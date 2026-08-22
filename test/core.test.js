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
import { readIdentity, describe } from '../src/core/identity.js';
import {
  listDestinations, readLayers, anchorToTopLeft, snapshotUrl, sourceLabel
} from '../src/core/screens.js';
import { detectPlatform, supports, whyNot, FAMILY } from '../src/core/platform.js';

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


/* ------------------------------------------------------------------ *
 * Device identity.
 *
 * The fixture is the simulator's own `system/deviceList`, trimmed to the
 * fields this reads. It is worth having as a fixture rather than a literal
 * because of the shape it proves: the list is four slots long on a
 * single-frame box, and the three empty ones are filled with a placeholder
 * rather than left out.
 * ------------------------------------------------------------------ */

const identityStore = () => {
  const store = new DeviceStore();
  store.hydrate(fixture('sim-6.2.73-identity.json'));
  return store;
};

test('identity is read off the device, model code and all', () => {
  const id = readIdentity(identityStore());
  assert.equal(id.present, true);
  assert.equal(id.primary.model, 'NLC_CMAX');
  assert.equal(id.primary.family, 'AQUILON');
  assert.equal(id.primary.firmware, '6.2.73');
  assert.equal(id.primary.chassis, '6U');
  assert.equal(id.primary.serial, 'ZZ9999');
  assert.equal(id.primary.platformId, 1280);
});

test('a simulator says so, and that is what excuses the missing VPU', () => {
  assert.equal(readIdentity(identityStore()).primary.simulated, true);
});

/* The whole reason `linked` exists: four slots, one frame. Reporting the slot
   count as a frame count would tell an operator they have a linked system. */
test('empty device slots are not counted as linked frames', () => {
  const id = readIdentity(identityStore());
  assert.equal(id.frames.length, 4);
  assert.equal(id.linked.length, 1);
  assert.equal(id.linked[0].key, '1');
  assert.deepEqual(id.frames.slice(1).map((f) => f.populated), [false, false, false]);
});

test('nothing is invented when the store has no identity block', () => {
  const store = new DeviceStore();
  store.hydrate({ device: {} });
  const id = readIdentity(store);
  assert.equal(id.present, false);
  assert.equal(id.primary, null);
  assert.deepEqual(id.linked, []);
});

/* An unknown model must read as unknown, not as a default. Gating a command
   on a guess is how a switcher gets sent something it cannot do. */
test('an unrecognised model is reported as absent rather than guessed at', () => {
  const store = new DeviceStore();
  store.hydrate({ device: { system: { deviceList: { itemKeys: ['1'], items: { 1: { pp: {} } } } } } });
  const id = readIdentity(store);
  assert.equal(id.present, true);
  assert.equal(id.primary.model, null);
  assert.equal(id.primary.family, null);
  assert.equal(describe(id.primary), 'unrecognised model');
});

test('a device is described by family and model together', () => {
  assert.equal(describe(readIdentity(identityStore()).primary), 'AQUILON NLC_CMAX (simulator)');
});

/* ------------------------------------------------------------------ *
 * Screens and auxiliaries, as something you can draw.
 *
 * The fixture is the simulator's own screen/aux/group subtree, trimmed to
 * four layer slots. It carries the case that matters most: S1's preset has
 * geometry for layer 2 pointing at LIVE_3 at full screen, and layer 2 is not
 * allocated. Anything that draws the preset without consulting the screen's
 * own layer list paints that stale layer over the picture.
 * ------------------------------------------------------------------ */

const destStore = () => {
  const store = new DeviceStore();
  store.hydrate(fixture('sim-6.2.73-destinations.json'));
  return store;
};

test('only destinations that are in service are listed', () => {
  const list = listDestinations(destStore());
  assert.deepEqual(list.map((d) => d.id), ['S1']);
  assert.equal(list[0].kind, 'screen');
  assert.equal(list[0].layerCount, 1);
});

test('the unused ones are still reachable when asked for', () => {
  const list = listDestinations(destStore(), { includeUnused: true });
  assert.deepEqual(list.map((d) => d.id), ['S1', 'S2', 'A1']);
  assert.equal(list.find((d) => d.id === 'A1').kind, 'aux');
  assert.equal(list.find((d) => d.id === 'S2').isUsed, false);
});

/* AT_UP means presetUp is on air. Reading it the other way round would put
   the preview picture under a PGM label, with nothing to give it away. */
