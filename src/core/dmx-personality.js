/*
 * A lighting desk's view of the switcher: fixtures, a patch, and what their
 * channels mean — no I/O.
 *
 * A desk drives a media server as one fixture per layer plus a fixture or two
 * for the whole box, and this copies that so a lighting programmer finds
 * nothing strange in it:
 *
 *   Master  one per switcher   master memory, take all, cut all
 *   Screen  one per screen     control mode, memory, take, cut
 *   Layer   one per layer      source folder, source file, opacity
 *
 * Each fixture type has modes — Cue now; Compact, Standard and Full (layer
 * geometry, crop, colour, borders) will join it — and this file is the one
 * definition the engine below, the patch, and the GDTF files a desk imports
 * (`core/desk-gdtf.js`) are all read from, so the three cannot disagree.
 *
 * ## The rules a show depends on
 *
 * - **A screen ignores the desk until its Control channel says otherwise.**
 *   0–63 is Off, 64–127 edits preview, 128–255 edits program. A desk that
 *   has just been patched, sitting at zero, changes nothing at all. Raising
 *   Control is the desk taking that screen over, and the layer levels the desk
 *   holds are written at that moment.
 * - **Nothing fires on the first frame.** The first frame from a desk — after
 *   this app starts, after the desk restarts, after a backup desk takes over —
 *   only sets where every channel is. A desk sitting with Take at full when
 *   the app restarts must not take. Triggers fire on a rising crossing of 50%
 *   seen after that; a memory channel recalls on a change to a non-zero value.
 * - **A memory recall goes to preview, always**, as every other recall in this
 *   app does. Reaching air costs a Take.
 * - **Folder 0 is "hold".** A desk at zero never blanks a layer's source.
 *
 * What a source or a level becomes on the wire, and which preset letter it
 * goes to, is the supervisor's business: this only says what the desk asked.
 */

/* -------------------------------------------------------------- channels */

/** Control mode on a Screen or the Master fixture. */
export const CONTROL = Object.freeze({ OFF: 'off', PREVIEW: 'preview', PROGRAM: 'program' });
export const controlOf = (v) => (v >= 128 ? CONTROL.PROGRAM : v >= 64 ? CONTROL.PREVIEW : CONTROL.OFF);

/** A trigger channel is "pressed" at 50% and above. */
export const TRIGGER_AT = 128;

/**
 * Source folders, by DMX value. The order follows the switcher's own source
 * list; 0 and anything past the end hold whatever source the layer has.
 */
export const FOLDERS = Object.freeze([
  { value: 0, kind: null, name: 'Hold' },
  { value: 1, kind: 'LIVE', name: 'Live inputs', numbered: true },
  { value: 2, kind: 'STILL', name: 'Stills', numbered: true },
  { value: 3, kind: 'SCREEN', name: 'Screens', numbered: true },
  { value: 4, kind: 'NATIVE', name: 'Backgrounds', numbered: true },
  { value: 5, kind: 'COLOR', name: 'Colour', numbered: false },
  { value: 6, kind: 'NONE', name: 'None (black)', numbered: false },
]);

const CH = {
  control: {
    attr: 'control', name: 'Control', role: 'control',
    sets: [
      { from: 0, to: 63, name: 'Off' },
      { from: 64, to: 127, name: 'Preview' },
      { from: 128, to: 255, name: 'Program' },
    ],
  },
  memory: { attr: 'memory', name: 'Memory', role: 'step', sets: [{ from: 0, to: 0, name: 'None' }, { from: 1, to: 255, name: 'Memory 1-255' }] },
  take: { attr: 'take', name: 'Take', role: 'trigger', sets: [{ from: 0, to: 127, name: 'Idle' }, { from: 128, to: 255, name: 'Take' }] },
  cut: { attr: 'cut', name: 'Cut', role: 'trigger', sets: [{ from: 0, to: 127, name: 'Idle' }, { from: 128, to: 255, name: 'Cut' }] },
  folder: {
    attr: 'folder', name: 'Source folder', role: 'step',
    sets: [...FOLDERS.map((f) => ({ from: f.value, to: f.value, name: f.name })), { from: FOLDERS.length, to: 255, name: 'Hold' }],
  },
  file: { attr: 'file', name: 'Source file', role: 'step', sets: [{ from: 0, to: 0, name: 'Hold' }, { from: 1, to: 255, name: 'Number 1-255' }] },
  opacity: { attr: 'opacity', name: 'Opacity', role: 'dimmer', sets: [{ from: 0, to: 255, name: 'Opacity 0-100%' }] },
};

