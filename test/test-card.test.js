/*
 * Test Card: Test Card's patterns, drawn for the switcher's outputs and
 * canvases and put on a destination's top layer through a still.
 *
 * Offline: the settings and the document, the card geometry (canvas and
 * per-output, rotation, pitch, the box round several outputs), the layer a
 * card goes on and whether it fits, the journal that Off puts back, the
 * drawing through a recording context, and the tab on the vendor's strips
 * over a fake DOM. The writes themselves are `core/still-layer.js`'s, tested
 * in `umd.test.js` against a stand-in switcher; the whole of it was run on a
 * LivePremier Simulator 6.2.73 (docs/NOTES.md, 2026-10-20).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DeviceStore } from '../src/core/device-store.js';
import { canvasTopology, screenTopology, readCanvases } from '../src/core/backgrounds.js';
import { chooseSlot, chooseStill } from '../src/core/still-layer.js';
import {
  KINDS, OPTIONS, normaliseSettings, normalise, withDest, toggleOutput, homeOf, cardOutput, cardPlan, layerFor,
  mergeJournal, trimJournal, fingerprint, outputOfPage, fileName, stillLabel, moves, setPath, getPath
} from '../plugins/test-card/core.js';
import { drawPlan } from '../plugins/test-card/render.js';
import { pageOf, selectedCanvas, installTestCardTab } from '../plugins/test-card/decorate.js';
import { DEFAULT_SETTINGS, PATTERN_LABELS } from '../src/vendor/test-card/engine.js';
import { install } from './helpers/fake-dom.js';

/* ------------------------------------------------------- synthetic stores */

const sliceItem = (left, top, w, h) => ({ pp: { top, left }, aoi: { pp: { top: 0, left: 0, width: w, height: h } } });

/** One output node, in the device's own shape (as `bg-slicer.test.js` builds it). */
function outputNode({ dest, left = 0, top = 0, w, h, ratio = 1000, rotation = 'NONE', group = '1X1', state = 'USED', slices = null, label = '' }) {
  const list = slices || [[0, 0, w, h]];
  const odd = rotation === '90_DEGREE' || rotation === '270_DEGREE';
  const fw = Math.floor(((odd ? h : w) * ratio) / 1000);
  const fh = Math.floor(((odd ? w : h) * ratio) / 1000);
  return {
    mapping: { pp: { device: '1', isValid: true } },
    control: { pp: { label } },
    status: { pp: { format: 'HDTV_1080P', rate: 60000, sizeH: w, sizeV: h } },
    plugList: { itemKeys: ['1'], items: { 1: { status: { pp: { type: 'HDMI' } } } } },
    canvas: {
      cmd: { pp: { pitchRatioH: ratio, pitchRatioV: ratio, rotation } },
      status: {
        pp: { isEnabled: state, usedInScreenAux: dest, group, capability: 'DUAL', rotation, left, top, pitchedWidth: fw, pitchedHeight: fh, clampedWidth: fw, clampedHeight: fh, maxWidth: w, maxHeight: h },
        slices: {
          pp: { mode: 'FREE', count: list.length },
          boundingBox: { pp: { left: 0, top: 0, width: w, height: h } },
          sliceList: { itemKeys: ['1', '2', '3', '4'], items: Object.fromEntries([0, 1, 2, 3].map((i) => [String(i + 1), list[i] ? sliceItem(...list[i]) : sliceItem(0, 0, w, h)])) }
        }
      }
    }
  };
}

const layerList = (caps) => ({
  itemKeys: ['NATIVE', ...Object.keys(caps)],
  items: {
    NATIVE: { status: { pp: { capability: 'OFF' } } },
    ...Object.fromEntries(Object.entries(caps).map(([k, c]) => [k, { status: { pp: { capability: c } } }]))
  }
});

