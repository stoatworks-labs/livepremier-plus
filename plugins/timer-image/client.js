/*
 * Timer Image — the plugin's page half.
 *
 * PLUS ▸ Timer Image: pick a screen and one of its Foreground Images, a
 * source (a switcher timer, or Stagetimer), and how it looks; Start, and the
 * runner page keeps that Foreground Image showing the time. Put it on air
 * the way a logo goes on — the preset's top layer, then a take — and
 * "Show on preview" does the first half.
 *
 * The loop runs on the server's tick (`server.js`), never a timer of this
 * page's: one event a second, which says whether this page is the runner.
 * On each tick the runner reads the time, and when the picture would differ
 * from the last one pushed, and no push is in flight, draws and pushes it. A
 * push that takes longer than a second is not queued behind: the next tick
 * draws whatever the time is then, so a slow switcher shows a picture that
 * updates less often, never one that falls behind.
 *
 * The switcher's timers are timed here (`core.createTracker`) from the
 * switcher's own frames — every page keeps its tracker, so a page that
 * becomes the runner has seen what the old one saw, as long as it was open.
 */

import {
  normalise, readScreens, readTopFrames, readTimer, timerEvent, createTracker, switcherView, stagetimerText,
  drawSpec, pictureKey, createTimings, planPush, placeAt, showWrites, TIMER_KEYS
} from './core.js';
import { renderPng } from './render.js';
import { pushPicture, removePicture } from './apply.js';
import { createTimerPanel } from './panel.js';
import { presetBanks } from '../../src/core/screens.js';
import { send, sendAndEcho } from '../../src/core/wire.js';
import { ROOT } from '../../src/core/paths.js';

const PAGE_ID = `p${Math.random().toString(36).slice(2, 10)}`;
/* After this many pushes fail in a row the runner stops, rather than
   hammer a switcher that keeps saying no. */
const FAILS_TO_STOP = 3;