/**
 * The fixture types and their modes. A mode is its channels in order, each
 * 8 bits wide for now (a 16-bit channel will say `bits: 16`).
 */
export const FIXTURES = Object.freeze({
  master: {
    kind: 'master', name: 'LPP Master', short: 'LPPMaster',
    description: 'LivePremier Plus: the whole switcher — master memory, take all, cut all.',
    guid: '83AD3503-A0F3-474D-AD92-5943E00AD40E',
    modes: { cue: [CH.control, CH.memory, CH.take, CH.cut] },
  },
  screen: {
    kind: 'screen', name: 'LPP Screen', short: 'LPPScreen',
    description: 'LivePremier Plus: one screen or aux — control mode, memory recall to preview, take, cut.',
    guid: '01C5BB6C-193C-4BE8-9F77-B2AE9DECC7CD',
    modes: { cue: [CH.control, CH.memory, CH.take, CH.cut] },
  },
  layer: {
    kind: 'layer', name: 'LPP Layer', short: 'LPPLayer',
    description: 'LivePremier Plus: one layer of a screen — source folder and file, and opacity.',
    guid: '7C425188-06C6-4A6B-A928-3A5A9691D485',
    modes: { cue: [CH.folder, CH.file, CH.opacity] },
  },
});

export const MODES = Object.freeze([
  { id: 'cue', label: 'Cue', what: 'Layers carry source and opacity; the memories hold the geometry. One universe covers most rigs.' },
]);

export const footprint = (kind, mode = 'cue') => FIXTURES[kind].modes[mode].reduce((n, c) => n + (c.bits === 16 ? 2 : 1), 0);

/* ----------------------------------------------------------------- patch */

/**
 * Where every fixture sits: the Master (if wanted), then each destination's
 * Screen fixture followed by its layers, packed into universes in order. No
 * fixture is split across two universes, and no destination is either while
 * it fits in one: a cue that changes a layer and takes the screen then
 * arrives in one packet, so the take cannot overtake the layer. The same settings always give the same patch — the
 * switcher's own preconfig does not move it — because a desk's patch must not
 * shift under a show when somebody changes a screen's layer count.
 *
 * @param {object} o
 * @param {string[]} o.destinations   'S1', 'S2', 'A1'…, in the order wanted
 * @param {number} o.layers           layer fixtures per destination
 * @param {number} o.firstUniverse    1-based, as a desk numbers them
 * @param {number} [o.firstAddress]   1-based
 * @param {boolean} [o.master]
 * @param {string} [o.mode]
 * @param {(id:string)=>string} [o.labelOf]  a destination's name, for the fixture names
 */
export function layout({ destinations, layers, firstUniverse, firstAddress = 1, master = true, mode = 'cue', labelOf = () => '' }) {
  const fixtures = [];
  let universe = firstUniverse;
  let address = firstAddress;
  const place = (fixture) => {
    const size = footprint(fixture.kind, mode);
    if (address + size - 1 > 512) { universe++; address = 1; }
    fixtures.push({ ...fixture, mode, universe, address, footprint: size });
    address += size;
  };
  if (master) place({ id: 'master', kind: 'master', destination: null, layer: null, name: 'LPP Master' });
  const block = footprint('screen', mode) + layers * footprint('layer', mode);
  for (const id of destinations) {
    if (block <= 512 && address + block - 1 > 512) { universe++; address = 1; }
    const label = labelOf(id);
    const base = label ? `${id} ${label}` : id;
    place({ id, kind: 'screen', destination: id, layer: null, name: base });
    for (let n = 1; n <= layers; n++) {
      place({ id: `${id}.L${n}`, kind: 'layer', destination: id, layer: n, name: `${id} L${n}` });
    }
  }
  const universes = [...new Set(fixtures.map((f) => f.universe))];
  return { fixtures, universes };
}

