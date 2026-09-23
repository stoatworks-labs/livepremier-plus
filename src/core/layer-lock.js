/*
 * Layer locks and partial takes — the rules, with no I/O in them.
 *
 * The switcher has neither. A LivePremier TAKE swaps a destination's whole
 * program and preview buffers, every layer at once, and so does a Midra 4K's;
 * there is no per-layer take and no per-layer lock anywhere in either object
 * model. What each layer does have is a per-preset `transition` node
 * (opening and closing effects, and flags that choose *how* it transitions —
 * `FORCE_TRANSITION`, `FORCE_CROSS`, the depth-cut pair), which decides the
 * manner of a layer's change and never whether there is one.
 *
 * ## The one fact both features stand on
 *
 * **A layer that is identical in program and preview has nothing to
 * transition.** So:
 *
 * - **Lock** a layer by keeping its preview copy equal to its program copy.
 *   The take still swaps the buffers; the layer is the same on both sides of
 *   the swap.
 * - **Take only** some layers by making every *other* layer equal first, then
 *   taking, then putting those other layers' preview looks back into the new
 *   preview buffer.
 *
 * The switcher's own opinion of that is published per layer on LivePremier:
 * `layerList/items/<k>/status/pp/up` and `…/down` read `OFF`, `OPEN`,
 * `CLOSE`, `CROSS`, `FLYING` or `FLYING_DEPTH` — the vendor's own comment is
 * "Layer will do a … transition". A real Aquilon C (6.2.73) reported `CROSS`
 * for a layer on `LIVE_2` in one buffer and `LIVE_8` in the other at the same
 * geometry, and `OFF` for a layer that was `NONE` in both. `verdict()` reads
 * it so the panel can show the device agreeing. ⚠️ **The simulator reports
 * `OFF` for every layer whatever the buffers hold**, so on a simulator the
 * verdict proves nothing, and **no real frame has yet been asked about a
 * locked layer with a live source on it.**
 *
 * ## ⚠️ Letters, not roles, at the moment of writing
 *
 * Everything here resolves PROGRAM and PREVIEW through `presetBanks()` at the
 * moment it is asked, and refuses when the destination is mid-take — the same
 * refusal `core/properties.js` and `core/groups.js` make, for the same reason:
 * during a transition "preview" names no buffer honestly, and a write that
 * guesses lands on the output.
 */

import { dialectFor } from './dialect.js';
import { presetBanks } from './screens.js';
import { catalogueFor, fittedLayers } from './properties.js';
import { samePath } from './paths.js';

/** The stored shape's version, so a later change can migrate rather than guess. */
export const LOCKS_VERSION = 1;

/**
 * The take-group triggers a lock has to answer for. `xTakeUp`/`xTakeDown` are
 * the directional takes the RC400T sends; `xCut` swaps the same two buffers
 * with no effect, which moves an unlocked layer just as surely.
 *
 * Not the T-bar. A T-bar is a stream of positions rather than a trigger, and
 * there is no honest moment to hold one — see `plugins/layer-lock/engine.js`.
 */
export const TAKE_PROPS = Object.freeze(['xTake', 'xCut', 'xTakeUp', 'xTakeDown']);

const isDest = (v) => typeof v === 'string' && /^[SA]\d+$/.test(v);
const layerKey = (v) => (v == null ? null : String(v).trim().toUpperCase() || null);

/** `S1/2` — the same spelling `core/groups.js` uses for a member. */
export const lockKey = (id, layer) => `${id}/${layer}`;

/** `S1/2` back into its halves, or null. */
export function parseLockKey(key) {
  const m = /^([SA]\d+)\/([0-9]+|NATIVE)$/.exec(String(key || '').trim().toUpperCase());
  return m ? { id: m[1], layer: m[2] } : null;
}

/**
 * Whatever was on disk, as a lock list that cannot misbehave: known shapes
 * only, no duplicates, in a stable order. Nothing is rejected outright — a
 * hand-edited file with one bad row still keeps the rest of its locks.
 */
