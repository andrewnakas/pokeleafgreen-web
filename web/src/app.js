/* Pokémon LeafGreen — page logic.
 *
 * Adapted from the pokeruby agent's page (same fleet, same mGBA shim). The
 * differences worth knowing about:
 *
 *  - This is a separate file rather than an inline <script> because the page's
 *    Content-Security-Policy has no 'unsafe-inline'. See the comment in
 *    index.html: the CSP is the mechanism that keeps the ROM local, so nothing
 *    here is allowed to need a looser one.
 *  - The ROM is sha1'd in-page and identified against the three LeafGreen
 *    hashes the decompilation documents in its own *.sha1 files.
 *  - window.__lg exposes GBA bus reads, so the self-test can ask the GAME what
 *    state it is in instead of guessing from pixels.
 */
(function () {
'use strict';

var $ = function (id) { return document.getElementById(id); };
var canvas = $('canvas'), ctx = canvas.getContext('2d', { alpha: false });
ctx.imageSmoothingEnabled = false;
/* Inline oncontextmenu would be refused by script-src. */
canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

var M = null, api = null;
var W = 240, H = 160, fbPtr = 0, imageData = null;
var running = false, romName = '', romSize = 0, romSha1 = '', romDump = '';

/* The hashes `pret/pokefirered` documents for LeafGreen, copied from the
 * repository's own leafgreen*.sha1 files at the pinned revision — not from a
 * ROM site. rev1 is the one this project's matching build reproduces. */
var KNOWN = {
  '7862c67bdecbe21d1d69ce082ce34327e1c6ed5e': 'LeafGreen (USA, Europe) (Rev 1)',
  '574fa542ffebb14be69902d1d36f1ec0a4afd71e': 'LeafGreen (USA, Europe) (Rev 0)',
  '62b9fc77549dbc67032eb6cbd0ea6ad3b825690f': 'LeafGreen (Switch Online)'
};
var MATCHING = '7862c67bdecbe21d1d69ce082ce34327e1c6ed5e';

/* ---------------------------------------------------------------- storage */
/* IndexedDB, not localStorage: the ROM is 16 MB and the cartridge save is
 * 128 KB, both past localStorage's limit and both binary. All of it is local to
 * this browser profile; the page cannot make a network request at all. */
var DB = 'pokeleafgreen-web', STORE = 'blobs';

function idb() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open(DB, 1);
    r.onupgradeneeded = function (e) { e.target.result.createObjectStore(STORE); };
    r.onsuccess = function (e) { res(e.target.result); };
    r.onerror = function (e) { rej(e.target.error); };
  });
}
function idbGet(k) {
  return idb().then(function (db) {
    return new Promise(function (res) {
      var r = db.transaction(STORE, 'readonly').objectStore(STORE).get(k);
      r.onsuccess = function () { res(r.result || null); };
      r.onerror = function () { res(null); };
    });
  }).catch(function () { return null; });
}
function idbPut(k, v) {
  return idb().then(function (db) {
    return new Promise(function (res, rej) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(v, k);
      tx.oncomplete = function () { res(); };
      tx.onerror = function (e) { rej(e.target.error); };
    });
  });
}
function idbDel(k) {
  return idb().then(function (db) {
    return new Promise(function (res) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(k);
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { res(); };
    });
  }).catch(function () {});
}

/* Keyed per cartridge game code, so a FireRed save could never land on top of a
 * LeafGreen one. The code is read from the header in JS rather than from the
 * core, because the save has to be restored BEFORE loadROM and the core knows
 * nothing until after. */
var saveKey = 'save', stateKey = 'state';

function gameCodeOf(bytes) {
  if (bytes.length < 0xB0) { return 'UNKNOWN'; }
  var s = '';
  for (var i = 0xAC; i < 0xB0; i++) { s += String.fromCharCode(bytes[i]); }
  return /^[A-Z0-9]{4}$/.test(s) ? s : 'UNKNOWN';
}

