/*
 * The ATEM Micro Panel: its bytes, the driver against a pretend panel, what
 * every key means, the lamps, and the supervisor end to end against a
 * pretend switcher.
 *
 * ⚠️ Nothing here has met a real panel. The pretend one is what
 * node-blackmagic-controller says the panel is (`helpers/fake-atem-micro-panel.js`);
 * a pass is evidence that this agrees with it, not with the hardware.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import * as P from '../src/core/atem-micro-panel.js';
import { AtemMicroPanelDriver } from '../devices/modules/atem-micro-panel/driver.js';
import microModule from '../devices/modules/atem-micro-panel/module.js';
import { SpeedEditorDriver } from '../devices/modules/speed-editor/driver.js';
import { createHostCore } from '../devices/core.js';
import { FakeMicroPanel } from './helpers/fake-atem-micro-panel.js';
import { FakePanel, fakeHid } from './helpers/fake-speed-editor.js';
import { fakeAwj } from './helpers/fake-awj.js';
import {
  DEFAULT_ATEM_MICRO, normaliseAtemMicro, atemMicroChanged, initialView, keyIntent, paint, selectOnly, UNMAPPED,
} from '../plugins/atem-micro-panel/core.js';
import { AtemMicroPanelSupervisor } from '../plugins/atem-micro-panel/supervisor.js';
import { Selection, readSource, strokeProgress } from '../src/core/console-intents.js';
import { NLC } from '../src/core/dialect.js';
import { toAwj } from '../src/core/paths.js';
import { labelPath, slotValidPath } from '../server/console-switcher.js';
import { layerSourcePath } from '../src/core/console-intents.js';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await settle(5); }
  return false;
}
const { COLOUR } = P;

/* ------------------------------------------------------------------ bytes */

