#!/bin/sh
# Screenshots of every part of the app, on demo data (macOS):
#
#   sh scripts/screenshots.sh [out-dir]      # default: screenshots/
#
# Starts `tinyjs dev` with TINYTIME_TOUR set: the app makes demo data in a
# temp folder (your own data and settings are left alone) and steps through
# its screens (runTour in src/backend/main.js). For each one it writes
# shot.json; this captures that window as <out>/<name>.png and answers with
# done-<seq>. Needs Screen Recording permission for the terminal. Quit any
# other copy of Tiny Time first: two would both put a timer in the menu bar.
set -e
cd "$(dirname "$0")/.."
OUT="${1:-screenshots}"
mkdir -p "$OUT"
TOUR="$(mktemp -d)"
swiftc -O scripts/window-id.swift -o "$TOUR/window-id" 2>/dev/null

TINYTIME_TOUR="$TOUR" tinyjs dev > "$TOUR/dev.log" 2>&1 &
DEV=$!
trap 'kill "$DEV" 2>/dev/null || true; pkill -f "tiny-time/.build/app/entry.js" 2>/dev/null || true' EXIT

seen=0
for _ in $(seq 1 900); do
  [ -f "$TOUR/finished" ] && break
  if [ -f "$TOUR/shot.json" ]; then
    seq=$(sed -n 's/.*"seq":\([0-9]*\).*/\1/p' "$TOUR/shot.json")
    name=$(sed -n 's/.*"name":"\([^"]*\)".*/\1/p' "$TOUR/shot.json")
    win=$(sed -n 's/.*"win":"\([^"]*\)".*/\1/p' "$TOUR/shot.json")
    if [ -n "$seq" ] && [ "$seq" != "$seen" ]; then
      title="Tiny Time"; [ "$win" = pop ] && title="Tiny Time Popover"
      id=$("$TOUR/window-id" "$title")
      if [ -z "$id" ]; then echo "no window titled \"$title\" for $name" >&2; exit 1; fi
      screencapture -x -o -l "$id" "$OUT/$name.png"
      echo "  $name"
      : > "$TOUR/done-$seq"
      seen=$seq
    fi
  fi
  sleep 0.2
done
[ -f "$TOUR/finished" ] || { echo "The tour didn't finish; see $TOUR/dev.log" >&2; exit 1; }
echo "Saved $(ls "$OUT"/*.png | wc -l | tr -d ' ') screenshots to $OUT/"
