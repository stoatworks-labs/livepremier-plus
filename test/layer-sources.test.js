/*
 * The Layer tab's source list: the sources this switcher has, not the
 * catalogue's enum.
 *
 * Found on an Aquilon RS4 on 6.1.60 (2026-10-16, docs/NOTES.md): the source
 * dropdown offered LIVE 1 to LIVE 256 on a frame with 24 inputs, because
 * `valuesFor` hands back the enum whole. The rule now is the vendor picker's
 * own, read off the 6.2.73 client bundle — see `sourceOffered` in
 * `core/dialect.js` — and only the picker narrows: a write is still checked
 * against the whole enum, so a cue or a group naming a source that has gone
 * is the device's to judge, as before.
 *
 * Fixtures, all real slices:
 *
 *   aquilon-6.2.73-memories.json   a live Aquilon C (the dialect, S1 and its
 *                                  layers — LIVE_2 and LIVE_8 on layer 1)
 *   sim-6.2.73-backgrounds.json    the 6.2.73 simulator's inputs and stills,
 *                                  with the applied still preconfig
 *   midra-3.2.29-pulse4k.json      the Midra 4K simulator as a Pulse 4K
 *   midra-3.2.29-inputs.json       the same simulator's sixteen inputs, ten
 *                                  available
 *
 * The RS4 store itself is not here (raw captures stay in the research repo);
 * its counts are, rebuilt below on the Aquilon capture.
 *
 * Run: node --test test/layer-sources.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import { MNG } from '../src/core/dialect.js';
import { listSources } from '../src/core/screens.js';
import {
  layerSections, layerSpec, valuesFor, offersValue, offeredValues, coerce, readValue, writeCmd
} from '../src/core/properties.js';
import { sourceCommands } from '../src/core/groups.js';
import { install } from './helpers/fake-dom.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

/** Deep-merge store slices; a later slice wins where two disagree. */
function merged(...slices) {
  const merge = (a, b) => {
    if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b;
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
    return out;
  };
  return slices.map((s) => (typeof s === 'string' ? fixture(s) : s)).reduce(merge, {});
}

const storeOf = (...slices) => { const s = new DeviceStore(); s.hydrate(merged(...slices)); return s; };

const range = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
const NATIVE = range('NATIVE_', 1, 8);

/* ------------------------------------------------------------ LivePremier */

const aquilon = () => storeOf('aquilon-6.2.73-memories.json', 'sim-6.2.73-backgrounds.json');

test('a LivePremier offers the inputs, stills and screens it has, then NATIVE sets and colour', () => {
  const store = aquilon();
  const spec = layerSpec(store, 'source');
  assert.deepEqual(offeredValues(spec, store), [
    'NONE',
    ...range('LIVE_', 1, 4),
    /* Allocated in the applied preconfig and empty: the device list's own
       `global` reads DISABLE for all five, and the vendor offers them. */
    ...range('STILL_', 1, 5),
    'SCREEN_1',
    ...NATIVE,
    'COLOR'
  ]);
  /* Still 49 is in the store and not allocated, so not offered. */
  assert.equal(offersValue(spec, store)('STILL_49'), false);
  /* The list a write is checked against is untouched. */
  assert.equal(valuesFor(spec, store).length, 1 + 256 + 192 + 24 + 8 + 1);
});

