/*
 * HyperDecks — the plugin's page half: the panel, the rules, and a cue action.
 *
 * ## The rules run here
 *
 * The server half has the decks and no store; this page has the store and no
 * decks. So the rules — play when on air, pause or load the next clip when
 * taken off, take when a clip ends — are decided here and carried out through
 * the server: a deck command is a POST, a take is the same `session.send()`
 * the Timeline's GO makes.
 *
 * **One page decides at a time.** Every open page asks for the lease every
 * few seconds and only the holder acts, so two tabs on the same switcher do
 * not both press play. A page that gets the lease starts from what it sees at
 * that moment and acts only on what changes after: loading the page, or
 * taking over from a closed one, never plays a deck that was already on air.
 *
 * ## A clip's end, two ways
 *
 * With no lead time, the server's `ended` event is the trigger — it is sent
 * when the transport stops by itself. With a lead, the countdown the server
 * streams is: the end action fires once, when the time left in the clip first
 * drops to the lead, so a two-second mix can finish on the last frame rather
 * than two seconds after it. Either way it fires once per play of a clip.
 */

import { createDeckPanel } from './panel.js';
import { dialectFor } from '../../src/core/dialect.js';
import { commandsFor } from '../../src/core/commands.js';
import {
  sourceForInput, airState, decide, endAction, parseCueText, describeCueAction, plays,
} from './core.js';

const RUNNER_BEAT_MS = 4000;
const LOG = 30;

