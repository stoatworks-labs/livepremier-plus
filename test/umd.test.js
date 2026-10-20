/*
 * UMD Generator: borders and name tabs drawn from where an aux's layers are.
 *
 * What is pinned here, each the quiet way to get it wrong:
 *
 * - **The templates keep the canvas's shape** — every box is the canvas
 *   scaled, so a 16:9 source is never squashed — and stay on the canvas
 *   without overlapping, in the 1, 3, 5 and 7 an aux's layer pairs allow.
 * - **The top layer is the UMD's, never a box**, and a layer with no source
 *   is no box unless it has a name.
 * - **Under the layers, inside labels are hidden**, and the plan says so;
 *   over them, a line shared by two touching boxes is one line.
 * - **Every write waits for the switcher's own echo**, the second UMD reuses
 *   the first's slot and still with one upload, and Undo takes back exactly
 *   what was written.
 *
 * The store is the 6.2.73 simulator's capture with A1 made an 8-layer aux,
 * as the simulator's preconfig makes one (8K advanced, 2026-10-16).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import { listDestinations, anchorToTopLeft } from '../src/core/screens.js';
import { same } from '../src/core/wire.js';
import { readLibrary, readStills, emptySlots } from '../src/core/stills.js';
import {
  TEMPLATES, templateRects, templatesFor, templateById, normalise, withDest, withStyle, layerPlan, targetOf, labelsFor,
  readBoxes, layout, borderBands, fingerprint, roughMeasure, placeWrites, cleanWrites, umdLayerWrites, templateWrites,
  chooseStill, chooseSlot, fileName, intersect, autoBorder, nativeWrites
} from '../plugins/umd/core.js';
import { draw } from '../plugins/umd/render.js';
import { putOnLayer, applyTemplate, revert } from '../plugins/umd/apply.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

function merge(a, b) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
  return out;
}

const CANVAS = { width: 1920, height: 1080 };
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8'];

/** One preset layer as the switcher keeps it, with the properties an aux layer has. */
function layerNode({ source = 'NONE', left = 0, top = 0, width = 1920, height = 1080, anchor = 'MIDDLE_CENTER', opacity = 256, crop = 0 } = {}) {
  const [v, hz] = anchor.split('_');
  const posH = hz === 'LEFT' ? left : hz === 'RIGHT' ? left + width : left + width / 2;
  const posV = v === 'TOP' ? top : v === 'BOTTOM' ? top + height : top + height / 2;
  return {
    source: { pp: { inputNum: source }, status: { pp: { inputNum: source } } },
    position: { pp: { anchor, posH, posV, sizeH: width, sizeV: height } },
    opacity: { pp: { opacity } },
    effects: { pp: { flags: [] } },
    cropping: { classic: { pp: { top: crop, bottom: 0, left: 0, right: 0, aspectOverride: 'NONE' } }, mask: { pp: { top: 0, bottom: 0, left: 0, right: 0 } } }
  };
}

/**
 * The simulator's store with A1 in service: eight DUAL layers, preview B
 * holding three PIPs (two cameras and a still), the rest empty; inputs 1 and
 * 2 fitted, the first named; stills 47 and 48 enabled and empty; library
 * slots 199 and 200 empty.
 */
