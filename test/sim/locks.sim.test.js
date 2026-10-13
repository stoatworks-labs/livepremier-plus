/*
 * Layer groups, Layer Lock and Preview lock, against a live switcher.
 *
 * All three run in the page, wired to the session's frames by their
 * `client.js`. Here they are wired the same way to the proxied vendor socket
 * — inbound and outbound frames, tagged as the page tags them — and their
 * promises are checked on the switcher:
 *
 *  - a source sent to a group lands on every member that can take it, and
 *    the ones that cannot are named;
 *  - a locked layer is still on program after a take;
 *  - a recall the app makes while a take is fading waits for it to land.
 *
 * The simulator has one screen in use with one fitted layer, so a gang (one
 * layer following another) has no second member to follow and is not
 * exercised here; `test/groups.test.js` covers it against fixtures.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKIP, startApp, Link, awjGet, sag, settled, guardScreen, layerPath, spareSlots, sleep,
  previewLook, saveFromPreview, deleteSlots
} from './harness.js';
import { bankLetter } from '../../src/core/properties.js';
import { sourceCommands, resolveMembers, normalise as normaliseGroups } from '../../src/core/groups.js';
import { syncWrites, inSync, partialPlan } from '../../src/core/layer-lock.js';
import { createLockEngine } from '../../plugins/layer-lock/engine.js';
import { createPreviewGuard } from '../../plugins/preview-lock/core.js';
import { CueStack } from '../../src/core/cuestack.js';
import { commandsFor } from '../../src/core/commands.js';
import { dialectFor } from '../../src/core/dialect.js';

let app;
let link;
let guard;
let slot;

before(async () => {
  if (SKIP) return;
  app = await startApp();
  link = await Link.open(app);
  guard = await guardScreen(link, 'S1');
  [slot] = spareSlots(link, 1);
  await previewLook(link, { source: 'LIVE_21' });
  await saveFromPreview(link, slot);
});

after(async () => {
  try {
    if (link && slot) await deleteSlots(link, [slot]);
    if (guard) await guard.restore();
  } finally {
    link?.close();
    await app?.close();
  }
});

const src = (role) => layerPath('S1', bankLetter(link.store, 'S1', role).letter, 1, 'source', 'pp', 'inputNum');

/** Put different sources on program and preview layer 1, and wait for both. */
async function split(programSource, previewSource) {
  await settled(link);
  link.send([{ path: src('PROGRAM'), value: programSource }, { path: src('PREVIEW'), value: previewSource }]);
  await link.waitFor(src('PROGRAM'), programSource);
  await link.waitFor(src('PREVIEW'), previewSource);
}

/* ------------------------------------------------------------- groups */

test('a source sent to a group lands on every member that can take it, and names the rest', { skip: SKIP }, async () => {
  const doc = normaliseGroups({
    version: 1,
    groups: [{ id: 'g1', name: 'Centre', members: [{ id: 'S1', layer: '1' }, { id: 'S1', layer: '2' }, { id: 'S2', layer: '1' }] }]
  });
  const put = await app.api('/groups', { method: 'PUT', body: { data: doc } });
  assert.equal(put.status, 200, put.text);
  const stored = (await app.api('/groups')).json.data;
  const group = stored.groups[0];

  const members = resolveMembers(link.store, group);
  assert.equal(members.filter((m) => m.fitted).length, 1, 'only S1 layer 1 is fitted on the simulator');

  await settled(link);
  const r = sourceCommands(link.store, members, 'LIVE_22', 'PREVIEW');
  assert.equal(r.cmds.length, 1);
  assert.equal(r.refused.length, 2, 'the unfitted layer and the unused screen are refused, not dropped');
  for (const x of r.refused) assert.ok(x.why, 'with a reason');
  link.send(r.cmds);
  await link.waitFor(src('PREVIEW'), 'LIVE_22');
  assert.equal(await awjGet(src('PREVIEW')), 'LIVE_22');

  /* The same source again is nothing to send. */
  const again = sourceCommands(link.store, members, 'LIVE_22', 'PREVIEW');
  assert.equal(again.cmds.length, 0);
  assert.equal(again.unchanged.length, 1);
});

