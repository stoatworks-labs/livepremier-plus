/*
 * An X-keys panel, as a LivePremier surface.  ** PREVIEW **
 *
 * ## Blank keys, so the operator says what they are
 *
 * The ATEM Micro Panel and the Barco EC panels are a switcher's face: every
 * key is printed, so their plugins know what each one means. An X-keys is
 * the opposite — rows of blank keys with clear caps for a paper legend — so
 * here every key is given ONE job by the operator, on the card, and that job
 * is saved per model (`xkeysLayouts`). A model nobody has laid out yet gets
 * `suggestedLayout`, shown on the card as a suggestion until it is saved.
 *
 * A job is one of `console-intents.js`'s kinds, or a choice of what the panel
 * drives — the same vocabulary the other consoles' printed keys speak:
 *
 * ```text
 *   take · cut · program to preview · fade to black · freeze · take time ±0.1 s
 *   recall memory n            to PREVIEW, always, as every recall here
 *   input / still / screen n   onto the selected layer of every selected screen, in PREVIEW
 *   drive screen S n           that screen alone; "add or drop" builds a selection
 *   layer n · next · previous  the layer a source key puts its source on
 * ```
 *
 * The T-bar on an XKE-124 T-bar, an XKE-64 Jog T-bar or an X-blox T-bar
 * module takes by hand, as the ATEM Micro Panel's does. Jog and shuttle have
 * no job yet.
 *
 * ## Lamps
 *
 * Most X-keys light each key blue, red, both or neither; the RGB panels any
 * colour; the sticks only blue; some nothing. `paletteFor` picks per panel,
 * on the ATEM's rules where colour allows: red is on air and blue (green on
 * RGB) in preview, on the selected layer of the active screen; blue (yellow
 * on RGB) is the screen and layer driven; red is FTB while faded, freeze
 * while frozen and TAKE during a T-bar stroke; a held key shows both colours
 * (white), so the press is seen landing. Keys with nothing to say are dark on
 * a two-colour panel, which has no spare colour for "available".
 *
 * ## No I/O
 *
 * The supervisor reads the switcher and moves bytes; this decides.
 */

import { keysOf, lampsOf, RGB } from '../../src/core/xkeys.js';
import {
  destinationsOf, activeOf, layersOf, sourceAt, memoryAt, stepLayer,
} from '../../src/core/console-intents.js';

/* ------------------------------------------------------------- the jobs */

const n = (b) => b.n;

/**
 * Every job a key can have. `needs` is what else a binding holds: `'number'`
 * (`n`, from 1) or `'destination'` (`id`, a screen or aux id). `short` is the
 * legend on the card.
 */
export const JOBS = Object.freeze([
  { id: 'none', label: 'Nothing', short: () => '', what: 'The key does nothing.' },
  { id: 'take', label: 'Take', short: () => 'TAKE', what: 'Takes every selected screen: preview goes to air.' },
  { id: 'cut', label: 'Cut', short: () => 'CUT', what: 'Cuts every selected screen: preview to air at once, no transition.' },
  { id: 'matchProgram', label: 'Program to preview', short: () => 'MATCH', what: 'Copies what is on air into preview, on every selected screen.' },
  { id: 'ftb', label: 'Fade to black', short: () => 'FTB', what: 'Fades every selected screen to black, or back up when all of them are black. Flashes while faded.' },
  { id: 'freeze', label: 'Freeze', short: () => 'FRZ', what: 'Freezes what is on air on every selected screen, or unfreezes it. Red while frozen (flashing, on a blue-only panel).' },
  { id: 'timeUp', label: 'Take time + 0.1 s', short: () => 'T +', what: 'Adds a tenth of a second to the take time of every selected screen, up to 10 s.' },
  { id: 'timeDown', label: 'Take time − 0.1 s', short: () => 'T −', what: 'Takes a tenth of a second off the take time of every selected screen, down to 0.1 s.' },
  { id: 'recall', label: 'Recall memory', needs: 'number', short: (b) => `MEM ${n(b)}`, what: 'Recalls that memory to PREVIEW on every selected screen — never to air.' },
  { id: 'input', label: 'Input to preview', needs: 'number', short: (b) => `IN ${n(b)}`, what: 'Puts that input on the selected layer of every selected screen, in preview. Lit while it is on air there, or in preview.' },
  { id: 'still', label: 'Still to preview', needs: 'number', short: (b) => `STL ${n(b)}`, what: 'Puts that still on the selected layer of every selected screen, in preview.' },
  { id: 'screenSource', label: 'Screen to preview (as a source)', needs: 'number', short: (b) => `SCR ${n(b)}`, what: 'Puts screen n, as a source, on the selected layer of every selected screen, in preview.' },
  { id: 'screen', label: 'Drive this screen', needs: 'destination', short: (b) => b.id, what: 'Makes that screen the only one the panel drives, on its first layer. Lit while driven.' },
  { id: 'screenAdd', label: 'Add or drop this screen', needs: 'destination', short: (b) => `+${b.id}`, what: 'Adds that screen to the ones the panel drives, or drops it. Lit while driven.' },
  { id: 'layer', label: 'Select layer', needs: 'number', short: (b) => `L ${n(b)}`, what: 'Makes layer n the one source keys put their source on. Lit while selected.' },
  { id: 'layerNext', label: 'Next layer', short: () => 'L ▲', what: 'Moves to the next fitted layer of the active screen.' },
  { id: 'layerPrev', label: 'Previous layer', short: () => 'L ▼', what: 'Moves to the previous fitted layer of the active screen.' },
]);
const JOB_BY_ID = new Map(JOBS.map((j) => [j.id, j]));
export const jobOf = (id) => JOB_BY_ID.get(id) ?? null;

