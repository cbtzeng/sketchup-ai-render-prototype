# architecture.md — 模組拆解、狀態機、失敗與成本護欄

---

## 1. 分層原則

**Ruby 層只做四件事，其餘一律不做**：多 pass 擷取、上傳、輪詢、UI 橋接。
理由：SketchUp 的 Ruby 執行在主 UI 執行緒，任何重活都會凍結使用者的 SketchUp。
而且外掛更新要靠使用者重裝 RBZ，把邏輯放雲端才能熱修。

**判斷準則**：任何「未來可能要改」的東西（模型選擇、controlnet 權重映射、prompt 模板、
provider 路由、價格）都放雲端。Ruby 只送「意圖」不送「實作參數」。
Ruby 送的是 `{scene_id, prompt, preset: "exterior_dusk", fidelity: 0.7}`，
不是 `{model: "...", controlnet_scale: [0.8, 0.5]}`。

---

## 2. 模組拆解

### 2.1 Ruby 層（extension）

```
src/architech_render/
  main.rb                 # SketchupExtension 註冊、menu / toolbar
  capture/
    session.rb            # 擷取編排：snapshot → passes → restore（ensure 保證還原）
    view_state.rb         # camera / rendering_options / shadow_info 的 snapshot & restore
    pass_beauty.rb        # pass A
    pass_edge.rb          # pass B（hidden-line）
    pass_depth.rb         # pass C（fog）
    alignment.rb          # aspect ratio 鎖定、輸出尺寸決定
  net/
    http.rb               # Sketchup::Http::Request 薄封裝（或 net/http fallback）
    uploader.rb           # 取簽名 URL → PUT 圖檔
    api_client.rb         # create_job / get_job / cancel_job
    poller.rb             # UI.start_timer 驅動的退避輪詢
  jobs/
    local_index.rb        # model attribute dictionary 存 job id ↔ scene，供 reconcile
  ui/
    dialog.rb             # UI::HtmlDialog 建立與生命週期
    bridge.rb             # add_action_callback 路由（單一入口，JSON in/out）
  config.rb               # endpoint、版本、feature flag
  ui_assets/              # HtmlDialog 的 html/css/js（前端獨立，不混進 Ruby）
```

模組邊界檢查：
- `capture/` 完全不知道網路存在，輸出是三個本機檔案路徑 + metadata。
- `net/` 完全不知道 SketchUp 存在，輸入輸出都是純資料。
- `ui/bridge.rb` 是唯一連接前端與 Ruby 的縫，所有 callback 都走這裡，方便統一做錯誤包裝與日誌。
- `view_state.rb` 是最容易出事的模組（改了使用者的模型狀態），必須有獨立的還原測試。

### 2.2 雲端層（Vercel 或 Cloudflare Workers，見 open-questions Q5）

```
POST   /v1/uploads          → 回簽名上傳 URL（每個 pass 一個）
POST   /v1/jobs             → 建立 job（帶 idempotency key）
GET    /v1/jobs/:id         → 查狀態
POST   /v1/jobs/:id/cancel  → 取消
POST   /v1/hooks/:provider  → provider webhook（有簽章驗證）
GET    /v1/me/quota         → 額度與用量
```

內部模組：
- `preset_resolver`：把 `{preset, fidelity}` 展開成實際的 model id / controlnet 權重。**版本化**，每個 job 記錄用了哪個 preset 版本，否則評估結果無法重現。
- `provider_adapter`：`fal` / `replicate` 兩個實作，同一介面 `submit(payload) → provider_job_id` 與 `normalize(webhook) → JobEvent`。
- `cost_guard`：見第 5 節。
- `job_service`：狀態機唯一的寫入者。

### 2.3 Supabase

```
users(id, ...)                                        -- 或先用 device_id，見 Q4
jobs(id, user_id, model_guid, scene_name, status,
     preset, preset_version, prompt, seed, params_json,
     provider, provider_job_id, idempotency_key,
     cost_estimate_cents, cost_actual_cents,
     created_at, started_at, finished_at, error_code, error_msg)
job_events(id, job_id, from_status, to_status, at, detail_json)  -- append only，除錯與 SLA 分析靠這張
assets(id, job_id, kind, storage_path, width, height, sha256)    -- kind: beauty|edge|depth|result
usage_daily(user_id, day, jobs_count, cents_spent)               -- 成本護欄的計數來源
```

- `job_events` append-only：狀態機的除錯全靠它，不要只存當前 status。
- `assets.sha256`：控制圖去重與快取命中的依據。
- RLS：使用者只能讀自己的 row。Ruby 層拿的是短效 token，不是 service key。
- ⚠️ **RLS policy 目前全部綁 `auth.uid()`。** 若 open-questions Q4 最終改走 device_id 模式，
  四張表的 policy 都要重寫。這是尚未關閉的 schema 級相依。

---

## 3. Job 狀態機

