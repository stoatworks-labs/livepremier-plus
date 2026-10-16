/*
 * UMD Generator — the part with no DOM and no I/O.
 *
 * A UMD here is what an ATEM multiviewer draws over its windows: a thin line
 * round each picture and a dark tab with the source's name along its bottom
 * edge. A switcher's aux laid out as a multiviewer has the pictures and none
 * of the furniture, so this draws the furniture as one transparent PNG the
 * size of the destination's canvas, from where each layer really is and what
 * it really shows, and the switcher shows it over (or under) the layers.
 *
 * ## Where the picture goes, and why it differs
 *
 * - **An aux: its top layer.** An aux has no background a picture can reach.
 *   Its NATIVE layer is never allocated — the preconfig gives it no capacity
 *   at any aux capability (6.2.73 simulator, 2026-10-16) — the vendor's own
 *   client allows it no source but NONE (`allowedAuxBackgroundLayerSourceTypes`),
 *   and `preconfig/backgrounds` has background sets for screens only. So the
 *   UMD is a still on the aux's highest fitted layer, full canvas, over the
 *   pictures, and the layers under it are the boxes.
 * - **A screen: its background.** A background costs no mixer, and a screen's
 *   layers are what it is for. A background set is per output, cut to each
 *   output's raster — which is the Background Slicer's whole job, so the
 *   picture is handed to it rather than cut twice. Under the layers, a label
 *   inside a box is hidden by the box: `below` is the label position that
 *   shows, and the plan says which labels a layer covers.
 *
 * ## Templates, and the aux's layer count
 *
 * An aux's layers come with its capability, two at a time: an advanced aux at
 * 4K gets 2 layers, 5K 4, `6` 6 and 8K 8 (a non-advanced one gets one layer of
 * the whole capability) — read off the 6.2.73 simulator's resources check,
 * 2026-10-16. With the top one spent on the UMD, that leaves 1, 3, 5 or 7
 * boxes, which is why the templates come in those sizes. A template is cells
 * as fractions of the canvas, each `[x, y, size]` with one size for both
 * sides, so every box keeps the canvas's shape and a 16:9 source is never
 * squashed into it. Adding one is adding a line to `TEMPLATES`.
 *
 * ## The document
 *
 * Per switcher, like the layer names:
 *
 *   { version: 1,
 *     style: { border: true, borderWidth: 0, borderColour: '#ffffff', textScale: 1,
 *              uppercase: false, tabOpacity: 0.7, labelFrom: 'source' },
 *     dests: { A1: { buffer: 'preview', labels: 'bottom', template: 'three-two-over-one',
 *                    gap: 0, names: { '2': 'CAM 2' },
 *                    placed: { slot, still, layer, fingerprint } } } }
 *
 * `borderWidth` 0 is "automatic": two pixels at 1080, scaled with the canvas.
 * `placed` is what this app last put on the switcher for that destination, so
 * a fresh UMD reuses the same library slot and still rather than taking
 * another pair each time, and the panel can say when the one on air is stale.
 */

import { ROOT } from '../../src/core/paths.js';
import { dialectFor } from '../../src/core/dialect.js';
import { readLayers, topLeftToAnchor } from '../../src/core/screens.js';
import { CAPACITY_UNITS, likelyCapability } from '../../src/core/stills.js';
import { same } from '../../src/core/wire.js';

/* ================================================================ options */

export const LABEL_MODES = [
  { id: 'bottom', label: 'Inside, bottom', what: 'A dark tab along the bottom edge of each box, as an ATEM multiviewer draws it.' },
  { id: 'top', label: 'Inside, top', what: 'The same tab along the top edge.' },
  { id: 'below', label: 'Under the box', what: 'Under-monitor: the tab sits in the gap under the box. The only labels a screen background can show, since the layers cover their own boxes.' },
  { id: 'none', label: 'No labels', what: 'Borders only.' }
];

export const LABEL_FROM = [
  { id: 'source', label: 'Source name', what: 'The input’s or still’s own label, as the switcher has it.' },
  { id: 'layer', label: 'Layer name', what: 'The layer’s name from Layer names, where it has one; the source’s otherwise.' }
];

