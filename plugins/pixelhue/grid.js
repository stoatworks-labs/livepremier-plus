/*
 * A U5 mini's LCD key grid, drawn by this app.  ** PREVIEW **
 *
 * ## Why a mini needs this and a U5 does not
 *
 * A U5 or U5 Pro is handed a model and labels its own bus keys (`core.js`).
 * A U5 mini does not: its LCD app (`/usr/process/oem/LCD/bin`, firmware
 * V1.0.3) is the controller. It binds to a Pixelhue switcher on the network,
 * draws the bus keys from its own cache and runs TAKE and CUT against that
 * switcher itself. Publishing a model to the mini's control service gets the
 * page and area-switch keys through to this app, and nothing to select.
 *
 * What the LCD app does offer is its Companion surface: TCP 17100, a 4 × 10
 * grid of 72 × 72 keys, one row per bus row (`src/vendor/pixelhue/surface.js`
 * has the wire). So on a mini this app draws the grid itself, as the console's
 * built-in Companion would, and a press comes straight back by row and column.
 * The selection lives here, as it does for a Barco EC panel.
 *
 * ```text
 *   row 0  screens                press selects; on a selected screen, makes it the
 *                                 active one; held 1.5 s, drops it — a U5's screen bus
 *   row 1  the active screen's    press selects the layer
 *          layers
 *   row 2  inputs (the kind       press puts it on the selected layer of every selected
 *          SIGNAL SOURCE chose)   screen, in the buffer the panel edits
 *   row 3  memories               press recalls to PREVIEW; SAVE TO or DEL armed on the
 *                                 console, stores or deletes instead
 *   columns 0–7                   the row's page of eight
 *   columns 8 / 9                 that row's page back / page on
 * ```
 *
 * ⚠️ What the firmware says and what it does not (`docs/PIXELHUE.md`, U5 mini):
 *
 * - A row shows this drawing only while the operator has switched it to its
 *   Companion module with the row's area-switch key. The console keeps the
 *   rest for when they do.
 * - `page` on the wire is the row's page: a draw for another page moves the
 *   row there, and a press says which page the row showed. A press from a page
 *   this app has drawn over since is refused (`pageMatches`), so a key pressed
 *   mid-redraw cannot act on the label that replaced it.
 * - That columns 8 and 9 are each row's own page keys is inferred from the key
 *   map, not proved. Whatever key they are, the drawing and the action agree:
 *   the page is drawn there, and a press there turns it.
 *
 * ## No I/O
 *
 * Same rule as `core.js`: the supervisor reads the switcher and moves bytes;
 * this decides what each key shows and means. The tests drive it directly.
 */

import { encodePng } from '../../src/vendor/pixelhue/png.js';
import { GRID_ROWS, GRID_COLUMNS, KEY_ICON_SIZE } from '../../src/vendor/pixelhue/surface.js';
import { paintText } from '../../src/core/ec-font.js';

export const ROWS = GRID_ROWS;
export const COLUMNS = GRID_COLUMNS;
/* Eight bus keys a row, as on the console, which pages its own buses by eight. */
export const BUS_KEYS = 8;
export const PAGE_BACK = 8;
export const PAGE_ON = 9;
export const ROW_NAMES = Object.freeze(['screens', 'layers', 'inputs', 'memories']);
const ROW_SHORT = Object.freeze(['SCREEN', 'LAYER', 'INPUT', 'MEMORY']);
export const SCREENS = 0;
export const LAYERS = 1;
export const INPUTS = 2;
export const MEMORIES = 3;
/* The console's own long press on a screen key (`key_function.xml`, mode 100,
   "unselect screen": Operation 3, PressTime 1500). */
export const LONG_PRESS_MS = 1500;

const SHORT = { LIVE: 'IN', STILL: 'STILL', SCREEN: 'S' };
/* The label's sizes on a 72-pixel key: 1.5× fits "Camera 1" on two lines
   where 2× would have to break the word (`ec-font.js`'s `layout`). */
const KEY_SCALES = Object.freeze([3, 2, 1.5, 1]);

/* ------------------------------------------------------------------ view */

/** The grid's own state, which is not the switcher's: each row's page, and SAVE TO / DEL. */
export function initialView() {
  return { pages: Array(ROWS).fill(0), armed: null };
}

const activeOf = (selection) => {
  const list = selection ? selection.list : [];
  return list.length ? list[list.length - 1] : null;
};

