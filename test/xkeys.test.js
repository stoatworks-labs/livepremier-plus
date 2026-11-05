/*
 * X-keys: the bytes against recordings of real panels, the driver against a
 * pretend panel, what each job asks for and how each key lights, and the
 * supervisor end to end against a pretend switcher. ** PREVIEW **: nothing
 * here has met a panel; `test/fixtures/xkeys-recordings.json` is the nearest
 * thing — SuperFly.tv's recordings of nineteen real models.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

import * as X from '../src/core/xkeys.js';
import { XKeysDriver, xkeysIn } from '../devices/modules/xkeys/driver.js';
import xkeysModule from '../devices/modules/xkeys/module.js';
import { createHostCore } from '../devices/core.js';
import { FakeXKeys, fakeXkeysHid } from './helpers/fake-xkeys.js';
import { fakeAwj } from './helpers/fake-awj.js';
import {
  DEFAULT_XKEYS, normaliseXkeys, xkeysChanged, normaliseBinding, suggestedLayout, layoutFor, limitsFor,
  keyIntent, paint, paletteFor, legendOf, JOBS,
} from '../plugins/xkeys/core.js';
import { XKeysSupervisor } from '../plugins/xkeys/supervisor.js';
import { Selection, layerSourcePath } from '../src/core/console-intents.js';
import { NLC } from '../src/core/dialect.js';
import { toAwj } from '../src/core/paths.js';
import { labelPath, slotValidPath } from '../server/console-switcher.js';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await settle(5); }
  return check();
}

const RECORDINGS = JSON.parse(readFileSync(new URL('./fixtures/xkeys-recordings.json', import.meta.url), 'utf8'));
/* Real panels send 32 bytes, or 36 on the newer ones; zeros past the end change nothing. */
const unhex = (s) => Uint8Array.from(Buffer.from(s.padEnd(72, '0'), 'hex'));
const padOut = (s) => s.padEnd(X.OUT_BYTES * 2, '0');
const hex = (r) => Buffer.from(r).toString('hex');

/* ------------------------------------------------------------- the table */

test('the table: 29 panels with keys, X-keys’ vendor id, each found by product id on its own interface', () => {
  assert.equal(X.VENDOR_ID, 1523);
  assert.equal(X.MODELS.length, 29);
  const xk24 = X.findProduct({ vendorId: 1523, productId: 1029, interface: 0 });
  assert.equal(xk24.name, 'XK-24');
  assert.equal(X.findProduct({ vendorId: 1523, productId: 1029, interface: 1 }), null, 'its keyboard interface is not it');
  assert.equal(X.findProduct({ vendorId: 1523, productId: 1029, interface: -1 }).model, 'XK24', 'an interface nobody could say is taken');
  assert.equal(X.findProduct({ vendorId: 0x1edb, productId: 1029, interface: 0 }), null, 'another vendor');
  assert.equal(X.findProduct({ vendorId: 1523, productId: 9999, interface: 0 }), null);
  assert.equal(X.keysOf(X.productOf('XK24')).length, 25, '24 keys and the program switch');
  assert.equal(X.keysOf(X.productOf('XKE124TBAR')).length, 124, 'the T-bar’s own bits left out');
  assert.equal(X.keysOf(X.productOf('XK3FOOT')).length, 4, 'three pedals and the program switch');
  assert.deepEqual(X.keyLocation(X.productOf('XK24'), 7), { row: 1, col: 2 }, 'keys count down each column');
  for (const m of X.MODELS) assert.ok(X.keysOf(m).length >= 3, `${m.name} has keys`);
});

