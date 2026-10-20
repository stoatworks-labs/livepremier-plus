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
  set(store, ['device', 'inputList', 'items', 'IN_2', 'mapping', 'pp', 'isValid'], true);
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
