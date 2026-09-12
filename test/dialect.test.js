/*
 * The two object models, through one interface.
 *
 * Two fixtures, both real:
 *
 *   aquilon-6.2.73-memories.json   a live Aquilon C, read 2026-09-10
 *   midra-3.2.29-pulse4k.json      the Midra 4K simulator as a Pulse 4K,
 *                                  read 2026-09-12 after the writes below
 *                                  had been made through the MNG dialect's
 *                                  own paths over AWJ — so every mng path
 *                                  asserted here is one the simulator
 *                                  accepted, and the fixture holds the
 *                                  evidence: three screen memories and a
 *                                  master saved, screen 1 taken to AT_UP,
 *                                  memories 10 and 2 recalled into screen
 *                                  2's program and preview.
 *
 * The simulator's store has the identical shape to a live Pulse 4K on
 * firmware 3.3.10 for every subtree named here (diffed 2026-09-12); the
 * simulator was used for the writes because the live one was mid-show.
 *
 * The LivePremier half is pinned against `core/paths.js` and the previous
 * memory paths byte for byte, because the point of a dialect is that nothing
 * already verified on hardware changes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import { CMD, screenAuxControl } from '../src/core/paths.js';
import { NLC, MNG, dialectFor, dialectOrDefault, parseId } from '../src/core/dialect.js';
import { commandsFor } from '../src/core/commands.js';
import { CueStack, ACTION_KINDS, SETTLE_MS } from '../src/core/cuestack.js';
import { listDestinations, presetBanks, readLayers, sourceLabel } from '../src/core/screens.js';
import {
  banksFor, bankFor, targetsFor, listSlots, slotCount, assignments,
  recallCmd, saveCmd, labelCmd, deleteCmd, saveFilters
} from '../src/core/memories.js';
import {
  fittedLayers, layerSections, paramPath, readValue, writeCmd, valuesFor, catalogueFor, bankLetter
} from '../src/core/properties.js';
import { detectPlatform, supports, whyNot } from '../src/core/platform.js';
import { screenOutputs, outputPitch, outputPitchCommit, pitchWrites } from '../src/core/pitch.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const hydrated = (name) => { const s = new DeviceStore(); s.hydrate(fixture(name)); return s; };

const aquilon = hydrated('aquilon-6.2.73-memories.json');
const pulse = hydrated('midra-3.2.29-pulse4k.json');

const P = (cmd) => cmd.path.join('/');

/* ------------------------------------------------------------ choosing */

test('the dialect is chosen by the tree, not by the model name', () => {
  assert.equal(dialectFor(aquilon), NLC);
  assert.equal(dialectFor(pulse), MNG);
  assert.equal(dialectFor(new DeviceStore()), null, 'nothing before hydration');
  /* The platform fixture is trimmed to identity: it says Midra 4K and has
     no transition tree, and that is not enough to spell a path. */
  assert.equal(dialectFor(hydrated('midra-3.2.29-platform.json')), null);
  assert.equal(dialectOrDefault(null), NLC, 'display falls back to LivePremier; commands never do');
});

test('identifiers are the LivePremier spelling on both platforms', () => {
  assert.deepEqual(parseId('S1'), { kind: 'screen', n: '1' });
  assert.deepEqual(parseId('A12'), { kind: 'aux', n: '12' });
  assert.equal(parseId('1'), null, 'a bare number names nothing');
  assert.deepEqual(MNG.split('S3'), { list: 'screenList', key: '3', kind: 'screen' });
  assert.deepEqual(MNG.split('A3'), { list: 'auxiliaryScreenList', key: '3', kind: 'aux' });
});

/* ------------------------------------------------------- nlc, unchanged */

test('the LivePremier dialect reproduces core/paths.js byte for byte', () => {
  const cmd = commandsFor(NLC);
  for (const id of ['S1', 'A3']) {
    assert.deepEqual(cmd.take(id), CMD.take(id));
    assert.deepEqual(cmd.cut(id), CMD.cut(id));
    assert.deepEqual(cmd.stepBack(id), CMD.stepBack(id));
    assert.deepEqual(cmd.abort(id), CMD.abort(id));
    assert.deepEqual(cmd.copyProgramToPreview(id), CMD.copyProgramToPreview(id));
    assert.deepEqual(cmd.fade(id, 25), [CMD.takeUpTime(id, 25), CMD.takeDownTime(id, 25)]);
    assert.deepEqual(cmd.recallScreenPreset(5, id, 'PREVIEW'), CMD.recallScreenPreset(5, id, 'PREVIEW'));
  }
  assert.deepEqual(cmd.recallMasterPreset(7, 'PROGRAM'), CMD.recallMasterPreset(7, 'PROGRAM'));
  assert.deepEqual(cmd.recallScreenPreset(5, 'S1'), CMD.recallScreenPreset(5, 'S1'), 'and PREVIEW is still the default');
  assert.deepEqual(NLC.takeControl('A3', 'xTake'), screenAuxControl('A3', 'xTake'));
});

