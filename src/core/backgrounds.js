/*
 * A LivePremier's outputs as places on a screen canvas, and the background
 * sets they show — the model the Background Slicer cuts pictures against and
 * Resolume Mapping writes an Arena output map from. No DOM, no I/O.
 *
 * Moved here out of `plugins/bg-slicer/core.js` (which still exports every
 * name it always did) so a second plugin can read it without importing the
 * Slicer's folder, which is only served while the Slicer is on. A Midra 4K or
 * Alta 4K keeps its outputs and sets another way (`plugins/bg-slicer/mng.js`).
 *
 * ## The model of an output, and how much of it is proven
 *
 * Everything here is read off `device/outputList/items/<out>/canvas/status`
 * through `core/pitch.js`'s `screenOutputs()` plus the slices beside it. The
 * names and shapes were read off a LivePremier Simulator 6.2.73 and the Web
 * RCS bundle that drives it; what they MEAN is pinned to different degrees,
 * and the panels that use it say which (the Slicer's `NOTES`):
 *
 *   - **A background is shown 1:1 in the output's raster.** The Aquilon
 *     manual (v6.2) calls the background layer "unscalable" (p.86) and sets
 *     content per output group with "the content and output capacities must
 *     match" (p.101); the vendor's own background thumbnail draws an image at
 *     `imageWidth / boundingBox.width` from the top-left. So each image is
 *     exactly the output's raster, `maxWidth × maxHeight`, and image pixel
 *     (x, y) is raster pixel (x, y).
 *   - **An output is a group of connectors, and its slices are those
 *     connectors.** Read off the bundle (`getGroupedOutputs`,
 *     `getGroupedOutputStatus`): `canvas/status/pp/{maxWidth,maxHeight}` is
 *     the group's raster — one picture across every connector, which is why
 *     the manual says a 4K image on four HD outputs "does not need to be
 *     divided beforehand" — and `canvas/status/slices/sliceList/items/<k>` is
 *     connector k: `pp.left/top` its place in that raster, `aoi/pp.width/
 *     height` how much of it the connector carries. On the screen canvas the
 *     output is the rectangle at `pp.left/top`, and slice k sits at
 *     `(slice − boundingBox) × pitch` inside it, `aoi × pitch` in size, the
 *     pitch being `canvas/cmd/pp/pitchRatioH/V` in thousandths. A footprint is
 *     floored, as aquilon-pitch found the device floors one. Only a 1X1 output
 *     with one full slice has been seen on a device; the rest is the bundle's
 *     arithmetic, not an observation.
 *   - **Rotation** (`OUTPUT_ROTATION`, counter-clockwise; "if the physical
 *     displays are rotated at 90° clockwise, set 90°", manual p.88) is applied
 *     the way it is applied to the screen's layers: the picture is turned in
 *     the raster so it reads upright on the turned display. Whether the device
 *     turns a BACKGROUND as well is NOT established — if it does, these images
 *     come out turned twice. The panel says so.
 *   - **An output group** (2X1, 2X2…) has one background, at its leader (the
 *     lowest-numbered output); its followers report `isEnabled: GROUPED`.
 *     Clones and duplicates show their reference's picture and get nothing of
 *     their own.
 */

import { ROOT } from './paths.js';
import { BG, LABEL_MAX } from './stills.js';
import { listDestinations } from './screens.js';
import { screenOutputs } from './pitch.js';
import { dialectFor, NLC } from './dialect.js';

const pp = (node) => (node && typeof node === 'object' && node.pp) || {};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Four slices per output — `OUTPUT_SLICE` is 1..4. */
export const MAX_SLICES = 4;

/** `OUTPUT_ROTATION` to degrees counter-clockwise. */
export const ROTATION = { NONE: 0, '90_DEGREE': 90, '180_DEGREE': 180, '270_DEGREE': 270 };

/* ------------------------------------------------------------------ topology */

/**
 * Screens in service, LivePremier only. A Midra or Alta has background sets
 * too, but of a different shape — one picture per screen, cropped by the
 * switcher — and `mng.js` reads them.
 */
export function readScreens(store) {
  if (!store || !store.ready || dialectFor(store) !== NLC) return [];
  return listDestinations(store)
    .filter((d) => d.kind === 'screen')
    .map((d) => ({ id: d.id, label: d.label || '', canvas: { width: d.canvas.width, height: d.canvas.height } }));
}

