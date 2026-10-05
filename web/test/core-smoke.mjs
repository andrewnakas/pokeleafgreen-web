/* Muted core test for pokeleafgreen, outside a browser.
 *
 * The point of this file is the "played" gate. The FireRed/LeafGreen opening is
 * scripted: a copyright screen, a title screen, a professor, a name-entry box
 * and a fade into a bedroom all happen on rails, and they look like play in a
 * screenshot whether or not a single button press registered. So this test does
 * not grade pixels. It reads the game's own `gMain.callback2` out of IWRAM
 * through the emulator bus and compares it against the address of
 * `CB2_Overworld` in THE ELF WE JUST LINKED, then reads the player's position,
 * map and name out of the live save blocks and names the map from the decomp's
 * own map_groups.h.
 *
 *   node test/core-smoke.mjs <rom> [maxFrames]
 *
 * Audio: this build never constructs an audio device at all; the shim exposes a
 * drain function that is simply never called here. Nothing can make a sound.
 *
 * VJ_DUMP=<dir> also writes PPM frames, so the frames behind the numbers can be
 * looked at rather than trusted.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import createGBA from './core-node.js';

const romPath = process.argv[2];
const MAX_FRAMES = parseInt(process.argv[3] || '20000', 10);
if (!romPath) {
  console.error('usage: node core-smoke.mjs <rom.gba> [maxFrames]');
  process.exit(2);
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PROJ = path.resolve(HERE, '../..');

/* Ground truth comes from tools/symbols.py, which reads our ELF and the
 * decomp's headers. Shelling out to it keeps one definition of "where things
 * live" instead of two that can drift. */
const SYM = JSON.parse(
  execFileSync('python3', [path.join(PROJ, 'tools/symbols.py'), '--json'], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
  })
);

const KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 };

let fails = 0, passes = 0;
function check(name, ok, detail) {
  if (ok) { passes++; } else { fails++; }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
}

function writePPM(dir, n, bytes, w, h) {
  fs.mkdirSync(dir, { recursive: true });
  const out = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    out[i * 3] = bytes[i * 4];
    out[i * 3 + 1] = bytes[i * 4 + 1];
    out[i * 3 + 2] = bytes[i * 4 + 2];
  }
  fs.writeFileSync(path.join(dir, `f${String(n).padStart(6, '0')}.ppm`),
    Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), out]));
}

const M = await createGBA();
const api = {
  init: M.cwrap('vj_init', 'number', []),
  loadRom: M.cwrap('vj_load_rom', 'number', ['number', 'number']),
  runFrame: M.cwrap('vj_run_frame', null, []),
  framebuffer: M.cwrap('vj_framebuffer', 'number', []),
  width: M.cwrap('vj_width', 'number', []),
  height: M.cwrap('vj_height', 'number', []),
  opaque: M.cwrap('vj_opaque', null, []),
  setKeys: M.cwrap('vj_set_keys', null, ['number']),
  meanLuma: M.cwrap('vj_mean_luma', 'number', []),
  frameHash: M.cwrap('vj_frame_hash', 'number', []),
  title: M.cwrap('vj_game_title', 'string', []),
  revision: M.cwrap('vj_rom_revision', 'number', []),
  saveBuffer: M.cwrap('vj_save_buffer', 'number', []),
  saveSize: M.cwrap('vj_save_size', 'number', []),
  saveHash: M.cwrap('vj_save_hash', 'number', []),
  stateSize: M.cwrap('vj_state_size', 'number', []),
  stateSave: M.cwrap('vj_state_save', 'number', []),
  stateLoad: M.cwrap('vj_state_load', 'number', ['number', 'number']),
  read8: M.cwrap('vj_read8', 'number', ['number']),
  read16: M.cwrap('vj_read16', 'number', ['number']),
  read32: M.cwrap('vj_read32', 'number', ['number']),
  readBlock: M.cwrap('vj_read_block', 'number', ['number', 'number'])
};

const r32 = a => api.read32(a >>> 0) >>> 0;
const r16 = a => api.read16(a >>> 0) & 0xFFFF;
const r8 = a => api.read8(a >>> 0) & 0xFF;
const s16 = a => { const v = r16(a); return v >= 0x8000 ? v - 0x10000 : v; };
function block(a, n) {
  const p = api.readBlock(a >>> 0, n);
  return Array.from(M.HEAPU8.subarray(p, p + n));
}

/* The game stores text in its own encoding, terminated by 0xFF. Decoded with
 * the decomp's charmap.txt, not with an assumed table. */
function decodeName(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b === 0xFF) { break; }
    const c = SYM.charmap[String(b)];
    s += (c === undefined ? '?' : c);
  }
  return s;
}

function callbackName(ptr) {
  return SYM.callback_by_addr['0x' + (ptr & ~1).toString(16)] || null;
}

/* ---------------------------------------------------------------- 1. load */

check('core initialised', api.init() === 1);