test('every recording of a real panel decodes to the presses, releases, T-bar, jog and shuttle it recorded', () => {
  let checked = 0;
  for (const rec of RECORDINGS.panels) {
    const product = X.findProduct({ productId: rec.productId, interface: 0 });
    assert.ok(product, `${rec.name} is in the table`);
    assert.equal(product.name, rec.name);
    let keys = [];
    /* What the library's mock answers Generate Data with: everything at rest. */
    let analog = { t: (product.hasTbar || []).map(() => 0), j: (product.hasJog || []).map(() => 0), s: (product.hasShuttle || []).map(() => 0) };
    for (const [data, kind, ...rest] of rec.events) {
      const r = X.decodeReport(product, unhex(data));
      assert.ok(r && r.type === 'keys', `${rec.name}: ${data} is a key report`);
      const { down, up } = X.keyChanges(keys, r.keys);
      keys = r.keys;
      const said = [];
      for (const k of down) said.push(['d', k]);
      for (const k of up) said.push(['u', k]);
      const now = { t: r.tbar, j: r.jog, s: r.shuttle };
      for (const t of ['t', 's']) now[t].forEach((v, i) => { if (analog[t][i] !== v) said.push([t, i, v]); });
      now.j.forEach((v, i) => { if (v !== 0 && analog.j[i] !== v) said.push(['j', i, v]); });
      analog = now;
      if (!kind) { assert.deepEqual(said.filter((s) => s[0] === 'd' || s[0] === 'u'), [], `${rec.name}: ${data} changes no key`); continue; }
      if (kind === 'd' || kind === 'u') {
        const [index, row, col, ts] = rest;
        assert.deepEqual(said.filter((s) => s[0] === 'd' || s[0] === 'u'), [[kind, index]], `${rec.name}: ${data}`);
        assert.deepEqual(X.keyLocation(product, index), { row, col }, `${rec.name}: key ${index} placed`);
        assert.equal(r.timestamp, ts, `${rec.name}: timestamp`);
      } else {
        const [index, value] = rest;
        assert.ok(said.some((s) => s[0] === kind && s[1] === index && s[2] === value), `${rec.name}: ${kind}${index} = ${value} from ${data}`);
      }
      checked++;
    }
  }
  assert.equal(checked, 2284, 'every described event in the nineteen recordings');
});

test('backlights, all backlights and the lamps: the bytes the library sends each panel', () => {
  const colour = (c) => (c === false ? X.RGB.OFF : { '00f': X.RGB.BLUE, blue: X.RGB.BLUE, ffffff: X.RGB.WHITE, f00: X.RGB.RED, '000': X.RGB.OFF }[c]);
  let checked = 0;
  for (const rec of RECORDINGS.panels) {
    const product = X.findProduct({ productId: rec.productId, interface: 0 });
    for (const [method, args, sent] of rec.actions) {
      let mine;
      if (method === 'setIndicatorLED') mine = [X.indicatorReport(args[0], args[1] ? (args[2] ? 'flash' : 'on') : 'off')];
      if (method === 'setAllBacklights') mine = X.allBacklightReports(product, colour(args[0]));
      if (method === 'setBacklight') mine = X.backlightReports(product, args[0], colour(args[1]), !!args[2]);
      assert.deepEqual(mine.map(hex), sent.map(padOut), `${rec.name}: ${method}(${JSON.stringify(args)})`);
      checked++;
    }
  }
  assert.equal(checked, 192);
  assert.equal(X.lampsOf(X.productOf('XK24')), 'two');
  assert.equal(X.lampsOf(X.productOf('XK16')), 'blue');
  assert.equal(X.lampsOf(X.productOf('XBK4X6')), 'rgb');
  assert.equal(X.lampsOf(X.productOf('XK3FOOT')), 'none');
  assert.deepEqual(X.backlightReports(X.productOf('XK24'), 0, X.RGB.RED), [], 'the program switch has no light');
  assert.equal(X.versionRequest().length, 36);
  assert.deepEqual(X.generateDataRequest().slice(0, 2), [0, 177]);
});

