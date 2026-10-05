# pokeleafgreen — status

_2026-10-05. Linux, no root. Everything below was run on this box._

**Done: the build is byte-identical to the staged ROM; the browser page passes 34/34 headless
checks and the core passes 21/21 in node, muted throughout; and a save made from the game's own
SAVE menu survives a page reload, after which the game reports `SAVE_STATUS_OK` and continues onto
the exact tile that was saved.**

This verifies what `pokefirered`'s STATUS.md left open. That file said LeafGreen "builds in the same
tree but that is unverified." **It is now verified**, at the same pinned revision, with no deviation
and no patches: `make compare_leafgreen_rev1` produces sha1
`7862c67bdecbe21d1d69ce082ce34327e1c6ed5e`, which is the staged ROM byte for byte.

The browser target is **not** EmulatorJS. It is a direct emscripten build of mGBA's `mCore`, the
stack `pokeruby` built, so none of the EmulatorJS traps apply — there is no `beforeunload`-destroys-
the-save bug here because there is no EmulatorJS and no emscripten filesystem (`FILESYSTEM=0`).

---

## 1. The matching build

| | |
|---|---|
| Upstream | `https://github.com/pret/pokefirered` |
| **Pinned revision** | **`037335f4c725d7c9aecdac87066f2002b4bd7e14`** (2026-09-26, "Audio improvements (#774)") |
| Make target | `compare_leafgreen_rev1` (= `GAME_VERSION=LEAFGREEN GAME_REVISION=1 COMPARE=1`) |
| Clean build time | 13.2 s wall / 49 s CPU at `-j12`, 649 objects |

Same revision as `pokefirered` used, deliberately — **no deviation to report.**

### Hashes

| | sha1 | md5 | bytes |
|---|---|---|---|
| Staged ROM `~/decompfleet/roms/pokeleafgreen.gba` | `7862c67bdecbe21d1d69ce082ce34327e1c6ed5e` | `9d33a02159e018d09073e700e1fd10fd` | 16777216 |
| Built `upstream/pokeleafgreen_rev1.gba` | `7862c67bdecbe21d1d69ce082ce34327e1c6ed5e` | `9d33a02159e018d09073e700e1fd10fd` | 16777216 |

`cmp` reports no differences. **Byte-identical, not merely same-hash.** Verified three ways: the
build's own `sha1sum -c` (which is what `compare_*` runs, so a mismatch fails the build), an
independent `cmp` against the staged ROM afterwards, and a second run from a wiped build tree.

### Cross-checked against upstream's own `.sha1` files before building anything

`leafgreen_rev1.sha1` at the pinned revision reads:

```
7862c67bdecbe21d1d69ce082ce34327e1c6ed5e  pokeleafgreen_rev1.gba
```

That is exactly the staged ROM. The ROM header agrees independently: bytes at `0xA0` read
`POKEMON LEAFBPGE` (game code **BPGE**) and the revision byte at `0xBC` reads **1**. So rev1 is the
right target; the default `make` would have built revision 0 and compared against
`574fa542ffebb14be69902d1d36f1ec0a4afd71e`. All three LeafGreen targets upstream documents:

```
7862c67bdecbe21d1d69ce082ce34327e1c6ed5e  pokeleafgreen_rev1.gba    <- the staged ROM
574fa542ffebb14be69902d1d36f1ec0a4afd71e  pokeleafgreen.gba          (rev 0)
62b9fc77549dbc67032eb6cbd0ea6ad3b825690f  pokeleafgreen_switch.gba
```

### Toolchain — all shared, nothing rebuilt

| Piece | Version | Where it came from |
|---|---|---|
| agbcc | prebuilt, `~/decompfleet/shared/agbcc-install` | shared; **not rebuilt**, per agbcc-notes.md |
| ARM binutils | 2.45.50.20251209-1ubuntu1+23build1 | shared `arm-bin` prefix |
| `arm-none-eabi-cpp` / `-gcc` | 14.2.1 20241119 (`15:14.2.rel1-1`) | shared `arm-bin` prefix |
| host gcc/g++ | 15.2.0 (Ubuntu 26.04) | system |
| GNU Make | 4.4.1 | system |
| libpng | 1.6.57-1 | system, for `gbagfx`/`rsfont` |
| python | 3.14.4 | system |
| emscripten | 4.0.10 (`b7dc6e57`) | shared emsdk |
| node | 24.19.0 | bundled with the shared emsdk |
| mGBA | `68cf79fe55257b61efaeea87c83de69aab01f963` | **linked from pokeruby's prebuilt `libmgba.a`**, not rebuilt |
| Chrome | 151.0.7922.108 (headless, software GL) | system |

