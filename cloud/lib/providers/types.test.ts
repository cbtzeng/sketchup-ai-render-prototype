/**
 * providers/types.test.ts —— ProviderAdapter 介面的契約測試。
 *
 * 這裡不測任何 provider 的實際 HTTP 行為（fal 的端點、參數名、回應格式
 * 目前**未經驗證**，見檔案 types.ts 的 🔴 標記）。
 * 只驗證：介面剛好兩個方法、normalize 的輸出能餵給狀態機。
 */
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_ADAPTER_METHODS,
  isTerminalProviderEvent,
  providerEventToStatus,
} from './types.js';
import type { NormalizedProviderEvent, ProviderAdapter, ProviderSubmitPayload } from './types.js';

/** 測試用的假 adapter：完全不發 HTTP。 */
class FakeAdapter implements ProviderAdapter {
  readonly name = 'fake';
  async submit(payload: ProviderSubmitPayload) {
    return { providerJobId: `fake-${payload.jobId}`, acceptedAt: '2026-09-04T00:00:00.000Z' };
  }
  normalize(): NormalizedProviderEvent {
    return {
      providerJobId: 'fake-1',
      kind: 'succeeded',
      receivedAt: '2026-09-04T00:00:00.000Z',
      raw: {},
    };
  }
}

describe('ProviderAdapter 介面', () => {
  it('只有 submit 與 normalize 兩個方法', () => {
    expect(PROVIDER_ADAPTER_METHODS).toEqual(['submit', 'normalize']);
  });

  it('假 adapter 的原型上除了 constructor 只有這兩個方法', () => {
    const methods = Object.getOwnPropertyNames(FakeAdapter.prototype).filter(
      (m) => m !== 'constructor',
    );
    expect(methods.sort()).toEqual([...PROVIDER_ADAPTER_METHODS].sort());
  });

  it('submit 回 providerJobId', async () => {
    const a = new FakeAdapter();
    const r = await a.submit({
      jobId: 'job_1',
      idempotencyKey: 'k',
      presetVersion: '2026-09-04.1',
      prompt: 'x',
      seed: 1,
      params: {},
      controls: [],
      webhookUrl: 'https://example.invalid/v1/hooks/fake',
    });
    expect(r.providerJobId).toBe('fake-job_1');
  });
});

describe('normalize 輸出對應到狀態機', () => {
  it.each([
    ['accepted', 'running'],
    ['running', 'running'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
  ] as const)('%s → %s', (kind, status) => {
    expect(providerEventToStatus(kind)).toBe(status);
  });

  it('終態事件可辨識', () => {
    expect(isTerminalProviderEvent('succeeded')).toBe(true);
    expect(isTerminalProviderEvent('failed')).toBe(true);
    expect(isTerminalProviderEvent('running')).toBe(false);
  });
});
