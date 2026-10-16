/*
 * Surfaces — the part with no DOM and no I/O.
 *
 * A screen's canvas is one raster, but what it lands on is usually several
 * physical things: an LED wall in three pieces, a header strip, a pair of
 * IMAG screens either side. A **surface** is one of those, as a rectangle on
 * the canvas, and a layer **bound** to a surface is kept inside it — dragged,
 * nudged, typed, aligned or set to full screen, it ends up within the
 * surface's edges, and "full screen" means the surface, not the canvas.
 *
 * (Nothing to do with `src/vendor/surface/`, which is the MIDI mapper's
 * control surface. Two meanings of one word; this one is the LED kind.)
 *
 * ## The document
 *
 * Kept per switcher, like the pixel maps and for the same reason:
 *
 *   { version: 1, visible: true,
 *     surfaces: { S1: [{ id: '1', name: 'LED left', x: 0, y: 0, width: 1152, height: 1080 }] },
 *     bindings: { S1: { '2': '1' } } }
 *
 * Rectangles are in canvas pixels — the units a layer's own geometry is in.
 * A binding is a screen's layer SLOT, not a letter: it holds in A, B and C,
 * in program and in preview, and in the Edit page's programmer, because a
 * layer slot is the thing an operator thinks of as "the left wall layer".
 * Only numbered layers bind; NATIVE is the background plane, and the vendor's
 * own toolbar never moves it either.
 *
 * ## What "kept inside" means
 *
 * `constrain()` is the whole rule, and every caller uses it — the outbound
 * shaper in the socket hook, the Edit page's drag, the follower. One rule in
 * one place is how the vendor's page and ours come to agree about where a
 * bound layer may go.
 *
 * - **Too big for the surface** is made to fit: per axis, or keeping its
 *   shape when the change kept its shape (a keep-ratio corner drag).
 * - **A move** that would leave the surface stops at its edge.
 * - **A resize** keeps the edge or corner the operator was not dragging
 *   where it was, and stops the dragged one at the surface's edge.
 * - **The whole canvas** (the vendor's full screen, a memory saved full
 *   screen, any write that asks for exactly the canvas) becomes the whole
 *   surface.
 * - **An alignment** pressed on the vendor's toolbar is redone against the
 *   surface (`OPS`): "align centre" means the surface's centre. Without that,
 *   a centred layer would be pushed to the surface's nearest edge — inside,
 *   but not what was asked.
 */

import { anchorToTopLeft, topLeftToAnchor } from '../../src/core/screens.js';

export const EMPTY = Object.freeze({ version: 1, visible: true, surfaces: {}, bindings: {} });

/** How far outside a surface still counts as inside: a centred odd width lands on a half pixel. */
export const TOLERANCE = 1;

const DEST = /^[SA]\d+$/;
const LAYER = /^\d+$/;
const SURFACE_ID = /^\d+$/;
const NAME_MAX = 40;

/** The geometry properties of a LivePremier layer, all under `position/pp`. */
export const GEOMETRY = Object.freeze(['anchor', 'posH', 'posV', 'sizeH', 'sizeV']);

/* ------------------------------------------------------------ document */

const int = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

/** One surface, with every field valid, or null if it cannot be one. */
export function normaliseSurface(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const id = String(s.id ?? '');
  if (!SURFACE_ID.test(id)) return null;
  const x = int(s.x);
  const y = int(s.y);
  const width = int(s.width);
  const height = int(s.height);
  if (x == null || y == null || !(width >= 1) || !(height >= 1)) return null;
  const name = typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, NAME_MAX) : `Surface ${id}`;
  return { id, name, x, y, width, height };
}

/**
 * The stored document, made valid. Corrects rather than refuses, like every
 * other setting here: a hand-edited file with one bad surface keeps the
 * rest, and a binding to a surface that is not there is dropped.
 */