test('the LivePremier memory paths are the ones verified on the Aquilon', () => {
  assert.equal(P(recallCmd('screen', 44, { id: 'S1', mode: 'PREVIEW' })),
    'device/presetBank/control/load/slotList/items/44/screenList/items/S1/presetList/items/PREVIEW/pp/xRequest');
  assert.equal(P(saveCmd('screen', 44, { id: 'S1', mode: 'PROGRAM' })),
    'device/presetBank/control/save/screenList/items/S1/presetList/items/PROGRAM/slotList/items/44/pp/xRequest');
  assert.equal(P(recallCmd('master', 3, { mode: 'PROGRAM' })),
    'device/masterPresetBank/control/load/slotList/items/3/presetList/items/PROGRAM/pp/xRequest');
  assert.equal(P(saveCmd('master', 3)), 'device/masterPresetBank/control/save/slotList/items/3/pp/xRequest');
  assert.equal(P(recallCmd('layer', 2, { id: 'S1', mode: 'PREVIEW', layer: 1 })),
    'device/layerBank/control/load/slotList/items/2/screenList/items/S1/presetList/items/PREVIEW/layerList/items/1/pp/xRequest');
  assert.equal(P(labelCmd('screen', 44, 'x')), 'device/presetBank/bankList/items/44/control/pp/label');
  assert.equal(P(deleteCmd('screen', 44)), 'device/presetBank/bankList/items/44/control/pp/xDelete');
  assert.deepEqual(banksFor(aquilon).map((b) => b.kind), ['master', 'screen', 'layer']);
});

/* ---------------------------------------------------- mng, as accepted */

test('a Midra take addresses the transition tree, split by kind', () => {
  const cmd = commandsFor(MNG);
  assert.equal(P(cmd.take('S1')), 'device/transition/screenList/items/1/control/pp/xTake');
  assert.equal(P(cmd.take('A2')), 'device/transition/auxiliaryScreenList/items/2/control/pp/xTake');
  assert.equal(P(cmd.cut('S1')), 'device/transition/screenList/items/1/control/pp/xCut');
  assert.equal(P(cmd.stepBack('S1')), 'device/transition/screenList/items/1/control/pp/xStepBack');
  assert.equal(P(cmd.abort('S1')), 'device/transition/screenList/items/1/control/pp/xTakeAbort');
  assert.equal(P(cmd.copyProgramToPreview('S1')), 'device/transition/screenList/items/1/control/pp/xCopyProgramToPreview');
});

test('a Midra fade is one write, to takeTime, in tenths', () => {
  const writes = commandsFor(MNG).fade('S2', 25);
  assert.equal(writes.length, 1, 'no up/down pair here');
  assert.equal(P(writes[0]), 'device/transition/screenList/items/2/control/pp/takeTime');
  assert.equal(writes[0].value, 25);
  /*
   * The simulator accepted this write (read back as 25 straight after) and
   * the fixture nevertheless holds 10: the two memory recalls made after it
   * put each memory's own `transitionDuration` onto the screen. The same
   * overwrite the cue engine orders its writes around on LivePremier —
   * recall, settle, THEN fade — and now seen on Midra as well.
   */
  assert.equal(pulse.get(writes[0].path), 10);
  assert.equal(pulse.get(['device', 'preset', 'bank', 'slotList', 'items', '10', 'status', 'pp', 'transitionDuration']), 10);
});

