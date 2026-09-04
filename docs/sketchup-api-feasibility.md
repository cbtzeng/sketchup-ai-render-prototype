# sketchup-api-feasibility.md — Ruby API 可行性清單

**閱讀方式**：每一項標了信心等級。
- 🟢 **確定**：我有把握 API 存在且行為如述。
- 🟡 **大致確定但細節待查**：API 存在，但關鍵參數/行為我不敢保證。
- 🔴 **不確定 / 需實機驗證**：我不確定，或這是整個方案的風險點。**這幾項若不成立，方案要改。**

## 0. 已確認的環境（2026-09-03 於本機掃描）

| 項目 | 值 | 來源 |
|---|---|---|
| SketchUp | **2026**（`Sketchup.version` = 26.2.242）✅ 已實測 | `/Applications/SketchUp 2026/SketchUp.app` |
| 架構 | universal（x86_64 + arm64） | `lipo -archs` |
| **Ruby** | **3.2.2** ✅ 已於 Ruby Console 實測 `RUBY_VERSION` | 檔案系統與執行期一致 |
| OpenSSL | 隨附（openssl 3.1.0 gem + stdlib） | Ruby.framework 內 |
| Plugins 目錄 | `~/Library/Application Support/SketchUp 2026/SketchUp/Plugins` | |
| macOS | 15.7.1 | |

⚠️ **Ruby 3.2.2 而非 2.7**（我原本的假設錯了）。影響：可用較新語法；但**既有第三方 SketchUp 範例碼多半是 Ruby 2.x 時代寫的**，
複製貼上時要注意 Ruby 3 的關鍵字參數分離、`Object#taint` 移除等破壞性變更。

以下 🔴 與 🟡 項目仍必須由你在實機上跑一次驗證腳本確認。
**我沒有臆造不存在的 API；凡是我記不清楚精確拼字或行為的，都標成待查，而不是猜一個寫上去。**

---

## 1. 影像輸出：`Sketchup::View#write_image`

| # | 項目 | 信心 | 說明 |
|---|---|---|---|
| 1.1 | `view.write_image` 存在，可輸出 PNG/JPG | 🟢 | 副檔名決定格式 |
| 1.2 | 有舊版位置參數形式與新版 options hash 形式（含 `:filename, :width, :height, :antialias, :compression`） | 🟢 | 新專案用 hash 形式 |
| 1.3 | 輸出解析度可大於 viewport | 🟢 **已實測** | 1512×849 的 viewport 成功輸出 1024×1024 與 1512×849，皆回傳 true |
| 1.4 | 寬高比 ≠ viewport 時的取景行為 | 🟢 **已實測解決** | **取景只由 width/height 決定**：垂直 FOV 固定（`fov_is_height?`=true），水平視野由長寬比推導。`camera.aspect_ratio` 對 write_image **完全無影響**（設 0.0 與 1.0 產出的 PNG 位元組相同）。→ 三 pass 用同一組尺寸即必然對齊，不需任何額外機制。見 journal 002 |
| 1.5 | `Camera#aspect_ratio=` 可鎖定寬高比 | 🟢 **已實測：對 write_image 無效** | 它只影響 viewport 顯示（加黑邊），不影響輸出。**不要在擷取流程中設定它** —— 純副作用 |
| 1.6 | `:transparent => true` 是否支援、與 fog/天空的互動 | 🔴 | 我不確定，需實測 |
| 1.7 | 改完 rendering_options 後是否需要 `view.refresh` / `invalidate` | 🟡 | `View` 同時有 `refresh` 與 `invalidate`（已實測存在），另有 `average_refresh_time` / `last_refresh_time` 可直接量測重繪耗時。**是否必要仍待 Task 0.2 驗證**，但工具齊全 |
| 1.8 | 三 pass 在 1024×1024 的總耗時 | 🟡 **初測 0.139 s** | beauty 0.059 / edge 0.042 / depth 0.037。**但測試模型近乎空白，僅一面牆**，不能當作真實場景的數字。spec 目標 p50 ≤ 3 s 看似有大量餘裕，需在 Phase 4 的真實場景上複測 |
| 1.9 | 邊線寬度以 px 計，導致高解析度下線相對變細 | 🟡 | 若成立，edge pass 的線寬需隨解析度調整，否則 ControlNet 吃到的線稿密度不一致 |
| 1.10 | `device_width/height` vs `vpwidth/height` | 🟢 **已實測：不影響對齊** | 倍率確為 2.0（Retina）。但 `write_image` 吃的是絕對像素數，與此無關。僅在螢幕座標↔輸出座標換算時才需要。`graphics_engine` = `:graphics_engine_2024` |
| 1.11 | `Camera#fov_is_height?` 存在 | 🟢 **已實測** | 決定 FOV 以高還是以寬量測 —— 正是寬高比改變時取景怎麼變的關鍵。dump 當前 `fov = 35.0`、`aspect_ratio = 0.0`（0 = 跟隨 viewport，先前 🟡 的猜測成立） |

**替代方案（若 write_image 有致命問題）**：`view.write_image` 之外沒有其他官方離螢幕出圖途徑。
真的不行只能退回抓 viewport 尺寸出圖，犧牲解析度自由度。

