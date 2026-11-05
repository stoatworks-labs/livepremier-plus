/*
 * A console's view of the switcher, read in bursts — shared by every console.
 *
 * A hardware console driving the switcher needs more than OSC does: screen
 * names, input names, memory names, which layers are fitted, and, before
 * every source change, which preset letter is preview. This reads all of it
 * with `server/awj.js`'s `exchange()` — a burst of `get`s on one connection,
 * which is then closed — and **holds nothing open on the switcher**.
 * `plugins/pixelhue/supervisor.js` argues at its head why that is enough and
 * what it gives up (live tally); the argument is the same for every console,
 * which is why the reading is too.
 *
 * Moved out of the Pixelhue supervisor (2026-10-20) when the Barco EC panel
 * arrived, so the two consoles read the switcher one way. What each console
 * then DOES with an intent is `src/core/console-intents.js`.
 *
 * Nothing here touches the store mirror, and no reply outlives its caller.
 */

import { exchange as awjExchange, AWJ_PORT } from './awj.js';
import { NLC, MNG } from '../src/core/dialect.js';
import { letterFor } from '../src/vendor/surface/preset.js';
import { toAwj } from '../src/core/paths.js';
import { layerSourcePath, readSource } from '../src/core/console-intents.js';

/* How much of a switcher to ask about. Bounded on purpose: these are `get`s in
   one burst, and a LivePremier has 24 screens and a thousand memory slots, of
   which a console with an eight-key bus wants the first few pages. A console
   with longer buses passes its own.

   `inputs` and `stills` are how many a console KEEPS, not how far it reads:
   every input slot the platform numbers is asked about (`dialect.inputSlots`),
   because the real ones follow the frame's cards and need not be the first
   few (`sourcesWanted`, below). 0 reads none. `masters` is how many master
   memory slots to read, from 1; 0, the default, reads none. */
export const DEFAULT_LIMITS = Object.freeze({
  screens: 24, auxes: 0, inputs: 24, memories: 32, masters: 0, layers: 16, stills: 24,
});

/* The order a console walks its input bus through, where they exist. */
export const SOURCE_KINDS = Object.freeze(['LIVE', 'STILL', 'SCREEN']);

const IDENTITY = {
  nlc: 'DeviceObject/system/$device/@items/1/@props/dev',
  mng: 'DeviceObject/system/@props/platformLabel',
};

export class ConsoleSwitcher {
  /**
   * @param {object} o
   * @param {() => string|null} o.deviceHost  the switcher's host, read per use
   *        (the app can be re-pointed under a console that is already talking)
   * @param {number} [o.awjPort]
   * @param {object} [o.limits]  how far along each list to read; see DEFAULT_LIMITS
   * @param {Function} [o.exchange]  `awj.js`'s `exchange` (a socket per burst),
   *        or an `AwjLink`'s, which holds one: `server/awj-link.js` says when
   */
  constructor({ deviceHost = () => null, awjPort = AWJ_PORT, limits = {}, exchange = awjExchange } = {}) {
    this.deviceHost = deviceHost;
    this.awjPort = awjPort;
    this.exchange = exchange;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    /** `core/dialect.js`'s NLC or MNG, once a read has identified the switcher. */
    this.dialect = null;
    /** The last `readFacts()`, or null. */
    this.facts = null;
  }

  /** Which platform the switcher is, from the one path each dialect answers. */
  async identify(host = this.deviceHost()) {
    if (!host) throw new Error('no switcher configured');
    const replies = await this.exchange({
      host,
      port: this.awjPort,
      messages: [{ op: 'get', path: IDENTITY.nlc }, { op: 'get', path: IDENTITY.mng }],
    });
    const answered = (path) => replies.find(
      (r) => r.path === path && typeof r.value === 'string' && r.value !== '',
    );
    if (answered(IDENTITY.nlc)) return NLC;
    if (answered(IDENTITY.mng)) return MNG;
    throw new Error(`${host} answered neither identity path — is AWJ enabled on it?`);
  }

