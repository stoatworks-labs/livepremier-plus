/*
 * Aux follow — an aux's layer that takes whatever source a screen's layer has.
 *
 * The switcher has no such link. An aux is a destination of its own, with its
 * own buffers and its own takes, and nothing ties one of its layers to a
 * screen's. So the link is ours: a list kept per switcher, and a follower in
 * the page that writes the aux's layer whenever the screen's layer changes
 * source, by any route — the vendor's own drag, a memory recall, a take, the
 * front panel, Companion. No DOM and no I/O here: the panel, the page half and
 * the tests all import this file.
 *
 * ## Two modes
 *
 * - **`program`** — the aux's PROGRAM shows what the screen's layer shows on
 *   program. When a take on the screen lands, or something writes the
 *   screen's program directly, the aux's program is written to match: a cut
 *   on the aux, at the moment the screen's take finishes. The aux's preview is
 *   left to the operator.
 * - **`both`** — program and preview, role for role. A preview edit on the
 *   screen goes to the aux's preview, a program edit to its program — so an
 *   aux taken *with* the screen transitions with it. An aux left out of the
 *   take is put back in line, both roles, when the screen's take lands.
 *
 * ## ⚠️ A role, not a letter
 *
 * As in `src/core/groups.js`, whose fan-out this uses: a change seen in the
 * screen's letter B is first turned into program or preview through
 * `presetBanks()`, and the write to the aux is addressed to whichever letter
 * means that role on the aux. The two are routinely on opposite letters.
 * LivePremier's third buffer (`presetPrevious`, C) is neither role, and a
 * change there is followed by nothing.
 *
 * ## ⚠️ Mid-take, nothing is written — it is owed
 *
 * While either end is mid-take a role names no buffer honestly. A write that
 * would have gone then is remembered instead, and made when both ends are at
 * rest, from what the screen holds at that moment — never the value that
 * started it, which may be gone by then.
 *
 * ## Why this cannot loop
 *
 * Structurally, rather than by care: a follower is always an aux layer
 * (`A<n>`) and a leader always a screen layer (`S<n>`), so nothing this
 * writes is ever something it listens to. A layer follows one leader at most
 * (`normalise` imposes it), and a write is made only when the aux's value
 * differs from the screen's, so a second page doing the same work, or the
 * echo of the first, writes nothing.
 *
 * ## ⚠️ It never fires on state it merely found
 *
 * `Session` replays the frames buffered while the page hydrates without
 * dispatching them, and this acts only on frames: opening a page onto an aux
 * already out of step does not rewrite it. The one exception is setting a
 * follow, which is the operator asking for it — `sync()`.
 *
 * ## ⚠️ Only while a page is open
 *
 * This runs in the page, on the page's mirror, like the gang and Layer Lock's
 * follower. With no LivePremier Plus page open anywhere, nothing follows.
 */

import { dialectFor } from '../../src/core/dialect.js';
import { presetBanks } from '../../src/core/screens.js';
import { fittedLayers, readValue } from '../../src/core/properties.js';
import { sourceSpec, sourceCommands } from '../../src/core/groups.js';

/** The stored shape's version, so a later change can migrate rather than guess. */
export const VERSION = 1;

export const MODES = Object.freeze(['program', 'both']);

/** How many notes `recent()` keeps. */
export const RECENT = 8;

const isAux = (v) => typeof v === 'string' && /^A\d+$/.test(v);
const isScreen = (v) => typeof v === 'string' && /^S\d+$/.test(v);
const layerKey = (v) => (v == null ? null : String(v).trim().toUpperCase() || null);

/** `A1/1` — a follow's identity: the aux layer, which follows one thing at most. */
export const followKey = (f) => `${f.aux}/${f.layer}`;

/** `S1/2` — the leader, spelled as everywhere else in the app. */
export const leaderKey = (f) => `${f.from.id}/${f.from.layer}`;

/**
 * @typedef {{aux: string, layer: string, from: {id: string, layer: string}, mode: 'program'|'both'}} Follow
 */

/**
 * Coerce whatever was on disk into a list that cannot misbehave: bad rows are
 * dropped, keys are upper-cased, an unknown mode is `program`, and a second
 * row for the same aux layer is dropped — the first one stands.
 */
export function normalise(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.follows) ? raw.follows : [];
  const follows = [];
  const seen = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const aux = typeof entry.aux === 'string' ? entry.aux.trim().toUpperCase() : '';
    const layer = layerKey(entry.layer);
    const from = entry.from && typeof entry.from === 'object' ? entry.from : {};
    const id = typeof from.id === 'string' ? from.id.trim().toUpperCase() : '';
    const fromLayer = layerKey(from.layer);
    if (!isAux(aux) || !layer || !isScreen(id) || !fromLayer) continue;
    const f = { aux, layer, from: { id, layer: fromLayer }, mode: MODES.includes(entry.mode) ? entry.mode : 'program' };
    if (seen.has(followKey(f))) continue;
    seen.add(followKey(f));
    follows.push(f);
  }
  return { version: VERSION, follows };
}

