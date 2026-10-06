/*
 * The Edit page on a Midra 4K.
 *
 * The page is offered wherever the Layer panel is, which includes Midra 4K
 * and Alta 4K, and until 2026-10-06 it spoke only LivePremier there: the
 * programmer's buffer was keyed `S1` where a Midra keys the screen `1`, so
 * nothing could be seeded; a source click looked up `source.inputNum`, which
 * the Midra catalogue calls `source.input`, so every click ended in "that
 * source is not one this layer accepts"; Empty wrote size under `position`;
 * and a save via preview snapshotted preview from the same wrong key, so its
 * restore wrote nothing and left preview holding the experiment.
 *
 * Everything below runs against `midra-3.2.29-pulse4k.json`, the Midra 4K
 * simulator as a Pulse 4K, with the input list from
 * `midra-3.2.29-inputs.json`. S1 rests at `AT_UP`, so program is UP and
 * preview is DOWN — and the two hold different looks on layer 1, INPUT_7 and
 * INPUT_1, so a copy from the wrong one cannot pass.
 *
 * The LivePremier side is pinned by `programmer.test.js` and
 * `save-look.test.js`, and by the last test here, which spells out the paths
 * the page always wrote there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { install } from './helpers/fake-dom.js';
import { DeviceStore } from '../src/core/device-store.js';
import { DIALECTS } from '../src/core/dialect.js';
import { createProgrammer, EDIT } from '../src/core/programmer.js';
import { listDestinations, readLayers } from '../src/core/screens.js';
import { composeMemory, saveViaPreview } from '../src/core/save-look.js';
import { createEditPanel } from '../plugins/edit/panel.js';
import { createPropertiesPanel } from '../src/ui/properties-panel.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

/**
 * The Pulse 4K, with its inputs. Only `inputList` is taken from the second
 * capture: it was read on another day and carries a `transition` node of its
 * own, which would move S1 to the other end.
 */
function pulse() {
  const desk = fixture('midra-3.2.29-pulse4k.json');
  desk.device.inputList = fixture('midra-3.2.29-inputs.json').device.inputList;
  const store = new DeviceStore();
  store.hydrate(desk);
  return store;
}

const S1 = ['device', 'screenList', 'items', '1'];
const buffer = (letter) => [...S1, 'presetList', 'items', letter];
const layerPath = (letter, key, ...tail) => [...buffer(letter), 'liveLayerList', 'items', key, ...tail];
const P = (path) => path.join('/');

/**
 * A live session that counts what it is asked to put on the wire, and — for
 * the save tests — applies it, the way the device's echo would, and turns a
 * slot valid when it is saved into.
 */
function fakeSession(store, { echo = false, saveLands = true } = {}) {
  const sent = [];
  return {
    store,
    sent,
    send(cmd) {
      sent.push(cmd);
      if (!echo) return true;
      const at = cmd.path.indexOf('save');
      if (cmd.path[1] === 'preset' && at > 0) {
        const slot = cmd.path[cmd.path.length - 3];
        if (saveLands) store.set(['device', 'preset', 'bank', 'slotList', 'items', slot, 'status', 'pp', 'isValid'], true);
        return true;
      }
      store.set(cmd.path, cmd.value);
      return true;
    }
  };
}

/** The Edit page over a programmer, drawn into the fake DOM. */
function editPage(store, session = fakeSession(store), opts = {}) {
  const programmer = createProgrammer({ session });
  const properties = createPropertiesPanel({
    session: programmer, onRefresh() {}, names: () => ({}), onRename: null, buffers: [EDIT], roles: false
  });
  const doc = new EventTarget();
  doc.hidden = false;
  const panel = createEditPanel({ session, programmer, properties, onRefresh() {}, doc, ...opts });
  const wrote = [];
  programmer.addEventListener('sent', (e) => wrote.push(e.detail.cmd));
  return { programmer, panel, session, doc, wrote };
}

