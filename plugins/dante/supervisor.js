/*
 * Dante — the devices this app is reading: one reader per device found by
 * discovery or configured by address, each polling its receive channels so
 * the grid stays true when somebody changes a subscription elsewhere, and the
 * writes, which are sent and then read back.
 *
 * ## What a reader asks, and in which dialect
 *
 * Every device is asked its name, its channel counts and its settings (sample
 * rate, latency) under the classic protocol id — netaudio does the same for
 * every revision (`client.rs`, `get_device_name` / `get_channel_count`). The
 * channel inventory then depends on the revision the device advertised:
 *
 * - **ARC 2.8.9 and later** ("modern"): paged channel-status queries, `0x3400`
 *   and `0x2400`. A device that answers those with `0x0030` (front end
 *   unavailable) is read the classic way instead, as netaudio falls back.
 * - **Earlier, or not said**: the classic pages, `0x3000` / `0x2000` / `0x2010`.
 *
 * A device configured by address has no TXT record to say. It is read the
 * classic way, and if that fails, the modern way under 2.8.9.
 *
 * ## How a write goes out
 *
 * `writeForm` picks one of three encodings, each from `protocol.js`, and the
 * reasons are in `docs/DANTE.md`:
 *
 * - `modern` — the subscription page Dante Controller sends a 2.8.9 device;
 * - `page-2729` — the page Dante Controller sends a 2.7.41 device;
 * - `classic` — netaudio's add and remove, for everything else that read
 *   cleanly the classic way.
 *
 * A device whose revision netaudio refuses is read but never written.
 */

import { EventEmitter } from 'node:events';
import { DanteLink } from './link.js';
import * as P from './protocol.js';

const TX_EVERY = 6;            // re-read transmit channels and the name every Nth poll
const UNREACHABLE_AFTER = 2;   // polls in a row without an answer
const MAX_PAGES = 64;
/* After a write, how long to give the device before reading back: a Dante
   card answers the write at once and fills in the new subscription a moment
   later. */
const SETTLE_MS = 150;

/** Which encoding writes to a device, or null with the reason. */
export function writeForm(state) {
  if (state.status !== 'ok') return { form: null, why: `${state.name || state.address} is not answering` };
  if (state.protocol && state.protocol.error) return { form: null, why: `${state.name} advertises ${state.protocol.error}; it is read but never written` };
  if (state.inventory === 'modern') return { form: 'modern' };
  if (state.protocol && state.protocol.protocolId === P.PROTOCOL.ARC_2729) return { form: 'page-2729' };
  if (state.inventory === 'classic') return { form: 'classic' };
  return { form: null, why: `${state.name} has not been read yet` };
}

/** `0x2809` → `2.8.9`, the way a device advertises it. */
export const revisionLabel = (id) => (id ? `${id >> 12}.${(id >> 8) & 0xf}.${id & 0xff}` : null);

export class DeviceReader extends EventEmitter {
  constructor({ key, address, port, source, mdns = null, pollMs, log = () => {}, linkOptions = {} }) {
    super();
    this.key = key;
    this.log = log;
    this.pollMs = pollMs;
    this.link = new DanteLink({ address, port, log, ...linkOptions });
    this.polls = 0;
    this.misses = 0;
    this.timer = null;
    this.stopped = false;
    this.reading = null;
    this.state = {
      key, address, port, source,
      name: mdns ? mdns.name : null,
      mdnsName: mdns ? mdns.name : null,
      txt: mdns ? mdns.txt : {},
      deviceId: mdns ? mdns.deviceId : null,
      mac: mdns ? mdns.mac : null,
      manufacturer: mdns && mdns.txt ? mdns.txt.mf || null : null,
      model: mdns && mdns.txt ? mdns.txt.model || null : null,
      protocol: mdns ? P.arcProtocol(mdns.txt && mdns.txt.arcp_vers) : null,
      inventory: null,           // 'classic' | 'modern', once a read has worked
      status: 'reading',
      error: null,
      lastRead: null,
      sampleRate: null,
      latencyNs: null,
      txCount: null,
      rxCount: null,
      tx: [],
      rx: []
    };
  }

