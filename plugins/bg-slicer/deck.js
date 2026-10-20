/*
 * Background Slicer — a document's pages: a PDF, or a PowerPoint, Keynote or
 * OpenDocument deck the server has turned into one (`convert.js`).
 *
 * A page is not a picture of a fixed size. It is drawn — by pdf.js, in the
 * page (`document.js`) — at whatever size it is wanted, so nothing here ever
 * scales pixels that were made at another size. Two ways out:
 *
 *   - **A background set per page.** The pages are placed on the screens the
 *     way a picture is (each screen, or spanned), and each page is drawn at
 *     exactly the size of its placement on that screen; the slicer then cuts
 *     that drawing per output as it cuts any picture placed 1:1, which is a
 *     copy. Every page gets its own images, stills and set: page 1 the first
 *     set, page 2 the next, and so on, on every screen chosen. A
 *     LivePremier has eight sets a screen, so at most eight pages go at once;
 *     a Midra 4K or Alta 4K has four Background Images a screen, so four.
 *   - **Stills at a size.** Each page drawn at a width and height of the
 *     operator's choosing — Fit, Fill or Stretch into it — and put into the
 *     image library, and on a LivePremier into a free still each if asked;
 *     or just downloaded.
 *
 * Both are plans of the shape `core.buildPlan` returns, with a screen entry
 * per page (`entry`, `setLabel`, `preview`, each output's `stillLabel`), so
 * the apply step, the journal and Undo are the slicer's own (`apply.js`).
 * Planned page after page, each page's plan is told what the pages before it
 * took (`opts.reserve`), so no two pages share a slot, a still, a set or a
 * Background Image.
 *
 * No DOM, no I/O.
 */

import { presetPlacement, spanLayout, CAPACITY_UNITS, likelyCapability } from './core.js';
import { readLibrary as readLibraryNlc, readStills, LABEL_MAX, emptySlots, orderSlots, pointedText } from '../../src/core/stills.js';
import { readLibrary as readLibraryMng, nextSlots, framesOn } from './mng.js';
import { dialectFor, MNG } from '../../src/core/dialect.js';

/** What pdf.js opens in the page. */
export const PDF_EXTENSIONS = ['pdf'];
/** What the server has to turn into a PDF first — `convert.js`'s `DECK_TYPES`, which a test holds this to. */
export const DECK_EXTENSIONS = ['pptx', 'ppt', 'ppsx', 'pps', 'potx', 'odp'];
/** Decks that are recognised and not opened, and what to do instead (`convert.js` says why). */
export const REFUSED = {
  key: 'A Keynote deck is not opened here — Keynote would not export one unattended when it was tried. Export a PDF from Keynote (File ▸ Export To ▸ PDF) and open that.',
  pptm: 'A macro-enabled deck is not opened — PowerPoint would stop on its macro warning. Save it as .pptx, or export a PDF, and open that.'
};

const extOf = (file) => (/\.([a-z0-9]+)$/.exec(String((file && file.name) || '').toLowerCase()) || [])[1] || '';

/** `pdf`, `deck`, `refused` or null, for a File (or anything with a `name` and a `type`). */
export function documentKind(file) {
  const ext = extOf(file);
  if (PDF_EXTENSIONS.includes(ext) || (file && file.type === 'application/pdf')) return 'pdf';
  if (DECK_EXTENSIONS.includes(ext)) return 'deck';
  if (REFUSED[ext]) return 'refused';
  return null;
}

/** Why a refused document is not opened. */
export const refusedWhy = (file) => REFUSED[extOf(file)] || null;

/** The file chooser's list of documents. */
export const DOC_ACCEPT = [...PDF_EXTENSIONS, ...DECK_EXTENSIONS, ...Object.keys(REFUSED)].map((e) => `.${e}`).join(',');

/**
 * The size a page is called in pixels when nothing else says: 96 to the
 * inch, PowerPoint's own pixel — a 13.333 × 7.5 inch widescreen slide is
 * 1280 × 720, and PowerPoint's own "export at 1×" gives the same. PDF sizes
 * are in points, 72 to the inch. It is only the picture's nominal size for
 * placing it (1:1 is this); a page is always drawn at its placement.
 */
export const PAGE_DPI = 96;
export const pagePixels = (page) => ({
  width: Math.max(1, Math.round((page.width * PAGE_DPI) / 72)),
  height: Math.max(1, Math.round((page.height * PAGE_DPI) / 72))
});

/** How a page is fitted into an image of another shape. */
export const FITS = ['fit', 'fill', 'stretch'];