  /**
   * Two bursts of AWJ `get`s, turned into the facts a console is drawn from:
   * destinations, every kind of source, memories (and the free slots), and the
   * fitted layers with their FTB and freeze state.
   */
  async readFacts() {
    const host = this.deviceHost();
    if (!host) throw new Error('no switcher configured');
    const { screens, auxes, inputs, memories, masters = 0, layers: layerLimit, stills } = this.limits;

    const dialect = await this.identify(host);
    const isNlc = dialect.id === 'nlc';
    const wanted = sourcesWanted(dialect, { inputs, stills });

    /* Enumerating a collection is not something AWJ does — `@itemKeys` answers
       null even for collections that exist — so the ids come from the
       platform's own fixed ranges and `isUsed` / `isValid` decide what is
       real. */
    const ids = isNlc
      ? [
        ...Array.from({ length: screens }, (_, i) => `S${i + 1}`),
        ...Array.from({ length: auxes }, (_, i) => `A${i + 1}`),
      ]
      : Array.from({ length: 4 }, (_, i) => `S${i + 1}`);

    const gets = [];
    for (const id of ids) {
      gets.push({ op: 'get', path: toAwj(dialect.takeStatus(id, 'isUsed')) });
      gets.push({ op: 'get', path: toAwj(labelPath(dialect, id)) });
    }
    /* Every slot the platform numbers is asked whether it is there; what the
       rest of the vendor's rule needs is asked of those that are, in the
       second burst (`sourcesWanted`). */
    for (const w of wanted) {
      for (const slot of w.slots) for (const path of w.first(slot)) gets.push({ op: 'get', path: toAwj(path) });
    }
    for (let slot = 1; slot <= memories; slot++) {
      const built = dialect.label('screen', slot, '');
      if (built) gets.push({ op: 'get', path: toAwj(built.path) });
      const valid = slotValidPath(dialect, slot);
      if (valid) gets.push({ op: 'get', path: toAwj(valid) });
    }
    for (let slot = 1; slot <= masters; slot++) {
      const built = dialect.label('master', slot, '');
      if (built) gets.push({ op: 'get', path: toAwj(built.path) });
      const valid = slotValidPath(dialect, slot, 'master');
      if (valid) gets.push({ op: 'get', path: toAwj(valid) });
    }

    const replies = await this.exchange({ host, port: this.awjPort, messages: gets });
    const byPath = new Map(replies.map((r) => [r.path, r.value]));
    const at = (path) => byPath.get(toAwj(path));

    const destinations = ids.map((id) => ({
      id,
      kind: id.startsWith('A') ? 'aux' : 'screen',
      label: String(at(labelPath(dialect, id)) || ''),
      isUsed: at(dialect.takeStatus(id, 'isUsed')) === true,
    }));

    const presets = [];
    const freeSlots = [];
    for (let slot = 1; slot <= memories; slot++) {
      const built = dialect.label('screen', slot, '');
      if (!built) continue;
      const label = byPath.get(toAwj(built.path));
      const valid = slotValidPath(dialect, slot);
      /* A slot with no label is not offered: a bus full of "Memory 17" that
         recalls nothing is worse than a short bus. A slot with no label AND no
         stored memory is free for a store into an empty key. ⚠️ Unlabelled is
         not empty — the simulator's slot 1 holds a memory with no name. */
      if (!label) {
        if (!valid || at(valid) !== true) freeSlots.push(slot);
        continue;
      }
      presets.push({ slot, label: String(label) });
    }

    /* Master memories: any that holds a memory or has a name, as the Web RCS
       lists them. Recalled only — a console stores and deletes screen
       memories, and a master memory's filters are the Web RCS's to set. */
    const masterList = [];
    for (let slot = 1; slot <= masters; slot++) {
      const built = dialect.label('master', slot, '');
      if (!built) continue;
      const label = String(byPath.get(toAwj(built.path)) || '');
      const valid = slotValidPath(dialect, slot, 'master');
      if (!label && !(valid && at(valid) === true)) continue;
      masterList.push({ slot, label });
    }

    /* Second burst, for what is there only: the fitted layers, the FTB and
       freeze lamps, and the rest of the vendor's rule for each source slot
       that answered "available" in the first. */
    const used = destinations.filter((d) => d.isUsed);
    const more = [];
    const probes = new Map(used.map((d) => [d.id, dialect.layerProbe(d.id, layerLimit)]));
    for (const d of used) {
      const probe = probes.get(d.id);
      for (const key of probe.slots) {
        more.push({ op: 'get', path: toAwj(probe.path(key)) });
        const frz = dialect.layerFreezePath(d.id, key);
        if (frz) more.push({ op: 'get', path: toAwj(frz) });
      }
      const ftb = dialect.fadeToBlackPath(d.id);
      if (ftb) more.push({ op: 'get', path: toAwj(ftb) });
    }
    const present = new Map(wanted.map((w) => [w.kind, w.slots.filter((n) => w.present(at, n))]));
    for (const w of wanted) {
      for (const n of present.get(w.kind)) for (const path of w.second(at, n)) more.push({ op: 'get', path: toAwj(path) });
    }
    const second = more.length ? await this.exchange({ host, port: this.awjPort, messages: more }) : [];
    const got = new Map(second.map((r) => [r.path, r.value]));
    const again = (path) => got.get(toAwj(path));
    const layers = [];
    for (const d of used) {
      const probe = probes.get(d.id);
      let anyFrozen = false;
      for (const key of probe.slots) {
        if (!probe.fitted(got.get(toAwj(probe.path(key))))) continue;
        layers.push({ destination: d.id, key: Number(key), label: `Layer ${key}` });
        const frz = dialect.layerFreezePath(d.id, key);
        const list = frz ? got.get(toAwj(frz)) : null;
        if (Array.isArray(list) && list.length) anyFrozen = true;
      }
      const ftb = dialect.fadeToBlackPath(d.id);
      d.faded = ftb ? got.get(toAwj(ftb)) === true : false;
      d.frozen = anyFrozen;
    }

    /* Everything an input bus can show, in the platform's own order and only
       what the vendor's source picker would offer now. A screen in service is
       a source on a LivePremier (SCREEN_n), as is a still. */
    const sources = { LIVE: [], STILL: [], SCREEN: [] };
    for (const w of wanted) {
      for (const n of present.get(w.kind)) {
        if (sources[w.kind].length >= w.keep) break;
        if (!w.offered(at, again, n)) continue;
        sources[w.kind].push({ number: n, source: w.source(n), label: w.label(at, again, n) });
      }
    }
    if (isNlc) {
      for (const d of destinations) {
        const m = /^S(\d+)$/.exec(d.id);
        if (m && d.isUsed) sources.SCREEN.push({ number: Number(m[1]), source: `SCREEN_${m[1]}`, label: d.label || d.id });
      }
    }
    const sourceKinds = SOURCE_KINDS.filter((k) => sources[k].length);

    this.dialect = dialect;
    this.facts = {
      dialect, destinations, sources, sourceKinds, presets, masters: masterList, layers, freeSlots, deviceId: host,
    };
    return this.facts;
  }

