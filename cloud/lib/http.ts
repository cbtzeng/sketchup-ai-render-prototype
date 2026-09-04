/**
 * http.ts —— API 層共用的請求／回應形狀、錯誤格式與輸入驗證。
 *
 * 為什麼不直接用 Vercel 或 Workers 的原生型別：
 * open-questions Q5（Vercel vs Cloudflare Workers）尚未關閉。
 * 端點只依賴這裡定義的中性 `ApiRequest` / `ApiResponse`，
 * 平台綁定集中在檔尾的 `toFetchHandler`，換平台時只改那一個函式。
 *
 * 錯誤格式刻意與 Ruby 端 `Net::Errors::Base#to_h` 對齊：
 *   { ok: false, code: 'JOB-20', message: '...', detail: {...} }
 * 這樣面板上顯示的診斷碼，雲端與 Ruby 端是同一套語彙。
 */

// ---------------------------------------------------------------------------
// 請求 / 回應
// ---------------------------------------------------------------------------

export interface ApiRequest {
  method: string;
  /** 路徑（不含 query string），例如 `/v1/jobs/abc`。 */
  path: string;
  query: Readonly<Record<string, string>>;
  /** header 名一律小寫。 */
  headers: Readonly<Record<string, string>>;
  /**
   * 原始 body 字串。
   * webhook 的簽章**必須**對這個未經 JSON 重新序列化的值驗證 ——
   * `JSON.stringify(JSON.parse(body))` 會改變空白與 key 順序，簽章立刻對不上。
   */
  rawBody: string;
  /** 路由參數，例如 `{ id: 'job_1' }`、`{ provider: 'fal' }`。 */
  params: Readonly<Record<string, string>>;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body };
}

// ---------------------------------------------------------------------------
// 錯誤
// ---------------------------------------------------------------------------

/**
 * 帶診斷碼的 API 錯誤。
 * 碼一旦發布就不要改動含義（同 Ruby 端 errors.rb 的規則）。
 */
export class ApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly detail: unknown;

  constructor(code: string, httpStatus: number, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }

  toBody(): Record<string, unknown> {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }
}

export function errorResponse(err: ApiError): ApiResponse {
  return json(err.httpStatus, err.toBody());
}

/**
 * 統一的執行外殼：把 ApiError 轉成回應，其餘例外一律 500。
 * **不要**把未知例外的 message 直接回給用戶端 —— 那是洩漏內部細節的常見管道。
 */
export async function runHandler(
  handler: () => Promise<ApiResponse>,
  onUnexpected?: (err: unknown) => void,
): Promise<ApiResponse> {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof ApiError) return errorResponse(err);
    onUnexpected?.(err);
    return errorResponse(new ApiError('SRV-50', 500, '伺服器內部錯誤'));
  }
}

// ---------------------------------------------------------------------------
// 通用驗證
// ---------------------------------------------------------------------------

/** 405：方法不符。回應必須帶 Allow header，否則用戶端無從得知正確方法。 */
export function requireMethod(req: ApiRequest, method: string, code: string): void {
  if (req.method.toUpperCase() !== method) {
    throw new ApiError(code, 405, `只接受 ${method}`, { got: req.method, allow: method });
  }
}

/** 解析 JSON body。空 body 視為 `{}`（cancel 端點送的就是 `{}`）。 */
export function parseJsonBody(req: ApiRequest, code: string): Record<string, unknown> {
  const raw = req.rawBody.trim();
  if (raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(code, 400, 'body 不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(code, 400, 'body 必須是 JSON 物件');
  }
  return parsed as Record<string, unknown>;
}

export function requireString(
  obj: Record<string, unknown>,
  field: string,
  code: string,
  opts: { maxLength?: number; allowEmpty?: boolean } = {},
): string {
  const v = obj[field];
  if (typeof v !== 'string') {
    throw new ApiError(code, 400, `${field} 必須是字串`, { field, got: typeName(v) });
  }
  if (!opts.allowEmpty && v.trim() === '') {
    throw new ApiError(code, 400, `${field} 不可為空`, { field });
  }
  const max = opts.maxLength ?? 4000;
  if (v.length > max) {
    throw new ApiError(code, 400, `${field} 超過長度上限 ${max}`, { field, length: v.length, max });
  }
  return v;
}

export function optionalString(
  obj: Record<string, unknown>,
  field: string,
  code: string,
  opts: { maxLength?: number } = {},
): string | null {
  const v = obj[field];
  if (v === undefined || v === null) return null;
  return requireString(obj, field, code, { ...opts, allowEmpty: true });
}

export function requireNumber(
  obj: Record<string, unknown>,
  field: string,
  code: string,
  range: { min: number; max: number },
): number {
  const v = obj[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ApiError(code, 400, `${field} 必須是數字`, { field, got: typeName(v) });
  }
  if (v < range.min || v > range.max) {
    throw new ApiError(code, 400, `${field} 必須介於 ${range.min} 與 ${range.max} 之間`, { field, value: v });
  }
  return v;
}

export function requireInt(obj: Record<string, unknown>, field: string, code: string): number {
  const v = obj[field];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new ApiError(code, 400, `${field} 必須是整數`, { field, got: typeName(v) });
  }
  return v;
}

export function requireObject(
  obj: Record<string, unknown>,
  field: string,
  code: string,
): Record<string, unknown> {
  const v = obj[field];
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new ApiError(code, 400, `${field} 必須是 JSON 物件`, { field, got: typeName(v) });
  }
  return v as Record<string, unknown>;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/** sha256 一律小寫十六進位 64 字元（與 migration 的 CHECK 約束同一條規則）。 */
export function isSha256Hex(v: unknown): v is string {
  return typeof v === 'string' && SHA256_RE.test(v);
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// ---------------------------------------------------------------------------
// 平台綁定（唯一一處）
// ---------------------------------------------------------------------------

/** 把 Fetch API 的 Request 轉成中性的 ApiRequest。 */
export async function fromFetchRequest(
  request: { method: string; url: string; headers: { forEach(cb: (v: string, k: string) => void): void }; text(): Promise<string> },
  params: Record<string, string> = {},
): Promise<ApiRequest> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  const rawBody = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  return { method: request.method, path: url.pathname, query, headers, rawBody, params };
}
