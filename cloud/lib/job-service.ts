/**
 * job-service.ts —— Job 狀態機，**唯一允許寫 jobs.status 的地方**。
 *
 * 對應 docs/architecture.md 第 3 節。任何其他模組（API handler、webhook、
 * sweeper）都只能透過 `transition()` 改狀態，不得直接 UPDATE。
 * 這樣 job_events 才保證是完整軌跡 —— 少一筆事件，SLA 分析與除錯就全毀。
 */
import {
  COST_LIMITS,
  backoffDelayMs,
  isRetryableErrorClass,
  type ProviderErrorClass,
} from './cost-guard.js';
import type {
  AssetRow,
  JobRow,
  JobStatus,
  JobStore,
  NewJob,
  UsageDailyRow,
} from './db.js';
import { REQUIRED_CONTROL_KINDS, TERMINAL_STATUSES, isTerminal } from './db.js';

// ---------------------------------------------------------------------------
// 合法轉移表（architecture.md 第 3 節）
// ---------------------------------------------------------------------------

/**
 * 每個狀態允許前往的下一個狀態。**終態一律為空陣列。**
 *
 * 本表與 architecture.md（2026-09-04 修訂版）第 3 節的轉移表逐條相符，
 * 陣列順序也刻意照表列順序排，方便肉眼對照 —— 沒有隱藏的擴充。
 *
 * 修訂版補上的四條邊，各自要解決的死路如下（記錄「為什麼」，避免日後被當成
 * 多餘的邊刪掉）：
 *
 * - `created → cancelled`：使用者在上傳階段按取消。少了這條，client 只能
 *   放棄上傳然後乾等 10 分鐘的 expired，UI 上等同當掉。
 * - `queued → failed`：provider 在 submit 當下就回 4xx（例如控制圖被判違規）。
 *   4xx 不可重試，若又不能進 failed 就只剩等 expired。
 * - `queued → retrying`：provider 在 submit 當下就回 5xx / 逾時。這與
 *   `running → retrying` 是同一種失敗，只是發生得更早，因此**共用同一組
 *   guard**（可重試分類 + 重試上限），不另立規則。
 * - `retrying → cancelled`：退避最長 40 秒，使用者不該被綁在等待裡。
 *
 * 反過來說，**沒有**被放寬的仍然沒有：終態一律不可再轉移、`running → queued`
 * 只能經由 retrying（否則 retry_count 與退避不會被計入）、`retrying → running`
 * 必須先回 queued 重新送出。
 */
export const LEGAL_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = Object.freeze({
  created: ['queued', 'failed', 'cancelled', 'expired'],
  queued: ['running', 'failed', 'retrying', 'cancelled', 'expired'],
  running: ['succeeded', 'failed', 'retrying', 'cancelled', 'expired'],
  retrying: ['queued', 'failed', 'cancelled', 'expired'],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
});

// ---------------------------------------------------------------------------
// 錯誤
// ---------------------------------------------------------------------------

export type TransitionErrorCode =
  | 'JOB_NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'ASSETS_NOT_READY'
  | 'COST_GUARD_NOT_PASSED'
  | 'NOT_RETRYABLE_ERROR'
  | 'RETRY_BUDGET_EXHAUSTED'
  | 'NOT_YET_EXPIRED'
  | 'STALE_STATUS';

export class JobTransitionError extends Error {
  readonly code: TransitionErrorCode;
  readonly jobId: string;
  readonly from: JobStatus | null;
  readonly to: JobStatus;

  constructor(
    code: TransitionErrorCode,
    message: string,
    ctx: { jobId: string; from: JobStatus | null; to: JobStatus },
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.jobId = ctx.jobId;
    this.from = ctx.from;
    this.to = ctx.to;
  }
}

/** 轉移表裡根本沒有這條邊（含所有從終態出發的轉移）。 */
export class IllegalTransitionError extends JobTransitionError {}

/** 邊存在，但前置條件不成立（asset 沒齊、重試用盡、還沒到期…）。 */
export class TransitionGuardError extends JobTransitionError {}

export class JobNotFoundError extends JobTransitionError {}

// ---------------------------------------------------------------------------
// 轉移上下文
// ---------------------------------------------------------------------------

export type TransitionTrigger = 'cloud' | 'provider' | 'user' | 'sweeper';

export interface TransitionContext {
  /** 誰觸發的，寫進 job_events.detail_json 供除錯。 */
  trigger?: TransitionTrigger;
  /** cost_guard 是否放行（created → queued 必填 true）。 */
  costGuardPassed?: boolean;
  /** provider 錯誤分類（running → retrying / failed 用）。 */
  errorClass?: ProviderErrorClass;
  providerJobId?: string;
  costActualCents?: number;
  errorCode?: string;
  errorMsg?: string;
  /** 額外寫入 detail_json 的欄位。 */
  detail?: Record<string, unknown>;
}

