/*
 * Tests for the memory banks and the layer-property catalogue.
 *
 * The fixture is real: `aquilon-6.2.73-memories.json` was cut out of
 * GET /api/stores/device on a live Aquilon C, trimmed to a handful of slots
 * and one screen. So the bank shapes, the preset-letter assignments and the
 * fitted-layer gate are tested against the device's own words rather than
 * against what the protocol guide claims.
 *
 * The paths matter more than usual here. Every command in `core/memories.js`
 * is a write to a live switcher, and the failure mode for a wrong path is not
 * an error — it is a write into a node the device does not have, which
 * succeeds and does nothing. So each one is pinned against the AWJ spelling as
 * well, which is the form a human can check against the protocol document.
 *
 * Run: node --test test/panels.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import { toAwj } from '../src/core/paths.js';
import {
  BANKS, bankFor, listNameFor, listSlots, slotCount, assignments,
  recallCmd, saveCmd, labelCmd, deleteCmd, saveFilters
} from '../src/core/memories.js';
import {
  layerSections, valuesFor, paramPath, readValue, coerce, writeCmd,
  fittedLayers, bankLetter
} from '../src/core/properties.js';
import { layerSpec } from '../src/vendor/surface/catalogue.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const store = (() => {
  const s = new DeviceStore();
  s.hydrate(fixture('aquilon-6.2.73-memories.json'));
  return s;
})();

/* ------------------------------------------------------------------ banks */

test('the three banks are distinguished by what a recall has to name', () => {
  assert.deepEqual(BANKS.map((b) => b.kind), ['master', 'screen', 'layer']);
  assert.deepEqual(BANKS.map((b) => b.scope), ['device', 'destination', 'layer']);
  assert.deepEqual(bankFor('screen').root, ['presetBank']);
  assert.equal(bankFor('nonsense'), null);
});

test('auxiliaries address through the auxiliary list at every level', () => {
  assert.equal(listNameFor('A3'), 'auxiliaryList');
  assert.equal(listNameFor('S3'), 'screenList');
  assert.ok(recallCmd('screen', 5, { id: 'A3', mode: 'PREVIEW' }).path.includes('auxiliaryList'));
  assert.ok(saveCmd('screen', 5, { id: 'A3', mode: 'PROGRAM' }).path.includes('auxiliaryList'));
});

test('slots are listed in numeric order, not lexical', () => {
  const slots = listSlots(store, 'screen').map((s) => s.slot);
  assert.deepEqual(slots, [1, 2, 3, 44, 45]);
});

test('isValid is what separates a saved memory from an empty slot', () => {
  const all = listSlots(store, 'screen');
  const valid = listSlots(store, 'screen', { onlyValid: true });
  assert.ok(all.length >= valid.length);
  /* Slot 1 on this box is valid but unnamed — an empty label is not an empty
     slot, and a panel that hid one would hide a real memory. */
  const one = all.find((s) => s.slot === 1);
  assert.equal(one.isValid, true);
  assert.equal(one.label, '');
  assert.equal(all.find((s) => s.slot === 2).label, 'Keynote 1_S1');
});

test('the layer bank is empty on this device, and says so rather than vanishing', () => {
  assert.equal(listSlots(store, 'layer', { onlyValid: true }).length, 0);
  assert.ok(listSlots(store, 'layer').length > 0);
});

test('master slots carry the destinations they cover', () => {
  const first = listSlots(store, 'master', { onlyValid: true })[0];
  assert.equal(first.label, 'Keynote 1');
  assert.deepEqual(first.screens, ['S1', 'S2', 'S3']);
  assert.ok(Array.isArray(first.auxes));
});

test('slot counts come from the device, not from the table', () => {
  /* The fixture is trimmed, so this is the trimmed count — which is the point:
     a hard-coded 1000 would draw 995 phantom slots here. */
  assert.equal(slotCount(store, 'screen'), 5);
  assert.equal(slotCount(store, 'layer'), 2);
});

/* --------------------------------------------------------------- commands */

test('a recall names the slot first and the destination second', () => {
  assert.equal(
    toAwj(recallCmd('screen', 44, { id: 'S1', mode: 'PREVIEW' }).path),
    'DeviceObject/presetBank/control/load/$slot/@items/44/$screen/@items/S1/$preset/@items/PREVIEW/@props/xRequest');
  assert.equal(
    toAwj(recallCmd('master', 7, { mode: 'PROGRAM' }).path),
    'DeviceObject/masterPresetBank/control/load/$slot/@items/7/$preset/@items/PROGRAM/@props/xRequest');
  assert.equal(
    toAwj(recallCmd('layer', 3, { id: 'S1', mode: 'PREVIEW', layer: '2' }).path),
    'DeviceObject/layerBank/control/load/$slot/@items/3/$screen/@items/S1/$preset/@items/PREVIEW/$layer/@items/2/@props/xRequest');
});