/** What a row offers, in bus order, from the facts the supervisor read. */
export function rowItems(row, { facts, selection, sourceKind = 'LIVE' }) {
  if (!facts) return [];
  if (row === SCREENS) {
    return (facts.destinations || []).filter((d) => d.isUsed)
      .map((d) => ({ type: 'screen', id: d.id, label: d.label || d.id, faded: !!d.faded, frozen: !!d.frozen }));
  }
  if (row === LAYERS) {
    const active = activeOf(selection);
    return (facts.layers || []).filter((l) => l.destination === active)
      .map((l) => Number(l.key)).sort((a, b) => a - b)
      .map((key) => ({ type: 'layer', key, label: `Layer ${key}` }));
  }
  if (row === INPUTS) {
    return (facts.inputs || []).map((s) => ({
      type: 'source', sourceKind, number: s.number, label: s.label || `${SHORT[sourceKind] || 'IN'} ${s.number}`,
    }));
  }
  if (row === MEMORIES) {
    return (facts.presets || []).map((p) => ({ type: 'memory', slot: p.slot, label: p.label || `Memory ${p.slot}` }));
  }
  return [];
}

/**
 * How many pages a row has. The memory row runs one key past its last memory,
 * so that with every key full there is still an empty one to SAVE TO — which
 * is what the console's own preset bus allows.
 */
export function pageCount(row, ctx) {
  const n = rowItems(row, ctx).length + (row === MEMORIES ? 1 : 0);
  return Math.max(1, Math.ceil(n / BUS_KEYS));
}

/** The view with every page inside its row — a row can shrink under it. */
export function clampView(view, ctx) {
  const pages = view.pages.map((p, row) => Math.max(0, Math.min(pageCount(row, ctx) - 1, p)));
  return pages.every((p, i) => p === view.pages[i]) ? view : { ...view, pages };
}

/** A page key's press applied: a new view, clamped at both ends rather than wrapped. */
export function turnPage(view, row, delta, ctx) {
  const pages = [...view.pages];
  pages[row] = Math.max(0, Math.min(pageCount(row, ctx) - 1, pages[row] + delta));
  return { ...view, pages };
}

/** The page the console is told a row shows: the view's, counted from 1 as Companion's are. */
export const wirePage = (view, row) => view.pages[row] + 1;

/**
 * Whether a press came from the page this app last drew on that row. A press
 * that does not say (`page` null) is taken at its word.
 */
export const pageMatches = (view, row, page) => page === null || page === undefined || page === wirePage(view, row);

/* ------------------------------------------------------------ press → intent */

/**
 * What a released key asks for: one of `console-intents.js`'s kinds —
 * `select`, `activate`, `unselect`, `selectLayer`, `source`, `recall`,
 * `store`, `deletePreset` — or this grid's own `page`, or `none` with why.
 * `long` is a press held `LONG_PRESS_MS` or more.
 */
export function pressIntent(row, column, ctx, { long = false } = {}) {
  const view = ctx.view || initialView();
  const name = `${ROW_NAMES[row] || `row ${row}`} key ${column + 1}`;
  if (row < 0 || row >= ROWS || column < 0 || column >= COLUMNS) return { kind: 'none', why: `no key at row ${row}, column ${column}` };
  if (column === PAGE_BACK || column === PAGE_ON) return { kind: 'page', row, delta: column === PAGE_ON ? 1 : -1 };

  const item = rowItems(row, ctx)[view.pages[row] * BUS_KEYS + column];
  if (!item) {
    if (row === MEMORIES && view.armed === 'save') return { kind: 'store', slot: null };
    if (row === LAYERS && !activeOf(ctx.selection)) return { kind: 'none', why: `${name}: select a screen first — the layer row shows the active screen's layers` };
    return { kind: 'none', why: `${name}: nothing on that key` };
  }

  switch (item.type) {
    case 'screen': {
      const selected = ctx.selection.destinations.has(item.id);
      if (!selected) return { kind: 'select', destination: item.id };
      if (long) return { kind: 'unselect', destination: item.id };
      if (activeOf(ctx.selection) !== item.id) return { kind: 'activate', destination: item.id };
      return { kind: 'none', why: `${item.label} is already the active screen — hold it ${LONG_PRESS_MS / 1000} s to drop it` };
    }
    case 'layer': return { kind: 'selectLayer', layer: item.key };
    case 'source': return { kind: 'source', input: item.number, label: item.label };
    case 'memory':
      if (view.armed === 'save') return { kind: 'store', slot: item.slot };
      if (view.armed === 'del') return { kind: 'deletePreset', slot: item.slot, label: item.label };
      return { kind: 'recall', slot: item.slot };
    default: return { kind: 'none', why: `${name}: no meaning yet` };
  }
}

/* -------------------------------------------------------------- the faces */

const RGB = Object.freeze({
  black: [0, 0, 0],
  key: [38, 38, 42],
  ink: [235, 235, 235],
  dim: [110, 110, 110],
  amber: [232, 150, 20],
  red: [200, 24, 24],
  green: [20, 150, 50],
  blue: [24, 52, 104],
  white: [255, 255, 255],
});

