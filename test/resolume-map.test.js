/*
 * Resolume Mapping: the composition, the Arena map it writes, the background
 * set plan, the writes and their Undo, and the panel.
 *
 * The geometry under it is `src/core/backgrounds.js`, which the Background
 * Slicer's pixel tests hold to the switcher's model; what is checked here is
 * that the map reads each output's rectangle of the composition and writes
 * it to the right part of the raster — side by side, stacked, grouped and
 * turned — and that the preset is made only of shapes a real Arena wrote.
 *
 * The stores: the synthetic one is built here to have what no simulator has
 * (slices, groups, rotation, two screens); `simStore` is the 6.2.73
 * simulator's captures, backgrounds and input signals included, as
 * test/bg-slicer.test.js merges them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import { liveCandidates, setContentPath, setLabelPath } from '../src/core/backgrounds.js';
import {
  compose, buildPlan, arenaProject, arenaPreset, arenaName, defaultName, outputRegions
} from '../plugins/resolume-map/core.js';
import { applyPlan, revert } from '../plugins/resolume-map/apply.js';
import { install } from './helpers/fake-dom.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

function merge(a, b) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
  return out;
}

function simStore() {
  const s = new DeviceStore();
  s.hydrate(['sim-6.2.73-identity.json', 'sim-6.2.73-screens.json', 'sim-6.2.73-destinations.json',
    'sim-6.2.73-outputs.json', 'sim-6.2.73-backgrounds.json', 'sim-6.2.73-inputs-signal.json'].map(fixture).reduce(merge, {}));
  return s;
}

const sliceItem = (left, top, w, h) => ({ pp: { top, left }, aoi: { pp: { top: 0, left: 0, width: w, height: h } } });

/** One output in the device's own shape — the Background Slicer's test builds them the same way. */
function outputNode({ screen, left = 0, top = 0, w, h, ratio = 1000, rotation = 'NONE', group = '1X1', state = 'USED', slices = null }) {
  const list = slices || [[0, 0, w, h]];
  const odd = rotation === '90_DEGREE' || rotation === '270_DEGREE';
  const fw = Math.floor(((odd ? h : w) * ratio) / 1000);
  const fh = Math.floor(((odd ? w : h) * ratio) / 1000);
  return {
    mapping: { pp: { device: '1', isValid: true } },
    control: { pp: { label: '' } },
    status: { pp: { format: 'HDTV_1080P', rate: 60000, sizeH: w, sizeV: h } },
    plugList: { itemKeys: ['1'], items: { 1: { status: { pp: { type: 'HDMI' } } } } },
    canvas: {
      cmd: { pp: { pitchRatioH: ratio, pitchRatioV: ratio, rotation } },
      status: {
        pp: { isEnabled: state, usedInScreenAux: screen, group, capability: 'DUAL', rotation, left, top, pitchedWidth: fw, pitchedHeight: fh, clampedWidth: fw, clampedHeight: fh, maxWidth: w, maxHeight: h },
        slices: {
          pp: { mode: 'FREE', count: list.length },
          boundingBox: { pp: { left: 0, top: 0, width: w, height: h } },
          sliceList: { itemKeys: ['1', '2', '3', '4'], items: Object.fromEntries([0, 1, 2, 3].map((i) => [String(i + 1), list[i] ? sliceItem(...list[i]) : sliceItem(0, 0, w, h)])) }
        }
      }
    }
  };
}

function syntheticStore(screens, outputs) {
  const s = new DeviceStore();
  const ids = Object.keys(screens);
  s.hydrate({
    device: {
      screenAuxGroupList: { itemKeys: ids, items: Object.fromEntries(ids.map((id) => [id, { control: { pp: { presetUp: 'B', presetDown: 'A' } }, status: { pp: { isUsed: true, transition: 'AT_UP' } } }])) },
      screenList: { itemKeys: ids, items: Object.fromEntries(ids.map((id) => [id, { control: { pp: { label: '' } }, status: { pp: { mode: 'FREESTYLE' }, size: { pp: { sizeH: screens[id][0], sizeV: screens[id][1] } } } }])) },
      outputList: { itemKeys: Object.keys(outputs), items: outputs }
    }
  });
  return s;
}

