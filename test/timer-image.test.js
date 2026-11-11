/*
 * Timer Image: the clock, the Stagetimer arithmetic, the two-slot push
 * against a stand-in Midra, the Stagetimer link against a stand-in server,
 * and the server half's routes.
 *
 * The stand-in Midra behaves as the 3.2.29 simulator was seen to
 * (2026-11-11): the upload route imports into the lowest empty library slot,
 * a write is echoed as an inbound frame a tick later, `xDelete` empties a
 * slot, and a Foreground Image reports itself valid at the picture's size
 * while it points at a full slot. Timer pulses are echoed and the state never
 * moves — exactly the simulator.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import { detectPlatform, supports } from '../src/core/platform.js';
import { readLibrary } from '../src/core/library-mng.js';
import {
  normalise, formatDuration, formatClock, createTracker, switcherView, readTimer, timerEvent,
  stagetimerView, stagetimerText, timerLength, planPush, ownName, ownedBy, placeAt, showWrites,
  drawSpec, pictureKey, createTimings, readScreens, readTopFrames
} from '../plugins/timer-image/core.js';
import { pushPicture, removePicture } from '../plugins/timer-image/apply.js';
import { layout, fitSize } from '../plugins/timer-image/render.js';
import { StagetimerLink, parseEvent, parseBase, createOffset } from '../plugins/timer-image/stagetimer.js';
import { FakeStagetimer } from './helpers/fake-stagetimer.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const D = ['device'];
const S = (n, ...tail) => [...D, 'screenList', 'items', String(n), ...tail];
const FRG = (n, k, ...tail) => S(n, 'topFrameList', 'items', String(k), ...tail);
const LIB = (slot, ...tail) => [...D, 'stillLibrary', 'bankList', 'items', String(slot), ...tail];
const TIMER = (key, ...tail) => [...D, 'timerList', 'items', key, ...tail];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The Midra 4K simulator's store, with its three timers as the real Pulse's store has them. */
function midra({ clearBkg = true } = {}) {
  const s = new DeviceStore();
  s.hydrate(fixture('midra-3.2.29-backgrounds.json'));
  if (clearBkg) s.set(S(1, 'backFrameList', 'items', '1', 'control', 'pp', 'librarySlot'), 'NONE');
  for (const key of ['TIMER_1', 'TIMER_2', 'TIMER_3']) {
    s.set(TIMER(key, 'control', 'pp'), { type: 'CURRENT_TIME', label: '', currentTimeMode: '24H', unitMode: 'IN_HOURS', timeOffset: 0, countdownDuration: 0, xStart: false, xPause: false, xStop: false });
    s.set(TIMER(key, 'status', 'pp'), { state: 'IDLE' });
  }
  return s;
}

/** A stand-in Midra session: echoes, the upload route, `xDelete`, frame statuses. */
function standIn(store, { status = 'FINISH', uploadMs = 2 } = {}) {
  const target = new EventTarget();
  const log = [];
  const watch = [];
  const refresh = () => {
    for (const sk of ['1', '2', '3', '4']) {
      for (const k of ['1', '2', '3', '4']) {
        const ctl = store.get(FRG(sk, k, 'control', 'pp')) || {};
        const slot = ctl.librarySlot;
        const lib = slot && slot !== 'NONE' ? store.get(LIB(slot, 'status', 'pp')) : null;
        const valid = !!(lib && lib.isValid);
        store.set(FRG(sk, k, 'status', 'pp', 'isValid'), valid);
        store.set(FRG(sk, k, 'status', 'pp', 'width'), valid ? lib.width : 0);
        store.set(FRG(sk, k, 'status', 'pp', 'height'), valid ? lib.height : 0);
      }
    }
    /* What S1 FRG4 shows at this moment: a slot that is empty would be a blank on air. */
    const shown = store.get(FRG(1, 4, 'control', 'pp', 'librarySlot'));
    if (shown && shown !== 'NONE') watch.push({ slot: shown, valid: store.get(LIB(shown, 'status', 'pp', 'isValid')) === true });
  };
  const echo = (path, value) => target.dispatchEvent(Object.assign(new Event('frame'), { detail: { dir: 'in', path, value } }));
  const session = {
    store,
    addEventListener: (...a) => target.addEventListener(...a),
    removeEventListener: (...a) => target.removeEventListener(...a),
    send({ path, value }) {
      log.push([path.join('/'), value]);
      setTimeout(() => {
        store.set(path, value);
        if (/stillLibrary\/bankList\/items\/\d+\/control\/pp\/xDelete$/.test(path.join('/')) && value === true) {
          store.set([...path.slice(0, -3), 'status', 'pp', 'isValid'], false);
          store.set([...path.slice(0, -3), 'status', 'pp', 'fileName'], '');
        }
        refresh();
        echo(path, value);
      }, 1);
      return true;
    }
  };
  const uploads = [];
  const fetchImpl = async (url, init) => {
    const file = init.body.get('FILES');
    uploads.push([url, file.name, [...init.body.keys()]]);
    const slot = readLibrary(store).slots.find((s) => s.free).slot;
    setTimeout(() => {
      if (/^FINISH/.test(status)) {
        store.set(LIB(slot, 'status', 'pp', 'fileName'), file.name);
        store.set(LIB(slot, 'status', 'pp', 'width'), 480);
        store.set(LIB(slot, 'status', 'pp', 'height'), 135);
        store.set(LIB(slot, 'status', 'pp', 'isValid'), true);
        refresh();
      }
    }, uploadMs);
    return { ok: true, status: 200, json: async () => ({ [file.name]: status }), text: async () => '' };
  };
  return { session, log, uploads, fetchImpl, watch, echo };
}