/**
 * Every key of the grid as it should look now: `{row, column, page, face,
 * sig}` × 40, where `face` is `{text, sub, fill, ink, frame}` and `sig` is
 * what the supervisor compares to send only what changed.
 *
 * - Screens: amber when selected, framed white when also the active one, and
 *   FTB / FRZ as last read.
 * - Layers: amber for the selected one.
 * - Inputs: red for what is on the selected layer in program, green for what
 *   is in preview, as last read (`tally`, from `ConsoleSwitcher.tallyFor`).
 * - Memories: framed red while SAVE TO or DEL is armed.
 * - Columns 8 / 9: the row's page, dark when there is only one.
 */
export function gridCells(ctx) {
  const view = ctx.view || initialView();
  const selection = ctx.selection;
  const active = activeOf(selection);
  const tally = ctx.tally && Number(ctx.tally.layer) === Number(selection && selection.layer) ? ctx.tally : null;
  const onAir = (src, item) => !!src && src.kind === item.sourceKind && Number(src.number) === Number(item.number);
  const out = [];
  for (let row = 0; row < ROWS; row++) {
    const items = rowItems(row, ctx);
    const pages = pageCount(row, ctx);
    const page = Math.min(view.pages[row], pages - 1);
    for (let column = 0; column < COLUMNS; column++) {
      let face;
      if (column === PAGE_BACK || column === PAGE_ON) {
        const more = pages > 1;
        face = {
          text: column === PAGE_ON ? '▶' : '◀',
          sub: `${ROW_SHORT[row]} ${page + 1}/${pages}`,
          fill: more ? RGB.blue : RGB.black,
          ink: more ? RGB.ink : RGB.dim,
        };
      } else {
        const item = items[page * BUS_KEYS + column];
        face = item ? faceOf(item, { selection, active, tally, onAir, view })
          : row === MEMORIES && view.armed === 'save'
            ? { text: '+', sub: 'SAVE HERE', fill: RGB.black, ink: RGB.red, frame: RGB.red }
            : { text: '', sub: '', fill: RGB.black, ink: RGB.dim };
      }
      const cell = { row, column, page: page + 1, face };
      cell.sig = JSON.stringify([cell.page, face]);
      out.push(cell);
    }
  }
  return out;
}

function faceOf(item, { selection, active, tally, onAir, view }) {
  if (item.type === 'screen') {
    const selected = selection.destinations.has(item.id);
    const marks = [item.id === active ? 'ACTIVE' : selected ? 'SEL' : item.id, item.faded && 'FTB', item.frozen && 'FRZ']
      .filter(Boolean).join(' ');
    return {
      text: item.label,
      sub: marks,
      fill: selected ? RGB.amber : RGB.key,
      ink: selected ? RGB.black : RGB.ink,
      frame: item.id === active ? RGB.white : null,
    };
  }
  if (item.type === 'layer') {
    const on = Number(item.key) === Number(selection.layer);
    return { text: item.label, sub: on ? 'SELECTED' : '', fill: on ? RGB.amber : RGB.key, ink: on ? RGB.black : RGB.ink };
  }
  if (item.type === 'source') {
    const pgm = tally && onAir(tally.program, item);
    const pvw = tally && onAir(tally.preview, item);
    const tag = `${SHORT[item.sourceKind] || 'IN'} ${item.number}`;
    return {
      text: item.label,
      sub: [pgm && 'PGM', pvw && 'PVW', tag].filter(Boolean).join(' '),
      fill: pgm ? RGB.red : pvw ? RGB.green : RGB.key,
      ink: RGB.ink,
      frame: pgm && pvw ? RGB.green : null,
    };
  }
  /* A memory. */
  const armed = view.armed === 'save' ? 'SAVE TO' : view.armed === 'del' ? 'DELETE' : null;
  return {
    text: item.label,
    sub: armed ? `${armed} ${item.slot}` : `M${item.slot}`,
    fill: RGB.key,
    ink: RGB.ink,
    frame: armed ? RGB.red : null,
  };
}

/**
 * One key's face as the 72 × 72 PNG the console takes. RGBA, as the vendor's
 * own plugin sends: the label centred in the top 54 rows at the largest of the
 * font's three sizes that fits, the status line in the bottom strip.
 */
export function renderKey(face, size = KEY_ICON_SIZE) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, face.fill || RGB.black);
  if (face.frame) {
    for (let t = 0; t < 3; t++) {
      for (let i = 0; i < size; i++) {
        put(i, t, face.frame); put(i, size - 1 - t, face.frame);
        put(t, i, face.frame); put(size - 1 - t, i, face.frame);
      }
    }
  }
  const ink = face.ink || RGB.ink;
  if (face.text) paintText(face.text, size - 6, 52, (x, y) => put(x + 3, y + 4, ink), KEY_SCALES);
  if (face.sub) paintText(face.sub, size - 6, 10, (x, y) => put(x + 3, y + 59, ink), [1]);
  return encodePng(px, size, size, 4);
}