/** S1 a 3840 × 1080 wall on one 2X1 output (two connectors); S2 a portrait 1080 × 1920 on an output turned 90°. */
const twoScreens = () => syntheticStore({ S1: [3840, 1080], S2: [1080, 1920] }, {
  1: outputNode({ screen: 'S1', w: 3840, h: 1080, group: '2X1', slices: [[0, 0, 1920, 1080], [1920, 0, 1920, 1080]] }),
  5: outputNode({ screen: 'S2', w: 1920, h: 1080, rotation: '90_DEGREE' })
});

const job = (over = {}) => ({ screens: ['S1', 'S2'], arrange: 'row', inputs: {}, name: '', set: { on: false, index: {}, label: '', edids: true, preview: false, allowProgram: false }, ...over });

/* ------------------------------------------------------------ the composition */

test('the composition is the screens’ canvases side by side, or one above another', () => {
  const screens = [{ id: 'S1', canvas: { width: 3840, height: 1080 } }, { id: 'S2', canvas: { width: 1080, height: 1920 } }];
  const row = compose(screens, 'row');
  assert.deepEqual(row.screens.map((s) => [s.id, s.at]), [['S1', { x: 0, y: 0 }], ['S2', { x: 3840, y: 0 }]]);
  assert.deepEqual([row.width, row.height], [4920, 1920]);
  const column = compose(screens, 'column');
  assert.deepEqual(column.screens.map((s) => s.at), [{ x: 0, y: 0 }, { x: 0, y: 1080 }]);
  assert.deepEqual([column.width, column.height], [3840, 3000]);
  assert.deepEqual([compose([]).width, compose([]).height], [0, 0]);
});

test('each output reads its own rectangle of the composition: a group’s connectors one slice each, a turned output as a turned quad', () => {
  const plan = buildPlan(twoScreens(), job());
  assert.equal(plan.xml.ok, true, plan.xml.problems.join('; '));
  assert.deepEqual(plan.composition, { width: 4920, height: 1920 });
  const [s1, s2] = plan.screens;
  assert.deepEqual(s1.outputs[0].regions.map((r) => [r.slice, r.input, r.raster]), [
    [1, { x: 0, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 1920, h: 1080 }],
    [2, { x: 1920, y: 0, w: 1920, h: 1080 }, { x: 1920, y: 0, w: 1920, h: 1080 }]
  ]);
  assert.deepEqual(s1.outputs[0].assumptions.sort(), ['group', 'slices']);
  const turned = s2.outputs[0].regions[0];
  assert.deepEqual(turned.input, { x: 3840, y: 0, w: 1080, h: 1920 }, 'S2 starts where S1’s canvas ends');
  /* The content's top-left lands at the raster's bottom-left, so the quad's top edge points up. */
  assert.deepEqual(turned.output, [{ x: 0, y: 1080 }, { x: 0, y: 0 }, { x: 1920, y: 0 }, { x: 1920, y: 1080 }]);
  assert.equal(turned.exact, true);

  const stacked = buildPlan(twoScreens(), job({ arrange: 'column' }));
  assert.deepEqual(stacked.composition, { width: 3840, height: 3000 });
  assert.deepEqual(stacked.screens[1].outputs[0].regions[0].input, { x: 0, y: 1080, w: 1080, h: 1920 });
});

test('a pitched output reads more canvas than it has pixels, and is marked scaled', () => {
  const store = syntheticStore({ S1: [2400, 1350] }, { 1: outputNode({ screen: 'S1', w: 1920, h: 1080, ratio: 1250 }) });
  const o = buildPlan(store, job({ screens: ['S1'] })).screens[0].outputs[0];
  assert.deepEqual(o.regions[0].input, { x: 0, y: 0, w: 2400, h: 1350 });
  assert.deepEqual(o.regions[0].raster, { x: 0, y: 0, w: 1920, h: 1080 });
  assert.equal(o.exact, false);
  assert.ok(o.assumptions.includes('pitch'));
});

