/**
 * POST /v1/internal/sweep —— 給 cron 呼叫的掃描端點外殼。
 *
 * 它做兩件事：把退避到期的 `retrying` job 推回 `queued`、把超過硬逾時的 job 判 `expired`。
 * 邏輯全部在 `lib/retry-scheduler.ts`，本檔只負責**授權**與 HTTP 形狀。
 *
 * ⚠️ 授權是這個端點存在的第一理由。
 * 一個誰都能打的掃描端點等於把別人的 job 狀態機交給外人操控：
 * 反覆呼叫可以把別人 `retrying` 的 job 一路燒完重試額度、逼成 `failed`，
 * 或在對方剛送出時就把 job 判成 `expired`。因此
 *   - 密鑰不符 → 401，**在任何掃描動作之前**；
 *   - 環境變數沒設密鑰 → 503 fail-closed，絕不「沒設就放行」；
 *   - 比對用固定時間比較，不用 `===`（避免用回應時間逐字元試出密鑰）。
 *
 * 🔴 待決（需主 session）：
 *   - 共享密鑰只是最低標。若部署在 Vercel，Vercel Cron 的
 *     `Authorization: Bearer $CRON_SECRET` 是更貼平台的作法；若在 Cloudflare，
 *     scheduled handler 根本不需要對外開這個 route。open-questions Q5 未關閉，
 *     所以這裡採用平台中立的共享密鑰，並把平台綁定留在檔尾的 default export。
 *   - 是否要加上來源 IP 允許清單或 rate limit，取決於最終平台。
 */
import { getRuntimeContext } from '../../../lib/api-context.js';
import {
  ApiError,
  fromFetchRequest,
  json,
  requireMethod,
  runHandler,
  type ApiRequest,
  type ApiResponse,
} from '../../../lib/http.js';
import {
  INTERNAL_SECRET_ENV,
  INTERNAL_SECRET_HEADER,
  SWEEP_ERROR_CODES,
  RetryScheduler,
  type RetryCandidateSource,
  type SweepOutcome,
} from '../../../lib/retry-scheduler.js';
import { createHash, timingSafeEqual } from 'node:crypto';

export interface SweepDeps {
  scheduler: RetryScheduler;
  /**
   * 期望的內部共享密鑰，由部署入口從環境變數讀入。
   * `null` / 空字串代表未設定 → 一律 503（見檔頭）。
   */
  secret: string | null;
}

export async function handle(req: ApiRequest, deps: SweepDeps): Promise<ApiResponse> {
  requireMethod(req, 'POST', SWEEP_ERROR_CODES.METHOD);
  assertAuthorized(req, deps.secret);

  const outcome = await deps.scheduler.sweep();
  return json(200, toBody(outcome));
}

function toBody(outcome: SweepOutcome): Record<string, unknown> {
  return {
    ok: true,
    swept_at: outcome.sweptAt,
    requeued: outcome.requeued,
    failed: outcome.failed,
    expired: outcome.expired,
    // 跳過的原因彙總成計數：cron 的日誌不需要每一筆 id，但需要看得出
    // 「一直有 no_retry_schedule」這種代表資料有問題的訊號。
    skipped: countReasons(outcome),
    truncated: outcome.truncated,
  };
}

function countReasons(outcome: SweepOutcome): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of outcome.skipped) counts[s.reason] = (counts[s.reason] ?? 0) + 1;
  return counts;
}

/** 授權檢查。任何一步不過就拋，**不回傳布林值** —— 免得呼叫端忘了檢查回傳值。 */
function assertAuthorized(req: ApiRequest, expected: string | null): void {
  const secret = (expected ?? '').trim();
  if (secret === '') {
    throw new ApiError(
      SWEEP_ERROR_CODES.NOT_CONFIGURED,
      503,
      `尚未設定內部掃描密鑰（環境變數 ${INTERNAL_SECRET_ENV}）`,
    );
  }

  const presented = req.headers[INTERNAL_SECRET_HEADER] ?? '';
  if (!constantTimeEquals(secret, presented)) {
    // 訊息刻意不區分「沒帶」與「帶錯」，兩者都是同一句話。
    throw new ApiError(SWEEP_ERROR_CODES.UNAUTHORIZED, 401, '內部掃描端點需要有效的共享密鑰');
  }
}

/**
 * 固定時間字串比較。
 * 先各自 sha256 再比：`timingSafeEqual` 要求兩個 buffer 等長，
 * 直接比原字串會因為長度不同而提早拋錯，等於把密鑰長度洩漏出去。
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// 執行期接線
// ---------------------------------------------------------------------------

let runtimeCandidates: RetryCandidateSource | null = null;

/**
 * 由部署入口在啟動時呼叫，提供 retrying 候選的查詢實作。
 *
 * 為什麼不放進 `ApiContext`：`lib/api-context.ts` 在本次工作中不可修改。
 * 🔴 需主 session 決策：把 `RetryCandidateSource` 併進 `ApiContext`（或 `JobStore`）
 *    之後，這個 module-level 變數就可以刪掉。
 */
export function setRuntimeRetryCandidates(source: RetryCandidateSource): void {
  runtimeCandidates = source;
}

/** 平台入口（Fetch API 形狀）。 */
export default async function sweepRoute(request: Request): Promise<Response> {
  const res = await runHandler(async () => {
    const ctx = getRuntimeContext();
    if (!runtimeCandidates) {
      throw new ApiError(
        SWEEP_ERROR_CODES.NOT_WIRED,
        501,
        '尚未接上 retrying 候選查詢（見 setRuntimeRetryCandidates）',
      );
    }
    const scheduler = new RetryScheduler({
      store: ctx.store,
      retryCandidates: runtimeCandidates,
      now: ctx.now,
    });
    // 密鑰只在這裡（平台入口）讀環境變數；`handle` 本身不碰 process.env，
    // 測試才能直接注入密鑰而不必污染整個行程的環境。
    const secret = process.env[INTERNAL_SECRET_ENV] ?? null;
    return handle(await fromFetchRequest(request), { scheduler, secret });
  });
  return new Response(JSON.stringify(res.body), { status: res.status, headers: res.headers });
}