function auxStore({ layers = 8, preview = null } = {}) {
  const fitted = Object.fromEntries(['NATIVE', ...KEYS].map((k) => [k, { status: { pp: { capability: k !== 'NATIVE' && Number(k) <= layers ? 'DUAL' : 'OFF' } } }]));
  const pv = preview || {
    1: layerNode({ source: 'LIVE_1', left: 0, top: 0, width: 960, height: 540 }),
    2: layerNode({ source: 'LIVE_2', left: 960, top: 0, width: 960, height: 540, anchor: 'TOP_LEFT' }),
    3: layerNode({ source: 'STILL_47', left: 480, top: 540, width: 960, height: 540 })
  };
  const presetLayers = (over) => Object.fromEntries(['NATIVE', ...KEYS].map((k) => [k, over[k] || layerNode()]));
  const still = (n, extra = {}) => ({
    control: { pp: { label: '', mode: 'NONE', source: 1, rescale: 'SCALE_TO_CAPABILITY', ...extra } },
    status: { pp: { isAvailable: true, isEnabled: true, isValid: false, isUsed: false, capability: 'DUAL', isOnProgram: false, isOnPreview: false } },
    mapping: { pp: { isValid: true } }
  });
  const aux = {
    device: {
      auxiliaryList: {
        itemKeys: ['A1'],
        items: {
          A1: {
            control: { pp: { label: 'MV' } },
            status: { pp: { mode: 'FREESTYLE', layerCount: layers }, size: { pp: { sizeH: 1920, sizeV: 1080 } } },
            layerList: { itemKeys: ['NATIVE', ...KEYS], items: fitted },
            presetList: { itemKeys: ['A', 'B'], items: { A: { layerList: { itemKeys: ['NATIVE', ...KEYS], items: presetLayers({}) } }, B: { layerList: { itemKeys: ['NATIVE', ...KEYS], items: presetLayers(pv) } } } }
          }
        }
      },
      screenAuxGroupList: { items: { A1: { control: { pp: { presetUp: 'B', presetDown: 'A' } }, status: { pp: { isUsed: true, transition: 'AT_DOWN', take: 'OFF' } } } } },
      inputList: {
        itemKeys: ['IN_1', 'IN_2'],
        items: {
          IN_1: { control: { pp: { label: 'Camera 1' } }, mapping: { pp: { isValid: true } } },
          IN_2: { control: { pp: { label: '' } }, mapping: { pp: { isValid: true } } }
        }
      },
      stillList: {
        itemKeys: ['46', '47', '48'],
        items: {
          46: still(46),
          47: merge(still(47, { mode: 'IMAGE', source: 3, label: 'Logo' }), { status: { pp: { isValid: true } } }),
          48: still(48)
        },
        library: {
          bankList: {
            itemKeys: ['198', '199', '200'],
            items: {
              198: { status: { pp: { isValid: true, fileName: 'logo.png', width: 400, height: 200 } } },
              199: { status: { pp: { isValid: false } } },
              200: { status: { pp: { isValid: false } } }
            }
          }
        }
      },
      preconfig: {
        stills: { current: { stillList: { items: { 46: { status: { pp: { global: 'USED', capability: 'DUAL' } } }, 47: { status: { pp: { global: 'USED', capability: 'DUAL' } } }, 48: { status: { pp: { global: 'USED', capability: 'DUAL' } } } } } } }
      }
    }
  };
  const s = new DeviceStore();
  s.hydrate(merge(['sim-6.2.73-identity.json', 'sim-6.2.73-screens.json', 'sim-6.2.73-destinations.json'].map(fixture).reduce(merge, {}), aux));
  return s;
}

const a1 = (store) => listDestinations(store).find((d) => d.id === 'A1');

/* ============================================================ templates */

test('templates come in the sizes an aux’s layer pairs leave, keep the canvas’s shape, and stay on it without overlapping', () => {
  assert.deepEqual([...new Set(TEMPLATES.filter((t) => !t.even).map((t) => t.boxes))], [1, 3, 5, 7], 'the top layer is the UMD’s');
  assert.deepEqual([...new Set(TEMPLATES.filter((t) => t.even).map((t) => t.boxes))], [2, 4, 6, 8], 'every layer is a box when the UMD is on the background');
  for (const t of TEMPLATES) {
    assert.equal(t.cells.length, t.boxes, `${t.id} has as many cells as boxes`);
    for (const canvas of [CANVAS, { width: 3840, height: 2160 }, { width: 1920, height: 1200 }]) {
      const rects = templateRects(t, canvas);
      for (const r of rects) {
        assert.ok(r.left >= 0 && r.top >= 0 && r.left + r.width <= canvas.width && r.top + r.height <= canvas.height, `${t.id} stays on a ${canvas.width}×${canvas.height} canvas`);
        assert.ok(Math.abs(r.width / r.height - canvas.width / canvas.height) < 0.01, `${t.id}: ${r.width}×${r.height} keeps the canvas’s shape`);
      }
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) assert.equal(intersect(rects[i], rects[j]), null, `${t.id}: boxes ${i + 1} and ${j + 1} do not overlap`);
      }
    }
  }
});

test('the quad split is three quadrants and a quarter-split one, to the pixel', () => {
  const rects = templateRects(templateById('seven-quad'), CANVAS);
  assert.deepEqual(rects.slice(0, 3), [
    { left: 0, top: 0, width: 960, height: 540 }, { left: 960, top: 0, width: 960, height: 540 }, { left: 0, top: 540, width: 960, height: 540 }
  ]);
  assert.deepEqual(rects[6], { left: 1440, top: 810, width: 480, height: 270 });
});

test('a gap shrinks each box about its centre and keeps its shape', () => {
  const [r] = templateRects(templateById('three-two-over-one'), CANVAS, 32);
  assert.deepEqual(r, { left: 16, top: 9, width: 928, height: 522 });
});

