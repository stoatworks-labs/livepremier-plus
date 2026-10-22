/*
 * A Pixelhue U-series console, as a LivePremier surface.  ** PREVIEW **
 *
 * ## The idea, which is not the obvious one
 *
 * The obvious way to drive a console is to read key ids and decide what each
 * one means. That is what `vendor/surface/` does for a MIDI controller, and it
 * is the wrong shape here, because a U-series console is not a keyboard — it
 * is a peer that already knows what a screen, a layer, a source and a memory
 * are.
 *
 * So this publishes a **model** and answers **intents**:
 *
 *   we send     {screens, layers, inputs, presets, …}   over data-change
 *   it does     labels, lamps, paging, modes, long-press
 *   it sends    {command: 300, payload:{id: 2, text: "LIVE_2"}}
 *   we do       the switcher
 *
 * The identity comes back exactly as published — a screen's `uid` is the
 * string this app chose, `S1` — so there is no key-to-meaning table to keep in
 * step with a firmware. `docs/PIXELHUE.md` has the evidence and the wire
 * shapes; both were read off a real UCenter, not a document.
 *
 * ## Why this file holds no I/O
 *
 * Same rule as everything in `src/core/`: it runs under plain node, the tests
 * import it directly, and the plugin's `supervisor.js` and `ucenter.js` do the
 * sockets. Both halves of the plugin import it — the settings card reads its
 * console list — which is the other reason it must stay free of either. It is
 * also why the caller supplies the preset letters rather than this resolving
 * them — which letter is on air is device state, and guessing puts a change on
 * air.
 */

import { actionOf, encoderStep, normaliseMap } from './mapping.js';

/* What an intent writes is shared with every other console, so it lives in
   `src/core/console-intents.js`; re-exported so this stays the one import. */
export { writesFor, tbarWrites, stepLayer, Selection } from '../../src/core/console-intents.js';

/**
 * The consoles this understands, and where their control service listens.
 *
 * ⚠️ The ports are not a detail. A U5 / U5 Pro serves 19999 on **loopback**,
 * so this app has to run on the console itself to reach one. A U5 mini serves
 * 8088 on the LAN, so it is driven from wherever this app already runs, with
 * nothing installed on the console. That difference decides how a show is
 * rigged, and it is the reason the mini is the model to try first.
 *
 * ⚠️ Nor is the socket's path, because it is not the same service. A U5 / U5
 * Pro runs UCenter (`ucenter_win`), which serves `/unico/v1/ucenter/ws`. A U5
 * mini runs `nvcontroller`, whose binary has no `ucenter/ws` in it at all: it
 * serves `/unico/v1/ws`, which is where the mini's own LCD app connects. Until
 * 2026-10-22 both models dialled the U5's path, the stand-in served it too,
 * and the first real mini answered it with an ordinary HTTP 200. The REST
 * calls are under `/unico/v1/ucenter/video-station/` on both.
 *
 * `clientType` is what this app says it is on that socket. 5 is what a U5's
 * on-screen keyboard uses, and a type-5 socket was seen getting key reports
 * from a U5's UCenter. On a mini it is a guess: `ownClientType` is what the
 * console's own software connects as there, and the panel says so out loud
 * if a type-5 socket opens and no key report ever arrives (`silentNote`).
 */
export const CONSOLE_MODELS = Object.freeze([
  /* `modelId` is the console's own (Unico's deviceModel): it is how its key
     map is asked for, `key/active-custom?deviceModel=`. */
  {
    id: 'u5mini', label: 'Pixelhue U5 mini', port: 8088, wsPath: '/unico/v1/ws', clientType: 5,
    /* liblcdcommchannelimpl.so, firmware V1.0.3: `/unico/v1/ws?client-type=11`. */
    ownClientType: 11,
    busWidth: 8, overLan: true, modelId: 29711,
  },
  {
    id: 'u5pro', label: 'Pixelhue U5 Pro', port: 19999, wsPath: '/unico/v1/ucenter/ws', clientType: 5,
    busWidth: 8, overLan: false, modelId: 29703,
  },
  {
    id: 'u5', label: 'Pixelhue U5', port: 19999, wsPath: '/unico/v1/ucenter/ws', clientType: 5,
    busWidth: 8, overLan: false, modelId: 29701,
  },
]);

