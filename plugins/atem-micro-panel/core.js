/*
 * An ATEM Micro Panel, as a LivePremier surface.  ** PREVIEW **
 *
 * ## A switcher's face, so this supplies the switcher
 *
 * The panel does nothing by itself: ATEM Software Control reads its keys and
 * lights them (`src/core/atem-micro-panel.js`). Here this plugin stands where
 * ATEM Software Control does, and the switcher behind it is a LivePremier. So
 * the meaning is an ATEM operator's habits — buses, M/E, CUT, AUTO, the
 * T-bar, SHIFT for the second ten — mapped onto what a LivePremier has:
 *
 * ```text
 *   M/E 1–4 (SHIFT 5–8)          screens in service, in order; a press makes that screen the one
 *                                the panel drives; with another M/E key held, it is added or taken out
 *   BKGD, KEY 1–4 (SHIFT 6–10)   the active screen's fitted layers, in order; a press selects one
 *   PREVIEW 1–10 (SHIFT 11–20)   input n (still n, screen n) onto the selected layer, in PREVIEW,
 *                                on every selected screen
 *   PROGRAM 1–10 (SHIFT 11–20)   tally only — unless "Program row cuts to air" is ticked, when
 *                                the same, in PROGRAM: on air at once, with no take
 *   KEY 1 / 2 / 3 ON AIR         what the buses hold: inputs, stills, screens
 *   MACRO                        a latch: PREVIEW n recalls memory n to preview
 *   CUT / AUTO / T-bar           cut / take / take by hand, on the selection
 *   DSK 1 CUT                    freeze what is on air, or unfreeze
 *   DSK 1 AUTO                   program to preview (MATCH)
 *   DSK 2 AUTO                   fade to black, or back up
 * ```
 *
 * Lamps: what a key may act on is blue and what is chosen yellow (M/E,
 * layers, the bus kind, MACRO, SHIFT); on the buses red is on air and green
 * in preview on the selected layer of the active screen; CUT, AUTO and the
 * DSK keys with a job are white, and red while what they switch is on (AUTO
 * during a T-bar stroke, freeze while frozen, FTB while faded). A held key
 * shows cyan, so the press is seen landing.
 *
 * What a press then WRITES is `src/core/console-intents.js` — the function
 * the Pixelhue and Barco EC panels' presses go through — so a take is one
 * thing whichever panel asked for it.
 *
 * ## No I/O
 *
 * The supervisor reads the switcher and moves bytes; this decides. The tests
 * drive it directly.
 */

import { KEYS, COLOUR, meterFor } from '../../src/core/atem-micro-panel.js';

/* ------------------------------------------------------------- settings */

/**
 * Off, as every console here starts: a preview that has never met a panel,
 * and it writes to a switcher with no browser open. The one other choice — the
 * program row cutting to air — is not a setting at all: it is a tick on the
 * card that lasts until the panel is switched off or the app restarts
 * (`AtemMicroPanelSupervisor.setHotCut`), so nobody inherits it from last
 * week's show.
 */
export const DEFAULT_ATEM_MICRO = Object.freeze({ atemMicroEnabled: false });

export function normaliseAtemMicro(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return { atemMicroEnabled: input.atemMicroEnabled === true };
}

export const atemMicroChanged = (a, b) => a.atemMicroEnabled !== b.atemMicroEnabled;

/* ------------------------------------------------------------- the keys */

export const BUS_KEYS = 10;
export const ME_KEYS = 4;
export const LAYER_KEYS = 5;

const range = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
export const PGM = range('PGM_', BUS_KEYS);
export const PVW = range('PVW_', BUS_KEYS);
export const ME = range('ME_', ME_KEYS);
export const LAYER = ['NEXT_BKGD', 'NEXT_KEY1', 'NEXT_KEY2', 'NEXT_KEY3', 'NEXT_KEY4'];

/** What the buses can hold, by the ON AIR key that picks it. `sourceKind` is `writesFor`'s spelling. */
export const BUS_KINDS = Object.freeze([
  { key: 'KEY1_ON_AIR', sourceKind: 'LIVE', label: 'Inputs' },
  { key: 'KEY2_ON_AIR', sourceKind: 'STILL', label: 'Stills' },
  { key: 'KEY3_ON_AIR', sourceKind: 'SCREEN', label: 'Screens' },
]);
const BUS_KIND_BY_KEY = new Map(BUS_KINDS.map((b) => [b.key, b]));

/* Keys with a job of their own. */
const FUNCTION = Object.freeze({
  CUT: { kind: 'cut' },
  AUTO: { kind: 'take' },
  DSK1_CUT: { kind: 'freeze' },
  DSK1_AUTO: { kind: 'matchProgram' },
  DSK2_AUTO: { kind: 'ftb' },
  MACRO: { kind: 'macro' },
  SHIFT: { kind: 'shift' },
});

