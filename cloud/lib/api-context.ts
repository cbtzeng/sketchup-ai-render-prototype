/**
 * api-context.ts —— API handler 的依賴注入容器。
 *
 * 端點本身**不 new 任何東西**、不讀環境變數、不看時鐘。
 * 全部從 ApiContext 拿，測試才能整條路徑用假件跑完而不碰網路。
 */
import { randomUUID } from 'node:crypto';
import type { JobStore } from './db.js';
import { ApiError } from './http.js';
import type { ProviderJobLookup } from './job-lookup.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { StorageAdapter } from './storage.js';
import type { UploadBatchStore } from './upload-batches.js';

// ---------------------------------------------------------------------------
// 身分
// ---------------------------------------------------------------------------

export interface AuthenticatedUser {
  userId: string;
}

export interface AuthVerifier {
  /** 驗證 Authorization header，回使用者身分；驗不過就拋 ApiError。 */
  authenticate(headers: Readonly<Record<string, string>>): Promise<AuthenticatedUser>;
}

/**
 * 預設驗證器：一律 501。
 *
 * 🔴 未驗證：Supabase 短效 token 的驗章方式（JWKS？共享 secret？claim 名稱？），
 *    以及 open-questions Q4「使用者身分是 auth 帳號還是 device_id」尚未關閉。
 *    在那之前不提供任何「看起來可用」的預設實作 —— 那種預設最後都會被誤上線。
 */
export const unconfiguredAuth: AuthVerifier = {
  async authenticate() {
    throw new ApiError('CFG-02', 501, '尚未接上身分驗證（🔴 Supabase token 驗章方式未驗證）');
  },
};

/** 測試／本機開發用：直接把 bearer token 當作 user_id。**不可用於正式環境。** */
export function staticTokenAuth(tokenToUser: Readonly<Record<string, string>>): AuthVerifier {
  return {
    async authenticate(headers) {
      const raw = headers['authorization'] ?? '';
      const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
      if (!match || !match[1]) {
        throw new ApiError('AUTH-10', 401, '缺少 Authorization: Bearer token');
      }
      const userId = tokenToUser[match[1]];
      if (!userId) throw new ApiError('AUTH-11', 401, 'token 無效或已過期');
      return { userId };
    },
  };
}

// ---------------------------------------------------------------------------
// 估價與 preset 版本
// ---------------------------------------------------------------------------

export interface CostEstimator {
  /** 事前估算（分）。architecture.md 5.1：估算來自雲端定價表，不是硬編在 Ruby。 */
  estimateCents(input: { preset: string; fidelity: number; width: number; height: number }): number;
}

/**
 * 佔位估價器。
 *
 * 🔴 未驗證：fal.ai 的計費單位與費率（每次？每 megapixel？GPU 秒？）完全未確認，
 *    因此這裡**不寫任何看起來像真實定價的數字**。回傳固定 `PLACEHOLDER_ESTIMATE_CENTS`，
 *    只是為了讓每日額度預留有數字可用。上線前必須換掉，否則 5.9 的
 *    「估算與實際偏差 > 20% 要告警」會整天在叫。
 */
export const PLACEHOLDER_ESTIMATE_CENTS = 5;

export const placeholderCostEstimator: CostEstimator = {
  estimateCents() {
    return PLACEHOLDER_ESTIMATE_CENTS;
  },
};

/**
 * 🔴 preset_resolver 尚未實作（architecture.md 2.2）。
 * preset_version 必須記錄在每個 job 上，否則評估結果無法重現，
 * 因此這裡給一個明確標示「未解析」的版本字串，而不是隨便編一個像樣的版號。
 */
export const UNRESOLVED_PRESET_VERSION = '0.0.0-unresolved';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ApiContext {
  store: JobStore;
  storage: StorageAdapter;
  batches: UploadBatchStore;
  auth: AuthVerifier;
  providers: ProviderRegistry;
  /** webhook 反查用。未提供時 webhook 端點回 501。 */
  jobLookup?: ProviderJobLookup;
  costEstimator: CostEstimator;
  presetVersion: string;
  /** 送給 provider 的 webhook 位址前綴，例如 https://api.example.com/v1/hooks */
  webhookBaseUrl: string;
  /** 預設 provider 名稱（建 job 時寫入 jobs.provider）。 */
  defaultProvider: string;
  /**
   * 是否在 POST /v1/jobs 內同步呼叫 provider.submit。
   * 預設 false：MVP 的派工可以由獨立的 worker 掃 queued 的 job，
   * 而且 job-service 的轉移表沒有 `queued → failed / retrying`，
   * 同步 submit 失敗時無法把狀態寫回去（詳見端點註解）。
   */
  submitOnCreate: boolean;
  now: () => Date;
  newId: () => string;
}

export type ApiContextOverrides = Partial<ApiContext> &
  Pick<ApiContext, 'store' | 'storage' | 'batches' | 'auth' | 'providers'>;

/** 補齊預設值，讓測試只需要提供真正在乎的部分。 */
export function makeContext(overrides: ApiContextOverrides): ApiContext {
  return {
    jobLookup: undefined,
    costEstimator: placeholderCostEstimator,
    presetVersion: UNRESOLVED_PRESET_VERSION,
    webhookBaseUrl: 'https://example.invalid/v1/hooks',
    defaultProvider: 'fal',
    submitOnCreate: false,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 執行期 context（給平台的 default export 用）
// ---------------------------------------------------------------------------

let runtimeContext: ApiContext | null = null;

/** 由部署入口在啟動時呼叫。尚未接線時所有端點回 501，而不是半殘地跑。 */
export function setRuntimeContext(ctx: ApiContext): void {
  runtimeContext = ctx;
}

export function getRuntimeContext(): ApiContext {
  if (!runtimeContext) {
    throw new ApiError(
      'CFG-01',
      501,
      '雲端執行環境尚未接線（Supabase store / storage / provider adapter 皆為 🔴 未驗證）',
    );
  }
  return runtimeContext;
}