---

## 2. 樣式控制：`model.rendering_options`

| # | 項目 | 信心 | 說明 |
|---|---|---|---|
| 2.1 | `model.rendering_options` 回傳 `Sketchup::RenderingOptions`，用 `[]` / `[]=` 存取字串 key | 🟢 | |
| 2.2 | 可列舉所有 key | 🟢 **已實測** | `RenderingOptions` 含 Enumerable，`each_pair` / `each_key` / `keys` / `to_h` 全部可用。共 58 個 key，完整 dump 見 `tools/spike/results/2026-09-04-env-dump.txt` |
| 2.3 | 控制邊線/面/材質/霧的 key | 🟢 **已實測** | 上述 key 名全部存在，已寫入 `src/architech_render/capture/options_keys.rb`。**兩項修正**：(a) 我先前猜的 `FaceColorMode` **不存在**；(b) `DisplayShadows` 不在 rendering_options，在 `shadow_info`。另：深度暗示的 key 確實是 `DrawDepthQue`（Que 不是 Cue），先前對拼字的懷疑成立 |
| 2.3b | `FogStartDist` / `FogEndDist` 的 `-1.0` | 🟢 **已實測解決** | 確為 auto 哨兵值，且**可寫入**。開啟 `DisplayFog` 不會自動把它換成計算值。寫入明確距離（英吋）後精確保留，寫回 `-1.0` 可恢復 auto |
| 2.4 | `RenderMode` 的整數值對應 | 🟢 **已實測（目視確認）** | **0**=線框、**1**=隱藏線（面填**背景色**）、**2**=著色含貼圖、**5**=單色（面恆為**純白**）、**6**=同 2 但整體壓暗約 7%。**3/4/7 與 2 位元組完全相同**（在有貼圖的場景上仍相同）→ 視為 2 的別名。貼圖顯示由獨立的 `Texture` 布林控制，不歸 RenderMode 管。**edge pass 用 5 不是 1**，理由見 journal 004 |
| 2.5 | 改 rendering_options 是否讓 model 變 dirty | 🟢 **已實測：不會** | 進場前 `modified? = false`，跑完 60+ 次 key 寫入與相機移動後仍為 `false`。**你在 Q13 的推測（會變 true）不成立** —— 這是好消息，代表擷取不會讓使用者被問「要儲存嗎」 |
| 2.6 | 改 rendering_options 是否污染 undo stack | 🟢 **已實測：不會** | 手動測試：畫矩形→改設定→Ctrl+Z，撤銷掉的是**矩形**，顯示設定維持改過的狀態。包在 `start_operation`+`commit_operation` 內結果相同（SketchUp 不為無幾何變更的操作建立 undo 條目）。**推論**：rendering_options 完全在 model transaction 之外，因此 SketchUp 不會幫我們還原任何東西 —— `ensure` 還原是**唯一**防線，不是雙保險。另測 C 確認 `abort_operation` **不回滾**顯示設定（設 true 後 abort，讀回仍為 true）—— 它只回滾幾何。見 journal 005 |
| 2.7 | snapshot → restore 能否完全還原 | 🟢 **已實測** | 腳本自我驗證「rendering_options 已完全還原」，逐 key 比對無差異，含 Color 與浮點值 |
| 2.8 | `model.shadow_info`（陰影開關、太陽方向）可存取與還原 | 🟢 | |
| 2.9 | `model.styles.add_style(path, select)` 可載入 .style 檔 | 🟡 | 我記得存在。但用「打包好的 .style 檔」切換 vs「直接改 rendering_options」哪個更快更乾淨，需實測比較。用 .style 的優點是還原乾淨、行為可預期 |

---

## 3. 深度圖（最大的技術賭注）

| # | 項目 | 信心 | 說明 |
|---|---|---|---|
| 3.1 | **Ruby API 沒有任何方式讀取 GPU depth buffer / z-buffer** | 🟢 | 這就是為什麼要用 fog 當 workaround。這一點我很確定 |
| 3.2 | fog 相關 key 存在且可程式化控制 | 🟢 **已實測** | 五個 key 全部存在且可讀寫。`-1.0` 是可寫入的哨兵值，代表 auto；寫入明確距離後精確保留 |
| 3.3 | `FogStartDist`/`FogEndDist` 的單位與意義 | 🟢 **已實測** | 單位為**英吋**（SketchUp 內部單位）。寫入 `60 × 39.3701` 讀回 `2362.206`，精確保留。距離自相機 eye 起算 |
| 3.4 | fog 的衰減是線性還是指數 | 🟢 **已實測：完全線性** | `grey = 255 × (1 − (d−start)/(end−start))`，clamp。12 個標定點誤差全部 ≤ ±0.5 灰階（即量化誤差）。見 journal 003 |
| 3.5 | fog 是否作用於邊線、面、背景 | 🟢 **已實測** | 背景（無幾何處）呈純霧色，與遠距離連續，**沒有深度斷層**。這是 fog-as-depth 可用的重要前提 |
| 3.6 | 白面 + 黑霧能否得到單調可用的灰階深度 | 🟢 **已實測：可以，且可逆** | 不只單調，是精確線性。`options_keys.rb` 的 `grey_to_distance` 可無損還原公尺數 |
| 3.7 | fog 深度的標定方法 | 🟢 **已完成** | 改用「相機退後法」：單一牆面 + 相機退到各距離，比原本蓋六面牆更無歧義。腳本 `tools/spike/probe_view.rb` E 節 |
| 3.8 | 後備方案：`view.pickray(x, y)` + `model.raytest(ray)` 產生 depth map | 🟢 | 這兩個 API 我確定存在，回傳交點與路徑。**這是物理正確的真深度**，缺點是慢：128×128 就要 16,384 次 raytest，在主執行緒上會凍結 UI |
| 3.9 | raytest 的實際速度 | ⚪ **不再需要** | fog 已證實可用（3.4），raytest 後備方案不啟用。若日後要交叉驗證 fog 的正確性可再測，非必要 |

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
| 4.5 | `Sketchup.temp_dir` 可取得暫存目錄 | 🟢 **已實測** | 回傳 `/var/folders/.../T/com.sketchup.SketchUp.2026.benson`。不需要 `Dir.tmpdir` fallback |