/**
 * Screens AND auxiliaries in service, LivePremier only, each with its kind
 * and canvas. An aux has outputs on a canvas just as a screen does
 * (`usedInScreenAux` names either); it only lacks background sets, which is
 * why the Background Slicer reads screens alone and Test Card reads both.
 */
export function readCanvases(store) {
  if (!store || !store.ready || dialectFor(store) !== NLC) return [];
  return listDestinations(store)
    .filter((d) => d.kind === 'screen' || d.kind === 'aux')
    .map((d) => ({ id: d.id, kind: d.kind, label: d.label || '', canvas: { width: d.canvas.width, height: d.canvas.height } }));
}

const groupShape = (group) => {
  const m = /^(\d)X(\d)$/.exec(String(group || '1X1'));
  return m ? { cols: Number(m[1]), rows: Number(m[2]) } : { cols: 1, rows: 1 };
};

/** Plug types of an output's connector(s): `['HDMI']`, `['SDI','SDI','SDI','SDI']`. */
function plugTypes(store, key) {
  const list = store.get([ROOT, 'outputList', 'items', key, 'plugList']) || {};
  const items = list.items || {};
  const keys = Array.isArray(list.itemKeys) ? list.itemKeys : Object.keys(items);
  return keys.map((k) => pp(items[k] && items[k].status).type).filter(Boolean);
}

/**
 * An output's slices — its connectors — as rectangles of its raster:
 * `[{ index, rect: {x,y,w,h} }]`, plus the bounding box they make. Null when
 * the store has none (a capture cut down to `canvas/status/pp`).
 */
function readSlices(store, key) {
  const slices = store.get([ROOT, 'outputList', 'items', key, 'canvas', 'status', 'slices']) || {};
  const count = Number(pp(slices).count) || 0;
  const items = (slices.sliceList && slices.sliceList.items) || null;
  if (!count || !items) return null;
  const list = [];
  for (let i = 1; i <= Math.min(count, MAX_SLICES); i++) {
    const s = items[String(i)];
    if (!s) continue;
    const a = pp(s.aoi);
    const rect = { x: num(pp(s).left) ?? 0, y: num(pp(s).top) ?? 0, w: num(a.width) ?? 0, h: num(a.height) ?? 0 };
    if (rect.w > 0 && rect.h > 0) list.push({ index: i, rect });
  }
  if (!list.length) return null;
  const bb = pp(slices.boundingBox);
  const box = num(bb.width) > 0 && num(bb.height) > 0
    ? { x: num(bb.left) ?? 0, y: num(bb.top) ?? 0, w: bb.width, h: bb.height }
    : union(list.map((s) => s.rect));
  return { list, box };
}

const union = (rects) => {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
};

/**
 * The inverse of `localToRaster`: where a raster rectangle `R` of a box `B`
 * lies in the box's own canvas-oriented frame, for a rotation.
 */
export function rasterToLocal(R, B, rotation) {
  switch (rotation) {
    case 90: return { x: B.y + B.h - R.y - R.h, y: R.x - B.x, w: R.h, h: R.w };
    case 180: return { x: B.x + B.w - R.x - R.w, y: B.y + B.h - R.y - R.h, w: R.w, h: R.h };
    case 270: return { x: R.y - B.y, y: B.x + B.w - R.x - R.w, w: R.h, h: R.w };
    default: return { x: R.x - B.x, y: R.y - B.y, w: R.w, h: R.h };
  }
}

/**
 * One region of an output: a rectangle of its raster (`aoi`, in image
 * pixels) and the rectangle of the screen canvas it shows (`canvas`).
 * `local` is the region's size in canvas orientation before the pitch —
 * the raster rectangle turned by the output's rotation. `box` is the slices'
 * bounding box and `origin` the output's top-left on the canvas.
 */
export function regionOf({ rect, box, origin, rotation = 0, ratio = { h: 1, v: 1 } }) {
  const L = rasterToLocal(rect, box, rotation);
  const floor = (n) => Math.floor(n + 1e-9);
  return {
    aoi: { ...rect },
    local: { w: L.w, h: L.h },
    rotation,
    ratio: { ...ratio },
    canvas: {
      x: origin.x + floor(L.x * ratio.h),
      y: origin.y + floor(L.y * ratio.v),
      w: floor(L.w * ratio.h),
      h: floor(L.h * ratio.v)
    }
  };
}

/**
 * Everything the slicer needs about one screen: its canvas and its outputs,
 * each with the regions that place its raster on the canvas.
 */