  /** One burst of `get`s, answered by path. */
  async read(paths) {
    const host = this.deviceHost();
    if (!host || !paths.length) return new Map();
    const replies = await this.exchange({
      host, port: this.awjPort, messages: paths.map((p) => ({ op: 'get', path: toAwj(p) })),
    });
    return new Map(replies.map((r) => [r.path, r.value]));
  }

  /** One read per destination, answered by destination. */
  async readEach(ids, pathOf) {
    const paths = ids.map(pathOf).filter(Boolean);
    const got = await this.read(paths);
    return new Map(ids.map((id) => {
      const path = pathOf(id);
      return [id, path ? got.get(toAwj(path)) : undefined];
    }));
  }

  /** Whether each destination is faded to black now. */
  async fadedFor(ids) {
    const dialect = this.dialect;
    const paths = ids.map((id) => dialect.fadeToBlackPath(id)).filter(Boolean);
    const got = await this.read(paths);
    const out = new Map();
    for (const id of ids) {
      const path = dialect.fadeToBlackPath(id);
      const v = path ? got.get(toAwj(path)) : undefined;
      out.set(id, typeof v === 'boolean' ? v : null);
    }
    return out;
  }

  /**
   * What freezing each destination's program means now: the preset
   * destination on air (`'UP'` when program is the group's up preset) and
   * every fitted layer's freeze list.
   */
  async freezeFor(ids) {
    const dialect = this.dialect;
    const props = ['presetUp', 'presetDown', 'presetPrevious'];
    const paths = [];
    const plan = new Map();
    for (const id of ids) {
      const keys = ((this.facts && this.facts.layers) || [])
        .filter((l) => l.destination === id).map((l) => String(l.key));
      plan.set(id, keys);
      for (const p of props) paths.push(dialect.takeControl(id, p));
      paths.push(dialect.takeStatus(id, 'transition'));
      for (const key of keys) {
        const frz = dialect.layerFreezePath(id, key);
        if (frz) paths.push(frz);
      }
    }
    const got = await this.read(paths);
    const out = new Map();
    for (const id of ids) {
      const control = Object.fromEntries(props.map((p) => [p, got.get(toAwj(dialect.takeControl(id, p)))]));
      const group = {
        control: { pp: control },
        status: { pp: { transition: got.get(toAwj(dialect.takeStatus(id, 'transition'))) } },
      };
      const onAir = letterFor('PROGRAM', group);
      const programDest = onAir && onAir === control.presetUp ? 'UP'
        : onAir && onAir === control.presetDown ? 'DOWN' : null;
      const layers = [];
      for (const key of plan.get(id)) {
        const frz = dialect.layerFreezePath(id, key);
        const list = frz ? got.get(toAwj(frz)) : null;
        if (Array.isArray(list)) layers.push({ key, freeze: list.map(String) });
      }
      out.set(id, { programDest, layers });
    }
    return out;
  }