/** The follow an aux layer has, or null. */
export function followOf(doc, aux, layer) {
  const key = `${aux}/${layerKey(layer)}`;
  return (doc.follows || []).find((f) => followKey(f) === key) || null;
}

/** A new document with that aux layer following `from` in `mode` — or following nothing, when `from` is null. */
export function setFollow(doc, aux, layer, from, mode = 'program') {
  const rest = (doc.follows || []).filter((f) => followKey(f) !== `${aux}/${layerKey(layer)}`);
  return normalise(from ? [...rest, { aux, layer, from, mode }] : rest);
}

/* ---------------------------------------------------------------- reading */

/** What a layer holds in one role right now: `{ value, letter, settled }`, or null when it has no such layer. */
export function sourceIn(store, id, layer, role) {
  const spec = sourceSpec(store);
  if (!spec || !fittedLayers(store, id).some((l) => l.key === layer)) return null;
  const banks = presetBanks(store, id);
  const letter = role === 'PROGRAM' ? banks.program : banks.preview;
  return { value: readValue(store, { id, bank: letter, layer }, spec), letter, settled: banks.settled };
}

/**
 * Where a follow stands, for the panel: each end's sources in the roles the
 * mode covers, whether they agree, and why it cannot act if it cannot.
 */
export function describe(store, f) {
  const roles = f.mode === 'both' ? ['PROGRAM', 'PREVIEW'] : ['PROGRAM'];
  const out = { roles: [], why: null };
  if (!fittedLayers(store, f.from.id).some((l) => l.key === f.from.layer)) {
    out.why = `${f.from.id} has no layer ${f.from.layer} now`;
    return out;
  }
  if (!fittedLayers(store, f.aux).some((l) => l.key === f.layer)) {
    out.why = `${f.aux} has no layer ${f.layer} now`;
    return out;
  }
  for (const role of roles) {
    const lead = sourceIn(store, f.from.id, f.from.layer, role);
    const mine = sourceIn(store, f.aux, f.layer, role);
    out.roles.push({ role, leader: lead && lead.value, aux: mine && mine.value, same: !!lead && !!mine && lead.value === mine.value });
  }
  return out;
}

/* ---------------------------------------------------------------- follower */

/**
 * The live half. Given the store, a way to read the current follows and a way
 * to send, this watches inbound frames and writes the aux layers into line.
 * It holds no timer; an idle follower costs a map lookup per frame.
 *
 * @param {{store: object, follows: () => Follow[], send: Function,
 *          onActivity?: Function, now?: () => number}} opts
 */
