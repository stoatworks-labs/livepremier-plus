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
import { ConsoleSwitcher, sentDetail } from '../../server/console-switcher.js';
import { UCenterLink } from './ucenter.js';
import { commandsFor } from '../../src/core/commands.js';
import { toAwj } from '../../src/core/paths.js';
import {
  businessModel, readIntent, writesFor, tbarWrites, Selection, commandName, CONSOLE_MODELS,
  MIDI_BINDINGS, readMidi, midiWrite, layerParam,
  stepLayer, companionLocation, backupRequest, SILENT_KEY_MODES,
} from './core.js';
import {
  mappedIntent, controlForKeyMode, controlById, actionOf, intentOf, resolvedMap,
} from './mapping.js';

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
/* A fader or encoder gesture with no move for this long is over; its history
   line is written then, not once per step. */
const GESTURE_IDLE_MS = 500;
/* A key that reports no command is only acted on when none followed it this
   long — SOURCE BACKUP shares its key with functions that do report one. */
const SILENT_KEY_WAIT_MS = 400;
/* An open page renews its claim to run page-side actions this often; a claim
   this old has lapsed (the page was closed). */
const RUNNER_LEASE_MS = 12000;
const HISTORY = 40;
/* A held key repeats about every 125 ms. A repeat after a gap this long is
   the start of a new hold. */
const REPEAT_GAP_MS = 400;

/* A console that has lost the model shows a panel with no labels. Noticing
   that and publishing again is bounded so two publishers on one UCenter cannot
   hammer each other: at most one republish in this window. */
