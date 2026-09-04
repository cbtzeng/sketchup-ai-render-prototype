/**
 * POST /v1/hooks/:provider 的端點測試。端點本體在 `cloud/api/v1/hooks/[provider].ts`。
 *
 * 這裡的 payload 形狀是 harness 的**假 provider 約定**，不是 fal.ai 的真實 schema
 * （真實 schema 未驗證，一律不猜）。測試證明的是端點對 adapter 介面的行為，
 * 而不是對任何特定 provider 的格式。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { handle as hook } from '../../api/v1/hooks/[provider].js';
import type { JobStatus } from '../db.js';
import { makeJob } from '../db-memory.js';
import { WebhookSignatureError } from '../providers/types.js';
import { alwaysRejectVerifier } from '../providers/registry.js';
import { bodyOf, catchApiError, fakeProvider, harness, makeRequest, USERS, type Harness } from './harness.js';

const DAY = '2026-09-04';
const SIG = { 'x-fake-signature': 'ok' };

async function seedJob(h: Harness, status: JobStatus, over: Record<string, unknown> = {}) {
  const job = await h.store.insertJob({
    ...makeJob({ user_id: USERS.a, created_at: '2026-09-04T11:58:00.000Z', ...over } as never),
    status,
    provider_job_id: 'prov_1',
  });
  h.store.usage.set(`${USERS.a}::${DAY}`, {
    user_id: USERS.a, day: DAY, jobs_count: 1, cents_spent: job.cost_estimate_cents,
  });
  return job;
}

function webhook(payload: unknown, opts: { headers?: Record<string, string>; provider?: string } = {}) {
  return makeRequest({
    method: 'POST',
    token: null, // webhook 沒有使用者身分，只有簽章
    rawBody: JSON.stringify(payload),
    headers: opts.headers ?? SIG,
    params: { provider: opts.provider ?? 'fal' },
  });
}

describe('POST /v1/hooks/:provider', () => {
  let h: Harness;
  let provider: ReturnType<typeof fakeProvider>;

  beforeEach(() => {
    h = harness();
    provider = fakeProvider();
    h.providers.register('fal', provider);
  });

  // -------------------------------------------------------------------------
  // 簽章：最重要的一組
  // -------------------------------------------------------------------------

  it('簽章不通過 → 401 HOOK-30，而且 **normalize 完全沒被呼叫**（驗章前不解析 body）', async () => {
    await seedJob(h, 'queued');
    const err = await catchApiError(() =>
      hook(webhook({ providerJobId: 'prov_1', kind: 'succeeded' }, { headers: {} }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'HOOK-30', httpStatus: 401 });
    expect(provider.calls.normalizes).toHaveLength(0);
    expect(provider.calls.verifies).toHaveLength(1);
  });

  it('驗證器拋 WebhookSignatureError 也是 401 HOOK-30', async () => {
    h.providers.register('fal', { adapter: provider.adapter, verifier: alwaysRejectVerifier });
    const err = await catchApiError(() => hook(webhook({ providerJobId: 'prov_1', kind: 'running' }), h.ctx));
    expect(err).toMatchObject({ code: 'HOOK-30', httpStatus: 401 });
    expect(err.message).toContain('簽章');
  });

  it('驗證器拿到的是**未經重新序列化的原始 body** 與全部 header', async () => {
    await seedJob(h, 'queued');
    const raw = '{"providerJobId":"prov_1",  "kind":"running"}'; // 刻意留多餘空白
    await hook(
      makeRequest({ method: 'POST', token: null, rawBody: raw, headers: SIG, params: { provider: 'fal' } }),
      h.ctx,
    );
    expect(provider.calls.verifies[0]?.rawBody).toBe(raw);
    expect(provider.calls.verifies[0]?.headers['x-fake-signature']).toBe('ok');
    expect(provider.calls.normalizes[0]?.rawBody).toBe(raw);
  });

  it('簽章失敗時不會動到 job 的狀態', async () => {
    const job = await seedJob(h, 'queued');
    await catchApiError(() => hook(webhook({ providerJobId: 'prov_1', kind: 'succeeded' }, { headers: {} }), h.ctx));
    expect((await h.store.getJob(job.id))?.status).toBe('queued');
    expect(await h.store.listJobEvents(job.id)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 路由與前置條件
  // -------------------------------------------------------------------------

  it('未註冊的 provider → 404 HOOK-20（不驗章、不解析）', async () => {
    const err = await catchApiError(() =>
      hook(webhook({ providerJobId: 'prov_1', kind: 'running' }, { provider: 'replicate' }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'HOOK-20', httpStatus: 404 });
    expect(provider.calls.verifies).toHaveLength(0);
  });

  it('非 POST → 405 HOOK-10', async () => {
    expect(
      await catchApiError(() => hook(makeRequest({ method: 'GET', params: { provider: 'fal' } }), h.ctx)),
    ).toMatchObject({ code: 'HOOK-10', httpStatus: 405 });
  });

  it('normalize 失敗 → 400 HOOK-40（payload 與 adapter 預期不符）', async () => {
    const err = await catchApiError(() => hook(webhook({ nothing: true }), h.ctx));
    expect(err).toMatchObject({ code: 'HOOK-40', httpStatus: 400 });
  });

  it('反查不到 job → 404 HOOK-41', async () => {
    const err = await catchApiError(() => hook(webhook({ providerJobId: 'unknown', kind: 'running' }), h.ctx));
    expect(err).toMatchObject({ code: 'HOOK-41', httpStatus: 404 });
  });

  it('ctx.jobLookup 未接線 → 501 HOOK-11（不是 500，也不是靜默忽略）', async () => {
    await seedJob(h, 'queued');
    h.ctx.jobLookup = undefined;
    expect(
      await catchApiError(() => hook(webhook({ providerJobId: 'prov_1', kind: 'running' }), h.ctx)),
    ).toMatchObject({ code: 'HOOK-11', httpStatus: 501 });
  });

  // -------------------------------------------------------------------------
  // 事件套用
  // -------------------------------------------------------------------------

  it('accepted / running → queued 轉 running', async () => {
    const job = await seedJob(h, 'queued');
    const res = await hook(webhook({ providerJobId: 'prov_1', kind: 'accepted' }), h.ctx);
    expect(res.status).toBe(200);
    expect(bodyOf(res)['status']).toBe('running');
    const updated = await h.store.getJob(job.id);
    expect(updated?.started_at).toBe('2026-09-04T12:00:00.000Z');
    expect((await h.store.listJobEvents(job.id)).at(-1)?.detail_json).toMatchObject({ trigger: 'provider' });
  });

  it('重複的 running 事件 → 202 不重複套用（job_events 是軌跡，不是流水帳）', async () => {
    const job = await seedJob(h, 'running');
    const res = await hook(webhook({ providerJobId: 'prov_1', kind: 'running' }), h.ctx);
    expect(res.status).toBe(202);
    expect(bodyOf(res)).toMatchObject({ applied: false, reason: 'already_running' });
    expect(await h.store.listJobEvents(job.id)).toHaveLength(0);
  });

  it('succeeded：寫入結果圖、轉終態、回填實際成本', async () => {
    const job = await seedJob(h, 'running');
    const res = await hook(
      webhook({
        providerJobId: 'prov_1',
        kind: 'succeeded',
        results: [{ url: 'https://provider.example/out.png', width: 1024, height: 1024 }],
        costActualCents: 6,
      }),
      h.ctx,
    );

    expect(res.status).toBe(200);
    const body = bodyOf(res);
    expect(body['status']).toBe('succeeded');
    expect(body['cost_actual_cents']).toBe(6);
    expect(body['cost_drift_alert']).toBe(false); // (6-5)/5 = 20%，未超過門檻

    const assets = await h.store.listAssets(job.id);
    expect(assets).toMatchObject([{ kind: 'result', storage_path: 'https://provider.example/out.png' }]);
    // 預留 5，實際 6 → usage 補 1
    expect(h.store.usage.get(`${USERS.a}::${DAY}`)?.cents_spent).toBe(6);
  });

  it('估算與實際偏差 > 20% → cost_drift_alert（architecture.md 5.9）', async () => {
    await seedJob(h, 'running');
    const res = await hook(
      webhook({ providerJobId: 'prov_1', kind: 'succeeded', results: [{ url: 'https://x/y.png' }], costActualCents: 20 }),
      h.ctx,
    );
    expect(bodyOf(res)['cost_drift_alert']).toBe(true);
    expect(bodyOf(res)['cost_diff_cents']).toBe(15);
    expect(h.store.usage.get(`${USERS.a}::${DAY}`)?.cents_spent).toBe(20);
  });

  it('實際成本低於估算 → 把差額還回 usage_daily', async () => {
    await seedJob(h, 'running');
    await hook(webhook({ providerJobId: 'prov_1', kind: 'succeeded', results: [{ url: 'https://x/y.png' }], costActualCents: 2 }), h.ctx);
    expect(h.store.usage.get(`${USERS.a}::${DAY}`)?.cents_spent).toBe(2);
  });

  it('provider 只送終態事件時，補記 queued → running，軌跡保持完整', async () => {
    const job = await seedJob(h, 'queued');
    await hook(webhook({ providerJobId: 'prov_1', kind: 'succeeded', results: [{ url: 'https://x/y.png' }] }), h.ctx);
    const trail = (await h.store.listJobEvents(job.id)).map((e) => `${e.from_status}→${e.to_status}`);
    expect(trail).toEqual(['queued→running', 'running→succeeded']);
    expect((await h.store.listJobEvents(job.id))[0]?.detail_json).toMatchObject({ inferred: expect.any(String) });
  });

  it('5xx 失敗 → retrying 並帶退避時間（重試上限與退避由 cost-guard 決定）', async () => {
    const job = await seedJob(h, 'running');
    const res = await hook(
      webhook({ providerJobId: 'prov_1', kind: 'failed', httpStatus: 503, errorCode: 'PROV-503', errorMsg: 'upstream busy' }),
      h.ctx,
    );
    expect(res.status).toBe(200);
    expect(bodyOf(res)).toMatchObject({ applied: true, retry_scheduled: true, backoff_ms: 10_000, status: 'retrying' });
    expect((await h.store.listJobEvents(job.id)).at(-1)?.detail_json).toMatchObject({ error_class: 'http_5xx' });
    // 還在重試中，額度不釋放
    expect(h.store.usage.get(`${USERS.a}::${DAY}`)?.cents_spent).toBe(5);
  });

  it('4xx 失敗 → 直接 failed（4xx 一律不重試），並釋放預留金額', async () => {
    const job = await seedJob(h, 'running');
    const res = await hook(
      webhook({ providerJobId: 'prov_1', kind: 'failed', httpStatus: 422, errorCode: 'PROV-422', errorMsg: '內容審查未通過' }),
      h.ctx,
    );
    expect(bodyOf(res)).toMatchObject({ retry_scheduled: false, status: 'failed', error_code: 'PROV-422' });
    expect((await h.store.getJob(job.id))?.error_msg).toBe('內容審查未通過');
    expect(h.store.usage.get(`${USERS.a}::${DAY}`)?.cents_spent).toBe(0);
  });

  it('沒有 httpStatus 的失敗一律不重試（分類不明就不燒錢）', async () => {
    await seedJob(h, 'running');
    const res = await hook(webhook({ providerJobId: 'prov_1', kind: 'failed', errorMsg: '不明錯誤' }), h.ctx);
    expect(bodyOf(res)).toMatchObject({ retry_scheduled: false, status: 'failed', error_code: 'PROV-FAIL' });
  });

  it('重試次數用盡 → 轉 failed 而不是再次 retrying', async () => {
    await seedJob(h, 'running', { retry_count: 2 });
    const res = await hook(webhook({ providerJobId: 'prov_1', kind: 'failed', httpStatus: 500 }), h.ctx);
    expect(bodyOf(res)).toMatchObject({ retry_scheduled: false, status: 'failed' });
  });

  it('失敗但 provider 有計費 → 記帳而不是釋放（錢真的花掉了）', async () => {
    await seedJob(h, 'running');
    await hook(webhook({ providerJobId: 'prov_1', kind: 'failed', httpStatus: 422, costActualCents: 3 }), h.ctx);
    expect(h.store.usage.get(`${USERS.a}::${DAY}`)?.cents_spent).toBe(3);
  });

  it('job 已是終態的遲到 webhook → 202 不套用（回 2xx 避免 provider 無限重送）', async () => {
    const job = await seedJob(h, 'succeeded');
    const res = await hook(webhook({ providerJobId: 'prov_1', kind: 'failed', httpStatus: 500 }), h.ctx);
    expect(res.status).toBe(202);
    expect(bodyOf(res)).toMatchObject({ applied: false, reason: 'job_already_terminal', status: 'succeeded' });
    expect(await h.store.listJobEvents(job.id)).toHaveLength(0);
  });

  it('狀態機拒絕該轉移 → 409 HOOK-50，附 reason 供對帳', async () => {
    // created 狀態收到 running 事件：created → running 不在轉移表內
    await seedJob(h, 'created');
    const err = await catchApiError(() => hook(webhook({ providerJobId: 'prov_1', kind: 'running' }), h.ctx));
    expect(err).toMatchObject({ code: 'HOOK-50', httpStatus: 409 });
    expect(err.detail).toMatchObject({ reason: 'ILLEGAL_TRANSITION' });
  });

  it('重複的 succeeded webhook 不會寫入第二張結果圖', async () => {
    const job = await seedJob(h, 'running');
    const payload = { providerJobId: 'prov_1', kind: 'succeeded', results: [{ url: 'https://x/y.png' }] };
    await hook(webhook(payload), h.ctx);
    const res = await hook(webhook(payload), h.ctx);
    expect(res.status).toBe(202); // 已是終態
    expect(await h.store.listAssets(job.id)).toHaveLength(1);
  });
});

describe('預設驗證器（fail-closed）', () => {
  it('alwaysRejectVerifier 一律拋 WebhookSignatureError —— 忘了接線的結果是全擋，不是全放', () => {
    expect(() => alwaysRejectVerifier.verify({ headers: {}, rawBody: '{}', receivedAt: '' })).toThrow(
      WebhookSignatureError,
    );
  });
});