export interface JobServiceOptions {
  /** 可注入的時鐘，測試用。 */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// JobService
// ---------------------------------------------------------------------------

export class JobService {
  private readonly store: JobStore;
  private readonly now: () => Date;

  constructor(store: JobStore, options: JobServiceOptions = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date());
  }

  /** 建立 job，並寫下 `∅ → created` 的第一筆事件。 */
  async create(row: NewJob): Promise<JobRow> {
    const job = await this.store.insertJob({ ...row, status: 'created' });
    await this.store.appendJobEvent({
      job_id: job.id,
      from_status: null,
      to_status: 'created',
      at: this.now().toISOString(),
      detail_json: { trigger: 'cloud' },
    });
    return job;
  }

  /**
   * 狀態轉移。順序：查 job → 查表 → 過 guard → CAS 寫入 → append 事件。
   * 任何一步失敗都拋錯，**且不留下 job_event**（避免污染軌跡）。
   */
  async transition(jobId: string, to: JobStatus, ctx: TransitionContext = {}): Promise<JobRow> {
    const job = await this.store.getJob(jobId);
    if (!job) {
      throw new JobNotFoundError('JOB_NOT_FOUND', `找不到 job ${jobId}`, {
        jobId,
        from: null,
        to,
      });
    }

    const from = job.status;
    const allowed = LEGAL_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      const why = isTerminal(from) ? `${from} 是終態，不可再轉移` : `轉移表沒有 ${from} → ${to}`;
      throw new IllegalTransitionError('ILLEGAL_TRANSITION', why, { jobId, from, to });
    }

    const nowIso = this.now().toISOString();
    const patch = await this.buildPatch(job, to, ctx, nowIso);

    const updated = await this.store.updateJob(jobId, { ...patch, status: to }, { status: from });
    if (!updated) {
      // compare-and-set 失敗：有人搶先改了狀態。
      throw new TransitionGuardError(
        'STALE_STATUS',
        `job ${jobId} 已不在 ${from}，轉移取消`,
        { jobId, from, to },
      );
    }

    await this.store.appendJobEvent({
      job_id: jobId,
      from_status: from,
      to_status: to,
      at: nowIso,
      detail_json: {
        trigger: ctx.trigger ?? 'cloud',
        ...(ctx.errorClass ? { error_class: ctx.errorClass } : {}),
        ...(ctx.errorCode ? { error_code: ctx.errorCode } : {}),
        ...(ctx.detail ?? {}),
      },
    });

