/*
 * Speed Editor — a DaVinci Resolve Speed Editor driving the switcher, over
 * WebHID from the page itself.
 *
 * The sibling of MIDI Mapping, and built the same way: this file owns no
 * engine. The panel's protocol (the handshake, the reports) and the adapter
 * that turns reports into control events are awj-surface's `core/hid/`,
 * vendored under `src/vendor/surface/hid/`; mapping, pickup and feedback are
 * the same Engine the MIDI panel runs. What is here is the transport: WebHID,
 * the handshake's lease, and reconnecting when the panel comes back.
 *
 * ## Three things WebHID makes this do
 *
 * - **Choosing the panel needs a click.** `navigator.hid.requestDevice` only
 *   runs from a user gesture. After that the browser remembers the grant, so
 *   `getDevices()` finds it again on the next load and on every plug-in.
 * - **It is a secure-context API**, like Web MIDI, and served from loopback
 *   this page is one. Only Chromium browsers have it at all.
 * - **Report IDs travel separately.** An `inputreport` event carries the ID
 *   beside the data; the vendored decoder wants it as byte 0, so it is put
 *   back. `receiveFeatureReport` returns it in byte 0 on some platforms and
 *   not on others, so that is normalised too.
 *
 * ## The lease
 *
 * The panel is silent until the host answers its challenge, and goes silent
 * again when the answer lapses — `authenticate` says how many seconds that
 * is. It is redone at half that, as node-blackmagic-controller does, with a
 * short retry if one attempt fails.
 */

import { h, button } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import { Engine } from '../../src/vendor/surface/engine.js';
import { validate } from '../../src/vendor/surface/profile.js';
import { SpeedEditorSurface } from '../../src/vendor/surface/hid/surface.js';
import { VENDOR_ID, PRODUCT_ID, authenticate } from '../../src/vendor/surface/hid/speed-editor.js';
import { insecureContextAdvice } from '../../src/core/secure-context.js';

const PROFILE_URL = '/__lpp/src/vendor/surface/profiles/speed-editor.json';
const FILTERS = [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }];
const ACTIVITY_MAX = 40;
const RETRY_S = 15;

const hid = () => (typeof navigator !== 'undefined' ? navigator.hid : undefined);

