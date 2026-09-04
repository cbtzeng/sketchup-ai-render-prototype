/**
 * storage.ts —— 物件儲存的抽象介面（簽名上傳 URL、雜湊校驗、簽名下載 URL）。
 *
 * ⚠️ 本檔**刻意不含任何 Supabase Storage 的實際 SDK 呼叫、參數名或回應格式。**
 * 下列各項在 `lib/storage-supabase.ts` 落地並實測之前一律為 🔴 未驗證：
 *
 *   🔴 建立簽名上傳 URL 的方法名與參數
 *      （`createSignedUploadUrl(path)`? 是否可指定 TTL？是否可鎖 content-type？）
 *   🔴 上傳時該用 PUT 還是 POST，以及是否需要額外的 token header。
 *      Ruby 端 `net/uploader.rb` 目前寫死 `PUT` + `Content-Type: image/png`。
 *   🔴 **上傳回應是否含 sha256。** uploader.rb 要求回應的 JSON body 帶 `sha256`／`digest`
 *      或 header 帶 `X-Content-Sha256`，「沒回就視為失敗」。Supabase Storage 幾乎確定
 *      不會回這個欄位 —— 這是 Ruby 端與雲端之間**目前已知的介面衝突**，需要主 session 決策，
 *      三個候選解見 docs 回報。本檔的設計是「伺服器端在建 job 時自己重算雜湊」（見 statObject）。
 *   🔴 是否有伺服器端可直接取得的物件雜湊（免下載），例如 metadata 上的 checksum。
 *      沒有的話 statObject 就得把物件抓下來重算，成本與延遲都要重新評估。
 *   🔴 簽名下載 URL 的 TTL 上限，以及能否給 provider 直接讀取。
 *
 * 測試一律用本檔的 `InMemoryStorage`，不連任何外部服務。
 */
import { createHash } from 'node:crypto';
import type { AssetKind } from './db.js';

export interface SignedUploadUrl {
  /** 用戶端 PUT 的目標。 */
  url: string;
  /** 物件在 bucket 內的路徑，之後建 job 時用來定位。 */
  path: string;
  expiresAt: string;
}

export interface ObjectStat {
  path: string;
  bytes: number;
  /** 伺服器端實算的 sha256（權威值）。 */
  sha256: string;
}

export interface StorageAdapter {
  createSignedUploadUrl(input: {
    path: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<SignedUploadUrl>;

  /**
   * 取得物件的大小與 sha256。物件不存在回 null。
   * 這是 `created → queued` 條件裡「sha256 校驗通過」的權威來源 ——
   * 用戶端宣告的雜湊只是待比對值，不可信。
   */
  statObject(path: string): Promise<ObjectStat | null>;

  /** 簽名下載 URL（給 provider 讀控制圖、給 Ruby 端下載結果圖）。 */
  createSignedDownloadUrl(path: string, expiresInSeconds: number): Promise<string>;
}

/** 控制圖的物件路徑。批次 id 隔離不同次擷取，避免併發互相覆寫。 */
export function controlObjectPath(userId: string, batchId: string, kind: AssetKind): string {
  return `controls/${userId}/${batchId}/${kind}.png`;
}

/**
 * in-memory 假實作。只給測試與本機開發用。
 * `putObject` 模擬用戶端把 bytes 上傳到簽名 URL。
 */
export class InMemoryStorage implements StorageAdapter {
  readonly objects = new Map<string, Buffer>();
  readonly signedUploads: SignedUploadUrl[] = [];
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async createSignedUploadUrl(input: {
    path: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<SignedUploadUrl> {
    const signed: SignedUploadUrl = {
      url: `memory://upload/${input.path}?ct=${encodeURIComponent(input.contentType)}`,
      path: input.path,
      expiresAt: new Date(this.now().getTime() + input.expiresInSeconds * 1000).toISOString(),
    };
    this.signedUploads.push(signed);
    return signed;
  }

  async statObject(path: string): Promise<ObjectStat | null> {
    const buf = this.objects.get(path);
    if (!buf) return null;
    return { path, bytes: buf.byteLength, sha256: createHash('sha256').update(buf).digest('hex') };
  }

  async createSignedDownloadUrl(path: string, expiresInSeconds: number): Promise<string> {
    return `memory://download/${path}?ttl=${expiresInSeconds}`;
  }

  /** 測試輔助：模擬用戶端完成上傳。 */
  putObject(path: string, bytes: Buffer | string): void {
    this.objects.set(path, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'));
  }
}