```
                    ┌──────────────┐
                    │   created    │  ← POST /v1/jobs（雲端唯一入口）
                    └──────┬───────┘
                           │ 控制圖全部上傳完成且校驗通過
                           ▼
                    ┌──────────────┐
          ┌─────────│   queued     │
          │         └──────┬───────┘
          │                │ provider 接受
          │                ▼
          │         ┌──────────────┐
          │  ┌──────│   running    │──────┐
          │  │      └──────┬───────┘      │
          │  │             │ webhook 成功  │ 5xx / timeout
          │  │             ▼              ▼
          │  │      ┌──────────────┐  ┌──────────────┐
          │  │      │  succeeded   │  │  retrying    │──┐
          │  │      └──────────────┘  └──────┬───────┘  │ 重試 < 2
          │  │                               │ 重試耗盡  └──→ queued
          │  │ 使用者取消                      ▼
          │  ▼                         ┌──────────────┐
          │ ┌──────────────┐           │   failed     │
          └→│  cancelled   │           └──────────────┘
            └──────────────┘
                    ▲                  ┌──────────────┐
                    └──────────────────│   expired    │ ← 超過 hard timeout
                                       └──────────────┘
```

**終態**：`succeeded` / `failed` / `cancelled` / `expired`。終態不可再轉移。

**轉移規則**

> 2026-09-04 修訂：實作 `cloud/lib/job-service.ts` 時發現原表缺 4 條邊，
> 導致某些真實情境無路可走。已補齊並在下表標註。

| from | to | 觸發者 | 條件 |
|---|---|---|---|
| created | queued | 雲端 | 全部 asset 上傳完成、sha256 校驗通過、cost_guard 放行 |
| created | failed | 雲端 | **上傳逾時（5 min）**或校驗失敗 |
| created | cancelled | 使用者 | **（補）** 上傳階段就按取消。原表沒有這條，使用者只能乾等到 expired |
| queued | running | provider webhook / 輪詢 | — |
| queued | failed | 雲端 | **（補）** provider 在 submit 當下就回 4xx |
| queued | retrying | 雲端 | **（補）** provider 在 submit 當下就回 5xx / 逾時 |
| queued | cancelled | 使用者 | 同時對 provider 發 cancel（best-effort） |
| running | succeeded | webhook | 結果已落地 storage |
| running | failed | 雲端 | **（補）** provider 回 4xx。原表只有 running→retrying 且註明「4xx 一律不重試」，等於 4xx 無路可走，只能白等 10 分鐘變 expired |
| running | retrying | 雲端 | provider 5xx / 逾時 |
| running | cancelled | 使用者 | — |
| retrying | queued | 雲端 | 退避後（10s, 40s），最多 2 次 |
| retrying | failed | 雲端 | 重試次數用盡 |
| retrying | cancelled | 使用者 | **（補）** 退避中也要能取消，否則使用者最久要等 10 分鐘 |
| any non-terminal | expired | 定時清理 | created_at + 10 min |

**兩個 timeout 的關係（原文件自相矛盾，此處為準）**
- `created` 狀態的上傳逾時為 **5 分鐘** → 轉 `failed`（不是 expired）。
- 整體硬性逾時為 `created_at + 10 分鐘` → 轉 `expired`。
- 兩者不衝突：卡在上傳的 job 5 分鐘就會被判 failed，不會佔用到 10 分鐘。

**schema 需要而原 2.3 節沒寫的欄位**（實作時補上，已寫入 migration）
- `assets.upload_state` —— 原本只有 `sha256` 一欄，無法區分「還沒上傳」與
  「上傳了但雜湊不符」，但 `created → queued` 的條件正是「全部上傳完成且校驗通過」。
- `assets.sha256_declared` —— 用戶端宣告值，與伺服器實算值分開存才驗得起來。
- `jobs.retry_count`、`jobs.next_attempt_at` —— 轉移表要求「最多 2 次」與退避，
  但原 schema 沒有落地欄位。

**冪等性**

`idempotency_key = sha256(controls_sha256 + "\n" + canonical_json(params) + "\n" + user_id)`

兩個細節不能省，否則會出現難查的錯誤命中：
- **三段之間必須有分隔符。** 純串接時 `("ab", "", "c")` 與 `("a", "", "bc")` 會算出
  同一個 key —— 兩個不同請求互相命中對方的快取。
- **params 必須 canonical JSON（key 排序）。** 否則 `{a,b}` 與 `{b,a}` 永遠不會命中快取，
  去重形同虛設。

重複 POST 回同一個 job。Ruby 層的網路重試因此不會重複計費。
同一個 key 若已有 `succeeded` 的 job，直接回傳舊結果（= 快取命中，成本 0）。

**失敗後重送**：`jobs.idempotency_key` 的 unique index 為 **partial index，
只涵蓋 `created / queued / running / retrying / succeeded`**。
`failed / cancelled / expired` 的 job 不佔用 key，使用者用同樣參數重試不會撞 23505。
（原文件只定義了 succeeded 的情形，沒定義失敗後重送 —— 那會直接撞 unique 約束。）

**成本回填與 usage_daily 的關係**：`admit` 時以 `cost_estimate_cents` 預留額度；
webhook 回來寫入 `cost_actual_cents` 後，用差額 `(actual - estimate)` 修正
`usage_daily.cents_spent`。job 進入 `failed` / `cancelled` / `expired` 時，
把預留的估算值全額釋放。