/**
 * Keys this does nothing with yet, and why — said in the history when one is
 * pressed, so an operator is not left wondering.
 */
export const UNMAPPED = Object.freeze({
  KEY4_ON_AIR: 'the fourth ON AIR key has no job yet; KEY 1–3 ON AIR pick inputs, stills or screens',
  MIX: 'a LivePremier screen has one transition, set on the switcher; the style keys are not mapped',
  DIP: 'a LivePremier screen has one transition, set on the switcher; the style keys are not mapped',
  WIPE: 'a LivePremier screen has one transition, set on the switcher; the style keys are not mapped',
  DVE: 'a LivePremier screen has one transition, set on the switcher; the style keys are not mapped',
  STING: 'a LivePremier screen has one transition, set on the switcher; the style keys are not mapped',
  ARM: 'arming belongs to transition styles, which are not mapped',
  PREV_TRANS: 'a LivePremier has no transition preview to send',
  DSK1_TIE: 'the DSK TIE keys are not mapped',
  DSK2_TIE: 'the DSK TIE keys are not mapped',
  DSK2_CUT: 'DSK 2 CUT is not mapped; DSK 2 AUTO fades to black',
});

/* ------------------------------------------------------------- the view */

/**
 * The panel's own state, which is not the switcher's: SHIFT and the M/E keys
 * held, the MACRO latch, what the buses hold, and every key held (by name).
 */
export function initialView() {
  return { shift: false, macro: false, busKind: 'LIVE', held: new Set() };
}

/** The screens the M/E keys walk through: those in service, in order. */
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

/** Source n of a kind, if the switcher has it: key n is input n, as on an ATEM. */
export function sourceAt(facts, kind, number) {
  return ((facts && facts.sources && facts.sources[kind]) || []).find((s) => s.number === number) || null;
}

/**
 * Whether a memory slot holds something. A labelled slot does; an unlabelled
 * one does unless the switcher said it is free — the simulator's slot 1 holds a
 * memory with no name (`server/console-switcher.js`).
 */
export function memoryAt(facts, slot, limit) {
  const named = ((facts && facts.presets) || []).find((p) => p.slot === slot);
  if (named) return { slot, label: named.label };
  if (slot > limit || ((facts && facts.freeSlots) || []).includes(slot)) return null;
  return facts ? { slot, label: '' } : null;
}

const bank = (view, size) => (view.shift ? size : 0);

/* ------------------------------------------------------- press → intent */

/**
 * What a key press asks for. The answer is one of `console-intents.js`'s
 * kinds — `select`, `unselect`, `selectLayer`, `source`, `recall`, `take`,
 * `cut`, `matchProgram`, `freeze`, `ftb` — or this panel's own: `selectOnly`,
 * `busKind`, `macro`, `shift`, `none`.
 *
 * @param {string} name     the key, by `KEYS`' name
 * @param {object} ctx      `{ view, facts, selection, hotCut, memoryLimit }`
 */
export function keyIntent(name, { view, facts, selection, hotCut = false, memoryLimit = 20 }) {
  if (UNMAPPED[name]) return { kind: 'none', key: name, why: UNMAPPED[name] };
  if (FUNCTION[name]) return { ...FUNCTION[name], key: name };

  const busKind = BUS_KIND_BY_KEY.get(name);
  if (busKind) {
    if (!sourcesOf(facts, busKind.sourceKind).length) {
      return { kind: 'none', key: name, why: `this switcher has no ${busKind.label.toLowerCase()} to put on the buses` };
    }
    return { kind: 'busKind', sourceKind: busKind.sourceKind, key: name };
  }

  let at = ME.indexOf(name);
  if (at >= 0) {
    const d = destinationsOf(facts)[at + bank(view, ME_KEYS)];
    if (!d) return { kind: 'none', key: name, why: 'no screen on that key' };
    /* Another M/E key held: build a selection of several screens. */
    const others = ME.some((m) => m !== name && view.held.has(m));
    if (!others) return { kind: 'selectOnly', destination: d.id, key: name };
    return selection.destinations.has(d.id)
      ? { kind: 'unselect', destination: d.id, key: name }
      : { kind: 'select', destination: d.id, key: name };
  }

  at = LAYER.indexOf(name);
  if (at >= 0) {
    const active = activeOf(selection);
    const layer = layersOf(facts, active)[at + bank(view, LAYER_KEYS)];
    if (!layer) return { kind: 'none', key: name, why: active ? 'no layer on that key' : 'select a screen first' };
    return { kind: 'selectLayer', layer, key: name };
  }

  const pvw = PVW.indexOf(name);
  const pgm = PGM.indexOf(name);
  if (pvw < 0 && pgm < 0) return { kind: 'none', key: name, why: 'no meaning yet' };
  const n = (pvw >= 0 ? pvw : pgm) + 1 + bank(view, BUS_KEYS);

  if (view.macro) {
    if (pgm >= 0) return { kind: 'none', key: name, why: 'MACRO is on: the preview row recalls memories, the program row does nothing' };
    const memory = memoryAt(facts, n, memoryLimit);
    if (!memory) return { kind: 'none', key: name, why: `no memory in slot ${n}` };
    return { kind: 'recall', slot: n, label: memory.label, key: name };
  }

  const source = sourceAt(facts, view.busKind, n);
  if (!source) return { kind: 'none', key: name, why: `${kindWord(view.busKind)} ${n} is not in use` };
  if (pgm >= 0 && !hotCut) {
    return { kind: 'none', key: name, why: 'the program row is tally only — tick “Program row cuts to air” on the card to switch from it' };
  }
  return {
    kind: 'source',
    input: n,
    sourceKind: view.busKind,
    buffer: pgm >= 0 ? 'PROGRAM' : 'PREVIEW',
    label: source.label,
    key: name,
  };
}

