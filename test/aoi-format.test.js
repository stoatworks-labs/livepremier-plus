/*
 * AoI from a custom format: the arithmetic, the plan and the vendor heading.
 *
 * The outputs are the 6.2.73 simulator's own (`sim-6.2.73-outputs.json`);
 * the custom formats are the shape that simulator reports under
 * `customFormats/bankList` — slot 1 its own `LEDwall`, 3000×1000 at 49.998 Hz.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DeviceStore } from '../src/core/device-store.js';
import {
  SCALE, toRaw, toPx, rateLabel, customFormats, outputAoi, matchingFormat, place, plan, landed, selectedOutput
} from '../plugins/aoi-format/core.js';

const outputs = JSON.parse(readFileSync(new URL('./fixtures/sim-6.2.73-outputs.json', import.meta.url), 'utf8'));

const bank = (n, { w, h, rate = 60000, name = '', valid = true }) => ({
  control: { pp: { userName: name, xDelete: false } },
  status: { pp: { hUtil: w, vUtil: h, rate, isValid: valid, mode: 'FULL' } }
});

function sim() {
  const store = new DeviceStore();
  store.hydrate({
    device: {
      ...outputs.device,
      customFormats: {
        bankList: {
          itemKeys: ['1', '2', '3', '4'],
          items: {
            1: bank(1, { w: 3000, h: 1000, rate: 49998, name: 'LEDwall' }),
            2: bank(2, { w: 1728, h: 576, name: 'Wall' }),
            3: bank(3, { w: 1024, h: 768, valid: false }),
            4: bank(4, { w: 1920, h: 1080 })
          }
        }
      }
    }
  });
  return store;
}

test('a pixel count written rounded up floors back to itself, on every raster it fits', () => {
  for (const ref of [720, 1080, 1200, 1920, 2048, 2160, 3840, 4096, 7680]) {
    for (let px = 0; px <= ref; px++) assert.equal(toPx(toRaw(px, ref), ref), px, `${px} of ${ref}`);
  }
  assert.equal(toRaw(1920, 1920), SCALE);
  assert.equal(toRaw(1728, 1920), 90000);
  assert.equal(toRaw(576, 1080), 53334, 'what the simulator was sent, and reported back as 576');
});

test('the custom formats are the valid ones, named the vendor’s way', () => {
  const formats = customFormats(sim());
  assert.deepEqual(formats.map((f) => [f.key, f.width, f.height]), [['1', 3000, 1000], ['2', 1728, 576], ['4', 1920, 1080]]);
  assert.equal(formats[0].label, 'M1 LEDwall — 3000×1000 49.998 Hz');
  assert.equal(formats[2].label, 'M4 — 1920×1080 60 Hz');
  assert.equal(rateLabel(59940), '59.94 Hz');
  assert.deepEqual(customFormats(new DeviceStore()), []);
});

test('an output’s AoI is read from its canvas: raster, mode and what the switcher reports', () => {
  const o = outputAoi(sim(), '3');
  assert.equal(o.screen, 'S1');
  assert.equal(o.group, '1X1');
  assert.equal(o.slices, 1);
  assert.deepEqual(o.raster, { width: 1920, height: 1080 });
  assert.equal(o.mode, 'FIT_FORMAT');
  assert.deepEqual(o.reported, { left: 0, top: 0, width: 1920, height: 1080 });
  assert.equal(outputAoi(sim(), '999'), null);
});

test('the three places, in whole pixels', () => {
  assert.deepEqual(place('top-left', 1728, 576, 1920, 1080), { left: 0, top: 0 });
  assert.deepEqual(place('top-centre', 1728, 576, 1920, 1080), { left: 96, top: 0 });
  assert.deepEqual(place('centre', 1728, 576, 1920, 1080), { left: 96, top: 252 });
  assert.deepEqual(place('centre', 1001, 1, 1920, 1080), { left: 459, top: 539 }, 'an odd margin is floored');
});

test('the plan writes what the vendor’s panel writes, then pulses xUpdate', () => {
  const store = sim();
  const formats = customFormats(store);
  const p = plan(outputAoi(store, '3'), formats.find((f) => f.key === '2'), 'centre');
  assert.equal(p.ok, true);
  assert.deepEqual(p.px, { left: 96, top: 252, width: 1728, height: 576 });
  assert.deepEqual(p.raw, { left: 5000, top: 23334, width: 90000, height: 53334 }, 'the values the simulator took and reported as 96, 252, 1728×576');
  const base = 'device/outputList/items/3/canvas/cmd/slices/aoi/sliceList/items/1/pp/';
  assert.deepEqual(p.writes.map((w) => [w.path.join('/').replace(base, ''), w.value]), [
    ['mode', 'CUSTOM'], ['width', 90000], ['height', 53334], ['left', 5000], ['top', 23334], ['xUpdate', false], ['xUpdate', true]
  ]);
});

test('a format larger than the output is refused, never clamped', () => {
  const store = sim();
  const p = plan(outputAoi(store, '3'), customFormats(store)[0]);
  assert.equal(p.ok, false);
  assert.match(p.why, /M1 is 3000×1000, larger than Output 3’s 1920×1080/);
});

test('a format the size of the raster is the whole of it', () => {
  const store = sim();
  const p = plan(outputAoi(store, '3'), customFormats(store).find((f) => f.key === '4'), 'centre');
  assert.equal(p.ok, true);
  assert.deepEqual(p.raw, { left: 0, top: 0, width: SCALE, height: SCALE });
});

test('grouped, copied and sliced outputs are left to the vendor’s own fields', () => {
  const store = sim();
  const f = customFormats(store)[1];
  const base = outputAoi(store, '3');
  assert.match(plan({ ...base, state: 'GROUPED' }, f).why, /part of another output’s group/);
  assert.match(plan({ ...base, state: 'CLONED' }, f).why, /copies another output/);
  assert.match(plan({ ...base, group: '2X1' }, f).why, /drives a 2X1 group/);
  assert.match(plan({ ...base, slices: 2 }, f).why, /cut into 2 slices/);
  assert.match(plan(base, null).why, /Pick a custom format/);
  assert.match(plan(null, f).why, /does not list/);
});

test('an AoI the size of a custom format is recognised as that format', () => {
  const store = sim();
  const formats = customFormats(store);
  const o = outputAoi(store, '3');
  assert.equal(matchingFormat(o, formats), null, 'Fit Output Format names none');
  const custom = { ...o, mode: 'CUSTOM', reported: { left: 0, top: 0, width: 1728, height: 576 } };
  assert.equal(matchingFormat(custom, formats).key, '2');
});

test('landed is what the switcher reports, not what was sent', () => {
  const store = sim();
  const p = plan(outputAoi(store, '3'), customFormats(store)[1]);
  assert.equal(landed(store, p, '3'), false);
  const at = (k, v) => store.set(['device', 'outputList', 'items', '3', 'canvas', 'status', 'slices', 'sliceList', 'items', '1', 'aoi', 'pp', k], v);
  at('width', 1728); at('height', 576);
  assert.equal(landed(store, p, '3'), true);
  at('width', 1727);
  assert.equal(landed(store, p, '3'), false);
});

test('the vendor’s selection heading names one output, or none', () => {
  assert.equal(selectedOutput('Screen 1 - Region 1 -  Group 2 - Output 3'), '3', 'the double space is the vendor’s');
  assert.equal(selectedOutput('Aux 1 - Region 1 - Group 1 - Output 12'), '12');
  assert.equal(selectedOutput('Screen 1 - Region 1 - Group 2'), null);
  assert.equal(selectedOutput('Screen 1 - Region 1 - Group 1 - Output 3 - 2'), null, 'a slice of a DisplayPort box is not the output');
  assert.equal(selectedOutput('Screen 1'), null);
  assert.equal(selectedOutput(null), null);
});
