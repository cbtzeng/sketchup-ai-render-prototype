/**
 * POST /v1/jobs 的端點測試。端點本體在 `cloud/api/v1/jobs/index.ts`。
 *
 * 重點覆蓋的三件事：
 *   1. 冪等（重送不重複計費）
 *   2. 成本護欄的拒絕路徑，以及**被拒時預留的額度有沒有還回去**
 *   3. sha256 校驗以伺服器實算值為準
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle as createJob } from '../../api/v1/jobs/index.js';
import { handle as requestUploads } from '../../api/v1/uploads.js';
import { PLACEHOLDER_ESTIMATE_CENTS } from '../api-context.js';
import { bodyOf, catchApiError, fakeProvider, harness, makeRequest, TOKENS, USERS, type Harness } from './harness.js';

const PASSES = ['beauty', 'edge', 'depth'] as const;
const DAY = '2026-09-04';

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** 走完 uploads → 實際上傳 → 得到 controls 宣告雜湊。 */
async function uploadControls(h: Harness, opts: { corrupt?: string; skip?: string } = {}) {
  const res = await requestUploads(makeRequest({ method: 'POST', body: { passes: [...PASSES] } }), h.ctx);
  const body = bodyOf(res);
  const paths = body['paths'] as Record<string, string>;
  const controls: Record<string, string> = {};

  for (const pass of PASSES) {
    const content = `${pass}-bytes`;
    controls[pass] = sha256(content);
    if (opts.skip === pass) continue;
    // corrupt：模擬「上傳的內容與宣告的雜湊不符」（例如二進位被當文字處理）
    h.storage.putObject(paths[pass]!, opts.corrupt === pass ? 'corrupted' : content);
  }
  return { batchId: body['upload_batch'] as string, controls, paths };
}

function jobBody(controls: Record<string, string>, over: Record<string, unknown> = {}) {
  return {
    scene: 'Scene 1',
    prompt: 'a modern house at dusk',
    preset: 'exterior',
    fidelity: 0.6,
    controls,
    output: { width: 1024, height: 1024 },
    ...over,
  };
}

