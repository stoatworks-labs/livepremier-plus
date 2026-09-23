/*
 * The Pixelhue panel supervisor.  ** PREVIEW **
 *
 * Holds one console link, feeds it a model of the switcher, and turns what it
 * reports back into writes. `core.js` beside this has the reasoning for the
 * model-and-intents shape; `ucenter.js` has the one for holding a socket open;
 * `server.js` puts it on the app as a plugin.
 *
 * ## It reads the switcher in bursts, and holds nothing open on it
 *
 * There is no store mirror in this process — `server/osc.js` says so and
 * refuses `preview`/`program` for exactly that reason. A panel needs rather
 * more than OSC does: screen names, input names, memory names, and, before
 * every source change, which preset letter is preview.
 *
 * All of it is read with `server/awj.js`'s `exchange()` — a burst of `get`s on
 * one connection, which is then closed. **This deliberately does not open a
 * subscription**, and that is not an oversight:
 *
 * - The rule in `awj.js` stands until something needs to beat it, and a
 *   refresh-on-demand panel does not.
 * - A letter read at the moment of the write is a fact about the device. A
 *   letter read from a mirror is our opinion of it, and the whole app is
 *   careful about that distinction.
 * - It costs one round trip per source change on a local network. That is
 *   cheaper than the class of bug a stale mirror produces.
 *
 * What this gives up is **live tally**: a memory recalled from the Web RCS, or
 * a take fired from the front panel, does not relight the console's keys until
 * the next refresh. That is the honest limit of the preview, it is written
 * down in `docs/PIXELHUE.md`, and closing it is what a scoped subscription
 * would be *for* — at which point `awj.js`'s argument has to be beaten
 * properly, in writing, the way `plugins/matrix-routing/routers/` did.
 */

import { EventEmitter } from 'node:events';

import { exchange, AWJ_PORT } from '../../server/awj.js';
import { UCenterLink } from './ucenter.js';
import { NLC, MNG } from '../../src/core/dialect.js';
import { commandsFor } from '../../src/core/commands.js';
import { letterFor } from '../../src/vendor/surface/preset.js';
import { toAwj } from '../../src/core/paths.js';
import {
  businessModel, readIntent, writesFor, tbarWrites, Selection, commandName, CONSOLE_MODELS,
  MIDI_BINDINGS, readMidi, midiWrite, layerParam,
} from './core.js';

export { CONSOLE_MODELS };

/* How much of a switcher to ask about. Bounded on purpose: these are `get`s in
   one burst, and a LivePremier has 24 screens, 20-odd inputs and a thousand
   memory slots, of which a console with an eight-key bus wants the first few
   pages. */
const SCREENS = 24;
const INPUTS = 24;
const MEMORIES = 32;
const LAYERS = 16;
const STILLS = 24;
/* The order SIGNAL SOURCE walks the input bus through, where they exist. */
const SOURCE_KINDS = ['LIVE', 'STILL', 'SCREEN'];
/* A fader or encoder gesture with no move for this long is over; its history
   line is written then, not once per step. */
const GESTURE_IDLE_MS = 500;
const HISTORY = 40;

/* A console that has lost the model shows a panel with no labels. Noticing
   that and publishing again is bounded so two publishers on one UCenter cannot
   hammer each other: at most one republish in this window. */
const REPUBLISH_MIN_MS = 3000;
/* A key-state batch this long is a whole-panel redraw, not a key press. */
const FULL_REDRAW_KEYS = 40;
/* A T-bar stroke with no report for this long is over. */
const STROKE_IDLE_MS = 2000;

const IDENTITY = {
  nlc: 'DeviceObject/system/$device/@items/1/@props/dev',
  mng: 'DeviceObject/system/@props/platformLabel',
};

export class PixelhueSupervisor extends EventEmitter {
  #link = null;
  #config = null;
  #dialect = null;
  #facts = null;
  #names = new Set();
  #lastRepublish = 0;
  #republishTimer = null;
  #stroke = null;
  #sourceKind = 'LIVE';
  #locked = false;
  #controls = new Map();