test('the key table: fifty keys, codes 1–50, each lamp three bits at 13 + 3 × code, clear of the T-bar meter', () => {
  assert.equal(P.KEYS.length, 50);
  assert.deepEqual(P.KEYS.map((k) => k.code).sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.equal(new Set(P.KEYS.map((k) => k.name)).size, 50, 'no name twice');
  for (const k of P.KEYS) {
    /* node-blackmagic-controller's table has exactly this shape; a slip in
       copying it breaks the rule here. */
    assert.equal(k.led, 13 + 3 * k.code, `${k.name}'s lamp bit`);
    assert.ok(k.led >= P.TBAR_SEGMENTS, `${k.name} is clear of the meter`);
    assert.ok(k.led + 2 < (P.LED_REPORT_BYTES - 1) * 8, `${k.name} fits the report`);
  }
  assert.equal(P.KEY_BY_NAME.get('CUT').code, 0x2b);
  assert.equal(P.KEY_BY_NAME.get('AUTO').code, 0x2c);
  assert.equal(P.KEY_BY_NAME.get('PVW_1').code, 0x15);
  assert.equal(P.KEY_BY_NAME.get('PGM_10').code, 0x14);
});

test('the lamp report: id 2, 32 bytes, a key’s colour on its three bits and the meter on the first sixteen', () => {
  const dark = P.darkReport();
  assert.equal(dark.length, 32);
  assert.equal(dark[0], 2);
  assert.ok(dark.slice(1).every((b) => b === 0));

  /* PROGRAM 1's lamp is bits 46–48: red is bit 46, byte 1 + 5, bit 6. */
  const red = P.ledReport(new Map([['PGM_1', COLOUR.RED]]));
  assert.equal(red[6], 0x40);
  assert.equal(red.slice(1).reduce((n, b) => n + (b ? 1 : 0), 0), 1, 'nothing else lit');
  const white = P.ledReport({ PGM_1: COLOUR.WHITE });
  assert.equal(white[6], 0xc0);
  assert.equal(white[7], 0x01);

  const full = P.ledReport(new Map(), P.meterFor(1));
  assert.equal(full[1], 0xff);
  assert.equal(full[2], 0xff);
  assert.equal(P.meterFor(0.5).filter(Boolean).length, 8);
  assert.equal(P.meterFor(0).filter(Boolean).length, 0);
  assert.equal(P.ledReport({ NOT_A_KEY: COLOUR.RED }).slice(1).every((b) => b === 0), true, 'an unknown name is skipped');
});

test('input reports: every key held, the T-bar out of 4096, the battery; a press is a code that was not held before', () => {
  assert.deepEqual(P.decodeReport(Uint8Array.from([3, 0x2b, 0, 0x26, 0, 0, 0, 0x01, 0])), { type: 'keys', codes: [0x2b, 0x26] }, 'stops at the first zero');
  assert.deepEqual(P.decodeReport(Uint8Array.from([8, 0x00, 0x08])), { type: 'tbar', raw: 2048, fraction: 0.5 });
  assert.deepEqual(P.decodeReport(Uint8Array.from([8, 0xff, 0xff])).fraction, 1, 'clamped');
  assert.deepEqual(P.decodeReport(Uint8Array.from([6, 0, 73])), { type: 'battery', level: 73 });
  assert.equal(P.decodeReport(Uint8Array.from([9, 1, 2])), null);
  assert.deepEqual(P.keyChanges([0x2b], [0x2b, 0x26]), { down: [0x26], up: [] });
  assert.deepEqual(P.keyChanges([0x2b, 0x26], [0x26]), { down: [], up: [0x2b] });
  assert.deepEqual(P.keyChanges([], [0x99]), { down: [], up: [] }, 'a code that is no key is ignored');
});

test('the handshake is the Speed Editor’s, answered on feature report 5 at ten bytes', async () => {
  const panel = new FakeMicroPanel();
  const lease = await P.authenticate({
    sendFeature: (b) => panel.sendFeatureReport([...b]),
    getFeature: async (id, n) => Uint8Array.from(await panel.getFeatureReport(id, n)),
  });
  assert.equal(lease, 600);
  assert.equal(panel.authed, true);
  assert.ok(panel.reads.every(([id, n]) => id === 5 && n === 10));

  const refusing = new FakeMicroPanel({ refuse: true });
  await assert.rejects(P.authenticate({
    sendFeature: (b) => refusing.sendFeatureReport([...b]),
    getFeature: async (id, n) => Uint8Array.from(await refusing.getFeatureReport(id, n)),
  }), /refused/);
});

/* ------------------------------------------------------------------ driver */

test('the driver: looked for until wanted, then opened, answered and renewed; keys come back; lamps refused before the answer', async () => {
  const panel = new FakeMicroPanel();
  const hid = fakeHid([panel]);
  const driver = new AtemMicroPanelDriver({ hid, scanMs: 10, retryMs: 10 });
  const reports = [];
  driver.on('report', (b) => reports.push([...b]));
  driver.start();
  try {
    assert.ok(await until(() => driver.state.present), 'found');
    assert.equal(driver.state.connected, false, 'not held until wanted');
    assert.equal(await driver.write(P.darkReport()), false, 'nobody could hear it');
    await driver.want(true);
    assert.ok(await until(() => driver.state.authed), 'opened and answered');
    assert.equal(driver.state.lease, 600);
    assert.equal(driver.state.product, 'ATEM Micro Panel');
    panel.hold('CUT');
    panel.battery(64);
    assert.ok(await until(() => reports.length >= 2));
    assert.deepEqual(P.decodeReport(Uint8Array.from(reports[0])), { type: 'keys', codes: [0x2b] });
    assert.deepEqual(driver.state.battery, { charging: null, level: 64 });
    assert.equal(await driver.write(P.ledReport({ CUT: COLOUR.RED })), true);
    assert.equal(panel.colourOf('CUT'), COLOUR.RED);
    await driver.want(false);
    assert.equal(panel.closed, true, 'let go when nothing drives it');
  } finally {
    await driver.stop();
  }
});

test('a Speed Editor and a Micro Panel side by side: each driver opens only its own panel', async () => {
  const micro = new FakeMicroPanel();
  const editor = new FakePanel();
  const hid = fakeHid([editor, micro]);
  const md = new AtemMicroPanelDriver({ hid, scanMs: 10, retryMs: 10 });
  const sd = new SpeedEditorDriver({ hid, scanMs: 10, retryMs: 10 });
  md.start(); sd.start();
  try {
    await md.want(true); await sd.want(true);
    assert.ok(await until(() => md.state.authed && sd.state.authed));
    assert.equal(micro.authed, true);
    assert.equal(editor.authed, true);
    assert.equal(md.state.product, 'ATEM Micro Panel');
    assert.equal(sd.state.product, 'DaVinci Resolve Speed Editor');
  } finally {
    await md.stop(); await sd.stop();
  }
});

test('the host starts the Micro Panel module on node-hid and passes its lamp report through', async () => {
  const sent = [];
  const panel = new FakeMicroPanel();
  const core = createHostCore({ hid: fakeHid([panel]), modules: [microModule], send: (m) => sent.push(m) });
  try {
    assert.deepEqual(sent[0].modules.map((m) => [m.id, m.transport, m.available]), [['atem-micro-panel', 'hid', true]]);
    await core.handle({ op: 'want', id: 1, module: 'atem-micro-panel', wanted: true });
    assert.ok(await until(() => panel.authed));
    await until(() => core.drivers.get('atem-micro-panel').state.authed);
    await core.handle({ op: 'write', id: 2, module: 'atem-micro-panel', reports: [[...P.ledReport({ AUTO: COLOUR.WHITE })]] });
    assert.ok(sent.some((m) => m.type === 'reply' && m.id === 2 && m.ok && m.result === 1), 'written');
    assert.equal(panel.colourOf('AUTO'), COLOUR.WHITE);
  } finally {
    await core.stop();
  }
});

/* --------------------------------------------------------------- meaning */

const FACTS = {
  destinations: [
    { id: 'S1', kind: 'screen', label: 'LED', isUsed: true, faded: false, frozen: false },
    { id: 'S2', kind: 'screen', label: 'IMAG', isUsed: true, faded: true, frozen: true },
    { id: 'S3', kind: 'screen', label: '', isUsed: false },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `S${i + 4}`, kind: 'screen', label: '', isUsed: true })),
  ],
  sources: {
    LIVE: [1, 2, 3, 12].map((n) => ({ number: n, source: `LIVE_${n}`, label: n === 1 ? 'CAM 1' : '' })),
    STILL: [{ number: 1, source: 'STILL_1', label: 'Logo' }],
    SCREEN: [],
  },
  presets: [{ slot: 1, label: 'Opener' }, { slot: 13, label: 'Walk-in' }],
  freeSlots: [2, 3],
  layers: [1, 2, 3, 4, 5, 6].map((key) => ({ destination: 'S1', key })).concat([{ destination: 'S2', key: 1 }]),
};

