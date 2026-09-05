# SketchUp 多重控制圖 AI 渲染外掛（原型規劃）

Architech AI 面試作業。**目前階段：純規劃，尚無實作程式碼。**

## 核心論點

多數 SketchUp AI 渲染外掛只把 viewport 截圖送去 img2img，結構與材質容易走鐘。
外掛跑在 SketchUp 內部，可以主動切換 rendering options，產出多張幾何對齊的控制圖
（beauty / hidden-line edge / fog depth）一起餵給 ControlNet，換取更高的結構保真度。

**這是一個待驗證的假設，不是結論。** 本專案的重點是設計一套可量測的實驗來證明或推翻它。

## 文件

| 檔案 | 內容 |
|---|---|
| [docs/spec.md](docs/spec.md) | 使用者流程、Non-goals、可量化驗收標準、**純 img2img vs 多重控制的評估方法** |
| [docs/architecture.md](docs/architecture.md) | 模組拆解、job 狀態機、失敗設計、成本護欄 |
| [docs/sketchup-api-feasibility.md](docs/sketchup-api-feasibility.md) | Ruby API 可行性清單，標示確定 🟢 / 待查 🟡 / 需實機驗證 🔴 |
| [docs/scope.md](docs/scope.md) | MVP / 加分 / 明確不做 |
| [docs/critique.md](docs/critique.md) | 對本專案產品論點的七點反駁 |
| [docs/open-questions.md](docs/open-questions.md) | **待回答的問題（下一步的前置條件）** |

## 目前的最大風險

1. **fog 深度圖是否線性、是否可用** —— 未經驗證。見 feasibility 3.3–3.7。動工前必須先做標定實驗。
2. **三個 pass 是否像素對齊** —— `write_image` 在寬高比不符時的行為未確認。對不齊則結果可能比純 img2img 更差。
3. **SketchUp 2026 已內建 Trimble 自家的 AI Render（`su_diffusion`）**，且是原生 C++/Qt 擴充，
   能碰到 Ruby API 拿不到的 depth buffer。差異化必須重新定位。見 critique.md 第 5 點。
4. **edge/depth 這兩張控制圖，外部工具用單張截圖也做得出來** —— 見 critique.md 第 1 點。
   評估必須包含「外部 Canny」對照組，否則無法證明「必須跑在 SketchUp 內部」。

## 已知限制

**記憶體競爭（互動情境中無法避免）**
MPS 是統一記憶體，而使用者按 Render 時 SketchUp 本來就開著。
實測一次生成在與其他工作同時進行時，從 60 秒拉長到 **913 秒**。
跑批（`eval/run.py`）可以事先關掉其他程式，但外掛的互動使用沒辦法這樣要求。
若要正式化，這正是把生成移到雲端的主要理由 —— 不是為了速度，是為了不跟使用者的 SketchUp 搶記憶體。

**生成品質天花板**
SD1.5 在 640² 的產出是「算圖」而不是「截圖」，但離 photoreal 還有距離。
換 SDXL 或提高解析度會改善，代價是記憶體：實測 768² 只比 640² 多 1.44 倍像素卻慢 7 倍（換頁）。

**雲端層未部署**
job 狀態機、成本護欄、Supabase schema 已完成並通過 215 個測試，
但沒有寫 Supabase adapter 也沒有部署。生成目前走本機。

**評估樣本不足**
只有 2 個程式產生的場景，缺曲面、大面積玻璃、細長構件 ——
而那些正是最容易讓結構走鐘的情境。`eval/report.md` 的數字只能當方向參考。

## 下一步

回答 [docs/open-questions.md](docs/open-questions.md)，特別是 B 節的實機驗證題。
