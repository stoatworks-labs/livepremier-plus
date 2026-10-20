/*
 * What a console's intents do to a switcher — shared by every console.
 *
 * A console, however it reports itself, ends up asking for the same handful of
 * things: select these destinations, this layer, put that source on it, recall
 * that memory, take, cut, fade to black, freeze, move the T-bar. The Pixelhue
 * panel reports them as commands about a model it was given; a Barco EC panel
 * reports bare key indexes that this app gives a meaning. What each one then
 * WRITES is the same, and it lives here once so the two cannot drift: a take on
 * one console and a take on the other are one function.
 *
 * Moved out of `plugins/pixelhue/core.js` (2026-10-20) when the second console
 * arrived, unchanged; that file re-exports it, so nothing that imported it
 * from there had to move. A plugin never imports another plugin's folder
 * (AGENTS.md), so shared engines live in `src/core/` like this one.
 *
 * Same rule as everything in `src/core/`: no I/O. The caller supplies what
 * must be read from the device — which preset letter is preview, whether a
 * screen is faded — because guessing either is how a change lands on air.
 */

/**
 * Turn an intent into device writes.
 *
 * @param {object} intent      a console's intent (Pixelhue `readIntent`, Barco EC `keyIntent`)
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
      const spec = layerSourcePath(dialect);
      if (!spec) return { ...out, note: 'this platform has no source parameter' };
      /* SIGNAL SOURCE moves the input bus between live inputs, stills and
         screens; the key's id is the number within whichever it shows. */
      const kind = ctx.sourceKind || 'LIVE';
      const value = dialect.id === 'nlc' ? `${kind}_${intent.input}` : `INPUT_${intent.input}`;
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
    case 'time': {
      /*
       * TIME adds 0.1 s to the take time, CTRL + TIME takes it off, and a held
       * TIME repeats. Clamped to PixelFlow's own range, 0.1 s to 10 s
       * (`FuncsCommand.ts`: SWITCH_MIN_TIME / SWITCH_MAX_TIME), each screen
       * from where it is now.
       */
      if (!dialect.fadeTimePath || !dialect.fadeCmds) {
        return { ...out, note: 'transition time is not mapped on this platform yet' };
      }
      const now = selected.map((id) => (ctx.timeOf ? ctx.timeOf(id) : null));
      if (now.some((v) => !Number.isFinite(v))) {
        return { ...out, note: 'refused — could not read the take time' };
      }
      const next = now.map((v) => Math.min(TIME_MAX, Math.max(TIME_MIN, v + (intent.delta || 0))));
      selected.forEach((id, i) => out.writes.push(...dialect.fadeCmds(id, next[i])));
      const shown = [...new Set(next)].map((t) => `${(t / 10).toFixed(1)} s`).join(' / ');
      out.note = `take time ${shown} on ${selected.join(' ')}`;
      break;
    }
    case 'swap': {
      /*
       * SWAP is a latch: on, a take swaps preview and program; off, preview
       * keeps a copy of what went on air. A LivePremier keeps the same switch
       * per take group, the other way up, as `copyMode`. One answer for the
       * selection: if every screen swaps, all of them stop; otherwise all swap.
       */
      if (!dialect.copyModePath || !dialect.copyModePath(selected[0])) {
        return { ...out, note: 'swap is not mapped on this platform yet' };
      }
      const now = selected.map((id) => (ctx.copyModeOf ? ctx.copyModeOf(id) : null));
      if (now.some((v) => typeof v !== 'boolean')) {
        return { ...out, note: 'refused — could not read the take mode' };
      }
      const swapping = now.every((v) => v === false);
      for (const id of selected) out.writes.push({ path: dialect.copyModePath(id), value: swapping });
      out.note = `${swapping ? 'swap off — a take copies' : 'swap on — a take swaps'} on ${selected.join(' ')}`;
      break;
    }
    case 'deletePreset': {
      /*
       * DEL armed, then a preset key. The console asks for exactly this, in
       * two deliberate presses, and disarms DEL itself afterwards. A memory
       * slot belongs to the bank, not to a screen, so no selection is needed.
       */
      if (!intent.slot) return { ...out, note: 'a delete with no slot' };
      const del = dialect.delete && dialect.delete('screen', intent.slot);
      if (!del) return { ...out, note: 'this platform cannot delete that memory' };
      out.writes.push(del);
      out.note = `delete memory ${intent.slot}${intent.label ? ` "${intent.label}"` : ''}`;
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

/* PixelFlow's take-time range, in tenths. */
const TIME_MIN = 1;
const TIME_MAX = 100;

const NEEDS_DESTINATION = new Set([
  'take', 'cut', 'matchProgram', 'recall', 'store', 'source', 'ftb', 'freeze', 'time', 'swap',
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

/**
 * How far a stroke has gone, 0…1, for a T-bar that reports where the lever IS
 * (`tbarWrites` wants how far through a take it is, and maps that onto each
 * screen's own rest). A stroke from the bottom counts up, from the top counts
 * down; which end it started from is wherever the lever rested before it
 * moved, nearest end. So the second throw — back the way it came — is a take
 * too, as on an Event Master Toolset or an ATEM.
 *
 * Moved here from the Barco EC panel (2026-10-20) when the ATEM Micro Panel,
 * whose T-bar reports its position the same way, arrived.
 */
export function strokeProgress(startFraction, nowFraction) {
  const fromBottom = startFraction < 0.5;
  const p = fromBottom ? nowFraction : 1 - nowFraction;
  return Math.max(0, Math.min(1, p));
}

/* A lever within this of an end has arrived: the last few counts of travel
   are mechanical slack. */
export const STROKE_END = 0.995;

/**
 * A layer's source as the switcher spells it, read back: `{kind, number}`, or
 * null for anything that is not an input, a still or a screen (no source, a
 * colour). The inverse of how `writesFor`'s `source` spells it — `LIVE_3`,
 * `STILL_2`, `SCREEN_1` on a LivePremier, `INPUT_3` on a Midra or Alta — kept
 * beside it so the two cannot drift.
 */
export function readSource(value) {
  const m = /^(LIVE|STILL|SCREEN|INPUT)_(\d+)$/.exec(String(value ?? ''));
  if (!m) return null;
  return { kind: m[1] === 'INPUT' ? 'LIVE' : m[1], number: Number(m[2]) };
}

/* ------------------------------------------------------------ layer steps */

/**
 * The layer a step lands on, among a screen's fitted layers. Clamped rather
 * than wrapped: a key held on the top layer should stay there, not jump to
 * the bottom.
 */
export function stepLayer(fitted, current, to) {
  const keys = [...new Set((fitted || []).map(Number))].filter(Number.isFinite).sort((a, b) => a - b);
  if (!keys.length) return null;
  if (to === 'first') return keys[0];
  if (to === 'last') return keys[keys.length - 1];
  const i = keys.indexOf(Number(current));
  if (i < 0) return to === 'next' ? keys.find((k) => k > current) ?? keys[keys.length - 1] : [...keys].reverse().find((k) => k < current) ?? keys[0];
  return keys[Math.min(keys.length - 1, Math.max(0, i + (to === 'next' ? 1 : -1)))];
}

/**
 * The path tail of the layer parameter naming a source, from the catalogue.
 * Exported for reading a layer's source back (`ConsoleSwitcher.tallyFor`),
 * so the write and the read cannot name different parameters.
 */
export function layerSourcePath(dialect) {
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