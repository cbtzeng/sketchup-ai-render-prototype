/**
 * cost-guard.ts —— 成本護欄（docs/architecture.md 第 5 節）。
 *
 * 原則：**server 為權威**。Ruby 層的估算只是即時回饋，一律不可信。
 * 本模組只做「判定」，不寫 jobs 表 —— 狀態機的唯一寫入者是 job-service。
 *
 * 涵蓋第 5 節的 2、3、4、6、7 條：
 *   2 解析度上限 / 3 並發上限 / 4 每日上限（atomic upsert）/ 6 重試上限 / 7 去重快取
 *
 * 尚未實作（列為 TODO，不假裝有）：
 *   1 事前估算（需要 preset 定價表，見 preset-resolver）
 *   5 硬性逾時的 sweeper 排程（判定邏輯在 job-service.sweepExpired）
 *   8 熔斷、9 成本回填告警、10 金鑰管理
 */
import { createHash } from 'node:crypto';
import type { JobRow, JobStore, UsageDailyRow } from './db.js';
import { isTerminal } from './db.js';

// ---------------------------------------------------------------------------
// 上限常數（architecture.md 第 5 節）
// ---------------------------------------------------------------------------

export const COST_LIMITS = {
  /** 解析度單邊上限；原型鎖 1024×1024，硬上限 1536。 */
  MAX_EDGE_PX: 1536,
  /** 每日 job 數上限。 */
  MAX_JOBS_PER_DAY: 30,
  /** 每日金額上限（分）= $2。 */
  MAX_CENTS_PER_DAY: 200,
  /** 每使用者同時 running 的 job 數。 */
  MAX_CONCURRENT_RUNNING: 1,
  /** 重試上限，且只對 5xx / timeout。 */
  MAX_RETRIES: 2,
  /** 退避間隔（毫秒），索引 = 已用掉的重試次數。 */
  BACKOFF_MS: [10_000, 40_000] as readonly number[],
  /** 硬性逾時：created_at + 10 分鐘 → expired。 */
  HARD_TIMEOUT_MS: 10 * 60 * 1000,
} as const;

// ---------------------------------------------------------------------------
// 冪等 key
// ---------------------------------------------------------------------------

/**
 * canonical JSON：物件的 key 依字典序排序後序列化。
 * 沒有這一步的話，`{a:1,b:2}` 與 `{b:2,a:1}` 會算出不同的 idempotency_key，
 * 去重快取就永遠不會命中。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export interface IdempotencyInput {
  controlsSha256: string;
  paramsJson: unknown;
  userId: string;
}

/**
 * `idempotency_key = sha256(controls_sha256 + params_json + user_id)`
 * （architecture.md 第 3 節）。
 *
 * 實作上在三段之間插入 `\n` 分隔符：規格寫的是純字串串接，
 * 但純串接有歧義（"ab"+""+"c" 與 "a"+""+"bc" 會撞成同一個 key），
 * 那是真的會導致跨請求誤命中快取的 bug。此處刻意偏離規格並記錄。
 */
