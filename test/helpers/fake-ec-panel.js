/*
 * A pretend Barco EC panel, at the level of the bytes on its USB pipe — and
 * an FTDI backend (`devices/transports/ftdi.js`'s interface) that hands it out.
 *
 * It parses the MPSSE stream the way the FT232H does — chip select from the
 * low-byte pin writes, data from the clock-out and clock-in opcodes — and
 * answers as ec50-panel describes the CPLD answering: register writes framed
 * `<addr> <flags> <len-1> [data] AA BB`, nothing taking effect until latched
 * through 0x3828, the framebuffer discarded if its header is zeroed and
 * double buffered so one pass shows a torn panel, and **every read reply one
 * transaction late**. A driver that forgets any of those fails here.
 *
 * What it cannot be is a panel: its rules are what the protocol notes say, and
 * a rule they got wrong is wrong here too.
 */

import {
  VENDOR_ID, PRODUCT_ID, REG, COMMIT, LED_REGS, FB_HEADER, PAYLOAD_LEN, NUM_CELLS, CELL_SIZE, CELL_STRIDE, CELL_H,
  SKEW_ROWS, COLOUR_BASE, BUTTON_BY_INDEX, KEY_IDLE, OP,
} from '../../src/core/ec-panel.js';

const CS_BIT = 0x08;

export class FakeEcPanel {
  constructor({ serial = 'FAKE-EC50', busy = false } = {}) {
    this.serial = serial;
    this.busy = busy;
    this.plugged = true;
    this.open = false;
    this.mode = null;
    this.regs = new Map();          // as written, unlatched
    this.leds = new Map(LED_REGS.map((r) => [r, 0]));   // latched lamps
    this.pendingFb = null;
    this.banks = [null, null];
    this.bank = 0;
    this.fifo = [];
    this.tbarRaw = 0x0040;
    this.out = [6, 0, 0, 0, 0, 0].map(() => 0);   // the reply latched by the last read
    this.rx = [];
    this.cs = false;
    this.mosi = [];
    this.pending = [];              // unparsed MPSSE bytes
    this.log = [];                  // { kind, … } for assertions
    this.badCommands = 0;
    this.discarded = 0;
    this.writes = 0;
  }

  /* ------------------------------------------------------- the operator */

  press(index) { this.fifo.push(0x80 | index); }
  release(index) { this.fifo.push(index); }
  tap(index) { this.press(index); this.release(index); }
  setTbar(raw) { this.tbarRaw = raw & 0xffff; }
  unplug() { this.plugged = false; this.open = false; }

  /* ------------------------------------------------------------ what shows */

  /** The framebuffer on the glass, or null while the two banks disagree (one pass, a torn panel). */
  shown() {
    const [a, b] = this.banks;
    if (!a || !b || a.length !== b.length || a.some((v, i) => v !== b[i])) return null;
    return a;
  }

  /** A cell as drawn, unskewed back to a plain 64 × 32 image (256 bytes). */
  cellImage(cell) {
    const fb = this.shown();
    if (!fb) return null;
    const raw = fb.subarray(cell * CELL_SIZE, (cell + 1) * CELL_SIZE);
    const out = new Uint8Array(raw);
    const half = CELL_STRIDE / 2;
    for (let r = CELL_H - 1; r >= 0; r--) {
      const row = r * CELL_STRIDE;
      if (r - SKEW_ROWS >= 0) out.set(raw.subarray((r - SKEW_ROWS) * CELL_STRIDE + half, (r - SKEW_ROWS + 1) * CELL_STRIDE), row + half);
      else out.fill(0, row + half, row + CELL_STRIDE);
    }
    return out;
  }

  colourOf(cell) {
    const fb = this.shown();
    return fb ? fb[COLOUR_BASE + cell * 4 + 3] : null;
  }

  /** A key's lamp as latched: 0 off, 1 red, 2 green (3 is off too). */
  ledOf(index) {
    const b = BUTTON_BY_INDEX.get(index);
    if (!b || b.reg === null) return null;
    return (this.leds.get(b.reg) >>> b.bit) & 0x3;
  }

  /* ------------------------------------------------------------ the chip */

  feed(bytes) {
    if (!this.plugged || !this.open) throw new Error('LIBUSB_ERROR_NO_DEVICE');
    this.writes++;
    this.pending.push(...bytes);
    for (;;) {
      const p = this.pending;
      if (!p.length) return;
      const op = p[0];
      const need = (n) => p.length >= n;
      if ([0x8a, 0x97, 0x8d, 0x85, 0x87, 0x8b, 0x8c].includes(op)) { p.splice(0, 1); continue; }
      if (op === 0x86 || op === 0x9e) { if (!need(3)) return; p.splice(0, 3); continue; }
      if (op === 0x80 || op === 0x82) {
        if (!need(3)) return;
        const [, value] = p.splice(0, 3);
        if (op === 0x80) this.#pins(value);
        continue;
      }
      if (op === OP.OUT || op === OP.INOUT) {
        if (!need(3)) return;
        const len = (p[1] | (p[2] << 8)) + 1;
        if (!need(3 + len)) return;
        const data = p.slice(3, 3 + len);
        p.splice(0, 3 + len);
        if (!this.cs) { this.log.push({ kind: 'clock-without-cs' }); continue; }
        this.mosi.push(...data);
        if (op === OP.INOUT) this.#clockIn(len);
        continue;
      }
      if (op === OP.IN) {
        if (!need(3)) return;
        const len = (p[1] | (p[2] << 8)) + 1;
        p.splice(0, 3);
        if (!this.cs) { this.log.push({ kind: 'clock-without-cs' }); continue; }
        this.#clockIn(len);
        continue;
      }
      /* What an FT232H says to an opcode it does not know. */
      this.badCommands++;
      this.rx.push(0xfa, op);
      p.splice(0, 1);
    }
  }