**Ruby 端的狀態**：Ruby 只維護 `idle / capturing / uploading / tracking`。
job 的真實狀態一律以雲端為準，Ruby 不做本地推測。這樣 SketchUp 崩潰不會丟 job。

**輪詢策略**：`UI.start_timer` 每 2s → 5s → 10s 退避，上限 10 min。
若 provider 支援 webhook，雲端收到後更新 DB，Ruby 端輪詢只是讀 DB（便宜）。

---

## 4. 失敗設計

**分類與處置**
| 類別 | 例子 | 處置 | 是否計費 |
|---|---|---|---|
| 擷取失敗 | write_image 回 false、檔案 0 bytes、尺寸不符 | 本機中止，還原設定，不上傳 | 否 |
| 對齊失敗 | 三張圖尺寸不一致 | 本機中止並回報（這是 bug，不是使用者問題） | 否 |
| 網路暫時失敗 | DNS / 5xx / timeout | 退避重試 2 次 | 否 |
| 授權失敗 | token 過期 | 靜默換 token 後重試 1 次，失敗則要求重新登入 | 否 |
| 額度不足 | 超過每日上限 | 明確錯誤 + 剩餘額度顯示，不重試 | 否 |
| provider 拒絕 | 內容審查、參數非法 | 不重試，原文訊息回前端 | 依 provider 政策，記錄實際成本 |
| provider 掛掉 | 5xx / 逾時 | 重試 2 次；仍失敗則 failed 並記 incident | 記錄但標記為不應向使用者收費 |

**最重要的一條失敗規則**：`capture/session.rb` 的還原必須寫在 `ensure` 區塊裡。
擷取途中拋例外而沒還原 rendering_options，等於毀掉使用者的樣式設定 —— 這是會被一星負評的錯誤，
比出圖失敗嚴重得多。這一條需要專門的例外注入測試。

**觀測性**：每個 job 在 `job_events` 留下完整軌跡；Ruby 端錯誤帶一個短診斷碼（如 `CAP-03`）
顯示在 UI，使用者回報時可直接對照。

---

## 5. 成本護欄

**分層防禦，server 為權威（client 只做即時回饋，不可信）**

1. **事前估算**：按下 Render 前面板就顯示「約 $0.0x / 約 40s」。估算來自雲端的 preset 定價表，不是硬編在 Ruby。
2. **解析度上限**：原型鎖 1024×1024（單邊上限 1536）。高解析放 Non-goals。
3. **並發上限**：每使用者同時 1 個 running job。第二個請求回 409 並提示。
4. **每日上限**：預設 30 jobs / day 或 $2 / day，先達者為準，由 `usage_daily` 判定，寫入用 atomic upsert 避免 race。
5. **硬性逾時**：job 超過 10 分鐘 → `expired`，並對 provider 發 cancel。
6. **重試上限**：最多 2 次，且只對 5xx/timeout。4xx 不重試（避免對著會失敗的請求反覆燒錢）。
7. **去重快取**：`idempotency_key` 命中已成功 job → 直接回舊結果，成本 0。使用者連按兩次 Render 不會被收兩次。
8. **熔斷**：provider 錯誤率在 5 分鐘視窗 > 50% → 停止送新 job 60 秒，前端顯示「服務暫時不穩」。
9. **成本回填**：webhook 回來時把 provider 實際計費寫入 `cost_actual_cents`，與 `cost_estimate_cents` 的偏差 > 20% 要告警 —— 估算失準本身就是需要修的 bug。
10. **金鑰**：provider key 只存在雲端環境變數，永遠不進 Ruby、不進 HtmlDialog、不進日誌。若採 BYO key 模式，見 open-questions Q4，這會改變整個信任模型。

---

## 6. Provider 比較（需實測，見 open-questions Q6）

| 面向 | fal.ai | Replicate |
|---|---|---|
| 延遲 | 一般較低，主打即時推論 | 冷啟動可能數十秒 |
| 多 ControlNet | 部分端點支援 controlnet 陣列 | 多見於社群模型，介面不統一 |
| 計費 | 依端點，常見為每次/每 megapixel | 多為 GPU 秒數計費 |
| Webhook | 支援 | 支援 |
| 風險 | 端點與參數變動較快 | 冷啟動導致 p95 不可控 |

**決定（open-questions Q6）：MVP 只接 fal.ai 一家。**
理由：延遲較低，符合外掛「按下去要有反應」的互動體感；兩天的時間盒不允許同時接兩家。

因此上表要分成兩半，報告中必須分開陳述，不可混為一談：
- **fal.ai 那一欄**：以 36 張評估跑批的實測 p50/p95 與實際計費回填。
- **Replicate 那一欄**：標明為「依定價頁與官方文件調查，未實測」。

`provider_adapter` 介面照樣先切出來（`submit` / `normalize` 兩個方法），
但只實作 fal 一個。接第二家列為加分項。假裝測過兩家比誠實承認只測一家更糟。
