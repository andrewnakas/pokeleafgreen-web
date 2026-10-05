/* Diagnostic: is a LeafGreen in-game save complete, and does the game accept it
 * back?
 *
 * The browser test found gSaveFileStatus == SAVE_STATUS_INVALID after a reload,
 * with the save bytes provably byte-identical across that reload. Two very
 * different causes fit that: either the bytes were snapshotted before the game
 * had finished writing flash, or the page's restore path is wrong. This probe
 * separates them, in node, with no browser and no IndexedDB in the picture:
 * it saves in-game, then reloads the ROM IN PROCESS while keeping the same
 * save buffer, and asks the game what it thinks of the save.
 *
 * If the in-process reload is accepted, the fault is in the page.
 * If it is rejected too, the save was incomplete when it was read.
 *
 *   node test/save-probe.mjs <rom>
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import createGBA from './core-node.js';

const romPath = process.argv[2];
if (!romPath) { console.error('usage: node save-probe.mjs <rom>'); process.exit(2); }

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PROJ = path.resolve(HERE, '../..');
const SYM = JSON.parse(execFileSync('python3', [path.join(PROJ, 'tools/symbols.py'), '--json'],
	{ encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));

const KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128 };

const M = await createGBA();
const w = (n, r, a) => M.cwrap(n, r, a);
const api = {
	init: w('vj_init', 'number', []), loadRom: w('vj_load_rom', 'number', ['number', 'number']),
	runFrame: w('vj_run_frame', null, []), setKeys: w('vj_set_keys', null, ['number']),
	opaque: w('vj_opaque', null, []), meanLuma: w('vj_mean_luma', 'number', []),
	saveBuffer: w('vj_save_buffer', 'number', []), saveSize: w('vj_save_size', 'number', []),
	saveHash: w('vj_save_hash', 'number', []),
	read8: w('vj_read8', 'number', ['number']), read16: w('vj_read16', 'number', ['number']),
	read32: w('vj_read32', 'number', ['number']),
	readBlock: w('vj_read_block', 'number', ['number', 'number'])
};
const r8 = (a) => api.read8(a >>> 0) & 0xFF;
const r16 = (a) => api.read16(a >>> 0) & 0xFFFF;
const r32 = (a) => api.read32(a >>> 0) >>> 0;
function blk(a, n) {
	const ptr = api.readBlock(a >>> 0, n);
	return Array.from(M.HEAPU8.subarray(ptr, ptr + n));
}
const cb = () => SYM.callback_by_addr['0x' + ((r32(SYM.data.gMain + SYM.offsets['Main.callback2']) & ~1) >>> 0).toString(16)] || null;

function press(bits, on = 6, off = 10) {
	for (let i = 0; i < on; i++) { api.setKeys(bits); api.runFrame(); }
	for (let i = 0; i < off; i++) { api.setKeys(0); api.runFrame(); }
}
function idle(n) { for (let i = 0; i < n; i++) { api.setKeys(0); api.runFrame(); } }

api.init();
const rom = fs.readFileSync(romPath);
const p = M._malloc(rom.length);
M.HEAPU8.set(rom, p);
api.loadRom(p, rom.length);

/* --- play to the overworld --- */
let settled = -1;
for (let i = 0; i < 420; i++) {
	press(i > 20 && i % 14 === 13 ? KEY.START : KEY.A, 6, 10);
	if (cb() === 'CB2_Overworld') { if (settled < 0) { settled = i; } if (i > settled + 8) { break; } }
}
console.log('reached:', cb());
const sb1 = r32(SYM.data.gSaveBlock1Ptr);
const mapBefore = [r8(sb1 + 4), r8(sb1 + 5)];
console.log('map before save: group/num', mapBefore);

/* CB2_Overworld going live does NOT mean the player has control: the intro
 * leaves a message box up, and while it is up the script engine holds
 * sLockFieldControls, which blocks both walking and the start menu. The first
 * version of this probe assumed control and found an empty start menu; the
 * browser test only got away with it because its rAF loop was advancing extra
 * frames between presses. Ask the game instead. */
const locked = () => r8(SYM.data.sLockFieldControls);
console.log('sLockFieldControls after reaching CB2_Overworld:', locked());
let cleared = -1;
for (let i = 0; i < 40 && locked(); i++) { press(KEY.A, 6, 30); cleared = i; }
console.log(`field controls unlocked after ${cleared + 1} further A presses -> locked=${locked()}`);

/* Confirm control for real before trusting anything downstream. */
const pos0 = [r16(r32(SYM.data.gSaveBlock1Ptr) + 0), r16(r32(SYM.data.gSaveBlock1Ptr) + 2)];
press(KEY.DOWN, 48, 24);
const pos1 = [r16(r32(SYM.data.gSaveBlock1Ptr) + 0), r16(r32(SYM.data.gSaveBlock1Ptr) + 2)];
console.log(`walked ${pos0} -> ${pos1}`);

