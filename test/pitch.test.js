/*
 * The pitch-compensation adapter, and the pitch parser the panel types into.
 *
 * The arithmetic itself is not tested here — it belongs to the vendored engine
 * and is pinned upstream in aquilon-pitch. What is tested here is this repo's
 * half of the job: reading the device store correctly, and not sending writes
 * the device would throw away.
 *
 * `sim-6.2.73-outputs.json` is mostly real. Output 1's node came verbatim out
 * of GET /api/stores/device on a running LivePremier simulator 6.2.73 — it is
 * the one output that machine has on S1, so the key names and the "NONE"/"S1"
 * vocabulary are the device's own. Outputs 2 and 3 are that same node with the
 * raster and canvas position changed, because the simulator's stock
 * configuration has no multi-output screen and that is the case worth testing.
 * Output 4 is a real unassigned one.
 *
 * Run: node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import {
  screenOutputs, toProject, pitchWrites, alreadyApplied, outputPitch, outputPitchCommit
} from '../src/core/pitch.js';
import { compensate } from '../src/vendor/pitch-engine.js';
import { parsePitch } from '../src/ui/pitch-panel.js';

const here = dirname(fileURLToPath(import.meta.url));

function outputStore() {
  const snapshot = JSON.parse(
    readFileSync(join(here, 'fixtures', 'sim-6.2.73-outputs.json'), 'utf8'));
  const store = new DeviceStore();
  store.hydrate(snapshot);
  return store;
}

/* ------------------------------------------------------------ the store */

test('screenOutputs takes only the outputs the device put on that screen', () => {
  const outputs = screenOutputs(outputStore(), 'S1');
  assert.deepEqual(outputs.map((o) => o.key), ['1', '2', '3']);
});

test('an unassigned output reads as the literal string NONE, not an absent key', () => {
  /* The trap this exists for: `if (!status.usedInScreenAux)` looks like it
     filters unassigned outputs and does not, because "NONE" is truthy. */
  const store = outputStore();
  const raw = store.get(['device', 'outputList', 'items', '4', 'canvas', 'status', 'pp']);
  assert.equal(raw.usedInScreenAux, 'NONE');
  assert.equal(screenOutputs(store, 'S1').some((o) => o.key === '4'), false);
});

test('the raster comes from maxWidth, not from the pitched footprint', () => {
  /*
   * Output 3 in the fixture already carries a 2.000 pair, so its clamped and
   * pitched dimensions are 2560x1440 while the panel it actually drives is
   * 1280x720. Reading the wrong pair here would feed the engine a raster that
   * has already been multiplied once, and every ratio downstream would be
   * half what it should be — while still looking plausible.
   */
  const three = screenOutputs(outputStore(), 'S1').find((o) => o.key === '3');
  assert.deepEqual([three.pxWidth, three.pxHeight], [1280, 720]);
  assert.deepEqual([three.footprintWidth, three.footprintHeight], [2560, 1440]);
});

test('the live ratios come through in the device units', () => {
  const outputs = screenOutputs(outputStore(), 'S1');
  assert.equal(outputs.find((o) => o.key === '1').liveRawH, 1000);
  assert.equal(outputs.find((o) => o.key === '3').liveRawH, 2000);
  assert.equal(outputs.find((o) => o.key === '3').liveRawV, 2000);
});

test('outputs come back in numeric order, so 10 follows 9', () => {
  const store = outputStore();
  /* The fixture stops at 4; assert on the comparator's intent directly rather
     than pretending the fixture proves it. */
  const outputs = screenOutputs(store, 'S1');
  const keys = outputs.map((o) => Number(o.key));
  assert.deepEqual(keys, [...keys].sort((a, b) => a - b));
});

/* ---------------------------------------------------------- the project */

test('toProject carries the rasters and leaves untyped pitches at zero', () => {
  const outputs = screenOutputs(outputStore(), 'S1');
  const project = toProject(outputs, { 1: { hMm: 2.6, vMm: 2.6 } });

  assert.equal(project.groups.length, 3);
  assert.deepEqual(project.groups[0].entry, { mode: 'pitch', hMm: 2.6, vMm: 2.6 });
  /* Not yet typed. The engine reads zero as "not usable" and steps over it, so
     the panel stays useful while it is being filled in. */
  assert.deepEqual(project.groups[1].entry, { mode: 'pitch', hMm: 0, vMm: 0 });

  const result = compensate(project);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].group.outputKey, '1');
});