test('a Midra recall goes to the bank its target belongs to', () => {
  const cmd = commandsFor(MNG);
  assert.equal(P(cmd.recallScreenPreset(10, 'S2', 'PROGRAM')),
    'device/preset/bank/control/load/slotList/items/10/screenList/items/2/presetList/items/PROGRAM/pp/xRequest');
  /* Auxes have a bank of their own on this platform, and a cue that names
     one as a "screen preset" — the cue stack's only per-destination kind —
     still has to land there. */
  assert.equal(P(cmd.recallScreenPreset(1, 'A1', 'PREVIEW')),
    'device/preset/auxBank/control/load/slotList/items/1/auxiliaryScreenList/items/1/presetList/items/PREVIEW/pp/xRequest');
  assert.equal(P(cmd.recallMasterPreset(1)),
    'device/preset/masterBank/control/load/slotList/items/1/presetList/items/PREVIEW/pp/xRequest');
  assert.equal(P(recallCmd('aux', 5, { id: 'A2', mode: 'PROGRAM' }, MNG)),
    'device/preset/auxBank/control/load/slotList/items/5/auxiliaryScreenList/items/2/presetList/items/PROGRAM/pp/xRequest');
  assert.equal(recallCmd('aux', 5, { id: 'S2', mode: 'PROGRAM' }, MNG), null, 'an aux memory cannot go onto a screen');
  assert.equal(recallCmd('layer', 1, { id: 'S1', mode: 'PREVIEW', layer: 1 }, MNG), null, 'there is no layer bank');
  assert.equal(recallCmd('screen', 1, { id: 'S1' }, MNG), null, 'and still no default buffer');
});

test('a Midra save puts the slot last, exactly as LivePremier does', () => {
  assert.equal(P(saveCmd('screen', 1, { id: 'S1', mode: 'PROGRAM' }, MNG)),
    'device/preset/bank/control/save/screenList/items/1/presetList/items/PROGRAM/slotList/items/1/pp/xRequest');
  assert.equal(P(saveCmd('screen', 3, { id: 'A1', mode: 'PREVIEW' }, MNG)),
    'device/preset/auxBank/control/save/auxiliaryScreenList/items/1/presetList/items/PREVIEW/slotList/items/3/pp/xRequest');
  assert.equal(P(saveCmd('master', 1, {}, MNG)), 'device/preset/masterBank/control/save/slotList/items/1/pp/xRequest');
  assert.equal(P(labelCmd('screen', 1, 'Fixture one', MNG)), 'device/preset/bank/slotList/items/1/control/pp/label');
  assert.equal(P(deleteCmd('master', 1, MNG)), 'device/preset/masterBank/slotList/items/1/control/pp/xDelete');
  /* The saves in the fixture came through these paths. */
  assert.equal(pulse.get(['device', 'preset', 'bank', 'slotList', 'items', '1', 'control', 'pp', 'label']), 'Fixture one');
  assert.equal(pulse.get(['device', 'preset', 'bank', 'slotList', 'items', '1', 'status', 'pp', 'isValid']), true);
  assert.equal(pulse.get(['device', 'preset', 'masterBank', 'slotList', 'items', '1', 'status', 'pp', 'isValid']), true);
});

test('with no dialect, every command declines to be built', () => {
  const none = commandsFor(null);
  assert.equal(none.take('S1'), null);
  assert.equal(none.recallScreenPreset(1, 'S1'), null);
  assert.deepEqual(none.fade('S1', 10), []);
  assert.equal(recallCmd('screen', 1, { id: 'S1', mode: 'PREVIEW' }, null), null);
  assert.equal(labelCmd('screen', 1, 'x', null), null);
});

/* ----------------------------------------------------------- buffers */

/*
 * The rule was read out of the vendor's bundle and then checked by
 * behaviour: a recall to PROGRAM on an AT_DOWN screen landed in DOWN, and
 * one to PREVIEW landed in UP. The fixture is the state after those two.
 */
test('UP and DOWN resolve from the transition suffix, as the vendor does it', () => {
  const s1 = presetBanks(pulse, 'S1');
  assert.deepEqual([s1.program, s1.preview, s1.settled, s1.reported, s1.transition], ['UP', 'DOWN', true, true, 'AT_UP']);
  const s2 = presetBanks(pulse, 'S2');
  assert.deepEqual([s2.program, s2.preview, s2.settled], ['DOWN', 'UP', true]);
  /* And the evidence: memory 10 went to program, memory 2 to preview. */
  assert.deepEqual(assignments(pulse, 'S2'), {
    DOWN: { slot: 10, unmodified: true },
    UP: { slot: 2, unmodified: true }
  });
  /* memoryId 0 is "not loaded from a memory", not slot zero. */
  assert.equal(assignments(pulse, 'S1').UP.slot, null);
  assert.equal(assignments(pulse, 'S1').DOWN.slot, 1);
});