const png = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

/* =============================================================== platform */

test('offered on a Midra 4K, and not on a LivePremier, which shows a timer itself', () => {
  const m = midra();
  assert.equal(supports(detectPlatform(m), 'foregroundImages'), true);
  const lp = new DeviceStore();
  lp.hydrate(fixture('livepremier-6.2.73-platform.json'));
  assert.equal(supports(detectPlatform(lp), 'foregroundImages'), false);
});

test('the document fills in and corrects', () => {
  const d = normalise({ screen: 'S2', frame: 9, source: 'nope', style: { width: 10, colour: 'red', background: '#ABCDEF' } });
  assert.equal(d.screen, 'S2');
  assert.equal(d.frame, 4);
  assert.equal(d.source, 'switcher');
  assert.equal(d.style.width, 64);
  assert.equal(d.style.colour, '#ffffff');
  assert.equal(d.style.background, '#abcdef');
  assert.equal(normalise(null).frame, 4, 'the last Foreground Image by default: the first ones are the likeliest to hold a logo');
});

/* ============================================================= formatting */

test('durations read as the switcher’s unit modes write them', () => {
  assert.equal(formatDuration(3723, 'IN_HOURS'), '01:02:03');
  assert.equal(formatDuration(3723, 'IN_MINUTES'), '62:03');
  assert.equal(formatDuration(3723, 'IN_SECONDS'), '3723');
  assert.equal(formatDuration(3723, 'IN_HOURS', 'minutes'), '01:02');
  assert.equal(formatDuration(3723, 'IN_MINUTES', 'minutes'), '62 min');
  assert.equal(formatDuration(0, 'IN_HOURS'), '00:00:00');
});

test('a time of day in 24 h and 12 h', () => {
  assert.equal(formatClock({ hours: 14, minutes: 5, seconds: 9 }, '24H'), '14:05:09');
  assert.equal(formatClock({ hours: 14, minutes: 5, seconds: 9 }, '12H_AM_PM'), '2:05:09 PM');
  assert.equal(formatClock({ hours: 0, minutes: 5, seconds: 9 }, '12H_AM_PM', 'minutes'), '12:05 AM');
});

/* ============================================================ the tracker */

test('a timer is timed from its Start, Pause and Stop, each arriving twice', () => {
  const t = createTracker();
  t.seen('TIMER_1', 'IDLE', 0);
  /* The simulator echoes both edges of a pulse, twice. */
  for (const v of [false, true, false, true]) t.event('TIMER_1', 'start', 1000, v);
  assert.equal(t.phase('TIMER_1'), 'running');
  assert.equal(t.elapsed('TIMER_1', 4000), 3);
  for (const v of [false, true, false, true]) t.event('TIMER_1', 'pause', 6000, v);
  assert.equal(t.phase('TIMER_1'), 'paused');
  assert.equal(t.elapsed('TIMER_1', 60000), 5, 'paused time does not count');
  t.event('TIMER_1', 'start', 70000, false);
  t.event('TIMER_1', 'start', 70000, true);
  assert.equal(t.elapsed('TIMER_1', 72000), 7, 'Start while paused resumes');
  /* A real unit then reports the state it went to: no change. */
  t.event('TIMER_1', 'state', 70010, 'RUNNING');
  assert.equal(t.elapsed('TIMER_1', 72000), 7);
  t.event('TIMER_1', 'stop', 80000, false);
  t.event('TIMER_1', 'stop', 80000, true);
  assert.equal(t.phase('TIMER_1'), 'idle');
  assert.equal(t.elapsed('TIMER_1', 90000), 0);
});