describe('POST /v1/jobs', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('happy path：建立 job、校驗控制圖、轉入 queued，並留下完整軌跡', async () => {
    const { controls, batchId } = await uploadControls(h);
    const res = await createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx);

    expect(res.status).toBe(201);
    const body = bodyOf(res);
    expect(body['status']).toBe('queued');
    expect(typeof body['id']).toBe('string');
    expect(body['preset_version']).toBe('0.0.0-unresolved'); // 🔴 preset_resolver 未實作

    const jobId = body['id'] as string;
    const events = await h.store.listJobEvents(jobId);
    expect(events.map((e) => `${e.from_status ?? '∅'}→${e.to_status}`)).toEqual([
      '∅→created',
      'created→queued',
    ]);

    const assets = await h.store.listAssets(jobId);
    expect(assets).toHaveLength(3);
    expect(assets.every((a) => a.upload_state === 'verified')).toBe(true);
    expect(assets.every((a) => a.sha256 === a.sha256_declared)).toBe(true);

    const batch = await h.batches.getBatch(batchId);
    expect(batch?.claimed_by_job_id).toBe(jobId); // 批次已認領，不會被第二個 job 重用
  });

  it('額度被預留，回應帶剩餘額度', async () => {
    const { controls } = await uploadControls(h);
    const res = await createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx);
    const remaining = bodyOf(res)['remaining'] as { jobs: number; cents: number };
    expect(remaining.jobs).toBe(29);
    expect(remaining.cents).toBe(200 - PLACEHOLDER_ESTIMATE_CENTS);
    expect(h.store.usage.get(`${USERS.a}::${DAY}`)).toMatchObject({ jobs_count: 1 });
  });

  it('sha256 不符 → 422 JOB-42，job 轉 failed，預留金額釋放', async () => {
    const { controls } = await uploadControls(h, { corrupt: 'edge' });
    const err = await catchApiError(() =>
      createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'JOB-42', httpStatus: 422 });

    const detail = err.detail as { problems: Array<{ kind: string; reason: string }>; job: { id: string; status: string } };
    expect(detail.problems).toEqual([{ kind: 'edge', reason: 'sha256_mismatch', declared: controls['edge'], actual: sha256('corrupted') }]);
    expect(detail.job.status).toBe('failed');

    const assets = await h.store.listAssets(detail.job.id);
    expect(assets.find((a) => a.kind === 'edge')?.upload_state).toBe('mismatch');
    expect(assets.find((a) => a.kind === 'beauty')?.upload_state).toBe('verified');
    // 沒真的算圖就不該扣錢
    expect(h.store.usage.get(`${USERS.a}::${DAY}`)?.cents_spent).toBe(0);
  });

  it('控制圖根本沒上傳 → 422 JOB-42，reason 為 missing', async () => {
    const { controls } = await uploadControls(h, { skip: 'depth' });
    const err = await catchApiError(() =>
      createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'JOB-42', httpStatus: 422 });
    expect(JSON.stringify(err.detail)).toContain('"reason":"missing"');
  });

  it('儲存服務讀不到物件 → 502 JOB-41，job 轉 failed 收尾（不讓使用者對著卡住的進度條）', async () => {
    const { controls } = await uploadControls(h);
    const original = h.storage.statObject.bind(h.storage);
    h.storage.statObject = async () => {
      throw new Error('storage down');
    };
    const err = await catchApiError(() =>
      createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'JOB-41', httpStatus: 502 });

    const job = [...h.store.jobs.values()][0];
    expect(job?.status).toBe('failed');
    expect(job?.error_code).toBe('JOB-41');
    expect(h.store.usage.get(`${USERS.a}::${DAY}`)?.cents_spent).toBe(0);
    h.storage.statObject = original;
  });

  it('重送同一個請求（in_flight）→ 回同一個 job，不重複計費', async () => {
    const { controls } = await uploadControls(h);
    const first = bodyOf(await createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx));

    // 第二次重送（Ruby 端的網路重試就是這個情境）
    const res = await createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx);
    expect(res.status).toBe(200);
    const second = bodyOf(res);
    expect(second['id']).toBe(first['id']);
    expect(second['idempotent']).toBe(true);
    expect(second['cache_hit']).toBe(false);
    expect(h.store.usage.get(`${USERS.a}::${DAY}`)).toMatchObject({ jobs_count: 1, cents_spent: PLACEHOLDER_ESTIMATE_CENTS });
  });

  it('key 的材料與欄位順序無關（canonical JSON）', async () => {
    const { controls } = await uploadControls(h);
    const first = bodyOf(await createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx));
    // 相同內容、不同 key 順序
    const reordered = { output: { height: 1024, width: 1024 }, fidelity: 0.6, preset: 'exterior', prompt: 'a modern house at dusk', controls, scene: 'Scene 1' };
    const second = bodyOf(await createJob(makeRequest({ method: 'POST', body: reordered }), h.ctx));
    expect(second['id']).toBe(first['id']);
  });

  it('冪等命中已成功的 job → cache_hit，直接回結果 URL，成本 0', async () => {
    const { controls } = await uploadControls(h);
    const first = bodyOf(await createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx));
    const jobId = first['id'] as string;

    // 手動把 job 推到 succeeded 並放一張結果圖
    const job = await h.store.getJob(jobId);
    await h.store.updateJob(jobId, { status: 'running' }, { status: 'queued' });
    await h.store.updateJob(jobId, { status: 'succeeded' }, { status: 'running' });
    await h.store.insertAsset({
      job_id: jobId, kind: 'result', storage_path: 'results/x.png',
      width: 1024, height: 1024, sha256: null, sha256_declared: null, upload_state: 'uploaded',
    });
    expect(job?.status).toBe('queued');

    const res = await createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx);
    expect(res.status).toBe(200);
    expect(bodyOf(res)['cache_hit']).toBe(true);
    expect(bodyOf(res)['result_url']).toContain('results/x.png');
  });

  it('並發上限 → 409 JOB-31', async () => {
    await h.store.insertJob({
      id: 'job_running', user_id: USERS.a, model_guid: null, scene_name: null, preset: null,
      preset_version: null, prompt: null, seed: null, params_json: {}, provider: 'fal',
      idempotency_key: 'other-key', cost_estimate_cents: 5,
      created_at: '2026-09-04T11:59:00.000Z', status: 'running',
    });
    const { controls } = await uploadControls(h);
    const err = await catchApiError(() =>
      createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'JOB-31', httpStatus: 409 });
  });

  it('每日次數上限 → 429 JOB-32，並附剩餘額度', async () => {
    h.store.usage.set(`${USERS.a}::${DAY}`, { user_id: USERS.a, day: DAY, jobs_count: 30, cents_spent: 30 });
    const { controls } = await uploadControls(h);
    const err = await catchApiError(() =>
      createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'JOB-32', httpStatus: 429 });
    expect(err.detail).toMatchObject({ remaining: { jobs: 0 } });
  });

  it('每日金額上限 → 429 JOB-33', async () => {
    h.store.usage.set(`${USERS.a}::${DAY}`, { user_id: USERS.a, day: DAY, jobs_count: 2, cents_spent: 199 });
    const { controls } = await uploadControls(h);
    const err = await catchApiError(() =>
      createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'JOB-33', httpStatus: 429 });
  });

  it('解析度超過單邊上限 → 400 JOB-23（額度不該被佔用）', async () => {
    const { controls } = await uploadControls(h);
    const err = await catchApiError(() =>
      createJob(makeRequest({ method: 'POST', body: jobBody(controls, { output: { width: 2048, height: 1024 } }) }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'JOB-23', httpStatus: 400 });
    expect(h.store.usage.get(`${USERS.a}::${DAY}`)).toBeUndefined();
  });

  it('解析度非正整數 → 400 JOB-20（格式）／JOB-22（語意）', async () => {
    const { controls } = await uploadControls(h);
    expect(
      await catchApiError(() =>
        createJob(makeRequest({ method: 'POST', body: jobBody(controls, { output: { width: 1024.5, height: 1024 } }) }), h.ctx),
      ),
    ).toMatchObject({ code: 'JOB-20', httpStatus: 400 });
    expect(
      await catchApiError(() =>
        createJob(makeRequest({ method: 'POST', body: jobBody(controls, { output: { width: 0, height: 1024 } }) }), h.ctx),
      ),
    ).toMatchObject({ code: 'JOB-22', httpStatus: 400 });
  });

  it('controls 缺 pass 或不是 sha256 → 400 JOB-21', async () => {
    const { controls } = await uploadControls(h);
    const { depth: _drop, ...missing } = controls;
    expect(
      await catchApiError(() => createJob(makeRequest({ method: 'POST', body: jobBody(missing) }), h.ctx)),
    ).toMatchObject({ code: 'JOB-21', httpStatus: 400 });

    expect(
      await catchApiError(() =>
        createJob(makeRequest({ method: 'POST', body: jobBody({ ...controls, depth: 'ABC' }) }), h.ctx),
      ),
    ).toMatchObject({ code: 'JOB-21' });

    // 大寫十六進位也不接受：sha256 一律小寫，否則同一張圖會有兩種寫法
    expect(
      await catchApiError(() =>
        createJob(makeRequest({ method: 'POST', body: jobBody({ ...controls, depth: controls['depth']!.toUpperCase() }) }), h.ctx),
      ),
    ).toMatchObject({ code: 'JOB-21' });
  });

  it('未知的 pass 出現在 controls → 400 JOB-21', async () => {
    const { controls } = await uploadControls(h);
    const err = await catchApiError(() =>
      createJob(makeRequest({ method: 'POST', body: jobBody({ ...controls, normal: sha256('x') }) }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'JOB-21' });
  });

  it('prompt / preset / fidelity 的驗證', async () => {
    const { controls } = await uploadControls(h);
    expect(
      await catchApiError(() => createJob(makeRequest({ method: 'POST', body: jobBody(controls, { prompt: '' }) }), h.ctx)),
    ).toMatchObject({ code: 'JOB-20' });
    expect(
      await catchApiError(() => createJob(makeRequest({ method: 'POST', body: jobBody(controls, { fidelity: 1.5 }) }), h.ctx)),
    ).toMatchObject({ code: 'JOB-20' });
    expect(
      await catchApiError(() => createJob(makeRequest({ method: 'POST', body: jobBody(controls, { preset: 123 }) }), h.ctx)),
    ).toMatchObject({ code: 'JOB-20' });
  });

  it('沒有可用的上傳批次 → 409 JOB-40，且預留的額度已釋放', async () => {
    const controls = { beauty: sha256('a'), edge: sha256('b'), depth: sha256('c') };
    const err = await catchApiError(() =>
      createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'JOB-40', httpStatus: 409 });
    expect(h.store.usage.get(`${USERS.a}::${DAY}`)).toMatchObject({ jobs_count: 0, cents_spent: 0 });
  });

  it('明確指定 upload_batch 時使用該批次；別人的批次一律當成找不到', async () => {
    const mine = await uploadControls(h);
    const res = await createJob(
      makeRequest({ method: 'POST', body: jobBody(mine.controls, { upload_batch: mine.batchId }) }),
      h.ctx,
    );
    expect(res.status).toBe(201);

    const other = await requestUploads(makeRequest({ method: 'POST', token: TOKENS.b, body: { passes: [...PASSES] } }), h.ctx);
    const otherBatch = bodyOf(other)['upload_batch'] as string;
    const err = await catchApiError(() =>
      createJob(makeRequest({ method: 'POST', body: jobBody(mine.controls, { upload_batch: otherBatch, prompt: 'another' }) }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'JOB-40', httpStatus: 409 });
  });

  it('批次已被別的 job 認領 → 409 JOB-40', async () => {
    const { controls, batchId } = await uploadControls(h);
    await createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx);
    const err = await catchApiError(() =>
      createJob(makeRequest({ method: 'POST', body: jobBody(controls, { upload_batch: batchId, prompt: 'different prompt' }) }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'JOB-40' });
  });

  it('只接受 POST，且需要授權', async () => {
    expect(await catchApiError(() => createJob(makeRequest({ method: 'GET' }), h.ctx))).toMatchObject({
      code: 'JOB-10', httpStatus: 405,
    });
    expect(
      await catchApiError(() => createJob(makeRequest({ method: 'POST', token: null, body: {} }), h.ctx)),
    ).toMatchObject({ code: 'AUTH-10', httpStatus: 401 });
  });

  it('submitOnCreate 開啟時把 provider_job_id 寫回 job', async () => {
    const provider = fakeProvider();
    h.providers.register('fal', provider);
    h.ctx.submitOnCreate = true;

    const { controls } = await uploadControls(h);
    const res = await createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx);
    const jobId = bodyOf(res)['id'] as string;

    expect(provider.calls.submits).toHaveLength(1);
    expect(provider.calls.submits[0]?.webhookUrl).toContain('/fal');
    expect(provider.calls.submits[0]?.controls.map((c) => c.kind)).toEqual(['beauty', 'edge', 'depth']);
    expect((await h.store.getJob(jobId))?.provider_job_id).toBe(`prov_${jobId}`);
  });

  it('submit 失敗 → 502 JOB-50，且 job 仍留在 queued（轉移表沒有 queued → failed）', async () => {
    const provider = fakeProvider({ submitError: new Error('provider 500') });
    h.providers.register('fal', provider);
    h.ctx.submitOnCreate = true;

    const { controls } = await uploadControls(h);
    const err = await catchApiError(() =>
      createJob(makeRequest({ method: 'POST', body: jobBody(controls) }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'JOB-50', httpStatus: 502 });
    const jobs = [...h.store.jobs.values()];
    expect(jobs[0]?.status).toBe('queued');
    expect(JSON.stringify(err.detail)).toContain('queued');
  });
});