  /** Which preset letter is `buffer` ('PREVIEW' | 'PROGRAM'), read from the device now. */
  async lettersFor(ids, buffer = 'PREVIEW') {
    const host = this.deviceHost();
    const dialect = this.dialect;
    if (!host || !dialect || !ids.length) return new Map();
    const props = ['presetUp', 'presetDown', 'presetPrevious'];
    const gets = [];
    for (const id of ids) {
      for (const prop of props) gets.push({ op: 'get', path: toAwj(dialect.takeControl(id, prop)) });
      gets.push({ op: 'get', path: toAwj(dialect.takeStatus(id, 'transition')) });
    }
    const replies = await this.exchange({ host, port: this.awjPort, messages: gets });
    const byPath = new Map(replies.map((r) => [r.path, r.value]));
    const out = new Map();
    for (const id of ids) {
      const group = {
        control: { pp: Object.fromEntries(props.map((p) => [p, byPath.get(toAwj(dialect.takeControl(id, p)))])) },
        status: { pp: { transition: byPath.get(toAwj(dialect.takeStatus(id, 'transition'))) } },
      };
      out.set(id, letterFor(buffer, group));
    }
    return out;
  }

  /**
   * What is on one layer in program and in preview, per destination — the
   * tally an ATEM-style bus shows. Two bursts: the letters, as `lettersFor`
   * reads them, then the layer's source under each. `{program, preview}` are
   * `readSource`'s `{kind, number}` or null; a destination whose letters could
   * not be read is left out rather than guessed.
   */
  async tallyFor(ids, layer) {
    const dialect = this.dialect;
    const spec = dialect ? layerSourcePath(dialect) : null;
    if (!dialect || !spec || !ids.length) return new Map();
    const props = ['presetUp', 'presetDown', 'presetPrevious'];
    const first = [];
    for (const id of ids) {
      for (const p of props) first.push(dialect.takeControl(id, p));
      first.push(dialect.takeStatus(id, 'transition'));
    }
    const got = await this.read(first);
    const letters = new Map();
    for (const id of ids) {
      const group = {
        control: { pp: Object.fromEntries(props.map((p) => [p, got.get(toAwj(dialect.takeControl(id, p)))])) },
        status: { pp: { transition: got.get(toAwj(dialect.takeStatus(id, 'transition'))) } },
      };
      const program = letterFor('PROGRAM', group);
      const preview = letterFor('PREVIEW', group);
      if (program && preview) letters.set(id, { program, preview });
    }
    const second = [];
    for (const [id, l] of letters) {
      second.push(dialect.layerParamPath(id, l.program, layer, spec));
      second.push(dialect.layerParamPath(id, l.preview, layer, spec));
    }
    const sources = await this.read(second);
    const out = new Map();
    for (const [id, l] of letters) {
      out.set(id, {
        layer,
        program: readSource(sources.get(toAwj(dialect.layerParamPath(id, l.program, layer, spec)))),
        preview: readSource(sources.get(toAwj(dialect.layerParamPath(id, l.preview, layer, spec)))),
      });
    }
    return out;
  }

