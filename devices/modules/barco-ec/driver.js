/*
 * The Barco EC panel driver — EC-30, EC-40 or EC-50 — held by the device host
 * (`devices/host.js`), a process of its own beside LivePremier Plus.
 * ** PREVIEW **: written from ec50-panel's captures and Barco's button map,
 * and run only against `test/helpers/fake-ec-panel.js`.
 *
 * ## What this does, and what it leaves to the app
 *
 * It finds the panel, puts its FTDI chip in MPSSE mode, sets up the LCD
 * controllers, and then polls one register for the key queue and the T-bar,
 * sending each change to the app as a `report` (`REPORT` in
 * `src/core/ec-panel.js`, which holds the panel's bytes). The other
 * way, it takes `command`s — key labels, backlight colours, lamps — keeps
 * them in a framebuffer and lamp registers of its own, and pushes and latches
 * whatever changed. A panel plugged in later, or found again after a USB
 * hiccup, is painted from that copy at once.
 *
 * What a key MEANS is not here: `plugins/barco-ec/` decides that, and paints
 * accordingly. This knows panels, not the switcher — the device host's rule.
 *
 * ## Held only while it is wanted
 *
 * As with the Speed Editor, the panel is only looked for until the app wants
 * it, and let go when it stops wanting it. Here that matters more: **the panel
 * takes one host at a time**, so while this holds it the Event Master Toolset
 * cannot, and the other way round. Turning the plugin off hands it back.
 *
 * ## Every transaction is one at a time
 *
 * MPSSE is a byte stream with chip select as a pin: two transactions
 * interleaved would be one garbled one. So every USB exchange goes through a
 * single queue (`#io`), and a poll waits behind a label push rather than
 * cutting into it.
 */

import { EventEmitter } from 'node:events';

import {
  VENDOR_ID, PRODUCT_ID, PRODUCT_STRINGS, SETUP_BYTES, INIT_REGS, REG, COMMIT, LED_REGS,
  writeReg, readReg, parseKeys, REPORT, newBuffer, placeCell, setColour, framebufferFrame,
  ledRegisters, BUTTON_BY_INDEX, NUM_CELLS, LED, COLOUR,
} from '../../../src/core/ec-panel.js';
import { render } from '../../../src/core/ec-font.js';

/* How often to look for a panel that is not there. */
const SCAN_MS = 2000;
/* How often to ask for keys. ec50-panel polls every 3 ms; a key press waits at
   most this long, plus one more for the reply's lag. */
const POLL_MS = 5;
/* At most this many queued key events read back to back before yielding. */
const DRAIN = 16;
/* The T-bar's 16-bit reading jitters by a few counts at rest. A move smaller
   than this (about 0.1 % of travel) is not reported. */
const TBAR_DEADBAND = 64;
const IO_TIMEOUT_MS = 1000;
const MAX_LABEL = 64;

/**
 * @param o.ftdi  an FTDI backend (`../../transports/ftdi.js`), or null with `o.reason`
 */
export class BarcoEcDriver extends EventEmitter {
  #queue = Promise.resolve();

  constructor({ ftdi, reason = null, log = () => {}, scanMs = SCAN_MS, pollMs = POLL_MS } = {}) {
    super();
    this.ftdi = ftdi;
    this.reason = reason;
    this.log = log;
    this.scanMs = scanMs;
    this.pollMs = pollMs;
    this.wanted = false;
    this.stopped = true;
    this.present = null;
    this.device = null;
    this.entry = null;
    this.error = ftdi ? null : reason;
    this.timer = null;
    this.pollTimer = null;
    this.scanning = false;
    this.opening = false;
    /* The panel as this app wants it shown — kept while it is not there. */
    this.buffer = newBuffer();
    this.leds = new Map();
    this.dirty = { cells: true, leds: true };
    this.tbar = null;
    this.held = new Set();
    this.stats = { polls: 0, keys: 0, pushes: 0 };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.scan();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    await this.drop();
  }

  /** Open the panel (the app is driving it), or let it go (it is not). */
  async want(wanted) {
    if (this.wanted === wanted) return;
    this.wanted = wanted;
    if (!wanted && this.device) {
      this.log('let the panel go: nothing here is driving it');
      await this.drop();
      this.changed();
    }
    if (!this.stopped) void this.scan();
  }

