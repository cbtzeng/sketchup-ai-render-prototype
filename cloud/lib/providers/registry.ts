/**
 * providers/registry.ts —— provider 名稱 → { adapter, verifier } 的登錄表。
 *
 * 為什麼簽章驗證**不放進 ProviderAdapter**：`types.ts` 明文規定 adapter
 * 只能有 `submit` / `normalize` 兩個方法（`PROVIDER_ADAPTER_METHODS` 有契約測試在守）。
 * 驗簽章是同一個 provider 的知識、但不是狀態機的知識，因此獨立成 `WebhookVerifier`，
 * 與 adapter 並列註冊。webhook 端點只認這個介面，不認任何 provider 名字。
 *
 * ⚠️ 本檔**不含任何真實 provider 的簽章演算法或 header 名稱**。
 * 🔴 fal.ai webhook 簽章的 header 名稱（是 `X-Fal-Signature`？`Webhook-Signature`？）
 * 🔴 簽章的計算材料（raw body？timestamp + body？其他前綴？）
 * 🔴 演算法（HMAC-SHA256？Ed25519 公鑰驗章？）與金鑰的取得方式
 * 🔴 是否有 timestamp 防重放欄位、容許的時間窗
 * 🔴 provider 對非 2xx 回應的重送策略（決定我們該回 200 還是 5xx）
 *
 * 在這些項目實測之前，正式環境**不得**註冊 `alwaysRejectVerifier` 以外的東西 ——
 * 未驗簽章的 webhook 端點等於讓任何人改別人的 job 狀態並偽造帳單。
 */
import type { ProviderAdapter, ProviderWebhookInput } from './types.js';
import { WebhookSignatureError } from './types.js';

export interface WebhookVerifier {
  /**
   * 驗證簽章。通過回 true；不通過回 false 或拋 `WebhookSignatureError`。
   * 實作必須對 `input.rawBody` 原始字串驗，不可先 JSON.parse 再重新序列化。
   */
  verify(input: ProviderWebhookInput): Promise<boolean> | boolean;
}

export interface ProviderRegistration {
  adapter: ProviderAdapter;
  verifier: WebhookVerifier;
}

/**
 * 預設的驗證器：一律拒絕。
 * 這是刻意的 fail-closed 預設 —— 忘了接上真正的驗證器時，
 * 結果是 webhook 全部被擋（可觀測、可修），而不是全部被放行（悄悄被人偽造）。
 */
export const alwaysRejectVerifier: WebhookVerifier = {
  verify() {
    throw new WebhookSignatureError('尚未接上真實的簽章驗證器（🔴 演算法與 header 名稱未驗證）');
  },
};

export class ProviderRegistry {
  private readonly entries = new Map<string, ProviderRegistration>();

  register(name: string, registration: ProviderRegistration): this {
    this.entries.set(name, registration);
    return this;
  }

  get(name: string): ProviderRegistration | null {
    return this.entries.get(name) ?? null;
  }

  names(): string[] {
    return [...this.entries.keys()];
  }
}