const REPUBLISH_MIN_MS = 3000;
/* A key-state batch this long is a whole-panel redraw, not a key press. */
const FULL_REDRAW_KEYS = 40;
/* A T-bar stroke with no report for this long is over. */
const STROKE_IDLE_MS = 2000;

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
  #settings = {};
  #silentKeys = new Map();
  #keyDownAt = new Map();
  #lastCommandAt = 0;
  #lastInput = null;
  #runner = null;
  /* What the console shows on each key, as it last said: key code →
     `{text, state, page}`. The Pixelhue Mapping page draws from it. */
  #keys = new Map();
  #lastPress = null;
  #repeatAt = new Map();

  /**
   * @param {object} opts
   * @param {() => string|null} opts.deviceHost  the switcher, as the proxy knows it
   */
  constructor({
    deviceHost = () => null, awjPort = AWJ_PORT, log = () => {}, companion = () => null, settings = null,
  } = {}) {
    super();
    this.deviceHost = deviceHost;
    /* The Companion plugin's service, asked for per use: it may be switched
       on or off under a running panel. */
    this.companion = companion;
    /* Settings read per use. `apply` is only called for a change to the link
       fields (`pixelhueChanged`), so a transport change would never arrive. */
    this.settingsNow = settings;
    this.awjPort = awjPort;
    this.log = log;
    this.switcher = new ConsoleSwitcher({
      deviceHost: () => this.deviceHost(),
      awjPort,
      limits: { screens: SCREENS, inputs: INPUTS, memories: MEMORIES, layers: LAYERS, stills: STILLS },
    });
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
    /* Transport and the rest are read per use, so a change to them needs no
       redial — only the link fields below do. */
    this.#settings = settings || {};
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
    this.#keys = new Map();
    this.#lastPress = null;
    if (!want) { this.#note({ kind: 'stopped' }); return this.describe(); }

    const link = new UCenterLink({ host: want.host, port: want.port, log: this.log });
    this.#link = link;
    link.on('open', () => { this.#note({ kind: 'connected' }); void this.refresh(); void this.#readKeyMap(); });
    link.on('close', () => this.#note({ kind: 'disconnected' }));
    link.on('failure', (err) => this.#note({ kind: 'error', error: err.message }));
    link.on('command', (report) => { void this.#onCommand(report); });
    link.on('keystate', (items) => {
      this.#watchForWipe(items);
      this.#watchSilentKeys(items);
      this.#mirrorKeys(items);
    });
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

  /**
   * The switcher, read in two bursts (`server/console-switcher.js`, shared
   * with every console), with the input bus showing whichever kind of source
   * SIGNAL SOURCE last chose.
   */
  async readFacts() {
    const facts = await this.switcher.readFacts();
    if (!facts.sourceKinds.includes(this.#sourceKind)) this.#sourceKind = 'LIVE';
    const { destinations, sources, presets, layers, freeSlots, sourceKinds, deviceId } = facts;
    this.#dialect = facts.dialect;
    this.#facts = { destinations, inputs: sources[this.#sourceKind], presets, layers, freeSlots, sourceKinds, deviceId };
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

  /* The switcher reads below are `server/console-switcher.js`'s. */
  #read(paths) { return this.switcher.read(paths); }
  #readEach(ids, pathOf) { return this.switcher.readEach(ids, pathOf); }
  #fadedFor(ids) { return this.switcher.fadedFor(ids); }
  #freezeFor(ids) { return this.switcher.freezeFor(ids); }
  #lettersFor(ids) { return this.switcher.lettersFor(ids, this.selection.buffer); }

  /* ----------------------------------------------------------------- intents */

  async #onCommand(report) {
    const code = report && report.command;
    if (code) this.#lastCommandAt = Date.now();
    /* A function key goes through the mapping table (`mapping.js`); a bus
       key, a mode key and the rest are what the console says they are. */
    const mapped = mappedIntent(this.#current().pixelhueMap, code);
    if (mapped && mapped.repeat) {
      const now = Date.now();
      const last = this.#repeatAt.get(mapped.control) || 0;
      this.#repeatAt.set(mapped.control, now);
      if (now - last < REPEAT_GAP_MS) return;
    }
    const intent = mapped || readIntent(report);
    if (!intent) {
      this.#note({ kind: 'ignored', command: nameOf(code), code });
      return;
    }
    await this.#perform(intent, code);
  }

  /**
   * Act on one intent. `code` is the command that asked for it, or the name
   * of a key that reports none (MVR, SOURCE BACKUP) — it is only ever used to
   * say, in the history, which key did this.
   */
  async #perform(intent, code) {
    if (intent.kind === 'none') {
      const c = intent.control && controlById(intent.control);
      this.#note({ kind: 'noted', command: nameOf(code), code, note: `${c ? c.label : 'that key'} is mapped to nothing` });
      return;
    }

    /* LOCK PANEL (a long press) latches; while it is on, the panel changes
       nothing but the lock. */
    if (intent.kind === 'lock') {
      this.#locked = !this.#locked;
      this.#note({ kind: 'noted', command: nameOf(code), code, note: this.#locked ? 'panel locked' : 'panel unlocked' });
      return;
    }
    if (this.#locked) {
      this.#note({ kind: 'noted', command: nameOf(code), code, note: 'ignored — the panel is locked' });
      return;
    }

    if (intent.kind === 'sourceType') {
      const kinds = (this.#facts && this.#facts.sourceKinds) || ['LIVE'];
      const next = kinds[(kinds.indexOf(this.#sourceKind) + 1) % kinds.length] || 'LIVE';
      this.#sourceKind = next;
      this.#note({ kind: 'noted', command: nameOf(code), code, note: `input bus shows ${next.toLowerCase()} sources` });
      void this.refresh();
      return;
    }

    if (intent.kind === 'transport') { await this.#transport(intent.action, code); return; }
    if (intent.kind === 'page') { this.#toPage({ type: intent.type, paths: intent.paths }, intent.what, code); return; }
    if (intent.kind === 'inputBackup') { this.#openBackup(code); return; }
    if (intent.kind === 'companion') { await this.#pressCompanion(intent.location, code, 'Companion'); return; }
    if (intent.kind === 'layerStep') { this.#stepLayer(intent.to, code); return; }
    if (intent.kind === 'source' && this.#sourceKind === 'LIVE' && intent.input) this.#lastInput = intent.input;

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
        this.#note({ kind: 'noted', command: nameOf(code), code, note: `refused — no free memory slot in 1–${MEMORIES}` });
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
      this.#note({ kind: 'error', command: nameOf(code), code, error: err.message });
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
      this.#note({ kind: 'noted', command: nameOf(code), code, note });
      if (selectionMoved) void this.#republish();
      return;
    }

    const host = this.deviceHost();
    if (!host) { this.#note({ kind: 'error', command: nameOf(code), code, error: 'no switcher configured' }); return; }
    try {
      await exchange({
        host,
        port: this.awjPort,
        messages: writes.map((w) => ({ op: 'replace', path: toAwj(w.path), value: w.value })),
      });
      this.#note({ kind: 'sent', command: nameOf(code), code, note, writes: writes.length, sent: sentDetail(writes) });
    } catch (err) {
      this.#note({ kind: 'error', command: nameOf(code), code, error: err.message });
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
      stroke.rests = await this.switcher.restsFor(stroke.ids);
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

  /* ------------------------------------------------ page-side actions */

  /**
   * Take the lease on page-side actions — opening a page, the cue stack.
   * Every open page claims every few seconds; the first to claim keeps it
   * while it keeps claiming, and only it acts, so two open tabs do not fire
   * GO twice. Answers who holds it.
   */
  claimRunner(id) {
    const now = Date.now();
    if (!id) return this.#runner ? this.#runner.id : null;
    if (!this.#runner || this.#runner.id === id || now - this.#runner.at > RUNNER_LEASE_MS) {
      this.#runner = { id: String(id), at: now };
    }
    return this.#runner.id;
  }

  /** Hand an action to the page holding the lease, or say there is none. */
  #toPage(payload, what, code) {
    const r = this.#runner;
    if (!r || Date.now() - r.at > RUNNER_LEASE_MS) {
      this.#note({ kind: 'noted', command: nameOf(code), code, note: `refused — no page is open to ${what}` });
      return false;
    }
    this.emit('page', { ...payload, runner: r.id });
    this.#note({ kind: 'sent', command: nameOf(code), code, note: `${what} (in the open page)` });
    return true;
  }

  #current() {
    return (this.settingsNow && this.settingsNow()) || this.#settings;
  }

  async #transport(action, code) {
    const st = this.#current();
    const target = st.pixelhueTransport || 'cues';
    if (target === 'off') {
      this.#note({ kind: 'noted', command: nameOf(code), code, note: `cue ${action} — transport is off` });
      return;
    }
    if (target === 'companion') {
      const loc = companionLocation(action, st.pixelhueCompanionPage ?? 1, st.pixelhueCompanionRow ?? 0);
      await this.#pressCompanion(loc, code, `cue ${action}`);
      return;
    }
    this.#toPage({ type: 'transport', action }, `cue ${action}`, code);
  }

  /** One Companion button, through the Companion plugin's server. */
  async #pressCompanion(loc, code, what) {
    const svc = this.companion();
    if (!svc || !loc) {
      this.#note({ kind: 'noted', command: nameOf(code), code, note: `${what} — the Companion plugin is off` });
      return;
    }
    const where = `${loc.pageNumber}/${loc.row}/${loc.column}`;
    try {
      const r = await svc.press([loc]);
      if (r && r.ok) this.#note({ kind: 'sent', command: nameOf(code), code, note: `${what} → Companion button ${where}` });
      else this.#note({ kind: 'error', command: nameOf(code), code, error: `Companion ${where}: ${(r && r.error) || 'refused'}` });
    } catch (err) {
      this.#note({ kind: 'error', command: nameOf(code), code, error: `Companion: ${err.message}` });
    }
  }

  /** The backup menu of the last input pressed on the panel, in the open page. */
  #openBackup(code) {
    const ask = backupRequest({ dialect: this.#dialect, input: this.#lastInput });
    if (!ask.payload) {
      this.#note({ kind: 'noted', command: nameOf(code), code, note: ask.note });
      return;
    }
    this.#toPage(ask.payload, ask.what, code);
  }

  /** LAYER UP / DOWN: the selected layer moves through the active screen's. */
  #stepLayer(to, code) {
    const active = this.selection.list[this.selection.list.length - 1];
    if (!active) {
      this.#note({ kind: 'noted', command: nameOf(code), code, note: 'no screen selected on the panel' });
      return;
    }
    const fitted = ((this.#facts && this.#facts.layers) || []).filter((l) => l.destination === active).map((l) => l.key);
    const next = stepLayer(fitted, this.selection.layer, to);
    if (!next) {
      this.#note({ kind: 'noted', command: nameOf(code), code, note: `${active} has no layers to step through` });
      return;
    }
    const moved = next !== this.selection.layer;
    this.selection.layer = next;
    this.#note({ kind: 'noted', command: nameOf(code), code, note: `layer ${next} of ${active} selected` });
    if (moved) void this.#republish();
  }

  /* ----------------------------------------- keys that report nothing */

  /** Which keys are MVR and SOURCE BACKUP on this console, from its own key map. */
  async #readKeyMap() {
    const model = CONSOLE_MODELS.find((m) => m.id === (this.#config && this.#config.model));
    if (!this.#link || !model || !model.modelId) return;
    try {
      const json = await this.#link.keyMap(model.modelId);
      const keys = new Map();
      for (const area of (json.data && json.data.areaList) || []) {
        for (const k of area.keyList || []) {
          const control = SILENT_KEY_MODES[k.keyMode] && controlForKeyMode(k.keyMode);
          if (control) keys.set(Number(k.keyCode), control.id);
        }
      }
      this.#silentKeys = keys;
    } catch (err) {
      this.#note({ kind: 'error', error: `reading the console's key map: ${err.message}` });
    }
  }

  #watchSilentKeys(items) {
    if (!Array.isArray(items) || items.length !== 1 || !this.#silentKeys.size) return;
    const { key, state } = items[0] || {};
    const id = this.#silentKeys.get(Number(key));
    if (!id || (state !== 0 && state !== 1)) return;
    if (state === 0) { this.#keyDownAt.set(key, Date.now()); return; }
    const downAt = this.#keyDownAt.get(key) || Date.now();
    setTimeout(() => {
      if (this.#lastCommandAt >= downAt) return;
      const control = controlById(id);
      const action = actionOf(this.#current().pixelhueMap, control);
      const intent = intentOf(action);
      if (intent) void this.#perform({ ...intent, control: id, mapping: action }, control.label);
    }, SILENT_KEY_WAIT_MS).unref?.();
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
    if (actionOf(this.#current().pixelhueMap, key) === 'none') return;
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
      const action = actionOf(this.#current().pixelhueMap, `${move.control}.${move.index}`);
      let current;
      if (move.control === 'encoder') {
        const spec = layerParam(this.#dialect, action);
        if (spec && letter) {
          const path = this.#dialect.layerParamPath(destination, letter, this.selection.layer, spec.path);
          const got = await this.#read([path]);
          current = Number(got.get(toAwj(path)));
        }
      }
      const w = midiWrite(move, {
        dialect: this.#dialect, destination, letter, layer: this.selection.layer, current, action,
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

  /* ------------------------------------------------------ the key mirror */

  /**
   * What each key shows, for the Mapping page to draw. A one-key batch with
   * state 0 or 1 is a press (down / up), not a lamp, so it is kept apart —
   * the page lights the key it names for a moment.
   */
  #mirrorKeys(items) {
    if (!Array.isArray(items) || !items.length) return;
    if (items.length === 1 && (items[0].state === 0 || items[0].state === 1)) {
      if (items[0].state === 0) {
        this.#lastPress = { key: Number(items[0].key), at: Date.now() };
        this.emit('activity', null);
      }
      return;
    }
    for (const k of items) {
      if (!k || !Number.isFinite(Number(k.key))) continue;
      this.#keys.set(Number(k.key), { text: k.text || '', state: k.state, page: k.page });
    }
    this.emit('activity', null);
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
      transport: this.#current().pixelhueTransport || 'cues',
      runner: this.#runner && Date.now() - this.#runner.at <= RUNNER_LEASE_MS ? this.#runner.id : null,
      history: this.history.slice(0, 12),
      map: resolvedMap(this.#current().pixelhueMap),
      keys: Object.fromEntries(this.#keys),
      lastPress: this.#lastPress,
    };
  }

}

/** A command's name for the history, or a silent key's own name. */
function nameOf(code) {
  return typeof code === 'string' ? code : commandName(code);
}

/* Intents after which the model must be read again, not just re-sent. */
const REREAD = new Set(['store', 'ftb', 'freeze', 'time', 'swap', 'deletePreset']);

export const portFor = (model) =>
  (CONSOLE_MODELS.find((m) => m.id === model) || CONSOLE_MODELS[0]).port;
