/*
 * The Barco EC panel supervisor.  ** PREVIEW **
 *
 * Holds the panel through the device host (`devices/modules/barco-ec/`),
 * reads the switcher in bursts, turns each press into writes, and keeps the
 * panel's labels and lamps in step. `core.js` beside this decides what every
 * key means; this does the I/O.
 *
 * ## In the server, not the page
 *
 * The Speed Editor's controls become switcher writes in the page, because
 * that is where the store mirror is, and so it drives the switcher only while
 * a page is open. A console on a desk has to work with no browser open at all
 * — that is what it is for — so this runs where the Pixelhue panel's
 * supervisor runs, and on the same terms (`plugins/pixelhue/supervisor.js`
 * argues them at its head): the switcher is read with `exchange()` bursts
 * through `server/console-switcher.js` and nothing is held open on it, and a
 * press is written the way `src/core/console-intents.js` says. The device host
 * still knows only the panel; the meaning stays in this process.
 *
 * What that gives up is live tally, exactly as for the Pixelhue panel: a take
 * fired from the Web RCS does not relight anything here until the next read —
 * after each press that changes the switcher, when the panel connects, and
 * every `REFRESH_MS`.
 */

import { EventEmitter } from 'node:events';

import { ConsoleSwitcher, sentDetail } from '../../server/console-switcher.js';
import { AWJ_PORT } from '../../server/awj.js';
import { commandsFor } from '../../src/core/commands.js';
import { writesFor, tbarWrites, Selection } from '../../src/core/console-intents.js';
import { readReport } from '../../src/core/ec-panel.js';
import {
  initialView, keyIntent, applyView, pageCounts, paint, paintCommand, strokeProgress, tbarFraction,
  destinationsOf, STROKE_END,
} from './core.js';

export const MODULE = 'barco-ec';

/* A console wants more of a switcher than a Pixelhue bus of eight: twelve
   keys a row, paged. Still bounded: these are `get`s in one burst. */
const LIMITS = { screens: 24, inputs: 48, memories: 64, layers: 16, stills: 48 };
/* Labels follow renames and new memories this often while the panel is held. */
const REFRESH_MS = 15_000;
/* A T-bar with no report for this long has stopped; the stroke is over. */
const STROKE_IDLE_MS = 2000;
const HISTORY = 40;
/* Intents after which the switcher is read again, not just the panel repainted. */
const REREAD = new Set(['freeze']);

export class BarcoEcSupervisor extends EventEmitter {
  #settings = null;
  #view = null;
  #painted = null;
  #painting = false;
  #repaintAgain = false;
  #refreshTimer = null;
  #offs = [];
  #connected = false;
  #lever = null;
  #stroke = null;

  /**
   * @param {object} o
   * @param {() => string|null} o.deviceHost  the switcher's host, read per use
   * @param {() => object|null} o.devices     the app's `devices` service, read per use
   */
  constructor({ deviceHost = () => null, devices = () => null, awjPort = AWJ_PORT, log = () => {}, refreshMs = REFRESH_MS } = {}) {
    super();
    this.deviceHost = deviceHost;
    this.devices = devices;
    this.log = log;
    this.refreshMs = refreshMs;
    this.switcher = new ConsoleSwitcher({ deviceHost: () => this.deviceHost(), awjPort, limits: LIMITS });
    this.selection = new Selection();
    this.history = [];
    this.facts = null;
  }

  get panel() { return this.devices()?.module?.(MODULE) ?? null; }

  /* ------------------------------------------------------------ lifecycle */