test('a version reply and a Generate Data answer are told apart from presses', () => {
  const p = X.productOf('XK24');
  const v = new Uint8Array(32); v[0] = 10; v[1] = 214; v[10] = 38;
  assert.deepEqual(X.decodeReport(p, v), { type: 'version', unitId: 10, firmware: 38 });
  const g = new Uint8Array(32); g[1] = 2 | 1; g[2] = 1;
  const r = X.decodeReport(p, g);
  assert.equal(r.generated, true);
  assert.deepEqual(r.keys, [0, 1], 'the program switch and key 1 held');
  const s = new Uint8Array(32); s[1] = 200;
  assert.deepEqual(X.decodeReport(p, s), { type: 'special', code: 200 });
  assert.equal(X.decodeReport(p, new Uint8Array(3)), null, 'too short to be anything');
});

/* ------------------------------------------------------------- the driver */

test('the driver: looked for until wanted, opened shared, version and state asked, keys passed on, let go', async () => {
  const panel = new FakeXKeys({ model: 'XK24', unitId: 7 });
  const other = new FakeXKeys({ model: 'XK80' });
  const hid = fakeXkeysHid([panel, other], {
    extra: [{ vendorId: 1523, productId: 1029, interface: 1, path: 'keyboard', product: 'XK-24 kbd' }],
  });
  const d = new XKeysDriver({ hid, scanMs: 10, askMs: 10 });
  const reports = [];
  d.on('report', (b) => reports.push(b));
  d.start();
  try {
    assert.ok(await until(() => d.state.present));
    assert.equal(d.state.connected, false, 'not held until wanted');
    assert.equal(d.state.model, 'XK24', 'the first by path');
    assert.equal(d.state.others, 1);
    assert.equal(hid.opened.length, 0);
    await d.want(true);
    assert.ok(await until(() => d.state.ready));
    assert.equal(hid.opened[0], panel, 'its own interface, not the keyboard');
    assert.equal(d.state.unitId, 7);
    assert.equal(d.state.firmware, 38);
    assert.deepEqual(panel.written.slice(0, 2).map((w) => w[1]), [214, 177], 'version, then Generate Data');
    panel.tap(3);
    assert.ok(await until(() => reports.length >= 3), 'the answer, the press and the release');
    assert.equal(await d.write(X.indicatorReport(1, 'on')), true);
    assert.equal(panel.indicators.green, 1);
    await d.want(false);
    assert.equal(panel.closed, true);
    assert.equal(d.state.connected, false);
    assert.equal(await d.write(X.indicatorReport(1, 'on')), false, 'refused when not held');
  } finally {
    await d.stop();
  }
});

test('the driver takes a silent panel after three asks, and looks again when it is unplugged', async () => {
  const panel = new FakeXKeys({ model: 'XK24', answers: false });
  const hid = fakeXkeysHid([panel]);
  const d = new XKeysDriver({ hid, scanMs: 10, askMs: 10 });
  d.start();
  try {
    await d.want(true);
    assert.ok(await until(() => d.state.ready), 'taken as it is');
    assert.equal(panel.written.filter((w) => w[1] === 177).length, 3);
    hid.present = [];
    panel.unplug();
    assert.ok(await until(() => !d.state.connected && !d.state.present));
  } finally {
    await d.stop();
  }
});

test('the host starts the X-keys module on node-hid and passes its reports through', async () => {
  const panel = new FakeXKeys({ model: 'XKE124TBAR' });
  const sent = [];
  const core = createHostCore({ hid: fakeXkeysHid([panel]), modules: [xkeysModule], send: (m) => sent.push(m) });
  try {
    const hello = sent.find((m) => m.type === 'hello');
    assert.deepEqual(hello.modules.map((m) => [m.id, m.available]), [['xkeys', true]]);
    await core.handle({ op: 'want', id: 1, module: 'xkeys', wanted: true });
    assert.ok(await until(() => sent.some((m) => m.type === 'state' && m.state.ready)));
    await core.handle({ op: 'write', id: 2, module: 'xkeys', reports: [X.indicatorReport(2, 'flash')] });
    assert.equal(panel.indicators.red, 2);
    assert.ok(sent.some((m) => m.type === 'reply' && m.id === 2 && m.ok && m.result === 1));
    assert.equal(xkeysIn([{ vendorId: 1523, productId: 1278, interface: 0, path: 'p' }])[0].product.name, 'XKE-124 T-bar');
  } finally {
    await core.stop();
  }
});

