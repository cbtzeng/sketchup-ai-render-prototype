# journal — 逐 branch 的決策紀錄

## 為什麼需要這個目錄

Claude Code 的對話逐字稿**不在這個 repo 裡**。它寫在：

```
~/.claude/projects/-Users-benson-sketch-up-202609/<session-uuid>.jsonl
```

以 **session UUID** 命名，不是以 branch 命名，也不進版控。切 branch 不會產生新檔案，
開新 session 才會。所以「不同 branch 的重要對話分開記錄」這件事，工具不會自動幫你做。

這個目錄就是人工做這件事的地方。

## 逐字稿 vs 決策紀錄

| | 逐字稿 (.jsonl) | 決策紀錄 (本目錄) |
|---|---|---|
| 內容 | 發生了什麼，含全部工具輸出 | 決定了什麼、為什麼 |
| 大小 | 數百 KB 起跳 | 一頁以內 |
| 可 review | 否 | 是，可 diff、可進 PR |
| 進 PDF | 否 | 是 |

**不要把逐字稿原封不動 commit 進來。** 面試作業的評分者會看這個 repo，
一份「fog 線性度這件事我考慮過 A/B/C，選了 B，因為⋯⋯」的紀錄，
價值遠高於 250KB 的原始對話。逐字稿是原料，決策紀錄才是成品。

## 慣例

```
docs/journal/
  _TEMPLATE.md
  _raw/                       # 原始逐字稿存放處，已 gitignore
  main/
    000-planning.md
  feat-fog-calibration/       # 目錄名 = branch 名（/ 換成 -）
    001-fog-標定結果.md
```

- **開 branch 時**建目錄，內容可以之後補。
- **做完一個決策時**寫一篇，不是每次對話都寫。
  判斷門檻：**這個決定之後會不會被質疑？** 會，就寫。
- 檔名前綴的三位數字是**全 repo 遞增**，不是每個 branch 各自從 001 開始 ——
  這樣合併回 main 之後仍能看出時間順序。
- **PR 描述**連結該 branch 底下的紀錄，review 的人先看紀錄再看 diff。

## 這個專案一定要寫的兩篇

1. **fog 深度標定結果**（open-questions Q12）—— 決定 depth pass 留不留。
2. **write_image 寬高比行為與對齊方案**（Q11）—— 決定三 pass 能不能像素對齊。

這兩件事的結論會改變架構，不寫下來，兩週後你會忘記為什麼當初這樣選。

## 新增一篇

```bash
./tools/journal-new.sh "fog 標定結果"
```

依當前 branch 自動建目錄、取下一個編號、套用範本。
