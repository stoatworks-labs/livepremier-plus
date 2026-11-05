/*
 * The switcher as a console reads it (`server/console-switcher.js`), shared by
 * the Pixelhue and Barco EC panels since 2026-10-20. Against a pretend switcher
 * on AWJ; the live check is `test/sim/` and `test/console/`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ConsoleSwitcher, labelPath } from '../server/console-switcher.js';
import { NLC, MNG } from '../src/core/dialect.js';
import { toAwj } from '../src/core/paths.js';
import { fakeAwj } from './helpers/fake-awj.js';

test('a destination’s name is found on both platforms — on a Midra too, where split() answers an object', () => {
  assert.deepEqual(labelPath(NLC, 'S1'), ['device', 'screenList', 'items', 'S1', 'control', 'pp', 'label']);
  /* Until 2026-10-20 this destructured split()'s object as a pair and threw. */
  assert.deepEqual(labelPath(MNG, 'S2'), ['device', 'screenList', 'items', '2', 'control', 'pp', 'label']);
  assert.deepEqual(labelPath(MNG, 'A1'), ['device', 'auxiliaryScreenList', 'items', '1', 'control', 'pp', 'label']);
});

test('one read: the platform, the screens in service, the sources, the memories and the free slots, the fitted layers', async () => {
  const set = (m, path, v) => m.set(toAwj(path), v);
  const store = new Map([['DeviceObject/system/$device/@items/1/@props/dev', 'NLC_AQL_C']]);
  set(store, NLC.takeStatus('S1', 'isUsed'), true);
  set(store, labelPath(NLC, 'S1'), 'Main');
  set(store, ['device', 'inputList', 'items', 'IN_2', 'status', 'pp', 'isAvailable'], true);
  set(store, ['device', 'inputList', 'items', 'IN_2', 'status', 'pp', 'isEnabled'], true);
  set(store, ['device', 'inputList', 'items', 'IN_2', 'control', 'pp', 'label'], 'CAM 2');
  set(store, NLC.label('screen', 1, '').path, 'Opener');
  const probe = NLC.layerProbe('S1', 4);
  set(store, probe.path('1'), 'FULL');
  set(store, probe.path('2'), 'OFF');
  set(store, NLC.takeControl('S1', 'presetUp'), 'A');
  set(store, NLC.takeControl('S1', 'presetDown'), 'B');
  set(store, NLC.takeStatus('S1', 'transition'), 'AT_UP');
  set(store, NLC.takeStatus('S1', 'tbarPosition'), 65535);
  const awj = await fakeAwj(store);
  try {
    const sw = new ConsoleSwitcher({ deviceHost: () => '127.0.0.1', awjPort: awj.port, limits: { screens: 2, inputs: 3, memories: 3, layers: 4, stills: 1 } });
    const facts = await sw.readFacts();
    assert.equal(facts.dialect, NLC);
    assert.deepEqual(facts.destinations.map((d) => [d.id, d.isUsed, d.label]), [['S1', true, 'Main'], ['S2', false, '']]);
    assert.deepEqual(facts.sources.LIVE, [{ number: 2, source: 'LIVE_2', label: 'CAM 2' }]);
    assert.deepEqual(facts.sourceKinds, ['LIVE', 'SCREEN']);
    assert.deepEqual(facts.presets, [{ slot: 1, label: 'Opener' }]);
    assert.deepEqual(facts.freeSlots, [2, 3]);
    assert.deepEqual(facts.layers, [{ destination: 'S1', key: 1, label: 'Layer 1' }]);
    /* AT_UP: program is the up preset, so preview is the down one. */
    assert.equal((await sw.lettersFor(['S1'], 'PREVIEW')).get('S1'), 'B');
    assert.equal((await sw.restsFor(['S1'])).get('S1'), 65535);
    await sw.write([{ path: NLC.takeControl('S1', 'xTake'), value: true }]);
    /* A replace has no reply, so it lands a moment after `exchange` resolves. */
    for (let i = 0; i < 100 && !awj.writes().length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(awj.writes(), [{ path: toAwj(NLC.takeControl('S1', 'xTake')), value: true }]);
  } finally {
    await awj.close();
  }
});

test('inputs are the ones the Web RCS’s source picker offers, wherever they are numbered — not the first 24 slots', async () => {
  /* A U5 mini on an Aquilon stopped at input 24 (2026-11-05): the read only
     asked for IN_1..IN_24, and a frame fills its slots by card, with gaps. */
  const set = (m, path, v) => m.set(toAwj(path), v);
  const input = (n, ...tail) => ['device', 'inputList', 'items', `IN_${n}`, ...tail];
  const store = new Map([['DeviceObject/system/$device/@items/1/@props/dev', 'NLC_AQL_C']]);
  const usable = (n, label, { enabled = true, global } = {}) => {
    set(store, input(n, 'status', 'pp', 'isAvailable'), true);
    set(store, input(n, 'status', 'pp', 'isEnabled'), enabled);
    set(store, input(n, 'control', 'pp', 'label'), label);
    if (global) set(store, ['device', 'preconfig', 'inputs', 'current', 'inputList', 'items', `IN_${n}`, 'status', 'pp', 'global'], global);
  };
  usable(1, 'CAM 1', { global: 'USED' });
  usable(2, 'CAM 2', { enabled: false });                 // switched off in Preconfig Inputs
  usable(25, 'DP 1', { global: 'USED' });                 // past the old cap
  usable(26, 'DP 1 (pair)', { global: 'PREEMPTED' });     // taken by IN_25 for DP 1.2
  usable(40, 'GROUP', { global: 'GROUPED' });
  usable(41, 'Captions');
  set(store, input(42, 'status', 'pp', 'isAvailable'), false);   // no card in that slot
  set(store, input(42, 'status', 'pp', 'isEnabled'), true);
  set(store, ['device', 'stillList', 'items', '7', 'status', 'pp', 'isAvailable'], true);
  set(store, ['device', 'stillList', 'items', '7', 'status', 'pp', 'isEnabled'], true);
  const awj = await fakeAwj(store);
  try {
    const sw = new ConsoleSwitcher({ deviceHost: () => '127.0.0.1', awjPort: awj.port, limits: { screens: 1, inputs: 256, memories: 1, layers: 1, stills: 192 } });
    const facts = await sw.readFacts();
    assert.deepEqual(facts.sources.LIVE, [
      { number: 1, source: 'LIVE_1', label: 'CAM 1' },
      { number: 25, source: 'LIVE_25', label: 'DP 1' },
      { number: 41, source: 'LIVE_41', label: 'Captions' },
    ]);
    assert.deepEqual(facts.sources.STILL, [{ number: 7, source: 'STILL_7', label: 'STILL_7' }]);
    /* A console that keeps fewer keeps the first it is offered, not the first slots. */
    sw.limits.inputs = 2;
    assert.deepEqual((await sw.readFacts()).sources.LIVE.map((s) => s.number), [1, 25]);
  } finally {
    await awj.close();
  }
});

test('a Midra’s inputs are read as INPUT_n, named from the plug in use', async () => {
  /* Until 2026-11-05 this read nlc's `mapping` under plain keys and found none. */
  const set = (m, path, v) => m.set(toAwj(path), v);
  const store = new Map([['DeviceObject/system/@props/platformLabel', 'Event Master']]);
  const node = (n, ...tail) => ['device', 'inputList', 'items', `INPUT_${n}`, ...tail];
  set(store, node(1, 'status', 'pp', 'isAvailable'), true);
  set(store, node(1, 'status', 'pp', 'plug'), 2);
  set(store, node(1, 'plugList', 'items', '2', 'control', 'pp', 'label'), 'SDI A');
  set(store, node(3, 'status', 'pp', 'isAvailable'), true);
  set(store, node(3, 'plugList', 'items', '1', 'control', 'pp', 'label'), 'HDMI');
  set(store, node(2, 'status', 'pp', 'isAvailable'), false);
  const awj = await fakeAwj(store);
  try {
    const sw = new ConsoleSwitcher({ deviceHost: () => '127.0.0.1', awjPort: awj.port, limits: { screens: 1, inputs: 32, memories: 1, layers: 1, stills: 0 } });
    const facts = await sw.readFacts();
    assert.equal(facts.dialect, MNG);
    assert.deepEqual(facts.sources.LIVE, [
      { number: 1, source: 'INPUT_1', label: 'SDI A' },
      { number: 3, source: 'INPUT_3', label: 'HDMI' },
    ]);
  } finally {
    await awj.close();
  }
});

test('master memories are read when a console asks for them: labelled or valid, never empty slots', async () => {
  const set = (m, path, v) => m.set(toAwj(path), v);
  const store = new Map([['DeviceObject/system/$device/@items/1/@props/dev', 'NLC_AQL_C']]);
  const master = (slot, ...tail) => ['device', 'masterPresetBank', 'bankList', 'items', String(slot), ...tail];
  set(store, master(1, 'control', 'pp', 'label'), 'Walk-in');
  set(store, master(1, 'status', 'pp', 'isValid'), true);
  set(store, master(3, 'status', 'pp', 'isValid'), true);      // saved, never named
  set(store, master(4, 'status', 'pp', 'isValid'), false);
  const awj = await fakeAwj(store);
  try {
    const limits = { screens: 1, inputs: 0, memories: 1, layers: 1, stills: 0 };
    const none = new ConsoleSwitcher({ deviceHost: () => '127.0.0.1', awjPort: awj.port, limits });
    assert.deepEqual((await none.readFacts()).masters, [], 'a console that does not ask reads none');
    const sw = new ConsoleSwitcher({ deviceHost: () => '127.0.0.1', awjPort: awj.port, limits: { ...limits, masters: 8 } });
    assert.deepEqual((await sw.readFacts()).masters, [{ slot: 1, label: 'Walk-in' }, { slot: 3, label: '' }]);
  } finally {
    await awj.close();
  }
});