test('a timer already running when first seen is unknown until stopped', () => {
  const t = createTracker();
  t.seen('TIMER_2', 'RUNNING', 0);
  assert.equal(t.elapsed('TIMER_2', 5000), null);
  t.event('TIMER_2', 'start', 6000, true);
  assert.equal(t.elapsed('TIMER_2', 7000), null, 'a Start says nothing of when it began');
  t.event('TIMER_2', 'state', 8000, 'IDLE');
  assert.equal(t.elapsed('TIMER_2', 9000), 0);
  t.event('TIMER_2', 'state', 10000, 'RUNNING');
  assert.equal(t.elapsed('TIMER_2', 12500), 2.5, 'the front panel’s Start, seen only as a state');
});

test('a real Pulse 4K’s messages: pause, resume, stop and start of a 10-minute countdown', () => {
  /* Logged off a Pulse 4K 3.3.10's WebSocket on 2026-11-11 while the
     operator pressed the vendor's buttons; ms from the moment the page first
     saw Timer 1, already RUNNING. Each pulse's echo comes first, the state
     2–9 ms after; the flags stay latched true. */
  const PULSE = [
    [50371, 'xPause', true], [50372, 'xPause', true], [50374, 'state', 'PAUSED'],
    [51487, 'xStart', false], [51491, 'xStart', true], [51491, 'xStart', false], [51492, 'xStart', true], [51492, 'state', 'RUNNING'],
    [52994, 'xStop', true], [52996, 'xStop', true], [52998, 'state', 'IDLE'],
    [54669, 'xStart', false], [54670, 'xStart', true], [54672, 'xStart', false], [54676, 'xStart', true], [54678, 'state', 'RUNNING']
  ];
  const store = midra();
  store.set(TIMER('TIMER_1', 'control', 'pp', 'type'), 'COUNTDOWN');
  store.set(TIMER('TIMER_1', 'control', 'pp', 'countdownDuration'), 600);
  const timer = readTimer(store, 'TIMER_1');
  const t = createTracker();
  t.seen('TIMER_1', 'RUNNING', 0);
  const phases = [];
  for (const [at, prop, value] of PULSE) {
    const path = prop === 'state' ? TIMER('TIMER_1', 'status', 'pp', 'state') : TIMER('TIMER_1', 'control', 'pp', prop);
    const e = timerEvent(path);
    t.event(e.key, e.kind, at, value);
    phases.push(t.phase('TIMER_1'));
  }
  assert.deepEqual(phases.slice(0, 8), Array(8).fill('unknown'), 'a pause and resume of a countdown never seen starting say nothing');
  assert.deepEqual(phases.slice(8, 11), ['idle', 'idle', 'idle'], 'Stop makes it knowable');
  assert.deepEqual(phases.slice(11), ['idle', 'running', 'running', 'running', 'running'], 'timed from the first rising xStart');
  assert.equal(switcherView(timer, t, 54670 + 51200).text, '00:09:09', '51.2 s in, as the replay read it');
  /* The Pulse said ELAPSED 600.103 s after that rising xStart (11:10:47.732
     against 11:00:47.629): its clock and ours agree to a tenth of a second. */
  const ELAPSED_AT = 54670 + 600103;
  assert.equal(switcherView(timer, t, ELAPSED_AT - 1000).text, '00:00:01', 'counting the last second');
  assert.equal(switcherView(timer, t, ELAPSED_AT - 1).text, '00:00:00', 'ours reached zero 0.103 s before the Pulse said so');
  t.event('TIMER_1', 'state', ELAPSED_AT, 'ELAPSED');
  assert.equal(t.phase('TIMER_1'), 'elapsed');
  assert.ok(Math.abs(t.elapsed('TIMER_1', ELAPSED_AT + 60000) - 600.103) < 1e-9, 'elapsed stops at the Pulse’s word');
  assert.equal(switcherView(timer, t, ELAPSED_AT + 60000).text, '00:00:00');
});

