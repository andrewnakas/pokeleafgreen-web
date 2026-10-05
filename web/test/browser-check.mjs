/* Drives the real pokeleafgreen page in headless Chrome over the DevTools
 * protocol. Adapted from the pokeruby agent's harness; what is new here:
 *
 *  - The CSP is TESTED, not trusted. The harness makes the page attempt a
 *    cross-origin fetch, a same-origin fetch, an XHR, a WebSocket and a
 *    sendBeacon, and requires all five to be refused. A policy nobody tried to
 *    violate is a comment, not a boundary.
 *  - Egress is also judged at the network layer, from CDP
 *    Network.requestWillBeSent, rather than from the page's own
 *    performance.getEntriesByType — the page is the thing under test and is
 *    not a witness to its own behaviour.
 *  - "Played" is gated on the game's own state read out of IWRAM/EWRAM at
 *    addresses from our build's ELF, not on screenshot brightness.
 *  - The save test makes a REAL in-game save, navigating the start menu by
 *    reading the menu the game built (sStartMenuOrder / sStartMenuCursorPos),
 *    then reloads the page and continues from the save, checking the restored
 *    map, tile and player name against what was recorded before.
 *
 *   node browser-check.mjs <url> <rom path> [outdir]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const url = process.argv[2];
const romPath = process.argv[3];
const outDir = process.argv[4] || null;
if (!url || !romPath) {
	console.error('usage: node browser-check.mjs <url> <rom> [outdir]');
	process.exit(2);
}
if (outDir) { mkdirSync(outDir, { recursive: true }); }

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PROJ = path.resolve(HERE, '../..');
const SYM = JSON.parse(execFileSync('python3',
	[path.join(PROJ, 'tools/symbols.py'), '--json'],
	{ encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok: !!ok, detail });
	console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}
function note(s) { console.log('      ' + s); }

/* --------------------------------------------------------------- CDP client */

const endpoint = process.env.CDP_URL;
if (!endpoint) {
	console.error('CDP_URL not set (the websocket URL from /json/new)');
	process.exit(2);
}

const ws = new WebSocket(endpoint);
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];
const netRequests = [];      /* every request Chrome actually issued */
const cspViolations = [];

ws.addEventListener('message', (ev) => {
	const msg = JSON.parse(ev.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		if (msg.error) { reject(new Error(msg.error.message)); } else { resolve(msg.result); }
		return;
	}
	/* requestWillBeSent fires even for a request CSP is about to refuse: Chrome
	 * logs the intent, then blocks it before any bytes leave. So "a request
	 * appeared" is NOT egress on its own, and the first version of this harness
	 * wrongly failed itself on the POST it had deliberately provoked. What
	 * settles it is Network.loadingFailed carrying blockedReason "csp", which is
	 * the network stack reporting that it refused to send. Both halves are
	 * recorded and correlated by requestId below. */
	if (msg.method === 'Network.requestWillBeSent') {
		netRequests.push({
			id: msg.params.requestId,
			url: msg.params.request.url,
			method: msg.params.request.method,
			blockedReason: null,
			succeeded: false
		});
	}
	if (msg.method === 'Network.loadingFailed') {
		const r = netRequests.find((x) => x.id === msg.params.requestId);
		if (r) { r.blockedReason = msg.params.blockedReason || 'failed:' + msg.params.errorText; }
	}
	if (msg.method === 'Network.responseReceived' || msg.method === 'Network.loadingFinished') {
		const r = netRequests.find((x) => x.id === msg.params.requestId);
		if (r) { r.succeeded = true; }
	}
	if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
		const t = msg.params.args.map((a) => a.value ?? a.description).join(' ');
		/* Chrome reports every CSP refusal as a console error. Those are the
		 * policy working, so they are collected separately rather than counted
		 * as page faults. */
		if (/Content Security Policy/i.test(t)) { cspViolations.push(t); } else { consoleErrors.push(t); }
	}
	if (msg.method === 'Runtime.exceptionThrown') {
		pageErrors.push(msg.params.exceptionDetails.text + ' ' +
			(msg.params.exceptionDetails.exception?.description || ''));
	}
});

function send(method, params = {}) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
}

await new Promise((res, rej) => {
	ws.addEventListener('open', res);
	ws.addEventListener('error', () => rej(new Error('could not connect to Chrome at ' + endpoint)));
});

