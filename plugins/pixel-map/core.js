/*
 * Pixel Map — the part with no DOM and no I/O.
 *
 * A pixel map is a picture of what a screen's canvas really lands on: the LED
 * panels and the gaps between them, a projection blend, a set piece cut out
 * of the middle of the raster. The switcher already has somewhere to keep
 * pictures — the image library — so the map is one of those, chosen per
 * destination, and drawn over that destination's canvas on the vendor's
 * Screens / Aux. page. It costs no layer: nothing is written to the switcher,
 * and the only thing that knows the map is there is this browser tab.
 *
 * ## The document
 *
 * Kept per switcher, like the layer names, because `S1` is one box's screen
 * and a map of one LED wall means nothing pointed at another frame:
 *
 *   { version: 1, visible: true, buffers: 'preview',
 *     maps: { S1: { slot: 3, mode: 'mask', opacity: 0.8, fit: 'pixels' } } }
 *
 * `slot` names an image library slot, not a still. A still is a frame store a
 * layer can take as a source, and putting the map in one would be spending
 * exactly the resource this feature exists not to spend.
 *
 * ## Modes
 *
 * Drawn with `mix-blend-mode`, so the map is combined with the layers already
 * drawn under it rather than painted over them:
 *
 * - **mask** — multiply. Black in the map hides what is under it, white shows
 *   it untouched: what the audience will see of each layer.
 * - **over** — the picture as it is, at the opacity: panel numbers, outlines,
 *   a map with transparency.
 * - **lines** — screen. Only the light parts of the map show, over dark
 *   content: a white grid of panel edges.
 *
 * ## Fit
 *
 * - **pixels** — one map pixel to one canvas pixel, from the top left: where a
 *   pixel map is true. A map bigger than the canvas is cut off at its edge; a
 *   smaller one leaves the rest of the canvas uncovered.
 * - **stretch** — the whole map over the whole canvas, whatever its size: for
 *   a map drawn at another resolution than the screen's raster.
 *
 * When the two disagree — the map is not the canvas's size — the panel says
 * so, because a map that is quietly the wrong size is a map that lies.
 */

export const MODES = [
  { id: 'mask', label: 'Mask', blend: 'multiply', what: 'Black in the map hides what is under it; white shows it as it is.' },
  { id: 'over', label: 'Over', blend: 'normal', what: 'The map as it is, over the layers, at the opacity.' },
  { id: 'lines', label: 'Lines', blend: 'screen', what: 'Only the light parts of the map show — a white grid over dark content.' }
];

export const FITS = [
  { id: 'pixels', label: '1:1', what: 'One map pixel to one canvas pixel, from the top left.' },
  { id: 'stretch', label: 'Stretch', what: 'The whole map over the whole canvas, whatever its size.' }
];

export const BUFFERS = [
  { id: 'preview', label: 'PRW', what: 'Over the preview buffer of each card.' },
  { id: 'program', label: 'PGM', what: 'Over the program buffer of each card.' },
  { id: 'both', label: 'Both', what: 'Over both buffers.' }
];

export const DEFAULT_MAP = Object.freeze({ slot: null, mode: 'mask', opacity: 0.8, fit: 'pixels' });

export const EMPTY = Object.freeze({ version: 1, visible: true, buffers: 'preview', maps: {} });

const DEST = /^[SA]\d+$/;
const ids = (list) => new Set(list.map((x) => x.id));
const MODE_IDS = ids(MODES);
const FIT_IDS = ids(FITS);
const BUFFER_IDS = ids(BUFFERS);

/** Opacity as a fraction, clamped; anything unreadable is the default. */
function fraction(v) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_MAP.opacity;
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100));
}