/** The console model for an id, or the mini (the first) for one this does not know. */
export const consoleModel = (id) => CONSOLE_MODELS.find((m) => m.id === id) || CONSOLE_MODELS[0];

/** What a link to `id` dials: `{port, wsPath, clientType}`, for `UCenterLink`. */
export function linkFor(id) {
  const { port, wsPath, clientType } = consoleModel(id);
  return { port, wsPath, clientType };
}

/**
 * What the panel says when the console's socket opened and no key report has
 * come in: `after` ms, `frames` of anything else meanwhile. Plain words,
 * because the likeliest reader is someone with a console in front of them and
 * this line in a message to us.
 */
export function silentNote(id, { after, frames = 0, clientType } = {}) {
  const m = consoleModel(id);
  const type = clientType ?? m.clientType;
  const s = Math.round(after / 1000);
  const heard = frames
    ? `${frames} frame${frames === 1 ? '' : 's'}, none of them keys`
    : 'nothing at all';
  const why = m.ownClientType && m.ownClientType !== type
    ? `This app connects as client-type=${type}, which has never been tried on a ${m.label}: `
      + `the console's own LCD app connects as client-type=${m.ownClientType}.`
    : 'UCenter has always sent its whole key state the moment a socket opened, so something on this link is wrong.';
  return `The console's socket is open, but no key report has come in the ${s} s since (${heard}). ${why}`;
}

/** Unico's `AreaType`. The console's four buses, plus the device area. */
export const AREA = Object.freeze({
  printing: 0, screen: 1, device: 2, input: 3, layer: 4, preset: 5, custom: 6,
});

/**
 * The commands a console reports. Read out of Unico's own
 * `pages/editor1/common/enum.ts` and confirmed against a live UCenter for the
 * ones marked ✓ — the rest are the vendor's own numbering, unexercised. The
 * names are the vendor's too: pixelhue-re's press inspector checks every one
 * against PixelFlow's source maps and flags any that drift.
 */
export const COMMAND = Object.freeze({
  deviceSelect: 0,
  deviceUnselect: 1,
  screenCreate: 100,
  screenSelect: 101,        // ✓
  /* A quick press on a screen already selected but not active: make it the
     active one (its layers take the layer bus). A LONG press on a selected
     screen is what reports 103. */
  screenActive: 102,        // ✓
  screenUnselect: 103,      // ✓ long press
  /* What a screen key reports while DEL is armed. Never acted on: deleting a
     screen from a panel is not something this app offers. */
  screenDelete: 104,        // ✓
  /* What an EMPTY layer key reports. Never acted on either. */
  layerCreate: 200,         // ✓
  layerSelect: 201,         // ✓
  inputSwitch: 300,         // ✓
  savePreset: 400,          // ✓ — SAVE TO armed, then a preset key
  playPreset: 401,          // ✓
  /* Never acted on: one key emptying every memory is not a panel feature. */
  deleteAllPreset: 402,
  deletePreset: 403,        // ✓ — DEL armed, then a preset key
  /* Layer tools, on page 0 of a U5's lower-left cluster. Never acted on: a
     LivePremier layer's stacking is its number, and the rest want a decision. */
  layerFullscreen: 500,
  layerFullOutput: 501,     // ✓
  layerCopy: 502,           // ✓
  layerMirror: 503,         // ✓
  layerTop: 504,
  layerUp: 505,             // ✓
  layerBottom: 506,
  layerDown: 507,           // ✓
  layerCutout: 508,
  layerEffectTimeAdd: 509,  // ✓ TIME, a click
  layerEffectTimeQuickAddStart: 510,   // ✓ TIME, held (repeats)
  LayerEffectTimeQuickAddEnd: 511,
  layerEffectTimeMinus: 512,           // ✓ CTRL + TIME
  layerEffectTimeQuickMinusStart: 513,
  layerEffectTimeQuickMinusEnd: 514,
  ctrl: 519,
  screenFreeze: 517,        // ✓
  screenFTB: 518,           // ✓
  presetSave: 520,          // ✓ SAVE TO arms / disarms
  switchDel: 521,           // ✓ DEL arms / disarms
  switchMutiDel: 522,
  matchPGM: 529,            // ✓
  pgmEdit: 530,             // ✓
  take: 531,                // ✓
  cut: 532,                 // ✓
  swap: 533,                // ✓
  lockPanel: 523,           // ✓ LOCK PANEL, a long press
  unlockPanel: 524,
  pageUp: 549,
  pageDown: 550,
  /* Cue transport, on page 1 of the lower-left cluster. */
  playCue: 569,             // ✓
  startAnewCue: 570,        // ✓
  stopCue: 571,             // ✓
  previousCue: 572,         // ✓
  nextCue: 573,             // ✓
  deviceSwitch: 586,        // ✓ SWITCH DEVICE
  inputTypeSwitch: 587,     // ✓ SIGNAL SOURCE
});

