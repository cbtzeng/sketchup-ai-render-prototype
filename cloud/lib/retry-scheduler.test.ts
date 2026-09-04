/**
 * retry-scheduler.test.ts —— 退避重送 sweeper 與 /v1/internal/sweep 端點的測試。
 *
 * 時鐘一律注入（`clock.current`），全檔**沒有任何 sleep**。
 * 理由：退避是 10s / 40s、硬逾時是 10 分鐘，靠真實時間測要嘛慢到沒人跑，
 * 要嘛把常數改小去遷就測試 —— 後者測的就不是正式環境的行為了。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { handle as sweepEndpoint } from '../api/v1/internal/sweep.js';
import { COST_LIMITS } from './cost-guard.js';
import type { JobRow, JobStatus } from './db.js';
import { InMemoryJobStore, makeJob } from './db-memory.js';
import type { ApiRequest } from './http.js';
import {
  RetryScheduler,
  inMemoryRetryCandidates,
  retryDueAtMs,
  SWEEP_ERROR_CODES,
} from './retry-scheduler.js';

const T0 = '2026-09-05T12:00:00.000Z';
const USER = 'user_a';

/** 可注入時鐘。測試改 `clock.current` 就等於「時間過去了」。 */
function makeClock(at: string) {
  const clock = { current: new Date(at) };
  return {
    clock,
    now: () => clock.current,
    advance(ms: number) {
      clock.current = new Date(clock.current.getTime() + ms);
    },
    set(iso: string) {
      clock.current = new Date(iso);
    },
  };
}

interface Fixture {
  store: InMemoryJobStore;
  time: ReturnType<typeof makeClock>;
  scheduler: RetryScheduler;
}

function fixture(options: { maxPerSweep?: number } = {}): Fixture {
  const store = new InMemoryJobStore();
  const time = makeClock(T0);
  const scheduler = new RetryScheduler({
    store,
    retryCandidates: inMemoryRetryCandidates(store),
    now: time.now,
    ...(options.maxPerSweep === undefined ? {} : { maxPerSweep: options.maxPerSweep }),
  });
  return { store, time, scheduler };
}

/** 建一個非終態 job。`createdAt` 預設為「剛剛」，避免不小心撞到硬逾時。 */
async function seedJob(
  f: Fixture,
  status: JobStatus,
  over: { retryCount?: number; createdAt?: string; userId?: string; costCents?: number } = {},
): Promise<JobRow> {
  const createdAt = over.createdAt ?? f.time.clock.current.toISOString();
  const job = await f.store.insertJob({
    ...makeJob({
      user_id: over.userId ?? USER,
      created_at: createdAt,
      cost_estimate_cents: over.costCents ?? 5,
    } as never),
    status,
    retry_count: over.retryCount ?? 0,
  });
  return job;
}

/**
 * 模擬 webhook 把 job 推進 retrying 時留下的軌跡。
 * `api/v1/hooks/[provider].ts` 就是這樣寫的：backoff 記在 job_events.detail_json.backoff_ms，
 * **沒有寫進 jobs.next_attempt_at**（見本檔最後一組測試的說明）。
 */
async function markRetrying(
  f: Fixture,
  job: JobRow,
  opts: { at?: string; backoffMs?: number | null } = {},
): Promise<void> {
  const at = opts.at ?? f.time.clock.current.toISOString();
  const backoff = opts.backoffMs === undefined ? COST_LIMITS.BACKOFF_MS[job.retry_count] : opts.backoffMs;
  await f.store.appendJobEvent({
    job_id: job.id,
    from_status: 'running',
    to_status: 'retrying',
    at,
    detail_json: { trigger: 'cloud', ...(backoff === null ? {} : { backoff_ms: backoff }) },
  });
}

