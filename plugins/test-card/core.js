/*
 * Test Card — the part with no DOM and no I/O.
 *
 * Test Card's patterns (`src/vendor/test-card/engine.js`, from
 * stoatworks-labs/test-card) drawn for the switcher's own outputs and
 * canvases, and put on the switcher. A tab beside the vendor's own Pattern
 * tab on Setup ▸ Outputs ▸ an output, and on Preconfig ▸ Canvas for a screen
 * or an aux.
 *
 * ## Why a still, and not a pattern
 *
 * The switcher's own patterns are generators with a fixed list: 21 on an
 * output (`OPATTERN_TYPE`) and 15 on a screen (`SCREEN_PATTERN_TYPE`) in Web
 * RCS 6.2.73, none of them an image. So a Test Card pattern reaches the
 * outputs the only way a picture can: drawn in this page at the size it is
 * shown, uploaded into the image library, shown by a still, and the still on
 * the destination's **top layer** (`core/still-layer.js`, which the UMD
 * Generator uses for the same thing). That puts it over everything, as the
 * vendor's own patterns are. It is "on the fly" as far as a switcher allows:
 * a change of pattern, option or output format is drawn again here and
 * uploaded into the same library slot, which the still follows by itself —
 * nothing structural is written twice.
 *
 * ## What is drawn, and where
 *
 *   - **Canvas** (Preconfig ▸ Canvas): the whole canvas, opaque. *Per output*
 *     fills each output's footprint with its own pattern and labels it —
 *     Test Card's composition mode, which proves the canvas map; *Across the
 *     canvas* draws one pattern over all of it with each output outlined.
 *   - **Outputs** (Setup ▸ Outputs ▸ an output): each output that has its card
 *     on gets its own pattern in its footprint, on one transparent picture the
 *     size of the box round them all, so several outputs of a screen can show
 *     their cards at once, as the vendor's per-output patterns can. Only one
 *     layer per destination is ever used.
 *
 * Everything is drawn in **canvas orientation**: a rotated output's card is
 * drawn upright, because the canvas is what the audience sees and turning it
 * into the raster is the switcher's job. A footprint that is not the raster's
 * size (a pitch ratio other than 1.000) is resampled by the switcher on the
 * way out, so its pixels are not 1:1 — the panel says so.
 *
 * ## The document
 *
 * Per switcher, like the UMD Generator's:
 *
 *   { version: 1,
 *     settings: <Test Card PatternSettings>,
 *     dests: { S1: { mode: 'canvas' | 'outputs', outputs: ['1', '3'], layout: 'per-output',
 *                    placed: { slot, still, layer, letter, rect, fingerprint },
 *                    journal: { id, uploads, stills, writes } } } }
 *
 * `journal` is what the switcher held before this app wrote anything for that
 * destination, kept on disk so **Off** puts it back even after a reload.
 */

import {
  DEFAULT_SETTINGS, PATTERN_LABELS, isAnimated, isScaleAware, canvasLimitProblem, FAULT_LABELS, ALL_FAULTS, LINEUP_ORDER, SPECIES
} from '../../src/vendor/test-card/engine.js';
import { dialectFor } from '../../src/core/dialect.js';
import { CAPACITY_UNITS, likelyCapability } from '../../src/core/stills.js';

export { PATTERN_LABELS, canvasLimitProblem };

/* ============================================================ catalogue */

/**
 * The patterns offered, in the order the tab lists them. Test Card's own
 * "your image" is left out: a picture of your own is the Background Slicer's
 * and the Image Library's job.
 */
export const KINDS = [
  'smpte-rp219', 'ebu-bars', 'grid', 'alignment', 'led-tiles', 'solid', 'greyscale', 'pixel-check',
  'rulers', 'bananas', 'dinosaurs', 'hamsters', 'ocean', 'dino-scroll', 'volcano', 'broken-wall'
];

/** Whether a pattern moves in Test Card — here it is one still frame of it. */
export const moves = (kind) => isAnimated({ ...DEFAULT_SETTINGS, kind });
/** Whether a pattern is drawn at real size from a pixel pitch. */
export const scaled = (kind) => isScaleAware({ ...DEFAULT_SETTINGS, kind });

