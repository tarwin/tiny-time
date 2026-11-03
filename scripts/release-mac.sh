#!/bin/sh
# Build, notarize and stage the macOS release, one CPU at a time:
#
#   sh scripts/release-mac.sh [arm64] [x86_64]     # no arch = both
#
# Needs TINYJS_SIGN_IDENTITY (a Developer ID) and TINYJS_NOTARY_PROFILE.
# Per arch it leaves in release/ (outside dist/, which each build empties):
#   tiny-time-<ver>-macos-<arch>.dmg   the download
#   tiny-time-<ver>-macos-<arch>.zip   the stapled .app, for updates
# Builds of other versions are cleared out first (they're already on their
# GitHub releases), so release/ only ever holds the one being released.
# The zip is made from the STAPLED app rather than by `tinyjs publish`,
# which rebuilds (and so re-signs) the bundle after notarization.
# Adapted from tiny-tally (itself from tinyjsapp-examples/shelf).
set -e
cd "$(dirname "$0")/.."
: "${TINYJS_SIGN_IDENTITY:?set TINYJS_SIGN_IDENTITY}"
: "${TINYJS_NOTARY_PROFILE:?set TINYJS_NOTARY_PROFILE}"
ARCHS="${*:-arm64 x86_64}"
TINYJS="${TINYJS:-tinyjs}"
field() { sed -n "s/^ *\"$1\": *\"\([^\"]*\)\".*/\1/p" tinyjs.json | head -1; }
VER="$(field version)"
NAME="$(field name)"
TITLE="$(field title)"; TITLE="${TITLE:-$NAME}"
OUT=release
mkdir -p "$OUT"
find "$OUT" -maxdepth 1 -name "$NAME-*" ! -name "$NAME-$VER-*" -delete
for ARCH in $ARCHS; do
  echo "==> $NAME $VER ($ARCH)"
  "$TINYJS" build --arch "$ARCH" --dmg
  "$TINYJS" notarize --arch "$ARCH" --dmg
  xcrun stapler validate -q "dist/$TITLE.app"
  cp "dist/$NAME-$VER-macos-$ARCH.dmg" "$OUT/"
  rm -f "$OUT/$NAME-$VER-macos-$ARCH.zip"
  ditto -c -k --keepParent "dist/$TITLE.app" "$OUT/$NAME-$VER-macos-$ARCH.zip"
  echo "    staged $NAME-$VER-macos-$ARCH.{dmg,zip}"
done
ls -la "$OUT"
echo "Upload with: gh release upload v$VER $OUT/$NAME-$VER-macos-*"