/* --------------------------------------------------------- layer lock */

test('a locked layer’s preview is kept equal to program', { skip: SKIP }, async () => {
  await split('LIVE_23', 'LIVE_24');
  const { writes, refused } = syncWrites(link.store, 'S1', ['1']);
  assert.ok(!refused, String(refused));
  assert.ok(writes.length > 0);
  assert.ok(writes.every((w) => w.path.includes(bankLetter(link.store, 'S1', 'PREVIEW').letter)), 'preview only');
  link.send(writes);
  await link.waitFor(src('PREVIEW'), 'LIVE_23');
  assert.equal(inSync(link.store, 'S1', ['1']), true);
});

test('the lock follows a change to program made by somebody else', { skip: SKIP }, async () => {
  await split('LIVE_25', 'LIVE_25');
  const engine = createLockEngine({ store: link.store, send: (c) => { link.send(c); return true; }, locks: () => ['S1/1'] });
  const off = link.onFrame((f) => engine.onFrame(f));
  try {
    /* Another operator changes program; the lock brings preview along. */
    link.send({ path: src('PROGRAM'), value: 'LIVE_26' });
    await link.waitFor(src('PROGRAM'), 'LIVE_26');
    await link.waitFor(src('PREVIEW'), 'LIVE_26', { timeout: 3000, label: 'preview to follow program' });
  } finally {
    off();
    engine.dispose();
  }
});

test('a take held by the lock leaves the locked layer on program', { skip: SKIP }, async () => {
  let locks = [];
  const engine = createLockEngine({ store: link.store, send: (c) => { link.send(c); return true; }, locks: () => locks });
  const off = link.onFrame((f) => engine.onFrame(f));
  try {
    link.send([{ path: sag('S1', 'control', 'takeUpTime'), value: 5 }, { path: sag('S1', 'control', 'takeDownTime'), value: 5 }]);
    await split('LIVE_27', 'LIVE_28');
    locks = ['S1/1'];

    const from = await settled(link);
    const take = { channel: 'DEVICE', data: { path: sag('S1', 'control', 'xTake'), value: true } };
    let releasedAt = null;
    const held = engine.gate(JSON.stringify(take), () => { releasedAt = Date.now(); link.send(take.data); });
    assert.equal(held, true, 'the take was held');
    assert.equal(releasedAt, null, 'and not released before preview was lined up');

    await link.waitFor(sag('S1', 'status', 'transition'), (v) => v !== from, { timeout: 4000 });
    assert.ok(releasedAt);
    assert.equal(link.get(src('PROGRAM')), 'LIVE_27', 'the locked layer is still on air');
    assert.equal(await awjGet(src('PROGRAM')), 'LIVE_27');
  } finally {
    off();
    engine.dispose();
  }
});

test('a take that touches no locked layer is not held', { skip: SKIP }, async () => {
  const engine = createLockEngine({ store: link.store, send: () => true, locks: () => [] });
  const take = { channel: 'DEVICE', data: { path: sag('S1', 'control', 'xTake'), value: true } };
  assert.equal(engine.gate(JSON.stringify(take), () => {}), false);
  engine.dispose();
});

test('take one layer alone', { skip: SKIP }, async () => {
  const plan = partialPlan(link.store, [{ id: 'S1', layer: '1' }], []);
  assert.equal(plan.plans.length, 1);

  const engine = createLockEngine({ store: link.store, send: (c) => { link.send(c); return true; }, locks: () => [] });
  const off = link.onFrame((f) => engine.onFrame(f));
  try {
    link.send([{ path: sag('S1', 'control', 'takeUpTime'), value: 5 }, { path: sag('S1', 'control', 'takeDownTime'), value: 5 }]);
    await split('LIVE_29', 'LIVE_30');
    const r = await engine.takeOnly([{ id: 'S1', layer: '1' }]);
    assert.equal(r.ok, true, r.message);
    assert.equal(link.get(src('PROGRAM')), 'LIVE_30', 'layer 1 went to air');
    assert.equal(await awjGet(src('PROGRAM')), 'LIVE_30');
  } finally {
    off();
    engine.dispose();
  }
});