const NAMES = Object.fromEntries(Object.entries(COMMAND).map(([k, v]) => [v, k]));
export const commandName = (code) => NAMES[code] ?? `command ${code}`;

/* Unico's own enums, for the values the model carries. */
const ENABLE = { off: 0, on: 1 };
const SCREEN_TYPE = { normal: 2, AUX: 4 };
const SOURCE_TYPE = { input: 2 };
const SCREEN_ACTIVE = { INACTIVATED: 1, PGM: 2, PVW: 4 };
const PLAY = { default: 1 };
/* ⚠️ `LayerTypeE`: the console binds only normal (2), aux (4), fill (256),
   bkg (16) and logo (32) layers — PixelFlow's own `isaVailableLayer`. This
   app used to send 0, which is why the layer bus stayed empty. */
const LAYER_TYPE = { normal: 2 };
/* `LayerSceneTypeE`: which buffer a layer belongs to. */
const LAYER_SCENE = { none: 1, PGM: 2, PVW: 4 };

/**
 * Layers of different screens share one id space on the console, and the id
 * is what a layer key reports back. So a layer's id carries its screen's
 * position as well as its slot: slot 3 of the second screen is 2003.
 */
const LAYER_ID_STRIDE = 1000;
export const layerIdFor = (screenIndex, key) => (screenIndex + 1) * LAYER_ID_STRIDE + Number(key);
export const layerKeyOf = (id) => {
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? (n % LAYER_ID_STRIDE) || null : null;
};

/**
 * How many positions a bus shows before the console pages it.
 *
 * The console pages itself — that is the whole point of publishing a model
 * rather than painting keys — so this is not a limit on what may be sent. It
 * is here because a LivePremier has up to 24 screens and a thousand memory
 * slots, and sending a thousand of anything to a panel with eight keys on a
 * bus is a way of making a console take a second to redraw. `docs/PIXELHUE.md`
 * has the per-model bus widths.
 */
export const DEFAULT_LIMITS = Object.freeze({ screens: 24, inputs: 64, presets: 64, layers: 16 });

/**
 * Build the business model a console is fed.
 *
 * @param {object} facts
 * @param {string} facts.deviceId     what the console calls this switcher; any
 *                                    stable string, and it comes back on every
 *                                    intent, which is how two frames are told
 *                                    apart
 * @param {Array}  facts.destinations `{id, kind, label, isUsed}` from the dialect
 * @param {Array}  facts.inputs       `{source, label}` — `source` is `LIVE_3`
 * @param {Array}  facts.presets      `{slot, label}` — screen memories
 * @param {Array}  [facts.layers]     `{destination, key, label}` — every fitted
 *                                    layer of every published destination; the
 *                                    console shows the selected screen's own
 * @param {object} [facts.selection]  `{destinations, layer, buffer}` as we hold
 *                                    it (`destination` alone is still read)
 * @param {object} [facts.limits]
 */
