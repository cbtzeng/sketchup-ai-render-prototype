/**
 * POST /v1/uploads 的端點測試。
 * 端點本體在 `cloud/api/v1/uploads.ts`（測試放這裡的理由見 harness.ts 檔頭）。
 */
import { describe, expect, it } from 'vitest';
import { handle } from '../../api/v1/uploads.js';
import { bodyOf, catchApiError, harness, makeRequest, TOKENS, USERS } from './harness.js';

const PASSES = ['beauty', 'edge', 'depth'];

describe('POST /v1/uploads', () => {
  it('每個 pass 回一個簽名 URL，且 key 名是 urls（Ruby 端 cloud_backend.rb 直接讀 res["urls"]）', async () => {
    const h = harness();
    const res = await handle(makeRequest({ method: 'POST', body: { passes: PASSES } }), h.ctx);

    expect(res.status).toBe(200);
    const body = bodyOf(res);
    const urls = body['urls'] as Record<string, string>;
    expect(Object.keys(urls).sort()).toEqual(['beauty', 'depth', 'edge']);
    for (const pass of PASSES) {
      expect(typeof urls[pass]).toBe('string');
      expect(urls[pass]).toContain(pass);
    }
  });

  it('建立上傳批次，路徑以 user + batch 隔離（併發擷取不會互相覆寫）', async () => {
    const h = harness();
    const res = await handle(makeRequest({ method: 'POST', body: { passes: PASSES } }), h.ctx);
    const body = bodyOf(res);
    const batchId = body['upload_batch'] as string;

    const batch = await h.batches.getBatch(batchId);
    expect(batch).not.toBeNull();
    expect(batch?.user_id).toBe(USERS.a);
    expect(batch?.claimed_by_job_id).toBeNull();
    expect(batch?.paths['beauty']).toBe(`controls/${USERS.a}/${batchId}/beauty.png`);
  });

  it('兩個使用者的批次互不干擾', async () => {
    const h = harness();
    const a = bodyOf(await handle(makeRequest({ method: 'POST', body: { passes: PASSES } }), h.ctx));
    const b = bodyOf(
      await handle(makeRequest({ method: 'POST', token: TOKENS.b, body: { passes: PASSES } }), h.ctx),
    );
    expect(a['upload_batch']).not.toBe(b['upload_batch']);
    expect(await h.batches.findLatestUnclaimedBatch(USERS.b)).toMatchObject({ user_id: USERS.b });
  });

  it('只接受 POST', async () => {
    const h = harness();
    const err = await catchApiError(() => handle(makeRequest({ method: 'GET' }), h.ctx));
    expect(err).toMatchObject({ code: 'UPL-10', httpStatus: 405 });
  });

  it('沒有 Authorization 回 401 AUTH-10', async () => {
    const h = harness();
    const err = await catchApiError(() =>
      handle(makeRequest({ method: 'POST', token: null, body: { passes: PASSES } }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'AUTH-10', httpStatus: 401 });
  });

  it('token 無效回 401 AUTH-11', async () => {
    const h = harness();
    const err = await catchApiError(() =>
      handle(makeRequest({ method: 'POST', token: 'nope', body: { passes: PASSES } }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'AUTH-11', httpStatus: 401 });
  });

  it('body 不是合法 JSON 回 400 UPL-20', async () => {
    const h = harness();
    const err = await catchApiError(() =>
      handle(makeRequest({ method: 'POST', rawBody: '{oops' }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'UPL-20', httpStatus: 400 });
  });

  it('passes 缺席或為空陣列回 400 UPL-21', async () => {
    const h = harness();
    expect(await catchApiError(() => handle(makeRequest({ method: 'POST', body: {} }), h.ctx))).toMatchObject({
      code: 'UPL-21',
    });
    expect(
      await catchApiError(() => handle(makeRequest({ method: 'POST', body: { passes: [] } }), h.ctx)),
    ).toMatchObject({ code: 'UPL-21' });
  });

  it('未知的 pass 名稱回 400 UPL-22，並列出允許值', async () => {
    const h = harness();
    const err = await catchApiError(() =>
      handle(makeRequest({ method: 'POST', body: { passes: ['beauty', 'normal'] } }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'UPL-22', httpStatus: 400 });
    expect(JSON.stringify(err.detail)).toContain('depth');
  });

  it('重複的 pass 回 400 UPL-23（否則同一個路徑會被發兩次 URL）', async () => {
    const h = harness();
    const err = await catchApiError(() =>
      handle(makeRequest({ method: 'POST', body: { passes: ['beauty', 'beauty'] } }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'UPL-23', httpStatus: 400 });
  });

  it('儲存服務發不出 URL 時回 502 UPL-30，且不留下批次記錄', async () => {
    const h = harness();
    h.ctx.storage = {
      async createSignedUploadUrl() {
        throw new Error('storage down');
      },
      async statObject() {
        return null;
      },
      async createSignedDownloadUrl() {
        return '';
      },
    };
    const err = await catchApiError(() =>
      handle(makeRequest({ method: 'POST', body: { passes: PASSES } }), h.ctx),
    );
    expect(err).toMatchObject({ code: 'UPL-30', httpStatus: 502 });
    expect(h.batches.batches.size).toBe(0);
  });
});
