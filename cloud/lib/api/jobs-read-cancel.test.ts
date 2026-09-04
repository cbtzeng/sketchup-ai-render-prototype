/**
 * GET /v1/jobs/:id 與 POST /v1/jobs/:id/cancel 的端點測試。
 * 端點本體在 `cloud/api/v1/jobs/[id].ts` 與 `cloud/api/v1/jobs/[id]/cancel.ts`。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { handle as getJob } from '../../api/v1/jobs/[id].js';
import { handle as cancelJob } from '../../api/v1/jobs/[id]/cancel.js';
import type { JobStatus } from '../db.js';
import { makeJob } from '../db-memory.js';
import { bodyOf, catchApiError, harness, makeRequest, TOKENS, USERS, type Harness } from './harness.js';

const DAY = '2026-09-04';

async function seedJob(h: Harness, status: JobStatus, over: Record<string, unknown> = {}) {
  const row = makeJob({
    user_id: USERS.a,
    created_at: '2026-09-04T11:58:00.000Z',
    cost_estimate_cents: 5,
    ...over,
  } as never);
  const job = await h.store.insertJob({ ...row, status });
  h.store.usage.set(`${USERS.a}::${DAY}`, {
    user_id: USERS.a, day: DAY, jobs_count: 1, cents_spent: job.cost_estimate_cents,
  });
  return job;
}

describe('GET /v1/jobs/:id', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('回傳 status 與 Ruby 端會讀的欄位名', async () => {
    const job = await seedJob(h, 'running');
    const res = await getJob(makeRequest({ method: 'GET', params: { id: job.id } }), h.ctx);
    expect(res.status).toBe(200);
    const body = bodyOf(res);
    expect(body['id']).toBe(job.id);
    expect(body['status']).toBe('running');
    // poller.rb / cloud_backend.rb 讀的就是這三個 key
    expect(body).toHaveProperty('error_code');
    expect(body).toHaveProperty('error_msg');
    expect(body).not.toHaveProperty('result_url'); // 尚未成功時不給
  });

  it('succeeded 時附上 result_url', async () => {
    const job = await seedJob(h, 'succeeded');
    await h.store.insertAsset({
      job_id: job.id, kind: 'result', storage_path: 'results/final.png',
      width: 1024, height: 1024, sha256: null, sha256_declared: null, upload_state: 'uploaded',
    });
    const body = bodyOf(await getJob(makeRequest({ method: 'GET', params: { id: job.id } }), h.ctx));
    expect(body['result_url']).toContain('results/final.png');
  });

  it('provider 直傳的 http URL 原樣回傳（🔴 MVP 尚未轉存到自家 storage）', async () => {
    const job = await seedJob(h, 'succeeded');
    await h.store.insertAsset({
      job_id: job.id, kind: 'result', storage_path: 'https://provider.example/out.png',
      width: null, height: null, sha256: null, sha256_declared: null, upload_state: 'uploaded',
    });
    const body = bodyOf(await getJob(makeRequest({ method: 'GET', params: { id: job.id } }), h.ctx));
    expect(body['result_url']).toBe('https://provider.example/out.png');
  });

  it('失敗的 job 帶 error_code / error_msg', async () => {
    const job = await seedJob(h, 'failed');
    await h.store.updateJob(job.id, { error_code: 'PROV-FAIL', error_msg: '內容審查未通過' }, { status: 'failed' });
    const body = bodyOf(await getJob(makeRequest({ method: 'GET', params: { id: job.id } }), h.ctx));
    expect(body['error_code']).toBe('PROV-FAIL');
    expect(body['error_msg']).toBe('內容審查未通過');
  });

  it('別人的 job 與不存在的 job 都回同一個 404（不當作存在性探測器）', async () => {
    const job = await seedJob(h, 'running');
    const mine = await catchApiError(() =>
      getJob(makeRequest({ method: 'GET', token: TOKENS.b, params: { id: job.id } }), h.ctx),
    );
    const ghost = await catchApiError(() =>
      getJob(makeRequest({ method: 'GET', params: { id: 'no-such-job' } }), h.ctx),
    );
    expect(mine).toMatchObject({ code: 'JOB-44', httpStatus: 404 });
    expect(ghost).toMatchObject({ code: 'JOB-44', httpStatus: 404 });
    expect(mine.message).toBe(ghost.message);
  });

  it('缺 id → 400 JOB-24；非 GET → 405 JOB-11；未授權 → 401', async () => {
    expect(await catchApiError(() => getJob(makeRequest({ method: 'GET' }), h.ctx))).toMatchObject({ code: 'JOB-24' });
    expect(
      await catchApiError(() => getJob(makeRequest({ method: 'POST', params: { id: 'x' } }), h.ctx)),
    ).toMatchObject({ code: 'JOB-11', httpStatus: 405 });
    expect(
      await catchApiError(() => getJob(makeRequest({ method: 'GET', token: null, params: { id: 'x' } }), h.ctx)),
    ).toMatchObject({ code: 'AUTH-10', httpStatus: 401 });
  });

  it('唯讀：查詢不會改變狀態，也不會寫 job_events', async () => {
    const job = await seedJob(h, 'queued');
    await getJob(makeRequest({ method: 'GET', params: { id: job.id } }), h.ctx);
    await getJob(makeRequest({ method: 'GET', params: { id: job.id } }), h.ctx);
    expect((await h.store.getJob(job.id))?.status).toBe('queued');
    expect(await h.store.listJobEvents(job.id)).toHaveLength(0);
  });
});

describe('POST /v1/jobs/:id/cancel', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('queued → cancelled，並釋放預留的金額', async () => {
    const job = await seedJob(h, 'queued');
    const res = await cancelJob(makeRequest({ method: 'POST', body: {}, params: { id: job.id } }), h.ctx);

    expect(res.status).toBe(200);
    const body = bodyOf(res);
    expect(body['status']).toBe('cancelled');
    expect(body['already']).toBe(false);
    expect(body['provider_cancel']).toBe('not_implemented'); // 🔴 adapter 沒有 cancel

    const events = await h.store.listJobEvents(job.id);
    expect(events.at(-1)).toMatchObject({ from_status: 'queued', to_status: 'cancelled' });
    expect(events.at(-1)?.detail_json).toMatchObject({ trigger: 'user' });
    // 取消不收錢：金額釋放，次數不還（次數同時是防濫用的閘門）
    expect(h.store.usage.get(`${USERS.a}::${DAY}`)).toMatchObject({ jobs_count: 1, cents_spent: 0 });
  });

  it('running → cancelled', async () => {
    const job = await seedJob(h, 'running');
    const body = bodyOf(await cancelJob(makeRequest({ method: 'POST', params: { id: job.id } }), h.ctx));
    expect(body['status']).toBe('cancelled');
  });

  // 2026-09-05：這兩個狀態原本回 JOB-60「轉移表缺這條邊」。
  // 轉移表已補齊，端點的擋阻也移除了 —— 使用者在上傳階段或退避等待中
  // 按取消，本來就不該被要求乾等到逾時。
  it('created → cancelled（使用者在上傳階段就按取消）', async () => {
    const job = await seedJob(h, 'created');
    const body = bodyOf(await cancelJob(makeRequest({ method: 'POST', params: { id: job.id } }), h.ctx));
    expect(body['status']).toBe('cancelled');
    expect((await h.store.getJob(job.id))?.status).toBe('cancelled');
  });

  it('retrying → cancelled（退避等待中按取消）', async () => {
    const job = await seedJob(h, 'retrying');
    const body = bodyOf(await cancelJob(makeRequest({ method: 'POST', params: { id: job.id } }), h.ctx));
    expect(body['status']).toBe('cancelled');
  });

  it('重複取消是冪等的 → 200 already=true，不會重複釋放額度', async () => {
    const job = await seedJob(h, 'queued');
    await cancelJob(makeRequest({ method: 'POST', params: { id: job.id } }), h.ctx);
    const res = await cancelJob(makeRequest({ method: 'POST', params: { id: job.id } }), h.ctx);
    expect(res.status).toBe(200);
    expect(bodyOf(res)['already']).toBe(true);
    expect(await h.store.listJobEvents(job.id)).toHaveLength(1); // 沒有第二筆事件
  });

  it('已成功／已失敗的 job → 409 JOB-61', async () => {
    const done = await seedJob(h, 'succeeded');
    expect(
      await catchApiError(() => cancelJob(makeRequest({ method: 'POST', params: { id: done.id } }), h.ctx)),
    ).toMatchObject({ code: 'JOB-61', httpStatus: 409 });

    const failed = await seedJob(h, 'failed');
    expect(
      await catchApiError(() => cancelJob(makeRequest({ method: 'POST', params: { id: failed.id } }), h.ctx)),
    ).toMatchObject({ code: 'JOB-61' });
  });

  it('別人的 job → 404 JOB-44；缺 id → 400；非 POST → 405 JOB-12', async () => {
    const job = await seedJob(h, 'queued');
    expect(
      await catchApiError(() => cancelJob(makeRequest({ method: 'POST', token: TOKENS.b, params: { id: job.id } }), h.ctx)),
    ).toMatchObject({ code: 'JOB-44', httpStatus: 404 });
    expect(await catchApiError(() => cancelJob(makeRequest({ method: 'POST' }), h.ctx))).toMatchObject({ code: 'JOB-24' });
    expect(
      await catchApiError(() => cancelJob(makeRequest({ method: 'GET', params: { id: job.id } }), h.ctx)),
    ).toMatchObject({ code: 'JOB-12', httpStatus: 405 });
  });

  it('取消途中狀態被搶先改掉（CAS 失敗）→ 409 JOB-62', async () => {
    const job = await seedJob(h, 'queued');
    const original = h.store.getJob.bind(h.store);
    let peeked = false;
    // 端點讀完狀態後、轉移前，模擬另一條路徑把 job 改成 succeeded
    h.store.getJob = async (id: string) => {
      const row = await original(id);
      if (!peeked && row) {
        peeked = true;
        const live = h.store.jobs.get(id);
        if (live) h.store.jobs.set(id, { ...live, status: 'succeeded' });
      }
      return row;
    };
    const err = await catchApiError(() =>
      cancelJob(makeRequest({ method: 'POST', params: { id: job.id } }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'JOB-62', httpStatus: 409 });
    expect(err.detail).toMatchObject({ reason: 'ILLEGAL_TRANSITION' });
  });
});