/** A library slot, 1-based, or null for none. */
function slotOf(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** One destination's entry, with every field valid. */
export function normaliseMap(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  return {
    slot: slotOf(m.slot),
    mode: MODE_IDS.has(m.mode) ? m.mode : DEFAULT_MAP.mode,
    opacity: m.opacity === undefined ? DEFAULT_MAP.opacity : fraction(m.opacity),
    fit: FIT_IDS.has(m.fit) ? m.fit : DEFAULT_MAP.fit
  };
}

/**
 * The stored document, made valid. Corrects rather than refuses, like every
 * other setting here: a hand-edited file with one bad field keeps the rest.
 * A destination with no image is dropped — it is the same as no entry.
 */
export function normalise(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const maps = {};
  const src = d.maps && typeof d.maps === 'object' ? d.maps : {};
  for (const [id, entry] of Object.entries(src)) {
    if (!DEST.test(id)) continue;
    const m = normaliseMap(entry);
    if (m.slot != null) maps[id] = m;
  }
  return {
    version: 1,
    visible: d.visible !== false,
    buffers: BUFFER_IDS.has(d.buffers) ? d.buffers : EMPTY.buffers,
    maps
  };
}

/** The document with one destination's entry changed; `slot: null` removes it. */
export function withMap(doc, id, patch) {
  const base = normalise(doc);
  const next = normaliseMap({ ...(base.maps[id] || DEFAULT_MAP), ...patch });
  const maps = { ...base.maps };
  if (next.slot == null) delete maps[id];
  else maps[id] = next;
  return { ...base, maps };
}

/** Which buffers, by the vendor's own label on the card, get a map drawn. */
export function rolesFor(buffers) {
  if (buffers === 'both') return ['PGM', 'PRW'];
  return buffers === 'program' ? ['PGM'] : ['PRW'];
}

/**
 * Where the picture sits on the canvas, as percentages of the canvas — so it
 * follows the card's zoom and size with no measuring.
 *
 * @param {{width:number|null, height:number|null}} image  the map's pixel size
 * @param {{width:number, height:number}} canvas         the destination's raster
 * @param {'pixels'|'stretch'} fit
 */
export function placement(image, canvas, fit) {
  const full = { left: 0, top: 0, width: 100, height: 100 };
  if (fit !== 'pixels') return full;
  const iw = image && image.width;
  const ih = image && image.height;
  const cw = canvas && canvas.width;
  const ch = canvas && canvas.height;
  /* A size the switcher has not reported cannot be placed pixel for pixel,
     and a guess would be a wrong map that looks right. Stretch instead, and
     `plan` says why. */
  if (!(iw > 0 && ih > 0 && cw > 0 && ch > 0)) return full;
  const pct = (a, b) => Math.round((a / b) * 1e6) / 1e4;
  return { left: 0, top: 0, width: pct(iw, cw), height: pct(ih, ch) };
}

/**
 * What to draw on each destination, and what to say about each.
 *
 * @param {object} doc            the stored document
 * @param {object[]} destinations `listDestinations(store)`: `{id, canvas}`
 * @param {object[]} images       `dialect.libraryImages(store)`
 * @returns {Map<string, {image, map, place, blend, opacity, notes: string[]} | {missing: number, map}>}
 */
export function plan(doc, destinations, images) {
  const d = normalise(doc);
  const bySlot = new Map(images.map((i) => [i.slot, i]));
  const out = new Map();
  for (const dest of destinations) {
    const map = d.maps[dest.id];
    if (!map) continue;
    const image = bySlot.get(map.slot);
    if (!image) { out.set(dest.id, { missing: map.slot, map }); continue; }
    const canvas = dest.canvas || {};
    const notes = [];
    const sized = image.width > 0 && image.height > 0;
    if (!sized) notes.push('The switcher reports no size for this image, so it is stretched over the canvas.');
    else if (canvas.width && canvas.height && (image.width !== canvas.width || image.height !== canvas.height)) {
      notes.push(`The map is ${image.width}×${image.height}; ${dest.id}’s canvas is ${canvas.width}×${canvas.height}.`
        + (map.fit === 'pixels' ? ' Drawn 1:1 from the top left.' : ' Stretched to fit.'));
    }
    out.set(dest.id, {
      image, map,
      place: placement(image, canvas, sized ? map.fit : 'stretch'),
      blend: MODES.find((m) => m.id === map.mode).blend,
      opacity: map.opacity,
      notes
    });
  }
  return out;
}

/** How a library image is named in a list: `3 · stage-left.png · 1920×1080`. */
export function imageLabel(image) {
  const size = image.width > 0 && image.height > 0 ? `${image.width}×${image.height}` : 'size unknown';
  return [String(image.slot), image.fileName || 'untitled', size].join(' · ');
}