export function normalise(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const surfaces = {};
  const bindings = {};
  const src = d.surfaces && typeof d.surfaces === 'object' ? d.surfaces : {};
  for (const [id, list] of Object.entries(src)) {
    if (!DEST.test(id) || !Array.isArray(list)) continue;
    const seen = new Set();
    const kept = [];
    for (const entry of list) {
      const s = normaliseSurface(entry);
      if (s && !seen.has(s.id)) { seen.add(s.id); kept.push(s); }
    }
    if (kept.length) surfaces[id] = kept;
  }
  const bsrc = d.bindings && typeof d.bindings === 'object' ? d.bindings : {};
  for (const [id, map] of Object.entries(bsrc)) {
    if (!surfaces[id] || !map || typeof map !== 'object') continue;
    const ids = new Set(surfaces[id].map((s) => s.id));
    const kept = {};
    for (const [layer, sid] of Object.entries(map)) {
      if (LAYER.test(layer) && ids.has(String(sid))) kept[layer] = String(sid);
    }
    if (Object.keys(kept).length) bindings[id] = kept;
  }
  return { version: 1, visible: d.visible !== false, surfaces, bindings };
}

/** A destination's surfaces, in the order they were made. */
export const surfacesOf = (doc, id) => (doc.surfaces && doc.surfaces[id]) || [];

/** The surface a layer slot is bound to, or null. */
export function boundSurface(doc, id, layer) {
  const sid = doc.bindings && doc.bindings[id] && doc.bindings[id][String(layer)];
  return sid ? surfacesOf(doc, id).find((s) => s.id === sid) || null : null;
}

/** Every bound layer on a destination: `[{layer, surface}]`. */
export function boundLayers(doc, id) {
  const map = (doc.bindings && doc.bindings[id]) || {};
  return Object.keys(map)
    .map((layer) => ({ layer, surface: boundSurface(doc, id, layer) }))
    .filter((b) => b.surface);
}

/** Is anything bound anywhere? The shaper and the follower do nothing until it is. */
export const anyBound = (doc) => Object.keys(doc.bindings || {}).length > 0;

/** The document with a new surface on `id`; its id is the next free number. */
export function addSurface(doc, id, patch = {}) {
  const base = normalise(doc);
  const list = surfacesOf(base, id);
  const next = String(list.reduce((n, s) => Math.max(n, Number(s.id)), 0) + 1);
  const surface = normaliseSurface({ x: 0, y: 0, width: 1920, height: 1080, ...patch, id: next });
  if (!surface) return { doc: base, surface: null };
  return { doc: normalise({ ...base, surfaces: { ...base.surfaces, [id]: [...list, surface] } }), surface };
}

/** The document with one surface changed. A change that would make it invalid is not made. */
export function updateSurface(doc, id, sid, patch) {
  const base = normalise(doc);
  const list = surfacesOf(base, id).map((s) => {
    if (s.id !== sid) return s;
    return normaliseSurface({ ...s, ...patch, id: s.id }) || s;
  });
  return normalise({ ...base, surfaces: { ...base.surfaces, [id]: list } });
}

/** The document without one surface, and without the bindings to it. */
export function removeSurface(doc, id, sid) {
  const base = normalise(doc);
  const list = surfacesOf(base, id).filter((s) => s.id !== sid);
  return normalise({ ...base, surfaces: { ...base.surfaces, [id]: list } });
}

/** The document with one layer slot bound to a surface, or unbound with `sid` null. */
export function bind(doc, id, layer, sid) {
  const base = normalise(doc);
  const map = { ...((base.bindings && base.bindings[id]) || {}) };
  if (sid == null || sid === '') delete map[String(layer)];
  else map[String(layer)] = String(sid);
  return normalise({ ...base, bindings: { ...base.bindings, [id]: map } });
}

/**
 * One surface per output feeding a screen, from where each output sits on
 * the screen's canvas (`dialect.outputFormats`). An LED processor fed by one
 * output is often one element, which makes this the right first guess — and
 * only a guess, because one output can feed several elements.
 *
 * @param {object[]} outputs  `{n, label, x, y, cw, ch, screen}`
 * @param {string} id
 */
export function fromOutputs(outputs, id) {
  return outputs
    .filter((o) => o.screen === id && o.cw > 0 && o.ch > 0 && o.x != null && o.y != null)
    .sort((a, b) => a.n - b.n)
    .map((o) => ({ name: o.label || `Output ${o.n}`, x: o.x, y: o.y, width: o.cw, height: o.ch }));
}