test('mid-take the Midra answer is unsettled, and an unknown screen is unreported', () => {
  const store = hydrated('midra-3.2.29-pulse4k.json');
  store.set(MNG.takeStatus('S1', 'transition'), 'EFFECT_FROM_DOWN');
  const mid = presetBanks(store, 'S1');
  assert.deepEqual([mid.program, mid.preview, mid.settled], ['DOWN', 'UP', false]);
  store.set(MNG.takeStatus('S1', 'transition'), 'COPY_FROM_UP');
  assert.equal(presetBanks(store, 'S1').program, 'UP');
  assert.equal(presetBanks(store, 'S9').reported, false, 'no status, no claim');
});

/* ------------------------------------------------------- destinations */

test('a Midra says which screens are in service through the applied preconfig', () => {
  const used = listDestinations(pulse);
  assert.deepEqual(used.map((d) => d.id), ['S1', 'S2']);
  const all = listDestinations(pulse, { includeUnused: true });
  assert.deepEqual(all.map((d) => d.id), ['S1', 'S2', 'S3', 'S4', 'A1', 'A2', 'A3', 'A4']);
  const s2 = all.find((d) => d.id === 'S2');
  assert.deepEqual(s2.canvas, { width: 1024, height: 640, reported: true });
  assert.equal(s2.layerCount, 2);
  assert.equal(s2.outputCount, 1);
  assert.deepEqual(s2.banks, { program: 'DOWN', preview: 'UP' });
  const s1 = all.find((d) => d.id === 'S1');
  assert.equal(s1.transition, 'AT_UP');
  assert.equal(s1.tbar, 1);
  assert.equal(s1.isTransitioning, false);
  /* A disabled screen reports a 0x0 canvas; the fallback is used and said so. */
  assert.equal(all.find((d) => d.id === 'S3').canvas.reported, false);
  assert.equal(all.find((d) => d.id === 'A1').isUsed, false, 'aux mode DISABLE');
});

test('fitted layers on a Midra are the ones the running preconfig gave a scaler', () => {
  assert.deepEqual(fittedLayers(pulse, 'S1').map((l) => l.key), ['1', '2']);
  assert.deepEqual(fittedLayers(pulse, 'S3'), []);
  assert.deepEqual(fittedLayers(pulse, 'A1'), [], 'an aux has no layers here');
});

test('Midra layer geometry is centre-anchored with size split from position', () => {
  const dest = listDestinations(pulse).find((d) => d.id === 'S1');
  const layers = readLayers(pulse, dest, 'UP');
  assert.equal(layers.length, 2, 'eight slots in the preset, two fitted');
  const l1 = layers[0];
  assert.equal(l1.source, 'INPUT_7');
  assert.equal(l1.snapshot, '/api/device/snapshots/inputs/7');
  assert.deepEqual(l1.rect, { left: 507 - 853 / 2, top: 409 - 255 / 2, width: 853, height: 255 });
  assert.equal(sourceLabel('INPUT_7', pulse), 'IN7');
  assert.equal(sourceLabel('LIVE_7', aquilon), 'IN7', 'and the LivePremier spelling still reads');
});

/* ------------------------------------------------------------ memories */

test('a Midra has a screen bank, an aux bank and a master bank, and no layer bank', () => {
  assert.deepEqual(banksFor(pulse).map((b) => b.kind), ['master', 'screen', 'aux']);
  assert.equal(bankFor('layer', pulse), null);
  assert.deepEqual(listSlots(pulse, 'screen', { onlyValid: true }).map((s) => [s.slot, s.label]),
    [[1, 'Fixture one'], [2, 'Fixture two'], [10, 'Slot ten']]);
  assert.equal(listSlots(pulse, 'screen', { onlyValid: true })[1].width, 1024, 'saved from screen 2');
  assert.deepEqual(listSlots(pulse, 'master', { onlyValid: true }).map((s) => [s.slot, s.label, s.screens]),
    [[1, 'Master one', ['1', '2', '3', '4']]]);
  /* The fixture keeps five slots of each bank; the count comes from there. */
  assert.equal(slotCount(pulse, 'master'), 5);
  assert.equal(slotCount(new DeviceStore(), 'master'), 500, 'and the fallback is LivePremier\'s, for display only');
});

