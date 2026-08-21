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
import {
  readMixers, readSide, diffSides, inspectMapping, layerLabel, layerShort,
  summarise, parseMixerId, MIXER_PROPS, LINKS_PER_VPU
} from '../src/core/vpu.js';
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

/*
 * The VPU model itself is vendored from aquilon-vpu-map and tested there. What
 * is tested here is the adapter: that the device store yields exactly the
 * record shape that model expects.
 *
 * aquilon-c-6output-5k.json is a real capture from an Aquilon C, taken through
 * that tool - S1 a six-output screen with a native layer plus two more, S2 at
 * 5K. It is deliberately the awkward configuration: the simpler capture alone
 * supports assumptions this one disproves.
 */

/** Wrap flat mixer records back into the store shape the device serves. */
function storeWithMixers(current, next = null, screenStatus = null) {
  const side = (mixers) => {
    const items = {};
    for (const [id, rec] of Object.entries(mixers)) {
      if (!rec.isAvailable) { items[id] = { pp: { isAvailable: false } }; continue; }
      const { mixerAllocation, scalers, ...pp } = rec;
      items[id] = {
        pp: { ...pp, isAvailable: true },
        mixerAllocation: { pp: { ...mixerAllocation } }
      };
      if (scalers) {
        items[id].scalerList = {
          itemKeys: Object.keys(scalers),
          items: Object.fromEntries(Object.entries(scalers).map(([k, v]) => [k, { pp: { ...v } }]))
        };
      }
    }
    return {
      status: { mapping: { deviceList: { itemKeys: ['1'], items: { 1: {
        vpuMixerList: { itemKeys: Object.keys(mixers), items }
      } } } } },
      screenList: screenStatus
        ? { itemKeys: Object.keys(screenStatus),
            items: Object.fromEntries(Object.entries(screenStatus).map(([k, v]) => [k, { status: { pp: v } }])) }
        : undefined
    };
  };
  return storeFrom({ device: { preconfig: { resources: {
    current: side(current),
    new: side(next || current)
  } } } });
}

test('a real capture survives the round trip into store shape and back', () => {
  const capture = fixture('aquilon-c-6output-5k.json');
  const store = storeWithMixers(capture.current);
  const mixers = readMixers(store, { which: 'current', device: '1' });

  for (const [id, before] of Object.entries(capture.current)) {
    if (!before.isAvailable) { assert.deepEqual(mixers[id], { isAvailable: false }, id); continue; }
    for (const prop of MIXER_PROPS) assert.equal(mixers[id][prop], before[prop], `${id}.${prop}`);
    assert.deepEqual(mixers[id].mixerAllocation, before.mixerAllocation, id);
  }
});

test('the shared model reads the capture the same way through the adapter', () => {
  const capture = fixture('aquilon-c-6output-5k.json');
  const side = readSide(storeWithMixers(capture.current), 'current');
  const direct = summarise(capture.current);
  assert.deepEqual(side.devices[0].summary, direct,
    'the adapter must not change what the model concludes');

  /* The capture: S1 native plus two layers, S2 at 5K. Runs are per
     (screen, layer), and a six-output screen spends two mixers per slice. */
  const sum = side.devices[0].summary;
  assert.equal(sum.enabled, 24);
  assert.ok(sum.allocations.some((a) => a.screen === 'S1' && a.layer === 'NATIVE'));
  assert.ok(sum.allocations.some((a) => a.capability === '5K'),
    'the 5K layer must survive - capacity is read from the enum position');
});

test('the link grid takes its columns from the output links the device reports', () => {
  const capture = fixture('aquilon-c-6output-5k.json');
  const side = readSide(storeWithMixers(capture.current), 'current');
  const grids = side.devices[0].grids;
  const drawn = grids.filter((g) => g.blocks.length);
  assert.ok(drawn.length, 'expected at least one populated VPU');
  assert.equal(drawn[0].placement, 'reported-columns');

  for (const g of drawn) {
    assert.ok(!g.overflow, `VPU ${g.vpu} must fit in ${LINKS_PER_VPU} link rows`);
    for (const b of g.blocks) {
      assert.ok(b.cols.length > 0, `${b.mixer} must sit on at least one output link`);
      // Natives are laid out in the band below the field, rows LINKS_PER_VPU up.
      if (b.section === 'background') assert.ok(b.row >= LINKS_PER_VPU, `${b.mixer} in the band`);
      else assert.ok(b.row >= 0 && b.row < LINKS_PER_VPU, `${b.mixer} row in range`);
      // The columns the device reports are the screen's own links, contiguous.
      for (let i = 1; i < b.cols.length; i++) {
        assert.equal(b.cols[i], b.cols[i - 1] + 1, `${b.mixer} bar is continuous`);
      }
    }
  }
});

test('optimized mode is resolved from screen status onto whole VPUs', () => {
  const capture = fixture('aquilon-c-6output-5k.json');
  const status = { S1: { mode: 'FREESTYLE', isOptimized: true, outputCount: 6 },
                   S2: { mode: 'FREESTYLE', isOptimized: false, outputCount: 1 },
                   S9: { mode: 'DISABLED' } };
  const store = storeWithMixers(capture.current, null, status);
  const side = readSide(store, 'current');

  assert.deepEqual(Object.keys(side.screenStatus), ['S1', 'S2'], 'DISABLED screens are dropped');
  /* Optimized belongs to the VPU, not to the screen that triggered it. */
  const s1Vpus = new Set(Object.entries(capture.current)
    .filter(([, r]) => r.isEnabled && r.usedInScreen === 'S1')
    .map(([id]) => parseMixerId(id).processor));
  assert.deepEqual([...side.devices[0].optimized].sort(), [...s1Vpus].sort());
});

test('a staged change to output links alone is still reported as a change', () => {
  const capture = fixture('aquilon-c-6output-5k.json');
  const staged = structuredClone(capture.current);
  const victim = Object.keys(staged).find((id) => staged[id].isEnabled);
  staged[victim].mixerAllocation.usedOnOutPipe1 = '8';

  const store = storeWithMixers(capture.current, staged);
  const diffs = diffSides(store);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].changes.length, 1);
  assert.equal(diffs[0].changes[0].mixer, victim);
  assert.equal(diffs[0].changes[0].changed[0].prop, 'link 1');
});

test('an unchanged preconfig produces an empty diff', () => {
  const capture = fixture('aquilon-c-6output-5k.json');
  assert.deepEqual(diffSides(storeWithMixers(capture.current)), []);
});

test('a simulator is reported as having no VPU, not as an empty chassis', () => {
  const store = storeFrom(fixture('sim-6.2.73-resources.json'));
  const info = inspectMapping(store, 'current');
  assert.equal(info.present, false);
  /* vpuLayerList present, vpuMixerList absent: $vpuLayer answers E12 on real
     hardware, so this collection is a simulator artefact rather than a second
     firmware generation, and the panel has to say so. */
  assert.equal(info.reason, 'simulator');
  assert.equal(readSide(store, 'current'), null);
});

test('NATIVE is named as a layer, never as the background', () => {
  /* Backgrounds live in preconfig/backgrounds and cost no mixer at all;
     NATIVE is a layer slot that does. Conflating them is the trap. */
  assert.equal(layerLabel('NATIVE'), 'Native layer');
  assert.equal(layerShort('NATIVE'), 'NAT');
  assert.equal(layerLabel('2'), 'Layer 2');
  assert.doesNotMatch(layerLabel('NATIVE').toLowerCase(), /background/);
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

