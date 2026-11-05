/*
 * The X-keys driver — a P.I. Engineering X-keys panel, held by the device
 * host. ** PREVIEW **: never yet run against a panel.
 *
 * It finds the first X-keys the table knows (`src/core/xkeys.js`, from
 * SuperFly.tv's xkeys library), opens it while it is wanted, asks for its
 * version and for every key's state, and then only moves bytes: key reports
 * out as `report` events, backlight and lamp reports in through `write`. What
 * a key means is the plugin's server half (`plugins/xkeys/`), which drives the
 * switcher with no page open, as the ATEM Micro Panel does.
 *
 * ## Held only while it is wanted, and shared
 *
 * As `../../blackmagic-hid.js` argues: looked for until something here drives
 * it, then opened non-exclusively. ⚠️ So Bitfocus Companion, X-keys'
 * MacroWorks or anything else holding the same panel hears every press too.
 * Turn the panel off in whichever of those is running.
 *
 * ## One panel
 *
 * The first X-keys found, by path, is the one driven; the state says how many
 * others there are. Several at once wait for someone to need it.
 */

import { EventEmitter } from 'node:events';
import { VENDOR_ID, findProduct, keysOf, decodeReport, versionRequest, generateDataRequest } from '../../../src/core/xkeys.js';

/* How often to look for a panel that is not there. */
const SCAN_MS = 2000;
/* A panel that has not answered Generate Data by now is asked again; after
   ASKS it is taken as it is, keys arriving as they change. */
const ASK_MS = 1000;
const ASKS = 3;

const toBytes = (data) => Uint8Array.from(data);

/** Every HID entry that is an X-keys this knows, with its product, by path. */
export function xkeysIn(all) {
  return (all || [])
    .filter((d) => d.vendorId === VENDOR_ID && d.path)
    .map((d) => ({ info: d, product: findProduct(d) }))
    .filter((d) => d.product)
    .sort((a, b) => String(a.info.path).localeCompare(String(b.info.path)));
}

export class XKeysDriver extends EventEmitter {
  /**
   * @param hid  node-hid's module: `devicesAsync()` and `HIDAsync.open(path, opts)`
   * @param log  fn(message)
   */
  constructor({ hid, log = () => {}, scanMs = SCAN_MS, askMs = ASK_MS } = {}) {
    super();
    this.hid = hid;
    this.log = log;
    this.scanMs = scanMs;
    this.askMs = askMs;
    this.wanted = false;
    this.present = null;      // `{info, product}` the last scan found, open or not
    this.others = 0;          // more X-keys than the one driven
    this.device = null;
    this.product = null;
    this.ready = false;
    this.unitId = null;
    this.firmware = null;
    this.error = null;
    this.asks = 0;
    this.stopped = true;
    this.timer = null;
    this.askTimer = null;
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

  /** What the app is told. `model` is the table's key, which the plugin reads the panel by. */
  get state() {
    const product = this.product ?? this.present?.product ?? null;
    return {
      present: !!this.present || !!this.device,
      connected: !!this.device,
      ready: this.ready,
      model: product?.model ?? null,
      product: product?.name ?? null,
      productId: (this.device ? this.openedId : this.present?.info.productId) ?? null,
      keys: product ? keysOf(product).length : 0,
      unitId: this.unitId,
      firmware: this.firmware,
      others: this.others,
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
      const found = xkeysIn(await this.hid.devicesAsync());
      const first = found[0] ?? null;
      const was = this.present;
      this.present = first;
      this.others = Math.max(0, found.length - 1);
      if (!!was !== !!first || was?.info.path !== first?.info.path) this.changed();
      if (first && this.wanted && !this.stopped) await this.open(first);
    } catch (err) {
      this.fail(`could not list HID devices: ${err.message}`);
    } finally {
      this.scanning = false;
    }
    if (!this.device) this.schedule(() => this.scan(), this.scanMs);
  }

  async open({ info, product }) {
    let device;
    try {
      device = await this.hid.HIDAsync.open(info.path, { nonExclusive: true });
    } catch (err) {
      this.fail(`could not open the panel: ${err.message}`);
      return;
    }
    if (this.stopped || !this.wanted) { await device.close().catch(() => {}); return; }
    this.device = device;
    this.product = product;
    this.openedId = info.productId;
    this.ready = false;
    this.asks = 0;
    this.error = null;
    device.on('data', (data) => this.onData(data));
    device.on('error', (err) => { void this.lost(err); });
    this.log(`opened ${product.name} (${info.productId})`);
    this.changed();
    await this.send(versionRequest());
    this.ask();
  }

  /** Ask for every key's state, again until it is answered or ASKS have gone unanswered. */
  ask() {
    clearTimeout(this.askTimer);
    if (!this.device || this.ready) return;
    if (this.asks >= ASKS) {
      this.ready = true;
      this.log('the panel never answered Generate Data; taking its keys as they change');
      this.changed();
      return;
    }
    this.asks++;
    void this.send(generateDataRequest());
    this.askTimer = setTimeout(() => this.ask(), this.askMs);
    this.askTimer.unref?.();
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
    clearTimeout(this.askTimer);
    const device = this.device;
    this.device = null;
    this.product = null;
    this.openedId = null;
    this.ready = false;
    this.unitId = null;
    this.firmware = null;
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
    const bytes = toBytes(data);
    const r = decodeReport(this.product, bytes);
    if (r?.type === 'version') {
      const was = this.firmware;
      this.firmware = r.firmware;
      this.unitId = r.unitId;
      if (was !== r.firmware) this.changed();
      return;
    }
    if (r?.type === 'keys') {
      if (!this.ready && (r.generated || this.asks > 0)) {
        this.ready = true;
        this.unitId = r.unitId;
        clearTimeout(this.askTimer);
        this.changed();
      }
      this.emit('report', bytes);
    }
  }

  async send(bytes) {
    const device = this.device;
    if (!device) return false;
    try {
      await device.write([...bytes]);
      return true;
    } catch (err) {
      this.log(`a write failed: ${err.message}`);
      return false;
    }
  }

  /** One output report, id 0 first. Refused while no panel is open. */
  async write(bytes) {
    if (!this.device) return false;
    return this.send(bytes);
  }
}