export function screenTopology(store, screenId) {
  const screen = readScreens(store).find((s) => s.id === screenId);
  return screen ? topologyOf(store, screen) : null;
}

/** The same for a screen or an auxiliary (`readCanvases`): Test Card draws for both. */
export function canvasTopology(store, id) {
  const dest = readCanvases(store).find((s) => s.id === id);
  return dest ? topologyOf(store, dest) : null;
}

function topologyOf(store, screen) {
  const screenId = screen.id;
  const outs = screenOutputs(store, screenId);
  const outputs = [];
  const skipped = [];
  for (const o of outs) {
    if (o.state === 'GROUPED') { skipped.push({ key: o.key, why: 'a member of an output group — its leader carries the background' }); continue; }
    if (o.state === 'CLONED' || o.state === 'DUPLICATED') {
      skipped.push({ key: o.key, why: `${o.state.toLowerCase()} from output ${o.outputRef || '?'} — it shows that output’s picture` });
      continue;
    }
    if (!(o.pxWidth > 0 && o.pxHeight > 0)) { skipped.push({ key: o.key, why: 'reports no raster' }); continue; }
    outputs.push(outputModel(store, o));
  }
  return { ...screen, outputs, skipped };
}

function outputModel(store, o) {
  const node = store.get([ROOT, 'outputList', 'items', o.key]) || {};
  const status = pp(node.status);
  const rotation = ROTATION[o.rotation] ?? 0;
  const odd = rotation === 90 || rotation === 270;
  /* The ratio the device applies, in thousandths; else what the footprint
     says, which is the same thing measured after the floor. */
  const ratio = {
    h: o.liveRawH != null ? o.liveRawH / 1000 : (o.footprintWidth / (odd ? o.pxHeight : o.pxWidth)) || 1,
    v: o.liveRawV != null ? o.liveRawV / 1000 : (o.footprintHeight / (odd ? o.pxWidth : o.pxHeight)) || 1
  };
  const raw = readSlices(store, o.key);
  const whole = { x: 0, y: 0, w: o.pxWidth, h: o.pxHeight };
  /* A slice is a part of the raster, so nothing outside it is cut; a store
     that says otherwise is clipped rather than believed. */
  const clipped = raw ? raw.list.map((s) => ({ ...s, rect: intersect(s.rect, whole) })).filter((s) => s.rect) : [];
  const list = clipped.length ? clipped : [{ index: 1, rect: whole }];
  const box = (raw && intersect(raw.box, whole)) || whole;
  const origin = { x: o.canvasX, y: o.canvasY };
  const regions = list.map((s) => ({ slice: s.index, ...regionOf({ rect: s.rect, box, origin, rotation, ratio }) }));
  const { cols, rows } = groupShape(o.group);
  const keyNum = Number(o.key);
  const label = String(pp(node.control).label || '');
  return {
    key: o.key,
    name: `Out ${o.key}`,
    label,
    plugs: plugTypes(store, o.key),
    device: pp(node.mapping).device ?? null,
    format: status.format || null,
    rate: num(status.rate),
    size: { width: num(status.sizeH), height: num(status.sizeV) },
    total: { h: num(status.totalH), v: num(status.totalV) },
    state: o.state,
    group: o.group || '1X1',
    groupShape: { cols, rows },
    members: cols * rows > 1 && Number.isInteger(keyNum)
      ? Array.from({ length: cols * rows }, (_, i) => String(keyNum + i)) : [o.key],
    capability: o.capability,
    rotation,
    ratio,
    raster: { width: o.pxWidth, height: o.pxHeight },
    footprint: { x: o.canvasX, y: o.canvasY, w: o.footprintWidth, h: o.footprintHeight },
    regions,
    slicesRead: !!raw
  };
}

/** What about an output is assumed rather than proven, as `NOTES` keys. */
export function assumptionsFor(output) {
  const out = [];
  if (output.regions.length > 1 || output.regions.some((r) => r.aoi.x || r.aoi.y || r.aoi.w !== output.raster.width || r.aoi.h !== output.raster.height)) out.push('slices');
  if (output.ratio.h !== 1 || output.ratio.v !== 1) out.push('pitch');
  if (output.rotation) out.push('rotation');
  if (output.groupShape.cols * output.groupShape.rows > 1) out.push('group');
  return out;
}

/* ----------------------------------------------------------------- cutting */

const intersect = (a, b) => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
};

