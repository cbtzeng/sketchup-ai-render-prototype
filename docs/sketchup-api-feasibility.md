# sketchup-api-feasibility.md — Ruby API 可行性清單

**閱讀方式**：每一項標了信心等級。
- 🟢 **確定**：我有把握 API 存在且行為如述。
- 🟡 **大致確定但細節待查**：API 存在，但關鍵參數/行為我不敢保證。
- 🔴 **不確定 / 需實機驗證**：我不確定，或這是整個方案的風險點。**這幾項若不成立，方案要改。**

本機沒有安裝 SketchUp，以下 🔴 與 🟡 項目必須由你在實機上跑一次驗證腳本確認。
**我沒有臆造不存在的 API；凡是我記不清楚精確拼字或行為的，都標成待查，而不是猜一個寫上去。**

---

## 1. 影像輸出：`Sketchup::View#write_image`

| # | 項目 | 信心 | 說明 |
|---|---|---|---|
| 1.1 | `view.write_image` 存在，可輸出 PNG/JPG | 🟢 | 副檔名決定格式 |
| 1.2 | 有舊版位置參數形式與新版 options hash 形式（含 `:filename, :width, :height, :antialias, :compression`） | 🟢 | 新專案用 hash 形式 |
| 1.3 | 輸出解析度可大於 viewport（離螢幕渲染） | 🟡 | 可以，但上限受硬體/驅動影響，需實測 |
| 1.4 | **當要求的寬高比 ≠ viewport 寬高比時，畫面如何處理（裁切 / 加黑邊 / 重新取景）** | 🔴 | **最高風險項**。若處理方式不可預期，三個 pass 之間可能不像素對齊，整個論點就垮了。必須實測 |
| 1.5 | `Sketchup::Camera#aspect_ratio=` 可鎖定寬高比（0 = 跟隨 viewport） | 🟡 | API 我確定存在；但它是否足以讓 1.4 變成完全確定的行為，需實測 |
| 1.6 | `:transparent => true` 是否支援、與 fog/天空的互動 | 🔴 | 我不確定，需實測 |
| 1.7 | 改完 rendering_options 後是否需要 `view.refresh` / `invalidate` 才會反映在 write_image | 🔴 | 這是常見坑。若需要，可能還得等一個 timer tick，會拉長擷取時間 |
| 1.8 | 三個 pass 在 1024×1024 的總耗時 | 🔴 | 直接決定 spec 的 p50 ≤ 3s 是否可達 |
| 1.9 | 邊線寬度以 px 計，導致高解析度下線相對變細 | 🟡 | 若成立，edge pass 的線寬需隨解析度調整，否則 ControlNet 吃到的線稿密度不一致 |

**替代方案（若 write_image 有致命問題）**：`view.write_image` 之外沒有其他官方離螢幕出圖途徑。
真的不行只能退回抓 viewport 尺寸出圖，犧牲解析度自由度。

---

## 2. 樣式控制：`model.rendering_options`

| # | 項目 | 信心 | 說明 |
|---|---|---|---|
| 2.1 | `model.rendering_options` 回傳 `Sketchup::RenderingOptions`，用 `[]` / `[]=` 存取字串 key | 🟢 | |
| 2.2 | 可列舉所有 key（`keys` / `each_key` / `each_pair` 之類） | 🟡 | 我確定「可以列舉」，但不敢保證方法名。**驗證腳本第一件事就是把 keys 全部 dump 出來**，之後所有 key 一律以 dump 結果為準 |
| 2.3 | 存在控制邊線/面/材質顯示的 key（`RenderMode`、`EdgeDisplayMode`、`Texture`、`DrawSilhouettes`、`DisplayFog`、`FogColor`、`FogStartDist`、`FogEndDist`、`FogUseBkColor` 等） | 🟡 | 這些 key 名我印象中正確，但**不要直接寫進程式**，以 2.2 的 dump 為準。SketchUp 有些 key 拼字不直覺（例如深度暗示相關的 key 歷史上有拼字瑕疵），硬猜會踩雷 |
| 2.4 | `RenderMode` 的整數值對應哪個顯示模式（wireframe / hidden line / shaded / textured / monochrome） | 🔴 | 我不確定精確映射，需實測列舉 |
| 2.5 | 改 rendering_options 是否會把 model 標成 dirty（造成關檔時跳「要儲存嗎」） | 🔴 | 若會，即使還原也可能留下 dirty flag，需驗證能否用 `start_operation(..., transparent)` 或其他方式規避 |
| 2.6 | 改 rendering_options 是否會污染 undo stack | 🔴 | 同上，使用者按 Ctrl+Z 應該回到自己的編輯，不該撤銷我們的擷取步驟 |
| 2.7 | snapshot → restore 能否完全還原（含浮點值） | 🟡 | 原則上可以；需寫「dump→改→還原→再 dump→逐 key 比對」的測試 |
| 2.8 | `model.shadow_info`（陰影開關、太陽方向）可存取與還原 | 🟢 | |
| 2.9 | `model.styles.add_style(path, select)` 可載入 .style 檔 | 🟡 | 我記得存在。但用「打包好的 .style 檔」切換 vs「直接改 rendering_options」哪個更快更乾淨，需實測比較。用 .style 的優點是還原乾淨、行為可預期 |

---

## 3. 深度圖（最大的技術賭注）

