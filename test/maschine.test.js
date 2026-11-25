/*
 * The Maschine MK3: its bytes, the driver against a pretend panel, the host
 * handing it libusb, what every control means, the lamps and screens, and
 * the supervisor end to end against a pretend switcher.
 *
 * ⚠️ Nothing here has met a real panel. The pretend one is what OpenAV
 * Ctlra's MK3 driver says the panel is (`helpers/fake-maschine.js`); a pass
 * is evidence that this agrees with it, not with the hardware.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import * as P from '../src/core/maschine-mk3.js';
import { MaschineMk3Driver, maschinesIn } from '../devices/modules/maschine-mk3/driver.js';
import maschineModule from '../devices/modules/maschine-mk3/module.js';
import { createHostCore } from '../devices/core.js';
import { createDeviceHost } from '../server/device-host.js';
import { FakeMaschine, fakeMaschineHid, fakeUsb } from './helpers/fake-maschine.js';
import { fakeAwj } from './helpers/fake-awj.js';
import {
  DEFAULT_MASCHINE, normaliseMaschine, maschineChanged, initialView, buttonIntent, padIntent, encoderIntent,
  paint, screens, stripLights, knobSpec, knobValue, knobText, knobWrites, PAD_KINDS,
} from '../plugins/maschine/core.js';
import { MaschineSupervisor, PICKUP } from '../plugins/maschine/supervisor.js';
import { Selection, layerSourcePath } from '../src/core/console-intents.js';
import { NLC, MNG } from '../src/core/dialect.js';
import { toAwj } from '../src/core/paths.js';
import { labelPath, slotValidPath } from '../server/console-switcher.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await settle(5); }
  return false;
}
const { HUE } = P;

/* ------------------------------------------------------------------ bytes */

test('the button table: every bit and every lamp once, the lamps inside report 0x80, the knob touches backwards', () => {
  const bits = P.BUTTONS.map((b) => b.bit);
  assert.equal(new Set(bits).size, bits.length, 'no bit twice');
  assert.ok(bits.every((b) => b >= 0 && b < 80));
  const leds = P.BUTTONS.filter((b) => b.led !== null).map((b) => b.led);
  assert.equal(new Set(leds).size, leds.length, 'no lamp twice');
  assert.ok(leds.every((l) => l >= 0 && l < P.LEDS_BANK0), 'every button lamp is in report 0x80');
  assert.equal(new Set(P.BUTTONS.map((b) => b.name)).size, P.BUTTONS.length);
  assert.equal(P.BUTTON.get('knob-touch-1').bit, 79);
  assert.equal(P.BUTTON.get('knob-touch-8').bit, 72);
  assert.deepEqual(P.BUTTONS.filter((b) => b.colour).map((b) => b.name).sort(), [
    'encoder-down', 'encoder-left', 'encoder-right', 'encoder-up',
    ...'abcdefgh'.split('').map((g) => `group-${g}`), 'sampling',
  ].sort());
  assert.equal(P.STRIP_LED_BASE + P.STRIP_LEDS, P.PAD_LED_BASE);
  assert.equal(P.PAD_LED_BASE + P.PADS, P.LED_COUNT);
});

test('controls: the first report only records; then presses, knobs and the encoder across their wrap, and the strip', () => {
  const d = new P.Mk3Decoder();
  assert.deepEqual(d.decode(P.buildControls({ knobs: [998, 0, 0, 0, 0, 0, 0, 0], encoder: 15 })), [], 'the first only records');
  assert.deepEqual(d.decode(P.buildControls({ pressed: ['play'], knobs: [1, 0, 0, 0, 0, 0, 0, 0], encoder: 0, strip: 512 })), [
    { type: 'button', name: 'play', pressed: true },
    { type: 'knob', index: 0, delta: 3 },
    { type: 'encoder', delta: 1 },
    { type: 'strip', value: 0.5 },
  ]);
  assert.deepEqual(d.decode(P.buildControls({ knobs: [1, 0, 0, 0, 0, 0, 0, 990], encoder: 0 })), [
    { type: 'button', name: 'play', pressed: false },
    { type: 'knob', index: 7, delta: -10 },
    { type: 'strip', value: null },
  ]);
  assert.equal(P.wrapDelta(2, 998, 1000), 4);
  assert.equal(P.wrapDelta(14, 1, 16), -3);
  assert.equal(P.parseControls(Uint8Array.from([1, 2, 3])), null, 'short');
});

