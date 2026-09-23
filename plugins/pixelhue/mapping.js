/*
 * What each of a Pixelhue console's function keys, faders and encoders does
 * here — the one table the Pixelhue Mapping page edits.  ** PREVIEW **
 *
 * Pure, and imported by both halves: the supervisor resolves a report through
 * it, and the page draws and edits it.
 *
 * ## What is mapped, and what is not
 *
 * The four buses — screens, layers, inputs, presets — are NOT in this table
 * and cannot be. The console is handed a model of the switcher and labels its
 * own bus keys from it (`core.js` says why), so what a bus key does is "that
 * object", and the object is whatever sits at that position. SAVE TO and DEL
 * are modes of the preset bus and stay with it. Paging is the console's own.
 *
 * Everything else that reports something is a **control** here, named by
 * function rather than by key code: TAKE is `take` on a U5, a U5 Pro and a
 * U5 mini alike, because the console reports the same command from each. A
 * control has a default action — exactly what it did before this table
 * existed — and the stored map holds only the controls someone changed.
 *
 * ⚠️ A held key REPEATS. TIME held reports 510 about eight times a second —
 * and ONLY 510, no 509 first — which is right for a take time and wrong for
 * nearly anything else. So while a control is mapped to an action that is not
 * `repeatable`, its repeat codes come back marked `repeat`, and the supervisor
 * acts on the first of a burst only: TIME mapped to TAKE fires once per hold,
 * not eight times a second for as long as a thumb rests on it.
 */

/**
 * The actions a KEY can be given. `intent` is what the supervisor acts on —
 * the same shapes `readIntent` produces, plus `none`, `page`, `inputBackup` and
 * `companion`, which only this table can produce.
 */
export const KEY_ACTIONS = Object.freeze([
  { id: 'none', legend: '—', label: 'Nothing', group: 'Off', intent: { kind: 'none' } },
  { id: 'take', legend: 'TAKE', label: 'Take', group: 'Transitions', intent: { kind: 'take' } },
  { id: 'cut', legend: 'CUT', label: 'Cut', group: 'Transitions', intent: { kind: 'cut' } },
  { id: 'matchProgram', legend: 'MATCH PGM', label: 'Program to preview', group: 'Transitions', intent: { kind: 'matchProgram' } },
  { id: 'swap', legend: 'SWAP', label: 'Swap on take (on / off)', group: 'Transitions', intent: { kind: 'swap' } },
  { id: 'timeUp', legend: 'TIME +', label: 'Take time +0.1 s', group: 'Transitions', intent: { kind: 'time', delta: 1 }, repeatable: true },
  { id: 'timeDown', legend: 'TIME −', label: 'Take time −0.1 s', group: 'Transitions', intent: { kind: 'time', delta: -1 }, repeatable: true },
  { id: 'ftb', legend: 'FTB', label: 'Fade to black (toggle)', group: 'Screens', intent: { kind: 'ftb' } },
  { id: 'freeze', legend: 'FREEZE', label: 'Freeze what is on air (toggle)', group: 'Screens', intent: { kind: 'freeze' } },
  { id: 'pgmEdit', legend: 'PGM EDIT', label: 'Edit program instead of preview (latch)', group: 'Screens', intent: { kind: 'pgmEdit' } },
  { id: 'sourceType', legend: 'SIGNAL', label: 'Input bus: live → stills → screens', group: 'Buses', intent: { kind: 'sourceType' } },
  { id: 'layerNext', legend: 'LAYER ▲', label: 'Select the next layer', group: 'Buses', intent: { kind: 'layerStep', to: 'next' } },
  { id: 'layerPrevious', legend: 'LAYER ▼', label: 'Select the previous layer', group: 'Buses', intent: { kind: 'layerStep', to: 'previous' } },
  { id: 'layerLast', legend: 'LAYER TOP', label: 'Select the top layer', group: 'Buses', intent: { kind: 'layerStep', to: 'last' } },
  { id: 'layerFirst', legend: 'LAYER BTM', label: 'Select the bottom layer', group: 'Buses', intent: { kind: 'layerStep', to: 'first' } },
  { id: 'cuePlay', legend: 'GO', label: 'Cue: play (GO)', group: 'Cue transport', intent: { kind: 'transport', action: 'play' } },
  { id: 'cueRestart', legend: 'CUE ⏮', label: 'Cue: back to the first', group: 'Cue transport', intent: { kind: 'transport', action: 'restart' } },
  { id: 'cueStop', legend: 'CUE ■', label: 'Cue: stop', group: 'Cue transport', intent: { kind: 'transport', action: 'stop' } },
  { id: 'cuePrevious', legend: 'CUE ◀', label: 'Cue: previous', group: 'Cue transport', intent: { kind: 'transport', action: 'previous' } },
  { id: 'cueNext', legend: 'CUE ▶', label: 'Cue: next', group: 'Cue transport', intent: { kind: 'transport', action: 'next' } },
  { id: 'mvr', legend: 'MVR', label: 'Open the Multiviewers page', group: 'Pages', intent: { kind: 'page', type: 'navigate', path: '/live/multiviewers', what: 'open the multiviewers page' } },
  { id: 'sourceBackup', legend: 'BACKUP', label: 'Open the last input’s backup menu', group: 'Pages', intent: { kind: 'inputBackup' } },
  { id: 'lock', legend: 'LOCK', label: 'Lock the panel (toggle)', group: 'Panel', intent: { kind: 'lock' } },
]);

