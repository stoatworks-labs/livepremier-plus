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
  layerEffectTimeAdd: 509,  // ✓ TIME
  screenFreeze: 517,        // ✓
  screenFTB: 518,           // ✓
  presetSave: 520,          // ✓ SAVE TO arms / disarms
  switchDel: 521,           // ✓ DEL arms / disarms
  matchPGM: 529,            // ✓
  pgmEdit: 530,             // ✓
  take: 531,                // ✓
  cut: 532,                 // ✓
  swap: 533,                // ✓
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
 * @param {(id:string)=>boolean|null} [ctx.fadedOf]
 *        whether that destination is faded to black now, read from the device
 * @param {(id:string)=>{programDest:string, layers:Array<{key:string, freeze:string[]}>}|null} [ctx.freezeOf]
 *        the preset destination (`'UP'`/`'DOWN'`) on air, and each fitted
 *        layer's freeze list, read from the device
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
    case 'store': {
      /*
       * SAVE TO, then a preset key. A published key reports its slot; an
       * EMPTY key reports `id: 0`, and the caller has already chosen a free
       * slot and a label for it (`intent.slot`, `intent.label`). The buffer
       * saved is the one the panel edits — preview unless PGM EDIT is on.
       */
      /*
       * ⚠️ From the ACTIVE screen only. A bank slot holds one preset — one
       * layer set, one screen size — not one per screen, so saving the same
       * slot from each selected screen keeps only the last and recalls it
       * everywhere. Found on the simulator 2026-09-23: S2 recalled S1's layers.
       */
      if (!intent.slot) return { ...out, note: 'a store with no slot' };
      const from = selected[selected.length - 1];
      const save = dialect.save('screen', intent.slot, { mode: buffer, id: from });
      if (!save) return { ...out, note: 'this platform cannot store that memory' };
      out.writes.push(save);
      if (intent.label) out.writes.push(dialect.label('screen', intent.slot, intent.label));
      out.note = `store ${buffer} of ${from} to memory ${intent.slot}`
        + (intent.label ? ` as "${intent.label}"` : '');
      break;
    }
    case 'ftb': {
      /*
       * A toggle on the panel; a bool per destination on the switcher. One
       * answer for the whole selection, as the Web RCS gives: if anything
       * selected is still up, everything fades out; only when all of it is
       * black does the key fade back in.
       */
      if (!dialect.fadeToBlackPath || !dialect.fadeToBlackPath(selected[0])) {
        return { ...out, note: 'fade to black is not mapped on this platform yet' };
      }
      const now = selected.map((id) => (ctx.fadedOf ? ctx.fadedOf(id) : null));
      if (now.some((v) => v === null || v === undefined)) {
        return { ...out, note: 'refused — could not read whether the selection is faded' };
      }
      const target = !now.every(Boolean);
      for (const id of selected) out.writes.push({ path: dialect.fadeToBlackPath(id), value: target });
      out.note = `${target ? 'fade to black' : 'fade up'} ${selected.join(' ')}`;
      break;
    }
    case 'freeze': {
      /*
       * Freeze what is on air. A layer's freeze is a list of preset
       * destinations, so freezing adds the on-air one ('UP' or 'DOWN') to
       * every fitted layer and unfreezing takes it out — leaving any other
       * destination the operator froze from the Web RCS alone.
       */
      if (!dialect.layerFreezePath || !selected.some((id) => dialect.layerFreezePath(id, 1))) {
        return { ...out, note: 'freeze is not mapped on this platform yet' };
      }
      const states = new Map(selected.map((id) => [id, ctx.freezeOf ? ctx.freezeOf(id) : null]));
      const usable = [...states].filter(([id, st]) => st && dialect.layerFreezePath(id, 1));
      if (!usable.length || usable.some(([, st]) => !st.programDest)) {
        return { ...out, note: 'refused — could not read what is on air to freeze' };
      }
      const frozen = usable.every(([, st]) => st.layers.length
        && st.layers.every((l) => l.freeze.includes(st.programDest)));
      const target = !frozen;
      for (const [id, st] of usable) {
        for (const l of st.layers) {
          const next = target
            ? [...new Set([...l.freeze, st.programDest])]
            : l.freeze.filter((d) => d !== st.programDest);
          out.writes.push({ path: dialect.layerFreezePath(id, l.key), value: next });
        }
      }
      out.note = `${target ? 'freeze' : 'unfreeze'} ${usable.map(([id]) => id).join(' ')}`;
      break;
    }
    default:
      return { ...out, note: `nothing to send for ${intent.kind}` };
  }
  return out;
}