test('an output off its canvas, or partly, is fed only from the canvas, and says so', () => {
  const store = syntheticStore({ S1: [1920, 1080] }, {
    1: outputNode({ screen: 'S1', left: 960, w: 1920, h: 1080 }),
    2: outputNode({ screen: 'S1', left: 4000, w: 1920, h: 1080 })
  });
  const plan = buildPlan(store, job({ screens: ['S1'] }));
  assert.deepEqual(plan.screens[0].outputs[0].regions[0].input, { x: 960, y: 0, w: 960, h: 1080 });
  assert.deepEqual(plan.screens[0].outputs[0].regions[0].raster, { x: 0, y: 0, w: 960, h: 1080 });
  assert.equal(plan.screens[0].outputs[1].regions.length, 0);
  assert.match(plan.warnings.join('\n'), /S1 Out 1 is partly off its screen’s canvas/);
  assert.match(plan.warnings.join('\n'), /S1 Out 2 is off its screen’s canvas/);
  assert.equal(plan.xml.ok, true, 'still a map: the output is there, with nothing to show');
  assert.deepEqual(outputRegions({ regions: [] }, { width: 10, height: 10 }, { x: 0, y: 0 }), []);
});

test('no screen, no map; one input per output', () => {
  assert.deepEqual(buildPlan(twoScreens(), job({ screens: [] })).xml.problems, ['Choose the screens to map.']);
  assert.deepEqual(buildPlan(twoScreens(), job({ screens: ['S9'] })).xml.problems, ['Choose the screens to map.']);
  const twice = buildPlan(twoScreens(), job({ inputs: { 'S1/1': 'IN_5', 'S2/5': 'IN_5' } }));
  assert.equal(twice.xml.ok, false);
  assert.match(twice.xml.problems[0], /IN 5 is chosen for S1 Out 1 and S2 Out 5 — one input per output/);
});

/* ------------------------------------------------------------- the preset */

test('an Arena output is named after the cable, else after the output', () => {
  assert.equal(arenaName('S1', '3', 'IN_12'), 'IN 12 → S1 Out 3');
  assert.equal(arenaName('S1', '3', null), 'S1 Out 3');
  assert.equal(defaultName(['S1', 'S2']), 'LivePremier S1 S2');
  const plan = buildPlan(twoScreens(), job({ inputs: { 'S2/5': 'IN_6' } }));
  assert.deepEqual(plan.screens.flatMap((s) => s.outputs.map((o) => o.arena)), ['S1 Out 1', 'IN 6 → S2 Out 5']);
});

test('the preset: a Virtual screen per switcher output at its raster, a slice per connector, the composition’s size', () => {
  const plan = buildPlan(twoScreens(), job({ inputs: { 'S2/5': 'IN_6' }, name: 'Main walls' }));
  const project = arenaProject(plan);
  assert.deepEqual(project.connectors.map((c) => [c.name, c.width, c.height, c.desktop.x, c.device]), [
    ['S1 Out 1', 3840, 1080, 0, 'virtual'], ['IN 6 → S2 Out 5', 1920, 1080, 3840, 'virtual']
  ]);
  assert.deepEqual(project.slices.map((s) => [s.connectorId, s.name]), [['c1', 'S1 Out 1 s1'], ['c1', 'S1 Out 1 s2'], ['c2', 'S2 Out 5']]);
  assert.deepEqual(project.slices[2].input, [{ x: 3840, y: 0 }, { x: 4920, y: 0 }, { x: 4920, y: 1920 }, { x: 3840, y: 1920 }]);

  const { name, xml } = arenaPreset(plan);
  assert.equal(name, 'Main walls.xml');
  assert.match(xml, /^<\?xml version="1.0" encoding="utf-8"\?>\n<XmlState name="Main walls">/);
  assert.equal((xml.match(/<Screen name=/g) || []).length, 2);
  assert.equal((xml.match(/<Slice uniqueId=/g) || []).length, 3);
  assert.match(xml, /<CurrentCompositionTextureSize width="4920" height="1920"\/>/);
  assert.match(xml, /<OutputDeviceVirtual deviceId="VirtualIN 6 → S2 Out 5" name="IN 6 → S2 Out 5" idHash="\d+" width="1920" height="1080"\/>/);
  assert.match(xml, /<OutputRect orientation="-1.570796">/, 'the turned slice');
  assert.equal(arenaPreset(buildPlan(twoScreens(), job({ screens: ['S1'] }))).name, 'LivePremier S1.xml');
});

