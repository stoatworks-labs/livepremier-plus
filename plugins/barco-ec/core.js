/*
 * A Barco EC-30 / EC-40 / EC-50 panel, as a LivePremier surface.  ** PREVIEW **
 *
 * ## A keyboard with labels, so this supplies the meaning
 *
 * A Pixelhue console is a peer: it is handed a model and reports intents
 * (`plugins/pixelhue/core.js`). An EC panel is the opposite — a CPLD behind a
 * USB chip that reports key numbers and shows whatever pixels it is sent. The
 * Event Master Toolset is where its meaning lives, so here this plugin is the
 * Toolset: it decides what each key is, draws every label, and lights every
 * lamp. Read `src/core/ec-panel.js` for the panel and `docs/BARCO-EC.md` for
 * the operator's view.
 *
 * The meaning follows the panel's own engraving and an Event Master operator's
 * habits, mapped onto what a LivePremier has:
 *
 * ```text
 *   DESTINATION row (12, paged)   screens; a press toggles one in or out of the selection
 *   LAYER row (8, paged)          the active screen's layers; a press selects one
 *   ASSIGN rows (3 × 12, paged)   inputs, stills, screens-as-sources or memories, per row;
 *                                 a source goes on the selected layer of every selected
 *                                 screen, in PREVIEW; a memory recalls to PREVIEW
 *   row LABEL key                 shows what the row holds; a press cycles it
 *   ALL TRANS / CUT / MATCH       take / cut / program-to-preview on the selection
 *   FREEZE (program)              freeze what is on air, or unfreeze
 *   T-bar                         the take, by hand
 * ```
 *
 * What a press then WRITES is `src/core/console-intents.js` — the same
 * function a Pixelhue panel's press goes through — so a take is one thing
 * whichever console asked for it.
 *
 * ## No I/O
 *
 * Same rule as `src/core/`: the supervisor reads the switcher and moves bytes;
 * this decides. The tests drive it directly.
 */

import {
  BUTTONS, BUTTON_BY_INDEX, BUTTON_BY_NAME, MODELS, hasButton, LED, COLOUR, NUM_CELLS, tbarFraction,
} from '../../src/core/ec-panel.js';

export { MODELS, tbarFraction };

/** What an Assign row can hold. `sourceKind` is `writesFor`'s spelling. */
export const ROW_KINDS = Object.freeze([
  { id: 'inputs', label: 'Inputs', short: 'INPUTS', sourceKind: 'LIVE', colour: COLOUR.WHITE },
  { id: 'stills', label: 'Stills', short: 'STILLS', sourceKind: 'STILL', colour: COLOUR.CYAN },
  { id: 'screens', label: 'Screens as sources', short: 'SCREENS', sourceKind: 'SCREEN', colour: COLOUR.BLUE },
  { id: 'memories', label: 'Memories', short: 'MEMORY', colour: COLOUR.YELLOW },
  { id: 'off', label: 'Nothing', short: '', colour: COLOUR.OFF },
]);
const KIND = new Map(ROW_KINDS.map((k) => [k.id, k]));

export const CONSOLE_MODELS = Object.freeze(Object.values(MODELS).map((m) => ({ id: m.id, label: m.name })));

export const DEST_KEYS = 12;
export const LAYER_KEYS = 8;
export const ROW_KEYS = 12;
export const ROWS = 3;

/* ------------------------------------------------------------- settings */

/**
 * Off, for the reasons the Pixelhue panel is: a preview that has never met a
 * panel, and it writes to a switcher with no browser open. The EC-50 is the
 * default model because it is the one the protocol was proved on. The top row
 * (EC-40 and EC-50 only) holds stills, the middle inputs, the bottom memories:
 * an EC-30, which has no top row, still gets inputs and memories.
 */
export const DEFAULT_BARCO_EC = Object.freeze({
  barcoEcEnabled: false,
  barcoEcModel: 'ec-50',
  barcoEcRows: Object.freeze(['stills', 'inputs', 'memories']),
});

export function normaliseBarcoEc(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const rows = Array.isArray(input.barcoEcRows) ? input.barcoEcRows : [];
  return {
    barcoEcEnabled: input.barcoEcEnabled === true,
    barcoEcModel: MODELS[input.barcoEcModel] ? input.barcoEcModel : DEFAULT_BARCO_EC.barcoEcModel,
    barcoEcRows: DEFAULT_BARCO_EC.barcoEcRows.map((d, i) => (KIND.has(rows[i]) ? rows[i] : d)),
  };
}

