/**
 * POST /v1/jobs —— 建立 job。雲端的唯一入口（architecture.md 2.2）。
 *
 * 呼叫端：`src/architech_render/net/api_client.rb#create_job`
 *   request : { "scene": "...", "prompt": "...", "preset": "...", "fidelity": 0.6,
 *               "controls": { "beauty": "<sha256>", "edge": "<sha256>", "depth": "<sha256>" },
 *               "output": { "width": 1024, "height": 1024 },
 *               "upload_batch": "..."   // 選填，見下方 🔴
 *               "seed": 12345 }         // 選填
 *   response: JobView（含 id / status），cloud_backend.rb 讀 `job['id']` 與 `job['status']`
 *
 * 本端點做的事，順序不可調換：
 *   1. 驗身分與輸入
 *   2. cost_guard.admit（冪等去重 → 解析度 → 並發 → 每日額度，額度是原子預留）
 *   3. 找到上傳批次，**伺服器端重算 sha256** 與用戶端宣告值比對
 *   4. JobService.create 建 job（狀態機唯一寫入者）
 *   5. 全部校驗通過 → transition created → queued；有不符 → transition created → failed 並釋放額度
 *
 * 為什麼 asset 是「先校驗再 insert」：`db.ts` 的 JobStore 沒有 updateAsset，
 * asset row 一旦寫下就改不了 upload_state。校驗發生在同一個請求內，
 * 因此直接以最終狀態（verified / mismatch）寫入，不留 pending 的中間態。
 *
 * 🔴 待驗證 / 待決
 *   - `upload_batch`：Ruby 端 api_client.rb 目前**沒有**把它帶回來，
 *     缺少時只能退而取「該使用者最近一個未認領批次」（見 lib/upload-batches.ts 的說明）。
 *   - `upload_batches` 這張表不存在於 001_init.sql。
 *   - 事前估價：🔴 provider 計費單位未驗證，目前用 PLACEHOLDER_ESTIMATE_CENTS。
 *   - preset_version：🔴 preset_resolver 未實作，寫入 '0.0.0-unresolved'。
 *   - 同步 submit 給 provider 預設關閉（ctx.submitOnCreate = false）：
 *     轉移表沒有 `queued → failed` / `queued → retrying`（job-service 照表禁止），
 *     submit 當下失敗時無法把狀態寫回去，只能等 sweeper 判 expired。
 *     這是 architecture.md 的缺口，需主 session 決策後才適合打開。
 */
import { admit, utcDayKey, type AdmitResult, type DenyCode } from '../../../lib/cost-guard.js';
import { getRuntimeContext, type ApiContext } from '../../../lib/api-context.js';
import { REQUIRED_CONTROL_KINDS, type AssetKind, type JobRow, type NewAsset } from '../../../lib/db.js';
import {
  ApiError,
  fromFetchRequest,
  isSha256Hex,
  json,
  optionalString,
  parseJsonBody,
  requireInt,
  requireMethod,
  requireNumber,
  requireObject,
  requireString,
  runHandler,
  type ApiRequest,
  type ApiResponse,
} from '../../../lib/http.js';
import { JobService } from '../../../lib/job-service.js';
import { releaseEstimate, resolveResultUrl, toJobView } from '../../../lib/job-view.js';
import { batchPath, type UploadBatchRow } from '../../../lib/upload-batches.js';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../lib/cost-guard.js';

/**
 * 診斷碼
 *   JOB-10 405 方法不符
 *   JOB-20 400 body / 欄位格式錯誤
 *   JOB-21 400 controls 缺 pass 或不是合法 sha256
 *   JOB-22 400 解析度非法（cost-guard RESOLUTION_INVALID）
 *   JOB-23 400 解析度超過上限（cost-guard RESOLUTION_EXCEEDED）
 *   JOB-31 409 並發上限（同時只能 1 個進行中）
 *   JOB-32 429 每日次數上限
 *   JOB-33 429 每日金額上限
 *   JOB-40 409 找不到可用的上傳批次（或批次缺少某個 pass）
 *   JOB-41 502 儲存服務讀不到物件資訊
 *   JOB-42 422 控制圖校驗失敗（未上傳 / sha256 不符），job 已轉 failed
 *   JOB-50 502 provider submit 失敗（僅 submitOnCreate 開啟時）
 */

const DENY_CODE_MAP: Readonly<Record<DenyCode, string>> = {
  RESOLUTION_INVALID: 'JOB-22',
  RESOLUTION_EXCEEDED: 'JOB-23',
  CONCURRENCY_LIMIT: 'JOB-31',
  DAILY_JOB_LIMIT: 'JOB-32',
  DAILY_COST_LIMIT: 'JOB-33',
};

