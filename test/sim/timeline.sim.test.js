/*
 * The Timeline's cue engine, firing at a live switcher.
 *
 * The page builds a `CueStack` over its session and presses GO; this does the
 * same over the proxied vendor socket, with the real clock, and checks the
 * three things the engine promises: what reaches the switcher, in which
 * order, and when. Two memories are saved on the simulator first so the cues
 * have something real to recall, and deleted after.
 *
 * Timecode goes the way the "Pushed to LivePremier Plus" source does: pushed
 * to the app's HTTP route by somebody else, out of its event stream, into a
 * `TimecodeClock`, and a `TimecodeChase` firing the stack.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKIP, startApp, Link, awjGet, sag, settled, guardScreen, layerPath, spareSlots, sleep,
  previewLook, saveFromPreview, deleteSlots, sse
} from './harness.js';
import { CueStack, SETTLE_MS } from '../../src/core/cuestack.js';
import { commandsFor } from '../../src/core/commands.js';
import { dialectFor } from '../../src/core/dialect.js';
import { bankLetter } from '../../src/core/properties.js';
import { TimecodeClock, formatTimecode } from '../../src/core/timecode.js';
import { TimecodeChase } from '../../src/core/chase.js';

let app;
let link;
let guard;
let slotA;
let slotB;
const SOURCE_A = 'LIVE_15';
const SOURCE_B = 'LIVE_16';

before(async () => {
  if (SKIP) return;
  app = await startApp();
  link = await Link.open(app);
  guard = await guardScreen(link, 'S1');
  [slotA, slotB] = spareSlots(link, 2);
  await previewLook(link, { source: SOURCE_A });
  await saveFromPreview(link, slotA);
  await previewLook(link, { source: SOURCE_B });
  await saveFromPreview(link, slotB);
  await previewLook(link, { source: 'NONE' });
});

after(async () => {
  try {
    if (link) await deleteSlots(link, [slotA, slotB].filter(Boolean));
    if (guard) await guard.restore();
  } finally {
    link?.close();
    await app?.close();
  }
});

/** A stack over the live session, recording every write as it leaves. */
function stack() {
  const sent = [];
  const s = new CueStack({
    send: (cmd) => { sent.push({ ...cmd, at: Date.now() }); link.send(cmd); return true; },
    commands: () => commandsFor(dialectFor(link.store))
  });
  const events = [];
  for (const type of ['fired', 'took', 'armed', 'end', 'stopped', 'warning', 'sendFailed']) {
    s.addEventListener(type, (e) => events.push({ type, detail: e.detail, at: Date.now() }));
  }
  return { s, sent, events };
}

const last = (path) => path[path.length - 1];
const programSource = () =>
  link.get(layerPath('S1', bankLetter(link.store, 'S1', 'PROGRAM').letter, 1, 'source', 'pp', 'inputNum'));

const recall = (slot) => ({ kind: 'screenPreset', slot, targets: ['S1'], mode: 'PREVIEW' });

test('GO recalls into preview, waits for it to land, then fades with the cue’s own time', { skip: SKIP }, async () => {
  await settled(link);
  const { s, sent } = stack();
  s.add({ number: '1', label: 'A up', fade: 0.7, actions: [recall(slotA), { kind: 'take', targets: ['S1'] }] });

  const from = link.get(sag('S1', 'status', 'transition'));
  const t0 = Date.now();
  s.go();
  await link.waitFor(sag('S1', 'status', 'transition'), (v) => v !== from, { timeout: 5000, label: 'the take to land' });

  /* The order on the wire: recall, then the fade time, then the take. */
  const names = sent.map((c) => last(c.path));
  assert.deepEqual(names, ['xRequest', 'takeUpTime', 'takeDownTime', 'xTake']);
  const recallAt = sent[0].at;
  const takeAt = sent[3].at;
  assert.ok(takeAt - recallAt >= SETTLE_MS - 5,
    `the take waited ${takeAt - recallAt} ms behind its own recall (floor ${SETTLE_MS})`);
  assert.equal(sent[1].value, 7, 'the fade goes in tenths');

  const took = Date.now() - takeAt;
  assert.ok(took >= 500, `a 0.7 s fade landed after ${took} ms`);
  assert.equal(programSource(), SOURCE_A, 'the recalled memory is what went to air');
  assert.equal(await awjGet(layerPath('S1', bankLetter(link.store, 'S1', 'PROGRAM').letter, 1, 'source', 'pp', 'inputNum')), SOURCE_A);
  assert.ok(Date.now() - t0 < 4000);
});

test('a cut-only cue goes at once, with no settle and no fade written', { skip: SKIP }, async () => {
  await settled(link);
  const { s, sent } = stack();
  s.add({ number: '2', actions: [{ kind: 'cut', targets: ['S1'] }] });
  const from = link.get(sag('S1', 'status', 'transition'));
  s.go();
  await link.waitFor(sag('S1', 'status', 'transition'), (v) => v !== from, { timeout: 2000 });
  assert.deepEqual(sent.map((c) => last(c.path)), ['xCut']);
});

