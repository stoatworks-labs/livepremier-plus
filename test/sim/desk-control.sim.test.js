/*
 * A lighting desk, live: the app's own `desk-control` plugin with no page
 * open, a pretend desk sending real Art-Net on this machine at a desk's 40
 * frames a second, and the simulator at the far end. Every effect is
 * witnessed on the vendor socket; S1 and the memory used are put back.
 *
 * Only the desk is a stand-in. Everything from a UDP packet to an AWJ write is
 * the code that ships — which is still not grandMA3 on a network.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import os from 'node:os';

import {
  SKIP, SIM, startApp, Link, sag, settled, take, guardScreen, layerPath, spareSlots, saveFromPreview, deleteSlots, sleep,
} from './harness.js';
import { buildArtDmx, buildArtPoll, parsePollReply, ARTNET_PORT } from '../../src/core/artnet.js';
import { layout, opacityOf, CENTRE } from '../../src/core/dmx-personality.js';

let app;
let link;
let guard;
let desk;
let ticker;
let slot = null;
let seq = 0;

/* The patch the plugin makes from these settings: Master at 1, S1 at 5, its layers at 9 and 12. */
const SETTINGS = { deskEnabled: true, deskDestinations: ['S1'], deskLayers: 2, deskAllow: ['127.0.0.1'] };
let PATCH = layout({ destinations: ['S1'], layers: 2, firstUniverse: 1 });
const at = (id) => PATCH.fixtures.find((f) => f.id === id).address - 1;
const frame = new Uint8Array(512);
const set = (id, values) => frame.set(values, at(id));
const word16 = (v) => [v >> 8, v & 255];

const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(20); }
  return false;
};
const letters = () => {
  const t = link.get(sag('S1', 'status', 'transition'));
  const up = link.get(sag('S1', 'control', 'presetUp'));
  const down = link.get(sag('S1', 'control', 'presetDown'));
  return t === 'AT_DOWN' ? { program: down, preview: up } : { program: up, preview: down };
};
const sourceOn = (letter, layer = 1) => link.get(layerPath('S1', letter, layer, 'source', 'pp', 'inputNum'));
const opacityPath = (letter, layer) => layerPath('S1', letter, layer, 'opacity', 'pp', 'opacity');
const liveInputs = () => Object.keys(link.get(['device', 'inputList', 'items']) || {})
  .map((k) => Number(/^IN_(\d+)$/.exec(k)?.[1]))
  .filter((n) => n && link.get(['device', 'inputList', 'items', `IN_${n}`, 'mapping', 'pp', 'isValid']) === true)
  .sort((a, b) => a - b);

before(async () => {
  if (SKIP) return;
  app = await startApp();
  link = await Link.open(app);
  guard = await guardScreen(link, 'S1');
  await app.configure({ plugins: { 'desk-control': { enabled: true, settings: SETTINGS } } });
  desk = dgram.createSocket('udp4');
  await new Promise((r) => desk.bind(0, '127.0.0.1', r));
  /* A desk sends every universe all the time, changed or not. */
  ticker = setInterval(() => desk.send(buildArtDmx(0, frame, { sequence: (++seq % 255) + 1 }), ARTNET_PORT, '127.0.0.1'), 25);
});

after(async () => {
  clearInterval(ticker);
  try {
    if (slot && link) await deleteSlots(link, [slot]);
    if (guard) await guard.restore();
  } finally {
    desk?.close();
    link?.close();
    await app?.close();
  }
});

test('ArtPoll on the LAN is answered as a media server listening to universe 1', { skip: SKIP }, async () => {
  /* The interface the simulator is reached on, not the first one listed: a
     Mac with a VM adapter lists that first. */
  const sim = SIM.split(':')[0].split('.').map(Number);
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal
    && i.address.split('.').every((o, k) => ((Number(o) ^ sim[k]) & Number(i.netmask.split('.')[k])) === 0));
  assert.ok(lan, 'an interface on the simulator’s subnet');
  const bcast = lan.address.split('.').map((o, i) => (Number(o) | (~Number(lan.netmask.split('.')[i]) & 255))).join('.');
  /* A desk listens on 6454 too; this one is up only as long as the poll. */
  const poller = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const heard = [];
  poller.on('message', (b) => { const r = parsePollReply(b); if (r) heard.push(r); });
  await new Promise((r) => poller.bind(ARTNET_PORT, '0.0.0.0', r));
  poller.setBroadcast(true);
  try {
    poller.send(buildArtPoll(), ARTNET_PORT, bcast);
    assert.ok(await until(() => heard.some((r) => /LivePremier Plus/.test(r.longName || r.shortName || ''))), 'a reply from this app');
    const ours = heard.find((r) => /LivePremier Plus/.test(r.longName || r.shortName || ''));
    assert.deepEqual(ours.universes, [0]);
    assert.deepEqual(ours.ip, lan.address.split('.').map(Number), 'the address on the poller’s own subnet');
  } finally {
    poller.close();
  }
});