export const BUFFERS = [
  { id: 'preview', label: 'PRW', what: 'Read the preview buffer, and put the UMD there. Take it when you are happy.' },
  { id: 'program', label: 'PGM', what: 'Read the program buffer, and put the UMD straight on air.' }
];

export const DEFAULT_STYLE = Object.freeze({
  border: true,
  borderWidth: 0,
  borderColour: '#ffffff',
  textScale: 1,
  uppercase: false,
  tabOpacity: 0.7,
  labelFrom: 'source'
});

export const DEFAULT_DEST = Object.freeze({ buffer: 'preview', labels: null, template: null, gap: 0, names: {}, placed: null });

export const EMPTY = Object.freeze({ version: 1, style: DEFAULT_STYLE, dests: {} });

/* ============================================================== templates */

const third = 1 / 3;
const sixth = 1 / 6;

/**
 * The layouts, by how many boxes. `cells` are `[x, y, size]` as fractions of
 * the canvas; a box is `size` of the canvas wide AND high, so it has the
 * canvas's own aspect. Listed in the order the panel offers them.
 */
export const TEMPLATES = [
  { id: 'one-full', boxes: 1, label: 'Full', what: 'One picture, the whole canvas.', cells: [[0, 0, 1]] },
  { id: 'one-inset', boxes: 1, label: 'Inset', what: 'One picture with room under it for its label.', cells: [[1 / 12, 1 / 24, 5 / 6]] },
  {
    id: 'three-two-over-one', boxes: 3, label: 'Two over one', what: 'Two halves on top, one centred under them.',
    cells: [[0, 0, 0.5], [0.5, 0, 0.5], [0.25, 0.5, 0.5]]
  },
  {
    id: 'three-one-over-two', boxes: 3, label: 'One over two', what: 'A big picture on top, two thirds under it.',
    cells: [[sixth, 0, 2 * third], [sixth, 2 * third, third], [0.5, 2 * third, third]]
  },
  {
    id: 'three-side', boxes: 3, label: 'One and two', what: 'A big picture on the left, two stacked on the right.',
    cells: [[0, sixth, 2 * third], [2 * third, sixth, third], [2 * third, 0.5, third]]
  },
  {
    id: 'five-two-over-three', boxes: 5, label: 'Two over three', what: 'Two halves on top, three thirds under them.',
    cells: [[0, 0, 0.5], [0.5, 0, 0.5], [0, 7 / 12, third], [third, 7 / 12, third], [2 * third, 7 / 12, third]]
  },
  {
    id: 'five-one-over-four', boxes: 5, label: 'One over four', what: 'A big picture on top, four quarters under it.',
    cells: [[sixth, 0, 2 * third], [0, 17 / 24, 0.25], [0.25, 17 / 24, 0.25], [0.5, 17 / 24, 0.25], [0.75, 17 / 24, 0.25]]
  },
  {
    id: 'seven-quad', boxes: 7, label: 'Three and four', what: 'Three quadrants, the fourth split in four — an ATEM layout.',
    cells: [[0, 0, 0.5], [0.5, 0, 0.5], [0, 0.5, 0.5], [0.5, 0.5, 0.25], [0.75, 0.5, 0.25], [0.5, 0.75, 0.25], [0.75, 0.75, 0.25]]
  },
  {
    id: 'seven-three-over-four', boxes: 7, label: 'Three over four', what: 'Three thirds on top, four quarters under them.',
    cells: [[0, sixth, third], [third, sixth, third], [2 * third, sixth, third],
      [0, 7 / 12, 0.25], [0.25, 7 / 12, 0.25], [0.5, 7 / 12, 0.25], [0.75, 7 / 12, 0.25]]
  }
];

const TEMPLATE_IDS = new Set(TEMPLATES.map((t) => t.id));
export const templateById = (id) => TEMPLATES.find((t) => t.id === id) || null;