export function createSpeedEditorPanel({ session, onRefresh = () => {} }) {
  const state = {
    support: !!hid(),
    secure: typeof window !== 'undefined' ? window.isSecureContext : false,
    device: null,
    authed: false,
    lease: null,
    authTimer: null,
    error: null,
    profile: null,
    engine: null,
    surface: null,
    selection: null,
    activity: [],
    writes: 0,
    unsub: null,
    watching: false
  };

  function log(kind, text) {
    state.activity.unshift({ at: Date.now(), kind, text });
    if (state.activity.length > ACTIVITY_MAX) state.activity.length = ACTIVITY_MAX;
  }

  /* ------------------------------------------------------------ device */

  /** The device as the vendored protocol code wants it: bytes with the ID first. */
  const io = (device) => ({
    sendFeature: (bytes) => device.sendFeatureReport(bytes[0], bytes.subarray(1)),
    getFeature: async (id, length) => {
      const view = await device.receiveFeatureReport(id);
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      if (bytes.length >= length && bytes[0] === id) return bytes;
      const out = new Uint8Array(bytes.length + 1);
      out[0] = id;
      out.set(bytes, 1);
      return out;
    }
  });

  const sendReport = (bytes) => {
    const device = state.device;
    if (!device?.opened) return;
    device.sendReport(bytes[0], bytes.subarray(1)).catch(() => { /* unplugged mid-write */ });
  };

  /** Ask the browser for the panel. Must run from a click. */
  async function choose() {
    state.error = null;
    if (!state.support) {
      state.error = state.secure
        ? 'This browser has no WebHID. Use Chrome or Edge.'
        : insecureContextAdvice(window.location);
      return onRefresh();
    }
    try {
      const [device] = await hid().requestDevice({ filters: FILTERS });
      if (!device) return onRefresh();      // the chooser was dismissed
      await open(device);
    } catch (err) {
      state.error = `Could not choose the panel: ${err.message}`;
      onRefresh();
    }
  }

  /** Reopen a panel the browser already has permission for, if one is here. */
  async function reconnect() {
    if (!state.support || state.device) return;
    try {
      const devices = await hid().getDevices();
      const device = devices.find((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
      if (device) await open(device);
    } catch { /* nothing granted yet */ }
  }

  function watch() {
    if (state.watching || !state.support) return;
    state.watching = true;
    hid().addEventListener('connect', (ev) => {
      if (ev.device.vendorId === VENDOR_ID && ev.device.productId === PRODUCT_ID) {
        log('info', 'panel plugged in');
        if (!state.device) open(ev.device);
      }
    });
    hid().addEventListener('disconnect', (ev) => {
      if (ev.device !== state.device) return;
      log('warn', 'panel unplugged');
      drop();
      onRefresh();
    });
  }

  async function open(device) {
    try {
      if (!device.opened) await device.open();
    } catch (err) {
      state.error = `Could not open the panel: ${err.message}. Is DaVinci Resolve running? Quit it and try again.`;
      return onRefresh();
    }
    state.device = device;
    device.addEventListener('inputreport', onReport);
    log('info', `opened ${device.productName || 'Speed Editor'}`);
    await auth();
  }

  async function auth(attempt = 1) {
    clearTimeout(state.authTimer);
    if (!state.device) return;
    try {
      state.lease = await authenticate(io(state.device));
      if (!state.authed) log('info', `authenticated (lease ${state.lease}s)`);
      state.authed = true;
      state.error = null;
      state.surface?.reset();
      state.engine && refreshFeedback();
      state.authTimer = setTimeout(() => auth(), (state.lease || 600) * 500);
    } catch (err) {
      state.authed = false;
      log('warn', `authentication failed: ${err.message}`);
      if (attempt < 3) state.authTimer = setTimeout(() => auth(attempt + 1), RETRY_S * 1000);
      else state.error = 'The panel would not authenticate. Unplug it, plug it back in, and choose it again.';
    }
    onRefresh();
  }

  function drop() {
    clearTimeout(state.authTimer);
    if (state.device) {
      state.device.removeEventListener('inputreport', onReport);
      state.device.close().catch(() => {});
    }
    state.device = null;
    state.authed = false;
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

    if (state.authed) state.surface.reset();
    refreshFeedback();
    log('info', 'running');
    onRefresh();
  }

  function refreshFeedback() {
    try { state.engine.refresh(); } catch { /* nothing to show yet */ }
  }

  function stop() {
    if (state.unsub) { state.unsub(); state.unsub = null; }
    if (state.surface && state.authed) state.surface.reset();   // lamps out
    state.engine = null;
    state.surface = null;
  }

  function onReport(ev) {
    const bytes = new Uint8Array(ev.data.byteLength + 1);
    bytes[0] = ev.reportId;
    bytes.set(new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength), 1);
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

  /* ------------------------------------------------------------ render */

  function render() {
    watch();
    const running = !!state.engine;
    const body = h('div', { class: 'aw-flex-col aw-gap-row-large' },
      contextNotice(),
      state.error ? h('div', { class: 'wru-tag wru-warn', text: state.error }) : null,
      deviceSection(),
      running ? selectionSection() : null,
      activitySection());
    return panel({ toolbar: toolbar(running), body });
  }

  function contextNotice() {
    if (state.support && state.secure) return null;
    return h('div', { class: 'wru-tag wru-warn' },
      h('span', {
        text: state.secure
          ? 'This browser has no WebHID. The Speed Editor needs Chrome or Edge.'
          : insecureContextAdvice(window.location)
      }));
  }

  function deviceSection() {
    const battery = state.surface?.battery;
    const status = !state.device
      ? 'No panel connected.'
      : state.authed
        ? `${state.device.productName || 'Speed Editor'} — connected${battery ? `, battery ${battery.level}%${battery.charging ? ' (charging)' : ''}` : ''}.`
        : `${state.device.productName || 'Speed Editor'} — waiting for the handshake…`;
    return h('div', { class: 'aw-flex-col aw-gap-row-medium' },
      h('div', { class: 'aw-font-subtitle-1', text: 'Panel' }),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium' },
        h('span', { class: 'aw-text-secondary', text: status }),
        state.device ? null : button('Choose panel…', { onClick: choose, variant: 'primary', disabled: !state.support })),
      h('div', { class: 'aw-text-tertiary aw-font-caption',
        text: 'USB or Bluetooth. Quit DaVinci Resolve first — both would hear every key. ' +
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
        : h('div', { class: 'wru-empty', text: 'Nothing yet. Choose the panel, then Start.' }));
  }

  function toolbar(running) {
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium' },
      h('div', { class: 'aw-font-subtitle-1', text: 'Speed Editor' }),
      h('span', { class: ['wru-tag', running ? '' : 'wru-warn'], text: running ? 'running' : 'stopped' }),
      running ? h('span', { class: 'wru-tag', text: `${state.writes} write${state.writes === 1 ? '' : 's'}` }) : null,
      h('div', { style: { flex: '1' } }),
      running
        ? button('Stop', { onClick: () => { stop(); onRefresh(); }, variant: 'ghost' })
        : button('Start', { onClick: start, variant: 'primary' }));
  }

  reconnect();
  return { render, state, choose, start, stop, onReport };
}