const sourceCard = (root, value) =>
  root.querySelectorAll('button.lpp-source').find((b) => b.getAttribute('title').endsWith(' · ' + value));

/* ------------------------------------------------------------ programmer */

test('on a Midra the programmer sits beside the real buffers, keyed as the device keys them', () => {
  const store = pulse();
  const programmer = createProgrammer({ session: fakeSession(store) });

  assert.deepEqual(programmer.bufferPath('S1'), buffer(EDIT), 'screen 1, not S1');
  assert.equal(programmer.seed('S1', 'PREVIEW'), true, 'preview can be seeded from');
  assert.equal(programmer.has('S1'), true);
  assert.equal(programmer.store.get(layerPath(EDIT, '1', 'source', 'pp', 'input')), 'INPUT_1', 'preview is DOWN');

  assert.equal(programmer.seed('S1', 'PROGRAM'), true);
  assert.equal(programmer.store.get(layerPath(EDIT, '1', 'source', 'pp', 'input')), 'INPUT_7', 'program is UP');
  assert.deepEqual(
    readLayers(programmer.store, listDestinations(store).find((d) => d.id === 'S1'), EDIT).map((l) => l.source),
    ['INPUT_7', 'INPUT_5'], 'and the stage draws it');
});

test('Empty on a Midra spells source and size the Midra way, and writes no anchor', () => {
  const store = pulse();
  const programmer = createProgrammer({ session: fakeSession(store) });
  assert.equal(programmer.clear('S1'), true);

  const look = programmer.look('S1');
  for (const key of ['1', '2']) {
    const layer = look.liveLayerList.items[key];
    assert.equal(layer.source.pp.input, 'NONE');
    assert.deepEqual(layer.size.pp, { sizeH: 1920, sizeV: 1080 }, `layer ${key} fills the canvas`);
    assert.deepEqual(layer.position.pp, { posH: 960, posV: 540 }, `layer ${key} is centred, with no anchor`);
    assert.equal(layer.opacity.pp.opacity, 256);
    assert.equal(layer.source.pp.inputNum, undefined, 'no LivePremier source written beside it');
  }
  assert.equal(look.layerList, undefined, 'nothing written into a LivePremier layer list');
});

/* ------------------------------------------------------------- the page */

test('a source picked on the Edit page lands as source/pp/input under liveLayerList', () => {
  const dom = install();
  try {
    const store = pulse();
    const { programmer, panel, session, wrote } = editPage(store);
    panel.select('S1', '1');

    let root = panel.render();
    assert.ok(sourceCard(root, 'INPUT_3'), 'the rail offers the Midra inputs');

    sourceCard(root, 'INPUT_3').click();
    const path = layerPath(EDIT, '1', 'source', 'pp', 'input');
    assert.deepEqual(wrote.map((c) => P(c.path)), [P(path)], 'one write, spelled the Midra way');
    assert.equal(programmer.store.get(path), 'INPUT_3');
    assert.equal(programmer.store.get(layerPath(EDIT, '2', 'source', 'pp', 'input')), 'INPUT_2',
      'the rest of preview came with it');

    root = panel.render();
    assert.deepEqual(root.querySelectorAll('.wru-console-row').map((r) => r.textContent), ['S1 L1 = IN3']);
    assert.deepEqual(root.querySelectorAll('.lpp-layer-row').map((r) => r.textContent), ['L1IN3', 'L2IN2'],
      'the layer strip reads the programmer back');
    assert.deepEqual(root.querySelectorAll('button.lpp-source--on').map((b) => b.getAttribute('title')),
      ['IN3 · INPUT_3'], 'and the card that was picked is lit');

    sourceCard(root, 'COLOR').click();
    assert.equal(programmer.store.get(path), 'COLOR');
    sourceCard(panel.render(), 'NONE').click();
    assert.equal(programmer.store.get(path), 'NONE', 'None is a source too');

    assert.deepEqual(session.sent, [], 'and the switcher heard none of it');
  } finally {
    dom.uninstall();
  }
});

