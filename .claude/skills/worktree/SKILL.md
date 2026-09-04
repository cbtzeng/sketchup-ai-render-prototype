---
name: worktree
description: |
  Create an isolated git worktree for development on this repo. Triggered by
  "開 worktree", "用 worktree", "worktree 處理", "worktree 隔離",
  or "handle issue / fix issue / work on issue".
  Accepts GitHub issue numbers or a free-form task description.
  Also creates the matching docs/journal/<branch>/ directory for decision records.
argument-hint: "<issue-number(s)> | <task-description>"
disable-model-invocation: false
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, WebFetch
---

# Worktree Skill

Create isolated git worktrees for parallel, focused development. Two modes:

1. **GitHub Issue Mode** — input matches issue numbers
2. **General Task Mode** — input is a task description

**Announce at start:** "I'm using the worktree skill to set up an isolated development environment."

## Project specifics

| | 本專案 |
|---|---|
| Base branch | `main`（本 repo 沒有 staging） |
| 相依安裝 | 無。Ruby 由 SketchUp 內建（3.2.2），雲端層在 `cloud/`（若已建立則 `npm ci`） |
| 測試 | 規劃階段尚無測試。有了之後填入 4.3 |
| 決策紀錄 | **每個 worktree 必須有對應的 `docs/journal/<branch>/`** |

## Current Context

- **Repository**: !`basename $(git rev-parse --show-toplevel)`
- **Current branch**: !`git branch --show-current`
- **Worktrees**: !`git worktree list 2>/dev/null | head -5`

## Mode Detection

```
Input: $ARGUMENTS
    ├─ Matches /^#?\d+(\s+#?\d+)*$/ → GitHub Issue Mode
    └─ Any other text              → General Task Mode
```

---

# Phase 1: Setup

## Issue Mode

```bash
ISSUE_NUM="${ISSUE_NUM#\#}"
[[ "$ISSUE_NUM" =~ ^[0-9]+$ ]] || { echo "Issue number must be numeric"; exit 1; }

ISSUE_TITLE=$(gh issue view "$ISSUE_NUM" --json title -q '.title')
ISSUE_SLUG=$(echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | cut -c1-30 | sed 's/-$//')
BRANCH_NAME="feat/issue-${ISSUE_NUM}-${ISSUE_SLUG}"

git fetch origin main
git worktree add ".worktrees/issue-${ISSUE_NUM}" -b "$BRANCH_NAME" origin/main
```

## Task Mode

```bash
TODAY=$(date +%Y%m%d)
EXISTING=$(ls -1 .worktrees 2>/dev/null | grep "^task-${TODAY}-" | sort -r | head -1 || true)
NEXT_NUM=$([ -n "$EXISTING" ] && echo $(( $(echo "$EXISTING" | sed "s/task-${TODAY}-//" | sed 's/^0*//') + 1 )) || echo 1)
TASK_ID=$(printf "%s-%03d" "$TODAY" "$NEXT_NUM")

BRANCH_NAME="feat/${TASK_ID}-${TASK_SLUG}"
git fetch origin main
git worktree add ".worktrees/task-${TASK_ID}" -b "$BRANCH_NAME" origin/main
```

Slug 範例：

| 輸入 | slug |
|---|---|
| fog 深度標定 | fog-depth-calibration |
| write_image 對齊驗證 | verify-write-image-alignment |
| 接 fal.ai adapter | add-fal-adapter |

## 1.x 建立決策紀錄目錄（本專案必做）

```bash
cd "$WORKTREE_PATH"
mkdir -p "docs/journal/${BRANCH_NAME//\//-}"
```

不需要馬上寫內容，但目錄要在。見 `docs/journal/README.md`。

---

# Phase 2: Analyze

Issue mode：`gh issue view "$ISSUE_NUM" --json title,body,labels,comments`

檢查清單：
- [ ] 問題陳述與驗收標準
- [ ] 這件事會不會改變 `docs/spec.md` 的驗收標準或 `docs/architecture.md` 的狀態機？會的話先講。
- [ ] 是否涉及 `docs/sketchup-api-feasibility.md` 中標記 🔴 的項目？**是的話必須先實機驗證，不得先寫程式碼。**

---

# Phase 3: Present Plan（必須停下來等核准）

```markdown
## [Issue #<NUM> | Task <TASK_ID>]: <Title>

### Problem Summary
### Proposed Solution
### Files to Modify
### Test Plan
### 影響到的既有文件
- docs/spec.md / architecture.md / feasibility 的哪一節會需要改？
### Questions

---
**Worktree**: `.worktrees/...`　**Branch**: `feat/...`
**Journal**: `docs/journal/<branch>/`
```

**不要在使用者核准前進入 Phase 4。**

---

# Phase 4: Implement（核准後）

1. **Red** — 先寫失敗的測試
2. **Green** — 最小實作讓測試通過
3. **Refactor**

## 4.3 測試

```bash
# 規劃階段尚無測試套件。建立後在此填入：
# Ruby:  ruby -Ilib -Itest test/**/*_test.rb
# Cloud: cd cloud && npm test
```

## 4.4 寫決策紀錄（本專案必做）

做完後、開 PR 前：

```bash
./tools/journal-new.sh "這次決定了什麼"
```

門檻：**這個決定之後會不會被質疑？** 會，就寫。fog 標定、write_image 對齊這類實驗結果一定要寫。

## 4.5 Commit & Push

```bash
git commit -m "feat: <description> (Related to #${ISSUE_NUM})

Co-Authored-By: Claude <noreply@anthropic.com>"
git push -u origin "$BRANCH_NAME"
```

---

# Worktree Management

```bash
git worktree list                          # 列出
.claude/skills/worktree/scripts/setup-worktree.sh --task <slug>
.claude/skills/worktree/scripts/cleanup-worktree.sh <identifier>
```

---

# Red Flags — Never Do These

- 沒先提計畫就開始實作
- 在主工作區工作而不是 worktree
- 從 `main` 以外的分支開（本 repo 只有 main）
- **對 `sketchup-api-feasibility.md` 標 🔴 的項目先寫程式碼再驗證**
- **合併前沒寫決策紀錄**（實驗結果類的 branch）
- 臆造 SketchUp Ruby API 名稱 —— 見 CLAUDE.md