/**
 * The raster rectangle a region-local rectangle lands on, for a rotation.
 * `L` is in the region's own (canvas-oriented, unscaled) units; `A` is the
 * region's AOI in the raster. Counter-clockwise: at 90 the region's left edge
 * becomes the raster's bottom edge.
 */
export function localToRaster(L, A, rotation) {
  switch (rotation) {
    case 90: return { x: A.x + L.y, y: A.y + A.h - L.x - L.w, w: L.h, h: L.w };
    case 180: return { x: A.x + A.w - L.x - L.w, y: A.y + A.h - L.y - L.h, w: L.w, h: L.h };
    case 270: return { x: A.x + A.w - L.y - L.h, y: A.y + L.x, w: L.h, h: L.w };
    default: return { x: A.x + L.x, y: A.y + L.y, w: L.w, h: L.h };
  }
}

/**
 * The 2D transform that draws a blit's content (`lw × lh`, upright) into its
 * raster rectangle: `[a, b, c, d, e, f]` as `CanvasRenderingContext2D.
 * setTransform` takes it, x' = a·u + c·v + e, y' = b·u + d·v + f. Integer
 * whenever the rectangle is, so a 1:1 blit is a pixel copy.
 */
export function blitTransform(blit) {
  const { dst, lw, lh, rotation } = blit;
  switch (rotation) {
    case 90: return [0, -1, 1, 0, dst.x, dst.y + lw];
    case 180: return [-1, 0, 0, -1, dst.x + lw, dst.y + lh];
    case 270: return [0, 1, -1, 0, dst.x + lh, dst.y];
    default: return [1, 0, 0, 1, dst.x, dst.y];
  }
}

/**
 * What to draw for one output: the blits that copy parts of the picture into
 * its raster. `place` is the picture's rectangle on the screen canvas and
 * `image` its pixel size. Each blit is `{ src, dst, lw, lh, rotation, region }`:
 * `src` in picture pixels, `dst` in raster pixels, `lw × lh` the content's
 * size before rotation. Everything not covered is the background colour.
 */
export function outputBlits(output, place, image) {
  if (!place || !image || !(place.w > 0 && place.h > 0)) return [];
  const sx = image.width / place.w;
  const sy = image.height / place.h;
  const blits = [];
  for (const region of output.regions) {
    const C = region.canvas;
    const I = intersect(C, place);
    if (!I) continue;
    const kx = C.w / region.local.w;
    const ky = C.h / region.local.h;
    const L = { x: (I.x - C.x) / kx, y: (I.y - C.y) / ky, w: I.w / kx, h: I.h / ky };
    const dst = localToRaster(L, region.aoi, region.rotation);
    blits.push({
      region: region.slice,
      rotation: region.rotation,
      lw: L.w,
      lh: L.h,
      dst,
      src: { x: (I.x - place.x) * sx, y: (I.y - place.y) * sy, w: I.w * sx, h: I.h * sy }
    });
  }
  return blits;
}

const isInt = (n) => Math.abs(n - Math.round(n)) < 1e-9;

/** Whether a blit is a straight pixel copy: whole pixels, nothing scaled. */
export function isExact(blit) {
  const { src, dst, lw, lh } = blit;
  return [src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h].every(isInt)
    && Math.abs(src.w - lw) < 1e-9 && Math.abs(src.h - lh) < 1e-9;
}

/** Whether a screen's NATIVE layer is allocated — the only way a set reaches it. */
export function nativeLayer(store, screenId) {
  const cap = pp(store.get([ROOT, 'screenList', 'items', screenId, 'layerList', 'items', 'NATIVE', 'status'])).capability;
  return { fitted: !!cap && cap !== 'OFF', capability: cap || null };
}

/* -------------------------------------------------------- write commands */

/** A background set's per-output content. */
export const setContentPath = (screenId, set, out) =>
  [...BG, 'screenList', 'items', screenId, 'backgroundSetList', 'items', String(set), 'outputList', 'items', String(out), 'control', 'pp', 'content'];
/** A background set's label. */
export const setLabelPath = (screenId, set) =>
  [...BG, 'screenList', 'items', screenId, 'backgroundSetList', 'items', String(set), 'pp', 'label'];
/** A preset buffer's NATIVE layer source. */
export const nativeSourcePath = (screenId, letter) =>
  [ROOT, 'screenList', 'items', screenId, 'presetList', 'items', letter, 'layerList', 'items', 'NATIVE', 'source', 'pp', 'inputNum'];