const SOURCE_KIND = Object.freeze({ input: 'LIVE', still: 'STILL', screenSource: 'SCREEN' });
const KIND_WORD = Object.freeze({ LIVE: 'input', STILL: 'still', SCREEN: 'screen' });

/** The legend for a key: `IN 3`, `MEM 2`, `TAKE`… or empty. */
export function legendOf(binding) {
  const job = binding && jobOf(binding.do);
  return job ? job.short(binding) : '';
}

/* ------------------------------------------------------------- settings */

/* A model is the table's key (`XK24`, `XKE124TBAR`); a key's index is a number. */
const MODEL_ID = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const KEY_ID = /^\d{1,3}$/;
const DESTINATION = /^(S|A)\d{1,2}$/;
const MAX_NUMBER = 999;
/* The most keys any X-keys has is 217 (the XKE-180); a layout is never bigger. */
const MAX_KEYS = 256;

/**
 * Off, as every console here starts: a preview that has never met a panel,
 * and it writes to a switcher with no browser open.
 */
export const DEFAULT_XKEYS = Object.freeze({ xkeysEnabled: false, xkeysLayouts: Object.freeze({}) });

/** One key's job, made safe, or null for nothing. */
export function normaliseBinding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const job = jobOf(raw.do);
  if (!job || job.id === 'none') return null;
  if (job.needs === 'number') {
    const v = Number(raw.n);
    if (!Number.isInteger(v) || v < 1 || v > MAX_NUMBER) return null;
    return { do: job.id, n: v };
  }
  if (job.needs === 'destination') {
    const id = String(raw.id ?? '').toUpperCase();
    return DESTINATION.test(id) ? { do: job.id, id } : null;
  }
  return { do: job.id };
}

export function normaliseLayout(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  let count = 0;
  for (const [key, binding] of Object.entries(raw)) {
    if (!KEY_ID.test(key) || count >= MAX_KEYS) continue;
    const b = normaliseBinding(binding);
    if (b) { out[String(Number(key))] = b; count++; }
  }
  return out;
}

export function normaliseXkeys(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const layouts = {};
  const src = input.xkeysLayouts && typeof input.xkeysLayouts === 'object' ? input.xkeysLayouts : {};
  for (const [model, keys] of Object.entries(src)) {
    if (MODEL_ID.test(model)) layouts[model] = normaliseLayout(keys);
  }
  return { xkeysEnabled: input.xkeysEnabled === true, xkeysLayouts: layouts };
}

export const xkeysChanged = (a, b) => a.xkeysEnabled !== b.xkeysEnabled
  || JSON.stringify(a.xkeysLayouts) !== JSON.stringify(b.xkeysLayouts);

/* ---------------------------------------------------- a starting layout */

/**
 * A layout for a panel nobody has laid out: in reading order, TAKE on the
 * last key and CUT before it (FTB, freeze and program-to-preview before those
 * on a panel of a dozen keys or more); then, on whatever keys are left, the
 * first row puts inputs 1, 2, 3… in preview and, on a panel of eight keys or
 * more, the second recalls memories 1, 2, 3…, the third drives screens S1,
 * S2…, and the fourth selects layers 1, 2…. The program switch is left alone.
 */
