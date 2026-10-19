/*
 * Transitions, per layer and across a screen — the rules, with no I/O in them.
 *
 * ## What the switcher has
 *
 * Every layer of every preset buffer carries its own transition, on both
 * platforms and under the same catalogue ids:
 *
 * - `transition.opening` / `transition.closing`: an effect (CUT, FADE, SLIDE,
 *   WIPE, CIRCLE, STRETCH) and a direction (`way`, eleven of them);
 * - `timing.opening` / `timing.closing`: a window, `start` and `end` in
 *   0–65535, saying when in the take this layer opens and closes. It is a
 *   fraction of the take, not a time;
 * - `speed.type`: the easing, linear or smooth.
 *
 * What belongs to the screen is only the take's duration — `takeUpTime` and
 * `takeDownTime` on LivePremier, one `takeTime` on Midra, tenths of a second —
 * and a memory recall replaces it with the time the memory was saved with. So
 * a window shown in seconds is only true for the take time it was read
 * against, and no layer can run longer than its screen's take.
 *
 * There is no per-layer take. Layer Lock's "take only" makes one by holding
 * every other layer equal to program, which is also what makes a time given to
 * it honestly per layer: the held layers have nothing to transition, so the
 * screen's take time governs only the layers that move.
 *
 * ## ⚠️ What no frame has shown yet
 *
 * Everything here is written and read back on simulators, whose output is a
 * placeholder picture. So: which buffer's copy a CLOSING is read from (the
 * outgoing one is the guess, and it is the buffer on air), what
 * `timing.ratio` does, whether a WIPE runs inside its layer's own box or
 * across the screen, and how the force flags change a layer that only swaps
 * source. The moves below assume a wipe stays inside its box — that is the
 * only reason "a wipe across the whole screen" needs working out at all — and
 * are behind the Experimental features switch until a frame has been watched.
 *
 * `docs/NOTES.md` (2026-10-19) has the reading this rests on.
 */

import { dialectFor } from './dialect.js';
import { listDestinations, presetBanks, readLayers } from './screens.js';
import { catalogueFor, fittedLayers, coerce, valuesFor } from './properties.js';

/** The top of a timing window: the whole take. */
export const FULL = 65535;

/** A take time, in tenths, the switcher accepts: 0–300 s on both platforms. */
export const MAX_TENTHS = 3000;

/**
 * The catalogue ids of a layer's transition, by what they mean. The two
 * catalogues use the same ids; only the enum spellings under them differ.
 */
export const IDS = Object.freeze({
  openingType: 'transition.opening.type',
  openingWay: 'transition.opening.way',
  closingType: 'transition.closing.type',
  closingWay: 'transition.closing.way',
  openingStart: 'timing.opening.start',
  openingEnd: 'timing.opening.end',
  closingStart: 'timing.closing.start',
  closingEnd: 'timing.closing.end',
  speed: 'speed.type'
});

/** The four directions a move across the screen can go, in the device's own spelling. */
export const ACROSS = Object.freeze(['LEFT_TO_RIGHT', 'RIGHT_TO_LEFT', 'UP_TO_BOTTOM', 'BOTTOM_TO_UP']);

/** `LEFT_TO_RIGHT` as `Left to right`; `UP_TO_BOTTOM` as `Top to bottom`. */
export const prettyWay = (v) => String(v || '')
  .replace(/^UP_TO_BOTTOM$/, 'TOP_TO_BOTTOM').replace(/^BOTTOM_TO_UP$/, 'BOTTOM_TO_TOP')
  .replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