agbcc binaries were checked against the hashes in `shared/agbcc-notes.md` before use; all five
match, so nobody has replaced them:

```
2879a669aa0059ccf9ff672a856d1e84061ec20c  bin/agbcc
bf57ac04c2ab11324c4c967d52dd1a07fdf94ca6  bin/agbcc_arm
73d003e6de3f8f4f0a5b8f63b6bf70f580388491  bin/old_agbcc
b3969bb1ffbe48071073e9c1b58d7807c63ebd41  lib/libc.a
c61ad82531caa6e661ba0aadafc898b86e128793  lib/libgcc.a
```

**Zero patches** to agbcc, to the game tree or to the host tools. The host tools built clean under
gcc 15 with their own `-Werror` intact, first try, in 10 s. `pokefirered`'s notes were accurate in
every particular; this target cost almost nothing because of them.

### Reproducing

```sh
sh tools/setup.sh                                   # clone @ pinned rev, drop in shared agbcc
sh tools/build.sh ~/decompfleet/roms/pokeleafgreen.gba
```

---

## 2. The browser target

**Shipped: the matching ROM running on a direct emscripten build of mGBA's `mCore`** — the stack
`pokeruby` built and documented, chosen over EmulatorJS as instructed. Three static files:

```
dist/index.html          6.8 KB   a3eeaed87717b2f7d6a50e821ac69c3137a1098b
dist/app.js             21.8 KB   d13a1d45c8dae5de17ee53423e58b1e871048e9a
dist/pokeleafgreen.js  903.8 KB   44039bfaa8394733055b4a973cbbd776bd50dfc0   (wasm embedded)
```

No server component, no EmulatorJS, no libretro frontend, no CDN.

### The CSP is the boundary, and it is tested