/** A LivePremier-shaped store: screens (and an aux) with canvases, layers, and outputs on them. */
function store({ screens = { S1: [3840, 1080] }, auxes = {}, outputs, layers = { S1: { 1: 'DUAL', 2: '4K' } } }) {
  const s = new DeviceStore();
  const ids = [...Object.keys(screens), ...Object.keys(auxes)];
  const dest = (size, id) => ({
    control: { pp: { label: '' } },
    status: { pp: { mode: 'FREESTYLE' }, size: { pp: { sizeH: size[0], sizeV: size[1] } } },
    layerList: layerList(layers[id] || {})
  });
  s.hydrate({
    device: {
      screenAuxGroupList: { itemKeys: ids, items: Object.fromEntries(ids.map((id) => [id, { control: { pp: { presetUp: 'B', presetDown: 'A' } }, status: { pp: { isUsed: true, transition: 'AT_UP' } } }])) },
      screenList: { itemKeys: Object.keys(screens), items: Object.fromEntries(Object.entries(screens).map(([id, size]) => [id, dest(size, id)])) },
      auxiliaryList: { itemKeys: Object.keys(auxes), items: Object.fromEntries(Object.entries(auxes).map(([id, size]) => [id, dest(size, id)])) },
      outputList: { itemKeys: Object.keys(outputs), items: outputs }
    }
  });
  return s;
}

const twoUp = () => store({
  outputs: {
    1: outputNode({ dest: 'S1', left: 0, w: 1920, h: 1080, label: 'LEFT' }),
    2: outputNode({ dest: 'S1', left: 1920, w: 1920, h: 1080 })
  }
});

/* ============================================================== settings */

test('settings: Test Card’s defaults, a stored pattern and options kept, anything else held to range', () => {
  const s = normaliseSettings({ kind: 'grid', grid: { spacingPx: 2, diagonals: 'yes', labelCells: true }, levels: 'loud', overlay: { customText: 'x'.repeat(200) } });
  assert.equal(s.kind, 'grid');
  assert.equal(s.grid.spacingPx, 4, 'below the minimum is the minimum');
  assert.equal(s.grid.diagonals, DEFAULT_SETTINGS.grid.diagonals, 'a value of the wrong type is the default');
  assert.equal(s.grid.labelCells, true);
  assert.equal(s.levels, 'full');
  assert.equal(s.overlay.customText.length, 60);
  assert.equal(normaliseSettings({ kind: 'image' }).kind, DEFAULT_SETTINGS.kind, 'your image is not offered here');
  assert.equal(normaliseSettings({ broken: { base: 'broken-wall' } }).broken.base, DEFAULT_SETTINGS.broken.base);
  assert.equal(normaliseSettings({ animation: { stillAtSeconds: 99, seconds: 10 } }).animation.stillAtSeconds, 0, 'a frame inside the loop');
});

test('the catalogue: every pattern offered is Test Card’s, has a label, and its options are real paths', () => {
  for (const k of KINDS) {
    assert.ok(PATTERN_LABELS[k], k);
    for (const spec of OPTIONS[k]) assert.notEqual(getPath(DEFAULT_SETTINGS, spec.path), undefined, `${k} ${spec.path}`);
  }
  assert.ok(moves('ocean') && !moves('grid'));
  assert.deepEqual(getPath(setPath({ a: { b: 1 } }, 'a.c', 2), 'a'), { b: 1, c: 2 });
});

/* ============================================================== document */

test('the document keeps what is on and its journal, and drops the rest', () => {
  const doc = normalise({
    dests: {
      S1: { mode: 'outputs', outputs: ['3', 1, 'x', '3'], placed: { slot: 200, still: 48, layer: '2', letter: 'B', rect: { left: 0, top: 0, width: 1920, height: 1080 } } },
      A1: { mode: 'canvas', layout: 'across' },
      S2: { mode: 'outputs', outputs: [] },
      Z9: { mode: 'canvas' },
      S3: { journal: { id: 'S3', writes: [{ path: ['device', 'x'], value: 'NONE' }], stills: [], uploads: ['200'] } }
    }
  });
  assert.deepEqual(Object.keys(doc.dests).sort(), ['A1', 'S1', 'S3']);
  assert.deepEqual(doc.dests.S1.outputs, ['1', '3']);
  assert.equal(doc.dests.S1.placed.still, 48);
  assert.equal(doc.dests.A1.layout, 'across');
  assert.deepEqual(doc.dests.S3.journal.uploads, [200], 'a journal is kept with nothing on, so Off can still put it back');
  assert.equal(withDest(doc, 'S1', { mode: null, outputs: [], placed: null }).dests.S1, undefined);
});