function sourcesOf(facts, kind) {
  return (facts && facts.sources && facts.sources[kind]) || [];
}

const kindWord = (kind) => ({ LIVE: 'input', STILL: 'still', SCREEN: 'screen' }[kind] || 'source');

/**
 * Make one screen the selection, as an M/E key does on an ATEM: the others
 * go, this one stays or arrives. Applied through `Selection` so its rules
 * (only what was published) hold.
 */
export function selectOnly(selection, destination) {
  for (const id of selection.list) {
    if (id !== destination) selection.apply({ kind: 'unselect', destination: id });
  }
  selection.apply({ kind: 'select', destination });
  return selection;
}

/* ------------------------------------------------------- the panel drawn */

/**
 * Every key's colour and the T-bar's meter, for the facts, the selection, the
 * tally and the view as they stand: `{ colours: Map(name → COLOUR), meter }`.
 * The supervisor sends the report when it differs from the last.
 *
 * @param {object} o
 * @param {object} o.tally   `ConsoleSwitcher.tallyFor` for the active screen: `{layer, program, preview}`, or null
 * @param {number|null} o.stroke  how far a T-bar stroke has gone, 0..1, or null between strokes
 */
export function paint({ view, facts, selection, tally = null, stroke = null, memoryLimit = 20 }) {
  const colours = new Map(KEYS.map((key) => [key.name, COLOUR.OFF]));

  const dests = destinationsOf(facts);
  ME.forEach((name, i) => {
    const d = dests[i + bank(view, ME_KEYS)];
    if (d) colours.set(name, selection.destinations.has(d.id) ? COLOUR.YELLOW : COLOUR.BLUE);
  });

  const active = activeOf(selection);
  const layers = layersOf(facts, active);
  LAYER.forEach((name, i) => {
    const key = layers[i + bank(view, LAYER_KEYS)];
    if (key !== undefined) colours.set(name, key === selection.layer ? COLOUR.YELLOW : COLOUR.BLUE);
  });

  for (const b of BUS_KINDS) {
    if (!sourcesOf(facts, b.sourceKind).length) continue;
    colours.set(b.key, !view.macro && view.busKind === b.sourceKind ? COLOUR.YELLOW : COLOUR.BLUE);
  }
  colours.set('MACRO', view.macro ? COLOUR.YELLOW : COLOUR.BLUE);
  colours.set('SHIFT', view.shift ? COLOUR.YELLOW : COLOUR.BLUE);

  const offset = bank(view, BUS_KEYS);
  if (view.macro) {
    PVW.forEach((name, i) => { if (memoryAt(facts, i + 1 + offset, memoryLimit)) colours.set(name, COLOUR.BLUE); });
  } else if (tally && tally.layer === selection.layer) {
    const lit = (src, row, colour) => {
      if (!src || src.kind !== view.busKind) return;
      const i = src.number - 1 - offset;
      if (i >= 0 && i < BUS_KEYS) colours.set(row[i], colour);
    };
    lit(tally.program, PGM, COLOUR.RED);
    lit(tally.preview, PVW, COLOUR.GREEN);
  }

  const selected = dests.filter((d) => selection.destinations.has(d.id));
  colours.set('CUT', COLOUR.WHITE);
  colours.set('AUTO', stroke !== null ? COLOUR.RED : COLOUR.WHITE);
  colours.set('DSK1_CUT', selected.some((d) => d.frozen) ? COLOUR.RED : COLOUR.WHITE);
  colours.set('DSK1_AUTO', COLOUR.WHITE);
  colours.set('DSK2_AUTO', selected.some((d) => d.faded) ? COLOUR.RED : COLOUR.WHITE);

  /* SHIFT is held for as long as it means anything; its yellow says so. */
  for (const name of view.held) if (colours.has(name) && name !== 'SHIFT') colours.set(name, COLOUR.CYAN);

  return { colours, meter: meterFor(stroke ?? 0) };
}
