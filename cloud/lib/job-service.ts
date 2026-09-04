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
 * 與 architecture.md 轉移表的差異，全部列在這裡（沒有隱藏的擴充）：
 *
 * - 表中沒有 `running → failed`，但同一份表的 `running → retrying` 那一列
 *   寫著「**4xx 一律不重試**」。4xx 若不能進 failed，就只剩下等 expired
 *   （白等 10 分鐘）這條路。因此**新增 `running → failed`**。
 * - 表中沒有 `created → cancelled`：本實作**照表禁止**。使用者在上傳階段
 *   按取消，目前只能靠 client 放棄上傳後等 expired。這是 architecture.md
 *   的缺口，已列入回報。
 * - 表中沒有 `queued → failed` / `queued → retrying`：本實作**照表禁止**。
 *   provider 在 submit 當下就回 4xx 的情境無法表達，同樣列入回報。
 * - 表中沒有 `retrying → cancelled`：照表禁止。
 */
export const LEGAL_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = Object.freeze({
  created: ['queued', 'failed', 'expired'],
  queued: ['running', 'cancelled', 'expired'],
  running: ['succeeded', 'retrying', 'failed', 'cancelled', 'expired'],
  retrying: ['queued', 'failed', 'expired'],
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
      const delayMs = backoffDelayMs(job.retry_count);
      patch.retry_count = job.retry_count + 1;
      patch.next_attempt_at = new Date(Date.parse(nowIso) + delayMs).toISOString();
    }

    if (to === 'retrying') {
      if (!isRetryableErrorClass(ctx.errorClass)) {
        throw new TransitionGuardError(
          'NOT_RETRYABLE_ERROR',
          `錯誤分類 ${ctx.errorClass ?? 'none'} 不可重試（4xx 一律不重試）`,
          { jobId: job.id, from, to },
        );
      }
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
