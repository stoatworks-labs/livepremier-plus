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
 *   Layer   one per layer      source, opacity, and as much of the look as
 *                              the mode carries
 *
 * Every fixture type has the same four modes, so a desk patches everything in
 * one of them. Master and Screen are the same in all four; a Layer is
 *
 *   Cue       3 ch   source folder and file, opacity
 *   Compact  11 ch   + position X, Y and size W, H (16-bit)
 *   Standard 24 ch   + crop, colour (for the Colour folder), flip, strobe
 *   Full     53 ch   + mask, aspect, effect, border, shadow, key
 *
 * This file is the one definition the engine below, the patch, and the GDTF
 * files a desk imports (`core/desk-gdtf.js`) are all read from, so the three
 * cannot disagree.
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
 * - **Size 0 is the memory's look.** While W or H is at zero, everything past
 *   source, opacity and colour — position, size, crop, effects, border,
 *   shadow, key — is the memory's, and the desk writes none of it. A desk
 *   sitting at zero edits nothing a memory set up; the memory's look comes
 *   back with the next recall or take.
 * - **X and Y are pixels from the centre of the screen**, 32768 being the
 *   centre, so a layer at the defaults sits in the middle at whatever size W
 *   and H give it. W and H are pixels.
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

/** 16-bit X and Y: this value is the centre of the screen. */
export const CENTRE = 32768;

/* Step channels: each name owns `width` values, the last to the top. */
const steps = (names, width) => names.map((name, i) => ({
  from: i * width, to: i === names.length - 1 ? 255 : (i + 1) * width - 1, name,
}));

/** Flip, 64 values a step. */
export const FLIPS = Object.freeze([
  { name: 'None', h: false, v: false },
  { name: 'Flip H', h: true, v: false },
  { name: 'Flip V', h: false, v: true },
  { name: 'Flip H+V', h: true, v: true },
]);

/** Effect, 32 values a step; past the last is None again. */
export const EFFECTS = Object.freeze([
  { name: 'None', flag: null },
  { name: 'Black and white', flag: 'BLACK_N_WHITE' },
  { name: 'Negative', flag: 'NEGATIVE' },
  { name: 'Sepia', flag: 'SEPIA' },
  { name: 'Solarise', flag: 'SOLAR' },
  { name: 'Posterise', flag: 'POSTERIZE' },
]);

/** Aspect override, 51 values a step, as the LivePremier spells them. */
export const ASPECTS = Object.freeze([
  { name: 'None', value: 'NONE' },
  { name: '1:1', value: '1_1' },
  { name: 'Centred', value: 'CENTERED' },
  { name: 'Full screen', value: 'FULLSCREEN' },
  { name: 'Cropped', value: 'CROPPED' },
]);

/** Border and shadow style, a set of three flags: every combination, 32 values each. */
export const STYLES = Object.freeze([[], ['EDGE'], ['SMOOTH'], ['ROUNDED'], ['EDGE', 'SMOOTH'], ['EDGE', 'ROUNDED'],
  ['SMOOTH', 'ROUNDED'], ['EDGE', 'SMOOTH', 'ROUNDED']]);
const styleName = (flags) => (flags.length ? flags.map((f) => f[0] + f.slice(1).toLowerCase()).join('+') : 'Off');

/** Key slots on a LivePremier. */
export const KEY_SLOTS = 50;

const word = (attr, name, sets = [{ from: 0, to: 255, name }]) => ({ attr, name, role: 'value', sets });
const wide = (attr, name, { def = 0, physical = [0, 65535], sets = [{ from: 0, to: 65535, name }] } = {}) =>
  ({ attr, name, role: 'value', bits: 16, default: def, physical, sets });
const step = (attr, name, sets) => ({ attr, name, role: 'step', sets });