/**
 * Where a `page` (any units) is drawn inside a `box` (pixels): Fit inside it
 * with bars of the background, Fill it and lose the overflow, or Stretch to
 * it. The rectangle may overhang the box (Fill); the drawing is clipped.
 */
export function fitInto(mode, page, box) {
  if (mode === 'stretch') return { x: 0, y: 0, w: box.width, h: box.height };
  const s = mode === 'fill'
    ? Math.max(box.width / page.width, box.height / page.height)
    : Math.min(box.width / page.width, box.height / page.height);
  const w = page.width * s;
  const h = page.height * s;
  return { x: (box.width - w) / 2, y: (box.height - h) / 2, w, h };
}

/**
 * How a page is drawn into its placement for a background set. The
 * placement was made for the first chosen page; a page of the same shape
 * fills it exactly (the rounding of a placement to whole pixels is far under
 * a pixel), and one of another shape — a portrait page in a landscape PDF —
 * is fitted inside it rather than squashed.
 */
export function placedFit(page, box) {
  const a = page.width / page.height;
  const b = box.width / box.height;
  return Math.abs(a - b) / b < 0.01 ? 'stretch' : 'fit';
}

/**
 * Pages as the operator types them — `1-3, 5, 8-` — to 0-based indices,
 * in order, each once. Answers `{ pages, error }`. `numbers` is what each
 * page is called when that is not its position — a deck's slide numbers,
 * hidden slides being left out of its PDF — and then the typed numbers are
 * those: `4` is the page that is slide 4.
 */
export function parsePages(text, count, numbers = null) {
  const src = String(text == null ? '' : text).trim();
  if (!src || /^all$/i.test(src)) return { pages: Array.from({ length: count }, (_, i) => i), error: null };
  const nums = numbers && numbers.length === count ? numbers : Array.from({ length: count }, (_, i) => i + 1);
  const word = numbers && numbers.length === count ? 'slide' : 'page';
  const last = Math.max(...nums);
  const out = [];
  const seen = new Set();
  for (const part of src.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part) || /^(\d+)$/.exec(part);
    if (!m) return { pages: [], error: `“${part}” is not a ${word} or a range` };
    const range = m.length === 3;
    const a = range ? (m[1] ? Number(m[1]) : 1) : Number(m[1]);
    const b = range ? (m[2] ? Number(m[2]) : last) : Number(m[1]);
    if (a < 1 || b < 1 || a > last || b > last) return { pages: [], error: `the document has ${word}s 1 to ${last}` };
    if (!range && !nums.includes(a)) return { pages: [], error: `slide ${a} is hidden, so the deck’s PDF has no page for it` };
    nums.forEach((n, i) => {
      if (n >= Math.min(a, b) && n <= Math.max(a, b) && !seen.has(i)) { seen.add(i); out.push(i); }
    });
  }
  return { pages: out, error: null };
}

/** The number a page goes by: its slide number when the deck said, else its place. */
export const pageNumber = (deck, page) => ((deck && deck.numbers && deck.numbers[page]) || page + 1);

