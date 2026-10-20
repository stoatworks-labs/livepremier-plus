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
 * ## The model of an output
 *
 * Where each output sits on its screen's canvas — its slices, rotation,
 * pitch and group — and the background-set writes are in
 * `src/core/backgrounds.js`, with what is proven about them; Resolume Mapping
 * reads the same model. This file exports those names as it always did.
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

import {
  SET_COUNT, readSets, firstFreeSet, stillsInSets, readLibrary, readStills, CAPACITY_UNITS, CAPACITY_FORMAT, likelyCapability, stillPath, libraryDeletePath, pulse, LABEL_MAX, stillWrites, stillRestoreWrites, libraryDeleteWrites,
  preStillsNew, preStillsCurrent, stillFormatPath, preStillsTrigger, emptySlots, orderSlots, pointedText
} from '../../src/core/stills.js';
import {
  MAX_SLICES, ROTATION, readScreens, rasterToLocal, regionOf, screenTopology, assumptionsFor, localToRaster, blitTransform, outputBlits, isExact,
  nativeLayer, setContentPath, setLabelPath, nativeSourcePath, contentWrites, setLabelWrite,
  liveCandidates, sendingFormatOf, suggestInputs, templateRate, edidChoice, plugTemplates, edidWrites
} from '../../src/core/backgrounds.js';

/** Which model this is — `model.js` and the plan carry it. Midra 4K / Alta 4K is `mng.js`. */
export const PLATFORM = 'nlc';

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

/* The library and the stills are read and written in `src/core/stills.js`,
   shared with the UMD generator; these are what this plugin always exported. */
export {
  SET_COUNT, readSets, firstFreeSet, stillsInSets, readLibrary, readStills, CAPACITY_UNITS, likelyCapability, stillPath, libraryDeletePath, pulse, LABEL_MAX, stillWrites, stillRestoreWrites, libraryDeleteWrites,
  preStillsNew, preStillsCurrent, stillFormatPath, preStillsTrigger
};

/* The outputs, the set writes and the live inputs are in
   `src/core/backgrounds.js`, shared with Resolume Mapping; likewise. */
export {
  MAX_SLICES, ROTATION, readScreens, rasterToLocal, regionOf, screenTopology, assumptionsFor, localToRaster, blitTransform, outputBlits, isExact,
  nativeLayer, setContentPath, setLabelPath, nativeSourcePath, contentWrites, setLabelWrite,
  liveCandidates, sendingFormatOf, suggestInputs, templateRate, edidChoice, plugTemplates, edidWrites
};

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

/** The format that is each capacity beyond doubt (`core/stills.js`, where it is shared). */
const CANONICAL_FORMAT = CAPACITY_FORMAT;

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
 *
 * An empty library slot a still points at is only chosen with
 * `opts.assignedSlots`, and after every clean one: the still shows whatever
 * is uploaded there (`core/stills.js` `emptySlots`), so each one chosen is a
 * warning naming the stills, and without the option a plan short of slots
 * says how many it passed over.
 *
 * `opts.reserve` — `{ slots: Set<number>, stills: Set<string> }` — is what
 * plans made before this one have already taken: a document's pages are
 * planned one after another (`deck.js`), and two pages must never be handed
 * the same slot or still.
 */
export function buildPlan(store, job, opts = {}) {
  const problems = [];
  const warnings = [];
  const source = job.source === 'live' ? 'live' : 'stills';
  const image = job.image && job.image.width > 0 ? job.image : null;
  if (!image) problems.push(source === 'live' ? 'Set the content size (or choose a picture) first.' : 'Choose a picture first.');

  const library = readLibrary(store);
  const assignedSlots = opts.assignedSlots === true;
  const empty = emptySlots(store);
  const usable = orderSlots(empty, { assigned: assignedSlots });
  const freeSlots = usable.map((s) => s.slot);
  const pointers = new Map(usable.filter((s) => s.stills.length).map((s) => [s.slot, s.stills]));
  const passedOver = assignedSlots ? 0 : empty.filter((s) => s.stills.length).length;
  const stills = readStills(store);
  const freeStills = stills.filter((s) => s.free);
  const reserve = opts.reserve || {};
  const takenSlots = new Set(reserve.slots || []);
  const takenStills = new Set(reserve.stills || []);
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
    /* Filling a set is optional in the stills mode — the images and stills
       are useful without one (Allan: "and optionally also assign the
       background set"). The live mode is nothing but a set. */
    const assign = source === 'live' || !(job.options && job.options.assignSet === false);
    const setIndex = assign ? Number((job.sets || {})[id]) || (firstFreeSet(sets) || {}).index || null : null;
    const set = assign ? sets.find((s) => s.index === setIndex) || null : null;
    if (assign && !set) problems.push(`${id}: no free background set — choose one to overwrite.`);
    else if (set && set.onProgram && !opts.allowProgram) problems.push(`${id}: background set ${set.index} is on program — confirm to write it live.`);
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
        if (row.librarySlot == null) problems.push(`${id} ${o.name}: the image library has no free slot${passedOver ? ` that no still points at (${passedOver} assigned passed over — tick “Use empty slots a still points at” to use ${passedOver === 1 ? 'it' : 'them'})` : ''}.`);
        else if (pointers.has(row.librarySlot)) warnings.push(`${id} ${o.name}: library slot ${row.librarySlot} is empty, but ${pointedText(pointers.get(row.librarySlot))}.`);
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
      if (set && row.previous !== 'NONE' && row.previous !== row.content) warnings.push(`${id} set ${setIndex} ${o.name}: replaces ${row.previous}.`);
      return row;
    });
    if (!topo.outputs.length) problems.push(`${id} has no outputs to give a background.`);
    for (const s of topo.skipped) warnings.push(`${id} Out ${s.key}: skipped — ${s.why}.`);
    const native = nativeLayer(store, id);
    screens.push({
      id, label: topo.label, canvas: topo.canvas, assign, set, setIndex, place, outputs, native,
      /* Whether the screen can show a set, in words — `mng.js` says the same of its preconfig. */
      display: { ok: native.fitted, why: native.fitted ? null : 'NATIVE layer not allocated — the set can be built, not shown, until it is (Preconfig ▸ Resources)' }
    });
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
    platform: PLATFORM,
    source,
    problems,
    warnings,
    screens,
    capacityChanges: changes,
    assignedSlots,
    library: { free: freeSlots.length, sizeKB: library.sizeKB, maxKB: library.maxKB }
  };
}

/** File name of an output's image: screen, output, raster — what the library card will show. */
export function imageName(screenId, output, stem = 'bg') {
  const safe = String(stem || 'bg').replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 24) || 'bg';
  return `${safe}_${screenId}_Out${output.key}_${output.raster.width}x${output.raster.height}.png`;
}