const bgClaimPath = (source, out) => {
  const live = /^LIVE_(\d+)$/.exec(source);
  if (live) return [...BG, 'inputList', 'items', `IN_${live[1]}`, 'control', 'pp', 'useOnOutput'];
  const still = /^STILL_(\d+)$/.exec(source);
  if (still) return [...BG, 'stillList', 'items', still[1], 'control', 'pp', 'useOnOutput'];
  return null;
};

/**
 * The writes that set one output of one background set to `source`, exactly
 * as the Web RCS's `axSetBackgroundSetOutputSource` sends them:
 *
 *   1. the content being replaced, if it is an input or a still that claims
 *      this output (`…/backgrounds/inputList|stillList/<n>/control/pp/
 *      useOnOutput`), is handed to the next output of any set still using it,
 *      or to NONE;
 *   2. the new input or still claims this output;
 *   3. the content itself.
 *
 * Immediate: the bundle has no apply step anywhere under
 * `preconfig/backgrounds`. Reads the claims off `store` as they are now.
 */
export function contentWrites(store, screenId, set, out, source) {
  const writes = [];
  const outKey = String(out);
  const old = store.get(setContentPath(screenId, set, out)) || 'NONE';
  if (old !== 'NONE') {
    const claim = bgClaimPath(old, outKey);
    if (claim && String(store.get(claim)) === outKey) {
      const next = otherOutputUsing(store, old, screenId, set, outKey);
      writes.push({ path: claim, value: next || 'NONE' });
    }
  }
  const claim = bgClaimPath(source, outKey);
  if (claim) writes.push({ path: claim, value: outKey });
  writes.push({ path: setContentPath(screenId, set, out), value: source });
  return writes;
}

/** The first other output, in any set of any screen, whose content is `source` — the bundle's order. */
function otherOutputUsing(store, source, screenId, set, outKey) {
  const screens = store.get([...BG, 'screenList', 'items']) || {};
  for (const [sid, sv] of Object.entries(screens)) {
    const sets = (sv.backgroundSetList && sv.backgroundSetList.items) || {};
    for (const [bid, bv] of Object.entries(sets)) {
      const outs = (bv.outputList && bv.outputList.items) || {};
      for (const [ok, ov] of Object.entries(outs)) {
        if (sid === screenId && bid === String(set) && ok === outKey) continue;
        if (pp(ov && ov.control).content === source) return ok;
      }
    }
  }
  return null;
}

/** A background set's label write, cut to what the switcher keeps. */
export const setLabelWrite = (screenId, set, label) =>
  ({ path: setLabelPath(screenId, set), value: String(label || '').slice(0, LABEL_MAX) });

/* ----------------------------------------------------- live inputs, EDIDs */

/**
 * Inputs a live background could come from, per output: fitted, not already
 * a live background elsewhere, and — where the switcher says — compatible.
 * `outputsCompatibility` is empty on a simulator, so an empty list is read as
 * "not stated" rather than "compatible with nothing".
 */
export function liveCandidates(store) {
  const inputs = store.get([ROOT, 'inputList', 'items']) || {};
  const bgInputs = store.get([...BG, 'inputList', 'items']) || {};
  /* What each input is receiving now, from the dialect's own reader (the
     Variables plugin's `$IN3.rate`): a source already sending the output's
     format is the one to suggest. Rate in Hz. */
  const dialect = dialectFor(store);
  const signals = new Map(((dialect && dialect.inputFormats) ? dialect.inputFormats(store) : []).map((f) => [f.key, f]));
  const out = [];
  for (const key of Object.keys(inputs).filter((k) => /^IN_\d+$/.test(k)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))) {
    const node = inputs[key];
    if (pp(node.mapping).isValid !== true) continue;
    const bg = bgInputs[key] || {};
    const st = pp(bg.status);
    const plug = pp(node.plugList && node.plugList.items && node.plugList.items['1'] && node.plugList.items['1'].status);
    const status = pp(node.status);
    /* A member of an input group is not a source of its own, and a disabled
       input carries nothing. */
    if (status.global === 'GROUPED' || status.global === 'DISABLE') continue;
    out.push({
      key,
      label: String(pp(node.control).label || ''),
      plug: plug.type || null,
      device: pp(node.mapping).device ?? null,
      usedOnOutput: st.usedOnOutput && st.usedOnOutput !== 'NONE' ? String(st.usedOnOutput) : null,
      compatibility: Array.isArray(st.outputsCompatibility) ? st.outputsCompatibility.map(String) : [],
      onAir: status.isOnProgram === true || status.isOnPreview === true,
      state: status.global || null,
      signal: signals.get(key) || null
    });
  }
  return out;
}

