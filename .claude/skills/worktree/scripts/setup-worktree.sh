#!/bin/bash
# 為本 repo 建立隔離的 git worktree（base branch = main）。
#   ./setup-worktree.sh --issue <issue-number> [base-branch]
#   ./setup-worktree.sh --task  <slug>         [base-branch]
set -e

WORKTREE_DIR=".worktrees"
BASE_BRANCH="main"
MODE=""; IDENTIFIER=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --issue|-i) MODE="issue"; IDENTIFIER="$2"; shift 2 ;;
        --task|-t)  MODE="task";  IDENTIFIER="$2"; shift 2 ;;
        *)          [ -n "$1" ] && BASE_BRANCH="$1"; shift ;;
    esac
done

[ -n "$MODE" ] || { echo "Error: 需要 --issue 或 --task"; echo "  $0 --task fog-depth-calibration"; exit 1; }
[ -n "$IDENTIFIER" ] || { echo "Error: 需要識別字"; exit 1; }

ensure_worktree_dir() {
    mkdir -p "$WORKTREE_DIR"
    if ! git check-ignore -q "$WORKTREE_DIR" 2>/dev/null; then
        echo "$WORKTREE_DIR/" >> .gitignore
        echo "已將 $WORKTREE_DIR/ 加入 .gitignore"
    fi
}

create_worktree() {
    local PATH_="$1" BRANCH="$2"
    echo "抓取最新的 $BASE_BRANCH…"
    git fetch origin "$BASE_BRANCH"
    git worktree add "$PATH_" -b "$BRANCH" "origin/$BASE_BRANCH"
    # 本專案慣例：每個 branch 都有對應的決策紀錄目錄
    mkdir -p "$PATH_/docs/journal/${BRANCH//\//-}"
    echo "已建立 docs/journal/${BRANCH//\//-}/"
}

case $MODE in
  issue)
    ISSUE_NUM="${IDENTIFIER#\#}"
    [[ "$ISSUE_NUM" =~ ^[0-9]+$ ]] || { echo "Error: issue 編號必須是數字：$ISSUE_NUM"; exit 1; }
    ISSUE_TITLE=$(gh issue view "$ISSUE_NUM" --json title -q '.title' 2>/dev/null || echo "")
    [ -n "$ISSUE_TITLE" ] || { echo "Error: 讀不到 issue #${ISSUE_NUM}"; exit 1; }
    SLUG=$(echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | cut -c1-30 | sed 's/-$//')
    BRANCH_NAME="feat/issue-${ISSUE_NUM}-${SLUG}"
    WORKTREE_PATH="${WORKTREE_DIR}/issue-${ISSUE_NUM}"
    ;;
  task)
    SLUG=$(echo "$IDENTIFIER" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | cut -c1-30 | sed 's/-$//')
    [ -n "$SLUG" ] || SLUG="task-$(date +%s | shasum | cut -c1-12)"
    TODAY=$(date +%Y%m%d)
    EXISTING=$(ls -1 "$WORKTREE_DIR" 2>/dev/null | grep "^task-${TODAY}-" | sort -r | head -1 || true)
    if [ -n "$EXISTING" ]; then
        NEXT_NUM=$(( $(echo "$EXISTING" | sed "s/task-${TODAY}-//" | sed 's/^0*//') + 1 ))
    else
        NEXT_NUM=1
    fi
    TASK_ID=$(printf "%s-%03d" "$TODAY" "$NEXT_NUM")
    BRANCH_NAME="feat/${TASK_ID}-${SLUG}"
    WORKTREE_PATH="${WORKTREE_DIR}/task-${TASK_ID}"
    ;;
esac

ensure_worktree_dir

if [ -d "$WORKTREE_PATH" ]; then
    echo "worktree 已存在：$WORKTREE_PATH（分支 $(cd "$WORKTREE_PATH" && git branch --show-current)）"
    exit 0
fi
git show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null && echo "警告：本機已有分支 $BRANCH_NAME"

create_worktree "$WORKTREE_PATH" "$BRANCH_NAME"

cat <<MSG

worktree 建立完成
  路徑:   $WORKTREE_PATH
  分支:   $BRANCH_NAME
  base:   origin/$BASE_BRANCH
  紀錄:   $WORKTREE_PATH/docs/journal/${BRANCH_NAME//\//-}/

進入：cd $WORKTREE_PATH
MSG