test('a drag on a Midra resizes through size/, about the centre the device keeps', () => {
  const dom = install();
  try {
    const store = pulse();
    const { programmer, panel, doc, wrote } = editPage(store);
    panel.select('S1', '1');
    panel.render();
    sourceCard(panel.render(), 'INPUT_3').click();      /* seeds from preview: 1638x513 about (878,316) */
    wrote.length = 0;

    /* The fake DOM lays nothing out, so the stage is 1px wide and a pointer
       pixel is a whole canvas width: a quarter-pixel is 480. */
    const handle = panel.render().querySelector('.lpp-handle--se');
    assert.ok(handle, 'the selected layer has its handles');
    handle.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    doc.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: -0.25, clientY: -0.25 }));
    doc.dispatchEvent(new Event('pointerup'));

    const tails = wrote.map((c) => P(c.path.slice(c.path.indexOf('liveLayerList'))));
    assert.deepEqual(tails, [
      'liveLayerList/items/1/size/pp/sizeH',
      'liveLayerList/items/1/size/pp/sizeV',
      'liveLayerList/items/1/position/pp/posH',
      'liveLayerList/items/1/position/pp/posV'
    ]);
    const get = (...tail) => programmer.store.get(layerPath(EDIT, '1', ...tail));
    assert.equal(get('size', 'pp', 'sizeH'), 1638 - 480);
    assert.equal(get('size', 'pp', 'sizeV'), 513 - 480);
    /* The top-left corner stays put, so the centre moves by half the change. */
    assert.equal(get('position', 'pp', 'posH'), 878 - 240);
    assert.equal(get('position', 'pp', 'posV'), Math.round(316 - 240));
  } finally {
    dom.uninstall();
  }
});

test('on a Midra the memory rail offers only the route its bank has', async () => {
  const dom = install();
  try {
    const store = pulse();
    const asked = [];
    const { programmer, panel } = editPage(store, fakeSession(store), {
      onSave: async (req) => { asked.push(req); return { ok: true }; },
      onLoad: async () => ({ ok: true })
    });
    panel.select('S1', '1');
    programmer.seed('S1', 'PREVIEW');
    panel.view.rail = 'memory';
    /* As an operator who had chosen Direct on a LivePremier would leave it. */
    panel.view.saving = { slot: '7', route: 'direct' };

    const root = panel.render();
    const buttons = root.querySelectorAll('.lpp-edit-rail button').map((b) => b.textContent);
    assert.ok(buttons.includes('Via preview'));
    assert.equal(buttons.includes('Direct'), false, 'no bank here has an import');
    assert.equal(buttons.some((t) => /^Load memory/.test(t)), false, 'nor an export to load from');
    assert.equal(composeMemory({ programmer, id: 'S1', slot: 7 }), null, 'and no file is composed for one');

    root.querySelectorAll('.lpp-edit-rail button').find((b) => b.textContent === 'Save to memory').click();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(asked.map((r) => r.route), ['preview'], 'a save goes the way that exists');
  } finally {
    dom.uninstall();
  }
});

/* ------------------------------------------------------------ via preview */