/* ------------------------------------------------------- preview lock */

test('the preview guard shuts the padlock as a take starts and opens it when it lands', { skip: SKIP }, async () => {
  const calls = [];
  const pg = createPreviewGuard({
    store: link.store,
    lock: (ids) => calls.push({ what: 'lock', ids: [].concat(ids), at: Date.now() }),
    unlock: (ids) => calls.push({ what: 'unlock', ids: [].concat(ids), at: Date.now() }),
    settings: () => ({ skip: [] })
  });
  const off = link.onFrame((f) => pg.onFrame(f));
  try {
    link.send([{ path: sag('S1', 'control', 'takeUpTime'), value: 10 }, { path: sag('S1', 'control', 'takeDownTime'), value: 10 }]);
    await link.waitFor(sag('S1', 'control', 'takeDownTime'), 10);
    const from = await settled(link);

    link.send({ path: sag('S1', 'control', 'xTake'), value: true });
    assert.equal(pg.isGuarded('S1'), true, 'guarded from the moment the take leaves');
    const landedAt = await link.waitFor(sag('S1', 'status', 'transition'), (v) => v !== from, { timeout: 4000 }).then(() => Date.now());
    const settledResult = await pg.whenSettled(['S1']);
    assert.ok(!settledResult || settledResult.ok !== false);
    await sleep(100);

    const lock = calls.find((c) => c.what === 'lock');
    const unlock = calls.find((c) => c.what === 'unlock');
    assert.ok(lock, 'the padlock was shut');
    assert.ok(unlock, 'and opened again');
    assert.ok(unlock.at >= landedAt - 20, 'not before the take landed');
    assert.equal(pg.isGuarded('S1'), false);
  } finally {
    off();
    pg.releaseAll?.();
  }
});

test('a cue’s recall into a preview that is mid-take waits for the take to land', { skip: SKIP }, async () => {
  const pg = createPreviewGuard({ store: link.store, lock: () => {}, unlock: () => {}, settings: () => ({ skip: [] }) });
  const off = link.onFrame((f) => pg.onFrame(f));
  const sent = [];
  const stack = new CueStack({
    send: (cmd) => { sent.push({ path: cmd.path, at: Date.now() }); link.send(cmd); return true; },
    commands: () => commandsFor(dialectFor(link.store)),
    /* What the Timeline hands its engine when Preview lock is on. */
    hold: (ids) => pg.whenSettled(ids)
  });
  try {
    await settled(link);
    const from = link.get(sag('S1', 'status', 'transition'));
    stack.add({ number: '1', fade: 1.2, actions: [{ kind: 'take', targets: ['S1'] }] });
    stack.add({ number: '2', actions: [{ kind: 'screenPreset', slot, targets: ['S1'], mode: 'PREVIEW' }] });

    stack.go();
    await sleep(250);
    stack.go();
    const landedAt = await link.waitFor(sag('S1', 'status', 'transition'), (v) => v !== from, { timeout: 5000 }).then(() => Date.now());
    await link.waitFor(src('PREVIEW'), 'LIVE_21', { timeout: 3000, label: 'the held recall to land' });

    const recall = sent.find((c) => c.path.at(-1) === 'xRequest');
    assert.ok(recall, 'the recall was sent');
    assert.ok(recall.at >= landedAt - 20,
      `the recall left ${landedAt - recall.at} ms before the take landed`);
  } finally {
    off();
    stack.stop();
    pg.releaseAll?.();
  }
});
