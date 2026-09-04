# 專案 Skills

放置與本專案相關的 Claude Code skills。

## 慣例
每個 skill 一個目錄，內含 `SKILL.md`：

```
.claude/skills/
  <skill-name>/
    SKILL.md        # frontmatter 需有 name 與 description
    references/     # 選用，較長的參考資料
```

`SKILL.md` frontmatter：
```yaml
---
name: skill-name
description: 何時該使用這個 skill（寫成觸發條件，不是功能描述）
---
```

## 目前有的 skills

| skill | 來源 | 用途 |
|---|---|---|
| `worktree` | 取自 duotopia，已改寫 | 開隔離開發環境；base branch 改為 `main`，並自動建立 `docs/journal/<branch>/` |
| `sketchup-api-verify` | 本專案新寫 | **碰 SketchUp Ruby API 前必讀**。V1–V8 實機驗證腳本，強制「不臆造 API」 |
| `control-map-eval` | 本專案新寫 | 評估設計、變因鎖定、統計方法；含「B 組不可省略」的理由 |

## 刻意還沒放進來的

- **`fix-review` / `fix-workflow`**（duotopia 有）—— 這兩個整份在解析 GitHub Actions 的
  Black / Flake8 / pytest / ESLint / tsc 失敗。本 repo 目前沒有程式碼、沒有測試、沒有 CI，
  照抄會是 900 行指向不存在工具鏈的設定。**等 Day 0 下午開始寫擷取流程、有了 Ruby 測試
  與 Vercel 側之後，再照實際工具鏈改寫移植。**
- `ruby-extension-packaging`（RBZ 打包、簽章）—— 交付形式已定為 (b)，不做 RBZ，暫不需要。