test('a bank only offers the destinations it can address', () => {
  const all = listDestinations(pulse, { includeUnused: true });
  assert.deepEqual(targetsFor(bankFor('screen', pulse), all).map((d) => d.id), ['S1', 'S2', 'S3', 'S4']);
  assert.deepEqual(targetsFor(bankFor('aux', pulse), all).map((d) => d.id), ['A1', 'A2', 'A3', 'A4']);
  assert.deepEqual(targetsFor(bankFor('master', pulse), all), []);
  assert.equal(targetsFor(bankFor('screen', aquilon), all).length, all.length, 'LivePremier\'s serves both');
});

test('Midra save filters are read from the bank the destination belongs to', () => {
  const screen = saveFilters(pulse, 'screen', { id: 'S1' });
  assert.ok(screen.categories.includes('SOURCE'));
  assert.deepEqual(screen.layers, ['1'].concat(screen.layers.slice(1)));
  const master = saveFilters(pulse, 'master');
  assert.equal(master.mode, 'SAVE_FROM_PGM');
  assert.deepEqual(master.screens, ['1', '2', '3', '4']);
  assert.equal(saveFilters(pulse, 'layer'), null, 'no such bank here');
});

/* ------------------------------------------------------------- cue stack */

test('a cue fired at a Midra is spelled for it, fade included', () => {
  const sent = [];
  const timers = [];
  const clock = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    now: () => 0
  };
  const stack = new CueStack({
    send: (cmd) => { sent.push(cmd); return true; },
    clock,
    commands: () => commandsFor(dialectFor(pulse))
  });
  stack.add({
    number: '1', fade: 1.5,
    actions: [
      { kind: ACTION_KINDS.SCREEN_PRESET, slot: 10, targets: ['S2'], mode: 'PREVIEW' },
      { kind: ACTION_KINDS.TAKE, targets: ['S2'] }
    ]
  });
  stack.go();
  assert.deepEqual(sent.map(P), [
    'device/preset/bank/control/load/slotList/items/10/screenList/items/2/presetList/items/PREVIEW/pp/xRequest'
  ]);
  assert.equal(timers[0].ms, SETTLE_MS);
  timers[0].fn();
  assert.deepEqual(sent.slice(1).map(P), [
    'device/transition/screenList/items/2/control/pp/takeTime',
    'device/transition/screenList/items/2/control/pp/xTake'
  ]);
  assert.equal(sent[1].value, 15);
});

test('a cue fired before the store has arrived sends nothing, and says so', () => {
  const sent = [];
  const failed = [];
  const empty = new DeviceStore();
  const stack = new CueStack({
    send: (cmd) => { sent.push(cmd); return true; },
    commands: () => commandsFor(dialectFor(empty))
  });
  stack.addEventListener('sendFailed', (ev) => failed.push(ev.detail));
  stack.add({ number: '1', actions: [{ kind: ACTION_KINDS.CUT, targets: ['S1'] }] });
  stack.go();
  assert.deepEqual(sent, []);
  assert.equal(failed.length, 1);
});

/* --------------------------------------------------------- capabilities */

test('a real Pulse 4K store gets everything but the VPU map and audio patching', () => {
  const p = detectPlatform(pulse);
  assert.equal(p.id, 'midra4k');
  assert.equal(p.modelName, 'Pulse 4K');
  for (const cap of ['screens', 'cueStack', 'console', 'layerProperties', 'pitchCompensation']) assert.equal(supports(p, cap), true, cap);
  for (const cap of ['vpuMap', 'audioPatch']) {
    assert.equal(supports(p, cap), false, cap);
    assert.ok(whyNot(p, cap), 'and says why: ' + cap);
  }
});

/* ----------------------------------------------------------------- pitch */

test('pitch compensation on a Midra reads canvas/pitch and the applied preconfig', () => {
  /* The fixture keeps one output with its pitch and status nodes; the applied
     preconfig says it feeds screen 1 as SCREEN_FORMAT. */
  const outs = screenOutputs(pulse, 'S1');
  assert.deepEqual(outs.map((o) => o.key), ['1']);
  assert.equal(outs[0].pxWidth, 1920);
  assert.equal(outs[0].liveRawH, 1000);
  assert.deepEqual(screenOutputs(pulse, 'S3'), [], 'no output feeds screen 3');
  assert.equal(outputPitch('1', 'H', MNG).join('/'), 'device/outputList/items/1/canvas/pitch/pp/pitchRatioH');
  assert.equal(outputPitchCommit('1', MNG).join('/'), 'device/outputList/items/1/canvas/pitch/pp/xUpdate');
  assert.equal(outputPitch('1', 'H').join('/'), 'device/outputList/items/1/canvas/cmd/pp/pitchRatioH', 'LivePremier when unsaid');
  const writes = pitchWrites({ groups: [{ group: { outputKey: '1' }, h: { raw: 1010 }, v: { raw: 1000 } }] }, MNG);
  assert.deepEqual(writes.map((w) => w.path[w.path.length - 2] + '/' + w.path[w.path.length - 1]), ['pp/pitchRatioH', 'pp/pitchRatioV', 'pp/xUpdate']);
  assert.ok(writes.every((w) => w.path.includes('pitch') && !w.path.includes('cmd')));
});

