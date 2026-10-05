#!/bin/sh
# Set this project up from an empty directory: clone the decomp at the pinned
# revision and drop in the prebuilt agbcc.
#
# No sudo, nothing installed system-wide. The ARM toolchain, emscripten and node
# are already present under ~/decompfleet/shared (see tools/env.sh).
set -e

REV=037335f4c725d7c9aecdac87066f2002b4bd7e14   # pret/pokefirered, 2026-09-26
HERE=$(cd "$(dirname "$0")/.." && pwd)
SHARED="$HOME/decompfleet/shared"

if [ ! -d "$HERE/upstream/.git" ]; then
  echo "cloning pret/pokefirered @ $REV"
  git clone https://github.com/pret/pokefirered.git "$HERE/upstream"
fi
cd "$HERE/upstream"
git fetch --all --tags 2>/dev/null || true
git checkout --detach "$REV"
test "$(git rev-parse HEAD)" = "$REV" || { echo "wrong revision checked out"; exit 1; }

# agbcc is prebuilt and shared; do NOT build it again. Its binaries' hashes are
# recorded in ~/decompfleet/shared/agbcc-notes.md and in STATUS.md.
test -f "$SHARED/agbcc-install/.ok" || { echo "no verified agbcc at $SHARED/agbcc-install"; exit 1; }
rm -rf tools/agbcc
cp -R "$SHARED/agbcc-install" tools/agbcc

echo "setup done. now: sh tools/build.sh <your pokeleafgreen.gba>"