test('an output’s card on and off: added to the outputs, replacing a canvas card, and off when the last goes', () => {
  const empty = normalise(null).dests.S1 || { mode: null, outputs: [], layout: 'per-output' };
  const one = toggleOutput(empty, '3', true);
  assert.deepEqual([one.mode, one.outputs], ['outputs', ['3']]);
  const two = toggleOutput(one, '1', true);
  assert.deepEqual(two.outputs.sort(), ['1', '3']);
  assert.deepEqual(toggleOutput({ ...two, mode: 'canvas' }, '5', true).outputs, ['5'], 'a canvas card is replaced');
  const back = toggleOutput(toggleOutput(two, '1', false), '3', false);
  assert.equal(back.mode, null);
  assert.equal(outputOfPage('/outputs/12/pattern'), '12');
  assert.equal(outputOfPage('/preconfig/resources/outputs'), null);
  assert.equal(fileName('S1'), 'testcard-S1.png');
  assert.ok(stillLabel('S12').length <= 16);
});

/* ============================================================== geometry */

test('topology: the Canvas page reads auxes as well as screens; the Background Slicer still reads screens only', () => {
  const s = store({
    screens: { S1: [1920, 1080] }, auxes: { A1: [1280, 720] },
    outputs: { 1: outputNode({ dest: 'S1', w: 1920, h: 1080 }), 5: outputNode({ dest: 'A1', w: 1280, h: 720 }) },
    layers: { S1: { 1: 'DUAL' }, A1: { 1: 'DUAL', 2: 'DUAL' } }
  });
  assert.deepEqual(readCanvases(s).map((d) => [d.id, d.kind]), [['S1', 'screen'], ['A1', 'aux']]);
  assert.equal(canvasTopology(s, 'A1').outputs[0].key, '5');
  assert.equal(screenTopology(s, 'A1'), null);
  assert.equal(screenTopology(s, 'S1').outputs.length, 1);
});

test('a card output is in canvas orientation: a turned output’s raster is turned, its footprint is where it is', () => {
  const s = store({ screens: { S1: [1080, 1920] }, outputs: { 1: outputNode({ dest: 'S1', w: 1920, h: 1080, rotation: '90_DEGREE', label: 'PORTRAIT' }) }, layers: { S1: { 1: 'DUAL' } } });
  const o = cardOutput(canvasTopology(s, 'S1').outputs[0]);
  assert.deepEqual([o.widthPx, o.heightPx], [1080, 1920]);
  assert.deepEqual(o.compositionRect, { x: 0, y: 0, width: 1080, height: 1920 });
  assert.equal(o.name, 'Out 1 · PORTRAIT');
  assert.match(o.device, /^1920×1080 · HDMI · turned 90°$/);
});

test('a pitched output: the footprint is not the raster, and the plan says it is not pixel for pixel', () => {
  const s = store({ screens: { S1: [2112, 1188] }, outputs: { 1: outputNode({ dest: 'S1', w: 1920, h: 1080, ratio: 1100 }) }, layers: { S1: { 1: '4K' } } });
  const plan = cardPlan(canvasTopology(s, 'S1'), { mode: 'outputs', outputs: ['1'] });
  assert.deepEqual(plan.rect, { left: 0, top: 0, width: 2112, height: 1188 });
  assert.deepEqual([plan.outputs[0].widthPx, plan.outputs[0].heightPx], [1920, 1080], 'drawn at the raster, scaled into the footprint');
  assert.deepEqual(plan.inexact, ['1']);
});