export default function activate(ctx) {
  const session = ctx.session;
  const store = session.store;
  let doc = normalise(null);
  let tick = null;
  let offset = 0;
  let stagetimer = null;
  let busyText = null;
  const tracker = createTracker();
  const timings = createTimings();
  const run = { busy: false, pending: false, lastKey: null, lastText: null, fails: 0, error: null, skipped: 0, slot: null, screen: null, frame: null, message: null };

  const serverNow = () => Date.now() + offset;

  /* ------------------------------------------------------------ documents */

  async function load() {
    try {
      const res = await fetch(ctx.url('/'), { cache: 'no-store' });
      if (res.ok) doc = normalise((await res.json()).data);
    } catch (err) {
      ctx.log.warn('could not load the Timer Image settings', err);
    }
    await loadStagetimer();
  }

  async function save() {
    try {
      await fetch(ctx.url('/'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: doc }) });
    } catch (err) {
      ctx.log.warn('could not save the Timer Image settings', err);
    }
  }

  async function loadStagetimer() {
    try {
      const res = await fetch(ctx.url('/stagetimer'), { cache: 'no-store' });
      if (res.ok) stagetimer = await res.json();
    } catch { /* the card says so */ }
  }

  const change = (next) => {
    doc = normalise(next);
    run.lastKey = null;
    void save();
    ctx.refresh();
  };

  /* -------------------------------------------------------------- timers */

  let seenOnce = false;
  function seeTimers() {
    if (seenOnce || !store.ready) return;
    seenOnce = true;
    for (const key of TIMER_KEYS) {
      const t = readTimer(store, key);
      if (t) tracker.seen(key, t.state, serverNow());
    }
  }
  if (store.ready) seeTimers();
  store.addEventListener?.('ready', () => { seeTimers(); ctx.refresh(); });

  session.addEventListener('frame', (ev) => {
    const f = ev && ev.detail;
    /* The switcher's own frames only: a pulse this page sent counts when it
       comes back, exactly as one from the vendor's page does. */
    if (!f || f.dir !== 'in' || !Array.isArray(f.path)) return;
    const e = timerEvent(f.path);
    if (!e) return;
    seeTimers();
    tracker.event(e.key, e.kind, serverNow(), f.value);
  });

  /** What the chosen source reads now: `{ known, text, sub, phase, running, why? }`. */
  function reading(at = serverNow()) {
    if (doc.source === 'stagetimer') {
      const st = tick && tick.stagetimer;
      if (!st) return { known: false, text: '--:--', sub: '', phase: 'unknown', running: false, why: 'Stagetimer is off. Set a room and switch it on below.' };
      if (st.link && st.link.state !== 'live' && st.link.state !== 'polling' && !st.view.has) {
        return { known: false, text: '--:--', sub: '', phase: 'unknown', running: false, why: st.link.error || `Stagetimer: ${st.link.state}` };
      }
      return stagetimerText(st.view, { precision: doc.precision });
    }
    if (!store.ready) return { known: false, text: '--:--', sub: '', phase: 'unknown', running: false, why: 'Waiting for the switcher.' };
    return switcherView(readTimer(store, doc.timer), tracker, at, doc.precision);
  }

  /* ---------------------------------------------------------------- push */

  const isRunner = () => Boolean(tick && tick.runner === PAGE_ID);
  const running = () => Boolean(tick && tick.running);

  async function report(extra = {}) {
    if (!isRunner()) return;
    const summary = timings.summary();
    try {
      await fetch(ctx.url('/report'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page: PAGE_ID,
          report: { text: run.lastText, slot: run.slot, error: run.error, message: run.message, skipped: run.skipped, timings: summary, screen: run.screen, frame: run.frame },
          ...extra
        })
      });
    } catch { /* the next tick tries again */ }
  }

  async function maybePush() {
    if (!running() || !isRunner() || !store.ready) return;
    /* The time now, not the tick's: a tick held behind a push is read when
       the push is done, as whatever second it is by then. */
    const r = reading(serverNow());
    const spec = drawSpec(doc.style, r);
    const key = pictureKey(spec) + `|${doc.screen}|${doc.frame}`;
    if (key === run.lastKey) return;
    if (run.busy) { run.skipped += 1; run.pending = true; return; }
    run.busy = true;
    run.pending = false;
    busyText = r.text;
    try {
      const blob = await renderPng(spec);
      const res = await pushPicture({ session, screen: doc.screen, frame: doc.frame, blob });
      timings.add({ ok: res.ok, upload: res.upload, point: res.point, remove: res.remove, total: res.total, at: Date.now(), bytes: blob.size, text: r.text });
      if (res.ok) {
        run.lastKey = key;
        run.lastText = r.text;
        run.slot = res.slot;
        run.screen = doc.screen;
        run.frame = doc.frame;
        run.fails = 0;
        run.error = null;
        run.message = res.resampled ? `The switcher answered ${res.status}: it resampled the picture.` : null;
      } else {
        run.fails += 1;
        run.error = res.error;
      }
    } catch (err) {
      run.fails += 1;
      run.error = err.message;
    } finally {
      run.busy = false;
      busyText = null;
    }
    const stop = run.fails >= FAILS_TO_STOP;
    if (stop) run.error = `Stopped after ${FAILS_TO_STOP} failed pushes in a row: ${run.error}`;
    await report(stop ? { stop: true } : {});
    ctx.refresh();
    /* A tick came while this push was going: catch up now rather than wait
       for the next one. */
    if (run.pending && !stop) { run.pending = false; void maybePush(); }
  }

  /* ---------------------------------------------------------------- tick */

  let source = null;
  function listen() {
    if (source) return;
    source = new EventSource(ctx.url(`/stream?page=${PAGE_ID}`));
    source.addEventListener('tick', (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      const wasRunning = running();
      tick = data;
      offset = data.now - Date.now();
      if (data.stagetimer && data.stagetimer.link) stagetimer = { ...(stagetimer || {}), ...data.stagetimer.link };
      if (!data.running && wasRunning) { run.lastKey = null; }
      void maybePush();
      ctx.refresh();
    });
    source.addEventListener('error', () => { /* EventSource reconnects by itself */ });
  }
  listen();

  /* ------------------------------------------------------------- actions */

  const pulse = (key, prop) => {
    const path = [ROOT, 'timerList', 'items', key, 'control', 'pp', prop];
    send(session, [{ path, value: false }, { path, value: true }]);
  };

  const actions = {
    async start() {
      run.error = null; run.fails = 0; run.skipped = 0; run.lastKey = null; run.message = null;
      timings.clear();
      const plan = planPush(store, { screen: doc.screen, frame: doc.frame });
      if (!plan.ok) { run.error = plan.problems[0]; ctx.refresh(); return; }
      await fetch(ctx.url('/run'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) });
    },
    async stop() {
      await fetch(ctx.url('/run'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) });
    },
    async remove() {
      if (running()) return;
      run.busy = true;
      ctx.refresh();
      const res = await removePicture({ session, screen: doc.screen, frame: doc.frame });
      run.busy = false;
      run.error = res.ok ? null : res.error;
      run.message = res.ok ? `${doc.screen} FRG${doc.frame} is empty again${res.emptied.length ? `, and library slot${res.emptied.length === 1 ? '' : 's'} ${res.emptied.join(', ')} with it` : ''}.` : null;
      run.lastKey = null;
      ctx.refresh();
    },
    async showOnPreview() {
      const screen = readScreens(store).find((s) => s.id === doc.screen);
      const bank = presetBanks(store, doc.screen);
      if (!screen || !bank.reported || !bank.settled) { run.error = `${doc.screen} is mid-take or not reported yet — try again when it has landed`; ctx.refresh(); return; }
      const pos = placeAt(screen, doc.style.width, doc.style.height, doc.place, doc.margin);
      const ok = await sendAndEcho(session, showWrites(doc.screen, bank.preview, doc.frame, pos), { inbound: true });
      run.error = ok ? null : `The switcher did not take ${doc.screen}'s preview top layer`;
      run.message = ok ? `${doc.screen} preview: top layer shows FRG${doc.frame} at ${pos.posH}, ${pos.posV}. Take to put it on air.` : null;
      ctx.refresh();
    },
    timer: (prop) => pulse(doc.timer, prop),
    async saveStagetimer(patch) {
      const res = await fetch(ctx.url('/stagetimer'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (res.ok) stagetimer = await res.json();
      ctx.refresh();
    },
    async testStagetimer() {
      const res = await fetch(ctx.url('/stagetimer/test'), { method: 'POST' });
      const out = res.ok ? await res.json() : { ok: false, error: `HTTP ${res.status}` };
      stagetimer = { ...(stagetimer || {}), test: out.ok ? 'The room and key are good.' : out.error };
      ctx.refresh();
    }
  };

  const view = createTimerPanel({
    ready: () => Boolean(store.ready),
    doc: () => doc,
    change,
    screens: () => (store.ready ? readScreens(store) : []),
    frames: (screen) => (store.ready ? readTopFrames(store, screen) : []),
    timers: () => TIMER_KEYS.map((k) => readTimer(store, k)).filter(Boolean),
    plan: () => (store.ready ? planPush(store, { screen: doc.screen, frame: doc.frame }) : null),
    reading,
    spec: () => drawSpec(doc.style, reading()),
    status: () => ({
      running: running(),
      runner: isRunner(),
      connected: Boolean(tick),
      busy: run.busy,
      busyText,
      local: { error: run.error, message: run.message, text: run.lastText, slot: run.slot, screen: run.screen, frame: run.frame, skipped: run.skipped, timings: timings.summary() },
      report: tick && tick.report
    }),
    stagetimer: () => stagetimer,
    actions
  });

  ctx.ui.sidebar({
    id: 'timer-image',
    label: 'Timer Image',
    icon: ['timer-18', 'clock-18', 'stills-18'],
    order: 62,
    render: () => view.render(),
    busy: () => view.busy()
  });

  void load().then(() => ctx.refresh());
}