test('the Aquilon RS4 on 6.1.60: 256 inputs in the store, 24 offered', () => {
  /* The field test's counts, on the Aquilon capture: IN_1..IN_256 present,
     the first 24 available, enabled and USED in the applied preconfig, and
     48 still slots allocated. A frame with 3 screens in FREESTYLE. */
  const inputs = {}, applied = {}, stills = {}, appliedStills = {}, screens = {};
  for (let n = 1; n <= 256; n++) {
    const on = n <= 24;
    inputs[`IN_${n}`] = { status: { pp: { isAvailable: on, isEnabled: true, global: on ? 'USED' : 'DISABLE' } } };
    applied[`IN_${n}`] = { status: { pp: { global: on ? 'USED' : 'DISABLE', isEnabled: true } } };
  }
  for (let n = 1; n <= 192; n++) {
    const on = n <= 48;
    stills[n] = { status: { pp: { isAvailable: on, isEnabled: true, isValid: n === 1, global: on ? 'USED' : 'DISABLE' } } };
    appliedStills[n] = { status: { pp: { global: on ? 'USED' : 'DISABLE', isEnabled: true } } };
  }
  for (let n = 1; n <= 24; n++) screens[`S${n}`] = { status: { pp: { mode: n <= 3 ? 'FREESTYLE' : 'DISABLED' } } };
  const store = storeOf('aquilon-6.2.73-memories.json', {
    device: {
      inputList: { itemKeys: Object.keys(inputs), items: inputs },
      stillList: { itemKeys: Object.keys(stills), items: stills },
      screenList: { items: screens },
      preconfig: {
        inputs: { current: { inputList: { items: applied } } },
        stills: { current: { stillList: { items: appliedStills } } }
      }
    }
  });
  const offered = offeredValues(layerSpec(store, 'source'), store);
  const count = (prefix) => offered.filter((v) => v.startsWith(prefix)).length;
  assert.equal(count('LIVE_'), 24);
  assert.equal(offered.includes('LIVE_25'), false);
  assert.equal(count('STILL_'), 48, 'allocated slots, not only the one holding a picture');
  assert.deepEqual(offered.filter((v) => v.startsWith('SCREEN_')), ['SCREEN_1', 'SCREEN_2', 'SCREEN_3']);
  assert.equal(offered.length, 1 + 24 + 48 + 3 + 8 + 1);
});

test('what a layer holds stays in its list, even when the switcher no longer offers it', () => {
  const store = aquilon();
  const spec = layerSpec(store, 'source');
  /* S1's preview buffer A, layer 1, is on LIVE_2 in the capture — offered.
     Put it on an input this store does not have. */
  const target = { id: 'S1', bank: 'A', layer: '1' };
  assert.equal(readValue(store, target, spec), 'LIVE_2');
  store.set(writeCmd(target, spec, 'LIVE_30', store).path, 'LIVE_30');
  const held = readValue(store, target, spec);
  assert.equal(held, 'LIVE_30');
  assert.equal(offersValue(spec, store)(held), false);
  const values = offeredValues(spec, store, held);
  assert.ok(values.includes('LIVE_30'), 'kept, so the field shows what the layer is on');
  assert.deepEqual(values.slice(0, 6), ['NONE', 'LIVE_1', 'LIVE_2', 'LIVE_3', 'LIVE_4', 'LIVE_30'], 'in catalogue order');
  /* And it is still writable — the picker narrows, the write check does not. */
  assert.equal(coerce(spec, 'LIVE_30', store).ok, true);
});

test('the cut-and-fill source picks from the same list; other enums are not narrowed', () => {
  const store = aquilon();
  const specs = layerSections(store).flatMap((s) => s.params);
  const source = layerSpec(store, 'source');
  const cut = specs.find((p) => p.id === 'cutNFill.cut.inputNum');
  assert.ok(cut, 'the catalogue has a cut source');
  assert.deepEqual(offeredValues(cut, store), offeredValues(source, store));
  /* Every other enum is offered whole. */
  const others = specs.filter((p) => (p.type === 'enum' || p.type === 'map') && p.enum !== source.enum);
  assert.ok(others.length > 5);
  for (const spec of others) assert.deepEqual(offeredValues(spec, store), valuesFor(spec, store), spec.id);
});

test('a store that does not carry a list decides nothing about it', () => {
  /* The Aquilon capture alone has screens and no inputs or stills: every
     input and still is still offered, screens only the one it has. */
  const store = storeOf('aquilon-6.2.73-memories.json');
  const offered = offeredValues(layerSpec(store, 'source'), store);
  assert.ok(offered.includes('LIVE_256'));
  assert.ok(offered.includes('STILL_192'));
  assert.deepEqual(offered.filter((v) => v.startsWith('SCREEN_')), ['SCREEN_1']);
  /* And no store at all offers the catalogue. */
  assert.deepEqual(offeredValues(layerSpec(store, 'source'), null), valuesFor(layerSpec(store, 'source'), null));
});