test('the templates offered are those with no more boxes than there are layers for', () => {
  assert.deepEqual([...new Set(templatesFor(1).map((t) => t.boxes))], [1]);
  assert.deepEqual([...new Set(templatesFor(3).map((t) => t.boxes))], [1, 3]);
  assert.deepEqual([...new Set(templatesFor(7).map((t) => t.boxes))], [1, 3, 5, 7]);
  assert.deepEqual(templatesFor(0), []);
  assert.ok(!templatesFor(8).some((t) => t.even), 'the even layouts are not offered for the top layer');
  assert.deepEqual([...new Set(templatesFor(4, { even: true }).map((t) => t.boxes))].sort(), [1, 2, 3, 4]);
  assert.deepEqual([...new Set(templatesFor(8, { even: true }).filter((t) => t.even).map((t) => t.boxes))], [2, 4, 6, 8]);
});

/* ============================================================ the doc */

test('the document corrects a bad field and keeps the rest', () => {
  const d = normalise({
    style: { borderWidth: 99, borderColour: 'red', textScale: 7, tabOpacity: -1, labelFrom: 'nonsense', uppercase: true },
    dests: { A1: { buffer: 'program', labels: 'below', template: 'no-such', gap: -4, names: { 2: '  CAM 2  ', x: 'no', 3: '' }, placed: { slot: 200, still: 48, layer: '8' } }, Q9: { buffer: 'program' } }
  });
  assert.deepEqual(d.style, { border: true, borderWidth: 32, borderColour: '#ffffff', textScale: 2, uppercase: true, tabOpacity: 0, labelFrom: 'source' });
  assert.deepEqual(Object.keys(d.dests), ['A1'], 'a destination that is not one is dropped');
  assert.equal(d.dests.A1.buffer, 'program');
  assert.equal(d.dests.A1.template, null);
  assert.equal(d.dests.A1.gap, 0);
  assert.deepEqual(d.dests.A1.names, { 2: 'CAM 2' });
  assert.deepEqual(d.dests.A1.placed, { slot: 200, still: 48, layer: '8', letter: null, fingerprint: null });
  const named = withDest(d, 'A1', { names: { 3: 'Wide' } });
  assert.deepEqual(named.dests.A1.names, { 2: 'CAM 2', 3: 'Wide' }, 'a name is added, not the list replaced');
  assert.deepEqual(withDest(named, 'A1', { names: { 2: '' } }).dests.A1.names, { 3: 'Wide' }, 'an empty name clears it');
  assert.equal(withStyle(d, { border: false }).style.border, false);
});

/* ====================================================== the destination */

test('an aux’s UMD goes on its top layer and the rest are boxes; a screen’s goes under all of them', () => {
  const store = auxStore();
  assert.equal(targetOf('A1'), 'layer');
  assert.equal(targetOf('S1'), 'background');
  assert.deepEqual(layerPlan(store, 'A1'), { layers: KEYS, umd: '8', boxes: KEYS.slice(0, 7) });
  assert.deepEqual(layerPlan(auxStore({ layers: 1 }), 'A1').boxes, [], 'one layer leaves no box under the UMD');
  assert.equal(labelsFor('A1', null), 'bottom');
  assert.equal(labelsFor('S1', null), 'below', 'under the box is the label a background can show');
  assert.equal(labelsFor('S1', { labels: 'top' }), 'top');
});

test('experimental: an aux’s UMD on its background only with the switch on, and then every layer is a box', () => {
  const store = auxStore();
  const wants = normalise({ dests: { A1: { auxTarget: 'background' }, A2: { auxTarget: 'sideways' } } });
  assert.equal(wants.dests.A1.auxTarget, 'background');
  assert.equal(wants.dests.A2.auxTarget, 'layer', 'anything else is the top layer');
  assert.equal(targetOf('A1', wants.dests.A1), 'layer', 'without the switch the entry is ignored');
  assert.equal(targetOf('A1', wants.dests.A1, true), 'background');
  assert.equal(targetOf('S1', null, true), 'background');
  assert.equal(labelsFor('A1', wants.dests.A1, true), 'below', 'under the layers, a label inside a box is hidden');
  assert.deepEqual(layerPlan(store, 'A1', 'background'), { layers: KEYS, umd: null, boxes: KEYS });
  assert.deepEqual(nativeWrites(store, a1(store), 'B', 48), [
    { path: ['device', 'auxiliaryList', 'items', 'A1', 'presetList', 'items', 'B', 'layerList', 'items', 'NATIVE', 'source', 'pp', 'inputNum'], value: 'STILL_48' }
  ], 'the still as the background’s source, and nothing placed');
});

