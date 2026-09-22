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

/**
 * The consoles this understands, and where their control service listens.
 *
 * ⚠️ The ports are not a detail. A U5 / U5 Pro serves 19999 on **loopback**,
 * so this app has to run on the console itself to reach one. A U5 mini serves
 * 8088 on the LAN, so it is driven from wherever this app already runs, with
 * nothing installed on the console. That difference decides how a show is
 * rigged, and it is the reason the mini is the model to try first.
 */
export const CONSOLE_MODELS = Object.freeze([
  { id: 'u5mini', label: 'Pixelhue U5 mini', port: 8088, busWidth: 8, overLan: true },
  { id: 'u5pro', label: 'Pixelhue U5 Pro', port: 19999, busWidth: 8, overLan: false },
  { id: 'u5', label: 'Pixelhue U5', port: 19999, busWidth: 8, overLan: false },
]);

/** Unico's `AreaType`. The console's four buses, plus the device area. */
export const AREA = Object.freeze({
  printing: 0, screen: 1, device: 2, input: 3, layer: 4, preset: 5, custom: 6,
});

/**
 * The commands a console reports. Read out of Unico's own
 * `pages/editor1/common/enum.ts` and confirmed against a live UCenter for the
 * ones marked ✓ — the rest are the vendor's own numbering, unexercised.
 */
export const COMMAND = Object.freeze({
  deviceSelect: 0,
  deviceUnselect: 1,
  screenCreate: 100,
  screenSelect: 101,        // ✓
  screenActive: 102,
  screenUnselect: 103,
  layerSelect: 201,
  inputSwitch: 300,         // ✓
  savePreset: 400,
  playPreset: 401,          // ✓
  screenFreeze: 517,        // ✓
  screenFTB: 518,           // ✓
  matchPGM: 529,            // ✓
  pgmEdit: 530,             // ✓
  take: 531,                // ✓
  cut: 532,                 // ✓
  pageUp: 549,
  pageDown: 550,
});

const NAMES = Object.fromEntries(Object.entries(COMMAND).map(([k, v]) => [v, k]));
export const commandName = (code) => NAMES[code] ?? `command ${code}`;

