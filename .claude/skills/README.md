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

## 本專案可能需要的 skills（待 open-questions Q20 確認）
- `sketchup-ruby-api` —— SketchUp Ruby API 的已驗證事實與已知陷阱；防止臆造 API
- `multi-controlnet-eval` —— 控制圖評估的指標定義、統計方法、報告格式
- `ruby-extension-packaging` —— RBZ 打包、SketchupExtension 註冊、簽章流程

以上尚未建立。要從別處複製既有 skills 進來，或由此新寫，請在 Q20 回覆。
