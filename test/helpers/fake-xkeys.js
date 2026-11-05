/*
 * An X-keys panel as node-hid presents one, for the tests.
 *
 * It answers the version request with a version report and Generate Data
 * with a key report flagged as the answer, sends a key report whenever a key
 * or the T-bar moves, and keeps every backlight and lamp it is sent, so a
 * test asserts what a key shows, not bytes. Reports in are laid out as the
 * recordings in `test/fixtures/xkeys-recordings.json` show real panels lay
 * them out. **It is what SuperFly.tv's xkeys library says a panel is, nothing
 * more**: never teach it a behaviour nobody has seen on a real one.
 */

import { EventEmitter } from 'node:events';
import { VENDOR_ID, CMD, OUT_BYTES, BACKLIGHT, productOf, keyLocation } from '../../src/core/xkeys.js';

export class FakeXKeys extends EventEmitter {
  constructor({ model = 'XK24', unitId = 0, firmware = 38, answers = true } = {}) {
    super();
    this.p = productOf(model);
    this.vendorId = VENDOR_ID;
    this.productId = this.p.hidDevices[0][0];
    this.interface = this.p.hidDevices[0][1];
    this.product = `${this.p.name} HID`;
    this.unitId = unitId;
    this.firmware = firmware;
    this.answers = answers;
    this.held = new Set();
    this.tbar = 0;
    this.written = [];
    this.leds = new Map();       // LED index → 0 off, 1 on, 2 flash (blue and red banks share the index space)
    this.rgb = new Map();        // LED index → {r,g,b,flash}, for the RGB panels
    this.indicators = { green: 0, red: 0 };
    this.open = true;
    this.closed = false;
  }

  /* ------------------------------------------------------------ the wire */

  async write(data) {
    if (this.closed) throw new Error('could not write to HID device');
    if (data.length !== OUT_BYTES || data[0] !== 0) throw new Error(`not an X-keys report: ${data.length} bytes, id ${data[0]}`);
    this.written.push([...data]);
    const [, cmd, a, b, c, d, e] = data;
    switch (cmd) {
      case CMD.VERSION:
        if (this.answers) queueMicrotask(() => this.#emit(this.#version()));
        break;
      case CMD.GENERATE_DATA:
        if (this.answers) queueMicrotask(() => this.#emit(this.#keys(true)));
        break;
      case CMD.INDICATOR:
        this.indicators[a === 6 ? 'green' : 'red'] = b;
        break;
      case CMD.BACKLIGHT:
        if (this.p.backLightType === BACKLIGHT.REMAP_24) this.rgb.set(a, { g: b, r: c, b: d, flash: !!e });
        else this.leds.set(a, b);
        break;
      case CMD.ALL_BACKLIGHTS:
        /* Bank 0 is blue, 1 red: every LED in that bank. */
        for (const [i] of this.leds) if (this.#bankOf(i) === a) this.leds.set(i, b ? 1 : 0);
        this.allOn = { ...(this.allOn || {}), [a]: b };
        break;
      case CMD.RGB_BACKLIGHT:
        this.rgb.set(`${a}:${b}`, { r: c, g: d, b: e, flash: !!data[7] });
        break;
      case CMD.RGB_ALL:
        this.rgb.clear();
        break;
      default:
    }
    return data.length;
  }

  async close() { this.closed = true; this.open = false; }

  #bankOf(led) { return this.p.backLight2offset && led >= this.p.backLight2offset ? 1 : 0; }

  #emit(bytes) { if (!this.closed) this.emit('data', Buffer.from(bytes)); }

  #version() {
    const out = new Array(32).fill(0);
    out[0] = this.unitId;
    out[1] = 214;
    out[10] = this.firmware;
    out[11] = this.productId & 0xff;
    out[12] = this.productId >> 8;
    return out;
  }

  #keys(generated = false) {
    const out = new Array(Math.max(32, 2 + this.p.bBytes)).fill(0);
    out[0] = this.unitId;
    if (generated) out[1] |= 2;
    if (this.held.has(0)) out[1] |= 1;
    for (const k of this.held) {
      if (k === 0) continue;
      const x = Math.floor((k - 1) / this.p.bBits);
      const y = (k - 1) % this.p.bBits;
      out[2 + x] |= 1 << y;
    }
    for (const t of this.p.hasTbar || []) out[t.tbarByte] = this.tbar;
    return out;
  }

  /* ------------------------------------------------------------ the hand */

  press(index) { this.held.add(index); this.#emit(this.#keys()); }
  release(index) { this.held.delete(index); this.#emit(this.#keys()); }
  tap(index) { this.press(index); this.release(index); }
  setTbar(value) { this.tbar = value; this.#emit(this.#keys()); }
  unplug() { this.closed = true; this.emit('error', new Error('could not read from HID device')); }

  /* ------------------------------------------------------------ reading back */

  /**
   * What a key shows on a two-colour panel: `'off'`, `'blue'`, `'red'` or
   * `'both'`, with `*` when flashing.
   */
  lampOf(index) {
    const at = keyLocation(this.p, index);
    const blue = this.p.backLightType === BACKLIGHT.LINEAR ? index - 1 : (at.col - 1) * 8 + at.row - 1;
    const b = this.leds.get(blue) ?? 0;
    const r = this.leds.get(blue + this.p.backLight2offset) ?? 0;
    const word = b && r ? 'both' : b ? 'blue' : r ? 'red' : 'off';
    return (b === 2 || r === 2) ? `${word}*` : word;
  }

  dark() {
    return [...this.leds.values()].every((v) => v === 0)
      && this.indicators.green === 0 && this.indicators.red === 0
      && this.allOn && this.allOn[0] === 0 && this.allOn[1] === 0;
  }
}

/** node-hid's module shape over a list of fake panels, each on interface 0 as a real one is. */
export function fakeXkeysHid(panels, { extra = [] } = {}) {
  const hid = {
    present: [...panels],
    opened: [],
    async devicesAsync() {
      return [
        ...extra,
        ...hid.present.map((p, i) => ({
          vendorId: p.vendorId, productId: p.productId, interface: p.interface, path: `xkeys-${i}`, product: p.product,
        })),
      ];
    },
    HIDAsync: {
      async open(path, opts) {
        if (opts?.nonExclusive !== true) throw new Error('opened exclusively: the panel must be shared');
        const p = hid.present[Number(path.split('-')[1])];
        if (!p) throw new Error(`no device at ${path}`);
        hid.opened.push(p);
        return p;
      },
    },
  };
  return hid;
}