/* ------------------------------------------------------------ geometry */

/** A layer's wire values as a top-left rectangle in canvas pixels. */
export function rectFromWire(w) {
  const { left, top } = anchorToTopLeft(w.anchor, w.posH, w.posV, w.sizeH, w.sizeV);
  return { left, top, width: w.sizeH, height: w.sizeV };
}

/** A rectangle as the wire values that put it there, for this anchor. Integers. */
export function wireFromRect(rect, anchor) {
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  const { posH, posV } = topLeftToAnchor(anchor, Math.round(rect.left), Math.round(rect.top), width, height);
  return { posH: Math.round(posH), posV: Math.round(posV), sizeH: width, sizeV: height };
}

/** Is `rect` within `s`, give or take `tol` pixels? */
export function inside(rect, s, tol = TOLERANCE) {
  return rect.left >= s.x - tol
    && rect.top >= s.y - tol
    && rect.left + rect.width <= s.x + s.width + tol
    && rect.top + rect.height <= s.y + s.height + tol;
}

const near = (a, b, tol = TOLERANCE) => Math.abs(a - b) <= tol;
const sameAspect = (a, b) => a.height > 0 && b.height > 0 && Math.abs(a.width / a.height - b.width / b.height) < 0.01;
const clamp = (v, lo, hi) => (hi < lo ? lo : Math.min(hi, Math.max(lo, v)));

/**
 * The vendor's toolbar buttons that are statements about the screen, by the
 * sprite id of their icon (the same in 6.1.60 and 6.2.73). `x`/`y` say where
 * on each axis the layer goes — the start, centre or end of the surface — and
 * `fill` that it covers the surface.
 *
 * ⚠️ The vendor names them by the LINE they align to: `horizontal-center` is
 * its `alignVerticalCenter`, the layer centred top to bottom on the
 * horizontal centre line.
 */
export const OPS = Object.freeze({
  'set-layer-to-fullscreen-18': { fill: true },
  'align-screen-top-left-18': { x: 'start', y: 'start' },
  'align-screen-top-18': { y: 'start' },
  'align-screen-top-right-18': { x: 'end', y: 'start' },
  'align-screen-horizontal-center-18': { y: 'centre' },
  'align-screen-left-18': { x: 'start' },
  'align-screen-middle-18': { x: 'centre', y: 'centre' },
  'align-screen-right-18': { x: 'end' },
  'align-screen-bottom-left-18': { x: 'start', y: 'end' },
  'align-screen-bottom-18': { y: 'end' },
  'align-screen-bottom-right-18': { x: 'end', y: 'end' },
  'align-screen-vertical-center-18': { x: 'centre' }
});

const place = (where, start, span, size) =>
  where === 'start' ? start : where === 'end' ? start + span - size : start + (span - size) / 2;

/**
 * The fraction of a box that stays put while it is resized, on one axis:
 * 0 its near edge, 1 its far edge, 0.5 its centre. Read off which edge moved.
 */
function pivot(before, req, axis) {
  const [lo, len] = axis === 'x' ? ['left', 'width'] : ['top', 'height'];
  const keptNear = near(req[lo], before[lo]);
  const keptFar = near(req[lo] + req[len], before[lo] + before[len]);
  if (keptNear && !keptFar) return 0;
  if (keptFar && !keptNear) return 1;
  return 0.5;
}

/** The longest span a box may have on one axis, resized about `fixed` inside [lo, lo+span]. */
function room(fixed, frac, lo, span) {
  const hi = lo + span;
  if (fixed < lo - TOLERANCE || fixed > hi + TOLERANCE) return null;
  const a = frac < 1 ? (hi - fixed) / (1 - frac) : Infinity;
  const b = frac > 0 ? (fixed - lo) / frac : Infinity;
  return Math.max(1, Math.min(a, b));
}

/**
 * Keep a requested rectangle inside a surface.
 *
 * @param {{left:number, top:number, width:number, height:number}} req   where it was asked to go
 * @param {{x:number, y:number, width:number, height:number}} s           the surface
 * @param {object} [opts]
 * @param {object|null} [opts.before]  where it was, if known: tells a move from a resize
 * @param {object|null} [opts.op]      an `OPS` entry, when a toolbar button asked
 * @param {{width:number, height:number}|null} [opts.canvas]  the screen's raster
 * @returns {{left:number, top:number, width:number, height:number}}  `req` itself when it needs nothing
 */