test('the boxes are the layers showing something, named after their sources, and never the UMD’s own layer', () => {
  const store = auxStore({
    preview: {
      1: layerNode({ source: 'LIVE_1', left: 0, top: 0, width: 960, height: 540 }),
      2: layerNode({ source: 'LIVE_2', left: 960, top: 0, width: 960, height: 540, anchor: 'TOP_LEFT' }),
      3: layerNode({ source: 'STILL_47', left: 480, top: 540, width: 960, height: 540 }),
      4: layerNode({ source: 'LIVE_1', opacity: 0 }),
      8: layerNode({ source: 'STILL_48' })
    }
  });
  const boxes = readBoxes(store, a1(store), 'B', { umd: '8' });
  assert.deepEqual(boxes.map((b) => [b.key, b.text]), [['1', 'Camera 1'], ['2', 'IN2'], ['3', 'Logo']]);
  assert.deepEqual(boxes[1].rect, { left: 960, top: 0, width: 960, height: 540 }, 'a TOP_LEFT layer is read through its anchor');
  const named = readBoxes(store, a1(store), 'B', { umd: '8', names: { 2: 'Lectern', 5: 'Spare' } });
  assert.deepEqual(named.map((b) => [b.key, b.text]), [['1', 'Camera 1'], ['2', 'Lectern'], ['3', 'Logo'], ['5', 'Spare']],
    'a name of its own wins, and draws an empty layer’s box');
  const byLayer = readBoxes(store, a1(store), 'B', { umd: '8', layerNames: { 'A1/1': 'Stage left' }, labelFrom: 'layer' });
  assert.equal(byLayer[0].text, 'Stage left');
});

/* ================================================================ layout */

const style = (over = {}) => normalise({ style: over }).style;

test('over the pictures, a label is a tab inside the bottom of its box and a line between two boxes is one line', () => {
  const boxes = [
    { key: '1', rect: { left: 0, top: 0, width: 960, height: 540 }, text: 'Camera 1' },
    { key: '2', rect: { left: 960, top: 0, width: 960, height: 540 }, text: 'Camera 2' }
  ];
  const plan = layout(boxes, CANVAS, style(), { target: 'layer', labels: 'bottom' });
  assert.equal(plan.border, 2, 'two pixels at 1080');
  const tab = plan.items[0].tab;
  assert.equal(tab.top + tab.height, 540 - 2, 'flush with the bottom edge, inside the line');
  assert.equal(Math.round(tab.left + tab.width / 2), 480, 'centred');
  /* The shared edge at x = 960: box 1's right band and box 2's left band are the same two pixels. */
  const right = plan.items[0].borders[3];
  const left = plan.items[1].borders[2];
  assert.equal(right.left, 959);
  assert.equal(left.left, 959);
  assert.equal(right.width, 2);
  assert.equal(autoBorder({ width: 3840, height: 2160 }), 4);
});

test('under the layers, the line is outside the box and an inside label is reported as hidden', () => {
  const boxes = [{ key: '1', rect: { left: 100, top: 100, width: 960, height: 540 }, text: 'Camera 1' }];
  const bands = borderBands(boxes[0].rect, 4, 'background', CANVAS);
  assert.deepEqual(bands[0], { left: 96, top: 96, width: 968, height: 4 }, 'wholly outside');
  const inside = layout(boxes, CANVAS, style(), { target: 'background', labels: 'bottom' });
  assert.match(inside.items[0].notes.join(' '), /under L1/);
  const below = layout(boxes, CANVAS, style(), { target: 'background', labels: 'below' });
  assert.equal(below.items[0].notes.length, 0, 'under the box, it shows');
  assert.equal(below.items[0].tab.top, 100 + 540 + 2);
});

test('a label with no room under its box goes inside it, and says so', () => {
  const plan = layout([{ key: '1', rect: { left: 0, top: 0, width: 1920, height: 1080 }, text: 'Programme' }], CANVAS, style(), { target: 'background', labels: 'below' });
  assert.equal(plan.items[0].tab.where, 'bottom');
  assert.match(plan.items[0].notes.join(' '), /no room under this box/);
});

test('a long name shrinks to fit, then is cut short with an ellipsis', () => {
  const box = { key: '1', rect: { left: 0, top: 0, width: 160, height: 90 }, text: 'The extremely long camera name' };
  const plan = layout([box], CANVAS, style(), { target: 'layer', labels: 'bottom', measure: roughMeasure });
  const tab = plan.items[0].tab;
  assert.ok(tab.width <= 160 - 2 * plan.border, 'inside its box');
  assert.ok(tab.text.endsWith('…'));
  assert.match(plan.items[0].notes[0], /too long/);
  const caps = layout([{ ...box, text: 'cam' }], CANVAS, style({ uppercase: true }), { labels: 'top' });
  assert.equal(caps.items[0].tab.text, 'CAM');
  assert.equal(layout([box], CANVAS, style(), { labels: 'none' }).items[0].tab, null);
});