test('Control raised: the desk’s layer goes onto preview, and only preview', { skip: SKIP }, async (t) => {
  await settled(link, 'S1');
  const inputs = liveInputs();
  assert.ok(inputs.length >= 2, 'the simulator has two live inputs');
  const { program, preview } = letters();
  /* One preview is not showing now, or the wait below proves nothing. */
  const a = inputs.find((n) => `LIVE_${n}` !== sourceOn(preview));
  const onAir = sourceOn(program);
  /* The first frame is a baseline: the layer is set while S1 is not the desk's. */
  set('S1', [0, 0, 0, 0]);
  set('S1.L1', [1, a, 255]);
  await sleep(300);
  const started = Date.now();
  set('S1', [100, 0, 0, 0]);
  await link.waitFor(layerPath('S1', preview, 1, 'source', 'pp', 'inputNum'), `LIVE_${a}`, { timeout: 4000 });
  t.diagnostic(`Control raised to LIVE_${a} on preview: ${Date.now() - started} ms`);
  await link.waitFor(layerPath('S1', preview, 1, 'opacity', 'pp', 'opacity'), 256, { timeout: 4000 });
  assert.equal(sourceOn(program), onAir, 'program untouched');
  const state = (await app.api('/desk-control/state')).json;
  assert.equal(state.screens[0].control, 'preview', 'the write can only have come from the engage');
  assert.equal(state.switcher.link.open, true, 'the AWJ connection is held while the desk drives');
});

test('a memory recalls to preview, Take takes it, and the desk’s layers follow onto the new preview', { skip: SKIP }, async (t) => {
  await settled(link, 'S1');
  const { preview } = letters();
  /* Two inputs: b for the memory, a for what preview shows before the recall. */
  const [a, b] = liveInputs().filter((n) => `LIVE_${n}` !== sourceOn(preview)).concat(liveInputs()).slice(0, 2);
  assert.notEqual(a, b);
  /* A memory holding LIVE_b on layer 1, in the top empty slot a desk can reach. */
  link.send({ path: layerPath('S1', preview, 1, 'source', 'pp', 'inputNum'), value: `LIVE_${b}` });
  await link.waitFor(layerPath('S1', preview, 1, 'source', 'pp', 'inputNum'), `LIVE_${b}`);
  [slot] = spareSlots(link, 1, { from: 255 });
  await saveFromPreview(link, slot);
  /* Hold the desk's layer source so the memory's shows, and put LIVE_a back on preview. */
  set('S1.L1', [0, a, 255]);
  await sleep(200);
  link.send({ path: layerPath('S1', preview, 1, 'source', 'pp', 'inputNum'), value: `LIVE_${a}` });
  await link.waitFor(layerPath('S1', preview, 1, 'source', 'pp', 'inputNum'), `LIVE_${a}`);

  const started = Date.now();
  set('S1', [100, slot, 0, 0]);
  await link.waitFor(layerPath('S1', preview, 1, 'source', 'pp', 'inputNum'), `LIVE_${b}`, { timeout: 4000 });
  t.diagnostic(`memory ${slot} recalled to preview: ${Date.now() - started} ms`);

  /* Layer 1 at a level only the desk sets, and program at another: the level
     reaching the new preview after the take is the re-push, nothing else.
     Layer 1, because it has a source: the guard puts back only layers in use. */
  const level = opacityOf(200);
  set('S1.L1', [0, a, 200]);
  await link.waitFor(opacityPath(preview, 1), level, { timeout: 4000 });
  const { program } = letters();
  link.send({ path: opacityPath(program, 1), value: 0 });
  await link.waitFor(opacityPath(program, 1), 0);

  const before = link.get(sag('S1', 'status', 'transition'));
  const after = before === 'AT_DOWN' ? 'AT_UP' : 'AT_DOWN';
  const fired = Date.now();
  set('S1', [100, slot, 255, 0]);
  await link.waitFor(sag('S1', 'status', 'transition'), after, { timeout: 15000 });
  t.diagnostic(`Take to transition landed: ${Date.now() - fired} ms`);
  assert.equal(letters().preview, program, 'the take swapped the letters');
  assert.equal(sourceOn(letters().program), `LIVE_${b}`, 'the memory is on air');
  /* The desk holds layer 1's source (folder 0), so the new preview keeps its
     own; the desk's levels are written to it. The simulator reports the old
     resting state for the whole take, so this is the supervisor waiting for
     the take to land rather than writing to the letter going to air. */
  await link.waitFor(opacityPath(program, 1), level, { timeout: 4000 });
  t.diagnostic(`Take to the desk's level on the new preview: ${Date.now() - fired} ms`);
  assert.equal(link.get(opacityPath(letters().program, 1)), level, 'and the take carried it to air');
  set('S1', [100, slot, 0, 0]);
  const history = (await app.api('/desk-control/state')).json.history;
  assert.ok(history.some((e) => /recall/.test(e.note || '')), 'the recall is in the history');
  assert.ok(history.some((e) => /^take/.test(e.note || '')), 'the take is in the history');
});

