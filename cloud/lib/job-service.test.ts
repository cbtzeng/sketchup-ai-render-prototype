/**
 * job-service.test.ts —— 狀態機測試。
 *
 * 對照 docs/architecture.md 第 3 節的轉移表，逐條驗證合法與非法轉移。
 * 全部用 in-memory store，不連 Supabase。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryJobStore, makeJob } from './db-memory.js';
import type { AssetKind, JobRow, JobStatus } from './db.js';
import { REQUIRED_CONTROL_KINDS, TERMINAL_STATUSES } from './db.js';
import {
  IllegalTransitionError,
  JobService,
  LEGAL_TRANSITIONS,
  TransitionGuardError,
} from './job-service.js';

const T0 = '2026-09-04T00:00:00.000Z';

class Clock {
  private t: number;
  constructor(iso: string) {
    this.t = Date.parse(iso);
  }
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
    return this;
  }
}

let store: InMemoryJobStore;
let clock: Clock;
let svc: JobService;

beforeEach(() => {
  store = new InMemoryJobStore();
  clock = new Clock(T0);
  svc = new JobService(store, { now: clock.now });
});

async function uploadControls(jobId: string, kinds: readonly AssetKind[] = REQUIRED_CONTROL_KINDS) {
  for (const kind of kinds) {
    await store.insertAsset({
      job_id: jobId,
      kind,
      storage_path: `jobs/${jobId}/${kind}.png`,
      width: 1024,
      height: 1024,
      sha256: `sha-${kind}`,
      sha256_declared: `sha-${kind}`,
      upload_state: 'verified',
    });
  }
}

/** 造一個 job 並推進到指定狀態，走的都是合法路徑。 */
async function jobAt(status: JobStatus, overrides: Partial<JobRow> = {}): Promise<JobRow> {
  let job = await svc.create(makeJob({ created_at: clock.now().toISOString(), ...overrides }));
  if (status === 'created') return job;

  await uploadControls(job.id);
  job = await svc.transition(job.id, 'queued', { costGuardPassed: true });
  if (status === 'queued') return job;

  job = await svc.transition(job.id, 'running', { providerJobId: 'prov-1' });
  if (status === 'running') return job;

  if (status === 'retrying') {
    return svc.transition(job.id, 'retrying', { errorClass: 'http_5xx' });
  }
  if (status === 'succeeded') {
    return svc.transition(job.id, 'succeeded', { costActualCents: 4 });
  }
  if (status === 'failed') {
    return svc.transition(job.id, 'failed', { errorClass: 'http_4xx', errorCode: 'PROV-400' });
  }
  if (status === 'cancelled') {
    return svc.transition(job.id, 'cancelled', { trigger: 'user' });
  }
  if (status === 'expired') {
    clock.advance(11 * 60 * 1000);
    return svc.transition(job.id, 'expired', { trigger: 'sweeper' });
  }
  throw new Error(`unhandled status ${status}`);
}

// ---------------------------------------------------------------------------

describe('建立 job', () => {
  it('create 會寫一筆 null → created 的 job_event', async () => {
    const job = await svc.create(makeJob());
    expect(job.status).toBe('created');

    const events = await store.listJobEvents(job.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from_status: null, to_status: 'created' });
  });
});

describe('created → queued（需要 asset 齊全 + sha256 校驗 + cost_guard 放行）', () => {
  it('三張控制圖都 verified 且 cost_guard 放行 → 成功', async () => {
    const job = await svc.create(makeJob());
    await uploadControls(job.id);

    const queued = await svc.transition(job.id, 'queued', { costGuardPassed: true });
    expect(queued.status).toBe('queued');
  });

  it('缺一張控制圖 → 拋 TransitionGuardError(ASSETS_NOT_READY)', async () => {
    const job = await svc.create(makeJob());
    await uploadControls(job.id, ['beauty', 'edge']); // 少了 depth

    await expect(svc.transition(job.id, 'queued', { costGuardPassed: true })).rejects.toThrow(
      TransitionGuardError,
    );
    await expect(svc.transition(job.id, 'queued', { costGuardPassed: true })).rejects.toMatchObject({
      code: 'ASSETS_NOT_READY',
    });
    expect((await store.getJob(job.id))!.status).toBe('created');
  });

  it('sha256 不符（upload_state=mismatch）→ 擋下', async () => {
    const job = await svc.create(makeJob());
    await uploadControls(job.id, ['beauty', 'edge']);
    await store.insertAsset({
      job_id: job.id,
      kind: 'depth',
      storage_path: `jobs/${job.id}/depth.png`,
      width: 1024,
      height: 1024,
      sha256: 'sha-actual',
      sha256_declared: 'sha-expected',
      upload_state: 'mismatch',
    });

    await expect(svc.transition(job.id, 'queued', { costGuardPassed: true })).rejects.toMatchObject({
      code: 'ASSETS_NOT_READY',
    });
  });

  it('cost_guard 未放行 → 擋下', async () => {
    const job = await svc.create(makeJob());
    await uploadControls(job.id);

    await expect(svc.transition(job.id, 'queued', { costGuardPassed: false })).rejects.toMatchObject(
      { code: 'COST_GUARD_NOT_PASSED' },
    );
  });
});