interface CreateJobInput {
  scene: string | null;
  prompt: string;
  preset: string;
  fidelity: number;
  seed: number | null;
  controls: Record<AssetKind, string>;
  width: number;
  height: number;
  uploadBatch: string | null;
  modelGuid: string | null;
}

export async function handle(req: ApiRequest, ctx: ApiContext): Promise<ApiResponse> {
  requireMethod(req, 'POST', 'JOB-10');
  const { userId } = await ctx.auth.authenticate(req.headers);
  const input = parseInput(req);

  // params_json 同時是 idempotency_key 的材料，因此不含 scene 這類純顯示欄位 ——
  // 換個場景名字不該讓同一組控制圖與參數重跑一次（那等於白花錢）。
  const paramsJson = {
    preset: input.preset,
    fidelity: input.fidelity,
    prompt: input.prompt,
    seed: input.seed,
    output: { width: input.width, height: input.height },
    preset_version: ctx.presetVersion,
  };

  const controlsSha256 = createHash('sha256')
    .update(canonicalJson(input.controls), 'utf8')
    .digest('hex');

  const costEstimateCents = ctx.costEstimator.estimateCents({
    preset: input.preset,
    fidelity: input.fidelity,
    width: input.width,
    height: input.height,
  });

  const decision: AdmitResult = await admit(ctx.store, {
    userId,
    controlsSha256,
    paramsJson,
    width: input.width,
    height: input.height,
    costEstimateCents,
    now: ctx.now(),
  });

  if (decision.decision === 'deny') {
    throw new ApiError(DENY_CODE_MAP[decision.code], decision.httpStatus, decision.message, {
      reason: decision.code,
      ...(decision.remaining ? { remaining: decision.remaining } : {}),
    });
  }

  if (decision.decision === 'cache_hit' || decision.decision === 'in_flight') {
    // 冪等命中：回同一個 job，不計費也不算新請求（architecture.md 5.7）。
    const resultUrl = await resolveResultUrl(ctx, decision.job);
    return json(200, {
      ok: true,
      idempotent: true,
      cache_hit: decision.decision === 'cache_hit',
      ...toJobView(decision.job, { resultUrl }),
    });
  }

  // --- decision === 'allow' 之後，額度已經被預留，任何提早返回都必須釋放 ---
  const batch = await resolveBatch(ctx, userId, input);
  if (!batch.ok) {
    await ctx.store.releaseDailyQuota({
      user_id: userId,
      day: utcDayKey(ctx.now()),
      add_jobs: 1,
      add_cents: costEstimateCents,
    });
    throw batch.error;
  }

  const jobId = ctx.newId();
  const service = new JobService(ctx.store, { now: ctx.now });

  let job: JobRow;
  try {
    job = await service.create({
      id: jobId,
      user_id: userId,
      model_guid: input.modelGuid,
      scene_name: input.scene,
      preset: input.preset,
      preset_version: ctx.presetVersion,
      prompt: input.prompt,
      seed: input.seed,
      params_json: paramsJson,
      provider: ctx.defaultProvider,
      idempotency_key: decision.idempotencyKey,
      cost_estimate_cents: costEstimateCents,
      created_at: ctx.now().toISOString(),
    });
  } catch (err) {
    // unique violation：兩個相同請求同時抵達，其中一個 insert 失敗。
    // 依 cost-guard 的說明重讀該 key 回既有 job，並把多佔的額度還回去。
    const existing = await ctx.store.findJobByIdempotencyKey(userId, decision.idempotencyKey);
    await ctx.store.releaseDailyQuota({
      user_id: userId,
      day: utcDayKey(ctx.now()),
      add_jobs: 1,
      add_cents: costEstimateCents,
    });
    if (existing) {
      const resultUrl = await resolveResultUrl(ctx, existing);
      return json(200, { ok: true, idempotent: true, cache_hit: false, ...toJobView(existing, { resultUrl }) });
    }
    throw err;
  }

  await ctx.batches.claimBatch(batch.row.id, jobId);

  // --- 控制圖校驗：伺服器實算 sha256 才算數，用戶端宣告值只是待比對值 ---
  let verification;
  try {
    verification = await verifyControls(ctx, jobId, batch.row, input.controls);
  } catch (err) {
    // 儲存服務掛掉時，job 已經建好了。不收尾的話它會卡在 created 直到 10 分鐘後被判 expired，
    // 使用者則是對著一個永遠不動的進度條。created → failed 是轉移表裡有的邊，就走它。
    const dead = await service.transition(jobId, 'failed', {
      trigger: 'cloud',
      errorCode: 'JOB-41',
      errorMsg: '無法讀取已上傳物件的資訊',
    });
    await releaseEstimate(ctx.store, dead);
    throw err;
  }
  for (const asset of verification.assets) {
    await ctx.store.insertAsset(asset);
  }

  if (verification.problems.length > 0) {
    const failed = await service.transition(jobId, 'failed', {
      trigger: 'cloud',
      errorCode: 'JOB-42',
      errorMsg: `控制圖校驗未通過：${verification.problems.map((p) => p.kind).join(', ')}`,
      detail: { problems: verification.problems },
    });
    await releaseEstimate(ctx.store, failed);
    throw new ApiError('JOB-42', 422, '控制圖校驗未通過', {
      problems: verification.problems,
      job: toJobView(failed),
    });
  }

  let queued = await service.transition(jobId, 'queued', {
    trigger: 'cloud',
    costGuardPassed: true,
    detail: { controls_sha256: controlsSha256 },
  });

  if (ctx.submitOnCreate) {
    queued = await submitToProvider(ctx, queued, batch.row, input, controlsSha256);
  }

  return json(201, {
    ok: true,
    idempotent: false,
    remaining: decision.remaining,
    ...toJobView(queued),
  });
}

