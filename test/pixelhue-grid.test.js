/*
 * A U5 mini's key grid: what is drawn, what a press means, the 17100 link and
 * who holds it, and the whole panel end to end against the stand-in console.
 *
 * ⚠️ The stand-in's grid (`helpers/fake-mini-lcd.js`) behaves as the mini's
 * LCD app does in its firmware, read from its symbols — one client, the
 * localhost rules, drawing only on rows switched to Companion, `page` as the
 * row's page — and reads the wire with a codec of its own. None of it has been
 * under a thumb: these tests prove the app agrees with that reading of the
 * firmware, not with a console. Whether a mini reports TAKE and CUT at all is
 * unknown, so the stand-in is told each way in turn (`functionKeys`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { inflateSync } from 'node:zlib';

import {
  initialView, rowItems, pageCount, clampView, turnPage, pressIntent, pageMatches, wirePage, gridCells, renderKey,
  SCREENS, LAYERS, INPUTS, MEMORIES, PAGE_BACK, PAGE_ON, LONG_PRESS_MS,
} from '../plugins/pixelhue/grid.js';
import { GridLink, letGoNote } from '../plugins/pixelhue/grid-link.js';
import { PixelhueSupervisor } from '../plugins/pixelhue/supervisor.js';
import { normalisePixelhue, takeCutNote } from '../plugins/pixelhue/core.js';
import { Selection } from '../src/core/console-intents.js';
import { NLC } from '../src/core/dialect.js';
import { toAwj } from '../src/core/paths.js';
import { labelPath, slotValidPath } from '../server/console-switcher.js';
import { StandInConsole } from './helpers/fake-ucenter.js';
import { StandInLcd } from './helpers/fake-mini-lcd.js';
import { fakeAwj } from './helpers/fake-awj.js';
import { install as installDom } from './helpers/fake-dom.js';

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await settle(10);
  }
  return false;
}

/** A PNG back to RGBA rows (the encoder writes filter 0 on every row). */
function pixels(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const type = png[25];
  const parts = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * 4 + 1;
  return { width, height, type, at: (x, y) => [...raw.subarray(y * stride + 1 + x * 4, y * stride + 1 + x * 4 + 3)] };
}
/* A point between a key's label and its status line: always the key's fill. */
const fillOf = (png) => pixels(png).at(5, 56);
const AMBER = [232, 150, 20];
const GREY = [38, 38, 42];
const RED = [200, 24, 24];
const GREEN = [20, 150, 50];
const BLACK = [0, 0, 0];

const FACTS = {
  destinations: [
    { id: 'S1', kind: 'screen', label: 'LED 1', isUsed: true },
    { id: 'S2', kind: 'screen', label: '', isUsed: true },
    { id: 'S3', kind: 'screen', label: 'Spare', isUsed: false },
  ],
  layers: [
    { destination: 'S1', key: 2, label: 'Layer 2' },
    { destination: 'S1', key: 1, label: 'Layer 1' },
    { destination: 'S2', key: 1, label: 'Layer 1' },
  ],
  inputs: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, source: `LIVE_${i + 1}`, label: i === 4 ? '' : `CAM ${i + 1}` })),
  presets: Array.from({ length: 8 }, (_, i) => ({ slot: i + 1, label: `Look ${i + 1}` })),
  freeSlots: [9, 10],
};

const ctxWith = (picked = [], extra = {}) => {
  const selection = new Selection();
  selection.restrict(['S1', 'S2']);
  for (const id of picked) selection.apply({ kind: 'select', destination: id });
  return { facts: FACTS, selection, view: initialView(), sourceKind: 'LIVE', ...extra };
};

/* ================================================================ the grid */

