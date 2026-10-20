/*
 * The ATEM Micro Panel supervisor.  ** PREVIEW **
 *
 * Holds the panel through the device host (`devices/modules/atem-micro-panel/`),
 * reads the switcher in bursts, turns each press into writes, and keeps the
 * panel's lamps in step. `core.js` beside this decides what every key means;
 * this does the I/O.
 *
 * ## In the server, not the page
 *
 * For the reason the Barco EC panel's is (`plugins/barco-ec/supervisor.js`): a
 * panel on a desk has to work with no browser open. So the switcher is read
 * with `exchange()` bursts through `server/console-switcher.js`, nothing is
 * held open on it, and a press is written the way
 * `src/core/console-intents.js` says. The device host knows only the panel.
 *
 * ## Tally, read rather than followed
 *
 * An ATEM-style bus is mostly tally: red for what is on air, green for what is
 * in preview. Nothing here follows the switcher live (the Pixelhue supervisor
 * argues why at its head), so tally is READ: a burst of a dozen `get`s for the
 * active screen's selected layer, after every press that changes the
 * switcher, when the panel connects, and every `TALLY_MS` while it is held.
 * A take fired from the Web RCS relights the buses within that, not at once.
 * The rest — names, memories, layers, FTB and freeze — is read every
 * `REFRESH_MS`, as the other consoles read it.
 *
 * ## The program row
 *
 * On an ATEM the program row cuts to air. Here it shows tally and does nothing
 * else unless the operator has ticked "Program row cuts to air" on the card —
 * `setHotCut`. That tick is held in this process only: it is gone when the
 * panel is switched off, and when the app restarts, so a show never inherits
 * it from the last one.
 */

import { EventEmitter } from 'node:events';

import { ConsoleSwitcher, sentDetail } from '../../server/console-switcher.js';
import { AWJ_PORT } from '../../server/awj.js';
import { commandsFor } from '../../src/core/commands.js';
import { writesFor, tbarWrites, strokeProgress, STROKE_END, Selection } from '../../src/core/console-intents.js';
import { decodeReport, keyChanges, ledReport, KEY_BY_CODE, darkReport } from '../../src/core/atem-micro-panel.js';
import {
  initialView, keyIntent, paint, selectOnly, destinationsOf, layersOf, activeOf,
} from './core.js';

export const MODULE = 'atem-micro-panel';

/* Twenty keys a bus (ten, and ten more with SHIFT), eight M/E keys, ten layer keys. */
const LIMITS = { screens: 24, inputs: 20, memories: 20, layers: 16, stills: 20 };
/* Names, memories and layers follow the switcher this often while the panel is held. */
const REFRESH_MS = 15_000;
/* Tally follows the switcher this often: one small burst for one screen's layer. */
const TALLY_MS = 5_000;
/* A T-bar with no report for this long has stopped; the stroke is over. */
const STROKE_IDLE_MS = 2000;
const HISTORY = 40;
/* Intents after which everything is read again, not just tally. */
const REREAD = new Set(['freeze', 'ftb', 'recall']);
/* Intents that change what is on a bus. */
const RETALLY = new Set(['source', 'take', 'cut', 'matchProgram', 'recall']);

export class AtemMicroPanelSupervisor extends EventEmitter {
  #settings = null;
  #view = initialView();
  #codes = [];
  #sent = null;
  #painting = false;
  #repaintAgain = false;
  #refreshTimer = null;
  #tallyTimer = null;
  #offs = [];
  #connected = false;
  #lever = null;
  #stroke = null;
  #tally = null;
  #hotCut = false;