test('the canvas card covers the canvas; across the canvas it is one output with every output a region', () => {
  const topo = canvasTopology(twoUp(), 'S1');
  const per = cardPlan(topo, { mode: 'canvas', layout: 'per-output' });
  assert.deepEqual(per.rect, { left: 0, top: 0, width: 3840, height: 1080 });
  assert.deepEqual(per.outputs.map((o) => o.compositionRect.x), [0, 1920]);
  assert.equal(per.whole, undefined);
  const across = cardPlan(topo, { mode: 'canvas', layout: 'across' });
  assert.deepEqual([across.whole.widthPx, across.whole.heightPx], [3840, 1080]);
  assert.deepEqual(across.whole.regions.map((r) => [r.label, r.rect.x]), [['Out 1 · LEFT', 0], ['Out 2', 1920]]);
  assert.deepEqual(across.inexact, []);
});

test('output cards: the picture is the box round the outputs that are on, and only those are drawn', () => {
  const topo = canvasTopology(twoUp(), 'S1');
  const right = cardPlan(topo, { mode: 'outputs', outputs: ['2'] });
  assert.deepEqual(right.rect, { left: 1920, top: 0, width: 1920, height: 1080 });
  assert.deepEqual(right.outputs.map((o) => o.id), ['2']);
  const both = cardPlan(topo, { mode: 'outputs', outputs: ['1', '2'] });
  assert.deepEqual(both.rect, { left: 0, top: 0, width: 3840, height: 1080 });
  assert.match(cardPlan(topo, { mode: 'outputs', outputs: ['9'] }).problem, /None of output 9/);
  assert.match(cardPlan(null, { mode: 'canvas' }).problem, /Not in service/);
});

test('a canvas past the browser’s canvas limit is refused rather than drawn blank', () => {
  const s = store({ screens: { S1: [20000, 1080] }, outputs: { 1: outputNode({ dest: 'S1', w: 1920, h: 1080 }) } });
  assert.match(cardPlan(canvasTopology(s, 'S1'), { mode: 'canvas', layout: 'per-output' }).problem, /per-side canvas limit/);
});

test('which destination an output’s card goes on, or why it has none', () => {
  const s = store({
    screens: { S1: [3840, 1080] },
    outputs: {
      1: outputNode({ dest: 'S1', w: 1920, h: 1080 }),
      2: outputNode({ dest: 'S1', w: 1920, h: 1080, state: 'GROUPED' }),
      7: outputNode({ dest: '', w: 1920, h: 1080 })
    }
  });
  const topos = readCanvases(s).map((d) => canvasTopology(s, d.id));
  assert.equal(homeOf(topos, '1').dest.id, 'S1');
  assert.match(homeOf(topos, '2').reason, /a member of an output group/);
  assert.match(homeOf(topos, '7').reason, /on no screen or aux/);
});

/* ================================================================ layers */

test('the card goes on the top layer, if that layer can carry a picture its size', () => {
  const s = twoUp();
  const fits = layerFor(s, 'S1', { width: 1920, height: 1080 });
  assert.deepEqual([fits.layer, fits.capability, fits.fits], ['2', '4K', true]);
  const big = layerFor(s, 'S1', { width: 5120, height: 2160 });
  assert.equal(big.fits, false);
  assert.match(big.reason, /L2, is 4K, and a 5120×2160 card needs 5K/);
  const none = store({ outputs: { 1: outputNode({ dest: 'S1', w: 1920, h: 1080 }) }, layers: { S1: {} } });
  assert.match(layerFor(none, 'S1', { width: 1920, height: 1080 }).reason, /no layer/);
});