  /** Follow the settings: hold the panel while enabled, let it go when not. */
  async apply(settings) {
    const was = this.#settings;
    this.#settings = settings;
    const panel = this.panel;
    if (!settings?.barcoEcEnabled) {
      if (was?.barcoEcEnabled) await this.#letGo();
      this.#note({ kind: 'stopped' });
      return this.describe();
    }
    if (!was?.barcoEcEnabled || was.barcoEcRows.join() !== settings.barcoEcRows.join()) this.#view = initialView(settings);
    if (!this.#view) this.#view = initialView(settings);
    this.#painted = null;
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

  async #letGo() {
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
    this.#endStroke();
    const panel = this.panel;
    /* Leave the panel dark rather than showing this app's labels to whoever
       picks it up next — the Toolset repaints it when it takes it. */
    if (panel?.available && this.#connected) await panel.command({ clear: true }).catch(() => {});
    for (const off of this.#offs.splice(0)) off();
    await panel?.want(false);
    this.#connected = false;
    this.#painted = null;
    this.#lever = null;
    this.selection.reset();
  }

  #onState(state) {
    const connected = !!state?.connected;
    if (connected === this.#connected) { this.emit('activity'); return; }
    this.#connected = connected;
    this.#lever = null;
    this.#endStroke();
    if (connected) {
      /* A panel found (again) shows whatever the host last had, which after a
         host restart is nothing: paint all of it. */
      this.#painted = null;
      this.#note({ kind: 'connected', note: state.serial ? `panel ${state.serial}` : 'panel connected' });
      void this.refresh();
    } else {
      this.#view && this.#view.held.clear();
      this.#note({ kind: 'disconnected', note: state?.error || (state?.busy ? 'the panel is in use by another program' : 'panel not connected') });
    }
  }

  /* ------------------------------------------------------------ the switcher */

  /** Read the switcher, keep the selection to what is there, and repaint. */
  async refresh() {
    clearTimeout(this.#refreshTimer);
    if (!this.#settings?.barcoEcEnabled) return null;
    try {
      this.facts = await this.switcher.readFacts();
      this.selection.restrict(destinationsOf(this.facts).map((d) => d.id));
      this.#clampView();
      this.#note({ kind: 'read', note: `${destinationsOf(this.facts).length} screens, ${this.facts.presets.length} memories` }, { quiet: true });
    } catch (err) {
      this.#note({ kind: 'error', error: `reading the switcher: ${err.message}` });
    }
    await this.repaint();
    if (this.#connected) {
      this.#refreshTimer = setTimeout(() => { void this.refresh(); }, this.refreshMs);
      this.#refreshTimer.unref?.();
    }
    return this.facts;
  }

  #clampView() {
    if (!this.#view) return;
    const c = this.#counts();
    this.#view.destPage = Math.min(this.#view.destPage, c.dest - 1);
    this.#view.layerPage = Math.min(this.#view.layerPage, c.layer - 1);
    this.#view.rowPages = this.#view.rowPages.map((p, r) => Math.min(p, c.rows[r] - 1));
  }

  #counts() { return pageCounts(this.#view, this.facts, this.selection); }

  #ctx() {
    return { model: this.#settings?.barcoEcModel ?? 'ec-50', view: this.#view, facts: this.facts, selection: this.selection };
  }

  /* ---------------------------------------------------------------- paint */

  /** Send the panel what differs from what it was last sent. One at a time; the newest wins. */
  async repaint() {
    const panel = this.panel;
    if (!this.#view || !panel?.available || !this.#connected) return;
    if (this.#painting) { this.#repaintAgain = true; return; }
    this.#painting = true;
    try {
      do {
        this.#repaintAgain = false;
        const next = paint(this.#ctx());
        const cmd = paintCommand(next, this.#painted);
        if (!cmd.cells.length && !cmd.leds.length) break;
        await panel.command(cmd);
        this.#painted = next;
      } while (this.#repaintAgain);
    } catch (err) {
      this.#painted = null;
      this.#note({ kind: 'error', error: `painting the panel: ${err.message}` });
    } finally {
      this.#painting = false;
    }
  }

  /* ---------------------------------------------------------------- input */

  #onReport(bytes) {
    const r = readReport(bytes);
    if (!r || !this.#settings?.barcoEcEnabled || !this.#view) return;
    if (r.type === 'tbar') { this.#onTbar(r.raw); return; }
    if (r.pressed) this.#view.held.add(r.index); else this.#view.held.delete(r.index);
    void this.repaint();
    if (r.pressed) void this.#onPress(r.index);
  }

  async #onPress(index) {
    const intent = keyIntent(index, this.#ctx());
    if (intent.kind === 'none') {
      this.#note({ kind: 'noted', key: intent.key, note: intent.why });
      return;
    }
    if (intent.kind === 'page' || intent.kind === 'cycleRow') {
      this.#view = applyView(this.#view, intent, this.#counts());
      this.#note({ kind: 'noted', key: intent.key, note: intent.kind === 'cycleRow' ? `row ${intent.row} shows ${this.#view.rowKinds[intent.row]}` : 'page' }, { quiet: true });
      void this.repaint();
      return;
    }
    if (intent.kind === 'select' || intent.kind === 'unselect' || intent.kind === 'selectLayer') {
      const before = this.selection.list.at(-1);
      this.selection.apply(intent);
      /* A new active screen starts on its first page of layers, at layer 1. */
      if (this.selection.list.at(-1) !== before) { this.#view.layerPage = 0; this.selection.layer = 1; }
      this.#note({ kind: 'noted', key: intent.key, note: `selected ${this.selection.list.join(' ') || 'nothing'}, layer ${this.selection.layer}` }, { quiet: true });
      void this.repaint();
      return;
    }
    await this.#perform(intent);
  }

  /** Act on an intent that writes to the switcher. */
  async #perform(intent) {
    const dialect = this.switcher.dialect;
    if (!dialect) { this.#note({ kind: 'error', key: intent.key, error: 'the switcher has not been read yet' }); return; }
    const selected = this.selection.list;
    let letters = new Map();
    let freeze = new Map();
    try {
      if (intent.kind === 'source') letters = await this.switcher.lettersFor(selected, this.selection.buffer);
      if (intent.kind === 'freeze') freeze = await this.switcher.freezeFor(selected);
    } catch (err) {
      this.#note({ kind: 'error', key: intent.key, error: err.message });
      return;
    }
    const { writes, note } = writesFor(intent, {
      dialect,
      commands: commandsFor(dialect),
      selected,
      layer: this.selection.layer,
      buffer: this.selection.buffer,
      letterFor: (id) => letters.get(id) || null,
      freezeOf: (id) => freeze.get(id) || null,
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
  }

  /* --------------------------------------------------------------- T-bar */

  /**
   * The lever moved. The first reading after the panel connects is only where
   * it rests; a stroke starts with the next move, from there. Where each
   * selected screen rests is read once per stroke (`tbarWrites` says why);
   * after that each report is a write, one in flight, the newest winning.
   */
  #onTbar(raw) {
    const f = tbarFraction(raw);
    const from = this.#lever;
    this.#lever = f;
    if (from === null) return;
    if (!this.#stroke) {
      const ids = this.selection.list;
      if (!ids.length || !this.switcher.dialect) {
        this.#note({ kind: 'noted', key: 'T-bar', note: 'no screen selected on the panel' }, { quiet: true });
        return;
      }
      this.#stroke = { ids, from, rests: null, pending: null, busy: false, timer: null, lastSent: [] };
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
    if (progress >= 1) {
      this.#note({ kind: 'sent', key: 'T-bar', note: `T-bar take on ${stroke.ids.join(' ')}`, sent: stroke.lastSent });
      this.#endStroke();
      return;
    }
    if (stroke.pending !== null) void this.#pumpTbar();
  }

  #endStroke() {
    if (!this.#stroke) return;
    clearTimeout(this.#stroke.timer);
    this.#stroke = null;
  }

  /* -------------------------------------------------------------- reporting */

  #note(entry, { quiet = false } = {}) {
    const e = { at: Date.now(), ...entry };
    if (!quiet || entry.kind === 'error') {
      this.history.unshift(e);
      this.history.length = Math.min(this.history.length, HISTORY);
      if (entry.error) this.log(`barco-ec: ${entry.error}`);
    }
    this.emit('activity', e);
  }

  describe() {
    const panel = this.panel;
    const status = this.devices()?.status?.() ?? null;
    return {
      enabled: !!this.#settings?.barcoEcEnabled,
      model: this.#settings?.barcoEcModel ?? null,
      host: status ? { installed: status.installed, running: status.running, reason: status.reason } : null,
      panel: {
        available: !!panel?.available,
        reason: panel?.reason ?? null,
        ...(panel?.state ?? {}),
      },
      selection: this.selection.describe(),
      view: this.#view ? {
        destPage: this.#view.destPage,
        layerPage: this.#view.layerPage,
        rowPages: [...this.#view.rowPages],
        rowKinds: [...this.#view.rowKinds],
      } : null,
      switcher: this.facts ? {
        screens: destinationsOf(this.facts).map((d) => ({ id: d.id, label: d.label })),
        memories: this.facts.presets.length,
        inputs: this.facts.sources.LIVE.length,
      } : null,
      stroke: this.#stroke ? { ids: this.#stroke.ids } : null,
      history: this.history,
    };
  }
}
