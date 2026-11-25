/*
 * A Maschine MK3, as a LivePremier surface.  ** PREVIEW **
 *
 * ## A drum machine's face on a switcher
 *
 * The panel does nothing by itself: Maschine 2 reads its controls, lights
 * its lamps and draws its two screens (`src/core/maschine-mk3.js`). Here this
 * plugin stands where Maschine 2 does, and what is behind it is a
 * LivePremier. The meaning borrows the ATEM Micro Panel plugin's habits —
 * screens on one row of keys, sources on another, the selected layer, a
 * T-bar — and adds what a Maschine has that an ATEM panel has not: screens
 * to label its keys with, and knobs.
 *
 * ```text
 *   GROUP A–H (SHIFT: 9–16)   screens in service, in order; a press makes that screen the one the
 *                             panel drives; with another group key held, it is added or taken out
 *   PADS 1–16 (SHIFT: 17–32)  pad n is source n onto the selected layer, IN PREVIEW, on every
 *                             selected screen; or memory n, recalled to preview (soft key 4)
 *   SOFT KEYS 1–4             what the pads hold: inputs, stills, screens, memories
 *   SOFT KEYS 5–7             MATCH (program to preview), FREEZE, FADE TO BLACK
 *   PLAY / RESTART            take / cut, on the selection
 *   TOUCH STRIP               a T-bar: touch it where the lever is (the lit dot) and slide
 *   ENCODER, or ◀ ▶ on it     the selected layer: previous or next fitted layer
 *   KNOBS 1–5                 the selected layer IN PREVIEW: opacity, X, Y, width, height
 *                             (SHIFT: a tenth of the step)
 *   SHIFT                     held: the second bank of screens and pads, fine knobs
 * ```
 *
 * The soft keys are the eight buttons above the screens, labelled on the
 * screens; the knobs are labelled below. Pad numbers are Maschine's own, 1
 * at the bottom left.
 *
 * **Everything lands in preview**, as on the X-keys: sources, memories, and
 * the knobs too. Nothing here puts anything on air except a take, a cut, the
 * strip and FADE TO BLACK, which is what they are for.
 *
 * What a press then WRITES is `src/core/console-intents.js`, the function
 * every other console's presses go through, so a take is one thing whichever
 * panel asked for it. The knobs' writes are this file's own
 * (`knobWrites`), because no other console has knobs.
 *
 * ## No I/O
 *
 * The supervisor reads the switcher and moves bytes; this decides. The tests
 * drive it directly.
 */

import { HUE, PADS, KNOBS, STRIP_LEDS, KNOB_RANGE, padIndex, SCREEN_W } from '../../src/core/maschine-mk3.js';
import {
  destinationsOf, activeOf, layersOf, sourceAt, memoryAt, selectOnly, stepLayer,
} from '../../src/core/console-intents.js';

export { destinationsOf, activeOf, layersOf, selectOnly };

/* ------------------------------------------------------------- settings */

/**
 * Off, as every console here starts: a preview that has never met a panel,
 * and it writes to a switcher with no browser open.
 */
export const DEFAULT_MASCHINE = Object.freeze({ maschineEnabled: false });

export function normaliseMaschine(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return { maschineEnabled: input.maschineEnabled === true };
}

export const maschineChanged = (a, b) => a.maschineEnabled !== b.maschineEnabled;

/* ------------------------------------------------------------- the keys */

export const GROUPS = Object.freeze('abcdefgh'.split('').map((g) => `group-${g}`));
export const GROUP_KEYS = GROUPS.length;

/** What the pads hold, by the soft key that picks it. `kind` is `writesFor`'s `sourceKind`, or MEMORY. */
export const PAD_KINDS = Object.freeze([
  { key: 'top-1', kind: 'LIVE', label: 'INPUTS' },
  { key: 'top-2', kind: 'STILL', label: 'STILLS' },
  { key: 'top-3', kind: 'SCREEN', label: 'SCREENS' },
  { key: 'top-4', kind: 'MEMORY', label: 'MEMORIES' },
]);
const PAD_KIND_BY_KEY = new Map(PAD_KINDS.map((p) => [p.key, p]));

