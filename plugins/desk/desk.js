/*
 * The desk, running: one MIDI input, a Console line, and the encoder engine.
 *
 * The desk's controller is one USB MIDI device carrying everything — keypad
 * notes, encoder and wheel CCs, encoder pushes — on channel 1. This splits
 * the stream: the keypad's notes type into a Console line of the desk's own
 * (`keypad.js`), and everything else goes through awj-surface's engine with
 * the `lpp-surface-p1` profile, exactly as MIDI Mapping would run it. The
 * screen window draws from `snapshot()` and asks for changes through the
 * methods here; it holds nothing of its own.
 *
 * ## Why it lives in the Web RCS tab and not in the screen window
 *
 * The tab is where the session is, and a popped-out window only borrows it
 * (`src/ui/popout.js`). Living here, the keypad still types and TAKE still
 * takes with the screen window closed, and the screen is only a view.
 *
 * ## One browser, one desk
 *
 * Two tabs of this app each listening to the desk would each type every word,
 * and a TAKE pressed once would take twice — which on a LivePremier is a take
 * and then the take back. So the desk holds a Web Lock while it listens, and a
 * second tab that finds it held says so and stays deaf. (MIDI Mapping is a
 * different panel and takes no such lock: started on the desk's port with this
 * profile it would move every parameter twice. Don't.)
 */

import { Engine } from '../../src/vendor/surface/engine.js';
import { MidiSurface } from '../../src/vendor/surface/surface.js';
import { validate } from '../../src/vendor/surface/profile.js';
import { readIdentity, describe } from '../../src/core/identity.js';
import { createKeypad } from './keypad.js';
import { PROFILE, KNOBS, cells, pageFor, outcomeText, formatValue, cellValue } from './core.js';

const PROFILE_URL = `/__lpp/src/vendor/surface/profiles/${PROFILE}`;
const LOCK = 'lpp-desk';
const STORED_INPUT = 'lpp-desk:midi-input';
const KNOB_IDS = new Set(KNOBS.map((k) => k.control));
const RECENT = 4;

/** How a sticky scope points the wheels: its first screen and first layer. */
function wheelsFor(selection) {
  if (!selection) return null;
  const screen = selection.targets.find((t) => t.kind === 'screen');
  const layer = (selection.layers || []).find((l) => typeof l === 'number');
  return { screen: screen ? `S${screen.n}` : null, layer: layer ?? null };
}

/**
 * @param {object} opts
 * @param {object} opts.session the tab's session (store mirror and socket)
 * @param {() => object|null} opts.consoleService the `console` service, asked once
 * @param {() => void} [opts.onChange] something the panel should redraw
 * @param {object} [opts.midi] `navigator`-shaped, for `requestMIDIAccess` and `locks`
 * @param {(url: string) => Promise<object>} [opts.loadProfile]
 * @param {Storage|null} [opts.storage] where the chosen port's name is kept
 */