test('pads: a press and its note on are one hit, the release one more; pad 1 is the bottom left', () => {
  assert.equal(P.padNumber(12), 1);
  assert.equal(P.padNumber(15), 4);
  assert.equal(P.padNumber(0), 13);
  assert.equal(P.padNumber(3), 16);
  for (let n = 1; n <= 16; n++) assert.equal(P.padNumber(P.padIndex(n)), n);

  const d = new P.Mk3Decoder();
  const pad = P.padIndex(6);
  assert.deepEqual(d.decode(P.buildPads([{ pad, event: 'press', pressure: 300 }, { pad, event: 'note-on', pressure: 900 }])),
    [{ type: 'pad', index: pad, number: 6, pressed: true, pressure: 300 }]);
  assert.deepEqual(d.decode(P.buildPads([{ pad, event: 'aftertouch', pressure: 2000 }])), [], 'pressure alone is not a hit');
  assert.deepEqual(d.decode(P.buildPads([{ pad, event: 'press-off', pressure: 0 }, { pad, event: 'note-off', pressure: 0 }])),
    [{ type: 'pad', index: pad, number: 6, pressed: false, pressure: 0 }]);
  assert.deepEqual(P.parsePads(P.buildPads([{ pad: 0, event: 'press', pressure: 0x123 }])), [{ pad: 0, event: 'press', pressure: 0x123 }]);
});

test('lamps: a colour slot is palette and level, a mono slot a brightness; the pads and strip in report 0x81', () => {
  assert.equal(P.colourLed(HUE.RED, 3), (1 << 2) | 3);
  assert.equal(P.colourLed(HUE.WHITE, 0), 0);
  assert.equal(P.paletteOf([255, 0, 0]), HUE.RED);
  assert.equal(P.paletteOf([0, 255, 0]), HUE.GREEN);
  assert.equal(P.paletteOf([0, 0, 255]), HUE.BLUE);
  assert.equal(P.paletteOf([255, 255, 0]), HUE.YELLOW);
  assert.equal(P.paletteOf([0, 255, 255]), HUE.CYAN);
  assert.equal(P.paletteOf([128, 128, 128]), HUE.WHITE);
  assert.equal(P.paletteOf([0, 0, 0]), null);

  const slots = P.ledSlots({
    buttons: new Map([['group-a', { hue: HUE.YELLOW, level: 3 }], ['play', { hue: HUE.GREEN, level: 2 }], ['pedal', { level: 3 }]]),
    pads: Object.assign(new Array(16).fill(null), { [P.padIndex(1)]: { hue: HUE.RED, level: 3 } }),
    strip: [{ hue: HUE.WHITE, level: 1 }],
  });
  assert.equal(slots[P.BUTTON.get('group-a').led], P.colourLed(HUE.YELLOW, 3));
  assert.equal(slots[P.BUTTON.get('play').led], P.MONO_LEVELS[2], 'PLAY is mono: only the level counts');
  assert.equal(slots[P.PAD_LED_BASE + 12], P.colourLed(HUE.RED, 3), 'pad 1 is index 12');
  assert.equal(slots[P.STRIP_LED_BASE], P.colourLed(HUE.WHITE, 1));
  assert.equal(slots.filter(Boolean).length, 4, 'a button with no lamp lights nothing');

  const [a, b] = P.ledReports(slots);
  assert.equal(a.length, 63);
  assert.equal(b.length, 42);
  assert.equal(a[0], 0x80);
  assert.equal(b[0], 0x81);
  assert.equal(b[1 + (P.PAD_LED_BASE + 12 - P.LEDS_BANK0)], P.colourLed(HUE.RED, 3));
  assert.deepEqual([...P.slotsOf(a, b)], [...slots]);
  assert.ok(P.darkReports().every((r) => r.slice(1).every((x) => x === 0)));
});

test('screens: a packet reads back to the pixels it was cut from, and only changed rows are dirty', () => {
  const px = new Uint16Array(P.SCREEN_W * P.SCREEN_H);
  for (let i = 0; i < px.length; i++) px[i] = i & 0xffff;
  const packet = P.screenPacket(1, px, { x: 0, y: 10, w: P.SCREEN_W, h: 4 });
  assert.deepEqual([...packet.slice(0, 8)], [0x84, 0, 1, 0x60, 0, 0, 0, 0]);
  assert.equal(packet.length, 16 + 4 + P.SCREEN_W * 4 * 2 + 8);
  const back = P.readScreenPacket(packet);
  assert.equal(back.screen, 1);
  assert.deepEqual(back.rect, { x: 0, y: 10, w: P.SCREEN_W, h: 4 });
  const out = back.apply(new Uint16Array(px.length));
  assert.equal(out[10 * P.SCREEN_W + 5], px[10 * P.SCREEN_W + 5]);
  assert.equal(out[9 * P.SCREEN_W + 5], 0, 'outside the rect untouched');
  assert.equal(P.screenPacket(0, px).length, 16 + 4 + P.SCREEN_W * P.SCREEN_H * 2 + 8, 'a whole screen is one data command');

  const next = px.slice();
  assert.equal(P.dirtyRows(next, px), null);
  next[50 * P.SCREEN_W + 3] = 1;
  next[60 * P.SCREEN_W] = 1;
  assert.deepEqual(P.dirtyRows(next, px), [50, 61]);
  assert.deepEqual(P.dirtyRows(next, null), [0, P.SCREEN_H]);
  assert.deepEqual([...P.toRgb565(Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255]))], [0xf800, 0x07e0]);
  assert.throws(() => P.screenPacket(2, px), /screen is 0 or 1/);
});