test('the live bank comes from the transition end, not from a guess', () => {
  const [s1] = listDestinations(destStore());
  assert.equal(s1.transition, 'AT_UP');
  assert.deepEqual(s1.banks, { program: 'B', preview: 'A' });
});

test('the reverse end swaps the banks over', () => {
  const store = destStore();
  store.set([ROOT, 'screenAuxGroupList', 'items', 'S1', 'status', 'pp'],
    { isUsed: true, transition: 'AT_DOWN', take: 'OFF', tbarPosition: 0 });
  const [s1] = listDestinations(store);
  assert.deepEqual(s1.banks, { program: 'A', preview: 'B' });
});

test('the canvas size is the one the device reports', () => {
  const [s1] = listDestinations(destStore());
  assert.deepEqual(s1.canvas, { width: 1920, height: 1080, reported: true });
});

/* The whole point of the file. */
test('a layer with geometry but no allocation is not drawn', () => {
  const store = destStore();
  const [s1] = listDestinations(store);
  const layers = readLayers(store, s1, 'A');
  assert.deepEqual(layers.map((l) => l.label), ['L1']);
  /* Layer 2 is in the preset, at full screen, on LIVE_3 — and it is OFF. */
  const preset = store.get([ROOT, 'screenList', 'items', 'S1', 'presetList', 'items', 'A', 'layerList', 'items', '2']);
  assert.equal(preset.source.pp.inputNum, 'LIVE_3');
});

test('an anchored layer resolves to a top-left rectangle in canvas pixels', () => {
  const store = destStore();
  const [s1] = listDestinations(store);
  const [l1] = readLayers(store, s1, 'A');
  /* MIDDLE_CENTER at 960,540, 960x960 on a 1920x1080 canvas. */
  assert.deepEqual(l1.rect, { left: 480, top: 60, width: 960, height: 960 });
  assert.equal(l1.frac.left, 0.25);
  assert.equal(l1.source, 'LIVE_1');
  assert.equal(l1.snapshot, '/api/device/snapshots/inputs/1');
  assert.equal(l1.opacity, 1);
});

test('every anchor corner resolves without a table of combinations', () => {
  assert.deepEqual(anchorToTopLeft('TOP_LEFT', 100, 50, 200, 100), { left: 100, top: 50 });
  assert.deepEqual(anchorToTopLeft('BOTTOM_RIGHT', 100, 50, 200, 100), { left: -100, top: -50 });
  assert.deepEqual(anchorToTopLeft('MIDDLE_CENTER', 100, 50, 200, 100), { left: 0, top: 0 });
  assert.deepEqual(anchorToTopLeft('TOP_CENTER', 100, 50, 200, 100), { left: 0, top: 50 });
  /* An anchor we cannot read goes to the centre rather than to a corner. */
  assert.deepEqual(anchorToTopLeft('SOMETHING_NEW', 100, 50, 200, 100), { left: 0, top: 0 });
});

/* Only live inputs and stills have a picture; everything else is drawn as a
   labelled rectangle, which is what the vendor does too. */
test('a snapshot URL exists only for sources that have one', () => {
  assert.equal(snapshotUrl('LIVE_7'), '/api/device/snapshots/inputs/7');
  assert.equal(snapshotUrl('STILL_2'), '/api/device/snapshots/images/2');
  assert.equal(snapshotUrl('NONE'), null);
  assert.equal(snapshotUrl('COLOR'), null);
  assert.equal(snapshotUrl(undefined), null);
});

test('sources are labelled the way an operator names them', () => {
  assert.equal(sourceLabel('LIVE_3'), 'IN3');
  assert.equal(sourceLabel('STILL_1'), 'IMG1');
  assert.equal(sourceLabel('NONE'), '');
  assert.equal(sourceLabel('COLOR_BAR'), 'COLOR BAR');
});

/* ------------------------------------------------------------------ *
 * Which platform, and what it can do.
 *
 * All three fixtures are real: cut from the running simulators on 2026-08-22,
 * trimmed to the identity block and the shape the capability probes read.
 * The point of having all three is that identity lives somewhere *different*
 * on each family, and the two mng-platform ranges have to come out as
 * different products despite sharing every structural key.
 * ------------------------------------------------------------------ */

const platformStore = (name) => {
  const store = new DeviceStore();
  store.hydrate(fixture(name));
  return store;
};