  /** New advertisement data for the same address: a renamed device or a changed TXT. */
  update(mdns) {
    if (!mdns) return;
    const s = this.state;
    s.mdnsName = mdns.name;
    if (!s.name) s.name = mdns.name;
    s.txt = mdns.txt || s.txt;
    if (mdns.deviceId) { s.deviceId = mdns.deviceId; s.mac = mdns.mac; }
    if (mdns.txt && mdns.txt.mf) s.manufacturer = mdns.txt.mf;
    if (mdns.txt && mdns.txt.model) s.model = mdns.txt.model;
    const p = P.arcProtocol(mdns.txt && mdns.txt.arcp_vers);
    if (JSON.stringify(p) !== JSON.stringify(s.protocol)) { s.protocol = p; s.inventory = null; }
  }

  start() {
    this.stopped = false;
    this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.link.close();
  }

  schedule() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    /* A device that is not answering is asked less often, up to a minute. */
    const backoff = this.state.status === 'unreachable' ? Math.min(60000, this.pollMs * 2 ** Math.min(this.misses, 4)) : this.pollMs;
    this.timer = setTimeout(() => this.tick(), backoff);
    this.timer.unref?.();
  }

  async tick() {
    if (this.stopped) return;
    const full = this.polls % TX_EVERY === 0 || this.state.status !== 'ok';
    this.polls += 1;
    await this.read(full);
    this.schedule();
  }

  /** Read now; a read already running is joined rather than doubled. */
  read(full = true) {
    if (this.reading) return this.reading;
    this.reading = (full ? this.readAll() : this.readRx())
      .then(() => { this.misses = 0; this.setStatus('ok', null); })
      .catch((err) => {
        this.misses += 1;
        if (this.stopped) return;
        const unreachable = /no answer/.test(err.message);
        if (!unreachable || this.misses >= UNREACHABLE_AFTER || this.state.status !== 'ok') {
          this.setStatus(unreachable ? 'unreachable' : 'error', err.message);
        }
      })
      .finally(() => { this.reading = null; });
    return this.reading;
  }

  setStatus(status, error) {
    const s = this.state;
    const changed = s.status !== status || s.error !== error;
    s.status = status;
    s.error = error;
    if (status === 'ok') s.lastRead = Date.now();
    if (changed) this.emit('change');
  }

  req(build, parse, what) {
    return this.link.request(build).then((bytes) => {
      const out = parse(bytes);
      if (out == null) throw new Error(`${this.state.name || this.state.address} answered ${what} in a shape this does not read (${P.hex(bytes.subarray(0, 12))}…)`);
      return out;
    });
  }

  async readAll() {
    const s = this.state;
    const name = await this.req(P.buildDeviceName, P.parseDeviceName, 'its name');
    const counts = await this.req(P.buildChannelCount, P.parseChannelCount, 'its channel count');
    let settings = null;
    try { settings = await this.req(P.buildDeviceSettings, P.parseDeviceSettings, 'its settings'); } catch { /* not every device answers; the rest still reads */ }
    const before = JSON.stringify([s.name, s.txCount, s.rxCount, s.sampleRate, s.latencyNs, s.tx]);
    s.name = name;
    s.txCount = counts.tx;
    s.rxCount = counts.rx;
    if (settings) {
      s.sampleRate = settings.sampleRate ?? s.sampleRate;
      s.latencyNs = settings.latencyNs ?? settings.activeLatencyNs ?? s.latencyNs;
    }
    await this.readInventory(true);
    if (before !== JSON.stringify([s.name, s.txCount, s.rxCount, s.sampleRate, s.latencyNs, s.tx])) this.emit('change');
  }

  async readRx() {
    await this.readInventory(false);
  }

  /** Read the channels in whichever dialect the device speaks, falling back as netaudio does. */
  async readInventory(withTx) {
    const s = this.state;
    const modernFirst = s.inventory ? s.inventory === 'modern' : Boolean(s.protocol && s.protocol.modern);
    const order = modernFirst ? ['modern', 'classic'] : ['classic', 'modern'];
    let lastError = null;
    for (const dialect of order) {
      if (dialect === 'modern' && !modernFirst && s.protocol && !s.protocol.error && !s.protocol.modern) continue;
      try {
        const rx = dialect === 'modern' ? await this.modernRx() : await this.classicRx();
        const tx = withTx ? (dialect === 'modern' ? await this.modernTx() : await this.classicTx()) : null;
        this.commit(rx, tx);
        if (s.inventory !== dialect) { s.inventory = dialect; this.emit('change'); }
        return;
      } catch (err) {
        lastError = err;
        if (/no answer/.test(err.message) && dialect === order[0] && s.inventory) throw err;
      }
    }
    throw lastError || new Error('no inventory');
  }

  commit(rx, tx) {
    const s = this.state;
    const next = JSON.stringify(rx);
    if (next !== JSON.stringify(s.rx)) { s.rx = rx; this.emit('change'); }
    if (tx && JSON.stringify(tx) !== JSON.stringify(s.tx)) { s.tx = tx; this.emit('change'); }
    if (!s.sampleRate) {
      const rate = (rx.find((c) => c.sampleRate) || (tx || []).find((c) => c.sampleRate) || {}).sampleRate;
      if (rate) s.sampleRate = rate;
    }
  }

  async classicRx() {
    const count = this.state.rxCount ?? (await this.req(P.buildChannelCount, P.parseChannelCount, 'its channel count')).rx;
    const out = [];
    const pages = Math.max(1, Math.ceil(count / P.RX_PER_PAGE));
    for (let page = 0; page < pages && page < MAX_PAGES; page++) {
      const start = page * P.RX_PER_PAGE + 1;
      const rows = await this.req((t) => P.buildReceivers(page, t), (b) => P.parseRxPage(b, start), `receive channels from ${start}`);
      out.push(...rows.map((c) => ({
        number: c.number, label: c.label,
        sub: c.txChannel ? { channel: c.txChannel, device: c.txDevice || '.' } : null,
        status: P.subscriptionStatus(c.status, c.rxStatus), media: P.MEDIA.AUDIO
      })));
      if (rows.length < P.RX_PER_PAGE) break;
    }
    if (out.length !== count) throw new Error(`${this.state.name} listed ${out.length} of ${count} receive channels`);
    return out;
  }

  async classicTx() {
    const count = this.state.txCount ?? 0;
    if (!count) return [];
    let labels = new Map();
    try {
      labels = new Map(await this.req((t) => P.buildTransmitterNames(count, t), (b) => P.parseTxNamesPage(b, 1), 'its transmit labels'));
    } catch { /* the factory names still read; a label just shows as its name */ }
    const out = [];
    const pages = Math.ceil(count / P.TX_PER_PAGE);
    for (let page = 0; page < pages && page < MAX_PAGES; page++) {
      const start = page * P.TX_PER_PAGE + 1;
      const rows = await this.req((t) => P.buildTransmitters(page, t), (b) => P.parseTxPage(b, start), `transmit channels from ${start}`);
      out.push(...rows.map((c) => ({ number: c.number, label: labels.get(c.number) || c.name, factory: c.name })));
      if (rows.length < P.TX_PER_PAGE) break;
    }
    return out;
  }

  /** Every page of a modern status inventory — `channel_inventory.rs`'s paging. */
  async modernPages(receiver) {
    const s = this.state;
    const protocolId = s.protocol && s.protocol.modern ? s.protocol.protocolId : P.PROTOCOL.ARC_2809;
    const seen = new Set();
    const records = [];
    let range = { media: 1, first: 1 };
    for (let n = 0; range && n < MAX_PAGES; n++) {
      const bytes = await this.link.request((t) => P.buildChannelStatusQuery(protocolId, receiver, range.media, range.first, 0, t));
      const e = P.envelope(bytes);
      if (e && e.result === P.RESULT.FRONTEND_UNAVAILABLE) throw new Error(`${s.name} does not answer the modern channel queries`);
      const page = receiver ? P.parseRxStatusPage(bytes) : P.parseTxStatusPage(bytes);
      if (!page) throw new Error(`${s.name} answered a channel page in a shape this does not read (${P.hex(bytes.subarray(0, 12))}…)`);
      let added = 0;
      for (const r of page.records) {
        const k = `${r.media}:${r.mediaId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        records.push(r);
        added += 1;
      }
      if (n > 0 && !added) throw new Error(`${s.name}'s channel pages stopped making progress`);
      range = P.nextStatusRange(page, seen);
    }
    return records.filter((r) => r.media === P.MEDIA.AUDIO).sort((a, b) => a.number - b.number);
  }

  async modernRx() {
    return (await this.modernPages(true)).map((r) => ({
      number: r.number, label: r.label,
      sub: r.txChannel ? { channel: r.txChannel, device: r.txDevice || '.' } : null,
      status: P.subscriptionStatus(r.status, r.rxStatus), media: r.media, sampleRate: r.sampleRate
    }));
  }

  async modernTx() {
    return (await this.modernPages(false)).map((r) => ({ number: r.number, label: r.label, factory: r.factory, sampleRate: r.sampleRate }));
  }

  /**
   * Send changes — `[{ number, tx: { channel, device } | null }]` — in this
   * device's form, then read the receive channels back. Answers the
   * failures, by receive channel number: a write the device refused or never
   * answered. What actually changed is for the caller to read off the state.
   */
  async write(changes) {
    const s = this.state;
    const { form, why } = writeForm(s);
    const failures = new Map();
    if (!form) { for (const c of changes) failures.set(c.number, why); return failures; }
    const self = (tx) => tx && tx.device.toLowerCase() === String(s.name).toLowerCase();
    const send = async (records, build) => {
      try {
        const bytes = await this.link.request(build);
        const ack = P.writeAccepted(bytes);
        if (!ack.ok) for (const r of records) failures.set(r.number, `${s.name} refused the change: ${ack.error}`);
      } catch (err) {
        for (const r of records) failures.set(r.number, err.message);
      }
    };
    if (form === 'modern') {
      const capacity = Math.min(Math.max(1, s.rx.length), P.PAGE_CAPACITY);
      for (let i = 0; i < changes.length; i += capacity) {
        const chunk = changes.slice(i, i + capacity);
        const records = chunk.map((c) => (c.tx ? { rx: c.number, channel: c.tx.channel, device: c.tx.device } : { rx: c.number }));
        await send(chunk, (t) => P.buildSubscriptionPage(s.protocol && s.protocol.modern ? s.protocol.protocolId : P.PROTOCOL.ARC_2809, capacity, records, t));
      }
    } else if (form === 'page-2729') {
      for (let i = 0; i < changes.length; i += P.PAGE_2729_CAPACITY) {
        const chunk = changes.slice(i, i + P.PAGE_2729_CAPACITY);
        /* Dante Controller writes "." for the receiver's own channels on this revision. */
        const records = chunk.map((c) => (c.tx ? { rx: c.number, channel: c.tx.channel, device: self(c.tx) ? '.' : c.tx.device } : { rx: c.number }));
        await send(chunk, (t) => P.buildSubscriptionPage2729(records, t));
      }
    } else {
      const clears = changes.filter((c) => !c.tx);
      const sets = changes.filter((c) => c.tx);
      for (const c of sets.filter((x) => x.number > 255)) failures.set(c.number, 'the classic subscription write reaches receive channels 1–255 only');
      for (let i = 0; i < clears.length; i += P.LEGACY_BATCH) {
        const chunk = clears.slice(i, i + P.LEGACY_BATCH);
        await send(chunk, (t) => P.buildRemoveSubscriptions(chunk.map((c) => c.number), t));
      }
      const reachable = sets.filter((x) => x.number <= 255);
      for (let i = 0; i < reachable.length; i += P.LEGACY_BATCH) {
        const chunk = reachable.slice(i, i + P.LEGACY_BATCH);
        await send(chunk, (t) => P.buildAddSubscriptions(chunk.map((c) => ({ rx: c.number, channel: c.tx.channel, device: c.tx.device })), t));
      }
    }
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    try { await this.readRx(); this.setStatus('ok', null); } catch (err) {
      for (const c of changes) if (!failures.has(c.number)) failures.set(c.number, `could not read ${s.name} back: ${err.message}`);
    }
    return failures;
  }

  /** The device as the page and the planner see it. */
  describe() {
    const s = this.state;
    const { form, why } = writeForm(s);
    const protocolId = s.protocol && !s.protocol.error ? s.protocol.protocolId : null;
    return {
      id: s.key,
      name: s.name || s.mdnsName || s.address,
      address: s.address,
      port: s.port,
      source: s.source,
      manufacturer: s.manufacturer,
      model: s.model,
      deviceId: s.deviceId,
      mac: s.mac,
      arcp: s.txt && s.txt.arcp_vers ? String(s.txt.arcp_vers) : null,
      protocol: protocolId ? revisionLabel(protocolId) : s.protocol && s.protocol.error ? 'unsupported' : null,
      inventory: s.inventory,
      status: s.status,
      error: s.error,
      lastRead: s.lastRead,
      sampleRate: s.sampleRate,
      latencyNs: s.latencyNs,
      txCount: s.txCount,
      rxCount: s.rxCount,
      tx: s.tx,
      rx: s.rx,
      writable: Boolean(form),
      form,
      why: form ? null : why
    };
  }
}