const rom = fs.readFileSync(romPath);
const romSha1 = crypto.createHash('sha1').update(rom).digest('hex');
check('ROM sha1 is the rev1 dump our build reproduces',
  romSha1 === SYM.expect_rom_sha1, romSha1);

const p = M._malloc(rom.length);
M.HEAPU8.set(rom, p);
check('ROM accepted by mGBA', api.loadRom(p, rom.length) === 1);
M._free(p);

check('cartridge header title/code', api.title() === 'POKEMON LEAFBPGE', api.title());
check('header revision byte is 1 (Rev 1)', api.revision() === 1, String(api.revision()));
check('save media sized 128 KiB (FLASH1M)', api.saveSize() === 131072, String(api.saveSize()));

/* ----------------------------------------------- 2. run the opening, muted */

const W = api.width(), H = api.height();
const fb = api.framebuffer();
const dumpDir = process.env.VJ_DUMP || '';

/* A has to be pulsed, not held: the game edge-triggers menu confirmation, so a
 * held button advances exactly one screen and then nothing. START is pulsed
 * periodically because the two naming screens are confirmed with it. */
function scriptedBits(frame) {
  const phase = frame % 16;
  if (frame > 1200 && frame % 420 < 8) { return KEY.START; }
  return phase < 5 ? KEY.A : 0;
}

const seen = [];           /* ordered list of distinct named callbacks */
const lumas = [];
let reachedOverworld = -1;
let frames = 0;

for (; frames < MAX_FRAMES; frames++) {
  api.setKeys(scriptedBits(frames));
  api.runFrame();

  /* Sampled EVERY frame, deliberately. At a 30-frame interval this missed
   * CB2_MainMenu entirely -- A-mashing crosses that screen in well under half a
   * second, so the trace came back without it and the test failed an assertion
   * that was actually true. A sparse sampler is a bad witness for a state
   * machine this fast. */
  {
    const cb = callbackName(r32(SYM.data.gMain + SYM.offsets['Main.callback2']));
    if (cb && seen[seen.length - 1] !== cb) {
      seen.push(cb);
      console.log(`      frame ${String(frames).padStart(6)}  gMain.callback2 -> ${cb}`);
    }
    if (cb === 'CB2_Overworld' && reachedOverworld < 0) {
      /* Don't stop at first sight: the overworld callback is also live during
       * the scripted bedroom fade-in. Give it a few seconds to settle, then
       * read state. */
      reachedOverworld = frames;
    }
    if (reachedOverworld > 0 && frames > reachedOverworld + 240) { break; }
  }
  if (frames % 300 === 0) {
    api.opaque();
    lumas.push(+api.meanLuma().toFixed(1));
    if (dumpDir) { writePPM(dumpDir, frames, M.HEAPU8.subarray(fb, fb + W * H * 4), W, H); }
  }
}

api.opaque();
check('frames advanced', frames > 1000, `${frames} frames`);
check('picture is not black at the end', api.meanLuma() > 3, `mean luma ${api.meanLuma().toFixed(1)}`);
check('picture changed during the run (not one frozen frame)',
  new Set(lumas).size > 3, `${new Set(lumas).size} distinct luma samples: ${lumas.join(', ')}`);

/* ------------------------------- 3. the actual "played" gate, from symbols */

const cb2 = r32(SYM.data.gMain + SYM.offsets['Main.callback2']);
const cb2name = callbackName(cb2);
check('gMain.callback2 is the game\'s own overworld callback',
  cb2name === 'CB2_Overworld',
  `0x${cb2.toString(16)} = ${cb2name || 'unknown'} (CB2_Overworld is 0x${SYM.code.CB2_Overworld.toString(16)})`);

/* Not just "it ended up in the overworld" but "it got there through the game's
 * own screens", in order. A savestate or a poked variable could satisfy the
 * previous check; it could not produce this trace. */
const flow = ['CB2_InitTitleScreen', 'CB2_MainMenu', 'CB2_NamingScreen', 'CB2_Overworld'];
let cursor = -1, inOrder = true;
for (const want of flow) {
  const at = seen.indexOf(want);
  if (at <= cursor) { inOrder = false; break; }
  cursor = at;
}
check('the run walked the game\'s own screens in order: title -> main menu -> naming -> overworld',
  inOrder, seen.join(' -> '));

const sb1 = r32(SYM.data.gSaveBlock1Ptr);
const sb2 = r32(SYM.data.gSaveBlock2Ptr);
check('gSaveBlock1Ptr points into EWRAM', (sb1 >>> 24) === 0x02, '0x' + sb1.toString(16));
check('gSaveBlock2Ptr points into EWRAM', (sb2 >>> 24) === 0x02, '0x' + sb2.toString(16));

const mapGroup = r8(sb1 + SYM.offsets['SaveBlock1.location.mapGroup']);
const mapNum = r8(sb1 + SYM.offsets['SaveBlock1.location.mapNum']);
const mapName = SYM.maps[`${mapGroup}:${mapNum}`] || null;
const px = s16(sb1 + SYM.offsets['SaveBlock1.pos.x']);
const py = s16(sb1 + SYM.offsets['SaveBlock1.pos.y']);
check('the player is standing on a map the decomp names',
  mapName !== null, `group ${mapGroup} num ${mapNum} = ${mapName} at (${px}, ${py})`);

