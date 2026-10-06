/*
 * Preview lock during takes: when a screen counts as mid-take, and when it
 * is let go.
 *
 * Driven against real store shapes — the LivePremier simulator's screen
 * groups and the Midra 4K's transition list — with frames shaped the way the
 * page socket delivers them (`{path, value, dir}`) and a fake clock. The DOM
 * half is pinned in `test/preset-lock.test.js` (`cardPadlock`); this file
 * pins the decisions, which are the part with consequences: a padlock shut
 * too late lets the recall through, and one never opened leaves the operator
 * unable to load preview at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DeviceStore } from '../src/core/device-store.js';
import { createPreviewGuard, statusDestination, normalise, START_GRACE_MS } from '../plugins/preview-lock/core.js';
import { dialectFor } from '../src/core/dialect.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const NLC_STATUS = (id) => ['device', 'screenAuxGroupList', 'items', id, 'status', 'pp', 'transition'];
const NLC_TAKE = (id, prop = 'xTake') => ['device', 'screenAuxGroupList', 'items', id, 'control', 'pp', prop];
const MNG_STATUS = (n) => ['device', 'transition', 'screenList', 'items', String(n), 'status', 'pp', 'transition'];
const MNG_TAKE = (n) => ['device', 'transition', 'screenList', 'items', String(n), 'control', 'pp', 'xTake'];

function fakeClock() {
  let t = 1000;
  const timers = new Set();
  return {
    now: () => t,
    setTimeout(fn, ms) { const tm = { at: t + ms, fn }; timers.add(tm); return tm; },
    clearTimeout(tm) { timers.delete(tm); },
    advance(ms) {
      t += ms;
      for (const tm of [...timers].sort((a, b) => a.at - b.at)) {
        if (tm.at <= t && timers.has(tm)) { timers.delete(tm); tm.fn(); }
      }
    }
  };
}

function rig(storeName = 'sim-6.2.73-screens.json', settings = { skip: [] }) {
  const store = new DeviceStore();
  store.hydrate(fixture(storeName));
  const events = [];
  const clock = fakeClock();
  const guard = createPreviewGuard({
    store, clock, settings: () => settings,
    lock: (id, why) => events.push(['lock', id, why]),
    unlock: (id, why) => events.push(['unlock', id, why])
  });
  /* A frame lands in the mirror before the session dispatches it, so the
     guard reads state that already includes it — do the same here. */
  const frame = (path, value, dir = 'in') => {
    store.set(path, value);
    guard.onFrame({ path, value, dir });
  };
  return { store, guard, events, clock, frame };
}

test('TAKE leaving the page locks at once, before the switcher has said anything', () => {
  const { guard, events, frame } = rig();
  frame(NLC_TAKE('S1'), true, 'out');
  assert.deepEqual(events, [['lock', 'S1', 'take']]);
  assert.equal(guard.isGuarded('S1'), true);
});

test('the lock opens when the take lands at the other end, not before', () => {
  const { guard, events, frame } = rig();
  frame(NLC_TAKE('S1'), true, 'out');
  frame(NLC_STATUS('S1'), 'EFFECT_FROM_DOWN');
  assert.equal(events.length, 1, 'still locked while the effect runs');
  frame(NLC_STATUS('S1'), 'COPY_FROM_DOWN');
  assert.equal(events.length, 1, 'still locked while preview is being copied');
  frame(NLC_STATUS('S1'), 'AT_UP');
  assert.deepEqual(events, [['lock', 'S1', 'take'], ['unlock', 'S1', 'landed']]);
  assert.equal(guard.isGuarded('S1'), false);
});

test('a transition started anywhere else is guarded from the first status frame', () => {
  const { events, frame } = rig();
  /* Front panel, T-bar, Companion, OSC: no take frame leaves this page. */
  frame(NLC_STATUS('S1'), 'EFFECT_FROM_DOWN');
  frame(NLC_STATUS('S1'), 'AT_UP');
  assert.deepEqual(events, [['lock', 'S1', 'moving'], ['unlock', 'S1', 'landed']]);
});

test('a status frame carrying the whole pp object counts too', () => {
  const { events, frame } = rig();
  const pp = NLC_STATUS('S1').slice(0, -1);
  frame(pp, { isUsed: true, transition: 'EFFECT_FROM_DOWN', take: 'ON' });
  frame(pp, { isUsed: true, transition: 'AT_UP', take: 'OFF' });
  assert.deepEqual(events.map((e) => e[0]), ['lock', 'unlock']);
});

test('a take that never starts is let go after the grace, not left locked', () => {
  const { events, frame, clock } = rig();
  frame(NLC_TAKE('S1'), true, 'out');
  clock.advance(START_GRACE_MS - 1);
  assert.equal(events.length, 1);
  clock.advance(1);
  assert.deepEqual(events, [['lock', 'S1', 'take'], ['unlock', 'S1', 'never started']]);
});

