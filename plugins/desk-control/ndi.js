/*
 * Desk control — pictures for the desk, as NDI.  ** PREVIEW **  No I/O.
 *
 * What a media server shows a lighting desk in its video windows, made from
 * what the switcher says: the switcher's own video does not reach this app,
 * so a feed is a drawing of it, about once a second, not a picture of it.
 *
 * - **One feed per patched screen**: its program, each patched layer where
 *   the switcher has it, with its source's snapshot (or a card where the
 *   switcher has none — a colour, a background, an input it cannot see)
 *   at its opacity, outlined and labelled `L2 IN3 Camera 3`.
 * - **The layers**: every patched layer as a tile, `S1 L2` over what it has
 *   in program — the layer assignments a desk shows beside its fixtures.
 * - **Optionally a feed per layer**: the same tile alone, for a desk that
 *   puts a feed on a button (grandMA3's appearances).
 *
 * Each is a scene for `src/core/raster.js`'s `render`: drawn by the media
 * host (`devices/media/`), so the app's own process stays free for the desk.
 */

import { libraries, placeOf, SWATCHES } from './media.js';
/* A layer's own feed is a button's picture, not a screen's. */
export const TILE_SIZE = Object.freeze({ width: 640, height: 360 });
/* What a screen is taken to be when its size could not be read. */
const DEFAULT_CANVAS = Object.freeze({ width: 1920, height: 1080 });

const BACKGROUND = [10, 14, 18];
const CANVAS_EDGE = [70, 78, 86];
const BAND = [0, 0, 0];
const WHITE = [255, 255, 255];
const MUTED = [150, 158, 166];
/* One colour per layer number, so L2 is the same colour on every screen. */
const LAYER_COLOURS = [
  [80, 170, 255], [255, 170, 60], [120, 220, 120], [235, 100, 200],
  [255, 230, 90], [100, 225, 225], [255, 110, 100], [180, 140, 255],
];
export const layerColour = (n) => LAYER_COLOURS[(Math.max(1, n) - 1) % LAYER_COLOURS.length];

const NAME_PREFIX = 'LivePremier Plus';

/**
 * The feeds these settings ask for, `[{ id, name, kind, destination?, layer? }]`:
 * a screen's in patch order, then the layers, then each layer's if asked.
 * `name` is the NDI source name; receivers see `MACHINE (name)`.
 */
export function feedsFor(fixtures, { perLayer = false } = {}) {
  const layers = fixtures.filter((f) => f.kind === 'layer');
  const screens = [...new Set(layers.map((f) => f.destination))];
  const out = screens.map((d) => ({ id: `screen-${d}`, name: `${NAME_PREFIX} ${d}`, kind: 'screen', destination: d }));
  if (layers.length) out.push({ id: 'layers', name: `${NAME_PREFIX} layers`, kind: 'layers' });
  if (perLayer) {
    for (const f of layers) out.push({ id: `layer-${f.destination}-${f.layer}`, name: `${NAME_PREFIX} ${f.destination} L${f.layer}`, kind: 'layer', destination: f.destination, layer: f.layer });
  }
  return out;
}

/** The images a scene can use: a source with a snapshot that has one. */
export const imageKey = (source) => (source && /^(LIVE|STILL|INPUT)_\d+$/.test(source) ? source : null);

/** What a source is called on the desk's side: `IN3 Camera 3`, `Colour`, `Black`. */
export function sourceName(libs, source) {
  if (!source || source === 'NONE') return 'Black';
  const at = placeOf(libs, source);
  return at ? at.name.replace(/ \(not in use\)$/, '') : String(source);
}

function swatch(source) {
  const kind = /^([A-Z]+)/.exec(String(source || 'NONE'))[1];
  return SWATCHES[kind === 'INPUT' ? 'LIVE' : kind] || SWATCHES.NONE;
}

/** A source as fill-or-picture operations inside `rect`. */
function sourceOps(source, rect, images, opacity = 1) {
  const key = imageKey(source);
  if (key && images[key]) return [{ op: 'image', rect, image: key, opacity }];
  return [{ op: 'fill', rect, rgb: swatch(source), opacity }];
}

/** `inner` (w × h) fitted inside `outer`, centred, aspect kept. */
function fitInside(w, h, outer) {
  const k = Math.min(outer.w / w, outer.h / h);
  const fw = w * k;
  const fh = h * k;
  return { x: outer.x + (outer.w - fw) / 2, y: outer.y + (outer.h - fh) / 2, w: fw, h: fh, k };
}

/**
 * One screen's program as a scene.
 *
 * @param {string} destination   `S1`
 * @param {{canvas, layers}|null} look   from `supervisor.readProgram({ look: true })`
 * @param {object} o
 * @param {{width, height}} o.size
 * @param {object} o.facts      the switcher's last `readFacts()`, for source names
 * @param {object} o.images     image key → RGBA image, those there are
 */