test('the still and the slot: another destination’s are skipped, and a refusal names the picture', () => {
  const library = { slots: [199, 200].map((slot) => ({ slot, free: true, fileName: '' })) };
  assert.equal(chooseSlot(library, 'testcard-S1.png').slot, 200);
  assert.equal(chooseSlot(library, 'testcard-S2.png', null, { skip: [200] }).slot, 199);
  const pointed = chooseSlot(library, 'x.png', null, { empty: [{ slot: 200, stills: [{ key: '1', name: 'Image 1' }] }], what: 'the test card' });
  assert.match(pointed.reason, /which would show the test card as well/);
  const stills = [{ key: '47', free: true, capability: 'DUAL' }, { key: '48', free: true, capability: 'DUAL' }];
  assert.equal(chooseStill(stills, { width: 1920, height: 1080 }).still.key, '48');
  assert.equal(chooseStill(stills, { width: 1920, height: 1080 }, null, { skip: ['48'] }).still.key, '47');
});

/* =============================================================== journal */

test('the journal keeps what was there before the first write, and adds only what is new', () => {
  const p = (k) => ['device', 'screenList', 'items', 'S1', 'presetList', 'items', 'B', 'layerList', 'items', '2', k];
  const first = { id: 'S1', writes: [{ path: p('source'), value: 'LIVE_3' }, { path: p('sizeH'), value: 960 }], stills: [{ still: '48', before: { mode: 'NONE' } }], uploads: [200] };
  const again = { id: 'S1', writes: [{ path: p('source'), value: 'STILL_48' }, { path: p('sizeH'), value: 1920 }, { path: p('posH'), value: 960 }], stills: [], uploads: [] };
  const merged = mergeJournal(first, again);
  assert.deepEqual(merged.writes.map((w) => [w.path.at(-1), w.value]), [['source', 'LIVE_3'], ['sizeH', 960], ['posH', 960]]);
  assert.deepEqual(merged.uploads, [200]);
  assert.deepEqual(merged.stills.map((s) => s.still), ['48']);
  assert.equal(mergeJournal(null, { id: 'S1', writes: [], stills: [], uploads: [] }), null, 'nothing written is no journal');
});

test('Off takes back only what is still the card’s: a layer, still or slot somebody has reused is left alone', () => {
  const layer = (b, k, leaf) => ['device', 'screenList', 'items', 'S1', 'presetList', 'items', b, 'layerList', 'items', k, ...leaf];
  const journal = {
    id: 'S1',
    writes: [{ path: layer('B', '2', ['source', 'pp', 'inputNum']), value: 'LIVE_3' }, { path: layer('B', '2', ['position', 'pp', 'sizeH']), value: 960 }],
    stills: [{ still: '48', before: { mode: 'NONE' } }],
    uploads: [200]
  };
  const placed = { slot: 200, still: 48, layer: '2', letter: 'B' };
  const at = (map) => (path) => map[path.join('/')];
  const showing = (v) => at({ [layer('B', '2', ['source', 'pp', 'inputNum']).join('/')]: v });
  const mine = { get: showing('STILL_48'), stills: [{ key: '48', mode: 'IMAGE', source: 200 }], library: [{ slot: 200, fileName: 'testcard-S1.png', free: false }] };
  assert.deepEqual(trimJournal(journal, placed, 'testcard-S1.png', mine), { journal, left: [] });

  const reused = trimJournal(journal, placed, 'testcard-S1.png', {
    get: showing('LIVE_7'),
    stills: [{ key: '48', mode: 'IMAGE', source: 12 }],
    library: [{ slot: 200, fileName: 'logo.png', free: false }]
  });
  assert.deepEqual([reused.journal.writes, reused.journal.stills, reused.journal.uploads], [[], [], []]);
  assert.match(reused.left.join(' | '), /S1 B L2 shows LIVE_7 now.*still 48.*library slot 200 holds logo\.png/);
  const emptied = trimJournal(journal, placed, 'testcard-S1.png', { ...mine, library: [{ slot: 200, fileName: '', free: true }] });
  assert.deepEqual([emptied.journal.uploads, emptied.left], [[], []], 'nothing to empty in a slot somebody already emptied');
});

