/*
 * MIDI Mapping — a control surface driving the switcher, from the page itself.
 *
 * Lives under Virtual RC400T, next to the vendor's own remote-panel emulation,
 * because that is where an operator goes to think about control surfaces.
 *
 * ## Why this can be a plain panel now
 *
 * `navigator.requestMIDIAccess()` is a **secure-context** API. When this
 * project was a Chrome extension the page was a Web RCS on a plain-HTTP LAN
 * address, which is not a secure context — and a content script inherits the
 * page's context, so neither world could use it. The answer then was an
 * offscreen document on the `chrome-extension://` origin, relaying MIDI
 * through a service worker to the page. There is a whole `hosts/extension/`
 * directory upstream implementing exactly that.
 *
 * None of it is needed here. The proxy serves the vendor UI from
 * `http://127.0.0.1:<port>`, and loopback **is** a potentially-trustworthy
 * origin, so this page is a secure context and Web MIDI is simply available.
 * Verified rather than assumed: `window.isSecureContext === true` and
 * `navigator.requestMIDIAccess` is present on the served origin.
 *
 * It also fixes the SysEx wrinkle. An offscreen document is invisible and so
 * cannot show a permission prompt, which meant `{sysex:true}` had to be
 * granted from a separate visible page. A normal page just prompts — so
 * Mackie scribble strips are reachable without ceremony.
 *
 * ## This file owns no engine
 *
 * Decoding, pickup, feedback and the parameter catalogue all come from
 * `../vendor/surface/`, which is awj-surface's own core. This is a front-end:
 * it opens ports, hands bytes to the surface, hands events to the engine, and
 * puts the engine's writes on the session. If a fader does the wrong thing,
 * the fix is upstream.
 */

import { h, button } from './dom.js';
import { panel } from './shell.js';
import { Engine } from '../vendor/surface/engine.js';
import { MidiSurface } from '../vendor/surface/surface.js';
import { validate } from '../vendor/surface/profile.js';

const PROFILE_BASE = '/__lpp/src/vendor/surface/profiles/';
const STOCK = [
  { file: 'generic-learn.json', label: 'Generic (learn as you go)' },
  { file: 'x-touch-mcu.json', label: 'Behringer X-Touch (Mackie)' },
  { file: 'apc40.json', label: 'Akai APC40' },
  { file: 'midicon-2.json', label: 'JLCooper MIDIcon 2' },
  { file: 'midicon-pro.json', label: 'JLCooper MIDIcon Pro' }
];
const ACTIVITY_MAX = 40;