describe('created → failed（上傳逾時或校驗失敗）', () => {
  it('可直接失敗，並記 error_code', async () => {
    const job = await svc.create(makeJob());
    const failed = await svc.transition(job.id, 'failed', {
      errorCode: 'UPL-01',
      errorMsg: '上傳逾時',
    });
    expect(failed.status).toBe('failed');
    expect(failed.error_code).toBe('UPL-01');
    expect(failed.finished_at).toBe(T0);
  });
});

describe('created → cancelled（使用者在上傳階段就按取消）', () => {
  it('可直接取消，並記 finished_at 與取消原因', async () => {
    const job = await svc.create(makeJob({ created_at: clock.now().toISOString() }));
    clock.advance(5_000);

    const cancelled = await svc.transition(job.id, 'cancelled', {
      trigger: 'user',
      errorCode: 'JOB-CANCELLED',
      errorMsg: '使用者在上傳階段取消',
    });

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finished_at).toBe('2026-09-04T00:00:05.000Z');
    expect(cancelled.error_code).toBe('JOB-CANCELLED');
    // 還沒送出過 provider，不該留下 started_at
    expect(cancelled.started_at).toBeNull();
  });

  it('控制圖還沒上傳完也能取消 —— 取消不受 created → queued 的 asset guard 影響', async () => {
    const job = await svc.create(makeJob());
    await uploadControls(job.id, ['beauty']); // 只上傳一張

    const cancelled = await svc.transition(job.id, 'cancelled', { trigger: 'user' });
    expect(cancelled.status).toBe('cancelled');
  });

  it('寫下一筆 created → cancelled 的 job_event，trigger=user', async () => {
    const job = await svc.create(makeJob());
    await svc.transition(job.id, 'cancelled', { trigger: 'user' });

    const events = await store.listJobEvents(job.id);
    expect(events.map((e) => `${e.from_status ?? '∅'}→${e.to_status}`)).toEqual([
      '∅→created',
      'created→cancelled',
    ]);
    expect(events.at(-1)!.detail_json).toMatchObject({ trigger: 'user' });
  });
});

describe('queued → running', () => {
  it('設定 started_at 與 provider_job_id', async () => {
    const job = await jobAt('queued');
    clock.advance(3000);
    const running = await svc.transition(job.id, 'running', { providerJobId: 'prov-42' });
    expect(running.status).toBe('running');
    expect(running.provider_job_id).toBe('prov-42');
    expect(running.started_at).toBe('2026-09-04T00:00:03.000Z');
  });
});

describe('queued → failed（provider 在 submit 當下就回 4xx）', () => {
  it('直接失敗，記 finished_at / error_code / error_msg', async () => {
    const job = await jobAt('queued');
    clock.advance(2_000);

    const failed = await svc.transition(job.id, 'failed', {
      errorClass: 'http_4xx',
      errorCode: 'PROV-400',
      errorMsg: 'invalid control image',
    });

    expect(failed.status).toBe('failed');
    expect(failed.finished_at).toBe('2026-09-04T00:00:02.000Z');
    expect(failed.error_code).toBe('PROV-400');
    expect(failed.error_msg).toBe('invalid control image');
    // submit 就被打回，provider 從未開始跑，started_at 必須維持 null
    expect(failed.started_at).toBeNull();
    expect(failed.retry_count).toBe(0);
  });

  it('寫下一筆 queued → failed 的 job_event，帶 error_class', async () => {
    const job = await jobAt('queued');
    await svc.transition(job.id, 'failed', { errorClass: 'http_4xx', errorCode: 'PROV-400' });

    const events = await store.listJobEvents(job.id);
    expect(events.at(-1)).toMatchObject({ from_status: 'queued', to_status: 'failed' });
    expect(events.at(-1)!.detail_json).toMatchObject({
      trigger: 'cloud',
      error_class: 'http_4xx',
      error_code: 'PROV-400',
    });
  });
});