export function computeIdempotencyKey(input: IdempotencyInput): string {
  const material = `${input.controlsSha256}\n${canonicalJson(input.paramsJson)}\n${input.userId}`;
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// 解析度
// ---------------------------------------------------------------------------

export type ResolutionCheck =
  | { ok: true }
  | { ok: false; code: 'RESOLUTION_EXCEEDED' | 'RESOLUTION_INVALID'; httpStatus: 400; message: string };

export function checkResolution(size: { width: number; height: number }): ResolutionCheck {
  const { width, height } = size;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return {
      ok: false,
      code: 'RESOLUTION_INVALID',
      httpStatus: 400,
      message: `尺寸必須是正整數，收到 ${width}×${height}`,
    };
  }
  if (width > COST_LIMITS.MAX_EDGE_PX || height > COST_LIMITS.MAX_EDGE_PX) {
    return {
      ok: false,
      code: 'RESOLUTION_EXCEEDED',
      httpStatus: 400,
      message: `單邊上限 ${COST_LIMITS.MAX_EDGE_PX}px，收到 ${width}×${height}`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 重試政策
// ---------------------------------------------------------------------------

export type ProviderErrorClass = 'http_4xx' | 'http_5xx' | 'timeout' | 'network' | 'none';

/** 可重試的錯誤類別：只有 5xx 與逾時（network 視為逾時的一種）。 */
export const RETRYABLE_ERROR_CLASSES: readonly ProviderErrorClass[] = ['http_5xx', 'timeout', 'network'];

export function isRetryableErrorClass(c: ProviderErrorClass | undefined): boolean {
  return c !== undefined && RETRYABLE_ERROR_CLASSES.includes(c);
}

export function classifyProviderError(signal: {
  httpStatus?: number;
  timedOut?: boolean;
  networkError?: boolean;
}): ProviderErrorClass {
  if (signal.networkError) return 'network';
  if (signal.timedOut) return 'timeout';
  const s = signal.httpStatus;
  if (typeof s === 'number') {
    if (s >= 500) return 'http_5xx';
    if (s >= 400) return 'http_4xx';
  }
  return 'none';
}

export function backoffDelayMs(retryCount: number): number {
  const delay = COST_LIMITS.BACKOFF_MS[retryCount];
  if (delay === undefined) {
    throw new RangeError(`沒有第 ${retryCount + 1} 次重試的退避設定（上限 ${COST_LIMITS.MAX_RETRIES} 次）`);
  }
  return delay;
}

export type RetryDecision =
  | { retry: true; delayMs: number }
  | { retry: false; reason: 'not_retryable' | 'budget_exhausted' };

/**
 * 重試判定。**4xx 一律不重試** —— 對著必然失敗的請求反覆重送只是燒錢。
 */
export function shouldRetry(input: {
  errorClass: ProviderErrorClass;
  retryCount: number;
}): RetryDecision {
  if (!isRetryableErrorClass(input.errorClass)) return { retry: false, reason: 'not_retryable' };
  if (input.retryCount >= COST_LIMITS.MAX_RETRIES) return { retry: false, reason: 'budget_exhausted' };
  return { retry: true, delayMs: backoffDelayMs(input.retryCount) };
}

// ---------------------------------------------------------------------------
// 每日額度
// ---------------------------------------------------------------------------

/** 以 UTC 為界的日期 key，格式 YYYY-MM-DD。 */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// admit：POST /v1/jobs 的准入判定
// ---------------------------------------------------------------------------

export interface AdmitRequest {
  userId: string;
  /** 三張控制圖 sha256 的彙總雜湊（由 uploads 端點算出）。 */
  controlsSha256: string;
  paramsJson: unknown;
  width: number;
  height: number;
  /** 事前估算的成本（分），由 preset 定價表算出。 */
  costEstimateCents: number;
  now: Date;
}

export type DenyCode =
  | 'RESOLUTION_EXCEEDED'
  | 'RESOLUTION_INVALID'
  | 'CONCURRENCY_LIMIT'
  | 'DAILY_JOB_LIMIT'
  | 'DAILY_COST_LIMIT';

export interface QuotaRemaining {
  jobs: number;
  cents: number;
}

export type AdmitResult =
  /** 冪等命中已成功的 job：直接回舊結果，成本 0。 */
  | { decision: 'cache_hit'; idempotencyKey: string; job: JobRow; costCents: 0 }
  /** 冪等命中仍在進行中的 job：回同一個 job，不是錯誤，也不算新請求。 */
  | { decision: 'in_flight'; idempotencyKey: string; job: JobRow }
  /** 放行：呼叫端接著建立 job。 */
  | {
      decision: 'allow';
      idempotencyKey: string;
      usage: UsageDailyRow;
      remaining: QuotaRemaining;
      /** 若這次是重送一個已失敗／已取消／已過期的同 key job，記下被取代者。 */
      supersedes?: string;
    }
  /** 拒絕。 */
  | {
      decision: 'deny';
      idempotencyKey: string;
      code: DenyCode;
      httpStatus: 400 | 409 | 429;
      message: string;
      remaining?: QuotaRemaining;
    };

/**
 * 准入判定。順序有意義，不可調換：
 *
 * 1. **冪等去重最先**。使用者重送自己正在跑的 job 必須拿到同一個 job，
 *    而不是 409；也不能因此多佔一次每日額度。
 * 2. 解析度（純運算，最便宜，且不該佔用額度）。
 * 3. 並發上限（一次 count 查詢）。
 * 4. 每日上限（原子 upsert，會真的寫入，所以放最後）。
 *
 * 注意：本函式**不建立 job**。呼叫端拿到 `allow` 後才呼叫 `JobService.create`，
 * 並且必須處理 `jobs.idempotency_key` unique index 的併發衝突
 * （兩個同時抵達的相同請求會有一個 insert 失敗，此時重讀該 key 回既有 job，
 * 並用 `releaseDailyQuota` 把多佔的額度還回去）。
 */
export async function admit(store: JobStore, req: AdmitRequest): Promise<AdmitResult> {
  const idempotencyKey = computeIdempotencyKey({
    controlsSha256: req.controlsSha256,
    paramsJson: req.paramsJson,
    userId: req.userId,
  });

  // 1. 冪等去重
  const existing = await store.findJobByIdempotencyKey(req.userId, idempotencyKey);
  let supersedes: string | undefined;
  if (existing) {
    if (existing.status === 'succeeded') {
      return { decision: 'cache_hit', idempotencyKey, job: existing, costCents: 0 };
    }
    if (!isTerminal(existing.status)) {
      return { decision: 'in_flight', idempotencyKey, job: existing };
    }
    // failed / cancelled / expired：允許重送。
    // 🔴 待決：architecture.md 沒有定義這個情境。若 jobs.idempotency_key 是
    // 全域 unique index，重送會直接撞索引。可行解有兩個（見 001_init.sql 註解）：
    //   (a) 改成 partial unique index，排除終態失敗的 row；
    //   (b) idempotency_key 的材料加入 attempt 序號。
    // 在做出決定之前，呼叫端必須自行處理 unique 衝突。
    supersedes = existing.id;
  }

  // 2. 解析度
  const res = checkResolution({ width: req.width, height: req.height });
  if (!res.ok) {
    return {
      decision: 'deny',
      idempotencyKey,
      code: res.code,
      httpStatus: res.httpStatus,
      message: res.message,
    };
  }

  // 3. 並發上限
  const running = await store.countRunningJobs(req.userId);
  if (running >= COST_LIMITS.MAX_CONCURRENT_RUNNING) {
    return {
      decision: 'deny',
      idempotencyKey,
      code: 'CONCURRENCY_LIMIT',
      httpStatus: 409,
      message: `同時只能有 ${COST_LIMITS.MAX_CONCURRENT_RUNNING} 個進行中的算圖，請等目前這張完成`,
    };
  }

  // 4. 每日上限（檢查與遞增在單一 DB 往返內完成）
  const day = utcDayKey(req.now);
  const reservation = await store.reserveDailyQuota({
    user_id: req.userId,
    day,
    add_jobs: 1,
    add_cents: req.costEstimateCents,
    jobs_limit: COST_LIMITS.MAX_JOBS_PER_DAY,
    cents_limit: COST_LIMITS.MAX_CENTS_PER_DAY,
  });

  const remaining: QuotaRemaining = {
    jobs: Math.max(0, COST_LIMITS.MAX_JOBS_PER_DAY - reservation.usage.jobs_count),
    cents: Math.max(0, COST_LIMITS.MAX_CENTS_PER_DAY - reservation.usage.cents_spent),
  };

  if (!reservation.ok) {
    const isJobs = reservation.exceeded === 'jobs';
    return {
      decision: 'deny',
      idempotencyKey,
      code: isJobs ? 'DAILY_JOB_LIMIT' : 'DAILY_COST_LIMIT',
      httpStatus: 429,
      message: isJobs
        ? `今日已達 ${COST_LIMITS.MAX_JOBS_PER_DAY} 次上限，明日 00:00 UTC 重置`
        : `今日已達 $${(COST_LIMITS.MAX_CENTS_PER_DAY / 100).toFixed(2)} 上限，明日 00:00 UTC 重置`,
      remaining,
    };
  }

  return {
    decision: 'allow',
    idempotencyKey,
    usage: reservation.usage,
    remaining,
    ...(supersedes ? { supersedes } : {}),
  };
}
