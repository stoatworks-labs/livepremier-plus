/*
 * OSC input, live: packets over UDP to the app's own listener, and every
 * effect read back off the switcher over AWJ — the path QLab or a lighting
 * desk takes, with no browser open anywhere.
 *
 * `test/osc.test.js` covers decoding and resolution against fixtures; this is
 * the far end of it: does the switcher do what the address says.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import {
  SKIP, startApp, Link, awjGet, awjGetAll, sag, settled, take, guardScreen, layerPath, spareSlots, sleep
} from './harness.js';
import { bankLetter } from '../../src/core/properties.js';

let app;
let link;
let guard;
let udp;
let port;
const slots = [];

/* An unprivileged port the settings accept (1025–65535; 0 is refused). */
const pickPort = () => 41000 + Math.floor(Math.random() * 8000);

before(async () => {
  if (SKIP) return;
  app = await startApp();
  link = await Link.open(app);
  guard = await guardScreen(link, 'S1');
  udp = dgram.createSocket('udp4');

  for (let tries = 0; tries < 5; tries++) {
    port = pickPort();
    await app.configure({ plugins: { 'osc-input': { settings: { oscEnabled: true, oscPort: port, oscBind: '127.0.0.1' } } } });
    const state = await waitState((s) => s.listening || s.lastError);
    if (state.listening && state.port === port) return;
  }
  throw new Error('the OSC listener would not start on any port tried');
});

after(async () => {
  try {
    for (const slot of slots) {
      if (link.get(slotValid(slot)) === true) {
        link.send({ path: ['device', 'presetBank', 'bankList', 'items', String(slot), 'control', 'pp', 'xDelete'], value: true });
        await link.waitFor(slotValid(slot), false).catch(() => {});
      }
    }
    if (guard) await guard.restore();
  } finally {
    udp?.close();
    link?.close();
    await app?.close();
  }
});

const slotValid = (slot) => ['device', 'presetBank', 'bankList', 'items', String(slot), 'status', 'pp', 'isValid'];

async function state() {
  return (await app.api('/osc/state')).json;
}

async function waitState(pred, timeout = 3000) {
  const until = Date.now() + timeout;
  let s;
  while (Date.now() < until) {
    s = await state();
    if (pred(s)) return s;
    await sleep(40);
  }
  return s;
}

/* ------------------------------------------------------------ encoding */

function pad(buf) {
  const len = Math.ceil((buf.length + 1) / 4) * 4;
  const out = Buffer.alloc(len);
  buf.copy(out);
  return out;
}

/** One OSC message. Numbers that are integers go as `i`, others as `f`. */
function message(address, args = []) {
  const tags = [','];
  const parts = [];
  for (const a of args) {
    if (typeof a === 'string') { tags.push('s'); parts.push(pad(Buffer.from(a, 'utf8'))); }
    else if (typeof a === 'boolean') { tags.push(a ? 'T' : 'F'); }
    else if (Number.isInteger(a) && !Object.is(a, -0) && !(a > 0 && a < 1)) {
      tags.push('i'); const b = Buffer.alloc(4); b.writeInt32BE(a); parts.push(b);
    } else { tags.push('f'); const b = Buffer.alloc(4); b.writeFloatBE(a); parts.push(b); }
  }
  return Buffer.concat([pad(Buffer.from(address)), pad(Buffer.from(tags.join(''))), ...parts]);
}

/** Send and wait until the listener has counted it. */
async function send(address, args = []) {
  const before = await state();
  await new Promise((resolve, reject) =>
    udp.send(message(address, args), port, '127.0.0.1', (err) => (err ? reject(err) : resolve())));
  return waitState((s) => s.received > before.received && (s.sent + s.failed) >= (before.sent + before.failed));
}

/**
 * The listener's recent activity, newest first — the stream replays its last
 * hundred entries to whoever connects, which is how a refusal's reason is
 * seen: per-message errors go there, never into `lastError`, which is the
 * socket's own.
 */