const colours = ['white', 'black', 'red', 'green', 'blue', 'cyan', 'magenta', 'yellow', 'grey50', 'grey18'];
const choice = (values, labels = {}) => values.map((v) => ({ value: v, label: labels[v] || v }));

/**
 * The options each pattern offers here: a working subset of Test Card's, by
 * the dotted path into its settings. `type` is `number`, `bool` or `choice`.
 */
export const OPTIONS = {
  'smpte-rp219': [],
  'ebu-bars': [],
  grid: [
    { path: 'grid.spacingPx', label: 'Cell (px)', type: 'number', min: 4, max: 4096 },
    { path: 'grid.lineWidthPx', label: 'Line (px)', type: 'number', min: 1, max: 64 },
    { path: 'grid.majorEvery', label: 'Heavy every', type: 'number', min: 0, max: 100 },
    { path: 'grid.diagonals', label: 'Diagonals', type: 'bool' },
    { path: 'grid.centreMarks', label: 'Centre marks', type: 'bool' },
    { path: 'grid.labelCells', label: 'Label cells', type: 'bool' },
    { path: 'grid.originCentre', label: 'From the centre', type: 'bool' }
  ],
  alignment: [
    { path: 'alignment.edgeBorder', label: 'Edge border', type: 'bool' },
    { path: 'alignment.cornerMarkers', label: 'Corner markers', type: 'bool' },
    { path: 'alignment.centreTarget', label: 'Centre target', type: 'bool' },
    { path: 'alignment.pixelPatches', label: 'Pixel patches', type: 'bool' },
    { path: 'alignment.diagonals', label: 'Diagonals', type: 'bool' }
  ],
  'led-tiles': [
    { path: 'led.tileWidthPx', label: 'Tile width (px)', type: 'number', min: 8, max: 2048 },
    { path: 'led.tileHeightPx', label: 'Tile height (px)', type: 'number', min: 8, max: 2048 },
    { path: 'led.originXPx', label: 'First tile X', type: 'number', min: 0, max: 2048 },
    { path: 'led.originYPx', label: 'First tile Y', type: 'number', min: 0, max: 2048 },
    { path: 'led.checker', label: 'Checker', type: 'bool' },
    { path: 'led.labelTiles', label: 'Label tiles', type: 'bool' }
  ],
  solid: [
    { path: 'solid.field', label: 'Colour', type: 'choice', choices: choice(colours, { grey50: 'Grey 50 %', grey18: 'Grey 18 %' }) },
    { path: 'solid.levelPct', label: 'Level (%)', type: 'number', min: 0, max: 100 }
  ],
  greyscale: [
    { path: 'greyscale.steps', label: 'Steps (0 = ramp)', type: 'number', min: 0, max: 256 },
    { path: 'greyscale.vertical', label: 'Vertical', type: 'bool' },
    { path: 'greyscale.perChannel', label: 'R, G, B strips', type: 'bool' }
  ],
  'pixel-check': [
    { path: 'pixelCheck.cellPx', label: 'Cell (px)', type: 'number', min: 1, max: 64 },
    { path: 'pixelCheck.lineBursts', label: 'Line bursts', type: 'bool' }
  ],
  rulers: [
    { path: 'scale.pitchMm', label: 'Pixel pitch (mm)', type: 'number', min: 0.05, max: 500, step: 0.01 },
    { path: 'scale.units', label: 'Units', type: 'choice', choices: choice(['metric', 'imperial'], { metric: 'Metric', imperial: 'Imperial' }) },
    { path: 'rulers.gridLines', label: 'Grid lines', type: 'bool' },
    { path: 'rulers.fromFloor', label: 'Up from the floor', type: 'bool' },
    { path: 'scale.floorMm', label: 'Floor below (mm)', type: 'number', min: 0, max: 100000 }
  ],
  bananas: [
    { path: 'scale.pitchMm', label: 'Pixel pitch (mm)', type: 'number', min: 0.05, max: 500, step: 0.01 },
    { path: 'bananas.layout', label: 'Bananas', type: 'choice', choices: choice(['once', 'per-tile'], { once: 'One bunch', 'per-tile': 'One per tile' }) },
    { path: 'bananas.caption', label: 'Size in bananas', type: 'bool' }
  ],
  dinosaurs: [
    { path: 'scale.pitchMm', label: 'Pixel pitch (mm)', type: 'number', min: 0.05, max: 500, step: 0.01 },
    { path: 'scale.floorMm', label: 'Floor below (mm)', type: 'number', min: 0, max: 100000 },
    { path: 'dinosaurs.panM', label: 'Pan (m)', type: 'number', min: -500, max: 500, step: 0.1 },
    { path: 'dinosaurs.human', label: 'A person', type: 'bool' },
    { path: 'dinosaurs.labels', label: 'Names', type: 'bool' },
    { path: 'dinosaurs.scenery', label: 'Scenery', type: 'bool' }
  ],
  hamsters: [],
  ocean: [
    { path: 'ocean.time', label: 'Time of day', type: 'choice', choices: choice(['day', 'sunset', 'night'], { day: 'Day', sunset: 'Sunset', night: 'Night' }) },
    { path: 'ocean.seed', label: 'Seed', type: 'number', min: 1, max: 9999 }
  ],
  'dino-scroll': [{ path: 'scene.seed', label: 'Seed', type: 'number', min: 1, max: 9999 }],
  volcano: [{ path: 'scene.seed', label: 'Seed', type: 'number', min: 1, max: 9999 }],
  'broken-wall': [
    { path: 'broken.base', label: 'Over', type: 'choice', choices: KINDS.filter((k) => k !== 'broken-wall').map((k) => ({ value: k, label: PATTERN_LABELS[k] })) },
    { path: 'broken.faultyPct', label: 'Faulty tiles (%)', type: 'number', min: 0, max: 100 },
    { path: 'broken.seed', label: 'Seed', type: 'number', min: 1, max: 9999 },
    { path: 'broken.labels', label: 'Say what is wrong', type: 'bool' },
    { path: 'led.tileWidthPx', label: 'Tile width (px)', type: 'number', min: 8, max: 2048 },
    { path: 'led.tileHeightPx', label: 'Tile height (px)', type: 'number', min: 8, max: 2048 }
  ]
};

