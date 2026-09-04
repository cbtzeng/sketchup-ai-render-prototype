/**
 * GET /v1/jobs/:id —— 查 job 狀態。
 *
 * 呼叫端：`src/architech_render/net/poller.rb`（每 2s → 5s → 10s 退避輪詢）
 *   response: JobView。poller 讀 `job['status']`；終態時 cloud_backend.rb 讀
 *             `job['error_msg']`、`job['error_code']`，成功時 UI 用 `result_url`。
 *
 * 這個端點是**唯讀**的：它不做任何狀態推進，也不碰 provider。
 * 輪詢是最高頻的請求，任何寫入都會被放大成 DB 壓力與競態。
 *
 * 找不到 job 與「不是自己的 job」一律回同一個 404 ——
 * 用 403 區分等於送給攻擊者一個 job id 存在性的探測器。
 */
import { getRuntimeContext, type ApiContext } from '../../../lib/api-context.js';
import {
  ApiError,
  fromFetchRequest,
  json,
  requireMethod,
  runHandler,
  type ApiRequest,
  type ApiResponse,
} from '../../../lib/http.js';
import { resolveResultUrl, toJobView } from '../../../lib/job-view.js';

/**
 * 診斷碼
 *   JOB-11 405 方法不符（本端點只接受 GET）
 *   JOB-24 400 路徑缺少 job id
 *   JOB-44 404 job 不存在或不屬於這個使用者
 */
export async function handle(req: ApiRequest, ctx: ApiContext): Promise<ApiResponse> {
  requireMethod(req, 'GET', 'JOB-11');
  const { userId } = await ctx.auth.authenticate(req.headers);

  const id = req.params['id'];
  if (!id) throw new ApiError('JOB-24', 400, '路徑缺少 job id');

  const job = await ctx.store.getJob(id);
  if (!job || job.user_id !== userId) {
    throw new ApiError('JOB-44', 404, '找不到這個 job', { id });
  }

  const resultUrl = await resolveResultUrl(ctx, job);
  return json(200, { ok: true, ...toJobView(job, { resultUrl }) });
}

/** 平台入口（Fetch API 形狀）。路由參數從路徑末段取得。 */
export default async function jobByIdRoute(request: Request): Promise<Response> {
  const res = await runHandler(async () => {
    const ctx = getRuntimeContext();
    const id = new URL(request.url).pathname.split('/').filter(Boolean).pop() ?? '';
    return handle(await fromFetchRequest(request, { id }), ctx);
  });
  return new Response(JSON.stringify(res.body), { status: res.status, headers: res.headers });
}