export function createMidiPanel({ session, onRefresh = () => {} }) {
  const state = {
    support: typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function',
    secure: typeof window !== 'undefined' ? window.isSecureContext : false,
    access: null,
    error: null,
    inputId: '',
    outputId: '',
    profileFile: STOCK[0].file,
    profile: null,
    engine: null,
    surface: null,
    activity: [],
    learn: null,
    writes: 0,
    unsub: null
  };

  function log(kind, text) {
    state.activity.unshift({ at: Date.now(), kind, text });
    if (state.activity.length > ACTIVITY_MAX) state.activity.length = ACTIVITY_MAX;
  }

  /* ------------------------------------------------------------ ports */

  async function connect() {
    state.error = null;
    if (!state.support) {
      state.error = state.secure
        ? 'This browser has no Web MIDI support.'
        : 'Web MIDI needs a secure context. Open this through LivePremier Plus on localhost, not the device address.';
      return onRefresh();
    }
    try {
      /* SysEx is asked for because Mackie scribble strips ride on it. A refusal
         is not fatal — retry without, and the surface still works as a
         controller minus its text displays. */
      try {
        state.access = await navigator.requestMIDIAccess({ sysex: true });
        state.sysex = true;
      } catch {
        state.access = await navigator.requestMIDIAccess({ sysex: false });
        state.sysex = false;
      }
    } catch (err) {
      state.error = err.name === 'NotAllowedError'
        ? 'Permission to use MIDI was refused. Allow it in the browser and try again.'
        : `Could not open MIDI: ${err.message}`;
      return onRefresh();
    }
    state.access.onstatechange = () => onRefresh();
    log('info', `MIDI open${state.sysex ? ' (with SysEx)' : ' (no SysEx)'}`);
    onRefresh();
  }

  const inputs = () => (state.access ? [...state.access.inputs.values()] : []);
  const outputs = () => (state.access ? [...state.access.outputs.values()] : []);

  /* ---------------------------------------------------------- engine */

  async function loadProfile(file) {
    const res = await fetch(PROFILE_BASE + file, { cache: 'no-store' });
    if (!res.ok) throw new Error('profile HTTP ' + res.status);
    const profile = await res.json();
    const problems = validate(profile);
    if (problems && problems.length) {
      log('warn', `${file}: ${problems.length} profile problem${problems.length === 1 ? '' : 's'}`);
    }
    return profile;
  }

  async function start() {
    stop();
    state.error = null;
    try {
      state.profile = await loadProfile(state.profileFile);
    } catch (err) {
      state.error = 'Could not load profile: ' + err.message;
      return onRefresh();
    }

    const out = outputs().find((o) => o.id === state.outputId);
    state.surface = new MidiSurface(state.profile, (bytes) => {
      try { out && out.send(bytes); } catch { /* a surface unplugged mid-show */ }
    });

    /* The engine reads the device out of the same mirrored store the panels
       use, so it sees exactly what the vendor UI sees. */
    state.engine = new Engine(session.store, state.profile, {});

    state.engine.addEventListener('write', (ev) => {
      for (const w of ev.detail.writes || []) {
        /* Already store-form: the node host converts these to AWJ, we do not
           have to. Sent through the session so they ride the vendor socket. */
        if (session.send({ path: w.path, value: w.value })) state.writes++;
      }
      onRefresh();
    });
    state.engine.addEventListener('feedback', (ev) => {
      try { state.surface.render(ev.detail); } catch { /* feedback is best-effort */ }
    });
    state.engine.addEventListener('unresolved', (ev) => {
      log('warn', `unresolved: ${ev.detail.reason}`);
    });

    /* Keep the engine's view of the device current. */
    state.unsub = session.store.subscribe([], ({ path }) => {
      try { state.engine.deviceChanged(path); } catch { /* ignore */ }
    }, { immediate: false });

    const input = inputs().find((i) => i.id === state.inputId);
    if (input) {
      input.onmidimessage = (ev) => onMidi(ev.data);
      log('info', `listening on ${input.name}`);
    } else {
      log('warn', 'no MIDI input selected — nothing will arrive');
    }

    try { state.engine.refresh(); } catch { /* nothing selected yet */ }
    onRefresh();
  }

  function stop() {
    for (const i of inputs()) i.onmidimessage = null;
    if (state.unsub) { state.unsub(); state.unsub = null; }
    state.engine = null;
    state.surface = null;
  }

  function onMidi(bytes) {
    if (!state.surface) return;
    let event;
    try { event = state.surface.handle(bytes); } catch { return; }
    if (!event) return;

    if (state.learn) { finishLearn(event); return; }

    if (event.kind === 'unmapped') {
      log('unmapped', `${event.control} — not in this profile`);
      onRefresh();
      return;
    }
    try { state.engine.input(event); } catch (err) { log('warn', err.message); }
    log('in', `${event.control} ${event.kind}${event.value != null ? ' ' + fmt(event.value) : ''}`);
    onRefresh();
  }

  /* ----------------------------------------------------------- learn */

  function beginLearn() {
    state.learn = { since: Date.now() };
    log('info', 'learn armed — move a control');
    onRefresh();
  }

  function finishLearn(event) {
    state.learn = null;
    log('learn', `${event.control} (${event.kind})`);
    onRefresh();
  }

  const fmt = (v) => (typeof v === 'number' ? (Math.round(v * 1000) / 1000).toString() : String(v));

  /* ---------------------------------------------------------- render */

  function render() {
    const running = !!state.engine;

    const body = h('div', { class: 'aw-flex-col aw-gap-row-large' },
      contextNotice(),
      state.error ? h('div', { class: 'wru-tag wru-warn', text: state.error }) : null,
      portSection(running),
      activitySection());

    return panel({ toolbar: toolbar(running), body });
  }

  /**
   * Say plainly why MIDI is or is not available.
   *
   * This is the one thing worth explaining in the UI: an operator who opened
   * the device's own address directly will find nothing works here, and the
   * reason is not guessable.
   */
  function contextNotice() {
    if (state.support && state.secure) return null;
    return h('div', { class: 'wru-tag wru-warn' },
      h('span', {
        text: state.secure
          ? 'This browser does not support Web MIDI.'
          : 'Not a secure context — MIDI is unavailable. Open Web RCS through LivePremier Plus (a localhost address), not the switcher\'s own address.'
      }));
  }

  function portSection(running) {
    const select = (label, list, current, onPick) =>
      h('label', { class: 'aw-flex-col aw-gap-row-mini' },
        h('span', { class: 'aw-font-overline aw-text-tertiary', text: label }),
        h('select', {
          class: 'wru-input',
          disabled: running ? 'disabled' : null,
          onChange: (ev) => { onPick(ev.target.value); onRefresh(); }
        },
        h('option', { value: '', text: list.length ? '— choose —' : 'none found' }),
        list.map((p) => {
          const opt = h('option', { value: p.id, text: p.name + (p.manufacturer ? ` (${p.manufacturer})` : '') });
          if (p.id === current) opt.selected = true;
          return opt;
        })));

    return h('div', { class: 'aw-flex-col aw-gap-row-medium' },
      h('div', { class: 'aw-font-subtitle-1', text: 'Surface' }),
      !state.access
        ? h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium' },
          button('Enable MIDI', { onClick: connect, variant: 'primary' }),
          h('span', { class: 'aw-text-secondary aw-font-caption', text: 'The browser will ask once.' }))
        : h('div', { class: 'aw-flex-row aw-gap-col-medium' },
          select('Input', inputs(), state.inputId, (v) => { state.inputId = v; }),
          select('Output (feedback)', outputs(), state.outputId, (v) => { state.outputId = v; }),
          h('label', { class: 'aw-flex-col aw-gap-row-mini' },
            h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'Profile' }),
            h('select', {
              class: 'wru-input',
              disabled: running ? 'disabled' : null,
              onChange: (ev) => { state.profileFile = ev.target.value; onRefresh(); }
            }, STOCK.map((p) => {
              const opt = h('option', { value: p.file, text: p.label });
              if (p.file === state.profileFile) opt.selected = true;
              return opt;
            })))));
  }

  function activitySection() {
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Activity' }),
      state.activity.length
        ? h('div', { class: 'wru-console-log aw-flex-col' }, state.activity.map((a) =>
          h('div', { class: ['wru-console-row', a.kind === 'unmapped' ? 'wru-console-warn' : a.kind === 'warn' ? 'wru-console-warn' : 'wru-console-ok'] },
            h('code', { class: 'wru-console-cmd', text: a.kind }),
            h('span', { class: 'wru-console-detail aw-text-secondary', text: a.text }))))
        : h('div', { class: 'wru-empty', text: 'Nothing yet. Enable MIDI, pick a port and profile, then Start.' }));
  }

  function toolbar(running) {
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium' },
      h('div', { class: 'aw-font-subtitle-1', text: 'MIDI Mapping' }),
      h('span', { class: ['wru-tag', running ? '' : 'wru-warn'], text: running ? 'running' : 'stopped' }),
      running ? h('span', { class: 'wru-tag', text: `${state.writes} write${state.writes === 1 ? '' : 's'}` }) : null,
      h('div', { style: { flex: '1' } }),
      state.learn ? h('span', { class: 'wru-tag wru-warn', text: 'move a control…' }) : null,
      button('Learn', { onClick: beginLearn, disabled: !running, variant: 'ghost' }),
      running
        ? button('Stop', { onClick: () => { stop(); onRefresh(); }, variant: 'ghost' })
        : button('Start', { onClick: start, disabled: !state.access || !state.inputId, variant: 'primary' }));
  }

  return { render, state, connect, start, stop, onMidi };
}