    return updated;
  }

  /**
   * 掃出所有 `created_at + 10 分鐘` 已到期的非終態 job 並轉成 expired。
   * 回傳實際被過期掉的 job（併發下被別人搶先改掉的會被跳過）。
   *
   * ⚠️ **不要把這個方法接到任何端點上。** 生產路徑請用
   * `RetryScheduler.sweepExpired()`，它多了兩件這裡沒有的事：
   *   1. 每次掃描的筆數上限（這裡沒有上限，積壓大時會把整批 row 拉進記憶體）
   *   2. 過期時釋放預留的額度（這裡不釋放）
   *
   * 兩個都接線的話會**重複釋放 cents**，那是直接影響帳務的 bug。
   * 保留這個方法只為了 job-service 自己的單元測試能獨立驗證轉移邏輯。
   */
  async sweepExpired(): Promise<JobRow[]> {
    const cutoff = new Date(this.now().getTime() - COST_LIMITS.HARD_TIMEOUT_MS).toISOString();
    const candidates = await this.store.listExpiredCandidates(cutoff);
    const expired: JobRow[] = [];
    for (const candidate of candidates) {
      try {
        expired.push(
          await this.transition(candidate.id, 'expired', {
            trigger: 'sweeper',
            errorCode: 'JOB-TIMEOUT',
            errorMsg: `超過硬性逾時 ${COST_LIMITS.HARD_TIMEOUT_MS / 60000} 分鐘`,
          }),
        );
      } catch (err) {
        if (err instanceof JobTransitionError && (err.code === 'STALE_STATUS' || err.code === 'ILLEGAL_TRANSITION')) {
          continue; // 已被別的路徑收尾，跳過
        }
        throw err;
      }
    }
    return expired;
  }

  // -------------------------------------------------------------------------
  // guard 與欄位計算
  // -------------------------------------------------------------------------

  private async buildPatch(
    job: JobRow,
    to: JobStatus,
    ctx: TransitionContext,
    nowIso: string,
  ): Promise<Partial<JobRow>> {
    const patch: Partial<JobRow> = {};
    const from = job.status;

    if (to === 'queued' && from === 'created') {
      await this.assertControlsReady(job);
      if (ctx.costGuardPassed !== true) {
        throw new TransitionGuardError(
          'COST_GUARD_NOT_PASSED',
          'cost_guard 未放行，不得進入佇列',
          { jobId: job.id, from, to },
        );
      }
    }

    if (to === 'queued' && from === 'retrying') {
      if (job.retry_count >= COST_LIMITS.MAX_RETRIES) {
        throw new TransitionGuardError(
          'RETRY_BUDGET_EXHAUSTED',
          `重試次數已用盡（上限 ${COST_LIMITS.MAX_RETRIES} 次），應轉為 failed`,
          { jobId: job.id, from, to },
        );
      }
      patch.retry_count = job.retry_count + 1;
      // 重送出去之後就不再是「等待中」，清掉到期時間。
      // 留著會讓 sweeper 的粗篩撈到已經回到 queued 的 job。
      patch.next_attempt_at = null;
    }

    // 不分 from 一律套用：submit 當下失敗（queued）與執行中失敗（running）
    // 是同一種錯誤，判準必須一致，否則同一個 4xx 會因為時間差而有兩種結局。
    if (to === 'retrying') {
      if (!isRetryableErrorClass(ctx.errorClass)) {
        throw new TransitionGuardError(
          'NOT_RETRYABLE_ERROR',
          `錯誤分類 ${ctx.errorClass ?? 'none'} 不可重試（4xx 一律不重試）`,
          { jobId: job.id, from, to },
        );
      }
      // next_attempt_at 在**進入** retrying 時就寫定，語意是「這次何時可以重送」。
      //
      // 2026-09-05 修正：原本只在 retrying → queued 寫（now + backoff），
      // 那是「重送之後」，語意變成「下一次的到期時間」，方向是反的。
      // 後果是第一次進 retrying 時 next_attempt_at 為 null，
      // sweeper 直接推它 = 零退避 —— 對著剛掛掉的 provider 連打三次。
      // 這是會花錢的 bug，由 retry-scheduler 的作者在整合時發現。
      // 額度已用盡時不算退避 —— 不會有下一次重送了，算了也沒有意義，
      // 而且 backoffDelayMs 對超出範圍的次數會拋 RangeError。
      // next_attempt_at = null 正好表達「這一列不等待重送，它只能走向 failed」，
      // sweeper 的粗篩看到 null 會跳過它（reason: no_retry_schedule）。
      patch.next_attempt_at =
        job.retry_count >= COST_LIMITS.MAX_RETRIES
          ? null
          : new Date(Date.parse(nowIso) + backoffDelayMs(job.retry_count)).toISOString();

      // 重試上限刻意**不**擋在這裡，而是擋在 retrying → queued。
      // 理由：真正花錢的是「再送一次 provider」那一步，而 retrying 只是把
      // 「已經失敗、正在決定後續」這件事寫進軌跡。額度用盡時讓 job 先進
      // retrying、再由 RETRY_BUDGET_EXHAUSTED 逼它收在 failed，job_events
      // 才看得出「試到最後一次才放棄」；若在此攔下，最後一次失敗會完全沒有紀錄。
    }

    if (to === 'expired') {
      const deadline = Date.parse(job.created_at) + COST_LIMITS.HARD_TIMEOUT_MS;
      if (Date.parse(nowIso) < deadline) {
        throw new TransitionGuardError(
          'NOT_YET_EXPIRED',
          `尚未到期（created_at + ${COST_LIMITS.HARD_TIMEOUT_MS / 60000} 分鐘）`,
          { jobId: job.id, from, to },
        );
      }
    }

    if (to === 'running') {
      if (job.started_at === null) patch.started_at = nowIso;
      if (ctx.providerJobId) patch.provider_job_id = ctx.providerJobId;
    }

    if (isTerminal(to)) {
      patch.finished_at = nowIso;
    }

    if (ctx.costActualCents !== undefined) patch.cost_actual_cents = ctx.costActualCents;
    if (ctx.errorCode !== undefined) patch.error_code = ctx.errorCode;
    if (ctx.errorMsg !== undefined) patch.error_msg = ctx.errorMsg;

    return patch;
  }

  /** created → queued 的條件：三張控制圖都上傳完成且 sha256 校驗通過。 */
  private async assertControlsReady(job: JobRow): Promise<void> {
    const assets = await this.store.listAssets(job.id);
    const byKind = new Map<string, AssetRow>(assets.map((a) => [a.kind, a]));
    const missing: string[] = [];
    for (const kind of REQUIRED_CONTROL_KINDS) {
      const asset = byKind.get(kind);
      if (!asset || asset.upload_state !== 'verified' || !asset.sha256) {
        missing.push(kind);
      }
    }
    if (missing.length > 0) {
      throw new TransitionGuardError(
        'ASSETS_NOT_READY',
        `控制圖未就緒或校驗未通過：${missing.join(', ')}`,
        { jobId: job.id, from: job.status, to: 'queued' },
      );
    }
  }
}

export { TERMINAL_STATUSES, isTerminal };
export type { JobStatus, JobRow, UsageDailyRow };