  #pins(value) {
    const low = (value & CS_BIT) === 0;
    if (low && !this.cs) { this.cs = true; this.mosi = []; this.misoAt = 0; this.misoFor = null; }
    else if (!low && this.cs) { this.cs = false; this.#transaction(this.mosi); }
  }

  /**
   * Bytes clocked in during a transaction. A read's request is decoded as soon
   * as its header has been clocked out; what comes back is the reply latched
   * by the PREVIOUS read, and this read's register is latched for the next.
   */
  #clockIn(len) {
    if (this.misoFor === null && this.mosi.length >= 4 && (this.mosi[2] & 0x80)) {
      const addr = (this.mosi[0] << 8) | this.mosi[1];
      this.misoFor = [0, 0, 0, 0, ...this.out];
      this.out = this.#window(addr);
    }
    for (let i = 0; i < len; i++) this.rx.push(this.misoFor ? (this.misoFor[this.misoAt++] ?? 0) : 0);
  }

  /** What a read of `addr` latches: six data bytes. */
  #window(addr) {
    if (addr === REG.KEYS) {
      const key = this.fifo.length ? this.fifo.shift() : KEY_IDLE;
      return [this.tbarRaw & 0xff, (this.tbarRaw >> 8) & 0xff, key, 0, 0, 0];
    }
    const v = this.regs.get(addr) ?? 0;
    return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff, 0, 0];
  }

  #transaction(t) {
    if (t.length < 6) { this.log.push({ kind: 'short', bytes: t.length }); return; }
    const addr = (t[0] << 8) | t[1];
    const flags = t[2];
    if (flags & 0x80) { this.log.push({ kind: 'read', addr }); return; }
    if (t[t.length - 2] !== 0xaa || t[t.length - 1] !== 0xbb) { this.log.push({ kind: 'no-tail', addr }); return; }
    if (addr === REG.FRAMEBUFFER) {
      if (t.length !== PAYLOAD_LEN || FB_HEADER.some((b, i) => t[i] !== b)) {
        this.discarded++;
        this.log.push({ kind: 'framebuffer-discarded', length: t.length });
        return;
      }
      this.pendingFb = Uint8Array.from(t);
      this.log.push({ kind: 'framebuffer' });
      return;
    }
    const value = (t[4] | (t[5] << 8) | (t[6] << 16) | (t[7] << 24)) >>> 0;
    this.regs.set(addr, value);
    this.log.push({ kind: 'write', addr, value });
    if (addr === REG.COMMIT) {
      if (value & COMMIT.LEDS) for (const r of LED_REGS) this.leds.set(r, this.regs.get(r) ?? 0);
      if ((value & COMMIT.LCD) && this.pendingFb) {
        this.banks[this.bank] = this.pendingFb;
        this.bank ^= 1;
      }
    }
  }

  take(n) {
    if (!this.plugged || !this.open) throw new Error('LIBUSB_ERROR_NO_DEVICE');
    if (this.rx.length < n) throw new Error(`the panel sent ${this.rx.length} of ${n} bytes`);
    return Uint8Array.from(this.rx.splice(0, n));
  }
}

/** An FTDI backend over pretend panels, for `BarcoEcDriver` and `devices/host.js --ftdi`. */
export function fakeFtdi(panels) {
  return {
    name: 'fake',
    async list({ vid, pid }) {
      if (vid !== VENDOR_ID || pid !== PRODUCT_ID) return [];
      return panels.filter((p) => p.plugged).map((p) => ({ key: `fake:${p.serial}`, serial: p.serial, description: 'EC Show Board', busy: p.busy, panel: p }));
    },
    async open(entry) {
      const p = entry.panel;
      if (!p.plugged) throw new Error('LIBUSB_ERROR_NO_DEVICE');
      if (p.busy || p.open) throw new Error('LIBUSB_ERROR_BUSY');
      p.open = true;
      p.mode = 'mpsse';
      return {
        async write(bytes) { p.feed(bytes); },
        async read(n) { return p.take(n); },
        async purge() { p.rx = []; },
        async close() { p.open = false; p.mode = null; },
      };
    },
  };
}

export { NUM_CELLS };
