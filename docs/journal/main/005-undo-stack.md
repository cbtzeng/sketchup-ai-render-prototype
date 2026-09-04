---
branch: main
date: 2026-09-04
status: decided
---

# rendering_options 不進 undo stack，因此 ensure 還原是唯一防線

## 背景

可行性清單 2.6：改 rendering_options 會不會污染 undo stack？
若會，使用者按 Ctrl+Z 想撤銷自己的編輯，卻撤銷到我們的顯示設定 ——
那是會被一星負評的體驗。按 Ctrl+Z 是 UI 動作，腳本模擬不了，只能手動測。

## 實測（2026-09-04，手動）

流程：開新模型 → 畫一個矩形 → 改 rendering_options → 按一次 Ctrl+Z。

| 測試 | 做法 | Ctrl+Z 撤銷掉什麼 | Edit 選單 |
|---|---|---|---|
| A | 裸改 `DisplayFog` / `Texture` | **矩形**，顯示設定維持改過的狀態 | Undo 變灰、出現 Redo Rectangle |
| B | 包在 `start_operation` + `commit_operation` | **矩形** | Undo 變灰、出現 Redo Rectangle |
| C | `start_operation` + `abort_operation` | — | **`DisplayFog` 仍為 `true`** → abort **不回滾**顯示設定 |

## 決定

1. **擷取流程不需要 `start_operation` 來包裝顯示設定的變更。**
2. **`ViewState.with_temporary` 的 `ensure` 還原是唯一的還原機制**，不是雙保險。
   任何時候都不得移除或跳過。

## 理由

測試 A 直接證明 rendering_options 的變更**不屬於 model transaction**，
不會產生 undo 項目。這有兩個後果：

- **好消息**：使用者的 Ctrl+Z 行為完全正常，我們不會干擾他的編輯歷史。
  也不需要為了顯示設定去研究 `start_operation` 的 transparent 參數。
- **必須警惕的一面**：正因為不在 transaction 內，**SketchUp 不會幫我們還原任何東西**。
  程式當掉、例外沒接到、或有人把 `ensure` 拿掉，使用者的樣式設定就永久壞掉，
  而且他自己按 Ctrl+Z 也救不回來。

測試 B 顯示包在 `start_operation` 裡也不會產生 undo 項目 ——
SketchUp 不會為「沒有幾何變更的操作」建立 undo 條目。所以包了也沒用，徒增複雜度。

這與稍早的另一項實測一致：跑完 60+ 次 key 寫入後 `model.modified?` 仍為 `false`。
rendering_options 完全在 model 的變更追蹤之外。

## 被否決的選項為什麼不行

- **用 `start_operation` 包住顯示設定變更**：測試 B 證明沒有效果，只是多一層沒用的包裝。
- **依賴 `abort_operation` 回滾顯示設定**：**測試 C 已確認不行**。
  在 `start_operation` 內把 `DisplayFog` 設為 true 後 `abort_operation`，
  讀回仍是 `true`。rendering_options 不在 transaction 內，abort 對它無效。
  這與測試 A 的結論一致。

## 對程式碼的硬性要求

- `ViewState` 只暴露 `with_temporary`，不對外開放裸的 `restore`，
  讓呼叫端沒有機會「忘記還原」。
- 必須有一個測試專門驗證「block 內拋例外時仍然還原」。
- 還原後要 `diff` 自我驗證，不一致就明確回報，不能靜默。

## 未解

無。三組測試皆已取得有效結果，可行性清單 2.6 由 🔴 結案為 🟢。

## 後記：probe 腳本的 abort_operation 是給幾何用的，不是給設定用的

先前的 `probe_view.rb` / `probe_rendermode.rb` 同時用了 `abort_operation`
與自寫的 `ensure` 還原。測試 C 證明前者只回滾臨時幾何，
**顯示設定完全是靠後者救回來的**。兩者職責不同，都要留。