/* --- in-game save via the start menu --- */
const SAVE_IDX = SYM.enums.STARTMENU_SAVE;
let menu = [], cursor = -1;
for (let i = 0; i < 6; i++) {
	press(KEY.START, 6, 30);
	const n = r8(SYM.data.sNumStartMenuItems);
	console.log(`  attempt ${i}: sNumStartMenuItems=${n}`);
	if (n > 0 && n <= SYM.enums.MAX_STARTMENU_ITEMS) {
		menu = blk(SYM.data.sStartMenuOrder, n);
		cursor = r8(SYM.data.sStartMenuCursorPos);
		if (menu.includes(SAVE_IDX)) { break; }
	}
}
const want = menu.indexOf(SAVE_IDX);
if (want < 0) { console.error('start menu never opened; aborting probe'); process.exit(3); }
while (cursor !== want) { press(cursor < want ? KEY.DOWN : KEY.UP, 5, 9); cursor = r8(SYM.data.sStartMenuCursorPos); }
console.log('menu', menu, 'cursor on SAVE at', cursor);

const h0 = api.saveHash();
let firstChange = -1;
for (let i = 0; i < 40; i++) {
	press(KEY.A, 6, 16);
	if (api.saveHash() !== h0) { firstChange = i; break; }
}
console.log(`save hash first moved after ${firstChange + 1} A presses: ${h0} -> ${api.saveHash()}`);

/* --- KEY QUESTION 1: does the save buffer keep changing after that? --- */
console.log('\nsettling the save buffer (does it keep being written?):');
let prev = api.saveHash(), lastMove = 0;
for (let f = 0; f <= 2400; f += 60) {
	idle(60);
	const h = api.saveHash();
	if (h !== prev) { lastMove = f + 60; console.log(`  +${f + 60} frames: hash moved -> ${h}`); prev = h; }
}
console.log(`  save buffer stopped changing after ~${lastMove} frames past the first write`);

/* Keep pressing A a few more times in case the dialog is still open, then
 * settle again — the write might be gated on dismissing a message box. */
for (let i = 0; i < 6; i++) { press(KEY.A, 6, 16); }
idle(600);
const hFinal = api.saveHash();
console.log(`  after dismissing the dialog and settling: ${hFinal}`);

const snap = Buffer.from(M.HEAPU8.subarray(api.saveBuffer(), api.saveBuffer() + api.saveSize()));
const nonZero = snap.reduce((a, b) => a + (b !== 0 ? 1 : 0), 0);
console.log(`  save buffer: ${nonZero}/${snap.length} non-zero bytes`);
/* FRLG sector footer: the sector id, a signature and a counter sit at the end of
 * each 4 KiB sector. Count how many sectors carry the game's own signature. */
const SIG = 0x08012025;
let sigCount = 0;
for (let s = 0; s < snap.length; s += 0x1000) {
	if (snap.readUInt32LE(s + 0xFF8) === SIG) { sigCount++; }
}
console.log(`  sectors carrying the game's save signature 0x08012025: ${sigCount}`);

/* --- KEY QUESTION 2: reload the ROM in process, same save buffer --- */
console.log('\nreloading the ROM in process, keeping the same save buffer:');
const p2 = M._malloc(rom.length);
M.HEAPU8.set(rom, p2);
api.loadRom(p2, rom.length);
M._free(p2);

for (let i = 0; i < 90; i++) {
	idle(30);
	const st = r8(SYM.data.gSaveFileStatus);
	if (st !== 0) {
		console.log(`  gSaveFileStatus = ${st} after ${(i + 1) * 30} frames ` +
			`(OK=${SYM.enums.SAVE_STATUS_OK} EMPTY=${SYM.enums.SAVE_STATUS_EMPTY} ` +
			`INVALID=${SYM.enums.SAVE_STATUS_INVALID} NO_FLASH=${SYM.enums.SAVE_STATUS_NO_FLASH})`);
		break;
	}
}
const st = r8(SYM.data.gSaveFileStatus);
console.log(`  final gSaveFileStatus = ${st} -> ${st === SYM.enums.SAVE_STATUS_OK ? 'ACCEPTED' : 'REJECTED'}`);

/* If accepted, continue and see where we land. */
if (st === SYM.enums.SAVE_STATUS_OK) {
	for (let i = 0; i < 200; i++) {
		press(KEY.A, 6, 12);
		if (cb() === 'CB2_Overworld') { idle(180); break; }
	}
	const sb1b = r32(SYM.data.gSaveBlock1Ptr);
	console.log(`  continued to ${cb()} at map group/num [${r8(sb1b + 4)}, ${r8(sb1b + 5)}]`);
}

console.log('\nCONCLUSION: the fault is in ' +
	(st === SYM.enums.SAVE_STATUS_OK ? 'the PAGE (restore path), not the save write'
		: 'the SAVE WRITE or the save media, not the page'));