test('Control lowered: the screen is let go, and a layer change after that writes nothing', { skip: SKIP }, async () => {
  set('S1', [0, 0, 0, 0]);
  assert.ok(await until(async () => (await app.api('/desk-control/state')).json.screens[0].control === 'off'), 'released');
  /* Whatever the last test left landing has landed before the baseline is read. */
  await settled(link, 'S1');
  await sleep(500);
  const { preview } = letters();
  const was = sourceOn(preview);
  const other = liveInputs().find((n) => `LIVE_${n}` !== was);
  set('S1.L1', [1, other, 255]);
  await sleep(600);
  assert.equal(sourceOn(preview), was, 'preview untouched');
});

test('Compact: the desk places layer 1 from the screen’s centre, on preview, at the canvas the switcher reports', { skip: SKIP }, async (t) => {
  await settled(link, 'S1');
  await app.configure({ plugins: { 'desk-control': { settings: { deskMode: 'compact' } } } });
  PATCH = layout({ destinations: ['S1'], layers: 2, firstUniverse: 1, mode: 'compact' });
  /* A new patch: every address means something else now, so a clean baseline with S1 not the desk's. */
  frame.fill(0);
  set('S1.L1', [0, 0, 255, ...word16(CENTRE), ...word16(CENTRE), 0, 0, 0, 0]);
  await sleep(400);
  const { program, preview } = letters();
  const pos = (letter, prop) => link.get(layerPath('S1', letter, 1, 'position', 'pp', prop));
  const onAir = ['posH', 'posV', 'sizeH', 'sizeV'].map((p) => pos(program, p));
  const width = link.get(['device', 'screenList', 'items', 'S1', 'status', 'size', 'pp', 'sizeH']);
  const height = link.get(['device', 'screenList', 'items', 'S1', 'status', 'size', 'pp', 'sizeV']);

  set('S1', [100, 0, 0, 0]);
  assert.ok(await until(async () => (await app.api('/desk-control/state')).json.screens[0].control === 'preview'), 'engaged');
  /* A quarter-size layer, 100 px right of centre and 50 px up. */
  const started = Date.now();
  set('S1.L1', [0, 0, 255, ...word16(CENTRE + 100), ...word16(CENTRE - 50), ...word16(width / 4), ...word16(height / 4)]);
  await link.waitFor(layerPath('S1', preview, 1, 'position', 'pp', 'posH'), width / 2 + 100, { timeout: 4000 });
  t.diagnostic(`position on preview: ${Date.now() - started} ms (canvas ${width} × ${height})`);
  await link.waitFor(layerPath('S1', preview, 1, 'position', 'pp', 'posV'), height / 2 - 50, { timeout: 4000 });
  await link.waitFor(layerPath('S1', preview, 1, 'position', 'pp', 'sizeH'), width / 4, { timeout: 4000 });
  await link.waitFor(layerPath('S1', preview, 1, 'position', 'pp', 'sizeV'), height / 4, { timeout: 4000 });
  assert.equal(link.get(layerPath('S1', preview, 1, 'position', 'pp', 'anchor')), 'MIDDLE_CENTER');
  assert.deepEqual(['posH', 'posV', 'sizeH', 'sizeV'].map((p) => pos(program, p)), onAir, 'program untouched');

  /* Width to zero hands the look back: a move after it writes nothing. */
  set('S1.L1', [0, 0, 255, ...word16(CENTRE + 300), ...word16(CENTRE - 50), 0, 0, ...word16(height / 4)]);
  await sleep(600);
  assert.equal(pos(preview, 'posH'), width / 2 + 100, 'held at size 0');
  set('S1', [0, 0, 0, 0]);
  assert.ok(await until(async () => (await app.api('/desk-control/state')).json.screens[0].control === 'off'), 'released');
});