export function businessModel(facts) {
  const {
    deviceId = 'LIVEPREMIER',
    destinations = [], inputs = [], presets = [], layers = [],
    selection = {}, limits = DEFAULT_LIMITS,
  } = facts || {};

  /*
   * ⚠️ `index` is the key position **and it is 1-based**. Publishing from zero
   * silently drops the first object of every bus: the console binds nothing to
   * position 0, reports no error, and the operator sees a panel that is one
   * short with no clue why. Found the hard way; the console's own
   * `key_mini.xml` numbers its key list from 1 and says so.
   */
  const at = (i) => [i + 1];

  const used = destinations.filter((d) => d.isUsed).slice(0, limits.screens);
  /*
   * ⚠️ Every selected screen is marked, not only the first. The console
   * decides between select (101) and unselect (103) from this flag, so a
   * screen published as unselected can never be deselected from the panel —
   * pressing it again only selects it again.
   */
  const chosen = new Set(selection.destinations
    || (selection.destination ? [selection.destination] : []));
  const flag = (on) => (on ? ENABLE.on : ENABLE.off);
  /*
   * ⚠️ The layer bus shows only the ACTIVE screen's layers, and a screen is
   * active only when published with `activeRegion: PVW` to match its layers'
   * `region: PVW` — found by publishing variants at a live UCenter,
   * 2026-09-23. PGM on both sides binds nothing. PixelFlow activates the
   * screen last selected, and so does this.
   */
  const list = [...chosen];
  const active = list.length ? list[list.length - 1] : null;
  const position = new Map(used.map((d, i) => [d.id, i]));

  /* Each screen's layers are numbered from key 1 on the bus: the console
     shows one screen's layers at a time. */
  const perScreen = new Map();
  const bound = [];
  for (const l of layers) {
    const i = position.get(l.destination);
    if (i === undefined) continue;
    const n = perScreen.get(l.destination) || 0;
    if (n >= limits.layers) continue;
    perScreen.set(l.destination, n + 1);
    bound.push({ ...l, screenIndex: i, slot: n });
  }

  return {
    screens: used.map((d, i) => ({
      uid: d.id,
      screenId: i + 1,
      name: d.label || d.id,
      index: at(i),
      enable: ENABLE.on,
      isEmpty: false,
      selected: flag(chosen.has(d.id)),
      type: d.kind === 'aux' ? SCREEN_TYPE.AUX : SCREEN_TYPE.normal,
      activeRegion: d.id === active ? SCREEN_ACTIVE.PVW : SCREEN_ACTIVE.INACTIVATED,
      lockedPgm: ENABLE.on,
      /* These three light the console's own PGM EDIT, FRZ and FTB keys. */
      pgmEdit: flag(selection.buffer === 'PROGRAM'),
      freeze: flag(d.frozen),
      ftb: flag(d.faded),
      originId: deviceId,
    })),

    layers: bound.map((l) => ({
      attachScreenId: l.screenIndex + 1,
      attachScreenUid: l.destination,
      id: layerIdFor(l.screenIndex, l.key),
      type: LAYER_TYPE.normal,
      region: LAYER_SCENE.PVW,
      sourceType: SOURCE_TYPE.input,
      name: l.label || `Layer ${l.key}`,
      selected: flag(Number(l.key) === Number(selection.layer) && chosen.has(l.destination)),
      index: at(l.slot),
      sourceId: 0,
      deviceSn: deviceId,
      serial: Number(l.key),
      originId: deviceId,
      enable: ENABLE.on,
    })),

    inputs: inputs.slice(0, limits.inputs).map((s, i) => ({
      /* `id` is what comes back on an intent, so it has to be the number in
         `LIVE_<n>` rather than a position in this list. */
      id: s.number,
      type: SOURCE_TYPE.input,
      signal: 1,
      overload: 0,
      name: s.label || s.source,
      index: at(i),
      deviceSn: deviceId,
      hasBackup: 0,
      isBackup: 0,
      slotId: 1,
      sortNum: s.number,
      parentId: 0,
      originId: deviceId,
    })),

    presets: presets.slice(0, limits.presets).map((p, i) => ({
      id: p.slot,
      name: p.label || `Memory ${p.slot}`,
      index: at(i),
      load: PLAY.default,
      deviceSn: deviceId,
      originId: deviceId,
    })),

    cues: [], medias: [], funcs: [], additionInfos: [],
    newProtocol: ENABLE.on,
  };
}

/* ------------------------------------------------------------------ intents */

/**
 * Normalise one reported command into something this app can act on.
 *
 * Returns `null` for anything not handled, which is most of the vocabulary —
 * a console reports PTZ, media, timecode and cue commands too. Ignoring them
 * quietly is right: they are about a Pixelhue show, not this switcher.
 */
