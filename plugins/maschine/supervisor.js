/*
 * The Maschine MK3 supervisor.  ** PREVIEW **
 *
 * Holds the panel through the device host (`devices/modules/maschine-mk3/`),
 * reads the switcher in bursts, turns each press, turn and slide into writes,
 * and keeps the panel's lamps and screens in step. `core.js` beside this
 * decides what every control means and what the screens show; this does the
 * I/O.
 *
 * ## In the server, not the page, and read rather than followed
 *
 * As the ATEM Micro Panel's supervisor argues (`plugins/atem-micro-panel/
 * supervisor.js`): a panel on a desk has to work with no browser open, so the
 * switcher is read with `exchange()` bursts through `server/console-switcher.js`
 * and nothing is held open on it. Tally, and the five values the knobs show,
 * are read for the active screen's selected layer after every press that
 * changes them, when the panel connects, and every `TALLY_MS`; names,
 * memories, layers, FTB and freeze every `REFRESH_MS`.
 *
 * ## The knobs
 *
 * A knob turned starts an edit of one parameter of the selected layer, in
 * PREVIEW, on every selected screen. The edit reads where each screen's
 * value is once, then each turn moves every screen's value by the same step
 * and is written, one burst in flight and the newest winning, as a T-bar
 * stroke is. An edit with no turn for `EDIT_IDLE_MS` is over, and the next
 * turn reads again: a value changed from the Web RCS in between is picked up.
 *
 * ## The strip
 *
 * A T-bar with no lever: the lever is where the strip last left it, the lit
 * dot. A touch within `PICKUP` of it starts a stroke and the finger is then
 * the lever; a touch anywhere else is refused, so a hand resting on the strip
 * cannot jump a transition half way. Lifting ends the stroke where it is, as
 * a lever left mid-throw would. A completed take puts the lever at the far
 * end, and the touch that made it does nothing more until it lifts.
 */

import { EventEmitter } from 'node:events';

import { ConsoleSwitcher, sentDetail } from '../../server/console-switcher.js';
import { AWJ_PORT } from '../../server/awj.js';
import { commandsFor } from '../../src/core/commands.js';
import { toAwj } from '../../src/core/paths.js';
import { writesFor, tbarWrites, strokeProgress, STROKE_END, Selection } from '../../src/core/console-intents.js';
import { Mk3Decoder, ledSlots, ledReports, darkReports } from '../../src/core/maschine-mk3.js';
import {
  initialView, buttonIntent, padIntent, encoderIntent, paint, screens, blankScreens,
  knobSpec, knobStep, knobValue, knobText, knobWrites, KNOB_PARAMS,
  selectOnly, destinationsOf, layersOf, activeOf,
} from './core.js';

export const MODULE = 'maschine-mk3';

/* Sixteen screens (eight, and eight more with SHIFT), thirty-two pads' worth of sources and memories. */
const LIMITS = { screens: 24, inputs: 32, memories: 32, layers: 16, stills: 32 };
const REFRESH_MS = 15_000;
const TALLY_MS = 5_000;
/* A strip with no report for this long has stopped; the stroke is over. */
const STROKE_IDLE_MS = 2000;
/* A knob with no turn for this long has stopped; the edit is over. */
const EDIT_IDLE_MS = 1500;
/* How near the lever a touch must land to take it, as a fraction of the strip. */
export const PICKUP = 0.12;
const HISTORY = 40;
const REREAD = new Set(['freeze', 'ftb', 'recall']);
const RETALLY = new Set(['source', 'take', 'cut', 'matchProgram', 'recall']);

export class MaschineSupervisor extends EventEmitter {
  #settings = null;
  #view = initialView();
  #decoder = new Mk3Decoder();
  #sentLeds = null;
  #sentScenes = [null, null];
  #painting = false;
  #repaintAgain = false;
  #refreshTimer = null;
  #tallyTimer = null;
  #offs = [];
  #connected = false;
  #screens = false;
  #stroke = null;
  #touch = 'none';          // 'none' | 'refused' | 'spent': the strip's current touch, when it starts no stroke
  #tally = null;
  #params = new Map();
  #edits = new Map();
  #error = null;
  #said = null;