/* ------------------------------------------------------------- the jobs */

const FACTS = {
  destinations: [
    { id: 'S1', label: 'LED', isUsed: true, faded: false, frozen: false },
    { id: 'S2', label: 'IMAG', isUsed: true, faded: true, frozen: false },
    { id: 'S3', label: '', isUsed: false },
  ],
  sources: {
    LIVE: [{ number: 1, label: 'CAM 1' }, { number: 2, label: 'CAM 2' }, { number: 3, label: 'PPT' }],
    STILL: [{ number: 1, label: 'Logo' }],
    SCREEN: [{ number: 1, label: 'LED' }],
  },
  presets: [{ slot: 1, label: 'Opener' }],
  freeSlots: [2, 3],
  layers: [{ destination: 'S1', key: 1 }, { destination: 'S1', key: 2 }, { destination: 'S2', key: 1 }],
};

function selected(...ids) {
  const s = new Selection();
  s.restrict(['S1', 'S2']);
  for (const id of ids) s.apply({ kind: 'select', destination: id });
  return s;
}

test('settings: off with nothing laid out by default; bad keys and jobs dropped; only a real change counts', () => {
  assert.deepEqual(normaliseXkeys(undefined), DEFAULT_XKEYS);
  const n = normaliseXkeys({
    xkeysEnabled: 'yes',
    xkeysLayouts: {
      XK24: { 1: { do: 'input', n: 3 }, 2: { do: 'input', n: 0 }, 3: { do: 'screen', id: 's2' }, x: { do: 'take' }, 4: { do: 'nonsense' }, 5: { do: 'none' }, 6: { do: 'take', n: 9 } },
      '../evil': { 1: { do: 'take' } },
    },
  });
  assert.equal(n.xkeysEnabled, false, 'only true turns it on');
  assert.deepEqual(n.xkeysLayouts, { XK24: { 1: { do: 'input', n: 3 }, 3: { do: 'screen', id: 'S2' }, 6: { do: 'take' } } });
  assert.equal(xkeysChanged(n, normaliseXkeys(JSON.parse(JSON.stringify(n)))), false);
  assert.equal(xkeysChanged(n, { ...n, xkeysEnabled: true }), true);
  assert.equal(normaliseBinding({ do: 'recall', n: 1000 }), null, 'past the switcher');
  for (const j of JOBS) assert.equal(typeof j.what, 'string', `${j.id} says what it does`);
});

test('the suggestion: TAKE last, CUT before it, then inputs, memories, screens and layers by row', () => {
  const xk24 = X.productOf('XK24');
  const s = suggestedLayout(xk24);
  const at = (row, col) => s[X.keysOf(xk24).find((k) => k.row === row && k.col === col).index];
  assert.deepEqual(at(6, 4), { do: 'take' });
  assert.deepEqual(at(6, 3), { do: 'cut' });
  assert.deepEqual(at(6, 2), { do: 'ftb' });
  assert.deepEqual(at(1, 1), { do: 'input', n: 1 });
  assert.deepEqual(at(1, 4), { do: 'input', n: 4 });
  assert.deepEqual(at(2, 2), { do: 'recall', n: 2 });
  assert.deepEqual(at(3, 1), { do: 'screen', id: 'S1' });
  assert.deepEqual(at(4, 3), { do: 'layer', n: 3 });
  assert.equal(s[0], undefined, 'the program switch is left alone');
  const pedal = suggestedLayout(X.productOf('XK3FOOT'));
  assert.deepEqual(Object.values(pedal), [{ do: 'input', n: 1 }, { do: 'cut' }, { do: 'take' }]);
  const stick = suggestedLayout(X.productOf('XK16'));
  assert.equal(Object.values(stick).filter((b) => b.do === 'input').length, 11, 'a stick: one row, less the five at the end');
  assert.deepEqual(layoutFor({ xkeysLayouts: {} }, xk24).suggested, true);
  assert.deepEqual(layoutFor({ xkeysLayouts: { XK24: {} } }, xk24), { keys: {}, suggested: false }, 'cleared is saved, not suggested');
  assert.equal(limitsFor({ 1: { do: 'recall', n: 48 }, 2: { do: 'input', n: 4 } }).memories, 48);
  assert.equal(limitsFor({}).inputs, 20);
});

