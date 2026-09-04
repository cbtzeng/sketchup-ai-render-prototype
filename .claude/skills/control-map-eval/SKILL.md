---
name: control-map-eval
description: |
  Use when running, analysing, or reporting the structural-fidelity evaluation that decides
  whether multi-control (beauty + hidden-line + fog depth) actually beats plain img2img —
  i.e. any work on eval/, the A/B/C conditions, Edge F-score, depth correlation, or eval/report.md.
  Enforces variable locking, the mandatory external-Canny control group, and paired statistics.
allowed-tools: Bash, Read, Write, Edit, Grep
---

# 控制圖評估

這份評估是整個作業的核心交付物。功能可以砍，評估不能。

## 假設

- **H1**：C 相對 A，Edge F-score **+≥0.10**、depth Spearman ρ **+≥0.05**，配對 95% CI 不含 0。
- **H2**（守門）：C 對 A 的人類偏好勝率 95% CI 下界 **≥0.40**。
  結構變準但畫面變醜，在產品上是失敗。

## 四個條件

| | 條件 | 為什麼存在 |
|---|---|---|
| A | 純 img2img（beauty 截圖） | baseline |
| **B** | img2img + 對 beauty 截圖跑的 Canny | **不可省略** |
| C | beauty + hidden-line edge + fog depth | 本方案 |
| D | SketchUp 內建 su_diffusion | 已排入 follow-up issue，第一版不做 |

### B 組為什麼不能省

Canny 和單目深度估計，在**外部**拿一張截圖就做得出來。
少了 B，你無法回答「這件事非得在 SketchUp 內部做嗎」——
而這正是整個產品論點的地基。少了 B 的報告，在面試中會被一句話問倒。

**若 C 打不贏 B**：照 open-questions Q8 的決定，誠實寫進報告，
把論點改寫成「護城河在語意遮罩與相機真值，不在 edge/depth」。
這個結論本身有價值，不要為了好看去調參數重跑。

## 變因鎖定（最容易搞砸的地方）

跑之間**只有控制圖能變**。以下全部鎖死並記錄在 `eval/config.json`：

- prompt（逐字相同，**不做任何 LLM 改寫** —— 這就是它被列入 Non-goals 的原因）
- negative prompt、seed、底模、sampler、steps、CFG、denoise、輸出尺寸
- provider 端點與版本、preset_version

每張輸出圖的 metadata 要能回推是哪個 (shot, condition, seed)。做不到就重跑。

## 資料集

規模依 open-questions Q2/Q17：**6 場景 × 2 相機 = 12 shots**（時間盒 ≤2 天）。
場景以具名 Scene 存進 `eval/scenes/`，涵蓋：直角量體、曲面、大面積玻璃、
密集開口、細長構件、複雜家具。

12 shots × 3 條件 × 1 seed = 36 張。

## Ground truth

由 SketchUp 直接產出，**不是估計值** —— 這是本方案唯一無法被外部工具複製的部分。

- GT-edge：hidden-line pass 二值化
- GT-depth：fog depth pass（**須先通過 sketchup-api-verify 的 V4 標定**）。
  標定失敗就改用 V5 的 raytest 低解析度深度當量尺。

## 指標

1. **Edge F-score（主）** — 對生成圖跑 Canny（參數固定並記錄）→ 與 GT-edge 做
   容許 2 px 位移的邊界配對，算 precision / recall / F1，回報 ODS。
2. **Depth Spearman ρ（主）** — 生成圖跑單目深度 → 與 GT-depth 先做最小平方
   scale-shift 對齊（單目深度是 scale/shift invariant），再算 ρ 與對齊後 RMSE。
3. 消失點角度誤差（加分）— LSD 抽線 → 與相機參數解出的真值比對。建築客戶最有感。
4. 開口幻覺率（加分）— 可見門窗數 vs GT-count。
5. 人類偏好（H2 守門）— 雙盲配對，強制二選一：「哪一張你更願意交給客戶？」

## 統計

- **配對**比較（同 shot 同 seed），不是各自算平均再相減。
- 對 shot 做 bootstrap（10,000 次）取 95% CI。
- **回報 C−A 與 C−B 的配對差值與 CI**，不要只回報三組各自的平均值。
- 多 seed 時，先在 shot 內取中位數再進 bootstrap，避免用 seed 灌大樣本數。

## 報告

`eval/report.md` 必須包含：

- [ ] 四個條件的完整參數表（可重現）
- [ ] C−A 與 **C−B** 的配對差值 + 95% CI
- [ ] 每個 shot 的 A/B/C 三聯圖
- [ ] **失敗案例**：挑 2–3 個 C 表現最差的 shot，說明為什麼
- [ ] 成本與延遲實測：p50 / p95、單張成本
- [ ] H1 / H2 各自是否成立的明確結論句
- [ ] 若 fog 標定失敗，說明 GT-depth 改用什麼、以及這對結論的影響

## Red Flags

- 只回報 A vs C，跳過 B
- 只回報平均值，不回報配對差值與 CI
- 調參數重跑到有優勢為止
- 用不同 prompt 跑不同條件
- 挑好看的圖放進報告，不放失敗案例
- 宣稱「結構保真度提升」卻沒量人類偏好（H2）
