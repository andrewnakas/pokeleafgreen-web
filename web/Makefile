# Browser target for pokeleafgreen.
#
# Builds mGBA's mCore to wasm plus a small shim, and emits a static page that
# takes the user's own ROM from a file picker. No ROM, and no bytes extracted
# from one, are produced or consumed by this Makefile.
#
#   make            build dist/ (the shippable page)
#   make test       also build the node-side core test harness
#   make selftest   run the muted core self-test against ~/decompfleet/roms
#   make browsercheck   run the real page in headless Chrome
#   make clean
#
# The mGBA static library is SHARED with the pokeruby agent (it is GBA-generic
# and already built); we link it rather than rebuilding ~1 GB of mGBA.

MGBA      ?= $(HOME)/decompfleet/games/pokeruby/ref/mgba
MGBA_BUILD = $(MGBA)/build-wasm
LIBMGBA    = $(MGBA_BUILD)/libmgba.a
ROMS      ?= $(HOME)/decompfleet/roms
ROM       ?= $(ROMS)/pokeleafgreen.gba
SHOTS     ?=

# The shim reads struct mCore through mGBA's headers, so it MUST be compiled
# with the same -D set as libmgba.a or the fields land at different offsets and
# every vtable entry reads back as NULL -- at runtime, with no link error.
# Derived from the build rather than hand-copied, because hand-copying it is
# exactly how that bug gets in.
MGBA_DEFS = $(shell sed -n 's/^C_DEFINES = //p' $(MGBA_BUILD)/CMakeFiles/mgba.dir/flags.make)

CPPFLAGS = -I $(MGBA)/include -I $(MGBA)/src -I $(MGBA_BUILD)/include \
           -D_GNU_SOURCE -DPATH_MAX=4096 -DDISABLE_THREADING $(MGBA_DEFS)

# No audio device, no filesystem, no GL: the page owns the canvas and only
# creates an AudioContext if the user explicitly unmutes.
#
# SINGLE_FILE=1 is a security decision, not a packaging one. It base64-embeds
# the wasm into the .js, so the page never calls fetch() for it, which lets the
# Content-Security-Policy say `connect-src 'none'` -- the browser then refuses
# every fetch/XHR/WebSocket/sendBeacon from the page, to any origin including
# its own. That is a boundary the page cannot talk its way out of, as opposed to
# monkey-patching window.fetch, which any later script can undo.
EMFLAGS = -s MODULARIZE=1 -s EXPORT_NAME=createGBA \
          -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=64MB \
          -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","HEAPU8","HEAPU32","HEAP16"]' \
          -s EXPORTED_FUNCTIONS='["_malloc","_free"]' \
          -s FILESYSTEM=0

.PHONY: all test selftest browsercheck check clean checklib

all: dist/pokeleafgreen.js dist/index.html dist/app.js

checklib:
	@test -f $(LIBMGBA) || { \
	  echo "missing $(LIBMGBA)"; \
	  echo "that is the pokeruby agent's shared mGBA wasm build; see ../STATUS.md"; \
	  exit 1; }
	@test -n "$(MGBA_DEFS)" || { \
	  echo "could not read C_DEFINES from the mgba build; refusing to build with"; \
	  echo "mismatched struct layouts (every mCore function pointer would be NULL)"; \
	  exit 1; }

dist/pokeleafgreen.js: src/shim.c $(LIBMGBA) Makefile | checklib
	@mkdir -p dist
	emcc -O3 $< $(LIBMGBA) $(CPPFLAGS) -o $@ $(EMFLAGS) -s ENVIRONMENT=web -s SINGLE_FILE=1
	@# The CSP promise above is only true if nothing fetches the wasm at runtime.
	@# Assert it instead of trusting the flag.
	@test ! -f dist/pokeleafgreen.wasm || { \
	  echo "SINGLE_FILE did not embed the wasm; connect-src 'none' would break the page"; \
	  exit 1; }

dist/index.html: src/index.html
	@mkdir -p dist
	cp $< $@

dist/app.js: src/app.js
	@mkdir -p dist
	cp $< $@

test: test/core-node.js

test/core-node.js: src/shim.c $(LIBMGBA) Makefile | checklib
	@mkdir -p test
	emcc -O2 $< $(LIBMGBA) $(CPPFLAGS) -o $@ $(EMFLAGS) -s ENVIRONMENT=node

# Core-level, outside a browser. Fast; isolates core bugs from page bugs, and
# this is where the symbol-gated "did it actually reach the overworld" check
# lives, because it needs thousands of frames.
selftest: test/core-node.js
	node test/core-smoke.mjs $(ROM) 1800

# The real page in headless Chrome, ROM fed through the actual file picker.
browsercheck: all
	./test/run-browser-check.sh $(ROM) $(SHOTS)

check: selftest browsercheck

clean:
	rm -rf dist test/core-node.js test/core-node.wasm
