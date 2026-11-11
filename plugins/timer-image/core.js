/*
 * Timer Image — the part with no DOM and no I/O.
 *
 * A Midra 4K or Alta 4K (a Pulse 4K, say) shows its three timers on the
 * multiviewer and nowhere else: a screen has no timer source. This plugin
 * draws a timer as a small PNG and keeps one of a screen's Foreground Images
 * showing it, a fresh picture each time the text changes. The operator puts
 * that Foreground Image on a screen the way they would a logo — the top layer
 * of a preset — and takes it.
 *
 * ## Where the time comes from
 *
 * - **A switcher timer** (`device/timerList/items/TIMER_1..3`). ⚠️ A Midra
 *   publishes a timer's settings and its state (IDLE, RUNNING, PAUSED,
 *   ELAPSED) and **no running value** — the real Pulse 4K's store (2026-09-12)
 *   and the Midra 3.2.29 Web RCS bundle agree, and the bundle serves
 *   snapshots of inputs and screens only, none of a timer. So the time is
 *   kept here (`createTracker`), from what is seen happen: the Start, Pause
 *   and Stop pulses any client sends (`control/pp/xStart|xPause|xStop`, which
 *   the switcher broadcasts) and every state the switcher reports. A timer
 *   already running or paused when this page first sees it **cannot be
 *   known** — when it started was never published — and reads as unknown
 *   until it is stopped. The simulator echoes the pulses and never changes
 *   a timer's state, so the state half is unproven: written to the
 *   vendor's enum, never seen move.
 *   A time-of-day timer is this machine's clock plus the timer's
 *   `timeOffset`, not the switcher's own clock, which no store path carries.
 * - **Stagetimer.io**, a room's current timer, through the server half
 *   (`stagetimer.js`): its feed carries `start`, `finish` and `pause` in the
 *   server's milliseconds, so a countdown is exact whenever this machine
 *   joined. `stagetimerView` is the arithmetic, after bdstage's `TimerAt`.
 *
 * ## Why two library slots, not one
 *
 * Deleting the picture a Foreground Image shows empties that frame at once —
 * a blank on air for as long as the next upload takes. So each new picture
 * goes into an empty slot while the old one is still showing, the frame is
 * pointed at it, and only then is the old slot emptied. Two slots at most,
 * one in steady state.
 *
 * ⚠️ **The switcher picks the slot**: the lowest empty one, even one another
 * frame points at, which would then show the timer. `planPush` predicts it
 * and refuses when any frame points there.
 *
 * A picture is ours by its **file name** (`ownName`): `lpp-timer-S1-FRG2-a.png`
 * and `-b.png` alternate. Nothing about ownership is saved, so a reload or a
 * second machine recognises the slots, and a slot of ours that no frame
 * points at — left by a push that failed halfway — is tidied by the next one.
 */

import { ROOT } from '../../src/core/paths.js';
import { readLibrary, nextSlots, framesOn, libraryDeleteWrites } from '../../src/core/library-mng.js';

/* ================================================================ options */

export const SOURCES = [
  { id: 'switcher', label: 'Switcher timer', what: 'One of the switcher’s three multiviewer timers, timed here from the Start, Pause and Stop it sees.' },
  { id: 'stagetimer', label: 'Stagetimer', what: 'The current timer of a Stagetimer.io room, through this app’s server.' }
];

export const PRECISIONS = [
  { id: 'seconds', label: 'Seconds', what: 'A new picture every second.' },
  { id: 'minutes', label: 'Minutes', what: 'A new picture once a minute: hours and minutes only.' }
];

/** Where the preset's top layer puts the picture, from the canvas edges. */
export const PLACES = [
  { id: 'bottom-right', label: 'Bottom right' },
  { id: 'bottom-left', label: 'Bottom left' },
  { id: 'bottom-centre', label: 'Bottom centre' },
  { id: 'top-right', label: 'Top right' },
  { id: 'top-left', label: 'Top left' },
  { id: 'top-centre', label: 'Top centre' },
  { id: 'centre', label: 'Centre' }
];

export const TIMER_KEYS = ['TIMER_1', 'TIMER_2', 'TIMER_3'];
/** Four Foreground Images per screen (`TOP_PRESET_FRAME` 1..4, FRG1..FRG4). */
export const FRAME_COUNT = 4;

