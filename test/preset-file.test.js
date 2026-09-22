/*
 * The memory bank's file format.
 *
 * The fixture is the evidence, not a convenience: `sim-6.2.73-memory.json`
 * holds a memory the simulator exported on 2026-09-22 **beside the live preset
 * node it was saved from**, for the same three layers of the same screen. So
 * the first test below is not a test of this file's arithmetic — it is the
 * proof that the name table in `core/preset-file.js` is the device's own
 * correspondence and not somebody's reading of it.
 *
 * If a future firmware renames a field, that test fails with the pair that
 * moved rather than with a memory that silently saves the wrong thing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import catalogue from '../src/vendor/surface/catalogue.json' with { type: 'json' };
import {
  toMemory, fromMemory, toPresetFile, fromPresetFile, layersFrom,
  unmappedParams, FIELD_BY_PARAM, UNMAPPED_DEFAULTS, CATEGORIES,
  fileLayerKey, storeLayerKey, NATIVE_KEY, FILE_NAME
} from '../src/core/preset-file.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/sim-6.2.73-memory.json', import.meta.url), 'utf8')
);

const MEMORY = fixture.memory[0];
const PREFIX = 'xPEMEM_BANK_';

const specOf = (id) => catalogue.layer.find((s) => s.id === id);
const at = (node, path) => path.reduce((n, seg) => (n == null ? undefined : n[seg]), node);

/* ------------------------------------------------- the table is the device's */

test('every mapped field matches the live preset node it was saved from', () => {
  let checked = 0;
  let meaningful = 0;

  for (const [key, node] of Object.entries(fixture.preset)) {
    const fields = MEMORY.Layer[fileLayerKey(key)];
    assert.ok(fields, `the fixture has a memory layer for ${key}`);

    for (const [paramId, field] of Object.entries(FIELD_BY_PARAM)) {
      const spec = specOf(paramId);
      assert.ok(spec, `${paramId} is in the catalogue`);
      assert.ok(!spec.readOnly, `${paramId} is writable — a memory cannot carry a read-only value`);

      const stored = at(node, spec.path);
      const inFile = fields[PREFIX + field];
      assert.deepEqual(inFile, stored, `${key} ${paramId} <-> ${field}`);
      checked++;
      /* A pair that agrees on 0 or NONE agrees by coincidence as easily as by
         correspondence. Counting the rest is what makes the total mean
         something, so the count is asserted too. */
      if (stored !== 0 && stored !== false && stored !== 'NONE' &&
          !(Array.isArray(stored) && stored.length === 0)) meaningful++;
    }
  }

  assert.equal(checked, Object.keys(FIELD_BY_PARAM).length * Object.keys(fixture.preset).length);
  assert.ok(meaningful >= 90, `at least ninety pairs agree on a non-default value (got ${meaningful})`);
});

test('the layer capability in the file is the screen\'s own, not the preset\'s', () => {
  for (const [key, capability] of Object.entries(fixture.capability)) {
    assert.equal(MEMORY.Layer[fileLayerKey(key)][PREFIX + 'LAYER_CAPABILITY'], capability);
  }
});

test('the catalogue has no writable parameter the table cannot spell', () => {
  assert.deepEqual(unmappedParams(), []);
});

test('the only file fields with no catalogue parameter are the five carried verbatim', () => {
  const mapped = new Set(Object.values(FIELD_BY_PARAM));
  const extra = Object.keys(MEMORY.Layer['1'])
    .map((k) => k.slice(PREFIX.length))
    .filter((f) => !mapped.has(f) && f !== 'LAYER_CAPABILITY')
    .sort();
  assert.deepEqual(extra, Object.keys(UNMAPPED_DEFAULTS).sort());
});

/* ------------------------------------------------------------ round trips */

test('a real memory survives being read and written again', () => {
  const look = fromMemory(MEMORY);
  const again = toMemory(look);
  assert.deepEqual(again, MEMORY, 'the device\'s own file is reproduced exactly');
});

test('a whole file round-trips', () => {
  const back = toPresetFile(fromPresetFile(fixture.memory));
  assert.deepEqual(back, fixture.memory);
});