describe('queued → retrying（provider 在 submit 當下就回 5xx / 逾時）', () => {
  it.each(['http_5xx', 'timeout', 'network'] as const)('%s → retrying', async (errorClass) => {
    const job = await jobAt('queued');
    const r = await svc.transition(job.id, 'retrying', { errorClass });
    expect(r.status).toBe('retrying');
    // 進 retrying 本身不算一次重試；retry_count 是在 retrying → queued 才遞增的
    expect(r.retry_count).toBe(0);
    expect(r.finished_at).toBeNull();
  });

  it('http_4xx → 被拒（NOT_RETRYABLE_ERROR），job 仍停在 queued', async () => {
    const job = await jobAt('queued');
    await expect(
      svc.transition(job.id, 'retrying', { errorClass: 'http_4xx' }),
    ).rejects.toMatchObject({ code: 'NOT_RETRYABLE_ERROR' });
    expect((await store.getJob(job.id))!.status).toBe('queued');
  });

  it('未指定 errorClass → 被拒（不知道錯在哪就不准重試）', async () => {
    const job = await jobAt('queued');
    await expect(svc.transition(job.id, 'retrying', {})).rejects.toMatchObject({
      code: 'NOT_RETRYABLE_ERROR',
    });
    expect((await store.getJob(job.id))!.status).toBe('queued');
  });

  it('失敗的 guard 不留下 job_event', async () => {
    const job = await jobAt('queued');
    const before = (await store.listJobEvents(job.id)).length;
    await expect(svc.transition(job.id, 'retrying', { errorClass: 'http_4xx' })).rejects.toThrow(
      TransitionGuardError,
    );
    expect((await store.listJobEvents(job.id)).length).toBe(before);
  });

  it('寫下一筆 queued → retrying 的 job_event', async () => {
    const job = await jobAt('queued');
    await svc.transition(job.id, 'retrying', { errorClass: 'http_5xx' });

    const events = await store.listJobEvents(job.id);
    expect(events.map((e) => `${e.from_status ?? '∅'}→${e.to_status}`)).toEqual([
      '∅→created',
      'created→queued',
      'queued→retrying',
    ]);
    expect(events.at(-1)!.detail_json).toMatchObject({ error_class: 'http_5xx' });
  });

  it('submit 連續失敗時仍受 2 次重試上限拘束，第 3 次只能收在 failed', async () => {
    const job = await jobAt('queued');

    // 第 1 次：submit 5xx → retrying → 退避 10s 後回 queued
    // next_attempt_at 在**進入** retrying 時就寫定 —— 那才是「這次何時可以重送」。
    let retrying = await svc.transition(job.id, 'retrying', { errorClass: 'http_5xx' });
    expect(retrying.next_attempt_at).toBe('2026-09-04T00:00:10.000Z');
    let requeued = await svc.transition(job.id, 'queued', {});
    expect(requeued.retry_count).toBe(1);
    // 重送出去就不再是等待中，清空避免 sweeper 的粗篩再撈到它
    expect(requeued.next_attempt_at).toBeNull();

    // 第 2 次：退避 40s
    retrying = await svc.transition(job.id, 'retrying', { errorClass: 'timeout' });
    expect(retrying.next_attempt_at).toBe('2026-09-04T00:00:40.000Z');
    requeued = await svc.transition(job.id, 'queued', {});
    expect(requeued.retry_count).toBe(2);
    expect(requeued.next_attempt_at).toBeNull();

    // 第 3 次：額度用盡。進 retrying 仍合法（錯誤分類可重試），
    // 但 retrying → queued 會被 RETRY_BUDGET_EXHAUSTED 擋下，只剩 failed 這條路。
    // 此時不該有退避時間 —— 不會有下一次重送了。
    const exhausted = await svc.transition(job.id, 'retrying', { errorClass: 'http_5xx' });
    expect(exhausted.next_attempt_at).toBeNull();
    await expect(svc.transition(job.id, 'queued', {})).rejects.toMatchObject({
      code: 'RETRY_BUDGET_EXHAUSTED',
    });
    const failed = await svc.transition(job.id, 'failed', { errorCode: 'PROV-503' });
    expect(failed.status).toBe('failed');
    expect(failed.retry_count).toBe(2);
  });
});