/** Options every pattern has. */
export const COMMON = [
  { path: 'levels', label: 'Levels', type: 'choice', choices: choice(['full', 'legal'], { full: 'Full (0–255)', legal: 'Legal (16–235)' }) },
  { path: 'overlay.enabled', label: 'Name and size', type: 'bool' },
  { path: 'overlay.customText', label: 'Text', type: 'text', max: 60 }
];

/** A moving pattern is one still frame: which moment of it. */
export const STILL_AT = { path: 'animation.stillAtSeconds', label: 'Frame at (s)', type: 'number', min: 0, max: 600, step: 0.1 };

export const LAYOUTS = [
  { id: 'per-output', label: 'Per output', what: 'Each output’s footprint gets its own pattern and its name — the quickest proof that the canvas map is what you think.' },
  { id: 'across', label: 'Across the canvas', what: 'One pattern over the whole canvas, each output outlined and named over it — seams and overlaps show.' }
];

/* ============================================================== settings */

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Read a dotted path out of the settings. */
export function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** A copy of the settings with one dotted path set. */
export function setPath(obj, path, value) {
  const out = clone(obj);
  const keys = String(path).split('.');
  let o = out;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(o[k])) o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
  return out;
}

/** `raw` laid over Test Card's defaults, one level at a time, each value checked against the default's type. */
function overlay(def, raw) {
  if (!isObj(raw)) return clone(def);
  const out = {};
  for (const [k, d] of Object.entries(def)) {
    const v = raw[k];
    if (isObj(d)) out[k] = overlay(d, v);
    else if (Array.isArray(d)) out[k] = Array.isArray(v) ? v.slice() : d.slice();
    else if (typeof v === typeof d && (typeof v !== 'number' || Number.isFinite(v))) out[k] = v;
    else out[k] = d;
  }
  return out;
}

