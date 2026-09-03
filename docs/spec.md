# spec.md — SketchUp 多重控制圖 AI 渲染外掛

狀態：規劃草案 v0.1（2026-09-03）
定位：Architech AI 面試作業原型。目標不是做出可上架商品，而是證明「外掛跑在 SketchUp 內部 → 能拿到 3D 資訊 → 結構保真度可量測地更好」這個論點。

---

## 1. 產品論點與可否證的主張

**論點**：市面上多數 AI 渲染外掛只送一張 viewport 截圖給 img2img，模型必須自己猜結構，導致牆面歪斜、開口數量改變、透視線跑掉。外掛在 SketchUp 內部，可以主動改變 rendering options 產生多張幾何對齊的控制圖，一起餵給 ControlNet。

**可否證主張（H1）**：在同一組場景、同一 prompt、同一 seed、同一底模的條件下，
多重控制（beauty + hidden-line edge + fog depth）相對於純 img2img，
**Edge F-score 提升 ≥ 0.10（絕對值）**，且 **depth Spearman ρ 提升 ≥ 0.05**，
配對 bootstrap 的 95% CI 不包含 0。

**同時必須成立的守門條件（H2）**：多重控制的人類偏好勝率不得顯著低於純 img2img
（雙盲 A/B，勝率 95% CI 下界 ≥ 0.40）。
如果結構變準但畫面變醜／變成「3D render 加濾鏡」，這個論點在產品上是失敗的。

H1 成立而 H2 不成立，結論就是「多重控制需要可調權重，而不是預設全開」。這也是一個有價值的交付結論。

---

## 2. 使用者流程

### 2.1 主線（Happy path）

1. 使用者在 SketchUp 中把鏡頭調到想要的角度。
2. 點工具列圖示 → 開啟 HtmlDialog 面板。
3. 面板顯示：prompt 輸入、風格 preset（外觀/內裝/夜景…）、控制強度滑桿（單一「保真度」滑桿，內部映射到多個 ControlNet 權重）、解析度、預估成本與預估時間。
4. 按「Render」。
5. 外掛在背景做多 pass 擷取（見 2.2），期間面板顯示 `Capturing 1/3`，SketchUp 視窗會短暫閃動（已知副作用，需在 UI 上預告）。
6. 上傳控制圖 → 建立 job → 面板進入輪詢狀態，顯示 queue position / elapsed。
7. 完成 → 面板顯示結果圖 + 「與原視圖對比」滑桿 + 下載 / 複製 / 重跑（換 seed）。
8. 歷史紀錄分頁列出這個 model 過去的 render（縮圖 + 參數 + 可重跑）。

### 2.2 多 pass 擷取序列（單次 Render 內）

```
snapshot 目前 rendering_options / camera / shadow_info / style
  ├─ pass A: beauty      — 使用者當前樣式，textured + shadows
  ├─ pass B: hidden-line — RenderMode 切換、關 texture、關 shadow、白底黑線
  └─ pass C: fog depth   — monochrome、白面、開 fog、fog 色黑、關邊線
restore 全部設定（必須保證還原，即使中途例外）
```

三張圖必須**像素對齊**：同一 camera、同一 aspect ratio、同一輸出尺寸。這是整個論點的地基；對不齊則 ControlNet 條件互相打架，結果會比純 img2img 更差。

### 2.3 錯誤流程

- 擷取失敗（write_image 回 false / 檔案不存在）→ 立即中止，還原設定，面板顯示「擷取失敗」+ 診斷碼，不上傳、不計費。
- 上傳失敗 → 最多重試 2 次（指數退避），仍失敗則 job 標記 `failed`，不計費。
- provider 5xx / timeout → 雲端層重試（見 architecture.md），對使用者只顯示一次「重試中」。
- provider 4xx（prompt 被擋、參數錯）→ 不重試，直接把可讀訊息帶回面板。
- 使用者關閉面板 → job 繼續在雲端跑，重開面板可看到 `running` 的 job（狀態存在雲端，不存在 Ruby 記憶體）。
- 使用者關閉 SketchUp → 同上，下次開啟時 reconcile。

---

## 3. Non-goals（這個原型明確不做）

- 不做自有推論後端 / 不自架 GPU。
- 不做 photoreal 物理渲染（不是 V-Ray 競品）。
- 不做動畫、walkthrough、多幀時序一致性。
- 不做材質庫 / 素材市集 / 模型編輯。
- 不做團隊協作、共用 workspace、權限分級。
- 不做離線模式。
- 不做 Windows/Mac 全版本相容矩陣（原型只鎖定一個驗證過的版本，見 open-questions Q1）。
- 不做 SketchUp Web 版（Ruby API 不可用）。
- 不做付費金流（原型階段 BYO key 或固定額度）。
- 不做 prompt 自動生成 / LLM 改寫（可列入加分）。

---

## 4. 可量化驗收標準

### 4.1 功能面（Definition of Done）

| # | 條件 | 量測方式 | 門檻 |
|---|---|---|---|
| F1 | 三個 pass 像素對齊 | 對同一 scene 擷取，檢查三圖尺寸相同；用棋盤格測試模型比對 8 個已知角點的像素座標 | 角點誤差 ≤ 1 px |
| F2 | 設定完整還原 | 擷取前後 dump `rendering_options` 全部 key/value 與 camera 參數比對 | 100% 相同；model dirty flag 不因擷取而被設起（若做不到，需記錄為已知限制） |
| F3 | 端到端成功率 | 連續 50 次 render（含刻意注入的網路中斷 5 次） | 成功或明確錯誤 ≥ 98%，無靜默失敗、無 SketchUp crash |
| F4 | UI 不凍結 | 擷取＋上傳＋輪詢期間量測 UI 卡頓 | 單次主執行緒阻塞 ≤ 500 ms |
| F5 | Job 可恢復 | 關閉面板 / 重開 SketchUp 後重開面板 | 進行中 job 能正確顯示並取回結果 |
| F6 | 成本護欄生效 | 觸發每日上限、並發上限、解析度上限 | 三者皆能在 client 與 server 兩層擋下，server 為權威 |