test('what each job asks for, and why a key does nothing', () => {
  const sel = selected('S1');
  const ctx = { facts: FACTS, selection: sel, memoryLimit: 20 };
  assert.deepEqual(keyIntent({ do: 'take' }, ctx), { kind: 'take' });
  assert.deepEqual(keyIntent({ do: 'timeDown' }, ctx), { kind: 'time', delta: -1 });
  assert.deepEqual(keyIntent({ do: 'input', n: 2 }, ctx), { kind: 'source', input: 2, sourceKind: 'LIVE', buffer: 'PREVIEW', label: 'CAM 2' });
  assert.deepEqual(keyIntent({ do: 'still', n: 1 }, ctx).sourceKind, 'STILL');
  assert.match(keyIntent({ do: 'input', n: 9 }, ctx).why, /input 9 is not in use/);
  assert.deepEqual(keyIntent({ do: 'recall', n: 1 }, ctx), { kind: 'recall', slot: 1, label: 'Opener' });
  assert.match(keyIntent({ do: 'recall', n: 2 }, ctx).why, /no memory in slot 2/);
  assert.deepEqual(keyIntent({ do: 'screen', id: 'S2' }, ctx), { kind: 'selectOnly', destination: 'S2' });
  assert.match(keyIntent({ do: 'screen', id: 'S3' }, ctx).why, /not in service/);
  assert.deepEqual(keyIntent({ do: 'screenAdd', id: 'S2' }, ctx), { kind: 'select', destination: 'S2' });
  assert.deepEqual(keyIntent({ do: 'screenAdd', id: 'S1' }, ctx), { kind: 'unselect', destination: 'S1' });
  assert.deepEqual(keyIntent({ do: 'layer', n: 2 }, ctx), { kind: 'selectLayer', layer: 2 });
  assert.match(keyIntent({ do: 'layer', n: 5 }, ctx).why, /S1 has no layer 5/);
  assert.deepEqual(keyIntent({ do: 'layerNext' }, ctx), { kind: 'selectLayer', layer: 2 });
  assert.match(keyIntent(null, ctx).why, /no job/);
  assert.equal(legendOf({ do: 'input', n: 3 }), 'IN 3');
  assert.equal(legendOf({ do: 'screenAdd', id: 'S2' }), '+S2');
});

