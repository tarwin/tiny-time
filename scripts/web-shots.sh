#!/bin/sh
# Screenshots for the microsite, from scripts/screenshots.sh's PNGs: WebPs at
# most 1600px wide for the page (<name>.webp) plus full-size ones for its
# gallery (<name>-full.webp), in $MICROSITE/tiny-time/shots/. Commit there.
#
#   sh scripts/web-shots.sh [screenshots dir]
set -e
cd "$(dirname "$0")/.."
IN=${1:-screenshots}
SITE=${MICROSITE:-../tarwin-apps-microsites}
command -v cwebp >/dev/null || { echo "Needs cwebp (brew install webp)." >&2; exit 1; }
OUT="$SITE/tiny-time/shots"
mkdir -p "$OUT"
for png in "$IN"/*.png; do
  name=$(basename "$png" .png)
  w=$(sips -g pixelWidth "$png" | awk '/pixelWidth/ {print $2}')
  if [ "$w" -gt 1600 ]; then resize="-resize 1600 0"; else resize=""; fi
  cwebp -quiet -q 82 $resize "$png" -o "$OUT/$name.webp"
  cwebp -quiet -q 80 "$png" -o "$OUT/$name-full.webp"
done
sips -Z 256 assets/icon.png --out "$SITE/shared/icons/tiny-time.png" >/dev/null
echo "Wrote $OUT/ and shared/icons/tiny-time.png"
