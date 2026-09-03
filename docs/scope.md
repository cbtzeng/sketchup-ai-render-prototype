# scope.md — 三段 Scope

面試作業的評分重點是「判斷力」與「誠實度」，不是功能數量。
所以 MVP 刻意做小，把時間留給**證明論點的評估實驗**——那才是這份作業真正的差異化。

---

## 0. 第 0 天：可行性尖刺（Spike，非 MVP 範圍但必須先做）

不寫任何產品程式，只在 Ruby Console 跑 `sketchup-api-feasibility.md` 第 7 節的七項驗證。
**產出**：一份填好的驗證結果。
**Gate**：fog 標定（3.7）若失敗，MVP 的 depth pass 換成 raytest GT-only 模式，範圍立刻調整。
時間盒：半天。做不完就代表方向要改，這本身就是結論。

---

## 1. MVP（必須完成，否則作業不成立）

### 1.1 Ruby 層
- 工具列按鈕 + `UI::HtmlDialog` 單一面板。
- 三 pass 擷取，**含 `ensure` 保證還原**，含還原正確性的驗證。
- 三張圖像素對齊（spec F1：棋盤格角點誤差 ≤ 1 px）。
- 上傳 → 建 job → `UI.start_timer` 退避輪詢 → 顯示結果。
- 錯誤以可讀訊息 + 診斷碼呈現，不靜默失敗。

### 1.2 雲端層
- 四個端點：`/uploads`、`/jobs` (POST/GET)、`/hooks/:provider`。
- **只接一家 provider**（依 Q6 的實測結果選定），adapter 介面留好但不實作第二家。
- 狀態機五個狀態即可：`created / queued / running / succeeded / failed`。
- 成本護欄先做三條：解析度上限、每日上限、冪等去重。

### 1.3 Supabase
- `jobs` + `job_events` + `assets` 三張表 + RLS。

### 1.4 評估（MVP 的重點，不可砍）
- 12 場景 × 3 相機 = 36 shots，條件 A / B / C 各 1 個 seed（共 108 張，先不做 3 seed）。
- 指標先做兩個：**Edge F-score** 與 **depth Spearman ρ**。
- 產出 `eval/report.md`，含配對 bootstrap CI 與 A/B/C 三聯圖。
- **包含 B 組（外部 Canny）**。少了 B 組，整份報告在面試官眼中沒有說服力，因為沒有排除「其實不用進 SketchUp 也做得到」。

### 1.5 文件
- `spec.md` / `architecture.md` / `sketchup-api-feasibility.md` / `eval/report.md`
- README 含「已知限制」章節，誠實列出沒做到的。

---

## 2. 加分（有時間才做，依價值排序）

| 優先 | 項目 | 為什麼有價值 |
|---|---|---|
| ★★★ | **材質/物件語意遮罩 pass** —— 用 SketchUp 的 material 與 group/component 資訊產生分色遮罩，餵給 segmentation 類控制或做區域重繪 | 這是**外部工具完全複製不了**的能力，比 edge/depth 更能證明「跑在 SketchUp 內部」的價值。見 critique.md 第 2 點 |
| ★★★ | 人類偏好 A/B 評估（spec H2 守門指標） | 防止「結構準但變醜」的假勝利 |
| ★★ | 兩家 provider 都接，實測 p50/p95 與成本並寫進報告 | 直接回答面試題的「比較成本與延遲」 |
| ★★ | 消失點角度誤差指標 | 建築客戶最有感的指標 |
| ★★ | 局部重繪（框選區域 + inpaint，控制圖同步裁切） | 真實工作流常見需求 |
| ★ | 3 個 seed × 36 shots 的完整跑批 | 提高統計穩健度 |
| ★ | 歷史紀錄存進 model attribute dictionary，跟著 .skp 走 | 產品感 |
| ★ | 「保真度」單一滑桿到多 controlnet 權重的映射曲線調校 | 產品感，且是 H2 失敗時的解方 |

---

## 3. 明確不做

| 項目 | 理由 |
|---|---|
| 自建 GPU 推論 / 自訓 LoRA | 超出時間盒，且不是這份作業要證明的事 |
| 影片 / walkthrough / 多幀時序一致性 | 完全不同的技術問題 |
| SketchUp Web 版支援 | 沒有 Ruby API，物理上不可能 |
| Windows + Mac × 多版本相容矩陣 | 只鎖一個實測過的版本，其他列為未驗證 |
| Extension Warehouse 上架、數位簽章流程 | 原型手動安裝即可 |
| 金流、訂閱、credit 系統 | 原型用固定額度 |
| 使用者帳號系統（註冊/登入/找回密碼） | 用 device id 或單一測試帳號，見 Q4 |
| 多語系 | 英文 UI |
| 材質庫 / 素材市集 | 不是這次的論點 |
| 離線模式 | 本質上需要雲端 GPU |
| 自動 prompt 改寫（LLM） | 會污染評估：prompt 必須鎖死才能做 A/B 比較 |
| 超過 1536 px 的高解析輸出、放大流程 | 成本與延遲不可控 |

**特別說明**：不做的項目中，「自動 prompt 改寫」是刻意排除的。
它看起來像加分項，但它會讓 A/B/C 三組的變因不再只有控制圖，
整個評估設計就失效了。原型階段寧可 UI 陽春，也要保住實驗的內部效度。