/*
 * output-map's conformance rule (its docs/resolume-export.md), on this
 * plugin's own preset: every element-and-attribute shape in it must appear in
 * a file a real Arena 7.27 wrote. The reference files live in an output-map
 * checkout beside this repo; without one, skipped.
 */
test('the preset uses only shapes a real Arena wrote', async (t) => {
  const refs = ['resolume-arena-preset.xml', 'resolume-arena-rotated-ndi.xml']
    .map((f) => join(here, '..', '..', 'output-map', 'src', 'lib', '__tests__', 'fixtures', f));
  let texts;
  try {
    texts = refs.map((f) => readFileSync(f, 'utf8'));
  } catch {
    t.skip('no output-map checkout beside this repo');
    return;
  }
  const VOCAB = new Set(['Params', 'Param', 'ParamChoice', 'ParamRange', 'ValueRange']);
  const shapes = (xml) => {
    const out = new Set();
    const stack = [];
    for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w]*)((?:\s+[\w:]+="[^"]*")*)\s*(\/?)>/g)) {
      const [, close, tag, attrs, self] = m;
      if (close) { stack.pop(); continue; }
      const names = [...attrs.matchAll(/([\w:]+)="([^"]*)"/g)];
      const vocab = VOCAB.has(tag) ? names.find(([, k]) => k === 'name') : null;
      const key = `${stack.join('/')}/${tag}${vocab ? `[name=${vocab[2]}]` : ''}`;
      out.add(`${key} ${names.map(([, k]) => k).filter((k) => !(k === 'name' && !VOCAB.has(tag))).sort().join(',')}`);
      if (!self) stack.push(tag + (vocab ? `[name=${vocab[2]}]` : ''));
    }
    return out;
  };
  const real = new Set(texts.flatMap((x) => [...shapes(x)]));
  const ours = shapes(arenaPreset(buildPlan(twoScreens(), job({ inputs: { 'S1/1': 'IN_5' } }))).xml);
  assert.deepEqual([...ours].filter((s) => !real.has(s)), [], 'every shape is one Arena wrote');
  assert.ok(ours.size > 30);
});

/* -------------------------------------------------------- the background set */

const setJob = (over = {}) => job({
  screens: ['S1'],
  inputs: { 'S1/1': 'IN_1' },
  set: { on: true, index: {}, label: 'Resolume', edids: true, preview: false, allowProgram: false },
  ...over
});

test('the set: a free one by default, the chosen inputs as live contents, the EDID for each output’s format', () => {
  const store = simStore();
  const plan = buildPlan(store, setJob(), liveCandidates(store));
  assert.equal(plan.write.ok, true, plan.write.problems.join('; '));
  const s = plan.screens[0];
  assert.equal(s.assign, true);
  assert.equal(s.setIndex, 1);
  assert.deepEqual(s.outputs.map((o) => o.content), ['LIVE_1', null, null]);
  assert.deepEqual(s.outputs[0].edid, { kind: 'template', key: '1920_1080_60HZ', label: '1920×1080 60HZ' });
  assert.equal(s.outputs[0].arena, 'IN 1 → S1 Out 1');

  /* Off: no set is planned at all, and nothing can be written. */
  const off = buildPlan(store, job({ screens: ['S1'], inputs: { 'S1/1': 'IN_1' } }), liveCandidates(store));
  assert.equal(off.screens[0].assign, false);
  assert.equal(off.write.ok, false);
});