test('Off after a put that was tried twice: every still that shows any of the card’s slots goes back, not only the last', () => {
  /* The review's case: the first try filled slot 200 and pointed still 48 at
     it, then failed; the retry took slot 199 and still 47. */
  const first = { id: 'S1', writes: [], stills: [{ still: '48', before: { mode: 'NONE' } }], uploads: [200] };
  const second = { id: 'S1', writes: [], stills: [{ still: '47', before: { mode: 'NONE' } }], uploads: [199] };
  const journal = mergeJournal(first, second);
  const now = {
    get: () => undefined,
    stills: [{ key: '47', mode: 'IMAGE', source: 199 }, { key: '48', mode: 'IMAGE', source: 200 }],
    library: [{ slot: 199, fileName: 'testcard-S1.png', free: false }, { slot: 200, fileName: 'testcard-S1.png', free: false }]
  };
  const t = trimJournal(journal, { slot: 199, still: 47, layer: '2', letter: 'B' }, 'testcard-S1.png', now);
  assert.deepEqual(t.journal.stills.map((x) => x.still).sort(), ['47', '48']);
  assert.deepEqual(t.journal.uploads.sort(), [199, 200]);
  const lost = trimJournal(journal, null, 'testcard-S1.png', now);
  assert.deepEqual(lost.journal.stills.map((x) => x.still).sort(), ['47', '48'], 'with no placement the journal’s own slots still count');
});

test('a still a failed Off half put back is still ours; one wholly back, or somebody else’s, is not touched', () => {
  const journal = { id: 'S1', writes: [], stills: [{ still: '48', before: { mode: 'NONE', source: 1, rescale: 'SCALE_TO_CAPABILITY', label: '' } }], uploads: [200] };
  const placed = { slot: 200, still: 48, layer: '2', letter: 'B' };
  const now = (st) => ({ get: () => undefined, stills: [{ key: '48', ...st }], library: [{ slot: 200, fileName: 'testcard-S1.png', free: false }] });
  const opts = { label: 'Test card S1' };
  const half = trimJournal(journal, placed, 'testcard-S1.png', now({ mode: 'IMAGE', source: 1, rescale: 'SCALE_TO_CAPABILITY', label: '' }), opts);
  assert.deepEqual(half.journal.stills.map((x) => x.still), ['48'], 'IMAGE is ours, the rest is the journal’s');
  const back = trimJournal(journal, placed, 'testcard-S1.png', now({ mode: 'NONE', source: 1, rescale: 'SCALE_TO_CAPABILITY', label: '' }), opts);
  assert.deepEqual([back.journal.stills, back.left], [[], []], 'wholly back: nothing to do, nothing to say');
  const theirs = trimJournal(journal, placed, 'testcard-S1.png', now({ mode: 'IMAGE', source: 7, rescale: 'NO_RESCALE', label: 'Logo' }), opts);
  assert.deepEqual(theirs.journal.stills, []);
  assert.match(theirs.left[0], /still 48 shows something else/);
});

test('a fingerprint changes with the settings or the geometry, and only then', () => {
  const topo = canvasTopology(twoUp(), 'S1');
  const plan = cardPlan(topo, { mode: 'canvas', layout: 'per-output' });
  const a = fingerprint(normaliseSettings(null), plan);
  assert.equal(a, fingerprint(normaliseSettings(null), cardPlan(topo, { mode: 'canvas', layout: 'per-output' })));
  assert.notEqual(a, fingerprint(normaliseSettings({ kind: 'grid' }), plan));
  const moved = store({ outputs: { 1: outputNode({ dest: 'S1', left: 0, w: 1920, h: 1080, label: 'LEFT' }), 2: outputNode({ dest: 'S1', left: 1900, w: 1920, h: 1080 }) } });
  assert.notEqual(a, fingerprint(normaliseSettings(null), cardPlan(canvasTopology(moved, 'S1'), { mode: 'canvas', layout: 'per-output' })));
});

/* ================================================================ render */

