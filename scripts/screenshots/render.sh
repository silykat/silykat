#!/bin/sh
# Renders the mockups of the user guide's screenshots (one HTML page each) to docs/guide/images/*.webp.
# Needs Google Chrome (headless) and cwebp (brew install webp). Usage: scripts/screenshots/render.sh [name…]
# Icons: @vscode/codicons (CC BY 4.0, Microsoft).
set -e
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OUT=../../docs/guide/images
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
size() {
  case "$1" in
    claude-and-vscode) echo 1600,760 ;;
    new-comment) echo 1000,375 ;;
    agent-replies) echo 1100,668 ;;
    channels-warning) echo 900,300 ;;
    review-menu) echo 1100,520 ;;
    diff-thread) echo 1300,372 ;;
    outdated-thread) echo 1000,372 ;;
    agent-sessions) echo 1000,330 ;;
    retro-discussion) echo 1300,790 ;;
    *) echo 1200,800 ;;
  esac
}
names="$*"
[ -z "$names" ] && names=$(ls *.html | sed 's/\.html$//')
mkdir -p "$OUT"
for n in $names; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size="$(size "$n")" --virtual-time-budget=5000 --screenshot="$TMP/$n.png" "file://$PWD/$n.html" >/dev/null 2>&1
  cwebp -quiet -q 90 "$TMP/$n.png" -o "$OUT/$n.webp"
  echo "$OUT/$n.webp $(wc -c < "$OUT/$n.webp" | tr -d ' ') bytes"
done