  get state() {
    return {
      present: !!this.present?.length || !!this.device,
      busy: !this.device && !!this.present?.some((e) => e.busy),
      connected: !!this.device,
      backend: this.ftdi?.name ?? null,
      product: this.device || this.present?.length ? 'Barco EC (Show Console Board)' : null,
      serial: this.entry?.serial ?? null,
      tbar: this.tbar,
      held: [...this.held],
      error: this.error,
      ...this.stats,
    };
  }

  changed() { this.emit('state', this.state); }

  /** Raw output reports are the Speed Editor's road; this panel takes `command`. */
  async write() { return false; }

  /* ------------------------------------------------------------- finding */

  schedule(fn, ms) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(fn, ms);
    this.timer.unref?.();
  }

  async scan() {
    if (this.stopped || this.device || this.scanning || !this.ftdi) return;
    this.scanning = true;
    try {
      const found = await this.ftdi.list({ vid: VENDOR_ID, pid: PRODUCT_ID, descriptions: PRODUCT_STRINGS });
      const before = JSON.stringify(this.present?.map((e) => [e.key, e.busy]) ?? null);
      this.present = found;
      if (JSON.stringify(found.map((e) => [e.key, e.busy])) !== before) this.changed();
      const entry = found.find((e) => !e.busy) ?? found[0];
      if (entry && this.wanted && !this.stopped) await this.open(entry);
    } catch (err) {
      this.fail(`could not look for the panel: ${err.message}`);
    } finally {
      this.scanning = false;
    }
    if (!this.device) this.schedule(() => this.scan(), this.scanMs);
  }

  async open(entry) {
    if (this.opening) return;
    this.opening = true;
    let device;
    try {
      device = await this.ftdi.open(entry);
    } catch (err) {
      this.opening = false;
      this.fail(entry.busy || /busy|access|in use|opened/i.test(err.message)
        ? `the panel is in use by another program — close the Event Master Toolset (${err.message})`
        : `could not open the panel: ${err.message}`);
      return;
    }
    if (this.stopped || !this.wanted) { this.opening = false; await device.close().catch(() => {}); return; }
    this.device = device;
    this.entry = entry;
    try {
      await this.#io(async () => {
        await device.write(SETUP_BYTES);
        for (const [addr, value] of INIT_REGS) await device.write(writeReg(addr, value));
        /* Replies lag one transaction: the first read answers for whatever was
           asked before, so it is read and thrown away. */
        await this.#readKeys(device);
      });
      this.dirty = { cells: true, leds: true };
      await this.push();
    } catch (err) {
      this.opening = false;
      await this.lost(err);
      return;
    }
    this.opening = false;
    /* A first paint that failed has already let the panel go and looked again. */
    if (this.device !== device) return;
    this.error = null;
    this.log(`opened the panel (${this.ftdi.name}${entry.serial ? `, ${entry.serial}` : ''})`);
    this.changed();
    this.pollSoon();
  }

  /** Unplugged, or the chip stopped answering: let go and look again. */
  async lost(err) {
    if (!this.device) return;
    this.log(`panel gone (${err?.message || 'closed'})`);
    this.error = err?.message || null;
    await this.drop();
    this.changed();
    this.schedule(() => this.scan(), this.scanMs);
  }

  async drop() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    const device = this.device;
    this.device = null;
    this.entry = null;
    this.tbar = null;
    /* A key held when the panel went is released as far as the app knows. */
    for (const index of this.held) this.emit('report', Uint8Array.of(REPORT.KEY, index, 0));
    this.held.clear();
    if (device) await this.#io(() => device.close()).catch(() => {});
  }

  fail(message) {
    if (this.error !== message) this.log(message);
    this.error = message;
    this.changed();
  }

  /* --------------------------------------------------------------- input */

  pollSoon() {
    clearTimeout(this.pollTimer);
    if (!this.device || this.stopped) return;
    this.pollTimer = setTimeout(() => { void this.poll(); }, this.pollMs);
    this.pollTimer.unref?.();
  }

  async poll() {
    const device = this.device;
    if (!device) return;
    try {
      for (let n = 0; n < DRAIN; n++) {
        const reading = await this.#io(() => this.#readKeys(device));
        if (device !== this.device) return;
        this.stats.polls++;
        if (!reading) break;
        if (this.tbar === null || Math.abs(reading.tbar - this.tbar) >= TBAR_DEADBAND) {
          this.tbar = reading.tbar;
          this.emit('report', Uint8Array.of(REPORT.TBAR, reading.tbar & 0xff, (reading.tbar >> 8) & 0xff));
        }
        if (!reading.key) break;
        const { index, pressed } = reading.key;
        /* An index the map does not have is a misread, not a key. */
        if (!BUTTON_BY_INDEX.has(index)) continue;
        if (pressed) this.held.add(index); else this.held.delete(index);
        this.stats.keys++;
        this.emit('report', Uint8Array.of(REPORT.KEY, index, pressed ? 1 : 0));
      }
    } catch (err) {
      await this.lost(err);
      return;
    }
    this.pollSoon();
  }

  async #readKeys(device) {
    const { bytes, replyLength } = readReg(REG.KEYS);
    await device.write(bytes);
    return parseKeys(await device.read(replyLength, IO_TIMEOUT_MS));
  }

  /* -------------------------------------------------------------- output */

  /**
   * Labels, backlights and lamps, from the app:
   *
   * ```text
   *   { cells: [{ cell, text, colour, invert }], leds: [{ index, state }], clear: true }
   * ```
   *
   * `clear` blanks every cell and lamp first. Kept here whether or not the
   * panel is connected, and pushed when it is.
   */
  async command(cmd) {
    if (!cmd || typeof cmd !== 'object') throw new Error('a command is an object');
    if (cmd.clear) {
      this.buffer = newBuffer();
      for (let cell = 0; cell < NUM_CELLS; cell++) setColour(this.buffer, cell, COLOUR.OFF);
      this.leds.clear();
      this.dirty = { cells: true, leds: true };
    }
    for (const c of Array.isArray(cmd.cells) ? cmd.cells : []) {
      const cell = Number(c?.cell);
      if (!Number.isInteger(cell) || cell < 0 || cell >= NUM_CELLS) throw new Error(`no LCD cell ${c?.cell}`);
      const text = String(c.text ?? '').slice(0, MAX_LABEL);
      placeCell(this.buffer, cell, render(text, { invert: !!c.invert }));
      if (c.colour !== undefined) {
        const v = Number(c.colour);
        if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`colour ${c.colour} is not a byte`);
        setColour(this.buffer, cell, v);
      }
      this.dirty.cells = true;
    }
    for (const l of Array.isArray(cmd.leds) ? cmd.leds : []) {
      const index = Number(l?.index);
      const state = Number(l?.state);
      if (!BUTTON_BY_INDEX.has(index)) throw new Error(`no key ${l?.index}`);
      if (![LED.OFF, LED.RED, LED.GREEN].includes(state)) throw new Error(`lamp state ${l?.state}`);
      if ((this.leds.get(index) ?? LED.OFF) !== state) { this.leds.set(index, state); this.dirty.leds = true; }
    }
    const pushed = this.device ? await this.push() : false;
    return { connected: !!this.device, pushed };
  }

  /** Send what changed and latch it. The framebuffer goes twice: it is double buffered. */
  async push() {
    const device = this.device;
    if (!device) return false;
    const { cells, leds } = this.dirty;
    if (!cells && !leds) return false;
    this.dirty = { cells: false, leds: false };
    try {
      await this.#io(async () => {
        if (cells) {
          const fb = framebufferFrame(this.buffer);
          for (let pass = 0; pass < 2; pass++) {
            await device.write(fb);
            await device.write(writeReg(REG.COMMIT, COMMIT.LCD));
          }
        }
        if (leds) {
          const regs = ledRegisters(this.leds);
          for (const reg of LED_REGS) await device.write(writeReg(reg, regs.get(reg)));
          await device.write(writeReg(REG.COMMIT, COMMIT.LEDS));
        }
      });
      this.stats.pushes++;
      return true;
    } catch (err) {
      this.dirty = { cells: this.dirty.cells || cells, leds: this.dirty.leds || leds };
      await this.lost(err);
      return false;
    }
  }

  /** One USB exchange at a time, in order; a failure does not stall the queue. */
  #io(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }
}