const LP = 'livepremier-6.2.73-platform.json';
const MIDRA = 'midra-3.2.29-platform.json';
const ALTA = 'alta-1.3.7-platform.json';

test('LivePremier is identified from its per-frame device list', () => {
  const p = detectPlatform(platformStore(LP));
  assert.equal(p.id, 'livepremier');
  assert.equal(p.family, FAMILY.NLC);
  assert.equal(p.name, 'AQUILON');
  assert.equal(p.model, 'NLC_CMAX');
  assert.equal(p.firmware, '6.2.73');
  assert.equal(p.platformId, 1280);
});

/* `device/system/pp` is `{ready:true}` on LivePremier and carries the whole
   identity on the other family. Getting that backwards identifies nothing. */
test('Midra 4K is identified from the platform label the device supplies', () => {
  const p = detectPlatform(platformStore(MIDRA));
  assert.equal(p.id, 'midra4k');
  assert.equal(p.family, FAMILY.MNG);
  assert.equal(p.name, 'Midra 4K');
  assert.equal(p.model, 'PULSE');
  assert.equal(p.firmware, '3.2.29');
  assert.deepEqual(p.frames, [], 'single frame, so no list of them');
});

test('Alta 4K is a different product from Midra despite the shared platform', () => {
  const p = detectPlatform(platformStore(ALTA));
  assert.equal(p.id, 'alta4k');
  assert.equal(p.family, FAMILY.MNG, 'same code family as Midra');
  assert.equal(p.name, 'Alta 4K');
  assert.equal(p.model, 'ZEN200');
  assert.equal(p.platformId, 1552);
  assert.notEqual(p.platformId, detectPlatform(platformStore(MIDRA)).platformId);
});

/* The whole reason this file exists: offering a LivePremier command to a Midra
   would send a switcher a write it has no property for. */
test('the VPU map is offered on LivePremier and withheld from Midra and Alta', () => {
  assert.equal(supports(detectPlatform(platformStore(LP)), 'vpuMap'), true);
  for (const fx of [MIDRA, ALTA]) {
    const p = detectPlatform(platformStore(fx));
    assert.equal(supports(p, 'vpuMap'), false, fx);
    assert.match(whyNot(p, 'vpuMap'), /no VPU/);
  }
});

test('the cue stack and the command line are withheld from the other platform', () => {
  const lp = detectPlatform(platformStore(LP));
  const midra = detectPlatform(platformStore(MIDRA));
  for (const cap of ['screens', 'cueStack', 'console']) {
    assert.equal(supports(lp, cap), true, 'LivePremier ' + cap);
    assert.equal(supports(midra, cap), false, 'Midra ' + cap);
    assert.ok(whyNot(midra, cap), 'and says why: ' + cap);
  }
});

/* Probing beats an allowlist precisely here: this is a range that does not
   exist, and it still gets the right answer for the right reason. */
test('an unmet platform is judged on what its store actually has', () => {
  const store = new DeviceStore();
  store.hydrate({
    device: {
      system: { pp: { dev: 'FUTURE', platformId: 9999, platformLabel: 'Something 8K' } },
      screenAuxGroupList: { items: { S1: {} } }
    }
  });
  const p = detectPlatform(store);
  assert.equal(p.name, 'Something 8K', 'named by the device, not by a table');
  assert.equal(p.id, 'mng-9999');
  assert.equal(p.family, FAMILY.MNG);
  assert.equal(supports(p, 'console'), true, 'it has the paths, so it gets the console');
  assert.equal(supports(p, 'vpuMap'), false, 'it has no VPU map, so it does not');
});

/* "Not looked yet" and "cannot" must never render as the same thing. */
test('nothing is claimed either way before the store arrives', () => {
  const p = detectPlatform(new DeviceStore());
  assert.equal(p.ready, false);
  assert.equal(p.name, 'Not connected');
  assert.equal(p.capabilities.vpuMap.supported, null);
  assert.equal(supports(p, 'vpuMap'), true, 'and everything stays on offer meanwhile');
  assert.equal(whyNot(p, 'vpuMap'), null);
});

test('a connected switcher we cannot identify is said to be unrecognised', () => {
  const store = new DeviceStore();
  store.hydrate({ device: { system: { pp: { ready: true } } } });
  const p = detectPlatform(store);
  assert.equal(p.id, 'unknown');
  assert.equal(p.name, 'Unrecognised switcher');
  assert.equal(p.family, null);
});
