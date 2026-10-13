/*
 * Memories, live: the three ways this app puts a look into the bank — the
 * device's own save from a buffer, the Edit page's save via preview, and the
 * import that touches no bus at all — plus label, recall and delete.
 *
 * Every slot used is an empty one at the top of the bank, and every one is
 * deleted again. S1 is guarded as a whole, because a recall rewrites a buffer
 * and the fade time with it.
 *
 * Master memories are not saved here: a master save also writes each screen's
 * memory into its `bankSlot`, which defaults to slot 1 — the one memory the
 * simulator holds (docs/NOTES.md, "A master save writes every screen's memory
 * into bankSlot").
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKIP, target, startApp, Link, Journal, awjGet, awjGetAll, sag, settled, guardScreen, spareSlots, layerPath, sleep
} from './harness.js';

import { dialectFor } from '../../src/core/dialect.js';
import {
  recallCmd, saveCmd, labelCmd, deleteCmd, listSlots, assignments
} from '../../src/core/memories.js';
import { layerSpec, writeCmd, bankLetter } from '../../src/core/properties.js';
import { createProgrammer } from '../../src/core/programmer.js';
import { composeMemory, saveViaPreview } from '../../src/core/save-look.js';

let app;
let link;
let guard;
let journal;
const used = [];

/* What the bank's import and export are handed: a path on the device's own
   filesystem and, for the export, a selection. Left behind they would be the
   only trace of this file on the switcher, so they are journalled. */
const BANK_ARGS = [
  ['device', 'presetBank', 'import', 'extract', 'cmd', 'pp', 'path'],
  ['device', 'presetBank', 'export', 'cmd', 'pp', 'path'],
  ['device', 'presetBank', 'export', 'cmd', 'pp', 'selection']
];

before(async () => {
  if (SKIP) return;
  app = await startApp();
  link = await Link.open(app);
  guard = await guardScreen(link, 'S1');
  journal = new Journal(link);
  for (const p of BANK_ARGS) if (link.get(p) !== undefined) journal.remember(p);
});

after(async () => {
  try {
    /* Any slot a test filled and did not get to empty. */
    for (const slot of used) {
      if (link.get(slotValid(slot)) === true) link.send(deleteCmd('screen', slot));
    }
    for (const slot of used) await link.waitFor(slotValid(slot), false).catch(() => {});
    if (journal) await journal.restore();
    if (guard) await guard.restore();
  } finally {
    link?.close();
    await app?.close();
  }
});

const slotValid = (slot) => ['device', 'presetBank', 'bankList', 'items', String(slot), 'status', 'pp', 'isValid'];
const slotLabel = (slot) => ['device', 'presetBank', 'bankList', 'items', String(slot), 'control', 'pp', 'label'];
const src = (letter) => layerPath('S1', letter, 1, 'source', 'pp', 'inputNum');
const opa = (letter) => layerPath('S1', letter, 1, 'opacity', 'pp', 'opacity');

/* Each test takes slots no earlier test has had, so one that failed before
   deleting its memory cannot hand the next a slot that is still full. */
function claim(n) {
  const slots = spareSlots(link, n + used.length).filter((s) => !used.includes(s)).slice(0, n);
  used.push(...slots);
  return slots;
}

/** Put a known look on preview layer 1 and wait for the switcher to hold it. */
async function previewLook({ source, opacity }) {
  await settled(link);
  const pv = bankLetter(link.store, 'S1', 'PREVIEW').letter;
  link.send([
    writeCmd({ id: 'S1', bank: pv, layer: '1' }, layerSpec(link.store, 'source'), source, link.store),
    writeCmd({ id: 'S1', bank: pv, layer: '1' }, layerSpec(link.store, 'opacity'), opacity, link.store)
  ]);
  await link.waitFor(src(pv), source);
  await link.waitFor(opa(pv), opacity);
  /* The switcher confirms the source a second time, under `status`, and not
     always in the same breath — wait for that too, or its echo lands in the
     next test's window and reads as something that test wrote. */
  await link.waitFor(layerPath('S1', pv, 1, 'source', 'status', 'pp', 'inputNum'), source);
  return pv;
}