/** 一個「已經在退避中」的 job：status=retrying + 對應的 job_event。 */
async function seedRetrying(
  f: Fixture,
  opts: { retryCount?: number; enteredAt?: string; createdAt?: string; backoffMs?: number | null } = {},
): Promise<JobRow> {
  const job = await seedJob(f, 'retrying', {
    retryCount: opts.retryCount ?? 0,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
  await markRetrying(f, job, {
    ...(opts.enteredAt ? { at: opts.enteredAt } : {}),
    ...(opts.backoffMs === undefined ? {} : { backoffMs: opts.backoffMs }),
  });
  return job;
}

function statusOf(store: InMemoryJobStore, id: string): JobStatus {
  const job = store.jobs.get(id);
  if (!job) throw new Error(`job ${id} 不存在`);
  return job.status;
}

function eventsTo(store: InMemoryJobStore, id: string, to: JobStatus) {
  return store.events.filter((e) => e.job_id === id && e.to_status === to);
}

// ---------------------------------------------------------------------------
// 1. 退避時間到了才推回 queued
// ---------------------------------------------------------------------------

describe('RetryScheduler.sweepRetries —— 退避到期才推回 queued', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });

  it('第一次退避 10s：還差 1s 不推回，滿 10s 才推回', async () => {
    const job = await seedRetrying(f, { retryCount: 0 });

    f.time.advance(9_000);
    const early = await f.scheduler.sweepRetries();
    expect(early.requeued).toEqual([]);
    expect(early.skipped).toContainEqual({ jobId: job.id, reason: 'not_due' });
    expect(statusOf(f.store, job.id)).toBe('retrying');

    f.time.advance(1_000);
    const due = await f.scheduler.sweepRetries();
    expect(due.requeued).toEqual([job.id]);
    expect(statusOf(f.store, job.id)).toBe('queued');
  });

  it('第二次退避 40s（不是又一次 10s）', async () => {
    const job = await seedRetrying(f, { retryCount: 1 });

    f.time.advance(30_000);
    expect((await f.scheduler.sweepRetries()).requeued).toEqual([]);

    f.time.advance(10_000);
    expect((await f.scheduler.sweepRetries()).requeued).toEqual([job.id]);
  });

  it('推回 queued 會遞增 retry_count 並留下 job_event（軌跡完整）', async () => {
    const job = await seedRetrying(f, { retryCount: 0 });
    f.time.advance(10_000);
    await f.scheduler.sweepRetries();

    expect(f.store.jobs.get(job.id)?.retry_count).toBe(1);
    const evts = eventsTo(f.store, job.id, 'queued');
    expect(evts).toHaveLength(1);
    expect(evts[0]?.from_status).toBe('retrying');
    expect(evts[0]?.detail_json).toMatchObject({ trigger: 'sweeper' });
  });

  it('狀態不是 retrying 的 job 一律不碰', async () => {
    const running = await seedJob(f, 'running');
    const queued = await seedJob(f, 'queued');
    f.time.advance(60_000);
    const out = await f.scheduler.sweepRetries();
    expect(out.requeued).toEqual([]);
    expect(statusOf(f.store, running.id)).toBe('running');
    expect(statusOf(f.store, queued.id)).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// 2. 重試上限：第 3 次改判 failed
// ---------------------------------------------------------------------------

describe('RetryScheduler.sweepRetries —— 重試次數用盡', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });

  it(`retry_count 已達 ${COST_LIMITS.MAX_RETRIES} 時轉 failed，不再推回 queued`, async () => {
    const job = await seedRetrying(f, { retryCount: COST_LIMITS.MAX_RETRIES });
    f.time.advance(60_000);

    const out = await f.scheduler.sweepRetries();
    expect(out.failed).toEqual([job.id]);
    expect(out.requeued).toEqual([]);
    expect(statusOf(f.store, job.id)).toBe('failed');
    expect(f.store.jobs.get(job.id)?.error_code).toBe('JOB-RETRY-EXHAUSTED');
  });

  it('用盡後判 failed 會把預留的 cents 還回去，但**不退 jobs_count**', async () => {
    const job = await seedRetrying(f, { retryCount: COST_LIMITS.MAX_RETRIES });
    f.store.usage.set(`${USER}::${job.created_at.slice(0, 10)}`, {
      user_id: USER,
      day: job.created_at.slice(0, 10),
      jobs_count: 1,
      cents_spent: job.cost_estimate_cents,
    });

    f.time.advance(60_000);
    await f.scheduler.sweepRetries();

    const usage = f.store.usage.get(`${USER}::${job.created_at.slice(0, 10)}`);
    expect(usage?.cents_spent).toBe(0);
    expect(usage?.jobs_count).toBe(1); // 次數是防濫用閘門，失敗也不退
  });

  it('第 3 次失敗改判 failed —— 完整走一遍 10s → 40s → failed', async () => {
    const job = await seedRetrying(f, { retryCount: 0 });

    f.time.advance(10_000);
    await f.scheduler.sweepRetries();
    expect(statusOf(f.store, job.id)).toBe('queued'); // 第 1 次重試

    // 第 2 次失敗：模擬 queued → running → retrying
    await f.store.updateJob(job.id, { status: 'running' }, { status: 'queued' });
    await f.store.updateJob(job.id, { status: 'retrying' }, { status: 'running' });
    const afterFirst = f.store.jobs.get(job.id) as JobRow;
    await markRetrying(f, afterFirst);

    f.time.advance(39_000);
    expect((await f.scheduler.sweepRetries()).requeued).toEqual([]);
    f.time.advance(1_000);
    expect((await f.scheduler.sweepRetries()).requeued).toEqual([job.id]); // 第 2 次重試
    expect(f.store.jobs.get(job.id)?.retry_count).toBe(COST_LIMITS.MAX_RETRIES);

    // 第 3 次失敗：額度已用盡
    await f.store.updateJob(job.id, { status: 'running' }, { status: 'queued' });
    await f.store.updateJob(job.id, { status: 'retrying' }, { status: 'running' });
    await markRetrying(f, f.store.jobs.get(job.id) as JobRow, { backoffMs: null });

    f.time.advance(60_000);
    const out = await f.scheduler.sweepRetries();
    expect(out.failed).toEqual([job.id]);
    expect(statusOf(f.store, job.id)).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 3. 掃描筆數上限
// ---------------------------------------------------------------------------

describe('RetryScheduler —— 每次掃描的筆數上限', () => {
  it('到期 5 筆、上限 2 → 只推 2 筆，並回報 truncated', async () => {
    const f = fixture({ maxPerSweep: 2 });
    for (let i = 0; i < 5; i += 1) await seedRetrying(f, { retryCount: 0 });
    f.time.advance(10_000);

    const out = await f.scheduler.sweepRetries();
    expect(out.requeued).toHaveLength(2);
    expect(out.truncated).toBe(true);

    const queued = [...f.store.jobs.values()].filter((j) => j.status === 'queued');
    expect(queued).toHaveLength(2);

    // 下一輪掃描接著處理剩下的，最終全部處理完。
    await f.scheduler.sweepRetries();
    const out3 = await f.scheduler.sweepRetries();
    expect(out3.truncated).toBe(false);
    expect([...f.store.jobs.values()].every((j) => j.status === 'queued')).toBe(true);
  });

  it('過期掃描同樣受上限約束', async () => {
    const f = fixture({ maxPerSweep: 2 });
    const old = new Date(Date.parse(T0) - COST_LIMITS.HARD_TIMEOUT_MS - 1000).toISOString();
    for (let i = 0; i < 4; i += 1) await seedJob(f, 'queued', { createdAt: old });

    const out = await f.scheduler.sweepExpired();
    expect(out.expired).toHaveLength(2);
    expect(out.truncated).toBe(true);
    expect([...f.store.jobs.values()].filter((j) => j.status === 'expired')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 4. 硬逾時
// ---------------------------------------------------------------------------

describe('RetryScheduler.sweepExpired —— created_at + 10 分鐘', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });

  it('尚未滿 10 分鐘不動；滿了才轉 expired', async () => {
    const job = await seedJob(f, 'running');

    f.time.advance(COST_LIMITS.HARD_TIMEOUT_MS - 1000);
    expect((await f.scheduler.sweepExpired()).expired).toEqual([]);
    expect(statusOf(f.store, job.id)).toBe('running');

    f.time.advance(1000);
    expect((await f.scheduler.sweepExpired()).expired).toEqual([job.id]);
    expect(statusOf(f.store, job.id)).toBe('expired');
    expect(f.store.jobs.get(job.id)?.error_code).toBe('JOB-TIMEOUT');
  });

  it('終態 job 一律不碰', async () => {
    const old = new Date(Date.parse(T0) - COST_LIMITS.HARD_TIMEOUT_MS - 1000).toISOString();
    const done = await seedJob(f, 'succeeded', { createdAt: old });
    const out = await f.scheduler.sweepExpired();
    expect(out.expired).toEqual([]);
    expect(statusOf(f.store, done.id)).toBe('succeeded');
  });

  it('過期時釋放預留的 cents', async () => {
    const old = new Date(Date.parse(T0) - COST_LIMITS.HARD_TIMEOUT_MS - 1000).toISOString();
    const job = await seedJob(f, 'queued', { createdAt: old, costCents: 7 });
    const day = old.slice(0, 10);
    f.store.usage.set(`${USER}::${day}`, { user_id: USER, day, jobs_count: 1, cents_spent: 7 });

    await f.scheduler.sweepExpired();
    expect(f.store.usage.get(`${USER}::${day}`)?.cents_spent).toBe(0);
    expect(f.store.usage.get(`${USER}::${day}`)?.jobs_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. 兩個 pass 的先後：過期優先於重送
// ---------------------------------------------------------------------------

describe('RetryScheduler.sweep —— 過期優先', () => {
  it('同時「退避到期」又「超過硬逾時」的 job 只會變 expired，不會先被重送一次', async () => {
    const f = fixture();
    const old = new Date(Date.parse(T0) - COST_LIMITS.HARD_TIMEOUT_MS + 5_000).toISOString();
    const job = await seedRetrying(f, { retryCount: 0, createdAt: old });

    // 退避（10s）與硬逾時（剩 5s）都已經過去。
    f.time.advance(20_000);
    const out = await f.scheduler.sweep();

    expect(out.expired).toEqual([job.id]);
    expect(out.requeued).toEqual([]);
    expect(statusOf(f.store, job.id)).toBe('expired');
    // 重送一次會白花一次 provider 呼叫，隨即又被判 expired —— 這是燒錢的順序錯誤。
    expect(eventsTo(f.store, job.id, 'queued')).toHaveLength(0);
  });

  it('過期掃描被上限截斷時，殘留的過期 job 也不會被重送', async () => {
    const f = fixture({ maxPerSweep: 1 });
    const old = new Date(Date.parse(T0) - COST_LIMITS.HARD_TIMEOUT_MS - 60_000).toISOString();
    await seedJob(f, 'queued', { createdAt: old });
    const stale = await seedRetrying(f, { retryCount: 0, createdAt: old, enteredAt: old });

    const out = await f.scheduler.sweep();
    expect(out.requeued).toEqual([]);
    expect(statusOf(f.store, stale.id)).not.toBe('queued');
    expect(out.skipped.some((s) => s.jobId === stale.id && s.reason === 'past_hard_deadline')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. 併發安全
// ---------------------------------------------------------------------------

describe('RetryScheduler —— 併發安全', () => {
  it('兩個 sweeper 同時掃，同一個 job 只被推回 queued 一次', async () => {
    const store = new InMemoryJobStore();
    const time = makeClock(T0);
    const mk = () =>
      new RetryScheduler({ store, retryCandidates: inMemoryRetryCandidates(store), now: time.now });
    const f: Fixture = { store, time, scheduler: mk() };

    const job = await seedRetrying(f, { retryCount: 0 });
    time.advance(10_000);

    const [a, b] = await Promise.all([mk().sweepRetries(), mk().sweepRetries()]);

    const requeued = [...a.requeued, ...b.requeued];
    expect(requeued).toEqual([job.id]); // 恰好一次
    expect(eventsTo(store, job.id, 'queued')).toHaveLength(1);
    expect(store.jobs.get(job.id)?.retry_count).toBe(1); // 不會被加兩次
    const raced = [...a.skipped, ...b.skipped];
    expect(raced).toContainEqual({ jobId: job.id, reason: 'raced' });
  });

  it('兩個 sweeper 同時做過期掃描，同一個 job 只被判 expired 一次', async () => {
    const store = new InMemoryJobStore();
    const time = makeClock(T0);
    const mk = () =>
      new RetryScheduler({ store, retryCandidates: inMemoryRetryCandidates(store), now: time.now });
    const f: Fixture = { store, time, scheduler: mk() };

    const old = new Date(Date.parse(T0) - COST_LIMITS.HARD_TIMEOUT_MS - 1000).toISOString();
    const job = await seedJob(f, 'running', { createdAt: old });

    const [a, b] = await Promise.all([mk().sweepExpired(), mk().sweepExpired()]);
    expect([...a.expired, ...b.expired]).toEqual([job.id]);
    expect(eventsTo(store, job.id, 'expired')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7. 到期時間的推算（這是本模組最容易出錯的地方）
// ---------------------------------------------------------------------------

describe('retryDueAtMs —— 退避基準點從哪裡來', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });

  it('以最後一筆 retrying 事件的時間 + detail_json.backoff_ms 為準', async () => {
    const job = await seedRetrying(f, { retryCount: 0, enteredAt: T0, backoffMs: 10_000 });
    const events = await f.store.listJobEvents(job.id);
    expect(retryDueAtMs(f.store.jobs.get(job.id) as JobRow, events)).toBe(Date.parse(T0) + 10_000);
  });

  it('事件沒記 backoff_ms 時，退回用 retry_count 查退避表', async () => {
    const job = await seedRetrying(f, { retryCount: 1, enteredAt: T0, backoffMs: null });
    const events = await f.store.listJobEvents(job.id);
    expect(retryDueAtMs(f.store.jobs.get(job.id) as JobRow, events)).toBe(Date.parse(T0) + 40_000);
  });

  it('next_attempt_at 是上一輪留下的**過期舊值**時，不可因此把退避縮成 0', async () => {
    // job-service 目前在 retrying → queued 才寫 next_attempt_at，
    // 因此再次進入 retrying 時該欄位是上一輪的舊值（已在過去）。
    const job = await seedRetrying(f, { retryCount: 1, enteredAt: T0, backoffMs: 40_000 });
    await f.store.updateJob(
      job.id,
      { next_attempt_at: new Date(Date.parse(T0) - 30_000).toISOString() },
      { status: 'retrying' },
    );
    const fresh = f.store.jobs.get(job.id) as JobRow;
    const events = await f.store.listJobEvents(job.id);
    expect(retryDueAtMs(fresh, events)).toBe(Date.parse(T0) + 40_000);

    f.time.advance(39_000);
    expect((await f.scheduler.sweepRetries()).requeued).toEqual([]);
  });

  it('next_attempt_at 比事件推算值更晚時以它為準（未來若改由 webhook 寫入也不會被搶跑）', async () => {
    const job = await seedRetrying(f, { retryCount: 0, enteredAt: T0, backoffMs: 10_000 });
    const later = new Date(Date.parse(T0) + 25_000).toISOString();
    await f.store.updateJob(job.id, { next_attempt_at: later }, { status: 'retrying' });
    const fresh = f.store.jobs.get(job.id) as JobRow;
    expect(retryDueAtMs(fresh, await f.store.listJobEvents(job.id))).toBe(Date.parse(later));
  });

  it('完全沒有退避依據時回 null，sweeper 保守跳過（不亂推）', async () => {
    const job = await seedJob(f, 'retrying'); // 刻意不寫 retrying 事件
    expect(retryDueAtMs(job, [])).toBeNull();

    f.time.advance(60_000);
    const out = await f.scheduler.sweepRetries();
    expect(out.requeued).toEqual([]);
    expect(out.skipped).toContainEqual({ jobId: job.id, reason: 'no_retry_schedule' });
    expect(statusOf(f.store, job.id)).toBe('retrying'); // 最終由硬逾時收掉
  });
});

// ---------------------------------------------------------------------------
// 8. /v1/internal/sweep 端點的授權
// ---------------------------------------------------------------------------

describe('POST /v1/internal/sweep —— 內部授權', () => {
  let f: Fixture;
  const SECRET = 's3cret-from-env';

  function req(init: { method?: string; headers?: Record<string, string> } = {}): ApiRequest {
    return {
      method: init.method ?? 'POST',
      path: '/v1/internal/sweep',
      query: {},
      headers: init.headers ?? { 'x-internal-secret': SECRET },
      rawBody: '',
      params: {},
    };
  }

  beforeEach(async () => {
    f = fixture();
    const job = await seedRetrying(f, { retryCount: 0 });
    f.time.advance(10_000);
    // 保留 job 供斷言使用
    (f as Fixture & { seeded: JobRow }).seeded = job;
  });

  it('沒有密鑰 header → 401，而且**沒有執行任何掃描**', async () => {
    const err = await expect(
      sweepEndpoint(req({ headers: {} }), { scheduler: f.scheduler, secret: SECRET }),
    ).rejects.toMatchObject({ code: SWEEP_ERROR_CODES.UNAUTHORIZED, httpStatus: 401 });
    void err;
    expect([...f.store.jobs.values()].every((j) => j.status === 'retrying')).toBe(true);
  });

  it('密鑰錯誤 → 401', async () => {
    await expect(
      sweepEndpoint(req({ headers: { 'x-internal-secret': 'wrong' } }), {
        scheduler: f.scheduler,
        secret: SECRET,
      }),
    ).rejects.toMatchObject({ code: SWEEP_ERROR_CODES.UNAUTHORIZED, httpStatus: 401 });
    expect([...f.store.jobs.values()].every((j) => j.status === 'retrying')).toBe(true);
  });

  it('環境變數沒設密鑰 → 503 fail-closed（絕不因此變成人人可打）', async () => {
    for (const secret of [null, '', '   ']) {
      await expect(
        sweepEndpoint(req(), { scheduler: f.scheduler, secret }),
      ).rejects.toMatchObject({ code: SWEEP_ERROR_CODES.NOT_CONFIGURED, httpStatus: 503 });
    }
    expect([...f.store.jobs.values()].every((j) => j.status === 'retrying')).toBe(true);
  });

  it('密鑰正確 → 200，並回報這次掃描的統計', async () => {
    const res = await sweepEndpoint(req(), { scheduler: f.scheduler, secret: SECRET });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['requeued']).toEqual([(f as Fixture & { seeded: JobRow }).seeded.id]);
    expect(body['expired']).toEqual([]);
    expect(body['truncated']).toBe(false);
    expect([...f.store.jobs.values()].every((j) => j.status === 'queued')).toBe(true);
  });

  it('GET → 405（掃描會改狀態，不可以是 GET）', async () => {
    await expect(
      sweepEndpoint(req({ method: 'GET' }), { scheduler: f.scheduler, secret: SECRET }),
    ).rejects.toMatchObject({ code: SWEEP_ERROR_CODES.METHOD, httpStatus: 405 });
  });

  it('密鑰比對用固定時間比較，長度不同也不會提早回答', async () => {
    // 只能驗行為：短密鑰與長密鑰都必須是 401，不能因長度不同而丟出別的錯。
    for (const wrong of ['s', 's3cret-from-env-plus-more', '']) {
      await expect(
        sweepEndpoint(req({ headers: { 'x-internal-secret': wrong } }), {
          scheduler: f.scheduler,
          secret: SECRET,
        }),
      ).rejects.toMatchObject({ code: SWEEP_ERROR_CODES.UNAUTHORIZED, httpStatus: 401 });
    }
  });
});