/** Whether an input is receiving exactly an output's raster and rate right now. */
export const sendingFormatOf = (c, output) => !!(c.signal && c.signal.valid && output
  && c.signal.width === output.raster.width && c.signal.height === output.raster.height
  && output.rate && c.signal.rate != null && Math.abs(c.signal.rate * 1000 - output.rate) < 1);

/**
 * The inputs to suggest for an output, best first: not already another
 * output's background, compatible where the switcher says, on the output's
 * own frame (the Web RCS offers nothing else); then not on air in a layer,
 * already this output's, and already receiving its format, in that order.
 * `output` is a topology output, or just its key.
 */
export function suggestInputs(candidates, output, taken = new Set(), device = null) {
  const key = String(typeof output === 'object' && output ? output.key : output);
  const o = typeof output === 'object' ? output : null;
  return candidates
    .filter((c) => !taken.has(c.key) && (!c.usedOnOutput || c.usedOnOutput === key))
    .filter((c) => !c.compatibility.length || c.compatibility.includes(key))
    .filter((c) => device == null || c.device == null || String(c.device) === String(device))
    .sort((a, b) => (a.onAir - b.onAir)
      || ((b.usedOnOutput === key) - (a.usedOnOutput === key))
      || (sendingFormatOf(b, o) - sendingFormatOf(a, o)));
}

/** Millihertz to the template spelling: 59940 → 59HZ94, 60000 → 60HZ. */
export function templateRate(mHz) {
  const table = { 23976: '23HZ976', 24000: '24HZ', 25000: '25HZ', 29970: '29HZ97', 30000: '30HZ', 47952: '47HZ95', 48000: '48HZ',
    50000: '50HZ', 59940: '59HZ94', 60000: '60HZ', 100000: '100HZ', 119880: '119HZ88', 120000: '120HZ' };
  return table[Math.round(Number(mHz))] || null;
}

/**
 * Which of the switcher's own EDIDs makes a source output exactly what a
 * live background on this output needs: an input plug's `fromTemplate` key
 * (`1920_1080_60HZ`, `…_RB` for a reduced-blanking computer format) or
 * `fromCustom` slot for a custom output format. The switcher builds the EDID
 * itself — the same "load from template" the vendor's EDID page uses — so no
 * EDID is written by hand here. `templates` is the plug's `templateValidity`
 * map: `{ key: true|false }`.
 */
export function edidChoice(output, templates) {
  const custom = /^COMPUTER_CUSTOM_(\d+)$/.exec(String(output.format || ''));
  if (custom) return { kind: 'custom', key: custom[1], label: `custom format M${custom[1]}` };
  const rate = templateRate(output.rate);
  if (!rate) return { kind: null, why: `no EDID template for a rate of ${(output.rate / 1000).toFixed(3)} Hz` };
  const base = `${output.raster.width}_${output.raster.height}_${rate}`;
  const rb = /_RB\d?$/.test(String(output.format || ''));
  const wanted = rb ? [`${base}_RB`, base] : [base, `${base}_RB`];
  const key = wanted.find((k) => templates && templates[k] === true);
  if (key) return { kind: 'template', key, label: key.replace(/_/g, ' ').replace(/(\d+) (\d+)/, '$1×$2') };
  return { kind: null, why: `the switcher has no EDID template for ${output.raster.width} × ${output.raster.height} at ${rate.replace('HZ', '.').replace(/\.$/, '')} Hz` };
}

/** The input plug's EDID templates as `{ key: valid }`. */
export function plugTemplates(store, input, plug = '1') {
  const items = store.get([ROOT, 'inputList', 'items', input, 'plugList', 'items', plug, 'edid', 'cmd', 'fromTemplate', 'bankList', 'items']) || {};
  const out = {};
  for (const [k, v] of Object.entries(items)) out[k] = pp(v).templateValidity === true;
  return out;
}

/** The two writes that load an EDID into an input plug: `xApply` false, then true, as Web RCS sends it. */
export function edidWrites(input, choice, plug = '1') {
  if (!choice || !choice.kind) return [];
  const bank = choice.kind === 'custom' ? 'fromCustom' : 'fromTemplate';
  const path = [ROOT, 'inputList', 'items', input, 'plugList', 'items', plug, 'edid', 'cmd', bank, 'bankList', 'items', choice.key, 'pp', 'xApply'];
  return [{ path, value: false }, { path, value: true }];
}