test('a save is not the mirror image of a recall — the slot comes last', () => {
  assert.equal(
    toAwj(saveCmd('screen', 44, { id: 'S1', mode: 'PROGRAM' }).path),
    'DeviceObject/presetBank/control/save/$screen/@items/S1/$preset/@items/PROGRAM/$slot/@items/44/@props/xRequest');
  assert.equal(
    toAwj(saveCmd('layer', 3, { id: 'S1', mode: 'PROGRAM', layer: 'NATIVE' }).path),
    'DeviceObject/layerBank/control/save/$screen/@items/S1/$preset/@items/PROGRAM/$layer/@items/NATIVE/$slot/@items/3/@props/xRequest');
  /* Master is the exception: it has no single source to name. */
  assert.equal(
    toAwj(saveCmd('master', 12, {}).path),
    'DeviceObject/masterPresetBank/control/save/$slot/@items/12/@props/xRequest');
});

test('a recall refuses rather than defaulting to a buffer', () => {
  assert.equal(recallCmd('screen', 1, { id: 'S1' }), null);
  assert.equal(recallCmd('screen', 1, { id: 'S1', mode: 'PROGRAMME' }), null);
  /* A destination-scoped bank with no destination is not answerable either. */
  assert.equal(recallCmd('screen', 1, { mode: 'PREVIEW' }), null);
  /* Nor a layer recall with no layer. */
  assert.equal(recallCmd('layer', 1, { id: 'S1', mode: 'PREVIEW' }), null);
});

test('rename and erase address the bank list, not the load tree', () => {
  assert.deepEqual(labelCmd('screen', 44, 'Act One Top').value, 'Act One Top');
  assert.equal(
    toAwj(labelCmd('screen', 44, 'x').path),
    'DeviceObject/presetBank/$bank/@items/44/control/@props/label');
  assert.equal(
    toAwj(deleteCmd('master', 2).path),
    'DeviceObject/masterPresetBank/$bank/@items/2/control/@props/xDelete');
  assert.equal(deleteCmd('screen', 3).value, true);
});

test('save filters are read, never written', () => {
  const f = saveFilters(store, 'screen', { id: 'S1' });
  assert.ok(f.categories.includes('SOURCE'));
  assert.ok(f.layers.includes('NATIVE'));
  const m = saveFilters(store, 'master');
  assert.equal(typeof m.mode, 'string');
  assert.ok(Array.isArray(m.screens));
});

/* ------------------------------------------------------------ assignments */

test('which memory sits in each preset buffer, and whether it still matches', () => {
  const a = assignments(store, 'S1');
  assert.ok(a.A && Number.isFinite(a.A.slot));
  assert.equal(typeof a.A.unmodified, 'boolean');
  /* C is the previous buffer and the device reports it modified on this box —
     the flag is the difference between "showing memory 44" and "showing
     something that started as memory 44". */
  assert.equal(a.C.unmodified, false);
});

/* ------------------------------------------------------------- properties */

test('the catalogue groups into the twelve sections a layer has', () => {
  const sections = layerSections();
  const ids = sections.map((s) => s.id);
  assert.deepEqual(ids.slice(0, 3), ['source', 'position', 'opacity']);
  assert.equal(sections.reduce((n, s) => n + s.params.length, 0), 67);
  /* Every section has a human label, including any the catalogue grows later. */
  assert.ok(sections.every((s) => typeof s.label === 'string' && s.label));
});

test('a property addresses a letter, never PROGRAM or PREVIEW', () => {
  const spec = layerSpec('position.posH');
  assert.equal(
    toAwj(paramPath({ id: 'S1', bank: 'A', layer: '1' }, spec)),
    'DeviceObject/$screen/@items/S1/$preset/@items/A/$layer/@items/1/position/@props/posH');
  assert.ok(
    paramPath({ id: 'A2', bank: 'B', layer: '1' }, spec).includes('auxiliaryList'));
  assert.equal(paramPath({ id: 'S1', bank: 'A' }, spec), null);
});