export function normalise(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.locks) ? raw.locks : [];
  const out = new Set();
  for (const entry of list) {
    const key = typeof entry === 'string' ? entry
      : entry && isDest(entry.id) ? lockKey(entry.id, layerKey(entry.layer)) : null;
    const parsed = parseLockKey(key);
    if (parsed) out.add(lockKey(parsed.id, parsed.layer));
  }
  return { version: LOCKS_VERSION, locks: [...out].sort(compareKeys) };
}

function compareKeys(a, b) {
  const pa = parseLockKey(a);
  const pb = parseLockKey(b);
  if (pa.id !== pb.id) {
    if (pa.id[0] !== pb.id[0]) return pa.id[0] === 'S' ? -1 : 1;
    return Number(pa.id.slice(1)) - Number(pb.id.slice(1));
  }
  if (pa.layer === 'NATIVE') return 1;
  if (pb.layer === 'NATIVE') return -1;
  return Number(pa.layer) - Number(pb.layer);
}

/** The locked layer keys on one destination. */
export function lockedOn(locks, id) {
  const out = [];
  for (const key of locks || []) {
    const p = parseLockKey(key);
    if (p && p.id === id) out.push(p.layer);
  }
  return out;
}

/** Every destination with at least one lock. */
export function lockedDestinations(locks) {
  const out = new Set();
  for (const key of locks || []) { const p = parseLockKey(key); if (p) out.add(p.id); }
  return [...out];
}

/**
 * Which destination a write takes, if it is a take — `{id, prop}` or null.
 *
 * The candidate is read off the path's shape and then **confirmed** by
 * building the dialect's own take path for it and comparing, so this can
 * never disagree with what `core/commands.js` sends.
 */
export function takeTarget(dialect, path, value = true) {
  if (!dialect || !Array.isArray(path) || value !== true) return null;
  const prop = path[path.length - 1];
  if (!TAKE_PROPS.includes(prop)) return null;
  let id = null;
  if (path[1] === 'screenAuxGroupList') id = path[3];
  else if (path[1] === 'transition') id = (path[2] === 'auxiliaryScreenList' ? 'A' : 'S') + path[4];
  if (!isDest(id)) return null;
  return samePath(dialect.takeControl(id, prop), path) ? { id, prop } : null;
}

/* ---------------------------------------------------------------- buffers */

const writable = (store) => catalogueFor(store).layer.filter((s) => !s.readOnly);
const dig = (node, tail) => tail.reduce((n, seg) => (n == null ? undefined : n[seg]), node);
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Only layers the destination really has; a preset carries all 128 slots. */
function fittedOnly(store, id, layers) {
  const fitted = new Set(fittedLayers(store, id).map((l) => l.key));
  return layers.map(String).filter((k) => fitted.has(k));
}

function layerNode(store, id, letter, key) {
  const dialect = dialectFor(store);
  const path = dialect.layerParamPath(id, letter, key, []);
  return path ? store.get(path) : undefined;
}

/**
 * The writes that make preview's copy of `layers` equal program's.
 *
 * Only properties that differ are written, and a property program does not
 * carry is left alone — that is what makes a follower built on this
 * convergent: a second call straight after the first builds nothing.
 *
 * @returns {{writes: Array<{path:string[], value:unknown}>, refused: string|null,
 *            program: string, preview: string}}
 */
export function syncWrites(store, id, layers) {
  const dialect = dialectFor(store);
  const banks = presetBanks(store, id);
  const base = { writes: [], refused: null, program: banks.program, preview: banks.preview };
  if (!dialect) return { ...base, refused: 'the device store has not arrived' };
  if (!banks.reported) return { ...base, refused: `${id}: the device has not said which buffer is preview` };
  if (!banks.settled) return { ...base, refused: `${id}: a take is in flight` };

  const specs = writable(store);
  for (const key of fittedOnly(store, id, layers)) {
    const pgm = layerNode(store, id, banks.program, key);
    const pvw = layerNode(store, id, banks.preview, key);
    if (!pgm) continue;
    for (const spec of specs) {
      const want = dig(pgm, spec.path);
      if (want === undefined) continue;
      if (same(want, dig(pvw, spec.path))) continue;
      const path = dialect.layerParamPath(id, banks.preview, key, spec.path);
      if (path) base.writes.push({ path, value: structuredClone(want) });
    }
  }
  return base;
}