/* Keys with a job of their own, and the soft keys' labels on the right screen. */
const FUNCTION = Object.freeze({
  play: { kind: 'take' },
  restart: { kind: 'cut' },
  'top-5': { kind: 'matchProgram' },
  'top-6': { kind: 'freeze' },
  'top-7': { kind: 'ftb' },
  shift: { kind: 'shift' },
  'encoder-left': { kind: 'layerStep', to: 'prev' },
  'encoder-right': { kind: 'layerStep', to: 'next' },
});
export const SOFT_LABELS = Object.freeze(['INPUTS', 'STILLS', 'SCREENS', 'MEMORIES', 'MATCH', 'FREEZE', 'FTB', '']);

/* Held, never pressed: a knob or the encoder being touched is shown, not acted on. */
export const TOUCHES = Object.freeze(new Set([
  'encoder-touch', 'encoder-push', ...Array.from({ length: KNOBS }, (_, i) => `knob-touch-${i + 1}`),
]));

/**
 * Keys this does nothing with, and why where it is worth saying — said in
 * the history when one is pressed, so an operator is not left wondering.
 * Any other key is answered "no job yet".
 */
export const UNMAPPED = Object.freeze({
  stop: 'STOP has no job: PLAY takes, RESTART cuts, and fade to black is soft key 7',
  rec: 'REC has no job: nothing here records',
  'top-8': 'the eighth soft key has no job yet',
  'encoder-up': 'the encoder’s up and down have no job; turn it, or push it left and right, for the layer',
  'encoder-down': 'the encoder’s up and down have no job; turn it, or push it left and right, for the layer',
  'arrow-left': 'the page arrows have no job; SHIFT shows the second bank of screens and pads',
  'arrow-right': 'the page arrows have no job; SHIFT shows the second bank of screens and pads',
});

/* ------------------------------------------------------------- the knobs */

/**
 * The knobs, by the dialect's own names for a layer's position, size and
 * opacity (`dialect.layerParams`), so a Midra's size, under another node, is
 * found as a LivePremier's is. Knobs 6–8 have no job.
 */
export const KNOB_PARAMS = Object.freeze([
  { knob: 0, param: 'opacity', label: 'OPACITY' },
  { knob: 1, param: 'posH', label: 'POS X' },
  { knob: 2, param: 'posV', label: 'POS Y' },
  { knob: 3, param: 'sizeH', label: 'WIDTH' },
  { knob: 4, param: 'sizeV', label: 'HEIGHT' },
]);

/** What knob `index` adjusts on this platform: `{knob, param, label, tail, min, max}`, or null. */
export function knobSpec(index, dialect) {
  const k = KNOB_PARAMS.find((p) => p.knob === index);
  const id = k && dialect && dialect.layerParams ? dialect.layerParams[k.param] : null;
  const entry = id ? ((dialect.catalogue && dialect.catalogue.layer) || []).find((p) => p.id === id) : null;
  if (!entry) return null;
  return { ...k, id, tail: entry.path, min: entry.min, max: entry.max };
}

/*
 * A knob reports 1000 counts before it wraps. Opacity crosses its whole
 * range in those 1000; position and size move a pixel a count. SHIFT is a
 * tenth of either. How many counts a turn is has not been measured.
 */
const unitOf = (spec) => (spec.param === 'opacity' ? (spec.max - spec.min) / KNOB_RANGE : 1);

/** How far `counts` move a knob's parameter, unclamped. */
export function knobStep(spec, counts, { fine = false } = {}) {
  return counts * unitOf(spec) * (fine ? 0.1 : 1);
}

/** Where a knob's value goes from `from` after `counts`, clamped to the parameter's range. */
export function knobValue(spec, from, counts, opts = {}) {
  return Math.min(spec.max, Math.max(spec.min, from + knobStep(spec, counts, opts)));
}

/** A knob's value as its screen shows it: opacity a percentage, the rest whole pixels. */
export function knobText(spec, value) {
  if (!spec) return '';
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (spec.param === 'opacity') return `${Math.round((value / spec.max) * 100)}%`;
  return String(Math.round(value));
}

/**
 * The writes for one knob's value on each selected screen: the layer's
 * parameter in the PREVIEW buffer, by the letter read for it. A screen whose
 * letter could not be read is left out, as `writesFor` leaves it.
 *
 * @param {object} ctx `{dialect, spec, layer, values: Map(id → value), letterFor(id)}`
 */