test('a take that starts late inside the grace is still followed to the end', () => {
  const { events, frame, clock } = rig();
  frame(NLC_TAKE('S1'), true, 'out');
  clock.advance(400);
  frame(NLC_STATUS('S1'), 'EFFECT_FROM_DOWN');
  clock.advance(START_GRACE_MS);
  assert.equal(events.length, 1, 'moving: the grace no longer applies');
  frame(NLC_STATUS('S1'), 'AT_UP');
  assert.equal(events[1][2], 'landed');
});

test('a zero-time take that lands before any in-flight state is still released', () => {
  const { events, frame } = rig();
  frame(NLC_TAKE('S1'), true, 'out');
  frame(NLC_STATUS('S1'), 'AT_UP');
  assert.deepEqual(events.map((e) => e[2]), ['take', 'landed']);
});

test('a T-bar parked half way keeps the lock for as long as it stays there', () => {
  const { guard, events, frame, clock } = rig();
  frame(NLC_STATUS('S1'), 'EFFECT_FROM_DOWN');
  clock.advance(10 * 60 * 1000);
  assert.equal(guard.isGuarded('S1'), true, 'preview is half on air: no cap');
  assert.equal(events.length, 1);
});

test('a second TAKE mid-take is not a second lock', () => {
  const { events, frame } = rig();
  frame(NLC_TAKE('S1'), true, 'out');
  frame(NLC_STATUS('S1'), 'EFFECT_FROM_DOWN');
  frame(NLC_TAKE('S1'), true, 'out');
  assert.equal(events.filter((e) => e[0] === 'lock').length, 1);
});

test('CUT is not a reason to lock: there is no window to recall into', () => {
  const { events, frame } = rig();
  frame(NLC_TAKE('S1', 'xCut'), true, 'out');
  assert.deepEqual(events, []);
});

test('only the destination that is taking is locked', () => {
  const { events, frame } = rig();
  frame(NLC_TAKE('S2'), true, 'out');
  assert.deepEqual(events, [['lock', 'S2', 'take']]);
});

test('a skipped destination is never locked', () => {
  const { events, frame } = rig('sim-6.2.73-screens.json', { skip: ['S1'] });
  frame(NLC_TAKE('S1'), true, 'out');
  frame(NLC_STATUS('S1'), 'EFFECT_FROM_DOWN');
  assert.deepEqual(events, []);
});

test('an inbound take echo is not mistaken for this page pressing TAKE', () => {
  const { events, frame } = rig();
  /* The switcher echoes xTake back; only the status says a take is running. */
  frame(NLC_TAKE('S1'), true, 'in');
  assert.deepEqual(events, []);
});

test('on a Midra 4K the transition list is followed the same way', () => {
  const { events, frame } = rig('midra-3.2.29-pulse4k.json');
  assert.equal(dialectFor(rig('midra-3.2.29-pulse4k.json').store).id, 'mng');
  frame(MNG_TAKE(1), true, 'out');
  frame(MNG_STATUS(1), 'EFFECT_FROM_DOWN');
  frame(MNG_STATUS(1), 'AT_UP');
  assert.deepEqual(events, [['lock', 'S1', 'take'], ['unlock', 'S1', 'landed']]);
});

test('statusDestination names the destination from either depth, and nothing else', () => {
  const { store } = rig();
  const d = dialectFor(store);
  assert.equal(statusDestination(d, NLC_STATUS('A2')), 'A2');
  assert.equal(statusDestination(d, NLC_STATUS('S3').slice(0, -1)), 'S3');
  assert.equal(statusDestination(d, ['device', 'screenAuxGroupList', 'items', 'S1', 'status', 'pp', 'tbarPosition']), null);
  assert.equal(statusDestination(d, NLC_TAKE('S1')), null);
});

test('releaseAll lets every padlock go when the plugin stops', () => {
  const { guard, events, frame } = rig();
  frame(NLC_TAKE('S1'), true, 'out');
  frame(NLC_TAKE('S2'), true, 'out');
  guard.releaseAll();
  assert.deepEqual(events.filter((e) => e[0] === 'unlock').map((e) => e[1]).sort(), ['S1', 'S2']);
});

test('settings keep only real destinations, once each, in order', () => {
  assert.deepEqual(normalise({ skip: ['s2', 'A1', 'S10', 'S2', 'bogus', 7] }), { skip: ['S2', 'S10', 'A1'] });
  assert.deepEqual(normalise({}), { skip: [] });
});

/* ------------------------------------------------- our own recalls wait */