/** True when every one of `layers` is the same in program and preview. */
export function inSync(store, id, layers) {
  const r = syncWrites(store, id, layers);
  return !r.refused && r.writes.length === 0;
}

/**
 * The writable properties of some layers of one buffer, as they stand — the
 * operator's preview look, kept so a partial take can put it back.
 */
export function snapshot(store, id, letter, layers) {
  const specs = writable(store);
  const out = {};
  for (const key of fittedOnly(store, id, layers)) {
    const node = layerNode(store, id, letter, key);
    if (!node) continue;
    const values = [];
    for (const spec of specs) {
      const v = dig(node, spec.path);
      if (v !== undefined) values.push([spec.path, structuredClone(v)]);
    }
    out[key] = values;
  }
  return out;
}

/**
 * The writes that put a `snapshot()` into a buffer — skipping what is already
 * there, so a restore over an unchanged layer sends nothing.
 */
export function restoreWrites(store, id, letter, snap) {
  const dialect = dialectFor(store);
  if (!dialect || !snap) return [];
  const out = [];
  for (const [key, values] of Object.entries(snap)) {
    const node = layerNode(store, id, letter, key);
    for (const [tail, value] of values) {
      if (same(value, dig(node, tail))) continue;
      const path = dialect.layerParamPath(id, letter, key, tail);
      if (path) out.push({ path, value });
    }
  }
  return out;
}

/**
 * What the switcher says a layer will do on the next take, where it says.
 *
 * LivePremier only; a Midra publishes no such field and gets null. Which of
 * `up`/`down` is "next" is inferred from the resting transition — at
 * `AT_DOWN` the next take goes up — and has not been confirmed on a frame
 * whose two values differed, so both are returned for the panel to show when
 * they disagree.
 */
export function verdict(store, id, key) {
  const dialect = dialectFor(store);
  if (!dialect || dialect.id !== 'nlc') return null;
  const node = store.get(['device', dialect.listNameFor(id), 'items', id, 'layerList', 'items', String(key), 'status', 'pp']);
  if (!node || (node.up === undefined && node.down === undefined)) return null;
  const transition = presetBanks(store, id).transition;
  const next = transition === 'AT_DOWN' ? node.up : transition === 'AT_UP' ? node.down : null;
  return { up: node.up ?? null, down: node.down ?? null, next: next ?? null };
}

/**
 * Split a list of `{id, layer}` targets into one plan per destination for a
 * partial take: which layers go, which are held, and why a target cannot go.
 *
 * A target that is itself locked is refused rather than quietly held — the
 * operator asked for it to move, and it would not.
 */
export function partialPlan(store, targets, locks = []) {
  const byDest = new Map();
  const refused = [];
  for (const t of targets || []) {
    if (!t || !isDest(t.id)) continue;
    const layer = layerKey(t.layer);
    if (!layer) continue;
    if (lockedOn(locks, t.id).includes(layer)) {
      refused.push(`${t.id} L${layer} is locked — unlock it to take it`);
      continue;
    }
    if (!byDest.has(t.id)) byDest.set(t.id, new Set());
    byDest.get(t.id).add(layer);
  }
  const plans = [];
  for (const [id, go] of byDest) {
    const fitted = fittedLayers(store, id).map((l) => l.key);
    const missing = [...go].filter((k) => !fitted.includes(k));
    for (const k of missing) refused.push(`${id} L${k} is not fitted`);
    const moving = [...go].filter((k) => fitted.includes(k));
    if (!moving.length) continue;
    const locked = lockedOn(locks, id);
    plans.push({
      id,
      go: moving,
      /* Everything else on the screen is held for the take; the locked ones
         already are, and are never restored — they were never the
         operator's preview look to begin with. */
      hold: fitted.filter((k) => !moving.includes(k)),
      restore: fitted.filter((k) => !moving.includes(k) && !locked.includes(k))
    });
  }
  return { plans, refused };
}