function ctxWith({ select = ['S1'], view = initialView(), hotCut = false } = {}) {
  const selection = new Selection();
  selection.restrict(['S1', 'S2', 'S4', 'S5', 'S6', 'S7']);
  for (const d of select) selection.apply({ kind: 'select', destination: d });
  return { view, facts: FACTS, selection, hotCut };
}

test('settings: off by default, only a real true turns it on, and only that counts as a change', () => {
  assert.deepEqual(normaliseAtemMicro(undefined), DEFAULT_ATEM_MICRO);
  assert.deepEqual(normaliseAtemMicro({ atemMicroEnabled: 'yes' }), { atemMicroEnabled: false });
  assert.deepEqual(normaliseAtemMicro({ atemMicroEnabled: true, hotCut: true }), { atemMicroEnabled: true }, 'the program row is never a setting');
  assert.equal(atemMicroChanged({ atemMicroEnabled: false }, { atemMicroEnabled: true }), true);
});

test('M/E keys pick the screens in service, SHIFT the next four; another M/E held builds a selection', () => {
  const ctx = ctxWith();
  assert.deepEqual(keyIntent('ME_1', ctx), { kind: 'selectOnly', destination: 'S1', key: 'ME_1' });
  assert.equal(keyIntent('ME_3', ctx).destination, 'S4', 'S3 is not in service, so it is skipped');
  const shifted = ctxWith({ view: { ...initialView(), shift: true } });
  assert.equal(keyIntent('ME_1', shifted).destination, 'S6');
  assert.equal(keyIntent('ME_3', shifted).kind, 'none', 'no eighth screen');
  const holding = ctxWith({ view: { ...initialView(), held: new Set(['ME_1']) } });
  assert.deepEqual(keyIntent('ME_2', holding), { kind: 'select', destination: 'S2', key: 'ME_2' });
  const both = ctxWith({ select: ['S1', 'S2'], view: { ...initialView(), held: new Set(['ME_1']) } });
  assert.equal(keyIntent('ME_2', both).kind, 'unselect');

  const sel = ctxWith({ select: ['S1', 'S2'] }).selection;
  selectOnly(sel, 'S4');
  assert.deepEqual(sel.list, ['S4']);
});

