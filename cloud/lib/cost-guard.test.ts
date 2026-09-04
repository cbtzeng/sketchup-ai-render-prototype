/**
 * cost-guard.test.ts —— 成本護欄測試（architecture.md 第 5 節）。
 *
 * 覆蓋：解析度上限、每日上限（含 atomic upsert 的併發驗證）、
 * 每使用者並發 1 個 running job、冪等去重與快取命中、重試上限與 4xx 不重試。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { InMemoryJobStore, makeJob } from './db-memory.js';
import {
  COST_LIMITS,
  admit,
  backoffDelayMs,
  checkResolution,
  classifyProviderError,
  computeIdempotencyKey,
  shouldRetry,
  utcDayKey,
} from './cost-guard.js';

let store: InMemoryJobStore;
const USER = 'user_a';
const DAY = '2026-09-04';
const NOW = new Date('2026-09-04T08:00:00.000Z');

beforeEach(() => {
  store = new InMemoryJobStore();
});

function req(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    controlsSha256: 'abc123',
    paramsJson: { preset: 'exterior_dusk', fidelity: 0.7 },
    width: 1024,
    height: 1024,
    costEstimateCents: 5,
    now: NOW,
    ...overrides,
  } as Parameters<typeof admit>[1];
}

// ---------------------------------------------------------------------------

describe('冪等 key', () => {
  it('= sha256(controls_sha256 + params_json + user_id)，且為 64 hex', () => {
    const key = computeIdempotencyKey({
      controlsSha256: 'abc123',
      paramsJson: { a: 1 },
      userId: USER,
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('相同輸入 → 相同 key', () => {
    const a = computeIdempotencyKey({ controlsSha256: 'x', paramsJson: { a: 1 }, userId: USER });
    const b = computeIdempotencyKey({ controlsSha256: 'x', paramsJson: { a: 1 }, userId: USER });
    expect(a).toBe(b);
  });

  it('params 的 key 順序不影響結果（canonical JSON）', () => {
    const a = computeIdempotencyKey({
      controlsSha256: 'x',
      paramsJson: { a: 1, b: { c: 2, d: 3 } },
      userId: USER,
    });
    const b = computeIdempotencyKey({
      controlsSha256: 'x',
      paramsJson: { b: { d: 3, c: 2 }, a: 1 },
      userId: USER,
    });
    expect(a).toBe(b);
  });

  it('不同使用者 → 不同 key（避免跨帳號快取洩漏）', () => {
    const a = computeIdempotencyKey({ controlsSha256: 'x', paramsJson: {}, userId: 'u1' });
    const b = computeIdempotencyKey({ controlsSha256: 'x', paramsJson: {}, userId: 'u2' });
    expect(a).not.toBe(b);
  });

  it('欄位間有分隔符，避免拼接歧義', () => {
    // 沒有分隔符時 ("ab" + "" + "c") 與 ("a" + "" + "bc") 會撞在一起
    const a = computeIdempotencyKey({ controlsSha256: 'ab', paramsJson: '', userId: 'c' });
    const b = computeIdempotencyKey({ controlsSha256: 'a', paramsJson: '', userId: 'bc' });
    expect(a).not.toBe(b);
  });

  it('與獨立算出的 sha256 一致（不是自我一致的假測試）', () => {
    const canonical = JSON.stringify({ a: 1, b: 2 });
    const expected = createHash('sha256')
      .update(`x\n${canonical}\n${USER}`, 'utf8')
      .digest('hex');
    expect(
      computeIdempotencyKey({ controlsSha256: 'x', paramsJson: { b: 2, a: 1 }, userId: USER }),
    ).toBe(expected);
  });
});

describe('解析度上限（單邊 1536）', () => {
  it.each([
    [1024, 1024],
    [1536, 1024],
    [1024, 1536],
    [1536, 1536],
  ])('%ix%i 通過', (w, h) => {
    expect(checkResolution({ width: w, height: h }).ok).toBe(true);
  });

  it.each([
    [1537, 1024],
    [1024, 1537],
    [2048, 2048],
  ])('%ix%i 被擋，回 400 RESOLUTION_EXCEEDED', (w, h) => {
    const r = checkResolution({ width: w, height: h });
    expect(r).toMatchObject({ ok: false, code: 'RESOLUTION_EXCEEDED', httpStatus: 400 });
  });

  it.each([
    [0, 1024],
    [-1, 512],
    [1024, 1.5],
  ])('%ix%i 非法尺寸被擋', (w, h) => {
    expect(checkResolution({ width: w, height: h }).ok).toBe(false);
  });

  it('admit 會先擋解析度，且不佔用每日額度', async () => {
    const r = await admit(store, req({ width: 2048, height: 2048 }));
    expect(r).toMatchObject({ decision: 'deny', code: 'RESOLUTION_EXCEEDED', httpStatus: 400 });
    expect(store.reserveCalls).toBe(0);
  });
});

describe('並發上限：每使用者同時 1 個 running job', () => {
  it('已有 running job 時，新請求回 409', async () => {
    await store.insertJob(makeJob({ user_id: USER, status: 'running' }));
    const r = await admit(store, req());
    expect(r).toMatchObject({ decision: 'deny', code: 'CONCURRENCY_LIMIT', httpStatus: 409 });
    expect(store.reserveCalls).toBe(0);
  });

  it('別的使用者的 running job 不影響本使用者', async () => {
    await store.insertJob(makeJob({ user_id: 'other', status: 'running' }));
    const r = await admit(store, req());
    expect(r.decision).toBe('allow');
  });

  it('queued 中的 job 不計入 running 並發', async () => {
    await store.insertJob(makeJob({ user_id: USER, status: 'queued' }));
    expect((await admit(store, req())).decision).toBe('allow');
  });
});

describe('每日上限：30 jobs 或 $2，先達者為準', () => {
  it('上限常數符合 architecture.md', () => {
    expect(COST_LIMITS.MAX_JOBS_PER_DAY).toBe(30);
    expect(COST_LIMITS.MAX_CENTS_PER_DAY).toBe(200);
    expect(COST_LIMITS.MAX_EDGE_PX).toBe(1536);
    expect(COST_LIMITS.MAX_CONCURRENT_RUNNING).toBe(1);
    expect(COST_LIMITS.MAX_RETRIES).toBe(2);
  });

  it('第 31 個 job 被擋，回 429 DAILY_JOB_LIMIT，並附剩餘額度', async () => {
    for (let i = 0; i < 30; i += 1) {
      const r = await admit(store, req({ controlsSha256: `c${i}`, costEstimateCents: 1 }));
      expect(r.decision).toBe('allow');
    }
    const r = await admit(store, req({ controlsSha256: 'c30', costEstimateCents: 1 }));
    expect(r).toMatchObject({
      decision: 'deny',
      code: 'DAILY_JOB_LIMIT',
      httpStatus: 429,
    });
    expect(r).toMatchObject({ remaining: { jobs: 0 } });
  });

  it('金額先達上限時回 DAILY_COST_LIMIT', async () => {
    // 每次 50 cents，4 次就到 $2；第 5 次超過金額但 job 數才 5
    for (let i = 0; i < 4; i += 1) {
      const r = await admit(store, req({ controlsSha256: `c${i}`, costEstimateCents: 50 }));
      expect(r.decision).toBe('allow');
    }
    const r = await admit(store, req({ controlsSha256: 'c4', costEstimateCents: 50 }));
    expect(r).toMatchObject({ decision: 'deny', code: 'DAILY_COST_LIMIT', httpStatus: 429 });
  });

  it('當天第一筆就超過金額上限也要擋（回歸：SQL 版曾因 ON CONFLICT 的 WHERE 只在衝突時評估而漏放）', async () => {
    const r = await admit(store, req({ controlsSha256: 'big', costEstimateCents: 250 }));
    expect(r).toMatchObject({ decision: 'deny', code: 'DAILY_COST_LIMIT', httpStatus: 429 });
    expect(store.usage.get(`${USER}::${DAY}`)).toBeUndefined();
  });

  it('額度以 UTC 日為界，跨日重置', async () => {
    for (let i = 0; i < 30; i += 1) {
      await admit(store, req({ controlsSha256: `c${i}`, costEstimateCents: 1 }));
    }
    const nextDay = await admit(
      store,
      req({ controlsSha256: 'next', now: new Date('2026-09-05T00:00:00.000Z') }),
    );
    expect(nextDay.decision).toBe('allow');
  });

  it('utcDayKey 回 YYYY-MM-DD（UTC）', () => {
    expect(utcDayKey(new Date('2026-09-04T23:59:59.999Z'))).toBe('2026-09-04');
    expect(utcDayKey(new Date('2026-09-05T00:00:00.000Z'))).toBe('2026-09-05');
  });
});

describe('每日上限的 atomic upsert（併發不得超賣）', () => {
  it('50 個併發請求只有 30 個放行', async () => {
    const reqs = Array.from({ length: 50 }, (_, i) =>
      admit(store, req({ controlsSha256: `race-${i}`, costEstimateCents: 1 })),
    );
    const results = await Promise.all(reqs);
    const allowed = results.filter((r) => r.decision === 'allow');
    const denied = results.filter((r) => r.decision === 'deny');

    expect(allowed).toHaveLength(30);
    expect(denied).toHaveLength(20);
    expect(store.usage.get(`${USER}::${DAY}`)!.jobs_count).toBe(30);
  });

  it('金額上限在併發下同樣不會超賣', async () => {
    const reqs = Array.from({ length: 20 }, (_, i) =>
      admit(store, req({ controlsSha256: `money-${i}`, costEstimateCents: 30 })),
    );
    const results = await Promise.all(reqs);
    expect(results.filter((r) => r.decision === 'allow')).toHaveLength(6); // 6 * 30 = 180 <= 200
    expect(store.usage.get(`${USER}::${DAY}`)!.cents_spent).toBe(180);
  });
});

describe('冪等去重', () => {
  it('命中已 succeeded 的 job → 回舊結果，成本 0，不再計額度', async () => {
    const key = computeIdempotencyKey({
      controlsSha256: 'abc123',
      paramsJson: { preset: 'exterior_dusk', fidelity: 0.7 },
      userId: USER,
    });
    const existing = await store.insertJob(
      makeJob({ user_id: USER, idempotency_key: key, status: 'succeeded' }),
    );

    const r = await admit(store, req());
    expect(r).toMatchObject({
      decision: 'cache_hit',
      costCents: 0,
      job: { id: existing.id, status: 'succeeded' },
    });
    expect(store.reserveCalls).toBe(0);
  });

  it('命中進行中的 job → 回同一個 job，不算新請求也不回 409', async () => {
    const key = computeIdempotencyKey({
      controlsSha256: 'abc123',
      paramsJson: { preset: 'exterior_dusk', fidelity: 0.7 },
      userId: USER,
    });
    const existing = await store.insertJob(
      makeJob({ user_id: USER, idempotency_key: key, status: 'running' }),
    );

    const r = await admit(store, req());
    expect(r).toMatchObject({ decision: 'in_flight', job: { id: existing.id } });
    expect(store.reserveCalls).toBe(0);
  });

  it('命中已失敗的 job → 視為新請求（允許重送）', async () => {
    const key = computeIdempotencyKey({
      controlsSha256: 'abc123',
      paramsJson: { preset: 'exterior_dusk', fidelity: 0.7 },
      userId: USER,
    });
    await store.insertJob(makeJob({ user_id: USER, idempotency_key: key, status: 'failed' }));

    const r = await admit(store, req());
    expect(r.decision).toBe('allow');
  });

  it('連按兩次 Render：第二次不重複計費', async () => {
    const first = await admit(store, req());
    expect(first.decision).toBe('allow');
    // 第一次的 job 真的被建立
    await store.insertJob(
      makeJob({
        user_id: USER,
        idempotency_key: (first as { idempotencyKey: string }).idempotencyKey,
        status: 'succeeded',
      }),
    );
    const before = store.usage.get(`${USER}::${DAY}`)!.cents_spent;

    const second = await admit(store, req());
    expect(second.decision).toBe('cache_hit');
    expect(store.usage.get(`${USER}::${DAY}`)!.cents_spent).toBe(before);
  });

  it('放行時回傳算好的 idempotencyKey 供建立 job 使用', async () => {
    const r = await admit(store, req());
    expect(r).toMatchObject({
      decision: 'allow',
      idempotencyKey: computeIdempotencyKey({
        controlsSha256: 'abc123',
        paramsJson: { preset: 'exterior_dusk', fidelity: 0.7 },
        userId: USER,
      }),
    });
  });

  it('去重先於並發檢查：使用者重送自己正在跑的 job 不會拿到 409', async () => {
    const key = computeIdempotencyKey({
      controlsSha256: 'abc123',
      paramsJson: { preset: 'exterior_dusk', fidelity: 0.7 },
      userId: USER,
    });
    await store.insertJob(makeJob({ user_id: USER, idempotency_key: key, status: 'running' }));
    const r = await admit(store, req());
    expect(r.decision).toBe('in_flight');
  });
});

describe('重試政策：最多 2 次，且只對 5xx / timeout', () => {
  it('classifyProviderError 依 HTTP 狀態碼分類', () => {
    expect(classifyProviderError({ httpStatus: 400 })).toBe('http_4xx');
    expect(classifyProviderError({ httpStatus: 429 })).toBe('http_4xx');
    expect(classifyProviderError({ httpStatus: 500 })).toBe('http_5xx');
    expect(classifyProviderError({ httpStatus: 503 })).toBe('http_5xx');
    expect(classifyProviderError({ timedOut: true })).toBe('timeout');
    expect(classifyProviderError({ networkError: true })).toBe('network');
    expect(classifyProviderError({ httpStatus: 200 })).toBe('none');
  });

  it.each([0, 1])('5xx 在 retryCount=%i 時可重試', (retryCount) => {
    expect(shouldRetry({ errorClass: 'http_5xx', retryCount })).toEqual({
      retry: true,
      delayMs: retryCount === 0 ? 10_000 : 40_000,
    });
  });

  it('5xx 在 retryCount=2 時不再重試', () => {
    expect(shouldRetry({ errorClass: 'http_5xx', retryCount: 2 })).toEqual({
      retry: false,
      reason: 'budget_exhausted',
    });
  });

  it.each(['http_4xx'] as const)('%s 一律不重試（即使還有額度）', (errorClass) => {
    expect(shouldRetry({ errorClass, retryCount: 0 })).toEqual({
      retry: false,
      reason: 'not_retryable',
    });
  });

  it('timeout 與 network 可重試', () => {
    expect(shouldRetry({ errorClass: 'timeout', retryCount: 0 }).retry).toBe(true);
    expect(shouldRetry({ errorClass: 'network', retryCount: 0 }).retry).toBe(true);
  });

  it('退避是 10s / 40s', () => {
    expect(backoffDelayMs(0)).toBe(10_000);
    expect(backoffDelayMs(1)).toBe(40_000);
    expect(() => backoffDelayMs(2)).toThrow();
  });
});
