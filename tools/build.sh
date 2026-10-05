#!/bin/sh
# Build LeafGreen (USA, Europe) (Rev 1) and prove it matches a ROM you supply.
#
#   sh tools/build.sh ~/path/to/pokeleafgreen.gba
#
# `compare_leafgreen_rev1` is the right target, not the default `make`: the
# default builds revision 0 and compares against a different hash. The compare_*
# target runs upstream's own `sha1sum -c` as part of the build, so a mismatch
# fails the build instead of quietly producing a wrong ROM. We then also `cmp`
# against your ROM, because "same hash" and "byte-identical" are not the same
# claim and this project makes the second one.
set -e

ROM="$1"
HERE=$(cd "$(dirname "$0")/.." && pwd)
SHARED="$HOME/decompfleet/shared"
TC="$SHARED/arm-bin/usr"

[ -n "$ROM" ] || { echo "usage: sh tools/build.sh <your pokeleafgreen.gba>"; exit 2; }
[ -f "$ROM" ] || { echo "no such file: $ROM"; exit 2; }

export PATH="$TC/bin:$PATH"
cd "$HERE/upstream"

make -f make_tools.mk -j"$(nproc)"
make compare_leafgreen_rev1 TOOLCHAIN="$TC" -j"$(nproc)"

OUT="$HERE/upstream/pokeleafgreen_rev1.gba"
echo
echo "built:  $(sha1sum "$OUT")"
echo "yours:  $(sha1sum "$ROM")"
if cmp "$OUT" "$ROM"; then
  echo "BYTE-IDENTICAL."
else
  echo "DIFFERS -- see cmp output above."
  exit 1
fi