export const barcoEcChanged = (a, b) =>
  a.barcoEcEnabled !== b.barcoEcEnabled
  || a.barcoEcModel !== b.barcoEcModel
  || a.barcoEcRows.join() !== b.barcoEcRows.join();

/* ------------------------------------------------------------ the keys */

const named = (name) => BUTTON_BY_NAME.get(name);
export const DEST = Array.from({ length: DEST_KEYS }, (_, i) => named(`DEST_${i}`));
export const LAYER = Array.from({ length: LAYER_KEYS }, (_, i) => named(`LAYER_${i}`));
export const ASSIGN = Array.from({ length: ROWS }, (_, r) => Array.from({ length: ROW_KEYS }, (_, c) => named(`ASSIGN_${r}_${c}`)));
const WHERE = new Map();
DEST.forEach((b, i) => WHERE.set(b.index, { group: 'dest', at: i }));
LAYER.forEach((b, i) => WHERE.set(b.index, { group: 'layer', at: i }));
ASSIGN.forEach((row, r) => row.forEach((b, c) => WHERE.set(b.index, { group: 'assign', row: r, at: c })));

/* Keys with a function of their own, by the panel's name for them. */
const FUNCTION = {
  ALL_TRANS: { kind: 'take' },
  CUT: { kind: 'cut' },
  MATCH: { kind: 'matchProgram' },
  FREEZE_PGM: { kind: 'freeze' },
  DEST_UP: { kind: 'page', target: 'dest', delta: -1 },
  DEST_DOWN: { kind: 'page', target: 'dest', delta: 1 },
  LAYER_UP: { kind: 'page', target: 'layer', delta: -1 },
  LAYER_DOWN: { kind: 'page', target: 'layer', delta: 1 },
};
for (let r = 0; r < ROWS; r++) {
  FUNCTION[`ASSIGN_${r}_UP`] = { kind: 'page', target: 'row', row: r, delta: -1 };
  FUNCTION[`ASSIGN_${r}_DOWN`] = { kind: 'page', target: 'row', row: r, delta: 1 };
  FUNCTION[`ASSIGN_${r}_LABEL`] = { kind: 'cycleRow', row: r };
}
Object.freeze(FUNCTION);

/**
 * Keys this does nothing with yet, and why — said in the history when one is
 * pressed, so an operator is not left wondering.
 */
export const UNMAPPED = Object.freeze({
  LAYER_8: 'the background key — a LivePremier background is a set, not a layer source; not mapped yet',
  LAYER_TRANS: 'a LivePremier takes a screen, not a layer — no layer transition to send',
  LAYER_CUT: 'a LivePremier takes a screen, not a layer — no layer cut to send',
  ARM: 'arming layers belongs to layer transitions, which a LivePremier does not have',
  FREEZE_PVW: 'freezing preview is not mapped yet; FREEZE on the program side is',
  SHOW_CFG_0_0: 'show configuration keys are not mapped',
  SHOW_CFG_0_1: 'show configuration keys are not mapped',
  SHOW_CFG_1_0: 'show configuration keys are not mapped',
  SHOW_CFG_1_1: 'show configuration keys are not mapped',
});

/* ------------------------------------------------------------- the view */

/**
 * The panel's own state, which is not the switcher's: which page each bus is
 * on, what each Assign row holds right now (a LABEL press changes it until
 * the settings next do), and which keys are held.
 */
export function initialView(settings) {
  return {
    destPage: 0,
    layerPage: 0,
    rowPages: Array(ROWS).fill(0),
    rowKinds: [...(settings?.barcoEcRows ?? DEFAULT_BARCO_EC.barcoEcRows)],
    held: new Set(),
  };
}

/** The screens the destination row pages through: those in service, in order. */
export function destinationsOf(facts) {
  return ((facts && facts.destinations) || []).filter((d) => d.isUsed);
}

/** The active screen: the last one selected, as `Selection` keeps it. */
export const activeOf = (selection) => {
  const list = selection.list;
  return list.length ? list[list.length - 1] : null;
};

/** The fitted layers of a screen, in number order. */
export function layersOf(facts, destination) {
  return ((facts && facts.layers) || [])
    .filter((l) => l.destination === destination)
    .map((l) => l.key)
    .sort((a, b) => a - b);
}