test('the set refuses what the switcher would: no input at all, a set on program, an input from another frame', () => {
  const store = simStore();
  const none = buildPlan(store, setJob({ inputs: {} }), liveCandidates(store));
  assert.equal(none.write.ok, false);
  assert.match(none.write.problems.join('\n'), /Choose the input each Arena output is cabled into/);
  assert.match(none.warnings.join('\n'), /S1: no input chosen, so its background sets are left alone/);

  store.set(['device', 'preconfig', 'backgrounds', 'screenList', 'items', 'S1', 'backgroundSetList', 'items', '2', 'status', 'pp', 'isOnProgram'], true);
  const live = buildPlan(store, setJob({ set: { ...setJob().set, index: { S1: 2 } } }), liveCandidates(store));
  assert.match(live.write.problems.join('\n'), /S1: background set 2 is on program — confirm to write it live/);
  assert.equal(buildPlan(store, setJob({ set: { ...setJob().set, index: { S1: 2 }, allowProgram: true } }), liveCandidates(store)).write.ok, true);

  const far = liveCandidates(store).map((c) => (c.key === 'IN_1' ? { ...c, device: '2' } : c));
  assert.match(buildPlan(store, setJob(), far).write.problems.join('\n'), /IN 1 is on frame 2 and the output on frame 1 — a background comes from its own frame/);
  assert.match(buildPlan(store, setJob({ inputs: { 'S1/1': 'IN_99' } }), liveCandidates(store)).write.problems.join('\n'), /IN 99 is not a fitted input/);
});

test('an output with no input keeps what its set holds, and says so', () => {
  const store = simStore();
  store.set(setContentPath('S1', 1, '2'), 'STILL_3');
  assert.equal(buildPlan(store, setJob(), liveCandidates(store)).screens[0].setIndex, 2, 'a set holding something is not free');
  const plan = buildPlan(store, setJob({ set: { ...setJob().set, index: { S1: 1 } } }), liveCandidates(store));
  assert.equal(plan.screens[0].outputs[1].previous, 'STILL_3');
  assert.equal(plan.screens[0].outputs[1].content, null);
  assert.match(plan.warnings.join('\n'), /S1 set 1 Out 2: no input chosen — keeps STILL_3/);
});

/* -------------------------------------------------------------- the writes */

/**
 * A stand-in switcher, as the 6.2.73 simulator behaves: a write that changes
 * a value is echoed back inbound a tick later; one it already holds, or one
 * `refuse` turns down, is not echoed at all.
 */
function standIn(store, { refuse = () => false } = {}) {
  const session = new EventTarget();
  session.store = store;
  const log = [];
  session.send = ({ path, value }) => {
    log.push([path.join('/'), value]);
    const changed = !Object.is(store.get(path), value);
    setTimeout(() => {
      if (refuse(path, value) || !changed) return;
      store.set(path, value);
      session.dispatchEvent(new CustomEvent('frame', { detail: { path, value, dir: 'in' } }));
    }, 1);
    return true;
  };
  return { session, log };
}

