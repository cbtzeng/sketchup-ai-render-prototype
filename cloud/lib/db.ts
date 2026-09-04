/**
 * db.ts —— 資料庫存取的抽象介面。
 *
 * 目的：讓 job-service / cost-guard 完全不知道 Supabase 的存在，
 * 單元測試用 `db-memory.ts` 的 in-memory 假實作即可跑，不需連線。
 *
 * 對應 schema 見 `cloud/supabase/migrations/001_init.sql`
 * 與 `docs/architecture.md` 2.3 節。
 */

// ---------------------------------------------------------------------------
// 型別
// ---------------------------------------------------------------------------

/** Job 狀態機的八個狀態（architecture.md 第 3 節）。 */
export type JobStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired';

/** 終態：不可再轉移。 */
export const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled', 'expired'] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export function isTerminal(status: JobStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** 控制圖與結果圖的種類（architecture.md 2.3：kind: beauty|edge|depth|result）。 */
export type AssetKind = 'beauty' | 'edge' | 'depth' | 'result';

/** 送出 job 前必須全部上傳並校驗通過的控制圖。 */
export const REQUIRED_CONTROL_KINDS: readonly AssetKind[] = ['beauty', 'edge', 'depth'];

/**
 * asset 的上傳狀態。
 *
 * 註：architecture.md 2.3 的 assets 欄位只列到 sha256，沒有上傳狀態欄位。
 * 但「全部 asset 上傳完成、sha256 校驗通過」這個 created → queued 的條件
 * 需要一個可判定的欄位，因此本實作新增 upload_state 與 sha256_declared。
 * 這是對 architecture.md 的**擴充**，已在 migration 註解中標明。
 */
export type UploadState = 'pending' | 'uploaded' | 'verified' | 'mismatch';

export interface JobRow {
  id: string;
  user_id: string;
  model_guid: string | null;
  scene_name: string | null;
  status: JobStatus;
  preset: string | null;
  preset_version: string | null;
  prompt: string | null;
  seed: number | null;
  params_json: unknown;
  provider: string | null;
  provider_job_id: string | null;
  idempotency_key: string;
  /** 已用掉的重試次數，上限見 cost-guard 的 MAX_RETRIES。 */
  retry_count: number;
  /** 退避後可再次送出的時間（retrying → queued 用）。 */
  next_attempt_at: string | null;
  cost_estimate_cents: number;
  cost_actual_cents: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_msg: string | null;
}

export type NewJob = Omit<
  JobRow,
  | 'status'
  | 'retry_count'
  | 'next_attempt_at'
  | 'started_at'
  | 'finished_at'
  | 'error_code'
  | 'error_msg'
  | 'cost_actual_cents'
  | 'provider_job_id'
> &
  Partial<Pick<JobRow, 'status' | 'retry_count' | 'provider_job_id'>>;

export interface JobEventRow {
  id: string;
  job_id: string;
  from_status: JobStatus | null;
  to_status: JobStatus;
  at: string;
  detail_json: unknown;
}

export type NewJobEvent = Omit<JobEventRow, 'id'>;

export interface AssetRow {
  id: string;
  job_id: string;
  kind: AssetKind;
  storage_path: string;
  width: number | null;
  height: number | null;
  /** 伺服器端實際算出的 sha256（權威值）。未上傳完成時為 null。 */
  sha256: string | null;
  /** Ruby 層在取簽名 URL 時宣告的 sha256，用來比對。 */
  sha256_declared: string | null;
  upload_state: UploadState;
}

export type NewAsset = Omit<AssetRow, 'id'>;

export interface UsageDailyRow {
  user_id: string;
  /** ISO date，UTC，格式 YYYY-MM-DD。 */
  day: string;
  jobs_count: number;
  cents_spent: number;
}

/** reserveDailyQuota 的請求。 */
export interface QuotaReservation {
  user_id: string;
  day: string;
  add_jobs: number;
  add_cents: number;
  jobs_limit: number;
  cents_limit: number;
}

/**
 * reserveDailyQuota 的結果。
 *
 * `ok: false` 時 usage 是**未被修改**的當前用量，供錯誤訊息顯示剩餘額度。
 * 這個「檢查 + 遞增」必須在單一 DB 往返內完成（見 001_init.sql 的
 * `reserve_daily_quota` function），否則兩個併發請求會同時通過檢查。
 */
export interface QuotaReservationResult {
  ok: boolean;
  usage: UsageDailyRow;
  /** ok=false 時說明是哪一項超限。 */
  exceeded?: 'jobs' | 'cents';
}

/** updateJob 的 compare-and-set 前提條件。 */
export interface UpdateExpectation {
  status: JobStatus;
}

// ---------------------------------------------------------------------------
// 介面
// ---------------------------------------------------------------------------

export interface JobStore {
  insertJob(row: NewJob): Promise<JobRow>;
  getJob(id: string): Promise<JobRow | null>;
  findJobByIdempotencyKey(userId: string, key: string): Promise<JobRow | null>;

  /**
   * 條件更新：只有當目前 status 等於 expect.status 時才寫入。
   * 這是狀態機防止併發雙寫的最後一道鎖（對應 SQL 的
   * `UPDATE ... WHERE id = $1 AND status = $2`）。
   * 前提不成立時回 null，由呼叫端決定是拋錯還是重讀。
   */
  updateJob(id: string, patch: Partial<JobRow>, expect: UpdateExpectation): Promise<JobRow | null>;

  /** job_events 是 append-only，因此只有 append 沒有 update / delete。 */
  appendJobEvent(event: NewJobEvent): Promise<JobEventRow>;
  listJobEvents(jobId: string): Promise<JobEventRow[]>;

  insertAsset(asset: NewAsset): Promise<AssetRow>;
  listAssets(jobId: string): Promise<AssetRow[]>;

  /** 目前處於 running 的 job 數（並發上限用）。 */
  countRunningJobs(userId: string): Promise<number>;

  /** 原子式的「檢查上限並遞增」。 */
  reserveDailyQuota(req: QuotaReservation): Promise<QuotaReservationResult>;

  /** 反向補償：job 最終沒有真的花錢時把額度還回去。 */
  releaseDailyQuota(req: Pick<QuotaReservation, 'user_id' | 'day' | 'add_jobs' | 'add_cents'>): Promise<UsageDailyRow>;

  /** 非終態且 created_at 早於 cutoff 的 job（過期清理用）。 */
  listExpiredCandidates(cutoffIso: string): Promise<JobRow[]>;
}