/** What an Assign row of this kind offers, from the facts. */
export function rowItems(kindId, facts) {
  const kind = KIND.get(kindId);
  if (!kind || !facts) return [];
  if (kind.id === 'memories') {
    return (facts.presets || []).map((p) => ({ type: 'memory', slot: p.slot, label: p.label || `Memory ${p.slot}` }));
  }
  if (kind.sourceKind) {
    return ((facts.sources && facts.sources[kind.sourceKind]) || []).map((s) => ({
      /* An unnamed input is drawn by its number ("IN 2"), not the switcher's spelling of it. */
      type: 'source', sourceKind: kind.sourceKind, number: s.number, label: s.label || '',
    }));
  }
  return [];
}

const pageOf = (list, page, size) => list.slice(page * size, page * size + size);
const pages = (n, size) => Math.max(1, Math.ceil(n / size));

/** How many pages each bus has, for clamping a page key. */
export function pageCounts(view, facts, selection) {
  return {
    dest: pages(destinationsOf(facts).length, DEST_KEYS),
    layer: pages(layersOf(facts, activeOf(selection)).length, LAYER_KEYS),
    rows: view.rowKinds.map((k) => pages(rowItems(k, facts).length, ROW_KEYS)),
  };
}

/* ------------------------------------------------------- press → intent */

/**
 * What a key press asks for. Bus keys resolve against the page they are on;
 * a key on an empty slot asks for nothing. The answer is either one of
 * `console-intents.js`'s kinds — `select`, `unselect`, `selectLayer`,
 * `source`, `recall`, `take`, `cut`, `matchProgram`, `freeze` — or this
 * panel's own: `page`, `cycleRow`, `none`.
 */
export function keyIntent(index, { model, view, facts, selection }) {
  const b = BUTTON_BY_INDEX.get(index);
  if (!b || !hasButton(model, b)) return { kind: 'none', key: b ? b.name : `key ${index}`, why: 'not on this model' };

  if (UNMAPPED[b.name]) return { kind: 'none', key: b.name, why: UNMAPPED[b.name] };
  if (FUNCTION[b.name]) return { ...FUNCTION[b.name], key: b.name };

  const where = WHERE.get(index);
  if (!where) return { kind: 'none', key: b.name, why: 'no meaning yet' };

  if (where.group === 'dest') {
    const d = pageOf(destinationsOf(facts), view.destPage, DEST_KEYS)[where.at];
    if (!d) return { kind: 'none', key: b.name, why: 'no screen on that key' };
    return selection.destinations.has(d.id)
      ? { kind: 'unselect', destination: d.id, key: b.name }
      : { kind: 'select', destination: d.id, key: b.name };
  }

  if (where.group === 'layer') {
    const layer = pageOf(layersOf(facts, activeOf(selection)), view.layerPage, LAYER_KEYS)[where.at];
    if (!layer) return { kind: 'none', key: b.name, why: activeOf(selection) ? 'no layer on that key' : 'select a screen first' };
    return { kind: 'selectLayer', layer, key: b.name };
  }

  const kind = view.rowKinds[where.row];
  const item = pageOf(rowItems(kind, facts), view.rowPages[where.row], ROW_KEYS)[where.at];
  if (!item) return { kind: 'none', key: b.name, why: 'nothing on that key' };
  if (item.type === 'memory') return { kind: 'recall', slot: item.slot, label: item.label, key: b.name };
  return { kind: 'source', input: item.number, sourceKind: item.sourceKind, label: item.label, key: b.name };
}

/** A page or row-cycle intent applied to the view; a new view, clamped. */
export function applyView(view, intent, counts) {
  const next = { ...view, rowPages: [...view.rowPages], rowKinds: [...view.rowKinds] };
  const clamp = (v, n) => Math.max(0, Math.min(n - 1, v));
  if (intent.kind === 'page') {
    if (intent.target === 'dest') next.destPage = clamp(view.destPage + intent.delta, counts.dest);
    if (intent.target === 'layer') next.layerPage = clamp(view.layerPage + intent.delta, counts.layer);
    if (intent.target === 'row') next.rowPages[intent.row] = clamp(view.rowPages[intent.row] + intent.delta, counts.rows[intent.row]);
  }
  if (intent.kind === 'cycleRow') {
    const order = ROW_KINDS.map((k) => k.id);
    next.rowKinds[intent.row] = order[(order.indexOf(view.rowKinds[intent.row]) + 1) % order.length];
    next.rowPages[intent.row] = 0;
  }
  return next;
}

/* ------------------------------------------------------- the panel drawn */

const SHORT = { LIVE: 'IN', STILL: 'STILL', SCREEN: 'S' };