/* ------------------------------------------------------------------ driver */

test('the driver: looked for until wanted, opened shared, screens claimed; reports out, lamps and screens in', async () => {
  const panel = new FakeMaschine();
  const usb = fakeUsb(panel);
  const driver = new MaschineMk3Driver({ hid: fakeMaschineHid([panel]), usb, scanMs: 10 });
  const reports = [];
  driver.on('report', (b) => reports.push([...b]));
  driver.start();
  try {
    assert.ok(await until(() => driver.state.present), 'found');
    assert.equal(panel.open, false, 'not opened until wanted');
    await driver.want(true);
    assert.ok(await until(() => driver.state.connected && driver.state.screens));
    assert.equal(usb.claims, 1);
    panel.tap('play');
    panel.tapPad(3);
    assert.ok(await until(() => reports.length >= 5), 'controls and pads reports come back');
    assert.ok(reports.every((r) => r[0] === 0x01 || r[0] === 0x02));

    const [a, b] = P.ledReports(P.ledSlots({ buttons: new Map([['group-a', { hue: HUE.BLUE, level: 1 }]]) }));
    assert.equal(await driver.write(a), true);
    assert.equal(await driver.write(b), true);
    assert.deepEqual(panel.colourOf('group-a'), { hue: HUE.BLUE, level: 1 });
    await assert.rejects(driver.write(Uint8Array.from([0x01, 0])), /only the LED reports/);

    const scene = { background: [0, 0, 0], ops: [{ op: 'fill', rect: { x: 0, y: 100, w: 480, h: 20 }, rgb: [255, 0, 0] }] };
    assert.deepEqual(await driver.command({ op: 'screens', scenes: [scene, null] }), { screens: true, drawn: 1 });
    assert.ok(await until(() => panel.packets.length === 1));
    assert.deepEqual(panel.packets[0].rect, { x: 0, y: 0, w: 480, h: 272 }, 'the first frame goes whole');
    assert.deepEqual(panel.pixel(0, 10, 110), [255, 0, 0]);
    assert.deepEqual(panel.pixel(0, 10, 90), [0, 0, 0]);
    const moved = { background: [0, 0, 0], ops: [{ op: 'fill', rect: { x: 0, y: 104, w: 480, h: 20 }, rgb: [255, 0, 0] }] };
    await driver.command({ op: 'screens', scenes: [moved] });
    assert.ok(await until(() => panel.packets.length === 2));
    assert.deepEqual(panel.packets[1].rect, { x: 0, y: 100, w: 480, h: 24 }, 'then only the rows that changed');
    await driver.command({ op: 'screens', scenes: [moved] });
    await settle(20);
    assert.equal(panel.packets.length, 2, 'nothing changed, nothing sent');
    await assert.rejects(driver.command({ op: 'nope' }), /unknown command/);

    await driver.want(false);
    assert.equal(panel.closed, true, 'let go when nobody wants it');
    assert.equal(usb.released, 1, 'and the screens with it');
    assert.equal(await driver.write(a), false, 'refused while closed');
  } finally {
    await driver.stop();
  }
});

test('the driver without screens: no libusb, or a claim refused, still leaves keys and lamps, and says why', async () => {
  const panel = new FakeMaschine();
  const bare = new MaschineMk3Driver({ hid: fakeMaschineHid([panel]), usb: null, usbReason: 'usb is not installed in devices/', scanMs: 10 });
  bare.start();
  try {
    await bare.want(true);
    assert.ok(await until(() => bare.state.connected));
    assert.equal(bare.state.screens, false);
    assert.match(bare.state.screenError, /usb is not installed/);
    assert.deepEqual(await bare.command({ op: 'screens', scenes: [{ ops: [] }] }), { screens: false, drawn: 0 });
    assert.equal(await bare.write(P.darkReports()[0]), true);
  } finally {
    await bare.stop();
  }

  const held = new FakeMaschine();
  const refused = new MaschineMk3Driver({ hid: fakeMaschineHid([held]), usb: fakeUsb(held, { refuse: true }), scanMs: 10 });
  refused.start();
  try {
    await refused.want(true);
    assert.ok(await until(() => refused.state.connected));
    assert.equal(refused.state.screens, false);
    assert.match(refused.state.screenError, /NIHostIntegrationAgent/);
  } finally {
    await refused.stop();
  }

  assert.deepEqual(maschinesIn([
    { vendorId: P.VENDOR_ID, productId: P.PRODUCT_ID, path: 'b', interface: 0 },
    { vendorId: P.VENDOR_ID, productId: P.PRODUCT_ID, path: 'a', interface: 4 },
    { vendorId: 0x05f3, productId: 1, path: 'x' },
  ]).map((d) => d.path), ['a', 'b'], 'interface 4 first, anything else left out');
});