test('only timer pulses and states are timer events', () => {
  assert.deepEqual(timerEvent(TIMER('TIMER_3', 'control', 'pp', 'xPause')), { key: 'TIMER_3', kind: 'pause' });
  assert.deepEqual(timerEvent(TIMER('TIMER_1', 'status', 'pp', 'state')), { key: 'TIMER_1', kind: 'state' });
  assert.equal(timerEvent(TIMER('TIMER_1', 'control', 'pp', 'countdownDuration')), null);
  assert.equal(timerEvent(TIMER('TIMER_9', 'control', 'pp', 'xStart')), null);
});

test('what a switcher timer reads: countdown, stopwatch, time of day, unknown', () => {
  const store = midra();
  store.set(TIMER('TIMER_1', 'control', 'pp', 'type'), 'COUNTDOWN');
  store.set(TIMER('TIMER_1', 'control', 'pp', 'countdownDuration'), 90);
  const t = createTracker();
  t.seen('TIMER_1', 'IDLE', 0);
  const timer = readTimer(store, 'TIMER_1');
  assert.equal(switcherView(timer, t, 0).text, '00:01:30', 'idle shows the full duration');
  t.event('TIMER_1', 'start', 1000, true);
  assert.equal(switcherView(timer, t, 1400).text, '00:01:30', 'rounded up while time is left');
  assert.equal(switcherView(timer, t, 2000).text, '00:01:29');
  assert.equal(switcherView(timer, t, 2000, 'minutes').text, '00:02');
  const over = switcherView(timer, t, 120000);
  assert.equal(over.text, '00:00:00');
  assert.equal(over.phase, 'over');

  store.set(TIMER('TIMER_2', 'control', 'pp', 'type'), 'STOPWATCH');
  store.set(TIMER('TIMER_2', 'control', 'pp', 'unitMode'), 'IN_MINUTES');
  t.seen('TIMER_2', 'IDLE', 0);
  t.event('TIMER_2', 'start', 0, true);
  assert.equal(switcherView(readTimer(store, 'TIMER_2'), t, 61900).text, '01:01', 'rounded down');

  store.set(TIMER('TIMER_3', 'control', 'pp', 'timeOffset'), 3600);
  const at = new Date(2026, 10, 11, 9, 30, 15).getTime();
  assert.equal(switcherView(readTimer(store, 'TIMER_3'), t, at).text, '10:30:15', 'this machine’s clock plus the offset');

  const u = createTracker();
  u.seen('TIMER_1', 'PAUSED', 0);
  const unknown = switcherView(timer, u, 1000);
  assert.equal(unknown.known, false);
  assert.match(unknown.why, /never published/);
});

/* ============================================================= Stagetimer */

test('a Stagetimer countdown is finish minus now while running, finish minus pause while paused', () => {
  const timer = { _id: 't1', name: 'Keynote', appearance: 'COUNTDOWN', duration: '0:10:00', wrap_up_yellow: 120, wrap_up_red: 30 };
  const base = { timer_id: 't1', running: true, start: 1_000_000, finish: 1_600_000, pause: 0 };
  const snap = { status: base, current: timer, timers: [timer], room: { timezone: 'UTC' }, offsetMs: 500 };
  const v = stagetimerView(snap, 1_000_000);
  assert.equal(v.remainingMs, 599_500, 'the server’s clock is ours plus the offset');
  assert.equal(stagetimerText(v).text, '10:00');
  assert.equal(v.phase, 'green');
  assert.equal(stagetimerView(snap, 1_500_000).phase, 'yellow');
  assert.equal(stagetimerView(snap, 1_580_000).phase, 'red');
  const over = stagetimerView(snap, 1_662_000);
  assert.equal(over.phase, 'over');
  assert.equal(stagetimerText(over).text, '+1:02', 'over, with a room’s default plus, as a real room drew it');
  const paused = stagetimerView({ ...snap, status: { ...base, running: false, pause: 1_300_000 } }, 1_550_000);
  assert.equal(stagetimerText(paused).text, '5:00');
  assert.equal(paused.running, false);
  assert.equal(stagetimerText(stagetimerView(snap, 1_000_000), { precision: 'minutes' }).text, '10 min');
});