test('save from preview, label, recall over a changed preview, and delete', { skip: SKIP }, async () => {
  const [slot] = claim(1);
  const d = dialectFor(link.store);
  const pv = await previewLook({ source: 'LIVE_5', opacity: 200 });

  link.send(saveCmd('screen', slot, { mode: 'PREVIEW', id: 'S1' }, d));
  await link.waitFor(slotValid(slot), true, { timeout: 8000 });
  assert.equal(await awjGet(slotValid(slot)), true, 'AWJ sees the slot filled');

  link.send(labelCmd('screen', slot, 'lpp sim suite', d));
  await link.waitFor(slotLabel(slot), 'lpp sim suite');
  const listed = listSlots(link.store, 'screen', { onlyValid: true }).find((s) => s.slot === slot);
  assert.equal(listed.label, 'lpp sim suite');
  assert.equal(listed.width, link.get(['device', 'screenList', 'items', 'S1', 'status', 'pp', 'canvasWidth']) ?? listed.width);

  /* Change preview, then recall the memory over it. */
  await previewLook({ source: 'LIVE_6', opacity: 64 });
  link.send(recallCmd('screen', slot, { mode: 'PREVIEW', id: 'S1' }, d));
  await link.waitFor(src(pv), 'LIVE_5', { timeout: 6000 });
  await link.waitFor(opa(pv), 200);
  await link.waitFor(['device', 'presetBank', 'status', 'presetId', 'screenList', 'items', 'S1', 'presetList', 'items', pv, 'pp', 'id'],
    slot, { label: 'preview to report the memory it holds' });
  assert.equal(assignments(link.store, 'S1')[pv].slot, slot);
  assert.deepEqual(await awjGetAll([src(pv), opa(pv)]), ['LIVE_5', 200]);

  link.send(deleteCmd('screen', slot, d));
  await link.waitFor(slotValid(slot), false);
  assert.equal(await awjGet(slotValid(slot)), false);
});

test('a recall into PREVIEW never touches program', { skip: SKIP }, async () => {
  const [slot] = claim(1);
  const d = dialectFor(link.store);
  await previewLook({ source: 'LIVE_7', opacity: 150 });
  link.send(saveCmd('screen', slot, { mode: 'PREVIEW', id: 'S1' }, d));
  await link.waitFor(slotValid(slot), true, { timeout: 8000 });

  const pg = bankLetter(link.store, 'S1', 'PROGRAM').letter;
  const before = await awjGetAll([src(pg), opa(pg)]);
  const mark = link.mark();
  link.send(recallCmd('screen', slot, { mode: 'PREVIEW', id: 'S1' }, d));
  await sleep(1500);

  const programFrames = link.since(mark, ['device', 'screenList', 'items', 'S1', 'presetList', 'items', pg]);
  assert.deepEqual(programFrames.map((f) => f.path.join('/')), [], 'no write reached the program buffer');
  assert.deepEqual(await awjGetAll([src(pg), opa(pg)]), before);
  assert.equal(link.since(mark, sag('S1', 'status', 'transition')).length, 0, 'and nothing was taken');

  link.send(deleteCmd('screen', slot, d));
  await link.waitFor(slotValid(slot), false);
});

test('the Edit page saves a programmed look via preview and gives preview back', { skip: SKIP }, async () => {
  const [slot] = claim(1);
  const pv = await previewLook({ source: 'LIVE_2', opacity: 256 });
  const before = await awjGetAll([src(pv), opa(pv)]);

  const programmer = createProgrammer({ session: link.session });
  assert.equal(programmer.seed('S1', 'PREVIEW'), true, 'seeded from the live preview');
  const edit = { id: 'S1', bank: programmer.buffer, layer: '1' };
  programmer.send(writeCmd(edit, layerSpec(programmer.store, 'source'), 'LIVE_8', programmer.store));
  programmer.send(writeCmd(edit, layerSpec(programmer.store, 'opacity'), 77, programmer.store));

  /* The programmer is a sandbox: nothing it holds has reached the switcher. */
  assert.deepEqual(await awjGetAll([src(pv), opa(pv)]), before);

  const r = await saveViaPreview({ session: link.session, programmer, id: 'S1', slot, label: 'lpp edit' });
  assert.equal(r.ok, true, r.message);
  assert.ok(r.wrote > 0);
  await link.waitFor(slotLabel(slot), 'lpp edit');

  /* Preview is given back. */
  await link.waitFor(src(pv), before[0]);
  await link.waitFor(opa(pv), before[1]);
  assert.deepEqual(await awjGetAll([src(pv), opa(pv)]), before);

  /* And the memory holds the programmed look. */
  link.send(recallCmd('screen', slot, { mode: 'PREVIEW', id: 'S1' }, dialectFor(link.store)));
  await link.waitFor(src(pv), 'LIVE_8', { timeout: 6000 });
  await link.waitFor(opa(pv), 77);

  link.send(deleteCmd('screen', slot));
  await link.waitFor(slotValid(slot), false);
});

/*
 * The simulator cannot reach this branch: during a take it reports no state
 * in between — `transition` holds its old value and then lands, with
 * `tbarPosition` jumping straight to the end — so preview always names a
 * buffer. A switcher that reports the fade in flight is refused; this checks
 * which kind it is talking to and skips, rather than passing, when it is the
 * first kind.
 */