// ---------------------------------------------------------------------------
// 輸入解析
// ---------------------------------------------------------------------------

function parseInput(req: ApiRequest): CreateJobInput {
  const body = parseJsonBody(req, 'JOB-20');
  const prompt = requireString(body, 'prompt', 'JOB-20', { maxLength: 2000 });
  const preset = requireString(body, 'preset', 'JOB-20', { maxLength: 100 });
  const fidelity = requireNumber(body, 'fidelity', 'JOB-20', { min: 0, max: 1 });
  const output = requireObject(body, 'output', 'JOB-20');
  const width = requireInt(output, 'width', 'JOB-20');
  const height = requireInt(output, 'height', 'JOB-20');
  const controlsRaw = requireObject(body, 'controls', 'JOB-21');

  const controls = {} as Record<AssetKind, string>;
  for (const kind of REQUIRED_CONTROL_KINDS) {
    const declared = controlsRaw[kind];
    if (!isSha256Hex(declared)) {
      throw new ApiError('JOB-21', 400, `controls.${kind} 必須是 64 字元小寫十六進位 sha256`, {
        kind,
        required: REQUIRED_CONTROL_KINDS,
      });
    }
    controls[kind] = declared;
  }
  for (const key of Object.keys(controlsRaw)) {
    if (!(REQUIRED_CONTROL_KINDS as readonly string[]).includes(key)) {
      throw new ApiError('JOB-21', 400, `controls 含未知的 pass「${key}」`, {
        allowed: REQUIRED_CONTROL_KINDS,
      });
    }
  }

  const seedValue = body['seed'];
  if (seedValue !== undefined && seedValue !== null && !Number.isInteger(seedValue)) {
    throw new ApiError('JOB-20', 400, 'seed 必須是整數或 null');
  }

  return {
    scene: optionalString(body, 'scene', 'JOB-20', { maxLength: 200 }),
    prompt,
    preset,
    fidelity,
    seed: typeof seedValue === 'number' ? seedValue : null,
    controls,
    width,
    height,
    uploadBatch: optionalString(body, 'upload_batch', 'JOB-20', { maxLength: 100 }),
    modelGuid: optionalString(body, 'model_guid', 'JOB-20', { maxLength: 100 }),
  };
}

// ---------------------------------------------------------------------------
// 上傳批次與控制圖校驗
// ---------------------------------------------------------------------------

type BatchResolution = { ok: true; row: UploadBatchRow } | { ok: false; error: ApiError };

async function resolveBatch(
  ctx: ApiContext,
  userId: string,
  input: CreateJobInput,
): Promise<BatchResolution> {
  const row = input.uploadBatch
    ? await ctx.batches.getBatch(input.uploadBatch)
    : await ctx.batches.findLatestUnclaimedBatch(userId);

  if (!row) {
    return {
      ok: false,
      error: new ApiError('JOB-40', 409, '找不到對應的上傳批次，請重新取得上傳 URL', {
        upload_batch: input.uploadBatch,
      }),
    };
  }
  if (row.user_id !== userId) {
    // 不回 403，避免洩漏別人的批次是否存在。
    return { ok: false, error: new ApiError('JOB-40', 409, '找不到對應的上傳批次，請重新取得上傳 URL') };
  }
  if (row.claimed_by_job_id !== null) {
    return {
      ok: false,
      error: new ApiError('JOB-40', 409, '這個上傳批次已被其他 job 使用', {
        upload_batch: row.id,
      }),
    };
  }
  for (const kind of REQUIRED_CONTROL_KINDS) {
    if (!batchPath(row, kind)) {
      return {
        ok: false,
        error: new ApiError('JOB-40', 409, `上傳批次缺少 ${kind} 的物件路徑`, { upload_batch: row.id }),
      };
    }
  }
  return { ok: true, row };
}