export function createFollower({ store, follows, send, onActivity = () => {}, now = () => Date.now() }) {
  /* Leader source path -> [{follow, buffer}]. */
  let index = new Map();
  /* Destination id -> its take node, the prefix every frame about its take sits under. */
  let watched = new Map();
  let builtFor = null;
  /* Destination id -> {program, settled} as last seen, to tell a take landing from noise. */
  const last = new Map();
  /* followKey -> Set of roles a write is owed in, made when both ends are at rest. */
  const owed = new Map();
  const notes = [];

  function note(n) {
    notes.unshift({ at: now(), ...n });
    notes.length = Math.min(notes.length, RECENT);
    onActivity(n);
  }

  /** The node a destination's take state lives under: the dialect's own status path, less `status/pp/<prop>`. */
  function takeNode(dialect, id) {
    const path = dialect.takeStatus(id, 'transition');
    return path.slice(0, -3);
  }

  function rebuild() {
    const list = follows() || [];
    const dialect = dialectFor(store);
    const spec = sourceSpec(store);
    const stamp = JSON.stringify([dialect ? dialect.id : null, list.map((f) => [followKey(f), leaderKey(f), f.mode])]);
    if (stamp === builtFor) return;
    builtFor = stamp;
    index = new Map();
    watched = new Map();
    if (!dialect || !spec) return;
    for (const f of list) {
      for (const buffer of dialect.bufferKeys) {
        const path = dialect.layerParamPath(f.from.id, buffer, f.from.layer, spec.path);
        if (!path) continue;
        const k = path.join('/');
        if (!index.has(k)) index.set(k, []);
        index.get(k).push({ follow: f, buffer });
      }
      for (const id of [f.from.id, f.aux]) {
        if (watched.has(id)) continue;
        watched.set(id, takeNode(dialect, id));
        /* What the take state is now, so the next frame can be told apart
           from a landing. Read, never acted on. ⚠️ Only true if this runs
           BEFORE that frame reaches the mirror — the session applies a frame
           and then dispatches it — which is why the page primes it whenever
           the list changes rather than waiting for the next frame. */
        if (!last.has(id)) {
          const b = presetBanks(store, id);
          last.set(id, { program: b.program, settled: b.settled });
        }
      }
    }
    /* One no longer watched is no longer kept current: forget it. */
    for (const id of [...last.keys()]) if (!watched.has(id)) last.delete(id);
    for (const k of [...owed.keys()]) if (!list.some((f) => followKey(f) === k)) owed.delete(k);
  }

  /**
   * The destinations a frame's path says something about the take state of.
   * Either may be the longer: a frame may carry one leaf or a whole node.
   */
  function takesOf(path) {
    const out = [];
    for (const [id, node] of watched) {
      if (path.length < 2) continue;
      const n = Math.min(node.length, path.length);
      let same = true;
      for (let i = 0; i < n; i++) if (String(node[i]) !== String(path[i])) { same = false; break; }
      if (same) out.push(id);
    }
    return out;
  }

  function owe(f, role) {
    const k = followKey(f);
    if (!owed.has(k)) owed.set(k, new Set());
    owed.get(k).add(role);
  }

  /**
   * Write one role of a follow from what the leader holds in it now. The
   * caller has checked the leader is at rest; the aux may not be, and then
   * the write is owed.
   */
  function write(f, role, value, cause) {
    const target = { id: f.aux, layer: f.layer };
    const plan = sourceCommands(store, [target], value, role);
    const midTake = plan.refused.find((r) => /mid-take/.test(r.why));
    if (midTake) {
      owe(f, role);
      note({ kind: 'owed', follow: f, role, value, why: `${f.aux} is mid-take; it follows when it lands`, cause });
      return 0;
    }
    if (plan.refused.length) {
      note({ kind: 'refused', follow: f, role, value, why: plan.refused[0].why, cause });
      return 0;
    }
    let sent = 0;
    for (const cmd of plan.cmds) if (send(cmd)) sent++;
    if (sent) note({ kind: 'sent', follow: f, role, value, cause });
    return sent;
  }

  /** Bring `roles` of a follow into line with the leader as it is now. */
  function bring(f, roles, cause) {
    const lead = presetBanks(store, f.from.id);
    if (!lead.settled) {
      for (const role of roles) owe(f, role);
      return 0;
    }
    let sent = 0;
    for (const role of roles) {
      const src = sourceIn(store, f.from.id, f.from.layer, role);
      if (!src) {
        note({ kind: 'refused', follow: f, role, why: `${f.from.id} has no layer ${f.from.layer}`, cause });
        continue;
      }
      sent += write(f, role, src.value, cause);
    }
    return sent;
  }

  /** Pay what is owed to every follow touching `id`, where both ends are now at rest. */
  function settleOwed(id) {
    for (const f of follows() || []) {
      const k = followKey(f);
      if (!owed.has(k) || (f.aux !== id && f.from.id !== id)) continue;
      if (!presetBanks(store, f.aux).settled || !presetBanks(store, f.from.id).settled) continue;
      const roles = [...owed.get(k)];
      owed.delete(k);
      bring(f, roles, 'owed');
    }
  }

  function onLeader(hits, value) {
    let sent = 0;
    for (const { follow: f, buffer } of hits) {
      const banks = presetBanks(store, f.from.id);
      const role = buffer === banks.program ? 'PROGRAM' : buffer === banks.preview ? 'PREVIEW' : null;
      if (!banks.settled) {
        /* No honest role mid-take. Owe both the mode covers; the landing
           settles it from whatever the screen then holds. */
        for (const r of f.mode === 'both' ? ['PROGRAM', 'PREVIEW'] : ['PROGRAM']) owe(f, r);
        continue;
      }
      if (!role) continue;
      if (f.mode === 'program' && role !== 'PROGRAM') continue;
      sent += write(f, role, value, 'source');
    }
    return sent;
  }

  function onTake(id) {
    const b = presetBanks(store, id);
    const prev = last.get(id);
    last.set(id, { program: b.program, settled: b.settled });
    if (!b.settled) return 0;
    const landed = !!prev && (!prev.settled || prev.program !== b.program);
    let sent = 0;
    if (landed) {
      for (const f of follows() || []) {
        if (f.from.id !== id) continue;
        sent += bring(f, f.mode === 'both' ? ['PROGRAM', 'PREVIEW'] : ['PROGRAM'], 'take');
      }
    }
    settleOwed(id);
    return sent;
  }

  /**
   * One frame from the session. Only the switcher's own frames count: this
   * page's outbound writes are not yet the switcher's state, and one it
   * refuses never comes back.
   */
  function onFrame(frame) {
    if (!frame || frame.dir === 'out' || !Array.isArray(frame.path)) return 0;
    rebuild();
    if (!index.size) return 0;
    const hits = index.get(frame.path.join('/'));
    if (hits) return onLeader(hits, frame.value);
    let sent = 0;
    for (const id of takesOf(frame.path)) sent += onTake(id);
    return sent;
  }

  /** A follow was just set: the operator asking, so bring it into line now. */
  function sync(f) {
    rebuild();
    return bring(f, f.mode === 'both' ? ['PROGRAM', 'PREVIEW'] : ['PROGRAM'], 'set');
  }

  /**
   * Index the list and note every end's take state as it is now. Call it when
   * the list changes and when the store arrives, so the first take after
   * either is seen landing. Writes nothing.
   */
  function prime() {
    rebuild();
  }

  return {
    onFrame,
    sync,
    prime,
    recent: () => notes.slice(),
    owed: () => [...owed].map(([k, roles]) => ({ key: k, roles: [...roles] })),
    /** Exposed for the tests. */
    size: () => { rebuild(); return index.size; }
  };
}