export function constrain(req, s, { before = null, op = null, canvas = null } = {}) {
  const whole = canvas && canvas.width > 0 && near(req.left, 0) && near(req.top, 0)
    && near(req.width, canvas.width) && near(req.height, canvas.height);
  if ((op && op.fill) || whole) return { left: s.x, top: s.y, width: s.width, height: s.height };
  /* Already inside — handed back as it came, not re-rounded: a centred
     layer of odd width sits on a half pixel, and rounding it again would
     move every write that was fine by one. */
  if (!op && inside(req, s, 0.5)) return req;

  let { left, top, width, height } = req;
  const resized = before && (!near(req.width, before.width) || !near(req.height, before.height));
  /* Which edge was dragged only means something for a layer that was inside
     to begin with. One straddling two surfaces has no edge "on" this one,
     and keeping its centre would leave no room at all. */
  const fromInside = resized && inside(before, s);

  if (op) {
    /* An alignment: the size it already has, made to fit, then placed. */
    const k = Math.min(1, s.width / width, s.height / height);
    width *= k; height *= k;
    if (op.x) left = place(op.x, s.x, s.width, width);
    if (op.y) top = place(op.y, s.y, s.height, height);
  } else if (fromInside) {
    /* A resize: the edge that did not move stays where it is, and the box
       grows from it only as far as the surface goes. */
    const fx = pivot(before, req, 'x');
    const fy = pivot(before, req, 'y');
    const ax = req.left + fx * req.width;
    const ay = req.top + fy * req.height;
    const maxW = room(ax, fx, s.x, s.width);
    const maxH = room(ay, fy, s.y, s.height);
    if (maxW != null && maxH != null) {
      if (sameAspect(before, req)) {
        const k = Math.min(1, maxW / width, maxH / height);
        width *= k; height *= k;
      } else {
        width = Math.min(width, maxW);
        height = Math.min(height, maxH);
      }
      left = ax - fx * width;
      top = ay - fy * height;
    }
  }

  /* Whatever got here: no bigger than the surface — keeping its shape unless
     the request changed the shape — and then moved in from any edge it is
     past. This is all a plain move needs. */
  if (width > s.width || height > s.height) {
    if (resized && !sameAspect(before, req)) {
      width = Math.min(width, s.width);
      height = Math.min(height, s.height);
    } else {
      const k = Math.min(s.width / width, s.height / height);
      const cx = left + width / 2;
      const cy = top + height / 2;
      width *= k; height *= k;
      left = cx - width / 2;
      top = cy - height / 2;
    }
  }
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  left = clamp(Math.round(left), s.x, s.x + s.width - width);
  top = clamp(Math.round(top), s.y, s.y + s.height - height);
  return { left, top, width, height };
}

/* ------------------------------------------------------------- the wire */

/**
 * A LivePremier layer geometry write, taken apart, or null if it is not one:
 *
 *   ["device", "screenList", "items", "S1", "presetList", "items", "B",
 *    "layerList", "items", "2", "position", "pp", "posH"]
 *
 * The buffer is whatever the path names — a letter, or the programmer's
 * `EDIT` — because a bound layer is bound in all of them.
 */
export function parseGeometry(path) {
  if (!Array.isArray(path) || path.length !== 13) return null;
  if (path[0] !== 'device' || path[2] !== 'items' || path[4] !== 'presetList' || path[5] !== 'items') return null;
  if (path[7] !== 'layerList' || path[8] !== 'items' || path[10] !== 'position' || path[11] !== 'pp') return null;
  if (path[1] !== 'screenList' && path[1] !== 'auxiliaryList') return null;
  const prop = path[12];
  if (!GEOMETRY.includes(prop)) return null;
  return { id: path[3], buffer: path[6], layer: String(path[9]), prop, base: path.slice(0, 12) };
}