const LOOK = {
  x: wide('x', 'Position X', { def: CENTRE, physical: [-CENTRE, CENTRE - 1], sets: [{ from: 0, to: 65535, name: 'Pixels from centre' }] }),
  y: wide('y', 'Position Y', { def: CENTRE, physical: [-CENTRE, CENTRE - 1], sets: [{ from: 0, to: 65535, name: 'Pixels from centre' }] }),
  w: wide('w', 'Width', { sets: [{ from: 0, to: 0, name: 'Memory look' }, { from: 1, to: 65535, name: 'Pixels' }] }),
  h: wide('h', 'Height', { sets: [{ from: 0, to: 0, name: 'Memory look' }, { from: 1, to: 65535, name: 'Pixels' }] }),
  cropLeft: wide('cropLeft', 'Crop left'),
  cropRight: wide('cropRight', 'Crop right'),
  cropTop: wide('cropTop', 'Crop top'),
  cropBottom: wide('cropBottom', 'Crop bottom'),
  red: word('red', 'Red'),
  green: word('green', 'Green'),
  blue: word('blue', 'Blue'),
  flip: step('flip', 'Flip', steps(FLIPS.map((f) => f.name), 64)),
  strobe: word('strobe', 'Strobe', [{ from: 0, to: 0, name: 'Off' }, { from: 1, to: 255, name: 'Slow to fast' }]),
  maskLeft: wide('maskLeft', 'Mask left'),
  maskRight: wide('maskRight', 'Mask right'),
  maskTop: wide('maskTop', 'Mask top'),
  maskBottom: wide('maskBottom', 'Mask bottom'),
  aspect: step('aspect', 'Aspect', steps(ASPECTS.map((a) => a.name), 51)),
  effect: step('effect', 'Effect', steps([...EFFECTS.map((e) => e.name), 'None'], 32)),
  borderStyle: step('borderStyle', 'Border style', steps(STYLES.map(styleName), 32)),
  borderRadius: word('borderRadius', 'Border radius'),
  borderWidth: word('borderWidth', 'Border width'),
  borderHeight: word('borderHeight', 'Border height'),
  borderOpacity: word('borderOpacity', 'Border opacity'),
  borderRed: word('borderRed', 'Border red'),
  borderGreen: word('borderGreen', 'Border green'),
  borderBlue: word('borderBlue', 'Border blue'),
  shadowStyle: step('shadowStyle', 'Shadow style', steps(STYLES.map(styleName), 32)),
  shadowRadius: word('shadowRadius', 'Shadow radius'),
  shadowX: wide('shadowX', 'Shadow X', { def: CENTRE, physical: [-512, 512], sets: [{ from: 0, to: 65535, name: 'Offset -512 to 512 px' }] }),
  shadowY: wide('shadowY', 'Shadow Y', { def: CENTRE, physical: [-512, 512], sets: [{ from: 0, to: 65535, name: 'Offset -512 to 512 px' }] }),
  shadowOpacity: word('shadowOpacity', 'Shadow opacity'),
  shadowRed: word('shadowRed', 'Shadow red'),
  shadowGreen: word('shadowGreen', 'Shadow green'),
  shadowBlue: word('shadowBlue', 'Shadow blue'),
  key: step('key', 'Key', [{ from: 0, to: 0, name: 'Off' }, { from: 1, to: KEY_SLOTS, name: `Slot 1-${KEY_SLOTS}` },
    { from: KEY_SLOTS + 1, to: 255, name: 'Off' }]),
};

const CUE = [CH.folder, CH.file, CH.opacity];
const COMPACT = [...CUE, LOOK.x, LOOK.y, LOOK.w, LOOK.h];
const STANDARD = [...COMPACT, LOOK.cropLeft, LOOK.cropRight, LOOK.cropTop, LOOK.cropBottom,
  LOOK.red, LOOK.green, LOOK.blue, LOOK.flip, LOOK.strobe];
const FULL = [...STANDARD, LOOK.maskLeft, LOOK.maskRight, LOOK.maskTop, LOOK.maskBottom, LOOK.aspect, LOOK.effect,
  LOOK.borderStyle, LOOK.borderRadius, LOOK.borderWidth, LOOK.borderHeight, LOOK.borderOpacity,
  LOOK.borderRed, LOOK.borderGreen, LOOK.borderBlue,
  LOOK.shadowStyle, LOOK.shadowRadius, LOOK.shadowX, LOOK.shadowY, LOOK.shadowOpacity,
  LOOK.shadowRed, LOOK.shadowGreen, LOOK.shadowBlue, LOOK.key];
const CONTROLS = [CH.control, CH.memory, CH.take, CH.cut];
const same = (channels) => ({ cue: channels, compact: channels, standard: channels, full: channels });

/**
 * The fixture types and their modes. A mode is its channels in order, 8 bits
 * wide unless they say `bits: 16` (coarse then fine, as every desk patches
 * them).
 */
export const FIXTURES = Object.freeze({
  master: {
    kind: 'master', name: 'LPP Master', short: 'LPPMaster',
    description: 'LivePremier Plus: the whole switcher — master memory, take all, cut all.',
    guid: '83AD3503-A0F3-474D-AD92-5943E00AD40E',
    modes: same(CONTROLS),
  },
  screen: {
    kind: 'screen', name: 'LPP Screen', short: 'LPPScreen',
    description: 'LivePremier Plus: one screen or aux — control mode, memory recall to preview, take, cut.',
    guid: '01C5BB6C-193C-4BE8-9F77-B2AE9DECC7CD',
    modes: same(CONTROLS),
  },
  layer: {
    kind: 'layer', name: 'LPP Layer', short: 'LPPLayer',
    description: 'LivePremier Plus: one layer of a screen — source, opacity, and in the larger modes position, size, crop, colour and effects.',
    guid: '7C425188-06C6-4A6B-A928-3A5A9691D485',
    modes: { cue: CUE, compact: COMPACT, standard: STANDARD, full: FULL },
  },
});