test('values come out of the real store', () => {
  const target = { id: 'S1', bank: 'A', layer: 'NATIVE' };
  assert.equal(readValue(store, target, layerSpec('position.posH')), 960);
  assert.equal(readValue(store, target, layerSpec('source.inputNum')), 'NONE');
});

test('coercion clamps numbers, rounds ints and refuses nonsense', () => {
  const posH = layerSpec('position.posH');
  assert.deepEqual(coerce(posH, '1200'), { ok: true, value: 1200, note: null });
  assert.equal(coerce(posH, 9e9).value, posH.max);
  assert.match(coerce(posH, 9e9).note, /clamped/);
  assert.equal(coerce(posH, 'not a number').ok, false);

  const red = layerSpec('source.color.red');
  assert.equal(coerce(red, 12.6).value, 13);
  assert.equal(coerce(red, -5).value, 0);
});

test('an enum only accepts its own members, and read-only refuses outright', () => {
  const src = layerSpec('source.inputNum');
  assert.equal(coerce(src, 'LIVE_1').ok, true);
  assert.equal(coerce(src, 'LIVE_999').ok, false);
  assert.ok(valuesFor(src).includes('NONE'));
  assert.equal(coerce(layerSpec('source.status.inputNum'), 'NONE').ok, false);
});

test('a flag set is written whole, deduplicated, and capacity-checked', () => {
  const flags = layerSpec('effects.flags');
  assert.deepEqual(coerce(flags, ['FLIP_H', 'FLIP_H', 'SEPIA']).value, ['FLIP_H', 'SEPIA']);
  assert.equal(coerce(flags, ['NOT_A_FLAG']).ok, false);
  assert.deepEqual(coerce(flags, 'FLIP_H').value, []);
});

test('a write carries the clamp note it applied', () => {
  const cmd = writeCmd({ id: 'S1', bank: 'A', layer: '1' }, layerSpec('opacity.opacity'), 99999);
  assert.equal(cmd.value, layerSpec('opacity.opacity').max);
  assert.match(cmd.note, /clamped/);
  assert.equal(writeCmd({ id: 'S1', bank: 'A', layer: '1' }, layerSpec('position.posH'), 'x'), null);
});

test('only the layers the hardware actually has are offered', () => {
  const keys = fittedLayers(store, 'S1').map((l) => l.key);
  /* Two live layers. The preset carries geometry for all 128 slots and the
     screen's own list carries every key including NATIVE, so anything that
     read either one alone would offer a picker full of layers that do not
     exist. NATIVE is OFF on this screen — it is a layer slot that costs
     mixers, not the background, and it is not allocated here. */
  assert.deepEqual(keys, ['1', '2']);
});

test('NATIVE is offered when it is allocated, and sorts below the numbers', () => {
  const s = new DeviceStore();
  s.hydrate(fixture('aquilon-6.2.73-memories.json'));
  s.set(['device', 'screenList', 'items', 'S1', 'layerList', 'items', 'NATIVE',
    'status', 'pp', 'capability'], '4K');
  assert.deepEqual(fittedLayers(s, 'S1').map((l) => l.key), ['1', '2', 'NATIVE']);
});

test('PROGRAM and PREVIEW resolve to a letter, and say when it is on air', () => {
  /* S1 rests at AT_UP with presetUp B, so B is program and A is preview. */
  const pgm = bankLetter(store, 'S1', 'PROGRAM');
  assert.equal(pgm.letter, 'B');
  assert.equal(pgm.live, true);
  assert.equal(pgm.settled, true);

  const prw = bankLetter(store, 'S1', 'PREVIEW');
  assert.equal(prw.letter, 'A');
  assert.equal(prw.live, false);

  /* A literal letter passes through, but still reports whether it is on air —
     editing the live buffer is legitimate, it just must not be a surprise. */
  assert.equal(bankLetter(store, 'S1', 'B').live, true);
  assert.equal(bankLetter(store, 'S1', 'A').live, false);
});

test('mid-take, the resolution is reported unsettled rather than guessed', () => {
  const s = new DeviceStore();
  s.hydrate(fixture('aquilon-6.2.73-memories.json'));
  s.set(['device', 'screenAuxGroupList', 'items', 'S1', 'status', 'pp', 'transition'],
    'EFFECT_FROM_UP');
  const r = bankLetter(s, 'S1', 'PREVIEW');
  assert.equal(r.settled, false);
  /* Still names the letter the take started from, so a reader can carry on. */
  assert.equal(r.letter, 'A');
});