describe('running → retrying 只在 5xx / timeout；4xx 一律不重試', () => {
  it.each(['http_5xx', 'timeout', 'network'] as const)('%s → retrying', async (errorClass) => {
    const job = await jobAt('running');
    const r = await svc.transition(job.id, 'retrying', { errorClass });
    expect(r.status).toBe('retrying');
  });

  it('http_4xx → retrying 被拒（NOT_RETRYABLE_ERROR），job 仍在 running', async () => {
    const job = await jobAt('running');
    await expect(svc.transition(job.id, 'retrying', { errorClass: 'http_4xx' })).rejects.toMatchObject(
      { code: 'NOT_RETRYABLE_ERROR' },
    );
    expect((await store.getJob(job.id))!.status).toBe('running');
  });

  it('http_4xx 應該走 running → failed', async () => {
    const job = await jobAt('running');
    const failed = await svc.transition(job.id, 'failed', {
      errorClass: 'http_4xx',
      errorCode: 'PROV-422',
      errorMsg: 'content policy',
    });
    expect(failed.status).toBe('failed');
    expect(failed.error_msg).toBe('content policy');
  });

  it('未指定 errorClass → 不得進 retrying', async () => {
    const job = await jobAt('running');
    await expect(svc.transition(job.id, 'retrying', {})).rejects.toMatchObject({
      code: 'NOT_RETRYABLE_ERROR',
    });
  });
});

describe('retrying → queued 最多 2 次，退避 10s / 40s', () => {
  it('第一次退避 10s、第二次 40s，第三次拒絕', async () => {
    const job = await jobAt('running');

    // 第 1 次重試
    // next_attempt_at 在**進入** retrying 時就寫定 —— 那才是「這次何時可以重送」。
    let retrying = await svc.transition(job.id, 'retrying', { errorClass: 'http_5xx' });
    expect(retrying.next_attempt_at).toBe('2026-09-04T00:00:10.000Z');
    let requeued = await svc.transition(job.id, 'queued', {});
    expect(requeued.retry_count).toBe(1);
    // 重送出去就不再是等待中，清空避免 sweeper 的粗篩再撈到它
    expect(requeued.next_attempt_at).toBeNull();

    // 第 2 次重試
    await svc.transition(job.id, 'running', {});
    retrying = await svc.transition(job.id, 'retrying', { errorClass: 'timeout' });
    expect(retrying.next_attempt_at).toBe('2026-09-04T00:00:40.000Z');
    requeued = await svc.transition(job.id, 'queued', {});
    expect(requeued.retry_count).toBe(2);
    expect(requeued.next_attempt_at).toBeNull();

    // 第 3 次：額度用盡
    await svc.transition(job.id, 'running', {});
    await svc.transition(job.id, 'retrying', { errorClass: 'http_5xx' });
    await expect(svc.transition(job.id, 'queued', {})).rejects.toMatchObject({
      code: 'RETRY_BUDGET_EXHAUSTED',
    });
  });

  it('重試用盡後 retrying → failed 合法', async () => {
    const job = await jobAt('running');
    await svc.transition(job.id, 'retrying', { errorClass: 'http_5xx' });
    await svc.transition(job.id, 'queued', {});
    await svc.transition(job.id, 'running', {});
    await svc.transition(job.id, 'retrying', { errorClass: 'http_5xx' });
    await svc.transition(job.id, 'queued', {});
    await svc.transition(job.id, 'running', {});
    await svc.transition(job.id, 'retrying', { errorClass: 'http_5xx' });

    const failed = await svc.transition(job.id, 'failed', { errorCode: 'PROV-5XX' });
    expect(failed.status).toBe('failed');
    expect(failed.retry_count).toBe(2);
  });
});