/**
 * Shape a run of writes so no bound layer leaves its surface.
 *
 * Every write in `cmds` comes back, in order, with its value made safe; a
 * property the run did not write but the rule had to move (the position,
 * when only a size was sent) is added straight after that layer's last
 * write. Writes to anything else come back untouched, as the same objects.
 *
 * @param {{path: string[], value: unknown}[]} cmds
 * @param {object} o
 * @param {object} o.doc                       the normalised document
 * @param {(path: string[]) => unknown} o.read what the buffer holds now
 * @param {(id: string) => object|null} [o.canvasOf]
 * @param {object|null} [o.op]                 an `OPS` entry the operator just pressed
 * @param {(id: string, layer: string) => boolean} [o.exempt]  a layer another feature owns
 * @returns {{path: string[], value: unknown, shaped?: boolean}[]}
 */
export function shapeWrites(cmds, { doc, read, canvasOf = () => null, op = null, exempt = () => false }) {
  const groups = new Map();
  cmds.forEach((cmd, i) => {
    const g = parseGeometry(cmd && cmd.path);
    if (!g) return;
    const surface = boundSurface(doc, g.id, g.layer);
    if (!surface || exempt(g.id, g.layer)) return;
    const key = g.base.join('/');
    if (!groups.has(key)) groups.set(key, { ...g, surface, writes: [], last: i });
    const group = groups.get(key);
    group.writes.push({ i, prop: g.prop, value: cmd.value });
    group.last = i;
  });
  if (!groups.size) return cmds;

  const out = cmds.map((cmd) => cmd);
  const extras = new Map();
  for (const group of groups.values()) {
    const at = (prop) => [...group.base, prop];
    const before = {};
    for (const prop of GEOMETRY) before[prop] = read(at(prop));
    const asked = { ...before };
    for (const w of group.writes) asked[w.prop] = w.value;
    const nums = ['posH', 'posV', 'sizeH', 'sizeV'];
    if (nums.some((p) => typeof asked[p] !== 'number')) continue;

    const anchor = asked.anchor || 'MIDDLE_CENTER';
    const req = rectFromWire({ ...asked, anchor });
    const prev = nums.every((p) => typeof before[p] === 'number')
      ? rectFromWire({ ...before, anchor: before.anchor || 'MIDDLE_CENTER' })
      : null;
    const target = constrain(req, group.surface, { before: prev, op, canvas: canvasOf(group.id) });
    if (target === req) continue;
    const wire = wireFromRect(target, anchor);
    if (nums.every((p) => wire[p] === asked[p])) continue;

    const written = new Set(group.writes.map((w) => w.prop));
    for (const w of group.writes) {
      if (w.prop === 'anchor' || wire[w.prop] === w.value) continue;
      out[w.i] = { ...cmds[w.i], value: wire[w.prop], shaped: true };
    }
    /* Sizes before positions: a box that shrinks and then moves never
       passes through a rectangle bigger than the one it ends as. */
    const added = ['sizeH', 'sizeV', 'posH', 'posV']
      .filter((p) => !written.has(p) && wire[p] !== asked[p])
      .map((p) => ({ path: at(p), value: wire[p], shaped: true }));
    if (added.length) extras.set(group.last, [...(extras.get(group.last) || []), ...added]);
  }

  if (!extras.size) return out;
  const result = [];
  out.forEach((cmd, i) => {
    result.push(cmd);
    if (extras.has(i)) result.push(...extras.get(i));
  });
  return result;
}

/**
 * Where a bound layer is on one buffer, and whether that is inside its
 * surface — for the follower, the panel's warnings and the outlines.
 *
 * @returns {{rect, wire, surface, inside: boolean} | null}
 */
export function standing(doc, read, base, id, layer) {
  const surface = boundSurface(doc, id, layer);
  if (!surface) return null;
  const wire = {};
  for (const prop of GEOMETRY) wire[prop] = read([...base, prop]);
  if (['posH', 'posV', 'sizeH', 'sizeV'].some((p) => typeof wire[p] !== 'number')) return null;
  const rect = rectFromWire({ ...wire, anchor: wire.anchor || 'MIDDLE_CENTER' });
  return { rect, wire, surface, inside: inside(rect, surface) };
}