export function readIntent(report) {
  if (!report || typeof report !== 'object') return null;
  const command = Number(report.command);
  const payload = report.payload || {};
  const at = Number.isFinite(Number(report.index)) ? Number(report.index) : null;

  switch (command) {
    case COMMAND.screenSelect:
      return { kind: 'select', destination: String(payload.uid || ''), at };
    case COMMAND.screenActive:
      return { kind: 'activate', destination: String(payload.uid || ''), at };
    case COMMAND.screenUnselect:
      return { kind: 'unselect', destination: String(payload.uid || ''), at };
    case COMMAND.layerSelect:
      /* The id is the one `layerIdFor` published, so it carries the screen
         too; the selection keeps only the slot, which every selected screen
         shares. */
      return { kind: 'selectLayer', layer: layerKeyOf(payload.id), at };
    case COMMAND.inputSwitch:
      return { kind: 'source', input: Number(payload.id) || null, label: payload.text || '', at };
    case COMMAND.playPreset:
      return { kind: 'recall', slot: Number(payload.id) || null, at };
    case COMMAND.savePreset:
      return { kind: 'store', slot: Number(payload.id) || null, at };
    case COMMAND.take:   return { kind: 'take' };
    case COMMAND.cut:    return { kind: 'cut' };
    case COMMAND.matchPGM: return { kind: 'matchProgram' };
    case COMMAND.pgmEdit:  return { kind: 'pgmEdit' };
    case COMMAND.screenFTB:    return { kind: 'ftb' };
    case COMMAND.screenFreeze: return { kind: 'freeze' };
    case COMMAND.layerEffectTimeAdd:
    case COMMAND.layerEffectTimeQuickAddStart:
      return { kind: 'time', delta: 1 };
    case COMMAND.layerEffectTimeMinus:
    case COMMAND.layerEffectTimeQuickMinusStart:
      return { kind: 'time', delta: -1 };
    case COMMAND.swap: return { kind: 'swap' };
    case COMMAND.deletePreset:
      return { kind: 'deletePreset', slot: Number(payload.id) || null, label: payload.text || '', at };
    /* The console's layer order keys step the selection through the active
       screen's layers instead: a LivePremier layer's stacking is its number. */
    case COMMAND.layerUp: return { kind: 'layerStep', to: 'next' };
    case COMMAND.layerDown: return { kind: 'layerStep', to: 'previous' };
    case COMMAND.layerTop: return { kind: 'layerStep', to: 'last' };
    case COMMAND.layerBottom: return { kind: 'layerStep', to: 'first' };
    case COMMAND.playCue: return { kind: 'transport', action: 'play' };
    case COMMAND.startAnewCue: return { kind: 'transport', action: 'restart' };
    case COMMAND.stopCue: return { kind: 'transport', action: 'stop' };
    case COMMAND.previousCue: return { kind: 'transport', action: 'previous' };
    case COMMAND.nextCue: return { kind: 'transport', action: 'next' };
    case COMMAND.inputTypeSwitch: return { kind: 'sourceType' };
    case COMMAND.lockPanel:
    case COMMAND.unlockPanel:
      return { kind: 'lock' };
    default: return null;
  }
}

/* ------------------------------------------------------ cue transport */

/**
 * Where the cue transport keys go, and which Companion button each presses
 * when they go there: five buttons in a row, from column 0.
 */
export const TRANSPORT_TARGETS = Object.freeze([
  {
    id: 'cues',
    label: 'This app\'s cue stack',
    what: 'Play is GO, restart goes back to the first cue, stop stops, previous and next move the standby. '
      + 'It runs in one open page of this app, so a page has to be open.',
  },
  {
    id: 'companion',
    label: 'Companion buttons',
    what: 'The five keys press five Companion buttons in a row — for a media player, a HyperDeck or '
      + 'anything else Companion drives.',
  },
  { id: 'off', label: 'Nothing', what: 'The keys are reported and ignored.' },
]);
export const TRANSPORT_ACTIONS = Object.freeze(['play', 'restart', 'stop', 'previous', 'next']);
export const companionLocation = (action, page, row) => {
  const column = TRANSPORT_ACTIONS.indexOf(action);
  return column < 0 ? null : { pageNumber: page, row, column };
};

