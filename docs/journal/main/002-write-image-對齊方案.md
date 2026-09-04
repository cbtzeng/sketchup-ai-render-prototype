---
branch: main
date: 2026-09-04
status: decided
---

# write_image 的取景只由 width/height 決定，因此三 pass 只要尺寸一致就必然對齊

## 背景

`docs/sketchup-api-feasibility.md` 1.4 把「`write_image` 在寬高比不符時的行為」列為
🔴 最高風險項。理由：三張控制圖若沒有像素對齊，ControlNet 會收到互相矛盾的條件，
結果可能比純 img2img 更差 —— 這個方案沒有「效果普通」的中間地帶。

## 實測

`tools/spike/probe_view.rb` 測試 B 節，viewport 為 1512×849（長寬比 1.781）：

| 圖 | 尺寸 | 長寬比 | 物件寬 / 影像高 |
|---|---|---|---|
| B1 native | 1512×849 | 1.781 | 0.262 |
| B2 square（aspect_ratio = 0.0） | 1024×1024 | 1.000 | 0.263 |
| B3 square（aspect_ratio = 1.0） | 1024×1024 | 1.000 | 0.263 |

**B2 與 B3 的 PNG 位元組完全相同**（md5 皆為 `383a0e37…`）。

## 決定

**策略 `:consistent_dimensions`** —— 三個 pass 使用同一組 `width`/`height`，
不去動 `camera.aspect_ratio`。

## 理由

1. **取景只由 width/height 決定。** 垂直 FOV 固定（`camera.fov_is_height?` 實測為 `true`），
   水平視野由長寬比推導。B1 與 B2 的「物件寬 / 影像高」為 0.262 與 0.263，
   誤差 0.4%，證實垂直方向不隨長寬比改變。
2. **`camera.aspect_ratio` 對 `write_image` 完全沒有影響。** B2 與 B3 位元組相同。
   設定它只會在使用者的 viewport 上加黑邊，卻不改變輸出 —— 是純粹的副作用，沒有好處。
3. 因此像素對齊**不需要任何額外機制**，只要三次呼叫傳同樣的尺寸即可。
   原先擔心的最高風險項，實際上是最簡單的一項。

## 被否決的選項為什麼不行

- **鎖 `camera.aspect_ratio`**（原計畫的策略 A）：實測證明無效且有副作用（干擾使用者視窗）。
- **一律用 viewport 原生尺寸**（原計畫的策略 B）：不必要的退讓。既然任意尺寸都能對齊，
  就不該放棄自訂解析度 —— 那會連帶影響成本與品質。

## 附帶發現：WYSIWYG 落差（產品問題，非技術問題）

輸出長寬比與 viewport 不同時，使用者在 SketchUp 裡看到的水平範圍**不等於**輸出範圍。
以 1512×849 的視窗輸出 1024×1024，水平會被裁掉約 44%。

這不是 bug，但會讓使用者困惑（「我明明看得到那棵樹」）。
**面板必須在按下 Render 前顯示實際的裁切框。** 已列入 `docs/spec.md` 使用者流程。

## 證據

- `tools/spike/results/2026-09-04-probe-report.txt` B 節
- 分析工具 `tools/analysis/png_probe.py`

## 未解

B4（1024×576，長寬比 1.778）的「物件寬 / 影像高」為 0.281，與 B1 的 0.262 差 7%。
推測是低解析度下取樣列落在幾何的不同位置所致，但未確認。
本決定不依賴 B4 —— B2/B3 位元組相同已足以支持結論。若日後要精確推導水平 FOV，需重測。