/** 0-based pages back to the way they are typed — `1–3, 5` — in `numbers` when given. */
export function formatPages(pages, numbers = null) {
  const sorted = [...new Set(pages.map((p) => (numbers && numbers[p]) || p + 1))].sort((a, b) => a - b);
  const runs = [];
  for (const p of sorted) {
    const last = runs[runs.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else runs.push([p, p]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

/** A page's name on the switcher — `Act 1 12` — cut to the 16 characters a still and a set keep. */
export function pageLabel(base, n, max = LABEL_MAX) {
  const suffix = ` ${n}`;
  const stem = String(base || '').trim().slice(0, Math.max(0, max - suffix.length)).trimEnd();
  return stem ? `${stem}${suffix}` : `Page ${n}`.slice(0, max);
}

/** The file stem a document's images are named from: `Show_deck_p03`, or `_s04` for a deck's slide 4. */
export function pageStem(name, number, slide = false) {
  const safe = String(name || 'deck').replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 20) || 'deck';
  return `${safe}_${slide ? 's' : 'p'}${String(number).padStart(2, '0')}`;
}

/**
 * The sets `count` pages go into on one screen, in page order: consecutive
 * from `start` when the operator chose one, else from the first set from
 * which `count` sets in a row are empty and off air, else the first such set
 * at all. Fewer than `count` when the screen runs out of sets.
 */
export function setsForPages(sets, count, start = null) {
  const free = (s) => s.empty && !s.onProgram && !s.onPreview;
  const idx = sets.map((s) => s.index);
  let from = Number(start) || null;
  if (!from) {
    for (let i = 0; i < sets.length && !from; i++) {
      if (sets.slice(i, i + count).length === count && sets.slice(i, i + count).every(free)) from = sets[i].index;
    }
  }
  if (!from) from = (sets.find(free) || sets[0] || {}).index || null;
  if (!from) return [];
  return idx.filter((n) => n >= from).slice(0, count);
}

/** Problems that recur page after page, said once with the pages they hit: `Pages 3–8: …`. */
function grouped(list) {
  const by = new Map();
  for (const { page, text } of list) {
    if (!by.has(text)) by.set(text, []);
    by.get(text).push(page);
  }
  return [...by].map(([text, pages]) => {
    const p = [...new Set(pages)];
    return `${p.length === 1 ? 'Page' : 'Pages'} ${formatPages(p)}: ${text}`;
  });
}

/**
 * Each placement unit's geometry, in whole pixels: one per screen, or one for
 * all of them when they are spanned. `image` is the size the page is drawn
 * at, which is the placement's own — so the cut of it is 1:1.
 */
export function placementUnits(job, screens) {
  const chosen = (job.screens || []).map((id) => screens.find((s) => s.id === id)).filter(Boolean);
  const size = job.size ? job.size() : job.image;
  const whole = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)) });
  if (job.mode === 'span' && chosen.length > 1) {
    const lay = spanLayout(chosen, (job.span && job.span.offsets) || {});
    const rect = whole((job.span && job.span.rect) || presetPlacement('fit', size, lay.bounds));
    return [{ key: chosen.map((s) => s.id).join('+'), screens: chosen.map((s) => s.id), rect, image: { width: rect.w, height: rect.h } }];
  }
  return chosen.map((s) => {
    const rect = whole((job.place || {})[s.id] || presetPlacement('fit', size, { x: 0, y: 0, w: s.canvas.width, h: s.canvas.height }));
    return { key: s.id, screens: [s.id], rect, image: { width: rect.w, height: rect.h } };
  });
}

/**
 * A background set per page — every chosen page on every chosen screen,
 * with `model` the platform's (`model.js`). One plan, of the shape
 * `buildPlan` returns, with a screen entry per page and placement unit.
 */
export function buildDeckPlan(model, store, job, opts = {}) {
  const deck = job.deck || {};
  const pages = deck.chosen || [];
  const issues = [];
  const notes = [];
  const top = [];
  if (!pages.length) top.push('Choose at least one page.');
  const inService = model.readScreens(store);
  const units = placementUnits(job, inService);
  const assign = !(job.options && job.options.assignSet === false);
  const base = (job.options && job.options.label) || String(deck.name || '').replace(/\.[a-z0-9]+$/i, '');

  /* The sets each screen's pages go into, page by page. */
  const setsFor = {};
  if (assign) {
    for (const id of job.screens || []) {
      const sets = model.readSets(store, id);
      setsFor[id] = setsForPages(sets, pages.length, (deck.startSet || {})[id]);
      if (pages.length && setsFor[id].length < pages.length) {
        top.push(`${id}: ${pages.length} pages need ${pages.length} background sets, and only ${setsFor[id].length} ${setsFor[id].length === 1 ? 'is' : 'are'} left from set ${setsFor[id][0] || '—'} on — choose fewer pages, or an earlier first set.`);
      }
    }
  }

  const mng = model.PLATFORM === 'mng';
  const reserve = mng ? { uploads: 0, frames: {} } : { slots: new Set(), stills: new Set() };
  const screens = [];
  const capacityChanges = [];
  let library = null;
  pages.forEach((page, i) => {
    for (const unit of units) {
      if (assign && unit.screens.some((id) => setsFor[id][i] == null)) continue;
      const pageJob = {
        ...job,
        source: 'stills',
        screens: unit.screens,
        image: unit.image,
        place: Object.fromEntries(unit.screens.map((id) => [id, unit.rect])),
        span: { ...(job.span || {}), rect: unit.rect },
        sets: assign ? Object.fromEntries(unit.screens.map((id) => [id, setsFor[id][i]])) : {},
        frames: {}
      };
      const plan = model.buildPlan(store, pageJob, { allowProgram: opts.allowProgram, assignedSlots: opts.assignedSlots, reserve });
      library = library || plan.library;
      for (const text of plan.problems) issues.push({ page, text });
      for (const text of plan.warnings) notes.push({ page, text });
      const label = pageLabel(base, pageNumber(deck, page));
      for (const s of plan.screens) {
        s.entry = `p${page + 1}:${s.id}`;
        s.page = page;
        s.unit = `p${page + 1}:${unit.key}`;
        s.render = unit.image;
        s.setLabel = label;
        s.preview = i === 0;
        for (const o of s.outputs) {
          o.stillLabel = label;
          if (mng) {
            reserve.uploads += 1;
            if (o.frame != null) (reserve.frames[s.id] = reserve.frames[s.id] || new Set()).add(o.frame);
          } else {
            if (o.librarySlot != null) reserve.slots.add(o.librarySlot);
            if (o.still != null) reserve.stills.add(o.still);
          }
        }
        screens.push(s);
      }
      capacityChanges.push(...plan.capacityChanges);
    }
  });
  if (mng && library) library = { ...library, slots: screens.map((s) => s.outputs[0].librarySlot) };
  const problems = [...top, ...grouped(issues)];
  return {
    ok: problems.length === 0,
    platform: model.PLATFORM,
    source: 'stills',
    kind: 'sets',
    assignedSlots: opts.assignedSlots === true,
    problems,
    warnings: grouped(notes),
    screens,
    units,
    pages,
    capacityChanges,
    library: library || { free: 0, slots: [], sizeKB: 0, maxKB: 0 }
  };
}