---

## 5. 網路

| # | 項目 | 信心 | 說明 |
|---|---|---|---|
| 5.1 | `Sketchup::Http::Request`（SU2017+）非同步、callback 在主執行緒 | 🟢 | |
| 5.2 | 是否支援 binary body / multipart 上傳圖檔 | 🔴 | **需實測**。若不支援，改用「雲端發簽名 URL → PUT raw bytes」，或退回 `net/http` |
| 5.3 | 可設 headers、可設逾時 | 🟢 **已實測（有一項缺失）** | `Request` 的方法為 `[:body, :body=, :cancel, :headers, :headers=, :method=, :set_download_progress_callback, :set_upload_progress_callback, :start, :status, :url]`。headers 可設 ✓；**沒有任何逾時設定方法** ✗ → 逾時要靠 `UI.start_timer` 自行計時後呼叫 `cancel`。`Sketchup::Http` 常數含 PUT / POST 與 STATUS_* |
| 5.4 | Ruby stdlib `net/http` + OpenSSL 可用（HTTPS） | 🔴 **修正：不能直接用** | `require` 成功（OpenSSL gem 3.1.0 / library 3.4.1），但 **`OpenSSL::X509::DEFAULT_CERT_FILE` 指向打包機器路徑 `/Volumes/X10_Pro/conan1/...`，該檔在使用者機器上不存在**，預設憑證驗證會失敗。**解法已確認可行**：顯式傳 `ca_file`。來源有二 —— macOS 的 `/etc/ssl/cert.pem`（6263 行，存在），或 SketchUp 自帶的 `SketchUp.app/Contents/Resources/Tools/cacert.pem`（存在）。**後者較安全，不依賴使用者系統狀態**。我先前說「幾乎可以確定能用」是錯的 —— 能用，但不指定 CA 會靜默失敗在 TLS 握手 |
| 5.5 | 企業 proxy / 憑證攔截環境下的行為 | 🔴 | 原型可先不管，但要記為已知限制 |

---

## 6. 打包與發佈

| # | 項目 | 信心 | 說明 |
|---|---|---|---|
| 6.1 | RBZ 打包、`SketchupExtension` + `Sketchup.register_extension` | 🟢 | |
| 6.2 | Extension Warehouse 上架與「僅載入已識別的擴充功能」載入政策需要數位簽章 | 🟢 | 原型階段可用手動安裝繞過，但要在報告中提到 |
| 6.3 | 目標版本的 Ruby 版本 | 🟢 **已確認：3.2.2** | SketchUp 2026 隨附。注意 Ruby 3 的破壞性變更會讓舊範例碼失效 |

---

## 7. 建議的實機驗證腳本（優先序）

在寫任何功能程式碼之前，請先在 Ruby Console 跑完這七項並回填結果到 `docs/open-questions.md`：

1. ~~`RUBY_VERSION`、SketchUp 版本、作業系統~~ —— **已由檔案系統確認（見第 0 節）**，
   但仍請在 Ruby Console 跑一次 `RUBY_VERSION` 確認實際載入的版本與 framework 目錄一致。
2. dump `model.rendering_options` 的**全部 key 與當前值**（貼回來，之後所有 key 以此為準）。
3. `write_image` 在 viewport 為 16:9 時輸出 1024×1024，看畫面是被裁切、加邊、還是重新取景；再加上設定 `camera.aspect_ratio` 後重測。
4. 階梯模型的 fog 標定（第 3.7 節），回報灰階↔距離對照表。
5. 改 rendering_options 後檢查 `model.modified?` 與 undo stack 行為。
6. 三 pass 1024×1024 的實際總耗時。
7. `Sketchup::Http::Request` PUT 一個 500KB 的 PNG 到測試端點，看是否成功、body 是否被破壞。

第 3、4 項若結果不理想，**架構要在動工前先改**，而不是實作到一半才發現。