/**
 * A template's boxes in canvas pixels, whole numbers. `gap` (pixels) shrinks
 * each box about its centre, keeping its shape, so neighbours stand apart.
 */
export function templateRects(template, canvas, gap = 0) {
  const W = canvas.width;
  const H = canvas.height;
  return template.cells.map(([x, y, size]) => {
    const w = size * W;
    const h = size * H;
    const k = gap > 0 && w > gap ? (w - gap) / w : 1;
    const cx = (x + size / 2) * W;
    const cy = (y + size / 2) * H;
    const left = Math.round(cx - (w * k) / 2);
    const top = Math.round(cy - (h * k) / 2);
    return { left, top, width: Math.round(cx + (w * k) / 2) - left, height: Math.round(cy + (h * k) / 2) - top };
  });
}

/* ============================================================== the doc */

const DEST = /^[SA]\d+$/;
const ids = (list) => new Set(list.map((x) => x.id));
const LABEL_IDS = ids(LABEL_MODES);
const FROM_IDS = ids(LABEL_FROM);
const BUFFER_IDS = ids(BUFFERS);
const NAME_MAX = 32;

const clamp = (v, lo, hi, dflt) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const colour = (v, dflt) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : dflt);
const posInt = (v) => (Number.isInteger(v) && v >= 1 ? v : null);

export function normaliseStyle(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    border: s.border !== false,
    borderWidth: Math.round(clamp(s.borderWidth, 0, 32, 0)),
    borderColour: colour(s.borderColour, DEFAULT_STYLE.borderColour),
    textScale: Math.round(clamp(s.textScale, 0.5, 2, 1) * 100) / 100,
    uppercase: s.uppercase === true,
    tabOpacity: Math.round(clamp(s.tabOpacity, 0, 1, DEFAULT_STYLE.tabOpacity) * 100) / 100,
    labelFrom: FROM_IDS.has(s.labelFrom) ? s.labelFrom : DEFAULT_STYLE.labelFrom
  };
}

function normalisePlaced(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const slot = posInt(raw.slot);
  const still = posInt(raw.still);
  if (!slot || !still) return null;
  return {
    slot, still,
    layer: typeof raw.layer === 'string' && raw.layer ? raw.layer : null,
    letter: typeof raw.letter === 'string' && raw.letter ? raw.letter : null,
    fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : null
  };
}

export function normaliseDest(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const names = {};
  for (const [k, v] of Object.entries(d.names && typeof d.names === 'object' ? d.names : {})) {
    const text = typeof v === 'string' ? v.trim().slice(0, NAME_MAX) : '';
    if (/^\d+$/.test(k) && text) names[k] = text;
  }
  return {
    buffer: BUFFER_IDS.has(d.buffer) ? d.buffer : DEFAULT_DEST.buffer,
    labels: LABEL_IDS.has(d.labels) ? d.labels : null,
    template: TEMPLATE_IDS.has(d.template) ? d.template : null,
    gap: Math.round(clamp(d.gap, 0, 200, 0)),
    names,
    placed: normalisePlaced(d.placed)
  };
}

/** The stored document, made valid; a bad field is corrected, the rest kept. */
export function normalise(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const dests = {};
  for (const [id, entry] of Object.entries(d.dests && typeof d.dests === 'object' ? d.dests : {})) {
    if (DEST.test(id)) dests[id] = normaliseDest(entry);
  }
  return { version: 1, style: normaliseStyle(d.style), dests };
}

/** The document with one destination's entry changed. */
export function withDest(doc, id, patch) {
  const base = normalise(doc);
  const prev = base.dests[id] || normaliseDest(null);
  const names = patch.names ? { ...prev.names, ...patch.names } : prev.names;
  return { ...base, dests: { ...base.dests, [id]: normaliseDest({ ...prev, ...patch, names }) } };
}

/** The document with the shared style changed. */
export const withStyle = (doc, patch) => {
  const base = normalise(doc);
  return { ...base, style: normaliseStyle({ ...base.style, ...patch }) };
};

/* ======================================================== the destination */

