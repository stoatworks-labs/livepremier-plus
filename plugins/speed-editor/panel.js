/*
 * Speed Editor — a DaVinci Resolve Speed Editor driving the switcher. The
 * panel is held by the server (`link.js`, and why); this is the page half.
 *
 * The sibling of MIDI Mapping, and built the same way: mapping, pickup and
 * feedback are the same Engine the MIDI panel runs, and the adapter that
 * turns the panel's reports into control events is awj-surface's `core/hid/`,
 * vendored under `src/vendor/surface/hid/`. What is here is the page's side of
 * the transport: the server's `/stream` brings the input reports and the
 * panel's state, `/output` takes the lamps, and `/driver` is the lease that
 * says which page acts — see `server.js`.
 *
 * Because the page never touches the panel, none of WebHID's conditions
 * apply: any browser, any address, no choosing the panel. The panel has to be
 * plugged into the machine this app runs on.
 *
 * The stream is held only while the Speed Editor is started. A page has six
 * connections to its origin and the vendor's own app uses some of them; a
 * stream for a panel nobody started would be one fewer for everybody else.
 * Stopped, the panel's state is fetched when the panel is looked at.
 */

import { h, button } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import { Engine } from '../../src/vendor/surface/engine.js';
import { validate } from '../../src/vendor/surface/profile.js';
import { SpeedEditorSurface } from '../../src/vendor/surface/hid/surface.js';

const PROFILE_URL = '/__lpp/src/vendor/surface/profiles/speed-editor.json';
const ACTIVITY_MAX = 40;
const BEAT_MS = 4000;
const POLL_MS = 3000;

const newId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `p${Math.random().toString(36).slice(2)}`);

function fromBase64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * @param o.session    the page's live session: `store`, `send`
 * @param o.url        fn(path) -> this plugin's route, `ctx.url`
 * @param o.onRefresh  ask the shell to repaint
 */