export function knobWrites({ dialect, spec, layer, values, letterFor }) {
  const writes = [];
  for (const [id, value] of values) {
    const letter = letterFor(id);
    if (!letter || typeof value !== 'number') continue;
    writes.push({ path: dialect.layerParamPath(id, letter, layer, spec.tail), value: Math.round(value) });
  }
  return writes;
}

/* ------------------------------------------------------------- the view */

/**
 * The panel's own state, which is not the switcher's: what the pads hold,
 * SHIFT, every button and pad held, and the T-bar lever where the strip last
 * left it (0 the left end, 1 the right).
 */
export function initialView() {
  return { padKind: 'LIVE', shift: false, held: new Set(), pads: new Set(), lever: 0 };
}

const bank = (view, size) => (view.shift ? size : 0);
const sourcesOf = (facts, kind) => (facts && facts.sources && facts.sources[kind]) || [];
const kindWord = (kind) => ({ LIVE: 'input', STILL: 'still', SCREEN: 'screen' }[kind] || 'source');
const labelOf = (name) => name.replace(/-/g, ' ').toUpperCase();

/* ------------------------------------------------------- press → intent */

/**
 * What a button press asks for: one of `console-intents.js`'s kinds —
 * `select`, `unselect`, `selectLayer`, `take`, `cut`, `matchProgram`,
 * `freeze`, `ftb` — or this panel's own: `selectOnly`, `padKind`, `shift`,
 * `touch`, `none`.
 *
 * @param {string} name   the button, by `BUTTONS`' name
 * @param {object} ctx    `{view, facts, selection}`
 */
export function buttonIntent(name, { view, facts, selection }) {
  if (TOUCHES.has(name)) return { kind: 'touch', key: name };
  const fn = FUNCTION[name];
  if (fn) {
    if (fn.kind === 'layerStep') return layerStep(fn.to, name, { facts, selection });
    return { ...fn, key: name };
  }

  const padKind = PAD_KIND_BY_KEY.get(name);
  if (padKind) {
    if (padKind.kind !== 'MEMORY' && !sourcesOf(facts, padKind.kind).length) {
      return { kind: 'none', key: name, why: `this switcher has no ${padKind.label.toLowerCase()} to put on the pads` };
    }
    return { kind: 'padKind', padKind: padKind.kind, key: name };
  }

  const at = GROUPS.indexOf(name);
  if (at >= 0) {
    const d = destinationsOf(facts)[at + bank(view, GROUP_KEYS)];
    if (!d) return { kind: 'none', key: name, why: 'no screen on that group key' };
    /* Another group key held: build a selection of several screens. */
    const others = GROUPS.some((g) => g !== name && view.held.has(g));
    if (!others) return { kind: 'selectOnly', destination: d.id, key: name };
    return selection.destinations.has(d.id)
      ? { kind: 'unselect', destination: d.id, key: name }
      : { kind: 'select', destination: d.id, key: name };
  }

  return { kind: 'none', key: name, why: UNMAPPED[name] || `${labelOf(name)} has no job yet` };
}

/** The encoder turned (`delta` clicks) or pushed: the active screen's previous or next fitted layer. */
export function encoderIntent(delta, ctx) {
  if (!delta) return { kind: 'none', key: 'encoder', why: 'no step' };
  return layerStep(delta > 0 ? 'next' : 'prev', 'encoder', ctx);
}

function layerStep(to, key, { facts, selection }) {
  const active = activeOf(selection);
  if (!active) return { kind: 'none', key, why: 'select a screen first' };
  const layer = stepLayer(layersOf(facts, active), selection.layer, to);
  if (layer === null) return { kind: 'none', key, why: 'that screen has no fitted layers' };
  if (layer === selection.layer) return { kind: 'none', key, why: `already on the ${to === 'next' ? 'top' : 'bottom'} layer`, quiet: true };
  return { kind: 'selectLayer', layer, key };
}

/**
 * What a pad hit asks for: a `source` in preview, a `recall` to preview, or
 * `none` with why. Pad n is source n, not the nth source there is: an
 * unmapped input leaves a gap, as on the ATEM panel.
 */
export function padIntent(number, { view, facts, memoryLimit = 32 }) {
  const n = number + bank(view, PADS);
  const key = `PAD ${number}`;
  if (view.padKind === 'MEMORY') {
    const memory = memoryAt(facts, n, memoryLimit);
    if (!memory) return { kind: 'none', key, why: `no memory in slot ${n}` };
    return { kind: 'recall', slot: n, label: memory.label, key };
  }
  const source = sourceAt(facts, view.padKind, n);
  if (!source) return { kind: 'none', key, why: `${kindWord(view.padKind)} ${n} is not in use` };
  return { kind: 'source', input: n, sourceKind: view.padKind, buffer: 'PREVIEW', label: source.label, key };
}

