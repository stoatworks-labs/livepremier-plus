/*
 * Control API — what can be asked of this app from outside, and what it means.
 *
 * Shared by both halves, so it has no DOM, no sockets and no fetch. The server
 * checks a request against this table before it bothers a page with it; the
 * page runs the same table's names, so the two cannot disagree about what an
 * action is called or what it takes.
 *
 * ## Why a page runs it
 *
 * The Timeline, Layer Lock, Layer Groups, the Console and the user's variables
 * run in an open Web RCS page, against the store that page holds — `server/
 * awj.js` argues at length why this process keeps no store of its own. So an
 * action from Companion is handed to **one** open page, the one holding the
 * lease, exactly as the HyperDeck rules and the Pixelhue panel's cue transport
 * are: two open tabs must not both GO the stack. With no page open there is
 * nobody to run it, and the request says so in those words rather than
 * pretending.
 *
 * What already has a route of its own — Matrix Routing, the HyperDecks,
 * Triggers, the plugin switches — is not repeated here. A client calls those
 * routes directly, and they work with no page open at all.
 */

/** How long a page's claim lasts without a renewal. Its beat is every few seconds. */
export const LEASE_MS = 12000;

/** How long `/do` waits for the page to say what happened. */
export const ANSWER_MS = 4000;

/** The version of this contract, for a client to check before it relies on an action. */
export const CONTROL_VERSION = 1;

const text = (v) => (v == null ? '' : String(v).trim());

/** `on`, `off` or `toggle`, from whatever a client sent. */
export function onOff(v) {
  if (v === true) return 'on';
  if (v === false) return 'off';
  const s = text(v).toLowerCase();
  if (['on', 'true', '1', 'yes', 'lock'].includes(s)) return 'on';
  if (['off', 'false', '0', 'no', 'unlock'].includes(s)) return 'off';
  if (s === 'toggle' || s === '') return 'toggle';
  return null;
}

/**
 * The actions, by name. `args` turns what a client sent into what the page
 * runs, or throws a sentence the client can show.
 *
 * Every name is `<area>.<verb>`, so a client can group them, and an area maps
 * onto the plugin that has to be on for it to mean anything.
 */
export const ACTIONS = {
  'timeline.go': { plugin: 'timeline', describe: 'GO: fire the standby cue, then advance', args: () => ({}) },
  'timeline.back': { plugin: 'timeline', describe: 'Move the standby back one cue, firing nothing', args: () => ({}) },
  'timeline.next': { plugin: 'timeline', describe: 'Move the standby on one cue, firing nothing', args: () => ({}) },
  'timeline.first': { plugin: 'timeline', describe: 'Make the first cue the standby', args: () => ({}) },
  'timeline.stop': { plugin: 'timeline', describe: 'Cancel a pending pre-wait or follow', args: () => ({}) },
  'timeline.goto': {
    plugin: 'timeline',
    describe: 'Make a cue the standby, by its number',
    args: (a) => ({ cue: needCue(a) }),
  },
  'timeline.fire': {
    plugin: 'timeline',
    describe: 'Fire one cue now, by its number, wherever the standby is',
    args: (a) => ({ cue: needCue(a) }),
  },
  'timecode.chase': {
    plugin: 'timecode',
    describe: 'Arm or disarm the Timeline’s timecode chase',
    args: (a) => ({ on: needOnOff(a.on) }),
  },
  'console.run': {
    plugin: 'console',
    describe: 'Run a line exactly as if it had been typed at the Console',
    args: (a) => {
      const line = text(a.line);
      if (!line) throw new Error('a Console line is needed');
      if (line.length > 2000) throw new Error('that line is too long for the Console');
      return { line };
    },
  },
  'locks.set': {
    plugin: 'layer-lock',
    describe: 'Lock, unlock or toggle a layer or a layer group',
    args: (a) => ({ target: needTarget(a.target), on: needOnOff(a.on) }),
  },
  'locks.take': {
    plugin: 'layer-lock',
    describe: 'Take only this layer, or this group, leaving the rest alone',
    args: (a) => ({ target: needTarget(a.target) }),
  },
  'groups.send': {
    plugin: 'layer-groups',
    describe: 'Put an input on a layer or a layer group, in preview or program',
    args: (a) => {
      const source = text(a.source);
      if (!source) throw new Error('a source is needed: an input number, IN3, IMG2 or NONE');
      const mode = text(a.mode || 'preview').toUpperCase();
      if (mode !== 'PREVIEW' && mode !== 'PROGRAM') throw new Error('mode is preview or program');
      return { source, target: needTarget(a.target), mode };
    },
  },
  'variables.set': {
    plugin: 'variables',
    describe: 'Give a user variable a new definition, adding it if it is new',
    args: (a) => {
      const name = text(a.name).replace(/^@/, '');
      if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(name)) throw new Error(`“${text(a.name)}” is not a variable name`);
      const value = text(a.value);
      if (!value) throw new Error('a value is needed');
      return { name, value };
    },
  },
};

function needCue(a) {
  const cue = text(a.cue ?? a.number);
  if (!cue) throw new Error('a cue number is needed');
  return cue;
}

