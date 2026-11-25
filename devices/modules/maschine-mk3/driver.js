/*
 * The Maschine MK3 driver: Native Instruments' Maschine MK3, held by the
 * device host. ** PREVIEW **: never yet run against a panel.
 *
 * Two roads to one panel. The keys, knobs, pads, strip and lamps are HID
 * interface 4, through node-hid, opened shared as the X-keys is. The two
 * screens are interface 5, a vendor interface with one bulk OUT endpoint,
 * through libusb (the `usb` package the EC panel's transport already loads).
 * A host with no libusb, or a panel whose interface 5 somebody else has
 * claimed, still has everything but the screens, and `state.screenError`
 * says why. The bytes are `src/core/maschine-mk3.js`.
 *
 * What a key means, and what the screens show, is the plugin's server half
 * (`plugins/maschine/`), which drives the switcher with no page open, as the
 * ATEM Micro Panel's does. The host still knows only the panel: input reports
 * go out as `report` events, LED reports come in through `write`, and a
 * screen comes in through `command({op: 'screens'})` as a short list of
 * drawing operations (`src/core/raster.js`), drawn here. A whole screen is
 * 261 KB of pixels and a command is at most 64 KB of JSON, so the picture is
 * made where it is sent, as the media host makes desk control's.
 *
 * ## Native Instruments' agents
 *
 * ⚠️ NIHostIntegrationAgent (a login item, started with every login) holds
 * the panel for Maschine 2 and Komplete Kontrol. With it running, every
 * press is heard by both, and its claim on interface 5 is what keeps the
 * screens from this. Quit it while this drives the panel (docs/MASCHINE.md
 * says how); it comes back with the next login, or when Maschine 2 opens.
 *
 * ## Screens: only what changed
 *
 * A frame is drawn, turned into RGB565, compared with what that screen was
 * last sent, and only the rows between the first and last that differ go
 * out. A screen with a frame on its way keeps just the newest one waiting, so
 * a slow transfer drops frames rather than queueing them.
 */

import { EventEmitter } from 'node:events';
import * as P from '../../../src/core/maschine-mk3.js';
import { render } from '../../../src/core/raster.js';

/* How often to look for a panel that is not there. */
const SCAN_MS = 2000;
/* A bulk transfer that has not gone in this long has failed. */
const SCREEN_TIMEOUT_MS = 1000;

/** The HID entries that are a Maschine MK3, interface 4 first; macOS and Linux report the interface. */
export function maschinesIn(all) {
  return (all || [])
    .filter((d) => d.vendorId === P.VENDOR_ID && d.productId === P.PRODUCT_ID && d.path)
    .sort((a, b) => (a.interface === P.HID_INTERFACE ? 0 : 1) - (b.interface === P.HID_INTERFACE ? 0 : 1)
      || String(a.path).localeCompare(String(b.path)));
}