/* ------------------------------------------------------ keys with no command */

/**
 * Keys that report NO command — UCenter keeps them to itself — acted on from
 * their raw press instead. Which key they are comes from the console's own
 * key map (`key/active-custom`), by `keyMode`, so it holds for every model.
 * SOURCE BACKUP shares its key with other functions on the other pages of the
 * lower-left cluster, where the same key DOES report a command; a press is
 * only taken as SOURCE BACKUP when no command follows it.
 */
export const SILENT_KEY_MODES = Object.freeze({ 112: 'mvr', 181: 'sourceBackup' });

/**
 * What SOURCE BACKUP hands the open page, or why it hands it nothing: the
 * backup menu of `input`, the last input pressed on the panel. Only where the
 * switcher's inputs have a backup at all (`dialect.inputBackup`) — a Midra 4K
 * or Alta 4K input's ⋮ is a menu too, and opening it would claim a backup
 * menu that is not one.
 */
export function backupRequest({ dialect, input }) {
  if (!input) return { note: 'SOURCE BACKUP — press an input on the panel first, so it knows which' };
  if (!dialect) return { note: 'refused — the switcher has not been read yet' };
  if (!dialect.inputBackup) return { note: `refused — a ${dialect.name} input has no backup` };
  return { payload: { type: 'inputBackup', input }, what: `open the backup menu of input ${input}` };
}

/* ------------------------------------------------------ faders and encoders */

/**
 * What this app binds the console's faders and encoders to.
 *
 * ⚠️ A U5's faders and encoders report NOTHING until something is bound to
 * them: UCenter drops the moves. A client binds with `POST
 * ucenter/video-station/midi/binding {attributes:[{unique, type, index}]}`
 * (type 2 fader, 1 encoder), and from then on every move of a bound control
 * reaches every client on tag 0x0010031c as `{unique, value, type,
 * frameValue}` — a fader's value is its position in percent, an encoder's
 * `frameValue` is ±1 per detent. Found 2026-09-23 on the Mac UCenter; the
 * binding table is UCenter's and shared, so PixelFlow binding its own
 * controls takes them back.
 *
 * What each control DOES here is a first answer, meant to be replaced:
 * fader n is the opacity of layer n on the active screen, and the four
 * encoders move and size the selected layer — both on the buffer the panel
 * edits.
 */
export const FADERS = 8;
export const ENCODERS = 4;
export const MIDI_BINDINGS = Object.freeze([
  ...Array.from({ length: FADERS }, (_, i) => ({ unique: `lpp.fader.${i + 1}`, type: 2, index: i + 1 })),
  ...Array.from({ length: ENCODERS }, (_, i) => ({ unique: `lpp.encoder.${i + 1}`, type: 1, index: i + 1 })),
]);
/* Pixels per detent, for the four defaults. What each control does is the
   Pixelhue Mapping page's to change: `mapping.js`. */
export const ENCODER_STEP = 8;

/** One 0x0010031c report, as this app's own control, or null. */
export function readMidi(report) {
  const m = /^lpp\.(fader|encoder)\.(\d+)$/.exec(String((report && report.unique) || ''));
  if (!m) return null;
  const index = Number(m[2]);
  if (m[1] === 'fader') {
    const value = Number(report.value);
    return Number.isFinite(value) ? { control: 'fader', index, percent: Math.min(100, Math.max(0, value)) } : null;
  }
  const ticks = Number(report.frameValue);
  return Number.isFinite(ticks) && ticks !== 0 ? { control: 'encoder', index, ticks } : null;
}

/** The catalogue entry for a named layer parameter, spelled either platform's way. */
const PARAM_IDS = {
  opacity: ['opacity.opacity'],
  posH: ['position.posH'],
  posV: ['position.posV'],
  sizeH: ['position.sizeH', 'size.sizeH'],
  sizeV: ['position.sizeV', 'size.sizeV'],
};
export function layerParam(dialect, name) {
  const list = (dialect && dialect.catalogue && dialect.catalogue.layer) || [];
  for (const id of PARAM_IDS[name] || []) {
    const found = list.find((p) => p.id === id);
    if (found) return found;
  }
  return null;
}