test('the fingerprint changes with what is drawn and nothing else', () => {
  const boxes = [{ key: '1', rect: { left: 0, top: 0, width: 960, height: 540 }, text: 'A' }];
  const a = fingerprint(layout(boxes, CANVAS, style()));
  assert.equal(a, fingerprint(layout(boxes, CANVAS, style())));
  assert.notEqual(a, fingerprint(layout([{ ...boxes[0], text: 'B' }], CANVAS, style())));
  assert.notEqual(a, fingerprint(layout([{ ...boxes[0], rect: { ...boxes[0].rect, left: 2 } }], CANVAS, style())));
});

/* ================================================================ render */

test('the drawing clears to transparent, then fills the lines and the tabs, then the names', () => {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (k === 'measureText' ? () => ({ width: 10 }) : (...a) => calls.push([k, ...a])),
    set: (_, k, v) => { calls.push([`=${String(k)}`, v]); return true; }
  });
  const plan = layout([{ key: '1', rect: { left: 0, top: 0, width: 960, height: 540 }, text: 'Cam' }], CANVAS, style({ tabOpacity: 0.5 }));
  draw(ctx, plan);
  assert.deepEqual(calls[0], ['clearRect', 0, 0, 1920, 1080]);
  const fills = calls.filter((c) => c[0] === 'fillRect');
  assert.equal(fills.length, plan.items[0].borders.length + 1);
  assert.ok(calls.some((c) => c[0] === '=fillStyle' && c[1] === 'rgba(0, 0, 0, 0.5)'));
  assert.ok(calls.some((c) => c[0] === 'fillText' && c[1] === 'Cam'));
});

/* ================================================================ writes */

test('a layer is placed through its own anchor, position and size together', () => {
  const store = auxStore();
  const rect = { left: 100, top: 50, width: 640, height: 360 };
  for (const key of ['1', '2']) {
    const w = placeWrites(store, 'A1', 'B', key, rect);
    const v = Object.fromEntries(w.map((x) => [x.path.at(-1), x.value]));
    const anchor = store.get(['device', 'auxiliaryList', 'items', 'A1', 'presetList', 'items', 'B', 'layerList', 'items', key, 'position', 'pp', 'anchor']);
    assert.deepEqual(anchorToTopLeft(anchor, v.posH, v.posV, v.sizeH, v.sizeV), { left: 100, top: 50 }, `${anchor} lands at the corner`);
  }
});

test('the UMD layer takes the still over the whole canvas, and only the clean-up its layer needs', () => {
  const store = auxStore({ preview: { 8: layerNode({ source: 'LIVE_1', left: 10, top: 10, width: 100, height: 100, crop: 20 }) } });
  const w = umdLayerWrites(store, a1(store), 'B', '8', 48);
  const tail = (x) => x.path.slice(x.path.indexOf('items', 10) + 2).join('/');
  const byTail = Object.fromEntries(w.map((x) => [x.path.slice(-3).join('/'), x.value]));
  assert.equal(w[0].value, 'STILL_48');
  assert.equal(byTail['position/pp/sizeH'], 1920);
  assert.equal(byTail['position/pp/posH'], 960);
  assert.equal(byTail['classic/pp/top'], 0, 'its crop is taken off');
  assert.ok(!w.some((x) => x.path.includes('border') || x.path.includes('keying')), 'an aux layer has no border or keyer, so none is written');
  assert.ok(!w.some((x) => x.path.includes('effects')), 'a value already held is not written');
  assert.ok(w.every((x) => tail(x)));
  assert.deepEqual(cleanWrites(store, 'A1', 'B', '1'), [], 'a clean layer needs nothing');
});

test('a template places the box layers, empties the ones it does not use, and leaves the UMD’s alone', () => {
  const store = auxStore();
  const w = templateWrites(store, a1(store), 'B', templateById('three-two-over-one'), KEYS.slice(0, 7));
  const layersTouched = new Set(w.map((x) => x.path[x.path.indexOf('layerList') + 2]));
  assert.deepEqual([...layersTouched], KEYS.slice(0, 7));
  const emptied = w.filter((x) => x.value === 'NONE').map((x) => x.path[x.path.indexOf('layerList') + 2]);
  assert.deepEqual(emptied, ['4', '5', '6', '7']);
  assert.ok(!w.some((x) => x.path[x.path.indexOf('layerList') + 2] === '1' && x.path.includes('source')), 'a box keeps its source');
});

/* ======================================================== slot and still */