/** `WIPE` as `Wipe`. */
export const prettyEffect = (v) => String(v || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

/**
 * Whether an effect has a direction worth offering. A cut and a fade go no
 * way at all; the rest are offered one. Which of the eleven a CIRCLE or a
 * STRETCH honours has not been seen on a frame.
 */
export const takesWay = (type) => Boolean(type) && type !== 'CUT' && type !== 'FADE';

/* ---------------------------------------------------------------- catalogue */

/** The catalogue spec for one of `IDS`, on whichever platform the store speaks. */
export function specOf(store, field) {
  const id = IDS[field];
  return (id && catalogueFor(store).layer.find((p) => p.id === id)) || null;
}

/** The effects a layer offers, in catalogue order. */
export const effectsOn = (store) => valuesFor(specOf(store, 'openingType'), store);

/** The directions a layer offers, in catalogue order. */
export const waysOn = (store) => valuesFor(specOf(store, 'openingWay'), store);

/**
 * The platform's spelling of an easing: `LINEAR` is `LINEAR_TRANSITION` on
 * LivePremier and `LINEAR` on Midra. Null when the platform has no such member.
 */
export function speedValue(store, word) {
  const values = valuesFor(specOf(store, 'speed'), store);
  return values.find((v) => v === word || v.startsWith(word + '_')) || null;
}

/* ---------------------------------------------------------------- take time */

/** A destination's take time in tenths, as the switcher holds it, or null. */
export function takeTenths(store, id) {
  const d = dialectFor(store);
  const path = d && d.fadeTimePath ? d.fadeTimePath(id) : null;
  const v = path ? store.get(path) : null;
  return Number.isFinite(v) ? v : null;
}

/** Seconds as tenths the switcher accepts, or null for anything that is not a time. */
export function tenthsOf(seconds) {
  if (seconds == null || String(seconds).trim() === '') return null;
  const n = Number(String(seconds).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(MAX_TENTHS, Math.round(n * 10));
}

/**
 * The writes that set a destination's take time to `tenths`, and the writes
 * that put back what it holds now — every path the dialect writes a time to
 * (both directions on LivePremier), each with its own value, so a screen whose
 * up and down times differ gets both back. Only paths that change are in
 * either list.
 */
export function takeTimeWrites(store, id, tenths) {
  const d = dialectFor(store);
  if (!d || !d.fadeCmds || !Number.isFinite(tenths)) return { set: [], restore: [] };
  const set = [];
  const restore = [];
  for (const cmd of d.fadeCmds(id, tenths)) {
    const was = store.get(cmd.path);
    if (was === cmd.value) continue;
    set.push(cmd);
    if (Number.isFinite(was)) restore.push({ path: cmd.path, value: was });
  }
  return { set, restore };
}

/* ------------------------------------------------------------------ windows */

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** A fraction of the take as the switcher's 0–65535. */
export const toUnits = (fraction) => Math.round(clamp01(Number(fraction) || 0) * FULL);

/** The switcher's 0–65535 as a fraction of the take. */
export const toFraction = (units) => clamp01((Number(units) || 0) / FULL);

/** A window's edge in seconds, against a take time in tenths. */
export const secondsAt = (units, tenths) => (Number.isFinite(tenths) ? (toFraction(units) * tenths) / 10 : null);

/**
 * Seconds into a take as the switcher's units, against a take time in tenths.
 * Null when there is no take time to measure against, or it is zero (a cut has
 * no inside to put a window in).
 */
export function unitsAt(seconds, tenths) {
  const n = Number(String(seconds ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(n) || !Number.isFinite(tenths) || tenths <= 0) return null;
  return toUnits((n * 10) / tenths);
}

/** The narrowest window a move hands out, so a layer off the canvas still has one. */
const MIN_SPAN = 1 / 100;

function span(a, b) {
  let start = clamp01(Math.min(a, b));
  let end = clamp01(Math.max(a, b));
  if (end - start < MIN_SPAN) {
    end = Math.min(1, start + MIN_SPAN);
    start = Math.min(start, end - MIN_SPAN);
  }
  return { start: toUnits(start), end: toUnits(end) };
}

/* ------------------------------------------------------------------- a look */

const dig = (node, tail) => tail.reduce((n, seg) => (n == null ? undefined : n[seg]), node);

function layerNode(store, id, letter, layer) {
  const d = dialectFor(store);
  const path = d ? d.layerParamPath(id, letter, layer, []) : null;
  return path ? store.get(path) : undefined;
}

/**
 * One layer's transition as one buffer holds it:
 * `{opening: {type, way}, closing: {type, way}, window: {opening: {start, end},
 * closing: {start, end}}, speed}`. Fields the mirror does not have are null.
 */
export function readLook(store, id, letter, layer) {
  const node = layerNode(store, id, letter, layer);
  const get = (field) => {
    const spec = specOf(store, field);
    const v = spec && node ? dig(node, spec.path) : undefined;
    return v === undefined ? null : v;
  };
  return {
    opening: { type: get('openingType'), way: get('openingWay') },
    closing: { type: get('closingType'), way: get('closingWay') },
    window: {
      opening: { start: get('openingStart'), end: get('openingEnd') },
      closing: { start: get('closingStart'), end: get('closingEnd') }
    },
    speed: get('speed')
  };
}

/** A look as `[field, value]` pairs, only the fields it names. `speed` is a word, `LINEAR` or `SMOOTH`. */
function fieldsOf(store, look) {
  const out = [];
  const add = (field, v) => { if (v !== undefined && v !== null && v !== '') out.push([field, v]); };
  if (look.opening) { add('openingType', look.opening.type); add('openingWay', look.opening.way); }
  if (look.closing) { add('closingType', look.closing.type); add('closingWay', look.closing.way); }
  const w = look.window || {};
  if (w.opening) { add('openingStart', w.opening.start); add('openingEnd', w.opening.end); }
  if (w.closing) { add('closingStart', w.closing.start); add('closingEnd', w.closing.end); }
  if (look.speed) add('speed', speedValue(store, look.speed));
  return out;
}

/**
 * The writes that give one layer's copy in one buffer `look` — a partial look:
 * only the fields it names, and only those that differ from what the mirror
 * holds, so a second call builds nothing. A value the catalogue refuses (an
 * effect one platform lacks) is left out rather than sent.
 */
export function lookWrites(store, id, letter, layer, look) {
  const d = dialectFor(store);
  if (!d || !look) return [];
  const node = layerNode(store, id, letter, layer);
  const out = [];
  for (const [field, raw] of fieldsOf(store, look)) {
    const spec = specOf(store, field);
    if (!spec) continue;
    const c = coerce(spec, raw, store);
    if (!c.ok) continue;
    if (node && dig(node, spec.path) === c.value) continue;
    const path = d.layerParamPath(id, letter, layer, spec.path);
    if (path) out.push({ path, value: c.value });
  }
  return out;
}

/** One effect, the same way in and out: what "take only with a wipe" means. */
export function effectLook(type, way) {
  if (!type) return null;
  const side = takesWay(type) && way ? { type, way } : { type };
  return { opening: { ...side }, closing: { ...side } };
}

/* -------------------------------------------------------------------- styles */

export const STYLES_VERSION = 1;
export const MAX_STYLES = 64;
export const MAX_STYLE_NAME = 40;

const isWindow = (w) => w && Number.isFinite(w.start) && Number.isFinite(w.end)
  && w.start >= 0 && w.end <= FULL && w.start <= w.end;
const word = (v) => (typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,40}$/.test(v) ? v : null);

/** A look from a document, keeping only what has the right shape. */
export function cleanLook(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const side = (s) => {
    if (!s || typeof s !== 'object' || !word(s.type)) return null;
    return word(s.way) ? { type: s.type, way: s.way } : { type: s.type };
  };
  const look = {};
  const opening = side(raw.opening);
  const closing = side(raw.closing);
  if (opening) look.opening = opening;
  if (closing) look.closing = closing;
  const w = raw.window && typeof raw.window === 'object' ? raw.window : {};
  const win = {};
  if (isWindow(w.opening)) win.opening = { start: w.opening.start, end: w.opening.end };
  if (isWindow(w.closing)) win.closing = { start: w.closing.start, end: w.closing.end };
  if (Object.keys(win).length) look.window = win;
  if (raw.speed === 'LINEAR' || raw.speed === 'SMOOTH') look.speed = raw.speed;
  return Object.keys(look).length ? look : null;
}

/**
 * Whatever was on disk, as a style list that cannot misbehave: named, unique
 * by name, each with a look that has at least one field. A bad entry is
 * dropped and the rest are kept.
 */
export function normaliseStyles(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.styles) ? raw.styles : [];
  const seen = new Set();
  const styles = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const name = typeof s.name === 'string' ? s.name.trim().slice(0, MAX_STYLE_NAME) : '';
    const look = cleanLook(s.look);
    if (!name || !look || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    styles.push({ name, look });
    if (styles.length >= MAX_STYLES) break;
  }
  return { version: STYLES_VERSION, styles };
}

/** A look's speed as the word a style keeps, from either platform's spelling. */
export const speedWord = (v) => (typeof v === 'string' ? (v.startsWith('LINEAR') ? 'LINEAR' : v.startsWith('SMOOTH') ? 'SMOOTH' : null) : null);

/** A layer's look as a style keeps it: the platform's speed spelling turned into a word. */
export function styleOf(look) {
  if (!look) return null;
  return cleanLook({ ...look, speed: speedWord(look.speed) });
}

/* --------------------------------------------------------------------- moves */

/**
 * What can be worked out across a screen from where its layers sit. Each is
 * written into one buffer's copy of every layer that shows something, and
 * nothing else about a layer changes.
 */
export const MOVES = Object.freeze([
  {
    id: 'wipe',
    label: 'Wipe across the screen',
    what: 'Each layer wipes in the part of the take when a line crossing the whole screen passes over it, with a linear speed, so the edge travels from layer to layer instead of every box wiping at once.'
  },
  {
    id: 'cascade',
    label: 'Cascade',
    what: 'The layers open and close one after another, each in its own slice of the take, keeping their own effects.'
  },
  {
    id: 'dip',
    label: 'Dip through the background',
    what: 'Every layer closes in the first part of the take and opens in the rest, keeping its own effect, so the screen passes through its background between looks.'
  },
  {
    id: 'reset',
    label: 'Whole take',
    what: 'Every layer’s windows back to the whole take, the switcher’s default. Effects and speeds are left alone.'
  }
]);

/** Orders a cascade can go in. `stack` is the device's own, bottom of the stack first. */
export const CASCADE_ORDERS = Object.freeze([
  { id: 'stack', label: 'Bottom layer first' },
  { id: 'stack-down', label: 'Top layer first' },
  { id: 'left', label: 'Left to right' },
  { id: 'right', label: 'Right to left' },
  { id: 'top', label: 'Top to bottom' },
  { id: 'bottom', label: 'Bottom to top' }
]);

/**
 * The layers a move is about: fitted, and showing something in program or
 * preview — a layer empty in both has nothing to open or close. Each with the
 * rectangle it enters by (preview's, if it shows something there) and the one
 * it leaves by (program's).
 */
function moving(store, dest, program, preview) {
  const pgm = new Map(readLayers(store, dest, program).map((l) => [l.key, l]));
  const pvw = new Map(readLayers(store, dest, preview).map((l) => [l.key, l]));
  const out = [];
  for (const l of fittedLayers(store, dest.id)) {
    const a = pvw.get(l.key);
    const b = pgm.get(l.key);
    const shows = (x) => Boolean(x && x.hasSource);
    if (!shows(a) && !shows(b)) continue;
    const enter = shows(a) ? a : b;
    const leave = shows(b) ? b : a;
    out.push({ key: l.key, enter: enter.rect, leave: leave.rect, stack: [...pvw.keys()].indexOf(l.key) });
  }
  return out;
}

/** Where a rectangle sits along a direction, as a fraction of the canvas: `{a, b}`, a first. */
function along(rect, way, canvas) {
  const W = canvas.width || 1;
  const H = canvas.height || 1;
  const l = rect.left / W;
  const r = (rect.left + rect.width) / W;
  const t = rect.top / H;
  const b = (rect.top + rect.height) / H;
  switch (way) {
    case 'RIGHT_TO_LEFT': return { a: 1 - r, b: 1 - l };
    case 'UP_TO_BOTTOM': return { a: t, b };
    case 'BOTTOM_TO_UP': return { a: 1 - b, b: 1 - t };
    default: return { a: l, b: r };
  }
}

function order(list, how) {
  const by = (f) => [...list].sort((x, y) => f(x) - f(y) || x.stack - y.stack);
  switch (how) {
    case 'stack-down': return by((x) => -x.stack);
    case 'left': return by((x) => x.enter.left);
    case 'right': return by((x) => -(x.enter.left + x.enter.width));
    case 'top': return by((x) => x.enter.top);
    case 'bottom': return by((x) => -(x.enter.top + x.enter.height));
    default: return by((x) => x.stack);
  }
}

/**
 * The looks a move gives a destination's layers: `{looks: [{layer, look}],
 * refused}`. Pure — it reads the mirror and writes nothing; `lookWrites` turns
 * each look into writes for whichever buffer the caller chose.
 *
 * @param {object} store
 * @param {string} id                 a destination key
 * @param {string} move               one of `MOVES`
 * @param {object} [opts]
 * @param {string} [opts.way]         wipe: one of `ACROSS`
 * @param {string} [opts.order]       cascade: one of `CASCADE_ORDERS`
 * @param {number} [opts.overlap]     cascade: 0–0.9, how much each slice overlaps the next
 * @param {number} [opts.split]       dip: 0.1–0.9, where closing ends and opening starts
 */
export function planMove(store, id, move, opts = {}) {
  const d = dialectFor(store);
  if (!d) return { looks: [], refused: 'the device store has not arrived' };
  const dest = listDestinations(store, { includeUnused: true }).find((x) => x.id === id);
  if (!dest) return { looks: [], refused: `${id} is not on this switcher` };
  const banks = presetBanks(store, id);
  const canvas = dest.canvas || { width: 1920, height: 1080 };

  if (move === 'reset') {
    const whole = { start: 0, end: FULL };
    return {
      looks: fittedLayers(store, id).map((l) => ({ layer: l.key, look: { window: { opening: { ...whole }, closing: { ...whole } } } })),
      refused: null
    };
  }

  const list = moving(store, dest, banks.program, banks.preview);
  if (!list.length) return { looks: [], refused: `${id}: no layer shows anything in program or preview` };

  if (move === 'wipe') {
    const way = ACROSS.includes(opts.way) ? opts.way : 'LEFT_TO_RIGHT';
    return {
      looks: list.map((x) => {
        const inn = along(x.enter, way, canvas);
        const out = along(x.leave, way, canvas);
        return {
          layer: x.key,
          look: {
            opening: { type: 'WIPE', way },
            closing: { type: 'WIPE', way },
            window: { opening: span(inn.a, inn.b), closing: span(out.a, out.b) },
            speed: 'LINEAR'
          }
        };
      }),
      refused: null
    };
  }

  if (move === 'cascade') {
    const sorted = order(list, opts.order);
    const n = sorted.length;
    const overlap = Math.min(0.9, Math.max(0, Number(opts.overlap) || 0));
    /* n slices of length `len`, each starting `len·(1−overlap)` after the
       last, end to end exactly the take. */
    const len = 1 / ((n - 1) * (1 - overlap) + 1);
    const step = len * (1 - overlap);
    return {
      looks: sorted.map((x, i) => {
        const w = span(i * step, i * step + len);
        return { layer: x.key, look: { window: { opening: { ...w }, closing: { ...w } } } };
      }),
      refused: null
    };
  }

  if (move === 'dip') {
    const s = typeof opts.split === 'number' ? opts.split : 0.5;
    const split = Math.min(0.9, Math.max(0.1, Number.isFinite(s) ? s : 0.5));
    return {
      looks: list.map((x) => ({
        layer: x.key,
        look: { window: { closing: span(0, split), opening: span(split, 1) } }
      })),
      refused: null
    };
  }

  return { looks: [], refused: `no such move: ${move}` };
}
