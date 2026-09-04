/**
 * job-view.ts —— job 的對外表示，以及成本回填／釋放的共用邏輯。
 *
 * 欄位名以 Ruby 端實際會讀的為準（`net/cloud_backend.rb`、`net/poller.rb`）：
 *   `id`、`status`、`error_code`、`error_msg`、`result_url`
 * 這幾個名字不能改，改了 Ruby 端會安靜地讀到 nil。
 */
import { utcDayKey } from './cost-guard.js';
import type { JobRow, JobStore } from './db.js';
import type { ApiContext } from './api-context.js';

export interface JobView {
  id: string;
  status: string;
  scene: string | null;
  preset: string | null;
  preset_version: string | null;
  provider: string | null;
  retry_count: number;
  cost_estimate_cents: number;
  cost_actual_cents: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_msg: string | null;
  /** 只有 succeeded 且結果圖已落地時才有。 */
  result_url?: string;
}

export function toJobView(job: JobRow, extra: { resultUrl?: string | null } = {}): JobView {
  const view: JobView = {
    id: job.id,
    status: job.status,
    scene: job.scene_name,
    preset: job.preset,
    preset_version: job.preset_version,
    provider: job.provider,
    retry_count: job.retry_count,
    cost_estimate_cents: job.cost_estimate_cents,
    cost_actual_cents: job.cost_actual_cents,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error_code: job.error_code,
    error_msg: job.error_msg,
  };
  if (extra.resultUrl) view.result_url = extra.resultUrl;
  return view;
}

/** 結果圖的下載 URL。provider 直傳的 http(s) URL 原樣回傳，否則簽一個短效下載 URL。 */
export async function resolveResultUrl(ctx: ApiContext, job: JobRow): Promise<string | null> {
  if (job.status !== 'succeeded') return null;
  const assets = await ctx.store.listAssets(job.id);
  const result = assets.find((a) => a.kind === 'result');
  if (!result) return null;
  if (/^https?:\/\//i.test(result.storage_path)) return result.storage_path;
  return ctx.storage.createSignedDownloadUrl(result.storage_path, RESULT_URL_TTL_SECONDS);
}

export const RESULT_URL_TTL_SECONDS = 3600;
export const UPLOAD_URL_TTL_SECONDS = 600;

/**
 * 額度釋放（architecture.md 第 3 節「成本回填與 usage_daily 的關係」）：
 * job 進入 failed / cancelled / expired 時，把預留的估算金額全額釋放。
 *
 * 刻意**不**釋放 jobs_count：次數額度同時是防濫用的閘門，
 * 若失敗的 job 不計次，連續送必然失敗的請求就完全不受限。
 * 🔴 這一條 architecture.md 沒有明說（只寫了「估算值全額釋放」），需主 session 確認。
 */
export async function releaseEstimate(store: JobStore, job: JobRow): Promise<void> {
  if (job.cost_estimate_cents <= 0) return;
  await store.releaseDailyQuota({
    user_id: job.user_id,
    day: utcDayKey(new Date(job.created_at)),
    add_jobs: 0,
    add_cents: job.cost_estimate_cents,
  });
}

/** 成本回填：把 usage_daily 的預留金額修正成 provider 回報的實際金額。 */
export async function reconcileActualCost(
  store: JobStore,
  job: JobRow,
  actualCents: number,
): Promise<{ diffCents: number; overEstimateRatio: number | null }> {
  const diff = actualCents - job.cost_estimate_cents;
  const day = utcDayKey(new Date(job.created_at));
  if (diff < 0) {
    await store.releaseDailyQuota({ user_id: job.user_id, day, add_jobs: 0, add_cents: -diff });
  } else if (diff > 0) {
    // 回填不是准入判定，因此上限給 Number.MAX_SAFE_INTEGER：
    // 實際花掉的錢一定要記進去，不能因為「超過上限」而假裝沒花。
    await store.reserveDailyQuota({
      user_id: job.user_id,
      day,
      add_jobs: 0,
      add_cents: diff,
      jobs_limit: Number.MAX_SAFE_INTEGER,
      cents_limit: Number.MAX_SAFE_INTEGER,
    });
  }
  const ratio = job.cost_estimate_cents > 0 ? Math.abs(diff) / job.cost_estimate_cents : null;
  return { diffCents: diff, overEstimateRatio: ratio };
}

/** architecture.md 5.9：估算與實際偏差超過此比例要告警（估算失準本身就是 bug）。 */
export const COST_DRIFT_ALERT_RATIO = 0.2;