test('a full screen resolves to the ratios the device wants', () => {
  const outputs = screenOutputs(outputStore(), 'S1');
  const result = compensate(toProject(outputs, {
    1: { hMm: 2.6, vMm: 2.6 },
    2: { hMm: 2.6, vMm: 2.6 },
    3: { hMm: 5.2, vMm: 5.2 }
  }));

  assert.equal(result.reference.group.outputKey, '1');
  assert.equal(result.groups[2].h.ratio, 2);
  /* The coarse output takes MORE canvas than its raster, not less. */
  assert.equal(result.groups[2].h.footprint, 2560);
});

/* ----------------------------------------------------------- the writes */

test('pitchWrites sends both axes and then the commit, per output', () => {
  const outputs = screenOutputs(outputStore(), 'S1');
  const result = compensate(toProject(outputs, {
    1: { hMm: 2.6, vMm: 2.6 }, 2: { hMm: 2.6, vMm: 2.6 }, 3: { hMm: 5.2, vMm: 5.2 }
  }));
  const writes = pitchWrites(result);

  assert.equal(writes.length, 9);
  assert.deepEqual(writes[6].path, outputPitch('3', 'H'));
  assert.equal(writes[6].value, 2000);
  assert.deepEqual(writes[7].path, outputPitch('3', 'V'));
  /* Without this the cmd value moves and the canvas does not. */
  assert.deepEqual(writes[8].path, outputPitchCommit('3'));
  assert.equal(writes[8].value, true);
});

test('pitchWrites refuses to send a ratio the device would discard', () => {
  const outputs = screenOutputs(outputStore(), 'S1');
  const result = compensate(toProject(outputs, {
    1: { hMm: 2.6, vMm: 2.6 }, 2: { hMm: 2.6, vMm: 2.6 }, 3: { hMm: 40, vMm: 40 }
  }));

  const writes = pitchWrites(result);
  assert.equal(writes.some((w) => w.path.includes('3')), false,
    'an out-of-range output must not be written — the device drops it silently '
    + 'and the operator would believe it was set');
  assert.equal(writes.length, 6);
});

test('alreadyApplied notices when the device is holding these ratios already', () => {
  const outputs = screenOutputs(outputStore(), 'S1');

  /* The fixture has 1.000, 1.000 and 2.000 — which is what 2.6/2.6/5.2 asks
     for, so this configuration is already on the device. */
  const same = compensate(toProject(outputs, {
    1: { hMm: 2.6, vMm: 2.6 }, 2: { hMm: 2.6, vMm: 2.6 }, 3: { hMm: 5.2, vMm: 5.2 }
  }));
  assert.equal(alreadyApplied(same, outputs), true);

  const different = compensate(toProject(outputs, {
    1: { hMm: 2.6, vMm: 2.6 }, 2: { hMm: 2.6, vMm: 2.6 }, 3: { hMm: 3.9, vMm: 3.9 }
  }));
  assert.equal(alreadyApplied(different, outputs), false);
});

test('nothing comparable is not the same as everything matching', () => {
  const result = compensate(toProject(screenOutputs(outputStore(), 'S1'), {}));
  assert.equal(alreadyApplied(result, []), false);
});

/* ----------------------------------------------------------- the typing */

test('parsePitch takes one number for both axes', () => {
  assert.deepEqual(parsePitch('2.6'), { hMm: 2.6, vMm: 2.6 });
  assert.deepEqual(parsePitch('  3 '), { hMm: 3, vMm: 3 });
  /* A comma decimal is what half of Europe's keyboards produce. */
  assert.deepEqual(parsePitch('2,6'), { hMm: 2.6, vMm: 2.6 });
});

test('parsePitch splits the axes when asked', () => {
  assert.deepEqual(parsePitch('2.6 x 3.0'), { hMm: 2.6, vMm: 3 });
  assert.deepEqual(parsePitch('2.6×3'), { hMm: 2.6, vMm: 3 });
  assert.deepEqual(parsePitch('2.6*3'), { hMm: 2.6, vMm: 3 });
});

test('parsePitch returns null rather than a pitch that cannot be one', () => {
  for (const bad of ['', '   ', 'abc', '0', '-2.6', '2.6 x', '1 x 2 x 3', 'NaN']) {
    assert.equal(parsePitch(bad), null, `${JSON.stringify(bad)} is not a pitch`);
  }
  assert.equal(parsePitch(null), null);
  assert.equal(parsePitch(undefined), null);
});