  /**
   * @param {object} o
   * @param {() => string|null} o.deviceHost  the switcher's host, read per use
   * @param {() => object|null} o.devices     the app's `devices` service, read per use
   */
  constructor({
    deviceHost = () => null, devices = () => null, awjPort = AWJ_PORT, log = () => {},
    refreshMs = REFRESH_MS, tallyMs = TALLY_MS, editIdleMs = EDIT_IDLE_MS,
  } = {}) {
    super();
    this.deviceHost = deviceHost;
    this.devices = devices;
    this.log = log;
    this.refreshMs = refreshMs;
    this.tallyMs = tallyMs;
    this.editIdleMs = editIdleMs;
    this.switcher = new ConsoleSwitcher({ deviceHost: () => this.deviceHost(), awjPort, limits: LIMITS });
    this.selection = new Selection();
    this.history = [];
    this.facts = null;
  }

  get panel() { return this.devices()?.module?.(MODULE) ?? null; }
  get enabled() { return !!this.#settings?.maschineEnabled; }

  /* ------------------------------------------------------------ lifecycle */

  /** Follow the settings: hold the panel while enabled, let it go when not. */
  async apply(settings) {
    const was = this.#settings;
    this.#settings = settings;
    const panel = this.panel;
    if (!settings?.maschineEnabled) {
      if (was?.maschineEnabled) await this.#letGo();
      this.#note({ kind: 'stopped' });
      return this.describe();
    }
    if (!was?.maschineEnabled) this.#view = initialView();
    this.#sentLeds = null;
    this.#sentScenes = [null, null];
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
    clearTimeout(this.#tallyTimer);
    this.#refreshTimer = null;
    this.#tallyTimer = null;
    /* Nothing paints from here on — a tally read still in flight finishes
       into a panel that is not ours any more — and a paint already on its
       way lands before the dark one, not after it. */
    const wasConnected = this.#connected;
    this.#connected = false;
    this.#endStroke();
    this.#endEdits();
    while (this.#painting) await new Promise((r) => setTimeout(r, 5));
    const panel = this.panel;
    /* Dark, rather than this app's tally, for whoever picks the panel up next. */
    if (panel?.available && wasConnected) {
      await panel.write(darkReports().map((r) => [...r])).catch(() => {});
      if (this.#screens) await panel.command({ op: 'screens', scenes: blankScreens() }).catch(() => {});
    }
    for (const off of this.#offs.splice(0)) off();
    await panel?.want(false);
    this.#sentLeds = null;
    this.#sentScenes = [null, null];
    this.#screens = false;
    this.#touch = 'none';
    this.#tally = null;
    this.#params = new Map();
    this.#view = initialView();
    this.selection.reset();
  }

  #onState(state) {
    const live = !!state?.connected;
    const screensNow = live && !!state?.screens;
    if (screensNow !== this.#screens) {
      this.#screens = screensNow;
      this.#sentScenes = [null, null];
      if (live === this.#connected) void this.repaint();
    }
    if (live === this.#connected) { this.emit('activity'); return; }
    this.#connected = live;
    this.#decoder = new Mk3Decoder();
    this.#touch = 'none';
    this.#view.held.clear();
    this.#view.pads.clear();
    this.#view.shift = false;
    this.#endStroke();
    this.#endEdits();
    if (live) {
      /* A panel found (again) shows whatever it last had: paint all of it. */
      this.#sentLeds = null;
      this.#sentScenes = [null, null];
      const screensWord = state.screens ? 'with its screens' : `without its screens (${state.screenError || 'not claimed'})`;
      this.#note({ kind: 'connected', note: `${state.product || 'Maschine MK3'} opened, ${screensWord}` });
      void this.refresh();
    } else {
      clearTimeout(this.#tallyTimer);
      this.#note({ kind: 'disconnected', note: state?.error || (state?.present ? 'panel found, not held' : 'panel not connected') });
    }
  }

  /* ------------------------------------------------------------ the switcher */

  /** Read the switcher, keep the selection to what is there, read tally, repaint. */
  async refresh() {
    clearTimeout(this.#refreshTimer);
    if (!this.enabled) return null;
    try {
      this.facts = await this.switcher.readFacts();
      this.#error = null;
      const dests = destinationsOf(this.facts);
      this.selection.restrict(dests.map((d) => d.id));
      /* With nothing selected, the first screen is driven: a panel always drives something. */
      if (!this.selection.list.length && dests.length) this.#activate(dests[0].id);
      this.#keepLayer();
      this.#note({ kind: 'read', note: `${dests.length} screens, ${this.facts.presets.length} memories` }, { quiet: true });
    } catch (err) {
      this.#error = err.message;
      this.#note({ kind: 'error', error: `reading the switcher: ${err.message}` });
    }
    await this.refreshTally();
    if (this.#connected) {
      this.#refreshTimer = setTimeout(() => { void this.refresh(); }, this.refreshMs);
      this.#refreshTimer.unref?.();
    }
    return this.facts;
  }

  /** Tally and the knobs' values for the selected layer of the active screen; then repaint. */
  async refreshTally() {
    clearTimeout(this.#tallyTimer);
    if (!this.enabled) return null;
    const active = activeOf(this.selection);
    if (active && this.switcher.dialect) {
      try {
        const got = await this.switcher.tallyFor([active], this.selection.layer);
        this.#tally = got.get(active) ?? null;
        this.#params = await this.#readParams(active, this.selection.layer);
      } catch (err) {
        this.#tally = null;
        this.#note({ kind: 'error', error: `reading tally: ${err.message}` });
      }
    } else {
      this.#tally = null;
      this.#params = new Map();
    }
    await this.repaint();
    if (this.#connected) {
      this.#tallyTimer = setTimeout(() => { void this.refreshTally(); }, this.tallyMs);
      this.#tallyTimer.unref?.();
    }
    return this.#tally;
  }

  /** The knobs' parameters on one screen's layer in preview, by param name. */
  async #readParams(id, layer) {
    const dialect = this.switcher.dialect;
    const specs = KNOB_PARAMS.map((k) => knobSpec(k.knob, dialect)).filter(Boolean);
    const letter = (await this.switcher.lettersFor([id], 'PREVIEW')).get(id);
    if (!letter || !specs.length) return new Map();
    const paths = specs.map((s) => dialect.layerParamPath(id, letter, layer, s.tail));
    const got = await this.switcher.read(paths);
    return new Map(specs.map((s, i) => [s.param, got.get(toAwj(paths[i]))]));
  }

  #activate(id) {
    selectOnly(this.selection, id);
    this.selection.layer = layersOf(this.facts, id)[0] ?? 1;
  }

  #keepLayer() {
    const layers = layersOf(this.facts, activeOf(this.selection));
    if (layers.length && !layers.includes(this.selection.layer)) this.selection.layer = layers[0];
  }

  #ctx() {
    return { view: this.#view, facts: this.facts, selection: this.selection, memoryLimit: LIMITS.memories };
  }

  /* ---------------------------------------------------------------- paint */

  /** Send the lamps, and each screen, when they differ from the last sent. One at a time; the newest wins. */
  async repaint() {
    const panel = this.panel;
    if (!panel?.available || !this.#connected || !this.enabled) return;
    if (this.#painting) { this.#repaintAgain = true; return; }
    this.#painting = true;
    try {
      do {
        this.#repaintAgain = false;
        const stroke = this.#strokeShown();
        const lights = paint({ ...this.#ctx(), tally: this.#tally, stroke });
        const leds = ledReports(ledSlots(lights)).map((r) => [...r]);
        const key = leds.map((r) => r.join()).join('|');
        if (this.#sentLeds !== key) {
          const written = await panel.write(leds);
          this.#sentLeds = written === leds.length ? key : null;
        }
        if (!this.#screens) continue;
        const scenes = screens({
          ...this.#ctx(), tally: this.#tally, stroke, params: this.#params,
          editing: this.#editing(), note: this.#said, error: this.#error,
        });
        const json = scenes.map((s) => JSON.stringify(s));
        const send = json.map((j, i) => (j === this.#sentScenes[i] ? null : scenes[i]));
        if (send.some(Boolean)) {
          const answer = await panel.command({ op: 'screens', scenes: send });
          this.#sentScenes = answer && answer.screens ? json : [null, null];
        }
      } while (this.#repaintAgain);
    } catch (err) {
      this.#sentLeds = null;
      this.#sentScenes = [null, null];
      this.#note({ kind: 'error', error: `lighting the panel: ${err.message}` }, { repaint: false });
    } finally {
      this.#painting = false;
    }
  }

  #strokeShown() {
    const s = this.#stroke;
    return s ? { from: s.from, at: s.at, progress: s.progress ?? 0 } : null;
  }

  /** Knob index → the active screen's value, for the knobs being turned. */
  #editing() {
    const active = activeOf(this.selection);
    const out = new Map();
    for (const [index, edit] of this.#edits) {
      const v = edit.values ? edit.values.get(active) : undefined;
      out.set(index, typeof v === 'number' ? v : undefined);
    }
    return out;
  }

  /* ---------------------------------------------------------------- input */

  #onReport(bytes) {
    if (!this.enabled) return;
    const events = this.#decoder.decode(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
    let moved = false;
    for (const e of events) {
      if (e.type === 'button') {
        if (e.pressed) this.#view.held.add(e.name);
        else this.#view.held.delete(e.name);
        this.#view.shift = this.#view.held.has('shift');
        moved = true;
        if (e.pressed) void this.#act(buttonIntent(e.name, this.#ctx()));
      } else if (e.type === 'pad') {
        if (e.pressed) this.#view.pads.add(e.number);
        else this.#view.pads.delete(e.number);
        moved = true;
        if (e.pressed) void this.#act(padIntent(e.number, this.#ctx()));
      } else if (e.type === 'encoder') {
        void this.#act(encoderIntent(e.delta, this.#ctx()));
      } else if (e.type === 'knob') {
        this.#onKnob(e.index, e.delta);
      } else if (e.type === 'strip') {
        this.#onStrip(e.value);
      }
    }
    if (moved) void this.repaint();
  }

  async #act(intent) {
    switch (intent.kind) {
      case 'shift':
      case 'touch':
        return;
      case 'none':
        this.#note({ kind: 'noted', key: intent.key, note: intent.why }, { quiet: !!intent.quiet });
        return;
      case 'padKind': {
        this.#view.padKind = intent.padKind;
        const word = { LIVE: 'inputs', STILL: 'stills', SCREEN: 'screens', MEMORY: 'memories, recalled to preview' }[intent.padKind];
        this.#note({ kind: 'noted', key: intent.key, note: `the pads hold ${word}` }, { quiet: true });
        void this.repaint();
        return;
      }
      case 'selectOnly':
      case 'select':
      case 'unselect':
      case 'selectLayer': {
        const before = activeOf(this.selection);
        if (intent.kind === 'selectOnly') selectOnly(this.selection, intent.destination);
        else this.selection.apply(intent);
        if (activeOf(this.selection) !== before) this.selection.layer = layersOf(this.facts, activeOf(this.selection))[0] ?? 1;
        this.#note({ kind: 'noted', key: intent.key, note: `driving ${this.selection.list.join(' ') || 'nothing'}, layer ${this.selection.layer}` }, { quiet: true });
        void this.refreshTally();
        return;
      }
      default:
        await this.#perform(intent);
    }
  }

  /** Act on an intent that writes to the switcher, through `writesFor` as every console does. */
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

  /* ---------------------------------------------------------------- knobs */

  #onKnob(index, counts) {
    const spec = knobSpec(index, this.switcher.dialect);
    const key = `KNOB ${index + 1}`;
    if (!spec) {
      this.#note({ kind: 'noted', key, note: this.switcher.dialect ? `knob ${index + 1} has no job` : 'the switcher has not been read yet' }, { quiet: true });
      return;
    }
    let edit = this.#edits.get(index);
    if (!edit) {
      const ids = this.selection.list;
      if (!ids.length) { this.#note({ kind: 'noted', key, note: 'no screen selected on the panel' }, { quiet: true }); return; }
      edit = { index, key, spec, ids, layer: this.selection.layer, values: null, letters: null, queued: 0, dirty: false, busy: false, timer: null, lastSent: [] };
      this.#edits.set(index, edit);
      void this.#readEdit(edit);
    }
    const fine = this.#view.shift;
    if (edit.values) {
      for (const [id, v] of edit.values) edit.values.set(id, knobValue(spec, v, counts, { fine }));
      edit.dirty = true;
      void this.#pumpEdit(edit);
    } else {
      edit.queued += knobStep(spec, counts, { fine });
    }
    clearTimeout(edit.timer);
    edit.timer = setTimeout(() => this.#endEdit(edit), this.editIdleMs);
    edit.timer.unref?.();
    void this.repaint();
  }

  /** Where each selected screen's value is, read once per edit, with what was turned meanwhile added. */
  async #readEdit(edit) {
    const dialect = this.switcher.dialect;
    try {
      edit.letters = await this.switcher.lettersFor(edit.ids, 'PREVIEW');
      const paths = new Map();
      for (const id of edit.ids) {
        const letter = edit.letters.get(id);
        if (letter) paths.set(id, dialect.layerParamPath(id, letter, edit.layer, edit.spec.tail));
      }
      const got = await this.switcher.read([...paths.values()]);
      const values = new Map();
      for (const [id, path] of paths) {
        const v = got.get(toAwj(path));
        if (typeof v === 'number') values.set(id, Math.min(edit.spec.max, Math.max(edit.spec.min, v + edit.queued)));
      }
      if (this.#edits.get(edit.index) !== edit) return;
      edit.values = values;
      edit.dirty = edit.queued !== 0;
      edit.queued = 0;
      if (!values.size) this.#note({ kind: 'noted', key: edit.key, note: `${edit.spec.label.toLowerCase()} could not be read on ${edit.ids.join(' ')}` });
    } catch (err) {
      this.#note({ kind: 'error', key: edit.key, error: err.message });
      this.#endEdit(edit, { quiet: true });
      return;
    }
    void this.#pumpEdit(edit);
  }

  async #pumpEdit(edit) {
    if (edit.busy || !edit.dirty || !edit.values) return;
    edit.busy = true;
    edit.dirty = false;
    const writes = knobWrites({
      dialect: this.switcher.dialect, spec: edit.spec, layer: edit.layer, values: edit.values,
      letterFor: (id) => edit.letters.get(id) || null,
    });
    try {
      if (writes.length) {
        edit.lastSent = sentDetail(writes);
        await this.switcher.write(writes);
      }
    } catch (err) {
      this.#note({ kind: 'error', key: edit.key, error: err.message });
    }
    edit.busy = false;
    void this.repaint();
    if (edit.dirty) void this.#pumpEdit(edit);
  }

  #endEdit(edit, { quiet = false } = {}) {
    clearTimeout(edit.timer);
    if (this.#edits.get(edit.index) !== edit) return;
    this.#edits.delete(edit.index);
    const active = activeOf(this.selection);
    const v = edit.values ? edit.values.get(active) ?? [...edit.values.values()][0] : undefined;
    /* What was written is what the screen shows until the next read. */
    if (typeof v === 'number' && edit.layer === this.selection.layer && edit.ids.includes(active)) this.#params.set(edit.spec.param, Math.round(v));
    if (!quiet && edit.lastSent.length) {
      this.#note({ kind: 'sent', key: edit.key, note: `${edit.spec.label.toLowerCase()} ${knobText(edit.spec, v)} on ${edit.ids.join(' ')}, layer ${edit.layer}, in preview`, sent: edit.lastSent });
    }
    void this.repaint();
  }

  #endEdits() {
    for (const edit of [...this.#edits.values()]) this.#endEdit(edit, { quiet: true });
  }

  /* --------------------------------------------------------------- strip */

  #onStrip(value) {
    if (value === null) {
      this.#touch = 'none';
      if (this.#stroke) this.#endStroke();
      return;
    }
    if (!this.#stroke) {
      if (this.#touch !== 'none') return;
      const lever = this.#view.lever;
      if (Math.abs(value - lever) > PICKUP) {
        this.#touch = 'refused';
        this.#note({ kind: 'noted', key: 'STRIP', note: `touch the strip at the lit dot (${lever < 0.5 ? 'the left end' : lever > 0.5 ? 'the right end' : 'the middle'}) to move the T-bar` });
        return;
      }
      const ids = this.selection.list;
      if (!ids.length || !this.switcher.dialect) {
        this.#touch = 'refused';
        this.#note({ kind: 'noted', key: 'STRIP', note: 'no screen selected on the panel' }, { quiet: true });
        return;
      }
      this.#stroke = { ids, from: lever, at: value, rests: null, pending: null, busy: false, timer: null, lastSent: [], progress: 0 };
      void this.#readRests(this.#stroke);
    }
    const stroke = this.#stroke;
    stroke.at = value;
    stroke.pending = value;
    this.#view.lever = value;
    clearTimeout(stroke.timer);
    stroke.timer = setTimeout(() => this.#endStroke(), STROKE_IDLE_MS);
    stroke.timer.unref?.();
    void this.#pumpStrip();
  }

  async #readRests(stroke) {
    try {
      stroke.rests = await this.switcher.restsFor(stroke.ids);
    } catch (err) {
      this.#note({ kind: 'error', key: 'STRIP', error: err.message });
      if (this.#stroke === stroke) this.#endStroke();
      return;
    }
    void this.#pumpStrip();
  }

  async #pumpStrip() {
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
      this.#note({ kind: 'error', key: 'STRIP', error: err.message });
    }
    stroke.busy = false;
    void this.repaint();
    if (progress >= 1) {
      /* The take is made: the lever is at the far end, and this touch is spent. */
      this.#view.lever = stroke.from < 0.5 ? 1 : 0;
      this.#touch = 'spent';
      this.#note({ kind: 'sent', key: 'STRIP', note: `T-bar take on ${stroke.ids.join(' ')}`, sent: stroke.lastSent });
      this.#endStroke();
      void this.refreshTally();
      return;
    }
    if (stroke.pending !== null) void this.#pumpStrip();
  }

  #endStroke() {
    if (!this.#stroke) return;
    clearTimeout(this.#stroke.timer);
    this.#stroke = null;
    void this.repaint();
  }

  /* -------------------------------------------------------------- reporting */

  /** Into the history (unless quiet), and onto the right-hand screen; `repaint: false` from a paint that failed. */
  #note(entry, { quiet = false, repaint = true } = {}) {
    const e = { at: Date.now(), ...entry };
    if (!quiet || entry.kind === 'error') {
      this.history.unshift(e);
      this.history.length = Math.min(this.history.length, HISTORY);
      if (entry.error) this.log(`maschine: ${entry.error}`);
    }
    if ((entry.note || entry.error) && entry.kind !== 'read') {
      this.#said = { text: entry.error || entry.note, error: !!entry.error };
      if (repaint) void this.repaint();
    }
    this.emit('activity', e);
  }

  describe() {
    const panel = this.panel;
    const status = this.devices()?.status?.() ?? null;
    return {
      enabled: this.enabled,
      host: status ? { installed: status.installed, running: status.running, reason: status.reason } : null,
      panel: {
        available: !!panel?.available,
        reason: panel?.reason ?? null,
        ...(panel?.state ?? {}),
      },
      selection: this.selection.describe(),
      view: { padKind: this.#view.padKind, shift: this.#view.shift, lever: this.#view.lever },
      tally: this.#tally,
      params: Object.fromEntries(this.#params),
      switcher: this.facts ? {
        screens: destinationsOf(this.facts).map((d) => ({ id: d.id, label: d.label })),
        memories: this.facts.presets.length,
        inputs: this.facts.sources.LIVE.length,
      } : null,
      stroke: this.#stroke ? { ids: this.#stroke.ids, progress: this.#stroke.progress } : null,
      edits: [...this.#edits.values()].map((e) => ({ knob: e.index + 1, param: e.spec.param, ids: e.ids })),
      history: this.history,
    };
  }
}