export const SIZE_LIMITS = { minWidth: 64, maxWidth: 1920, minHeight: 32, maxHeight: 1080 };

export const DEFAULT_STYLE = Object.freeze({
  width: 480,
  height: 135,
  background: '#000000',
  transparent: false,
  colour: '#ffffff',
  phaseColours: true,
  label: ''
});

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const pick = (v, list, dflt) => (list.some((x) => x.id === v) ? v : dflt);

/**
 * The per-switcher document:
 *
 *   { version: 1, screen: 'S1', frame: 2, source: 'switcher', timer: 'TIMER_1',
 *     precision: 'seconds', place: 'bottom-right', margin: 40,
 *     style: { width, height, background, transparent, colour, phaseColours, label } }
 *
 * Whether it is running is not in it: a timer that started itself on the
 * next page load, on air, would be a surprise.
 */
export function normalise(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const s = d.style && typeof d.style === 'object' ? d.style : {};
  return {
    version: 1,
    screen: typeof d.screen === 'string' && /^S\d+$/.test(d.screen) ? d.screen : 'S1',
    frame: clampInt(d.frame, 1, FRAME_COUNT, FRAME_COUNT),
    source: pick(d.source, SOURCES, 'switcher'),
    timer: TIMER_KEYS.includes(d.timer) ? d.timer : 'TIMER_1',
    precision: pick(d.precision, PRECISIONS, 'seconds'),
    place: pick(d.place, PLACES, 'bottom-right'),
    margin: clampInt(d.margin, 0, 500, 40),
    style: {
      width: clampInt(s.width, SIZE_LIMITS.minWidth, SIZE_LIMITS.maxWidth, DEFAULT_STYLE.width),
      height: clampInt(s.height, SIZE_LIMITS.minHeight, SIZE_LIMITS.maxHeight, DEFAULT_STYLE.height),
      background: isHex(s.background) ? s.background.toLowerCase() : DEFAULT_STYLE.background,
      transparent: s.transparent === true,
      colour: isHex(s.colour) ? s.colour.toLowerCase() : DEFAULT_STYLE.colour,
      phaseColours: s.phaseColours !== false,
      label: typeof s.label === 'string' ? s.label.slice(0, 40) : ''
    }
  };
}

/* ============================================================= formatting */

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * A duration as the switcher's `unitMode` writes it: `IN_HOURS` 01:02:03,
 * `IN_MINUTES` 62:03, `IN_SECONDS` 3723. At minute precision the seconds go:
 * 01:02, then `62 min` for the other two.
 */
