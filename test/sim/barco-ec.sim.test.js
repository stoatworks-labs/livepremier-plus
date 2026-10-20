/*
 * A Barco EC panel, live: a pretend panel (`test/helpers/fake-ec-panel.js`,
 * which keeps the protocol's rules down to MPSSE bytes) inside the real device
 * host core, the app's own `barco-ec` plugin holding it with no page open,
 * and the simulator at the far end. Every effect is witnessed over AWJ or on
 * the vendor socket; S1 is put back afterwards.
 *
 * Only the panel is a stand-in. Everything from a key's bytes to the switcher
 * is the code that ships — which is still not a panel on a desk.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { SKIP, startApp, Link, awjGet, sag, settled, guardScreen, layerPath, sleep } from './harness.js';
import { bankLetter } from '../../src/core/properties.js';
import barcoModule from '../../devices/modules/barco-ec/module.js';
import { createDeviceHost } from '../../server/device-host.js';
import { inProcessFork } from '../helpers/fake-speed-editor.js';
import { FakeEcPanel, fakeFtdi } from '../helpers/fake-ec-panel.js';
import * as P from '../../src/core/ec-panel.js';
import { render } from '../../src/core/ec-font.js';

let app;
let link;
let guard;
let host;
let panel;

const key = (name) => P.BUTTON_BY_NAME.get(name).index;
const lcd = (name) => P.BUTTON_BY_NAME.get(name).lcd;
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(25); }
  return false;
};

before(async () => {
  if (SKIP) return;
  panel = new FakeEcPanel();
  host = createDeviceHost({
    entry: 'host.js',
    fork: inProcessFork({ hid: null, reason: 'no HID panels in this test', ftdi: fakeFtdi([panel]), modules: [barcoModule] }),
  });
  host.start();
  app = await startApp({ devices: host.api });
  link = await Link.open(app);
  guard = await guardScreen(link, 'S1');
  await app.configure({
    plugins: { 'barco-ec': { enabled: true, settings: { barcoEcEnabled: true, barcoEcModel: 'ec-50', barcoEcRows: ['stills', 'inputs', 'memories'] } } },
  });
});

after(async () => {
  try { if (guard) await guard.restore(); }
  finally {
    link?.close();
    await app?.close();
    await host?.stop();
  }
});

/** The live inputs the switcher has, in order — what the middle row pages through. */
const liveInputs = () => {
  const items = link.get(['device', 'inputList', 'items']) || {};
  return Object.keys(items)
    .map((k) => Number(/^IN_(\d+)$/.exec(k)?.[1]))
    .filter((n) => n && link.get(['device', 'inputList', 'items', `IN_${n}`, 'mapping', 'pp', 'isValid']) === true)
    .sort((a, b) => a - b);
};

test('the plugin takes the panel with no page open and labels it from the switcher', { skip: SKIP }, async () => {
  assert.ok(await until(() => panel.open), 'the device host opened the panel');
  const first = liveInputs()[0];
  assert.ok(first, 'the simulator has a live input');
  const label = link.get(['device', 'inputList', 'items', `IN_${first}`, 'control', 'pp', 'label']) || `IN ${first}`;
  assert.ok(await until(() => {
    const img = panel.cellImage(lcd('ASSIGN_1_0'));
    const want = render(label);
    return img && img.every((v, i) => v === want[i]);
  }), `the middle row's first key reads "${label}"`);
  assert.equal(panel.colourOf(lcd('ASSIGN_1_0')), P.COLOUR.WHITE);
  const state = await app.api('/barco-ec/state');
  assert.equal(state.json.panel.connected, true);
});

test('a screen picked, an input put on its preview, ALL TRANS takes it, and the T-bar takes it back and forth', { skip: SKIP }, async () => {
  const side = await settled(link, 'S1');
  const used = Object.keys(link.get(['device', 'screenAuxGroupList', 'items']) || {})
    .filter((id) => /^S\d+$/.test(id) && link.get(sag(id, 'status', 'isUsed')) === true)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  assert.equal(used[0], 'S1', 'S1 is the first destination key');

  panel.tap(key('DEST_0'));
  assert.ok(await until(() => panel.ledOf(key('DEST_0')) === P.LED.GREEN), 'S1 lit as selected');

  const inputs = liveInputs();
  const pick = inputs[1] ?? inputs[0];
  const at = inputs.indexOf(pick);
  const pv = bankLetter(link.store, 'S1', 'PREVIEW').letter;
  panel.tap(P.BUTTON_BY_NAME.get(`ASSIGN_1_${at}`).index);
  await link.waitFor(layerPath('S1', pv, 1, 'source', 'pp', 'inputNum'), `LIVE_${pick}`, { timeout: 4000 });
  assert.equal(await awjGet(layerPath('S1', pv, 1, 'source', 'pp', 'inputNum')), `LIVE_${pick}`, 'on preview, layer 1');

  panel.tap(key('ALL_TRANS'));
  const after = side.program === 'DOWN' ? 'AT_UP' : 'AT_DOWN';
  await link.waitFor(sag('S1', 'status', 'transition'), after, { timeout: 15000 });

  /* The lever rests at the bottom; a throw to the top is the next take, back
     the other way, and a throw down again is the one after. The simulator has
     no in-between state (test/sim AGENTS notes), so only the takes are seen. */
  panel.setTbar(P.TBAR_MIN);
  await sleep(200);
  panel.setTbar(0x7e28);
  await sleep(200);
  panel.setTbar(P.TBAR_MAX);
  await link.waitFor(sag('S1', 'status', 'transition'), side.program === 'DOWN' ? 'AT_DOWN' : 'AT_UP', { timeout: 15000 });
  await sleep(300);
  panel.setTbar(P.TBAR_MIN);
  await link.waitFor(sag('S1', 'status', 'transition'), after, { timeout: 15000 });
  const history = (await app.api('/barco-ec/state')).json.history;
  assert.equal(history.filter((e) => /T-bar take on S1/.test(e.note || '')).length, 2, 'both strokes are in the history');
});

test('switched off, the plugin hands the panel back, dark', { skip: SKIP }, async () => {
  await app.configure({ plugins: { 'barco-ec': { settings: { barcoEcEnabled: false } } } });
  assert.ok(await until(() => !panel.open), 'let go');
  const fb = panel.shown();
  assert.ok(fb, 'the last frame was sent in full');
  assert.equal(panel.colourOf(lcd('ASSIGN_1_0')), P.COLOUR.OFF);
  assert.ok(panel.cellImage(lcd('ASSIGN_1_0')).every((b) => b === 0));
});
