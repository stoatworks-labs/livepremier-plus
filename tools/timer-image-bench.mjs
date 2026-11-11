#!/usr/bin/env node
/*
 * Timer Image on a real Midra 4K / Alta 4K: how long a clock picture takes
 * from upload to a Foreground Image, measured the way the plugin does it
 * (upload into the first empty library slot, point the frame at it, empty
 * the slot before) but from a script, with gates a live show can live with.
 *
 * Gates, checked before every write; any failure stops the run, points the
 * frame back at NONE and empties what it uploaded:
 *   - every slot below --min-slot holds a file, so the switcher's
 *     first-empty-slot upload lands at --min-slot or above, and the slot it
 *     really landed in is read back: at or above, and named by us;
 *   - no Background/Foreground Image on any screen, nor the quick-preset
 *     frame, points at the slot the upload will land in;
 *   - neither of the screen's preset buffers (UP, DOWN) has its top layer on
 *     the frame, and no quick-preset FRAME is up. If either happens mid-run
 *     the frame goes to NONE on that same message and the run stops;
 *   - the frame starts empty, and only slots carrying our file names
 *     (lpp-timer-S<n>-FRG<k>-a|b.png) are ever emptied.
 *
 * Phase A pushes one picture every few seconds and polls the frame's own
 * thumbnail (/api/device/snapshots/screens/<n>/top/<k>) until it changes:
 * the time until the switcher has the new picture in the frame. Phase B is
 * the plugin's loop, a new picture each second, as fast as it keeps up.
 *
 *   node tools/timer-image-bench.mjs --device 127.0.0.1:3010 --screen 2 --frame 4 --dry
 *   node tools/timer-image-bench.mjs --device <ip> --screen 2 --frame 4 --min-slot 3 \
 *        --i-have-permission [--a 8] [--b 60] [--out <dir>]
 *
 * First run on a real Pulse 4K (3.3.10) on 2026-11-11, during a live event,
 * with the operator's go-ahead for S2 and slots 3+: AGENTS.md, Timer Image.
 */

import zlib from 'node:zlib';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const HOST = String(args.device || '');
const SCREEN = String(args.screen || '');
const FRAME = String(args.frame || '');
const MIN_SLOT = Number(args['min-slot'] ?? 3);
const DRY = args.dry === true;
const A_COUNT = Number(args.a ?? 8);
const B_SECONDS = Number(args.b ?? 60);
const OUT = path.resolve(String(args.out || path.join(os.tmpdir(), 'timer-image-bench')));

