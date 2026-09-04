/**
 * retry-scheduler.ts —— 把卡在 `retrying` 的 job 推回 `queued` 的退避排程器（sweeper）。
 *
 * 為什麼需要這個模組：
 * `api/v1/hooks/[provider].ts` 收到 provider 5xx 時只把 job 推進 `retrying`，
 * **沒有任何東西會把它推回 `queued`**。轉移表寫著「retrying → queued，退避後（10s, 40s）」，
 * 但那條邊沒有觸發者 —— 結果是每一個可重試的失敗最後都只會變成 `expired`，
 * 使用者等滿 10 分鐘才看到一個看不出原因的逾時。architecture.md 5.5 把
 * 「硬性逾時的 sweeper 排程」列為未實作，本檔補上它與退避重送兩件事。
 *
 * 邊界：本檔**不自己寫 jobs.status**。所有狀態變更一律經 `JobService.transition`，
 * 因為 job_events 的完整軌跡是狀態機唯一的除錯依據，繞過去就等於把軌跡打洞。
 *
 * 併發安全同理：`JobService.transition` 內部是
 * 「重讀 job → 查轉移表 → CAS 更新（`updateJob(..., { status: from })`）」，
 * 兩個 sweeper 同時處理同一個 job 時，後到的那個要嘛 CAS 失敗（`STALE_STATUS`），
 * 要嘛因為狀態已經不是 `retrying` 而被轉移表擋下（`ILLEGAL_TRANSITION`）。
 * 本檔把這兩種錯誤當成「別人先做了」而跳過，**不另外造一套鎖**。
 */
import { COST_LIMITS, backoffDelayMs } from './cost-guard.js';
import type { JobEventRow, JobRow, JobStore } from './db.js';
import type { InMemoryJobStore } from './db-memory.js';
import { JobService, JobTransitionError } from './job-service.js';
import { releaseEstimate } from './job-view.js';

// ---------------------------------------------------------------------------
// 候選查詢
// ---------------------------------------------------------------------------

/**
 * 「退避已到期的 retrying job」的查詢來源。
 *
 * `db.ts` 的 `JobStore` 只有 `listExpiredCandidates`，沒有 retrying 的查詢，
 * 而該檔在本次工作中不可修改，因此比照 `job-lookup.ts` 的作法獨立成一個介面。
 * 正式的 Supabase store 應同時實作 `JobStore` 與本介面。
 *
 * 🔴 需主 session 決策：是否把 `listRetryCandidates` 併入 `db.ts` 的 `JobStore`
 *    （同時需要一個 `jobs(status, next_attempt_at)` 的部分索引，migration 尚未有）。
 */
export interface RetryCandidateSource {
  /**
   * 回傳 `status = 'retrying'` 且**可能**已到退避時間的 job，最多 `limit` 筆。
   *
   * 這裡刻意只做粗篩（`next_attempt_at IS NULL OR next_attempt_at <= now`）：
   * `next_attempt_at` 目前不可靠（見 `retryDueAtMs` 的說明），精確的到期判定
   * 由排程器用 job_events 算，DB 這一層只負責把候選集合縮小到能走索引。
   */
  listRetryCandidates(input: { nowIso: string; limit: number }): Promise<JobRow[]>;
}

/** 測試／本機用：在 InMemoryJobStore 上線性掃描。正式環境請用 SQL 版本。 */
export function inMemoryRetryCandidates(store: InMemoryJobStore): RetryCandidateSource {
  return {
    async listRetryCandidates({ nowIso, limit }) {
      const now = Date.parse(nowIso);
      return [...store.jobs.values()]
        .filter((j) => j.status === 'retrying')
        .filter((j) => j.next_attempt_at === null || Date.parse(j.next_attempt_at) <= now)
        // 先進先出：舊的 job 離硬逾時最近，晚一輪處理就直接報銷了。
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .slice(0, limit)
        .map((j) => ({ ...j }));
    },
  };
}

// ---------------------------------------------------------------------------
// 到期時間推算
// ---------------------------------------------------------------------------

