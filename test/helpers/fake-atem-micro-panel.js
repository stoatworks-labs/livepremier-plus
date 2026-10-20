/*
 * An ATEM Micro Panel as node-hid presents one, for the tests.
 *
 * It runs the real handshake on feature report 5 — a challenge, the answer
 * checked with the vendored `authResponse`, silence until it is answered —
 * and refuses a feature read at any length but the report's own, as the Speed
 * Editor does on macOS. Whether the Micro Panel does that too has not been
 * seen; a driver that reads at the right length passes either way.
 *
 * It keeps the last lamp report written and reads it back by key name, so a
 * test asserts colours, not bits. **It is what node-blackmagic-controller
 * says the panel is, nothing more**: never teach it a behaviour nobody has
 * seen on a real one.
 */

import { EventEmitter } from 'node:events';
import { authResponse } from '../../src/vendor/surface/hid/speed-editor.js';
import {
  VENDOR_ID, PRODUCT_ID, PRODUCT_NAME, REPORT, KEY_BY_NAME, TBAR_SEGMENTS, LED_REPORT_BYTES,
} from '../../src/core/atem-micro-panel.js';

export class FakeMicroPanel extends EventEmitter {
  constructor({ refuse = false } = {}) {
    super();
    this.vendorId = VENDOR_ID;
    this.productId = PRODUCT_ID;
    this.product = PRODUCT_NAME;
    this.challenge = 0x0fedcba987654321n;
    this.step = null;
    this.authed = false;
    this.refuse = refuse;
    this.reads = [];
    this.written = [];
    this.open = false;
    this.closed = false;
  }

  async sendFeatureReport(data) {
    if (data[0] !== REPORT.AUTH) throw new Error(`feature report ${data[0]} is not the handshake`);
    this.step = data[1];
    if (this.step === 0) this.authed = false;
    if (this.step === 3) {
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[2 + i]);
      this.authed = !this.refuse && v === authResponse(this.challenge);
    }
    return data.length;
  }

  async getFeatureReport(id, length) {
    this.reads.push([id, length]);
    if (id !== REPORT.AUTH || length !== 10) throw new Error('IOHIDDeviceGetReport failed: (0xE0005000)');
    const out = Buffer.alloc(10);
    out[0] = REPORT.AUTH;
    if (this.step === 0) {
      for (let i = 0; i < 8; i++) out[2 + i] = Number((this.challenge >> BigInt(8 * i)) & 0xffn);
    } else if (this.step === 1) {
      out[1] = 2;
    } else if (this.step === 3) {
      out[1] = this.authed ? 4 : 0;
      out[2] = 0x58; out[3] = 0x02;                   // 600 s
    }
    return out;
  }

  async write(data) {
    if (!this.authed) throw new Error('not answered: the panel takes nothing yet');
    if (data[0] !== REPORT.OUT_LEDS || data.length !== LED_REPORT_BYTES) throw new Error(`not a lamp report: ${data.length} bytes, id ${data[0]}`);
    this.written.push([...data]);
    return data.length;
  }

  async close() { this.closed = true; this.open = false; }

  /* ------------------------------------------------------------ reading back */

  get lamps() { return this.written.at(-1) ?? null; }
  #bit(n) { const l = this.lamps; return l ? (l[1 + (n >> 3)] >> (n & 7)) & 1 : 0; }
  /** A key's colour, as COLOUR: red 1, green 2, blue 4. */
  colourOf(name) {
    const key = KEY_BY_NAME.get(name);
    if (!key) throw new Error(`no key ${name}`);
    return this.#bit(key.led) | (this.#bit(key.led + 1) << 1) | (this.#bit(key.led + 2) << 2);
  }
  /** How many of the T-bar meter's segments are lit. */
  meterLit() { let n = 0; for (let i = 0; i < TBAR_SEGMENTS; i++) n += this.#bit(i); return n; }
  dark() { const l = this.lamps; return !!l && l.slice(1).every((b) => b === 0); }

  /* ------------------------------------------------------------ the panel says */

  /** Hold exactly these keys (none: everything released). Only once answered. */
  hold(...names) {
    if (!this.authed) return;
    const data = Buffer.alloc(1 + 2 * 16);
    data[0] = REPORT.IN_KEYS;
    names.forEach((name, i) => data.writeUInt16LE(KEY_BY_NAME.get(name).code, 1 + 2 * i));
    this.emit('data', data);
  }
  tap(name, ...alsoHeld) { this.hold(...alsoHeld, name); this.hold(...alsoHeld); }
  setTbar(raw) {
    if (!this.authed) return;
    const data = Buffer.alloc(3);
    data[0] = REPORT.IN_TBAR;
    data.writeUInt16LE(raw, 1);
    this.emit('data', data);
  }
  battery(level) {
    if (!this.authed) return;
    this.emit('data', Buffer.from([REPORT.IN_BATTERY, 0, level]));
  }
}