export function suggestedLayout(product) {
  const keys = keysOf(product).filter((k) => k.index !== 0)
    .sort((a, b) => a.row - b.row || a.col - b.col);
  const out = {};
  const put = (k, b) => { if (k && !out[k.index]) out[k.index] = b; };
  const count = keys.length;
  if (!count) return out;
  put(keys[count - 1], { do: 'take' });
  if (count >= 2) put(keys[count - 2], { do: 'cut' });
  if (count >= 12) {
    put(keys[count - 3], { do: 'ftb' });
    put(keys[count - 4], { do: 'freeze' });
    put(keys[count - 5], { do: 'matchProgram' });
  }
  const rows = [...new Set(keys.map((k) => k.row))];
  const plan = count >= 8 ? ['input', 'recall', 'screen', 'layer'] : ['input'];
  rows.forEach((row, r) => {
    const job = plan[r];
    if (!job) return;
    let i = 1;
    for (const k of keys.filter((x) => x.row === row)) {
      if (out[k.index]) continue;
      put(k, job === 'screen' ? { do: 'screen', id: `S${i}` } : { do: job, n: i });
      i++;
    }
  });
  return out;
}

/** The layout a panel runs: the saved one for its model, or the suggestion. */
export function layoutFor(settings, product) {
  if (!product) return { keys: {}, suggested: false };
  const saved = settings?.xkeysLayouts?.[product.model];
  if (saved) return { keys: saved, suggested: false };
  return { keys: suggestedLayout(product), suggested: true };
}

/**
 * How far along each of the switcher's lists to read, so a key bound to
 * memory 40 or input 30 can be answered. Never less than the consoles'
 * usual, never more than the switcher has.
 */
export function limitsFor(layout) {
  const most = (job, floor, ceiling) => {
    let top = floor;
    for (const b of Object.values(layout || {})) if (b.do === job && b.n > top) top = b.n;
    return Math.min(top, ceiling);
  };
  return {
    screens: 24,
    inputs: most('input', 20, 128),
    stills: most('still', 20, 128),
    memories: most('recall', 20, 1000),
    layers: 16,
  };
}

/* ------------------------------------------------------- press → intent */

/**
 * What a press asks for: one of `console-intents.js`'s kinds — `source`,
 * `recall`, `take`, `cut`, `matchProgram`, `ftb`, `freeze`, `time`, `select`,
 * `unselect`, `selectLayer` — or `selectOnly`, or `none` with why.
 *
 * @param {object} binding   the key's job, `{do, n?, id?}`, or null
 * @param {object} ctx       `{ facts, selection, memoryLimit }`
 */
export function keyIntent(binding, { facts, selection, memoryLimit = 20 }) {
  if (!binding) return { kind: 'none', why: 'no job on this key — give it one on the card' };
  switch (binding.do) {
    case 'take':
    case 'cut':
    case 'matchProgram':
    case 'ftb':
    case 'freeze':
      return { kind: binding.do };
    case 'timeUp': return { kind: 'time', delta: 1 };
    case 'timeDown': return { kind: 'time', delta: -1 };
    case 'recall': {
      const memory = memoryAt(facts, binding.n, memoryLimit);
      if (!memory) return { kind: 'none', why: `no memory in slot ${binding.n}` };
      return { kind: 'recall', slot: binding.n, label: memory.label };
    }
    case 'input':
    case 'still':
    case 'screenSource': {
      const sourceKind = SOURCE_KIND[binding.do];
      const source = sourceAt(facts, sourceKind, binding.n);
      if (!source) return { kind: 'none', why: `${KIND_WORD[sourceKind]} ${binding.n} is not in use` };
      return { kind: 'source', input: binding.n, sourceKind, buffer: 'PREVIEW', label: source.label };
    }
    case 'screen':
    case 'screenAdd': {
      const d = destinationsOf(facts).find((x) => x.id === binding.id);
      if (!d) return { kind: 'none', why: `${binding.id} is not in service` };
      if (binding.do === 'screen') return { kind: 'selectOnly', destination: d.id };
      return selection.destinations.has(d.id)
        ? { kind: 'unselect', destination: d.id }
        : { kind: 'select', destination: d.id };
    }
    case 'layer': {
      const active = activeOf(selection);
      if (!active) return { kind: 'none', why: 'select a screen first' };
      if (!layersOf(facts, active).includes(binding.n)) return { kind: 'none', why: `${active} has no layer ${binding.n}` };
      return { kind: 'selectLayer', layer: binding.n };
    }
    case 'layerNext':
    case 'layerPrev': {
      const active = activeOf(selection);
      if (!active) return { kind: 'none', why: 'select a screen first' };
      const layer = stepLayer(layersOf(facts, active), selection.layer, binding.do === 'layerNext' ? 'next' : 'prev');
      if (!layer) return { kind: 'none', why: `${active} has no layers` };
      return { kind: 'selectLayer', layer };
    }
    default:
      return { kind: 'none', why: 'no job on this key — give it one on the card' };
  }
}

