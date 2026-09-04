# CLAUDE.md

## 專案階段
**實作階段（Phase 1+）。** Phase 0 可行性尖刺已於 2026-09-04 完成，
規劃階段的「禁止寫實作程式碼」限制已解除。

Phase 0 的結論（動工前必讀）：
- rendering_options 的 58 個 key 已實測，全部集中在 `src/architech_render/capture/options_keys.rb`
- `write_image` 的取景只由 width/height 決定 → 三 pass 同尺寸即必然對齊，
  **不要去設 `camera.aspect_ratio`**（對輸出無效，只會干擾使用者視窗）
- fog 為精確線性公制深度，轉換函式在 options_keys.rb

## 不可違反的原則
1. **不要臆造 SketchUp Ruby API。**（Phase 0 已把主要未知消除，但規則不變） 不確定的 API 名稱、參數、行為，一律標記為待驗證，
   不要猜一個看起來合理的寫上去。`docs/sketchup-api-feasibility.md` 用 🟢/🟡/🔴 標示信心等級，
   新增內容必須沿用這個標示法。
2. **rendering_options 的 key 名以實機 dump 的結果為準**，不要憑印象寫。
3. **擷取流程的還原必須在 `ensure` 區塊內。** 毀掉使用者的樣式設定比出圖失敗嚴重。
4. **評估設計不可省略 B 組（外部 Canny 對照）。** 少了它就無法證明核心論點。
5. **不要在 prompt 或參數上做未記錄的變動。** 評估的內部效度依賴變因鎖死。

## 文件語言
繁體中文，技術名詞保留英文。

## Skills

- `worktree` —— 開隔離開發環境，會一併建立 `docs/journal/<branch>/`
- `sketchup-api-verify` —— **碰 SketchUp Ruby API 之前必讀**，含實機驗證腳本
- `control-map-eval` —— 評估設計與統計，含「B 組不可省略」的理由

## 目錄
- `docs/` 規劃文件
- `eval/` 評估場景與報告
- `.claude/skills/` 專案 skills