test('a delay holds the cue, a second GO fires it early, and stop cancels it', { skip: SKIP }, async () => {
  await settled(link);
  const { s, sent, events } = stack();
  s.add({ number: '3', delay: 0.8, actions: [recall(slotB)] });
  s.add({ number: '4', delay: 0.8, actions: [recall(slotA)] });
  s.add({ number: '5', delay: 0.5, actions: [recall(slotB)] });

  /* Cue 3 runs out its own delay. */
  const t0 = Date.now();
  s.go();
  assert.equal(events.at(-1).type, 'armed');
  await sleep(300);
  assert.equal(sent.length, 0, 'nothing before the delay');
  await link.waitFor(layerPath('S1', bankLetter(link.store, 'S1', 'PREVIEW').letter, 1, 'source', 'pp', 'inputNum'),
    SOURCE_B, { timeout: 3000 });
  assert.ok(sent[0].at - t0 >= 750, `fired ${sent[0].at - t0} ms after GO`);

  /* Cue 4: GO again during its delay fires it now. */
  const t1 = Date.now();
  s.go();
  await sleep(100);
  s.go();
  await link.waitFor(layerPath('S1', bankLetter(link.store, 'S1', 'PREVIEW').letter, 1, 'source', 'pp', 'inputNum'),
    SOURCE_A, { timeout: 3000 });
  assert.ok(sent[1].at - t1 < 500, 'the second GO did not wait out the delay');

  /* Cue 5: stopped while armed — nothing leaves. */
  s.go();
  s.stop();
  await sleep(800);
  assert.equal(sent.length, 2, 'a stopped cue sends nothing');
  assert.ok(events.some((e) => e.type === 'stopped'));
});

test('a follow fires the next cue on its own, after the follow time', { skip: SKIP }, async () => {
  await settled(link);
  const { s, sent, events } = stack();
  s.add({ number: '6', follow: true, followTime: 0.4, actions: [recall(slotA)] });
  s.add({ number: '7', actions: [recall(slotB)] });
  s.go();
  const pv = layerPath('S1', bankLetter(link.store, 'S1', 'PREVIEW').letter, 1, 'source', 'pp', 'inputNum');
  await link.waitFor(pv, SOURCE_A, { timeout: 3000 });
  await link.waitFor(pv, SOURCE_B, { timeout: 3000 });
  assert.equal(sent.length, 2);
  assert.ok(sent[1].at - sent[0].at >= 350, `followed after ${sent[1].at - sent[0].at} ms`);
  assert.deepEqual(events.filter((e) => e.type === 'fired').map((e) => e.detail.number), ['6', '7']);
});

test('a stack saved through the app comes back as the same stack', { skip: SKIP }, async () => {
  const { s } = stack();
  s.name = 'Sim suite';
  s.add({ number: '1', label: 'Walk-in', fade: 1.5, actions: [recall(slotA), { kind: 'take', targets: ['S1'] }] });
  s.add({ number: '2', label: 'At TC', timecode: '00:00:10:00', actions: [{ kind: 'cut', targets: ['S1'] }] });

  const put = await app.api('/stack', { method: 'PUT', body: { data: s.toJSON() } });
  assert.equal(put.status, 200, put.text);
  const got = await app.api('/stack');
  assert.equal(got.status, 200);

  const again = new CueStack({});
  again.load(got.json.data);
  assert.equal(again.name, 'Sim suite');
  assert.deepEqual(again.cues.map((c) => [c.number, c.label, c.fade, c.timecode, c.actions.length]),
    [['1', 'Walk-in', 1.5, null, 2], ['2', 'At TC', null, '00:00:10:00', 1]]);
});

test('timecode pushed to the app fires the cue it reaches, and only that one', { skip: SKIP }, async () => {
  await settled(link);
  const { s, sent } = stack();
  s.add({ number: '10', timecode: '00:00:05:00', actions: [recall(slotA)] });
  s.add({ number: '11', timecode: '00:00:06:00', actions: [recall(slotB)] });
  s.add({ number: '12', timecode: '00:00:30:00', actions: [{ kind: 'cut', targets: ['S1'] }] });

  const clock = new TimecodeClock({ staleAfterMs: 500 });
  const chase = new TimecodeChase({ stack: s, clock, rate: 25 });
  const stream = sse(app.base + '/__lpp/timecode/stream', (e) => {
    if (e.event === 'timecode') clock.update(e.data, 'backend');
  });

  const push = (frame) => app.api('/timecode', {
    method: 'POST',
    body: { timecode: formatTimecode({ hours: 0, minutes: 0, seconds: Math.floor(frame / 25), frames: frame % 25 }), rate: 25 }
  });

  try {
    /* Somebody else's clock, running from 4:00 at about real time. */
    let frame = 4 * 25;
    const r = await push(frame);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.listeners >= 1, 'the page-side clock is listening');
    await sleep(100);
    chase.arm();

    const pv = layerPath('S1', bankLetter(link.store, 'S1', 'PREVIEW').letter, 1, 'source', 'pp', 'inputNum');
    /* Run to 5:12 — past cue 10, short of cue 11. */
    while (frame < 5 * 25 + 12) {
      frame += 3;
      await push(frame);
      await sleep(100);
    }
    await link.waitFor(pv, SOURCE_A, { timeout: 2000 });
    assert.equal(sent.length, 1, 'cue 10 fired, cue 11 not yet');

    /* A jump to 29:00 marks cue 11 done without firing it. */
    frame = 29 * 25;
    await push(frame);
    await sleep(300);
    assert.equal(sent.length, 1, 'a jump fires nothing it skipped');
    assert.equal(link.get(pv), SOURCE_A);

    const bad = await app.api('/timecode', { method: 'POST', body: { timecode: '25:99:00:00' } });
    assert.equal(bad.status, 400);
  } finally {
    chase.disarm();
    await stream.close();
  }
});