function needOnOff(v) {
  const s = onOff(v);
  if (!s) throw new Error('on, off or toggle');
  return s;
}

function needTarget(v) {
  const t = text(v);
  if (!t) throw new Error('a target is needed: a layer as S1/2, or a layer group by name');
  return t;
}

/**
 * Check a request. `{ok: true, action, args}` or `{ok: false, error}` — the
 * error a sentence for whoever pressed the button.
 */
export function checkRequest(body) {
  const action = text(body && body.action);
  const def = ACTIONS[action];
  if (!def) return { ok: false, error: action ? `there is no action “${action}”` : 'no action named' };
  try {
    return { ok: true, action, plugin: def.plugin, args: def.args((body && body.args) || {}) };
  } catch (err) {
    return { ok: false, error: `${action}: ${err.message}` };
  }
}

/** The table as a client reads it from `GET /state`. */
export const describeActions = () => Object.entries(ACTIONS).map(([name, d]) => ({ name, plugin: d.plugin, describe: d.describe }));

/* ------------------------------------------------------------------ the lease */

/**
 * One page at a time, as HyperDeck's `/runner`: the first to claim keeps it
 * while it renews; another claim is refused until the holder lets go or its
 * claim lapses.
 *
 * `alive(id)` keeps a claim that has stopped renewing: the server answers it
 * with whether that page's stream is still open. A browser slows the timers of
 * a tab that has been hidden a while to about one a minute, so a beat alone
 * would lose the lease to a page that is open and listening — the Web RCS tab
 * behind the cue sheet, which is where it usually is in a show.
 */
export function createLease({ ms = LEASE_MS, now = () => Date.now(), alive = () => false } = {}) {
  let holder = null;
  const current = () => (holder && (alive(holder.id) || now() - holder.at <= ms) ? holder.id : null);
  return {
    current,
    claim(id, release = false) {
      const key = text(id);
      if (!key) return current();
      const had = current();
      if (!had || had === key) holder = { id: key, at: now() };
      if (release && holder && holder.id === key) holder = null;
      return current();
    },
  };
}

/* ------------------------------------------------------------- cues, targets */

/**
 * The cue a client means by a number. Cue numbers are text an operator typed
 * (`3`, `3.5`, `12a`), so `3` matches `3`, `3.0` and `03` but not `3.5`. A
 * cue with no number of its own is numbered by its place in the list, as the
 * Timeline draws it.
 */
export function findCue(cues, wanted) {
  const w = text(wanted).toLowerCase();
  if (!w) return null;
  const asNumber = (s) => (/^\d+(\.\d+)?$/.test(s) ? Number(s) : null);
  const wn = asNumber(w);
  return (cues || []).find((c, i) => {
    const n = text(c.number || String(i + 1)).toLowerCase();
    if (n === w) return true;
    const nn = asNumber(n);
    return wn != null && nn != null && wn === nn;
  }) || null;
}

/**
 * A layer or a group, from what a client typed. `S1/2`, `S1 L2`, `s1 2`,
 * `A3/1` and `S2/NATIVE` are layers; anything else is a group's name, matched
 * without regard to case.
 */
export function parseTarget(raw, groups = []) {
  const t = text(raw);
  const m = /^([SA])\s*(\d+)\s*(?:\/|\s|L)\s*L?\s*(\d+|native|nat)$/i.exec(t);
  if (m) {
    const layer = /^nat/i.test(m[3]) ? 'NATIVE' : String(Number(m[3]));
    return { kind: 'layer', members: [{ id: `${m[1].toUpperCase()}${Number(m[2])}`, layer }], label: `${m[1].toUpperCase()}${Number(m[2])}/${layer}` };
  }
  const group = (groups || []).find((g) => text(g.name).toLowerCase() === t.toLowerCase());
  if (group) return { kind: 'group', group, members: (group.members || []).map((x) => ({ id: x.id, layer: String(x.layer) })), label: group.name };
  return null;
}

/**
 * A source, from what a client typed, against the sources the switcher
 * offers right now (`dialect.sources(store)`): `3` and `IN3` are input 3,
 * `IMG2` a still, `NONE` clears the layer, and the device's own spelling
 * (`LIVE_3`, `INPUT_3`) is taken as it is.
 */
export function resolveSource(raw, sources = [], label = (v) => v) {
  const t = text(raw);
  const squash = (s) => text(s).toLowerCase().replace(/[\s_-]+/g, '');
  const want = squash(/^\d+$/.test(t) ? `IN${t}` : t);
  if (want === 'none' || want === 'clear') {
    const none = sources.find((s) => /^none$/i.test(String(s.value)));
    return none ? none.value : 'NONE';
  }
  for (const s of sources) {
    if (squash(s.value) === want || squash(label(s.value)) === want) return s.value;
  }
  /* `INPUT3` or `IN3` for an input the dialect spells otherwise. */
  const n = /^in(?:put)?(\d+)$/.exec(want);
  if (n) {
    const found = sources.find((s) => s.kind === 'input' && Number(/(\d+)$/.exec(String(s.value))?.[1]) === Number(n[1]));
    if (found) return found.value;
  }
  return null;
}