const NEEDS_DESTINATION = new Set([
  'take', 'cut', 'matchProgram', 'recall', 'store', 'source', 'ftb', 'freeze',
]);

/**
 * One T-bar report as `tbarPosition` writes.
 *
 * ⚠️ The console reports progress **within a stroke** — `mapValue` of
 * `maxValue`, 0 at the start of a throw and full at its end, whichever way the
 * lever travels — not where the lever sits. A LivePremier's `tbarPosition` is
 * absolute: from rest at 0 a throw to 65535 completes the take, and from rest
 * at 65535 a throw back to 0 does. So the mapping needs where each destination
 * RESTED when the stroke began (`restOf`), read once per stroke; the console's
 * own `direction` is not trusted, because a take fired from a key leaves the
 * lever and the switcher at opposite ends.
 *
 * @param {{mapValue:number, maxValue:number, percent:number}} report
 * @param {object} ctx `{dialect, selected, restOf(id) -> 0 | 65535 | null}`
 */
export function tbarWrites(report, ctx) {
  const { dialect, selected = [], restOf = () => null } = ctx || {};
  if (!dialect || !selected.length || !report) return { writes: [], progress: null };
  const max = Number(report.maxValue) || 0;
  const raw = max > 0 ? Number(report.mapValue) / max : Number(report.percent) / 100;
  if (!Number.isFinite(raw)) return { writes: [], progress: null };
  const progress = Math.min(1, Math.max(0, raw));
  const writes = [];
  for (const id of selected) {
    const rest = restOf(id);
    if (rest !== 0 && rest !== 65535) continue;
    const value = Math.round(rest === 0 ? progress * 65535 : (1 - progress) * 65535);
    writes.push({ path: dialect.takeControl(id, 'tbarPosition'), value });
  }
  return { writes, progress };
}

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
    this.reset();
  }

  /**
   * Back to nothing selected and nothing published. A link that is rebuilt
   * or stopped starts here: a selection outliving its console is how a
   * screen from some other app's model ended up as a take target.
   */
  reset() {
    this.destinations = new Set();
    this.layer = 1;
    this.buffer = 'PREVIEW';
    /* The uids the console was last given, or null before the first publish. */
    this.known = null;
    return this;
  }

  /**
   * Hold only what was just published. ⚠️ A console's UCenter is shared: on
   * a U5 the vendor's own software publishes its model to the same service,
   * the panel then shows *its* screens, and pressing one reports a uid that
   * means nothing to this switcher. Found on 2026-09-23 with PixelFlow's P20
   * project open beside this app.
   */
  restrict(uids) {
    this.known = new Set(uids);
    for (const id of this.destinations) if (!this.known.has(id)) this.destinations.delete(id);
    return this;
  }

  /** False for a select of anything this app did not publish. */
  accepts(intent) {
    if (!intent || (intent.kind !== 'select' && intent.kind !== 'activate')) return true;
    return !!this.known && this.known.has(intent.destination);
  }

  apply(intent) {
    if (!intent) return this;
    if (intent.kind === 'select' && intent.destination && this.accepts(intent)) {
      this.destinations.add(intent.destination);
    }
    /* The last one in is the active one (`businessModel` publishes it so), so
       activating is moving a destination to the end. */
    if (intent.kind === 'activate' && intent.destination && this.accepts(intent)) {
      this.destinations.delete(intent.destination);
      this.destinations.add(intent.destination);
    }
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