/**
 * Actions that carry a number, spelled `recall:7` or `companion:1/0/3`. Kept
 * apart from the fixed list because the page offers them with a field.
 */
export const PARAM_ACTIONS = Object.freeze([
  { prefix: 'recall', label: 'Recall a memory to preview', group: 'Memories' },
  { prefix: 'companion', label: 'Press a Companion button', group: 'Companion' },
]);

const RECALL = /^recall:(\d{1,4})$/;
const COMPANION = /^companion:(\d{1,2})\/(\d{1,2})\/(\d{1,2})$/;

export const FADER_ACTIONS = Object.freeze([
  { id: 'layerOpacity', legend: 'L# OPAC', label: 'Opacity of its own layer (fader n → layer n)' },
  { id: 'selectedOpacity', legend: 'OPACITY', label: 'Opacity of the selected layer' },
  { id: 'none', legend: '—', label: 'Nothing' },
]);

export const ENCODER_ACTIONS = Object.freeze([
  { id: 'posH', legend: 'POS X', label: 'Selected layer: X position', step: 8 },
  { id: 'posV', legend: 'POS Y', label: 'Selected layer: Y position', step: 8 },
  { id: 'sizeH', legend: 'WIDTH', label: 'Selected layer: width', step: 8 },
  { id: 'sizeV', legend: 'HEIGHT', label: 'Selected layer: height', step: 8 },
  { id: 'opacity', legend: 'OPACITY', label: 'Selected layer: opacity', step: 2 },
  { id: 'none', legend: '—', label: 'Nothing' },
]);

/**
 * Every control that can be mapped. `codes` are the commands the console
 * reports for it; `keyMode` marks the two that report NO command and are
 * read from their raw press (see `SILENT_KEY_MODES` in `core.js`).
 */