describe('retrying → cancelled（退避等待中按取消）', () => {
  it('可取消，記 finished_at，且保留 retry_count 供事後分析', async () => {
    const job = await jobAt('running');
    await svc.transition(job.id, 'retrying', { errorClass: 'http_5xx' });
    await svc.transition(job.id, 'queued', {}); // retry_count = 1，next_attempt_at = +10s
    await svc.transition(job.id, 'retrying', { errorClass: 'http_5xx' });
    clock.advance(3_000); // 使用者不想等第二次退避

    const cancelled = await svc.transition(job.id, 'cancelled', {
      trigger: 'user',
      errorCode: 'JOB-CANCELLED',
    });

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finished_at).toBe('2026-09-04T00:00:03.000Z');
    expect(cancelled.retry_count).toBe(1);
  });

  it('寫下一筆 retrying → cancelled 的 job_event，trigger=user', async () => {
    const job = await jobAt('retrying');
    await svc.transition(job.id, 'cancelled', { trigger: 'user' });

    const events = await store.listJobEvents(job.id);
    expect(events.at(-1)).toMatchObject({ from_status: 'retrying', to_status: 'cancelled' });
    expect(events.at(-1)!.detail_json).toMatchObject({ trigger: 'user' });
  });

  it('取消後就是終態，退避排程再回來也推不動（避免排程與取消打架）', async () => {
    const job = await jobAt('retrying');
    await svc.transition(job.id, 'cancelled', { trigger: 'user' });
    await expect(svc.transition(job.id, 'queued', {})).rejects.toThrow(IllegalTransitionError);
  });
});

describe('queued / running → cancelled', () => {
  it.each(['queued', 'running'] as const)('%s 可被使用者取消', async (from) => {
    const job = await jobAt(from);
    const cancelled = await svc.transition(job.id, 'cancelled', { trigger: 'user' });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finished_at).not.toBeNull();
  });
});

describe('running → succeeded', () => {
  it('回填 cost_actual_cents 與 finished_at', async () => {
    const job = await jobAt('running');
    clock.advance(30_000);
    const done = await svc.transition(job.id, 'succeeded', { costActualCents: 7 });
    expect(done.status).toBe('succeeded');
    expect(done.cost_actual_cents).toBe(7);
    expect(done.finished_at).toBe('2026-09-04T00:00:30.000Z');
  });
});

describe('任何非終態 → expired（created_at + 10 分鐘）', () => {
  it.each(['created', 'queued', 'running', 'retrying'] as const)(
    '%s 在 10 分鐘後可過期',
    async (from) => {
      const job = await jobAt(from);
      clock.advance(10 * 60 * 1000);
      const expired = await svc.transition(job.id, 'expired', { trigger: 'sweeper' });
      expect(expired.status).toBe('expired');
    },
  );

  it('未滿 10 分鐘 → 拒絕（NOT_YET_EXPIRED）', async () => {
    const job = await jobAt('running');
    clock.advance(10 * 60 * 1000 - 1);
    await expect(svc.transition(job.id, 'expired', { trigger: 'sweeper' })).rejects.toMatchObject({
      code: 'NOT_YET_EXPIRED',
    });
  });

  // 注意：生產路徑用的是 RetryScheduler.sweepExpired（有筆數上限、會釋放額度）。
  // 這個測試只驗 job-service 這一層的轉移邏輯，兩者不可同時接線 —— 會重複釋放 cents。
  it('sweepExpired 只掃到過期的非終態 job', async () => {
    const stale = await jobAt('running');
    clock.advance(10 * 60 * 1000);
    const fresh = await jobAt('running', { user_id: 'user_b' });

    const swept = await svc.sweepExpired();
    expect(swept.map((j) => j.id)).toEqual([stale.id]);
    expect((await store.getJob(fresh.id))!.status).toBe('running');
  });
});

describe('終態不可再轉移', () => {
  it.each(TERMINAL_STATUSES)('%s 之後任何轉移都拋 IllegalTransitionError', async (terminal) => {
    const job = await jobAt(terminal);
    const targets: JobStatus[] = [
      'created',
      'queued',
      'running',
      'retrying',
      'succeeded',
      'failed',
      'cancelled',
      'expired',
    ];
    for (const to of targets) {
      await expect(svc.transition(job.id, to, { costGuardPassed: true })).rejects.toThrow(
        IllegalTransitionError,
      );
    }
  });

  it('succeeded → running 明確拋錯（回歸測試）', async () => {
    const job = await jobAt('succeeded');
    await expect(svc.transition(job.id, 'running', {})).rejects.toThrow(IllegalTransitionError);
  });
});

