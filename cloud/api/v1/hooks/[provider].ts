/**
 * POST /v1/hooks/:provider —— provider webhook。
 *
 * ⚠️ 這是整個雲端層**唯一沒有使用者身分**的寫入入口。
 * 沒驗簽章的 webhook 端點 = 任何人都能把別人的 job 改成 succeeded、
 * 或偽造一筆 cost_actual_cents。因此本檔的第一條規則是：
 * **簽章驗證通過之前，一個位元組的 body 都不解析。**
 *
 * 🔴 待驗證（全部委派給 `WebhookVerifier` / `ProviderAdapter`，本檔不含任何 provider 細節）
 *   - fal.ai webhook 簽章的 header 名稱
 *   - 簽章的計算材料（raw body？timestamp + body？）
 *   - 驗章演算法（HMAC-SHA256？Ed25519 公鑰？）與金鑰來源
 *   - 是否有 timestamp 防重放欄位與容許時間窗
 *   - webhook payload 的 schema：provider job id 的欄位名、狀態欄位的取值、
 *     結果圖的欄位與是否為短效 URL、錯誤碼的形狀
 *   - **計費資訊是否隨 webhook 回傳、單位是什麼** —— 沒有它 cost_actual_cents 永遠是 null
 *   - provider 對非 2xx 回應的重送策略（決定「已處理但不適用」該回 200 還是 4xx/5xx）
 *
 * 在上述項目落地之前，`lib/providers/registry.ts` 的預設驗證器一律拒絕（fail-closed）。
 *
 * 本端點**不決定狀態機怎麼走**的部分只有一處：錯誤要重試還是失敗，
 * 交給 cost-guard 的 classifyProviderError + shouldRetry；狀態寫入一律經 JobService。
 */
import { getRuntimeContext, type ApiContext } from '../../../lib/api-context.js';
import { classifyProviderError, shouldRetry } from '../../../lib/cost-guard.js';
import type { JobRow } from '../../../lib/db.js';
import { isTerminal } from '../../../lib/db.js';
import {
  ApiError,
  fromFetchRequest,
  json,
  requireMethod,
  runHandler,
  type ApiRequest,
  type ApiResponse,
} from '../../../lib/http.js';
import { JobService, JobTransitionError } from '../../../lib/job-service.js';
import {
  COST_DRIFT_ALERT_RATIO,
  reconcileActualCost,
  releaseEstimate,
  toJobView,
} from '../../../lib/job-view.js';
import type { NormalizedProviderEvent, ProviderWebhookInput } from '../../../lib/providers/types.js';
import { WebhookSignatureError } from '../../../lib/providers/types.js';

/**
 * 診斷碼
 *   HOOK-10 405 方法不符（只接受 POST）
 *   HOOK-11 501 執行環境沒有提供 provider_job_id 反查（ctx.jobLookup 未接線）
 *   HOOK-20 404 未註冊的 provider
 *   HOOK-30 401 簽章驗證失敗（**唯一會回 401 的情況**）
 *   HOOK-40 400 normalize 失敗（payload schema 與 adapter 預期不符）
 *   HOOK-41 404 找不到對應的 job（provider_job_id 反查不到）
 *   HOOK-50 409 狀態機拒絕這次轉移（附 reason，供對帳）
 *
 * 回應語意：
 *   200 已套用；202 已驗章並判定為重複／過期事件，刻意不套用（避免 provider 無限重送）
 */
