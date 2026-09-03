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
3. **edge/depth 這兩張控制圖，外部工具用單張截圖也做得出來** —— 見 critique.md 第 1 點。
   評估必須包含「外部 Canny」對照組，否則無法證明「必須跑在 SketchUp 內部」。

## 下一步

回答 [docs/open-questions.md](docs/open-questions.md)，特別是 B 節的實機驗證題。
