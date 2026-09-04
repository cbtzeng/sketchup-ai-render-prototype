/**
 * POST /v1/jobs/:id/cancel —— 使用者取消。
 *
 * 呼叫端：`src/architech_render/net/api_client.rb#cancel_job`（body 為 `{}`）
 *
 * 狀態機（job-service.ts 的 LEGAL_TRANSITIONS）目前只允許
 *   queued → cancelled、running → cancelled
 * `created → cancelled` 與 `retrying → cancelled` **不在 architecture.md 的原轉移表內**，
 * job-service 刻意照表禁止並把缺口列入回報。因此本端點在那兩個狀態下回 409，
 * 訊息明說「目前只能等逾時」——**不假裝取消成功**，那會讓使用者以為不會被計費。
 *
 * 對 provider 發 cancel 是 best-effort（architecture.md 轉移表），
 * 但 ProviderAdapter 介面刻意只有 submit / normalize 兩個方法，沒有 cancel。
 * 🔴 需主 session 決策：provider 端的取消要放哪裡（新介面？還是接受不取消、只停止計費歸屬）。
 */
import { getRuntimeContext, type ApiContext } from '../../../../lib/api-context.js';
import { isTerminal } from '../../../../lib/db.js';
import {
  ApiError,
  fromFetchRequest,
  json,
  requireMethod,
  runHandler,
  type ApiRequest,
  type ApiResponse,
} from '../../../../lib/http.js';
import { JobService, JobTransitionError } from '../../../../lib/job-service.js';
import { releaseEstimate, toJobView } from '../../../../lib/job-view.js';

/**
 * 診斷碼
 *   JOB-12 405 方法不符（只接受 POST）
 *   JOB-24 400 路徑缺少 job id
 *   JOB-44 404 job 不存在或不屬於這個使用者
 *   JOB-60 409 目前狀態不可取消（created / retrying —— 轉移表缺這兩條邊）
 *   JOB-61 409 job 已進入終態（succeeded / failed / expired）
 *   JOB-62 409 取消時狀態已被其他路徑改掉（CAS 失敗），請重新查詢
 */
export async function handle(req: ApiRequest, ctx: ApiContext): Promise<ApiResponse> {
  requireMethod(req, 'POST', 'JOB-12');
  const { userId } = await ctx.auth.authenticate(req.headers);

  const id = req.params['id'];
  if (!id) throw new ApiError('JOB-24', 400, '路徑缺少 job id');

  const job = await ctx.store.getJob(id);
  if (!job || job.user_id !== userId) {
    throw new ApiError('JOB-44', 404, '找不到這個 job', { id });
  }

  // 已取消：回 200 當作冪等成功。使用者連按兩次取消不該看到錯誤。
  if (job.status === 'cancelled') {
    return json(200, { ok: true, cancelled: true, already: true, ...toJobView(job) });
  }
  if (isTerminal(job.status)) {
    throw new ApiError('JOB-61', 409, `job 已經是 ${job.status}，無法取消`, { status: job.status });
  }
  if (job.status === 'created' || job.status === 'retrying') {
    throw new ApiError(
      'JOB-60',
      409,
      `目前狀態 ${job.status} 不支援取消（轉移表缺這條邊），只能等逾時`,
      { status: job.status, gap: `${job.status} → cancelled 不在 architecture.md 的轉移表內` },
    );
  }

  const service = new JobService(ctx.store, { now: ctx.now });
  let cancelled;
  try {
    cancelled = await service.transition(id, 'cancelled', {
      trigger: 'user',
      errorCode: 'JOB-CANCELLED',
      errorMsg: '使用者取消',
    });
  } catch (err) {
    if (err instanceof JobTransitionError) {
      throw new ApiError('JOB-62', 409, '狀態已改變，取消未生效，請重新查詢', {
        reason: err.code,
        message: err.message,
      });
    }
    throw err;
  }

  // 取消後把預留的估算金額還回去（architecture.md 第 3 節成本回填）。
  await releaseEstimate(ctx.store, cancelled);

  return json(200, {
    ok: true,
    cancelled: true,
    already: false,
    // 🔴 尚未對 provider 發 cancel：ProviderAdapter 沒有 cancel 方法（見檔頭）。
    provider_cancel: 'not_implemented',
    ...toJobView(cancelled),
  });
}

/** 平台入口（Fetch API 形狀）。路徑形如 /v1/jobs/:id/cancel。 */
export default async function cancelRoute(request: Request): Promise<Response> {
  const res = await runHandler(async () => {
    const ctx = getRuntimeContext();
    const segments = new URL(request.url).pathname.split('/').filter(Boolean);
    const id = segments[segments.length - 2] ?? '';
    return handle(await fromFetchRequest(request, { id }), ctx);
  });
  return new Response(JSON.stringify(res.body), { status: res.status, headers: res.headers });
}
