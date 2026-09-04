# Vercel 部署步驟

> ⚠️ **先讀這段再決定要不要做。**
>
> 雲端層目前**部署上去不會運作**，而且不是「不完整」而是結構上不可能：
>
> - `JobStore` 只有 `InMemoryJobStore`，沒有 Supabase 實作
> - **Vercel Function 是無狀態的** —— 記憶體實作在兩次呼叫之間就消失
> - auth 是 `unconfiguredAuth`，一律回 `501 CFG-02`
> - storage 是 `InMemoryStorage`，簽名 URL 是假的
>
> 要能動，得先寫三個 adapter（見最後一節），約 1–2 小時實作加除錯。
>
> **如果你的時間有限，先不要做這一步。** 評估報告走本機生成，不需要雲端。
> 雲端層已經是「設計完整、215 個測試通過」的元件，對 repo + 文件型的交付物
> 而言那本身就展示得出來；部署一個空殼不會加分。

---

## 前置：先寫完三個 adapter

| 檔案 | 取代什麼 | 要解決的 🔴 |
|---|---|---|
| `cloud/lib/db-supabase.ts` | `InMemoryJobStore` | 無（介面已定義清楚） |
| `cloud/lib/storage-supabase.ts` | `InMemoryStorage` | 簽名上傳 URL 的建法、TTL、能否鎖 content-type |
| `cloud/lib/auth-supabase.ts` | `unconfiguredAuth` | Supabase JWT 的驗章方式 |

沒有這三個，下面的步驟做完只會得到一堆 501。

---

## 1. 建專案

**【Vercel 網頁】** vercel.com → Add New → Project → Import Git Repository
→ 選 `cbtzeng/sketchup-ai-render-prototype`

## 2. 建置設定

| 欄位 | 值 | 為什麼 |
|---|---|---|
| Framework Preset | **Other** | 這不是 Next.js，只有 Vercel Functions |
| **Root Directory** | **`cloud`** | 端點在 `cloud/api/`，Vercel 以 root 底下的 `api/` 為約定。**這一項填錯就整個部署不到** |
| Build Command | 留空 | 沒有 build step，Functions 直接跑 TypeScript |
| Output Directory | 留空 | 同上 |
| Install Command | 預設 | |
| Node.js Version | 20.x | 與本機開發一致 |

## 3. 環境變數

**【Vercel 網頁】** Settings → Environment Variables。三個環境（Production /
Preview / Development）都要設，或至少設 Production。

```
SUPABASE_URL              https://fkplaizbxefpxqxtewgh.supabase.co
SUPABASE_SERVICE_ROLE_KEY <從 Supabase Settings → API 複製>
INTERNAL_SWEEP_SECRET     <自己產一個亂數，例如 openssl rand -hex 32>
```

**這些值不要貼進對話、不要進 repo。** 這是它們唯一該存在的地方。

`INTERNAL_SWEEP_SECRET` 是給 `POST /v1/internal/sweep` 用的 ——
沒設的話那個端點會 fail-closed 回 503，這是刻意的：
任何人都能觸發的掃描端點等於讓外人操控別人的 job 狀態。

`FAL_KEY` 目前不需要（我們走本機生成）。

## 4. 部署後驗證

```bash
curl -i https://<你的專案>.vercel.app/v1/jobs/00000000-0000-0000-0000-000000000000
```

在三個 adapter 寫好之前，預期會拿到 `501 CFG-02`。
**拿到 501 代表端點確實有部署到、路由也對**，只是還沒接上真實的後端 ——
這其實是這個階段唯一有意義的驗證。

## 5. 定期掃描（等 adapter 完成後再設）

`retrying` 的 job 需要有東西定期把它們推回 `queued`，否則會卡到逾時。

**【Vercel 網頁】** Settings → Cron Jobs：

```
Path      /v1/internal/sweep
Schedule  */1 * * * *
```

Vercel Cron 不會自動帶自訂 header，所以密鑰要另外處理 ——
這一項在 `sweep.ts` 裡標著 🔴，接線時要一起解決。

## 6. 部署後回填

把部署網址填進 `src/architech_render/config.rb` 的 `API_BASE_URL`：

```ruby
API_BASE_URL = 'https://<你的專案>.vercel.app/v1'
```
