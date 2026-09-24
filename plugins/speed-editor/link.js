/*
 * The Speed Editor link — the panel itself, held by this process.
 *
 * ## Why the server, and not WebHID in the page
 *
 * The first build opened the panel from the page over WebHID, and on the
 * first real panel (2026-09-24, USB, Chrome on macOS) it could not get past
 * the handshake. Chrome's `receiveFeatureReport` asks for the *largest*
 * feature report the device declares — 33 bytes, the serial number in report
 * 8 — whatever report it is reading, and the panel refuses a read of any
 * shorter report at that length (`IOHIDDeviceGetReport` 0xE0005000). So the
 * 10-byte challenge in report 6 could never be read, and a page has no way to
 * ask for less. hidapi, which this uses through node-hid, reads at the length
 * it is told, and the same vendored `authenticate` then passes on the real
 * panel with a 600 s lease.
 *
 * WebHID had a second fault the server does not: the panel has no stable
 * identity to Chrome, so every time it re-enumerated the grant was gone and
 * somebody had to choose it again. Here it is found by vendor and product id,
 * on every plug-in.
 *
 * ## What this does, and what it leaves to the page
 *
 * It finds the panel, answers its challenge and keeps the answer renewed, and
 * moves bytes: input reports out as `report` events, output reports (the
 * lamps, the wheel's mode) in through `write`. It decodes nothing but the
 * battery. The mapping — which key does what, pickup, which lamps are lit —
 * is the same Engine the MIDI panel runs, in the page, because that is where
 * the store mirror is and this process deliberately has none (see
 * `server/awj.js`). So the panel drives the switcher while a Web RCS page is
 * open with the Speed Editor started, and not otherwise.
 *
 * ## Held only while it is wanted
 *
 * The panel is opened when a page starts the Speed Editor (`want(true)`) and
 * let go when no page is driving it any more. Until then it is only looked
 * for, so the panel shows as found without this process holding it: DaVinci
 * Resolve, or anything else, can have it while nobody here is using it, and
 * an app nobody started never keeps a USB handle — which would also keep
 * Node's event loop alive past a server's close.
 *
 * ## Shared, not seized
 *
 * The device is opened non-exclusively, as it has to be on macOS for anyone
 * else to see it. DaVinci Resolve opening it too would answer the same
 * challenge and hear the same keys, so both apps would act on every press.
 */

import { EventEmitter } from 'node:events';
import { VENDOR_ID, PRODUCT_ID, REPORT, authenticate, decodeReport } from '../../src/vendor/surface/hid/speed-editor.js';

/* How often to look for a panel that is not there. Enumerating HID devices
   is cheap, and a panel plugged in should be answered within a breath. */
const SCAN_MS = 2000;
/* After a failed handshake: soon, but not so soon it hammers a panel that is
   still coming up after being plugged in. */
const RETRY_MS = 5000;

const toBytes = (data) => Uint8Array.from(data);

/**
 * @param hid   node-hid's module: `devicesAsync()` and `HIDAsync.open(path, opts)`
 * @param log   fn(message)
 */
export class PanelLink extends EventEmitter {
  constructor({ hid, log = () => {}, scanMs = SCAN_MS, retryMs = RETRY_MS } = {}) {
    super();
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

  /** Open the panel (a page is driving it), or let it go (none is). */
  async want(wanted) {
    if (this.wanted === wanted) return;
    this.wanted = wanted;
    if (!wanted && this.device) {
      this.log('let the panel go: no page is driving it');
      await this.drop();
      this.changed();
    }
    if (!this.stopped) void this.scan();
  }

  /** What the page is told. */
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
      const info = all.find((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID && d.path);
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
      const lease = await authenticate({
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
    if (bytes[0] === REPORT.IN_BATTERY) {
      const report = decodeReport(bytes);
      if (report) {
        const next = { charging: report.charging, level: report.level };
        const was = this.battery;
        this.battery = next;
        if (!was || was.level !== next.level || was.charging !== next.charging) this.changed();
      }
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
