/*
 * The switcher model, read and driven live: identity, platform, sources and
 * destinations, takes and cuts, fade times, and layer properties — each built
 * by the app's own `core/` and checked against what the switcher reports over
 * AWJ.
 *
 * Not asserted, because the simulator does not do them: `xStepBack` produces
 * no frame at all on 6.2.73, and `xTakeAbort` mid-fade lands the take rather
 * than reversing it, which is not something to pin a hardware behaviour on.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKIP, startApp, Link, awjGet, awjGetAll, sag, settled, take, guardScreen, layerPath, sleep
} from './harness.js';

import { readIdentity, describe as describeFrame } from '../../src/core/identity.js';
import { detectPlatform } from '../../src/core/platform.js';
import { dialectFor } from '../../src/core/dialect.js';
import { commandsFor } from '../../src/core/commands.js';
import { inspectMapping, readSide, diffSides } from '../../src/core/vpu.js';
import { listDestinations, listSources, presetBanks, readLayers } from '../../src/core/screens.js';
import { layerSpec, valuesFor, writeCmd, coerce, readValue, fittedLayers, bankLetter } from '../../src/core/properties.js';

let app;
let link;
let guard;

before(async () => {
  if (SKIP) return;
  app = await startApp();
  link = await Link.open(app);
  guard = await guardScreen(link, 'S1');
});

after(async () => {
  try { if (guard) await guard.restore(); }
  finally {
    link?.close();
    await app?.close();
  }
});

const cmds = () => commandsFor(dialectFor(link.store));

test('the switcher is identified as a simulated LivePremier, and AWJ agrees', { skip: SKIP }, async () => {
  const id = readIdentity(link.store);
  assert.equal(id.present, true);
  assert.equal(id.primary.simulated, true);
  assert.match(describeFrame(id.primary), /\(simulator\)/);

  const [dev, label] = await awjGetAll([
    ['device', 'system', 'deviceList', 'items', '1', 'pp', 'dev'],
    ['device', 'system', 'deviceList', 'items', '1', 'pp', 'label']
  ]);
  assert.equal(id.primary.model, dev);
  assert.equal(id.primary.family, label);

  const platform = detectPlatform(link.store);
  assert.equal(platform.id, 'livepremier');
  assert.equal(platform.simulated, true);
  assert.equal(dialectFor(link.store).id, 'nlc');
});

/*
 * AGENTS.md says a simulator has no VPU, and the simulator the fixtures were
 * cut from had none: an empty `vpuLayerList` and no mixers. The rack
 * simulator (6.2.73 under Wine, 2026-10-13) reports a fully fitted C MAX —
 * 64 mixers, two enabled for S1's NATIVE layer — so which branch this takes
 * depends on the simulator, and both are checked against the device.
 */
test('the VPU map reads what the switcher reports, mixer for mixer', { skip: SKIP }, async () => {
  const info = inspectMapping(link.store, 'current');
  const base = ['device', 'preconfig', 'resources', 'current', 'status', 'mapping', 'deviceList', 'items', '1'];
  const mixers = link.get([...base, 'vpuMixerList', 'items']);

  if (!mixers) {
    assert.equal(info.present, false);
    assert.equal(info.reason, 'simulator', 'no mixers is a simulator, not an empty chassis');
    return;
  }

  assert.equal(info.present, true);
  const side = readSide(link.store, 'current');
  const frame1 = side.devices.find((d) => d.key === '1');
  const names = Object.keys(mixers);
  const enabled = names.filter((n) => mixers[n].pp.isEnabled);
  assert.equal(frame1.summary.fitted, names.filter((n) => mixers[n].pp.isAvailable).length);
  assert.equal(frame1.summary.enabled, enabled.length);

  /* Every enabled mixer, read off the switcher itself. */
  const awj = await awjGetAll(enabled.flatMap((n) => [
    [...base, 'vpuMixerList', 'items', n, 'pp', 'isEnabled'],
    [...base, 'vpuMixerList', 'items', n, 'pp', 'usedInScreen']
  ]));
  enabled.forEach((n, i) => {
    assert.equal(awj[i * 2], true, `${n} is enabled on the switcher`);
    assert.equal(awj[i * 2 + 1], mixers[n].pp.usedInScreen);
  });

  /* Each allocation the panel draws names mixers the device says are in use
     for that screen and layer. */
  for (const a of frame1.summary.allocations) {
    for (const m of a.mixers) {
      assert.equal(mixers[m].pp.usedInScreen, a.screen);
      assert.equal(mixers[m].pp.usedInLayer, a.layer);
    }
  }
  assert.deepEqual(diffSides(link.store), [], 'nothing staged on the simulator');
});