/* ------------------------------------------------------- the lamps */

const L = (hue, level) => ({ hue, level });

/**
 * Every lamp, for the facts, the selection, the tally and the view as they
 * stand: `{buttons: Map(name → light), pads: [16 by index], strip: [25]}`,
 * which `ledSlots` turns into bytes. Chosen is yellow (or a mono lamp full),
 * available blue (or a mono lamp low), on air red, in preview green, held
 * cyan.
 *
 * @param o.tally   `ConsoleSwitcher.tallyFor` for the active screen: `{layer, program, preview}`, or null
 * @param o.stroke  a strip stroke under way, `{from, at, progress}`, or null
 */
export function paint({ view, facts, selection, tally = null, stroke = null, memoryLimit = 32 }) {
  const buttons = new Map();
  const dests = destinationsOf(facts);

  GROUPS.forEach((name, i) => {
    const d = dests[i + bank(view, GROUP_KEYS)];
    if (d) buttons.set(name, selection.destinations.has(d.id) ? L(HUE.YELLOW, 3) : L(HUE.BLUE, 1));
  });

  for (const p of PAD_KINDS) {
    if (p.kind !== 'MEMORY' && !sourcesOf(facts, p.kind).length) continue;
    buttons.set(p.key, L(HUE.WHITE, view.padKind === p.kind ? 3 : 1));
  }
  const selected = dests.filter((d) => selection.destinations.has(d.id));
  buttons.set('top-5', L(HUE.WHITE, 1));
  buttons.set('top-6', L(HUE.WHITE, selected.some((d) => d.frozen) ? 3 : 1));
  buttons.set('top-7', L(HUE.WHITE, selected.some((d) => d.faded) ? 3 : 1));
  buttons.set('play', L(HUE.GREEN, stroke ? 3 : 1));
  buttons.set('restart', L(HUE.WHITE, 1));
  buttons.set('shift', L(HUE.WHITE, view.shift ? 3 : 1));
  if (layersOf(facts, activeOf(selection)).length > 1) {
    buttons.set('encoder-left', L(HUE.WHITE, 1));
    buttons.set('encoder-right', L(HUE.WHITE, 1));
  }
  /* A held key shows the press landing. SHIFT already says it is held. */
  for (const name of view.held) {
    if (name !== 'shift' && buttons.has(name)) buttons.set(name, L(HUE.CYAN, 3));
  }

  const pads = new Array(PADS).fill(null);
  const offset = bank(view, PADS);
  for (let number = 1; number <= PADS; number++) {
    const n = number + offset;
    let light = null;
    if (view.padKind === 'MEMORY') {
      if (memoryAt(facts, n, memoryLimit)) light = L(HUE.BLUE, 1);
    } else if (sourceAt(facts, view.padKind, n)) {
      light = L(HUE.WHITE, 1);
      const on = (src) => !!src && src.kind === view.padKind && src.number === n;
      if (tally && tally.layer === selection.layer) {
        if (on(tally.preview)) light = L(HUE.GREEN, 3);
        if (on(tally.program)) light = L(HUE.RED, 3);
      }
    }
    if (view.pads.has(number)) light = L(HUE.CYAN, 3);
    pads[padIndex(number)] = light;
  }

  return { buttons, pads, strip: stripLights(view.lever, stroke) };
}

/**
 * The strip's 25 lamps: between strokes, the lever as one dot, where a
 * stroke has to start; during one, red from the end it started at to the
 * finger.
 */
export function stripLights(lever, stroke) {
  const out = new Array(STRIP_LEDS).fill(null);
  const at = (f) => Math.max(0, Math.min(STRIP_LEDS - 1, Math.round(f * (STRIP_LEDS - 1))));
  if (stroke) {
    const a = at(stroke.from < 0.5 ? 0 : 1);
    const b = at(stroke.at);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out[i] = L(HUE.RED, 2);
    out[b] = L(HUE.RED, 3);
    return out;
  }
  out[at(lever)] = L(HUE.WHITE, 3);
  return out;
}

/* ------------------------------------------------------- the screens */