/** Where the UMD goes on a destination: an aux's top layer, a screen's background. */
export const targetOf = (id) => (String(id).startsWith('A') ? 'layer' : 'background');

/** The label position in force: the destination's own, else the one that shows there. */
export const labelsFor = (id, entry) => (entry && entry.labels) || (targetOf(id) === 'layer' ? 'bottom' : 'below');

/** The fitted layers that can hold a picture, bottom first — NATIVE is not one. */
export function pictureLayers(store, id) {
  const dialect = dialectFor(store);
  if (!dialect) return [];
  return dialect.fittedLayers(store, id)
    .filter((l) => !l.isNative)
    .map((l) => l.key)
    .sort((a, b) => Number(a) - Number(b));
}

/**
 * Which layer carries the UMD, and how many are left for boxes.
 *
 * ⚠️ "Top" is the highest layer number, as the vendor's own layer list stacks
 * them; `core/screens.js` notes it was first seen with one layer only.
 */
export function layerPlan(store, id) {
  const layers = pictureLayers(store, id);
  if (targetOf(id) !== 'layer') return { layers, umd: null, boxes: layers };
  if (layers.length < 2) return { layers, umd: layers[layers.length - 1] || null, boxes: [] };
  return { layers, umd: layers[layers.length - 1], boxes: layers.slice(0, -1) };
}

/** The templates that fit a destination: no more boxes than it has layers for. */
export const templatesFor = (boxLayers) => TEMPLATES.filter((t) => t.boxes <= boxLayers);

/* ================================================================ labels */

/** Every source's name as the switcher has it: inputs, stills, screens. */
export function sourceNames(store) {
  const dialect = dialectFor(store);
  const out = new Map();
  if (!dialect) return out;
  for (const s of (dialect.sources ? dialect.sources(store) : [])) out.set(s.value, s.label);
  const screens = store.get([ROOT, 'screenList', 'items']) || {};
  for (const [k, node] of Object.entries(screens)) {
    const m = /^S(\d+)$/.exec(k);
    const label = node && node.control && node.control.pp && node.control.pp.label;
    if (m) out.set(`SCREEN_${m[1]}`, label || k);
  }
  return out;
}

/** What one box is called: its own name, else the layer's, else its source's. */
export function boxText(box, { id, names = {}, layerNames = {}, sources = new Map(), labelFrom = 'source', store = null }) {
  const own = names[box.key];
  if (own) return own;
  if (labelFrom === 'layer') {
    const layer = layerNames[`${id}/${box.key}`];
    if (layer) return layer;
  }
  const known = sources.get(box.source);
  if (known) return known;
  const dialect = dialectFor(store);
  const short = dialect ? dialect.sourceLabel(box.source) : '';
  return short || '';
}

/**
 * The boxes of one buffer: every picture layer showing something, bar the
 * one the UMD goes on. A layer with no source is left out — it shows no
 * picture — unless it has been given a name, which is how a box is labelled
 * before its source is chosen. A layer at zero opacity shows nothing either.
 */
export function readBoxes(store, dest, letter, { umd = null, names = {}, layerNames = {}, labelFrom = 'source' } = {}) {
  const sources = sourceNames(store);
  const out = [];
  for (const layer of readLayers(store, dest, letter)) {
    if (layer.isNative || layer.key === umd) continue;
    if (!layer.hasSource && !names[layer.key]) continue;
    if (layer.opacity <= 0) continue;
    const rect = {
      left: Math.round(layer.rect.left), top: Math.round(layer.rect.top),
      width: Math.round(layer.rect.width), height: Math.round(layer.rect.height)
    };
    if (rect.width <= 0 || rect.height <= 0) continue;
    const box = { key: layer.key, source: layer.source, rect };
    box.text = boxText(box, { id: dest.id, names, layerNames, sources, labelFrom, store });
    out.push(box);
  }
  return out;
}

/* ================================================================ layout */

const MONO_CHAR = 0.6;
/** A stand-in for text measuring: average glyph width. The page measures for real. */
export const roughMeasure = (text, px) => String(text).length * px * MONO_CHAR;

const ELLIPSIS = '…';