/** Test Card's settings, whole and checked, from whatever was stored. */
export function normaliseSettings(raw) {
  const s = overlay(DEFAULT_SETTINGS, raw);
  if (!KINDS.includes(s.kind)) s.kind = DEFAULT_SETTINGS.kind;
  if (!['full', 'legal'].includes(s.levels)) s.levels = DEFAULT_SETTINGS.levels;
  if (s.broken.base === 'broken-wall' || !KINDS.includes(s.broken.base)) s.broken.base = DEFAULT_SETTINGS.broken.base;
  s.broken.faults = s.broken.faults.filter((f) => ALL_FAULTS.includes(f));
  s.dinosaurs.species = s.dinosaurs.species.filter((id) => LINEUP_ORDER.includes(id) && SPECIES[id]);
  /* Every option this tab offers, held to its range. */
  for (const spec of [...COMMON, STILL_AT, ...Object.values(OPTIONS).flat()]) {
    const v = getPath(s, spec.path);
    if (spec.type === 'number') {
      const n = Math.min(spec.max, Math.max(spec.min, Number(v)));
      Object.assign(s, setPath(s, spec.path, Number.isFinite(n) ? n : getPath(DEFAULT_SETTINGS, spec.path)));
    } else if (spec.type === 'choice' && !spec.choices.some((c) => c.value === v)) {
      Object.assign(s, setPath(s, spec.path, getPath(DEFAULT_SETTINGS, spec.path)));
    } else if (spec.type === 'text') {
      Object.assign(s, setPath(s, spec.path, String(v || '').slice(0, spec.max)));
    }
  }
  /* A pattern that moves in Test Card is one frame here, and a frame
     somewhere in its loop. */
  if (s.animation.stillAtSeconds >= s.animation.seconds) s.animation.stillAtSeconds = 0;
  return s;
}

/** The faults Test Card names, for the docs and the panel. */
export const FAULTS = FAULT_LABELS;

/* ============================================================== document */

export const DEFAULT_DEST = Object.freeze({ mode: null, outputs: [], layout: 'per-output', placed: null, journal: null });

const isPath = (p) => Array.isArray(p) && p.length > 0 && p.every((k) => typeof k === 'string');

function normaliseJournal(raw) {
  if (!isObj(raw)) return null;
  const writes = Array.isArray(raw.writes) ? raw.writes.filter((w) => isObj(w) && isPath(w.path) && w.value !== undefined) : [];
  const stills = Array.isArray(raw.stills) ? raw.stills.filter((s) => isObj(s) && /^\d+$/.test(String(s.still)) && isObj(s.before)) : [];
  const uploads = Array.isArray(raw.uploads) ? raw.uploads.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!writes.length && !stills.length && !uploads.length) return null;
  return { id: String(raw.id || ''), writes, stills, uploads };
}

function normalisePlaced(raw) {
  if (!isObj(raw)) return null;
  const slot = Number(raw.slot);
  const still = Number(raw.still);
  if (!Number.isInteger(slot) || !Number.isInteger(still) || slot < 1 || still < 1) return null;
  const r = isObj(raw.rect) ? raw.rect : {};
  const rect = ['left', 'top', 'width', 'height'].every((k) => Number.isFinite(r[k])) ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
  return {
    slot, still,
    layer: String(raw.layer || ''),
    letter: String(raw.letter || ''),
    rect,
    fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : null
  };
}

export function normaliseDest(raw) {
  const d = isObj(raw) ? raw : {};
  const mode = d.mode === 'canvas' || d.mode === 'outputs' ? d.mode : null;
  const outputs = Array.isArray(d.outputs) ? [...new Set(d.outputs.map(String).filter((k) => /^\d+$/.test(k)))].sort((a, b) => a - b) : [];
  return {
    mode: mode === 'outputs' && !outputs.length ? null : mode,
    outputs: mode === 'outputs' ? outputs : [],
    layout: LAYOUTS.some((l) => l.id === d.layout) ? d.layout : DEFAULT_DEST.layout,
    placed: normalisePlaced(d.placed),
    journal: normaliseJournal(d.journal)
  };
}

export function normalise(raw) {
  const d = isObj(raw) ? raw : {};
  const dests = {};
  for (const [id, entry] of Object.entries(isObj(d.dests) ? d.dests : {})) {
    if (!/^[SA]\d+$/.test(id)) continue;
    const e = normaliseDest(entry);
    /* Keep an entry while there is anything to say about it: a card that is
       on, a layout chosen, or a journal still to put back. */
    if (e.mode || e.journal || e.placed || e.layout !== DEFAULT_DEST.layout) dests[id] = e;
  }
  return { version: 1, settings: normaliseSettings(d.settings), dests };
}

export const EMPTY = Object.freeze(normalise(null));

export function withDest(doc, id, patch) {
  const cur = doc.dests[id] || normaliseDest(null);
  return normalise({ ...doc, dests: { ...doc.dests, [id]: { ...cur, ...patch } } });
}