### 4.2 效能與成本

| 指標 | 目標 |
|---|---|
| 擷取三 pass（1024×1024）耗時 | p50 ≤ 3 s，p95 ≤ 6 s |
| 端到端（按下 Render → 出圖） | p50 ≤ 40 s，p95 ≤ 90 s |
| 單張成本 | ≤ US$0.08（1024×1024，需在 open-questions Q6 確認可接受範圍） |
| 多重控制相對純 img2img 的成本增幅 | ≤ 1.6×（含多 pass 上傳與額外 controlnet 費用） |

### 4.3 結構保真度評估方法（核心）

這是用來驗證 H1 / H2 的實驗設計。

**資料集**
- 12 個 SketchUp 場景（6 外觀 / 6 內裝），涵蓋：直角量體、曲面、大面積玻璃、密集開口、細長構件（欄杆/百葉）、複雜家具。
- 每個場景 3 個固定相機（一點透視 / 兩點透視 / 仰角），共 **36 shots**。
- 場景與相機以 .skp + 具名 Scene 存進 `eval/scenes/`，確保可重現。

**受測條件**（其他變因全部鎖死：同 prompt、同 seed、同底模、同 sampler/steps、同輸出尺寸）
- **A（baseline）**：純 img2img，beauty 截圖，denoise 固定值。
- **B（弱對照）**：img2img + 從 beauty 截圖跑 Canny 得到的 edge control。
  > B 存在的理由：如果 B 就已經接近 C，那「必須跑在 SketchUp 內部」的論點大幅弱化，因為 Canny 在外部工具也做得到。B 是誠實檢驗自己論點的關鍵對照組。
- **C（本方案）**：beauty + hidden-line edge + fog depth 多重控制。
- 每個條件每個 shot 跑 **3 個 seed**，共 36 × 3 × 3 = 324 張。

**Ground truth**：由 SketchUp 直接產出，不是估計值 —— 這是本方案唯一無法被外部工具複製的優勢。
- GT-edge：hidden-line pass（二值化後的線稿）
- GT-depth：fog depth pass（若 fog 非線性，需先做 open-questions Q3 的標定；標定不成立則改用 `model.raytest` 產生低解析度但物理正確的 depth 作為 GT）
- GT-count：每個 shot 人工標註可見開口（門窗）數量

**指標**

1. **Edge F-score（主指標）**
   對生成圖跑 Canny（固定參數）→ 與 GT-edge 比對。
   採 BSDS 式邊界配對：容許 2 px 位移的 bipartite matching，算 precision / recall / F1。
   回報 ODS（全資料集單一最佳門檻下的 F1）。

2. **Depth 相關性（主指標）**
   對生成圖跑單目深度估計（MiDaS 類）→ 與 GT-depth 比對。
   因為單目深度是 scale/shift invariant，先做最小平方 scale-shift 對齊，再算：
   - Spearman ρ（排序一致性，對非線性容忍）
   - 對齊後的 RMSE

3. **消失點角度誤差（建築特化）**
   LSD 抽線段 → 估計主要消失點 → 與 SketchUp 相機參數解析出的真值消失點比對。
   回報角度誤差中位數（度）。這個指標對建築客戶最有說服力：「牆是不是還是直的」。

4. **開口數量幻覺率**
   生成圖的可見門窗數 vs GT-count，回報 `|pred - gt| / gt` 的平均。
   計數方式先用 VLM 自動標，再人工抽查 20% 校正（需回報標註者一致性）。

5. **人類偏好（守門指標，對應 H2）**
   雙盲配對比較，A vs C 與 B vs C，每組 36 對，5 位評分者，強制二選一，
   問題固定為：「哪一張你更願意交給客戶？」
   回報勝率與 95% CI，以及評分者間一致性（Fleiss' κ）。

**統計**
- 主分析為配對比較（同 shot 同 seed 對照），對 shot 做 bootstrap（10,000 次）取 95% CI。
- 回報 C−A 與 C−B 的配對差值與 CI，不只回報各自平均。
- 三個 seed 先在 shot 內取中位數再進 bootstrap，避免 seed 變異灌水樣本數。

**通過條件**
- H1：C−A 的 Edge F1 差值 ≥ 0.10 且 CI 不含 0；C−A 的 depth ρ 差值 ≥ 0.05 且 CI 不含 0。
- H2：C 對 A 的人類偏好勝率 95% CI 下界 ≥ 0.40。
- 附帶結論：回報 C−B。若 C−B 的 Edge F1 差值 CI 含 0，必須在報告中明講「edge 這一項，SketchUp 內部取圖相對外部 Canny 沒有可測量的優勢」，並把論點重心移到 depth / 材質遮罩 / 相機真值。

**輸出**：`eval/report.md` + 原始數據 CSV + 每個 shot 的三聯圖（A/B/C 並排）。

---

## 5. 已知風險（詳見 critique.md）

- fog 深度圖的數值分布與 ControlNet depth 模型訓練用的 MiDaS 相對深度不同分布，可能 out-of-distribution。
- 多重控制過強會壓縮生成自由度，畫面可能變得像「上色的線稿」。
- SketchUp API 沒有 depth buffer，fog 是 workaround，其線性度未經驗證。
