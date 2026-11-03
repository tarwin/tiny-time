#!/bin/bash
# Package Tiny Time for Linux. Runs INSIDE an ubuntu:22.04 container: the
# linker bakes the build machine's glibc into the binaries, and 22.04 keeps
# that at 2.35 so the tarball loads on Ubuntu 22.04 / Debian 12 and newer.
# Adapted from tiny-tally (itself from tinyjsapp-examples/shelf).
#
#   docker run --rm -v $PWD:/src:ro -v $OUT:/work -e TINYJS_TAG=v0.68.0 \
#     ubuntu:22.04 bash /src/scripts/pkg-linux-container.sh
#
# Output: /work/out/tiny-time-<ver>-linux-<arch>.tar.gz
set -euo pipefail
: "${TINYJS_TAG:?set TINYJS_TAG to the tinyjs release to build against (e.g. v0.68.0)}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git xz-utils build-essential pkg-config binutils \
  libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  libx11-dev libxtst-dev libpipewire-0.3-dev >/dev/null

ARCH=$(uname -m); case "$ARCH" in aarch64) ARCH=arm64;; esac

cd /work && rm -rf tinyjsapp app out && mkdir -p out
git clone -q --depth 1 --branch "$TINYJS_TAG" https://github.com/tarwin/tinyjsapp.git
(cd tinyjsapp && TINYJS_TJS_RELEASE="$TINYJS_TAG" ./setup.sh >/dev/null)

floor_ok() { # <binary>: glibc floor must stay <= 2.35 (Ubuntu 22.04)
  local top; top=$(objdump -T "$1" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)
  case "$top" in GLIBC_2.3[0-5]|GLIBC_2.[12]*) return 0;; *) echo "FLOOR REGRESSION: $1 needs $top"; return 1;; esac
}
floor_ok tinyjsapp/bin/tjs && floor_ok tinyjsapp/native/launcher-linux

# A clean copy (no npm dependencies: plain JS, nothing to install).
mkdir app && (cd /src && tar --exclude=./dist --exclude=./.build --exclude=./release --exclude=./screenshots -cf - .) | tar -xf - -C app
cd app
/work/tinyjsapp/tinyjs publish

tb=$(ls dist/publish/*-linux-$ARCH.tar.gz)
name=$(basename "$tb" | sed 's/-[0-9].*//')
# Check what actually landed in the tarball, not just the toolchain.
rm -rf /tmp/tc && mkdir /tmp/tc && tar -xzf "$tb" -C /tmp/tc
floor_ok "/tmp/tc/$name/$name"
floor_ok "/tmp/tc/$name/launcher"
cp "$tb" /work/out/
echo "packaged: $(basename "$tb")"