function sha1Hex(buf) {
  /* Web Crypto, so the page does not ship a hash implementation. Needs a secure
   * context, which localhost and https both are. */
  if (!(window.crypto && crypto.subtle)) { return Promise.resolve(''); }
  return crypto.subtle.digest('SHA-1', buf).then(function (d) {
    return Array.prototype.map.call(new Uint8Array(d), function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }).catch(function () { return ''; });
}

/* ------------------------------------------------------------------ status */

function setStat(t) { $('stat').textContent = t; }
function setErr(t) { $('err').textContent = t || ''; }

/* ------------------------------------------------------------------- input */

var KEY = { A:1, B:2, SELECT:4, START:8, RIGHT:16, LEFT:32, UP:64, DOWN:128, R:256, L:512 };
var MAP = {
  KeyZ:KEY.A, KeyX:KEY.B, Enter:KEY.START, ShiftRight:KEY.SELECT, ShiftLeft:KEY.SELECT,
  ArrowUp:KEY.UP, ArrowDown:KEY.DOWN, ArrowLeft:KEY.LEFT, ArrowRight:KEY.RIGHT,
  KeyA:KEY.L, KeyS:KEY.R, Backspace:KEY.SELECT
};
var held = 0;
/* Keys injected by the self-test harness, OR-ed with real input so a human and
 * the harness cannot fight over one variable. */
var scripted = 0;

addEventListener('keydown', function (e) {
  var b = MAP[e.code];
  if (b) { held |= b; e.preventDefault(); }
});
addEventListener('keyup', function (e) {
  var b = MAP[e.code];
  if (b) { held &= ~b; e.preventDefault(); }
});
addEventListener('blur', function () { held = 0; });

/* Standard-gamepad mapping, polled once per rendered frame. Nothing is
 * registered until a pad reports itself, so this costs nothing otherwise. */
var PAD = { 0:KEY.A, 1:KEY.B, 2:KEY.B, 3:KEY.A, 4:KEY.L, 5:KEY.R, 8:KEY.SELECT, 9:KEY.START,
            12:KEY.UP, 13:KEY.DOWN, 14:KEY.LEFT, 15:KEY.RIGHT };
function padBits() {
  if (!navigator.getGamepads) { return 0; }
  var pads = navigator.getGamepads(), bits = 0;
  for (var i = 0; i < pads.length; i++) {
    var g = pads[i];
    if (!g || !g.connected) { continue; }
    for (var b in PAD) {
      if (g.buttons[b] && g.buttons[b].pressed) { bits |= PAD[b]; }
    }
    var ax = g.axes[0] || 0, ay = g.axes[1] || 0;
    if (ax < -0.5) { bits |= KEY.LEFT; } else if (ax > 0.5) { bits |= KEY.RIGHT; }
    if (ay < -0.5) { bits |= KEY.UP; } else if (ay > 0.5) { bits |= KEY.DOWN; }
  }
  return bits;
}

/* ------------------------------------------------------------------- audio */
/* No AudioContext exists until the user asks for one. "Muted" here means there
 * is no audio graph at all, not a gain node set to zero — which is why the
 * self-test can assert muting by asserting the object's absence. */
var ac = null, audioOn = false, audioBufPtr = 0;

function toggleAudio() {
  if (audioOn) {
    audioOn = false;
    if (ac) { ac.close(); ac = null; }
    $('mutebtn').className = 'muted';
    $('mutebtn').textContent = '🔇 muted — click for sound';
    return;
  }
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: api.sampleRate() });
    var node = ac.createScriptProcessor(1024, 0, 2);
    node.onaudioprocess = function (ev) {
      var l = ev.outputBuffer.getChannelData(0), r = ev.outputBuffer.getChannelData(1);
      var want = l.length;
      var got = api.drainAudio(want);
      var buf = new Int16Array(M.HEAP16.buffer, audioBufPtr, got * 2);
      for (var i = 0; i < want; i++) {
        if (i < got) { l[i] = buf[i * 2] / 32768; r[i] = buf[i * 2 + 1] / 32768; }
        else { l[i] = 0; r[i] = 0; }
      }
    };
    node.connect(ac.destination);
    ac.resume();
    audioOn = true;
    $('mutebtn').className = '';
    $('mutebtn').textContent = '🔊 sound on — click to mute';
  } catch (e) {
    setErr('could not start audio: ' + e.message);
  }
}

/* ------------------------------------------------------------------- video */

function blit() {
  /* ALLOW_MEMORY_GROWTH can detach the old heap view, so take a fresh subarray
   * each frame rather than caching one. */
  api.opaque();
  var src = new Uint8ClampedArray(M.HEAPU8.buffer, fbPtr, W * H * 4);
  imageData.data.set(src);
  ctx.putImageData(imageData, 0, 0);
}

/* ---------------------------------------------------------------- run loop */

var FPS = 59.7275, acc = 0, last = 0, framesRun = 0;