async function history() {
  const ctrl = new AbortController();
  const res = await fetch(app.base + '/__lpp/osc/stream', { signal: ctrl.signal });
  const reader = res.body.getReader();
  let text = '';
  for (;;) {
    const { value, done } = await Promise.race([reader.read(), sleep(300).then(() => ({ value: null }))]);
    if (done || !value) break;
    text += Buffer.from(value).toString('utf8');
  }
  ctrl.abort();
  return text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
}

const previewLetter = () => bankLetter(link.store, 'S1', 'PREVIEW').letter;

/* ---------------------------------------------------------------- tests */

test('the listener comes up on the port the settings name', { skip: SKIP }, async () => {
  const s = await state();
  assert.equal(s.listening, true);
  assert.equal(s.port, port);
  assert.equal(s.address, '127.0.0.1');
});

test('a screen group parameter goes straight to the switcher', { skip: SKIP }, async () => {
  const path = sag('S1', 'control', 'takeUpTime');
  const value = link.get(path) === 17 ? 18 : 17;
  await send('/lp/screen/1/group/control/takeUpTime', [value]);
  await link.waitFor(path, value);
  assert.equal(await awjGet(path), value);
});

test('take and cut by address; a release sends nothing', { skip: SKIP }, async () => {
  await send('/lp/screen/1/group/control/takeUpTime', [5]);
  await send('/lp/screen/1/group/control/takeDownTime', [5]);
  await link.waitFor(sag('S1', 'control', 'takeDownTime'), 5);

  const from = await settled(link);
  const to = from === 'AT_UP' ? 'AT_DOWN' : 'AT_UP';
  await send('/lp/screen/1/take');
  await link.waitFor(sag('S1', 'status', 'transition'), to, { timeout: 4000 });

  /* A button's release: the listener counts it and writes nothing. */
  const mark = link.mark();
  const before = await state();
  await send('/lp/screen/1/take', [0]);
  await sleep(1200);
  assert.equal((await state()).sent, before.sent, 'nothing sent for a release');
  assert.equal(link.since(mark, sag('S1', 'control', 'xTake')).length, 0);
  assert.equal(link.get(sag('S1', 'status', 'transition')), to);

  await send('/lp/screen/1/cut');
  await link.waitFor(sag('S1', 'status', 'transition'), from, { timeout: 2000 });
  assert.equal(await awjGet(sag('S1', 'status', 'transition')), from);
});

test('layer parameters by buffer letter, normalised, as arithmetic and as an enum', { skip: SKIP }, async () => {
  await settled(link);
  const pv = previewLetter();
  const base = `/lp/screen/1/preset/${pv.toLowerCase()}/layer/1`;
  const opacity = layerPath('S1', pv, 1, 'opacity', 'pp', 'opacity');
  const posH = layerPath('S1', pv, 1, 'position', 'pp', 'posH');
  const source = layerPath('S1', pv, 1, 'source', 'pp', 'inputNum');

  await send(`${base}/opacity/opacity`, [200]);
  await link.waitFor(opacity, 200);

  await send(`${base}/opacity/opacity/norm`, [0.5]);
  await link.waitFor(opacity, 128);

  /* Arithmetic in an argument, the way it works in a field. */
  await send(`${base}/position/posH`, ['1080-80']);
  await link.waitFor(posH, 1000);

  await send(`${base}/source/inputNum`, ['LIVE_3']);
  await link.waitFor(source, 'LIVE_3');

  assert.deepEqual(await awjGetAll([opacity, posH, source]), [128, 1000, 'LIVE_3']);
});

test('preview and program are refused over UDP, where nobody can see which buffer that is', { skip: SKIP }, async () => {
  const before = await state();
  const mark = link.mark();
  await send('/lp/screen/1/preset/preview/layer/1/opacity/opacity', [10]);
  const after = await state();
  assert.equal(after.failed, before.failed + 1);
  const entry = (await history()).find((e) => e.address === '/lp/screen/1/preset/preview/layer/1/opacity/opacity');
  assert.ok(entry && entry.error, 'the refusal is on the activity stream');
  assert.match(entry.error, /preview/i);
  await sleep(300);
  assert.equal(link.since(mark, ['device', 'screenList', 'items', 'S1', 'presetList']).length, 0, 'nothing written');
});

