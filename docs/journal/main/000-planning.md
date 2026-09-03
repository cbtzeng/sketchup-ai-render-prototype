---
branch: main
date: 2026-09-03
status: decided
---

# 規劃階段：確立「多重控制圖」為待驗證假設，而非設計前提

## 背景
Architech AI 面試作業。初始論點是「外掛跑在 SketchUp 內部可取得 3D 資訊，
做 beauty / hidden-line / fog depth 多重控制，換取更高結構保真度」。

## 決定
1. 把論點當成**可否證的假設 H1/H2**，設計配對實驗證明或推翻，而不是直接實作。
2. 評估**必須包含 B 組**（img2img + 從截圖跑的 Canny）作為對照。
3. 產品文件全部先寫完再動工，Ruby API 的不確定項一律標記而非臆測。

## 理由
- 多重控制若打不贏外部 Canny，「必須跑在 SketchUp 內部」這個核心論點就不成立。
  少了 B 組，整份報告無法回答這個問題，在面試中會被一句話問倒。
- SketchUp 沒有 depth buffer，fog 深度是 workaround，其線性度未經驗證 ——
  在標定完成前，它是假設不是前提。

## 被否決的選項為什麼不行
- **直接實作再說**：fog 若非線性，depth pass 要重做，前面寫的擷取程式碼白費。
- **只比 A vs C（跳過 B）**：數字會很漂亮，但無法排除「外部工具也做得到」，等於沒證明。

## 證據
- 本機掃描確認：SketchUp 2026 (26.2.242)、Ruby **3.2.2**（原假設 2.7 有誤）、
  bundle 內含 OpenSSL 3.1.0。
- 發現 SketchUp 2026 內建 `su_diffusion`（Trimble 自家 AI Render），
  為原生 C++/Qt 擴充 + 加密 `.rbe`，可直接取得 Ruby API 拿不到的 depth buffer。
  → 差異化不能建立在「取得 3D 資訊」本身。見 `docs/critique.md` 第 5 點。

## 未解 / 後續
`docs/open-questions.md` 全部 20 題，其中 Q11（write_image 寬高比）與
Q12（fog 標定）會改變架構，必須在動工前完成。