/**
 * 算出一個 `retrying` job 可以被推回 `queued` 的最早時間（epoch ms）。
 * 無法判定時回 `null` —— 呼叫端必須跳過，而不是當成「現在就可以」。
 *
 * 為什麼不直接信 `jobs.next_attempt_at`（規格說的就是它）：
 * `job-service.ts` 目前只在 **retrying → queued** 那一步寫 `next_attempt_at`
 * （寫成 `now + backoff(retry_count)`），**running → retrying 不寫**。因此
 *   - 第一次進 retrying 時 `next_attempt_at` 是 `null` → 直接信它等於零退避；
 *   - 第二次進 retrying 時它是上一輪留下的舊值、已經在過去 → 一樣等於零退避。
 * 零退避重送就是對著剛掛掉的 provider 連續打三次，退避上限形同虛設。
 *
 * 所以基準點取自 job_events：最後一筆 `to_status = 'retrying'` 的 `at`
 * 加上該事件記下的 `detail_json.backoff_ms`（webhook 端點已經在寫這個欄位）。
 * 事件沒記時退回用 `retry_count` 查退避表。
 *
 * 兩個來源取 **max**：`next_attempt_at` 若哪天改由 webhook 正確寫入，
 * 它會等於事件推算值；若它是更晚的時間，代表有人刻意延後，也應該被尊重。
 * 取 max 的方向永遠是「不會比任一來源更早重送」，這是安全的一邊。
 */
export function retryDueAtMs(job: JobRow, events: readonly JobEventRow[]): number | null {
  let dueMs: number | null = null;

  const entered = lastRetryingEvent(events);
  if (entered) {
    const enteredMs = Date.parse(entered.at);
    if (Number.isFinite(enteredMs)) {
      const backoff = backoffMsOf(entered, job.retry_count);
      if (backoff !== null) dueMs = enteredMs + backoff;
    }
  }

  if (job.next_attempt_at !== null) {
    const declared = Date.parse(job.next_attempt_at);
    if (Number.isFinite(declared)) dueMs = dueMs === null ? declared : Math.max(dueMs, declared);
  }

  return dueMs;
}

function lastRetryingEvent(events: readonly JobEventRow[]): JobEventRow | null {
  let latest: JobEventRow | null = null;
  for (const e of events) {
    if (e.to_status !== 'retrying') continue;
    if (latest === null || Date.parse(e.at) >= Date.parse(latest.at)) latest = e;
  }
  return latest;
}

