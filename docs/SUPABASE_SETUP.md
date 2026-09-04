# Supabase 設定步驟

專案：`sketchup-ai-render-prototype`
Project URL：`https://fkplaizbxefpxqxtewgh.supabase.co`

---

## 1. 跑 migration

**【Supabase 網頁】** SQL Editor → New query，**依序**貼上並執行這兩個檔案的內容：

| 順序 | 檔案 | 內容 |
|---|---|---|
| 1 | `cloud/supabase/migrations/001_init.sql` | jobs / job_events / assets / usage_daily + RLS + `reserve_daily_quota()` |
| 2 | `cloud/supabase/migrations/002_upload_batches.sql` | upload_batches（001 遺漏的） |
| 3 | `cloud/supabase/migrations/003_retry_index.sql` | 退避重送排程器要用的部分索引 |

**順序不能反** —— 002 的 `claimed_by` 有外鍵指向 001 建的 `jobs` 表，
003 的索引建在 001 建的 `jobs` 表上。

兩份都已在本機的拋棄式 postgres 17 容器上實測套用成功，並跑過行為驗證
（unique 約束、job_events 的 append-only 觸發器、RLS 隔離、每日額度的併發正確性）。

### 成功長怎樣

執行後應該看到 `Success. No rows returned`。到 **Table Editor** 確認出現五張表：
`jobs`、`job_events`、`assets`、`usage_daily`、`upload_batches`。

三份都已在本機 postgres 17 容器實測依序套用成功。

### 如果出錯

把完整錯誤訊息貼給我。**不要自己改 SQL 再試** —— migration 是版控的一部分，
你在網頁上改了，repo 裡的版本就跟資料庫對不上了，之後沒人知道實際 schema 是什麼。

---

## 2. 建一個測試使用者

RLS policy 綁 `auth.uid()`，所以需要一個真的 auth 使用者才能測。

**【Supabase 網頁】** Authentication → Users → Add user → Create new user
（email + password 隨便填，這是原型的測試帳號）。

---

## 3. 你要給我的（都不是機密）

```
Project ref     fkplaizbxefpxqxtewgh   ← 已從你給的 URL 得知
測試使用者的 UUID  （Authentication → Users 那一列的 UID）
五張表都建好了嗎   （是/否）
```

測試使用者的 UUID 我需要拿來寫測試資料與範例，它不是機密。

---

## 4. 你**不要**給我的

| 東西 | 為什麼 |
|---|---|
| **`service_role` key** | 它可以繞過所有 RLS、讀寫任何資料。貼進對話就會留在紀錄裡 |
| `anon` key | 我用不到。要用也是填進 Vercel |
| 資料庫密碼 | 同上 |

**這些金鑰只該出現在一個地方：Vercel 的環境變數。**
`docs/architecture.md` 第 5 節第 10 條寫的就是這件事 ——
provider 與資料庫的金鑰永遠不進 Ruby 端、不進 repo、不進日誌。

到了 Vercel 那一步，你會在 Vercel 的網頁介面自己填：

```
SUPABASE_URL=https://fkplaizbxefpxqxtewgh.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<從 Supabase Settings → API 複製>
```

我不需要看到它們的值，也不該看到。

---

## 5. Storage（下一步，先不用做）

`POST /v1/uploads` 需要一個 bucket 來放控制圖。等 migration 確認沒問題再處理，
因為簽名 URL 的建立方式目前在雲端程式碼裡標著 🔴 未驗證
（`cloud/lib/storage.ts` 的 `StorageAdapter` 介面），
我要先確認 Supabase Storage 的實際 API 才能接。

---

## 已知的未決項

`001_init.sql` 的 `jobs.user_id` 綁 `auth.users(id)`，所有 RLS policy 也綁 `auth.uid()`。
若之後改走 device_id 模式（open-questions Q4 的另一個分支），
五張表的 policy 都要重寫。原型階段用 auth 帳號是對的選擇，這裡只是記錄相依。