test('layer keys walk the active screen’s fitted layers, SHIFT the next five', () => {
  assert.deepEqual(keyIntent('NEXT_BKGD', ctxWith()), { kind: 'selectLayer', layer: 1, key: 'NEXT_BKGD' });
  assert.equal(keyIntent('NEXT_KEY4', ctxWith()).layer, 5);
  assert.equal(keyIntent('NEXT_BKGD', ctxWith({ view: { ...initialView(), shift: true } })).layer, 6);
  assert.equal(keyIntent('NEXT_KEY1', ctxWith({ select: ['S2'] })).kind, 'none', 'S2 has one layer');
  assert.match(keyIntent('NEXT_BKGD', ctxWith({ select: [] })).why, /select a screen/);
});

test('the buses: preview n is input n in preview, SHIFT n + 10; the program row is tally until the tick', () => {
  assert.deepEqual(keyIntent('PVW_2', ctxWith()), {
    kind: 'source', input: 2, sourceKind: 'LIVE', buffer: 'PREVIEW', label: '', key: 'PVW_2',
  });
  assert.match(keyIntent('PVW_4', ctxWith()).why, /input 4 is not in use/, 'key n is input n, not the nth input');
  assert.equal(keyIntent('PVW_2', ctxWith({ view: { ...initialView(), shift: true } })).input, 12);

  const refused = keyIntent('PGM_1', ctxWith());
  assert.equal(refused.kind, 'none');
  assert.match(refused.why, /tally only/);
  const live = keyIntent('PGM_1', ctxWith({ hotCut: true }));
  assert.equal(live.buffer, 'PROGRAM');
  assert.equal(live.input, 1);

  const stills = ctxWith({ view: { ...initialView(), busKind: 'STILL' } });
  assert.deepEqual([keyIntent('PVW_1', stills).sourceKind, keyIntent('PVW_1', stills).input], ['STILL', 1]);
  assert.deepEqual(keyIntent('KEY2_ON_AIR', ctxWith()), { kind: 'busKind', sourceKind: 'STILL', key: 'KEY2_ON_AIR' });
  assert.match(keyIntent('KEY3_ON_AIR', ctxWith()).why, /no screens/, 'no screens-as-sources on this switcher');
});

test('MACRO turns the preview row into memories by slot; an unnamed slot still recalls unless it is free', () => {
  const macro = ctxWith({ view: { ...initialView(), macro: true } });
  assert.deepEqual(keyIntent('PVW_1', macro), { kind: 'recall', slot: 1, label: 'Opener', key: 'PVW_1' });
  assert.match(keyIntent('PVW_2', macro).why, /no memory in slot 2/);
  assert.equal(keyIntent('PVW_4', macro).kind, 'recall', 'slot 4 is not named, and not free');
  assert.equal(keyIntent('PVW_3', { ...macro, view: { ...macro.view, shift: true } }).slot, 13);
  assert.match(keyIntent('PGM_1', macro).why, /MACRO is on/);
});

test('function keys, and every key without a job says why', () => {
  const ctx = ctxWith();
  assert.equal(keyIntent('CUT', ctx).kind, 'cut');
  assert.equal(keyIntent('AUTO', ctx).kind, 'take');
  assert.equal(keyIntent('DSK1_CUT', ctx).kind, 'freeze');
  assert.equal(keyIntent('DSK1_AUTO', ctx).kind, 'matchProgram');
  assert.equal(keyIntent('DSK2_AUTO', ctx).kind, 'ftb');
  for (const name of Object.keys(UNMAPPED)) {
    const i = keyIntent(name, ctx);
    assert.equal(i.kind, 'none');
    assert.ok(i.why.length > 10, `${name} says why`);
  }
  for (const k of P.KEYS) assert.ok(keyIntent(k.name, ctx).kind, `${k.name} answers something`);
});