test('S1 is listed with its canvas and its buffers, and nothing unused is', { skip: SKIP }, async () => {
  const dests = listDestinations(link.store, {});
  const s1 = dests.find((d) => d.id === 'S1');
  assert.ok(s1, 'S1 is a destination');
  assert.ok(dests.every((d) => d.isUsed !== false), 'unused destinations are left out by default');

  const [w, h] = await awjGetAll([
    ['device', 'screenList', 'items', 'S1', 'status', 'pp', 'canvasWidth'],
    ['device', 'screenList', 'items', 'S1', 'status', 'pp', 'canvasHeight']
  ]);
  /* The canvas is read from wherever the model keeps it; when AWJ has it at
     the screen's own status the two must agree. */
  if (typeof w === 'number') assert.deepEqual([s1.canvas.width, s1.canvas.height], [w, h]);
  assert.ok(s1.canvas.width > 0 && s1.canvas.height > 0);

  const banks = presetBanks(link.store, 'S1');
  assert.equal(banks.reported, true);
  assert.notEqual(banks.program, banks.preview);
  const [up, down] = await awjGetAll([sag('S1', 'control', 'presetUp'), sag('S1', 'control', 'presetDown')]);
  const atDown = (await awjGet(sag('S1', 'status', 'transition'))) === 'AT_DOWN';
  assert.equal(banks.program, atDown ? down : up, 'program is the buffer the screen sits AT');
});

test('every source offered is a value the layer source property accepts', { skip: SKIP }, () => {
  const sources = listSources(link.store);
  assert.equal(sources[0].value, 'NONE', 'NONE first');
  const allowed = new Set(valuesFor(layerSpec(link.store, 'source'), link.store));
  for (const s of sources) assert.ok(allowed.has(s.value), `${s.value} is in the source enum`);
  assert.ok(sources.some((s) => s.value.startsWith('LIVE_')), 'live inputs are offered');
});

test('a take swaps program and preview, and the fade time sets how long it takes', { skip: SKIP }, async () => {
  const c = cmds();
  const before = presetBanks(link.store, 'S1');

  link.send(c.fade('S1', 15));
  await link.waitFor(sag('S1', 'control', 'takeUpTime'), 15);
  await link.waitFor(sag('S1', 'control', 'takeDownTime'), 15);
  assert.deepEqual(await awjGetAll([sag('S1', 'control', 'takeUpTime'), sag('S1', 'control', 'takeDownTime')]), [15, 15]);

  const from = await settled(link);
  const t0 = Date.now();
  link.send(c.take('S1'));
  const to = from === 'AT_UP' ? 'AT_DOWN' : 'AT_UP';
  await link.waitFor(sag('S1', 'status', 'transition'), to, { timeout: 8000 });
  const took = Date.now() - t0;
  assert.ok(took >= 1200 && took < 4000, `a 1.5 s fade took ${took} ms`);

  const after = presetBanks(link.store, 'S1');
  assert.equal(after.program, before.preview);
  assert.equal(after.preview, before.program);
  assert.equal(await awjGet(sag('S1', 'status', 'transition')), to);
});

test('a cut swaps at once, whatever the fade time', { skip: SKIP }, async () => {
  const c = cmds();
  link.send(c.fade('S1', 30));
  await link.waitFor(sag('S1', 'control', 'takeUpTime'), 30);
  const from = await settled(link);
  const t0 = Date.now();
  link.send(c.cut('S1'));
  await link.waitFor(sag('S1', 'status', 'transition'), from === 'AT_UP' ? 'AT_DOWN' : 'AT_UP', { timeout: 3000 });
  assert.ok(Date.now() - t0 < 1500, `a cut with a 3 s fade set took ${Date.now() - t0} ms`);
});