export function createDesk({
  session, consoleService, onChange = () => {},
  midi = typeof navigator !== 'undefined' ? navigator : null,
  loadProfile = defaultLoadProfile,
  storage = defaultStorage()
}) {
  const watchers = new Set();
  const state = {
    status: 'off',          // off | asking | choose | listening | elsewhere | refused | unsupported
    error: null,
    access: null,
    inputId: '',
    inputName: '',
    profile: null,
    lastKey: null,
    notice: null
  };
  /* control id -> Map(binding id -> {label, text}) for the page in view */
  const shown = new Map();

  let release = null;       // lets go of the Web Lock
  let unsubscribe = null;   // the store subscription
  let scopeKey = '';

  const service = consoleService();
  if (!service) throw new Error('the Console plugin is off — the desk types into a Console line');
  const line = service.line({ onRefresh: () => changed() });

  const keypad = createKeypad({
    line,
    onPage: (attribute) => showPage(pageFor(attribute, page(), state.profile && state.profile.pages)),
    onUser: () => { state.notice = 'U1 has no job yet'; changed(); },
    onKey: (key, what) => { state.lastKey = { key: key.key, what, at: Date.now() }; }
  });

  /* ------------------------------------------------------------ engine */

  const engine = { current: null, surface: null };

  async function ready() {
    if (engine.current) return engine.current;
    const profile = await loadProfile(PROFILE_URL);
    const problems = validate(profile);
    if (problems.length) throw new Error(`${PROFILE}: ${problems[0]}`);
    state.profile = profile;
    /* The desk's controller has no lamps or rings: feedback is the screen. */
    engine.surface = new MidiSurface(profile, () => {});
    const e = new Engine(session.store, profile, {});
    e.addEventListener('write', (ev) => {
      for (const w of ev.detail.writes || []) session.send({ path: w.path, value: w.value });
    });
    e.addEventListener('selection', () => { shown.clear(); });
    e.addEventListener('feedback', (ev) => {
      const d = ev.detail;
      if (!KNOB_IDS.has(d.control)) return;
      if (!shown.has(d.control)) shown.set(d.control, new Map());
      shown.get(d.control).set(d.binding, { label: d.top, text: formatValue(d.path, d.value) });
      changed();
    });
    unsubscribe = session.store.subscribe([], ({ path }) => {
      try { e.deviceChanged(path); } catch { /* one bad path is not the desk's end */ }
    }, { immediate: false });
    /* Before the switcher has answered every cell reads a dash; when it does,
       read them all again. */
    if (session.store.addEventListener) {
      session.store.addEventListener('ready', () => { try { e.refresh(); } catch { /* nothing selected yet */ } });
    }
    engine.current = e;
    followScope();
    e.refresh();
    return e;
  }

  const page = () => (engine.current ? engine.current.selection.page : null);

  /** Point the wheels where the sticky scope points: its first screen and layer. */
  function followScope() {
    const e = engine.current;
    if (!e) return;
    const want = wheelsFor(line.state.selection);
    const key = JSON.stringify(want);
    if (key === scopeKey) return;
    scopeKey = key;
    if (!want) return;
    const act = (action, value) => e.action({ target: { kind: 'action', action, value } }, { kind: 'button', down: true }, {});
    if (want.screen) act('selectScreen', want.screen);
    if (want.layer !== null) act('selectLayer', want.layer);
  }

  function showPage(id) {
    if (!id || !engine.current) return;
    engine.current.showPage(id);
    changed();
  }

  /* -------------------------------------------------------------- MIDI */

  function onMessage(ev) {
    const bytes = ev.data;
    if (keypad.handle(bytes)) { state.notice = null; return; }
    const surface = engine.surface;
    if (!surface || !engine.current) return;
    let event;
    try { event = surface.handle(bytes); } catch { return; }
    if (!event || event.kind === 'unmapped') return;
    engine.current.input(event);
  }

  const inputs = () => (state.access ? [...state.access.inputs.values()] : []);

  /** Which input to open: the one chosen before, or the one whose name says it is the desk. */
  function pickInput() {
    const list = inputs();
    let remembered = '';
    try { remembered = (storage && storage.getItem(STORED_INPUT)) || ''; } catch { remembered = ''; }
    if (remembered) {
      const hit = list.find((i) => i.name === remembered);
      if (hit) return hit;
    }
    const pattern = state.profile && state.profile.match && state.profile.match.namePattern;
    if (pattern) {
      const re = new RegExp(pattern, 'i');
      const hits = list.filter((i) => re.test(i.name || ''));
      /* One that says it is the desk, or none: never a guess between several,
         and never any other port — a port that is not the desk looks exactly
         like a desk being ignored. */
      if (hits.length === 1) return hits[0];
    }
    return null;
  }

  async function connect() {
    state.error = null;
    if (!midi || typeof midi.requestMIDIAccess !== 'function') {
      state.status = 'unsupported';
      state.error = 'This browser has no Web MIDI. It needs Chrome or Chromium on this app’s own address (127.0.0.1 is fine).';
      return changed();
    }
    try { await ready(); } catch (err) {
      state.error = `Could not load the desk’s profile: ${err.message}`;
      return changed();
    }
    if (!state.access) {
      state.status = 'asking';
      changed();
      try {
        state.access = await midi.requestMIDIAccess({ sysex: false });
      } catch (err) {
        state.status = 'refused';
        state.error = err && err.name === 'NotAllowedError'
          ? 'MIDI was refused. Allow it for this address in the browser and try again.'
          : `Could not open MIDI: ${err && err.message}`;
        return changed();
      }
      state.access.onstatechange = () => { if (state.status === 'choose') listen(pickInput()); else changed(); };
    }
    return listen(pickInput());
  }

  /** Listen on one input, holding the desk's lock while we do. */
  async function listen(input) {
    stopListening();
    if (!input) { state.status = 'choose'; return changed(); }
    const held = await lock();
    if (!held) {
      state.status = 'elsewhere';
      state.error = 'Another tab of this browser is already listening to the desk. Close it, or switch the desk off there.';
      return changed();
    }
    input.onmidimessage = onMessage;
    state.inputId = input.id;
    state.inputName = input.name;
    state.status = 'listening';
    try { storage && storage.setItem(STORED_INPUT, input.name); } catch { /* remembered next time, or not */ }
    changed();
  }

  /** Take the Web Lock, or say it is held. True when this tab now has the desk. */
  async function lock() {
    if (release) return true;
    const locks = midi && midi.locks;
    if (!locks || typeof locks.request !== 'function') return true;
    return new Promise((resolve) => {
      locks.request(LOCK, { ifAvailable: true }, (held) => {
        if (!held) { resolve(false); return undefined; }
        resolve(true);
        return new Promise((done) => { release = () => { release = null; done(); }; });
      }).catch(() => resolve(true));
    });
  }

  function stopListening() {
    for (const i of inputs()) if (i.onmidimessage === onMessage) i.onmidimessage = null;
    if (release) release();
  }

  function choose(inputId) {
    const input = inputs().find((i) => i.id === inputId);
    return listen(input || null);
  }

  function stop() {
    stopListening();
    state.status = state.access ? 'choose' : 'off';
    state.inputId = '';
    state.inputName = '';
    changed();
  }

  function dispose() {
    stopListening();
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    watchers.clear();
  }

  /* ------------------------------------------------------------ change */

  /* An engine refresh is a feedback event per binding, and a keypress is a
     line change and a page change at once: tell the panel and the screen once
     per turn of the event loop, not once per event. */
  let queued = false;
  function changed() {
    if (queued) return;
    queued = true;
    queueMicrotask(flush);
  }

  function flush() {
    queued = false;
    followScope();
    onChange();
    for (const fn of [...watchers]) {
      /* A screen window that has gone away leaves a function from a dead
         document behind; calling it throws, and it is dropped. */
      try { fn(); } catch { watchers.delete(fn); }
    }
  }

  function subscribe(fn) {
    watchers.add(fn);
    return () => watchers.delete(fn);
  }

  /** Everything the screen draws, as plain data. */
  function snapshot() {
    const s = line.state;
    const e = engine.current;
    const frame = readIdentity(session.store).primary;
    const sel = e ? e.selection : null;
    const bindingsOn = (control) => (state.profile ? state.profile.bindings : [])
      .filter((b) => b.control === control && (b.page === undefined || b.page === (sel && sel.page)));
    return {
      line: s.line,
      scope: line.scope(),
      feedback: outcomeText(s.outcome, { error: s.error }),
      log: s.log.slice(0, RECENT).map((r) => ({ kind: r.kind, text: r.text, detail: r.detail })),
      pages: state.profile ? state.profile.pages : [],
      page: sel ? sel.page : null,
      wheelsAt: sel ? `${sel.screen} L${sel.layer} ${sel.preset === 'PREVIEW' ? 'preview' : sel.preset.toLowerCase()}` : '',
      cells: cells().map((c) => {
        const live = bindingsOn(c.control);
        const values = [...(shown.get(c.control) || new Map()).values()];
        return {
          ...c,
          label: live.length ? (live[0].label || values[0]?.label || c.name) : '—',
          value: live.length ? cellValue(values.map((v) => v.text)) : '',
          bound: live.length > 0
        };
      }),
      device: frame ? [describe(frame), frame.firmware].filter(Boolean).join(' · ') : '',
      session: session.state,
      midi: { status: state.status, name: state.inputName, error: state.error },
      shift: keypad.shift,
      notice: state.notice
    };
  }

  return {
    state, line, keypad, engine: () => engine.current, inputs, connect, choose, stop, dispose,
    showPage, snapshot, subscribe, ready,
    /* The screen window's line, typed at its own field. */
    setLine: (text) => line.setLine(text),
    execute: () => line.execute(),
    clear: () => line.clear()
  };
}

async function defaultLoadProfile(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}