/* ------------------------------------------------------- the panel drawn */

const lamp = (colour, flash = false) => ({ colour, flash });
const DARK = lamp(RGB.OFF);

/**
 * What each meaning looks like on this panel. Two colours cannot say
 * "available" as well as "chosen" and "preview", so on those it is dark.
 */
export function paletteFor(product) {
  switch (lampsOf(product)) {
    case 'rgb':
      return {
        program: lamp(RGB.RED), preview: lamp(RGB.GREEN), chosen: lamp(RGB.YELLOW),
        available: lamp(RGB.BLUE), active: lamp(RGB.RED), faded: lamp(RGB.RED, true), held: lamp(RGB.WHITE),
      };
    case 'two':
      return {
        program: lamp(RGB.RED), preview: lamp(RGB.BLUE), chosen: lamp(RGB.BLUE),
        available: DARK, active: lamp(RGB.RED), faded: lamp(RGB.RED, true), held: lamp(RGB.PURPLE),
      };
    case 'blue':
      return {
        program: lamp(RGB.BLUE), preview: lamp(RGB.BLUE, true), chosen: lamp(RGB.BLUE),
        available: DARK, active: lamp(RGB.BLUE, true), faded: lamp(RGB.BLUE, true), held: lamp(RGB.BLUE),
      };
    default:
      return null;
  }
}

/**
 * Every key's lamp, `Map(index → {colour, flash})`, for the layout, the
 * facts, the selection and the tally as they stand. Empty for a panel with
 * no backlights. The supervisor sends what differs from the last it sent.
 *
 * @param {object} o
 * @param {object} o.tally   `ConsoleSwitcher.tallyFor` for the active screen: `{layer, program, preview}`, or null
 * @param {Set<number>} o.held   keys held now
 * @param {number|null} o.stroke  how far a T-bar stroke has gone, 0..1, or null between strokes
 */
export function paint({ product, layout, facts, selection, tally = null, held = new Set(), stroke = null, memoryLimit = 20 }) {
  const out = new Map();
  const palette = paletteFor(product);
  if (!palette) return out;
  const dests = destinationsOf(facts);
  const selected = dests.filter((d) => selection.destinations.has(d.id));
  const active = activeOf(selection);
  const layers = layersOf(facts, active);

  for (const { index } of keysOf(product)) {
    if (index === 0) continue;
    const b = layout[index];
    let l = DARK;
    if (b) {
      switch (b.do) {
        case 'input':
        case 'still':
        case 'screenSource': {
          const kind = SOURCE_KIND[b.do];
          const on = (src) => src && src.kind === kind && src.number === b.n;
          if (tally && tally.layer === selection.layer && on(tally.program)) l = palette.program;
          else if (tally && tally.layer === selection.layer && on(tally.preview)) l = palette.preview;
          else if (sourceAt(facts, kind, b.n)) l = palette.available;
          break;
        }
        case 'recall':
          if (memoryAt(facts, b.n, memoryLimit)) l = palette.available;
          break;
        case 'screen':
        case 'screenAdd':
          if (selection.destinations.has(b.id)) l = palette.chosen;
          else if (dests.some((d) => d.id === b.id)) l = palette.available;
          break;
        case 'layer':
          if (layers.includes(b.n)) l = b.n === selection.layer ? palette.chosen : palette.available;
          break;
        case 'layerNext':
        case 'layerPrev':
          if (layers.length > 1) l = palette.available;
          break;
        case 'take':
          l = stroke !== null ? palette.active : palette.available;
          break;
        case 'ftb':
          l = selected.some((d) => d.faded) ? palette.faded : palette.available;
          break;
        case 'freeze':
          l = selected.some((d) => d.frozen) ? palette.active : palette.available;
          break;
        default:
          l = palette.available;
      }
    }
    if (held.has(index)) l = palette.held;
    out.set(index, l);
  }
  return out;
}

/** A lamp as one comparable word, for telling what changed. */
export const lampWord = (l) => `${l.colour.r},${l.colour.g},${l.colour.b}${l.flash ? '*' : ''}`;