test('the panel drawn: chosen yellow, available blue, red on air and green in preview, cyan while held', () => {
  const ctx = ctxWith();
  ctx.selection.layer = 2;
  const tally = { layer: 2, program: { kind: 'LIVE', number: 1 }, preview: { kind: 'LIVE', number: 3 } };
  const { colours, meter } = paint({ ...ctx, tally });
  assert.equal(colours.get('ME_1'), COLOUR.YELLOW);
  assert.equal(colours.get('ME_2'), COLOUR.BLUE);
  assert.equal(colours.get('ME_4'), COLOUR.BLUE, 'S5, fourth in service');
  assert.equal(colours.get('NEXT_KEY1'), COLOUR.YELLOW, 'layer 2');
  assert.equal(colours.get('NEXT_BKGD'), COLOUR.BLUE);
  assert.equal(colours.get('PGM_1'), COLOUR.RED);
  assert.equal(colours.get('PVW_3'), COLOUR.GREEN);
  assert.equal(colours.get('PVW_1'), COLOUR.OFF);
  assert.equal(colours.get('KEY1_ON_AIR'), COLOUR.YELLOW);
  assert.equal(colours.get('KEY2_ON_AIR'), COLOUR.BLUE);
  assert.equal(colours.get('KEY3_ON_AIR'), COLOUR.OFF, 'nothing to hold');
  assert.equal(colours.get('CUT'), COLOUR.WHITE);
  assert.equal(colours.get('MIX'), COLOUR.OFF, 'a key with no job is dark');
  assert.equal(meter.filter(Boolean).length, 0);

  assert.equal(paint({ ...ctx, tally: { ...tally, layer: 1 } }).colours.get('PGM_1'), COLOUR.OFF, 'tally of another layer is not shown');

  const s2 = ctxWith({ select: ['S2'] });
  const lit = paint({ ...s2, stroke: 0.5 }).colours;
  assert.equal(lit.get('DSK1_CUT'), COLOUR.RED, 'frozen');
  assert.equal(lit.get('DSK2_AUTO'), COLOUR.RED, 'faded');
  assert.equal(lit.get('AUTO'), COLOUR.RED, 'mid-stroke');
  assert.equal(paint({ ...s2, stroke: 0.5 }).meter.filter(Boolean).length, 8);

  const held = paint({ ...ctxWith({ view: { ...initialView(), held: new Set(['CUT', 'SHIFT']), shift: true } }) }).colours;
  assert.equal(held.get('CUT'), COLOUR.CYAN);
  assert.equal(held.get('SHIFT'), COLOUR.YELLOW, 'SHIFT shows that it is held, not that it was pressed');

  const macro = paint({ ...ctxWith({ view: { ...initialView(), macro: true } }), tally }).colours;
  assert.equal(macro.get('PVW_1'), COLOUR.BLUE, 'a memory there');
  assert.equal(macro.get('PVW_2'), COLOUR.OFF, 'free');
  assert.equal(macro.get('PGM_1'), COLOUR.OFF, 'no tally under MACRO');
  assert.equal(macro.get('MACRO'), COLOUR.YELLOW);
});

test('a source read back is the one written, on both platforms; a stroke counts from where the lever rested', () => {
  assert.deepEqual(readSource('LIVE_3'), { kind: 'LIVE', number: 3 });
  assert.deepEqual(readSource('STILL_12'), { kind: 'STILL', number: 12 });
  assert.deepEqual(readSource('SCREEN_2'), { kind: 'SCREEN', number: 2 });
  assert.deepEqual(readSource('INPUT_4'), { kind: 'LIVE', number: 4 });
  assert.equal(readSource('NONE'), null);
  assert.equal(readSource(null), null);
  assert.equal(strokeProgress(0, 0.3), 0.3);
  assert.equal(strokeProgress(1, 0.3), 0.7);
});

/* ------------------------------------------------------------ supervisor */

/** A LivePremier with S1 in service: preview is A, program B, two layers. */
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
    async write(reports) { let n = 0; for (const r of reports) if (await driver.write(Uint8Array.from(r))) n++; return n; },
    on(ev, fn) { events.on(ev, fn); return () => events.off(ev, fn); },
  };
  return { module: () => handle, status: () => ({ installed: true, running: true, reason: null }) };
}