/**
 * What a control move writes. A fader is absolute; an encoder is relative to
 * `current`, which the caller reads from the device.
 *
 * @param {{control, index, percent?, ticks?}} move   from `readMidi`
 * @param {object} ctx `{dialect, destination, letter, layer, current?}`
 * @returns {{param: string, layer: number, path?: string[], value?: number, note: string}}
 */
export function midiWrite(move, ctx) {
  const { dialect, destination, letter } = ctx || {};
  if (!move || !dialect || !destination || !letter) return { note: 'nothing to move' };
  const isFader = move.control === 'fader';
  const action = ctx.action || actionOf(null, `${move.control}.${move.index}`);
  if (!action || action === 'none') return { note: `${move.control} ${move.index} is mapped to nothing` };
  const name = isFader ? 'opacity' : action;
  const layer = isFader && action === 'layerOpacity' ? move.index : ctx.layer;
  const step = isFader ? 0 : encoderStep(action);
  const spec = name && layerParam(dialect, name);
  if (!spec) return { param: name, layer, note: `${name || 'that control'} is not mapped on this platform` };
  const clamp = (v) => Math.min(spec.max ?? v, Math.max(spec.min ?? v, v));
  let value;
  if (isFader) {
    value = Math.round(((spec.max ?? 100) * move.percent) / 100);
  } else {
    if (!Number.isFinite(ctx.current)) return { param: name, layer, note: `refused — could not read ${name}` };
    value = clamp(ctx.current + move.ticks * step);
  }
  return {
    param: name,
    layer,
    path: dialect.layerParamPath(destination, letter, layer, spec.path),
    value: clamp(value),
    note: `${name} of layer ${layer} on ${destination} = ${clamp(value)}`,
  };
}

/* ------------------------------------------------------------------ settings */

/**
 * The plugin's settings, and its settings schema's two functions.
 *
 * Off, and for the same reason as the OSC listener plus one more: this is a
 * preview, it has never worked against a console, and it writes to a
 * switcher. Nobody should find it on by surprise. The mini is the default
 * model because it is the one that can be driven over the LAN without
 * installing anything on the console.
 */
export const DEFAULT_PIXELHUE = {
  pixelhueEnabled: false,
  pixelhueHost: '',
  pixelhueModel: 'u5mini',
  pixelhueTransport: 'cues',
  pixelhueCompanionPage: 1,
  pixelhueCompanionRow: 0,
  /* Overrides only — a control not in here does its default. `mapping.js`. */
  pixelhueMap: {},
};

/**
 * Coerce stored Pixelhue settings into something usable — a bad field falls
 * back to its default rather than refusing the file, like every setting in
 * this app. A host with whitespace or a scheme in it is a paste of something
 * else, and a field that silently empties says so on the page it was typed on.
 */
export function normalisePixelhue(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const host = String(input.pixelhueHost ?? '').trim();
  return {
    pixelhueEnabled: input.pixelhueEnabled === true,
    pixelhueHost: host && host.length <= 255 && /^[A-Za-z0-9._-]+$/.test(host) ? host : '',
    pixelhueModel: CONSOLE_MODELS.some((m) => m.id === input.pixelhueModel)
      ? input.pixelhueModel : DEFAULT_PIXELHUE.pixelhueModel,
    pixelhueTransport: TRANSPORT_TARGETS.some((t) => t.id === input.pixelhueTransport)
      ? input.pixelhueTransport : DEFAULT_PIXELHUE.pixelhueTransport,
    pixelhueCompanionPage: wholeIn(input.pixelhueCompanionPage, 1, 99, DEFAULT_PIXELHUE.pixelhueCompanionPage),
    pixelhueCompanionRow: wholeIn(input.pixelhueCompanionRow, 0, 99, DEFAULT_PIXELHUE.pixelhueCompanionRow),
    pixelhueMap: normaliseMap(input.pixelhueMap),
  };
}

function wholeIn(v, min, max, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** True when a change needs the console link rebuilt rather than just noted. */
export const pixelhueChanged = (a, b) =>
  a.pixelhueEnabled !== b.pixelhueEnabled
  || a.pixelhueHost !== b.pixelhueHost
  || a.pixelhueModel !== b.pixelhueModel;