  /**
   * @param {object} o
   * @param {() => string|null} o.deviceHost  the switcher's host, read per use
   * @param {() => object|null} o.devices     the app's `devices` service, read per use
   */
  constructor({
    deviceHost = () => null, devices = () => null, awjPort = AWJ_PORT, log = () => {},
    refreshMs = REFRESH_MS, tallyMs = TALLY_MS,
  } = {}) {
    super();
    this.deviceHost = deviceHost;
    this.devices = devices;
    this.log = log;
    this.refreshMs = refreshMs;
    this.tallyMs = tallyMs;
    this.switcher = new ConsoleSwitcher({ deviceHost: () => this.deviceHost(), awjPort, limits: LIMITS });
    this.selection = new Selection();
    this.history = [];
    this.facts = null;
  }

  get panel() { return this.devices()?.module?.(MODULE) ?? null; }
  get enabled() { return !!this.#settings?.atemMicroEnabled; }
  get hotCut() { return this.#hotCut; }

  /* ------------------------------------------------------------ lifecycle */

  /** Follow the settings: hold the panel while enabled, let it go when not. */
  async apply(settings) {
    const was = this.#settings;
    this.#settings = settings;
    const panel = this.panel;
    if (!settings?.atemMicroEnabled) {
      if (was?.atemMicroEnabled) await this.#letGo();
      this.#note({ kind: 'stopped' });
      return this.describe();
    }
    if (!was?.atemMicroEnabled) this.#view = initialView();
    this.#sent = null;
    if (panel && !this.#offs.length) {
      this.#offs.push(panel.on('state', (state) => this.#onState(state)));
      this.#offs.push(panel.on('report', (bytes) => this.#onReport(bytes)));
    }
    if (panel) await panel.want(true);
    this.#onState(panel?.state ?? null);
    void this.refresh();
    return this.describe();
  }

  async stop() {
    await this.#letGo();
  }

  /**
   * The program row cuts to air, or goes back to tally only. Refused while
   * the panel is off; forgotten when it is switched off.
   */
  setHotCut(on) {
    if (!this.enabled && on) throw new Error('switch the panel on first');
    const next = !!on;
    if (next !== this.#hotCut) {
      this.#hotCut = next;
      this.#note({ kind: 'noted', note: next ? 'the program row cuts to air' : 'the program row is tally only' });
    }
    return this.describe();
  }

  async #letGo() {
    clearTimeout(this.#refreshTimer);
    clearTimeout(this.#tallyTimer);
    this.#refreshTimer = null;
    this.#tallyTimer = null;
    this.#hotCut = false;
    /* Nothing paints from here on — a tally read still in flight finishes
       into a panel that is not ours any more — and a paint already on its way
       lands before the dark report, not after it. */
    const wasConnected = this.#connected;
    this.#connected = false;
    this.#endStroke();
    while (this.#painting) await new Promise((r) => setTimeout(r, 5));
    const panel = this.panel;
    /* Dark, rather than this app's tally, for whoever picks the panel up next —
       ATEM Software Control relights it when it takes it. */
    if (panel?.available && wasConnected) await panel.write([[...darkReport()]]).catch(() => {});
    for (const off of this.#offs.splice(0)) off();
    await panel?.want(false);
    this.#sent = null;
    this.#lever = null;
    this.#codes = [];
    this.#tally = null;
    this.#view = initialView();
    this.selection.reset();
  }

  #onState(state) {
    const live = !!state?.connected && !!state?.authed;
    if (live === this.#connected) { this.emit('activity'); return; }
    this.#connected = live;
    this.#lever = null;
    this.#codes = [];
    this.#view.held.clear();
    this.#view.shift = false;
    this.#endStroke();
    if (live) {
      /* A panel found (again) shows whatever it last had: paint all of it. */
      this.#sent = null;
      this.#note({ kind: 'connected', note: state.product ? `${state.product} answered` : 'panel connected' });
      void this.refresh();
    } else {
      clearTimeout(this.#tallyTimer);
      this.#note({
        kind: 'disconnected',
        note: state?.error || (state?.connected ? 'panel found, not yet answered' : 'panel not connected'),
      });
    }
  }

  /* ------------------------------------------------------------ the switcher */

  /** Read the switcher, keep the selection to what is there, read tally, repaint. */
  async refresh() {
    clearTimeout(this.#refreshTimer);
    if (!this.enabled) return null;
    try {
      this.facts = await this.switcher.readFacts();
      const dests = destinationsOf(this.facts);
      this.selection.restrict(dests.map((d) => d.id));
      /* An ATEM always drives M/E 1: with nothing selected, the first screen is. */
      if (!this.selection.list.length && dests.length) this.#activate(dests[0].id);
      this.#keepLayer();
      this.#note({ kind: 'read', note: `${dests.length} screens, ${this.facts.presets.length} memories` }, { quiet: true });
    } catch (err) {
      this.#note({ kind: 'error', error: `reading the switcher: ${err.message}` });
    }
    await this.refreshTally();
    if (this.#connected) {
      this.#refreshTimer = setTimeout(() => { void this.refresh(); }, this.refreshMs);
      this.#refreshTimer.unref?.();
    }
    return this.facts;
  }

  /** What is on the selected layer of the active screen, in program and preview; then repaint. */
  async refreshTally() {
    clearTimeout(this.#tallyTimer);
    if (!this.enabled) return null;
    const active = activeOf(this.selection);
    if (active && this.switcher.dialect) {
      try {
        const got = await this.switcher.tallyFor([active], this.selection.layer);
        this.#tally = got.get(active) ?? null;
      } catch (err) {
        this.#tally = null;
        this.#note({ kind: 'error', error: `reading tally: ${err.message}` });
      }
    } else {
      this.#tally = null;
    }
    await this.repaint();
    if (this.#connected) {
      this.#tallyTimer = setTimeout(() => { void this.refreshTally(); }, this.tallyMs);
      this.#tallyTimer.unref?.();
    }
    return this.#tally;
  }

  /** Make one screen the panel's, starting on its first fitted layer. */
  #activate(id) {
    selectOnly(this.selection, id);
    this.selection.layer = layersOf(this.facts, id)[0] ?? 1;
  }

  /** The selected layer must be one the active screen has. */
  #keepLayer() {
    const layers = layersOf(this.facts, activeOf(this.selection));
    if (layers.length && !layers.includes(this.selection.layer)) this.selection.layer = layers[0];
  }

  #ctx() {
    return {
      view: this.#view, facts: this.facts, selection: this.selection, hotCut: this.#hotCut,
      memoryLimit: LIMITS.memories,
    };
  }

  /* ---------------------------------------------------------------- paint */

  /** Send the lamp report when it differs from the last sent. One at a time; the newest wins. */
  async repaint() {
    const panel = this.panel;
    if (!panel?.available || !this.#connected || !this.enabled) return;
    if (this.#painting) { this.#repaintAgain = true; return; }
    this.#painting = true;
    try {
      do {
        this.#repaintAgain = false;
        const { colours, meter } = paint({ ...this.#ctx(), tally: this.#tally, stroke: this.#strokeShown() });
        const bytes = [...ledReport(colours, meter)];
        if (this.#sent && this.#sent.join() === bytes.join()) break;
        const written = await panel.write([bytes]);
        this.#sent = written ? bytes : null;
      } while (this.#repaintAgain);
    } catch (err) {
      this.#sent = null;
      this.#note({ kind: 'error', error: `lighting the panel: ${err.message}` });
    } finally {
      this.#painting = false;
    }
  }

  #strokeShown() {
    const s = this.#stroke;
    return s && s.progress !== null ? s.progress : null;
  }

  /* ---------------------------------------------------------------- input */

  #onReport(bytes) {
    const r = decodeReport(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
    if (!r || !this.enabled) return;
    if (r.type === 'tbar') { this.#onTbar(r.fraction); return; }
    if (r.type !== 'keys') return;
    const { down, up } = keyChanges(this.#codes, r.codes);
    this.#codes = r.codes;
    for (const code of up) this.#view.held.delete(KEY_BY_CODE.get(code).name);
    for (const code of down) this.#view.held.add(KEY_BY_CODE.get(code).name);
    this.#view.shift = this.#view.held.has('SHIFT');
    void this.repaint();
    for (const code of down) void this.#onPress(KEY_BY_CODE.get(code).name);
  }

  async #onPress(name) {
    const intent = keyIntent(name, this.#ctx());
    switch (intent.kind) {
      case 'shift':
        return;
      case 'none':
        this.#note({ kind: 'noted', key: name, note: intent.why });
        return;
      case 'macro':
        this.#view.macro = !this.#view.macro;
        this.#note({ kind: 'noted', key: name, note: this.#view.macro ? 'MACRO: the preview row recalls memories' : 'MACRO off: the buses hold sources' }, { quiet: true });
        void this.repaint();
        return;
      case 'busKind':
        this.#view.busKind = intent.sourceKind;
        this.#view.macro = false;
        this.#note({ kind: 'noted', key: name, note: `the buses hold ${intent.sourceKind.toLowerCase()} sources` }, { quiet: true });
        void this.repaint();
        return;
      case 'selectOnly':
      case 'select':
      case 'unselect':
      case 'selectLayer': {
        const before = activeOf(this.selection);
        if (intent.kind === 'selectOnly') selectOnly(this.selection, intent.destination);
        else this.selection.apply(intent);
        /* A new active screen starts on its first fitted layer. */
        if (activeOf(this.selection) !== before) this.selection.layer = layersOf(this.facts, activeOf(this.selection))[0] ?? 1;
        this.#note({ kind: 'noted', key: name, note: `driving ${this.selection.list.join(' ') || 'nothing'}, layer ${this.selection.layer}` }, { quiet: true });
        void this.refreshTally();
        return;
      }
      default:
        await this.#perform(intent);
    }
  }

  /** Act on an intent that writes to the switcher. */
  async #perform(intent) {
    const dialect = this.switcher.dialect;
    if (!dialect) { this.#note({ kind: 'error', key: intent.key, error: 'the switcher has not been read yet' }); return; }
    const selected = this.selection.list;
    const buffer = intent.buffer || 'PREVIEW';
    let letters = new Map();
    let freeze = new Map();
    let faded = new Map();
    try {
      if (intent.kind === 'source') letters = await this.switcher.lettersFor(selected, buffer);
      if (intent.kind === 'freeze') freeze = await this.switcher.freezeFor(selected);
      if (intent.kind === 'ftb') faded = await this.switcher.fadedFor(selected);
    } catch (err) {
      this.#note({ kind: 'error', key: intent.key, error: err.message });
      return;
    }
    const { writes, note } = writesFor(intent, {
      dialect,
      commands: commandsFor(dialect),
      selected,
      layer: this.selection.layer,
      buffer,
      letterFor: (id) => letters.get(id) || null,
      freezeOf: (id) => freeze.get(id) || null,
      fadedOf: (id) => (faded.has(id) ? faded.get(id) : null),
      sourceKind: intent.sourceKind,
    });
    if (!writes.length) { this.#note({ kind: 'noted', key: intent.key, note }); return; }
    try {
      await this.switcher.write(writes);
      this.#note({ kind: 'sent', key: intent.key, note, sent: sentDetail(writes) });
    } catch (err) {
      this.#note({ kind: 'error', key: intent.key, error: err.message });
    }
    if (REREAD.has(intent.kind)) void this.refresh();
    else if (RETALLY.has(intent.kind)) void this.refreshTally();
  }

  /* --------------------------------------------------------------- T-bar */

  /**
   * The lever moved. The first reading after the panel connects is only where
   * it rests; a stroke starts with the next move, from there. Where each
   * selected screen rests is read once per stroke (`tbarWrites` says why);
   * after that each report is a write, one in flight, the newest winning.
   */
  #onTbar(f) {
    const from = this.#lever;
    this.#lever = f;
    if (from === null) return;
    if (!this.#stroke) {
      const ids = this.selection.list;
      if (!ids.length || !this.switcher.dialect) {
        this.#note({ kind: 'noted', key: 'T-bar', note: 'no screen selected on the panel' }, { quiet: true });
        return;
      }
      this.#stroke = { ids, from, rests: null, pending: null, busy: false, timer: null, lastSent: [], progress: null };
      void this.#readRests(this.#stroke);
    }
    const stroke = this.#stroke;
    stroke.pending = f;
    clearTimeout(stroke.timer);
    stroke.timer = setTimeout(() => this.#endStroke(), STROKE_IDLE_MS);
    stroke.timer.unref?.();
    void this.#pumpTbar();
  }

  async #readRests(stroke) {
    try {
      stroke.rests = await this.switcher.restsFor(stroke.ids);
    } catch (err) {
      this.#note({ kind: 'error', key: 'T-bar', error: err.message });
      this.#endStroke();
      return;
    }
    void this.#pumpTbar();
  }

  async #pumpTbar() {
    const stroke = this.#stroke;
    if (!stroke || stroke.busy || !stroke.rests || stroke.pending === null) return;
    const now = stroke.pending;
    stroke.pending = null;
    stroke.busy = true;
    let progress = strokeProgress(stroke.from, now);
    if (progress >= STROKE_END) progress = 1;
    stroke.progress = progress;
    const { writes } = tbarWrites({ mapValue: Math.round(progress * 1000), maxValue: 1000 }, {
      dialect: this.switcher.dialect,
      selected: stroke.ids,
      restOf: (id) => stroke.rests.get(id) ?? null,
    });
    try {
      if (writes.length) {
        stroke.lastSent = sentDetail(writes);
        await this.switcher.write(writes);
      }
    } catch (err) {
      this.#note({ kind: 'error', key: 'T-bar', error: err.message });
    }
    stroke.busy = false;
    void this.repaint();
    if (progress >= 1) {
      this.#note({ kind: 'sent', key: 'T-bar', note: `T-bar take on ${stroke.ids.join(' ')}`, sent: stroke.lastSent });
      this.#endStroke();
      void this.refreshTally();
      return;
    }
    if (stroke.pending !== null) void this.#pumpTbar();
  }

  #endStroke() {
    if (!this.#stroke) return;
    clearTimeout(this.#stroke.timer);
    this.#stroke = null;
    void this.repaint();
  }

  /* -------------------------------------------------------------- reporting */

  #note(entry, { quiet = false } = {}) {
    const e = { at: Date.now(), ...entry };
    if (!quiet || entry.kind === 'error') {
      this.history.unshift(e);
      this.history.length = Math.min(this.history.length, HISTORY);
      if (entry.error) this.log(`atem-micro-panel: ${entry.error}`);
    }
    this.emit('activity', e);
  }

  describe() {
    const panel = this.panel;
    const status = this.devices()?.status?.() ?? null;
    return {
      enabled: this.enabled,
      hotCut: this.#hotCut,
      host: status ? { installed: status.installed, running: status.running, reason: status.reason } : null,
      panel: {
        available: !!panel?.available,
        reason: panel?.reason ?? null,
        ...(panel?.state ?? {}),
      },
      selection: this.selection.describe(),
      view: { busKind: this.#view.busKind, macro: this.#view.macro, shift: this.#view.shift },
      tally: this.#tally,
      switcher: this.facts ? {
        screens: destinationsOf(this.facts).map((d) => ({ id: d.id, label: d.label })),
        memories: this.facts.presets.length,
        inputs: this.facts.sources.LIVE.length,
      } : null,
      stroke: this.#stroke ? { ids: this.#stroke.ids, progress: this.#stroke.progress } : null,
      history: this.history,
    };
  }
}