export function formatDuration(totalSeconds, unitMode = 'IN_HOURS', precision = 'seconds') {
  const neg = totalSeconds < 0;
  const t = Math.abs(Math.trunc(totalSeconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = t % 60;
  const sign = neg ? '-' : '';
  if (precision === 'minutes') {
    if (unitMode === 'IN_HOURS') return `${sign}${pad(h)}:${pad(m)}`;
    return `${sign}${Math.floor(t / 60)} min`;
  }
  if (unitMode === 'IN_SECONDS') return `${sign}${t}`;
  if (unitMode === 'IN_MINUTES') return `${sign}${pad(Math.floor(t / 60))}:${pad(s)}`;
  return `${sign}${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * A time of day: `24H` 14:05:09, `12H_AM_PM` 2:05:09 PM. `parts` is
 * `{ hours, minutes, seconds }` so the caller decides the time zone.
 */
export function formatClock(parts, mode = '24H', precision = 'seconds') {
  const { hours, minutes, seconds } = parts;
  const secs = precision === 'minutes' ? '' : `:${pad(seconds)}`;
  if (mode === '12H_AM_PM') {
    const h12 = hours % 12 === 0 ? 12 : hours % 12;
    return `${h12}:${pad(minutes)}${secs} ${hours < 12 ? 'AM' : 'PM'}`;
  }
  return `${pad(hours)}:${pad(minutes)}${secs}`;
}

/** `{ hours, minutes, seconds }` of an instant, in this machine's zone or a named one. */
export function clockParts(ms, timeZone) {
  if (timeZone) {
    try {
      const f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
      const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      return { hours: Number(p.hour) % 24, minutes: Number(p.minute), seconds: Number(p.second) };
    } catch { /* an unknown zone: this machine's */ }
  }
  const d = new Date(ms);
  return { hours: d.getHours(), minutes: d.getMinutes(), seconds: d.getSeconds() };
}

/* ================================================== the switcher's timers */

const pp = (node) => (node && typeof node === 'object' && node.pp) || {};

/** One timer's control and status, as the store holds them. */
export function readTimer(store, key) {
  const node = store.get([ROOT, 'timerList', 'items', key]);
  if (!node) return null;
  const c = pp(node.control);
  const st = pp(node.status);
  return {
    key,
    n: Number(String(key).replace(/\D/g, '')) || 0,
    label: String(c.label || ''),
    type: String(c.type || 'CURRENT_TIME'),
    currentTimeMode: String(c.currentTimeMode || '24H'),
    unitMode: String(c.unitMode || 'IN_HOURS'),
    timeOffset: Number(c.timeOffset) || 0,
    countdownDuration: Number(c.countdownDuration) || 0,
    state: String(st.state || 'IDLE')
  };
}

export const TYPE_WORDS = { CURRENT_TIME: 'time of day', COUNTDOWN: 'countdown', STOPWATCH: 'stopwatch' };

/** Which timer event a store path is, or null: `start`, `pause`, `stop`, or `state`. */
export function timerEvent(path) {
  if (!Array.isArray(path) || path[0] !== ROOT || path[1] !== 'timerList' || path[2] !== 'items') return null;
  const key = path[3];
  if (!TIMER_KEYS.includes(key)) return null;
  if (path[4] === 'control' && path[5] === 'pp') {
    const kind = { xStart: 'start', xPause: 'pause', xStop: 'stop' }[path[6]];
    return kind ? { key, kind } : null;
  }
  if (path[4] === 'status' && path[5] === 'pp' && path[6] === 'state') return { key, kind: 'state' };
  return null;
}

/**
 * The clock this page keeps for each switcher timer.
 *
 *   tracker.seen(key, state, at)     first sight: IDLE / ELAPSED known, RUNNING / PAUSED not
 *   tracker.event(key, kind, at, v)  a pulse (`start`/`pause`/`stop`, `v` its value) or
 *                                    a reported state (`state`, `v` the state)
 *   tracker.elapsed(key, at)         seconds run, or null when unknown
 *   tracker.phase(key)               idle | running | paused | elapsed | unknown
 *
 * Every transition is idempotent, because each arrives twice: the simulator
 * echoes both edges of a pulse twice, and on a real unit a pulse is followed
 * by the state it caused. A Start while paused resumes — an assumption: the
 * vendor's page has one Start button for both, and nothing has shown which.
 */
export function createTracker() {
  const timers = new Map();
  const get = (key) => {
    if (!timers.has(key)) timers.set(key, { phase: 'idle', base: 0, since: 0, last: {} });
    return timers.get(key);
  };
  const start = (t, at) => {
    if (t.phase === 'running' || t.phase === 'unknown') return;
    if (t.phase !== 'paused') t.base = 0;
    t.since = at;
    t.phase = 'running';
  };
  const pause = (t, at) => {
    if (t.phase !== 'running') return;
    t.base += Math.max(0, at - t.since) / 1000;
    t.phase = 'paused';
  };
  const stop = (t) => { t.phase = 'idle'; t.base = 0; t.since = 0; };

  return {
    seen(key, state, at) {
      const t = get(key);
      t.seenState = state;
      if (state === 'RUNNING' || state === 'PAUSED') { t.phase = 'unknown'; t.base = 0; }
      else if (state === 'ELAPSED') t.phase = 'elapsed';
      else stop(t);
    },
    known: (key) => timers.has(key),
    event(key, kind, at, value) {
      const t = get(key);
      if (kind === 'state') {
        if (value === t.seenState) return;
        t.seenState = value;
        if (value === 'RUNNING') {
          /* From unknown, a reported RUNNING still says nothing of when it began. */
          start(t, at);
        } else if (value === 'PAUSED') pause(t, at);
        else if (value === 'IDLE') stop(t);
        else if (value === 'ELAPSED') {
          if (t.phase === 'running') t.base += Math.max(0, at - t.since) / 1000;
          if (t.phase !== 'unknown') t.phase = 'elapsed';
        }
        return;
      }
      /* A pulse acts on its rising edge only. */
      const was = t.last[kind];
      t.last[kind] = value;
      if (value !== true || was === true) return;
      if (kind === 'start') start(t, at);
      else if (kind === 'pause') pause(t, at);
      else if (kind === 'stop') stop(t);
    },
    phase: (key) => get(key).phase,
    elapsed(key, at) {
      const t = get(key);
      if (t.phase === 'unknown') return null;
      return t.base + (t.phase === 'running' ? Math.max(0, at - t.since) / 1000 : 0);
    }
  };
}

/**
 * What a switcher timer reads now: `{ known, text, sub, phase, running }`.
 * `now` is this machine's time in ms; `phase` is green | over | idle | unknown.
 */
export function switcherView(timer, tracker, now, precision = 'seconds') {
  if (!timer) return { known: false, text: '--:--', sub: '', phase: 'unknown', running: false, why: 'no such timer' };
  if (timer.type === 'CURRENT_TIME') {
    const text = formatClock(clockParts(now + timer.timeOffset * 1000), timer.currentTimeMode, precision);
    return { known: true, text, sub: '', phase: 'green', running: true };
  }
  const elapsed = tracker.elapsed(timer.key, now);
  const phase = tracker.phase(timer.key);
  if (elapsed === null) {
    return { known: false, text: precision === 'minutes' ? '--:--' : '--:--:--', sub: '', phase: 'unknown', running: false, why: `${timer.key.replace('TIMER_', 'Timer ')} was already ${phase === 'unknown' ? 'running or paused' : phase} when this page saw it — when it started was never published. Stop it and start it again to time it here.` };
  }
  if (timer.type === 'COUNTDOWN') {
    const left = timer.countdownDuration - elapsed;
    const over = left <= 0 || phase === 'elapsed';
    /* Whole seconds rounded up while there is time left, as a countdown reads. */
    const shown = over ? 0 : (precision === 'minutes' ? Math.ceil(left / 60) * 60 : Math.ceil(left - 1e-9));
    return { known: true, text: formatDuration(shown, timer.unitMode, precision), sub: '', phase: over ? 'over' : 'green', running: phase === 'running' && !over };
  }
  const shown = precision === 'minutes' ? Math.floor(elapsed / 60) * 60 : Math.floor(elapsed);
  return { known: true, text: formatDuration(shown, timer.unitMode, precision), sub: '', phase: phase === 'idle' ? 'idle' : 'green', running: phase === 'running' };
}

/* ============================================================= Stagetimer */

/**
 * A Stagetimer room's current timer, as numbers: `{ has, appearance,
 * remainingMs, elapsedMs, totalMs, running, phase, timerName, timeZone }`.
 * `snap` is the server half's `{ status, current, timers, room, offsetMs }`;
 * `now` is this machine's ms, and `offsetMs` the server's clock minus ours.
 * Ported from bdstage's `TimerAt` (birddog-play-patcher/stagetimer/clock.go),
 * which follows Stagetimer's API v1 docs: the feed carries no running value —
 * it is finish minus now while running, finish minus pause while stopped.
 */
export function stagetimerView(snap, now) {
  const none = { has: false, appearance: '', remainingMs: 0, elapsedMs: 0, totalMs: 0, running: false, phase: 'idle', timerName: '', timeZone: '' };
  if (!snap || !snap.status || !snap.status.timer_id) return none;
  const st = snap.status;
  const timers = Array.isArray(snap.timers) ? snap.timers : [];
  const timer = (snap.current && snap.current._id === st.timer_id) ? snap.current
    : (timers.find((t) => t && t._id === st.timer_id) || null);
  const appearance = String((timer && timer.appearance) || 'COUNTDOWN').toUpperCase();
  const srv = now + (Number(snap.offsetMs) || 0);
  let total = (Number(st.finish) || 0) - (Number(st.start) || 0);
  if (total <= 0) total = timerLength(timer) * 1000;
  let remaining;
  if (st.running) remaining = st.finish - srv;
  else if (st.pause) remaining = st.finish - st.pause;
  else remaining = total;
  if (!st.finish && !st.start) remaining = total;
  const elapsed = total - remaining;
  const yellow = Number(timer && timer.wrap_up_yellow) || 0;
  const red = Number(timer && timer.wrap_up_red) || 0;
  let phase = 'green';
  if (remaining <= 0) phase = 'over';
  else if (red > 0 && remaining <= red * 1000) phase = 'red';
  else if (yellow > 0 && remaining <= yellow * 1000) phase = 'yellow';
  return {
    has: true, appearance, remainingMs: remaining, elapsedMs: Math.max(0, elapsed), totalMs: total,
    running: Boolean(st.running), phase, timerName: String((timer && timer.name) || ''),
    timeZone: String((snap.room && snap.room.timezone) || ''),
    serverNow: srv
  };
}

/** A Stagetimer timer's set length in seconds: `duration` "H:MM:SS", else its h/m/s. */
export function timerLength(t) {
  if (!t) return 0;
  const parts = String(t.duration || '').trim().split(':');
  if (parts.length >= 2 && parts.length <= 3 && parts.every((p) => /^\d+$/.test(p))) {
    const units = [3600, 60, 1].slice(3 - parts.length);
    return parts.reduce((acc, p, i) => acc + Number(p) * units[i], 0);
  }
  return (Number(t.hours) || 0) * 3600 + (Number(t.minutes) || 0) * 60 + (Number(t.seconds) || 0);
}

/** Stagetimer's own countdown text: rounded up while time is left, minus once over. */
export function stagetimerCountdown(ms, precision = 'seconds') {
  if (ms > 0) {
    const secs = precision === 'minutes' ? Math.ceil(ms / 60000) * 60 : Math.ceil(ms / 1000);
    return hms(secs, precision);
  }
  const over = precision === 'minutes' ? Math.floor(-ms / 60000) * 60 : Math.floor(-ms / 1000);
  return over === 0 ? hms(0, precision) : `-${hms(over, precision)}`;
}

/** Stagetimer's count-up text: rounded down. */
export function stagetimerCountUp(ms, precision = 'seconds') {
  const secs = Math.max(0, precision === 'minutes' ? Math.floor(ms / 60000) * 60 : Math.floor(ms / 1000));
  return hms(secs, precision);
}

function hms(secs, precision) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor(secs / 60) % 60;
  const s = secs % 60;
  if (precision === 'minutes') return h > 0 ? `${h}:${pad(m)}` : `${Math.floor(secs / 60)} min`;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** The text a Stagetimer view shows: `{ known, text, sub, phase, running }`. */
export function stagetimerText(view, { precision = 'seconds', h24 = true } = {}) {
  if (!view || !view.has) return { known: false, text: '--:--', sub: '', phase: 'unknown', running: false, why: 'Stagetimer has not said which timer is current yet.' };
  const mode = h24 ? '24H' : '12H_AM_PM';
  const tod = () => formatClock(clockParts(view.serverNow, view.timeZone), mode, precision);
  const todShort = () => formatClock(clockParts(view.serverNow, view.timeZone), mode, 'minutes');
  let text;
  let sub = '';
  switch (view.appearance) {
    case 'COUNTUP': text = stagetimerCountUp(view.elapsedMs, precision); break;
    case 'TOD': text = tod(); break;
    case 'COUNTDOWN_TOD': text = stagetimerCountdown(view.remainingMs, precision); sub = todShort(); break;
    case 'COUNTUP_TOD': text = stagetimerCountUp(view.elapsedMs, precision); sub = todShort(); break;
    case 'HIDDEN': text = ''; break;
    default: text = stagetimerCountdown(view.remainingMs, precision);
  }
  return { known: true, text, sub, phase: view.phase, running: view.running };
}

/* =================================================== the switcher's frames */

const screenKey = (id) => String(id).replace(/^S/, '');
const screenPath = (id, ...tail) => [ROOT, 'screenList', 'items', screenKey(id), ...tail];

/** One property of a Foreground Image's control. */
export const topFramePath = (screen, frame, prop) => screenPath(screen, 'topFrameList', 'items', String(frame), 'control', 'pp', prop);
/** One property of a Foreground Image's status. */
export const topFrameStatusPath = (screen, frame, prop) => screenPath(screen, 'topFrameList', 'items', String(frame), 'status', 'pp', prop);
/** What a preset buffer's top layer shows: `NONE`, `1`..`4` or `QUICK_FRAME`. */
export const presetTopPath = (screen, buffer, ...tail) => screenPath(screen, 'presetList', 'items', buffer, 'top', ...tail);

/** The screens that have Foreground Images. */
export function readScreens(store) {
  const items = store.get([ROOT, 'screenList', 'items']) || {};
  return Object.keys(items)
    .filter((k) => /^\d+$/.test(k) && items[k] && items[k].topFrameList)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => {
      const canvas = pp(items[k].canvas && items[k].canvas.status && items[k].canvas.status.size);
      return { id: `S${k}`, label: String(pp(items[k].control).label || ''), width: Number(canvas.sizeH) || 1920, height: Number(canvas.sizeV) || 1080 };
    });
}

/** A screen's Foreground Images: `[{ index, label, librarySlot, mode, valid, width, height }]`. */
export function readTopFrames(store, screen) {
  const items = (store.get(screenPath(screen, 'topFrameList', 'items')) || {});
  const out = [];
  for (let k = 1; k <= FRAME_COUNT; k++) {
    const node = items[String(k)];
    if (!node) continue;
    const c = pp(node.control);
    const st = pp(node.status);
    out.push({
      index: k,
      label: String(c.label || ''),
      librarySlot: String(c.librarySlot ?? 'NONE'),
      mode: String(c.mode || '1_1'),
      valid: st.isValid === true,
      width: Number(st.width) || 0,
      height: Number(st.height) || 0
    });
  }
  return out;
}

/** The file names this plugin gives a screen's frame, alternating. */
export const ownName = (screen, frame, side) => `lpp-timer-${screen}-FRG${frame}-${side}.png`;
const OWN = /^lpp-timer-(S\d+)-FRG(\d)-([ab])\.png$/;
/** `{ screen, frame, side }` if a file name is one of ours, else null. */
export function ownedBy(fileName) {
  const m = OWN.exec(String(fileName || ''));
  return m ? { screen: m[1], frame: Number(m[2]), side: m[3] } : null;
}

/**
 * What the next picture for `screen`'s Foreground Image `frame` would do:
 *
 *   { ok, problems, frame, current, side, name, predicted, tidy }
 *
 * - `current`: the slot the frame shows now, if it is one of ours for this
 *   frame (else null);
 * - `side`/`name`: the file name the next picture takes — the other side;
 * - `predicted`: the slot the upload will land in;
 * - `tidy`: slots of ours for this frame that no frame points at (a push
 *   that stopped halfway), to empty after the frame has moved.
 *
 * Refused when the frame shows something that is not ours (someone's logo
 * — pick an empty Foreground Image), when the library is full, or when
 * another frame points at the slot the upload would land in.
 */
export function planPush(store, { screen, frame }) {
  const problems = [];
  const frames = readTopFrames(store, screen);
  const f = frames.find((x) => x.index === frame) || null;
  const library = readLibrary(store);
  const bySlot = new Map(library.slots.map((s) => [String(s.slot), s]));
  if (!f) problems.push(`${screen} has no Foreground Image ${frame}.`);
  let current = null;
  let currentSide = null;
  if (f && f.librarySlot !== 'NONE') {
    const held = bySlot.get(f.librarySlot);
    const own = held && !held.free ? ownedBy(held.fileName) : null;
    if (own && own.screen === screen && own.frame === frame) { current = Number(f.librarySlot); currentSide = own.side; }
    else if (held && !held.free) problems.push(`${screen} FRG${frame} shows library slot ${f.librarySlot} (${held.fileName || 'a picture'}), which this app did not put there. Choose an empty Foreground Image.`);
    /* A frame pointing at an empty slot shows nothing, and the next upload
       may land there — which is the frame's own, so that is no harm. */
  }
  const side = currentSide === 'a' ? 'b' : 'a';
  const [predicted] = nextSlots(library, 1);
  if (predicted === undefined) problems.push('The image library is full (50 slots).');
  else {
    const others = framesOn(store, predicted).filter((x) => !(x.list === 'topFrameList' && x.screen === screen && Number(x.index) === frame));
    if (others.length) problems.push(`The next upload lands in empty library slot ${predicted}, which ${others.map((o) => o.name).join(', ')} ${others.length === 1 ? 'points' : 'point'} at — it would show the timer there. Point ${others.length === 1 ? 'it' : 'them'} elsewhere, or fill the slot.`);
  }
  const tidy = library.slots
    .filter((s) => !s.free && s.slot !== current)
    .filter((s) => { const o = ownedBy(s.fileName); return o && o.screen === screen && o.frame === frame; })
    .filter((s) => framesOn(store, s.slot).length === 0)
    .map((s) => s.slot);
  return { ok: problems.length === 0, problems, frame: f, current, side, name: ownName(screen, frame, side), predicted: predicted ?? null, tidy };
}

/** Point a Foreground Image at a slot, 1:1 — the mode written only if it differs. */
export function pointWrites(store, screen, frame, slot) {
  const writes = [];
  if (store.get(topFramePath(screen, frame, 'mode')) !== '1_1') writes.push({ path: topFramePath(screen, frame, 'mode'), value: '1_1' });
  writes.push({ path: topFramePath(screen, frame, 'librarySlot'), value: String(slot) });
  return writes;
}

/** Empty a slot of ours — never one any frame still points at. */
export function deleteWrites(store, slot) {
  if (framesOn(store, slot).length) return [];
  return libraryDeleteWrites(slot);
}

/**
 * The top layer's position for a picture `w`×`h` on a `canvas`, placed by
 * `place` with `margin` pixels from the edges. `posH`/`posV` are the centre
 * of the layer in canvas pixels — the Pulse's own default top layer sits at
 * 960/540 on 1920×1080.
 */
export function placeAt(canvas, w, h, place, margin) {
  const cw = canvas.width;
  const ch = canvas.height;
  const left = margin + w / 2;
  const right = cw - margin - w / 2;
  const top = margin + h / 2;
  const bottom = ch - margin - h / 2;
  const mid = (a, b) => (a + b) / 2;
  const at = {
    'bottom-right': [right, bottom], 'bottom-left': [left, bottom], 'bottom-centre': [cw / 2, bottom],
    'top-right': [right, top], 'top-left': [left, top], 'top-centre': [cw / 2, top],
    centre: [mid(0, cw), mid(0, ch)]
  }[place] || [right, bottom];
  return { posH: Math.round(at[0]), posV: Math.round(at[1]) };
}

/** Show a Foreground Image on a preset buffer's top layer, at a place. */
export function showWrites(screen, buffer, frame, pos) {
  return [
    { path: presetTopPath(screen, buffer, 'source', 'pp', 'frame'), value: String(frame) },
    { path: presetTopPath(screen, buffer, 'position', 'pp', 'posH'), value: pos.posH },
    { path: presetTopPath(screen, buffer, 'position', 'pp', 'posV'), value: pos.posV }
  ];
}

/* ============================================================== drawing */

export const PHASE_COLOURS = { green: null, yellow: '#ffc400', red: '#ff3b30', over: '#ff3b30', idle: null, unknown: '#9aa4b2' };

/** What `render.js` draws: the box, its colours and its lines of text. */
export function drawSpec(style, reading) {
  const colour = (style.phaseColours && PHASE_COLOURS[reading.phase]) || style.colour;
  return {
    width: style.width,
    height: style.height,
    background: style.transparent ? null : style.background,
    colour,
    label: style.label || '',
    text: String(reading.text ?? ''),
    sub: String(reading.sub || '')
  };
}

/** What changes the picture: two readings that draw alike need no new upload. */
export const pictureKey = (spec) => JSON.stringify([spec.width, spec.height, spec.background, spec.colour, spec.label, spec.text, spec.sub]);

/* ============================================================== timings */

/** A rolling record of how long each push took, for the panel and for hardware day. */
export function createTimings(limit = 30) {
  const runs = [];
  return {
    add(run) { runs.push(run); if (runs.length > limit) runs.shift(); },
    summary() {
      if (!runs.length) return null;
      const ok = runs.filter((r) => r.ok);
      const totals = ok.map((r) => r.total).sort((a, b) => a - b);
      const at = (q) => totals[Math.min(totals.length - 1, Math.floor(q * totals.length))];
      const mean = (k) => (ok.length ? Math.round(ok.reduce((a, r) => a + (r[k] || 0), 0) / ok.length) : 0);
      return {
        count: runs.length,
        failed: runs.length - ok.length,
        median: totals.length ? at(0.5) : null,
        p90: totals.length ? at(0.9) : null,
        upload: mean('upload'),
        point: mean('point'),
        remove: mean('remove'),
        last: runs[runs.length - 1]
      };
    },
    clear() { runs.length = 0; }
  };
}