/**
 * Every label, backlight and lamp the panel should show, for the facts, the
 * selection and the view as they stand: `{ cells: Map(cell → {text, colour}),
 * leds: Map(key → LED.*) }`. The supervisor sends the difference.
 *
 * - Destination lamps: green for the selected screens.
 * - Layer lamps: red for a fitted layer of the active screen, green for the
 *   selected one.
 * - Assign keys: the item's name on a backlight in the row's colour; a key
 *   with nothing on it dark. The row's LABEL key names the row and its page.
 * - FREEZE: red while a selected screen has a frozen layer (as last read).
 * - Any key held down: its lamp green, so the operator sees the press land.
 */
export function paint({ model, view, facts, selection }) {
  const cells = new Map();
  const leds = new Map();
  for (let c = 0; c < NUM_CELLS; c++) cells.set(c, { text: '', colour: COLOUR.OFF });
  for (const b of BUTTONS) if (b.reg !== null && hasButton(model, b)) leds.set(b.index, LED.OFF);

  const dests = pageOf(destinationsOf(facts), view.destPage, DEST_KEYS);
  DEST.forEach((b, i) => {
    const d = dests[i];
    if (d && selection.destinations.has(d.id)) leds.set(b.index, LED.GREEN);
    /* DEST_11 is the one destination key with a display of its own. */
    if (b.lcd >= 0) cells.set(b.lcd, d ? { text: d.label || d.id, colour: COLOUR.WHITE } : { text: '', colour: COLOUR.OFF });
  });

  const active = activeOf(selection);
  const layers = pageOf(layersOf(facts, active), view.layerPage, LAYER_KEYS);
  LAYER.forEach((b, i) => {
    const key = layers[i];
    if (key === undefined) return;
    leds.set(b.index, key === selection.layer ? LED.GREEN : LED.RED);
  });

  for (let r = 0; r < ROWS; r++) {
    if (!hasButton(model, ASSIGN[r][0])) continue;
    const kind = KIND.get(view.rowKinds[r]) || KIND.get('off');
    const all = rowItems(kind.id, facts);
    const items = pageOf(all, view.rowPages[r], ROW_KEYS);
    ASSIGN[r].forEach((b, c) => {
      const item = items[c];
      if (b.lcd < 0) return;
      cells.set(b.lcd, item
        ? { text: item.label || (item.type === 'memory' ? `M${item.slot}` : `${SHORT[item.sourceKind]} ${item.number}`), colour: kind.colour }
        : { text: '', colour: COLOUR.OFF });
    });
    const label = named(`ASSIGN_${r}_LABEL`);
    if (label && label.lcd >= 0) {
      const from = view.rowPages[r] * ROW_KEYS + 1;
      const to = Math.min(all.length, from + ROW_KEYS - 1);
      cells.set(label.lcd, kind.id === 'off'
        ? { text: 'OFF', colour: COLOUR.DIM }
        : { text: all.length ? `${kind.short}\n${from}-${to}` : `${kind.short}\nnone`, colour: kind.colour });
    }
  }

  const frz = named('FREEZE_PGM');
  if (destinationsOf(facts).some((d) => selection.destinations.has(d.id) && d.frozen)) leds.set(frz.index, LED.RED);

  for (const index of view.held) if (leds.has(index)) leds.set(index, LED.GREEN);

  /* What a model does not have is never drawn. */
  for (const b of BUTTONS) if (b.lcd >= 0 && !hasButton(model, b)) cells.set(b.lcd, { text: '', colour: COLOUR.OFF });
  return { cells, leds };
}

/** The difference between two paints, as one `command` for the device host. */
export function paintCommand(next, prev) {
  const cells = [];
  for (const [cell, v] of next.cells) {
    const was = prev && prev.cells.get(cell);
    if (!was || was.text !== v.text || was.colour !== v.colour) cells.push({ cell, text: v.text, colour: v.colour });
  }
  const leds = [];
  for (const [index, state] of next.leds) {
    if (!prev || prev.leds.get(index) !== state) leds.push({ index, state });
  }
  return { cells, leds };
}

/* ------------------------------------------------------------- the T-bar */

/*
 * How far a stroke has gone. The EC T-bar reports where the lever IS, and
 * `strokeProgress` turns that into how far through a take it is. It lives in
 * `src/core/console-intents.js` since the ATEM Micro Panel's T-bar, which
 * reports the same way, arrived (2026-10-20); re-exported so nothing that
 * imported it from here had to move.
 */
export { strokeProgress, STROKE_END } from '../../src/core/console-intents.js';