test('a take on the switcher fires the Triggers plugin’s trigger; the desk’s own take is not fired back', { skip: SKIP }, async (t) => {
  await settled(link, 'S1');
  /* The desk end: an OSC listener, as a desk's OSC input would be. */
  const osc = dgram.createSocket('udp4');
  await new Promise((r) => osc.bind(0, '127.0.0.1', r));
  const heard = [];
  osc.on('message', (b) => heard.push({ at: Date.now(), text: b.toString('latin1') }));
  try {
    await app.configure({ plugins: { triggers: { enabled: true } } });
    const put = await app.api('/triggers/', {
      method: 'PUT',
      body: {
        destinations: [{ name: 'Desk', kind: 'osc', host: '127.0.0.1', port: osc.address().port }],
        triggers: [{ name: 'VT state', go: ['Desk /vt/state 1'], back: [] }],
      },
    });
    assert.equal(put.status, 200, put.text);
    await app.configure({ plugins: { 'desk-control': { settings: {
      deskFeedback: true, deskFeedbackRules: [{ destination: 'S1', memory: null, trigger: 'vt-state' }],
    } } } });
    await sleep(400);
    const state0 = (await app.api('/desk-control/state')).json;
    assert.deepEqual(state0.feedback.watching, ['S1']);
    assert.deepEqual(state0.feedback.triggers, [{ id: 'vt-state', name: 'VT state' }]);

    /* Somebody else takes: the Web RCS, a T-bar, another console. */
    const fired = Date.now();
    await take(link, 'S1');
    const landed = Date.now();
    assert.ok(await until(() => heard.length === 1, 3000), 'the desk heard the trigger');
    assert.match(heard[0].text, /\/vt\/state/);
    t.diagnostic(`take written to OSC heard: ${heard[0].at - fired} ms; after the landing was seen here: ${heard[0].at - landed} ms`);
    const history = (await app.api('/desk-control/state')).json.history;
    assert.ok(history.some((e) => e.kind === 'fired' && /^S1 took/.test(e.note)), 'the history says why');

    /* The desk takes S1 itself: not fired back to it. */
    await sleep(600);
    set('S1', [100, 0, 0, 0]);
    assert.ok(await until(async () => (await app.api('/desk-control/state')).json.screens[0].control === 'preview'), 'engaged');
    const before = link.get(sag('S1', 'status', 'transition'));
    set('S1', [100, 0, 255, 0]);
    await link.waitFor(sag('S1', 'status', 'transition'), before === 'AT_DOWN' ? 'AT_UP' : 'AT_DOWN', { timeout: 15000 });
    assert.ok(await until(async () => (await app.api('/desk-control/state')).json.counts.echoes === 1, 3000), 'the take was seen');
    await sleep(300);
    assert.equal(heard.length, 1, 'and not fired');
    set('S1', [0, 0, 0, 0]);
  } finally {
    osc.close();
    await app.configure({ plugins: { 'desk-control': { settings: { deskFeedback: false } } } });
  }
});

test('switched off, the ports close', { skip: SKIP }, async () => {
  await app.configure({ plugins: { 'desk-control': { settings: { deskEnabled: false } } } });
  const state = (await app.api('/desk-control/state')).json;
  assert.equal(state.sockets.artnet.open, false);
  assert.equal(state.sockets.sacn.open, false);
});