/* ------------------------------------------------------- Midra / Alta */

/* The Pulse 4K fixture last, so its transition state wins over the inputs
   slice's (the two were read at different moments). */
const pulse = () => storeOf('midra-3.2.29-inputs.json', 'midra-3.2.29-pulse4k.json');

test('a Midra offers its available inputs and a colour — the same list as its source grid', () => {
  const store = pulse();
  const spec = layerSpec(store, 'source');
  assert.equal(spec.id, MNG.sourceParam);
  const offered = offeredValues(spec, store);
  assert.deepEqual(offered, ['NONE', ...range('INPUT_', 1, 10), 'COLOR']);
  assert.deepEqual(offered, listSources(store).map((s) => s.value), 'one rule on this platform');
  assert.equal(valuesFor(spec, store).length, 18, 'the write check keeps all sixteen');
});

test('a Midra layer on an input that has gone keeps it in its list', () => {
  const store = pulse();
  const spec = layerSpec(store, 'source');
  const target = { id: 'S1', bank: 'UP', layer: '1' };
  assert.equal(readValue(store, target, spec), 'INPUT_7');
  store.set(['device', 'inputList', 'items', 'INPUT_7', 'status', 'pp', 'isAvailable'], false);
  assert.equal(offersValue(spec, store)('INPUT_7'), false);
  assert.ok(offeredValues(spec, store, 'INPUT_7').includes('INPUT_7'));
  assert.equal(offeredValues(spec, store).includes('INPUT_7'), false);
});

test('the Pulse 4K fixture alone carries no input list, and so offers all sixteen', () => {
  const store = storeOf('midra-3.2.29-pulse4k.json');
  assert.deepEqual(offeredValues(layerSpec(store, 'source'), store), ['NONE', ...range('INPUT_', 1, 16), 'COLOR']);
});

/* ------------------------------------------------- groups and send-to */

test('a group fans out a source the picker would not offer — the write check is the enum', () => {
  /* Send-to takes its source off the vendor's own card, which the vendor
     already filtered; a ganged group copies whatever a member was set to. So
     neither offers a list, and neither should refuse a source that is
     merely not on offer: the device decides, as it always has. */
  const store = aquilon();
  const { cmds, refused } = sourceCommands(store, [{ id: 'S1', layer: '2' }], 'LIVE_30', 'PREVIEW');
  assert.deepEqual(refused, []);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].value, 'LIVE_30');
});

/* ------------------------------------------------------------ the panel */

test('the Layer panel draws the offered list and marks a held source', async () => {
  const dom = install();
  try {
    const { createPropertiesPanel } = await import('../src/ui/properties-panel.js');
    const store = aquilon();
    const session = new EventTarget();
    session.store = store;
    session.state = 'live';
    session.send = () => true;
    const panel = createPropertiesPanel({ session, onRefresh() {}, names: () => ({}), onRename: null });
    /* PREVIEW on S1 is buffer A; layer 1 holds LIVE_2. */
    const sourceSelect = () => panel.render().querySelectorAll('select')
      .find((s) => s.querySelectorAll('option').some((o) => o.getAttribute('value') === 'LIVE_1'));
    const options = () => sourceSelect().querySelectorAll('option');
    assert.deepEqual(options().map((o) => o.getAttribute('value')), offeredValues(layerSpec(store, 'source'), store));
    assert.equal(options().find((o) => o.getAttribute('selected')).getAttribute('value'), 'LIVE_2');

    store.set(['device', 'screenList', 'items', 'S1', 'presetList', 'items', 'A', 'layerList', 'items', '1', 'source', 'pp', 'inputNum'], 'LIVE_30');
    const held = options().find((o) => o.getAttribute('value') === 'LIVE_30');
    assert.ok(held, 'the held source is in the list');
    assert.equal(held.getAttribute('selected'), 'selected');
    assert.equal(held.textContent, 'LIVE 30 (not available)');
    assert.equal(options().find((o) => o.getAttribute('value') === 'LIVE_1').textContent, 'LIVE 1');
  } finally {
    dom.uninstall();
  }
});
