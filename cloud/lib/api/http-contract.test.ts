/**
 * API 的共用契約測試：錯誤格式、未知例外的處置、平台入口。
 *
 * 錯誤格式必須與 Ruby 端 `Net::Errors::Base#to_h` 對得起來，
 * 否則面板上的診斷碼會顯示成空白 —— 那是使用者回報問題時唯一的線索。
 */
import { describe, expect, it } from 'vitest';
import uploadsRoute from '../../api/v1/uploads.js';
import jobByIdRoute from '../../api/v1/jobs/[id].js';
import cancelRoute from '../../api/v1/jobs/[id]/cancel.js';
import hooksRoute from '../../api/v1/hooks/[provider].js';
import { ApiError, errorResponse, fromFetchRequest, runHandler } from '../http.js';

describe('錯誤格式', () => {
  it('與 Ruby 端 Errors::Base#to_h 同形：{ ok, code, message, detail }', () => {
    const res = errorResponse(new ApiError('JOB-21', 400, '控制圖雜湊不合法', { kind: 'edge' }));
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({
      ok: false,
      code: 'JOB-21',
      message: '控制圖雜湊不合法',
      detail: { kind: 'edge' },
    });
  });

  it('沒有 detail 時不輸出 detail 欄位（不要送 null 給用戶端猜）', () => {
    expect(errorResponse(new ApiError('AUTH-10', 401, '缺少 token')).body).toEqual({
      ok: false, code: 'AUTH-10', message: '缺少 token',
    });
  });

  it('未預期的例外一律 500 SRV-50，且**不洩漏內部訊息**', async () => {
    const seen: unknown[] = [];
    const res = await runHandler(async () => {
      throw new Error('connection string postgres://user:pw@host');
    }, (e) => seen.push(e));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, code: 'SRV-50', message: '伺服器內部錯誤' });
    expect(JSON.stringify(res.body)).not.toContain('postgres');
    expect(seen).toHaveLength(1); // 但要能被記錄下來
  });
});

describe('fromFetchRequest', () => {
  it('header 一律轉小寫，body 保持原始字串（簽章驗證的前提）', async () => {
    const raw = '{"a":  1}';
    const req = await fromFetchRequest(
      new Request('https://api.example/v1/hooks/fal?x=1', {
        method: 'POST',
        headers: { 'X-Fake-Signature': 'ok' },
        body: raw,
      }),
      { provider: 'fal' },
    );
    expect(req.headers['x-fake-signature']).toBe('ok');
    expect(req.rawBody).toBe(raw);
    expect(req.path).toBe('/v1/hooks/fal');
    expect(req.query).toEqual({ x: '1' });
    expect(req.params).toEqual({ provider: 'fal' });
  });

  it('GET 不讀 body', async () => {
    const req = await fromFetchRequest(new Request('https://api.example/v1/jobs/abc'));
    expect(req.rawBody).toBe('');
    expect(req.method).toBe('GET');
  });
});

describe('平台入口（default export）', () => {
  it('執行期 context 未接線時，四個端點一律回 501 CFG-01，而不是半殘地跑', async () => {
    const cases: Array<[string, Promise<Response>]> = [
      ['uploads', uploadsRoute(new Request('https://api.example/v1/uploads', { method: 'POST', body: '{}' }))],
      ['get', jobByIdRoute(new Request('https://api.example/v1/jobs/abc'))],
      ['cancel', cancelRoute(new Request('https://api.example/v1/jobs/abc/cancel', { method: 'POST', body: '{}' }))],
      ['hook', hooksRoute(new Request('https://api.example/v1/hooks/fal', { method: 'POST', body: '{}' }))],
    ];
    for (const [name, promise] of cases) {
      const res = await promise;
      expect(res.status, name).toBe(501);
      expect(await res.json()).toMatchObject({ ok: false, code: 'CFG-01' });
    }
  });
});