test('the host hands the module libusb, or why there is none, and passes its lamps and screens through', async () => {
  const sent = [];
  const panel = new FakeMaschine();
  const core = createHostCore({ hid: fakeMaschineHid([panel]), usb: fakeUsb(panel), modules: [maschineModule], send: (m) => sent.push(m) });
  try {
    assert.deepEqual(sent[0].modules.map((m) => [m.id, m.transport, m.available]), [['maschine-mk3', 'hid', true]]);
    await core.handle({ op: 'want', id: 1, module: 'maschine-mk3', wanted: true });
    assert.ok(await until(() => core.drivers.get('maschine-mk3').state.screens));
    await core.handle({ op: 'write', id: 2, module: 'maschine-mk3', reports: P.darkReports().map((r) => [...r]) });
    assert.ok(sent.some((m) => m.type === 'reply' && m.id === 2 && m.ok && m.result === 2), 'both reports fit the host’s 64 bytes');
    await core.handle({ op: 'command', id: 3, module: 'maschine-mk3', command: { op: 'screens', scenes: screens(ctxWith()) } });
    assert.ok(sent.some((m) => m.type === 'reply' && m.id === 3 && m.ok && m.result.screens), 'a scene fits a command');
    assert.ok(JSON.stringify({ op: 'screens', scenes: screens(ctxWith()) }).length < 16 * 1024, 'with room to spare');
  } finally {
    await core.stop();
  }

  const without = [];
  const bare = createHostCore({ hid: fakeMaschineHid([new FakeMaschine()]), usbReason: 'usb is not installed', modules: [maschineModule], send: (m) => without.push(m) });
  try {
    await bare.handle({ op: 'want', id: 1, module: 'maschine-mk3', wanted: true });
    assert.ok(await until(() => bare.drivers.get('maschine-mk3').state.connected));
    assert.match(bare.drivers.get('maschine-mk3').state.screenError, /usb is not installed/);
  } finally {
    await bare.stop();
  }
});

test('the real host process, forked with a pretend panel and pretend libusb: PLAY crosses the channel, lamps and screens go in', async () => {
  const host = createDeviceHost({
    entry: join(ROOT, 'devices/host.js'),
    args: ['--hid', join(here, 'helpers/fake-maschine-hid-module.mjs'), '--usb', join(here, 'helpers/fake-maschine-usb-module.mjs')],
  });
  const mk3 = host.api.module('maschine-mk3');
  const presses = [];
  const decoder = new P.Mk3Decoder();
  mk3.on('report', (b) => presses.push(...decoder.decode(Uint8Array.from(b)).filter((e) => e.type === 'button')));
  host.start();
  try {
    assert.ok(await until(() => mk3.available, 5000), `no hello: ${JSON.stringify(host.api.status())}`);
    await mk3.want(true);
    assert.ok(await until(() => mk3.state?.connected && mk3.state.screens, 5000), `not held with screens: ${JSON.stringify(mk3.state)}`);
    assert.ok(await until(() => presses.some((e) => e.name === 'play' && e.pressed), 5000), 'PLAY came back');
    assert.equal(await mk3.write(P.darkReports().map((r) => [...r])), 2);
    assert.deepEqual(await mk3.command({ op: 'screens', scenes: screens(ctxWith()) }), { screens: true, drawn: 2 });
  } finally {
    await host.stop();
  }
});

/* --------------------------------------------------------------- meaning */