/** A 2D context that records what is drawn and transforms, and draws nothing. */
function recorder() {
  const calls = [];
  const state = { fillStyle: '#000', font: '10px sans-serif' };
  return new Proxy(state, {
    get(target, key) {
      if (key === 'calls') return calls;
      if (key in target) return target[key];
      if (key === 'measureText') return (t) => ({ width: String(t).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient' || key === 'createPattern') return () => ({ addColorStop() {} });
      if (key === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h });
      return (...args) => { calls.push([String(key), ...args]); };
    },
    set(target, key, value) {
      target[key] = value;
      calls.push([`=${String(key)}`, value]);
      return true;
    }
  });
}

test('drawing output cards: transparent round them, each one clipped to its footprint and drawn there', () => {
  const plan = cardPlan(canvasTopology(twoUp(), 'S1'), { mode: 'outputs', outputs: ['2'] });
  const ctx = recorder();
  drawPlan(ctx, plan, normaliseSettings({ kind: 'smpte-rp219' }));
  const names = ctx.calls.map((c) => c[0]);
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'clearRect'), ['clearRect', 0, 0, 1920, 1080]);
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'translate'), ['translate', 0, 0], 'Out 2 is at the box’s own origin');
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'rect'), ['rect', 0, 0, 1920, 1080]);
  assert.ok(names.includes('clip'));
  assert.ok(ctx.calls.filter((c) => c[0] === 'fillRect').length > 20, 'the bars were painted');
  assert.ok(ctx.calls.some((c) => c[0] === '=fillStyle' && /191, 191, 0|#bfbf00/i.test(String(c[1]))), '75 % yellow, as Test Card computes it');
});

test('drawing the canvas card per output fills the canvas first, so gaps read as gaps', () => {
  const plan = cardPlan(canvasTopology(twoUp(), 'S1'), { mode: 'canvas', layout: 'per-output' });
  const ctx = recorder();
  drawPlan(ctx, plan, normaliseSettings({ kind: 'grid' }));
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'fillRect'), ['fillRect', 0, 0, 3840, 1080]);
  assert.ok(ctx.calls.some((c) => c[0] === 'fillText' && String(c[1]).startsWith('Out 1')), 'each output is named');
});

/* ================================================================== tab */

function outputPage(doc, key = '3') {
  const strip = doc.createElement('div');
  strip.className = 'ui tabular aw-gap-col-mini menu';
  for (const [i, t] of ['format', 'signal', 'adjustments', 'pattern'].entries()) {
    const a = doc.createElement('a');
    a.className = `item aw-padding-big link-module__c___X${i === 3 ? ' active link-module__c--active___Y' : ''}`;
    a.setAttribute('href', `/outputs/${key}/${t}`);
    if (i === 3) a.setAttribute('aria-current', 'page');
    const h3 = doc.createElement('h3');
    h3.textContent = t;
    a.append(h3);
    strip.append(a);
  }
  const pane = doc.createElement('div');
  pane.className = 'aw-full-height aw-panel aw-panel--large';
  const col = doc.createElement('div');
  col.className = 'aw-flex-col aw-full-height';
  col.append(strip, pane);
  doc.body.append(col);
  return { strip, pane };
}

test('the tab: beside the vendor’s, opening it hides their pane, and a vendor tab closes it', () => {
  const dom = install();
  try {
    const doc = dom.doc;
    const loc = { pathname: '/outputs/3/pattern' };
    const { strip, pane } = outputPage(doc);
    const pages = [];
    const body = doc.createElement('div');
    body.textContent = 'card';
    const tab = installTestCardTab({ enabled: () => true, render: (p) => { pages.push(p); return body; }, doc, loc });
    const ours = strip.querySelector('a[data-lpp-testcard]');
    assert.ok(ours, 'the tab is on the strip');
    assert.equal(strip.childNodes.indexOf(ours), 4, 'after the vendor’s own');
    assert.equal(ours.textContent, 'Test Card');
    assert.equal(ours.hasAttribute('href'), false);

    ours.click();
    assert.equal(pane.style.display, 'none');
    assert.ok(doc.querySelector('div[data-lpp-testcard]').contains(body));
    assert.deepEqual(pages.at(-1), { kind: 'output', key: '3' });
    assert.ok(ours.classList.contains('active'), 'ours looks selected');
    assert.equal(strip.querySelector('a[aria-current]').classList.contains('active'), false, 'the vendor’s does not');

    const format = strip.querySelector('a[href="/outputs/3/format"]');
    /* The fake document does not dispatch; its capture listener is called as the browser would. */
    for (const fn of doc._listeners.click || []) fn({ target: format });
    assert.equal(tab.isOpen(), false);
    assert.equal(pane.style.display, '');
    assert.equal(doc.querySelector('div[data-lpp-testcard]'), null);
    tab.stop();
    assert.equal(strip.querySelector('a[data-lpp-testcard]'), null, 'stopping takes the tab away');
  } finally {
    dom.uninstall();
  }
});