test('save via preview refuses mid-take rather than guess which buffer is preview', { skip: SKIP }, async (t) => {
  const [slot] = claim(1);
  const programmer = createProgrammer({ session: link.session });
  programmer.seed('S1', 'PREVIEW');

  link.send([{ path: sag('S1', 'control', 'takeUpTime'), value: 20 }, { path: sag('S1', 'control', 'takeDownTime'), value: 20 }]);
  await link.waitFor(sag('S1', 'control', 'takeUpTime'), 20);
  const from = await settled(link);
  link.send({ path: sag('S1', 'control', 'xTake'), value: true });
  await sleep(600);

  const mid = link.get(sag('S1', 'status', 'transition'));
  if (mid === from) {
    await settled(link);
    await link.waitFor(sag('S1', 'status', 'transition'), (v) => v !== from, { timeout: 4000 });
    return t.skip('this switcher reports no state while a take is in flight');
  }
  const r = await saveViaPreview({ session: link.session, programmer, id: 'S1', slot });
  assert.equal(r.ok, false);
  assert.match(r.message, /take is in flight/);
  await settled(link);
  assert.equal(link.get(slotValid(slot)), false, 'nothing saved');
});

test('the Edit page writes a memory straight into the bank, or says why the switcher could not read it', { skip: SKIP }, async () => {
  const [slot] = claim(1);
  await previewLook({ source: 'LIVE_4', opacity: 180 });
  const programmer = createProgrammer({ session: link.session });
  programmer.seed('S1', 'PREVIEW');
  const memory = composeMemory({ programmer, id: 'S1', slot, label: 'lpp import' });
  assert.ok(memory, 'a memory was composed');

  await sleep(500);
  const mark = link.mark();
  const r = await app.api('/memory', { method: 'POST', body: { memories: [memory] } });
  await sleep(500);

  /* Whatever the outcome, no buffer was written and nothing was taken. */
  const buffers = link.since(mark, ['device', 'screenList', 'items', 'S1', 'presetList']);
  assert.deepEqual(buffers.map((f) => f.path.join('/')), [], 'no preset buffer written');
  assert.equal(link.since(mark, sag('S1', 'status', 'transition')).length, 0, 'no take fired');

  /*
   * The import hands the switcher a path on ITS filesystem. A simulator on
   * this machine can read our temporary directory; one on another machine
   * cannot, and the honest answer is the device's own refusal.
   */
  const local = ['127.0.0.1', 'localhost', '::1'].includes(target.host);
  if (local) {
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.slots, [slot]);
    await link.waitFor(slotValid(slot), true, { timeout: 8000 });
    assert.equal(await awjGet(slotLabel(slot)), 'lpp import');
    link.send(deleteCmd('screen', slot));
    await link.waitFor(slotValid(slot), false);
  } else {
    assert.equal(r.status, 502, r.text);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /ERROR_[A-Z_]+/, 'the device\'s own refusal is reported, not swallowed');
    assert.equal(await awjGet(slotValid(slot)), false, 'and the slot is still empty');
  }
});

test('reading memories back through the Edit route', { skip: SKIP }, async () => {
  const r = await app.api('/memory?slots=1');
  const local = ['127.0.0.1', 'localhost', '::1'].includes(target.host);
  if (local) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.memories.length, 1);
  } else {
    /* The export is written to a directory on the device's side too, so a
       remote switcher refuses the path in its own words. */
    assert.equal(r.status, 502, r.text);
    assert.match(r.json.error, /ERROR_[A-Z_]+/);
  }
});

test('a layer memory saves one layer and recalls it into the same layer of preview', { skip: SKIP }, async (t) => {
  const d = dialectFor(link.store);
  const bank = link.get(['device', 'layerBank', 'bankList', 'items']) || {};
  const free = Object.keys(bank).map(Number).sort((a, b) => b - a)
    .find((n) => bank[String(n)].status && bank[String(n)].status.pp.isValid === false);
  if (!free) return t.skip('no empty layer memory');
  const valid = ['device', 'layerBank', 'bankList', 'items', String(free), 'status', 'pp', 'isValid'];

  const pv = await previewLook({ source: 'LIVE_9', opacity: 99 });
  const save = saveCmd('layer', free, { mode: 'PREVIEW', id: 'S1', layer: '1' }, d);
  assert.ok(save, 'the dialect builds a layer save');
  link.send(save);
  try {
    await link.waitFor(valid, true, { timeout: 8000 });

    await previewLook({ source: 'LIVE_10', opacity: 33 });
    link.send(recallCmd('layer', free, { mode: 'PREVIEW', id: 'S1', layer: '1' }, d));
    await link.waitFor(src(pv), 'LIVE_9', { timeout: 6000 });
    await link.waitFor(opa(pv), 99);
  } finally {
    link.send(deleteCmd('layer', free, d));
    await link.waitFor(valid, false).catch(() => {});
  }
});
