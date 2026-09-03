#!/usr/bin/env bash
# 依 docs/pdf.manifest 組出 PDF。
# 用法：./tools/build-pdf.sh [profile]   （預設 deliverable）
#
# 相依：node/npx（marked，首次會從網路抓）、Google Chrome（headless 列印）
set -euo pipefail
cd "$(dirname "$0")/.."

profile="${1:-deliverable}"
manifest="docs/pdf.manifest"
out="dist/$profile.pdf"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "找不到 Chrome：$CHROME" >&2; exit 1; }
command -v npx >/dev/null || { echo "需要 node/npx" >&2; exit 1; }

md="$work/all.md"; : > "$md"
title=""; subtitle=""; author=""; in_profile=0; found=0

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    "[profile:$profile]") in_profile=1; found=1; continue ;;
    "[profile:"*)         in_profile=0; continue ;;
  esac
  [ "$in_profile" -eq 1 ] || continue
  case "$line" in
    ""|"#"*)      continue ;;
    "title: "*)    title="${line#title: }" ;;
    "subtitle: "*) subtitle="${line#subtitle: }" ;;
    "author: "*)   author="${line#author: }" ;;
    "---")         printf '\n<div class="pagebreak"></div>\n\n' >> "$md" ;;
    "## "*)        printf '\n<h1 class="part">%s</h1>\n\n' "${line#\#\# }" >> "$md" ;;
    *)
      # macOS 內建 bash 3.2 沒有 globstar，改用 find 展開路徑樣式。
      # 注意 find 的 -path 中 * 也會跨越 /，樣式要寫得夠明確。
      if [ "${line#*\*}" != "$line" ]; then
        files="$(find . -type f -path "./$line" 2>/dev/null | sed 's|^\./||' | LC_ALL=C sort)"
      else
        files="$line"
      fi
      hit=0
      while IFS= read -r f; do
        [ -n "$f" ] && [ -f "$f" ] || continue
        hit=1
        printf '\n<!-- %s -->\n\n' "$f" >> "$md"
        cat "$f" >> "$md"
        printf '\n\n' >> "$md"
      done <<< "$files"
      [ "$hit" -eq 1 ] || echo "  略過（找不到）：$line" >&2
      ;;
  esac
done < "$manifest"

[ "$found" -eq 1 ] || { echo "manifest 內找不到 profile：$profile" >&2; exit 1; }

echo "→ 轉換 Markdown…"
npx -y marked -i "$md" -o "$work/body.html"

cat > "$work/print.html" <<HTML
<!doctype html><meta charset="utf-8"><title>$title</title>
<style>
 @page { size:A4; margin:20mm 18mm; }
 body{font:11pt/1.7 "PingFang TC","Helvetica Neue",sans-serif;color:#191d1f;max-width:none}
 .cover{height:230mm;display:flex;flex-direction:column;justify-content:center;gap:10px}
 .cover h1{font-size:30pt;margin:0;line-height:1.2}
 .cover .sub{font-size:14pt;color:#4a5257}
 .cover .meta{font-size:10pt;color:#79838a;margin-top:24px;font-family:"SF Mono",monospace}
 .pagebreak{break-after:page}
 h1.part{break-before:page;font-size:22pt;border-bottom:2px solid #191d1f;padding-bottom:8px;margin:0 0 18px}
 h1{font-size:19pt} h2{font-size:15pt;margin-top:1.6em} h3{font-size:12.5pt}
 h1,h2,h3{break-after:avoid}
 table{border-collapse:collapse;width:100%;font-size:9.5pt;break-inside:avoid}
 th,td{border:1px solid #d6dbd9;padding:5px 7px;text-align:left;vertical-align:top}
 th{background:#edefee}
 pre{background:#f6f7f6;border:1px solid #d6dbd9;padding:10px;font-size:9pt;overflow:hidden;white-space:pre-wrap;break-inside:avoid}
 code{font-family:"SF Mono",monospace;font-size:9.2pt;background:#f6f7f6;padding:1px 3px}
 pre code{background:none;padding:0}
 blockquote{border-left:3px solid #2a5db0;margin:0;padding-left:14px;color:#4a5257}
 img{max-width:100%}
</style>
<div class="cover">
  <h1>$title</h1>
  <div class="sub">$subtitle</div>
  <div class="meta">$author · $(date +%F) · profile: $profile</div>
</div>
<div class="pagebreak"></div>
$(cat "$work/body.html")
HTML

mkdir -p dist
echo "→ 列印 PDF…"
"$CHROME" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$PWD/$out" "file://$work/print.html" 2>/dev/null

echo "✓ $out  ($(du -h "$out" | cut -f1))"