import { previewRecallTargets, previewTargetsOf, HOLD_GRACE_MS } from '../plugins/preview-lock/core.js';
import { CueStack, ACTION_KINDS, SETTLE_MS, previewTargets } from '../src/core/cuestack.js';
import { commandsFor } from '../src/core/commands.js';

const tick = () => new Promise((r) => setImmediate(r));

test('a recall into PREVIEW is recognised on every bank and both platforms', () => {
  const nlc = dialectFor(rig().store);
  const mng = dialectFor(rig('midra-3.2.29-pulse4k.json').store);
  const of = (cmd) => previewRecallTargets(cmd.path, cmd.value);
  assert.deepEqual(of(nlc.recall('screen', 4, { mode: 'PREVIEW', id: 'S1' })), ['S1']);
  assert.deepEqual(of(nlc.recall('screen', 4, { mode: 'PREVIEW', id: 'A2' })), ['A2']);
  assert.deepEqual(of(nlc.recall('layer', 3, { mode: 'PREVIEW', id: 'S2', layer: '1' })), ['S2']);
  assert.deepEqual(of(nlc.recall('master', 9, { mode: 'PREVIEW' })), ['*'], 'a master memory covers its own screens');
  assert.deepEqual(of(mng.recall('screen', 4, { mode: 'PREVIEW', id: 'S1' })), ['S1']);
  assert.deepEqual(of(mng.recall('screen', 4, { mode: 'PREVIEW', id: 'A1' })), ['A1']);
  /* What is not a recall into preview. */
  assert.equal(of(nlc.recall('screen', 4, { mode: 'PROGRAM', id: 'S1' })), null);
  assert.equal(of(nlc.save('screen', 4, { mode: 'PREVIEW', id: 'S1' })), null);
  assert.equal(previewRecallTargets(nlc.recall('screen', 4, { mode: 'PREVIEW', id: 'S1' }).path, false), null);
  assert.deepEqual(previewTargetsOf([
    nlc.recall('screen', 4, { mode: 'PREVIEW', id: 'S1' }),
    nlc.recall('screen', 4, { mode: 'PREVIEW', id: 'S2' }),
    { path: NLC_TAKE('S1'), value: true }
  ]), ['S1', 'S2']);
  assert.equal(previewTargetsOf([{ path: NLC_TAKE('S1'), value: true }]), null);
});

test('whenSettled is null for a destination at rest, so nothing waits for nothing', () => {
  const { guard } = rig();
  assert.equal(guard.whenSettled(['S1']), null);
  assert.equal(guard.whenSettled(['*']), null);
});

test('whenSettled resolves when the take lands', async () => {
  const { guard, frame } = rig();
  frame(NLC_TAKE('S1'), true, 'out');
  frame(NLC_STATUS('S1'), 'EFFECT_FROM_DOWN');
  let result = null;
  guard.whenSettled(['S1', 'S2']).then((r) => { result = r; });
  await tick();
  assert.equal(result, null, 'S1 is still in flight');
  frame(NLC_STATUS('S1'), 'AT_UP');
  await tick();
  assert.equal(result.ok, true);
  assert.deepEqual(result.ids, ['S1', 'S2']);
});

test('whenSettled gives up after the take time and the grace, and says which is stuck', async () => {
  const { guard, frame, clock, store } = rig();
  const takeMs = Math.max(
    store.get(['device', 'screenAuxGroupList', 'items', 'S1', 'control', 'pp', 'takeUpTime']),
    store.get(['device', 'screenAuxGroupList', 'items', 'S1', 'control', 'pp', 'takeDownTime'])) * 100;
  frame(NLC_STATUS('S1'), 'EFFECT_FROM_DOWN');
  let result = null;
  guard.whenSettled(['*']).then((r) => { result = r; });
  clock.advance(takeMs + HOLD_GRACE_MS - 1);
  await tick();
  assert.equal(result, null);
  clock.advance(1);
  await tick();
  assert.equal(result.ok, false);
  assert.match(result.message, /S1 still mid-take/);
});

/** A cue stack whose sends reach the guard the way the page's do. */
function stackRig() {
  const r = rig();
  const sent = [];
  const warnings = [];
  const stack = new CueStack({
    clock: r.clock,
    commands: () => commandsFor(dialectFor(r.store)),
    /* hook.send records the frame as outbound, the transport parses it and
       the session dispatches it — synchronously, inside the send. */
    send: (cmd) => { sent.push(cmd); r.frame(cmd.path, cmd.value, 'out'); return true; },
    hold: (ids) => r.guard.whenSettled(ids)
  });
  stack.addEventListener('warning', (ev) => warnings.push(ev.detail.message));
  const what = () => sent.map((c) => (c.path.includes('load') ? `recall ${c.path[6]}` : c.path[c.path.length - 1]));
  return { ...r, stack, sent, warnings, what };
}