async function evalJs(expr, awaitPromise = false) {
	const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
	if (r.exceptionDetails) {
		throw new Error(r.exceptionDetails.text + ' ' +
			(r.exceptionDetails.exception?.description || '') + ' while evaluating: ' + expr);
	}
	return r.result.value;
}

async function waitFor(expr, timeoutMs, label) {
	const t0 = Date.now();
	for (;;) {
		let v = false;
		try { v = await evalJs(expr); } catch { /* page may still be loading */ }
		if (v) { return true; }
		if (Date.now() - t0 > timeoutMs) { throw new Error('timed out waiting for ' + (label || expr)); }
		await new Promise((r) => setTimeout(r, 100));
	}
}

/* After Page.navigate, Runtime.evaluate still answers from the OLD document for
 * a moment, so "poll until my global exists" returns true against the page we
 * are trying to leave. The pokefirered agent paid a debugging cycle for this.
 * Put a nonce in the URL and wait until the document admits to being the new
 * one. Navigating in the same tab (rather than closing it) is also what makes
 * pagehide fire, which is the path a real reload takes. */
async function goto(base) {
	const nonce = randomUUID().slice(0, 8);
	const sep = base.includes('?') ? '&' : '?';
	await send('Page.navigate', { url: `${base}${sep}n=${nonce}` });
	await waitFor(`location.search.indexOf("${nonce}") >= 0 && document.readyState === "complete"`,
		25000, `navigation to nonce ${nonce}`);
	return nonce;
}

async function shot(tag) {
	if (!outDir) { return; }
	const r = await send('Page.captureScreenshot', { format: 'png' });
	writeFileSync(`${outDir}/${tag}.png`, Buffer.from(r.data, 'base64'));
}

/* ------------------------------------------------- game state, from symbols */

const KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128 };

const r8 = (a) => evalJs(`window.__lg.read8(${a})`);
const r16 = (a) => evalJs(`window.__lg.read16(${a})`);
const r32 = (a) => evalJs(`window.__lg.read32(${a})`);
const blk = (a, n) => evalJs(`JSON.stringify(window.__lg.readBlock(${a}, ${n}))`).then(JSON.parse);

function cbName(ptr) {
	return SYM.callback_by_addr['0x' + ((ptr & ~1) >>> 0).toString(16)] || null;
}
function decodeName(bytes) {
	let s = '';
	for (const b of bytes) {
		if (b === 0xFF) { break; }
		s += (SYM.charmap[String(b)] ?? '?');
	}
	return s;
}
async function currentCallback() {
	return cbName(await r32(SYM.data.gMain + SYM.offsets['Main.callback2']));
}
async function playerState() {
	const sb1 = await r32(SYM.data.gSaveBlock1Ptr);
	const sb2 = await r32(SYM.data.gSaveBlock2Ptr);
	if ((sb1 >>> 24) !== 0x02 || (sb2 >>> 24) !== 0x02) { return null; }
	const g = await r8(sb1 + SYM.offsets['SaveBlock1.location.mapGroup']);
	const n = await r8(sb1 + SYM.offsets['SaveBlock1.location.mapNum']);
	const rawx = await r16(sb1 + SYM.offsets['SaveBlock1.pos.x']);
	const rawy = await r16(sb1 + SYM.offsets['SaveBlock1.pos.y']);
	const nm = decodeName(await blk(sb2 + SYM.offsets['SaveBlock2.playerName'],
		SYM.offsets['SaveBlock2.playerNameLen']));
	return {
		mapGroup: g, mapNum: n, map: SYM.maps[`${g}:${n}`] || null,
		x: rawx >= 0x8000 ? rawx - 0x10000 : rawx,
		y: rawy >= 0x8000 ? rawy - 0x10000 : rawy,
		name: nm
	};
}
const fmt = (s) => s ? `${s.map} (${s.x},${s.y}) name=${JSON.stringify(s.name)}` : 'none';

/* Pulse-press a button for `on` frames then release for `off`, so the game's
 * edge-triggered menus actually register it. */
async function press(bits, on = 6, off = 10) {
	await evalJs(`window.__lg.pump(${on}, ${bits})`);
	await evalJs(`window.__lg.pump(${off}, 0)`);
}