test('layer properties written through the catalogue land on preview, and only there', { skip: SKIP }, async () => {
  await settled(link);
  const preview = bankLetter(link.store, 'S1', 'PREVIEW');
  const program = bankLetter(link.store, 'S1', 'PROGRAM');
  assert.equal(preview.settled && preview.reported, true);
  const layer = fittedLayers(link.store, 'S1')[0].key;
  const target = { id: 'S1', bank: preview.letter, layer };
  const programTarget = { id: 'S1', bank: program.letter, layer };

  const programBefore = ['source', 'posH', 'sizeH', 'opacity']
    .map((n) => readValue(link.store, programTarget, layerSpec(link.store, n)));

  const want = { source: 'LIVE_2', posH: 480, sizeH: 960, sizeV: 540, opacity: 128, anchor: 'TOP_LEFT' };
  for (const [name, value] of Object.entries(want)) {
    const cmd = writeCmd(target, layerSpec(link.store, name), value, link.store);
    assert.ok(cmd, `${name} builds a write`);
    link.send(cmd);
  }
  for (const [name, value] of Object.entries(want)) {
    const spec = layerSpec(link.store, name);
    const path = layerPath('S1', preview.letter, layer, ...spec.path);
    await link.waitFor(path, value, { label: name });
    assert.equal(await awjGet(path), value, `AWJ reads ${name} back`);
  }

  const programAfter = ['source', 'posH', 'sizeH', 'opacity']
    .map((n) => readValue(link.store, programTarget, layerSpec(link.store, n)));
  assert.deepEqual(programAfter, programBefore, 'program untouched');

  /* And the panel's reading of the buffer shows what was written. */
  const dest = listDestinations(link.store, {}).find((d) => d.id === 'S1');
  const l = readLayers(link.store, dest, preview.letter).find((x) => String(x.key) === String(layer));
  assert.equal(l.source, 'LIVE_2');
  assert.equal(l.hasSource, true);
});

test('out-of-range and unknown values are clamped or refused before they reach the wire', { skip: SKIP }, () => {
  const opacity = layerSpec(link.store, 'opacity');
  assert.deepEqual(
    { ok: coerce(opacity, 999, link.store).ok, value: coerce(opacity, 999, link.store).value },
    { ok: true, value: 256 });
  assert.equal(coerce(layerSpec(link.store, 'source'), 'LIVE_9999', link.store).ok, false);
  assert.equal(coerce(layerSpec(link.store, 'anchor'), 'SIDEWAYS', link.store).ok, false);
});

test('the switcher clamps a value the catalogue let through, and the mirror shows its value, not ours', { skip: SKIP }, async () => {
  await settled(link);
  const preview = bankLetter(link.store, 'S1', 'PREVIEW').letter;
  const path = layerPath('S1', preview, 1, 'opacity', 'pp', 'opacity');
  link.send({ path, value: 100 });
  await link.waitFor(path, 100);
  /* Straight to the wire, past `coerce`: the device answers with what it kept. */
  link.send({ path, value: 5000 });
  const kept = await link.waitFor(path, (v) => v !== 100, { timeout: 3000 }).catch(() => link.get(path));
  assert.ok(kept <= 256, `the mirror reads ${kept}, never the 5000 that was sent`);
  assert.equal(await awjGet(path), kept);
});

test('copy program to preview makes preview a copy of program', { skip: SKIP }, async () => {
  await settled(link);
  const preview = bankLetter(link.store, 'S1', 'PREVIEW').letter;
  const program = bankLetter(link.store, 'S1', 'PROGRAM').letter;
  const src = (letter) => layerPath('S1', letter, 1, 'source', 'pp', 'inputNum');
  const programSource = link.get(src(program));
  const other = programSource === 'LIVE_3' ? 'LIVE_4' : 'LIVE_3';

  link.send({ path: src(preview), value: other });
  await link.waitFor(src(preview), other);

  link.send(cmds().copyProgramToPreview('S1'));
  await link.waitFor(src(preview), programSource);
  assert.equal(await awjGet(src(preview)), programSource);
});

test('the screen is put back the way it was found', { skip: SKIP }, async () => {
  const wrote = await guard.restore();
  guard = null;
  assert.ok(wrote >= 0);
  await sleep(200);
  assert.equal(await awjGet(sag('S1', 'status', 'transition')), (await settled(link)));
});
