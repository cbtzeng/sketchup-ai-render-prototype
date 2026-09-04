/**
 * POST /v1/uploads —— 為每個 pass 發一個簽名上傳 URL。
 *
 * 呼叫端：`src/architech_render/net/api_client.rb#request_upload_urls`
 *   request : { "passes": ["beauty", "edge", "depth"] }
 *   response: { "urls": { "beauty": "...", "edge": "...", "depth": "..." },
 *               "upload_batch": "...", "paths": {...}, "expires_at": "..." }
 *
 * `urls` 這個 key 名不能改 —— cloud_backend.rb 直接讀 `res['urls']`。
 * `upload_batch` 是新增欄位，Ruby 端目前會忽略它（見下方 🔴）。
 *
 * 🔴 待驗證（Supabase Storage，細節見 lib/storage.ts 檔頭）
 *   - 簽名上傳 URL 的建立方式、TTL 上限、能否鎖 content-type
 *   - 上傳用 PUT 還是 POST；uploader.rb 目前寫死 PUT + Content-Type: image/png
 *   - **上傳回應是否含 sha256**：uploader.rb 要求回應帶 `sha256`/`digest` 或
 *     `X-Content-Sha256` header，「沒回就視為失敗」。Supabase Storage 幾乎確定不會回。
 *     本端點的設計是伺服器在 POST /v1/jobs 時自行 statObject 重算雜湊校驗，
 *     但那不會讓 uploader.rb 的檢查通過 —— **這是已知的介面衝突，需主 session 決策。**
 *
 * 🔴 待決：Ruby 端沒有把 uploads 回應的 `upload_batch` 帶回 POST /v1/jobs
 *     （api_client.rb 的 create_job payload 沒有這個欄位）。
 *     在 Ruby 端補上之前，jobs 端點只能退而用「該使用者最近一個未認領批次」。
 */
import { getRuntimeContext, type ApiContext } from '../../lib/api-context.js';
import { REQUIRED_CONTROL_KINDS, type AssetKind } from '../../lib/db.js';
import {
  ApiError,
  fromFetchRequest,
  json,
  parseJsonBody,
  requireMethod,
  runHandler,
  type ApiRequest,
  type ApiResponse,
} from '../../lib/http.js';
import { UPLOAD_URL_TTL_SECONDS } from '../../lib/job-view.js';
import { controlObjectPath } from '../../lib/storage.js';

/**
 * 診斷碼
 *   UPL-10 405 方法不符
 *   UPL-20 400 body 不是合法 JSON 物件
 *   UPL-21 400 passes 必須是非空字串陣列
 *   UPL-22 400 未知的 pass 名稱
 *   UPL-23 400 pass 重複
 *   UPL-30 502 儲存服務發不出簽名 URL
 * （另有共用碼 AUTH-10 / AUTH-11 401、CFG-01 / CFG-02 501、SRV-50 500）
 */
const ALLOWED_PASSES: readonly string[] = REQUIRED_CONTROL_KINDS;

export async function handle(req: ApiRequest, ctx: ApiContext): Promise<ApiResponse> {
  requireMethod(req, 'POST', 'UPL-10');
  const { userId } = await ctx.auth.authenticate(req.headers);

  const body = parseJsonBody(req, 'UPL-20');
  const passes = parsePasses(body['passes']);

  const batchId = ctx.newId();
  const nowIso = ctx.now().toISOString();

  const urls: Record<string, string> = {};
  const paths: Record<string, string> = {};
  let expiresAt = '';

  for (const pass of passes) {
    const path = controlObjectPath(userId, batchId, pass);
    let signed;
    try {
      signed = await ctx.storage.createSignedUploadUrl({
        path,
        contentType: 'image/png',
        expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      });
    } catch (err) {
      throw new ApiError('UPL-30', 502, '無法建立簽名上傳 URL', {
        pass,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    urls[pass] = signed.url;
    paths[pass] = signed.path;
    expiresAt = signed.expiresAt;
  }

  await ctx.batches.createBatch({ id: batchId, user_id: userId, created_at: nowIso, paths });

  return json(200, {
    ok: true,
    urls,
    // 以下為新增欄位；Ruby 端目前只讀 urls，多回不會壞事，少回則無法精確對應批次。
    upload_batch: batchId,
    paths,
    expires_at: expiresAt,
    // uploader.rb 會檢查上傳回應的 sha256；先明確告知用戶端「校驗在建 job 時做」，
    // 讓這個已知衝突在介面上是可見的，而不是等到現場才炸。
    verification: 'server_side_on_job_create',
  });
}

function parsePasses(value: unknown): AssetKind[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError('UPL-21', 400, 'passes 必須是非空陣列', { allowed: ALLOWED_PASSES });
  }
  const seen = new Set<string>();
  const out: AssetKind[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new ApiError('UPL-21', 400, 'passes 的元素必須是字串');
    }
    if (!ALLOWED_PASSES.includes(item)) {
      throw new ApiError('UPL-22', 400, `未知的 pass「${item}」`, { allowed: ALLOWED_PASSES });
    }
    if (seen.has(item)) {
      throw new ApiError('UPL-23', 400, `pass「${item}」重複`);
    }
    seen.add(item);
    out.push(item as AssetKind);
  }
  return out;
}

/** 平台入口（Fetch API 形狀）。執行期 context 未接線時回 501 CFG-01。 */
export default async function uploadsRoute(request: Request): Promise<Response> {
  const res = await runHandler(async () => {
    const ctx = getRuntimeContext();
    return handle(await fromFetchRequest(request), ctx);
  });
  return new Response(JSON.stringify(res.body), { status: res.status, headers: res.headers });
}