function loop(t) {
  if (!running) { return; }
  requestAnimationFrame(loop);
  if (!last) { last = t; }
  var dt = (t - last) / 1000;
  last = t;
  if (dt > 0.25) { dt = 0.25; }           /* after a tab switch, don't fast-forward */
  acc += dt * FPS;
  var n = Math.floor(acc);
  if (n > 4) { n = 4; }                   /* cap catch-up so a slow frame can't spiral */
  acc -= Math.floor(acc);
  var bits = held | scripted | padBits();
  for (var i = 0; i < n; i++) {
    api.setKeys(bits);
    api.runFrame();
    framesRun++;
    /* The callback tracer has to witness frames from BOTH frame sources. The
     * self-test drives frames through pump(), but this rAF loop keeps running
     * at the same time, and a trace that only sampled pump()'s frames missed
     * CB2_MainMenu on some runs purely depending on which loop happened to
     * execute the frames that crossed it. Two frame sources, one instrumented,
     * is a flaky test by construction. */
    traceSample();
  }
  if (n > 0) { blit(); }
  maybePersistSave();
}

/* ------------------------------------------- cartridge save -> IndexedDB */

var lastSaveHash = 0, savePending = false, saveTimer = 0;

function maybePersistSave() {
  if (savePending || !api) { return; }
  /* Hashing 128 KB every frame would be wasteful; check a few times a second. */
  var now = performance.now();
  if (now - saveTimer < 1000) { return; }
  saveTimer = now;
  var h = api.saveHash();
  if (h === lastSaveHash) { return; }
  lastSaveHash = h;
  savePending = true;
  var ptr = api.saveBuffer(), len = api.saveSize();
  var bytes = M.HEAPU8.slice(ptr, ptr + len);
  idbPut(saveKey, bytes.buffer).then(function () {
    savePending = false;
    var d = $('savedot');
    d.className = 'on';
    setTimeout(function () { d.className = ''; }, 900);
  }).catch(function (e) {
    savePending = false;
    setErr('could not write save data: ' + e.message);
  });
}

function flushSaveNow() {
  if (!api || !running) { return Promise.resolve(); }
  var ptr = api.saveBuffer(), len = api.saveSize();
  return idbPut(saveKey, M.HEAPU8.slice(ptr, ptr + len).buffer).catch(function () {});
}
/* pagehide fires on reload and on mobile tab eviction; visibilitychange covers
 * backgrounding. Both matter — an in-game save a second before a reload would
 * otherwise be lost. Nothing here unmounts or clears anything: the EmulatorJS
 * trap the pokefirered agent documented (a beforeunload handler that ends in
 * FS.unmount and empties the store) does not exist on this stack, because there
 * is no emulator frontend and no emscripten filesystem — FILESYSTEM=0. */
addEventListener('pagehide', flushSaveNow);
addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') { flushSaveNow(); }
});

/* ------------------------------------------------------------- savestates */

function saveState() {
  var ptr = api.stateSave(), n = api.stateSize();
  if (!ptr || !n) { setErr('savestate failed'); return Promise.resolve(false); }
  return idbPut(stateKey, M.HEAPU8.slice(ptr, ptr + n).buffer).then(function () {
    setStat('state saved');
    return true;
  });
}
function loadState() {
  return idbGet(stateKey).then(function (buf) {
    if (!buf) { setStat('no saved state'); return false; }
    var bytes = new Uint8Array(buf);
    var p = M._malloc(bytes.length);
    M.HEAPU8.set(bytes, p);
    var ok = api.stateLoad(p, bytes.length);
    M._free(p);
    setStat(ok ? 'state loaded' : 'state did not match this ROM');
    return !!ok;
  });
}

/* ------------------------------------------------------------------ booting */

