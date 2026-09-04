/**
 * providers/types.ts —— ProviderAdapter 介面。
 *
 * architecture.md 2.2 與第 6 節：介面**只有兩個方法** ——
 *   `submit(payload) → provider_job_id`
 *   `normalize(webhook) → JobEvent`
 * MVP 只實作 fal 一家（Replicate 只做文件調查，不假裝測過）。
 *
 * ⚠️ 本檔**刻意不含任何 provider 的實際端點路徑、參數名稱或回應格式。**
 * 專案硬規則：不確定就標記為待驗證，不要猜一個看起來合理的寫上去。
 * 下列各項在 `lib/providers/fal.ts` 落地之前一律為 🔴 未驗證：
 *
 *   🔴 fal.ai 的 submit 端點 URL 與 HTTP 方法
 *   🔴 多 ControlNet 的參數名稱與陣列結構（是 controlnets? control_image? 權重欄位叫什麼）
 *   🔴 webhook 的 payload schema 與 provider job id 的欄位名
 *   🔴 webhook 簽章的 header 名稱與驗章演算法
 *   🔴 計費資訊是否隨 webhook 回傳、單位是什麼（每次 / 每 megapixel / GPU 秒）
 *
 * 驗證方式與結果請回填 docs/open-questions.md，並在此把 🔴 改成 🟢。
 */
import type { AssetKind } from '../db.js';

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

/** 一張要送給 provider 的控制圖。URL 為短效簽名 URL。 */
export interface ControlImageRef {
  kind: AssetKind;
  url: string;
  sha256: string;
  width: number;
  height: number;
  /** preset_resolver 算出的權重。實際欄位名依 provider 而定，由 adapter 自行對映。 */
  weight?: number;
}

/**
 * 送出請求的**中性**表示。
 * 這裡刻意不出現任何 provider 專屬欄位 —— 對映到 provider 實際 body 的工作
 * 完全發生在 adapter 內部，那是唯一允許知道端點細節的地方。
 */
export interface ProviderSubmitPayload {
  jobId: string;
  idempotencyKey: string;
  presetVersion: string;
  prompt: string;
  seed: number | null;
  /** preset_resolver 展開後的模型參數（model id、steps、cfg…）。 */
  params: Record<string, unknown>;
  controls: readonly ControlImageRef[];
  /** provider 回呼的位址（POST /v1/hooks/:provider）。 */
  webhookUrl: string;
}

export interface ProviderSubmitResult {
  providerJobId: string;
  acceptedAt: string;
  /** provider 若在 submit 當下就回報估價則填入，否則 undefined。 */
  estimatedCostCents?: number;
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

/** 標準化後的事件種類。刻意比 job 狀態少：adapter 不決定狀態機怎麼走。 */
export type ProviderEventKind = 'accepted' | 'running' | 'succeeded' | 'failed';

/** provider webhook 的原始輸入。body 型別為 unknown —— 尚未驗證任何 schema。 */
export interface ProviderWebhookInput {
  headers: Record<string, string>;
  /** 原始 bytes，簽章驗證必須對未經 JSON 重新序列化的 body 做。 */
  rawBody: string;
  receivedAt: string;
}

export interface ProviderResultAsset {
  url: string;
  width?: number;
  height?: number;
  sha256?: string;
}

export interface NormalizedProviderEvent {
  providerJobId: string;
  kind: ProviderEventKind;
  receivedAt: string;
  /** kind === 'succeeded' 時的結果圖。 */
  results?: readonly ProviderResultAsset[];
  /** kind === 'failed' 時的錯誤資訊，供 cost-guard 的 classifyProviderError 判定重試。 */
  errorCode?: string;
  errorMsg?: string;
  httpStatus?: number;
  /** provider 回報的實際計費（分），用於 cost_actual_cents 回填。 */
  costActualCents?: number;
  /** 原始 payload，完整存進 job_events.detail_json 供事後對帳。 */
  raw: unknown;
}

// ---------------------------------------------------------------------------
// 介面本體
// ---------------------------------------------------------------------------

/**
 * provider adapter。**只有這兩個方法**，不要往上加。
 * 一旦 adapter 開始長出 `getStatus` / `cancel` 之類的方法，
 * 路由邏輯就會從 job-service 漏到 adapter 裡，狀態機就不再只有一個寫入者。
 */
export interface ProviderAdapter {
  readonly name: string;
  submit(payload: ProviderSubmitPayload): Promise<ProviderSubmitResult>;
  normalize(webhook: ProviderWebhookInput): NormalizedProviderEvent;
}

/** 介面方法清單，供契約測試檢查沒有人偷加方法。 */
export const PROVIDER_ADAPTER_METHODS = ['submit', 'normalize'] as const;

// ---------------------------------------------------------------------------
// 事件 → 狀態的對映
// ---------------------------------------------------------------------------

const EVENT_TO_STATUS = {
  accepted: 'running',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
} as const;

/**
 * 把標準化事件映到目標 job 狀態。
 *
 * 注意 `failed` 只是**目標狀態的建議**：實際要走 `running → failed`
 * 還是 `running → retrying`，由 cost-guard 的 shouldRetry 依錯誤分類決定，
 * 不在 adapter 這一層決定。
 */
export function providerEventToStatus(kind: ProviderEventKind): 'running' | 'succeeded' | 'failed' {
  return EVENT_TO_STATUS[kind];
}

export function isTerminalProviderEvent(kind: ProviderEventKind): boolean {
  return kind === 'succeeded' || kind === 'failed';
}

/** 簽章驗證失敗時拋這個 —— 未驗簽章的 webhook 端點等於讓任何人改你的 job 狀態。 */
export class WebhookSignatureError extends Error {
  constructor(message = 'webhook 簽章驗證失敗') {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}