test('the panel drawn: red on air, blue in preview, the driven screen and layer blue, FTB flashing red while faded', () => {
  const p = X.productOf('XK24');
  const layout = { 1: { do: 'input', n: 1 }, 2: { do: 'input', n: 2 }, 3: { do: 'input', n: 3 }, 4: { do: 'screen', id: 'S1' }, 5: { do: 'screen', id: 'S2' }, 6: { do: 'layer', n: 1 }, 7: { do: 'ftb' }, 8: { do: 'take' } };
  const tally = { layer: 1, program: { kind: 'LIVE', number: 1 }, preview: { kind: 'LIVE', number: 2 } };
  const two = paletteFor(p);
  let lamps = paint({ product: p, layout, facts: FACTS, selection: selected('S1'), tally });
  assert.deepEqual(lamps.get(1), two.program);
  assert.deepEqual(lamps.get(2), two.preview);
  assert.deepEqual(lamps.get(3), two.available, 'dark: two colours have none to spare');
  assert.deepEqual(lamps.get(4), two.chosen);
  assert.deepEqual(lamps.get(5), two.available);
  assert.deepEqual(lamps.get(6), two.chosen);
  assert.deepEqual(lamps.get(7), two.available);
  assert.deepEqual(lamps.get(10), { colour: X.RGB.OFF, flash: false }, 'no job, no light');
  lamps = paint({ product: p, layout, facts: FACTS, selection: selected('S2'), tally: null, held: new Set([10]), stroke: 0.5 });
  assert.deepEqual(lamps.get(7), two.faded, 'S2 is faded');
  assert.deepEqual(lamps.get(8), two.active, 'TAKE during a T-bar stroke');
  assert.deepEqual(lamps.get(10), two.held, 'a held key shows, job or not');
  const rgb = paletteFor(X.productOf('XBK4X6'));
  assert.deepEqual(rgb.preview.colour, X.RGB.GREEN);
  assert.deepEqual(paint({ product: X.productOf('XK3FOOT'), layout: {}, facts: FACTS, selection: selected('S1') }).size, 0, 'a pedal has nothing to light');
});

/* ------------------------------------------------------------- end to end */

function lpStore() {
  const s = new Map();
  const set = (path, v) => s.set(toAwj(path), v);
  s.set('DeviceObject/system/$device/@items/1/@props/dev', 'NLC_RS4');
  set(NLC.takeStatus('S1', 'isUsed'), true);
  set(labelPath(NLC, 'S1'), 'LED');
  set(NLC.takeControl('S1', 'presetUp'), 'A');
  set(NLC.takeControl('S1', 'presetDown'), 'B');
  set(NLC.takeControl('S1', 'presetPrevious'), 'C');
  set(NLC.takeStatus('S1', 'transition'), 'AT_DOWN');
  set(NLC.takeStatus('S1', 'tbarPosition'), 0);
  set(NLC.fadeToBlackPath('S1'), false);
  const probe = NLC.layerProbe('S1', 16);
  for (const k of probe.slots) set(probe.path(k), Number(k) <= 2 ? 'FULL' : 'OFF');
  const spec = layerSourcePath(NLC);
  set(NLC.layerParamPath('S1', 'B', 1, spec), 'LIVE_1');   // on air
  set(NLC.layerParamPath('S1', 'A', 1, spec), 'LIVE_2');   // in preview
  ['CAM 1', 'CAM 2', 'PPT'].forEach((label, i) => {
    set(['device', 'inputList', 'items', `IN_${i + 1}`, 'mapping', 'pp', 'isValid'], true);
    set(['device', 'inputList', 'items', `IN_${i + 1}`, 'control', 'pp', 'label'], label);
  });
  set(NLC.label('screen', 1, '').path, 'Opener');
  set(slotValidPath(NLC, 1), true);
  return s;
}

/** The `devices` service, holding a real driver on a pretend panel in this process. */
function devicesWith(driver) {
  const events = new EventEmitter();
  driver.on('state', (st) => events.emit('state', st));
  driver.on('report', (b) => events.emit('report', b));
  const handle = {
    get state() { return driver.state; },
    get available() { return true; },
    reason: null,
    want: (w) => driver.want(w),
    async write(reports) {
      if (reports.length > 16) throw new Error('at most 16 reports');
      let n = 0;
      for (const r of reports) if (await driver.write(Uint8Array.from(r))) n++;
      return n;
    },
    on(ev, fn) { events.on(ev, fn); return () => events.off(ev, fn); },
  };
  return { module: () => handle, status: () => ({ installed: true, running: true, reason: null }) };
}

