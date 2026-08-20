/*
 * Tests for the parts that have no DOM in them.
 *
 * Two of the fixtures are real: sim-6.2.73-resources.json and
 * sim-6.2.73-screens.json were cut straight out of GET /api/stores/device on
 * a running LivePremier simulator, so the scaler-model path and the screen
 * enumeration are tested against the device's own words rather than against
 * what the protocol guide claims. mixer-model.json is hand-authored to the
 * shape the older firmware reports, which is the branch a simulator cannot
 * produce.
 *
 * Run: node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { toAwj, CMD, screenAuxControl, ROOT } from '../src/core/paths.js';
import { DeviceStore } from '../src/core/device-store.js';
import { readMap, diffMaps, detectVariant } from '../src/core/vpu.js';
import { CueStack, ACTION_KINDS, toTenths, SETTLE_MS } from '../src/core/cuestack.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const storeFrom = (data) => { const s = new DeviceStore(); s.hydrate(data); return s; };

/* ------------------------------------------------------------------ paths */

test('store paths translate to the documented AWJ paths', () => {
  assert.equal(
    toAwj(CMD.take('S1').path),
    'DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake');
  assert.equal(
    toAwj(CMD.recallScreenPreset(3, 'S1', 'PREVIEW').path),
    'DeviceObject/presetBank/control/load/$slot/@items/3/$screen/@items/S1/$preset/@items/PREVIEW/@props/xRequest');
  assert.equal(
    toAwj(CMD.recallMasterPreset(7, 'PROGRAM').path),
    'DeviceObject/masterPresetBank/control/load/$slot/@items/7/$preset/@items/PROGRAM/@props/xRequest');
});

test('auxiliaries recall through the auxiliary list, screens through the screen list', () => {
  assert.ok(CMD.recallScreenPreset(1, 'A3', 'PREVIEW').path.includes('auxiliaryList'));
  assert.ok(CMD.recallScreenPreset(1, 'S3', 'PREVIEW').path.includes('screenList'));
  /* Both still take on the one combined list - that split is only in presets. */
  assert.deepEqual(CMD.take('A3').path, screenAuxControl('A3', 'xTake'));
});

/* ------------------------------------------------------------- deviceStore */

test('store applies writes and notifies only matching prefixes', () => {
  const store = storeFrom(fixture('sim-6.2.73-screens.json'));
  const seen = [];
  store.subscribe([ROOT, 'screenAuxGroupList', 'items', 'S1'], (ev) => seen.push(ev), { immediate: false });
  store.subscribe([ROOT, 'screenAuxGroupList', 'items', 'A1'], () => seen.push('a1'), { immediate: false });

  store.set([ROOT, 'screenAuxGroupList', 'items', 'S1', 'status', 'pp', 'take'], 'ON');
  assert.equal(store.get([ROOT, 'screenAuxGroupList', 'items', 'S1', 'status', 'pp', 'take']), 'ON');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].value, 'ON');

  /* A write of the same value is not a change and must not wake subscribers. */
  store.set([ROOT, 'screenAuxGroupList', 'items', 'S1', 'status', 'pp', 'take'], 'ON');
  assert.equal(seen.length, 1);
});

test('store creates missing branches rather than dropping the write', () => {
  const store = storeFrom({ device: {} });
  store.set([ROOT, 'newThing', 'items', 'X', 'pp', 'value'], 42);
  assert.equal(store.get([ROOT, 'newThing', 'items', 'X', 'pp', 'value']), 42);
});

test('itemKeys prefers the device order over object key order', () => {
  const store = storeFrom(fixture('sim-6.2.73-screens.json'));
  const keys = store.itemKeys([ROOT, 'screenAuxGroupList']);
  assert.deepEqual(keys, ['S1', 'A1', 'A3']);
});

/* --------------------------------------------------------------------- vpu */

test('scaler-model firmware is read from a real simulator snapshot', () => {
  const store = storeFrom(fixture('sim-6.2.73-resources.json'));
  assert.equal(detectVariant(store).variant, 'scaler');

  const map = readMap(store, 'current');
  assert.equal(map.variant, 'scaler');
  assert.equal(map.devices.length, 4);
  /* 4 devices x 32 units. Nothing is fitted on this simulated chassis, which
     is exactly the case a naive reader would mistake for "no VPU support". */
  assert.equal(map.totals.total, 128);
  assert.equal(map.totals.available, 0);
  assert.equal(map.totals.enabled, 0);
  assert.equal(map.devices[0].fitted, false);
});

