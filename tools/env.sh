# source this: puts the ARM toolchain, emscripten and node on PATH.
# No sudo, nothing installed; all three live under ~/decompfleet/shared.
export PATH="$HOME/decompfleet/shared/arm-bin/usr/bin:$PATH"
export PATH="$HOME/decompfleet/shared/emsdk/node/24.19.0_64bit/bin:$PATH"
export PATH="$HOME/decompfleet/shared/emsdk/upstream/emscripten:$PATH"
export EMSDK="$HOME/decompfleet/shared/emsdk"
export EM_CONFIG="$HOME/decompfleet/shared/emsdk/.emscripten"