export const withSettings = (doc, settings) => normalise({ ...doc, settings });

/* ============================================================== geometry */

/** The PNG's file name, as the library will list it — how our slot is known again. */
export const fileName = (id) => `testcard-${id}.png`;
/** The still's label, 16 characters at most. */
export const stillLabel = (id) => `Test card ${id}`.slice(0, 16);

const rotationText = (r) => (r ? ` · turned ${r}°` : '');

/**
 * One output of a topology (`core/backgrounds.js` `canvasTopology`) as a Test Card Output, in
 * canvas orientation: `widthPx × heightPx` is its raster turned the way the
 * canvas sees it, `compositionRect` its footprint, and its slices are regions
 * of that turned raster.
 */
export function cardOutput(out) {
  const odd = out.rotation === 90 || out.rotation === 270;
  const w = odd ? out.raster.height : out.raster.width;
  const h = odd ? out.raster.width : out.raster.height;
  const fp = out.footprint;
  const name = out.label ? `${out.name} · ${out.label}` : out.name;
  const plugs = out.plugs && out.plugs.length ? ` · ${[...new Set(out.plugs)].join('/')}` : '';
  const kx = fp.w > 0 ? w / fp.w : 1;
  const ky = fp.h > 0 ? h / fp.h : 1;
  const regions = out.regions.length > 1
    ? out.regions.map((r) => ({
      id: `slice-${r.slice}`,
      label: `Slice ${r.slice}`,
      rect: {
        x: Math.round((r.canvas.x - fp.x) * kx), y: Math.round((r.canvas.y - fp.y) * ky),
        width: Math.round(r.canvas.w * kx), height: Math.round(r.canvas.h * ky)
      },
      order: r.slice
    }))
    : [];
  return {
    id: out.key,
    name,
    widthPx: w,
    heightPx: h,
    rasterSource: 'declared',
    source: 'manual',
    device: `${out.raster.width}×${out.raster.height}${plugs}${rotationText(out.rotation)}`,
    compositionRect: { x: fp.x, y: fp.y, width: fp.w, height: fp.h },
    regions,
    notes: [],
    enabled: true
  };
}

/** Whether a footprint is the raster at 1:1 — whole pixels, no pitch. */
export const exactFootprint = (out) => out.ratio.h === 1 && out.ratio.v === 1;

const bbox = (rects) => {
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  return {
    left, top,
    width: Math.max(...rects.map((r) => r.x + r.w)) - left,
    height: Math.max(...rects.map((r) => r.y + r.h)) - top
  };
};

/**
 * What to draw for a destination, and where it goes on the canvas.
 *
 * `{ kind, rect, outputs, composition, whole?, inexact, problem? }`: `rect` the
 * canvas rectangle the layer covers (and the picture's size), `outputs` the
 * Test Card Outputs to draw (each placed by its `compositionRect`).
 */
export function cardPlan(topo, entry) {
  if (!topo) return { problem: 'Not in service' };
  const canvas = { widthPx: topo.canvas.width, heightPx: topo.canvas.height };
  if (entry.mode === 'canvas') {
    const outputs = topo.outputs.map(cardOutput);
    const rect = { left: 0, top: 0, width: topo.canvas.width, height: topo.canvas.height };
    const plan = {
      kind: 'canvas', layout: entry.layout, rect, outputs, composition: canvas,
      inexact: topo.outputs.filter((o) => !exactFootprint(o)).map((o) => o.key)
    };
    if (entry.layout === 'across') {
      plan.whole = {
        id: topo.id,
        name: topo.label ? `${topo.id} · ${topo.label}` : topo.id,
        widthPx: rect.width,
        heightPx: rect.height,
        rasterSource: 'declared',
        source: 'manual',
        device: 'canvas',
        regions: outputs.map((o, i) => ({
          id: `out-${o.id}`, label: o.name, detail: o.device,
          rect: { x: o.compositionRect.x, y: o.compositionRect.y, width: o.compositionRect.width, height: o.compositionRect.height },
          order: i + 1
        })),
        notes: [],
        enabled: true
      };
    }
    return withLimit(plan);
  }
  if (entry.mode === 'outputs') {
    const chosen = topo.outputs.filter((o) => entry.outputs.includes(o.key));
    if (!chosen.length) return { problem: `None of output ${entry.outputs.join(', ')} is on ${topo.id} now` };
    const rect = bbox(chosen.map((o) => o.footprint));
    return withLimit({
      kind: 'outputs', rect, outputs: chosen.map(cardOutput), composition: canvas,
      inexact: chosen.filter((o) => !exactFootprint(o)).map((o) => o.key)
    });
  }
  return { problem: 'No card is on' };
}