/** Overlap of two rects, or null. */
export function intersect(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

/** The automatic border: 2 px at 1080 lines, in proportion, never under 1. */
export const autoBorder = (canvas) => Math.max(1, Math.round(canvas.height / 540));

/**
 * The bands of one box's border, as filled rects so every edge lands on whole
 * pixels. Over the pictures (`layer`) the line is centred on the box's edge,
 * so two boxes that touch share one line, as on an ATEM; under them
 * (`background`) it is wholly outside, or the layer would cover it.
 */
export function borderBands(rect, bw, target, canvas) {
  const out = target === 'background' ? bw : Math.floor(bw / 2);
  const inn = bw - out;
  const L = rect.left - out;
  const T = rect.top - out;
  const R = rect.left + rect.width + out;
  const B = rect.top + rect.height + out;
  const t = out + inn;
  const bands = [
    { left: L, top: T, width: R - L, height: t },
    { left: L, top: B - t, width: R - L, height: t },
    { left: L, top: T + t, width: t, height: B - T - 2 * t },
    { left: R - t, top: T + t, width: t, height: B - T - 2 * t }
  ];
  const view = { left: 0, top: 0, width: canvas.width, height: canvas.height };
  return bands.map((b) => intersect(b, view)).filter(Boolean);
}

/**
 * Everything the picture holds, worked out before it is drawn: per box its
 * border bands, its tab, the text and its size, and what is wrong with it.
 *
 * @param {{key, rect, text}[]} boxes
 * @param {{width:number, height:number}} canvas
 * @param {object} style       `normaliseStyle`
 * @param {object} opts
 * @param {'layer'|'background'} opts.target
 * @param {string} opts.labels  a `LABEL_MODES` id
 * @param {(text:string, px:number) => number} [opts.measure]  text width in px
 */
export function layout(boxes, canvas, style, { target = 'layer', labels = 'bottom', measure = roughMeasure } = {}) {
  const s = normaliseStyle(style);
  const W = canvas.width;
  const H = canvas.height;
  const bw = s.border ? (s.borderWidth || autoBorder(canvas)) : 0;
  const minPx = Math.max(10, Math.round(H / 108));
  const items = [];
  const warnings = [];

  for (const box of boxes) {
    const r = box.rect;
    const item = { key: box.key, rect: r, borders: bw ? borderBands(r, bw, target, canvas) : [], tab: null, notes: [] };
    const raw = String(box.text || '');
    const text = s.uppercase ? raw.toUpperCase() : raw;
    if (labels !== 'none' && text) {
      /* Sized to the box, as a multiviewer's are, within limits set by the
         canvas so a full-screen box does not get a headline: 16 px on a
         quarter-size window at 1080, 30 px at most. */
      const base = Math.round(Math.min(Math.max(0.06 * r.height, H / 72), H / 36) * s.textScale);
      let px = Math.max(minPx, base);
      const pad = (p) => Math.round(p * 0.6);
      const room = Math.max(0, r.width - 2 * bw - 2);
      let shown = text;
      while (px > minPx && measure(shown, px) + 2 * pad(px) > room) px -= 1;
      if (measure(shown, px) + 2 * pad(px) > room) {
        while (shown.length > 1 && measure(shown + ELLIPSIS, px) + 2 * pad(px) > room) shown = shown.slice(0, -1);
        shown = shown.length < text.length ? shown.replace(/\s+$/, '') + ELLIPSIS : shown;
        item.notes.push(`“${text}” is too long for the box, so it is cut short.`);
      }
      const tabH = Math.round(px * 1.5);
      const tabW = Math.min(room, Math.ceil(measure(shown, px)) + 2 * pad(px));
      const left = Math.round(r.left + (r.width - tabW) / 2);
      let top;
      let where = labels;
      if (labels === 'top') top = r.top + bw;
      else if (labels === 'below') {
        top = r.top + r.height + bw;
        if (top + tabH > H) {
          where = 'bottom';
          top = r.top + r.height - bw - tabH;
          item.notes.push('There is no room under this box, so its label is inside it.');
        }
      } else top = r.top + r.height - bw - tabH;
      item.tab = { left, top, width: tabW, height: tabH, px, text: shown, where };
    }
    items.push(item);
  }

  /* What a viewer would not see. Under the layers, anything inside a box is
     covered by that box's own picture; a label under a box can still land
     on the next one down. */
  if (target === 'background') {
    for (const item of items) {
      if (!item.tab) continue;
      const covered = boxes.filter((b) => intersect(item.tab, b.rect)).map((b) => b.key);
      if (covered.length) item.notes.push(`Its label is under ${covered.map((k) => `L${k}`).join(', ')}, which cover${covered.length === 1 ? 's' : ''} it.`);
    }
  } else {
    for (const item of items) {
      if (!item.tab) continue;
      const others = items.filter((o) => o !== item && o.tab && intersect(o.tab, item.tab));
      if (others.length) item.notes.push(`Its label overlaps ${others.map((o) => `L${o.key}`).join(', ')}’s.`);
    }
  }
  for (const item of items) {
    const r = item.rect;
    if (r.left < 0 || r.top < 0 || r.left + r.width > W || r.top + r.height > H) item.notes.push('The box runs off the canvas; what is off it is not drawn.');
  }
  if (!boxes.length) warnings.push('No boxes: no layer here shows anything, and none has a name.');
  return { width: W, height: H, border: bw, colour: s.borderColour, tabOpacity: s.tabOpacity, items, warnings };
}

/**
 * A short fingerprint of what a layout draws — the same picture, the same
 * string — so the panel can tell whether the UMD on the switcher still says
 * what the layers do.
 */
export function fingerprint(plan) {
  const text = JSON.stringify([plan.width, plan.height, plan.border, plan.colour, plan.tabOpacity,
    plan.items.map((i) => [i.rect, i.tab && [i.tab.left, i.tab.top, i.tab.width, i.tab.px, i.tab.text]])]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The PNG's file name, as the library will list it. */
export const fileName = (id) => `umd-${id}.png`;

/* ================================================================ writes */

/**
 * The store path of one layer property, by its catalogue id (`position.posH`).
 * Null when this platform's layers have no such property — a Midra layer has
 * no anchor — and a caller writes nothing there.
 */
export function layerPath(store, id, letter, key, paramId) {
  const dialect = dialectFor(store);
  const spec = dialect && dialect.catalogue.layer.find((p) => p.id === paramId);
  return spec ? dialect.layerParamPath(id, letter, key, spec.path) : null;
}

/**
 * The writes that put one layer of one buffer at a rectangle, through its
 * own anchor — a `BOTTOM_RIGHT` layer sized by its width alone moves its
 * left edge, so position and size are written together.
 */
export function placeWrites(store, id, letter, key, rect) {
  const dialect = dialectFor(store);
  if (!dialect) return [];
  const p = (name) => layerPath(store, id, letter, key, dialect.layerParams[name]);
  const at = p('anchor');
  const anchor = (at && store.get(at)) || 'MIDDLE_CENTER';
  const { posH, posV } = topLeftToAnchor(anchor, rect.left, rect.top, rect.width, rect.height);
  return [
    { path: p('posH'), value: posH },
    { path: p('posV'), value: posV },
    { path: p('sizeH'), value: rect.width },
    { path: p('sizeV'), value: rect.height }
  ].filter((w) => w.path);
}

/**
 * Leave a layer showing its source as it is: no crop, no mask, no effect,
 * fully opaque. Only the properties this layer has — an aux's layers have
 * no border or keyer, a screen's do — so nothing is written to a path the
 * switcher would refuse, and only those not already so.
 */
const CLEAN = [
  ['opacity.opacity', 256],
  ['cropping.classic.top', 0], ['cropping.classic.bottom', 0], ['cropping.classic.left', 0], ['cropping.classic.right', 0],
  ['cropping.mask.top', 0], ['cropping.mask.bottom', 0], ['cropping.mask.left', 0], ['cropping.mask.right', 0],
  ['effects.flags', []],
  ['border.edge.style', []], ['border.shadow.style', []],
  ['keying.enable', false]
];

export function cleanWrites(store, id, letter, key) {
  return CLEAN
    .map(([param, value]) => ({ path: layerPath(store, id, letter, key, param), value }))
    .filter((w) => w.path && store.get(w.path) !== undefined && !same(store.get(w.path), w.value));
}

/** The UMD layer: the still, over the whole canvas, clean. */
export function umdLayerWrites(store, dest, letter, key, still) {
  const dialect = dialectFor(store);
  const source = dialect && layerPath(store, dest.id, letter, key, dialect.sourceParam);
  if (!source) return [];
  return [
    { path: source, value: `STILL_${still}` },
    ...placeWrites(store, dest.id, letter, key, { left: 0, top: 0, width: dest.canvas.width, height: dest.canvas.height }),
    ...cleanWrites(store, dest.id, letter, key)
  ];
}

/**
 * A template onto a buffer: box n on the n-th box layer, opaque and
 * uncropped; the box layers it does not use emptied, so the look is the
 * template and nothing left over from before. The UMD layer is not touched.
 */
export function templateWrites(store, dest, letter, template, boxLayers, gap = 0) {
  const dialect = dialectFor(store);
  if (!dialect) return [];
  const rects = templateRects(template, dest.canvas, gap);
  const writes = [];
  boxLayers.forEach((key, i) => {
    if (i < rects.length) {
      writes.push(...placeWrites(store, dest.id, letter, key, rects[i]), ...cleanWrites(store, dest.id, letter, key));
    } else {
      const source = layerPath(store, dest.id, letter, key, dialect.sourceParam);
      if (source) writes.push({ path: source, value: 'NONE' });
    }
  });
  return writes;
}

/** What each path in `writes` holds now — the journal of a write, taken before it. */
export function before(store, writes) {
  const seen = new Map();
  for (const w of writes) {
    const k = w.path.join('/');
    if (!seen.has(k)) seen.set(k, { path: w.path, value: store.get(w.path) });
  }
  return [...seen.values()].filter((w) => w.value !== undefined);
}

/* ============================================================ the library */

/**
 * A still that can hold the picture: free, and with the capacity for the
 * canvas — a still's capacity is how large a picture it holds, DUAL up to
 * 1920 × 1200. Ours first, if it is still showing our slot; else the
 * highest-numbered free one, out of the way of the operator's own, who
 * fill from the top of the list.
 */
export function chooseStill(stills, canvas, placed = null) {
  const need = CAPACITY_UNITS[likelyCapability(canvas)];
  const holds = (s) => (CAPACITY_UNITS[s.capability] || 0) >= need;
  if (placed) {
    const ours = stills.find((s) => s.key === String(placed.still));
    if (ours && ours.mode === 'IMAGE' && Number(ours.source) === placed.slot && holds(ours) && !ours.inSet && !ours.onOutput) return { still: ours, reused: true };
  }
  const free = stills.filter((s) => s.free && holds(s));
  if (free.length) return { still: free[free.length - 1], reused: false };
  const small = stills.filter((s) => s.free);
  return {
    still: null,
    reason: small.length
      ? `Every free still is too small for a ${canvas.width}×${canvas.height} picture. Give one ${likelyCapability(canvas)} capacity in Preconfig ▸ Images.`
      : 'No still is free. Empty one, or give the switcher more in Preconfig ▸ Images.'
  };
}

/** A library slot for the picture: ours if it still holds our file, else the highest free one. */
export function chooseSlot(library, id, placed = null) {
  if (placed) {
    const ours = library.slots.find((s) => s.slot === placed.slot);
    if (ours && (ours.free || ours.fileName === fileName(id))) return { slot: ours.slot, reused: !ours.free, wasFree: ours.free };
  }
  const free = library.slots.filter((s) => s.free);
  if (!free.length) return { slot: null, reason: 'The image library is full. Delete an image on the Image Library page.' };
  return { slot: free[free.length - 1].slot, reused: false, wasFree: true };
}