/* Turn on the page's per-frame callback recorder, handing it the gMain address
 * and the callback name table out of our ELF. */
async function traceStart() {
	const names = {};
	for (const [addr, nm] of Object.entries(SYM.callback_by_addr)) {
		names[parseInt(addr, 16)] = nm;
	}
	await evalJs(`window.__lg.traceStart(${SYM.data.gMain + SYM.offsets['Main.callback2']},
		${JSON.stringify(names)})`);
}
const traceGet = () => evalJs('JSON.stringify(window.__lg.traceGet())').then(JSON.parse);

/* Drive the opening until gMain.callback2 is the game's own overworld callback.
 * The trace comes from the page's per-frame recorder, not from polling here. */
async function playToOverworld(maxRounds = 420) {
	let settled = -1;
	for (let i = 0; i < maxRounds; i++) {
		/* START every so often: the two naming screens are confirmed with it. */
		await press(i > 20 && i % 14 === 13 ? KEY.START : KEY.A, 6, 10);
		const cb = await currentCallback();
		if (cb === 'CB2_Overworld') {
			if (settled < 0) { settled = i; note(`reached CB2_Overworld at round ${i}`); }
			/* The overworld callback is live during the scripted bedroom fade-in
			 * too, so let it settle before reading state. */
			if (i > settled + 8) { break; }
		}
	}
	return await traceGet();
}

/* ------------------------------------------------------------------ the run */