function backoffMsOf(event: JobEventRow, retryCount: number): number | null {
  const detail = event.detail_json;
  if (detail !== null && typeof detail === 'object') {
    const raw = (detail as Record<string, unknown>)['backoff_ms'];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  }
  // 事件沒記就用退避表；retry_count 已超出表長度時 backoffDelayMs 會拋 RangeError，
  // 那代表這個 job 根本不該再重試，交給重試上限那條路處理。
  try {
    return backoffDelayMs(retryCount);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 掃描結果
// ---------------------------------------------------------------------------

export type SweepSkipReason =
  /** 退避還沒到。 */
  | 'not_due'
  /** 已經超過 created_at + 10 分鐘，重送等於白花一次 provider 呼叫。 */
  | 'past_hard_deadline'
  /** 算不出退避基準點（軌跡缺 retrying 事件且 next_attempt_at 為 null）。 */
  | 'no_retry_schedule'
  /** 併發：狀態被別的 sweeper／webhook／使用者搶先改掉。 */
  | 'raced';

export interface SweepSkip {
  jobId: string;
  reason: SweepSkipReason;
}

export interface SweepOutcome {
  /** retrying → queued。 */
  requeued: string[];
  /** retrying → failed（重試次數用盡）。 */
  failed: string[];
  /** 任何非終態 → expired。 */
  expired: string[];
  skipped: SweepSkip[];
  /**
   * 這次掃描有候選被筆數上限截斷。
   * cron 端看到 true 應該盡快再掃一次，否則積壓的 job 會慢慢逼近硬逾時。
   */
  truncated: boolean;
  /** 掃描當下的時間（可注入時鐘的值），供對帳。 */
  sweptAt: string;
}

function emptyOutcome(sweptAt: string): SweepOutcome {
  return { requeued: [], failed: [], expired: [], skipped: [], truncated: false, sweptAt };
}

function merge(a: SweepOutcome, b: SweepOutcome): SweepOutcome {
  return {
    requeued: [...a.requeued, ...b.requeued],
    failed: [...a.failed, ...b.failed],
    expired: [...a.expired, ...b.expired],
    skipped: [...a.skipped, ...b.skipped],
    truncated: a.truncated || b.truncated,
    sweptAt: a.sweptAt,
  };
}

// ---------------------------------------------------------------------------
// 排程器
// ---------------------------------------------------------------------------

/** 單次掃描的預設筆數上限。一次掃太多會把 DB 與 provider 同時打爆。 */
export const DEFAULT_MAX_PER_SWEEP = 100;

export interface RetrySchedulerOptions {
  store: JobStore;
  retryCandidates: RetryCandidateSource;
  /** 可注入時鐘。測退避與逾時不靠 sleep，全部靠這個。 */
  now?: () => Date;
  /** 每個 pass（過期／重送）各自的筆數上限。 */
  maxPerSweep?: number;
  /** 共用同一個 JobService 實例時可注入；預設自建。 */
  service?: JobService;
  /**
   * job 進終態時釋放預留額度。預設用 `job-view.ts` 的 releaseEstimate
   * （只退 cents 不退 jobs_count）。抽成參數是為了讓測試能觀察，
   * 也讓主 session 能在雙寫疑慮下關掉它。
   */
  releaseQuota?: (store: JobStore, job: JobRow) => Promise<void>;
}

export class RetryScheduler {
  private readonly store: JobStore;
  private readonly candidates: RetryCandidateSource;
  private readonly service: JobService;
  private readonly now: () => Date;
  private readonly maxPerSweep: number;
  private readonly releaseQuota: (store: JobStore, job: JobRow) => Promise<void>;

  constructor(options: RetrySchedulerOptions) {
    this.store = options.store;
    this.candidates = options.retryCandidates;
    this.now = options.now ?? (() => new Date());
    this.maxPerSweep = options.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP;
    this.service = options.service ?? new JobService(options.store, { now: this.now });
    this.releaseQuota = options.releaseQuota ?? releaseEstimate;
  }

  /**
   * 一次完整掃描。
   *
   * **順序有意義：先過期、再重送。** 反過來的話，一個既到退避時間又已經超過
   * 硬逾時的 job 會先被重送給 provider（真的花錢），下一輪掃描才被判 expired ——
   * 花了錢還是給使用者一個逾時。重送 pass 也會再檢查一次硬逾時，
   * 以防過期 pass 被筆數上限截斷。
   */
  async sweep(): Promise<SweepOutcome> {
    const expired = await this.sweepExpired();
    const retried = await this.sweepRetries();
    return merge(expired, retried);
  }

  /** 非終態且 `created_at + 10 分鐘` 已過的 job → expired。 */
  async sweepExpired(): Promise<SweepOutcome> {
    const now = this.now();
    const out = emptyOutcome(now.toISOString());
    const cutoffIso = new Date(now.getTime() - COST_LIMITS.HARD_TIMEOUT_MS).toISOString();

    // 🔴 `JobStore.listExpiredCandidates` 沒有 limit 參數（db.ts 不可修改），
    //    因此上限只能在讀回來之後套用：**寫入次數有上限，讀取量還沒有**。
    //    積壓量大時這一句會把整批 row 拉進記憶體。需要 db.ts 補 limit / cursor。
    const candidates = await this.store.listExpiredCandidates(cutoffIso);
    const ordered = [...candidates].sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
    );
    out.truncated = ordered.length > this.maxPerSweep;

    for (const job of ordered.slice(0, this.maxPerSweep)) {
      const done = await this.tryTransition(job, 'expired', {
        errorCode: 'JOB-TIMEOUT',
        errorMsg: `超過硬性逾時 ${COST_LIMITS.HARD_TIMEOUT_MS / 60000} 分鐘`,
        detail: { reason: 'hard_timeout', cutoff: cutoffIso },
      });
      if (done) {
        out.expired.push(job.id);
        await this.releaseQuota(this.store, done);
      } else {
        out.skipped.push({ jobId: job.id, reason: 'raced' });
      }
    }
    return out;
  }

  /** 退避到期的 retrying job → queued；重試次數用盡的 → failed。 */
  async sweepRetries(): Promise<SweepOutcome> {
    const now = this.now();
    const nowMs = now.getTime();
    const out = emptyOutcome(now.toISOString());

    // 多讀一筆用來判斷「是不是還有沒掃到的」，避免另外跑一次 count。
    const fetched = await this.candidates.listRetryCandidates({
      nowIso: now.toISOString(),
      limit: this.maxPerSweep + 1,
    });
    out.truncated = fetched.length > this.maxPerSweep;

    for (const job of fetched.slice(0, this.maxPerSweep)) {
      // 已經越過硬逾時的 job 不重送：送出去也是白花一次 provider 呼叫，
      // 結果仍然會被過期 pass 收掉（本輪可能已被上限截斷，下一輪會處理）。
      if (nowMs >= Date.parse(job.created_at) + COST_LIMITS.HARD_TIMEOUT_MS) {
        out.skipped.push({ jobId: job.id, reason: 'past_hard_deadline' });
        continue;
      }

      // 重試上限（architecture.md 5.6）：第 3 次改判 failed，不再重送。
      // job-service 的 guard 也會擋，但那是拋錯；這裡要的是「改走 failed」。
      if (job.retry_count >= COST_LIMITS.MAX_RETRIES) {
        const failed = await this.tryTransition(job, 'failed', {
          errorCode: 'JOB-RETRY-EXHAUSTED',
          errorMsg: `provider 連續失敗，重試 ${COST_LIMITS.MAX_RETRIES} 次後放棄`,
          detail: { reason: 'retry_budget_exhausted', retry_count: job.retry_count },
        });
        if (failed) {
          out.failed.push(job.id);
          // provider 掛掉不該向使用者收費（architecture.md 第 4 節）。
          await this.releaseQuota(this.store, failed);
        } else {
          out.skipped.push({ jobId: job.id, reason: 'raced' });
        }
        continue;
      }

      const events = await this.store.listJobEvents(job.id);
      const dueMs = retryDueAtMs(job, events);
      if (dueMs === null) {
        out.skipped.push({ jobId: job.id, reason: 'no_retry_schedule' });
        continue;
      }
      if (nowMs < dueMs) {
        out.skipped.push({ jobId: job.id, reason: 'not_due' });
        continue;
      }

      // retry_count 的遞增與下一次 next_attempt_at 由 job-service 的
      // buildPatch 負責，這裡不重複計算，免得兩邊各有一套退避規則。
      const requeued = await this.tryTransition(job, 'queued', {
        detail: { reason: 'backoff_elapsed', due_at: new Date(dueMs).toISOString() },
      });
      if (requeued) out.requeued.push(job.id);
      else out.skipped.push({ jobId: job.id, reason: 'raced' });
    }

    return out;
  }

  /**
   * 走 JobService 的轉移；因為併發而失敗時回 null（由呼叫端記成 skipped）。
   *
   * 這裡吞掉的只有 `STALE_STATUS`（CAS 失敗）與 `ILLEGAL_TRANSITION`
   * （狀態已經被改成別的、或已是終態）—— 兩者都代表「別人先處理了」。
   * 其他 guard 錯誤（例如重試額度）是真的邏輯問題，往上拋，不要靜靜吃掉。
   */
  private async tryTransition(
    job: JobRow,
    to: Parameters<JobService['transition']>[1],
    ctx: Omit<Parameters<JobService['transition']>[2], 'trigger'>,
  ): Promise<JobRow | null> {
    try {
      return await this.service.transition(job.id, to, { trigger: 'sweeper', ...ctx });
    } catch (err) {
      if (
        err instanceof JobTransitionError &&
        (err.code === 'STALE_STATUS' || err.code === 'ILLEGAL_TRANSITION')
      ) {
        return null;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// 端點共用的診斷碼（端點與測試都從這裡取，避免字串各寫一份）
// ---------------------------------------------------------------------------

export const SWEEP_ERROR_CODES = {
  /** 405：掃描會改狀態，只接受 POST。 */
  METHOD: 'SWEEP-10',
  /** 503：環境變數沒設共享密鑰 → fail-closed。 */
  NOT_CONFIGURED: 'SWEEP-11',
  /** 401：缺少或不符的內部密鑰。 */
  UNAUTHORIZED: 'SWEEP-30',
  /** 501：執行環境還沒接上 sweeper（Supabase store 未接線）。 */
  NOT_WIRED: 'SWEEP-51',
} as const;

/** 內部密鑰的 header 名稱。 */
export const INTERNAL_SECRET_HEADER = 'x-internal-secret';

/** 密鑰的環境變數名稱。**值只從環境變數來，永遠不寫進原始碼。** */
export const INTERNAL_SECRET_ENV = 'INTERNAL_SWEEP_SECRET';
