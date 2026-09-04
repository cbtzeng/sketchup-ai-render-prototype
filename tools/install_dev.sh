#!/usr/bin/env bash
# 用符號連結把外掛裝進 SketchUp，這樣改程式碼不用重裝。
#
#   ./tools/install_dev.sh          安裝
#   ./tools/install_dev.sh --remove 移除
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"

PLUGINS="$HOME/Library/Application Support/SketchUp 2026/SketchUp/Plugins"
[ -d "$PLUGINS" ] || { echo "找不到 Plugins 目錄：$PLUGINS"; exit 1; }

LOADER="$PLUGINS/architech_render.rb"
DIR="$PLUGINS/architech_render"

if [ "${1:-}" = "--remove" ]; then
  for p in "$LOADER" "$DIR"; do
    if [ -L "$p" ]; then rm "$p"; echo "已移除連結 $p"
    elif [ -e "$p" ]; then echo "！$p 不是符號連結，為安全起見不動它"; fi
  done
  echo "移除完成。SketchUp 需重新啟動才會生效。"
  exit 0
fi

for p in "$LOADER" "$DIR"; do
  if [ -e "$p" ] && [ ! -L "$p" ]; then
    echo "！$p 已存在且不是符號連結。請先自行處理，避免覆蓋你的東西。"; exit 1
  fi
  [ -L "$p" ] && rm "$p"
done

ln -s "$REPO/src/architech_render.rb" "$LOADER"
ln -s "$REPO/src/architech_render"    "$DIR"

cat <<MSG

安裝完成（符號連結，改程式碼不用重裝）
  $LOADER
    → $REPO/src/architech_render.rb
  $DIR
    → $REPO/src/architech_render

下一步：
  1. 重新啟動 SketchUp
  2. 選單應該出現 Extensions → Architech Render
  3. 若沒出現，開 Ruby Console 看有沒有載入錯誤

注意：SketchUp 的「載入政策」若設為僅載入已識別的擴充功能，
未簽章的外掛會被擋。原型階段請設為允許所有擴充功能
（SketchUp → Settings → Extensions → Loading Policy）。
MSG