test('the supervisor end to end: tally lit, a preview pick, the program row refused then live, a recall, a take, a cut, FTB and a T-bar throw', async () => {
  const awj = await fakeAwj(lpStore());
  const panel = new FakeMicroPanel();
  const driver = new AtemMicroPanelDriver({ hid: fakeHid([panel]), scanMs: 10, retryMs: 10 });
  driver.start();
  const devices = devicesWith(driver);
  const sup = new AtemMicroPanelSupervisor({ deviceHost: () => '127.0.0.1', awjPort: awj.port, devices: () => devices });
  const writes = () => awj.writes();
  try {
    await sup.apply(normaliseAtemMicro({ atemMicroEnabled: true }));
    assert.ok(await until(() => panel.lamps && panel.colourOf('ME_1') === COLOUR.YELLOW), 'S1 driven, as M/E 1 always is');
    assert.ok(await until(() => panel.colourOf('PGM_1') === COLOUR.RED && panel.colourOf('PVW_2') === COLOUR.GREEN), 'tally from the switcher');
    assert.equal(panel.colourOf('NEXT_BKGD'), COLOUR.YELLOW, 'layer 1');
    assert.equal(panel.colourOf('NEXT_KEY1'), COLOUR.BLUE, 'layer 2 fitted');
    assert.equal(panel.colourOf('NEXT_KEY2'), COLOUR.OFF, 'no layer 3');

    awj.clear();
    panel.tap('PVW_3');
    assert.ok(await until(() => writes().length));
    assert.deepEqual(writes()[0], { path: toAwj(NLC.layerParamPath('S1', 'A', 1, layerSourcePath(NLC))), value: 'LIVE_3' }, 'the preview letter’s layer 1');
    assert.ok(await until(() => panel.colourOf('PVW_3') === COLOUR.GREEN), 'tally read again after the press');

    awj.clear();
    panel.tap('PGM_3');
    assert.ok(await until(() => sup.history.some((e) => e.key === 'PGM_3' && /tally only/.test(e.note || ''))));
    assert.equal(writes().length, 0, 'nothing to air without the tick');
    sup.setHotCut(true);
    panel.tap('PGM_3');
    assert.ok(await until(() => writes().length));
    assert.deepEqual(writes()[0], { path: toAwj(NLC.layerParamPath('S1', 'B', 1, layerSourcePath(NLC))), value: 'LIVE_3' }, 'the program letter, on air');
    sup.setHotCut(false);

    awj.clear();
    panel.tap('MACRO');
    assert.ok(await until(() => panel.colourOf('MACRO') === COLOUR.YELLOW && panel.colourOf('PVW_1') === COLOUR.BLUE));
    panel.tap('PVW_1');
    assert.ok(await until(() => writes().length));
    assert.match(writes()[0].path, /\$slot\/@items\/1\/\$screen\/@items\/S1\/\$preset\/@items\/PREVIEW\/@props\/xRequest$/, 'to preview, always');
    panel.tap('MACRO');

    awj.clear();
    panel.tap('AUTO');
    assert.ok(await until(() => writes().length));
    assert.deepEqual(writes(), [{ path: toAwj(NLC.takeControl('S1', 'xTake')), value: true }]);

    awj.clear();
    panel.tap('CUT');
    assert.ok(await until(() => writes().length));
    assert.deepEqual(writes(), [{ path: toAwj(NLC.takeControl('S1', 'xCut')), value: true }]);

    awj.clear();
    panel.tap('DSK2_AUTO');
    assert.ok(await until(() => writes().length));
    assert.deepEqual(writes(), [{ path: toAwj(NLC.fadeToBlackPath('S1')), value: true }]);
    assert.ok(await until(() => panel.colourOf('DSK2_AUTO') === COLOUR.RED), 'read again: faded');

    awj.clear();
    panel.setTbar(0);                    // where the lever rests: not a stroke
    await settle(30);
    assert.equal(writes().length, 0);
    panel.setTbar(2048);
    assert.ok(await until(() => writes().some((x) => x.path.endsWith('tbarPosition'))));
    assert.ok(await until(() => panel.colourOf('AUTO') === COLOUR.RED && panel.meterLit() === 8), 'mid-stroke: AUTO red, the meter half lit');
    panel.setTbar(4096);
    assert.ok(await until(() => writes().some((x) => x.path.endsWith('tbarPosition') && x.value === 65535)), 'the throw completes the take');
    assert.ok(sup.history.some((e) => /T-bar take on S1/.test(e.note || '')));

    panel.tap('MIX');
    assert.ok(await until(() => sup.history.some((e) => e.key === 'MIX')), 'an unmapped key says why');

    sup.setHotCut(true);
    await sup.apply(normaliseAtemMicro({ atemMicroEnabled: false }));
    assert.equal(sup.hotCut, false, 'the tick is forgotten when the panel is switched off');
    assert.ok(panel.dark(), 'left dark');
    assert.equal(panel.closed, true, 'and let go');
    assert.throws(() => sup.setHotCut(true), /switch the panel on first/);
  } finally {
    await sup.stop();
    await driver.stop();
    await awj.close();
  }
});