test('Stagetimer’s appearances: count-up, time of day, and both', () => {
  const at = Date.UTC(2026, 10, 11, 14, 5, 9);
  const mk = (appearance) => stagetimerView({
    status: { timer_id: 't', running: true, start: at - 65_000, finish: at + 3_535_000, pause: 0 },
    current: { _id: 't', appearance }, timers: [], room: { timezone: 'UTC' }, offsetMs: 0
  }, at);
  assert.equal(stagetimerText(mk('COUNTUP')).text, '1:05');
  assert.equal(stagetimerText(mk('TOD')).text, '14:05:09');
  assert.deepEqual([stagetimerText(mk('COUNTDOWN_TOD')).text, stagetimerText(mk('COUNTDOWN_TOD')).sub], ['58:55', '14:05']);
  assert.equal(stagetimerText(mk('HIDDEN')).text, '');
  assert.equal(stagetimerText(stagetimerView(null, at)).known, false);
  assert.equal(timerLength({ duration: '1:02:03' }), 3723);
  assert.equal(timerLength({ hours: 0, minutes: 5, seconds: 0 }), 300);
});

test('a Socket.IO event body, with and without a namespace and ack id', () => {
  assert.deepEqual(parseEvent('["playback_status",{"running":true}]'), { name: 'playback_status', data: { running: true } });
  assert.deepEqual(parseEvent('/v1,12["room",{"name":"x"}]'), { name: 'room', data: { name: 'x' } });
  assert.equal(parseEvent('nonsense'), null);
  assert.deepEqual(parseBase('https://api.stagetimer.io'), { host: 'api.stagetimer.io', port: 443, secure: true, prefix: '', http: 'https://api.stagetimer.io' });
});

test('the clock offset trusts server_time only while a Date header agrees', () => {
  let now = 1_000_000;
  const o = createOffset(() => now);
  o.dateHeader(1_010_000, now);
  assert.equal(o.get(), 10_500);
  o.serverTime(1_010_200, now);
  assert.equal(o.get(), 10_200);
  o.serverTime(1_090_000, now);
  assert.equal(o.get(), 10_500, 'a sample 80 s out is not believed');
});

/* ========================================================= the two slots */

test('the plan refuses a frame showing someone else’s picture, and a predicted slot another frame points at', () => {
  const store = midra({ clearBkg: false });
  const p = planPush(store, { screen: 'S1', frame: 4 });
  assert.equal(p.ok, false, 'S1 BKG1 points at empty slot 1, the slot the upload would take');
  assert.match(p.problems[0], /S1 BKG1/);

  const clear = midra();
  clear.set(LIB(3, 'status', 'pp'), { isValid: true, fileName: 'logo.png', width: 300, height: 100 });
  clear.set(FRG(1, 2, 'control', 'pp', 'librarySlot'), '3');
  const q = planPush(clear, { screen: 'S1', frame: 2 });
  assert.equal(q.ok, false);
  assert.match(q.problems[0], /logo\.png/);
  const r = planPush(clear, { screen: 'S1', frame: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.predicted, 1);
  assert.equal(r.name, 'lpp-timer-S1-FRG4-a.png');
});

test('every push lands in an empty slot before the old one goes, so the frame never shows an empty slot', async () => {
  const store = midra();
  const { session, uploads, fetchImpl, watch, log } = standIn(store);
  const first = await pushPicture({ session, screen: 'S1', frame: 4, blob: png(), fetchImpl });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.slot, 1);
  assert.equal(store.get(FRG(1, 4, 'control', 'pp', 'librarySlot')), '1');
  assert.equal(store.get(FRG(1, 4, 'control', 'pp', 'mode')), '1_1');

  const second = await pushPicture({ session, screen: 'S1', frame: 4, blob: png(), fetchImpl });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.slot, 2, 'slot 1 still showed while slot 2 took the new picture');
  assert.equal(readLibrary(store).slots.find((s) => s.slot === 1).free, true, 'then slot 1 was emptied');

  const third = await pushPicture({ session, screen: 'S1', frame: 4, blob: png(), fetchImpl });
  assert.equal(third.slot, 1, 'and taken again by the next');
  assert.deepEqual(uploads.map((u) => u[1]), ['lpp-timer-S1-FRG4-a.png', 'lpp-timer-S1-FRG4-b.png', 'lpp-timer-S1-FRG4-a.png']);
  assert.deepEqual(uploads.map((u) => u[2]), [['FILES'], ['FILES'], ['FILES']], 'the file and nothing else: the switcher picks the slot');
  assert.ok(watch.length > 0);
  assert.ok(watch.every((w) => w.valid), `S1 FRG4 pointed at an empty slot: ${JSON.stringify(watch.filter((w) => !w.valid))}`);
  assert.equal(readLibrary(store).slots.filter((s) => !s.free).length, 1, 'one slot in steady state');
  assert.ok(Number.isFinite(third.total) && third.total >= third.upload);
  assert.ok(!log.some(([p]) => /backFrameList/.test(p)), 'no Background Image touched');
});