export default function activate(ctx) {
  const pageId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : `p${Math.random().toString(36).slice(2)}`;
  const state = { data: null, error: null, log: [], runner: null, pageId };
  let stream = null;
  /* Where each deck was on air last time we looked; null means "look first, act later". */
  let prev = null;
  let air = new Map();
  let pendingEval = null;

  /* ------------------------------------------------------------ server */

  async function load() {
    try {
      const res = await fetch(ctx.url('/'), { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      state.data = await res.json();
      state.error = null;
    } catch (err) {
      state.error = `Could not reach the launcher: ${err.message}`;
    }
    followIfAutomated();
    ctx.refresh();
  }

  /*
   * The stream is held only while it is needed — the panel is open, or a deck
   * has rules to run. A page has six connections to its origin and the vendor's
   * own app uses some of them; a stream for a feature nobody set up would be
   * one fewer for everybody else.
   */
  function followIfAutomated() {
    if (decks().some((d) => d.rules.automate)) listen();
  }

  function listen() {
    if (stream) return;
    try {
      stream = new EventSource(ctx.url('/stream'));
      stream.addEventListener('decks', (ev) => {
        try { state.data = JSON.parse(ev.data); } catch { return; }
        state.runner = state.data.runner;
        if (!prev) evaluate();
        checkLeads();
        ctx.refresh();
      });
      stream.addEventListener('ended', (ev) => {
        let e;
        try { e = JSON.parse(ev.data); } catch { return; }
        onEnded(e);
      });
    } catch { /* no EventSource: the panel still draws, the rules do not run */ }
  }

  async function command(deck, sequence, why) {
    try {
      const res = await fetch(ctx.url('/command'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deck, sequence }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || String(res.status));
      if (why) note(`${nameOf(deck)} ${sequence.map((s) => s.command).join(' + ')} — ${why}`);
      return payload;
    } catch (err) {
      note(`${nameOf(deck)} ${sequence.map((s) => s.command).join(' + ')} failed: ${err.message}`, true);
      throw err;
    }
  }

  async function saveDecks(decks) {
    try {
      const res = await fetch(ctx.url('/'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decks }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || String(res.status));
      state.data = payload;
      state.error = null;
      /* A deck just added or rewired starts from where it is now. */
      prev = null;
      followIfAutomated();
    } catch (err) {
      state.error = `Could not save: ${err.message}`;
    }
    ctx.refresh();
  }

  const decks = () => (state.data && state.data.decks) || [];
  const liveOf = (id) => ((state.data && state.data.live) || []).find((d) => d.id === id) || null;
  const nameOf = (id) => decks().find((d) => d.id === id)?.name ?? id;

  function note(text, warn = false) {
    state.log.unshift({ at: new Date(), text, warn });
    state.log.length = Math.min(state.log.length, LOG);
    if (warn) ctx.log.warn(`hyperdeck: ${text}`);
    ctx.refresh();
  }

  /* ------------------------------------------------------------ the lease */

  const running = () => state.runner === pageId;

  async function beat(release = false) {
    try {
      const res = await fetch(ctx.url('/runner'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pageId, release }), keepalive: release,
      });
      if (!res.ok) return;
      const was = running();
      state.runner = (await res.json()).runner;
      /* Taking over: see the world as it is before acting on any change in it. */
      if (!was && running()) prev = null;
    } catch { /* the next beat tries again */ }
  }
  void load();
  void beat();
  const beating = setInterval(beat, RUNNER_BEAT_MS);
  const release = () => { if (running()) void beat(true); };
  globalThis.addEventListener?.('pagehide', release);
  if (typeof ctx.onDispose === 'function') ctx.onDispose(() => { clearInterval(beating); release(); });

  /* ------------------------------------------------------------ the rules */

  function airByDeck() {
    const store = ctx.session.store;
    if (!store || !store.ready) return null;
    const sourceOf = new Map();
    for (const deck of decks()) {
      if (!plays(deck) || !deck.input) continue;
      const source = sourceForInput(store, deck.input);
      if (source) sourceOf.set(deck.id, source);
    }
    const bySource = airState(store, new Set(sourceOf.values()));
    const out = new Map();
    for (const [id, source] of sourceOf) out.set(id, bySource.get(source));
    return out;
  }

  function evaluate() {
    pendingEval = null;
    const next = airByDeck();
    if (!next) return;
    air = next;
    if (!running() || !prev) { prev = next; return; }
    const actions = decide(decks(), prev, next);
    prev = next;
    for (const a of actions) void command(a.deck, a.sequence, a.why).catch(() => {});
  }

  /* Frames arrive in bursts — a take is a dozen writes — so wait for the burst to finish. */
  ctx.session.addEventListener('frame', () => {
    if (!pendingEval) pendingEval = setTimeout(evaluate, 40);
  });
  ctx.session.addEventListener('state', () => { prev = null; });

  /* Runs for which the end action has fired, by deck. */
  const firedRun = new Map();

  function fireEnd(deck, run, why) {
    if (firedRun.get(deck.id) === run) return;
    const act = endAction(deck, air.get(deck.id));
    if (!act) return;
    firedRun.set(deck.id, run);
    const cmds = commandsFor(dialectFor(ctx.session.store));
    let sent = 0;
    for (const screen of act.screens) {
      const cmd = act.type === 'cut' ? cmds.cut(screen) : cmds.take(screen);
      if (cmd && ctx.session.send(cmd)) sent += 1;
    }
    note(`${act.type} on ${act.screens.join(', ')} — ${deck.name} ${why}`, sent !== act.screens.length);
  }

  function onEnded(e) {
    if (!running()) return;
    const deck = decks().find((d) => d.id === e.deck);
    if (!deck) return;
    fireEnd(deck, e.run, `clip ${e.clip} ended`);
  }

  function checkLeads() {
    if (!running()) return;
    for (const deck of decks()) {
      if (!deck.rules.automate || deck.rules.lead <= 0) continue;
      const live = liveOf(deck.id);
      const remaining = live && live.position && live.position.remaining;
      if (!live || live.transport.status !== 'play' || remaining == null) continue;
      if (remaining <= deck.rules.lead) fireEnd(deck, live.run, `${remaining.toFixed(1)} s from the end`);
    }
  }

  /* ------------------------------------------------------------ cues */

  ctx.contribute('cueAction', {
    kind: 'hyperdeck',
    label: 'HyperDeck',
    run: (a) => command(a.deck, [{ command: a.command, clip: a.clip, name: a.name, loop: a.loop }]),
    describe: (a) => describeCueAction(a, decks()),
    field: {
      label: 'HyperDeck',
      placeholder: 'VT 1 clip 2; VT 1 play; recorders record',
      hint: '<deck> play | stop | record [name] | clip N | next | prev | rewind — ; between several. all, players and recorders name several decks.',
      parse: (text) => parseCueText(text, decks()),
      format: (actions) => actions.map((a) => describeCueAction(a, decks())).join('; '),
    },
  });

  /* ------------------------------------------------------------ the panel */

  const panel = createDeckPanel({
    ctx,
    state,
    load: () => { if (!state.data && !state.error) void load(); listen(); },
    command: (deck, sequence) => command(deck, sequence).catch(() => {}),
    saveDecks,
    airOf: (id) => air.get(id) || null,
  });
  ctx.ui.sidebar({
    id: 'hyperdeck',
    label: 'HyperDecks',
    icon: ['play-18', 'video-18', 'properties-18'],
    order: 55,
    render: () => panel.render(),
    busy: () => panel.busy(),
  });
}