/** The sizes the size field offers: each screen's canvas, each output's raster, and the usual ones. */
export function sizeChoices(model, store, page = null) {
  const out = [];
  const add = (width, height, why) => {
    if (!(width > 0 && height > 0)) return;
    const hit = out.find((c) => c.width === width && c.height === height);
    if (hit) { if (!hit.why.includes(why)) hit.why.push(why); return; }
    out.push({ width, height, why: [why] });
  };
  if (page) { const p = pagePixels(page); add(p.width, p.height, 'the page at 96 dpi'); }
  for (const s of model.readScreens(store)) {
    add(s.canvas.width, s.canvas.height, `${s.id} canvas`);
    const topo = model.screenTopology(store, s.id);
    for (const o of (topo && topo.outputs) || []) add(o.raster.width, o.raster.height, `${s.id} ${o.name}`);
  }
  add(1920, 1080, 'HD');
  add(3840, 2160, 'UHD');
  return out;
}

/**
 * Stills at a size: each chosen page drawn at `deck.size`, one image for
 * the library each — and, on a LivePremier with `deck.stills`, a free still
 * each to show it. Nothing on the switcher is overwritten: only free slots
 * and free stills are taken, as the slicer takes them.
 *
 * A still is picked with a capacity that holds the size when there is one,
 * and shows it with no rescale; otherwise any free still, set to downscale
 * to its capacity, and the plan says so. Which capacity holds which size is
 * `likelyCapability`'s guess, not the switcher's word.
 */