function startWithRom(bytes, name) {
  setErr('');
  romName = name || 'ROM';
  romSize = bytes.length;
  var code = gameCodeOf(bytes);
  saveKey = 'save:' + code;
  stateKey = 'state:' + code;

  /* Copy into a standalone ArrayBuffer: digest() on a view of a buffer that
   * later gets detached (or on the IDB-returned buffer) is a trap. */
  return sha1Hex(bytes.slice().buffer).then(function (hex) {
    romSha1 = hex;
    romDump = KNOWN[hex] || '';
    return idbGet(saveKey);
  }).then(function (saveBuf) {
    /* Restore the cartridge save BEFORE loadROM: mGBA reads the buffer when it
     * attaches the save media, so restoring afterwards is ignored. */
    if (saveBuf) {
      var s = new Uint8Array(saveBuf);
      var sp = M._malloc(s.length);
      M.HEAPU8.set(s, sp);
      api.saveRestore(sp, s.length);
      M._free(sp);
    }
    var p = M._malloc(bytes.length);
    M.HEAPU8.set(bytes, p);
    var ok = api.loadRom(p, bytes.length);
    M._free(p);
    if (!ok) { throw new Error('mGBA rejected this file as a GBA ROM'); }

    var title = api.title();
    if (!/^POKEMON LEAF/.test(title)) {
      throw new Error('that ROM reports itself as "' + title.trim() +
        '" — this page expects Pokémon LeafGreen');
    }

    fbPtr = api.framebuffer();
    W = api.width(); H = api.height();
    canvas.width = W; canvas.height = H;
    imageData = ctx.createImageData(W, H);
    lastSaveHash = api.saveHash();

    $('overlay').className = 'hidden';
    var what = romDump ? romDump : 'unrecognised dump';
    if (romSha1 === MATCHING) { what += ' · matches this build'; }
    setStat('POKEMON LEAFGREEN · rev ' + api.revision() + ' · ' + what);
    running = true;
    last = 0; acc = 0;
    requestAnimationFrame(loop);
    canvas.focus();
    return true;
  });
}

function handleFile(file) {
  if (!file) { return; }
  setErr('');
  setStat('reading ' + file.name + '…');
  file.arrayBuffer().then(function (ab) {
    var bytes = new Uint8Array(ab);
    /* Cache the ROM locally so a reload does not need the picker again. It
     * still never leaves the device — it cannot; see the CSP. */
    return idbPut('rom', ab).catch(function () { /* quota: run anyway */ })
      .then(function () { return idbPut('romName', file.name); })
      .catch(function () {})
      .then(function () { return startWithRom(bytes, file.name); });
  }).catch(function (e) {
    setErr(e.message);
    setStat('');
  });
}

$('rom-file').addEventListener('change', function (e) { handleFile(e.target.files[0]); });
$('pick').addEventListener('click', function () { $('rom-file').click(); });
['dragenter', 'dragover'].forEach(function (t) {
  document.addEventListener(t, function (e) { e.preventDefault(); $('pick').classList.add('drag'); });
});
['dragleave', 'drop'].forEach(function (t) {
  document.addEventListener(t, function (e) { e.preventDefault(); $('pick').classList.remove('drag'); });
});
document.addEventListener('drop', function (e) {
  if (e.dataTransfer.files.length) { handleFile(e.dataTransfer.files[0]); }
});

$('mutebtn').addEventListener('click', function () { if (api) { toggleAudio(); } });
$('savebtn').addEventListener('click', function () { if (running) { saveState(); } });
$('loadbtn').addEventListener('click', function () { if (running) { loadState(); } });
$('forget').addEventListener('click', function () {
  Promise.all([idbDel('rom'), idbDel('romName')]).then(function () {
    setStat('ROM forgotten — reload to pick another');
  });
});

/* ---------------------------------------------------------- callback trace */

var traceAddr = 0, traceNames = {}, traceSeen = [];

function traceSample() {
  if (!traceAddr) { return; }
  var ptr = api.read32(traceAddr) >>> 0;
  var nm = traceNames[(ptr & ~1) >>> 0];
  if (nm && traceSeen[traceSeen.length - 1] !== nm) { traceSeen.push(nm); }
}

/* ------------------------------------------------- CSP violations, observed */
/* The spec-defined signal that the policy actually refused something, carrying
 * the directive that did it. Collected so the self-test can show the CSP is
 * enforced rather than merely present in a meta tag. */
var cspSeen = [];
document.addEventListener('securitypolicyviolation', function (e) {
  cspSeen.push({
    directive: e.effectiveDirective || e.violatedDirective,
    blocked: String(e.blockedURI || '').slice(0, 120),
    disposition: e.disposition
  });
});

/* ------------------------------------------------------- self-test hooks */
/* Used by test/browser-check.mjs over the DevTools protocol. Nothing here
 * changes behaviour unless the harness calls it. The read* functions are
 * read-only on purpose: there is no bus write, so the harness cannot poke the
 * game into a state it did not reach by playing. */
