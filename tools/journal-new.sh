#!/usr/bin/env bash
# 依當前 git branch 建立一篇新的決策紀錄。
# 用法：./tools/journal-new.sh "標題"
set -euo pipefail
cd "$(dirname "$0")/.."

[ $# -ge 1 ] || { echo "用法：$0 \"標題\"" >&2; exit 1; }
title="$1"

branch="$(git rev-parse --abbrev-ref HEAD)"
dir="docs/journal/${branch//\//-}"
mkdir -p "$dir"

# 編號全 repo 遞增，合併回 main 後仍看得出時間順序
last="$(find docs/journal -name '[0-9][0-9][0-9]-*.md' -exec basename {} \; 2>/dev/null \
        | cut -d- -f1 | sort -n | tail -1)"
next="$(printf '%03d' $((10#${last:-0} + 1)))"

slug="$(echo "$title" | tr ' /' '--' | tr -d ':?*"<>|')"
file="$dir/$next-$slug.md"
[ -e "$file" ] && { echo "已存在：$file" >&2; exit 1; }

sed -e "s|<branch 名>|$branch|" \
    -e "s|YYYY-MM-DD|$(date +%F)|" \
    -e "s|# <一句話標題：決定了什麼>|# $title|" \
    docs/journal/_TEMPLATE.md > "$file"

echo "$file"
