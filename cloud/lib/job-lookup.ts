/**
 * job-lookup.ts —— 依 provider_job_id 反查 job。
 *
 * webhook 進來時手上只有 provider 的 job id，必須換回我們的 job。
 * `db.ts` 的 `JobStore` 沒有這個方法，而該檔在本次工作中不可修改，
 * 因此以獨立介面表示；正式的 Supabase store 應同時實作 JobStore 與本介面
 * （`001_init.sql` 已備妥 `jobs_provider_job_id_idx` 索引）。
 *
 * 🔴 需主 session 決策：是否把 `findJobByProviderJobId` 併入 `db.ts` 的 JobStore 介面。
 */
import type { JobRow } from './db.js';
import type { InMemoryJobStore } from './db-memory.js';

export interface ProviderJobLookup {
  findJobByProviderJobId(provider: string, providerJobId: string): Promise<JobRow | null>;
}

/** 測試用：在 InMemoryJobStore 上做線性掃描。 */
export function inMemoryProviderJobLookup(store: InMemoryJobStore): ProviderJobLookup {
  return {
    async findJobByProviderJobId(provider, providerJobId) {
      for (const job of store.jobs.values()) {
        if (job.provider === provider && job.provider_job_id === providerJobId) return { ...job };
      }
      return null;
    },
  };
}