const name = decodeName(block(sb2 + SYM.offsets['SaveBlock2.playerName'],
  SYM.offsets['SaveBlock2.playerNameLen']));
check('a player name was entered and is in SaveBlock2',
  name.length > 0 && /^[A-Za-z]+$/.test(name), JSON.stringify(name));

/* CB2_Overworld going live is not the same as the player having control: the
 * intro leaves a message box up, and the script engine holds sLockFieldControls
 * while it is. This is the game's own answer to "is it playable right now", and
 * it is precisely the state a screenshot cannot tell apart from play. */
let lockPresses = 0;
for (; lockPresses < 40 && r8(SYM.data.sLockFieldControls); lockPresses++) {
  for (let i = 0; i < 6; i++) { api.setKeys(KEY.A); api.runFrame(); }
  for (let i = 0; i < 30; i++) { api.setKeys(0); api.runFrame(); }
}
check('the game reports the player has field control (sLockFieldControls clear)',
  r8(SYM.data.sLockFieldControls) === 0, `cleared after ${lockPresses} further A presses`);

/* And control really works: walk, and watch the game's own coordinates move. */
const beforeWalk = [s16(sb1 + SYM.offsets['SaveBlock1.pos.x']), s16(sb1 + SYM.offsets['SaveBlock1.pos.y'])];
for (let i = 0; i < 48; i++) { api.setKeys(KEY.DOWN); api.runFrame(); }
for (let i = 0; i < 24; i++) { api.setKeys(0); api.runFrame(); }
const afterWalk = [s16(sb1 + SYM.offsets['SaveBlock1.pos.x']), s16(sb1 + SYM.offsets['SaveBlock1.pos.y'])];
check('walking moves the player on the game\'s own tile grid (input reaches the game)',
  beforeWalk[0] !== afterWalk[0] || beforeWalk[1] !== afterWalk[1],
  `(${beforeWalk}) -> (${afterWalk})`);

const hours = r16(sb2 + SYM.offsets['SaveBlock2.playTimeHours']);
const mins = r8(sb2 + SYM.offsets['SaveBlock2.playTimeMinutes']);
const secs = r8(sb2 + SYM.offsets['SaveBlock2.playTimeSeconds']);
check('the game\'s own play clock is running',
  (hours * 3600 + mins * 60 + secs) > 0, `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`);

/* ------------------------------------------------- 4. savestate round trip */

/* core->loadState restores the emulated machine but does NOT repaint the video
 * buffer -- vbuf still holds whatever was last rasterised. Comparing frame
 * hashes immediately after the load therefore compares the PRE-load picture
 * with itself and fails a working round trip, which is what the first version
 * of this test did. Step one frame on each side of the comparison instead, with
 * identical input, so the thing being compared is a frame the restored machine
 * actually drew. */
const stPtr = api.stateSave(), stLen = api.stateSize();
const snapshot = Buffer.from(M.HEAPU8.subarray(stPtr, stPtr + stLen));

api.setKeys(0); api.runFrame(); api.opaque();
const hashOneFrameOn = api.frameHash();

for (let i = 0; i < 300; i++) { api.setKeys(i % 12 < 6 ? KEY.DOWN : 0); api.runFrame(); }
api.opaque();
const divergedHash = api.frameHash();

const sp = M._malloc(snapshot.length);
M.HEAPU8.set(snapshot, sp);
const ok = api.stateLoad(sp, snapshot.length);
M._free(sp);
check('savestate reloads', ok === 1);

api.setKeys(0); api.runFrame(); api.opaque();
const restoredHash = api.frameHash();

if (divergedHash === hashOneFrameOn) {
  check('savestate round trip', false,
    'INCONCLUSIVE — the picture never changed during the divergence window, so a frozen core would also pass');
} else {
  check('savestate round trip restores the exact frame',
    restoredHash === hashOneFrameOn,
    `one frame on ${hashOneFrameOn} -> diverged ${divergedHash} -> restored ${restoredHash}`);
}

/* The machine, not just the picture: the player should be back on the same map
 * at the same tile after the restore. */
{
  const sb1b = r32(SYM.data.gSaveBlock1Ptr);
  const g = r8(sb1b + SYM.offsets['SaveBlock1.location.mapGroup']);
  const n = r8(sb1b + SYM.offsets['SaveBlock1.location.mapNum']);
  check('savestate restored the game state too (same map as the snapshot)',
    g === mapGroup && n === mapNum, `group ${g} num ${n}`);
}

/* --------------------------------------------------------------- 5. result */

console.log(`\n${passes} passed, ${fails} failed`);
if (dumpDir) { console.log(`frames dumped to ${dumpDir}`); }
process.exit(fails ? 1 : 0);