test('the tab, kept by React from one output’s page to the next, opens for the page it is on', () => {
  const dom = install();
  try {
    const doc = dom.doc;
    const loc = { pathname: '/outputs/3/pattern' };
    const { strip } = outputPage(doc, '3');
    const pages = [];
    const tab = installTestCardTab({ enabled: () => true, render: (p) => { pages.push(p); return doc.createElement('div'); }, doc, loc });
    /* The vendor's next-output arrow: same strip, new hrefs, new URL. */
    loc.pathname = '/outputs/4/pattern';
    for (const a of strip.querySelectorAll('a[href]')) a.setAttribute('href', a.getAttribute('href').replace('/outputs/3/', '/outputs/4/'));
    tab.refresh();
    strip.querySelector('a[data-lpp-testcard]').click();
    assert.equal(tab.isOpen(), true);
    assert.deepEqual(pages.at(-1), { kind: 'output', key: '4' });
  } finally {
    dom.uninstall();
  }
});

test('the Canvas page: the tab on its pane switch, about the destination selected on the left', () => {
  const dom = install();
  try {
    const doc = dom.doc;
    const loc = { pathname: '/preconfig/pixelspaces/screens' };
    for (const [id, ref] of [['S1', false], ['S2', true]]) {
      const card = doc.createElement('div');
      card.className = `aw-preconfig-card${ref ? ' aw-preconfig-card--reference' : ''}`;
      const head = doc.createElement('div');
      head.className = 'aw-preconfig-card__header';
      const name = doc.createElement('div');
      name.textContent = id;
      head.append(name);
      card.append(head);
      doc.body.append(card);
    }
    const strip = doc.createElement('div');
    strip.className = 'ui tabular menu';
    for (const t of ['Canvas', 'Pattern']) {
      const a = doc.createElement('a');
      a.className = t === 'Pattern' ? 'active item' : 'item';
      a.textContent = t;
      strip.append(a);
    }
    const pane = doc.createElement('div');
    pane.className = 'ui bottom attached segment active tab';
    const col = doc.createElement('div');
    col.append(strip, pane);
    doc.body.append(col);

    assert.equal(selectedCanvas(doc), 'S2');
    const pages = [];
    installTestCardTab({ enabled: () => true, render: (p) => { pages.push(p); return doc.createElement('div'); }, doc, loc });
    strip.querySelector('a[data-lpp-testcard]').click();
    assert.deepEqual(pages.at(-1), { kind: 'canvas', id: 'S2' });
    assert.equal(pane.style.display, 'none');
    assert.ok(doc.querySelector('div[data-lpp-testcard] [data-lpp-testcard-inner]'), 'a panel of its own inside the segment');
  } finally {
    dom.uninstall();
  }
});

test('pages: an output’s detail page and the Canvas page, nothing else', () => {
  assert.deepEqual(pageOf('/outputs/4/signal'), { kind: 'output', key: '4' });
  assert.deepEqual(pageOf('/preconfig/pixelspaces/screens'), { kind: 'canvas' });
  assert.equal(pageOf('/outputs/all'), null);
  assert.equal(pageOf('/live/screens'), null);
});