export const KEY_CONTROLS = Object.freeze([
  { id: 'take', label: 'TAKE', codes: [531], default: 'take' },
  { id: 'cut', label: 'CUT', codes: [532], default: 'cut' },
  { id: 'matchPGM', label: 'MATCH PGM', codes: [529], default: 'matchProgram' },
  { id: 'pgmEdit', label: 'PGM EDIT', codes: [530], default: 'pgmEdit' },
  { id: 'ftb', label: 'FTB', codes: [518], default: 'ftb' },
  { id: 'freeze', label: 'FRZ', codes: [517], default: 'freeze' },
  { id: 'swap', label: 'SWAP', codes: [533], default: 'swap' },
  { id: 'time', label: 'TIME', codes: [509], repeat: [510], default: 'timeUp' },
  { id: 'ctrlTime', label: 'CTRL + TIME', codes: [512], repeat: [513], default: 'timeDown' },
  { id: 'signalSource', label: 'SIGNAL SOURCE', codes: [587], default: 'sourceType' },
  { id: 'switchDevice', label: 'SWITCH DEVICE', codes: [586], default: 'none' },
  { id: 'lockPanel', label: 'LOCK PANEL (long press)', codes: [523, 524], default: 'lock' },
  { id: 'mvr', label: 'MVR', keyMode: 112, default: 'mvr' },
  /* The lower-left cluster, page 0 on a U5: layer tools. */
  { id: 'layerFullOutput', label: 'FULL OUTPUT', codes: [501], default: 'none' },
  { id: 'layerCopy', label: 'COPY', codes: [502], default: 'none' },
  { id: 'layerMirror', label: 'MIRROR', codes: [503], default: 'none' },
  { id: 'layerUp', label: 'LAYER UP', codes: [505], default: 'layerNext' },
  { id: 'layerDown', label: 'LAYER DOWN', codes: [507], default: 'layerPrevious' },
  /* On other layouts' clusters; a U5's default layout has none of them. */
  { id: 'layerFullscreen', label: 'FULL SCREEN', codes: [500], default: 'none' },
  { id: 'layerTop', label: 'LAYER TOP', codes: [504], default: 'layerLast' },
  { id: 'layerBottom', label: 'LAYER BOTTOM', codes: [506], default: 'layerFirst' },
  { id: 'layerCutout', label: 'CUTOUT', codes: [508], default: 'none' },
  /* The cluster, page 1: cue transport. */
  { id: 'cuePlay', label: 'CUE PLAY', codes: [569], default: 'cuePlay' },
  { id: 'cueRestart', label: 'CUE RESTART', codes: [570], default: 'cueRestart' },
  { id: 'cueStop', label: 'CUE STOP', codes: [571], default: 'cueStop' },
  { id: 'cuePrevious', label: 'CUE PREVIOUS', codes: [572], default: 'cuePrevious' },
  { id: 'cueNext', label: 'CUE NEXT', codes: [573], default: 'cueNext' },
  /* The cluster, page 3. */
  { id: 'sourceBackup', label: 'SOURCE BACKUP', keyMode: 181, default: 'sourceBackup' },
]);

export const FADERS = 8;
export const ENCODERS = 4;
const ENCODER_DEFAULTS = { 1: 'posH', 2: 'posV', 3: 'sizeH', 4: 'sizeV' };

export const MOTION_CONTROLS = Object.freeze([
  ...Array.from({ length: FADERS }, (_, i) => ({ id: `fader.${i + 1}`, label: `Fader ${i + 1}`, kind: 'fader', default: 'layerOpacity' })),
  ...Array.from({ length: ENCODERS }, (_, i) => ({ id: `encoder.${i + 1}`, label: `Encoder ${i + 1}`, kind: 'encoder', default: ENCODER_DEFAULTS[i + 1] })),
]);

const CONTROL = new Map([...KEY_CONTROLS, ...MOTION_CONTROLS].map((c) => [c.id, c]));
const BY_CODE = new Map();
const REPEATS = new Map();
for (const c of KEY_CONTROLS) {
  for (const code of c.codes || []) BY_CODE.set(code, c);
  for (const code of c.repeat || []) { BY_CODE.set(code, c); REPEATS.set(code, c); }
}
const BY_KEY_MODE = new Map(KEY_CONTROLS.filter((c) => c.keyMode).map((c) => [c.keyMode, c]));
const KEY_ACTION = new Map(KEY_ACTIONS.map((a) => [a.id, a]));

export const controlById = (id) => CONTROL.get(id) || null;
/** The control a reported command belongs to, or null for a bus key and the rest. */
export const controlForCode = (code) => BY_CODE.get(Number(code)) || null;
/** The control a silent key is, by the console's own `keyMode` for it. */
export const controlForKeyMode = (mode) => BY_KEY_MODE.get(Number(mode)) || null;

/** The actions a control may be given. */
export function actionsFor(control) {
  const c = typeof control === 'string' ? controlById(control) : control;
  if (!c) return [];
  if (c.kind === 'fader') return FADER_ACTIONS;
  if (c.kind === 'encoder') return ENCODER_ACTIONS;
  return KEY_ACTIONS;
}