const recallAndTake = (number, slot, mode = 'PREVIEW') => ({
  number,
  actions: [
    { kind: ACTION_KINDS.SCREEN_PRESET, slot, targets: ['S1'], mode },
    { kind: ACTION_KINDS.TAKE, targets: ['S1'] }
  ]
});

test('GO, GO: the second cue waits for the first take to land, then fires whole', async () => {
  const { stack, frame, clock, what } = stackRig();
  stack.add(recallAndTake('1', 4));
  stack.add(recallAndTake('2', 5));

  stack.go();
  stack.go();
  assert.deepEqual(what(), ['recall 4'], 'cue 2 is queued behind cue 1’s settle, not fired over it');

  clock.advance(SETTLE_MS);
  await tick();
  assert.deepEqual(what(), ['recall 4', 'xTake'], 'cue 1 took; cue 2 now waits on that take');
  assert.deepEqual(stack.waiting.map((w) => w.ids), [['S1']]);

  frame(NLC_STATUS('S1'), 'EFFECT_FROM_DOWN');
  clock.advance(500);
  await tick();
  assert.deepEqual(what(), ['recall 4', 'xTake'], 'nothing goes into the preview fading up');

  frame(NLC_STATUS('S1'), 'AT_UP');
  await tick();
  assert.deepEqual(what(), ['recall 4', 'xTake', 'recall 5'], 'landed: cue 2’s recall goes into the new preview');
  clock.advance(SETTLE_MS);
  await tick();
  assert.deepEqual(what(), ['recall 4', 'xTake', 'recall 5', 'xTake'], 'and its take after its own settle');
  assert.deepEqual(stack.waiting, []);
});

test('a cue that recalls into PROGRAM is not held — that is “on air, now”', async () => {
  const { stack, frame, what } = stackRig();
  frame(NLC_STATUS('S1'), 'EFFECT_FROM_DOWN');
  stack.add({ number: '1', actions: [{ kind: ACTION_KINDS.SCREEN_PRESET, slot: 7, targets: ['S1'], mode: 'PROGRAM' }] });
  stack.go();
  assert.deepEqual(what(), ['recall 7']);
  assert.deepEqual(previewTargets(stack.cues[0]), []);
});

test('a hold that gives up means the cue is not fired, and says so', async () => {
  const { stack, frame, clock, what, warnings } = stackRig();
  frame(NLC_STATUS('S1'), 'EFFECT_FROM_DOWN');   /* a T-bar parked half way */
  stack.add(recallAndTake('12', 4));
  const r = stack.go();
  await tick();
  assert.deepEqual(what(), []);
  clock.advance(60 * 1000);
  await tick();
  assert.deepEqual(what(), [], 'never fired into the arriving buffer');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Cue 12 was not fired: S1 still mid-take/);
  assert.equal(r, undefined, 'go() returns nothing; the stack reports through events');
});

test('Stop cancels a cue still waiting for a take', async () => {
  const { stack, frame, what } = stackRig();
  frame(NLC_STATUS('S1'), 'EFFECT_FROM_DOWN');
  stack.add(recallAndTake('1', 4));
  const cancelled = [];
  stack.addEventListener('cancelled', (ev) => cancelled.push(ev.detail.cueId));
  stack.go();
  await tick();
  assert.equal(stack.waiting.length, 1);
  stack.stop();
  assert.deepEqual(stack.waiting, []);
  assert.deepEqual(cancelled, [stack.cues[0].id]);
  frame(NLC_STATUS('S1'), 'AT_UP');
  await tick();
  assert.deepEqual(what(), [], 'the take landing later fires nothing');
});

test('a master memory waits for every screen mid-take', async () => {
  const { stack, frame, what } = stackRig();
  frame(NLC_STATUS('A1'), 'EFFECT_FROM_DOWN');
  stack.add({ number: '1', actions: [{ kind: ACTION_KINDS.MASTER_PRESET, slot: 3, mode: 'PREVIEW' }] });
  stack.go();
  await tick();
  assert.deepEqual(what(), []);
  frame(NLC_STATUS('A1'), 'AT_UP');
  await tick();
  assert.deepEqual(what(), ['recall 3']);
});

test('with nothing mid-take a cue fires exactly as it always has', () => {
  const { stack, what } = stackRig();
  stack.add(recallAndTake('1', 4));
  stack.go();
  assert.deepEqual(what(), ['recall 4'], 'synchronously, in the same call');
});

test('a take sent to a destination that never reports is still let go after the grace', () => {
  const { events, frame, clock } = rig();
  /* S2 is not in this store at all: no T-bar position will ever arrive. */
  frame(NLC_TAKE('S2'), true, 'out');
  clock.advance(START_GRACE_MS);
  assert.deepEqual(events, [['lock', 'S2', 'take'], ['unlock', 'S2', 'never started']]);
});
