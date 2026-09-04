/**
 * upload-batches.ts —— 上傳批次。
 *
 * 為什麼需要這個東西：Ruby 端的流程是
 *   POST /v1/uploads（此時**還沒有 job**）→ PUT 上傳 → POST /v1/jobs
 * 但 `assets.job_id` 是 NOT NULL，所以發簽名 URL 的當下還不能建 asset row。
 * 批次記錄就是這段空窗期的暫存：記住「這個使用者剛剛拿到哪三個物件路徑」，
 * 等 POST /v1/jobs 進來時把它認領（claim）成該 job 的 assets。
 *
 * 🔴 待決：`001_init.sql` 目前沒有 upload_batches 這張表。
 *    候選解 (a) 加一張表；(b) 讓 POST /v1/jobs 直接帶 storage_path
 *    （需同步改 Ruby 端的 api_client.rb）。在決定之前，正式環境無法只靠現有 schema 運作。
 */
import type { AssetKind } from './db.js';

export interface UploadBatchRow {
  id: string;
  user_id: string;
  created_at: string;
  /** kind → storage_path。 */
  paths: Readonly<Record<string, string>>;
  /** 已被哪個 job 認領；null 表示尚未使用。 */
  claimed_by_job_id: string | null;
}

export interface NewUploadBatch {
  id: string;
  user_id: string;
  created_at: string;
  paths: Record<string, string>;
}

export interface UploadBatchStore {
  createBatch(row: NewUploadBatch): Promise<UploadBatchRow>;
  getBatch(id: string): Promise<UploadBatchRow | null>;
  /**
   * 找該使用者最近一個尚未認領的批次。
   * 🔴 這是為了相容目前 Ruby 端 `POST /v1/jobs` **不回傳批次 id** 的形狀所做的退讓。
   *    正確解是 Ruby 端把 uploads 回應裡的 `upload_batch` 原樣帶回來（本端點已支援）。
   *    退讓之所以尚可接受，是因為 cost-guard 限制每使用者同時 1 個進行中的 job；
   *    但同一使用者用兩台機器同時擷取仍會取錯批次。列入回報。
   */
  findLatestUnclaimedBatch(userId: string): Promise<UploadBatchRow | null>;
  /** 認領：只有 claimed_by_job_id 仍為 null 時才成功（compare-and-set）。 */
  claimBatch(id: string, jobId: string): Promise<UploadBatchRow | null>;
}

export class InMemoryUploadBatchStore implements UploadBatchStore {
  readonly batches = new Map<string, UploadBatchRow>();

  async createBatch(row: NewUploadBatch): Promise<UploadBatchRow> {
    const batch: UploadBatchRow = { ...row, paths: { ...row.paths }, claimed_by_job_id: null };
    this.batches.set(batch.id, batch);
    return { ...batch };
  }

  async getBatch(id: string): Promise<UploadBatchRow | null> {
    const b = this.batches.get(id);
    return b ? { ...b } : null;
  }

  async findLatestUnclaimedBatch(userId: string): Promise<UploadBatchRow | null> {
    const candidates = [...this.batches.values()]
      .filter((b) => b.user_id === userId && b.claimed_by_job_id === null)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const first = candidates[0];
    return first ? { ...first } : null;
  }

  async claimBatch(id: string, jobId: string): Promise<UploadBatchRow | null> {
    const b = this.batches.get(id);
    if (!b || b.claimed_by_job_id !== null) return null;
    const next: UploadBatchRow = { ...b, claimed_by_job_id: jobId };
    this.batches.set(id, next);
    return { ...next };
  }
}

/** 從批次記錄取出某個 kind 的路徑。 */
export function batchPath(batch: UploadBatchRow, kind: AssetKind): string | null {
  return batch.paths[kind] ?? null;
}