/* ---------------------------------------------------------- layer panel */

/*
 * The Midra catalogue was generated by awj-surface's tool from the live Pulse
 * 4K's own bundle and store (3.3.10). The values below are read out of the
 * simulator fixture through it, and the paths are the ones the simulator
 * accepted when `Set Screen 1 Layer 1 …` was typed at it through mynah.
 */
test('the Layer panel reads the Midra catalogue on a Midra, and LivePremier\'s otherwise', () => {
  assert.equal(catalogueFor(pulse).platform, 'midra');
  assert.equal(catalogueFor(aquilon).platform, 'livepremier');
  assert.equal(catalogueFor(new DeviceStore()).platform, 'livepremier', 'the default before the store arrives');
  const sections = layerSections(pulse);
  assert.deepEqual(sections.slice(0, 4).map((s) => s.id), ['source', 'position', 'size', 'opacity']);
  assert.equal(sections.reduce((n, s) => n + s.params.length, 0), 57);
  assert.ok(sections.every((s) => s.label && s.label !== s.id || ['status'].includes(s.id) === false), 'every group has a label');
  assert.equal(layerSections(aquilon).reduce((n, s) => n + s.params.length, 0), 67, 'and LivePremier\'s is untouched');
});

test('a Midra layer property is addressed under liveLayerList in the UP/DOWN buffer', () => {
  const spec = layerSections(pulse).flatMap((s) => s.params).find((p) => p.id === 'size.sizeH');
  assert.equal(paramPath({ id: 'S1', bank: 'UP', layer: '1' }, spec, pulse).join('/'),
    'device/screenList/items/1/presetList/items/UP/liveLayerList/items/1/size/pp/sizeH');
  assert.equal(readValue(pulse, { id: 'S1', bank: 'UP', layer: '1' }, spec), 853);
  const source = layerSections(pulse).flatMap((s) => s.params).find((p) => p.id === 'source.input');
  assert.equal(readValue(pulse, { id: 'S1', bank: 'UP', layer: '1' }, source), 'INPUT_7');
  assert.ok(valuesFor(source, pulse).includes('INPUT_16'));
  assert.equal(valuesFor(source, pulse).includes('LIVE_1'), false, 'the Midra enum, not LivePremier\'s');
  /* An aux has no layers on this platform. */
  assert.equal(paramPath({ id: 'A1', bank: 'UP', layer: '1' }, spec, pulse), null);
  /* And a store that has not arrived spells nothing. */
  assert.equal(paramPath({ id: 'S1', bank: 'UP', layer: '1' }, spec, new DeviceStore()), null);
});

test('a Midra write clamps to the Midra range and names the buffer by the take state', () => {
  const opacity = layerSections(pulse).flatMap((s) => s.params).find((p) => p.id === 'opacity.opacity');
  const cmd = writeCmd({ id: 'S1', bank: 'DOWN', layer: '2' }, opacity, 999, pulse);
  assert.equal(cmd.path.join('/'), 'device/screenList/items/1/presetList/items/DOWN/liveLayerList/items/2/opacity/pp/opacity');
  assert.equal(cmd.value, 256);
  assert.match(cmd.note, /clamped/);
  /* S1 is AT_UP in the fixture: program is UP and preview DOWN. */
  assert.deepEqual(bankLetter(pulse, 'S1', 'PREVIEW'), { letter: 'DOWN', live: false, settled: true, reported: true });
  assert.equal(bankLetter(pulse, 'S1', 'PROGRAM').letter, 'UP');
  assert.equal(bankLetter(pulse, 'S2', 'PREVIEW').letter, 'UP', 'S2 is AT_DOWN');
});

test('the LivePremier capabilities are unchanged by the per-family probes', () => {
  const p = detectPlatform(hydrated('livepremier-6.2.73-platform.json'));
  for (const cap of ['screens', 'cueStack', 'console', 'layerProperties']) assert.equal(supports(p, cap), true, cap);
});