export const MODES = Object.freeze([
  { id: 'cue', label: 'Cue', what: 'Layers carry source and opacity; the memories hold the geometry. One universe covers most rigs.' },
  { id: 'compact', label: 'Compact', what: 'Adds position and size, 16-bit. For onPC and other desks short of parameters.' },
  { id: 'standard', label: 'Standard', what: 'Adds crop, colour, flip and strobe.' },
  { id: 'full', label: 'Full', what: 'Every layer property worth a fader: adds mask, aspect, effect, border, shadow and key.' },
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

/** Strobe 1–255, slow to fast, as the frames a strobe cycle lasts (255 to 2); null is off. */
export const strobeFrames = (v) => (v > 0 ? Math.max(2, Math.min(255, 256 - v)) : null);

/** Shadow offset: 16-bit, centred, scaled to the switcher's ±512 px. */
export const shadowOffset = (v) => Math.round((v - CENTRE) / 64);

const styleOf = (v) => STYLES[Math.min(STYLES.length - 1, v >> 5)];
const keyOf = (v) => (v >= 1 && v <= KEY_SLOTS ? v : null);

/**
 * What a Layer fixture's channels ask of the layer, by part — only the parts
 * its mode has channels for, and only those the desk owns at these values:
 *
 *   source    {kind, number}         absent while the folder holds
 *   opacity   0–256
 *   colour    {red, green, blue}     only with the Colour folder
 *   geometry  {x, y, w, h}           pixels; x, y from the screen's centre
 *   crop      {left, right, top, bottom}   0–65535, as the switcher has them
 *   effects   {flipH, flipV, effect, strobe}   effect a flag or null; strobe frames or null
 *   mask      {left, right, top, bottom}
 *   aspect    'NONE' | '1_1' | 'CENTERED' | 'FULLSCREEN' | 'CROPPED'
 *   border    {style, radius, sizeH, sizeV, opacity, red, green, blue}   style a flag list
 *   shadow    {style, radius, sizeH, sizeV, opacity, red, green, blue}   sizes ±512
 *   key       {enable, slot}
 *
 * Everything from geometry down is absent while W or H is zero: the memory's.
 */
export function layerLook(v) {
  const look = {};
  const src = sourceOf(v);
  if (src) look.source = src;
  look.opacity = opacityOf(v.opacity);
  if (src && src.kind === 'COLOR' && 'red' in v) look.colour = { red: v.red, green: v.green, blue: v.blue };
  if (!('w' in v) || !v.w || !v.h) return look;
  look.geometry = { x: v.x - CENTRE, y: v.y - CENTRE, w: v.w, h: v.h };
  if ('cropLeft' in v) look.crop = { left: v.cropLeft, right: v.cropRight, top: v.cropTop, bottom: v.cropBottom };
  if ('flip' in v) {
    const flip = FLIPS[v.flip >> 6];
    const effect = 'effect' in v ? (EFFECTS[v.effect >> 5] || EFFECTS[0]).flag : null;
    look.effects = { flipH: flip.h, flipV: flip.v, effect, strobe: strobeFrames(v.strobe) };
  }
  if ('maskLeft' in v) look.mask = { left: v.maskLeft, right: v.maskRight, top: v.maskTop, bottom: v.maskBottom };
  if ('aspect' in v) look.aspect = ASPECTS[Math.min(ASPECTS.length - 1, Math.floor(v.aspect / 51))].value;
  if ('borderStyle' in v) {
    look.border = {
      style: styleOf(v.borderStyle), radius: v.borderRadius, sizeH: v.borderWidth, sizeV: v.borderHeight,
      opacity: v.borderOpacity, red: v.borderRed, green: v.borderGreen, blue: v.borderBlue,
    };
  }
  if ('shadowStyle' in v) {
    look.shadow = {
      style: styleOf(v.shadowStyle), radius: v.shadowRadius, sizeH: shadowOffset(v.shadowX), sizeV: shadowOffset(v.shadowY),
      opacity: v.shadowOpacity, red: v.shadowRed, green: v.shadowGreen, blue: v.shadowBlue,
    };
  }
  if ('key' in v) look.key = { enable: keyOf(v.key) !== null, slot: keyOf(v.key) };
  return look;
}

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
 *   { type: 'layer', destination, layer, param, value }   param a part of `layerLook`
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
      const prev = before.get(f.id);
      if (!prev) continue;
      const look = layerLook(now.get(f.id));
      const was = layerLook(prev);
      for (const [param, value] of Object.entries(look)) {
        if (!sameValue(value, was[param])) layers.push(layerAction(f, param, value));
      }
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
   * the buffer it edits (a recall into preview, a take): the desk owns what
   * its mode has channels for, and the memory owns the rest. A layer at
   * folder 0 (hold) keeps whatever source the memory gave it, and one at size
   * 0 its whole look.
   */
  layersFor(destination) {
    const out = [];
    for (const f of this.#fixtures) {
      if (f.kind !== 'layer' || f.destination !== destination) continue;
      const v = this.#last.get(f.id);
      if (!v) continue;
      for (const [param, value] of Object.entries(layerLook(v))) out.push(layerAction(f, param, value));
    }
    return out;
  }
}

const layerAction = (f, param, value) => ({ type: 'layer', destination: f.destination, layer: f.layer, param, value });

/* The parts of a look are numbers, strings, or small objects of them built in one key order. */
const sameValue = (a, b) => a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