test('the four rows are screens, the active screen\'s layers, inputs and memories', () => {
  const ctx = ctxWith(['S2', 'S1']);
  assert.deepEqual(rowItems(SCREENS, ctx).map((i) => i.id), ['S1', 'S2'], 'only screens in service');
  assert.equal(rowItems(SCREENS, ctx)[1].label, 'S2', 'an unnamed screen shows its id');
  assert.deepEqual(rowItems(LAYERS, ctx).map((i) => i.key), [1, 2], 'S1 is active: its layers, in order');
  assert.deepEqual(rowItems(LAYERS, ctxWith([])), [], 'no active screen, no layers');
  assert.equal(rowItems(INPUTS, ctx)[4].label, 'IN 5', 'an unnamed input by its number');
  assert.equal(rowItems(INPUTS, ctx)[4].number, 5);
  assert.deepEqual(rowItems(MEMORIES, ctx).map((i) => i.slot), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('rows page by eight, and the memory row keeps an empty key past its last memory', () => {
  const ctx = ctxWith();
  assert.equal(pageCount(INPUTS, ctx), 2, 'ten inputs');
  assert.equal(pageCount(SCREENS, ctx), 1);
  assert.equal(pageCount(MEMORIES, ctx), 2, 'eight memories fill a page; SAVE TO needs one more key');
  let view = turnPage(initialView(), INPUTS, 1, ctx);
  assert.equal(view.pages[INPUTS], 1);
  view = turnPage(view, INPUTS, 1, ctx);
  assert.equal(view.pages[INPUTS], 1, 'clamped at the last page, not wrapped');
  view = turnPage(view, INPUTS, -5, ctx);
  assert.equal(view.pages[INPUTS], 0);
  assert.equal(clampView({ ...initialView(), pages: [3, 0, 9, 0] }, ctx).pages.join(), '0,0,1,0', 'a row that shrank');
});

test('a screen key selects, makes a selected screen active, and drops it when held', () => {
  const none = ctxWith();
  assert.deepEqual(pressIntent(SCREENS, 0, none), { kind: 'select', destination: 'S1' });
  const two = ctxWith(['S1', 'S2']);
  assert.deepEqual(pressIntent(SCREENS, 0, two), { kind: 'activate', destination: 'S1' }, 'selected, not active');
  assert.deepEqual(pressIntent(SCREENS, 0, two, { long: true }), { kind: 'unselect', destination: 'S1' });
  assert.equal(pressIntent(SCREENS, 1, two).kind, 'none', 'the active one, pressed again');
  assert.match(pressIntent(SCREENS, 1, two).why, /already the active screen/);
  assert.equal(LONG_PRESS_MS, 1500, 'the console\'s own long press on a screen key');
});

test('layer, input and memory keys ask for what a U5\'s bus keys ask for', () => {
  const ctx = ctxWith(['S1']);
  assert.deepEqual(pressIntent(LAYERS, 1, ctx), { kind: 'selectLayer', layer: 2 });
  assert.match(pressIntent(LAYERS, 0, ctxWith()).why, /select a screen first/);
  assert.deepEqual(pressIntent(INPUTS, 4, ctx), { kind: 'source', input: 5, label: 'IN 5' });
  assert.deepEqual(pressIntent(MEMORIES, 2, ctx), { kind: 'recall', slot: 3 });
  const paged = { ...ctx, view: { ...initialView(), pages: [0, 0, 1, 0] } };
  assert.deepEqual(pressIntent(INPUTS, 1, paged), { kind: 'source', input: 10, label: 'CAM 10' }, 'page 2 of inputs');
  assert.equal(pressIntent(INPUTS, 2, paged).kind, 'none', 'past the last input');
});

test('SAVE TO and DEL, armed on the console, turn memory keys into a store and a delete', () => {
  const save = ctxWith(['S1'], { view: { ...initialView(), armed: 'save', pages: [0, 0, 0, 1] } });
  assert.deepEqual(pressIntent(MEMORIES, 0, save), { kind: 'store', slot: null }, 'the empty key past the last memory');
  const saveOver = ctxWith(['S1'], { view: { ...initialView(), armed: 'save' } });
  assert.deepEqual(pressIntent(MEMORIES, 1, saveOver), { kind: 'store', slot: 2 });
  const del = ctxWith(['S1'], { view: { ...initialView(), armed: 'del' } });
  assert.deepEqual(pressIntent(MEMORIES, 1, del), { kind: 'deletePreset', slot: 2, label: 'Look 2' });
  assert.equal(pressIntent(MEMORIES, 0, ctxWith(['S1'], { view: { ...initialView(), pages: [0, 0, 0, 1] } })).kind, 'none',
    'an empty key with nothing armed does nothing');
});

test('columns 8 and 9 are each row\'s page keys', () => {
  assert.deepEqual(pressIntent(INPUTS, PAGE_ON, ctxWith()), { kind: 'page', row: INPUTS, delta: 1 });
  assert.deepEqual(pressIntent(SCREENS, PAGE_BACK, ctxWith()), { kind: 'page', row: SCREENS, delta: -1 });
});

test('a press is taken only from the page this app last drew on its row', () => {
  const view = { ...initialView(), pages: [0, 0, 1, 0] };
  assert.equal(wirePage(view, INPUTS), 2, 'pages go out counted from 1, as Companion\'s do');
  assert.equal(pageMatches(view, INPUTS, 2), true);
  assert.equal(pageMatches(view, INPUTS, 1), false, 'pressed before the redraw landed');
  assert.equal(pageMatches(view, INPUTS, null), true, 'a press that does not say');
});

test('the grid shows the selection, the active screen, tally and the pages', () => {
  const tally = { layer: 1, program: { kind: 'LIVE', number: 1 }, preview: { kind: 'LIVE', number: 2 } };
  const cells = gridCells(ctxWith(['S2', 'S1'], { tally }));
  assert.equal(cells.length, 40);
  const at = (row, column) => cells.find((c) => c.row === row && c.column === column);
  assert.deepEqual(at(SCREENS, 0).face.fill, AMBER, 'S1 selected');
  assert.deepEqual(at(SCREENS, 0).face.frame, [255, 255, 255], 'and active');
  assert.match(at(SCREENS, 0).face.sub, /ACTIVE/);
  assert.equal(at(SCREENS, 1).face.frame, null, 'S2 selected, not active');
  assert.deepEqual(at(INPUTS, 0).face.fill, RED, 'CAM 1 on air on the selected layer');
  assert.match(at(INPUTS, 0).face.sub, /PGM/);
  assert.deepEqual(at(INPUTS, 1).face.fill, GREEN, 'CAM 2 in preview');
  assert.equal(at(INPUTS, PAGE_ON).face.sub, 'INPUT 1/2');
  assert.deepEqual(at(SCREENS, PAGE_ON).face.fill, BLACK, 'one page of screens: its page keys are dark');
  assert.equal(at(INPUTS, 3).page, 1);
  /* Tally for another layer is not this layer's. */
  const other = gridCells(ctxWith(['S1'], { tally: { ...tally, layer: 2 } }));
  assert.deepEqual(other.find((c) => c.row === INPUTS && c.column === 0).face.fill, GREY);
});

test('a key is drawn as a 72 × 72 RGBA PNG, its fill and its label', () => {
  const png = renderKey({ text: 'Camera 1', sub: 'PGM IN 1', fill: RED, ink: [235, 235, 235] });
  const p = pixels(png);
  assert.equal(p.width, 72);
  assert.equal(p.height, 72);
  assert.equal(p.type, 6, 'RGBA, as the vendor plugin sends');
  assert.deepEqual(p.at(0, 0), RED);
  assert.deepEqual(fillOf(png), RED);
  assert.notDeepEqual(renderKey({ text: 'Camera 2', fill: RED }), renderKey({ text: 'Camera 1', fill: RED }), 'the label is drawn');
  const framed = pixels(renderKey({ text: 'S1', fill: AMBER, frame: [255, 255, 255] }));
  assert.deepEqual(framed.at(1, 36), [255, 255, 255]);
});

/* ============================================================ the 17100 link */

const quick = { reconnectMs: 25, takeoverWindowMs: 10_000 };

test('the link draws a key, and the console shows it only on a row switched to Companion', async () => {
  const lcd = await new StandInLcd({ port: 0 }).start();
  const link = new GridLink({ host: '127.0.0.1', port: lcd.port, ...quick });
  try {
    await new Promise((resolve) => { link.once('open', resolve); link.start(); });
    const png = renderKey({ text: 'LED 1', fill: AMBER });
    link.draw([{ row: 0, column: 0, page: 1, png }]);
    assert.ok(await until(() => lcd.draws === 1));
    assert.deepEqual(lcd.rejected, []);
    assert.equal(lcd.shown(0, 0), null, 'row 0 is still the console\'s own screen bus');
    lcd.toCompanion(0);
    assert.deepEqual(lcd.shown(0, 0).png, png);
    link.draw([{ row: 0, column: 0, page: 2, png }]);
    assert.ok(await until(() => lcd.pages[0] === 2), 'a draw for another page moves the row there');
    assert.ok(await until(() => link.state.drawn === 2));
  } finally {
    await link.stop();
    await lcd.stop();
  }
});

test('a press on a Companion row comes back with its row, column and page; elsewhere it never arrives', async () => {
  const lcd = await new StandInLcd({ port: 0 }).start();
  const link = new GridLink({ host: '127.0.0.1', port: lcd.port, ...quick });
  const presses = [];
  link.on('press', (p) => presses.push(p));
  try {
    await new Promise((resolve) => { link.once('open', resolve); link.start(); });
    await lcd.press(1, 3);
    await settle(40);
    assert.deepEqual(presses, [], 'the layer row is the console\'s own until switched');
    lcd.toCompanion(1);
    lcd.pages[1] = 2;
    await lcd.press(1, 3);
    assert.ok(await until(() => presses.length === 2));
    assert.deepEqual(presses, [
      { pressed: true, column: 3, row: 1, page: 2 },
      { pressed: false, column: 3, row: 1, page: 2 },
    ]);
  } finally {
    await link.stop();
    await lcd.stop();
  }
});

test('the link takes the grid from the console\'s own Companion, whose retries are then refused: no fight', async () => {
  const lcd = await new StandInLcd({ port: 0 }).start();
  const builtIn = await lcd.builtInCompanion({ retryMs: 20 });
  const link = new GridLink({ host: '127.0.0.1', port: lcd.port, ...quick });
  let closes = 0;
  link.on('close', () => { closes++; });
  try {
    assert.ok(await until(() => lcd.current && lcd.current.local), 'the built-in Companion holds it first');
    await new Promise((resolve) => { link.once('open', resolve); link.start(); });
    assert.ok(await until(() => lcd.current && !lcd.current.local));
    assert.equal(lcd.kicked[0].address, '127.0.0.1', 'the LAN client took it from localhost');
    const tries = builtIn.state.attempts;
    assert.ok(await until(() => builtIn.state.attempts >= tries + 3), 'the built-in Companion keeps trying');
    assert.ok(lcd.refused.some((r) => r.address === '127.0.0.1'), 'and is refused');
    assert.equal(closes, 0, 'the link was never closed');
    assert.equal(link.state.connected, true);
  } finally {
    await link.stop();
    await lcd.stop();
  }
});

test('another LAN client takes the grid back and forth, so the link lets go and says why', async () => {
  const lcd = await new StandInLcd({ port: 0 }).start();
  const laptop = await lcd.listenAs('192.168.0.77');
  /* Another machine's Companion with the U5 mini surface: back on every drop. */
  let stopped = false;
  let other = null;
  const dial = () => {
    if (stopped) return;
    other = net.createConnection({ host: '127.0.0.1', port: laptop });
    other.on('error', () => {});
    other.on('close', () => setTimeout(dial, 15));
  };
  const link = new GridLink({ host: '127.0.0.1', port: lcd.port, ...quick });
  let letGo = null;
  link.on('letgo', (info) => { letGo = info; });
  try {
    await new Promise((resolve) => { link.once('open', resolve); link.start(); });
    dial();
    assert.ok(await until(() => letGo, 5000), 'let go rather than looping');
    assert.equal(letGo.count, 3);
    assert.deepEqual(link.state.letGo, letGo);
    const kickedWhenLetGo = lcd.kicked.length;
    await settle(150);
    assert.ok(lcd.kicked.length <= kickedWhenLetGo + 1, 'and stopped dialling');
    const words = letGoNote(letGo);
    assert.match(words, /3 times/);
    assert.match(words, /Companion with the U5 mini surface/);
    assert.match(words, /older connection from this computer/);
  } finally {
    stopped = true;
    other?.destroy();
    await link.stop();
    await lcd.stop();
  }
});

test('a second connection from the address already holding the grid is refused, and the first keeps it', async () => {
  const lcd = await new StandInLcd({ port: 0 }).start();
  const first = new GridLink({ host: '127.0.0.1', port: lcd.port, ...quick });
  const second = new GridLink({ host: '127.0.0.1', port: lcd.port, ...quick });
  let letGo = null;
  second.on('letgo', (info) => { letGo = info; });
  try {
    await new Promise((resolve) => { first.once('open', resolve); first.start(); });
    second.start();
    assert.ok(await until(() => letGo, 5000), 'the console closed it each time, so it let go');
    assert.equal(first.state.connected, true);
    assert.ok(lcd.refused.every((r) => r.why === 'that address already holds the grid'));
    assert.equal(lcd.kicked.length, 0);
  } finally {
    await first.stop();
    await second.stop();
    await lcd.stop();
  }
});

/* ======================================================== end to end */

/** A LivePremier: two screens (S1 with two layers), ten inputs, two memories. */
function lpStore() {
  const s = new Map();
  const set = (path, v) => s.set(toAwj(path), v);
  s.set('DeviceObject/system/$device/@items/1/@props/dev', 'NLC_RS4');
  for (const [id, label] of [['S1', 'LED 1'], ['S2', 'LED 2']]) {
    set(NLC.takeStatus(id, 'isUsed'), true);
    set(labelPath(NLC, id), label);
    set(NLC.takeControl(id, 'presetUp'), 'A');
    set(NLC.takeControl(id, 'presetDown'), 'B');
    set(NLC.takeControl(id, 'presetPrevious'), 'C');
    set(NLC.takeStatus(id, 'transition'), 'AT_DOWN');
    set(NLC.takeStatus(id, 'tbarPosition'), 0);
    set(NLC.fadeToBlackPath(id), false);
    const probe = NLC.layerProbe(id, 16);
    for (const k of probe.slots) set(probe.path(k), Number(k) <= (id === 'S1' ? 2 : 1) ? 'FULL' : 'OFF');
  }
  for (let n = 1; n <= 10; n++) {
    set(['device', 'inputList', 'items', `IN_${n}`, 'mapping', 'pp', 'isValid'], true);
    set(['device', 'inputList', 'items', `IN_${n}`, 'control', 'pp', 'label'], `CAM ${n}`);
  }
  [['1', 'Opener'], ['2', 'Walk-in']].forEach(([slot, label]) => {
    set(NLC.label('screen', Number(slot), '').path, label);
    set(slotValidPath(NLC, Number(slot)), true);
  });
  return s;
}

/** The app's panel on a stand-in mini with its grid, and a pretend LivePremier. */
async function rig({ functionKeys = 'command' } = {}) {
  const awj = await fakeAwj(lpStore());
  const standIn = await new StandInConsole({ port: 0, grid: true, gridPort: 0, functionKeys }).start();
  const sup = new PixelhueSupervisor({
    deviceHost: () => '127.0.0.1', awjPort: awj.port,
    consolePort: standIn.port, grid: { port: standIn.lcd.port, ...quick },
  });
  await sup.apply(normalisePixelhue({ pixelhueEnabled: true, pixelhueHost: '127.0.0.1', pixelhueModel: 'u5mini' }));
  const lcd = standIn.lcd;
  assert.ok(await until(() => lcd.draws >= 40, 5000), `the whole grid drawn (${lcd.draws})`);
  for (let row = 0; row < 4; row++) lcd.toCompanion(row);
  const said = (re) => sup.history.some((e) => re.test(e.note || e.error || ''));
  return {
    awj, standIn, lcd, sup, said,
    async close() { await sup.stop(); await standIn.stop(); await awj.close(); },
  };
}

test('on a mini the app draws the bus rows itself, and a grid press is a U5 bus press', async () => {
  const r = await rig();
  const { lcd, sup, awj } = r;
  try {
    assert.equal(sup.describe().grid.connected, true);
    assert.deepEqual(fillOf(lcd.shown(SCREENS, 0).png), GREY, 'LED 1, not selected');
    assert.deepEqual(fillOf(lcd.shown(SCREENS, 2).png), BLACK, 'no third screen');
    assert.deepEqual(fillOf(lcd.shown(LAYERS, 0).png), BLACK, 'no active screen, no layers');

    await lcd.press(SCREENS, 0);
    assert.ok(await until(() => sup.selection.list.join() === 'S1'), 'S1 selected from the grid');
    assert.ok(r.said(/^selected S1, layer 1$/));
    assert.ok(await until(() => fillOf(lcd.shown(SCREENS, 0).png).join() === AMBER.join()), 'and lit');
    assert.ok(await until(() => fillOf(lcd.shown(LAYERS, 1).png).join() === GREY.join()), 'S1\'s two layers on the layer row');
    assert.deepEqual(awj.writes(), [], 'a selection writes nothing');

    awj.clear();
    await lcd.press(INPUTS, 1);
    assert.ok(await until(() => awj.writes().length));
    const [w] = awj.writes();
    assert.match(w.path, /\$screen\/@items\/S1\/\$preset\/@items\/A\/\$layer\/@items\/1\/source\/@props\/inputNum$/, w.path);
    assert.equal(w.value, 'LIVE_2');

    awj.clear();
    await lcd.press(MEMORIES, 0);
    assert.ok(await until(() => awj.writes().length));
    assert.match(awj.writes()[0].path, /\$slot\/@items\/1\/\$screen\/@items\/S1\/\$preset\/@items\/PREVIEW\/@props\/xRequest$/, 'to preview');

    /* TAKE reported as a U5 reports it: it takes what the grid selected. */
    awj.clear();
    await r.standIn.pressFunction(65);
    assert.ok(await until(() => awj.writes().length));
    assert.deepEqual(awj.writes(), [{ path: toAwj(NLC.takeControl('S1', 'xTake')), value: true }]);
    assert.equal(sup.describe().takeCut.take, true);
    awj.clear();
    await r.standIn.pressFunction(64);
    assert.ok(await until(() => awj.writes().length));
    assert.deepEqual(awj.writes(), [{ path: toAwj(NLC.takeControl('S1', 'xCut')), value: true }]);
  } finally {
    await r.close();
  }
});

test('the grid pages each row with its own page keys, and refuses a press from a page it has drawn over', async () => {
  const r = await rig();
  const { lcd, sup, awj } = r;
  try {
    await lcd.press(SCREENS, 0);
    assert.ok(await until(() => sup.selection.list.length === 1));
    await lcd.press(INPUTS, PAGE_ON);
    assert.ok(await until(() => lcd.pages[INPUTS] === 2), 'the input row redrawn as page 2');
    assert.ok(r.said(/^inputs row on page 2$/));
    assert.ok(await until(() => lcd.shown(INPUTS, 1) && fillOf(lcd.shown(INPUTS, 1).png).join() === GREY.join()), 'CAM 10');
    assert.deepEqual(fillOf(lcd.shown(INPUTS, 2).png), BLACK, 'past CAM 10');

    awj.clear();
    await lcd.press(INPUTS, 1);
    assert.ok(await until(() => awj.writes().length));
    assert.equal(awj.writes()[0].value, 'LIVE_10');

    /* A press the console reports from page 1 of a row now drawn as page 2. */
    awj.clear();
    lcd.pages[INPUTS] = 1;
    await lcd.press(INPUTS, 1);
    assert.ok(await until(() => r.said(/refused — the console says that key was on page 1 of the inputs row/)));
    assert.deepEqual(awj.writes(), []);

    /* On a row that is not in Companion, the page keys are the console's: 549 / 550, ignored here. */
    lcd.areaSwitch(MEMORIES);
    await lcd.press(MEMORIES, PAGE_ON);
    assert.ok(await until(() => sup.history.some((e) => e.code === 550)));
    assert.equal(sup.describe().grid.pages[MEMORIES], 1);
  } finally {
    await r.close();
  }
});

test('a screen held on the grid drops out of the selection', async () => {
  const r = await rig();
  try {
    await r.lcd.press(SCREENS, 0);
    await r.lcd.press(SCREENS, 1);
    assert.ok(await until(() => r.sup.selection.list.join() === 'S1,S2'));
    await r.lcd.press(SCREENS, 0, LONG_PRESS_MS + 100);
    assert.ok(await until(() => r.sup.selection.list.join() === 'S2'));
  } finally {
    await r.close();
  }
});

test('SAVE TO armed on the console stores the active screen into a free slot from an empty memory key', async () => {
  const r = await rig();
  const { lcd, sup, awj, standIn } = r;
  try {
    await lcd.press(SCREENS, 0);
    assert.ok(await until(() => sup.selection.list.length === 1));
    awj.clear();
    await standIn.thumb(48);   // SAVE TO on a mini's key map
    assert.ok(await until(() => sup.describe().grid.armed === 'save'));
    assert.ok(r.said(/SAVE TO armed: the next memory key on the key grid stores/));
    await lcd.press(MEMORIES, 2);   // the first empty key: Opener, Walk-in, then nothing
    assert.ok(await until(() => awj.writes().length >= 2));
    assert.deepEqual(awj.writes().map((w) => [w.path, w.value]), [
      [toAwj(NLC.save('screen', 3, { mode: 'PREVIEW', id: 'S1' }).path), true],
      [toAwj(NLC.label('screen', 3, 'Memory 3').path), 'Memory 3'],
    ]);
    assert.equal(sup.describe().grid.armed, null, 'disarmed by the store');
  } finally {
    await r.close();
  }
});

test('a mini that reports TAKE\'s key but no take says so, and sends nothing', async () => {
  const r = await rig({ functionKeys: 'keys' });
  try {
    await r.lcd.press(SCREENS, 0);
    assert.ok(await until(() => r.sup.selection.list.length === 1));
    r.awj.clear();
    await r.standIn.pressFunction(65);
    assert.ok(await until(() => r.said(/^TAKE pressed on the console \(key 65\), but the console reported no take command \(531\)/)));
    assert.deepEqual(r.awj.writes(), []);
    assert.equal(r.sup.describe().takeCut.take, false);
  } finally {
    await r.close();
  }
});

test('a mini that reports nothing for TAKE leaves the card saying so in plain words', async () => {
  const r = await rig({ functionKeys: 'nothing' });
  try {
    await r.lcd.press(SCREENS, 0);
    assert.ok(await until(() => r.sup.selection.list.length === 1));
    r.awj.clear();
    await r.standIn.pressFunction(65);
    await settle(500);
    assert.deepEqual(r.awj.writes(), []);
    const d = r.sup.describe();
    assert.deepEqual([d.takeCut.take, d.takeCut.cut], [false, false]);
    assert.equal(d.takeCut.note, takeCutNote('u5mini'));
    assert.match(d.takeCut.note, /nobody knows yet whether TAKE and CUT reach this app/);
    assert.ok(r.said(/nobody knows yet whether TAKE and CUT reach this app/), 'said once in the history, at the first grid selection');
    assert.equal(r.sup.history.filter((e) => /nobody knows yet/.test(e.note || '')).length, 1);
  } finally {
    await r.close();
  }
});

test('a U5 or U5 Pro labels its own keys: no grid link at all', async () => {
  /* A port nothing listens on: PixelFlow for macOS runs a real UCenter on
     127.0.0.1:19999, the U5's own port, and a test must never dial it. */
  const free = net.createServer();
  await new Promise((r) => free.listen(0, '127.0.0.1', r));
  const closed = free.address().port;
  await new Promise((r) => free.close(r));
  const sup = new PixelhueSupervisor({ deviceHost: () => null, consolePort: closed });
  try {
    await sup.apply(normalisePixelhue({ pixelhueEnabled: true, pixelhueHost: '127.0.0.1', pixelhueModel: 'u5' }));
    assert.equal(sup.describe().grid, null);
    assert.equal(sup.describe().takeCut, null);
    assert.equal(takeCutNote('u5pro'), '');
  } finally {
    await sup.stop();
  }
});

/* ============================================================== the card */

/** The settings card, rendered over a fake DOM from a panel state the server would serve. */
async function cardText(state, settings) {
  const dom = installDom();
  const fetchBefore = globalThis.fetch;
  const intervalBefore = globalThis.setInterval;
  globalThis.fetch = async (url) => (String(url).endsWith('/state')
    ? { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(state)) }
    : { ok: false, status: 404, json: async () => ({}) });
  globalThis.setInterval = (...a) => { const t = intervalBefore(...a); t.unref?.(); return t; };
  try {
    const { KIT } = await import('../src/ui/plugin-host.js');
    const { default: activate } = await import('../plugins/pixelhue/client.js');
    const registered = [];
    await activate({
      id: 'pixelhue', session: new EventTarget(), platform: () => null, can: () => true,
      refresh() {}, kit: KIT, url: (p = '/') => `/__lpp/pixelhue${p === '/' ? '' : p}`,
      settings: { get: () => settings, set: async () => settings },
      contribute() {}, contributions: () => [], provide() {}, use: () => null, share() {},
      log: { info() {}, warn() {} },
      ui: { sidebar: (e) => registered.push(e), tab: (e) => registered.push(e), settingsSection: (e) => registered.push(e) },
    });
    const card = registered.find((e) => e.id === 'pixelhue');
    card.render();
    await settle(20);
    return card.render().textContent;
  } finally {
    globalThis.fetch = fetchBefore;
    globalThis.setInterval = intervalBefore;
    dom.uninstall();
  }
}

test('the card says the grid is drawn, how to see it, and that TAKE / CUT have not been seen', async () => {
  const r = await rig({ functionKeys: 'nothing' });
  let state;
  try {
    await r.lcd.press(SCREENS, 0);
    assert.ok(await until(() => r.sup.selection.list.length === 1));
    state = r.sup.describe();
  } finally {
    await r.close();
  }
  const settings = normalisePixelhue({ pixelhueEnabled: true, pixelhueHost: '127.0.0.1', pixelhueModel: 'u5mini' });
  const text = await cardText(state, settings);
  assert.match(text, /Key grid/);
  assert.match(text, /drawing on 127\.0\.0\.1:\d+/);
  assert.match(text, /TAKE \/ CUT/);
  assert.match(text, /not seen yet/);
  assert.match(text, /nobody knows yet whether TAKE and CUT reach this app/);
  assert.match(text, /switched to Companion with its area-switch key/);
  assert.doesNotMatch(text, /labels, lights and pages its own keys/, 'that is a U5\'s story, not a mini\'s');

  const gone = { ...state, grid: { ...state.grid, connected: false, letGo: { at: 1, count: 3, windowMs: 60_000, note: letGoNote({ count: 3, windowMs: 60_000 }) } } };
  const after = await cardText(gone, settings);
  assert.match(after, /let go/);
  assert.match(after, /closed this app's connection to its key grid 3 times in 60 s/);
});