test('the picture takes the highest free slot and still, or reuses its own', () => {
  const store = auxStore();
  const lib = readLibrary(store);
  assert.deepEqual(chooseSlot(lib, 'A1'), { slot: 200, reused: false, wasFree: true, stills: [] });
  const stills = readStills(store);
  assert.equal(chooseStill(stills, CANVAS).still.key, '48');
  assert.match(chooseStill(stills, { width: 3840, height: 2160 }).reason, /too small/);
  const ours = { slot: 199, still: 46 };
  store.set(['device', 'stillList', 'library', 'bankList', 'items', '199', 'status', 'pp', 'isValid'], true);
  store.set(['device', 'stillList', 'library', 'bankList', 'items', '199', 'status', 'pp', 'fileName'], fileName('A1'));
  store.set(['device', 'stillList', 'items', '46', 'control', 'pp', 'mode'], 'IMAGE');
  store.set(['device', 'stillList', 'items', '46', 'control', 'pp', 'source'], 199);
  assert.deepEqual(chooseSlot(readLibrary(store), 'A1', ours), { slot: 199, reused: true, wasFree: false, stills: [] });
  const again = chooseStill(readStills(store), CANVAS, ours);
  assert.equal(again.still.key, '46');
  assert.equal(again.reused, true);
  store.set(['device', 'stillList', 'library', 'bankList', 'items', '199', 'status', 'pp', 'fileName'], 'someone-else.png');
  assert.equal(chooseSlot(readLibrary(store), 'A1', ours).slot, 200, 'a slot somebody refilled is theirs');
});

test('an empty slot a still points at is only taken when allowed, after every clean one, and says who will show the UMD', () => {
  const store = auxStore();
  const set = (n, prop, v) => store.set(['device', 'stillList', 'items', String(n), 'control', 'pp', prop], v);
  const lib = readLibrary(store);
  const pick = (placed = null, assigned = false) => chooseSlot(lib, 'A1', placed, { empty: emptySlots(store), assigned });
  /* Image 46 points at empty slot 200, the one the UMD would take: 199 instead. */
  set(46, 'mode', 'IMAGE');
  set(46, 'source', 200);
  assert.deepEqual(pick(), { slot: 199, reused: false, wasFree: true, stills: [] });
  /* Both empty slots pointed at: refused without the option, taken with it. */
  set(48, 'mode', 'IMAGE');
  set(48, 'source', 199);
  const none = pick();
  assert.equal(none.slot, null);
  assert.match(none.reason, /Every empty library slot has a still pointing at it.*Tick “Use an empty slot a still points at”/);
  const allowed = pick(null, true);
  assert.equal(allowed.slot, 199);
  assert.deepEqual(allowed.stills.map((s) => s.name), ['Image 48']);
  /* Our own slot, emptied since: ours again if only our still points at it… */
  assert.deepEqual(pick({ slot: 199, still: 48 }), { slot: 199, reused: false, wasFree: true, stills: [] });
  /* …and not if another still has come to point at it. */
  set(46, 'source', 199);
  assert.equal(pick({ slot: 199, still: 48 }).slot, 200, 'the clean slot instead');
  assert.deepEqual(pick({ slot: 199, still: 48 }, true).stills.map((s) => s.key), ['46']);
});

/* ================================================================= apply */

/** A switcher in miniature: every write is echoed inbound a millisecond later, and an upload validates its slot. */
function standIn(store) {
  const session = new EventTarget();
  session.store = store;
  const log = [];
  const uploads = [];
  const report = (path, value) => {
    const changed = !same(store.get(path), value);
    store.set(path, value);
    if (changed) session.dispatchEvent(new CustomEvent('frame', { detail: { path, value, dir: 'in' } }));
  };
  session.send = ({ path, value }) => {
    log.push([path.join('/'), value]);
    setTimeout(() => {
      report(path, value);
      const p = path.join('/');
      if (/library\/bankList\/items\/\d+\/control\/pp\/xDelete$/.test(p) && value === true) report([...path.slice(0, -3), 'status', 'pp', 'isValid'], false);
    }, 1);
    return true;
  };
  let hash = 0;
  const fetchImpl = async (url, init) => {
    const slot = Number(init.body.get('librarySlot'));
    const file = init.body.get('FILES');
    uploads.push([url, slot, file.name]);
    const base = ['device', 'stillList', 'library', 'bankList', 'items', String(slot), 'status', 'pp'];
    setTimeout(() => {
      report([...base, 'isValid'], true);
      report([...base, 'fileName'], file.name);
      report([...base, 'hashName'], `h${++hash}`);
    }, 2);
    return { ok: true, status: 200, json: async () => ({ [file.name]: 'FINISH' }), text: async () => '' };
  };
  return { session, log, uploads, fetchImpl };
}

const png = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
const at = (store, ...p) => store.get(['device', ...p]);