function withLimit(plan) {
  const problem = canvasLimitProblem(plan.rect.width, plan.rect.height);
  return problem ? { ...plan, problem } : plan;
}

/* ================================================================ layers */

/** The fitted layers that can hold a picture, bottom first — NATIVE is not one. */
export function pictureLayers(store, id) {
  const dialect = dialectFor(store);
  if (!dialect) return [];
  return dialect.fittedLayers(store, id)
    .filter((l) => !l.isNative)
    .sort((a, b) => Number(a.key) - Number(b.key));
}

/**
 * The layer a card goes on, and whether it can carry a picture this size.
 *
 * ⚠️ "Top" is the highest layer number, as the vendor's own layer list stacks
 * them (`core/screens.js` notes it was first seen with one layer only), and a
 * layer's capacity is judged the way a still's is, by area — DUAL to
 * 1920 × 1200, 4K to 4096 × 2160, 5K to 5120 × 2880 (`core/stills.js`). The
 * switcher's own check is the one that counts.
 */
export function layerFor(store, id, size) {
  const layers = pictureLayers(store, id);
  const top = layers[layers.length - 1];
  if (!top) return { layer: null, reason: `${id} has no layer to put a card on. Give it one in Preconfig ▸ Screens.` };
  const need = likelyCapability(size);
  const fits = (CAPACITY_UNITS[top.capability] || 0) >= (CAPACITY_UNITS[need] || 0);
  return {
    layer: top.key,
    capability: top.capability,
    need,
    fits,
    reason: fits ? null
      : `${id}'s top layer, L${top.key}, is ${top.capability}, and a ${size.width}×${size.height} card needs ${need}. `
        + 'Put cards on fewer outputs at once, or give the layer more in Preconfig ▸ Screens.'
  };
}

/* =============================================================== journal */

/**
 * The journal after another write for a destination that already has one.
 * Each path keeps the value it had before this app's FIRST write — a later
 * write's "before" is only our own last value — and new paths are added.
 */
export function mergeJournal(old, fresh) {
  if (!old) return fresh && (fresh.writes.length || fresh.stills.length || fresh.uploads.length) ? fresh : old;
  if (!fresh) return old;
  const seen = new Set(old.writes.map((w) => w.path.join('/')));
  const stillsSeen = new Set(old.stills.map((s) => String(s.still)));
  return {
    id: old.id || fresh.id,
    writes: [...old.writes, ...fresh.writes.filter((w) => !seen.has(w.path.join('/')))],
    stills: [...old.stills, ...fresh.stills.filter((s) => !stillsSeen.has(String(s.still)))],
    uploads: [...new Set([...old.uploads, ...fresh.uploads])]
  };
}

/**
 * The part of a journal that is still ours to take back. A journal can
 * outlive what it describes — somebody puts a camera on the layer, a setup
 * file brings back an old one, a put that failed half way — and putting back
 * the layer's old source over somebody's new one, or emptying a still or a
 * slot somebody has since filled, would be this app writing over the
 * operator. So, judged on what the switcher holds now:
 *
 *   - a layer's writes, while that layer shows one of our stills (any still
 *     the journal took, or the placed one);
 *   - a still, while it shows one of our slots (any slot the journal filled,
 *     or the placed one);
 *   - a slot, while it holds our file — an emptied one needs nothing.
 *
 * `now` is `{ get(path), stills: [{ key, mode, source, rescale, label }], library: [{ slot, fileName, free }] }`,
 * and `label` the still label this app gives its stills;
 * the answer is the journal to revert and what was left alone, in words.
 */