export async function handle(req: ApiRequest, ctx: ApiContext): Promise<ApiResponse> {
  requireMethod(req, 'POST', 'HOOK-10');

  const providerName = req.params['provider'];
  const registration = providerName ? ctx.providers.get(providerName) : null;
  if (!providerName || !registration) {
    throw new ApiError('HOOK-20', 404, '未註冊的 provider', {
      provider: providerName ?? null,
      registered: ctx.providers.names(),
    });
  }

  const input: ProviderWebhookInput = {
    headers: { ...req.headers },
    rawBody: req.rawBody, // 原始字串，未經 JSON.parse → stringify
    receivedAt: ctx.now().toISOString(),
  };

  // --- 1. 驗簽章。在這行之前不碰 body 的內容。 ---
  await verifySignature(registration.verifier, input);

  // --- 2. 標準化。adapter 是唯一知道 payload schema 的地方。 ---
  let event: NormalizedProviderEvent;
  try {
    event = registration.adapter.normalize(input);
  } catch (err) {
    throw new ApiError('HOOK-40', 400, 'webhook payload 無法標準化', {
      provider: providerName,
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  // --- 3. 反查 job ---
  if (!ctx.jobLookup) {
    throw new ApiError('HOOK-11', 501, '尚未接上 provider_job_id 反查（見 lib/job-lookup.ts）');
  }
  const job = await ctx.jobLookup.findJobByProviderJobId(providerName, event.providerJobId);
  if (!job) {
    throw new ApiError('HOOK-41', 404, '找不到對應的 job', {
      provider: providerName,
      provider_job_id: event.providerJobId,
    });
  }

  // 遲到的 webhook：job 已經是終態就不再動它，但仍回 2xx，
  // 否則 provider 會對一個永遠不會改變的結果無限重送。
  if (isTerminal(job.status)) {
    return json(202, {
      ok: true,
      applied: false,
      reason: 'job_already_terminal',
      ...toJobView(job),
    });
  }

  const service = new JobService(ctx.store, { now: ctx.now });

  switch (event.kind) {
    case 'accepted':
    case 'running':
      return applyRunning(service, job, event);
    case 'succeeded':
      return applySucceeded(ctx, service, job, event);
    case 'failed':
      return applyFailed(ctx, service, job, event);
  }
}

async function verifySignature(
  verifier: { verify(input: ProviderWebhookInput): Promise<boolean> | boolean },
  input: ProviderWebhookInput,
): Promise<void> {
  let ok: boolean;
  try {
    ok = await verifier.verify(input);
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      throw new ApiError('HOOK-30', 401, err.message);
    }
    throw err;
  }
  if (!ok) throw new ApiError('HOOK-30', 401, 'webhook 簽章驗證失敗');
}

// ---------------------------------------------------------------------------
// 事件套用
// ---------------------------------------------------------------------------

async function applyRunning(
  service: JobService,
  job: JobRow,
  event: NormalizedProviderEvent,
): Promise<ApiResponse> {
  if (job.status === 'running') {
    // 重複的 running 事件：冪等，不再寫一次（job_events 是軌跡，不是流水帳）。
    return json(202, { ok: true, applied: false, reason: 'already_running', ...toJobView(job) });
  }
  const updated = await guarded(service, job, 'running', {
    trigger: 'provider',
    providerJobId: event.providerJobId,
    detail: { event_kind: event.kind, received_at: event.receivedAt },
  });
  return json(200, { ok: true, applied: true, ...toJobView(updated) });
}

async function applySucceeded(
  ctx: ApiContext,
  service: JobService,
  job: JobRow,
  event: NormalizedProviderEvent,
): Promise<ApiResponse> {
  // provider 若只送最終事件（沒送過 running），queued → succeeded 是非法的。
  // 補一筆 queued → running 而不是放寬轉移表：這個 job 確實跑過，
  // 軌跡上留下 running 是事實，不是為了繞過檢查而捏造的狀態。
  const current = await ensureRunning(service, job, event);

  await storeResultAsset(ctx, current, event);

  const costActual = event.costActualCents;
  const updated = await guarded(service, current, 'succeeded', {
    trigger: 'provider',
    ...(costActual !== undefined ? { costActualCents: costActual } : {}),
    detail: { event_kind: event.kind, received_at: event.receivedAt },
  });

  let drift: { diffCents: number; overEstimateRatio: number | null } | null = null;
  if (costActual !== undefined) {
    drift = await reconcileActualCost(ctx.store, updated, costActual);
  }
  const alert = drift?.overEstimateRatio !== null && drift?.overEstimateRatio !== undefined
    ? drift.overEstimateRatio > COST_DRIFT_ALERT_RATIO
    : false;

  return json(200, {
    ok: true,
    applied: true,
    // architecture.md 5.9：偏差 > 20% 要告警，估算失準本身就是需要修的 bug。
    cost_drift_alert: alert,
    ...(drift ? { cost_diff_cents: drift.diffCents } : {}),
    ...toJobView(updated),
  });
}

async function applyFailed(
  ctx: ApiContext,
  service: JobService,
  job: JobRow,
  event: NormalizedProviderEvent,
): Promise<ApiResponse> {
  const current = await ensureRunning(service, job, event);

  // httpStatus 缺席時 classifyProviderError 回 'none' → 不可重試。
  // 這是刻意的保守預設：分類不明的錯誤重試只是燒錢（architecture.md 5.6）。
  const errorClass = classifyProviderError({ httpStatus: event.httpStatus });
  const decision = shouldRetry({ errorClass, retryCount: current.retry_count });

  if (decision.retry) {
    const updated = await guarded(service, current, 'retrying', {
      trigger: 'cloud',
      errorClass,
      errorCode: event.errorCode ?? 'PROV-5XX',
      errorMsg: event.errorMsg ?? 'provider 回報可重試的錯誤',
      detail: { event_kind: event.kind, backoff_ms: decision.delayMs, received_at: event.receivedAt },
    });
    // 🔴 retrying → queued 的退避重送需要一個排程器（sweeper / queue），尚未實作。
    return json(200, {
      ok: true,
      applied: true,
      retry_scheduled: true,
      backoff_ms: decision.delayMs,
      ...toJobView(updated),
    });
  }

  const costActual = event.costActualCents;
  const updated = await guarded(service, current, 'failed', {
    trigger: 'cloud',
    errorClass,
    errorCode: event.errorCode ?? 'PROV-FAIL',
    errorMsg: event.errorMsg ?? 'provider 回報失敗',
    ...(costActual !== undefined ? { costActualCents: costActual } : {}),
    detail: { event_kind: event.kind, reason: decision.reason, received_at: event.receivedAt },
  });

  // 失敗的 job 把預留的估算金額全額釋放（architecture.md 第 3 節）。
  // provider 若回報了實際費用，那筆錢是真的花掉了，因此改走回填而不是釋放。
  if (costActual !== undefined && costActual > 0) {
    await reconcileActualCost(ctx.store, updated, costActual);
  } else {
    await releaseEstimate(ctx.store, updated);
  }

  return json(200, { ok: true, applied: true, retry_scheduled: false, ...toJobView(updated) });
}

/** queued 直接收到終態事件時，先補上 running 這一步，讓軌跡完整。 */
async function ensureRunning(
  service: JobService,
  job: JobRow,
  event: NormalizedProviderEvent,
): Promise<JobRow> {
  if (job.status !== 'queued') return job;
  return guarded(service, job, 'running', {
    trigger: 'provider',
    providerJobId: event.providerJobId,
    detail: { event_kind: event.kind, inferred: 'provider 只送了終態事件，補記 running' },
  });
}

/** 把 JobTransitionError 轉成帶診斷碼的 409，避免把內部例外原樣吐給 provider。 */
async function guarded(
  service: JobService,
  job: JobRow,
  to: Parameters<JobService['transition']>[1],
  ctx: Parameters<JobService['transition']>[2],
): Promise<JobRow> {
  try {
    return await service.transition(job.id, to, ctx);
  } catch (err) {
    if (err instanceof JobTransitionError) {
      throw new ApiError('HOOK-50', 409, `狀態機拒絕 ${job.status} → ${to}`, {
        reason: err.code,
        message: err.message,
        job_id: job.id,
      });
    }
    throw err;
  }
}

/**
 * 結果圖落地。
 * 🔴 MVP 直接把 provider 回傳的 URL 存進 assets.storage_path，**沒有轉存到自家 storage**。
 *    provider 的結果 URL 多半是短效的，過期後 result_url 就失效 ——
 *    正式版必須先下載再存，這裡不假裝已經做到。
 */
async function storeResultAsset(
  ctx: ApiContext,
  job: JobRow,
  event: NormalizedProviderEvent,
): Promise<void> {
  const first = event.results?.[0];
  if (!first) return;
  const existing = await ctx.store.listAssets(job.id);
  if (existing.some((a) => a.kind === 'result')) return; // assets(job_id, kind) 是 unique
  await ctx.store.insertAsset({
    job_id: job.id,
    kind: 'result',
    storage_path: first.url,
    width: first.width ?? null,
    height: first.height ?? null,
    sha256: first.sha256 ?? null,
    sha256_declared: null,
    upload_state: 'uploaded',
  });
}

/** 平台入口（Fetch API 形狀）。路徑形如 /v1/hooks/:provider。 */
export default async function hooksRoute(request: Request): Promise<Response> {
  const res = await runHandler(async () => {
    const ctx = getRuntimeContext();
    const provider = new URL(request.url).pathname.split('/').filter(Boolean).pop() ?? '';
    return handle(await fromFetchRequest(request, { provider }), ctx);
  });
  return new Response(JSON.stringify(res.body), { status: res.status, headers: res.headers });
}