test('a save via preview on a Midra writes DOWN, saves PREVIEW, and puts DOWN back', async () => {
  const store = pulse();
  const session = fakeSession(store, { echo: true });
  const programmer = createProgrammer({ session });
  programmer.seed('S1', 'PROGRAM');
  programmer.send({ path: layerPath(EDIT, '1', 'source', 'pp', 'input'), value: 'INPUT_9' });

  const preview = structuredClone(store.get(buffer('DOWN')));
  const program = structuredClone(store.get(buffer('UP')));
  const look = programmer.look('S1');

  const out = await saveViaPreview({ session, programmer, id: 'S1', slot: 7, label: 'Wide' });
  assert.equal(out.ok, true, out.message);

  const paths = session.sent.map((c) => P(c.path));
  assert.ok(paths.includes(P(layerPath('DOWN', '1', 'source', 'pp', 'input'))), 'the look went into preview');
  assert.ok(session.sent.some((c) => P(c.path) === P(layerPath('DOWN', '1', 'source', 'pp', 'input')) && c.value === 'INPUT_9'));
  assert.ok(paths.includes('device/preset/bank/control/save/screenList/items/1/presetList/items/PREVIEW/slotList/items/7/pp/xRequest'),
    'the save named PREVIEW on screen 1');
  assert.ok(paths.includes('device/preset/bank/slotList/items/7/control/pp/label'), 'the slot was labelled');
  assert.equal(paths.some((p) => p.includes('/S1/') || p.includes('/UP/') || p.includes('inputNum')), false,
    'nothing spelled for LivePremier, and program never touched');

  assert.deepEqual(store.get(buffer('DOWN')), preview, 'preview was put back property for property');
  assert.deepEqual(store.get(buffer('UP')), program, 'program never moved');
  assert.deepEqual(programmer.look('S1'), look, 'and the programmer still holds the look');
});

test('on a Midra, preview is put back even when the save never lands', async () => {
  const store = pulse();
  const session = fakeSession(store, { echo: true, saveLands: false });
  const programmer = createProgrammer({ session });
  programmer.seed('S1', 'PROGRAM');
  const preview = structuredClone(store.get(buffer('DOWN')));

  const out = await saveViaPreview({ session, programmer, id: 'S1', slot: 7, timeoutMs: 300 });

  assert.equal(out.ok, false);
  assert.match(out.message, /did not come back valid/);
  assert.notDeepEqual(programmer.look('S1').liveLayerList.items['1'].source, preview.liveLayerList.items['1'].source,
    'the look really was different');
  assert.deepEqual(store.get(buffer('DOWN')), preview, 'a failed save must not leave preview holding the experiment');
});

/* ---------------------------------------------------------- both platforms */

test('every layer property written by meaning is in that platform’s own catalogue', () => {
  for (const dialect of DIALECTS) {
    const writable = (id) => dialect.catalogue.layer.some((p) => p.id === id && !p.readOnly);
    assert.ok(writable(dialect.sourceParam), `${dialect.id}: ${dialect.sourceParam}`);
    for (const [name, id] of Object.entries(dialect.layerParams)) {
      if (id === null) continue;
      assert.ok(writable(id), `${dialect.id}: ${name} is ${id}, which its catalogue does not have`);
    }
  }
});

test('on LivePremier the Edit page writes what it always wrote', () => {
  const dom = install();
  try {
    const store = new DeviceStore();
    const merge = (a, b) => {
      if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b;
      const out = { ...a };
      for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
      return out;
    };
    store.hydrate(['sim-6.2.73-identity.json', 'sim-6.2.73-screens.json', 'sim-6.2.73-destinations.json',
      'sim-6.2.73-connectors.json', 'sim-6.2.73-outputs.json', 'sim-6.2.73-resources.json']
      .map(fixture).reduce(merge, {}));
    const { programmer, panel, session, wrote } = editPage(store);
    panel.select('S1', '1');

    assert.deepEqual(programmer.bufferPath('S1'), ['device', 'screenList', 'items', 'S1', 'presetList', 'items', EDIT]);
    sourceCard(panel.render(), 'LIVE_2').click();
    assert.deepEqual(wrote.map((c) => [P(c.path), c.value]), [
      ['device/screenList/items/S1/presetList/items/EDIT/layerList/items/1/source/pp/inputNum', 'LIVE_2']
    ]);

    programmer.clear('S1');
    const layer = programmer.look('S1').layerList.items['1'];
    assert.equal(layer.source.pp.inputNum, 'NONE');
    assert.equal(layer.position.pp.anchor, 'MIDDLE_CENTER');
    assert.equal(layer.position.pp.sizeH, 1920);
    assert.equal(layer.size, undefined, 'no Midra size node beside it');
    assert.deepEqual(session.sent, []);
  } finally {
    dom.uninstall();
  }
});