const FACTS = {
  dialect: NLC,
  destinations: [
    { id: 'S1', kind: 'screen', label: 'LED', isUsed: true, faded: false, frozen: false },
    { id: 'S2', kind: 'screen', label: 'IMAG', isUsed: true, faded: true, frozen: true },
    { id: 'S3', kind: 'screen', label: '', isUsed: false },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `S${i + 4}`, kind: 'screen', label: '', isUsed: true })),
  ],
  sources: {
    LIVE: [1, 2, 3, 18].map((n) => ({ number: n, source: `LIVE_${n}`, label: n === 1 ? 'CAM 1' : '' })),
    STILL: [{ number: 1, source: 'STILL_1', label: 'Logo' }],
    SCREEN: [],
  },
  presets: [{ slot: 1, label: 'Opener' }, { slot: 17, label: 'Walk-in' }],
  freeSlots: [2, 3],
  layers: [1, 2, 3].map((key) => ({ destination: 'S1', key })).concat([{ destination: 'S2', key: 1 }]),
};

function ctxWith({ select = ['S1'], view = initialView(), layer = 1 } = {}) {
  const selection = new Selection();
  selection.restrict(FACTS.destinations.filter((d) => d.isUsed).map((d) => d.id));
  for (const d of select) selection.apply({ kind: 'select', destination: d });
  selection.layer = layer;
  return { view, facts: FACTS, selection };
}

test('settings: off by default, only a real true turns it on, and only that counts as a change', () => {
  assert.deepEqual(normaliseMaschine(undefined), DEFAULT_MASCHINE);
  assert.deepEqual(normaliseMaschine({ maschineEnabled: 'yes' }), { maschineEnabled: false });
  assert.deepEqual(normaliseMaschine({ maschineEnabled: true, other: 1 }), { maschineEnabled: true });
  assert.equal(maschineChanged({ maschineEnabled: false }, { maschineEnabled: true }), true);
  assert.equal(maschineChanged({ maschineEnabled: true }, { maschineEnabled: true }), false);
});

test('group keys pick the screens in service, SHIFT the next eight; another group key held builds a selection', () => {
  assert.deepEqual(buttonIntent('group-a', ctxWith()), { kind: 'selectOnly', destination: 'S1', key: 'group-a' });
  assert.deepEqual(buttonIntent('group-c', ctxWith()), { kind: 'selectOnly', destination: 'S4', key: 'group-c' }, 'S3 is not in service');
  const shifted = { ...initialView(), shift: true };
  assert.deepEqual(buttonIntent('group-a', ctxWith({ view: shifted })), { kind: 'selectOnly', destination: 'S10', key: 'group-a' });
  assert.equal(buttonIntent('group-h', ctxWith({ view: shifted })).kind, 'none', 'nothing on the sixteenth');
  const holding = { ...initialView(), held: new Set(['group-a']) };
  assert.deepEqual(buttonIntent('group-b', ctxWith({ view: holding })), { kind: 'select', destination: 'S2', key: 'group-b' });
  assert.deepEqual(buttonIntent('group-b', ctxWith({ view: holding, select: ['S1', 'S2'] })), { kind: 'unselect', destination: 'S2', key: 'group-b' });
});

test('pads: pad n is source n in preview, SHIFT n + 16; memories by slot; a gap says why', () => {
  assert.deepEqual(padIntent(3, ctxWith()), { kind: 'source', input: 3, sourceKind: 'LIVE', buffer: 'PREVIEW', label: '', key: 'PAD 3' });
  assert.match(padIntent(4, ctxWith()).why, /input 4 is not in use/);
  assert.equal(padIntent(2, ctxWith({ view: { ...initialView(), shift: true } })).input, 18);
  const memories = { ...initialView(), padKind: 'MEMORY' };
  assert.deepEqual(padIntent(1, ctxWith({ view: memories })), { kind: 'recall', slot: 1, label: 'Opener', key: 'PAD 1' });
  assert.match(padIntent(2, ctxWith({ view: memories })).why, /no memory in slot 2/, 'a free slot');
  assert.equal(padIntent(4, ctxWith({ view: memories })).kind, 'recall', 'an unnamed slot that is not free still recalls');
  assert.equal(padIntent(1, ctxWith({ view: { ...memories, shift: true } })).slot, 17);
});

