/*
 * The adapter, against a real Aquilon C.
 *
 * `aquilon-c-live-resources.json` is the preconfig/resources subtree of an
 * actual device store, read from a live Aquilon C over its own HTTP API on
 * 2026-08-21 — the same GET the Web RCS page makes, trimmed to the mapping and
 * the screen status because the full response is 118 MB. Reads only; nothing
 * was written to that device.
 *
 * This is the test that a simulator cannot give: a simulator reports no VPU at
 * all, so every assertion here about mixers, output links and Optimized mode
 * exercises a code path no simulated box would reach.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import {
  readSide, diffSides, inspectMapping, readMixers, readScreenStatus, parseMixerId
} from '../src/core/vpu.js';

const here = dirname(fileURLToPath(import.meta.url));
const live = () => {
  const store = new DeviceStore();
  store.hydrate(JSON.parse(readFileSync(join(here, 'fixtures', 'aquilon-c-live-resources.json'), 'utf8')));
  return store;
};

test('a real chassis is recognised as having a VPU map', () => {
  const info = inspectMapping(live(), 'current');
  assert.equal(info.present, true);
  assert.equal(info.fitted, true);
  assert.deepEqual(info.devices, ['1', '2', '3', '4']);
});

test('the fitted chassis is read the way the device reports it', () => {
  const side = readSide(live(), 'current');
  const master = side.devices.find((d) => d.key === '1');

  /* Two processor cards of four, 26 of the 32 fitted mixers in use. The
     unfitted PROC_3/PROC_4 mixers must not count as spare capacity. */
  assert.equal(master.summary.fitted, 32);
  assert.equal(master.summary.enabled, 26);
  assert.equal(master.summary.spare, 6);
  assert.equal(master.summary.max, 64);
  assert.equal(master.summary.screens, 4);

  /* Link followers are listed but empty - no second chassis on this rig. */
  for (const key of ['2', '3', '4']) {
    const follower = side.devices.find((d) => d.key === key);
    assert.equal(follower.summary.fitted, 0, `device ${key} carries no fitted mixer`);
  }
});

test('a six-output screen spends two mixers per slice, split 4 links and 2', () => {
  const mixers = readMixers(live(), { which: 'current', device: '1' });

  const s1Native = Object.entries(mixers).filter(([, r]) =>
    r.isEnabled && r.usedInScreen === 'S1' && r.usedInLayer === 'NATIVE');
  assert.equal(s1Native.length, 4, 'two slices, two mixers each');

  const links = (rec) => Object.entries(rec.mixerAllocation)
    .filter(([, v]) => v && v !== 'NONE')
    .map(([k]) => Number(k.replace('usedOnOutPipe', '')));

  /* S1 spends six output capabilities. One mixer cannot span more than four
     output links (User Manual §5.5.4), so the run wraps onto a second mixer:
     links 1,3,5,7 carry outputs 1-4 and links 2,4 carry outputs 5-6.
     Interleaved, not contiguous — which is exactly why the grid draws the
     links the device names instead of packing each run into a neat square. */
  const slice0 = s1Native.filter(([, r]) => r.slice === 0).map(([, r]) => links(r));
  assert.deepEqual(slice0.map((l) => l.join(',')).sort(), ['1,3,5,7', '2,4']);
  assert.equal(slice0.reduce((n, l) => n + l.length, 0), 6,
    'six output links for six output capabilities');
  assert.ok(slice0.every((l) => l.length <= 4), 'no mixer spans more than four links');
});

test('screen status comes back with Optimized mode and the fit figures', () => {
  const store = live();
  const current = readScreenStatus(store, { which: 'current' });
  const staged = readScreenStatus(store, { which: 'new' });

  assert.deepEqual(Object.keys(current), ['S1', 'S2', 'S3', 'S4']);
  assert.equal(current.S1.isOptimized, true);
  assert.equal(current.S1.usedOutputCapabilities, 6);
  assert.equal(current.S1.layerCount, 3);

  /* The remaining/exceeding figures are the answer to "would this fit", and
     the device reports them only on the staged side. */
  assert.equal(current.S1.remainingOutputCapabilities, undefined);
  assert.equal(staged.S1.remainingOutputCapabilities, 2);
  assert.equal(staged.S1.exceedingOutputCapabilities, 0);
});

test('Optimized mode lands on the VPU hosting the screen, not just the screen', () => {
  const side = readSide(live(), 'current');
  const master = side.devices.find((d) => d.key === '1');
  const mixers = readMixers(live(), { which: 'current', device: '1' });

  const s1Vpus = new Set(Object.entries(mixers)
    .filter(([, r]) => r.isEnabled && r.usedInScreen === 'S1')
    .map(([id]) => parseMixerId(id).processor));
  assert.ok(s1Vpus.size > 0);
  assert.deepEqual([...master.optimized].sort(), [...s1Vpus].sort(),
    'the boundary must be dropped for the whole VPU, not for S1 alone');
});

test('the live staged configuration differs only in output links', () => {
  const diffs = diffSides(live());
  const master = diffs.find((d) => d.device === '1');
  assert.ok(master, 'this device has a staged preconfig that differs');

  /* 26 mixers move. Every single change is a link move: the running map
     interleaves the output links and the staged one packs them. Not one
     property differs — a diff that compared only @props would report this
     configuration as identical, which is the trap the model exists to avoid. */
  assert.equal(master.changes.length, 26);
  for (const change of master.changes) {
    for (const field of change.changed) {
      assert.match(field.prop, /^link \d$/,
        `${change.mixer}: expected only link moves, got ${field.prop}`);
    }
  }
});

test('the link grid places every live mixer inside the 8x8 field', () => {
  const side = readSide(live(), 'current');
  const master = side.devices.find((d) => d.key === '1');
  const populated = master.grids.filter((g) => g.blocks.length);

  assert.equal(populated.length, 2, 'two processor cards are fitted');
  for (const g of populated) {
    assert.equal(g.placement, 'reported-columns');
    assert.ok(!g.overflow, `VPU ${g.vpu} fits in eight link rows`);
    for (const b of g.blocks) {
      assert.ok(b.cols.length > 0, `${b.mixer} sits on at least one output link`);
      assert.ok(b.row >= 0 && b.row < 8, `${b.mixer} row ${b.row} is on the field`);
      assert.ok(b.cols.every((c) => c >= 0 && c < 8), `${b.mixer} columns are on the field`);
    }
  }
});
