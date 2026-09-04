#!/bin/bash
# 清除 worktree。
#   ./cleanup-worktree.sh --issue <n> | --task <YYYYMMDD-NNN> | <identifier>
set -e

WORKTREE_DIR=".worktrees"; MODE=""; IDENTIFIER=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --issue|-i) MODE="issue"; IDENTIFIER="$2"; shift 2 ;;
        --task|-t)  MODE="task";  IDENTIFIER="$2"; shift 2 ;;
        *)          IDENTIFIER="$1"; shift ;;
    esac
done

[ -n "$IDENTIFIER" ] || { echo "Error: 需要識別字（issue 編號或 task id）"; exit 1; }

if [ -z "$MODE" ]; then
    IDENTIFIER="${IDENTIFIER#\#}"
    if   [[ "$IDENTIFIER" =~ ^[0-9]{8}-[0-9]{3}$ ]]; then MODE="task"
    elif [[ "$IDENTIFIER" =~ ^[0-9]+$ ]];             then MODE="issue"
    else echo "Error: 無法判斷型別：$IDENTIFIER（請用 --issue / --task）"; exit 1; fi
fi

case $MODE in
    issue) WORKTREE_PATH="${WORKTREE_DIR}/issue-${IDENTIFIER#\#}" ;;
    task)  WORKTREE_PATH="${WORKTREE_DIR}/task-${IDENTIFIER}" ;;
esac

[ -d "$WORKTREE_PATH" ] || { echo "找不到 worktree：$WORKTREE_PATH"; echo; git worktree list; exit 1; }

BRANCH_NAME=$(cd "$WORKTREE_PATH" && git branch --show-current)

# 本專案特有：決策紀錄還沒寫就清掉，等於把實驗結果丟了
JOURNAL_DIR="$WORKTREE_PATH/docs/journal/${BRANCH_NAME//\//-}"
if [ -d "$JOURNAL_DIR" ] && [ -z "$(ls -A "$JOURNAL_DIR" 2>/dev/null)" ]; then
    echo "警告：$BRANCH_NAME 沒有任何決策紀錄。"
    echo "      如果這個 branch 有實驗結果或架構決定，清掉就沒了。"
    read -p "仍要繼續？(y/N) " -n 1 -r; echo
    [[ $REPLY =~ ^[Yy]$ ]] || { echo "已中止。"; exit 1; }
fi

if [ -n "$(cd "$WORKTREE_PATH" && git status --porcelain)" ]; then
    echo "警告：worktree 有未提交的變更："
    (cd "$WORKTREE_PATH" && git status --short)
    read -p "捨棄並移除？(y/N) " -n 1 -r; echo
    [[ $REPLY =~ ^[Yy]$ ]] || { echo "已中止。"; exit 1; }
fi

echo "移除 $WORKTREE_PATH…"
git worktree remove "$WORKTREE_PATH" --force

if [ -n "$BRANCH_NAME" ] && git show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
    read -p "刪除本機分支 $BRANCH_NAME？(y/N) " -n 1 -r; echo
    [[ $REPLY =~ ^[Yy]$ ]] && git branch -D "$BRANCH_NAME"
fi

echo; echo "完成。剩餘 worktree："; git worktree list