window.__lg = {
  ready: false,
  get running() { return running; },
  get frames() { return framesRun; },
  romSha1: function () { return romSha1; },
  romDump: function () { return romDump; },
  romSize: function () { return romSize; },
  gameCode: function () { return saveKey.replace(/^save:/, ''); },
  meanLuma: function () { return api ? api.meanLuma() : -1; },
  frameHash: function () { return api ? api.frameHash() : 0; },
  title: function () { return api ? api.title() : ''; },
  revision: function () { return api ? api.revision() : -1; },
  saveHash: function () { return api ? api.saveHash() : 0; },
  saveSize: function () { return api ? api.saveSize() : 0; },
  audioOn: function () { return audioOn; },
  audioContextExists: function () { return !!ac; },
  setScripted: function (bits) { scripted = bits | 0; },
  /* Run n frames synchronously, bypassing rAF so a headless run is not at the
   * mercy of the compositor's frame pacing. */
  pump: function (n, bits) {
    if (!api || !running) { return 0; }
    for (var i = 0; i < n; i++) {
      api.setKeys((bits | 0) | held);
      api.runFrame();
      framesRun++;
      traceSample();
    }
    blit();
    return framesRun;
  },
  /* Record gMain.callback2 once per emulated frame, inside the page.
   *
   * This cannot live in the harness: sampling over the DevTools protocol costs
   * a round trip per read, and A-mashing crosses the title screen and the main
   * menu in well under half a second. Sampling from outside produced a trace
   * with both of those missing, and a failing assertion that was actually true.
   * `names` maps a callback address (Thumb bit cleared) to its symbol name and
   * comes from our own built ELF via tools/symbols.py. */
  traceStart: function (addr, names) {
    traceAddr = addr >>> 0;
    traceNames = names || {};
    traceSeen = [];
    return true;
  },
  traceGet: function () { return traceSeen.slice(); },
  traceStop: function () { traceAddr = 0; },
  cspViolations: function () { return cspSeen.slice(); },
  /* GBA bus reads, for asserting on the game's own state. */
  read8: function (a) { return api ? api.read8(a >>> 0) : 0; },
  read16: function (a) { return api ? api.read16(a >>> 0) : 0; },
  read32: function (a) { return api ? api.read32(a >>> 0) >>> 0 : 0; },
  readBlock: function (a, n) {
    if (!api) { return []; }
    var p = api.readBlock(a >>> 0, n | 0);
    return Array.from(M.HEAPU8.subarray(p, p + (n | 0)));
  },
  canvasDataUrl: function () { return canvas.toDataURL('image/png'); },
  saveState: saveState,
  loadState: loadState,
  flushSave: flushSaveNow,
  readSaveBytes: function (off, n) {
    var ptr = api.saveBuffer();
    return Array.from(M.HEAPU8.subarray(ptr + (off | 0), ptr + (off | 0) + (n || 16)));
  },
  /* Read the persisted copy straight out of IndexedDB, so "the save survived"
   * is measured where it actually has to survive rather than in live memory. */
  readPersistedSave: function () {
    return idbGet(saveKey).then(function (buf) {
      return buf ? Array.from(new Uint8Array(buf)) : null;
    });
  }
};

/* ------------------------------------------------------------------- init */

createGBA().then(function (mod) {
  M = mod;
  api = {
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
    sampleRate: M.cwrap('vj_sample_rate', 'number', []),
    drainAudio: M.cwrap('vj_drain_audio', 'number', ['number']),
    audioBuffer: M.cwrap('vj_audio_buffer', 'number', []),
    saveBuffer: M.cwrap('vj_save_buffer', 'number', []),
    saveSize: M.cwrap('vj_save_size', 'number', []),
    saveHash: M.cwrap('vj_save_hash', 'number', []),
    saveRestore: M.cwrap('vj_save_restore', 'number', ['number', 'number']),
    stateSize: M.cwrap('vj_state_size', 'number', []),
    stateSave: M.cwrap('vj_state_save', 'number', []),
    stateLoad: M.cwrap('vj_state_load', 'number', ['number', 'number']),
    read8: M.cwrap('vj_read8', 'number', ['number']),
    read16: M.cwrap('vj_read16', 'number', ['number']),
    read32: M.cwrap('vj_read32', 'number', ['number']),
    readBlock: M.cwrap('vj_read_block', 'number', ['number', 'number'])
  };
  if (!api.init()) { setErr('could not start the emulator core'); return; }
  audioBufPtr = api.audioBuffer();
  window.__lg.ready = true;
  setStat('ready — choose a ROM');

  /* Auto-resume from the locally cached ROM. */
  return Promise.all([idbGet('rom'), idbGet('romName')]).then(function (r) {
    if (r[0]) {
      return startWithRom(new Uint8Array(r[0]), r[1] || 'cached ROM');
    }
  });
}).catch(function (e) {
  setErr('startup failed: ' + e.message);
});

})();
