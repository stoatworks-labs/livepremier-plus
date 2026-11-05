/*
 * The X-keys supervisor.  ** PREVIEW **
 *
 * Holds the panel through the device host (`devices/modules/xkeys/`), reads
 * the switcher in bursts, turns each press into writes, and keeps the
 * backlights in step. `core.js` beside this decides what every key means;
 * this does the I/O.
 *
 * ## In the server, not the page
 *
 * For the reason the ATEM Micro Panel's and the Barco EC panel's are: a panel
 * on a desk has to work with no browser open. So the switcher is read with
 * `exchange()` bursts through `server/console-switcher.js`, nothing is held
 * open on it, and a press is written the way `src/core/console-intents.js`
 * says. The device host knows only the panel.
 *
 * ## Tally, read rather than followed
 *
 * As on the ATEM Micro Panel (`plugins/atem-micro-panel/supervisor.js` says
 * why): a burst of a dozen `get`s for the active screen's selected layer,
 * after every press that changes the switcher, when the panel connects, and
 * every `TALLY_MS` while it is held. Names, memories, layers, FTB and freeze
 * are read every `REFRESH_MS`.
 *
 * ## The two lamps above the keys
 *
 * Green is steady while the panel is driving a switcher it has read, and
 * flashes while it cannot read one. Red flashes for a moment after a press
 * that was refused or failed — the history on the card says why.
 */

import { EventEmitter } from 'node:events';

import { ConsoleSwitcher, sentDetail } from '../../server/console-switcher.js';
import { AWJ_PORT } from '../../server/awj.js';
import { commandsFor } from '../../src/core/commands.js';
import {
  writesFor, tbarWrites, strokeProgress, STROKE_END, Selection,
  destinationsOf, activeOf, layersOf, selectOnly,
} from '../../src/core/console-intents.js';
import {
  productOf, decodeReport, keyChanges, backlightReports, allBacklightReports, darkReports,
  indicatorReport, INDICATOR, RGB, lampsOf,
} from '../../src/core/xkeys.js';
import { keyIntent, paint, layoutFor, limitsFor, legendOf, lampWord } from './core.js';

export const MODULE = 'xkeys';

/* Names, memories and layers follow the switcher this often while the panel is held. */
const REFRESH_MS = 15_000;
/* Tally follows the switcher this often: one small burst for one screen's layer. */
const TALLY_MS = 5_000;
/* A T-bar with no report for this long has stopped; the stroke is over. */
const STROKE_IDLE_MS = 2000;
/* How long the red lamp flashes after a refused press. */
const REFUSED_MS = 1500;
/* The device host takes this many reports per write. */
const BATCH = 16;
const HISTORY = 40;
/* Intents after which everything is read again, not just tally. */
const REREAD = new Set(['freeze', 'ftb', 'recall']);
/* Intents that change what is on a source key. */
const RETALLY = new Set(['source', 'take', 'cut', 'matchProgram', 'recall']);

const nameOf = (index) => (index === 0 ? 'PS' : `key ${index}`);

