# Pokémon LeafGreen — matching build + browser target

A byte-identical build of **Pokémon LeafGreen (USA, Europe) (Rev 1)** from the
[`pret/pokefirered`](https://github.com/pret/pokefirered) decompilation, plus a
static web page that runs it on a WebAssembly build of mGBA's core.

**You supply your own ROM.** Nothing in this repository is derived from a ROM,
and the page cannot upload yours: its Content-Security-Policy sets
`connect-src 'none'`, so the browser refuses every network request the page
could make.

See [STATUS.md](STATUS.md) for hashes, the exact toolchain, what was tested and
what was not.

## Build the ROM

```sh
sh tools/setup.sh                                  # clone upstream, install agbcc
sh tools/build.sh ~/path/to/your/pokeleafgreen.gba # build and compare
```

## Build and test the page

```sh
source tools/env.sh
cd web && make            # dist/ is the shippable page
make selftest ROM=~/path/to/your/pokeleafgreen.gba    # core, in node, muted
make browsercheck ROM=~/path/to/your/pokeleafgreen.gba # the real page, headless Chrome
```

## Controls

Arrow keys move. <kbd>Z</kbd> is A, <kbd>X</kbd> is B, <kbd>Enter</kbd> is
Start, <kbd>Shift</kbd> is Select, <kbd>A</kbd>/<kbd>S</kbd> are L/R. A standard
gamepad is picked up automatically. Sound is off until you click the speaker.