/*
 * Each screen is a `raster.js` scene the device host draws: 480 × 272, a
 * row of four soft-key labels at the top, a row of four knob labels at the
 * bottom, and between them, on the left, the screen driven and its tally,
 * on the right the selection, the strip's progress and the last thing said.
 * Text is the EC panel's 5 × 8 font, scaled: read across a desk, not
 * typography.
 */
const RGB = Object.freeze({
  BG: [0, 0, 0], TEXT: [255, 255, 255], DIM: [110, 110, 110], RULE: [60, 60, 60],
  RED: [230, 40, 40], GREEN: [40, 190, 70], YELLOW: [250, 200, 0], ORANGE: [255, 140, 0], INK: [0, 0, 0],
});
const CELL = SCREEN_W / 4;
const TOP = { y: 0, h: 30 };
const KNOB_ROW = { y: 206, label: 22, value: 40 };

const txt = (text, rect, rgb = RGB.TEXT, scales = [2, 1]) => ({ op: 'text', rect, text: String(text ?? ''), rgb, scales });
const box = (rect, rgb) => ({ op: 'fill', rect, rgb });

function softRow(labels, states) {
  const ops = [];
  labels.forEach((label, i) => {
    const rect = { x: i * CELL + 2, y: TOP.y + 2, w: CELL - 4, h: TOP.h - 4 };
    const state = states[i];
    if (!label) return;
    if (state === 'chosen') { ops.push(box(rect, RGB.TEXT), txt(label, rect, RGB.INK)); return; }
    if (state === 'alarm') { ops.push(box(rect, RGB.RED), txt(label, rect, RGB.TEXT)); return; }
    ops.push(txt(label, rect, state === 'off' ? RGB.RULE : RGB.TEXT));
  });
  ops.push(box({ x: 0, y: TOP.h + 1, w: SCREEN_W, h: 1 }, RGB.RULE));
  return ops;
}

function knobRow(first, { dialect, values, editing, touched }) {
  const ops = [box({ x: 0, y: KNOB_ROW.y - 4, w: SCREEN_W, h: 1 }, RGB.RULE)];
  for (let i = 0; i < 4; i++) {
    const index = first + i;
    const spec = knobSpec(index, dialect);
    if (!spec) continue;
    const x = i * CELL + 2;
    const hot = touched.has(index) || editing.has(index);
    ops.push(txt(spec.label, { x, y: KNOB_ROW.y, w: CELL - 4, h: KNOB_ROW.label }, hot ? RGB.TEXT : RGB.DIM));
    const value = editing.has(index) ? editing.get(index) : values.get(spec.param);
    ops.push(txt(knobText(spec, value), { x, y: KNOB_ROW.y + KNOB_ROW.label + 2, w: CELL - 4, h: KNOB_ROW.value },
      editing.has(index) ? RGB.YELLOW : RGB.TEXT, [3, 2, 1]));
  }
  return ops;
}

function sourceName(facts, src) {
  if (!src) return 'nothing';
  const found = sourceAt(facts, src.kind, src.number);
  const word = { LIVE: 'IN', STILL: 'STILL', SCREEN: 'S' }[src.kind] || src.kind;
  return found && found.label ? `${word} ${src.number} ${found.label}` : `${word} ${src.number}`;
}

/**
 * Both screens' scenes: `[left, right]`.
 *
 * @param o.params   Map(param → value): the active screen's selected layer in preview, as read
 * @param o.editing  Map(knob index → value) for knobs being turned now
 * @param o.note     the last thing said, `{text, error}`, or null
 * @param o.error    why the switcher could not be read, or null
 */
