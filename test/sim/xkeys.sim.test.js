/*
 * X-keys, live: a pretend XKE-124 T-bar (`test/helpers/fake-xkeys.js`) inside
 * the real device host core, the app's own `xkeys` plugin holding it with no
 * page open and a layout given to its keys, and the simulator at the far end.
 * Every effect is witnessed over AWJ or on the vendor socket; S1 is put back
 * afterwards.
 *
 * Only the panel is a stand-in. Everything from a key's bytes to the switcher
 * is the code that ships — which is still not a panel on a desk.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { SKIP, startApp, Link, awjGet, sag, settled, guardScreen, layerPath, sleep, offeredInputs } from './harness.js';
import { bankLetter } from '../../src/core/properties.js';
import xkeysModule from '../../devices/modules/xkeys/module.js';
import { createDeviceHost } from '../../server/device-host.js';
import { inProcessFork } from '../helpers/fake-speed-editor.js';
import { FakeXKeys, fakeXkeysHid } from '../helpers/fake-xkeys.js';

let app;
let link;
let guard;
let host;
let panel;

/* Keys by place on an XKE-124 T-bar: column c, row r is key (c − 1) × 8 + r. */
const KEY = { IN_A: 1, IN_B: 9, S1: 3, L1: 4, TAKE: 121, EMPTY: 50 };

const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(25); }
  return false;
};

/** The live inputs the plugin keeps, in order — the rule the console reader and the Web RCS picker share. */
const liveInputs = () => offeredInputs(link, 20);

let inputs = [];

before(async () => {
  if (SKIP) return;
  panel = new FakeXKeys({ model: 'XKE124TBAR' });
  host = createDeviceHost({
    entry: 'host.js',
    fork: inProcessFork({ hid: fakeXkeysHid([panel]), modules: [xkeysModule] }),
  });
  host.start();
  app = await startApp({ devices: host.api });
  link = await Link.open(app);
  guard = await guardScreen(link, 'S1');
  inputs = liveInputs();
  const [a, b] = inputs;
  await app.configure({
    plugins: {
      xkeys: {
        enabled: true,
        settings: {
          xkeysEnabled: true,
          xkeysLayouts: {
            XKE124TBAR: {
              [KEY.IN_A]: { do: 'input', n: a ?? 1 },
              [KEY.IN_B]: { do: 'input', n: b ?? 2 },
              [KEY.S1]: { do: 'screen', id: 'S1' },
              [KEY.L1]: { do: 'layer', n: 1 },
              [KEY.TAKE]: { do: 'take' },
            },
          },
        },
      },
    },
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

const state = async () => (await app.api('/xkeys/state')).json;

test('the plugin takes the panel with no page open, drives S1, and lights tally the switcher agrees with', { skip: SKIP }, async () => {
  assert.ok(inputs.length >= 2, 'the simulator has two live inputs');
  assert.ok(await until(() => panel.written.some((w) => w[1] === 177)), 'the device host opened the panel and asked for its keys');
  assert.ok(await until(async () => (await state()).tally), 'tally read');
  const s = await state();
  assert.equal(s.panel.connected, true);
  assert.equal(s.panel.model, 'XKE124TBAR');
  assert.deepEqual(s.selection.destinations, ['S1']);
  assert.equal(s.layout.suggested, false);
  assert.ok(await until(() => panel.lampOf(KEY.S1) === 'blue'), 'S1’s key lit: driven');
  assert.ok(await until(() => panel.indicators.green === 1), 'the green lamp: a switcher that answers');
  const pv = bankLetter(link.store, 'S1', 'PREVIEW').letter;
  const onPreview = await awjGet(layerPath('S1', pv, s.selection.layer, 'source', 'pp', 'inputNum'));
  const m = /^LIVE_(\d+)$/.exec(String(onPreview));
  assert.deepEqual(s.tally.preview, m ? { kind: 'LIVE', number: Number(m[1]) } : null, `tally says what AWJ says: ${onPreview}`);
});

test('an input key puts its input on preview and lights blue; TAKE and the T-bar take; a key with no job writes nothing', { skip: SKIP }, async () => {
  await settled(link, 'S1');
  const [, b] = inputs;
  const pv = bankLetter(link.store, 'S1', 'PREVIEW').letter;
  panel.tap(KEY.IN_B);
  await link.waitFor(layerPath('S1', pv, 1, 'source', 'pp', 'inputNum'), `LIVE_${b}`, { timeout: 4000 });
  assert.equal(await awjGet(layerPath('S1', pv, 1, 'source', 'pp', 'inputNum')), `LIVE_${b}`, 'on preview, layer 1');
  assert.ok(await until(() => panel.lampOf(KEY.IN_B) === 'blue'), 'its key went blue');

  const from = await settled(link, 'S1');
  const to = from === 'AT_UP' ? 'AT_DOWN' : 'AT_UP';
  panel.tap(KEY.TAKE);
  await link.waitFor(sag('S1', 'status', 'transition'), to, { timeout: 15000 });
  assert.ok(await until(() => panel.lampOf(KEY.IN_B) === 'red'), 'on air now: red');

  /* The lever rests at one end; a throw to the other is the next take, back
     the other way. The simulator has no in-between state, so only the take
     is seen. */
  await settled(link, 'S1');
  panel.setTbar(0);
  await sleep(200);
  panel.setTbar(128);
  await sleep(200);
  panel.setTbar(255);
  await link.waitFor(sag('S1', 'status', 'transition'), from, { timeout: 15000 });
  assert.ok((await state()).history.some((e) => /T-bar take on S1/.test(e.note || '')), 'the stroke is in the history');

  const before = await awjGet(layerPath('S1', bankLetter(link.store, 'S1', 'PREVIEW').letter, 1, 'source', 'pp', 'inputNum'));
  panel.tap(KEY.EMPTY);
  assert.ok(await until(async () => (await state()).history.some((e) => e.index === KEY.EMPTY && /no job/.test(e.note || ''))));
  assert.equal(await awjGet(layerPath('S1', bankLetter(link.store, 'S1', 'PREVIEW').letter, 1, 'source', 'pp', 'inputNum')), before, 'nothing changed');
});

test('switched off, the plugin hands the panel back, dark', { skip: SKIP }, async () => {
  await app.configure({ plugins: { xkeys: { settings: { xkeysEnabled: false } } } });
  assert.ok(await until(() => panel.closed), 'let go');
  assert.ok(panel.dark(), 'left dark');
});
