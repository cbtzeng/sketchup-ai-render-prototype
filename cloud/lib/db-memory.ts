/**
 * db-memory.ts —— JobStore 的 in-memory 假實作，只給測試用。
 *
 * 刻意模擬幾個真實 DB 的性質，否則測試會通過但正式環境會壞：
 * - updateJob 是 compare-and-set，前提不符回 null。
 * - reserveDailyQuota 在單一同步區段內完成檢查與遞增（模擬 SQL 的原子 upsert）。
 * - job_events 只能 append。
 * - 每個非同步方法都先 `await Promise.resolve()` 讓出事件迴圈，
 *   這樣「先讀後寫」的競態才會在測試中真的發生（不會因為同步執行而被掩蓋）。
 */
import type {
  AssetRow,
  JobEventRow,
  JobRow,
  JobStore,
  NewAsset,
  NewJob,
  NewJobEvent,
  QuotaReservation,
  QuotaReservationResult,
  UpdateExpectation,
  UsageDailyRow,
} from './db.js';
import { isTerminal } from './db.js';

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${String(seq).padStart(6, '0')}`;
}

/** 讓出一次事件迴圈，暴露 read-modify-write 的競態窗口。 */
const yieldTick = () => new Promise<void>((resolve) => setImmediate(resolve));

export class InMemoryJobStore implements JobStore {
  readonly jobs = new Map<string, JobRow>();
  readonly events: JobEventRow[] = [];
  readonly assets: AssetRow[] = [];
  readonly usage = new Map<string, UsageDailyRow>();

  /** 測試觀測用：reserveDailyQuota 被呼叫的次數。 */
  reserveCalls = 0;

  private usageKey(userId: string, day: string) {
    return `${userId}::${day}`;
  }

  async insertJob(row: NewJob): Promise<JobRow> {
    await yieldTick();
    if (this.jobs.has(row.id)) {
      throw new Error(`duplicate job id: ${row.id}`);
    }
    for (const existing of this.jobs.values()) {
      if (existing.user_id === row.user_id && existing.idempotency_key === row.idempotency_key) {
        // 模擬 unique index (user_id, idempotency_key) 的衝突
        throw new Error('unique violation: jobs_user_idempotency_key_uidx');
      }
    }
    const job: JobRow = {
      status: 'created',
      retry_count: 0,
      next_attempt_at: null,
      provider_job_id: null,
      cost_actual_cents: null,
      started_at: null,
      finished_at: null,
      error_code: null,
      error_msg: null,
      ...row,
    };
    this.jobs.set(job.id, job);
    return { ...job };
  }

  async getJob(id: string): Promise<JobRow | null> {
    await yieldTick();
    const job = this.jobs.get(id);
    return job ? { ...job } : null;
  }

  async findJobByIdempotencyKey(userId: string, key: string): Promise<JobRow | null> {
    await yieldTick();
    for (const job of this.jobs.values()) {
      if (job.user_id === userId && job.idempotency_key === key) return { ...job };
    }
    return null;
  }

  async updateJob(
    id: string,
    patch: Partial<JobRow>,
    expect: UpdateExpectation,
  ): Promise<JobRow | null> {
    await yieldTick();
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status !== expect.status) return null; // compare-and-set 失敗
    const next: JobRow = { ...job, ...patch, id: job.id };
    this.jobs.set(id, next);
    return { ...next };
  }

  async appendJobEvent(event: NewJobEvent): Promise<JobEventRow> {
    await yieldTick();
    const row: JobEventRow = { id: nextId('evt'), ...event };
    this.events.push(row);
    return { ...row };
  }

  async listJobEvents(jobId: string): Promise<JobEventRow[]> {
    await yieldTick();
    return this.events.filter((e) => e.job_id === jobId).map((e) => ({ ...e }));
  }

  async insertAsset(asset: NewAsset): Promise<AssetRow> {
    await yieldTick();
    const row: AssetRow = { id: nextId('ast'), ...asset };
    this.assets.push(row);
    return { ...row };
  }

  async listAssets(jobId: string): Promise<AssetRow[]> {
    await yieldTick();
    return this.assets.filter((a) => a.job_id === jobId).map((a) => ({ ...a }));
  }

  async countRunningJobs(userId: string): Promise<number> {
    await yieldTick();
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.user_id === userId && job.status === 'running') n += 1;
    }
    return n;
  }

  async reserveDailyQuota(req: QuotaReservation): Promise<QuotaReservationResult> {
    // 注意：await 放在同步區段「之前」，確保檢查與遞增之間沒有讓出點。
    // 這正是 SQL `INSERT ... ON CONFLICT DO UPDATE ... WHERE` 的語意。
    await yieldTick();
    this.reserveCalls += 1;
    const key = this.usageKey(req.user_id, req.day);
    const current: UsageDailyRow =
      this.usage.get(key) ?? { user_id: req.user_id, day: req.day, jobs_count: 0, cents_spent: 0 };

    const nextJobs = current.jobs_count + req.add_jobs;
    const nextCents = current.cents_spent + req.add_cents;

    if (nextJobs > req.jobs_limit) {
      return { ok: false, usage: { ...current }, exceeded: 'jobs' };
    }
    if (nextCents > req.cents_limit) {
      return { ok: false, usage: { ...current }, exceeded: 'cents' };
    }

    const updated: UsageDailyRow = { ...current, jobs_count: nextJobs, cents_spent: nextCents };
    this.usage.set(key, updated);
    return { ok: true, usage: { ...updated } };
  }

  async releaseDailyQuota(
    req: Pick<QuotaReservation, 'user_id' | 'day' | 'add_jobs' | 'add_cents'>,
  ): Promise<UsageDailyRow> {
    await yieldTick();
    const key = this.usageKey(req.user_id, req.day);
    const current: UsageDailyRow =
      this.usage.get(key) ?? { user_id: req.user_id, day: req.day, jobs_count: 0, cents_spent: 0 };
    const updated: UsageDailyRow = {
      ...current,
      jobs_count: Math.max(0, current.jobs_count - req.add_jobs),
      cents_spent: Math.max(0, current.cents_spent - req.add_cents),
    };
    this.usage.set(key, updated);
    return { ...updated };
  }

  async listExpiredCandidates(cutoffIso: string): Promise<JobRow[]> {
    await yieldTick();
    const cutoff = Date.parse(cutoffIso);
    return [...this.jobs.values()]
      .filter((j) => !isTerminal(j.status) && Date.parse(j.created_at) <= cutoff)
      .map((j) => ({ ...j }));
  }
}

/** 測試輔助：造一個 created 狀態的 job。 */
export function makeJob(overrides: Partial<JobRow> = {}): NewJob {
  const id = overrides.id ?? nextId('job');
  return {
    id,
    user_id: overrides.user_id ?? 'user_a',
    model_guid: overrides.model_guid ?? 'guid-1',
    scene_name: overrides.scene_name ?? 'Scene 1',
    preset: overrides.preset ?? 'exterior_dusk',
    preset_version: overrides.preset_version ?? '2026-09-04.1',
    prompt: overrides.prompt ?? 'a modern house at dusk',
    seed: overrides.seed ?? 12345,
    params_json: overrides.params_json ?? { fidelity: 0.7 },
    provider: overrides.provider ?? 'fal',
    idempotency_key: overrides.idempotency_key ?? nextId('idem'),
    cost_estimate_cents: overrides.cost_estimate_cents ?? 5,
    created_at: overrides.created_at ?? new Date('2026-09-04T00:00:00.000Z').toISOString(),
    ...(overrides.status ? { status: overrides.status } : {}),
    ...(overrides.retry_count !== undefined ? { retry_count: overrides.retry_count } : {}),
  };
}