export function trimJournal(journal, placed, name, now, { label = null } = {}) {
  if (!journal) return { journal: null, left: [] };
  const left = [];
  const ourStills = new Set([...journal.stills.map((s) => String(s.still)), ...(placed ? [String(placed.still)] : [])]);
  const ourSlots = new Set([...journal.uploads.map(Number), ...(placed ? [placed.slot] : [])]);

  /* The writes, a layer at a time: everything up to `layerList/items/<key>`. */
  const layerOf = (path) => {
    const i = path.indexOf('layerList');
    return i >= 0 && path[i + 1] === 'items' ? path.slice(0, i + 3).join('/') : path.join('/');
  };
  const groups = new Map();
  for (const w of journal.writes) {
    const k = layerOf(w.path);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  const writes = [];
  for (const [k, ws] of groups) {
    const source = ws.find((w) => w.path[w.path.length - 1] === 'inputNum');
    const shows = source ? String(now.get(source.path) || '') : '';
    const m = /^STILL_(\d+)$/.exec(shows);
    if (m && ourStills.has(m[1])) { writes.push(...ws); continue; }
    const parts = k.split('/');
    left.push(`${parts[3] || '?'} ${parts[6] || '?'} L${parts[parts.length - 1]} shows ${shows || 'something else'} now, and is left as it is`);
  }
  /* A still is ours while every field is either what this app wrote or what
     the journal says was there before — which also covers one a failed Off
     half put back (its source restored, its mode not). One already wholly
     back needs nothing. */
  const fields = { mode: (v) => v === 'IMAGE', source: (v) => ourSlots.has(Number(v)), rescale: (v) => v === 'NO_RESCALE', label: (v) => !label || v === label };
  const stills = journal.stills.filter((s) => {
    const st = now.stills.find((x) => x.key === String(s.still));
    const was = s.before || {};
    if (!st) { left.push(`still ${s.still} is not there now`); return false; }
    if (Object.keys(fields).every((f) => st[f] === undefined || st[f] === was[f])) return false;
    const ours = Object.entries(fields).every(([f, mine]) => st[f] === undefined || st[f] === was[f] || mine(st[f]));
    if (!ours) left.push(`still ${s.still} shows something else now, and is left as it is`);
    return ours;
  });
  const uploads = journal.uploads.filter((slot) => {
    const lib = now.library.find((x) => x.slot === Number(slot));
    if (!lib || lib.free) return false;
    if (lib.fileName !== name) left.push(`library slot ${slot} holds ${lib.fileName || 'another file'} now, and is left as it is`);
    return lib.fileName === name;
  });
  return { journal: { ...journal, writes, stills, uploads }, left };
}

/* ================================================================= state */

/**
 * A short fingerprint of what a card draws — the same settings over the same
 * geometry is the same picture, so a card that already matches is not
 * uploaded again.
 */
export function fingerprint(settings, plan) {
  const text = JSON.stringify([settings, plan.kind, plan.layout || null, plan.rect,
    plan.outputs.map((o) => [o.id, o.name, o.widthPx, o.heightPx, o.device, o.compositionRect, o.regions]),
    plan.whole ? [plan.whole.name, plan.whole.regions] : null]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The output key a Setup ▸ Outputs page is about, or null. */
export function outputOfPage(pathname) {
  const m = /^\/outputs\/(\d+)(?:\/|$)/.exec(String(pathname || ''));
  return m ? m[1] : null;
}

/**
 * Which destination an output's card would go on, or why it cannot have one:
 * `{ dest, out }` or `{ reason }`. `topologies` is every destination's.
 */
export function homeOf(topologies, key) {
  for (const t of topologies) {
    const out = t.outputs.find((o) => o.key === String(key));
    if (out) return { dest: t, out };
    const skipped = t.skipped.find((s) => s.key === String(key));
    if (skipped) return { reason: `Output ${key} is ${skipped.why}, on ${t.id}.` };
  }
  return { reason: `Output ${key} is on no screen or aux, so there is no canvas to put a card on. The switcher’s own Pattern tab still works on it.` };
}

/** The entry after an output's card is switched on or off. */
export function toggleOutput(entry, key, on) {
  const k = String(key);
  if (on) {
    const outputs = entry.mode === 'outputs' ? [...new Set([...entry.outputs, k])] : [k];
    return { ...entry, mode: 'outputs', outputs };
  }
  if (entry.mode !== 'outputs') return entry;
  const outputs = entry.outputs.filter((o) => o !== k);
  return { ...entry, mode: outputs.length ? 'outputs' : null, outputs };
}
