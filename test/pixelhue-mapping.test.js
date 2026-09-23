/*
 * The Pixelhue mapping table: what each function key, fader and encoder does,
 * and the U5 drawing the Pixelhue Mapping page is laid out from.
 *
 * The defaults are pinned against `readIntent`, because the one promise the
 * table makes is that with nothing changed, every key does exactly what it
 * did before the table existed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KEY_CONTROLS, MOTION_CONTROLS, KEY_ACTIONS, controlForCode, controlForKeyMode, mappedIntent,
  normaliseMap, actionOf, resolvedMap, intentOf, validAction, legendOf,
} from '../plugins/pixelhue/mapping.js';
import { readIntent, midiWrite, ENCODER_STEP, COMMAND, SILENT_KEY_MODES, normalisePixelhue } from '../plugins/pixelhue/core.js';
import { U5 } from '../plugins/pixelhue/layout.js';
import { NLC } from '../src/core/dialect.js';

const strip = (i) => {
  if (!i) return i;
  const { control, mapping, ...rest } = i;
  return rest;
};

test('with nothing changed, every command a control owns means what readIntent says it means', () => {
  for (const c of KEY_CONTROLS) {
    for (const code of [...(c.codes || []), ...(c.repeat || [])]) {
      const mapped = strip(mappedIntent({}, code));
      const plain = readIntent({ command: code, payload: {} });
      if (c.default === 'none') {
        assert.equal(plain, null, `${c.id} (${code}) was acted on before; its default must not be none`);
        assert.deepEqual(mapped, { kind: 'none' });
      } else {
        assert.deepEqual(mapped, plain, `${c.id} (${code})`);
      }
    }
  }
});

test('the bus, mode and paging commands are not in the table', () => {
  for (const code of [COMMAND.screenSelect, COMMAND.screenActive, COMMAND.screenUnselect, COMMAND.screenDelete,
    COMMAND.layerSelect, COMMAND.layerCreate, COMMAND.inputSwitch, COMMAND.playPreset, COMMAND.savePreset,
    COMMAND.deletePreset, COMMAND.presetSave, COMMAND.switchDel, COMMAND.pageUp, COMMAND.pageDown]) {
    assert.equal(controlForCode(code), null, `${code} must stay the console's`);
    assert.equal(mappedIntent({ take: 'cut' }, code), null);
  }
});

test('no command belongs to two controls, and every silent key mode is a control', () => {
  const seen = new Map();
  for (const c of KEY_CONTROLS) {
    for (const code of [...(c.codes || []), ...(c.repeat || [])]) {
      assert.ok(!seen.has(code), `${code} is claimed by ${seen.get(code)} and ${c.id}`);
      seen.set(code, c.id);
    }
  }
  for (const mode of Object.keys(SILENT_KEY_MODES)) assert.ok(controlForKeyMode(mode), `keyMode ${mode}`);
});

test('an override changes what a key does, and only that key', () => {
  const map = { switchDevice: 'take', cut: 'recall:7', mvr: 'companion:2/1/4' };
  assert.equal(mappedIntent(map, COMMAND.deviceSwitch).kind, 'take');
  assert.deepEqual(strip(mappedIntent(map, COMMAND.cut)), { kind: 'recall', slot: 7 });
  assert.deepEqual(intentOf(actionOf(map, 'mvr')), { kind: 'companion', location: { pageNumber: 2, row: 1, column: 4 } });
  assert.equal(mappedIntent(map, COMMAND.take).kind, 'take');
  assert.equal(mappedIntent(map, COMMAND.deviceSwitch).control, 'switchDevice');
});

test('a held key repeats only into an action that repeats', () => {
  const held = COMMAND.layerEffectTimeQuickAddStart;
  /* The default: TIME held keeps adding take time, as it always did. */
  assert.deepEqual(strip(mappedIntent({}, held)), { kind: 'time', delta: 1 });
  assert.equal(mappedIntent({}, held).repeat, undefined);
  /* Mapped to TAKE, the repeats are marked so the supervisor fires once per hold. */
  const once = mappedIntent({ time: 'take' }, held);
  assert.equal(once.kind, 'take');
  assert.equal(once.repeat, true);
  /* A click is not a repeat. */
  assert.equal(mappedIntent({ time: 'take' }, COMMAND.layerEffectTimeAdd).repeat, undefined);
});