  /**
   * @param {object} opts
   * @param {() => string|null} opts.deviceHost  the switcher, as the proxy knows it
   */
  constructor({ deviceHost = () => null, awjPort = AWJ_PORT, log = () => {} } = {}) {
    super();
    this.deviceHost = deviceHost;
    this.awjPort = awjPort;
    this.log = log;
    this.selection = new Selection();
    this.history = [];
  }

  /* --------------------------------------------------------------- lifecycle */

  /**
   * Bring the link into line with the settings. Idempotent and diff-based, the
   * same as `MatrixSupervisor.apply` — renaming nothing must not drop a panel
   * an operator is holding.
   */
  async apply(settings) {
    const want = settings && settings.pixelhueEnabled && settings.pixelhueHost
      ? {
        host: settings.pixelhueHost,
        model: settings.pixelhueModel,
        port: portFor(settings.pixelhueModel),
      }
      : null;

    const same = want && this.#config
      && want.host === this.#config.host && want.port === this.#config.port;
    if (same) { this.#config = want; return this.describe(); }

    if (this.#link) { await this.#link.stop(); this.#link = null; }
    this.#config = want;
    this.selection.reset();
    this.#sourceKind = 'LIVE';
    this.#locked = false;
    if (!want) { this.#note({ kind: 'stopped' }); return this.describe(); }

    const link = new UCenterLink({ host: want.host, port: want.port, log: this.log });
    this.#link = link;
    link.on('open', () => { this.#note({ kind: 'connected' }); void this.refresh(); });
    link.on('close', () => this.#note({ kind: 'disconnected' }));
    link.on('failure', (err) => this.#note({ kind: 'error', error: err.message }));
    link.on('command', (report) => { void this.#onCommand(report); });
    link.on('keystate', (items) => this.#watchForWipe(items));
    link.on('tbar', (report) => this.#onTbar(report));
    link.on('midi', (report) => this.#onMidi(report));
    link.start();
    this.#note({ kind: 'starting', host: want.host, port: want.port, model: want.model });
    return this.describe();
  }

  async stop() {
    if (this.#link) { await this.#link.stop(); this.#link = null; }
    this.#config = null;
    this.selection.reset();
    clearTimeout(this.#republishTimer); this.#republishTimer = null;
    this.#endStroke();
  }

  /* ------------------------------------------------------------- the switcher */

  /** One burst of AWJ `get`s, turned into the facts a model is built from. */
  async readFacts() {
    const host = this.deviceHost();
    if (!host) throw new Error('no switcher configured');

    const dialect = await this.#identify(host);
    const isNlc = dialect.id === 'nlc';

    /* Enumerating a collection is not something AWJ does — `@itemKeys` answers
       null even for collections that exist — so the ids come from the
       platform's own fixed ranges and `isUsed` / `isValid` decide what is
       real. */
    const ids = isNlc
      ? Array.from({ length: SCREENS }, (_, i) => `S${i + 1}`)
      : Array.from({ length: 4 }, (_, i) => `S${i + 1}`);

    const gets = [];
    for (const id of ids) {
      gets.push({ op: 'get', path: toAwj(dialect.takeStatus(id, 'isUsed')) });
      gets.push({ op: 'get', path: toAwj(labelPath(dialect, id)) });
    }
    for (let n = 1; n <= INPUTS; n++) {
      const key = isNlc ? `IN_${n}` : String(n);
      gets.push({ op: 'get', path: toAwj(['device', 'inputList', 'items', key, 'mapping', 'pp', 'isValid']) });
      gets.push({ op: 'get', path: toAwj(['device', 'inputList', 'items', key, 'control', 'pp', 'label']) });
    }
    if (isNlc) {
      for (let n = 1; n <= STILLS; n++) {
        gets.push({ op: 'get', path: toAwj(['device', 'stillList', 'items', String(n), 'mapping', 'pp', 'isValid']) });
        gets.push({ op: 'get', path: toAwj(['device', 'stillList', 'items', String(n), 'control', 'pp', 'label']) });
      }
    }
    for (let slot = 1; slot <= MEMORIES; slot++) {
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

    /* Everything the input bus can show; SIGNAL SOURCE picks which. A screen
       in service is a source on a LivePremier (SCREEN_n), as is a still. */
    const sources = { LIVE: [], STILL: [], SCREEN: [] };
    for (let n = 1; n <= INPUTS; n++) {
      const key = isNlc ? `IN_${n}` : String(n);
      if (at(['device', 'inputList', 'items', key, 'mapping', 'pp', 'isValid']) !== true) continue;
      const label = String(at(['device', 'inputList', 'items', key, 'control', 'pp', 'label']) || '');
      sources.LIVE.push({ number: n, source: isNlc ? `LIVE_${n}` : `INPUT_${n}`, label });
    }
    if (isNlc) {
      for (let n = 1; n <= STILLS; n++) {
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
    if (!sourceKinds.includes(this.#sourceKind)) this.#sourceKind = 'LIVE';
    const inputs = sources[this.#sourceKind];

    const presets = [];
    const freeSlots = [];
    for (let slot = 1; slot <= MEMORIES; slot++) {
      const built = dialect.label('screen', slot, '');
      if (!built) continue;
      const label = byPath.get(toAwj(built.path));
      const valid = slotValidPath(dialect, slot);
      /* A slot with no label is not published: a bus full of "Memory 17" that
         recalls nothing is worse than a short bus. A slot with no label AND no
         stored memory is free for SAVE TO on an empty key. ⚠️ Unlabelled is
         not empty — the simulator's slot 1 holds a memory with no name. */
      if (!label) {
        if (!valid || at(valid) !== true) freeSlots.push(slot);
        continue;
      }
      presets.push({ slot, label: String(label) });
    }

    /* Second burst, for what is in service only: the fitted layers (the layer
       bus), and the FTB and freeze lamps. */
    const used = destinations.filter((d) => d.isUsed);
    const more = [];
    const probes = new Map(used.map((d) => [d.id, dialect.layerProbe(d.id, LAYERS)]));
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

    this.#dialect = dialect;
    this.#facts = { destinations, inputs, presets, layers, freeSlots, sourceKinds, deviceId: host };
    return this.#facts;
  }

  /** The model for the facts in hand and the selection as it stands. */
  #modelFrom(facts) {
    return businessModel({
      ...facts,
      selection: {
        destinations: this.selection.list,
        layer: this.selection.layer,
        buffer: this.selection.buffer,
      },
    });
  }

  /** Read the switcher and hand the console a fresh model. */
  async refresh() {
    if (!this.#link) return null;
    try {
      const facts = await this.readFacts();
      const model = this.#modelFrom(facts);
      await this.#link.publish(model);
      this.#remember(model);
      this.selection.restrict(model.screens.map((s) => s.uid));
      await this.#bindControls();
      this.#note({
        kind: 'published',
        screens: model.screens.length,
        layers: model.layers.length,
        inputs: model.inputs.length,
        presets: model.presets.length,
      });
      return model;
    } catch (err) {
      this.#note({ kind: 'error', error: err.message });
      return null;
    }
  }

  /**
   * Bind the faders and encoders to this app. Without it UCenter drops their
   * moves; with it, each move arrives on tag 0x0010031c (see `MIDI_BINDINGS`).
   * Done on every publish, because the table is shared: PixelFlow binding its
   * own controls takes them away.
   */
  async #bindControls() {
    try {
      await this.#link.bindControls(MIDI_BINDINGS);
    } catch (err) {
      this.#note({ kind: 'error', error: `binding faders and encoders: ${err.message}` });
    }
  }

  /** The labels a panel showing our model carries — how a wipe is noticed. */
  #remember(model) {
    this.#names = new Set([...model.screens, ...model.inputs, ...model.presets]
      .map((o) => o.name).filter(Boolean));
  }

  /** One burst of `get`s, answered by path. */
  async #read(paths) {
    const host = this.deviceHost();
    if (!host || !paths.length) return new Map();
    const replies = await exchange({
      host, port: this.awjPort, messages: paths.map((p) => ({ op: 'get', path: toAwj(p) })),
    });
    return new Map(replies.map((r) => [r.path, r.value]));
  }

  /** One read per destination, answered by destination. */
  async #readEach(ids, pathOf) {
    const paths = ids.map(pathOf).filter(Boolean);
    const got = await this.#read(paths);
    return new Map(ids.map((id) => {
      const path = pathOf(id);
      return [id, path ? got.get(toAwj(path)) : undefined];
    }));
  }

  /** Whether each destination is faded to black now. */
  async #fadedFor(ids) {
    const dialect = this.#dialect;
    const paths = ids.map((id) => dialect.fadeToBlackPath(id)).filter(Boolean);
    const got = await this.#read(paths);
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
  async #freezeFor(ids) {
    const dialect = this.#dialect;
    const props = ['presetUp', 'presetDown', 'presetPrevious'];
    const paths = [];
    const plan = new Map();
    for (const id of ids) {
      const keys = ((this.#facts && this.#facts.layers) || [])
        .filter((l) => l.destination === id).map((l) => String(l.key));
      plan.set(id, keys);
      for (const p of props) paths.push(dialect.takeControl(id, p));
      paths.push(dialect.takeStatus(id, 'transition'));
      for (const key of keys) {
        const frz = dialect.layerFreezePath(id, key);
        if (frz) paths.push(frz);
      }
    }
    const got = await this.#read(paths);
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

  /** Which preset letter is the panel's buffer, read from the device now. */
  async #lettersFor(ids) {
    const host = this.deviceHost();
    const dialect = this.#dialect;
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
      out.set(id, letterFor(this.selection.buffer, group));
    }
    return out;
  }

  /* ----------------------------------------------------------------- intents */

  async #onCommand(report) {
    const intent = readIntent(report);
    const code = report && report.command;
    if (!intent) {
      this.#note({ kind: 'ignored', command: commandName(code), code });
      return;
    }

    /* LOCK PANEL (a long press) latches; while it is on, the panel changes
       nothing but the lock. */
    if (intent.kind === 'lock') {
      this.#locked = !this.#locked;
      this.#note({ kind: 'noted', command: commandName(code), code, note: this.#locked ? 'panel locked' : 'panel unlocked' });
      return;
    }
    if (this.#locked) {
      this.#note({ kind: 'noted', command: commandName(code), code, note: 'ignored — the panel is locked' });
      return;
    }

    if (intent.kind === 'sourceType') {
      const kinds = (this.#facts && this.#facts.sourceKinds) || ['LIVE'];
      const next = kinds[(kinds.indexOf(this.#sourceKind) + 1) % kinds.length] || 'LIVE';
      this.#sourceKind = next;
      this.#note({ kind: 'noted', command: commandName(code), code, note: `input bus shows ${next.toLowerCase()} sources` });
      void this.refresh();
      return;
    }

    if (!this.selection.accepts(intent)) {
      this.#note({
        kind: 'noted',
        command: commandName(code),
        code,
        note: `refused — ${intent.destination || 'that screen'} is not one this app published`,
      });
      return;
    }

    const before = this.selection.describe();
    this.selection.apply(intent);
    const selectionMoved = JSON.stringify(before) !== JSON.stringify(this.selection.describe());

    let action = intent;
    if (intent.kind === 'store' && !intent.slot) {
      /* SAVE TO on an EMPTY key reports no slot; the next free one is used
         and named, so the new memory shows on the bus. */
      const slot = this.#facts && this.#facts.freeSlots && this.#facts.freeSlots[0];
      if (!slot) {
        this.#note({ kind: 'noted', command: commandName(code), code, note: `refused — no free memory slot in 1–${MEMORIES}` });
        return;
      }
      action = { ...intent, slot, label: `Memory ${slot}` };
    }

    let letters = new Map();
    let faded = new Map();
    let freeze = new Map();
    let times = new Map();
    let copyModes = new Map();
    try {
      if (intent.kind === 'source') letters = await this.#lettersFor(this.selection.list);
      if (intent.kind === 'ftb' && this.#dialect) faded = await this.#fadedFor(this.selection.list);
      if (intent.kind === 'freeze' && this.#dialect) freeze = await this.#freezeFor(this.selection.list);
      if (intent.kind === 'time' && this.#dialect) times = await this.#readEach(this.selection.list, (id) => this.#dialect.fadeTimePath(id));
      if (intent.kind === 'swap' && this.#dialect && this.#dialect.copyModePath) {
        copyModes = await this.#readEach(this.selection.list, (id) => this.#dialect.copyModePath(id));
      }
    } catch (err) {
      this.#note({ kind: 'error', command: commandName(code), code, error: err.message });
      return;
    }

    const { writes, note } = writesFor(action, {
      dialect: this.#dialect,
      commands: commandsFor(this.#dialect),
      selected: this.selection.list,
      layer: this.selection.layer,
      buffer: this.selection.buffer,
      letterFor: (id) => letters.get(id) || null,
      fadedOf: (id) => (faded.has(id) ? faded.get(id) : null),
      freezeOf: (id) => freeze.get(id) || null,
      timeOf: (id) => (times.has(id) ? Number(times.get(id)) : null),
      copyModeOf: (id) => (copyModes.has(id) ? copyModes.get(id) : null),
      sourceKind: this.#sourceKind,
    });

    if (!writes.length) {
      this.#note({ kind: 'noted', command: commandName(code), code, note });
      if (selectionMoved) void this.#republish();
      return;
    }

    const host = this.deviceHost();
    if (!host) { this.#note({ kind: 'error', command: commandName(code), code, error: 'no switcher configured' }); return; }
    try {
      await exchange({
        host,
        port: this.awjPort,
        messages: writes.map((w) => ({ op: 'replace', path: toAwj(w.path), value: w.value })),
      });
      this.#note({ kind: 'sent', command: commandName(code), code, note, writes: writes.length, sent: sentDetail(writes) });
    } catch (err) {
      this.#note({ kind: 'error', command: commandName(code), code, error: err.message });
    }
    /* A new memory, or an FTB / freeze lamp, is device state the model has to
       be read again for; a selection change only needs the model re-sent. */
    if (REREAD.has(intent.kind)) void this.refresh();
    else if (selectionMoved) void this.#republish();
  }

  /* ------------------------------------------------------------ the T-bar */

  /**
   * One report from the lever. Where each selected destination rests is read
   * once, at the start of the stroke (`tbarWrites` says why); after that each
   * report becomes a write, one in flight at a time and the newest winning, so
   * a lever moved fast does not queue a backlog of stale positions.
   */
  #onTbar(report) {
    if (!this.#dialect || !this.selection.list.length) return;
    if (!this.#stroke) {
      this.#stroke = { ids: this.selection.list, rests: null, pending: null, busy: false, timer: null };
      void this.#readRests(this.#stroke);
    }
    const stroke = this.#stroke;
    stroke.pending = report;
    clearTimeout(stroke.timer);
    stroke.timer = setTimeout(() => this.#endStroke(), STROKE_IDLE_MS);
    if (stroke.timer.unref) stroke.timer.unref();
    void this.#pumpTbar();
  }

  async #readRests(stroke) {
    try {
      const paths = stroke.ids.map((id) => this.#dialect.takeStatus(id, 'tbarPosition'));
      const got = await this.#read(paths);
      stroke.rests = new Map(stroke.ids.map((id) => {
        const v = got.get(toAwj(this.#dialect.takeStatus(id, 'tbarPosition')));
        return [id, typeof v === 'number' ? (v >= 32768 ? 65535 : 0) : null];
      }));
      this.#note({ kind: 'noted', command: 'tbar', note: `T-bar stroke on ${stroke.ids.join(' ')}` });
    } catch (err) {
      this.#note({ kind: 'error', command: 'tbar', error: err.message });
      this.#endStroke();
      return;
    }
    void this.#pumpTbar();
  }

  async #pumpTbar() {
    const stroke = this.#stroke;
    if (!stroke || stroke.busy || !stroke.rests || !stroke.pending) return;
    const report = stroke.pending;
    stroke.pending = null;
    stroke.busy = true;
    const { writes, progress } = tbarWrites(report, {
      dialect: this.#dialect,
      selected: stroke.ids,
      restOf: (id) => stroke.rests.get(id) ?? null,
    });
    try {
      if (writes.length) {
        stroke.lastSent = sentDetail(writes);
        await exchange({
          host: this.deviceHost(),
          port: this.awjPort,
          messages: writes.map((w) => ({ op: 'replace', path: toAwj(w.path), value: w.value })),
        });
      }
    } catch (err) {
      this.#note({ kind: 'error', command: 'tbar', error: err.message });
    }
    stroke.busy = false;
    if (progress >= 1) {
      this.#note({
        kind: 'sent', command: 'tbar', note: `T-bar completed on ${stroke.ids.join(' ')}`, sent: stroke.lastSent || [],
      });
      this.#endStroke();
      return;
    }
    if (stroke.pending) void this.#pumpTbar();
  }

  #endStroke() {
    if (!this.#stroke) return;
    clearTimeout(this.#stroke.timer);
    this.#stroke = null;
  }

  /* ----------------------------------------------- faders and encoders */

  /**
   * One move of a bound fader or encoder. Each control keeps one write in
   * flight: a fader's newest position wins, an encoder's detents add up while
   * a write is out. The history gets one line per gesture, when it stops.
   */
  #onMidi(report) {
    if (this.#locked || !this.#dialect) return;
    const move = readMidi(report);
    if (!move) return;
    const key = `${move.control}.${move.index}`;
    let c = this.#controls.get(key);
    if (!c) { c = { busy: false, pending: null, ticks: 0, last: null, timer: null }; this.#controls.set(key, c); }
    if (move.control === 'fader') c.pending = move;
    else { c.ticks += move.ticks; c.pending = { ...move, ticks: c.ticks }; }
    clearTimeout(c.timer);
    c.timer = setTimeout(() => {
      if (c.last) this.#note({ kind: 'sent', command: key, note: c.last.note, sent: c.last.sent });
      c.last = null;
    }, GESTURE_IDLE_MS);
    if (c.timer.unref) c.timer.unref();
    void this.#pumpControl(c);
  }

  async #pumpControl(c) {
    if (c.busy || !c.pending) return;
    const move = c.pending;
    c.pending = null;
    if (move.control === 'encoder') c.ticks = 0;
    c.busy = true;
    try {
      const destination = this.selection.list[this.selection.list.length - 1];
      if (!destination) return;
      const letters = await this.#lettersFor([destination]);
      const letter = letters.get(destination);
      let current;
      if (move.control === 'encoder') {
        const name = { 1: 'posH', 2: 'posV', 3: 'sizeH', 4: 'sizeV' }[move.index];
        const spec = layerParam(this.#dialect, name);
        if (spec && letter) {
          const path = this.#dialect.layerParamPath(destination, letter, this.selection.layer, spec.path);
          const got = await this.#read([path]);
          current = Number(got.get(toAwj(path)));
        }
      }
      const w = midiWrite(move, {
        dialect: this.#dialect, destination, letter, layer: this.selection.layer, current,
      });
      if (!w.path) { c.last = { note: w.note, sent: [] }; return; }
      await exchange({
        host: this.deviceHost(),
        port: this.awjPort,
        messages: [{ op: 'replace', path: toAwj(w.path), value: w.value }],
      });
      c.last = { note: w.note, sent: sentDetail([w]) };
    } catch (err) {
      this.#note({ kind: 'error', command: `${move.control}.${move.index}`, error: err.message });
    } finally {
      c.busy = false;
      if (c.pending) void this.#pumpControl(c);
    }
  }

  /* ------------------------------------------------------ a wiped console */

  /**
   * ⚠️ The console's UCenter drops a published model when another PixelFlow
   * client connects — a whole-panel key-state redraw arrives with every label
   * gone — and says nothing to the publisher. Found 2026-09-23 by reloading
   * the virtual U5. So a whole-panel redraw carrying none of our labels means
   * publish again; bounded, because two publishers on one UCenter would
   * otherwise take turns forever.
   */
  #watchForWipe(items) {
    if (!Array.isArray(items) || items.length < FULL_REDRAW_KEYS || !this.#names.size) return;
    if (items.some((k) => k && this.#names.has(k.text))) return;
    if (this.#republishTimer) return;
    const wait = Math.max(500, this.#lastRepublish + REPUBLISH_MIN_MS - Date.now());
    this.#republishTimer = setTimeout(() => {
      this.#republishTimer = null;
      this.#lastRepublish = Date.now();
      this.#note({ kind: 'noted', note: 'the console dropped the model; publishing it again' });
      void this.refresh();
    }, wait);
    if (this.#republishTimer.unref) this.#republishTimer.unref();
  }

  /** Re-send the model so the panel's lamps agree with the selection we hold. */
  async #republish() {
    if (!this.#link || !this.#facts) return;
    try {
      const model = this.#modelFrom(this.#facts);
      await this.#link.publish(model);
      this.#remember(model);
    } catch (err) {
      this.#note({ kind: 'error', error: err.message });
    }
  }

  /* -------------------------------------------------------------- reporting */

  #note(entry) {
    const full = { at: Date.now(), ...entry };
    this.history.unshift(full);
    if (this.history.length > HISTORY) this.history.length = HISTORY;
    if (entry.error) this.log(`panel: ${entry.error}`);
    this.emit('activity', full);
  }

  describe() {
    return {
      preview: true,
      configured: !!this.#config,
      model: this.#config ? this.#config.model : null,
      host: this.#config ? this.#config.host : null,
      port: this.#config ? this.#config.port : null,
      platform: this.#dialect ? this.#dialect.name : null,
      link: this.#link ? this.#link.state : null,
      selection: this.selection.describe(),
      sourceKind: this.#sourceKind,
      locked: this.#locked,
      history: this.history.slice(0, 12),
    };
  }

  async #identify(host) {
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
}

/**
 * Where a destination keeps its name.
 *
 * ⚠️ The two dialects disagree about how to get there and only one of them has
 * `split`: on LivePremier `S1` is the key of `screenList`, and on a Midra the
 * same identifier means screen 1 of `screenList` keyed plain `1`. Asking the
 * dialect rather than spelling either is the whole point of `core/dialect.js`.
 */
/**
 * What went to the switcher, spelled as AWJ paths, for the history. The
 * settings card shows only the note; this is for anyone checking what a key
 * really did — pixelhue-re's press inspector reads it off `/state`.
 */
function sentDetail(writes) {
  return writes.map((w) => ({ path: toAwj(w.path), value: w.value }));
}

/* Intents after which the model must be read again, not just re-sent. */
const REREAD = new Set(['store', 'ftb', 'freeze', 'time', 'swap']);

/** Where a memory slot says it holds something, beside its label. */
function slotValidPath(dialect, slot) {
  const bank = dialect.bankFor && dialect.bankFor('screen');
  if (!bank || !dialect.slotList) return null;
  return [...dialect.slotList(bank), 'items', String(slot), 'status', 'pp', 'isValid'];
}

function labelPath(dialect, id) {
  const [listName, key] = dialect.split ? dialect.split(id) : [dialect.listNameFor(id), id];
  return ['device', listName, 'items', key, 'control', 'pp', 'label'];
}

export const portFor = (model) =>
  (CONSOLE_MODELS.find((m) => m.id === model) || CONSOLE_MODELS[0]).port;