test('mixer-model firmware yields the same shape, with slices', () => {
  const store = storeFrom(fixture('mixer-model.json'));
  assert.equal(detectVariant(store).variant, 'mixer');

  const map = readMap(store, 'current');
  assert.equal(map.totals.total, 6);
  assert.equal(map.totals.available, 5);
  assert.equal(map.totals.enabled, 4);
  assert.equal(map.totals.spare, 1);

  const unit = map.devices[0].units[0];
  assert.equal(unit.proc, 1);
  assert.equal(unit.index, 1);
  assert.equal(unit.slice, 0);
  assert.deepEqual(unit.pipes, [{ index: 1, output: '1' }]);
  assert.deepEqual(unit.scalers.A, { fill: 'SM5', cut: 'SM1' });

  /* S1 holds two slices of its background; S2 holds a background and a layer. */
  assert.equal(map.byScreen.get('S1').get('NATIVE').length, 2);
  assert.equal(map.byScreen.get('S2').get('1').length, 1);
});

test('a unit that is enabled but not available is not counted as allocated', () => {
  const data = fixture('mixer-model.json');
  const items = data.device.preconfig.resources.current.status.mapping
    .deviceList.items['1'].vpuMixerList.items;
  items.PROC_2_MIXER_1.pp.isEnabled = true; // available stays false
  const map = readMap(storeFrom(data), 'current');
  assert.equal(map.totals.enabled, 4);
});

test('diffing current against staged is what makes the map worth drawing', () => {
  const store = storeFrom(fixture('mixer-model.json'));
  const changes = diffMaps(readMap(store, 'current'), readMap(store, 'new'));
  const byKey = Object.fromEntries(changes.map((c) => [c.key, c]));

  /* MIXER_4 moves from S2 to S3, and the spare MIXER_5 is called into use. */
  assert.deepEqual(byKey['1/PROC_1_MIXER_4'].fields, ['screen']);
  assert.equal(byKey['1/PROC_1_MIXER_4'].after.screen, 'S3');
  assert.ok(byKey['1/PROC_1_MIXER_5'].fields.includes('enabled'));
  assert.equal(changes.length, 2);
});

test('an unchanged preconfig produces an empty diff', () => {
  const store = storeFrom(fixture('sim-6.2.73-resources.json'));
  assert.deepEqual(diffMaps(readMap(store, 'current'), readMap(store, 'new')), []);
});

test('a firmware reporting neither collection is reported as unknown, not empty', () => {
  const store = storeFrom({ device: { preconfig: { resources: { current: { status: { mapping: { deviceList: { items: { 1: {} } } } } } } } } });
  assert.equal(detectVariant(store), null);
  assert.equal(readMap(store, 'current'), null);
});

/* --------------------------------------------------------------- cuestack */

