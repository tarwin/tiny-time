#!/bin/sh
# Renders scripts/icon.html to assets/icon.png (1024², transparent) with
# headless Chrome. Run from anywhere: sh scripts/icon.sh
set -e
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --default-background-color=00000000 --window-size=1024,1024 \
  --screenshot="$PWD/assets/icon.png" "file://$PWD/scripts/icon.html" 2>/dev/null
echo assets/icon.png