test('a file parses from text as well as from an array', () => {
  assert.deepEqual(fromPresetFile(JSON.stringify(fixture.memory)), fromPresetFile(fixture.memory));
  /* Anything that is not a list of memories is nothing rather than a throw:
     the file may have been hand-edited, and an operator who mangles one wants
     to be told it is empty, not shown a stack trace. */
  assert.deepEqual(fromPresetFile({ BankSlot: 1 }), []);
});

test('NATIVE is layer zero, both ways', () => {
  assert.equal(fileLayerKey('NATIVE'), NATIVE_KEY);
  assert.equal(fileLayerKey('3'), '3');
  assert.equal(storeLayerKey(NATIVE_KEY), 'NATIVE');
  assert.equal(storeLayerKey('3'), '3');

  const look = fromMemory(MEMORY);
  assert.deepEqual(look.layers.map((l) => l.key), ['NATIVE', '1', '2']);
});

test('the memory header is read back in this app\'s own spelling', () => {
  const look = fromMemory(MEMORY);
  assert.equal(look.slot, MEMORY.BankSlot);
  assert.equal(look.label, MEMORY[PREFIX + 'LABEL']);
  assert.equal(look.duration, MEMORY[PREFIX + 'DURATION']);
  assert.deepEqual(look.canvas, {
    width: MEMORY[PREFIX + 'SCREEN_WIDTH'],
    height: MEMORY[PREFIX + 'SCREEN_HEIGHT']
  });
});

/* ------------------------------------------------------------- composing */

test('a composed memory declares every category, because it supplies every property', () => {
  const out = toMemory({
    slot: 900,
    label: 'Wide two-shot',
    duration: 25,
    canvas: { width: 1920, height: 1080 },
    layers: [{ key: '1', node: fixture.preset['1'], capability: 'DUAL' }]
  });

  assert.equal(out.BankSlot, 900);
  assert.equal(out[PREFIX + 'LABEL'], 'Wide two-shot');
  assert.equal(out[PREFIX + 'DURATION'], 25);
  assert.deepEqual(out[PREFIX + 'FILTER_CATEGORY'], CATEGORIES);
  assert.deepEqual(out[PREFIX + 'FILTER_LAYER'], ['1']);
  assert.equal(Object.keys(out.Layer['1']).length, 72, 'the device\'s own field count');
});

test('a property the look does not carry is left out rather than invented', () => {
  const thin = { source: { pp: { inputNum: 'LIVE_2' } } };
  const out = toMemory({
    slot: 4, canvas: { width: 1920, height: 1080 },
    layers: [{ key: 'NATIVE', node: thin, capability: 'OFF' }]
  });

  const fields = out.Layer[NATIVE_KEY];
  assert.equal(fields[PREFIX + 'INPUTNUM'], 'LIVE_2');
  assert.ok(!(PREFIX + 'POSH' in fields), 'a position nobody set is absent, not zero');
  /* The five with no live node are the exception: they are always emitted, at
     the device's own values, so a composed memory looks like a saved one. */
  for (const [field, value] of Object.entries(UNMAPPED_DEFAULTS)) {
    assert.equal(fields[PREFIX + field], value);
  }
  assert.equal(fields[PREFIX + 'LAYER_CAPABILITY'], 'OFF');
});

test('an unmapped field read off a real memory is carried back out unchanged', () => {
  const look = fromMemory(MEMORY);
  const layer = look.layers.find((l) => l.key === '1');
  layer.unmapped.ROTH = 42;
  const out = toMemory(look);
  assert.equal(out.Layer['1'][PREFIX + 'ROTH'], 42);
});

/* ---------------------------------------------------------------- layers */

test('layersFrom takes the slots the screen has and skips the ones it does not', () => {
  const bufferNode = { layerList: { items: { NATIVE: {}, 1: fixture.preset['1'] } } };
  const out = layersFrom(bufferNode, [
    { key: 'NATIVE', capability: 'OFF' },
    { key: '1', capability: 'DUAL' },
    { key: '7', capability: 'DUAL' }
  ]);

  assert.deepEqual(out.map((l) => l.key), ['NATIVE', '1'], 'layer 7 is fitted but not in this buffer');
  assert.equal(out[1].capability, 'DUAL');
});

test('the file has one name, whatever directory it lands in', () => {
  assert.equal(FILE_NAME, 'Preset.json');
});
