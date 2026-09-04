# 開始測試需要做的事

這是**唯一**一份你需要看的操作清單。分三階段，前一階段沒過就不要進下一階段。

環境已確認：SketchUp 2026（26.2.242）、Ruby 3.2.2、macOS 15.7.1。

## 先搞清楚：指令要貼在哪

這份文件有兩種指令，貼錯地方會直接報錯。每個程式碼區塊上方都會標。

| 標記 | 在哪裡 | 長怎樣 |
|---|---|---|
| **【終端機】** | macOS 的 **Terminal.app** | `./tools/...`、`python3 ...`、`git ...` |
| **【Ruby Console】** | SketchUp 裡 **Extensions → Developer → Ruby Console** | `load '...'`、`Sketchup.active_model...` |

判斷方式：**以 `load` 開頭的是 Ruby，其餘都是終端機。**
把 shell 指令貼進 Ruby Console 會得到 `SyntaxError`；
把 Ruby 貼進終端機會得到 `command not found`。兩種都不會弄壞任何東西。

---

## 階段 0 — 現在就能做，不需要任何帳號（約 20 分鐘）

這一階段會把可行性清單上剩下的 🔴 全部關掉。**這是關鍵路徑**，
因為 [B] 節的結果會決定網路層要走哪條路，而那會改變程式碼。

### 0-1. 安裝外掛（一次性）

**【終端機】**（不是 Ruby Console）

```bash
cd /Users/benson/sketch-up-202609
./tools/install_dev.sh
```

用符號連結，之後改程式碼不用重裝。裝完**重新啟動 SketchUp**。

⚠️ 若 SketchUp 的載入政策設為「僅載入已識別的擴充功能」，未簽章的外掛會被擋。
原型階段請改成允許所有擴充功能：**SketchUp → Settings → Extensions → Loading Policy**。

成功的話選單會出現 **Extensions → Architech Render**。

### 0-2. 跑模組測試

**【Ruby Console】** —— 位置在 **Extensions → Developer → Ruby Console**。

> **開一個新的空白模型再跑。** 這些腳本會暫時改動顯示設定（跑完自動還原）。

```ruby
load '/Users/benson/sketch-up-202609/test/run_tests_staged.rb'
```

預期：全部通過，總耗時約 0.3 秒。
最重要的一項是 `block 拋例外時仍還原` —— 那個掛了整個模組不能用。

### 0-3. 網路尖刺（需要先開 echo server）

**【終端機】** —— 另開一個視窗，讓它一直跑著（不要關）：

```bash
python3 /Users/benson/sketch-up-202609/tools/spike/echo_server.py
```

只聽 `127.0.0.1`，測試資料不會離開你的機器。看到 `echo server 聽在 http://127.0.0.1:8787` 就是好了。

**【Ruby Console】** —— 回到 SketchUp：

```ruby
load '/Users/benson/sketch-up-202609/tools/spike/probe_net.rb'
```

**判讀重點**（照這個順序看）：

| 節 | 看什麼 | 意義 |
|---|---|---|
| **[B]** | echo server 回報的 `first_8_bytes_hex` 是不是 `89504e470d0a1a0a` | PNG 的 magic number。**不是的話代表二進位被破壞了** —— 伺服器一樣會回 200，只看狀態碼看不出來。若破壞，`config.rb` 的 `HTTP_BACKEND` 要改成 `:net_http`，而且我得先解決它同步阻塞主執行緒的問題 |
| [C] | 不指定 `ca_file` 是否如預期失敗、指定 SketchUp 自帶的 `cacert.pem` 是否成功 | 決定 `net/http` 退路能不能用 |
| [D] | 哪些 `EdgeColorMode` 值會讓線變紅 | 若邊線顏色不可控，edge pass 會產出彩色線稿 |
| [E] | 32×32 raytest 是否 < 200 ms | 決定 journal 006 的 fog 範圍缺陷能不能修 |

[C] 節會對 `https://example.com` 發一次 HEAD 驗證憑證鏈，這是唯一的對外連線。

### 0-4. 面板酬載尖刺（單獨跑，會開視窗）

**【Ruby Console】**

