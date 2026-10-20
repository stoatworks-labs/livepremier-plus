/*
 * An ATEM Micro Panel, live: a pretend panel (`test/helpers/fake-atem-micro-panel.js`,
 * which runs the real handshake on report 5) inside the real device host core,
 * the app's own `atem-micro-panel` plugin holding it with no page open, and
 * the simulator at the far end. Every effect is witnessed over AWJ or on the
 * vendor socket; S1 is put back afterwards.
 *
 * Only the panel is a stand-in. Everything from a key's bytes to the switcher
 * is the code that ships — which is still not a panel on a desk.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { SKIP, startApp, Link, awjGet, sag, settled, guardScreen, layerPath, sleep } from './harness.js';
import { bankLetter } from '../../src/core/properties.js';
import microModule from '../../devices/modules/atem-micro-panel/module.js';
import { createDeviceHost } from '../../server/device-host.js';
import { inProcessFork, fakeHid } from '../helpers/fake-speed-editor.js';
import { FakeMicroPanel } from '../helpers/fake-atem-micro-panel.js';
import { COLOUR } from '../../src/core/atem-micro-panel.js';

let app;
let link;
let guard;
let host;
let panel;

const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(25); }
  return false;
};

before(async () => {
  if (SKIP) return;
  panel = new FakeMicroPanel();
  host = createDeviceHost({
    entry: 'host.js',
    fork: inProcessFork({ hid: fakeHid([panel]), modules: [microModule] }),
  });
  host.start();
  app = await startApp({ devices: host.api });
  link = await Link.open(app);
  guard = await guardScreen(link, 'S1');
  await app.configure({ plugins: { 'atem-micro-panel': { enabled: true, settings: { atemMicroEnabled: true } } } });
});

after(async () => {
  try { if (guard) await guard.restore(); }
  finally {
    link?.close();
    await app?.close();
    await host?.stop();
  }
});

/** The live inputs the switcher has, in order. */
const liveInputs = () => {
  const items = link.get(['device', 'inputList', 'items']) || {};
  return Object.keys(items)
    .map((k) => Number(/^IN_(\d+)$/.exec(k)?.[1]))
    .filter((n) => n && link.get(['device', 'inputList', 'items', `IN_${n}`, 'mapping', 'pp', 'isValid']) === true)
    .sort((a, b) => a - b);
};

const state = async () => (await app.api('/atem-micro-panel/state')).json;

test('the plugin takes the panel with no page open, drives S1 as M/E 1, and lights tally the switcher agrees with', { skip: SKIP }, async () => {
  assert.ok(await until(() => panel.authed && panel.lamps), 'the device host opened and answered the panel, and it was lit');
  assert.ok(await until(() => panel.colourOf('ME_1') === COLOUR.YELLOW), 'M/E 1 is S1, driven');
  assert.ok(await until(async () => (await state()).tally), 'tally read');
  const s = await state();
  assert.equal(s.panel.connected, true);
  assert.deepEqual(s.selection.destinations, ['S1']);
  const pv = bankLetter(link.store, 'S1', 'PREVIEW').letter;
  const onPreview = await awjGet(layerPath('S1', pv, s.selection.layer, 'source', 'pp', 'inputNum'));
  const m = /^LIVE_(\d+)$/.exec(String(onPreview));
  assert.deepEqual(s.tally.preview, m ? { kind: 'LIVE', number: Number(m[1]) } : null, `tally says what AWJ says: ${onPreview}`);
});

test('PREVIEW n puts input n on preview; the program row does nothing until ticked, then cuts to air; AUTO and the T-bar take', { skip: SKIP }, async () => {
  await settled(link, 'S1');
  const inputs = liveInputs().filter((n) => n <= 10);
  assert.ok(inputs.length >= 2, 'the simulator has two live inputs among the first ten');
  const [a, b] = inputs;

  const pv = bankLetter(link.store, 'S1', 'PREVIEW').letter;
  panel.tap(`PVW_${b}`);
  await link.waitFor(layerPath('S1', pv, 1, 'source', 'pp', 'inputNum'), `LIVE_${b}`, { timeout: 4000 });
  assert.equal(await awjGet(layerPath('S1', pv, 1, 'source', 'pp', 'inputNum')), `LIVE_${b}`, 'on preview, layer 1');
  assert.ok(await until(() => panel.colourOf(`PVW_${b}`) === COLOUR.GREEN), 'its key went green');

  const pg = bankLetter(link.store, 'S1', 'PROGRAM').letter;
  const before = await awjGet(layerPath('S1', pg, 1, 'source', 'pp', 'inputNum'));
  panel.tap(`PGM_${a}`);
  await sleep(400);
  assert.equal(await awjGet(layerPath('S1', pg, 1, 'source', 'pp', 'inputNum')), before, 'nothing on air without the tick');
  const ticked = await app.api('/atem-micro-panel/hot-cut', { method: 'POST', body: { on: true } });
  assert.equal(ticked.json.hotCut, true);
  panel.tap(`PGM_${a}`);
  await link.waitFor(layerPath('S1', pg, 1, 'source', 'pp', 'inputNum'), `LIVE_${a}`, { timeout: 4000 });
  assert.ok(await until(() => panel.colourOf(`PGM_${a}`) === COLOUR.RED), 'its key went red');
  await app.api('/atem-micro-panel/hot-cut', { method: 'POST', body: { on: false } });

  const from = await settled(link, 'S1');
  const to = from === 'AT_UP' ? 'AT_DOWN' : 'AT_UP';
  panel.tap('AUTO');
  await link.waitFor(sag('S1', 'status', 'transition'), to, { timeout: 15000 });

  /* The lever rests at the bottom; a throw to the top is the next take, back
     the other way. The simulator has no in-between state, so only the take
     is seen. */
  await settled(link, 'S1');
  panel.setTbar(0);
  await sleep(200);
  panel.setTbar(2048);
  await sleep(200);
  panel.setTbar(4096);
  await link.waitFor(sag('S1', 'status', 'transition'), from, { timeout: 15000 });
  assert.ok((await state()).history.some((e) => /T-bar take on S1/.test(e.note || '')), 'the stroke is in the history');
});

test('switched off, the plugin hands the panel back, dark, and forgets the tick', { skip: SKIP }, async () => {
  await app.api('/atem-micro-panel/hot-cut', { method: 'POST', body: { on: true } });
  await app.configure({ plugins: { 'atem-micro-panel': { settings: { atemMicroEnabled: false } } } });
  assert.ok(await until(() => panel.closed), 'let go');
  assert.ok(panel.dark(), 'left dark');
  assert.equal((await state()).hotCut, false);
});