test('put: the picture into a free slot, a free still onto it, and the top layer onto the still — then an update is one upload, and Undo takes it all back', async () => {
  const store = auxStore();
  const { session, log, uploads, fetchImpl } = standIn(store);
  const steps = [];
  const first = await putOnLayer({ session, dest: a1(store), letter: 'B', layer: '8', blob: png(), fetchImpl, onStep: (t, s) => steps.push([s, t]) });
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(uploads, [['/api/device/images/upload', 200, 'umd-A1.png']]);
  assert.deepEqual(first.placed, { slot: 200, still: 48, layer: '8', letter: 'B' });
  assert.equal(at(store, 'stillList', 'items', '48', 'control', 'pp', 'mode'), 'IMAGE');
  assert.equal(at(store, 'stillList', 'items', '48', 'control', 'pp', 'rescale'), 'NO_RESCALE');
  assert.equal(at(store, 'auxiliaryList', 'items', 'A1', 'presetList', 'items', 'B', 'layerList', 'items', '8', 'source', 'pp', 'inputNum'), 'STILL_48');
  assert.equal(at(store, 'auxiliaryList', 'items', 'A1', 'presetList', 'items', 'A', 'layerList', 'items', '8', 'source', 'pp', 'inputNum'), 'NONE', 'program is not touched');
  const order = log.map(([p]) => p);
  assert.ok(order.findIndex((p) => p.includes('stillList/items/48')) < order.findIndex((p) => p.includes('layerList/items/8')), 'the still is filled before the layer shows it');

  log.length = 0;
  const second = await putOnLayer({ session, dest: a1(store), letter: 'B', layer: '8', blob: png(), placed: first.placed, fetchImpl });
  assert.equal(second.ok, true, second.error);
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1][1], 200, 'the same slot');
  assert.deepEqual(second.journal.stills, [], 'the still is left as it is: it follows the new file');
  assert.deepEqual(second.journal.uploads, [], 'a slot that held our file is not ours to empty');
  assert.ok(!log.some(([p]) => p.includes('stillList/items/48')), 'nothing is written to the still');

  const back = await revert({ session, journal: first.journal });
  assert.equal(back.ok, true, back.problems.join(', '));
  assert.equal(at(store, 'auxiliaryList', 'items', 'A1', 'presetList', 'items', 'B', 'layerList', 'items', '8', 'source', 'pp', 'inputNum'), 'NONE');
  assert.equal(at(store, 'stillList', 'items', '48', 'control', 'pp', 'mode'), 'NONE');
  assert.equal(at(store, 'stillList', 'library', 'bankList', 'items', '200', 'status', 'pp', 'isValid'), false, 'the slot it filled is emptied');
});