export function createSpeedEditorPanel({ session, url, onRefresh = () => {} }) {
  const state = {
    pageId: newId(),
    server: null,     // the server's snapshot: available, connected, authed, battery, driver, …
    error: null,
    profile: null,
    engine: null,
    surface: null,
    selection: null,
    activity: [],
    writes: 0,
    unsub: null,
    stream: null,
    beating: null,
    polledAt: 0,
    handshakes: null,
  };

  function log(kind, text) {
    state.activity.unshift({ at: Date.now(), kind, text });
    if (state.activity.length > ACTIVITY_MAX) state.activity.length = ACTIVITY_MAX;
  }

  const driving = () => !!state.server && state.server.driver === state.pageId;
  const running = () => !!state.engine;

  /* ------------------------------------------------------------ server */

  async function poll() {
    state.polledAt = Date.now();
    try {
      const res = await fetch(url('/'), { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      absorb(await res.json());
      state.error = null;
    } catch (err) {
      state.error = `Could not reach LivePremier Plus: ${err.message}`;
    }
    onRefresh();
  }

  /** A new snapshot of the panel from the server. */
  function absorb(next) {
    const was = state.server;
    const wasDriving = driving();
    state.server = next;
    if (was && was.present !== next.present) {
      log(next.present ? 'info' : 'warn', next.present ? `${next.product || 'panel'} plugged in` : 'panel unplugged');
    }
    if (was && next.authed && !was.authed) log('info', `authenticated (lease ${next.lease}s)`);
    if (next.error && next.error !== was?.error) log('warn', next.error);
    if (!running()) return;
    if (driving() && !wasDriving) log('info', 'driving the panel from this page');
    if (!driving() && wasDriving) log('warn', next.driver ? 'another page took the panel over' : 'no longer driving the panel');
    /* A fresh handshake, or just becoming the driver: the panel's lamps and
       wheel mode are whatever somebody last left them, so set them again. */
    const reauthed = next.authed && next.handshakes !== state.handshakes;
    state.handshakes = next.handshakes;
    if (driving() && next.authed && (reauthed || !wasDriving)) {
      state.surface?.reset();
      refreshFeedback();
    }
  }

  function listen() {
    if (state.stream) return;
    try {
      const stream = new EventSource(url('/stream'));
      stream.addEventListener('state', (ev) => {
        try { absorb(JSON.parse(ev.data)); } catch { return; }
        onRefresh();
      });
      stream.addEventListener('report', (ev) => {
        if (!driving()) return;
        let bytes;
        try { bytes = fromBase64(ev.data); } catch { return; }
        onReport(bytes);
      });
      state.stream = stream;
    } catch (err) {
      state.error = `Could not listen to the panel: ${err.message}`;
    }
  }

  async function beat({ release = false, take = false } = {}) {
    try {
      const res = await fetch(url('/driver'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.pageId, release, take }), keepalive: release,
      });
      if (!res.ok) return;
      const { driver } = await res.json();
      if (state.server && (state.server.driver !== driver || release)) absorb({ ...state.server, driver });
      onRefresh();
    } catch { /* the next beat tries again */ }
  }

  /* The lamps, batched: one render can light several at once. */
  let outbox = [];
  let flushing = null;
  function sendReport(bytes) {
    if (!driving()) return;
    outbox.push([...bytes]);
    if (!flushing) flushing = Promise.resolve().then(flush);
  }
  async function flush() {
    const reports = outbox.splice(0, 16);
    try {
      if (reports.length) {
        await fetch(url('/output'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: state.pageId, reports }),
        });
      }
    } catch { /* feedback is best-effort */ }
    flushing = outbox.length ? Promise.resolve().then(flush) : null;
  }

  /* ------------------------------------------------------------ engine */

  async function start() {
    stop();
    state.error = null;
    try {
      const res = await fetch(PROFILE_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.profile = await res.json();
    } catch (err) {
      state.error = 'Could not load the Speed Editor profile: ' + err.message;
      return onRefresh();
    }
    const problems = validate(state.profile);
    if (problems.length) log('warn', `profile: ${problems.length} problem${problems.length === 1 ? '' : 's'}`);

    state.surface = new SpeedEditorSurface(state.profile, sendReport);
    state.engine = new Engine(session.store, state.profile, {});
    state.selection = { ...state.engine.selection };

    state.engine.addEventListener('write', (ev) => {
      for (const w of ev.detail.writes || []) {
        if (session.send({ path: w.path, value: w.value })) state.writes++;
      }
      onRefresh();
    });
    state.engine.addEventListener('feedback', (ev) => {
      try { state.surface?.render(ev.detail); } catch { /* feedback is best-effort */ }
    });
    state.engine.addEventListener('selection', (ev) => {
      state.selection = ev.detail.selection;
      onRefresh();
    });
    state.engine.addEventListener('unresolved', (ev) => log('warn', `unresolved: ${ev.detail.reason}`));

    state.unsub = session.store.subscribe([], ({ path }) => {
      try { state.engine.deviceChanged(path); } catch { /* ignore */ }
    }, { immediate: false });

    state.handshakes = null;
    listen();
    /* The lease is judged against a snapshot, so have one before claiming it. */
    if (!state.server) await poll();
    await beat();
    state.beating = setInterval(() => beat(), BEAT_MS);
    log('info', 'running');
    onRefresh();
  }

  function refreshFeedback() {
    try { state.engine?.refresh(); } catch { /* nothing to show yet */ }
  }

  function stop() {
    if (state.unsub) { state.unsub(); state.unsub = null; }
    if (state.surface && driving() && state.server?.authed) state.surface.reset();   // lamps out
    clearInterval(state.beating);
    state.beating = null;
    if (state.stream) { state.stream.close(); state.stream = null; }
    if (driving()) void beat({ release: true });
    state.engine = null;
    state.surface = null;
  }

  function onReport(bytes) {
    if (!state.surface) return;
    let events;
    try { events = state.surface.handle(bytes); } catch { return; }
    for (const event of events) {
      if (event.kind === 'unmapped') {
        log('unmapped', `${event.control} — nothing bound`);
        continue;
      }
      try { state.engine.input(event); } catch (err) { log('warn', err.message); }
      log('in', `${event.control} ${event.kind === 'relative' ? (event.delta > 0 ? '+' : '') + event.delta : event.down ? 'down' : 'up'}`);
    }
    if (events.length) onRefresh();
  }

  globalThis.addEventListener?.('pagehide', () => { if (driving()) void beat({ release: true }); });

  /* ------------------------------------------------------------ render */

  function render() {
    if (!running() && Date.now() - state.polledAt > POLL_MS) void poll();
    const body = h('div', { class: 'aw-flex-col aw-gap-row-large' },
      state.error ? h('div', { class: 'wru-tag wru-warn', text: state.error }) : null,
      state.server && !state.server.available ? h('div', { class: 'wru-tag wru-warn', text: state.server.reason }) : null,
      deviceSection(),
      running() ? selectionSection() : null,
      activitySection());
    return panel({ toolbar: toolbar(), body });
  }

  function deviceSection() {
    const s = state.server;
    const name = s?.product || 'Speed Editor';
    const battery = s?.battery;
    const status = !s
      ? 'Asking LivePremier Plus…'
      : !s.available
        ? 'Not available in this build.'
        : !s.connected && !s.present
          ? 'No panel. Plug it into this machine by USB, or pair it over Bluetooth.'
          : !s.connected
            ? (running() && driving() ? `${name} — opening…` : `${name} — found. Press Start to use it.`)
          : s.authed
            ? `${name} — connected${battery ? `, battery ${battery.level}%${battery.charging ? ' (charging)' : ''}` : ''}.`
            : `${name} — waiting for the handshake…`;
    const elsewhere = running() && s?.driver && s.driver !== state.pageId;
    return h('div', { class: 'aw-flex-col aw-gap-row-medium' },
      h('div', { class: 'aw-font-subtitle-1', text: 'Panel' }),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium' },
        h('span', { class: 'aw-text-secondary', text: status }),
        elsewhere ? h('span', { class: 'wru-tag wru-warn', text: 'Another page is driving it' }) : null,
        elsewhere ? button('Take over', { onClick: () => beat({ take: true }), variant: 'primary' }) : null),
      h('div', { class: 'aw-text-tertiary aw-font-caption',
        text: 'Plugged into the machine LivePremier Plus runs on. Quit DaVinci Resolve first — both would hear every key. ' +
          'CAM 1–9 put a live input on the selected layer; CUT cuts; DIS and STOP/PLAY take; ' +
          'the eight keys top left select layers 1–8; TRANS flips preview/program; SNAP is shift. ' +
          'JOG / SHTL / SCRL set what the wheel moves: opacity, position H, position V — shifted, T-bar, size H, size V.' }));
  }

  function selectionSection() {
    const s = state.selection ?? {};
    const tag = (text, warn) => h('span', { class: ['wru-tag', warn ? 'wru-warn' : ''], text });
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium' },
      h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'Driving' }),
      tag(`Screen ${String(s.screen ?? '').replace(/^S/, '')}`),
      tag(`Layer ${s.layer}`),
      tag(s.preset === 'PROGRAM' ? 'PROGRAM' : 'Preview', s.preset === 'PROGRAM'),
      s.shift ? tag('SHIFT', true) : null);
  }

  function activitySection() {
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Activity' }),
      state.activity.length
        ? h('div', { class: 'wru-console-log aw-flex-col' }, state.activity.map((a) =>
          h('div', { class: ['wru-console-row', a.kind === 'warn' || a.kind === 'unmapped' ? 'wru-console-warn' : 'wru-console-ok'] },
            h('code', { class: 'wru-console-cmd', text: a.kind }),
            h('span', { class: 'wru-console-detail aw-text-secondary', text: a.text }))))
        : h('div', { class: 'wru-empty', text: 'Nothing yet. Press Start.' }));
  }

  function toolbar() {
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium' },
      h('div', { class: 'aw-font-subtitle-1', text: 'Speed Editor' }),
      h('span', { class: ['wru-tag', running() ? '' : 'wru-warn'], text: running() ? 'running' : 'stopped' }),
      running() ? h('span', { class: 'wru-tag', text: `${state.writes} write${state.writes === 1 ? '' : 's'}` }) : null,
      h('div', { style: { flex: '1' } }),
      running()
        ? button('Stop', { onClick: () => { stop(); onRefresh(); }, variant: 'ghost' })
        : button('Start', { onClick: start, variant: 'primary', disabled: state.server?.available === false }));
  }

  return { render, state, start, stop, onReport, poll };
}
