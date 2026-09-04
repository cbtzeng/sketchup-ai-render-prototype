# 手動測試：rendering_options 是否污染 undo stack

**為什麼要手動測**：按 Ctrl+Z 是 UI 動作，腳本模擬不了。這一項是可行性清單 2.6，
也是唯一還沒驗證的架構級風險。

**為什麼重要**：如果使用者按 Ctrl+Z 想撤銷自己剛畫的線，結果撤銷到我們的顯示設定，
那是會被一星負評的體驗 —— 比出圖失敗嚴重得多。

⚠️ 請用**新開的空白模型**做，不要用重要的 .skp。

---

## 測試 A：不包 start_operation（裸改）

1. 開新模型（File → New）。
2. 用矩形工具**畫一個矩形**。這是「使用者自己的編輯」，等下要看它會不會被正確撤銷。
3. 開 Ruby Console（Extensions → Developer → Ruby Console），貼上：

   ```ruby
   m = Sketchup.active_model
   puts "改之前 DisplayFog = #{m.rendering_options['DisplayFog']}, Texture = #{m.rendering_options['Texture']}"
   m.rendering_options['DisplayFog'] = true
   m.rendering_options['Texture'] = false
   m.active_view.refresh
   puts "改之後 DisplayFog = #{m.rendering_options['DisplayFog']}, Texture = #{m.rendering_options['Texture']}"
   ```

   畫面應該會變（起霧、貼圖關掉）。

4. **按一次 Ctrl+Z**（或 Edit → Undo）。
5. 觀察並記錄：

   | 觀察到什麼 | 意義 |
   |---|---|
   | **矩形消失了**，霧和貼圖維持我們改過的狀態 | ✅ 好結果。顯示設定不進 undo stack |
   | **矩形還在**，霧關掉了或貼圖回來了 | ❌ 壞結果。我們的改動污染了 undo stack |
   | 兩者都變了 | ❌ 更糟 |

6. 再貼一次，看 Edit 選單的 Undo 項目文字叫什麼：

   ```ruby
   puts Sketchup.active_model.rendering_options['DisplayFog']
   ```

   同時**看 Edit 選單最上面那一行寫什麼**（例如「Undo Rectangle」還是別的），一起回報。

---

## 測試 B：包在 start_operation 裡（我們實際要用的方式）

1. 一樣開新模型，**再畫一個矩形**。
2. 貼上：

   ```ruby
   m = Sketchup.active_model
   m.start_operation("Architech Undo Test", true)
   m.rendering_options['DisplayFog'] = true
   m.rendering_options['Texture'] = false
   m.commit_operation
   m.active_view.refresh
   puts "已 commit"
   ```

3. **按一次 Ctrl+Z**。
4. 記錄：撤銷掉的是矩形，還是我們的顯示設定？Edit 選單的 Undo 文字是什麼？

---

## 測試 C：abort_operation（probe 腳本用的方式）

1. 開新模型，畫一個矩形。
2. 貼上：

   ```ruby
   m = Sketchup.active_model
   m.start_operation("Architech Abort Test", true)
   m.rendering_options['DisplayFog'] = true
   m.abort_operation
   m.active_view.refresh
   puts "DisplayFog 現在 = #{m.rendering_options['DisplayFog']}   ← abort 有沒有把它一起回滾？"
   ```

3. 記錄 `DisplayFog` 印出來是 `true` 還是 `false`。
   - `false` → abort_operation **會**回滾顯示設定（那我們的 ensure 還原就是多餘但無害的雙保險）
   - `true` → abort_operation **不會**回滾顯示設定（所以 ensure 還原是必要的，不能拿掉）
4. 再按一次 Ctrl+Z，看撤銷掉什麼。

---

## 回報格式

```
測試 A：Ctrl+Z 撤銷掉的是 ____，Edit 選單顯示 "Undo ____"
測試 B：Ctrl+Z 撤銷掉的是 ____，Edit 選單顯示 "Undo ____"
測試 C：DisplayFog 印出 ____，Ctrl+Z 撤銷掉的是 ____
```

## 結果會怎麼影響設計

- **A 好 B 好**：最理想。擷取流程照現在的設計走即可。
- **A 壞 B 好**：所有 rendering_options 改動都必須包在 `start_operation` 內，
  這會成為 `capture/session.rb` 的硬性規則，且要寫進測試。
- **A 壞 B 壞**：需要研究 `start_operation` 的第四個參數（transparent）。
  若仍無解，就在 README 的「已知限制」誠實記載，並在面板上提示使用者。