export function screenScene(destination, look, { size, facts, images = {} }) {
  const { width, height } = size;
  const libs = libraries(facts);
  const canvas = (look && look.canvas) || DEFAULT_CANVAS;
  const band = Math.round(height * 0.07);
  const area = fitInside(canvas.width, canvas.height, { x: 0, y: band, w: width, h: height - band });
  const ops = [
    { op: 'fill', rect: { x: area.x, y: area.y, w: area.w, h: area.h }, rgb: [0, 0, 0] },
  ];
  const labels = [];
  /* Label bands already placed: two layers with the same top edge — a full-screen layer under another — stack theirs. */
  const placed = [];
  const clash = (a) => placed.some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
  for (const l of (look && look.layers) || []) {
    const rect = { x: area.x + l.rect.left * area.k, y: area.y + l.rect.top * area.k, w: l.rect.width * area.k, h: l.rect.height * area.k };
    const colour = layerColour(l.layer);
    ops.push(...sourceOps(l.source, rect, images, l.opacity));
    ops.push({ op: 'stroke', rect, rgb: colour, width: Math.max(2, Math.round(height / 360)) });
    /* Labels go on last, over every layer, so a layer on top never hides the one below's name. */
    const h = Math.max(12, Math.min(Math.round(height * 0.05), rect.h));
    const opacity = l.opacity < 0.995 ? ` ${Math.round(l.opacity * 100)}%` : '';
    const band = { x: rect.x, y: rect.y, w: rect.w, h };
    while (clash(band) && band.y + 2 * h <= rect.y + rect.h) band.y += h;
    placed.push(band);
    labels.push(
      { op: 'fill', rect: band, rgb: BAND, opacity: 0.6 },
      { op: 'text', rect: { x: band.x + 4, y: band.y + 2, w: band.w - 8, h: h - 4 }, text: `L${l.layer} ${sourceName(libs, l.source)}${opacity}`, rgb: colour, scales: [3, 2, 1] },
    );
  }
  ops.push(...labels);
  ops.push({ op: 'stroke', rect: { x: area.x, y: area.y, w: area.w, h: area.h }, rgb: CANVAS_EDGE, width: 1 });
  const known = look && look.canvas ? `${canvas.width} × ${canvas.height}` : 'size not read';
  ops.push({ op: 'text', rect: { x: 8, y: 4, w: width - 16, h: band - 8 }, text: `${destination} PROGRAM   ${known}`, rgb: WHITE, scales: [4, 3, 2, 1] });
  return { width, height, background: BACKGROUND, fps: 1, ops };
}

/** Columns for `n` tiles of the given aspect in `w × h`, the tiles as large as they can be. */
function columns(n, w, h, aspect) {
  let best = { cols: 1, side: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tw = Math.min(w / cols, (h / rows) * aspect);
    if (tw > best.side) best = { cols, side: tw };
  }
  return best.cols;
}

/** One layer's tile: its program source, `S1 L2` and the source's name under it. */
function tileOps(f, l, rect, libs, images) {
  const caption = Math.round(rect.h * 0.24);
  const picture = { x: rect.x, y: rect.y, w: rect.w, h: rect.h - caption };
  const colour = layerColour(f.layer);
  const ops = [];
  if (l) ops.push(...sourceOps(l.source, picture, images, 1));
  else ops.push({ op: 'fill', rect: picture, rgb: [0, 0, 0] });
  ops.push({ op: 'stroke', rect: picture, rgb: colour, width: Math.max(2, Math.round(rect.h / 90)) });
  const name = l ? sourceName(libs, l.source) : 'not read';
  const opacity = l && l.opacity < 0.995 ? ` ${Math.round(l.opacity * 100)}%` : '';
  ops.push({ op: 'text', rect: { x: rect.x, y: rect.y + rect.h - caption, w: rect.w * 0.34, h: caption }, text: `${f.destination} L${f.layer}`, rgb: colour, scales: [5, 4, 3, 2, 1] });
  ops.push({ op: 'text', rect: { x: rect.x + rect.w * 0.34, y: rect.y + rect.h - caption, w: rect.w * 0.66, h: caption }, text: `${name}${opacity}`, rgb: l ? WHITE : MUTED, scales: [3, 2, 1] });
  return ops;
}

/**
 * Every patched layer as a tile, in patch order.
 *
 * @param {object[]} fixtures   the patch
 * @param {Map} looks           screen id → `{canvas, layers}`
 */
export function layersScene(fixtures, looks, { size, facts, images = {} }) {
  const { width, height } = size;
  const libs = libraries(facts);
  const layers = fixtures.filter((f) => f.kind === 'layer');
  const ops = [];
  const gap = Math.round(width / 160);
  const n = Math.max(1, layers.length);
  /* A tile is a 16:9 picture over a caption: the picture is 76% of its height. */
  const aspect = (16 / 9) * 0.76;
  const cols = columns(n, width - gap, height - gap, aspect);
  const rows = Math.ceil(n / cols);
  const cellW = (width - gap) / cols;
  const cellH = (height - gap) / rows;
  const tile = fitInside(aspect, 1, { x: 0, y: 0, w: cellW - gap, h: cellH - gap });
  layers.forEach((f, i) => {
    const look = looks.get(f.destination);
    const l = look ? look.layers.find((x) => x.layer === f.layer) || null : null;
    const x = gap + (i % cols) * cellW + tile.x;
    const y = gap + Math.floor(i / cols) * cellH + tile.y;
    ops.push(...tileOps(f, l, { x, y, w: tile.w, h: tile.h }, libs, images));
  });
  return { width, height, background: BACKGROUND, fps: 1, ops };
}

/** One layer alone, for its own feed. */
export function layerScene(fixture, looks, { facts, images = {} }) {
  const { width, height } = TILE_SIZE;
  const look = looks.get(fixture.destination);
  const l = look ? look.layers.find((x) => x.layer === fixture.layer) || null : null;
  return { width, height, background: BACKGROUND, fps: 1, ops: tileOps(fixture, l, { x: 0, y: 0, w: width, h: height }, libraries(facts), images) };
}