/**
 * Every reader, kept in line with what discovery found and what the settings
 * name. Keyed by `address:port`, because that is what a link talks to; a
 * device's name is what it says it is when asked.
 */
export class DanteSupervisor extends EventEmitter {
  constructor({ pollMs = 5000, log = () => {}, linkOptions = {} } = {}) {
    super();
    this.pollMs = pollMs;
    this.log = log;
    this.linkOptions = linkOptions;
    this.readers = new Map();
  }

  /**
   * @param {Array} found     discovery's list
   * @param {Array<{address, port}>} manual
   */
  apply(found, manual) {
    const wanted = new Map();
    for (const f of found) wanted.set(`${f.address}:${f.port}`, { address: f.address, port: f.port, source: 'mdns', mdns: f });
    for (const m of manual) {
      const port = m.port || P.PORT.ARC;
      const key = `${m.address}:${port}`;
      /* A device configured by address and also found keeps what it advertised. */
      if (wanted.has(key)) wanted.get(key).source = 'manual';
      else {
        const advertised = found.find((f) => f.address === m.address && (!m.port || f.port === m.port));
        if (advertised) wanted.set(`${advertised.address}:${advertised.port}`, { address: advertised.address, port: advertised.port, source: 'manual', mdns: advertised });
        else wanted.set(key, { address: m.address, port, source: 'manual', mdns: null });
      }
    }
    let changed = false;
    for (const [key, reader] of [...this.readers]) {
      if (!wanted.has(key)) { reader.stop(); this.readers.delete(key); changed = true; }
    }
    for (const [key, w] of wanted) {
      const existing = this.readers.get(key);
      if (existing) { existing.update(w.mdns); existing.state.source = w.source; continue; }
      const reader = new DeviceReader({ key, address: w.address, port: w.port, source: w.source, mdns: w.mdns, pollMs: this.pollMs, log: this.log, linkOptions: this.linkOptions });
      reader.on('change', () => this.emit('change'));
      this.readers.set(key, reader);
      reader.start();
      changed = true;
    }
    if (changed) this.emit('change');
  }