test('soft keys, transport and the encoder; every key without a job says why', () => {
  assert.deepEqual(buttonIntent('top-2', ctxWith()), { kind: 'padKind', padKind: 'STILL', key: 'top-2' });
  assert.match(buttonIntent('top-3', ctxWith()).why, /no screens to put on the pads/);
  assert.equal(buttonIntent('top-4', ctxWith()).padKind, 'MEMORY');
  assert.equal(buttonIntent('play', ctxWith()).kind, 'take');
  assert.equal(buttonIntent('restart', ctxWith()).kind, 'cut');
  assert.equal(buttonIntent('top-5', ctxWith()).kind, 'matchProgram');
  assert.equal(buttonIntent('top-6', ctxWith()).kind, 'freeze');
  assert.equal(buttonIntent('top-7', ctxWith()).kind, 'ftb');
  assert.match(buttonIntent('stop', ctxWith()).why, /STOP has no job/);
  assert.match(buttonIntent('duplicate', ctxWith()).why, /DUPLICATE has no job yet/);
  assert.equal(buttonIntent('knob-touch-3', ctxWith()).kind, 'touch');

  assert.deepEqual(encoderIntent(1, ctxWith()), { kind: 'selectLayer', layer: 2, key: 'encoder' });
  assert.deepEqual(encoderIntent(-1, ctxWith({ layer: 3 })), { kind: 'selectLayer', layer: 2, key: 'encoder' });
  assert.equal(encoderIntent(1, ctxWith({ layer: 3 })).quiet, true, 'the top layer stays, quietly');
  assert.deepEqual(buttonIntent('encoder-right', ctxWith()), { kind: 'selectLayer', layer: 2, key: 'encoder-right' });
  assert.match(encoderIntent(1, ctxWith({ select: [] })).why, /select a screen first/);
});

test('the knobs: opacity, position and size by the dialect’s own names, clamped, fine with SHIFT, written in preview', () => {
  const opacity = knobSpec(0, NLC);
  assert.deepEqual([opacity.param, opacity.min, opacity.max], ['opacity', 0, 256]);
  assert.deepEqual(knobSpec(3, NLC).tail, ['position', 'pp', 'sizeH']);
  assert.deepEqual(knobSpec(3, MNG).tail, ['size', 'pp', 'sizeH'], 'a Midra’s size is its own node');
  assert.equal(knobSpec(5, NLC), null, 'knob 6 has no job');

  assert.equal(knobValue(opacity, 128, 100), 128 + 25.6);
  assert.equal(knobValue(opacity, 250, 100), 256, 'clamped');
  assert.equal(knobValue(knobSpec(1, NLC), 960, -10, { fine: true }), 959);
  assert.equal(knobText(opacity, 192), '75%');
  assert.equal(knobText(knobSpec(1, NLC), 960.4), '960');
  assert.equal(knobText(opacity, undefined), '—');

  const writes = knobWrites({
    dialect: NLC, spec: opacity, layer: 2, values: new Map([['S1', 200.4], ['S2', 10]]),
    letterFor: (id) => (id === 'S1' ? 'A' : null),
  });
  assert.deepEqual(writes, [{ path: NLC.layerParamPath('S1', 'A', 2, ['opacity', 'pp', 'opacity']), value: 200 }], 'no letter, no write');
});

test('the lamps: chosen yellow, available blue, red on air and green in preview, cyan while held; the strip a dot or a stroke', () => {
  const tally = { layer: 1, program: { kind: 'LIVE', number: 1 }, preview: { kind: 'LIVE', number: 2 } };
  const view = { ...initialView(), held: new Set(['play']), pads: new Set([3]) };
  const { buttons, pads, strip } = paint({ ...ctxWith({ view }), tally });
  assert.deepEqual(buttons.get('group-a'), { hue: HUE.YELLOW, level: 3 });
  assert.deepEqual(buttons.get('group-b'), { hue: HUE.BLUE, level: 1 });
  assert.equal(buttons.get('top-1').level, 3, 'the pads hold inputs');
  assert.equal(buttons.get('top-2').level, 1);
  assert.equal(buttons.has('top-3'), false, 'no screens to hold');
  assert.equal(buttons.get('play').hue, HUE.CYAN, 'held');
  assert.deepEqual(pads[P.padIndex(1)], { hue: HUE.RED, level: 3 });
  assert.deepEqual(pads[P.padIndex(2)], { hue: HUE.GREEN, level: 3 });
  assert.deepEqual(pads[P.padIndex(3)], { hue: HUE.CYAN, level: 3 });
  assert.equal(pads[P.padIndex(4)], null, 'no input 4');
  assert.equal(strip.filter(Boolean).length, 1, 'the lever, as one dot');
  assert.ok(strip[0], 'at the left end');

  const other = paint({ ...ctxWith({ select: ['S2'] }), tally: { ...tally, layer: 2 } });
  assert.equal(other.buttons.get('top-7').level, 3, 'S2 is faded');
  assert.equal(other.pads[P.padIndex(1)].hue, HUE.WHITE, 'tally for another layer is not shown');

  const stroking = stripLights(0, { from: 0, at: 0.5, progress: 0.5 });
  assert.equal(stroking.filter(Boolean).length, 13);
  assert.ok(stroking.slice(0, 13).every((l) => l.hue === HUE.RED));
  assert.equal(stripLights(1, { from: 1, at: 0.75, progress: 0.25 }).filter(Boolean).length, 7, 'from the right end back');

  const memories = paint(ctxWith({ view: { ...initialView(), padKind: 'MEMORY' } }));
  assert.deepEqual(memories.pads[P.padIndex(1)], { hue: HUE.BLUE, level: 1 });
  assert.equal(memories.pads[P.padIndex(2)], null);
});

