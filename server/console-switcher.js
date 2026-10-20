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

import { exchange, AWJ_PORT } from './awj.js';
import { NLC, MNG } from '../src/core/dialect.js';
import { letterFor } from '../src/vendor/surface/preset.js';
import { toAwj } from '../src/core/paths.js';
import { layerSourcePath, readSource } from '../src/core/console-intents.js';

/* How much of a switcher to ask about. Bounded on purpose: these are `get`s in
   one burst, and a LivePremier has 24 screens, 20-odd inputs and a thousand
   memory slots, of which a console with an eight-key bus wants the first few
   pages. A console with longer buses passes its own. */
export const DEFAULT_LIMITS = Object.freeze({
  screens: 24, auxes: 0, inputs: 24, memories: 32, layers: 16, stills: 24,
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
   */
  constructor({ deviceHost = () => null, awjPort = AWJ_PORT, limits = {} } = {}) {
    this.deviceHost = deviceHost;
    this.awjPort = awjPort;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    /** `core/dialect.js`'s NLC or MNG, once a read has identified the switcher. */
    this.dialect = null;
    /** The last `readFacts()`, or null. */
    this.facts = null;
  }

  /** Which platform the switcher is, from the one path each dialect answers. */
  async identify(host = this.deviceHost()) {
    if (!host) throw new Error('no switcher configured');
    const replies = await exchange({
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
    const { screens, auxes, inputs, memories, layers: layerLimit, stills } = this.limits;

    const dialect = await this.identify(host);
    const isNlc = dialect.id === 'nlc';

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
    for (let n = 1; n <= inputs; n++) {
      const key = isNlc ? `IN_${n}` : String(n);
      gets.push({ op: 'get', path: toAwj(['device', 'inputList', 'items', key, 'mapping', 'pp', 'isValid']) });
      gets.push({ op: 'get', path: toAwj(['device', 'inputList', 'items', key, 'control', 'pp', 'label']) });
    }
    if (isNlc) {
      for (let n = 1; n <= stills; n++) {
        gets.push({ op: 'get', path: toAwj(['device', 'stillList', 'items', String(n), 'mapping', 'pp', 'isValid']) });
        gets.push({ op: 'get', path: toAwj(['device', 'stillList', 'items', String(n), 'control', 'pp', 'label']) });
      }
    }
    for (let slot = 1; slot <= memories; slot++) {
      const built = dialect.label('screen', slot, '');
      if (built) gets.push({ op: 'get', path: toAwj(built.path) });
      const valid = slotValidPath(dialect, slot);
      if (valid) gets.push({ op: 'get', path: toAwj(valid) });
    }

    const replies = await exchange({ host, port: this.awjPort, messages: gets });
    const byPath = new Map(replies.map((r) => [r.path, r.value]));
    const at = (path) => byPath.get(toAwj(path));

    const destinations = ids.map((id) => ({
      id,
      kind: id.startsWith('A') ? 'aux' : 'screen',
      label: String(at(labelPath(dialect, id)) || ''),
      isUsed: at(dialect.takeStatus(id, 'isUsed')) === true,
    }));

    /* Everything an input bus can show. A screen in service is a source on a
       LivePremier (SCREEN_n), as is a still. */
    const sources = { LIVE: [], STILL: [], SCREEN: [] };
    for (let n = 1; n <= inputs; n++) {
      const key = isNlc ? `IN_${n}` : String(n);
      if (at(['device', 'inputList', 'items', key, 'mapping', 'pp', 'isValid']) !== true) continue;
      const label = String(at(['device', 'inputList', 'items', key, 'control', 'pp', 'label']) || '');
      sources.LIVE.push({ number: n, source: isNlc ? `LIVE_${n}` : `INPUT_${n}`, label });
    }
    if (isNlc) {
      for (let n = 1; n <= stills; n++) {
        if (at(['device', 'stillList', 'items', String(n), 'mapping', 'pp', 'isValid']) !== true) continue;
        const label = String(at(['device', 'stillList', 'items', String(n), 'control', 'pp', 'label']) || '');
        sources.STILL.push({ number: n, source: `STILL_${n}`, label: label || `STILL_${n}` });
      }
      for (const d of destinations) {
        const m = /^S(\d+)$/.exec(d.id);
        if (m && d.isUsed) sources.SCREEN.push({ number: Number(m[1]), source: `SCREEN_${m[1]}`, label: d.label || d.id });
      }
    }
    const sourceKinds = SOURCE_KINDS.filter((k) => sources[k].length);

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

    /* Second burst, for what is in service only: the fitted layers, and the
       FTB and freeze lamps. */
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
    const second = more.length ? await exchange({ host, port: this.awjPort, messages: more }) : [];
    const got = new Map(second.map((r) => [r.path, r.value]));
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

    this.dialect = dialect;
    this.facts = { dialect, destinations, sources, sourceKinds, presets, layers, freeSlots, deviceId: host };
    return this.facts;
  }

  /** One burst of `get`s, answered by path. */
  async read(paths) {
    const host = this.deviceHost();
    if (!host || !paths.length) return new Map();
    const replies = await exchange({
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
    const replies = await exchange({ host, port: this.awjPort, messages: gets });
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
    return exchange({
      host,
      port: this.awjPort,
      messages: writes.map((w) => ({ op: 'replace', path: toAwj(w.path), value: w.value })),
    });
  }
}

/** Where a memory slot says it holds something, beside its label. */
export function slotValidPath(dialect, slot) {
  const bank = dialect.bankFor && dialect.bankFor('screen');
  if (!bank || !dialect.slotList) return null;
  return [...dialect.slotList(bank), 'items', String(slot), 'status', 'pp', 'isValid'];
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