| # | 項目 | 信心 | 說明 |
|---|---|---|---|
| 3.1 | **Ruby API 沒有任何方式讀取 GPU depth buffer / z-buffer** | 🟢 | 這就是為什麼要用 fog 當 workaround。這一點我很確定 |
| 3.2 | fog 相關的 rendering_options key 存在且可程式化開關與設色 | 🟡 | 見 2.3，以 dump 為準 |
| 3.3 | `FogStartDist` / `FogEndDist` 的**單位與座標意義**（模型單位？相機距離？沿視線還是歐氏距離？） | 🔴 | 不確定。SketchUp UI 上的 fog 是滑桿，API 是距離值，兩者映射我不敢保證 |
| 3.4 | **fog 的衰減是線性還是指數** | 🔴 | **決定成敗**。若是指數，灰階值 ≠ 線性深度，必須標定成查表函數，否則餵給 ControlNet 的是被扭曲的深度 |
| 3.5 | fog 是否同時作用於邊線、面、背景/天空 | 🔴 | 若背景不吃 fog，遠景會出現不連續的深度斷層 |
| 3.6 | 「白面 + 黑霧 + 關邊線 + monochrome」能否得到單調遞增的可用灰階深度 | 🔴 | 需以已知距離的階梯測試模型驗證 |
| 3.7 | fog 深度的**標定方法** | 🟢（方法確定，結果待測） | 建一個階梯模型：在相機前方 1/2/5/10/20/50 m 各放一面白牆 → 擷取 fog pass → 讀各面灰階值 → 擬合灰階↔距離曲線。**這個標定實驗是整個專案第一件該做的事**，成本 30 分鐘，決定要不要改架構 |
| 3.8 | 後備方案：`view.pickray(x, y)` + `model.raytest(ray)` 產生 depth map | 🟢 | 這兩個 API 我確定存在，回傳交點與路徑。**這是物理正確的真深度**，缺點是慢：128×128 就要 16,384 次 raytest，在主執行緒上會凍結 UI |
| 3.9 | raytest 的實際速度 | 🔴 | 需實測。若 64×64 可在 1s 內完成，就足以當作 evaluation 的 GT-depth（不必當生產用的控制圖，只要當量尺） |

**結論**：fog 深度是有風險的假設，不是已知事實。
**建議把 3.7 的標定實驗排在所有實作之前**。若 fog 不可用，方案退化為
「beauty + hidden-line edge」雙控制 + raytest 低解析度深度，論點仍然成立但強度下降。

---

## 4. UI 與非同步

| # | 項目 | 信心 | 說明 |
|---|---|---|---|
| 4.1 | `UI::HtmlDialog`（SU2017+，Chromium 核心），`add_action_callback` / `execute_script` / `set_file` | 🟢 | 舊的 `UI::WebDialog` 已棄用，不用 |
| 4.2 | `UI.start_timer(seconds, repeat) { }` / `UI.stop_timer(id)` 可做輪詢 | 🟢 | 這是 SketchUp 沒有背景執行緒時做非同步的標準手法 |
| 4.3 | Ruby 跑在主 UI 執行緒，長操作會凍結 SketchUp | 🟢 | 所有設計都要遷就這一點 |
| 4.4 | HtmlDialog ↔ Ruby 傳遞大字串（base64 預覽圖）的大小上限與效能 | 🔴 | 若上限低或很慢，預覽圖要改走 `file://` 或本機暫存檔路徑而非 base64 |
| 4.5 | `Sketchup.temp_dir` 可取得暫存目錄 | 🟡 | 我記得存在；不確定的話退回 Ruby 的 `Dir.tmpdir` |

---

## 5. 網路

| # | 項目 | 信心 | 說明 |
|---|---|---|---|
| 5.1 | `Sketchup::Http::Request`（SU2017+）非同步、callback 在主執行緒 | 🟢 | |
| 5.2 | 是否支援 binary body / multipart 上傳圖檔 | 🔴 | **需實測**。若不支援，改用「雲端發簽名 URL → PUT raw bytes」，或退回 `net/http` |
| 5.3 | 可設 headers、可設逾時 | 🟡 | headers 確定可以；逾時設定我不確定 |
| 5.4 | Ruby stdlib `net/http` + OpenSSL 在 SketchUp 內可用（HTTPS） | 🟡 | 現代版本一般可用，但歷史上有 OpenSSL 憑證問題，需實測 |
| 5.5 | 企業 proxy / 憑證攔截環境下的行為 | 🔴 | 原型可先不管，但要記為已知限制 |

---

## 6. 打包與發佈

| # | 項目 | 信心 | 說明 |
|---|---|---|---|
| 6.1 | RBZ 打包、`SketchupExtension` + `Sketchup.register_extension` | 🟢 | |
| 6.2 | Extension Warehouse 上架與「僅載入已識別的擴充功能」載入政策需要數位簽章 | 🟢 | 原型階段可用手動安裝繞過，但要在報告中提到 |
| 6.3 | 目標版本的 Ruby 版本（近年版本為 Ruby 2.7 系列） | 🟡 | 需以你機器上的 `RUBY_VERSION` 為準，決定可用語法 |

---

## 7. 建議的實機驗證腳本（優先序）

在寫任何功能程式碼之前，請先在 Ruby Console 跑完這七項並回填結果到 `docs/open-questions.md`：

1. `RUBY_VERSION`、SketchUp 版本、作業系統。
2. dump `model.rendering_options` 的**全部 key 與當前值**（貼回來，之後所有 key 以此為準）。
3. `write_image` 在 viewport 為 16:9 時輸出 1024×1024，看畫面是被裁切、加邊、還是重新取景；再加上設定 `camera.aspect_ratio` 後重測。
4. 階梯模型的 fog 標定（第 3.7 節），回報灰階↔距離對照表。
5. 改 rendering_options 後檢查 `model.modified?` 與 undo stack 行為。
6. 三 pass 1024×1024 的實際總耗時。
7. `Sketchup::Http::Request` PUT 一個 500KB 的 PNG 到測試端點，看是否成功、body 是否被破壞。

第 3、4 項若結果不理想，**架構要在動工前先改**，而不是實作到一半才發現。