/** True when `action` is something `control` may be given. */
export function validAction(control, action) {
  const c = typeof control === 'string' ? controlById(control) : control;
  if (!c || typeof action !== 'string') return false;
  if (c.kind) return actionsFor(c).some((a) => a.id === action);
  if (KEY_ACTION.has(action)) return true;
  const recall = RECALL.exec(action);
  if (recall) return Number(recall[1]) >= 1;
  const cmp = COMPANION.exec(action);
  return !!cmp && Number(cmp[1]) >= 1;
}

/**
 * Keep only overrides that mean something: a known control, an action it may
 * have, and not already its default. A bad entry is dropped rather than the
 * whole map refused, like every other setting in this app.
 */
export function normaliseMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, action] of Object.entries(raw)) {
    const c = controlById(id);
    if (!c || !validAction(c, action) || action === c.default) continue;
    out[id] = action;
  }
  return out;
}

/** What `control` does under `map` — its override, or its default. */
export function actionOf(map, control) {
  const c = typeof control === 'string' ? controlById(control) : control;
  if (!c) return null;
  const v = map && Object.prototype.hasOwnProperty.call(map, c.id) ? map[c.id] : null;
  return v && validAction(c, v) ? v : c.default;
}

/** The whole table, every control with what it does now. */
export function resolvedMap(map) {
  return Object.fromEntries([...KEY_CONTROLS, ...MOTION_CONTROLS].map((c) => [c.id, actionOf(map, c)]));
}

/**
 * The intent an action stands for, or null for one that does not parse.
 * `none` is an intent too — the supervisor notes a key mapped to nothing
 * rather than going quiet, so the history says why a press did nothing.
 */
export function intentOf(action) {
  const fixed = KEY_ACTION.get(action);
  if (fixed) return { ...fixed.intent };
  const recall = RECALL.exec(String(action));
  if (recall) return { kind: 'recall', slot: Number(recall[1]) };
  const cmp = COMPANION.exec(String(action));
  if (cmp) return { kind: 'companion', location: { pageNumber: Number(cmp[1]), row: Number(cmp[2]), column: Number(cmp[3]) } };
  return null;
}

/**
 * What a reported command means under `map`, or null when the code is not a
 * mapped control's (a bus key, a mode key, a vendor command left alone).
 * A repeat of a held key whose action does not repeat comes back marked
 * `repeat: true`; the supervisor acts on the first of a burst and drops the
 * rest without a history line (eight a second would bury everything else).
 */
export function mappedIntent(map, code) {
  const c = controlForCode(code);
  if (!c) return null;
  const action = actionOf(map, c);
  const intent = intentOf(action);
  if (!intent) return null;
  const a = KEY_ACTION.get(action);
  const repeat = REPEATS.has(Number(code)) && !(a && a.repeatable);
  return { ...intent, control: c.id, mapping: action, ...(repeat ? { repeat: true } : {}) };
}

/** A short legend for a key, as the diagram prints it. */
export function legendOf(action) {
  const fixed = KEY_ACTION.get(action) || FADER_ACTIONS.find((a) => a.id === action)
    || ENCODER_ACTIONS.find((a) => a.id === action);
  if (fixed) return fixed.legend;
  const recall = RECALL.exec(String(action));
  if (recall) return `MEM ${recall[1]}`;
  const cmp = COMPANION.exec(String(action));
  if (cmp) return `CMP ${cmp[1]}/${cmp[2]}/${cmp[3]}`;
  return '?';
}

/** A sentence for an action, as the inspector prints it. */
export function describeAction(action) {
  const fixed = KEY_ACTION.get(action) || FADER_ACTIONS.find((a) => a.id === action)
    || ENCODER_ACTIONS.find((a) => a.id === action);
  if (fixed) return fixed.label;
  const recall = RECALL.exec(String(action));
  if (recall) return `Recall memory ${recall[1]} to preview on the selected screens`;
  const cmp = COMPANION.exec(String(action));
  if (cmp) return `Press Companion button ${cmp[1]}/${cmp[2]}/${cmp[3]}`;
  return 'Unknown';
}

/** How far one encoder detent moves `action`. */
export const encoderStep = (action) => (ENCODER_ACTIONS.find((a) => a.id === action) || {}).step || 0;