test('the screens: soft keys above, knobs below, the screen driven and its tally between', () => {
  const tally = { layer: 1, program: { kind: 'LIVE', number: 1 }, preview: { kind: 'LIVE', number: 2 } };
  const [left, right] = screens({
    ...ctxWith(), tally, params: new Map([['opacity', 256], ['posH', 960]]), editing: new Map([[2, 540]]),
    note: { text: 'input 4 is not in use', error: false },
  });
  const texts = (scene) => scene.ops.filter((o) => o.op === 'text').map((o) => o.text);
  assert.deepEqual(texts(left).slice(0, 4), ['INPUTS', 'STILLS', 'SCREENS', 'MEMORIES']);
  assert.ok(texts(left).includes('S1 LED'));
  assert.ok(texts(left).includes('LAYER 1 OF 3'));
  assert.ok(texts(left).includes('IN 1 CAM 1'), 'on air, by name');
  assert.ok(texts(left).includes('IN 2'));
  assert.ok(texts(left).includes('100%'), 'opacity as read');
  assert.ok(texts(left).includes('540'), 'POS Y while it is being turned');
  assert.deepEqual(texts(right).slice(0, 3), ['MATCH', 'FREEZE', 'FTB']);
  assert.ok(texts(right).includes('S1'));
  assert.ok(texts(right).includes('PADS: INPUTS 1-16'));
  assert.ok(texts(right).includes('input 4 is not in use'));
  assert.ok(texts(right).includes('HEIGHT'));
  assert.equal(PAD_KINDS.length, 4);

  const [none] = screens({ ...ctxWith(), facts: null, error: 'connect ECONNREFUSED' });
  assert.ok(texts(none).includes('NO SWITCHER'));
  assert.ok(texts(none).includes('connect ECONNREFUSED'));
  const [, struck] = screens({ ...ctxWith(), stroke: { from: 0, at: 0.4, progress: 0.4 } });
  assert.ok(texts(struck).includes('T-BAR 40%'));
});

/* ------------------------------------------------------------ supervisor */

const OPACITY = ['opacity', 'pp', 'opacity'];

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
  set(NLC.layerParamPath('S1', 'A', 1, OPACITY), 256);
  set(NLC.layerParamPath('S1', 'A', 1, ['position', 'pp', 'posH']), 960);
  ['CAM 1', 'CAM 2', 'PPT'].forEach((label, i) => {
    set(['device', 'inputList', 'items', `IN_${i + 1}`, 'status', 'pp', 'isAvailable'], true);
    set(['device', 'inputList', 'items', `IN_${i + 1}`, 'status', 'pp', 'isEnabled'], true);
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
    command: (c) => driver.command(JSON.parse(JSON.stringify(c))),
    on(ev, fn) { events.on(ev, fn); return () => events.off(ev, fn); },
  };
  return { module: () => handle, status: () => ({ installed: true, running: true, reason: null }) };
}