if (!/^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(HOST)) { console.error('--device <ip>[:port] is required'); process.exit(2); }
if (!/^[1-4]$/.test(SCREEN) || !/^[1-4]$/.test(FRAME)) { console.error('--screen 1-4 and --frame 1-4 are required: the Foreground Image to repoint'); process.exit(2); }
if (!Number.isInteger(MIN_SLOT) || MIN_SLOT < 1 || MIN_SLOT > 49) { console.error('--min-slot is 1-49'); process.exit(2); }
if (!HOST.startsWith('127.0.0.1') && !DRY && args['i-have-permission'] !== true) {
  console.error(`This uploads into ${HOST}'s image library and repoints S${SCREEN} FRG${FRAME}. Add --i-have-permission once the operator has said which screen, frame and slots are yours, or --dry to check the gates only.`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const OWN = new RegExp(`^lpp-timer-S${SCREEN}-FRG${FRAME}-[ab]\\.png$`);
const ownName = (side) => `lpp-timer-S${SCREEN}-FRG${FRAME}-${side}.png`;

const t = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

/* ------------------------------------------------------------------ store */

let store = null;
const pending = [];
const waiters = new Set();
const frameLog = [];

function setPath(p, value) {
  let o = store;
  for (let i = 0; i < p.length - 1; i++) {
    if (o[p[i]] == null || typeof o[p[i]] !== 'object') o[p[i]] = {};
    o = o[p[i]];
  }
  o[p[p.length - 1]] = value;
}
function get(p) {
  let o = store;
  for (const k of p) { if (o == null) return undefined; o = o[k]; }
  return o;
}
const D = (...p) => ['device', ...p];
const libStatus = (n) => get(D('stillLibrary', 'bankList', 'items', String(n), 'status', 'pp')) || {};
const frameSlot = (screen, k, list = 'topFrameList') => String(get(D('screenList', 'items', String(screen), list, 'items', String(k), 'control', 'pp', 'librarySlot')) ?? 'NONE');
const topSel = (screen, buf) => String(get(D('screenList', 'items', String(screen), 'presetList', 'items', buf, 'top', 'source', 'pp', 'frame')) ?? 'NONE');
const screens = () => Object.keys(get(D('screenList', 'items')) || {});

function predictedSlot() {
  for (let n = 1; n <= 50; n++) if (libStatus(n).isValid !== true) return n;
  return null;
}
function pointersAt(slot) {
  const out = [];
  for (const s of screens()) {
    for (const list of ['backFrameList', 'topFrameList']) {
      for (let k = 1; k <= 4; k++) if (frameSlot(s, k, list) === String(slot)) out.push(`S${s} ${list === 'topFrameList' ? 'FRG' : 'BKG'}${k}`);
    }
  }
  const qp = get(D('quickPreset', 'control', 'mode', 'frame', 'pp', 'bankSlot'));
  if (String(qp) === String(slot)) out.push('quick preset frame');
  return out;
}
function onAirProblem() {
  for (const buf of ['UP', 'DOWN']) if (topSel(SCREEN, buf) === FRAME) return `S${SCREEN} ${buf} top layer selects FRG${FRAME}`;
  const qp = get(D('quickPreset', 'control', 'pp')) || {};
  if (qp.enable === true && qp.mode === 'FRAME') return 'a quick preset FRAME is up';
  return null;
}
function uploadProblem() {
  for (let n = 1; n < MIN_SLOT; n++) if (libStatus(n).isValid !== true) return `library slot ${n} is empty: an upload would land below slot ${MIN_SLOT}`;
  const p = predictedSlot();
  if (p == null) return 'library full';
  if (p < MIN_SLOT) return `next upload would land in slot ${p}`;
  const who = pointersAt(p);
  if (who.length) return `slot ${p} is pointed at by ${who.join(', ')}`;
  return null;
}

function waitFor(pred, ms) {
  return new Promise((resolve) => {
    if (pred()) return resolve(t());
    const w = { pred, resolve };
    waiters.add(w);
    setTimeout(() => { if (waiters.delete(w)) resolve(null); }, ms);
  });
}

/* --------------------------------------------------------------- transport */

const ws = new WebSocket(`ws://${HOST}/`);
ws.addEventListener('message', (ev) => {
  let f; try { f = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
  if (!f || f.channel !== 'DEVICE' || !f.data || !Array.isArray(f.data.path)) return;
  const at = t();
  const p = f.data.path.join('/');
  if (/stillLibrary\/bankList|topFrameList|presetList\/items\/(UP|DOWN)\/top|quickPreset|timerList/.test(p)) frameLog.push({ at, path: p, value: f.data.value });
  if (!store) { pending.push(f.data); return; }
  setPath(f.data.path, f.data.value);
  for (const w of [...waiters]) if (w.pred()) { waiters.delete(w); w.resolve(at); }
  if (running && onAirProblem()) void bail(onAirProblem());
});
const opened = new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', (e) => reject(new Error('WebSocket error')), { once: true });
});

function send(p, value) {
  if (DRY) { log('DRY would send', p.join('/'), JSON.stringify(value)); return; }
  ws.send(JSON.stringify({ channel: 'DEVICE', data: { path: D(...p), value } }));
}
const framePath = [ 'screenList', 'items', SCREEN, 'topFrameList', 'items', FRAME, 'control', 'pp', 'librarySlot' ];
const deletePath = (n) => ['stillLibrary', 'bankList', 'items', String(n), 'control', 'pp', 'xDelete'];

/* -------------------------------------------------------------- the picture */

// Seven-segment digits, white on black, 480 x 135 RGBA. Segments a..g.
const SEGS = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
function clockPng(text, W = 480, H = 135) {
  const px = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { px[i * 4 + 3] = 255; }
  const rect = (x0, y0, w, h) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) {
      const o = (y * W + x) * 4; px[o] = px[o + 1] = px[o + 2] = 255;
    }
  };
  const dw = 46, dh = 96, th = 10, gap = 10, cw = 18;
  const chars = [...text];
  const width = chars.reduce((s, c) => s + (c === ':' ? cw : dw) + gap, -gap);
  let x = Math.round((W - width) / 2);
  const y = Math.round((H - dh) / 2);
  for (const c of chars) {
    if (c === ':') { rect(x + 4, y + 26, th, th); rect(x + 4, y + dh - 36, th, th); x += cw + gap; continue; }
    const s = SEGS[c] || '';
    const half = Math.round(dh / 2);
    if (s.includes('a')) rect(x, y, dw, th);
    if (s.includes('g')) rect(x, y + half - th / 2, dw, th);
    if (s.includes('d')) rect(x, y + dh - th, dw, th);
    if (s.includes('f')) rect(x, y, th, half);
    if (s.includes('b')) rect(x + dw - th, y, th, half);
    if (s.includes('e')) rect(x, y + half, th, half);
    if (s.includes('c')) rect(x + dw - th, y + half, th, half);
    x += dw + gap;
  }
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let r = 0; r < H; r++) { raw[r * (W * 4 + 1)] = 0; px.copy(raw, r * (W * 4 + 1) + 1, r * W * 4, (r + 1) * W * 4); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const hhmmss = () => new Date().toTimeString().slice(0, 8);

/* ------------------------------------------------------------- snapshots */

const SNAP = `http://${HOST}/api/device/snapshots/screens/${SCREEN}/top/${FRAME}`;
async function snapHash() {
  const res = await fetch(`${SNAP}?t=${Date.now()}`, { cache: 'no-store' });
  const buf = Buffer.from(await res.arrayBuffer());
  return { hash: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12), buf, status: res.status };
}