```ruby
load '/Users/benson/sketch-up-202609/tools/spike/probe_dialog.rb'
```

1 KB 逐級加到 8 MB，雙向都測，跑完自動關閉。有 8 秒 watchdog。

**判讀**：1024² 的 PNG 轉 base64 約 1–2 MB。兩個方向都撐過 2,000,000 字元的話，
預覽圖可以走 base64；撐不過的話面板得改用 `file://` 路徑（目前的預設就是後者，
所以撐不過也不會壞，只是少一個備案）。

### 0-5. 把結果回填

跑完把 Console 輸出貼給我。我會：
- 更新 `docs/sketchup-api-feasibility.md` 的信心標記
- 依 [B] 的結果決定 `HTTP_BACKEND`
- 依 [D] 的結果修 edge pass
- 依 [E] 的結果決定要不要修 journal 006 的 fog 範圍

---

## 階段 1 — 需要帳號與金鑰（無法在沒有這些的情況下往下）

### 1-1. Supabase

1. 建一個專案（在 supabase.com 的網頁介面）。
2. 跑 `cloud/supabase/migrations/001_init.sql`（貼進 Supabase 的 SQL Editor）。
3. 記下 project URL 與 service role key。

> ⚠️ 已知缺口：`001_init.sql` **沒有 `upload_batches` 表**，需要補一個 migration。
> 見 journal 007。這件事我可以先做，不用等你。

### 1-2. fal.ai

1. 註冊並取得 API key。
2. **查文件填五項未知**（`eval/providers/fal.py` 檔頭有列）：
   端點路徑、多 ControlNet 的參數結構、回應格式、webhook schema 與簽章方式、計費單位。

   這五項我刻意沒有猜。填進 `eval/config.json` 的 `model` 區段後我才能實作 adapter。

3. 建議先只跑 **1 個 shot** 確認實際計費金額，再開全量。
   `eval/config.json` 的 `budget.max_usd_total = 10` 是最後一道保險。

### 1-3. Vercel

1. 部署 `cloud/`。
2. 環境變數放 Supabase 與 fal.ai 的金鑰。**金鑰只存在這一層**，Ruby 端永遠不該碰到。
3. 把部署後的網址填進 `src/architech_render/config.rb` 的 `API_BASE_URL`。

---

## 階段 2 — 需要你建內容（評估報告的原料）

### 2-1. 六個評估場景

存進 `eval/scenes/`，每個場景兩個具名 Scene（兩個相機角度）。

| # | 類型 | 為什麼要這個 |
|---|---|---|
| 1 | 外觀・直角量體 | 基準情境 |
| 2 | 外觀・曲面 | 曲面最容易被生成模型「拉直」 |
| 3 | 外觀・大面積玻璃 | 反射會誤導單目深度估計 |
| 4 | 內裝・密集開口 | 測開口數量幻覺 |
| 5 | 內裝・細長構件（欄杆／百葉） | 細線最容易糊掉 |
| 6 | 內裝・複雜家具 | 高頻細節 |

**不要六個都是方盒子。** 那樣純 img2img 也不會出錯，測不出差異 ——
整份評估報告會得出「沒有顯著差異」的空結論。

---

## 你不用做的事

- 不用寫任何程式碼
- 不用手動建臨時模型（腳本會自己建並用 `abort_operation` 回滾）
- 不用擔心設定被改壞（`ensure` 保證還原；真的出事跑 `tools/spike/restore_snapshot.rb`）

---

## 目前的阻塞關係

```
階段 0 ─┬─→ [B] 結果決定 HTTP_BACKEND ──→ 網路層可能要改寫
        ├─→ [D] 結果決定 edge pass 是否要改
        └─→ [E] 結果決定 fog 範圍缺陷要不要修

階段 1 ─┬─→ Supabase ──┐
        ├─→ fal.ai 五項未知 ──→ 我才能實作 adapter ──┐
        └─→ Vercel ────┘                             ├─→ 端到端可跑
                                                      │
階段 2 ─→ 六個場景 ───────────────────────────────────┘
                                                      └─→ 評估報告
```

**階段 0 完全不依賴階段 1 和 2。** 先做那個。