export function buildSizePlan(store, job) {
  const deck = job.deck || {};
  const pages = deck.chosen || [];
  const size = deck.size || {};
  const problems = [];
  const warnings = [];
  const mng = dialectFor(store) === MNG;
  const W = Math.round(Number(size.width));
  const H = Math.round(Number(size.height));
  if (!pages.length) problems.push('Choose at least one page.');
  if (!(W >= 16 && H >= 16)) problems.push('Give the size in pixels, 16 or more each way.');

  const library = mng ? readLibraryMng(store) : readLibraryNlc(store);
  const L = library.limits;
  if (W > L.maxWidth || H > L.maxHeight || W * H > L.maxPixels) {
    problems.push(`${W} × ${H} is larger than the image library takes (${L.maxWidth} × ${L.maxHeight}, ${L.maxPixels.toLocaleString()} pixels).`);
  }
  const base = (job.options && job.options.label) || String(deck.name || '').replace(/\.[a-z0-9]+$/i, '');
  const toLibrary = deck.library !== false;
  const wantStills = toLibrary && !mng && deck.stills === true;

  let slots = [];
  const assignedSlots = !mng && job.options && job.options.assignedSlots === true;
  if (toLibrary) {
    /* LivePremier: an empty slot a still points at only with the option, and
       after every clean one — the still shows whatever goes into it. */
    const empty = mng ? [] : emptySlots(store);
    const usable = mng ? [] : orderSlots(empty, { assigned: assignedSlots }).slice(0, pages.length);
    slots = mng ? nextSlots(library, pages.length) : usable.map((s) => s.slot);
    const passedOver = mng || assignedSlots ? 0 : empty.filter((s) => s.stills.length).length;
    if (slots.length < pages.length) problems.push(`${pages.length} pages need ${pages.length} library slots, and ${slots.length} ${slots.length === 1 ? 'is' : 'are'} free${passedOver ? ` (${passedOver} more ${passedOver === 1 ? 'is' : 'are'} empty but a still points at ${passedOver === 1 ? 'it' : 'them'} — tick “Use empty slots a still points at” to use ${passedOver === 1 ? 'it' : 'them'})` : ''}.`);
    for (const [i, s] of usable.entries()) {
      if (s.stills.length) warnings.push(`Page ${pages[i] + 1}: library slot ${s.slot} is empty, but ${pointedText(s.stills)}.`);
    }
    if (mng) {
      for (const slot of slots) {
        const on = framesOn(store, slot);
        if (on.length) problems.push(`the switcher puts an upload into the first empty library slot, and ${on.map((f) => f.name).join(', ')} already point${on.length === 1 ? 's' : ''} at slot ${slot}, so ${on.length === 1 ? 'it' : 'they'} would show a page too. Clear ${on.length === 1 ? 'that image' : 'those images'} in Images first.`);
      }
    }
  }

  const need = W > 0 && H > 0 ? likelyCapability({ width: W, height: H }) : 'DUAL';
  const free = wantStills ? readStills(store).filter((s) => s.free) : [];
  const taken = new Set();
  let downscaled = 0;
  const pickStill = () => {
    const holds = (s) => (CAPACITY_UNITS[s.capability] || 0) >= (CAPACITY_UNITS[need] || 1);
    const pick = free.find((s) => !taken.has(s.key) && holds(s)) || free.find((s) => !taken.has(s.key)) || null;
    if (pick) taken.add(pick.key);
    return pick;
  };

  const screens = pages.map((page, i) => {
    const n = page + 1;
    const label = pageLabel(base, pageNumber(deck, page));
    const still = wantStills ? pickStill() : null;
    const fits = still ? (CAPACITY_UNITS[still.capability] || 0) >= (CAPACITY_UNITS[need] || 1) : true;
    if (wantStills && !still) problems.push(`Page ${n}: no free still — every fitted still holds an image, a timer or a set’s content. Untick “a still each”, or free some.`);
    if (still && !fits) downscaled++;
    return {
      id: `P${n}`,
      entry: `p${n}:size`,
      page,
      label: `Page ${n}`,
      canvas: { width: W, height: H },
      assign: false,
      set: null,
      setIndex: null,
      place: null,
      preview: false,
      setLabel: null,
      render: { width: W, height: H },
      unit: `p${n}:size`,
      display: { ok: true, why: null },
      native: { fitted: true, capability: null },
      outputs: [{
        key: 'page',
        name: `Page ${n}`,
        label: '',
        raster: { width: W, height: H },
        format: null, rate: null, total: null, plugs: [], group: '1X1', members: [], rotation: 0,
        capability: still ? still.capability : null,
        assumptions: [],
        regions: [],
        blits: [],
        exact: true,
        covered: true,
        librarySlot: toLibrary ? (slots[i] ?? null) : null,
        still: still ? still.key : null,
        stillCapability: still ? still.capability : null,
        stillBefore: still ? { label: still.label, mode: still.mode, source: still.source, rescale: still.rescale, format: still.format } : null,
        capacityChange: null,
        rescale: still && !fits ? 'SCALE_TO_CAPABILITY' : 'NO_RESCALE',
        stillLabel: label,
        frame: null,
        content: still ? `STILL_${still.key}` : null,
        previous: 'NONE'
      }]
    };
  });
  if (downscaled) {
    warnings.push(`${downscaled} still${downscaled === 1 ? '' : 's'} of a smaller capacity than ${W} × ${H} wants (${need}, by its size): ${downscaled === 1 ? 'it is' : 'they are'} set to downscale to capacity, so the switcher resamples ${downscaled === 1 ? 'that page' : 'those pages'}.`);
  }
  return {
    ok: problems.length === 0,
    platform: mng ? 'mng' : 'nlc',
    source: 'stills',
    kind: 'size',
    assignedSlots,
    problems,
    warnings,
    screens,
    units: [],
    pages,
    capacityChanges: [],
    library: mng
      ? { free: library.slots.filter((s) => s.free).length, slots, sizeKB: 0, maxKB: 0, maxBytes: library.limits.maxBytes }
      : { free: library.slots.filter((s) => s.free).length, sizeKB: library.sizeKB, maxKB: library.maxKB }
  };
}

/** A fingerprint of what a document's generated images depend on. */
export function deckPlanKey(plan, extra = {}) {
  return JSON.stringify([plan.kind, extra, plan.screens.map((s) => [s.entry, s.render, s.outputs.map((o) => [o.key, o.raster.width, o.raster.height, o.blits])])]);
}