test('experimental: put on an aux’s background writes the still as its NATIVE source, and Undo puts NONE back', async () => {
  const store = auxStore();
  const { session, log, fetchImpl } = standIn(store);
  const res = await putOnLayer({ session, dest: a1(store), letter: 'B', layer: 'NATIVE', blob: png(), fetchImpl });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.placed, { slot: 200, still: 48, layer: 'NATIVE', letter: 'B' });
  const native = (b) => at(store, 'auxiliaryList', 'items', 'A1', 'presetList', 'items', b, 'layerList', 'items', 'NATIVE', 'source', 'pp', 'inputNum');
  assert.equal(native('B'), 'STILL_48');
  assert.equal(native('A'), 'NONE', 'program is not touched');
  assert.ok(!log.some(([p]) => /layerList\/items\/\d+\//.test(p)), 'no picture layer is written');
  const back = await revert({ session, journal: res.journal });
  assert.equal(back.ok, true, back.problems.join(', '));
  assert.equal(native('B'), 'NONE');
});

test('put refuses, writing nothing, when there is no still to hold the picture', async () => {
  const store = auxStore();
  for (const k of ['46', '48']) store.set(['device', 'stillList', 'items', k, 'control', 'pp', 'mode'], 'IMAGE');
  const { session, uploads, fetchImpl } = standIn(store);
  const res = await putOnLayer({ session, dest: a1(store), letter: 'B', layer: '8', blob: png(), fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.error, /No still is free/);
  assert.deepEqual(uploads, []);
});

test('a template is laid out through the echo, and Undo puts every layer back', async () => {
  const store = auxStore();
  const { session } = standIn(store);
  const dest = a1(store);
  const res = await applyTemplate({ session, dest, letter: 'B', template: templateById('seven-quad'), boxLayers: KEYS.slice(0, 7) });
  assert.equal(res.ok, true);
  const boxes = readBoxes(store, dest, 'B', { umd: '8', names: Object.fromEntries(KEYS.map((k) => [k, `Box ${k}`])) });
  assert.deepEqual(boxes.map((b) => b.rect), templateRects(templateById('seven-quad'), CANVAS));
  const back = await revert({ session, journal: res.journal });
  assert.equal(back.ok, true);
  assert.deepEqual(readBoxes(store, dest, 'B', { umd: '8' }).map((b) => b.rect), [
    { left: 0, top: 0, width: 960, height: 540 }, { left: 960, top: 0, width: 960, height: 540 }, { left: 480, top: 540, width: 960, height: 540 }
  ]);
});

/* ================================================================= panel */

import { install } from './helpers/fake-dom.js';

/**
 * The page half itself, booted through a stand-in ctx over the 8-layer aux:
 * the tab it registers draws the layout, a row per box layer, the look and
 * the preview, and offers the put — and a screen offers the Background
 * Slicer instead, or says to switch it on.
 */
test('the tab draws A1’s layers, names, look and preview, and a screen’s hand-over', async () => {
  const dom = install();
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  try {
    const store = auxStore();
    const session = new EventTarget();
    session.store = store;
    session.send = () => true;
    const tabs = [];
    let backgrounds = null;
    const { default: activate } = await import('../plugins/umd/client.js');
    await activate({
      id: 'umd', session, can: () => true, refresh() {}, url: (p = '/') => `/__lpp/umd${p === '/' ? '' : p}`,
      use: (name) => (name === 'backgrounds' ? backgrounds : null), provide() {}, share() {},
      log: { info() {}, warn() {} },
      ui: { tab: (e) => tabs.push(e), sidebar() {}, settingsSection() {} }
    });
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].id, 'umd');
    const root = tabs[0].render();
    const text = root.textContent;
    assert.match(text, /A1 has 8 layers: L8 carries the UMD, L1–L7 are the boxes/);
    const names = root.querySelectorAll('input[type="text"]').filter((i) => / name$/.test(i.getAttribute('aria-label')));
    assert.deepEqual(names.map((i) => i.getAttribute('aria-label')), KEYS.slice(0, 7).map((k) => `L${k} name`), 'a row per box layer');
    assert.equal(names[0].getAttribute('placeholder'), 'Camera 1');
    assert.equal(names[3].getAttribute('placeholder'), 'empty — not drawn');
    assert.match(text, /Put on L8 · PRW/);
    assert.match(text, /Use an empty slot a still points at/, 'the choice is offered beside the first put');
    assert.match(text, /1920×1080, transparent but for 3 boxes/);
    const options = root.querySelectorAll('option').map((o) => o.textContent);
    for (const t of ['7 · Three and four', '5 · Two over three', '3 · Two over one', '1 · Full']) assert.ok(options.includes(t), `${t} is offered`);
    assert.strictEqual(tabs[0].render(), root, 'nothing changed, nothing rebuilt');

    const screen = root.querySelector('select[aria-label="Destination"]');
    screen.value = 'S1';
    screen.dispatchEvent({ type: 'change' });
    const s1 = tabs[0].render().textContent;
    assert.match(s1, /goes on its background, under them/);
    assert.match(s1, /switch it on in Preconfig/);
    backgrounds = { offer: async () => ({ width: 1920, height: 1080 }) };
    assert.doesNotMatch(tabs[0].render().textContent, /switch it on in Preconfig/);
  } finally {
    globalThis.fetch = fetchBefore;
    dom.uninstall();
  }
});

/*
 * On a Midra 4K the picture is the same arithmetic over the mng dialect's
 * layers, and only Download is offered: putting it on the switcher reads
 * LivePremier's library and stills. Against the Midra 4K simulator's store.
 */
test('on a Midra the tab draws and offers the PNG, and writes nothing', async () => {
  const dom = install();
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  try {
    const store = new DeviceStore();
    store.hydrate(fixture('midra-3.2.29-pulse4k.json'));
    const session = new EventTarget();
    session.store = store;
    const sent = [];
    session.send = (w) => { sent.push(w); return true; };
    const tabs = [];
    const { default: activate } = await import('../plugins/umd/client.js');
    await activate({
      id: 'umd', session, can: () => false, refresh() {}, url: (p = '/') => `/__lpp/umd${p === '/' ? '' : p}`,
      use: () => null, provide() {}, share() {}, log: { info() {}, warn() {} },
      ui: { tab: (e) => tabs.push(e), sidebar() {}, settingsSection() {} }
    });
    const root = tabs[0].render();
    const text = root.textContent;
    assert.match(text, /Download PNG/);
    assert.doesNotMatch(text, /Waiting for the switcher/);
    const put = root.querySelectorAll('button').find((b) => /Put on|Update UMD|Lay out/.test(b.textContent));
    if (put) assert.ok(put.getAttribute('disabled') !== null, 'no write is offered on a Midra');
    assert.deepEqual(sent, []);
  } finally {
    globalThis.fetch = fetchBefore;
    dom.uninstall();
  }
});