  /**
   * Where each destination's T-bar rests, 0 or 65535, or null where it could
   * not be read. Read once per stroke: `tbarWrites` (console-intents.js) says
   * why a stroke needs it.
   */
  async restsFor(ids) {
    const paths = ids.map((id) => this.dialect.takeStatus(id, 'tbarPosition'));
    const got = await this.read(paths);
    return new Map(ids.map((id) => {
      const v = got.get(toAwj(this.dialect.takeStatus(id, 'tbarPosition')));
      return [id, typeof v === 'number' ? (v >= 32768 ? 65535 : 0) : null];
    }));
  }

  /** Writes from `writesFor` / `tbarWrites`, as one burst of AWJ `replace`s. */
  async write(writes) {
    const host = this.deviceHost();
    if (!host) throw new Error('no switcher configured');
    if (!writes.length) return [];
    return this.exchange({
      host,
      port: this.awjPort,
      messages: writes.map((w) => ({ op: 'replace', path: toAwj(w.path), value: w.value })),
    });
  }
}

/** Where a memory slot says it holds something, beside its label. */
export function slotValidPath(dialect, slot, kind = 'screen') {
  const bank = dialect.bankFor && dialect.bankFor(kind);
  if (!bank || !dialect.slotList) return null;
  return [...dialect.slotList(bank), 'items', String(slot), 'status', 'pp', 'isValid'];
}

/**
 * Which inputs and stills a console reads, and the rule that says one is
 * offered — `dialect.sourceOffered`'s rule, asked over AWJ by a reader with no
 * store. One entry per kind of source, each with:
 *
 * - `slots`: every number the platform gives that kind (`dialect.inputSlots`,
 *   `stillSlots`), so a frame whose real inputs are IN_1–IN_8 and IN_17–IN_32
 *   is read whole. Asking only the first few was the U5 mini's "inputs stop at
 *   24" (2026-11-05): a frame's logical inputs follow its cards, and a
 *   DisplayPort card running DP 1.2 takes its even-numbered ports.
 * - `first(n)`: the paths asked of every slot — whether it is there at all.
 * - `present(at, n)`: whether it answered that it is.
 * - `second(at, n)`: what else is asked of those, in the second burst.
 * - `offered(at, again, n)` and `label(at, again, n)`, from both bursts.
 * - `keep`: how many the console keeps, in order (`limits.inputs` / `stills`).
 *
 * nlc, as the vendor's source picker (6.2.73 bundle,
 * `availableInputAsSourceKeysSelector`): `status/pp/isAvailable` and
 * `isEnabled` on the input, and the APPLIED preconfig's `global` is `USED`.
 * `isEnabled` is the switch the Preconfig page's Inputs tab sets, so an input
 * the operator has turned off there is off the console too; a grouped or
 * preempted input is not `USED`. Stills the same, against `stillList` and
 * `preconfig/stills/current`. mng: `INPUT_<n>`, `status/pp/isAvailable`, and
 * the label on the active plug (`dialect.sources`) — before 2026-11-05 this
 * read nlc's `mapping` on a Midra's `1`..`n` keys and found no inputs at all.
 */