test('$ variables are refused and @ variables come from the saved document', { skip: SKIP }, async () => {
  await settled(link);
  const pv = previewLetter();
  const posV = layerPath('S1', pv, 1, 'position', 'pp', 'posV');
  const address = `/lp/screen/1/preset/${pv.toLowerCase()}/layer/1/position/posV`;

  const before = await state();
  await send(address, ['$S1.height / 2']);
  const refused = await state();
  assert.equal(refused.failed, before.failed + 1, 'a role over UDP is refused');
  const why = (await history()).find((e) => e.address === address && e.error);
  assert.match(why.error, /\$|variable|S1\.height/i);

  const put = await app.api('/variables', { method: 'PUT', body: { data: { variables: [{ name: 'gap', value: '40' }] } } });
  assert.equal(put.status, 200, put.text);
  await send(address, ['@gap * 3']);
  await link.waitFor(posV, 120);
  assert.equal(await awjGet(posV), 120);
});

test('store program into a memory, label it, recall it into preview and delete it — all by address', { skip: SKIP }, async () => {
  const [slot] = spareSlots(link, 1);
  slots.push(slot);
  await settled(link);
  const pg = bankLetter(link.store, 'S1', 'PROGRAM').letter;
  const pv = previewLetter();
  const programSource = link.get(layerPath('S1', pg, 1, 'source', 'pp', 'inputNum'));

  await send(`/lp/screen/1/memory/${slot}/store`);
  await link.waitFor(slotValid(slot), true, { timeout: 6000 });

  await send(`/lp/screen/1/memory/${slot}/label`, ['osc label']);
  await link.waitFor(['device', 'presetBank', 'bankList', 'items', String(slot), 'control', 'pp', 'label'], 'osc label');

  /* Make preview differ, then recall: preview takes program's look. */
  const other = programSource === 'LIVE_11' ? 'LIVE_12' : 'LIVE_11';
  await send(`/lp/screen/1/preset/${pv.toLowerCase()}/layer/1/source/inputNum`, [other]);
  await link.waitFor(layerPath('S1', pv, 1, 'source', 'pp', 'inputNum'), other);
  await send(`/lp/screen/1/memory/${slot}/recall`, [1]);
  await link.waitFor(layerPath('S1', pv, 1, 'source', 'pp', 'inputNum'), programSource, { timeout: 5000 });

  await send(`/lp/screen/1/memory/${slot}/delete`);
  await link.waitFor(slotValid(slot), false);
  assert.equal(await awjGet(slotValid(slot)), false);
});

test('the activity stream reports what arrived and what it did', { skip: SKIP }, async () => {
  const ctrl = new AbortController();
  const res = await fetch(app.base + '/__lpp/osc/stream', { signal: ctrl.signal });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  let text = '';
  const until = Date.now() + 3000;
  await send('/lp/screen/1/group/control/takeUpTime', [12]);
  while (Date.now() < until && !text.includes('takeUpTime')) {
    const { value, done } = await Promise.race([reader.read(), sleep(500).then(() => ({ value: null }))]);
    if (done) break;
    if (value) text += Buffer.from(value).toString('utf8');
  }
  ctrl.abort();
  await link.waitFor(sag('S1', 'control', 'takeUpTime'), 12);
  assert.match(text, /event: osc/);
  assert.match(text, /\/lp\/screen\/1\/group\/control\/takeUpTime/);
});

test('switching the listener off closes the port', { skip: SKIP }, async () => {
  await app.configure({ plugins: { 'osc-input': { settings: { oscEnabled: false } } } });
  const s = await waitState((x) => !x.listening);
  assert.equal(s.listening, false);

  /* A packet now goes nowhere. */
  const path = sag('S1', 'control', 'takeUpTime');
  const was = link.get(path);
  await new Promise((r) => udp.send(message('/lp/screen/1/group/control/takeUpTime', [was === 9 ? 8 : 9]), port, '127.0.0.1', r));
  await sleep(500);
  assert.equal(link.get(path), was);
});