try {
	await send('Page.enable');
	await send('Runtime.enable');
	await send('DOM.enable');
	await send('Network.enable');

	/* Start from a clean profile state, so "persists across a reload" means
	 * something: anything found later was written by this run. */
	await goto(url);
	await evalJs('indexedDB.deleteDatabase("pokeleafgreen-web"), true');
	await goto(url);

	await waitFor('!!(window.__lg && window.__lg.ready)', 40000, 'wasm core init');
	check('the mGBA core initialises in the browser', true);

	/* ---- 1. the ROM comes in through the real file picker ---- */

	const doc = await send('DOM.getDocument');
	const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#rom-file' });
	if (!node.nodeId) { throw new Error('#rom-file not found in the page'); }
	await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [romPath] });

	await waitFor('!!(window.__lg && window.__lg.running)', 40000, 'ROM to boot');
	const title = await evalJs('window.__lg.title()');
	const rev = await evalJs('window.__lg.revision()');
	const pageSha1 = await evalJs('window.__lg.romSha1()');
	const dump = await evalJs('window.__lg.romDump()');
	const diskSha1 = createHash('sha1')
		.update(execFileSync('cat', [romPath], { encoding: 'buffer', maxBuffer: 1 << 26 }))
		.digest('hex');

	check('ROM accepted through the page\'s real <input type=file>',
		title === 'POKEMON LEAFBPGE', `header title/code "${title}"`);
	check('header revision byte is 1 (LeafGreen Rev 1)', rev === 1, 'byte 0xBC = ' + rev);
	check('sha1 computed in the page equals the sha1 on disk',
		pageSha1 === diskSha1 && pageSha1 === SYM.expect_rom_sha1, pageSha1);
	check('the page identified the dump from the decomp\'s documented hashes',
		dump === 'LeafGreen (USA, Europe) (Rev 1)', dump || '(unrecognised)');
	check('save media is 128 KiB flash (FLASH1M)',
		(await evalJs('window.__lg.saveSize()')) === 131072);
	await shot('01-booted');

	/* ---- 2. the CSP is the boundary: try to breach it ---- */

	/* All five of these are egress paths a page could use to ship a 16 MB ROM
	 * somewhere. connect-src 'none' should refuse every one. A page that merely
	 * *says* it does not upload is not the same as a page that cannot. */
	const breach = await evalJs(`(async () => {
		const out = {};
		const tryIt = async (name, fn) => {
			try { await fn(); out[name] = 'ALLOWED'; }
			catch (e) { out[name] = 'refused: ' + (e && e.name ? e.name : String(e)); }
		};
		await tryIt('fetch-cross-origin', () => fetch('https://example.com/x', { mode: 'cors' }));
		await tryIt('fetch-same-origin', () => fetch(location.origin + '/index.html'));
		await tryIt('xhr-cross-origin', () => new Promise((res, rej) => {
			const x = new XMLHttpRequest();
			x.onload = () => res(); x.onerror = () => rej(new Error('NetworkOrCSPError'));
			try { x.open('POST', 'https://example.com/x'); x.send('a'); } catch (e) { rej(e); }
		}));
		await tryIt('websocket', () => new Promise((res, rej) => {
			try { const s = new WebSocket('wss://example.com/x');
				s.onopen = () => res(); s.onerror = () => rej(new Error('CSPorNetwork'));
			} catch (e) { rej(e); }
		}));
		await tryIt('sendBeacon', () => {
			const ok = navigator.sendBeacon('https://example.com/x', 'a');
			if (ok) { throw new Error('__beacon_returned_true'); }
		});
		return JSON.stringify(out);
	})()`, true);
	const b = JSON.parse(breach);
	note('breach attempts: ' + JSON.stringify(b));
	const allowed = Object.entries(b).filter(([, v]) => v === 'ALLOWED').map(([k]) => k);
	check('every egress path the page could use is refused by CSP (fetch x2, XHR, WebSocket, sendBeacon)',
		allowed.length === 0, allowed.length ? 'ALLOWED: ' + allowed.join(', ') : Object.keys(b).length + '/5 refused');

	/* The spec-defined signal, read from the page's own securitypolicyviolation
	 * listener, which carries WHICH directive refused WHICH URI. "It threw" on
	 * its own would also be satisfied by an offline machine. */
	const viol = await evalJs('JSON.stringify(window.__lg.cspViolations())').then(JSON.parse);
	note('securitypolicyviolation events: ' + JSON.stringify(viol));
	const connectViol = viol.filter((v) => v.directive === 'connect-src');
	check('the refusals were CSP connect-src, reported by the browser as policy violations',
		connectViol.length >= 3,
		`${viol.length} violation events, ${connectViol.length} from connect-src: ` +
		[...new Set(connectViol.map((v) => v.blocked))].join(' '));

	/* Judged from CDP at the network layer, not from the page's own accounting —
	 * the page is the thing under test and is not a witness to its own conduct.
	 * Note a request Chrome *intended* and then refused still shows up here, so
	 * the test is "nothing foreign actually succeeded", not "nothing appeared". */
	const origin = new URL(url).origin;
	const isLocal = (u) => u.startsWith(origin) || u.startsWith('data:') ||
		u.startsWith('blob:') || u === 'about:blank';
	const foreign = netRequests.filter((r) => !isLocal(r.url));
	const foreignThatGotOut = foreign.filter((r) => r.succeeded || r.blockedReason === null);
	check('no cross-origin request ever completed; every one was refused by CSP at the network layer',
		foreignThatGotOut.length === 0,
		foreign.length
			? foreign.map((r) => `${r.method} ${r.url} -> ${r.blockedReason || (r.succeeded ? 'SUCCEEDED' : 'pending')}`).join('; ')
			: 'no cross-origin request was even attempted');
	check('the only requests that succeeded are the page\'s own files',
		netRequests.filter((r) => r.succeeded).every((r) => isLocal(r.url)),
		netRequests.filter((r) => r.succeeded && r.url.startsWith(origin))
			.map((r) => r.url.replace(origin, '')).join(' '));
	/* The wasm is embedded, which is what lets connect-src stay at 'none'. */
	check('the page never fetched a .wasm file (it is base64-embedded, so no fetch is needed)',
		!netRequests.some((r) => /\.wasm$/.test(r.url)),
		'requests: ' + netRequests.filter((r) => r.url.startsWith(origin))
			.map((r) => r.url.replace(origin, '')).join(' '));

	/* ---- 3. audio: muted by absence ---- */

	check('no AudioContext exists — muted by absence of an audio graph, not a zeroed gain',
		(await evalJs('window.__lg.audioOn()')) === false &&
		(await evalJs('window.__lg.audioContextExists()')) === false);

	/* ---- 4. play, gated on the game's own state ---- */

	await traceStart();
	const trace = await playToOverworld();
	const cb = await currentCallback();
	check('gMain.callback2 is the game\'s own CB2_Overworld',
		cb === 'CB2_Overworld',
		`${cb} (CB2_Overworld = 0x${SYM.code.CB2_Overworld.toString(16)} in our ELF)`);

	/* Each step is a SET of acceptable callbacks, because the game splits some
	 * screens into an init callback and a run callback (CB2_InitMainMenu then
	 * CB2_MainMenu) and either one is evidence that the screen was reached. */
	const flow = [['CB2_InitTitleScreen'], ['CB2_InitMainMenu', 'CB2_MainMenu'],
		['CB2_NamingScreen'], ['CB2_Overworld']];
	let cursor = -1, inOrder = true;
	for (const want of flow) {
		const at = Math.min(...want.map((w) => {
			const i = trace.indexOf(w, cursor + 1);
			return i < 0 ? Infinity : i;
		}));
		if (!Number.isFinite(at)) { inOrder = false; break; }
		cursor = at;
	}
	check('the run walked the game\'s own screens in order: title -> main menu -> naming -> overworld',
		inOrder, trace.join(' -> '));

	/* CB2_Overworld going live does NOT mean the player has control: the intro
	 * leaves a message box up, and while it is up the script engine holds
	 * sLockFieldControls, which blocks both walking and the start menu. This is
	 * the game's own answer to "is it playable right now", and it is exactly the
	 * state a screenshot cannot distinguish from play. */
	let lockPresses = 0;
	for (; lockPresses < 40; lockPresses++) {
		if ((await r8(SYM.data.sLockFieldControls)) === 0) { break; }
		await press(KEY.A, 6, 30);
	}
	check('the game reports the player has field control (sLockFieldControls is clear)',
		(await r8(SYM.data.sLockFieldControls)) === 0,
		`cleared after ${lockPresses} further A presses`);

	const before = await playerState();
	check('the player is on a map the decomp names, with a name in SaveBlock2',
		before && before.map && /^[A-Za-z]+$/.test(before.name), fmt(before));

	const luma = await evalJs('window.__lg.meanLuma()');
	check('the canvas is drawing, not black', luma > 3, `mean luma ${Number(luma).toFixed(1)}`);
	await shot('02-overworld');

	/* The player can move: walk and watch the game's own coordinates change.
	 * This is the difference between "the intro ran" and "input reaches the
	 * game", which no screenshot of a bedroom can establish.
	 *
	 * The pixel-change check is folded in here rather than measured on a still
	 * frame. A first version pumped 180 frames with no input and required the
	 * frame hash to move; standing in a bedroom, the overworld is genuinely
	 * static, so a working emulator failed it. Walking has to change pixels. */
	const hBefore = await evalJs('window.__lg.frameHash()');
	let moved = null, hAfter = hBefore;
	for (const dir of ['DOWN', 'UP', 'LEFT', 'RIGHT']) {
		await evalJs(`window.__lg.pump(48, ${KEY[dir]})`);
		await evalJs('window.__lg.pump(24, 0)');
		hAfter = await evalJs('window.__lg.frameHash()');
		const s = await playerState();
		if (s && (s.x !== before.x || s.y !== before.y)) { moved = { dir, s }; break; }
	}
	check('walking moves the player on the game\'s own tile grid (input reaches the game)',
		moved !== null,
		moved ? `${moved.dir}: (${before.x},${before.y}) -> (${moved.s.x},${moved.s.y})` :
			'no coordinate change in any direction');
	check('the picture changed while walking (the core is rendering, not wedged on one frame)',
		hBefore !== hAfter, `frame hash ${hBefore} -> ${hAfter}`);
	await shot('03-walked');

	/* ---- 5. a real in-game save, from the game's own SAVE menu ---- */

	/* Snapshot the state the save is actually going to record. An earlier
	 * version compared the post-reload state against `before`, which was read
	 * BEFORE the walk -- so a correct restore to the tile the player had walked
	 * to was scored as a mismatch. Compare against the state at the moment of
	 * saving. */
	const atSave = await playerState();
	note('state being saved: ' + fmt(atSave));

	const SAVE_IDX = SYM.enums.STARTMENU_SAVE;
	let opened = false, menu = [], cursorPos = -1;
	for (let i = 0; i < 6 && !opened; i++) {
		await press(KEY.START, 6, 30);
		const n = await r8(SYM.data.sNumStartMenuItems);
		if (n > 0 && n <= SYM.enums.MAX_STARTMENU_ITEMS) {
			menu = await blk(SYM.data.sStartMenuOrder, n);
			cursorPos = await r8(SYM.data.sStartMenuCursorPos);
			if (menu.includes(SAVE_IDX)) { opened = true; }
		}
	}
	check('the start menu opened and the game built a menu containing SAVE',
		opened, `sNumStartMenuItems=${menu.length} sStartMenuOrder=[${menu}] (STARTMENU_SAVE=${SAVE_IDX})`);

	const wantPos = menu.indexOf(SAVE_IDX);
	note(`cursor at ${cursorPos}, SAVE is entry ${wantPos} of ${menu.length}`);
	for (let i = 0; i < menu.length * 2 && cursorPos !== wantPos; i++) {
		await press(cursorPos < wantPos ? KEY.DOWN : KEY.UP, 5, 9);
		cursorPos = await r8(SYM.data.sStartMenuCursorPos);
	}
	check('the menu cursor is on SAVE before anything is confirmed',
		cursorPos === wantPos, `sStartMenuCursorPos=${cursorPos}, wanted ${wantPos}`);
	await shot('04-start-menu');

	const hashBeforeSave = await evalJs('window.__lg.saveHash()');
	/* A through the save-info window, the "would you like to save?" prompt (YES
	 * is the default) and the confirmation. Watch the cartridge save hash rather
	 * than counting presses: the hash moving is the game writing flash. */
	let hashAfterSave = hashBeforeSave, pressesToSave = 0;
	for (let i = 0; i < 40; i++) {
		await press(KEY.A, 6, 16);
		pressesToSave++;
		hashAfterSave = await evalJs('window.__lg.saveHash()');
		if (hashAfterSave !== hashBeforeSave) { break; }
	}
	check('the GAME wrote its cartridge flash when SAVE was confirmed',
		hashAfterSave !== hashBeforeSave,
		`save hash ${hashBeforeSave} -> ${hashAfterSave} after ${pressesToSave} A presses`);
	await shot('05-saved');

	/* Wait for the write to FINISH, by watching the save buffer settle.
	 *
	 * This is the bug the first run of this harness shipped: it pumped a fixed
	 * 240 frames after the save hash first moved, flushed, and reloaded — and
	 * the game then reported SAVE_STATUS_INVALID, because LeafGreen writes its
	 * 14 flash sectors one at a time over about 300 frames (~5 s of emulated
	 * time). 240 frames captured a half-written save whose sector checksums did
	 * not validate. The bytes persisted perfectly; they were simply the wrong
	 * bytes. A fixed frame count is the wrong instrument — wait for the buffer
	 * to stop moving instead. */
	let settleFrames = 0, stable = 0, lastHash = await evalJs('window.__lg.saveHash()');
	for (let i = 0; i < 40; i++) {
		await evalJs('window.__lg.pump(60, 0)');
		settleFrames += 60;
		const h = await evalJs('window.__lg.saveHash()');
		if (h === lastHash) { stable++; } else { stable = 0; lastHash = h; }
		if (stable >= 4) { break; }
	}
	check('the save write ran to completion (cartridge flash stopped changing)',
		stable >= 4, `settled after ${settleFrames} frames, final save hash ${lastHash}`);

	/* 14 sectors carrying the game's own save signature is what a complete
	 * LeafGreen save slot looks like; a partial write has fewer. Checked here so
	 * a future regression in the settle loop fails loudly rather than producing
	 * an invalid save that merely persists well. */
	const sig = await evalJs(`(() => {
		const b = window.__lg.readSaveBytes(0, 0);  /* force the pointer */
		let n = 0;
		for (let s = 0; s < 131072; s += 0x1000) {
			const f = window.__lg.readSaveBytes(s + 0xFF8, 4);
			if ((f[0] | (f[1] << 8) | (f[2] << 16) | (f[3] << 24)) >>> 0 === 0x08012025) { n++; }
		}
		return n;
	})()`);
	check('the saved image has 14 sectors carrying the game\'s own save signature',
		sig === 14, `${sig} sectors with signature 0x08012025`);

	await evalJs('window.__lg.flushSave()', true);
	/* readPersistedSave() is async: JSON.stringify of the Promise itself gives
	 * "{}", which is what crashed the first run inside Buffer.from. Resolve it
	 * in the page and stringify the result. */
	const persistedBefore = await evalJs(
		'window.__lg.readPersistedSave().then(function (a) { return JSON.stringify(a); })', true);
	const pb = JSON.parse(persistedBefore);
	const pbHash = pb ? createHash('sha1').update(Buffer.from(pb)).digest('hex') : null;
	check('the save is in IndexedDB before the reload',
		pb && pb.length === 131072, pb ? `${pb.length} B, sha1 ${pbHash.slice(0, 12)}` : 'nothing stored');

	/* ---- 6. reload the page for real, and continue from the save ---- */

	await goto(url);
	await waitFor('!!(window.__lg && window.__lg.ready)', 40000, 'core init after reload');
	await waitFor('!!(window.__lg && window.__lg.running)', 40000, 'resume from the cached ROM');
	check('the ROM resumes from local cache after a reload (no re-pick needed)', true);

	const persistedAfter = await evalJs(
		'window.__lg.readPersistedSave().then(function (a) { return JSON.stringify(a); })', true);
	const pa = JSON.parse(persistedAfter);
	const paHash = pa ? createHash('sha1').update(Buffer.from(pa)).digest('hex') : null;
	check('the save in IndexedDB is byte-identical after the reload',
		pbHash !== null && pbHash === paHash,
		`${pbHash ? pbHash.slice(0, 12) : 'null'} -> ${paHash ? paHash.slice(0, 12) : 'null'}, ${pa ? pa.length : 0} B`);

	/* The claim that matters: the GAME reads its own save back. gSaveFileStatus
	 * is set by the game's own load path, so SAVE_STATUS_OK is the game saying
	 * it found a valid save -- not us inferring it from a file hash. */
	await evalJs('window.__lg.pump(240, 0)');
	const status = await r8(SYM.data.gSaveFileStatus);
	check('the game\'s own gSaveFileStatus reads SAVE_STATUS_OK after the reload',
		status === SYM.enums.SAVE_STATUS_OK,
		`gSaveFileStatus=${status} (SAVE_STATUS_OK=${SYM.enums.SAVE_STATUS_OK}, EMPTY=${SYM.enums.SAVE_STATUS_EMPTY})`);
	await shot('06-after-reload-title-sequence');

	/* CONTINUE is the first entry on the main menu once a save exists, so A
	 * takes it. Then wait for the overworld and compare state. */
	await traceStart();
	for (let i = 0; i < 160; i++) {
		await press(KEY.A, 6, 12);
		const c = await currentCallback();
		if (c === 'CB2_Overworld') { await evalJs('window.__lg.pump(180, 0)'); break; }
	}
	const trace2 = await traceGet();
	const after = await playerState();
	check('continuing from the save puts the player back in the overworld',
		(await currentCallback()) === 'CB2_Overworld', trace2.join(' -> '));
	check('the restored game has the same player name, map and tile that were saved',
		after && atSave && after.name === atSave.name && after.map === atSave.map &&
		after.x === atSave.x && after.y === atSave.y,
		`saved ${fmt(atSave)}  ->  restored ${fmt(after)}`);
	/* And it is a CONTINUE, not a fresh game: a new game would have gone through
	 * the naming screen again, and would not have restored the saved tile. */
	check('the reload continued the saved game rather than starting a new one',
		!trace2.includes('CB2_NamingScreen'), trace2.join(' -> '));
	await shot('07-continued');

	/* ---- 7. hygiene ---- */

	check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | ') || 'none');
	check('no console errors other than the CSP refusals we provoked',
		consoleErrors.length === 0, consoleErrors.join(' | ') || 'none');
	check('still running at the end of the test',
		(await evalJs('window.__lg.running')) === true,
		(await evalJs('window.__lg.frames')) + ' frames total');

} catch (e) {
	check('harness completed', false, e.message);
	if (pageErrors.length) { console.log('page errors: ' + pageErrors.join(' | ')); }
} finally {
	const failed = results.filter((r) => !r.ok);
	console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
	if (outDir) {
		writeFileSync(outDir + '/results.json', JSON.stringify({
			results, netRequests, cspConsoleMessages: cspViolations, pageErrors, consoleErrors
		}, null, 2));
	}
	ws.close();
	process.exit(failed.length ? 1 : 0);
}