test('the supervisor end to end: tally on the pads and screens, a pick, a recall, a take, a cut, FTB, a knob and a strip throw', async () => {
  const awj = await fakeAwj(lpStore());
  const panel = new FakeMaschine();
  const driver = new MaschineMk3Driver({ hid: fakeMaschineHid([panel]), usb: fakeUsb(panel), scanMs: 10 });
  driver.start();
  const devices = devicesWith(driver);
  const sup = new MaschineSupervisor({ deviceHost: () => '127.0.0.1', awjPort: awj.port, devices: () => devices, editIdleMs: 60 });
  const writes = () => awj.writes();
  const ink = [255, 255, 255];
  try {
    await sup.apply(normaliseMaschine({ maschineEnabled: true }));
    assert.ok(await until(() => panel.colourOf('group-a')?.hue === HUE.YELLOW), 'S1 driven: a panel always drives something');
    assert.ok(await until(() => panel.pad(1)?.hue === HUE.RED && panel.pad(2)?.hue === HUE.GREEN), 'tally from the switcher');
    assert.equal(panel.pad(4), null, 'no input 4');
    assert.ok(await until(() => panel.lit(0) > 2000 && panel.lit(1) > 1000), 'both screens drawn');
    assert.ok(panel.count(0, { x: 8, y: 104, w: 72, h: 38 }, [230, 40, 40]) > 1000, 'the PGM tag, red, where core.js puts it');
    assert.ok(panel.count(0, { x: 0, y: 0, w: 120, h: 30 }, ink) > 1000, 'INPUTS chosen: a white key');
    assert.ok(panel.strip()[0], 'the lever at the left end');

    awj.clear();
    panel.tapPad(3);
    assert.ok(await until(() => writes().length));
    assert.deepEqual(writes()[0], { path: toAwj(NLC.layerParamPath('S1', 'A', 1, layerSourcePath(NLC))), value: 'LIVE_3' }, 'the preview letter’s layer 1');
    assert.ok(await until(() => panel.pad(3)?.hue === HUE.GREEN), 'tally read again after the hit');

    awj.clear();
    panel.tap('top-4');
    assert.ok(await until(() => panel.pad(1)?.hue === HUE.BLUE && panel.pad(2) === null), 'the pads hold memories');
    panel.tapPad(1);
    assert.ok(await until(() => writes().length));
    assert.match(writes()[0].path, /\$slot\/@items\/1\/\$screen\/@items\/S1\/\$preset\/@items\/PREVIEW\/@props\/xRequest$/, 'to preview, always');
    panel.tap('top-1');

    awj.clear();
    panel.tap('play');
    assert.ok(await until(() => writes().length));
    assert.deepEqual(writes(), [{ path: toAwj(NLC.takeControl('S1', 'xTake')), value: true }]);

    awj.clear();
    panel.tap('restart');
    assert.ok(await until(() => writes().length));
    assert.deepEqual(writes(), [{ path: toAwj(NLC.takeControl('S1', 'xCut')), value: true }]);

    awj.clear();
    panel.tap('top-7');
    assert.ok(await until(() => writes().length));
    assert.deepEqual(writes(), [{ path: toAwj(NLC.fadeToBlackPath('S1')), value: true }]);
    assert.ok(await until(() => panel.brightness('top-7') === P.MONO_LEVELS[3]), 'read again: faded');
    assert.ok(await until(() => panel.count(1, { x: 240, y: 0, w: 120, h: 30 }, [230, 40, 40]) > 1000), 'FTB red on the screen');

    /* A knob: read once, then each turn written in preview, and the screen follows. */
    awj.clear();
    panel.turn(0, -100);
    assert.ok(await until(() => writes().some((w) => w.path === toAwj(NLC.layerParamPath('S1', 'A', 1, OPACITY)))));
    assert.equal(writes().at(-1).value, Math.round(256 - 25.6));
    panel.turn(0, -1000 / 4 + 1);   // a big turn, inside the wrap's half
    assert.ok(await until(() => writes().at(-1).value === Math.round(256 - 25.6 - 249 * 0.256)));
    assert.ok(await until(() => sup.history.some((e) => e.key === 'KNOB 1' && /opacity \d+% on S1, layer 1, in preview/.test(e.note || ''))), 'said once the edit ends');

    /* The strip: refused away from the lever, a stroke from it, a take at the far end. */
    awj.clear();
    panel.touch(0.6);
    assert.ok(await until(() => sup.history.some((e) => e.key === 'STRIP' && /lit dot/.test(e.note || ''))));
    panel.touch(0.1);
    await settle(30);
    assert.equal(writes().length, 0, 'still the refused touch until it lifts');
    panel.touch(null);
    panel.touch(PICKUP / 2);
    panel.touch(0.5);
    assert.ok(await until(() => writes().some((x) => x.path.endsWith('tbarPosition'))));
    assert.ok(await until(() => panel.brightness('play') === P.MONO_LEVELS[3] && panel.strip().filter(Boolean).length > 10), 'mid-stroke: PLAY lit, the strip red');
    panel.touch(1);
    assert.ok(await until(() => writes().some((x) => x.path.endsWith('tbarPosition') && x.value === 65535)), 'the throw completes the take');
    assert.ok(sup.history.some((e) => /T-bar take on S1/.test(e.note || '')));
    const n = writes().length;
    panel.touch(0.97);
    await settle(30);
    assert.equal(writes().length, n, 'the touch that took is spent');
    panel.touch(null);
    assert.ok(await until(() => panel.strip()[24] && !panel.strip()[0]), 'the lever now at the right end');

    panel.tap('stop');
    assert.ok(await until(() => sup.history.some((e) => e.key === 'stop')), 'a key with no job says why');

    await sup.apply(normaliseMaschine({ maschineEnabled: false }));
    assert.ok(panel.dark(), 'left dark');
    assert.ok(await until(() => panel.lit(0) === 0 && panel.lit(1) === 0), 'both screens black');
    assert.equal(panel.closed, true, 'and let go');
  } finally {
    await sup.stop();
    await driver.stop();
    await awj.close();
  }
});