test('write: the EDID first, then each input claims its output and becomes its content, then the name — and Undo puts the set back', async () => {
  const store = simStore();
  const { session, log } = standIn(store);
  const plan = buildPlan(store, setJob({ inputs: { 'S1/1': 'IN_1', 'S1/2': 'IN_2' } }), liveCandidates(store));
  const steps = [];
  const result = await applyPlan({ session, plan, options: { label: 'Resolume', edids: true }, onStep: (t) => steps.push(t) });
  assert.equal(result.ok, true, result.error);
  assert.equal(log[0][0], 'device/inputList/items/IN_1/plugList/items/1/edid/cmd/fromTemplate/bankList/items/1920_1080_60HZ/pp/xApply');
  assert.deepEqual([log[0][1], log[1][1]], [false, true]);
  assert.equal(store.get(setContentPath('S1', 1, '1')), 'LIVE_1');
  assert.equal(store.get(setContentPath('S1', 1, '2')), 'LIVE_2');
  assert.equal(store.get(['device', 'preconfig', 'backgrounds', 'inputList', 'items', 'IN_2', 'control', 'pp', 'useOnOutput']), '2');
  assert.equal(store.get(setLabelPath('S1', 1)), 'Resolume');
  assert.ok(steps.includes('S1 background set 1: Out 1 ← IN 1'));
  assert.equal(result.journal.edids.length, 2);

  const notes = [];
  const undone = await revert({ session, journal: result.journal, onStep: (t, s) => { if (s === 'note') notes.push(t); } });
  assert.equal(undone.ok, true, undone.problems.join('; '));
  assert.equal(store.get(setContentPath('S1', 1, '1')), 'NONE');
  assert.equal(store.get(setContentPath('S1', 1, '2')), 'NONE');
  assert.equal(store.get(setLabelPath('S1', 1)), '');
  assert.match(notes.join('\n'), /IN 1 still serves the 1920_1080_60HZ EDID/, 'an EDID is listed, never claimed undone');
});

test('write: no EDIDs unless asked; a set gone to air since the plan is refused, writing nothing', async () => {
  const store = simStore();
  const { session, log } = standIn(store);
  const plan = buildPlan(store, setJob(), liveCandidates(store));
  const ok = await applyPlan({ session, plan, options: {} });
  assert.equal(ok.ok, true, ok.error);
  assert.ok(!log.some(([p]) => p.includes('/edid/')), 'no plug was touched');

  const store2 = simStore();
  const two = standIn(store2);
  const plan2 = buildPlan(store2, setJob(), liveCandidates(store2));
  store2.set(['device', 'preconfig', 'backgrounds', 'screenList', 'items', 'S1', 'backgroundSetList', 'items', '1', 'status', 'pp', 'isOnProgram'], true);
  const refused = await applyPlan({ session: two.session, plan: plan2, options: { edids: true } });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /S1 background set 1 is on program/);
  assert.equal(two.log.length, 0);
});

test('write: a content the switcher does not echo stops the run, journalled so Undo can put it back', async () => {
  const store = simStore();
  const { session } = standIn(store, { refuse: (path) => path.at(-1) === 'content' });
  const plan = buildPlan(store, setJob(), liveCandidates(store));
  const result = await applyPlan({ session, plan, options: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /S1 set 1 did not take LIVE_1 on Out 1 — the switcher did not echo it/);
  assert.equal(result.journal.sets.length, 1);
});

/* --------------------------------------------------------------- the panel */

test('the panel draws the composition, the outputs, the preset and — when asked — the set', async () => {
  const dom = install();
  try {
    const { createResolumePanel } = await import('../plugins/resolume-map/panel.js');
    const store = simStore();
    const session = new EventTarget();
    session.store = store;
    session.send = () => true;
    const view = createResolumePanel({ session, onRefresh() {} });
    const first = view.render();
    assert.match(first.textContent, /Composition 1920 × 1080/);
    assert.match(first.textContent, /Download preset \(\.xml\)/);
    assert.match(first.textContent, /4 · Background set — optional/);
    assert.doesNotMatch(first.textContent, /Name for the sets/, 'the set’s options only once it is asked for');
    assert.deepEqual(view.job.screens, ['S1'], 'every screen in service, the first time');

    view.job.set.on = true;
    view.job.inputs['S1/1'] = 'IN_1';
    const second = view.render();
    assert.match(second.textContent, /Name for the sets/);
    assert.match(second.textContent, /IN 1 → S1 Out 1/);
    assert.match(second.textContent, /1920×1080 60HZ/);
    assert.ok(second.querySelector('[data-lpp-key="rsm-input-S1/1"]'), 'the input picker carries a key, for keep-focus');
  } finally {
    dom.uninstall();
  }
});