/* ------------------------------------------------------------------ push */

let running = false;
let current = null; // slot the frame shows (ours)
let sideNext = 'a';
const results = { host: HOST, screen: SCREEN, frame: FRAME, started: new Date().toISOString(), a: [], b: [], notes: [] };
let bailing = null;

async function push(text, { snap = false, lastSnap = null } = {}) {
  const r = { text, at: new Date().toISOString() };
  const guard = () => { if (!DRY && !running) throw new Error('stopped'); };
  const up = uploadProblem(); if (up) throw new Error(`gate: ${up}`);
  const air = onAirProblem(); if (air) throw new Error(`gate: ${air}`);
  const predicted = predictedSlot();
  const name = ownName(sideNext);
  const before = new Set(); for (let n = 1; n <= 50; n++) if (libStatus(n).isValid === true) before.add(n);
  const png = clockPng(text);
  r.bytes = png.length; r.predicted = predicted;
  if (DRY) { log(`DRY would upload ${name} (${png.length} B) into slot ${predicted}`); return r; }
  const form = new FormData();
  form.append('FILES', new Blob([png], { type: 'image/png' }), name);
  const fresh = () => { for (let n = 1; n <= 50; n++) { const s = libStatus(n); if (!before.has(n) && s.isValid === true && s.fileName === name) return n; } return null; };
  guard();
  const t0 = t();
  const libValid = waitFor(() => fresh() != null, 20000);
  const res = await fetch(`http://${HOST}/api/device/images/upload`, { method: 'POST', body: form });
  const t1 = t();
  let answer = null; try { answer = await res.json(); } catch { answer = null; }
  r.http = res.status; r.answer = answer;
  r.upload = Math.round(t1 - t0);
  const tl = await libValid;
  const landed = fresh();
  r.libValid = tl == null ? null : Math.round(tl - t0);
  r.slot = landed;
  if (landed == null) throw new Error(`upload answered ${res.status} ${JSON.stringify(answer)} but no slot holds ${name}`);
  if (landed < MIN_SLOT) throw new Error(`the upload landed in slot ${landed}`);
  const air2 = onAirProblem(); if (air2) throw new Error(`gate: ${air2}`);
  const others = pointersAt(landed); if (others.length) throw new Error(`slot ${landed} is pointed at by ${others.join(', ')}`);
  guard();
  const t2 = t();
  send(framePath, String(landed));
  const te = await waitFor(() => frameSlot(SCREEN, FRAME) === String(landed), 5000);
  r.point = te == null ? null : Math.round(te - t2);
  if (te == null) throw new Error(`S${SCREEN} FRG${FRAME} never echoed slot ${landed}`);
  const old = current;
  current = landed;
  sideNext = sideNext === 'a' ? 'b' : 'a';
  if (snap) {
    // Poll the frame's thumbnail until it differs from the one before the repoint.
    let seen = null;
    for (let i = 0; i < 40; i++) {
      const s = await snapHash();
      if (s.hash !== lastSnap) { seen = t(); r.snapHash = s.hash; fs.writeFileSync(path.join(OUT, `snap-${text.replace(/:/g, '')}.png`), s.buf); break; }
      await sleep(100);
    }
    r.snap = seen == null ? null : Math.round(seen - t2);
    r.snapFromUpload = seen == null ? null : Math.round(seen - t0);
  }
  if (old != null && old !== landed) {
    const st = libStatus(old);
    if (old >= MIN_SLOT && OWN.test(String(st.fileName || '')) && pointersAt(old).length === 0) {
      guard();
      const t3 = t();
      send(deletePath(old), false); send(deletePath(old), true);
      const td = await waitFor(() => libStatus(old).isValid !== true, 5000);
      r.remove = td == null ? null : Math.round(td - t3);
    } else {
      r.remove = null;
      results.notes.push(`did not empty slot ${old}: ${st.fileName} / pointers ${pointersAt(old).join(',')}`);
    }
  }
  r.total = Math.round(t() - t0);
  return r;
}