export function sourcesWanted(dialect, { inputs = 0, stills = 0 } = {}) {
  const range = (count) => Array.from({ length: count }, (_, i) => i + 1);
  const D = 'device';
  if (dialect.id === 'nlc') {
    const usable = (list, applied) => ({
      first: (n) => [[D, list, 'items', applied.key(n), 'status', 'pp', 'isAvailable']],
      present: (at, n) => at([D, list, 'items', applied.key(n), 'status', 'pp', 'isAvailable']) === true,
      second: (at, n) => [
        [D, list, 'items', applied.key(n), 'status', 'pp', 'isEnabled'],
        [D, 'preconfig', applied.tree, 'current', list, 'items', applied.key(n), 'status', 'pp', 'global'],
        [D, list, 'items', applied.key(n), 'control', 'pp', 'label'],
      ],
      offered: (at, again, n) => {
        if (again([D, list, 'items', applied.key(n), 'status', 'pp', 'isEnabled']) !== true) return false;
        const global = again([D, 'preconfig', applied.tree, 'current', list, 'items', applied.key(n), 'status', 'pp', 'global']);
        /* A preconfig that does not answer decides nothing, as in `sourceOffered`. */
        return global === undefined || global === null || global === 'USED';
      },
      label: (at, again, n) => String(again([D, list, 'items', applied.key(n), 'control', 'pp', 'label']) || ''),
    });
    const out = [];
    if (inputs > 0) {
      out.push({
        kind: 'LIVE', slots: range(dialect.inputSlots || 0), keep: inputs, source: (n) => `LIVE_${n}`,
        ...usable('inputList', { key: (n) => `IN_${n}`, tree: 'inputs' }),
      });
    }
    if (stills > 0) {
      const still = usable('stillList', { key: (n) => String(n), tree: 'stills' });
      out.push({
        kind: 'STILL', slots: range(dialect.stillSlots || 0), keep: stills, source: (n) => `STILL_${n}`,
        ...still,
        label: (at, again, n) => still.label(at, again, n) || `STILL_${n}`,
      });
    }
    return out;
  }
  if (inputs <= 0) return [];
  const node = (n) => [D, 'inputList', 'items', `INPUT_${n}`];
  const plugOf = (at, n) => String(at([...node(n), 'status', 'pp', 'plug']) || '1');
  return [{
    kind: 'LIVE', slots: range(dialect.inputSlots || 0), keep: inputs, source: (n) => `INPUT_${n}`,
    first: (n) => [[...node(n), 'status', 'pp', 'isAvailable'], [...node(n), 'status', 'pp', 'plug']],
    present: (at, n) => at([...node(n), 'status', 'pp', 'isAvailable']) === true,
    second: (at, n) => [[...node(n), 'plugList', 'items', plugOf(at, n), 'control', 'pp', 'label']],
    offered: () => true,
    label: (at, again, n) => String(again([...node(n), 'plugList', 'items', plugOf(at, n), 'control', 'pp', 'label']) || ''),
  }];
}

/**
 * Where a destination keeps its name.
 *
 * ⚠️ The two dialects disagree about how to get there and only one of them has
 * `split`: on LivePremier `S1` is the key of `screenList`, and on a Midra the
 * same identifier means screen 1 of `screenList` keyed plain `1`. Asking the
 * dialect rather than spelling either is the whole point of `core/dialect.js`.
 *
 * ⚠️ `split` answers `{list, key}`, not a pair. Until 2026-10-20 this read it
 * as `[list, key]`, which throws on a Midra or Alta, so the Pixelhue panel's
 * first read failed on that platform; `test/console-switcher.test.js` pins it.
 */
export function labelPath(dialect, id) {
  const s = dialect.split ? dialect.split(id) : null;
  const listName = s ? s.list : dialect.listNameFor(id);
  const key = s ? String(s.key) : String(id);
  return ['device', listName, 'items', key, 'control', 'pp', 'label'];
}

/** What went to the switcher, spelled as AWJ paths, for a history. */
export function sentDetail(writes) {
  return writes.map((w) => ({ path: toAwj(w.path), value: w.value }));
}
