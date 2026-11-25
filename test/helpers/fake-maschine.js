/*
 * A Maschine MK3 as node-hid and libusb present one, for the tests.
 *
 * The HID half streams controls reports, as a real panel does, and pads
 * reports when a pad is hit; it keeps the last of each LED report written and
 * reads a lamp back by name. The libusb half is interface 5's bulk endpoint:
 * every screen packet sent is read back (`readScreenPacket`) into a picture
 * per screen, so a test asserts what a screen shows, not bytes.
 *
 * **It is what OpenAV Ctlra's MK3 driver says the panel is, nothing more**:
 * never teach it a behaviour nobody has seen on a real one.
 */

import { EventEmitter } from 'node:events';
import {
  VENDOR_ID, PRODUCT_ID, PRODUCT_NAME, HID_INTERFACE, SCREEN_INTERFACE, SCREEN_ENDPOINT, SCREEN_W, SCREEN_H,
  REPORT, BUTTON, PAD_LED_BASE, STRIP_LED_BASE, STRIP_LEDS, KNOBS, KNOB_RANGE, STRIP_MAX,
  buildControls, buildPads, padIndex, slotsOf, readColour, readScreenPacket, fromRgb565,
} from '../../src/core/maschine-mk3.js';

export class FakeMaschine extends EventEmitter {
  constructor() {
    super();
    this.vendorId = VENDOR_ID;
    this.productId = PRODUCT_ID;
    this.product = PRODUCT_NAME;
    this.interface = HID_INTERFACE;
    this.pressed = new Set();
    this.knobs = Array.from({ length: KNOBS }, (_, i) => 100 * i + 17);
    this.encoder = 7;
    this.stripRaw = 0;
    this.counter = 0;
    this.bank0 = null;
    this.bank1 = null;
    this.written = [];
    this.open = false;
    this.closed = false;
    this.screens = [new Uint16Array(SCREEN_W * SCREEN_H), new Uint16Array(SCREEN_W * SCREEN_H)];
    this.packets = [];
  }

  /* ------------------------------------------------------------ node-hid */

  opened() {
    this.open = true;
    this.closed = false;
    /* A real panel streams controls reports; the first only says where everything is. */
    setTimeout(() => this.report(), 0);
  }

  async write(data) {
    if (!this.open) throw new Error('not open');
    const bytes = [...data];
    if (bytes[0] === REPORT.LEDS && bytes.length === 63) this.bank0 = bytes;
    else if (bytes[0] === REPORT.PAD_LEDS && bytes.length === 42) this.bank1 = bytes;
    else throw new Error(`not an LED report: ${bytes.length} bytes, id ${bytes[0]}`);
    this.written.push(bytes);
    return bytes.length;
  }

  async close() { this.closed = true; this.open = false; }

  /* ------------------------------------------------------------ the panel says */

  report() {
    if (!this.open) return;
    this.counter = (this.counter + 1) & 0xffff;
    this.emit('data', Buffer.from(buildControls({
      pressed: [...this.pressed], knobs: this.knobs, encoder: this.encoder, strip: this.stripRaw, counter: this.counter,
    })));
  }

  press(name) { if (!BUTTON.has(name)) throw new Error(`no button ${name}`); this.pressed.add(name); this.report(); }
  release(name) { this.pressed.delete(name); this.report(); }
  tap(name) { this.press(name); this.release(name); }
  /** Turn knob `index` (0..7) by `counts`, wrapping as the panel's does. */
  turn(index, counts) { this.knobs[index] = (((this.knobs[index] + counts) % KNOB_RANGE) + KNOB_RANGE) % KNOB_RANGE; this.report(); }
  /** Click the main encoder `clicks` times, signed. */
  click(clicks) { this.encoder = (((this.encoder + clicks) % 16) + 16) % 16; this.report(); }
  /** A finger on the strip at 0..1, or null to lift it. */
  touch(fraction) { this.stripRaw = fraction === null ? 0 : Math.max(1, Math.round(fraction * STRIP_MAX)); this.report(); }
  /** Pad number `n` (1 bottom left) hit: a press, then its note on, as Ctlra reads a hit. */
  hit(n, pressure = 2000) {
    if (!this.open) return;
    const pad = padIndex(n);
    this.emit('data', Buffer.from(buildPads([{ pad, event: 'press', pressure }, { pad, event: 'note-on', pressure }])));
  }
  lift(n) {
    if (!this.open) return;
    const pad = padIndex(n);
    this.emit('data', Buffer.from(buildPads([{ pad, event: 'press-off', pressure: 0 }, { pad, event: 'note-off', pressure: 0 }])));
  }
  tapPad(n) { this.hit(n); this.lift(n); }