export class XKeysSupervisor extends EventEmitter {
  #settings = null;
  #product = null;
  #held = new Set();
  #sent = null;            // Map(index → lampWord) as the panel shows it, or null to paint all
  #lamps = null;           // `{green, red}` as sent, or null
  #painting = false;
  #repaintAgain = false;
  #refreshTimer = null;
  #tallyTimer = null;
  #refusedTimer = null;
  #refusedUntil = 0;
  #offs = [];
  #connected = false;
  #lever = null;
  #stroke = null;
  #tally = null;
  #readOk = false;
  #noted = new Set();

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
    this.switcher = new ConsoleSwitcher({ deviceHost: () => this.deviceHost(), awjPort });
    this.selection = new Selection();
    this.history = [];
    this.facts = null;
  }

  get panel() { return this.devices()?.module?.(MODULE) ?? null; }
  get enabled() { return !!this.#settings?.xkeysEnabled; }
  get product() { return this.#product; }
  /** The keys the panel runs now: `{keys, suggested}`. */
  get layout() { return layoutFor(this.#settings, this.#product); }

  /* ------------------------------------------------------------ lifecycle */

  /** Follow the settings: hold the panel while enabled, let it go when not. */
  async apply(settings) {
    const was = this.#settings;
    this.#settings = settings;
    const panel = this.panel;
    if (!settings?.xkeysEnabled) {
      if (was?.xkeysEnabled) await this.#letGo();
      this.#note({ kind: 'stopped' });
      return this.describe();
    }
    if (panel && !this.#offs.length) {
      this.#offs.push(panel.on('state', (state) => this.#onState(state)));
      this.#offs.push(panel.on('report', (bytes) => this.#onReport(bytes)));
    }
    if (panel) await panel.want(true);
    this.#onState(panel?.state ?? null);
    /* Read (again): a changed layout may want more memories or inputs, and
       its keys lit differently. */
    void this.refresh();
    return this.describe();
  }

  async stop() {
    await this.#letGo();
  }

  async #letGo() {
    clearTimeout(this.#refreshTimer);
    clearTimeout(this.#tallyTimer);
    clearTimeout(this.#refusedTimer);
    this.#refreshTimer = null;
    this.#tallyTimer = null;
    /* Nothing paints from here on; a paint already on its way lands before
       the dark reports, not after them. */
    const wasConnected = this.#connected;
    const product = this.#product;
    this.#connected = false;
    this.#endStroke();
    while (this.#painting) await new Promise((r) => setTimeout(r, 5));
    const panel = this.panel;
    if (panel?.available && wasConnected && product) await this.#send(panel, darkReports(product)).catch(() => {});
    for (const off of this.#offs.splice(0)) off();
    await panel?.want(false);
    this.#sent = null;
    this.#lamps = null;
    this.#lever = null;
    this.#held.clear();
    this.#tally = null;
    this.#product = null;
    this.selection.reset();
  }

  #onState(state) {
    const live = !!state?.connected && !!state?.ready;
    const product = state?.model ? productOf(state.model) : null;
    if (product?.model !== this.#product?.model) {
      this.#product = product;
      this.#sent = null;
      this.#lamps = null;
    }
    if (live === this.#connected) { this.emit('activity'); return; }
    this.#connected = live;
    this.#lever = null;
    this.#held.clear();
    this.#endStroke();
    if (live) {
      this.#sent = null;
      this.#lamps = null;
      this.#note({ kind: 'connected', note: `${state.product || 'X-keys'} answered` });
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
    Object.assign(this.switcher.limits, limitsFor(this.layout.keys));
    try {
      this.facts = await this.switcher.readFacts();
      const dests = destinationsOf(this.facts);
      this.selection.restrict(dests.map((d) => d.id));
      /* With nothing selected, the first screen in service is driven. */
      if (!this.selection.list.length && dests.length) this.#activate(dests[0].id);
      this.#keepLayer();
      this.#readOk = true;
      this.#note({ kind: 'read', note: `${dests.length} screens, ${this.facts.presets.length} memories` }, { quiet: true });
    } catch (err) {
      this.#readOk = false;
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

  #activate(id) {
    selectOnly(this.selection, id);
    this.selection.layer = layersOf(this.facts, id)[0] ?? 1;
  }

  #keepLayer() {
    const layers = layersOf(this.facts, activeOf(this.selection));
    if (layers.length && !layers.includes(this.selection.layer)) this.selection.layer = layers[0];
  }

  #memoryLimit() { return this.switcher.limits.memories; }

  /* ---------------------------------------------------------------- paint */

  /** Send the backlights and lamps that differ from the last sent. One paint at a time; the newest wins. */
  async repaint() {
    const panel = this.panel;
    const product = this.#product;
    if (!panel?.available || !this.#connected || !this.enabled || !product) return;
    if (this.#painting) { this.#repaintAgain = true; return; }
    this.#painting = true;
    try {
      do {
        this.#repaintAgain = false;
        const lamps = paint({
          product,
          layout: this.layout.keys,
          facts: this.facts,
          selection: this.selection,
          tally: this.#tally,
          held: this.#held,
          stroke: this.#strokeShown(),
          memoryLimit: this.#memoryLimit(),
        });
        const reports = [];
        const first = this.#sent === null;
        const next = new Map();
        /* A panel found (again) shows whatever it last had: dark first, then what is lit. */
        if (first && lampsOf(product) !== 'none') reports.push(...allBacklightReports(product, RGB.OFF));
        for (const [index, l] of lamps) {
          const word = lampWord(l);
          next.set(index, word);
          const was = first ? lampWord({ colour: RGB.OFF, flash: false }) : this.#sent.get(index);
          if (was !== word) reports.push(...backlightReports(product, index, l.colour, l.flash));
        }
        const indicators = {
          green: this.#readOk ? 'on' : 'flash',
          red: Date.now() < this.#refusedUntil ? 'flash' : 'off',
        };
        if (!this.#lamps || this.#lamps.green !== indicators.green) reports.push(indicatorReport(INDICATOR.GREEN, indicators.green));
        if (!this.#lamps || this.#lamps.red !== indicators.red) reports.push(indicatorReport(INDICATOR.RED, indicators.red));
        if (!reports.length) break;
        const written = await this.#send(panel, reports);
        if (written) {
          this.#sent = next;
          this.#lamps = indicators;
        } else {
          this.#sent = null;
          this.#lamps = null;
        }
      } while (this.#repaintAgain);
    } catch (err) {
      this.#sent = null;
      this.#lamps = null;
      this.#note({ kind: 'error', error: `lighting the panel: ${err.message}` });
    } finally {
      this.#painting = false;
    }
  }

  /** Reports in batches the device host takes; true when every one was written. */
  async #send(panel, reports) {
    let all = true;
    for (let i = 0; i < reports.length; i += BATCH) {
      const batch = reports.slice(i, i + BATCH);
      const n = await panel.write(batch);
      if (n !== batch.length) all = false;
    }
    return all;
  }

  #strokeShown() {
    const s = this.#stroke;
    return s && s.progress !== null ? s.progress : null;
  }

  /* ---------------------------------------------------------------- input */

  #onReport(bytes) {
    const product = this.#product;
    const r = decodeReport(product, bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
    if (!r || r.type !== 'keys' || !this.enabled) return;
    if (r.tbar.length) this.#onTbar(r.tbar[0] / 255);
    if (r.jog.some((v) => v !== 0) || r.shuttle.some((v) => v !== 0)) this.#noteOnce('jog', 'jog and shuttle have no job yet');
    const { down, up } = keyChanges([...this.#held], r.keys);
    if (!down.length && !up.length) return;
    for (const k of up) this.#held.delete(k);
    for (const k of down) this.#held.add(k);
    /* A report that answers Generate Data says what is held, not what was pressed. */
    if (r.generated) { void this.repaint(); return; }
    void this.repaint();
    for (const k of down) void this.#onPress(k);
  }

  async #onPress(index) {
    const binding = this.layout.keys[index] ?? null;
    const key = binding ? `${nameOf(index)} (${legendOf(binding)})` : nameOf(index);
    const intent = keyIntent(binding, { facts: this.facts, selection: this.selection, memoryLimit: this.#memoryLimit() });
    switch (intent.kind) {
      case 'none':
        this.#note({ kind: 'noted', key, index, note: intent.why });
        if (binding) this.#refused();
        return;
      case 'selectOnly':
      case 'select':
      case 'unselect':
      case 'selectLayer': {
        const before = activeOf(this.selection);
        if (intent.kind === 'selectOnly') selectOnly(this.selection, intent.destination);
        else this.selection.apply(intent);
        if (activeOf(this.selection) !== before) this.selection.layer = layersOf(this.facts, activeOf(this.selection))[0] ?? 1;
        this.#note({ kind: 'noted', key, index, note: `driving ${this.selection.list.join(' ') || 'nothing'}, layer ${this.selection.layer}` }, { quiet: true });
        void this.refreshTally();
        return;
      }
      default:
        await this.#perform(intent, key, index);
    }
  }

  /** Act on an intent that writes to the switcher. */
  async #perform(intent, key, index) {
    const dialect = this.switcher.dialect;
    if (!dialect) { this.#note({ kind: 'error', key, index, error: 'the switcher has not been read yet' }); this.#refused(); return; }
    const selected = this.selection.list;
    const buffer = intent.buffer || 'PREVIEW';
    let letters = new Map();
    let freeze = new Map();
    let faded = new Map();
    let times = new Map();
    try {
      if (intent.kind === 'source') letters = await this.switcher.lettersFor(selected, buffer);
      if (intent.kind === 'freeze') freeze = await this.switcher.freezeFor(selected);
      if (intent.kind === 'ftb') faded = await this.switcher.fadedFor(selected);
      if (intent.kind === 'time' && dialect.fadeTimePath) times = await this.switcher.readEach(selected, (id) => dialect.fadeTimePath(id));
    } catch (err) {
      this.#note({ kind: 'error', key, index, error: err.message });
      this.#refused();
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
      timeOf: (id) => (times.has(id) && times.get(id) !== undefined ? Number(times.get(id)) : null),
      sourceKind: intent.sourceKind,
    });
    if (!writes.length) { this.#note({ kind: 'noted', key, index, note }); this.#refused(); return; }
    try {
      await this.switcher.write(writes);
      this.#note({ kind: 'sent', key, index, note, sent: sentDetail(writes) });
    } catch (err) {
      this.#note({ kind: 'error', key, index, error: err.message });
      this.#refused();
    }
    if (REREAD.has(intent.kind)) void this.refresh();
    else if (RETALLY.has(intent.kind)) void this.refreshTally();
  }

  /** Flash the red lamp for a moment. */
  #refused() {
    this.#refusedUntil = Date.now() + REFUSED_MS;
    clearTimeout(this.#refusedTimer);
    this.#refusedTimer = setTimeout(() => { void this.repaint(); }, REFUSED_MS + 20);
    this.#refusedTimer.unref?.();
    void this.repaint();
  }

  /* --------------------------------------------------------------- T-bar */

  /**
   * The lever moved. As on the ATEM Micro Panel: the first reading after the
   * panel connects is only where it rests; a stroke starts with the next
   * move, from there, and counts from whichever end it rested nearest.
   */
  #onTbar(f) {
    const from = this.#lever;
    if (from !== null && Math.abs(from - f) < 1e-9) return;
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

  #noteOnce(id, note) {
    if (this.#noted.has(id)) return;
    this.#noted.add(id);
    this.#note({ kind: 'noted', key: id, note });
  }

  #note(entry, { quiet = false } = {}) {
    const e = { at: Date.now(), ...entry };
    if (!quiet || entry.kind === 'error') {
      this.history.unshift(e);
      this.history.length = Math.min(this.history.length, HISTORY);
      if (entry.error) this.log(`xkeys: ${entry.error}`);
    }
    this.emit('activity', e);
  }

  describe() {
    const panel = this.panel;
    const status = this.devices()?.status?.() ?? null;
    const layout = this.layout;
    return {
      enabled: this.enabled,
      host: status ? { installed: status.installed, running: status.running, reason: status.reason } : null,
      panel: {
        available: !!panel?.available,
        reason: panel?.reason ?? null,
        ...(panel?.state ?? {}),
      },
      model: this.#product?.model ?? null,
      layout: this.#product ? { keys: layout.keys, suggested: layout.suggested } : null,
      held: [...this.#held],
      selection: this.selection.describe(),
      tally: this.#tally,
      switcher: this.facts ? {
        screens: destinationsOf(this.facts).map((d) => ({ id: d.id, label: d.label })),
        memories: this.facts.presets.map((p) => ({ slot: p.slot, label: p.label })),
        inputs: this.facts.sources.LIVE.map((s) => ({ number: s.number, label: s.label })),
      } : null,
      stroke: this.#stroke ? { ids: this.#stroke.ids, progress: this.#stroke.progress } : null,
      history: this.history,
    };
  }
}
