/*
 * Background Slicer — the geometry and the plan. No DOM, no I/O: the panel,
 * the apply step, the exports and the tests all import this.
 *
 * ## What it does
 *
 * One picture is laid over one or more screens. For every output on those
 * screens this works out which part of the picture that output shows, and
 * cuts an image the exact size of the output's raster — so a background set
 * built from those stills puts the picture back together across the outputs,
 * pixel for pixel. The live-input mode is the same arithmetic with a media
 * server's output standing where the still would have been: the regions this
 * file computes are the slices of the media server's output map.
 *
 * ## The model of an output, and how much of it is proven
 *
 * Everything here is read off `device/outputList/items/<out>/canvas/status`
 * through `core/pitch.js`'s `screenOutputs()` plus the slices beside it. The
 * names and shapes were read off a LivePremier Simulator 6.2.73 and the Web
 * RCS bundle that drives it; what they MEAN is pinned to different degrees,
 * and the panel says which (`NOTES`):
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
 *
 * ## Exact, and when it is not
 *
 * At a pitch of 1.000 and the picture placed at its own size on whole pixels,
 * every number below is an integer and a slice is a straight copy of pixels:
 * `test/bg-slicer.test.js` renders a pattern through the plan on a raw RGBA
 * buffer and checks the pixels either side of every edge. Anything scaled — a
 * Fit, a stretch, a pitch ratio — is resampled, and the plan says so on the
 * output (`exact: false`).
 */

import { ROOT } from '../../src/core/paths.js';
import { listDestinations } from '../../src/core/screens.js';
import { screenOutputs } from '../../src/core/pitch.js';
import { dialectFor, NLC } from '../../src/core/dialect.js';

const pp = (node) => (node && typeof node === 'object' && node.pp) || {};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Eight background sets per screen (manual p.100; the store has 1..8). */
export const SET_COUNT = 8;
/** Four slices per output — `OUTPUT_SLICE` is 1..4. */
export const MAX_SLICES = 4;

/** `OUTPUT_ROTATION` to degrees counter-clockwise. */
export const ROTATION = { NONE: 0, '90_DEGREE': 90, '180_DEGREE': 180, '270_DEGREE': 270 };

/**
 * The plain-language status of each part of the model, for the panel and the
 * docs. `proven` means read off the device or stated by Analog Way; `assumed`
 * means this file's best reading, shown to the operator as such.
 */
export const NOTES = {
  oneToOne: { proven: true, text: 'A background is shown 1:1 in the output raster ("an unscalable background layer", Aquilon manual v6.2 p.86), so each image is cut at exactly the output’s raster size.' },
  slices: { proven: false, text: 'An output’s slices are its connectors, read off the switcher: where each sits in the output’s raster and how much it carries. Only a single full-raster slice has been seen on a device; more than one follows the Web RCS’s own arithmetic.' },
  pitch: { proven: false, text: 'A pitch ratio other than 1.000 scales the canvas the output covers; the cut is then resampled, not a pixel copy.' },
  rotation: { proven: false, text: 'A rotated output’s image is turned the way the switcher turns its layers. Whether it turns a background as well is not established — check the first one on the display.' },
  group: { proven: false, text: 'An output group gets one background at its leader, covering the group’s whole raster, which the switcher splits across the connectors. No grouped output has been read off a device.' },
  native: { proven: true, text: 'A background set reaches the screen through its NATIVE layer: source NATIVE_<set> (AWJ guide §3.10). A screen whose NATIVE layer is not allocated cannot show one.' }
};

/* ------------------------------------------------------------------ topology */