test('the stored map keeps only real overrides', () => {
  assert.deepEqual(normaliseMap({
    take: 'cut',            // kept
    cut: 'cut',             // its default: dropped
    nonsense: 'take',       // no such control
    ftb: 'launchMissiles',  // no such action
    freeze: 'recall:0',     // no memory 0
    swap: 'recall:12',      // kept
    time: 'companion:1/0/3', // kept
    'fader.2': 'none',      // kept
    'fader.3': 'take',      // a fader cannot take
    'encoder.1': 'opacity', // kept
  }), { take: 'cut', swap: 'recall:12', time: 'companion:1/0/3', 'fader.2': 'none', 'encoder.1': 'opacity' });
  assert.deepEqual(normaliseMap(null), {});
  assert.deepEqual(normaliseMap(['take']), {});
  assert.deepEqual(normalisePixelhue({ pixelhueMap: { take: 'cut' } }).pixelhueMap, { take: 'cut' });
  assert.deepEqual(normalisePixelhue({}).pixelhueMap, {});
});

test('every control resolves, and every key action has a legend', () => {
  const all = resolvedMap({ take: 'cut' });
  assert.equal(Object.keys(all).length, KEY_CONTROLS.length + MOTION_CONTROLS.length);
  assert.equal(all.take, 'cut');
  assert.equal(all['fader.1'], 'layerOpacity');
  for (const a of KEY_ACTIONS) assert.notEqual(legendOf(a.id), '?', a.id);
  assert.equal(legendOf('recall:4'), 'MEM 4');
  assert.ok(validAction('take', 'companion:1/0/0'));
  assert.ok(!validAction('fader.1', 'take'));
});

test('faders and encoders follow the map', () => {
  const ctx = { dialect: NLC, destination: 'S1', letter: 'B', layer: 2 };
  const own = midiWrite({ control: 'fader', index: 3, percent: 50 }, ctx);
  assert.equal(own.layer, 3, 'the default: fader n is layer n');
  const sel = midiWrite({ control: 'fader', index: 3, percent: 50 }, { ...ctx, action: 'selectedOpacity' });
  assert.equal(sel.layer, 2, 'mapped: the selected layer');
  assert.equal(midiWrite({ control: 'fader', index: 3, percent: 50 }, { ...ctx, action: 'none' }).path, undefined);
  const x = midiWrite({ control: 'encoder', index: 1, ticks: 2 }, { ...ctx, current: 100 });
  assert.equal(x.param, 'posH');
  assert.equal(x.value, 100 + 2 * ENCODER_STEP);
  const op = midiWrite({ control: 'encoder', index: 1, ticks: 3 }, { ...ctx, current: 50, action: 'opacity' });
  assert.equal(op.param, 'opacity');
  assert.equal(op.value, 56, 'opacity moves 2 a detent');
});

test('the U5 drawing: every key once, every mapped key a real control, nothing overlapping', () => {
  const keys = U5.keys;
  assert.equal(new Set(keys.map((k) => k.key)).size, keys.length, 'a key code drawn twice');
  assert.equal(keys.length, 87, 'the virtual U5 has 91 key elements, four of them section bars');
  for (const k of keys) {
    if (k.kind === 'control') assert.ok(KEY_CONTROLS.some((c) => c.id === k.control), `key ${k.key}: ${k.control}`);
    assert.ok(k.x >= 0 && k.y >= 0 && k.x + k.w <= U5.width && k.y + k.h <= U5.height, `key ${k.key} off the board`);
  }
  for (const a of keys) {
    for (const b of keys) {
      if (a === b) continue;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `keys ${a.key} and ${b.key} overlap`);
    }
  }
  for (const page of U5.clusterPages) {
    for (const id of page.slots) if (id) assert.ok(KEY_CONTROLS.some((c) => c.id === id), id);
  }
  /* Every key control is somewhere a user can reach it. */
  const reachable = new Set([
    ...keys.filter((k) => k.kind === 'control').flatMap((k) => [k.control, k.also].filter(Boolean)),
    ...U5.clusterPages.flatMap((p) => p.slots).filter(Boolean),
    ...U5.elsewhere,
  ]);
  for (const c of KEY_CONTROLS) assert.ok(reachable.has(c.id), `${c.id} is on no key and in no list`);
});