/* Unico's own enums, for the values the model carries. */
const ENABLE = { off: 0, on: 1 };
const SCREEN_TYPE = { normal: 2, AUX: 4 };
const SOURCE_TYPE = { input: 2 };
const SCREEN_ACTIVE = { INACTIVATED: 1, PGM: 2, PVW: 4 };
const PLAY = { default: 1 };

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
 * @param {Array}  [facts.layers]     `{id, label}` for the selected destination
 * @param {object} [facts.selection]  `{destination, layer}` as we hold it
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

  return {
    screens: used.map((d, i) => ({
      uid: d.id,
      name: d.label || d.id,
      index: at(i),
      selected: d.id === selection.destination ? ENABLE.on : ENABLE.off,
      type: d.kind === 'aux' ? SCREEN_TYPE.AUX : SCREEN_TYPE.normal,
      activeRegion: SCREEN_ACTIVE.INACTIVATED,
      lockedPgm: ENABLE.on,
      originId: deviceId,
    })),

    layers: layers.slice(0, limits.layers).map((l, i) => ({
      attachScreenId: 1,
      attachScreenUid: selection.destination || (used[0] && used[0].id) || '',
      id: l.id,
      type: 0,
      region: 0,
      sourceType: SOURCE_TYPE.input,
      name: l.label || `Layer ${l.id}`,
      selected: l.id === selection.layer ? ENABLE.on : ENABLE.off,
      index: at(i),
      sourceId: 0,
      deviceSn: deviceId,
      serial: l.id,
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
    case COMMAND.screenActive:
      return { kind: 'select', destination: String(payload.uid || ''), at };
    case COMMAND.screenUnselect:
      return { kind: 'unselect', destination: String(payload.uid || ''), at };
    case COMMAND.layerSelect:
      return { kind: 'selectLayer', layer: Number(payload.id) || null, at };
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
    default: return null;
  }
}

/**
 * Turn an intent into device writes.
 *
 * @param {object} intent      from `readIntent`
 * @param {object} ctx
 * @param {object} ctx.dialect      `core/dialect.js`
 * @param {object} ctx.commands     `commandsFor(dialect)`
 * @param {string[]} ctx.selected   destinations the operator has selected
 * @param {number} ctx.layer        the selected layer
 * @param {string} ctx.buffer       'PREVIEW' or 'PROGRAM' — which the panel edits
 * @param {(id:string)=>string|null} ctx.letterFor
 *        the preset LETTER for `ctx.buffer` on that destination, read from the
 *        device. Returning null refuses the write rather than guessing.
 * @returns {{writes: Array<{path: string[], value: unknown}>, note: string}}
 */
export function writesFor(intent, ctx) {
  const { dialect, commands, selected = [], layer = 1, buffer = 'PREVIEW' } = ctx || {};
  const out = { writes: [], note: '' };
  if (!intent || !dialect || !commands) return { ...out, note: 'no platform yet' };
  if (!selected.length && NEEDS_DESTINATION.has(intent.kind)) {
    return { ...out, note: 'no destination selected on the panel' };
  }

  const each = (fn) => {
    for (const id of selected) {
      const built = fn(id);
      for (const cmd of [].concat(built || [])) if (cmd) out.writes.push(cmd);
    }
  };

  switch (intent.kind) {
    case 'take': each((id) => commands.take(id)); out.note = `take ${selected.join(' ')}`; break;
    case 'cut':  each((id) => commands.cut(id));  out.note = `cut ${selected.join(' ')}`;  break;
    case 'matchProgram':
      each((id) => commands.copyProgramToPreview(id));
      out.note = `program to preview on ${selected.join(' ')}`;
      break;
    case 'recall':
      if (!intent.slot) return { ...out, note: 'a recall with no slot' };
      /*
       * ⚠️ To PREVIEW, always, exactly as every other recall path in this app.
       * The console has a PGM EDIT key and it would be easy to honour it here;
       * a memory landing on air because a modifier was held two minutes ago is
       * not a risk worth the convenience. `docs/PIXELHUE.md` says so out loud.
       */
      each((id) => commands.recallScreenPreset(intent.slot, id, 'PREVIEW'));
      out.note = `recall ${intent.slot} to preview on ${selected.join(' ')}`;
      break;
    case 'source': {
      if (!intent.input) return { ...out, note: 'a source change with no input' };
      const spec = sourceSpec(dialect);
      if (!spec) return { ...out, note: 'this platform has no source parameter' };
      const value = dialect.id === 'nlc' ? `LIVE_${intent.input}` : `INPUT_${intent.input}`;
      for (const id of selected) {
        const letter = ctx.letterFor ? ctx.letterFor(id) : null;
        if (!letter) {
          /* The same refusal `server/osc.js` makes, for the same reason: a
             layer move landing in whichever buffer happened to be live is the
             failure this whole app is careful about. */
          return { writes: [], note: `refused — ${buffer} letter not known for ${id}` };
        }
        out.writes.push({
          path: dialect.layerParamPath(id, letter, layer, spec),
          value,
        });
      }
      out.note = `${value} on layer ${layer} of ${selected.join(' ')} (${buffer})`;
      break;
    }
    /* Reported, understood, and deliberately not acted on yet. */
    case 'ftb':
    case 'freeze':
      return { ...out, note: `${intent.kind} is not mapped on this platform yet` };
    default:
      return { ...out, note: `nothing to send for ${intent.kind}` };
  }
  return out;
}

const NEEDS_DESTINATION = new Set(['take', 'cut', 'matchProgram', 'recall', 'store', 'source']);

/** The path tail of the layer parameter naming a source, from the catalogue. */
function sourceSpec(dialect) {
  const list = (dialect.catalogue && dialect.catalogue.layer) || [];
  const found = list.find((p) => p.id === dialect.sourceParam);
  return found ? found.path : null;
}

/**
 * The panel's own selection, which is not device state.
 *
 * Nothing in the switcher records that an operator has three screens selected
 * on a console; the console reports select and unselect and this keeps score.
 * It is the same asymmetry `ui/properties-panel.js` describes for layers, and
 * it is why the panel makes the operator name a destination rather than
 * inheriting one.
 */
export class Selection {
  constructor() {
    this.destinations = new Set();
    this.layer = 1;
    this.buffer = 'PREVIEW';
  }

  apply(intent) {
    if (!intent) return this;
    if (intent.kind === 'select' && intent.destination) this.destinations.add(intent.destination);
    if (intent.kind === 'unselect') this.destinations.delete(intent.destination);
    if (intent.kind === 'selectLayer' && intent.layer) this.layer = intent.layer;
    /* PGM EDIT is a latch on the panel; here it only says which buffer the
       next source change edits, and it never changes where a recall lands. */
    if (intent.kind === 'pgmEdit') this.buffer = this.buffer === 'PREVIEW' ? 'PROGRAM' : 'PREVIEW';
    return this;
  }

  get list() { return [...this.destinations]; }
  describe() {
    return { destinations: this.list, layer: this.layer, buffer: this.buffer };
  }
}

/* ------------------------------------------------------------------ settings */

/**
 * The plugin's settings, and its settings schema's two functions.
 *
 * Off, and for the same reason as the OSC listener plus one more: this is a
 * preview, it has never been run against a console, and it writes to a
 * switcher. Nobody should find it on by surprise. The mini is the default
 * model because it is the one that can be driven over the LAN without
 * installing anything on the console.
 */
export const DEFAULT_PIXELHUE = {
  pixelhueEnabled: false,
  pixelhueHost: '',
  pixelhueModel: 'u5mini',
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
  };
}

/** True when a change needs the console link rebuilt rather than just noted. */
export const pixelhueChanged = (a, b) =>
  a.pixelhueEnabled !== b.pixelhueEnabled
  || a.pixelhueHost !== b.pixelhueHost
  || a.pixelhueModel !== b.pixelhueModel;
