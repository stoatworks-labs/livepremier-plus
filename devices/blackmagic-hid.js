/*
 * A Blackmagic HID panel, held by the device host — the Speed Editor's driver,
 * made to serve every Blackmagic panel that speaks the same way.
 *
 * The Speed Editor and the ATEM Micro Panel are one family on the wire: found
 * by vendor and product id over USB or Bluetooth, silent until a
 * challenge-response handshake is answered on a feature report, re-answered
 * before the lease it grants runs out, and otherwise only input reports in
 * and output reports out. What differs is a model: its ids, its handshake
 * (which report it is answered on) and how it reports its battery. A module
 * gives this its model; `modules/speed-editor/driver.js` says why the family
 * is driven from here and not from a page.
 *
 * This was `SpeedEditorDriver` until the Micro Panel arrived (2026-10-20),
 * moved unchanged but for reading the model's ids, handshake and battery
 * where it named the Speed Editor's. That driver is proven on a real panel;
 * `test/devices.test.js` still runs against it, untouched.
 *
 * ## Held only while it is wanted
 *
 * The panel is opened when something here drives it (`want(true)`) and let go
 * when nothing does. Until then it is only looked for, so it shows as found
 * without the host holding it: Blackmagic's own software, or anything else,
 * can have it while nobody here is using it, and an app nobody started never
 * keeps a USB handle — which would also keep Node's event loop alive past a
 * server's close.
 *
 * ## Shared, not seized
 *
 * The device is opened non-exclusively, as it has to be on macOS for anyone
 * else to see it. Blackmagic's software opening it too would answer the same
 * challenge and hear the same keys, so both would act on every press.
 */

import { EventEmitter } from 'node:events';

/* How often to look for a panel that is not there. Enumerating HID devices
   is cheap, and a panel plugged in should be answered within a breath. */
const SCAN_MS = 2000;
/* After a failed handshake: soon, but not so soon it hammers a panel that is
   still coming up after being plugged in. */
const RETRY_MS = 5000;

const toBytes = (data) => Uint8Array.from(data);

/**
 * @typedef {object} BlackmagicHidModel
 * @property {number} vendorId
 * @property {number} productId
 * @property {(io: {sendFeature, getFeature}) => Promise<number>} authenticate
 *           the handshake; resolves with the lease in seconds
 * @property {(bytes: Uint8Array) => ({charging: boolean|null, level: number}|null)} [battery]
 *           a battery reading, when this input report is one
 */

export class BlackmagicHidDriver extends EventEmitter {
  /**
   * @param model {BlackmagicHidModel}
   * @param hid   node-hid's module: `devicesAsync()` and `HIDAsync.open(path, opts)`
   * @param log   fn(message)
   */
  constructor({ model, hid, log = () => {}, scanMs = SCAN_MS, retryMs = RETRY_MS } = {}) {
    super();
    if (!model) throw new Error('a Blackmagic HID driver needs its model');
    this.model = model;
    this.hid = hid;
    this.log = log;
    this.scanMs = scanMs;
    this.retryMs = retryMs;
    this.wanted = false;
    this.present = null;     // what the last scan found, open or not
    this.device = null;
    this.info = null;
    this.authed = false;
    this.lease = null;
    this.battery = null;
    this.error = null;
    this.handshakes = 0;
    this.stopped = true;
    this.timer = null;
    this.scanning = false;
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

  /** Open the panel (something here is driving it), or let it go (nothing is). */
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

  /** What the app is told. */
  get state() {
    return {
      present: !!this.present || !!this.device,
      connected: !!this.device,
      authed: this.authed,
      lease: this.lease,
      product: (this.info ?? this.present)?.product ?? null,
      battery: this.battery,
      error: this.error,
      handshakes: this.handshakes,
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
      const all = await this.hid.devicesAsync();
      const { vendorId, productId } = this.model;
      const info = all.find((d) => d.vendorId === vendorId && d.productId === productId && d.path);
      if (!!this.present !== !!info) { this.present = info ?? null; this.changed(); } else this.present = info ?? null;
      if (info && this.wanted && !this.stopped) await this.open(info);
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
    this.info = info;
    this.error = null;
    device.on('data', (data) => this.onData(data));
    device.on('error', (err) => { void this.lost(err); });
    this.log(`opened ${info.product || 'the panel'}`);
    this.changed();
    await this.handshake();
  }

  /** Unplugged, or the panel went to sleep: let go and look again. */
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
    this.info = null;
    this.authed = false;
    this.lease = null;
    this.battery = null;
    if (device) {
      device.removeAllListeners('data');
      /* An 'error' after close must not throw as an unhandled event. */
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

  /* ---------------------------------------------------------- handshake */

  async handshake() {
    const device = this.device;
    if (!device) return;
    try {
      const lease = await this.model.authenticate({
        sendFeature: (bytes) => device.sendFeatureReport([...bytes]),
        /* At the report's own length — the whole reason this is not WebHID. */
        getFeature: async (id, length) => toBytes(await device.getFeatureReport(id, length)),
      });
      if (device !== this.device) return;
      this.authed = true;
      this.lease = lease;
      this.error = null;
      this.handshakes++;
      /* Renew at half the lease, as node-blackmagic-controller does. */
      this.schedule(() => this.handshake(), (lease || 600) * 500);
      this.emit('authed', this.state);
      this.changed();
    } catch (err) {
      if (device !== this.device) return;
      this.authed = false;
      this.fail(`the panel would not authenticate: ${err.message}`);
      this.schedule(() => this.handshake(), this.retryMs);
    }
  }

  /* ---------------------------------------------------------- the bytes */

  onData(data) {
    const bytes = toBytes(data);
    const reading = this.model.battery ? this.model.battery(bytes) : null;
    if (reading) {
      const was = this.battery;
      this.battery = reading;
      if (!was || was.level !== reading.level || was.charging !== reading.charging) this.changed();
    }
    this.emit('report', bytes);
  }

  /** One output report, id in byte 0. Refused while nobody could hear it. */
  async write(bytes) {
    const device = this.device;
    if (!device || !this.authed) return false;
    try {
      await device.write([...bytes]);
      return true;
    } catch (err) {
      this.log(`a write failed: ${err.message}`);
      return false;
    }
  }
}
