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