/* ------------------------------------------------------------- clean up */

async function cleanUp(reason) {
  log('cleaning up:', reason);
  if (DRY) return;
  const fs_ = frameSlot(SCREEN, FRAME);
  if (fs_ !== 'NONE' && OWN.test(String(libStatus(fs_).fileName || ''))) {
    send(framePath, 'NONE');
    const ok = await waitFor(() => frameSlot(SCREEN, FRAME) === 'NONE', 5000);
    log(`S${SCREEN} FRG${FRAME} -> NONE`, ok ? 'echoed' : 'NOT echoed');
  }
  for (let n = MIN_SLOT; n <= 50; n++) {
    const st = libStatus(n);
    if (st.isValid === true && OWN.test(String(st.fileName || '')) && pointersAt(n).length === 0) {
      send(deletePath(n), false); send(deletePath(n), true);
      const ok = await waitFor(() => libStatus(n).isValid !== true, 5000);
      log(`emptied slot ${n}`, ok ? 'echoed' : 'NOT echoed');
    }
  }
}

async function bail(reason) {
  if (bailing) return bailing;
  running = false;
  log('STOP:', reason);
  results.notes.push(`stopped: ${reason}`);
  bailing = (async () => {
    // Off the frame first: nothing of ours stays where a buffer can show it.
    if (!DRY && frameSlot(SCREEN, FRAME) !== 'NONE' && OWN.test(String(libStatus(frameSlot(SCREEN, FRAME)).fileName || ''))) send(framePath, 'NONE');
    await cleanUp(reason);
    finish(1);
  })();
  return bailing;
}
process.on('SIGINT', () => void bail('interrupted'));

function stats(list, key) {
  const v = list.map((r) => r[key]).filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
  return { n: v.length, min: v[0], median: q(0.5), p90: q(0.9), max: v[v.length - 1] };
}