function recordingStack() {
  const sent = [];
  const now = { t: 0 };
  const timers = [];
  const clock = {
    setTimeout: (fn, ms) => { timers.push({ fn, at: now.t + ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    now: () => now.t
  };
  const advance = (ms) => {
    now.t += ms;
    for (const t of timers) {
      if (!t.cancelled && !t.done && t.at <= now.t) { t.done = true; t.fn(); }
    }
  };
  const stack = new CueStack({ send: (cmd) => { sent.push(cmd); return true; }, clock });
  return { stack, sent, advance };
}

test('a cue writes its transition time before it pulls the trigger', () => {
  const { stack, sent, advance } = recordingStack();
  stack.add({
    number: '1', fade: 2.5,
    actions: [
      { kind: ACTION_KINDS.SCREEN_PRESET, slot: 4, targets: ['S1'], mode: 'PREVIEW' },
      { kind: ACTION_KINDS.TAKE, targets: ['S1'] }
    ]
  });
  stack.go();
  advance(SETTLE_MS);

  const props = sent.map((c) => c.path[c.path.length - 1]);
  assert.deepEqual(props, ['xRequest', 'takeUpTime', 'takeDownTime', 'xTake']);
  assert.equal(sent[1].value, 25); // tenths of a second
  assert.equal(toTenths(2.5), 25);
});

test('a TAKE never overtakes the recall in its own cue', () => {
  const { stack, sent, advance } = recordingStack();
  stack.add({
    actions: [
      { kind: ACTION_KINDS.SCREEN_PRESET, slot: 4, targets: ['S1'], mode: 'PREVIEW' },
      { kind: ACTION_KINDS.TAKE, targets: ['S1'] }
    ]
  });
  stack.go();

  /* Recall out, trigger held. Sending both at once lets the device transition
     the PREVIOUS preview contents to air - wrong picture, and silent. */
  assert.deepEqual(sent.map((c) => c.path[c.path.length - 1]), ['xRequest']);
  advance(SETTLE_MS - 1);
  assert.equal(sent.length, 1);
  advance(1);
  assert.deepEqual(sent.map((c) => c.path[c.path.length - 1]), ['xRequest', 'xTake']);
});

test('a cue with nothing in flight triggers immediately', () => {
  const { stack, sent } = recordingStack();
  stack.add({ actions: [{ kind: ACTION_KINDS.TAKE, targets: ['S1'] }] });
  stack.go();
  assert.deepEqual(sent.map((c) => c.path[c.path.length - 1]), ['xTake']);
  assert.equal(stack.log[0].settled, false);
});

test('a cue with no fade leaves the screen transition times alone', () => {
  const { stack, sent } = recordingStack();
  stack.add({ actions: [{ kind: ACTION_KINDS.CUT, targets: ['S1', 'A1'] }] });
  stack.go();
  assert.deepEqual(sent.map((c) => c.path[c.path.length - 1]), ['xCut', 'xCut']);
});

test('follow chains fire on the clock, and stop cancels the chain', () => {
  const { stack, sent, advance } = recordingStack();
  stack.add({ number: '1', follow: true, followTime: 3, actions: [{ kind: ACTION_KINDS.TAKE, targets: ['S1'] }] });
  stack.add({ number: '2', follow: true, followTime: 5, actions: [{ kind: ACTION_KINDS.TAKE, targets: ['S2'] }] });
  stack.add({ number: '3', actions: [{ kind: ACTION_KINDS.TAKE, targets: ['S3'] }] });

  stack.go();
  assert.equal(sent.length, 1);
  assert.equal(stack.pointer, 1);

  advance(3000);
  assert.equal(sent.length, 2);

  stack.stop();
  advance(10000);
  assert.equal(sent.length, 2, 'the third cue must not fire after stop');
  assert.equal(stack.running, false);
});

test('GO during a delay fires immediately instead of queueing a second one', () => {
  const { stack, sent, advance } = recordingStack();
  stack.add({ delay: 10, actions: [{ kind: ACTION_KINDS.TAKE, targets: ['S1'] }] });
  stack.add({ actions: [{ kind: ACTION_KINDS.TAKE, targets: ['S2'] }] });

  stack.go();
  assert.equal(sent.length, 0, 'armed, not fired');
  stack.go();
  assert.equal(sent.length, 1);

  advance(20000);
  assert.equal(sent.length, 1, 'the cancelled delay must not fire later');
});

test('disabled cues are stepped over without sending anything', () => {
  const { stack, sent } = recordingStack();
  stack.add({ enabled: false, actions: [{ kind: ACTION_KINDS.TAKE, targets: ['S1'] }] });
  stack.go();
  assert.equal(sent.length, 0);
  assert.equal(stack.pointer, 1);
});

test('a stack survives a round trip through JSON', () => {
  const { stack } = recordingStack();
  stack.name = 'Act 1';
  stack.add({ number: '1', label: 'House to half', fade: 3, actions: [{ kind: ACTION_KINDS.TAKE, targets: ['S1'] }] });
  const clone = new CueStack({ send: () => true });
  assert.ok(clone.load(JSON.parse(JSON.stringify(stack.toJSON()))));
  assert.equal(clone.name, 'Act 1');
  assert.equal(clone.cues[0].label, 'House to half');
  assert.equal(clone.cues[0].fade, 3);
});

test('a send that never left the browser is reported, not swallowed', () => {
  const stack = new CueStack({ send: () => false });
  const failures = [];
  stack.addEventListener('sendFailed', (ev) => failures.push(ev.detail.cmd));
  stack.add({ actions: [{ kind: ACTION_KINDS.TAKE, targets: ['S1'] }] });
  const record = stack.fire(stack.cues[0]);
  assert.equal(record.sent, 0);
  assert.equal(failures.length, 1);
});

test('a map can be handed to the standalone aquilon-vpu-map tool unchanged', async () => {
  const { toMixerRecords } = await import('../src/core/vpu.js');
  const map = readMap(storeFrom(fixture('mixer-model.json')), 'current');
  const records = toMixerRecords(map, '1');

  assert.equal(records.PROC_1_MIXER_1.isAvailable, true);
  assert.equal(records.PROC_1_MIXER_1.slice, 0);
  assert.equal(records.PROC_1_MIXER_1.mixerAllocation.usedOnOutPipe1, '1');
  assert.equal(records.PROC_1_MIXER_1.mixerAllocation.usedOnOutPipe2, 'NONE');
  assert.equal(records.PROC_1_MIXER_1.scalers.A.memoryFill, 'SM5');
  assert.deepEqual(records.PROC_2_MIXER_1, { isAvailable: false });
});