  setPoll(ms) {
    this.pollMs = ms;
    for (const r of this.readers.values()) r.pollMs = ms;
  }

  describe() {
    return [...this.readers.values()].map((r) => r.describe()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  readerFor(name) {
    const lower = String(name).toLowerCase();
    return [...this.readers.values()].find((r) => String(r.describe().name).toLowerCase() === lower) || null;
  }

  /** Read every device (or one) now, and wait for it. */
  async refresh(name = null) {
    const readers = name ? [this.readerFor(name)].filter(Boolean) : [...this.readers.values()];
    await Promise.all(readers.map((r) => r.read(true)));
  }

  /**
   * Send a plan's changes, one device at a time in parallel, and answer the
   * failures keyed `device\u0000number` — the shape `core.js`'s `confirm` takes.
   */
  async write(byDevice) {
    const failures = new Map();
    await Promise.all([...byDevice].map(async ([name, changes]) => {
      const reader = this.readerFor(name);
      if (!reader) { for (const c of changes) failures.set(`${name}\u0000${c.number}`, `${name} is gone`); return; }
      const f = await reader.write(changes);
      for (const [n, why] of f) failures.set(`${reader.describe().name}\u0000${n}`, why);
    }));
    this.emit('change');
    return failures;
  }

  stop() {
    for (const r of this.readers.values()) r.stop();
    this.readers.clear();
  }
}