/** The patch as CSV, for a desk's patch import or a printout. */
export function patchCsv(fixtures) {
  const rows = [['Name', 'Fixture type', 'Mode', 'Universe', 'Address', 'Channels']];
  for (const f of fixtures) {
    rows.push([f.name, FIXTURES[f.kind].name, modeLabel(f.mode), String(f.universe), String(f.address), String(f.footprint)]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const modeLabel = (id) => (MODES.find((m) => m.id === id) || { label: id }).label;
const csvCell = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/* ---------------------------------------------------------------- values */

/** What one fixture's channels say, read out of its universe's 512 slots. */
export function readFixture(fixture, frame) {
  const channels = FIXTURES[fixture.kind].modes[fixture.mode];
  const out = {};
  let at = fixture.address - 1;
  for (const c of channels) {
    out[c.attr] = c.bits === 16 ? (frame[at] << 8) | frame[at + 1] : frame[at];
    at += c.bits === 16 ? 2 : 1;
  }
  return out;
}

/** A Layer fixture's source, as `{kind, number}`, or null for hold. */
export function sourceOf(values) {
  const folder = FOLDERS[values.folder];
  if (!folder || !folder.kind) return null;
  if (!folder.numbered) return { kind: folder.kind, number: null };
  if (!values.file) return null;
  return { kind: folder.kind, number: values.file };
}

/** 0–255 on the desk is 0–256 on the switcher, whose full is 256. */
export const opacityOf = (v) => Math.round((v * 256) / 255);

/**
 * A source as the switcher spells it, or null where this platform has no such
 * source. LivePremier: LIVE_3, STILL_12, SCREEN_2, NATIVE_1, COLOR, NONE. A
 * Midra 4K or Alta 4K: INPUT_3 for a live input, and nothing else here yet.
 */
export function sourceValue(dialectId, source) {
  if (!source) return null;
  if (dialectId === 'mng') return source.kind === 'LIVE' && source.number ? `INPUT_${source.number}` : null;
  if (!source.number) return source.kind === 'COLOR' || source.kind === 'NONE' ? source.kind : null;
  return `${source.kind}_${source.number}`;
}

/* ---------------------------------------------------------------- engine */

/**
 * Turns frames into what the desk asked for. Holds each fixture's last
 * values and each destination's control mode; knows nothing of the switcher.
 *
 * `update(universe, frame, { fresh })` returns actions, in the order they
 * must happen — control first, then recalls, then layer values, then takes
 * and cuts. A cue that recalls a memory, sets a layer and takes, all in one
 * frame, means exactly that order: the take carries the layer with it.
 *
 *   { type: 'engage', destination, buffer }      'preview' | 'program'
 *   { type: 'release', destination }
 *   { type: 'recall', destination, slot }        to preview
 *   { type: 'take' | 'cut', destination }
 *   { type: 'recallMaster', slot }               to preview
 *   { type: 'takeAll' | 'cutAll' }               every engaged destination
 *   { type: 'layer', destination, layer, param, value }   'source' {kind, number} | 'opacity' 0–256
 */
export class DeskEngine {
  #fixtures = [];
  #byUniverse = new Map();
  #last = new Map();          /* fixture id → values, or absent before its first frame */
  #control = new Map();       /* destination (or 'master') → CONTROL */

  constructor(fixtures = []) { this.repatch(fixtures); }

  /** A new patch. Every fixture starts again from its next frame. */
  repatch(fixtures) {
    this.#fixtures = fixtures;
    this.#byUniverse = new Map();
    for (const f of fixtures) {
      const list = this.#byUniverse.get(f.universe) || [];
      this.#byUniverse.set(f.universe, list);
      list.push(f);
    }
    this.#last.clear();
    this.#control.clear();
  }

  /** The control mode each destination is in, as the desk last said. */
  control(id) { return this.#control.get(id) || CONTROL.OFF; }

  engaged() {
    return [...this.#control.entries()].filter(([id, c]) => id !== 'master' && c !== CONTROL.OFF).map(([id, c]) => ({ id, buffer: c }));
  }

  /**
   * Forget a universe's last frame, so its next one is a baseline again: the
   * source in control went quiet or changed. The control modes it held stay —
   * a lost desk must not let go of a screen (nothing is written meanwhile).
   */
  forget(universe) {
    for (const f of this.#byUniverse.get(universe) || []) this.#last.delete(f.id);
  }

  update(universe, frame, { fresh = false } = {}) {
    const fixtures = this.#byUniverse.get(universe);
    if (!fixtures || !frame) return [];
    if (fresh) this.forget(universe);
    const now = new Map(fixtures.map((f) => [f.id, readFixture(f, frame)]));
    /* undefined before a fixture's first frame: that frame is its baseline. */
    const before = new Map(fixtures.map((f) => [f.id, this.#last.get(f.id)]));
    for (const [id, v] of now) this.#last.set(id, v);
    const keyOf = (f) => (f.kind === 'master' ? 'master' : f.destination);

    const control = [];
    const recalls = [];
    const fires = [];
    const layers = [];
    const engagedNow = new Set();

    /* Control modes first, so the rest of this frame is judged by the mode
       the same frame sets. */
    for (const f of fixtures) {
      if (f.kind === 'layer') continue;
      const mode = controlOf(now.get(f.id).control);
      const prev = before.get(f.id);
      if (!prev) { this.#control.set(keyOf(f), mode); continue; }
      if (controlOf(prev.control) === mode) continue;
      this.#control.set(keyOf(f), mode);
      if (f.kind !== 'screen') continue;
      if (mode === CONTROL.OFF) {
        control.push({ type: 'release', destination: f.destination });
      } else {
        control.push({ type: 'engage', destination: f.destination, buffer: mode });
        engagedNow.add(f.destination);
      }
    }

    for (const f of fixtures) {
      if (f.kind === 'layer') continue;
      const v = now.get(f.id);
      const prev = before.get(f.id);
      if (!prev || this.control(keyOf(f)) === CONTROL.OFF) continue;
      const rose = (attr) => prev[attr] < TRIGGER_AT && v[attr] >= TRIGGER_AT;
      if (v.memory !== prev.memory && v.memory > 0) {
        recalls.push(f.kind === 'master'
          ? { type: 'recallMaster', slot: v.memory }
          : { type: 'recall', destination: f.destination, slot: v.memory });
      }
      if (rose('take')) fires.push(f.kind === 'master' ? { type: 'takeAll' } : { type: 'take', destination: f.destination });
      if (rose('cut')) fires.push(f.kind === 'master' ? { type: 'cutAll' } : { type: 'cut', destination: f.destination });
    }

    /* A change to a layer of an engaged destination is written. */
    for (const f of fixtures) {
      if (f.kind !== 'layer' || engagedNow.has(f.destination)) continue;
      if (this.control(f.destination) === CONTROL.OFF) continue;
      const v = now.get(f.id);
      const prev = before.get(f.id);
      if (!prev) continue;
      const src = sourceOf(v);
      if (src && !sameSource(src, sourceOf(prev))) layers.push(layerAction(f, 'source', src));
      if (v.opacity !== prev.opacity) layers.push(layerAction(f, 'opacity', opacityOf(v.opacity)));
    }

    /* A destination taken over in this frame gets everything its layers
       hold. */
    for (const id of engagedNow) layers.push(...this.layersFor(id));
    return [...control, ...recalls, ...layers, ...fires];
  }

  /**
   * Everything the desk holds for one destination's layers, wherever they are
   * patched — as far as their universes have been heard from. Written when
   * the desk takes a screen over, and again whenever something else replaces
   * the buffer it edits (a recall into preview, a take): the desk owns source
   * and opacity, and the memory owns the rest. A layer at folder 0 (hold)
   * keeps whatever source the memory gave it.
   */
  layersFor(destination) {
    const out = [];
    for (const f of this.#fixtures) {
      if (f.kind !== 'layer' || f.destination !== destination) continue;
      const v = this.#last.get(f.id);
      if (!v) continue;
      const src = sourceOf(v);
      if (src) out.push(layerAction(f, 'source', src));
      out.push(layerAction(f, 'opacity', opacityOf(v.opacity)));
    }
    return out;
  }
}

const layerAction = (f, param, value) => ({ type: 'layer', destination: f.destination, layer: f.layer, param, value });

function sameSource(a, b) {
  if (!a || !b) return false;
  return a.kind === b.kind && a.number === b.number;
}