interface ControlProblem {
  kind: AssetKind;
  reason: 'missing' | 'sha256_mismatch';
  declared: string;
  actual?: string;
}

async function verifyControls(
  ctx: ApiContext,
  jobId: string,
  batch: UploadBatchRow,
  controls: Record<AssetKind, string>,
): Promise<{ assets: NewAsset[]; problems: ControlProblem[] }> {
  const assets: NewAsset[] = [];
  const problems: ControlProblem[] = [];

  for (const kind of REQUIRED_CONTROL_KINDS) {
    const path = batchPath(batch, kind);
    if (!path) continue; // resolveBatch 已擋掉，這裡只是型別收斂
    const declared = controls[kind];

    let stat;
    try {
      stat = await ctx.storage.statObject(path);
    } catch (err) {
      throw new ApiError('JOB-41', 502, '無法讀取已上傳物件的資訊', {
        kind,
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    if (!stat) {
      problems.push({ kind, reason: 'missing', declared });
      assets.push({
        job_id: jobId,
        kind,
        storage_path: path,
        width: null,
        height: null,
        sha256: null,
        sha256_declared: declared,
        upload_state: 'pending',
      });
      continue;
    }

    const matched = stat.sha256 === declared;
    if (!matched) {
      problems.push({ kind, reason: 'sha256_mismatch', declared, actual: stat.sha256 });
    }
    assets.push({
      job_id: jobId,
      kind,
      storage_path: path,
      width: null, // 🔴 尺寸校驗需要解析 PNG header，尚未實作（alignment 由 Ruby 端保證）
      height: null,
      sha256: stat.sha256,
      sha256_declared: declared,
      upload_state: matched ? 'verified' : 'mismatch',
    });
  }

  return { assets, problems };
}

// ---------------------------------------------------------------------------
// provider 派工（預設關閉）
// ---------------------------------------------------------------------------

async function submitToProvider(
  ctx: ApiContext,
  job: JobRow,
  batch: UploadBatchRow,
  input: CreateJobInput,
  controlsSha256: string,
): Promise<JobRow> {
  const registration = ctx.providers.get(job.provider ?? ctx.defaultProvider);
  if (!registration) {
    throw new ApiError('JOB-50', 501, `provider ${job.provider} 尚未註冊`, {
      registered: ctx.providers.names(),
    });
  }

  const controls = [];
  for (const kind of REQUIRED_CONTROL_KINDS) {
    const path = batchPath(batch, kind);
    if (!path) continue;
    controls.push({
      kind,
      url: await ctx.storage.createSignedDownloadUrl(path, 900),
      sha256: input.controls[kind],
      width: input.width,
      height: input.height,
    });
  }

  try {
    const result = await registration.adapter.submit({
      jobId: job.id,
      idempotencyKey: job.idempotency_key,
      presetVersion: ctx.presetVersion,
      prompt: input.prompt,
      seed: input.seed,
      params: { preset: input.preset, fidelity: input.fidelity, controls_sha256: controlsSha256 },
      controls,
      webhookUrl: `${ctx.webhookBaseUrl}/${registration.adapter.name}`,
    });
    // provider 已接受但尚未開跑：provider_job_id 要先落地，
    // 否則 webhook 回來時反查不到 job（jobs_provider_job_id_idx 就是為此而存在）。
    // 🔴 缺口：`queued` 狀態下沒有合法轉移可用來只寫 provider_job_id，
    //    這裡直接用 store.updateJob 寫非 status 欄位（不碰 status，仍守住「狀態機唯一寫入者」）。
    const updated = await ctx.store.updateJob(
      job.id,
      { provider_job_id: result.providerJobId },
      { status: 'queued' },
    );
    return updated ?? job;
  } catch (err) {
    // 轉移表沒有 queued → failed / retrying，因此這裡**無法**把 job 標成失敗。
    // job 會留在 queued，直到 sweeper 判 expired。這是已知缺口，不假裝處理掉。
    throw new ApiError('JOB-50', 502, 'provider 拒絕或無法接受這個請求', {
      job_id: job.id,
      note: '轉移表缺 queued → failed / retrying，job 目前留在 queued 等待 expired',
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 平台入口（Fetch API 形狀）。 */
export default async function jobsRoute(request: Request): Promise<Response> {
  const res = await runHandler(async () => {
    const ctx = getRuntimeContext();
    return handle(await fromFetchRequest(request), ctx);
  });
  return new Response(JSON.stringify(res.body), { status: res.status, headers: res.headers });
}