test('the supervisor end to end: tally lit, an input to preview, a recall, take, cut, FTB, a refusal, a T-bar throw, dark at the end', async () => {
  const awj = await fakeAwj(lpStore());
  const panel = new FakeXKeys({ model: 'XKE124TBAR' });
  const driver = new XKeysDriver({ hid: fakeXkeysHid([panel]), scanMs: 10, askMs: 10 });
  driver.start();
  const devices = devicesWith(driver);
  const sup = new XKeysSupervisor({ deviceHost: () => '127.0.0.1', awjPort: awj.port, devices: () => devices });
  const writes = () => awj.writes();
  /* Keys by place, as an operator would lay them out: column c, row 1 is key (c − 1) × 8 + 1. */
  const KEY = { IN1: 1, IN2: 9, IN3: 17, MEM1: 2, S1: 3, L1: 4, L2: 12, TAKE: 121, CUT: 113, FTB: 105, EMPTY: 50, MEM9: 10 };
  const layout = {
    [KEY.IN1]: { do: 'input', n: 1 }, [KEY.IN2]: { do: 'input', n: 2 }, [KEY.IN3]: { do: 'input', n: 3 },
    [KEY.MEM1]: { do: 'recall', n: 1 }, [KEY.MEM9]: { do: 'recall', n: 9 }, [KEY.S1]: { do: 'screen', id: 'S1' },
    [KEY.L1]: { do: 'layer', n: 1 }, [KEY.L2]: { do: 'layer', n: 2 },
    [KEY.TAKE]: { do: 'take' }, [KEY.CUT]: { do: 'cut' }, [KEY.FTB]: { do: 'ftb' },
  };
  try {
    await sup.apply(normaliseXkeys({ xkeysEnabled: true, xkeysLayouts: { XKE124TBAR: layout } }));
    assert.ok(await until(() => panel.lampOf(KEY.IN1) === 'red' && panel.lampOf(KEY.IN2) === 'blue'), 'tally from the switcher');
    assert.equal(panel.lampOf(KEY.S1), 'blue', 'S1 driven, the first screen in service');
    assert.equal(panel.lampOf(KEY.L1), 'blue', 'layer 1');
    assert.equal(panel.lampOf(KEY.L2), 'off', 'layer 2 fitted, not chosen');
    assert.equal(panel.lampOf(KEY.IN3), 'off');
    assert.ok(await until(() => panel.indicators.green === 1), 'green: driving a switcher that answers');

    awj.clear();
    panel.tap(KEY.IN3);
    assert.ok(await until(() => writes().length));
    assert.deepEqual(writes()[0], { path: toAwj(NLC.layerParamPath('S1', 'A', 1, layerSourcePath(NLC))), value: 'LIVE_3' }, 'the preview letter’s layer 1');
    assert.ok(await until(() => panel.lampOf(KEY.IN3) === 'blue'), 'tally read again after the press');

    awj.clear();
    panel.tap(KEY.MEM1);
    assert.ok(await until(() => writes().length));
    assert.match(writes()[0].path, /\$slot\/@items\/1\/\$screen\/@items\/S1\/\$preset\/@items\/PREVIEW\/@props\/xRequest$/, 'to preview, always');

    awj.clear();
    panel.tap(KEY.TAKE);
    assert.ok(await until(() => writes().length));
    assert.deepEqual(writes(), [{ path: toAwj(NLC.takeControl('S1', 'xTake')), value: true }]);

    awj.clear();
    panel.tap(KEY.CUT);
    assert.ok(await until(() => writes().length));
    assert.deepEqual(writes(), [{ path: toAwj(NLC.takeControl('S1', 'xCut')), value: true }]);

    awj.clear();
    panel.tap(KEY.FTB);
    assert.ok(await until(() => writes().length));
    assert.deepEqual(writes(), [{ path: toAwj(NLC.fadeToBlackPath('S1')), value: true }]);
    assert.ok(await until(() => panel.lampOf(KEY.FTB) === 'red*'), 'read again: faded, flashing red');

    awj.clear();
    panel.tap(KEY.L2);
    assert.ok(await until(() => panel.lampOf(KEY.L2) === 'blue' && panel.lampOf(KEY.L1) === 'off'), 'layer 2 chosen');
    panel.tap(KEY.L1);
    assert.ok(await until(() => panel.lampOf(KEY.L1) === 'blue'));

    panel.tap(KEY.MEM9);
    assert.ok(await until(() => sup.history.some((e) => e.index === KEY.MEM9 && /no memory in slot 9/.test(e.note || ''))));
    assert.ok(await until(() => panel.indicators.red === 2), 'red flashes for a refused press');
    panel.tap(KEY.EMPTY);
    assert.ok(await until(() => sup.history.some((e) => e.index === KEY.EMPTY && /no job/.test(e.note || ''))));
    assert.equal(writes().length, 0, 'nothing written for either');

    awj.clear();
    panel.press(KEY.EMPTY);
    assert.ok(await until(() => panel.lampOf(KEY.EMPTY) === 'both'), 'a held key shows');
    panel.release(KEY.EMPTY);
    assert.ok(await until(() => panel.lampOf(KEY.EMPTY) === 'off'));

    awj.clear();
    panel.setTbar(0);                 // where the lever rests: not a stroke
    await settle(30);
    assert.equal(writes().length, 0);
    panel.setTbar(128);
    assert.ok(await until(() => writes().some((x) => x.path.endsWith('tbarPosition'))));
    assert.ok(await until(() => panel.lampOf(KEY.TAKE) === 'red'), 'TAKE red mid-stroke');
    panel.setTbar(255);
    assert.ok(await until(() => writes().some((x) => x.path.endsWith('tbarPosition') && x.value === 65535)), 'the throw completes the take');
    assert.ok(sup.history.some((e) => /T-bar take on S1/.test(e.note || '')));

    await sup.apply(normaliseXkeys({ xkeysEnabled: false }));
    assert.ok(panel.dark(), 'left dark');
    assert.equal(panel.closed, true, 'and let go');
  } finally {
    await sup.stop();
    await driver.stop();
    await awj.close();
  }
});