test('a slot of ours that no frame points at is tidied by the next push', async () => {
  const store = midra();
  store.set(LIB(5, 'status', 'pp'), { isValid: true, fileName: ownName('S1', 4, 'b'), width: 480, height: 135 });
  const { session, fetchImpl } = standIn(store);
  const plan = planPush(store, { screen: 'S1', frame: 4 });
  assert.deepEqual(plan.tidy, [5]);
  const res = await pushPicture({ session, screen: 'S1', frame: 4, blob: png(), fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(readLibrary(store).slots.find((s) => s.slot === 5).free, true);
});

test('Remove points the frame at nothing and empties our slots, and leaves a stranger’s picture alone', async () => {
  const store = midra();
  const { session, fetchImpl } = standIn(store);
  await pushPicture({ session, screen: 'S1', frame: 4, blob: png(), fetchImpl });
  const res = await removePicture({ session, screen: 'S1', frame: 4 });
  assert.equal(res.ok, true, res.error);
  assert.equal(store.get(FRG(1, 4, 'control', 'pp', 'librarySlot')), 'NONE');
  assert.equal(readLibrary(store).slots.every((s) => s.free), true);

  store.set(LIB(7, 'status', 'pp'), { isValid: true, fileName: 'logo.png', width: 300, height: 100 });
  store.set(FRG(1, 3, 'control', 'pp', 'librarySlot'), '7');
  const no = await removePicture({ session, screen: 'S1', frame: 3 });
  assert.equal(no.ok, false);
  assert.equal(store.get(FRG(1, 3, 'control', 'pp', 'librarySlot')), '7');
});

test('a push the switcher refuses fails, and empties what it uploaded', async () => {
  const store = midra();
  const { session, fetchImpl } = standIn(store);
  const refusing = { ...session, send(w) { if (/topFrameList/.test(w.path.join('/'))) return true; return session.send(w); } };
  const res = await pushPicture({ session: refusing, screen: 'S1', frame: 4, blob: png(), fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.error, /did not take S1 FRG4/);
  assert.equal(readLibrary(store).slots.every((s) => s.free), true);
});

test('file names say whose a picture is', () => {
  assert.deepEqual(ownedBy('lpp-timer-S2-FRG3-b.png'), { screen: 'S2', frame: 3, side: 'b' });
  assert.equal(ownedBy('logo.png'), null);
});

test('the top layer is placed by its centre, from the edges', () => {
  assert.deepEqual(placeAt({ width: 1920, height: 1080 }, 480, 136, 'bottom-right', 40), { posH: 1640, posV: 972 });
  assert.deepEqual(placeAt({ width: 1920, height: 1080 }, 480, 136, 'centre', 40), { posH: 960, posV: 540 });
  const w = showWrites('S1', 'DOWN', 4, { posH: 1, posV: 2 });
  assert.deepEqual(w[0].path, S(1, 'presetList', 'items', 'DOWN', 'top', 'source', 'pp', 'frame'));
  assert.equal(w[0].value, '4');
});

test('the store’s screens and Foreground Images', () => {
  const store = midra();
  const screens = readScreens(store);
  assert.ok(screens.length >= 1);
  assert.equal(screens[0].id, 'S1');
  assert.equal(readTopFrames(store, 'S1').length, 4);
});

/* ================================================================ drawing */

test('the text is sized from a template, so it holds still from second to second', () => {
  const measure = (text, px) => text.length * px * 0.6;
  const a = layout({ width: 480, height: 135, text: '00:01:11', sub: '', label: '' }, measure);
  const b = layout({ width: 480, height: 135, text: '00:08:88', sub: '', label: '' }, measure);
  assert.equal(a.main.px, b.main.px);
  assert.ok(fitSize(measure, '12:34:56', 480, 1000) * 8 * 0.6 <= 480);
  const spec = drawSpec(normalise(null).style, { text: '1:00', sub: '', phase: 'over' });
  assert.equal(spec.colour, '#ff3b30');
  assert.notEqual(pictureKey(spec), pictureKey({ ...spec, text: '0:59' }));
});

test('timings report the median and the 90th percentile', () => {
  const t = createTimings();
  for (const total of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]) t.add({ ok: true, total, upload: total - 10, point: 5, remove: 5 });
  t.add({ ok: false, total: 0 });
  const s = t.summary();
  assert.equal(s.median, 600);
  assert.equal(s.p90, 1000);
  assert.equal(s.failed, 1);
});

/* ======================================================= the Stagetimer link */

const TIMER_A = { _id: 'tA', name: 'Opening', appearance: 'COUNTDOWN', duration: '0:05:00' };

test('the link reads a room over the feed: the key in the CONNECT, never a URL', async (t) => {
  const st = await new FakeStagetimer({ roomId: 'ROOM1', apiKey: 'SECRET', timers: [TIMER_A], status: { timer_id: 'tA', running: true, start: Date.now(), finish: Date.now() + 300_000, pause: 0 } }).listen();
  t.after(() => st.close());
  const link = new StagetimerLink({ roomId: 'ROOM1', apiKey: 'SECRET', base: st.base });
  t.after(() => link.stop());
  link.start();
  for (let i = 0; i < 100 && !(link.state === 'live' && link.snap.status && link.snap.timers.length); i++) await sleep(20);
  assert.equal(link.state, 'live');
  assert.deepEqual(st.connects, [{ room_id: 'ROOM1', api_key: 'SECRET' }]);
  assert.equal(st.unmasked, 0, 'every client frame masked');
  assert.equal(link.snapshot().status.timer_id, 'tA');
  assert.equal(link.snapshot().current.name, 'Opening');
  assert.equal(link.describe().roomName, 'Main hall');
  assert.ok(!JSON.stringify(link.describe()).includes('SECRET'), 'describe() never carries the key');
  assert.ok(st.requests.every((r) => !JSON.stringify(r.query).includes('SECRET')), 'the key is never in a query string');
  assert.ok(st.requests.some((r) => r.path === '/v1/get_all_timers' && r.auth === 'Bearer SECRET'));

  st.emit('playback_status', { timer_id: 'tA', running: false, start: 1, finish: 2, pause: 2, server_time: Date.now() });
  for (let i = 0; i < 50 && link.snap.status.running; i++) await sleep(10);
  assert.equal(link.snapshot().status.running, false);
});

test('a refused room stops the link, saying why, and it does not retry', async (t) => {
  const st = await new FakeStagetimer({ roomId: 'ROOM1', apiKey: 'SECRET' }).listen();
  t.after(() => st.close());
  const link = new StagetimerLink({ roomId: 'NOPE', apiKey: 'SECRET', base: st.base });
  t.after(() => link.stop());
  link.start();
  for (let i = 0; i < 100 && link.state !== 'refused'; i++) await sleep(20);
  assert.equal(link.state, 'refused');
  assert.match(link.error, /Room not found/);
  await sleep(1200);
  assert.equal(st.connects.length, 1, 'no second try');
  await assert.rejects(new StagetimerLink({ roomId: 'ROOM1', apiKey: 'WRONG', base: st.base }).testAuth(), /Access Denied/);
  assert.equal(await new StagetimerLink({ roomId: 'ROOM1', apiKey: 'SECRET', base: st.base }).testAuth(), true);
});

test('with the feed down the link reads get_status instead', async (t) => {
  const st = await new FakeStagetimer({ roomId: 'R', apiKey: 'K', status: { timer_id: 'tA', running: true, start: 1, finish: 2, pause: 0 } }).listen();
  st.socketOff = true;
  t.after(() => st.close());
  const link = new StagetimerLink({ roomId: 'R', apiKey: 'K', base: st.base });
  t.after(() => link.stop());
  link.start();
  for (let i = 0; i < 100 && link.state !== 'polling'; i++) await sleep(20);
  assert.equal(link.state, 'polling');
  assert.equal(link.snapshot().status.timer_id, 'tA');
  assert.ok(st.requests.some((r) => r.path === '/v1/get_status'));
});

/* ========================================================= the server half */

/** Just enough of the plugin host's server `ctx` to run the server half. */
function fakeCtx({ files = new Map() } = {}) {
  const routes = new Map();
  const disposers = [];
  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  const ctx = {
    id: 'timer-image',
    HttpError,
    route: (method, path, fn) => routes.set(`${method} ${path}`, fn),
    contribute: () => {},
    onDispose: (fn) => disposers.push(fn),
    log: () => {},
    storage: {
      load: async (name, { perDevice } = {}) => files.get(`${name}${perDevice ? '@dev' : ''}`) ?? null,
      save: async (name, data, { perDevice } = {}) => { files.set(`${name}${perDevice ? '@dev' : ''}`, data); }
    }
  };
  const call = async (method, path, { body, query = '' } = {}) => {
    const fn = routes.get(`${method} ${path}`);
    assert.ok(fn, `${method} ${path} is a route`);
    let out = null;
    const chunks = [];
    const closers = [];
    const req = { on: (ev, f) => { if (ev === 'close') closers.push(f); } };
    const res = { writeHead: (s, hdr) => { out = { status: s, headers: hdr }; }, write: (c) => { chunks.push(String(c)); return true; }, end: () => {} };
    const raw = body === undefined ? '' : JSON.stringify(body);
    const h = {
      url: new URL(`http://x/__lpp/timer-image${path}${query}`),
      json: (status, b) => { out = { status, body: b }; },
      readJson: async () => (raw ? JSON.parse(raw) : {}),
      readBody: async () => Buffer.from(raw)
    };
    await fn(req, res, h);
    return { ...out, chunks, close: () => closers.forEach((f) => f()) };
  };
  return { ctx, call, files, dispose: () => disposers.reverse().forEach((f) => f()) };
}

test('the server never hands the key back, and keeps it out of the setup file', async (t) => {
  const { default: activate } = await import('../plugins/timer-image/server.js');
  const { ctx, call, files, dispose } = fakeCtx();
  t.after(dispose);
  activate(ctx);
  const put = await call('PUT', '/stagetimer', { body: { roomId: 'ROOM9', apiKey: 'SUPERSECRET', enabled: false } });
  assert.equal(put.status, 200);
  assert.equal(put.body.keySet, true);
  assert.ok(!JSON.stringify(put.body).includes('SUPERSECRET'));
  const got = await call('GET', '/stagetimer');
  assert.ok(!JSON.stringify(got.body).includes('SUPERSECRET'));
  assert.equal(got.body.roomId, 'ROOM9');
  assert.equal(files.get('timer-image-stagetimer').apiKey, 'SUPERSECRET', 'kept on this machine');
  /* An empty key keeps the one set; clearKey forgets it. */
  await call('PUT', '/stagetimer', { body: { apiKey: '' } });
  assert.equal(files.get('timer-image-stagetimer').apiKey, 'SUPERSECRET');
  await call('PUT', '/stagetimer', { body: { clearKey: true } });
  assert.equal(files.get('timer-image-stagetimer').apiKey, '');
});

test('the tick names one runner, the oldest page, and hands over when it goes', async (t) => {
  const { default: activate } = await import('../plugins/timer-image/server.js');
  const { ctx, call, dispose } = fakeCtx();
  t.after(dispose);
  activate(ctx);
  const a = await call('GET', '/stream', { query: '?page=pa' });
  const b = await call('GET', '/stream', { query: '?page=pb' });
  const lastTick = (s) => JSON.parse(s.chunks.filter((c) => c.startsWith('event: tick')).at(-1).split('data: ')[1]);
  assert.equal(lastTick(a).runner, 'pa');
  assert.equal(lastTick(b).runner, 'pa');
  assert.equal(lastTick(b).running, false);
  const run = await call('POST', '/run', { body: { on: true } });
  assert.equal(run.body.running, true);
  const notRunner = await call('POST', '/report', { body: { page: 'pb', report: { text: 'x' } } });
  assert.equal(notRunner.status, 409, 'only the runner speaks for the switcher');
  a.close();
  await sleep(80);
  assert.equal(lastTick(b).runner, 'pb');
  assert.equal(lastTick(b).running, true);
  const stop = await call('POST', '/report', { body: { page: 'pb', report: { error: 'no' }, stop: true } });
  assert.equal(stop.status, 200);
  await sleep(80);
  assert.equal(lastTick(b).running, false, 'a runner that gives up stops the timer for every page');
  assert.equal(lastTick(b).report.error, 'no');
});