export class MaschineMk3Driver extends EventEmitter {
  /**
   * @param hid        node-hid's module: `devicesAsync()` and `HIDAsync.open(path, opts)`
   * @param usb        the `usb` package (v2): `findByIds(vid, pid)`, or null for no screens
   * @param usbReason  why there is no `usb`, when there is none
   */
  constructor({ hid, usb = null, usbReason = null, log = () => {}, scanMs = SCAN_MS } = {}) {
    super();
    this.hid = hid;
    this.usb = usb;
    this.usbReason = usbReason;
    this.log = log;
    this.scanMs = scanMs;
    this.wanted = false;
    this.stopped = true;
    this.present = null;
    this.device = null;
    this.usbDevice = null;
    this.iface = null;
    this.endpoint = null;
    this.error = null;
    this.screenError = null;
    this.timer = null;
    this.scanning = false;
    /* Per screen: the RGB565 it was last sent, a transfer in flight, the newest frame waiting. */
    this.sent = [null, null];
    this.busy = [false, false];
    this.pending = [null, null];
    this.frames = 0;
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
      present: !!this.present || !!this.device,
      connected: !!this.device,
      product: this.present?.product || (this.present ? P.PRODUCT_NAME : null),
      serial: this.present?.serialNumber ?? null,
      screens: !!this.endpoint,
      screenError: this.device && !this.endpoint ? this.screenError : null,
      frames: this.frames,
      error: this.error,
    };
  }

  changed() { this.emit('state', this.state); }

  schedule(fn, ms) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(fn, ms);
    this.timer.unref?.();
  }

  /* ------------------------------------------------------------ finding */

  async scan() {
    if (this.stopped || this.device || this.scanning) return;
    this.scanning = true;
    try {
      const first = maschinesIn(await this.hid.devicesAsync())[0] ?? null;
      const was = this.present;
      this.present = first;
      if (!!was !== !!first || was?.path !== first?.path) this.changed();
      if (first && this.wanted && !this.stopped) await this.open(first);
    } catch (err) {
      this.fail(`could not list HID devices: ${err.message}`);
    } finally {
      this.scanning = false;
    }
    if (!this.device) this.schedule(() => this.scan(), this.scanMs);
  }

  async open(info) {
    let device;
    try {
      device = await this.hid.HIDAsync.open(info.path, { nonExclusive: true });
    } catch (err) {
      this.fail(`could not open the panel: ${err.message}`);
      return;
    }
    if (this.stopped || !this.wanted) { await device.close().catch(() => {}); return; }
    this.device = device;
    this.error = null;
    this.sent = [null, null];
    device.on('data', (data) => this.onData(data));
    device.on('error', (err) => { void this.lost(err); });
    this.openScreens();
    this.log(`opened ${info.product || P.PRODUCT_NAME}; screens ${this.endpoint ? 'claimed' : `not claimed (${this.screenError})`}`);
    this.changed();
  }

  /** Claim interface 5 through libusb. Failing leaves the panel without screens, not without keys. */
  openScreens() {
    this.screenError = null;
    if (!this.usb) { this.screenError = this.usbReason || 'libusb (the usb package) is not loaded'; return; }
    let dev = null;
    try {
      const find = this.usb.findByIds ?? this.usb.usb?.findByIds;
      dev = find ? find(P.VENDOR_ID, P.PRODUCT_ID) : null;
      if (!dev) throw new Error('libusb does not see the panel');
      dev.open();
      const iface = dev.interface(P.SCREEN_INTERFACE);
      if (!iface) throw new Error(`the panel has no interface ${P.SCREEN_INTERFACE}`);
      /* Linux only; macOS and Windows answer "not supported". */
      try { if (iface.isKernelDriverActive()) iface.detachKernelDriver(); } catch { /* not supported here */ }
      iface.claim();
      const ep = iface.endpoint(P.SCREEN_ENDPOINT);
      if (!ep || ep.direction !== 'out') throw new Error(`no OUT endpoint 0x0${P.SCREEN_ENDPOINT.toString(16)}`);
      ep.timeout = SCREEN_TIMEOUT_MS;
      this.usbDevice = dev;
      this.iface = iface;
      this.endpoint = ep;
    } catch (err) {
      this.screenError = /ACCESS|BUSY/i.test(err.message)
        ? `the screens are held by something else (${err.message}): quit NIHostIntegrationAgent`
        : err.message;
      this.usbDevice = dev;
      this.closeScreens();
    }
  }

  closeScreens() {
    const { iface, usbDevice } = this;
    this.endpoint = null;
    this.iface = null;
    this.usbDevice = null;
    const close = () => { try { usbDevice?.close(); } catch { /* gone, or never opened */ } };
    if (iface) {
      try { iface.release(true, close); } catch { close(); }
    } else {
      close();
    }
  }

  /** Unplugged: let go and look again. */
  async lost(err) {
    if (!this.device) return;
    this.log(`panel gone (${err?.message || 'closed'})`);
    await this.drop();
    this.changed();
    this.schedule(() => this.scan(), this.scanMs);
  }

  async drop() {
    const device = this.device;
    this.device = null;
    this.pending = [null, null];
    this.closeScreens();
    if (device) {
      device.removeAllListeners('data');
      device.removeAllListeners('error');
      device.on('error', () => {});
      await device.close().catch(() => {});
    }
  }

  fail(message) {
    if (this.error !== message) this.log(message);
    this.error = message;
    this.changed();
  }

  /* ---------------------------------------------------------- the bytes */

  onData(data) {
    const bytes = Uint8Array.from(data);
    if (bytes[0] === P.REPORT.CONTROLS || bytes[0] === P.REPORT.PADS) this.emit('report', bytes);
  }

  /** One LED report, id first (0x80 or 0x81). Refused while no panel is open. */
  async write(bytes) {
    const device = this.device;
    if (!device) return false;
    if (bytes[0] !== P.REPORT.LEDS && bytes[0] !== P.REPORT.PAD_LEDS) throw new Error('only the LED reports (0x80, 0x81) are written');
    try {
      await device.write([...bytes]);
      return true;
    } catch (err) {
      this.log(`a write failed: ${err.message}`);
      return false;
    }
  }

  /**
   * `{op: 'screens', scenes: [left, right]}`, each a `raster.js` scene
   * (`{background, ops}`) or null to leave that screen as it is. Answers
   * whether the panel has screens here; drawing for none is not an error.
   */
  async command(cmd) {
    if (cmd?.op !== 'screens') throw new Error(`unknown command ${cmd?.op}`);
    const scenes = Array.isArray(cmd.scenes) ? cmd.scenes : [];
    if (!this.device || !this.endpoint) return { screens: false, drawn: 0 };
    let drawn = 0;
    for (let s = 0; s < P.SCREENS; s++) {
      const scene = scenes[s];
      if (!scene || typeof scene !== 'object') continue;
      const pic = render({ background: scene.background, ops: scene.ops, width: P.SCREEN_W, height: P.SCREEN_H });
      this.pending[s] = P.toRgb565(pic.data);
      drawn++;
      if (!this.busy[s]) void this.flush(s);
    }
    return { screens: true, drawn };
  }

  async flush(screen) {
    this.busy[screen] = true;
    try {
      while (this.pending[screen] && this.endpoint) {
        const px = this.pending[screen];
        this.pending[screen] = null;
        const rows = P.dirtyRows(px, this.sent[screen]);
        if (!rows) continue;
        const packet = P.screenPacket(screen, px, { x: 0, y: rows[0], w: P.SCREEN_W, h: rows[1] - rows[0] });
        await this.transfer(packet);
        this.sent[screen] = px;
        this.frames++;
      }
    } catch (err) {
      /* Sent nothing for sure: the next frame goes whole. */
      this.sent[screen] = null;
      this.log(`a screen transfer failed: ${err.message}`);
    } finally {
      this.busy[screen] = false;
    }
  }

  transfer(packet) {
    const ep = this.endpoint;
    if (!ep) return Promise.resolve();
    const buf = Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength);
    if (typeof ep.transferAsync === 'function') return ep.transferAsync(buf);
    return new Promise((resolve, reject) => ep.transfer(buf, (err) => (err ? reject(err) : resolve())));
  }
}