describe('轉移表以外的組合一律非法', () => {
  // 2026-09-04 修訂後，created→cancelled / queued→retrying / retrying→cancelled
  // 已成為合法邊，因此從這份清單移出（各自有專屬的合法轉移 describe）。
  // 這裡只留「表上真的沒有」的組合，避免日後有人順手放寬。
  const illegal: Array<[JobStatus, JobStatus]> = [
    ['created', 'running'],
    ['created', 'succeeded'],
    ['created', 'retrying'], // 還沒送出過 provider，談不上重試
    ['queued', 'succeeded'], // 必須先 running 才可能有結果落地
    ['running', 'queued'], // 回佇列只能經由 retrying（才會計入 retry_count 與退避）
    ['running', 'created'],
    ['retrying', 'running'], // 必須先回 queued 重新送出
    ['retrying', 'succeeded'],
  ];

  it.each(illegal)('%s → %s 非法', async (from, to) => {
    const job = await jobAt(from);
    await expect(svc.transition(job.id, to, { costGuardPassed: true })).rejects.toThrow(
      IllegalTransitionError,
    );
    expect((await store.getJob(job.id))!.status).toBe(from);
  });

  it('LEGAL_TRANSITIONS 表不含任何從終態出發的邊', () => {
    for (const terminal of TERMINAL_STATUSES) {
      expect(LEGAL_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it('自我轉移（running → running）非法', async () => {
    const job = await jobAt('running');
    await expect(svc.transition(job.id, 'running', {})).rejects.toThrow(IllegalTransitionError);
  });
});

describe('job_events append-only 軌跡', () => {
  it('每次轉移都寫一筆，順序與內容可還原整條軌跡', async () => {
    const job = await jobAt('running');
    await svc.transition(job.id, 'retrying', { errorClass: 'http_5xx' });
    await svc.transition(job.id, 'queued', {});
    await svc.transition(job.id, 'running', {});
    await svc.transition(job.id, 'succeeded', { costActualCents: 3 });

    const events = await store.listJobEvents(job.id);
    expect(events.map((e) => `${e.from_status ?? '∅'}→${e.to_status}`)).toEqual([
      '∅→created',
      'created→queued',
      'queued→running',
      'running→retrying',
      'retrying→queued',
      'queued→running',
      'running→succeeded',
    ]);
  });

  it('非法轉移不留下 job_event（不污染軌跡）', async () => {
    const job = await jobAt('succeeded');
    const before = (await store.listJobEvents(job.id)).length;
    await expect(svc.transition(job.id, 'running', {})).rejects.toThrow();
    expect((await store.listJobEvents(job.id)).length).toBe(before);
  });

  it('detail_json 帶上觸發者與錯誤分類', async () => {
    const job = await jobAt('running');
    await svc.transition(job.id, 'retrying', { errorClass: 'http_5xx', detail: { attempt: 1 } });
    const events = await store.listJobEvents(job.id);
    expect(events.at(-1)!.detail_json).toMatchObject({
      trigger: 'cloud',
      error_class: 'http_5xx',
      attempt: 1,
    });
  });
});

describe('併發保護', () => {
  it('同一個 job 併發兩次 queued → running，只有一個成功', async () => {
    const job = await jobAt('queued');
    const results = await Promise.allSettled([
      svc.transition(job.id, 'running', {}),
      svc.transition(job.id, 'running', {}),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'STALE_STATUS' });

    // 事件也只多一筆
    const events = await store.listJobEvents(job.id);
    expect(events.filter((e) => e.to_status === 'running')).toHaveLength(1);
  });
});

describe('找不到 job', () => {
  it('拋 JOB_NOT_FOUND', async () => {
    await expect(svc.transition('nope', 'queued', {})).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
    });
  });
});

describe('LEGAL_TRANSITIONS 與 architecture.md 第 3 節轉移表逐條對齊', () => {
  it('整張表完全相符（防止日後順手放寬）', () => {
    expect(LEGAL_TRANSITIONS).toEqual({
      created: ['queued', 'failed', 'cancelled', 'expired'],
      queued: ['running', 'failed', 'retrying', 'cancelled', 'expired'],
      running: ['succeeded', 'failed', 'retrying', 'cancelled', 'expired'],
      retrying: ['queued', 'failed', 'cancelled', 'expired'],
      succeeded: [],
      failed: [],
      cancelled: [],
      expired: [],
    });
  });
});
