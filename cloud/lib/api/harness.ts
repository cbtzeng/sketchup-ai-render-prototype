/**
 * lib/api/harness.ts —— API 端點測試的共用假件。
 *
 * 為什麼測試放在 `lib/api/` 而不是 `api/v1/` 旁邊：
 * `vitest.config.ts` 的 include 是 `lib/**\/*.test.ts`，而本次工作的邊界是
 * 「只新增檔案、不修改既有檔案」，因此不動 vitest.config。
 * 端點本體仍在 `cloud/api/v1/`，測試以相對路徑 import 進來。
 * 若主 session 同意把 include 改成 `['lib/**\/*.test.ts', 'api/**\/*.test.ts']`，
 * 這些測試可以直接搬到端點旁邊，內容不需要改。
 *
 * 這裡的 provider 假件**不是 fal.ai 的真實 schema** —— 真實 schema 未經驗證，
 * 一個位元組都不猜。假件只用來證明端點對 adapter 介面的行為正確。
 */
import { makeContext, staticTokenAuth, type ApiContext } from '../api-context.js';
import { InMemoryJobStore } from '../db-memory.js';
import type { ApiRequest } from '../http.js';
import { inMemoryProviderJobLookup } from '../job-lookup.js';
import { ProviderRegistry, type WebhookVerifier } from '../providers/registry.js';
import type {
  NormalizedProviderEvent,
  ProviderAdapter,
  ProviderSubmitPayload,
  ProviderSubmitResult,
  ProviderWebhookInput,
} from '../providers/types.js';
import { InMemoryStorage } from '../storage.js';
import { InMemoryUploadBatchStore } from '../upload-batches.js';

export const TOKENS = { a: 'tok-user-a', b: 'tok-user-b' } as const;
export const USERS = { a: 'user_a', b: 'user_b' } as const;

export interface Harness {
  store: InMemoryJobStore;
  storage: InMemoryStorage;
  batches: InMemoryUploadBatchStore;
  providers: ProviderRegistry;
  ctx: ApiContext;
  clock: { current: Date };
  ids: { next: number };
}

export function harness(options: { now?: Date } = {}): Harness {
  const clock = { current: options.now ?? new Date('2026-09-04T12:00:00.000Z') };
  const now = () => clock.current;
  const store = new InMemoryJobStore();
  const storage = new InMemoryStorage({ now });
  const batches = new InMemoryUploadBatchStore();
  const providers = new ProviderRegistry();
  const ids = { next: 0 };

  const ctx = makeContext({
    store,
    storage,
    batches,
    providers,
    auth: staticTokenAuth({ [TOKENS.a]: USERS.a, [TOKENS.b]: USERS.b }),
    jobLookup: inMemoryProviderJobLookup(store),
    now,
    newId: () => {
      ids.next += 1;
      return `id_${String(ids.next).padStart(4, '0')}`;
    },
  });

  return { store, storage, batches, providers, ctx, clock, ids };
}

// ---------------------------------------------------------------------------
// 請求建構
// ---------------------------------------------------------------------------

export function makeRequest(init: {
  method: string;
  body?: unknown;
  rawBody?: string;
  token?: string | null;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  path?: string;
}): ApiRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers ?? {}) };
  const token = init.token === undefined ? TOKENS.a : init.token;
  if (token) headers['authorization'] = `Bearer ${token}`;
  return {
    method: init.method,
    path: init.path ?? '/v1/test',
    query: {},
    headers,
    rawBody: init.rawBody ?? (init.body === undefined ? '' : JSON.stringify(init.body)),
    params: init.params ?? {},
  };
}

// ---------------------------------------------------------------------------
// provider 假件
// ---------------------------------------------------------------------------

export interface FakeProvider {
  adapter: ProviderAdapter;
  verifier: WebhookVerifier;
  calls: {
    submits: ProviderSubmitPayload[];
    normalizes: ProviderWebhookInput[];
    verifies: ProviderWebhookInput[];
  };
}

/**
 * 假 provider。
 * - `verify`：body 必須含 header `x-fake-signature: ok`（**純屬測試約定**）
 * - `normalize`：把 rawBody 當成已經是 NormalizedProviderEvent 的 JSON
 */
export function fakeProvider(options: {
  name?: string;
  accept?: boolean;
  submitError?: Error;
  normalizeError?: Error;
} = {}): FakeProvider {
  const name = options.name ?? 'fal';
  const calls: FakeProvider['calls'] = { submits: [], normalizes: [], verifies: [] };

  const adapter: ProviderAdapter = {
    name,
    async submit(payload: ProviderSubmitPayload): Promise<ProviderSubmitResult> {
      calls.submits.push(payload);
      if (options.submitError) throw options.submitError;
      return { providerJobId: `prov_${payload.jobId}`, acceptedAt: '2026-09-04T12:00:01.000Z' };
    },
    normalize(webhook: ProviderWebhookInput): NormalizedProviderEvent {
      calls.normalizes.push(webhook);
      if (options.normalizeError) throw options.normalizeError;
      const parsed = JSON.parse(webhook.rawBody) as Partial<NormalizedProviderEvent>;
      if (!parsed.providerJobId || !parsed.kind) throw new Error('缺少必要欄位');
      return { ...parsed, receivedAt: webhook.receivedAt, raw: parsed } as NormalizedProviderEvent;
    },
  };

  const verifier: WebhookVerifier = {
    verify(input) {
      calls.verifies.push(input);
      if (options.accept === false) return false;
      return input.headers['x-fake-signature'] === 'ok';
    },
  };

  return { adapter, verifier, calls };
}

// ---------------------------------------------------------------------------
// 其他小工具
// ---------------------------------------------------------------------------

export function bodyOf(res: { body: unknown }): Record<string, unknown> {
  return res.body as Record<string, unknown>;
}

/** 期待 handler 拋出 ApiError，回傳它以便斷言 code / status。 */
export async function catchApiError(fn: () => Promise<unknown>): Promise<{
  code: string;
  httpStatus: number;
  message: string;
  detail: unknown;
}> {
  try {
    await fn();
  } catch (err) {
    const e = err as { code?: string; httpStatus?: number; message: string; detail?: unknown };
    if (typeof e.code !== 'string' || typeof e.httpStatus !== 'number') {
      throw err;
    }
    return { code: e.code, httpStatus: e.httpStatus, message: e.message, detail: e.detail };
  }
  throw new Error('預期會拋出 ApiError，但沒有');
}