test('a suggested layout drives a panel nobody has laid out, and a cleared one does nothing', async () => {
  const awj = await fakeAwj(lpStore());
  const panel = new FakeXKeys({ model: 'XK24' });
  const driver = new XKeysDriver({ hid: fakeXkeysHid([panel]), scanMs: 10, askMs: 10 });
  driver.start();
  const devices = devicesWith(driver);
  const sup = new XKeysSupervisor({ deviceHost: () => '127.0.0.1', awjPort: awj.port, devices: () => devices });
  const xk24 = X.productOf('XK24');
  const take = Number(Object.entries(suggestedLayout(xk24)).find(([, b]) => b.do === 'take')[0]);
  try {
    await sup.apply(normaliseXkeys({ xkeysEnabled: true }));
    assert.ok(await until(() => sup.describe().layout?.suggested === true));
    assert.ok(await until(() => panel.lampOf(1) === 'red'), 'input 1, on air, on the suggestion’s first key');
    awj.clear();
    panel.tap(take);
    assert.ok(await until(() => awj.writes().length));
    assert.deepEqual(awj.writes(), [{ path: toAwj(NLC.takeControl('S1', 'xTake')), value: true }]);

    await sup.apply(normaliseXkeys({ xkeysEnabled: true, xkeysLayouts: { XK24: {} } }));
    assert.ok(await until(() => panel.lampOf(1) === 'off'), 'cleared: dark');
    awj.clear();
    panel.tap(take);
    assert.ok(await until(() => sup.history.some((e) => e.index === take && /no job/.test(e.note || ''))));
    assert.equal(awj.writes().length, 0);
  } finally {
    await sup.stop();
    await driver.stop();
    await awj.close();
  }
});