export function screens({
  view, facts, selection, tally = null, stroke = null, params = new Map(), editing = new Map(), note = null, error = null,
}) {
  const dialect = facts ? facts.dialect : null;
  const touched = new Set([...view.held].filter((n) => n.startsWith('knob-touch-')).map((n) => Number(n.slice(11)) - 1));
  const dests = destinationsOf(facts);
  const selected = dests.filter((d) => selection.destinations.has(d.id));
  const knobs = { dialect, values: params, editing, touched };

  /* ---- left: what the pads hold, the screen driven, its tally ---- */
  const left = [];
  left.push(...softRow(SOFT_LABELS.slice(0, 4), PAD_KINDS.map((p) => {
    if (p.kind !== 'MEMORY' && !sourcesOf(facts, p.kind).length) return 'off';
    return view.padKind === p.kind ? 'chosen' : 'on';
  })));
  const active = dests.find((d) => d.id === activeOf(selection)) || null;
  if (!facts) {
    left.push(txt('NO SWITCHER', { x: 8, y: 50, w: SCREEN_W - 16, h: 40 }, RGB.ORANGE, [3, 2]));
    if (error) left.push(txt(error, { x: 8, y: 100, w: SCREEN_W - 16, h: 90 }, RGB.DIM, [2, 1]));
  } else if (!active) {
    left.push(txt('NO SCREEN', { x: 8, y: 50, w: SCREEN_W - 16, h: 40 }, RGB.DIM, [3, 2]));
    left.push(txt('press a group key', { x: 8, y: 100, w: SCREEN_W - 16, h: 30 }, RGB.DIM, [2, 1]));
  } else {
    const fitted = layersOf(facts, active.id);
    left.push(txt(`${active.id} ${active.label || ''}`.trim(), { x: 8, y: 38, w: SCREEN_W - 16, h: 34 }, RGB.TEXT, [3, 2, 1]));
    left.push(txt(`LAYER ${selection.layer} OF ${fitted.length}`, { x: 8, y: 74, w: SCREEN_W - 16, h: 20 }, RGB.DIM, [2, 1]));
    const row = (y, tag, rgb, src) => {
      left.push(box({ x: 8, y, w: 72, h: 38 }, rgb), txt(tag, { x: 8, y, w: 72, h: 38 }, RGB.INK, [3, 2]));
      left.push(txt(sourceName(facts, src), { x: 88, y, w: SCREEN_W - 96, h: 38 }, RGB.TEXT, [2, 1]));
    };
    const shown = tally && tally.layer === selection.layer ? tally : null;
    row(104, 'PGM', RGB.RED, shown && shown.program);
    row(150, 'PVW', RGB.GREEN, shown && shown.preview);
  }
  left.push(...knobRow(0, knobs));

  /* ---- right: the switcher's keys, the selection, the strip, the last word ---- */
  const right = [];
  right.push(...softRow(SOFT_LABELS.slice(4), [
    'on',
    selected.some((d) => d.frozen) ? 'alarm' : 'on',
    selected.some((d) => d.faded) ? 'alarm' : 'on',
    'off',
  ]));
  right.push(txt('DRIVING', { x: 8, y: 38, w: 140, h: 18 }, RGB.DIM, [2, 1]));
  right.push(txt(selection.list.join(' ') || 'nothing', { x: 8, y: 56, w: SCREEN_W - 16, h: 34 },
    selection.list.length ? RGB.TEXT : RGB.DIM, [3, 2, 1]));
  const kind = PAD_KINDS.find((p) => p.kind === view.padKind);
  const first = 1 + bank(view, PADS);
  right.push(txt(`PADS: ${kind ? kind.label : ''} ${first}-${first + PADS - 1}`, { x: 8, y: 96, w: SCREEN_W - 16, h: 20 }, RGB.DIM, [2, 1]));
  if (stroke) {
    const bar = { x: 8, y: 124, w: SCREEN_W - 16, h: 30 };
    right.push(box(bar, RGB.RULE), box({ ...bar, w: Math.round(bar.w * (stroke.progress ?? 0)) }, RGB.RED));
    right.push(txt(`T-BAR ${Math.round((stroke.progress ?? 0) * 100)}%`, bar, RGB.TEXT, [2, 1]));
  } else {
    const flags = [selected.some((d) => d.frozen) && 'FROZEN', selected.some((d) => d.faded) && 'FADED'].filter(Boolean);
    if (flags.length) right.push(txt(flags.join('  '), { x: 8, y: 124, w: SCREEN_W - 16, h: 30 }, RGB.RED, [3, 2]));
  }
  if (note && note.text) {
    right.push(txt(note.text, { x: 8, y: 160, w: SCREEN_W - 16, h: 38 }, note.error ? RGB.ORANGE : RGB.DIM, [2, 1]));
  }
  right.push(...knobRow(4, knobs));

  return [{ background: RGB.BG, ops: left }, { background: RGB.BG, ops: right }];
}

/** Both screens black, for whoever has the panel next. */
export const blankScreens = () => [{ background: RGB.BG, ops: [] }, { background: RGB.BG, ops: [] }];