let finished = false;
async function finish(code = 0) {
  if (finished) return; finished = true;
  try {
    const res = await fetch(`http://${HOST}/api/stores/device`, { cache: 'no-store' });
    const after = (await res.json()).device;
    const lib = after.stillLibrary.bankList.items;
    results.after = {
      slots: Object.fromEntries(Object.entries(lib).filter(([, v]) => v.status.pp.isValid).map(([k, v]) => [k, v.status.pp.fileName])),
      frame: after.screenList.items[SCREEN].topFrameList.items[FRAME].control.pp.librarySlot,
      tops: Object.fromEntries(['UP', 'DOWN'].map((b) => [b, after.screenList.items[SCREEN].presetList.items[b].top.source.pp.frame]))
    };
  } catch (e) { results.after = { error: e.message }; }
  results.summary = {
    a: Object.fromEntries(['upload', 'libValid', 'point', 'snap', 'snapFromUpload', 'remove', 'total'].map((k) => [k, stats(results.a, k)])),
    b: Object.fromEntries(['upload', 'libValid', 'point', 'remove', 'total'].map((k) => [k, stats(results.b, k)]))
  };
  results.frames = frameLog.length;
  const file = path.join(OUT, `bench-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...results, frameLog: frameLog.slice(0, 2000) }, null, 1));
  log('after:', JSON.stringify(results.after));
  log('summary:', JSON.stringify(results.summary, null, 1));
  log('saved', file);
  try { ws.close(); } catch { /* gone */ }
  process.exit(code);
}

/* ------------------------------------------------------------------- run */

await opened;
{
  const res = await fetch(`http://${HOST}/api/stores/device`, { cache: 'no-store' });
  store = await res.json();
  for (const f of pending) setPath(f.path, f.value);
  pending.length = 0;
}
log(`connected to ${HOST}: ${get(D('system', 'pp', 'platformLabel'))} ${get(D('system', 'pp', 'dev'))} ${get(D('system', 'version', 'pp', 'updater'))}`);
log(`target S${SCREEN} FRG${FRAME} -> ${frameSlot(SCREEN, FRAME)}; tops UP ${topSel(SCREEN, 'UP')} DOWN ${topSel(SCREEN, 'DOWN')}`);
log(`library: next empty slot ${predictedSlot()}, lowest allowed ${MIN_SLOT}`);
const startProblem = uploadProblem() || onAirProblem() || (frameSlot(SCREEN, FRAME) !== 'NONE' ? `S${SCREEN} FRG${FRAME} already shows slot ${frameSlot(SCREEN, FRAME)}` : null);
if (startProblem) { log('will not start:', startProblem); try { ws.close(); } catch {} process.exit(1); }
log('gates clear');
if (DRY) {
  await push(hhmmss());
  fs.writeFileSync(path.join(OUT, 'sample.png'), clockPng('12:34:56'));
  log(`dry run done; sample picture in ${path.join(OUT, 'sample.png')}`);
  ws.close();
  process.exit(0);
}

running = true;
try {
  // Phase A: single pushes with time to settle, the thumbnail watched for the new picture.
  let last = (await snapHash()).hash;
  results.notes.push(`empty-frame thumbnail ${last}`);
  for (let i = 0; i < A_COUNT && running; i++) {
    const r = await push(hhmmss(), { snap: true, lastSnap: last });
    if (r.snapHash) last = r.snapHash;
    results.a.push(r);
    log('A', JSON.stringify(r));
    await sleep(2500);
  }
  // Phase B: the plugin's loop — a new picture each second, the next as soon as the last is done.
  const endAt = Date.now() + B_SECONDS * 1000;
  let lastText = null;
  while (running && Date.now() < endAt) {
    const wait = 1000 - (Date.now() % 1000) + 15;
    const text = hhmmss();
    if (text === lastText) { await sleep(wait); continue; }
    const r = await push(text);
    lastText = text;
    results.b.push(r);
    log('B', JSON.stringify(r));
  }
} catch (e) {
  await bail(e.message);
}
if (running) {
  running = false;
  await cleanUp('done');
  await finish(0);
}