/** Screens in service, LivePremier only — Midra and Alta have no background sets. */
export function readScreens(store) {
  if (!store || !store.ready || dialectFor(store) !== NLC) return [];
  return listDestinations(store)
    .filter((d) => d.kind === 'screen')
    .map((d) => ({ id: d.id, label: d.label || '', canvas: { width: d.canvas.width, height: d.canvas.height } }));
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
  if (!screen) return null;
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

/* ------------------------------------------------------------- placement */

export const PRESETS = ['fit', 'fill', 'stretch', 'native', 'centre'];

/**
 * Where a picture of `image` size goes in a `frame`, as whole canvas pixels.
 * `native` is 1:1 at the frame's top-left; `centre` keeps the current size
 * and centres it.
 */
export function presetPlacement(preset, image, frame, current = null) {
  const { width: iw, height: ih } = image;
  const fx = frame.x || 0;
  const fy = frame.y || 0;
  const centred = (w, h) => ({ x: fx + Math.round((frame.w - w) / 2), y: fy + Math.round((frame.h - h) / 2), w, h });
  switch (preset) {
    case 'fit': {
      const s = Math.min(frame.w / iw, frame.h / ih);
      return centred(Math.max(1, Math.round(iw * s)), Math.max(1, Math.round(ih * s)));
    }
    case 'fill': {
      const s = Math.max(frame.w / iw, frame.h / ih);
      return centred(Math.max(1, Math.round(iw * s)), Math.max(1, Math.round(ih * s)));
    }
    case 'stretch': return { x: fx, y: fy, w: frame.w, h: frame.h };
    case 'centre': return centred(current ? current.w : iw, current ? current.h : ih);
    case 'native':
    default: return { x: fx, y: fy, w: iw, h: ih };
  }
}

/**
 * Screens side by side, in order, for one picture across all of them: each
 * screen's offset in the strip, and the strip's bounds. `offsets` may move
 * any screen off the default (a gap, a step down).
 */
export function spanLayout(screens, offsets = {}) {
  let x = 0;
  const placed = screens.map((s) => {
    const def = { x, y: 0 };
    x += s.canvas.width;
    const o = offsets[s.id] || def;
    return { id: s.id, x: Math.round(Number(o.x) || 0), y: Math.round(Number(o.y) || 0), w: s.canvas.width, h: s.canvas.height };
  });
  const minX = Math.min(...placed.map((p) => p.x), 0);
  const minY = Math.min(...placed.map((p) => p.y), 0);
  const maxX = Math.max(...placed.map((p) => p.x + p.w), 0);
  const maxY = Math.max(...placed.map((p) => p.y + p.h), 0);
  return { screens: placed, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

/**
 * The picture's rectangle on one screen's canvas. `job.mode` is `each` (a
 * rectangle per screen) or `span` (one rectangle in the strip, seen through
 * each screen's place in it). `screens` are the spanned screens in strip
 * order, `{ id, canvas }`, for the places nobody has moved.
 */
export function placementFor(job, screenId, screens = []) {
  if (job.mode === 'span' && job.span && job.span.rect) {
    const lay = spanLayout(screens, job.span.offsets || {});
    const off = lay.screens.find((p) => p.id === screenId) || (job.span.offsets || {})[screenId] || { x: 0, y: 0 };
    const r = job.span.rect;
    return { x: r.x - off.x, y: r.y - off.y, w: r.w, h: r.h };
  }
  return (job.place || {})[screenId] || null;
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

/**
 * Draw blits into an RGBA buffer by nearest-neighbour sampling — the
 * reference the browser's `drawImage` (smoothing off) is held to, and what the
 * pixel tests run. `image` is `{ width, height, data }` (RGBA bytes);
 * returns `{ width, height, data }`.
 */
export function renderRGBA(blits, image, width, height, fill = [0, 0, 0, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  for (const b of blits) {
    const { dst, lw, lh, src, rotation } = b;
    const x0 = Math.max(0, Math.ceil(dst.x - 0.5));
    const y0 = Math.max(0, Math.ceil(dst.y - 0.5));
    const x1 = Math.min(width, Math.ceil(dst.x + dst.w - 0.5));
    const y1 = Math.min(height, Math.ceil(dst.y + dst.h - 0.5));
    for (let Y = y0; Y < y1; Y++) {
      for (let X = x0; X < x1; X++) {
        const px = X + 0.5;
        const py = Y + 0.5;
        let u; let v;
        switch (rotation) {
          case 90: v = px - dst.x; u = dst.y + lw - py; break;
          case 180: u = dst.x + lw - px; v = dst.y + lh - py; break;
          case 270: v = dst.x + lh - px; u = py - dst.y; break;
          default: u = px - dst.x; v = py - dst.y;
        }
        const ix = Math.floor(src.x + (u * src.w) / lw);
        const iy = Math.floor(src.y + (v * src.h) / lh);
        if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) continue;
        const s = (iy * image.width + ix) * 4;
        const d = (Y * width + X) * 4;
        data[d] = image.data[s];
        data[d + 1] = image.data[s + 1];
        data[d + 2] = image.data[s + 2];
        data[d + 3] = image.data[s + 3];
      }
    }
  }
  return { width, height, data };
}

/* ------------------------------------------------------------- the device */

const BG = [ROOT, 'preconfig', 'backgrounds'];
const STILLS = [ROOT, 'stillList'];
const LIBRARY = [ROOT, 'stillList', 'library'];
const PRE_STILLS = [ROOT, 'preconfig', 'stills'];

/** The eight background sets of a screen: `{ index, label, onProgram, onPreview, contents: {out: content} }`. */
export function readSets(store, screenId) {
  const list = store.get([...BG, 'screenList', 'items', screenId, 'backgroundSetList']) || {};
  const items = list.items || {};
  const out = [];
  for (let n = 1; n <= SET_COUNT; n++) {
    const set = items[String(n)];
    if (!set) continue;
    const st = pp(set.status);
    const contents = {};
    const outs = (set.outputList && set.outputList.items) || {};
    for (const [k, v] of Object.entries(outs)) {
      const c = pp(v && v.control).content;
      if (c && c !== 'NONE') contents[k] = c;
    }
    out.push({
      index: n,
      label: String(pp(set).label || ''),
      onProgram: st.isOnProgram === true,
      onPreview: st.isOnPreview === true,
      contents,
      empty: Object.keys(contents).length === 0 && !pp(set).label
    });
  }
  return out;
}

/** The first set of a screen with no content, no label and not on air; else null. */
export function firstFreeSet(sets) {
  return sets.find((s) => s.empty && !s.onProgram && !s.onPreview) || null;
}

/** Every `STILL_n` any background set of any screen names. */
export function stillsInSets(store) {
  const used = new Set();
  const screens = store.get([...BG, 'screenList', 'items']) || {};
  for (const sid of Object.keys(screens)) {
    for (const set of readSets(store, sid)) {
      for (const c of Object.values(set.contents)) {
        const m = /^STILL_(\d+)$/.exec(c);
        if (m) used.add(m[1]);
      }
    }
  }
  return used;
}

/** The image library: `{ slots: [{ slot, free, fileName, width, height, size }], sizeKB, maxKB, limits }`. */
export function readLibrary(store) {
  const bank = store.get([...LIBRARY, 'bankList']) || {};
  const items = bank.items || {};
  const keys = Array.isArray(bank.itemKeys) ? bank.itemKeys : Object.keys(items);
  const slots = keys.map((k) => {
    const st = pp(items[k] && items[k].status);
    return {
      slot: Number(k),
      free: st.isValid !== true,
      used: st.isUsed === true,
      fileName: String(st.fileName || ''),
      width: num(st.width) || 0,
      height: num(st.height) || 0,
      size: num(st.fileSize) || 0
    };
  }).filter((s) => Number.isInteger(s.slot));
  const status = pp(bank.status);
  const limits = pp(store.get([...LIBRARY, 'import', 'status']));
  return {
    slots,
    /* `maxSize` is 972800 on a 6.2.73 simulator: the manual's "950 MB
       limit" (p.126) in KiB, so both are read as kilobytes. */
    sizeKB: num(status.size) || 0,
    maxKB: num(status.maxSize) || 0,
    limits: {
      maxWidth: num(limits.maxWidth) || 16384,
      maxHeight: num(limits.maxHeight) || 8192,
      maxPixels: num(limits.maxTotalPixel) || 39321600,
      maxBytes: num(limits.maxFileSize) || 157286400
    }
  };
}

/**
 * The stills of this frame, with what makes one free to take: fitted
 * (`isAvailable`), holding nothing (`mode` NONE and no valid image), named by
 * no background set and claimed by no output (`preconfig/backgrounds/
 * stillList/<n>/control/pp/useOnOutput`), and enabled in the applied
 * preconfig. `capability` is the applied capacity (`preconfig/stills/current`).
 */
export function readStills(store) {
  const list = store.get(STILLS) || {};
  const items = list.items || {};
  const keys = Array.isArray(list.itemKeys) ? list.itemKeys : Object.keys(items);
  const current = (store.get([...PRE_STILLS, 'current', 'stillList', 'items'])) || {};
  const staged = (store.get([...PRE_STILLS, 'new', 'stillList', 'items'])) || {};
  const bgStills = (store.get([...BG, 'stillList', 'items'])) || {};
  const inSets = stillsInSets(store);
  return keys.filter((k) => /^\d+$/.test(k)).map((k) => {
    const node = items[k] || {};
    const st = pp(node.status);
    const ctl = pp(node.control);
    const pre = pp(current[k] && current[k].status);
    const helper = staged[k] && staged[k].control && staged[k].control.helper;
    const validity = staged[k] && staged[k].status && staged[k].status.helper;
    const claimed = pp(bgStills[k] && bgStills[k].control).useOnOutput;
    const fitted = st.isAvailable === true && pp(node.mapping).isValid !== false;
    const enabled = pre.global ? pre.global === 'USED' : fitted;
    const holding = ctl.mode && ctl.mode !== 'NONE';
    const onOutput = claimed && claimed !== 'NONE' ? String(claimed) : null;
    return {
      key: k,
      label: String(ctl.label || ''),
      device: pp(node.mapping).device ?? null,
      fitted,
      enabled,
      capability: pre.capability || st.capability || null,
      format: pp(helper).format || null,
      formats: Array.isArray(pp(validity).formatValidity) ? pp(validity).formatValidity : [],
      mode: ctl.mode || 'NONE',
      source: ctl.source,
      rescale: ctl.rescale || null,
      inSet: inSets.has(k),
      onOutput,
      onAir: st.isOnProgram === true || st.isOnPreview === true,
      free: fitted && enabled && !holding && st.isValid !== true && st.isUsed !== true && !inSets.has(k) && !onOutput
    };
  });
}

/** Units of still capacity, as the manual counts them (p.99/p.100): DUAL is one slot. */
export const CAPACITY_UNITS = { OFF: 0, DUAL: 1, '4K': 2, 3: 3, '5K': 4, 5: 5, 6: 6, 7: 7, '8K': 8 };

/* ---------------------------------------------------------- formats */

/**
 * Pixel sizes of the format names the still capacity helper offers, where
 * the name does not spell them. Only names whose size is certain; anything
 * else is matched by the numbers in its name, or not at all.
 */
const FORMAT_SIZES = {
  HDTV_720P: [1280, 720], HDTV_1080P: [1920, 1080], HDTV_1080I: [1920, 1080], HDTV_1080SF: [1920, 1080],
  PROJ_1200P: [1920, 1200], CINEMA_2K: [2048, 1080], UHDTV_2160P: [3840, 2160], CINEMA_4K: [4096, 2160],
  COMPUTER_VGA: [640, 480], COMPUTER_SVGA: [800, 600], COMPUTER_XGA: [1024, 768], COMPUTER_SXGA: [1280, 1024],
  COMPUTER_UXGA: [1600, 1200], COMPUTER_WUXGA: [1920, 1200], COMPUTER_QXGA: [2048, 1536], COMPUTER_WQXGA: [2560, 1600],
  COMPUTER_720P: [1280, 720], COMPUTER_900P: [1600, 900], COMPUTER_1080P: [1920, 1080]
};

/** A format name's pixel size, or null. */
export function formatSize(name) {
  const known = FORMAT_SIZES[name];
  if (known) return { width: known[0], height: known[1] };
  const m = /^COMPUTER_(\d{3,5})_(\d{3,5})(?:_RB\d?)?$/.exec(String(name || ''));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * The capacity a format probably gives a still, by its size — DUAL up to
 * 1920 × 1200, 4K up to 4096 × 2160, 5K up to 5120 × 2880, else 8K. A guess
 * used only to choose what to ask for: the switcher's own `xCheck` says what
 * the capacity really is, and a change that comes back different is refused
 * (`apply.js`). The odd capacities (3, 5, 6, 7) are never guessed at.
 */
export function likelyCapability(size) {
  const area = size.width * size.height;
  if (area <= 1920 * 1200) return 'DUAL';
  if (area <= 4096 * 2160) return '4K';
  if (area <= 5120 * 2880) return '5K';
  return '8K';
}

/** The format that is each capacity beyond doubt. */
const CANONICAL_FORMAT = { DUAL: 'HDTV_1080P', '4K': 'UHDTV_2160P', '5K': 'COMPUTER_5120_2880_RB' };

/**
 * The format to give a still's capacity helper so it can hold an output's
 * background: it must be at least the raster's size and give the output's
 * capacity — the manual's "content and output capacities must match"
 * (p.101). The output's own format first, when that fits; then one of
 * exactly the raster's size; then the capacity's own format; else the
 * smallest offered format that fits. Null when none is offered.
 */
export function chooseStillFormat(validity, output, need = output.capability) {
  const list = Array.isArray(validity) ? validity : [];
  const fits = (f) => {
    const sz = formatSize(f);
    return sz && sz.width >= output.raster.width && sz.height >= output.raster.height
      && (!need || likelyCapability(sz) === need);
  };
  if (output.format && list.includes(output.format) && fits(output.format)) return output.format;
  const exact = list.find((f) => fits(f) && formatSize(f).width === output.raster.width && formatSize(f).height === output.raster.height);
  if (exact) return exact;
  /* A capacity bigger than the raster needs (a 4K-capacity output running
     1080p): ask for the format that is that capacity beyond doubt. */
  const canonical = CANONICAL_FORMAT[need];
  if (canonical && list.includes(canonical) && fits(canonical)) return canonical;
  const ok = list.filter(fits).sort((a, b) => {
    const A = formatSize(a);
    const B = formatSize(b);
    return A.width * A.height - B.width * B.height;
  });
  return ok[0] || null;
}

/* -------------------------------------------------------------- the plan */

/**
 * Everything that would be written, worked out before anything is.
 *
 * `job`: `{ screens: [ids], mode, place, span, image: {width,height}|null,
 *   sets: { S1: 3 }, live: { '<screen>/<out>': 'IN_5' }, source: 'stills'|'live' }`.
 *
 * Only free library slots and free stills are ever chosen, so by default
 * nothing on the switcher is overwritten. A set on program is refused unless
 * `opts.allowProgram`; a set holding content is listed as overwritten.
 */
export function buildPlan(store, job, opts = {}) {
  const problems = [];
  const warnings = [];
  const source = job.source === 'live' ? 'live' : 'stills';
  const image = job.image && job.image.width > 0 ? job.image : null;
  if (!image) problems.push(source === 'live' ? 'Set the content size (or choose a picture) first.' : 'Choose a picture first.');

  const library = readLibrary(store);
  const freeSlots = library.slots.filter((s) => s.free).map((s) => s.slot);
  const stills = readStills(store);
  const freeStills = stills.filter((s) => s.free);
  const takenSlots = new Set();
  const takenStills = new Set();
  const pickSlot = () => { const s = freeSlots.find((x) => !takenSlots.has(x)); if (s != null) takenSlots.add(s); return s ?? null; };
  /*
   * A still of the output's own capacity if there is a free one; else one
   * whose capacity must change, preferring one with free stills after it —
   * raising a capacity takes the next slots (manual p.100), and the
   * switcher's own check decides exactly which (see apply.js). Only stills on
   * the output's own frame: the Web RCS refuses a background from another
   * device (`canUseOnBackgroundSetOutput`).
   */
  const pickStill = (cap, device) => {
    const ok = (s) => !takenStills.has(s.key) && (device == null || s.device == null || String(s.device) === String(device));
    const units = CAPACITY_UNITS[cap] || 1;
    const roomAfter = (s) => {
      const i = stills.indexOf(s);
      return stills.slice(i + 1, i + units).every((n) => n.free && !takenStills.has(n.key));
    };
    const pick = freeStills.find((s) => ok(s) && s.capability === cap)
      || freeStills.find((s) => ok(s) && roomAfter(s))
      || freeStills.find(ok);
    if (pick) takenStills.add(pick.key);
    return pick || null;
  };

  const inService = readScreens(store);
  const spanned = (job.screens || []).map((id) => inService.find((s) => s.id === id)).filter(Boolean);
  const screens = [];
  for (const id of job.screens || []) {
    const topo = screenTopology(store, id);
    if (!topo) { problems.push(`${id} is not a screen in service.`); continue; }
    const sets = readSets(store, id);
    const setIndex = Number((job.sets || {})[id]) || (firstFreeSet(sets) || {}).index || null;
    const set = sets.find((s) => s.index === setIndex) || null;
    if (!set) problems.push(`${id}: no free background set — choose one to overwrite.`);
    else if (set.onProgram && !opts.allowProgram) problems.push(`${id}: background set ${set.index} is on program — confirm to write it live.`);
    const place = placementFor(job, id, spanned);
    if (!place) problems.push(`${id}: the picture is not placed on this screen.`);

    const outputs = topo.outputs.map((o) => {
      const blits = image && place ? outputBlits(o, place, image) : [];
      const exact = blits.length > 0 && blits.every(isExact);
      const row = {
        key: o.key,
        name: o.name,
        label: o.label,
        raster: o.raster,
        format: o.format,
        rate: o.rate,
        total: o.total,
        plugs: o.plugs,
        group: o.group,
        members: o.members,
        rotation: o.rotation,
        capability: o.capability,
        assumptions: assumptionsFor(o),
        regions: o.regions,
        blits,
        exact,
        covered: blits.length > 0,
        previous: set ? set.contents[o.key] || 'NONE' : 'NONE'
      };
      if (!blits.length && place) warnings.push(`${id} ${o.name}: the picture does not reach this output; it gets a plain background.`);
      if (o.raster.width > library.limits.maxWidth || o.raster.height > library.limits.maxHeight
          || o.raster.width * o.raster.height > library.limits.maxPixels) {
        problems.push(`${id} ${o.name}: ${o.raster.width} × ${o.raster.height} is larger than the image library takes.`);
      }
      if (source === 'stills') {
        row.librarySlot = pickSlot();
        if (row.librarySlot == null) problems.push(`${id} ${o.name}: the image library has no free slot.`);
        const still = pickStill(o.capability, o.device);
        row.still = still ? still.key : null;
        row.stillCapability = still ? still.capability : null;
        row.stillBefore = still ? { label: still.label, mode: still.mode, source: still.source, rescale: still.rescale, format: still.format } : null;
        if (still && still.capability !== o.capability) {
          const format = chooseStillFormat(still.formats, o);
          row.capacityChange = { from: still.capability, to: o.capability, format, before: still.format };
          if (!format) problems.push(`${id} ${o.name}: still ${still.key} would need a ${o.capability} capacity, and no still format of ${o.raster.width} × ${o.raster.height} is offered — set it in Preconfig ▸ Images.`);
        } else row.capacityChange = null;
        if (!still) problems.push(`${id} ${o.name}: no free still — every fitted still holds an image, a timer or a set’s content.`);
        row.content = still ? `STILL_${still.key}` : null;
      } else {
        const input = (job.live || {})[`${id}/${o.key}`] || null;
        row.input = input;
        row.edid = (job.edid || {})[`${id}/${o.key}`] || null;
        row.content = input ? `LIVE_${String(input).replace(/^IN_/, '')}` : null;
        if (!input) problems.push(`${id} ${o.name}: choose the input that carries it.`);
      }
      if (row.previous !== 'NONE' && row.previous !== row.content) warnings.push(`${id} set ${setIndex} ${o.name}: replaces ${row.previous}.`);
      return row;
    });
    if (!topo.outputs.length) problems.push(`${id} has no outputs to give a background.`);
    for (const s of topo.skipped) warnings.push(`${id} Out ${s.key}: skipped — ${s.why}.`);
    screens.push({ id, label: topo.label, canvas: topo.canvas, set, setIndex, place, outputs, native: nativeLayer(store, id) });
  }

  const inputsUsed = new Map();
  for (const s of screens) for (const o of s.outputs) {
    if (!o.input) continue;
    if (inputsUsed.has(o.input)) problems.push(`${o.input} is chosen for ${inputsUsed.get(o.input)} and ${s.id} ${o.name} — one input per output.`);
    else inputsUsed.set(o.input, `${s.id} ${o.name}`);
  }

  const changes = screens.flatMap((s) => s.outputs.filter((o) => o.capacityChange).map((o) => ({ still: o.still, ...o.capacityChange })));
  return {
    ok: problems.length === 0,
    source,
    problems,
    warnings,
    screens,
    capacityChanges: changes,
    library: { free: freeSlots.length, sizeKB: library.sizeKB, maxKB: library.maxKB }
  };
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
/** One property of a still. */
export const stillPath = (still, prop) => [...STILLS, 'items', String(still), 'control', 'pp', prop];
/** Empty a library slot — the bin on the vendor's card. */
export const libraryDeletePath = (slot) => [...LIBRARY, 'bankList', 'items', String(slot), 'control', 'pp', 'xDelete'];
/** A preset buffer's NATIVE layer source. */
export const nativeSourcePath = (screenId, letter) =>
  [ROOT, 'screenList', 'items', screenId, 'presetList', 'items', letter, 'layerList', 'items', 'NATIVE', 'source', 'pp', 'inputNum'];
/** The staged still-capacity preconfig. */
export const preStillsNew = (...tail) => [...PRE_STILLS, 'new', ...tail];
export const preStillsCurrent = (...tail) => [...PRE_STILLS, 'current', ...tail];

/** A trigger, as Web RCS pulses every `x…` property: false, then true. */
export const pulse = (path) => [{ path, value: false }, { path, value: true }];

/** The longest label a still and a background set take (`label: {max: 16}` in the bundle). */
export const LABEL_MAX = 16;

/**
 * The writes that make a still show a library image at its own size, in the
 * order the Web RCS's image picker sends them — `mode` IMAGE, then `source`
 * (the library slot, 1-based) — then `rescale` NO_RESCALE ("No rescale"; the
 * other choice, "Downscale to capacity", would resample a picture cut to be
 * pixel-exact) and the label.
 */
export function stillWrites(still, slot, label) {
  return [
    { path: stillPath(still, 'mode'), value: 'IMAGE' },
    { path: stillPath(still, 'source'), value: Number(slot) },
    { path: stillPath(still, 'rescale'), value: 'NO_RESCALE' },
    { path: stillPath(still, 'label'), value: String(label || '').slice(0, LABEL_MAX) }
  ];
}

/**
 * Put a still back as it was. Leaving IMAGE, `mode` goes first, so the still
 * never shows the slot it is being pointed back at; returning to IMAGE, the
 * source goes first for the same reason.
 */
export function stillRestoreWrites(still, before) {
  const b = before || {};
  const mode = { path: stillPath(still, 'mode'), value: b.mode || 'NONE' };
  const writes = [];
  if (mode.value !== 'IMAGE') writes.push(mode);
  if (Number.isInteger(b.source)) writes.push({ path: stillPath(still, 'source'), value: b.source });
  if (mode.value === 'IMAGE') writes.push(mode);
  writes.push({ path: stillPath(still, 'rescale'), value: b.rescale || 'SCALE_TO_CAPABILITY' });
  writes.push({ path: stillPath(still, 'label'), value: String(b.label || '') });
  return writes;
}

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

/** Empty a library slot: the vendor card's bin, pulsed. */
export const libraryDeleteWrites = (slot) => pulse(libraryDeletePath(slot));

/** A still's capacity helper format, staged in `preconfig/stills/new`. */
export const stillFormatPath = (still) => preStillsNew('stillList', 'items', String(still), 'control', 'helper', 'pp', 'format');
/** The staged side's own triggers: `xCopyFromCurrent`, `xCheck`, `xApply`. */
export const preStillsTrigger = (name) => preStillsNew('control', 'pp', name);

/** File name of an output's image: screen, output, raster — what the library card will show. */
export function imageName(screenId, output, stem = 'bg') {
  const safe = String(stem || 'bg').replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 24) || 'bg';
  return `${safe}_${screenId}_Out${output.key}_${output.raster.width}x${output.raster.height}.png`;
}

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