`pokefirered` kept the ROM local by wrapping `window.fetch`, `XMLHttpRequest`, `WebSocket` and
`sendBeacon` before the emulator loaded. That works, but it is a boundary made of page script: any
later script can delete the wrapper, and it has to win a race to install. This page uses a
Content-Security-Policy instead:

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; connect-src 'none'; font-src 'none'; media-src 'none';
object-src 'none'; frame-src 'none'; worker-src 'none'; child-src 'none';
base-uri 'none'; form-action 'none'
```

`connect-src 'none'` means the browser refuses **every** `fetch`, `XMLHttpRequest`, `WebSocket`,
`EventSource` and `navigator.sendBeacon` from the page, to every origin **including its own**. Page
script cannot remove it.

**This is only possible because the wasm is base64-embedded into the `.js` (`SINGLE_FILE=1`).** A
separate `.wasm` would have to be fetched, which would force `connect-src 'self'` and leave a
same-origin egress path open. The Makefile asserts that no `dist/*.wasm` was emitted and fails the
build if one was, because the CSP promise silently stops being true otherwise. The cost is ~240 KB
of base64 overhead, which is the right trade.

The test does not take the policy's word for it. It makes the page attempt all five egress paths
and requires every one to be refused, then corroborates three ways:

```
breach attempts: {"fetch-cross-origin":"refused: TypeError","fetch-same-origin":"refused: TypeError",
                  "xhr-cross-origin":"refused: Error","websocket":"refused: Error",
                  "sendBeacon":"refused: Error"}
securitypolicyviolation events: 5, all effectiveDirective "connect-src", disposition "enforce",
                  blocking https://example.com/x, http://127.0.0.1:PORT/index.html, wss://example.com/x
CDP network layer: POST https://example.com/x -> blockedReason "csp"
```

### Other properties

- **The player supplies the ROM.** A real `<input type=file>` plus drag-and-drop, read with the File
  API into wasm linear memory. The test feeds it through that same input over
  `DOM.setFileInputFiles`, so the picker and boot path under test are the ones a user gets.
- The page sha1s the ROM with Web Crypto and identifies it against the three LeafGreen hashes the
  decomp documents, saying so in the status bar ("matches this build" for rev1).
- The ROM is cached in IndexedDB so a reload does not re-prompt; there is a **forget ROM** button.
- **Saves**: cartridge flash, 128 KiB, FLASH1M — sized exactly, because oversizing makes mGBA pick
  the wrong save media. Mirrored to IndexedDB when its hash changes and flushed on `pagehide` and
  `visibilitychange`. Keyed per cartridge game code, so a FireRed save cannot land on a LeafGreen
  slot. Savestates work the same way.
- **Muted by default, by absence**: no `AudioContext` is constructed at all until the user clicks
  unmute. The test asserts the object does not exist, which is a stronger claim than a gain of zero.

### Why not an emscripten build of the decomp

Not attempted, as instructed — two sessions already measured and rejected it. `pokeruby` ran the
real pipeline with emcc substituted for agbcc and got 337/352 C files compiling, then stopped on the
two things that actually block it: **there is no PPU**, so a native port must supply BG modes 0–5,
affine backgrounds, 128 sprites, windows, blending, DMA, timers and IRQ timing — most of a GBA
emulator, to render less accurately than mGBA already does; and **`preproc` bakes the committed art
and music into the binary** (1985 `INCBIN_*` sites over 97 MB of assets), so shipping that build
would mean redistributing the game, which is the one thing this fleet's model exists to avoid.
`pokefirered` reached the same conclusion independently. So: ROM on a wasm GBA core, deliberately.
The wasm here is a real emscripten build — of mGBA, not of the decomp.

---

## 3. What I actually tested

### "Played" is gated on the game's own state, not on pixels

This is the part I would most want reviewed. The FireRed/LeafGreen opening is **scripted**: a
copyright screen, a title screen, a professor, a name-entry box and a fade into a bedroom all happen
on rails and look exactly like play in a screenshot, whether or not a single button press ever
registered. Mean luma cannot tell those apart.

So the tests read the game's own variables out of IWRAM/EWRAM through the emulator bus, at addresses
taken from **the ELF this project just linked** (`tools/symbols.py` runs `arm-none-eabi-nm` over
`pokeleafgreen_rev1.elf`). Struct offsets come from the decomp's own headers, map names from its own
`include/constants/map_groups.h`, the `STARTMENU_*` and `SAVE_STATUS_*` values are parsed out of
`src/start_menu.c` and `include/save.h`, and the player's name is decoded with the decomp's own
`charmap.txt`. Nothing here came from a wiki or a RAM map.

The shim exposes bus **reads only** — there is deliberately no bus write — so no amount of JS can
poke the game into a state it did not reach by playing.

What that buys, from the real run:

```
gMain.callback2 = 0x80565c9 = CB2_Overworld      (CB2_Overworld is 0x80565c8 in our ELF)
trace: CB2_InitCopyrightScreenAfterBootup -> CB2_InitTitleScreen -> CB2_InitMainMenu
       -> CB2_MainMenu -> CB2_NamingScreen -> CB2_Overworld
sLockFieldControls = 0                            (the game says the player has control)
gSaveBlock1Ptr->location = group 4 num 1 = MAP_PALLET_TOWN_PLAYERS_HOUSE_2F at (6,6)
gSaveBlock2Ptr->playerName = "AAAA"               (A-mashing typed it)
play clock = 0:00:05                              (the game's own timer is running)
walking: (6,6) -> (6,8)                           (input reaches the game)
```

The callback trace is the strongest single piece: it is an **ordered** walk through the game's own
screens. A savestate, a poked variable or a lucky screenshot could satisfy "ends in the overworld";
none of them produces that sequence.

### Core, in node, muted — 21/21 (`make selftest`)

ROM identity (sha1, header title/code, revision byte, 128 KiB save media), ~4600 frames of scripted
input, the symbol gate above, picture not black and changing, and a savestate round trip that also
checks the restored **game** state, not just the restored picture.

### The real page, headless Chrome, muted — 34/34 (`make browsercheck`)

Everything above plus: the ROM through the real file picker with an in-page sha1 that matches disk;
the five-way CSP breach test; egress judged at the CDP network layer; no `AudioContext`; the full
in-game save round trip below; no uncaught page errors; no console errors. Screenshots and
`results.json` in `web/out/`.

### An in-game save, made from the game's own SAVE menu, and continued after a reload

The start menu is navigated by **reading the menu the game built**, not by counting button presses:

```
sNumStartMenuItems = 5   sStartMenuOrder = [2,3,4,5,6]   (BAG, PLAYER, SAVE, OPTION, EXIT)
STARTMENU_SAVE = 4 -> entry 2 of 5
sStartMenuCursorPos = 2 before anything is confirmed
```

That matters: this early in the game there is no Pokédex and no party, so the menu is five entries,
not seven. **A hardcoded "press DOWN four times" would have landed on the wrong item** and the test
would have been asserting about whatever that opened.

Then:

1. The game wrote its cartridge flash (`vj_save_hash` moved, and only at that moment).
2. The write ran to completion — the buffer settled after 480 frames, and the image carries **14
   sectors with the game's own save signature `0x08012025`**, which is what a complete LeafGreen
   save slot looks like.
3. Flushed to IndexedDB: 131072 B.
4. **Navigated away in the same tab** (so `pagehide` fires — the path a person actually takes) and
   came back. The persisted bytes are byte-identical, read straight out of IndexedDB *before* the
   core touches them.
5. `gSaveFileStatus` reads **`SAVE_STATUS_OK` (1)** — the game's own load path saying it found a
   valid save, not me inferring it from a file hash.
6. Continuing lands back in `CB2_Overworld` at `MAP_PALLET_TOWN_PLAYERS_HOUSE_2F (6,8)` with
   `playerName = "AAAA"` — **the exact tile and name that were saved** — and the trace
   (`title -> main menu -> overworld`, no `CB2_NamingScreen`) shows it was a CONTINUE, not a new game.

Screenshots corroborate it: `04-start-menu.png` shows the bedroom with BAG / AAAA / ▶SAVE / OPTION /
EXIT and the help text "Save your game with a complete record of your progress to take a break.";
`07-continued.png` shows the player back in the bedroom after the reload.

---

## 3a. Five bugs this session found, four of them in my own tests

Recording these because every one produced a confident wrong answer first.

1. **A fixed frame count is the wrong instrument for a flash write.** The first browser run reported
   the save persisted *perfectly* — byte-identical across the reload — and the game then said
   `SAVE_STATUS_INVALID`. Both were true. LeafGreen writes its 14 flash sectors one at a time over
   **~300 frames (≈5 s of emulated time)**, and the test had pumped a fixed 240 and flushed. It
   persisted a half-written save flawlessly. The fix is to wait for the save buffer to stop
   changing, plus the 14-signature-sector check so a regression fails loudly instead of producing an
   invalid save that merely persists well. **"The bytes survived" is not "the save survived."**
2. **`CB2_Overworld` does not mean the player has control.** The intro leaves a message box up, and
   the script engine holds `sLockFieldControls` while it is — blocking both walking and the start
   menu, with `gPlayerAvatar` still flagged controllable. A probe that assumed control found an
   empty start menu and concluded the save had failed. The game has a flag for exactly this
   question; the tests now wait on it, and it is a better "is this playable" gate than anything I
   would have invented.
3. **Two frame sources, one instrumented, is a flaky test by construction.** The page runs frames
   from both `requestAnimationFrame` and the test's `pump()`. The callback tracer only sampled
   `pump()`'s frames, so `CB2_MainMenu` — crossed in well under half a second — appeared or vanished
   from the trace depending on which loop happened to execute those frames. Sampling in both fixed
   it. The same bug in sparser form had already cost a run in node, where a 30-frame sampling
   interval missed the main menu entirely.
4. **A CDP `Network.requestWillBeSent` is not egress.** Chrome logs the intent and *then* refuses.
   The first harness failed itself on the POST it had deliberately provoked. The signal that settles
   it is `Network.loadingFailed` with `blockedReason: "csp"`, correlated by request id.
5. **`rm -rf build` is not a clean rebuild.** My first "reproduced from clean" ran in 2.9 s because
   it had left `pokeleafgreen_rev1.elf` in place, so `make` just re-ran `objcopy` on the stale ELF
   and declared a match. Zero object files were compiled. The genuine clean rebuild — wiping
   `build/`, the `.elf`, `.gba` and `.map` — takes 13.2 s, compiles 649 objects, and *is*
   byte-identical. I nearly recorded the first one as the result.

Also worth noting: **a screenshot caught a bug no assertion did.** The HUD legend read "X = A,
Z = B" while the key map was the other way round. Nothing in 34 checks reads the legend; looking at
the rendered page did.

### What I did NOT test

- **Anything past the first room.** Verified as far as the bedroom in Pallet Town, walking, and the
  in-game save menu. No battles, no Pokémon, no walking outside, nothing past the opening.
  **Not play-tested as a game.**
- **That the save is *correct* in detail**, beyond map, tile, player name and the game accepting it
  as valid and continuing from it. I did not compare full world state.
- **Sound.** Deliberately never enabled, per fleet rules. The audio path exists and is wired to the
  unmute button but has never been listened to. Treat it as untested.
- **Touch input and real mobile devices.** There are no on-screen controls at all; keyboard and
  gamepad only. The gamepad path is written to the Standard Gamepad mapping and is **unverified** —
  no controller attached.
- **Other browsers.** Chrome 151 headless with software GL, only. No Firefox, no Safari, no real
  mobile browser. No GPU path.
- **The rev-0 and Switch LeafGreen targets, and all three FireRed targets.** Not built here. The
  page recognises the other two LeafGreen hashes and would boot them; untested.
- **FireRed on this page.** The page deliberately *refuses* a non-LeafGreen ROM, so the FireRed
  dumps `pokefirered` verified are not accepted here.
- **`make modern`**, the German/other-language ROMs, and the debug targets. Not built.
- **Link cable, wireless trading and link battles.** Not available in the browser; not attempted.
- **A fresh machine.** `tools/setup.sh` is the recipe I ran, reassembled into a script afterwards;
  it has not been run end-to-end from an empty directory. The shared toolchain it depends on was
  already present.
- **Deployment.** Nothing has been pushed anywhere; `source` and `embedUrl` below are placeholders.

---

## 4. Proposed catalog entry

Fragment only — **I have not touched `src/data/games.json`**, per the rules.

```json
{
  "id": "pokemon-leafgreen",
  "title": "Pokémon LeafGreen",
  "aliases": ["pokeleafgreen", "pokemon leafgreen", "leafgreen", "leaf green"],
  "year": 2004,
  "genre": "RPG",
  "kind": "Decompilation",
  "mode": "embed",
  "engine": "the pret/pokefirered decompilation, built to a matching ROM and run on a direct WebAssembly build of mGBA's core",
  "description": "Return to Kanto: catch, train and battle through the original 151.",
  "overview": "Pokémon LeafGreen built from the pret/pokefirered decompilation, pinned at 037335f4. The build is byte-identical to a retail (USA, Europe) (Rev 1) cartridge dump — sha1 7862c67bdecbe21d1d69ce082ce34327e1c6ed5e — and runs in the browser on a direct WebAssembly build of mGBA's core, with no emulator frontend in between. You supply your own ROM: it is read in your browser with the File API, checked against the hashes the decompilation documents, and handed straight to the emulator. The page is static files with no server, and its Content-Security-Policy sets connect-src 'none', so the browser itself refuses to let the page make any network request at all.",
  "source": "https://github.com/andrewnakas/pokeleafgreen-web",
  "engineLicense": "pret/pokefirered; mGBA core MPL-2.0",
  "assetLicense": "None distributed — the player supplies their own ROM",
  "assetRequirements": "Your own Pokémon LeafGreen ROM (USA, Europe) (Rev 1), sha1 7862c67bdecbe21d1d69ce082ce34327e1c6ed5e. It is read in your browser and never uploaded.",
  "controls": [
    "Arrow keys — D-pad",
    "Z — A",
    "X — B",
    "A / S — L / R",
    "Enter — Start",
    "Shift — Select",
    "Gamepad — any standard controller (untested)"
  ],
  "saveInstructions": "Save from the in-game menu (Start, SAVE). The cartridge save is mirrored into this browser's storage and restored automatically on reload, so the game offers CONTINUE when you come back. There are also save-state buttons. Clearing site data removes everything, including the cached ROM.",
  "limitations": [
    "You must supply your own ROM; none is distributed.",
    "Revision 1 only — the rev 0 and Switch Online dumps are a different build and are untested here.",
    "FireRed is not accepted by this page, only LeafGreen.",
    "Verified as far as the bedroom in Pallet Town, walking, and an in-game save that survives a reload. Battles, the wider overworld and the rest of the game have not been play-tested.",
    "Sound is implemented but has never been listened to — all testing was muted.",
    "Keyboard and gamepad only; there are no on-screen touch controls, so phones and tablets are not usable.",
    "Tested in headless Chrome 151 only, with software rendering.",
    "Link cable, trading and link battles are not available in the browser."
  ],
  "inputs": ["Keyboard", "Gamepad"],
  "downloadMB": 1,
  "complete": false,
  "color": "#4caf50",
  "shelf": "decomp",
  "platform": "Game Boy Advance",
  "launch": "embed",
  "touch": false,
  "embedUrl": "https://andrewnakas.github.io/pokeleafgreen-web/",
  "verification": {
    "status": "smoke-tested",
    "date": "2026-10-05",
    "browsers": ["Chrome 151 (headless, software GL)"],
    "scope": "Byte-identical build verified by cmp against a retail dump and reproduced from a clean tree. Muted headless run: ROM read in-page (sha1 match), CSP connect-src 'none' proven by five refused egress attempts and corroborated at the network layer, core boots, and the game's own gMain.callback2 walks title -> main menu -> naming -> overworld with sLockFieldControls clear and the player walking on the game's own tile grid. A save made from the game's SAVE menu survives a reload: the game reports SAVE_STATUS_OK and continues onto the exact saved tile. No play-testing beyond the first room.",
    "playthrough": false
  },
  "image": "/images/pokemon-leafgreen.png"
}
```

`source` and `embedUrl` are placeholders — nothing has been pushed. There is no `image`: the rules
forbid generating art, and a screenshot of the running build is retail pixels, so that one is yours.

---

## 5. Layout

```
games/pokeleafgreen/
  STATUS.md                     this file
  README.md
  .gitignore                    no ROMs, no extracted assets, no build output
  tools/
    env.sh                      puts the shared ARM toolchain, emscripten and node on PATH
    setup.sh                    clone upstream @ the pinned rev, drop in the shared agbcc
    build.sh                    build LeafGreen rev1 and cmp it against your ROM
    symbols.py                  ground truth for the tests, read from OUR ELF and the decomp's headers
  upstream/                     pret/pokefirered @ 037335f4 (detached), gitignored, not vendored
  web/
    Makefile                    all / test / selftest / browsercheck / check
    src/shim.c                  mCore -> JS surface, plus read-only GBA bus probes
    src/index.html              the page (CSP lives here)
    src/app.js                  page logic, separate so script-src needs no 'unsafe-inline'
    test/core-smoke.mjs         core test in node, symbol-gated (VJ_DUMP=dir for PPM frames)
    test/browser-check.mjs      CDP harness, drives the real file picker
    test/save-probe.mjs         the diagnostic that found the half-written-save bug
    test/run-browser-check.sh   serves dist/, runs headless Chrome, tears down
    dist/                       build output (gitignored)
```

Disk: the project is 348 MB with the upstream clone and a full build; `dist/` is 932 KB and the
committed repo is well under 100 KB. The upstream clone was made with `git clone --local` from
`pokefirered`'s tree, so its object store is hardlinked and costs almost nothing. `/` went from
11 G to 12 G free over the session.

---

## 6. Notes for the next agent

- **The pokeruby mGBA stack is reusable as-is and worth reusing.** I linked
  `~/decompfleet/games/pokeruby/ref/mgba/build-wasm/libmgba.a` directly rather than rebuilding
  mGBA — it is GBA-generic. That saved ~1 GB of disk and a long build. The Makefile still derives
  `MGBA_DEFS` from that build's own `flags.make`, which is the one thing you must not hand-copy:
  get the `-D` set wrong and every `mCore` vtable entry reads back NULL at runtime with no link
  error.
- **`SINGLE_FILE=1` buys you `connect-src 'none'`.** If you want a CSP that forbids *all* network
  access, the wasm cannot be a separate file. Assert it in the build (`test ! -f dist/*.wasm`),
  because the guarantee silently stops holding otherwise.
- **If your game has a battery save, do not trust a fixed settle time.** See §3a.1. Wait for the
  save buffer to stop changing, and if the game has a sector signature, count the sectors.
- **`tools/symbols.py` is the pattern I would most recommend copying.** Any pret decomp has an ELF
  with full symbols and headers with offsets in the comments. Reading `gMain.callback2` and
  comparing it to `CB2_Overworld` from your own link is a far stronger gameplay test than any
  screenshot, it is deterministic, and it costs about an hour to build. The map-name and charmap
  reverse lookups make the failure messages readable, which is most of the value.
- EmulatorJS was not used here, so none of `emulatorjs-notes.md` applies — including trap 10, the
  `beforeunload` that destroys saves. There is no emscripten filesystem on this stack at all
  (`FILESYSTEM=0`); the save is a plain buffer the page mirrors to IndexedDB itself.
- `pokefirered`'s STATUS.md was accurate throughout and made this the cheapest target in the batch:
  the build was byte-identical on the first attempt, in 17 seconds, with zero patches. Its open
  question about LeafGreen is now closed.