  /* ------------------------------------------------------------ reading back */

  get slots() { return this.bank0 || this.bank1 ? slotsOf(this.bank0, this.bank1) : null; }
  /** A colour lamp's `{hue, level}`, null when off. */
  colourOf(name) { const s = this.slots; return s ? readColour(s[BUTTON.get(name).led]) : null; }
  /** A mono lamp's brightness, 0..127. */
  brightness(name) { const s = this.slots; return s ? s[BUTTON.get(name).led] : 0; }
  pad(n) { const s = this.slots; return s ? readColour(s[PAD_LED_BASE + padIndex(n)]) : null; }
  strip() { const s = this.slots; return s ? Array.from({ length: STRIP_LEDS }, (_, i) => readColour(s[STRIP_LED_BASE + i])) : []; }
  dark() { const s = this.slots; return !!s && s.every((b) => b === 0); }

  /** The RGB of one pixel of one screen, as it would show. */
  pixel(screen, x, y) {
    const rgba = fromRgb565(this.screens[screen].subarray(y * SCREEN_W + x, y * SCREEN_W + x + 1));
    return [rgba[0], rgba[1], rgba[2]];
  }
  /** How many pixels of a screen are not black. */
  lit(screen) { let n = 0; for (const v of this.screens[screen]) if (v) n++; return n; }
  /** How many pixels in a rect are near this colour. */
  count(screen, { x, y, w, h }, [r, g, b]) {
    let n = 0;
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        const [pr, pg, pb] = this.pixel(screen, col, row);
        if (Math.abs(pr - r) < 24 && Math.abs(pg - g) < 24 && Math.abs(pb - b) < 24) n++;
      }
    }
    return n;
  }

  /* ------------------------------------------------------------ libusb, interface 5 */

  receiveScreen(buf) {
    const packet = readScreenPacket(Uint8Array.from(buf));
    packet.apply(this.screens[packet.screen]);
    this.packets.push({ screen: packet.screen, rect: packet.rect, bytes: buf.length });
  }
}

/** node-hid, over these panels. Opening must be shared, as every panel here is. */
export function fakeMaschineHid(panels) {
  const hid = {
    present: [...panels],
    async devicesAsync() {
      return hid.present.map((p, i) => ({
        vendorId: p.vendorId, productId: p.productId, path: `maschine-${i}`, product: p.product, interface: p.interface, serialNumber: `SN${i}`,
      }));
    },
    HIDAsync: {
      async open(path, opts) {
        if (opts?.nonExclusive !== true) throw new Error('opened exclusively: the panel must be shared');
        const p = hid.present[Number(path.split('-')[1])];
        if (!p) throw new Error('gone');
        p.opened();
        return p;
      },
    },
  };
  return hid;
}

/**
 * The `usb` package over one panel's screens.
 * @param o.refuse  the claim fails as libusb does when someone else holds the interface
 */
export function fakeUsb(panel, { refuse = false } = {}) {
  const usb = {
    claims: 0,
    released: 0,
    findByIds(vid, pid) {
      if (!panel || vid !== VENDOR_ID || pid !== PRODUCT_ID) return undefined;
      return {
        open() {},
        close() {},
        interface(n) {
          if (n !== SCREEN_INTERFACE) return undefined;
          return {
            isKernelDriverActive() { throw new Error('LIBUSB_ERROR_NOT_SUPPORTED'); },
            claim() {
              if (refuse) throw new Error('LIBUSB_ERROR_ACCESS');
              usb.claims++;
            },
            release(_closeEndpoints, cb) { usb.released++; cb?.(); },
            endpoint(address) {
              if (address !== SCREEN_ENDPOINT) return undefined;
              return {
                direction: 'out',
                timeout: 0,
                async transferAsync(buf) { panel.receiveScreen(buf); return buf.length; },
              };
            },
          };
        },
      };
    },
  };
  return usb;
}
