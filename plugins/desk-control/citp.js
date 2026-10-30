/*
 * Desk control — the switcher as a CITP media server.  ** PREVIEW **
 *
 * MagicQ, grandMA2 and Titan find media servers over CITP and show what is
 * in them: libraries with thumbnails to pick from, what each layer is
 * playing, and low-rate previews. This is that face for the switcher. What it
 * says comes from `media.js`; the bytes are `src/core/citp.js`.
 *
 * ## What happens on the wire
 *
 * - **UDP 4809**, joined to 239.224.0.180 and the older 224.0.0.180: a
 *   `PINF/PLoc` every second saying "MediaServer, connect on TCP <port>", and
 *   any desk's own PLoc heard and listed on the card. With the network left
 *   on Automatic that is on every IPv4 interface, each through a socket of
 *   its own: one multicast socket sends on one interface, and the first one
 *   a Mac lists can be a VM adapter while the desk is on the LAN.
 * - **TCP**, 4811 if it is free and any port if not (PLoc says which): a desk
 *   connects and gets `PNam` and an MSEX 1.0 `SInf` straight away, as the
 *   spec asks for clients older than 1.2. A 1.2 desk then sends `CInf`, and
 *   gets a 1.2 `SInf` and 1.2 from then on.
 * - **LSta four times a second** to every desk connected, from layer sources
 *   read off the switcher once a second — and only while a desk is connected,
 *   so a CITP face nobody uses costs the switcher nothing.
 * - **Requests are answered one at a time per desk, in the order asked**:
 *   library lists, element lists, thumbnails (each from a snapshot fetched
 *   from the switcher, or a plain card where there is none), video sources.
 * - **Streams are multicast**, as MSEX 1.1 and later require: a desk's
 *   `RqSt` subscribes to a live input for its timeout, and that input's
 *   snapshot goes out as `StFr` about once a second, on the interface that
 *   desk connected through. **An MSEX 1.0 desk gets its frames over its TCP
 *   connection instead**: the spec only forbids that from 1.1, and MagicQ
 *   1.9.6.5 asks in 1.0 and has no socket on 4809 to hear multicast with. A
 *   snapshot is all the switcher offers; real-time video waits for NDI.
 * - **Nothing here writes to the switcher.** A desk changes layers over
 *   Art-Net or sACN; CITP only reports.
 */

import dgram from 'node:dgram';
import net from 'node:net';
import { EventEmitter } from 'node:events';

import {
  CITP_PORT, CITP_GROUPS, V10, V12, versionCompare, LIBRARY_MEDIA, FORMATS,
  buildPNam, buildPLoc, buildSInf, buildNack, buildLSta, buildELIn, buildMEIn, buildELUp, buildEThn, buildELTh,
  buildVSrc, buildStFr, parseCitp, readRequest, highestCommon, CitpStream,
} from '../../src/core/citp.js';

export const CITP_TCP_PORT = 4811;
export const LOC_MS = 1000;
export const STATUS_MS = 250;
export const REFRESH_MS = 1000;
export const MAX_CLIENTS = 8;
/* A stream frame is a snapshot fetched from the switcher: once a second is plenty. */
export const STREAM_MS = 1000;
const STREAM_TICK_MS = 100;
const MAX_STREAM_S = 60;
const PEER_TTL_MS = 10_000;

const at12 = (v) => !!v && versionCompare(v, V12) >= 0;
const clamp = (v) => (!v || versionCompare(v, V10) < 0 ? V10 : versionCompare(v, V12) > 0 ? V12 : v);

export class CitpPeer extends EventEmitter {
  #udp = null;
  /* IPv4 address → a socket sending multicast out of that interface. */
  #senders = new Map();
  #joined = new Set();
  #tcp = null;
  #clients = new Set();
  #timers = [];
  #streams = new Map();
  #serials = null;
  #refreshing = false;
  #pumping = false;
  #frameIndex = 0;
  #peers = new Map();
  #nextClient = 0;

  /**
   * @param {object} o
   * @param {string} o.name            display name, in PNam and PLoc
   * @param {string} o.uuid            this server's UUID, for SInf 1.2 and StFr
   * @param {number[]} o.productVersion [major, minor, bugfix]
   * @param {() => object} o.model     `mediaModel()` as of now
   * @param {() => Promise<unknown>} o.refresh  re-read the switcher's layers (once a second while connected)
   * @param {(want: object) => Promise<object>} o.thumbnail  `{library, element, format, width, height, bgr}` → image
   * @param {(want: object) => Promise<object|null>} o.frame  `{source, format, width, height, bgr, limit}` → image
   * @param {() => string[]} [o.ifaces]  the IPv4 addresses to join and send multicast on
   * @param {(ip: string) => boolean} [o.allow]  whether a desk at this address may connect ("Only these desks")
   * @param {{udp?: number, tcp?: number}} [o.ports]
   * @param {Array<{address: string, port: number}>} [o.targets]  PLoc and StFr unicast here instead (tests: loopback)
   */
  constructor({
    name, uuid, productVersion = [0, 0, 0], model, refresh = async () => {}, thumbnail, frame,
    ifaces = () => [], allow = () => true, ports = {}, bindAddress = '0.0.0.0', targets = null, groups = CITP_GROUPS,
    locMs = LOC_MS, statusMs = STATUS_MS, refreshMs = REFRESH_MS, streamMs = STREAM_MS, log = () => {},
  }) {
    super();
    Object.assign(this, { name, uuid, productVersion, model, refresh, thumbnail, frame, ifaces, allow, bindAddress, groups, targets, log });
    this.ports = { udp: CITP_PORT, tcp: CITP_TCP_PORT, ...ports };
    this.timing = { locMs, statusMs, refreshMs, streamMs };
    this.bound = { udp: null, tcp: null };
    this.errors = { udp: null, tcp: null, multicast: null, refresh: null };
    this.counts = { connections: 0, refused: 0, requests: 0, thumbnails: 0, frames: 0, nacks: 0 };
  }

  /* ------------------------------------------------------------ lifecycle */

  async start() {
    await Promise.all([this.#listen(), this.#bindUdp()]);
    const every = (ms, fn) => { const t = setInterval(fn, ms); t.unref?.(); this.#timers.push(t); };
    every(this.timing.locMs, () => this.#announce());
    every(this.timing.statusMs, () => this.#status());
    every(this.timing.refreshMs, () => { void this.#refresh(); });
    every(STREAM_TICK_MS, () => { void this.#pumpStreams(); });
    this.#announce();
    return this.describe();
  }

  stop() {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    for (const c of this.#clients) c.socket.destroy();
    this.#clients.clear();
    for (const sender of this.#senders.values()) { try { sender.close(); } catch { /* already closed */ } }
    this.#senders.clear();
    this.#joined.clear();
    this.#streams.clear();
    try { this.#tcp?.close(); } catch { /* not listening */ }
    try { this.#udp?.close(); } catch { /* already closed */ }
    this.#tcp = null;
    this.#udp = null;
    this.bound = { udp: null, tcp: null };
  }

  #listen() {
    return new Promise((done) => {
      const server = net.createServer((socket) => this.#accept(socket));
      const tryPort = (port) => {
        server.once('error', (err) => {
          /* Someone else has 4811: any port will do, PLoc says which. */
          if (err.code === 'EADDRINUSE' && port !== 0) { tryPort(0); return; }
          this.errors.tcp = err.message;
          done();
        });
        server.listen(port, this.bindAddress, () => {
          this.errors.tcp = null;
          this.bound.tcp = server.address().port;
          done();
        });
      };
      this.#tcp = server;
      tryPort(this.ports.tcp);
    });
  }

  #bindUdp() {
    return new Promise((done) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.#udp = socket;
      socket.on('message', (buf, rinfo) => this.#onDatagram(buf, rinfo));
      socket.once('error', (err) => {
        this.errors.udp = err.message;
        this.log(`desk-control: CITP UDP ${this.ports.udp}: ${err.message}`);
        try { socket.close(); } catch { /* never bound */ }
        if (this.#udp === socket) this.#udp = null;
        done();
      });
      socket.bind(this.ports.udp, this.bindAddress, () => {
        this.bound.udp = socket.address().port;
        this.#followInterfaces();
        done();
      });
    });
  }

  /**
   * Join the groups, and have a sender, on every interface asked for — again
   * every second, so a cable plugged in after the start is found.
   */
  #followInterfaces() {
    if (!this.#udp || !this.bound.udp) return;
    const want = new Set(this.ifaces() || []);
    for (const address of want) {
      for (const g of this.groups) {
        const key = `${g}@${address}`;
        if (this.#joined.has(key)) continue;
        try {
          this.#udp.addMembership(g, address);
          this.#joined.add(key);
        } catch (err) { this.errors.multicast = `${g} on ${address}: ${err.message}`; }
      }
      if (this.targets || this.#senders.has(address)) continue;
      const sender = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sender.on('error', (err) => { this.errors.multicast = `sending on ${address}: ${err.message}`; });
      this.#senders.set(address, sender);
      sender.bind(0, address, () => {
        try {
          sender.setMulticastInterface(address);
          sender.setMulticastTTL(4);
        } catch (err) { this.errors.multicast = `sending on ${address}: ${err.message}`; }
      });
    }
    for (const [address, sender] of this.#senders) {
      if (want.has(address)) continue;
      try { sender.close(); } catch { /* already closed */ }
      this.#senders.delete(address);
    }
    for (const key of [...this.#joined]) if (!want.has(key.split('@')[1])) this.#joined.delete(key);
  }

  /* ------------------------------------------------------------- discovery */

  #announce() {
    this.#followInterfaces();
    if (!this.#udp || !this.bound.udp || !this.bound.tcp) return;
    const state = this.#clients.size ? `${this.#clients.size} connected` : 'Running';
    this.#multicast(buildPLoc({ port: this.bound.tcp, type: 'MediaServer', name: this.name, state }));
  }

  /** To the groups, on every interface, or on `only` (an interface address) where there is a sender for it. */
  #multicast(bytes, only = null) {
    if (this.targets) {
      for (const t of this.targets) this.#udp?.send(bytes, t.port, t.address);
      return;
    }
    const senders = only && this.#senders.has(only) ? [this.#senders.get(only)] : [...this.#senders.values()];
    for (const sender of senders) {
      for (const g of this.groups) {
        sender.send(bytes, CITP_PORT, g, (err) => {
          if (err && !this.errors.multicast) this.errors.multicast = `${g}: ${err.message}`;
        });
      }
    }
  }

  /* The desks' own PLocs, for the card: who is out there looking. */
  #onDatagram(buf, rinfo) {
    const msg = parseCitp(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
    if (!msg || msg.layer !== 'PINF' || msg.type !== 'PLoc') return;
    const loc = readRequest(msg);
    if (!loc || loc.name === this.name) return;
    const key = `${rinfo.address}|${loc.name}`;
    const known = this.#peers.has(key);
    this.#peers.set(key, { address: rinfo.address, ...loc, at: Date.now() });
    if (!known) this.emit('activity');
  }

  /* --------------------------------------------------------------- clients */

  #accept(socket) {
    const address = socket.remoteAddress?.replace(/^::ffff:/, '') || '';
    /* Thumbnails are pictures of what is on the switcher's inputs: a locked desk list keeps them too. */
    if (!this.allow(address)) { this.counts.refused++; socket.destroy(); return; }
    if (this.#clients.size >= MAX_CLIENTS) { socket.destroy(); return; }
    socket.setNoDelay(true);
    /* `version` is the session's, from CInf; `seen` the last a request was in, for a desk that sends no CInf. */
    const c = {
      id: ++this.#nextClient, socket, stream: new CitpStream(), version: null, seen: null, name: '', address,
      local: socket.localAddress?.replace(/^::ffff:/, '') || null,
      since: Date.now(), layersKey: '', queue: Promise.resolve(),
    };
    this.#clients.add(c);
    this.counts.connections++;
    socket.on('data', (chunk) => {
      for (const bytes of c.stream.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length))) {
        const msg = parseCitp(bytes);
        if (msg) c.queue = c.queue.then(() => this.#handle(c, msg)).catch((err) => this.log(`desk-control: CITP ${c.address}: ${err.message}`));
      }
      if (c.stream.broken) socket.destroy();
    });
    socket.on('error', () => { /* a desk going away mid-write */ });
    socket.on('close', () => {
      this.#clients.delete(c);
      for (const [key, s] of this.#streams) if (s.client === c) this.#streams.delete(key);
      this.emit('activity');
    });
    const model = this.model();
    c.layersKey = model.layers.join('\n');
    this.#send(c, buildPNam(this.name));
    this.#send(c, buildSInf(V10, this.#info(model)));
    void this.#refresh();
    this.emit('activity');
  }

  #send(c, bytes) {
    if (!c.socket.destroyed && c.socket.writable) c.socket.write(bytes);
  }

  #info(model) {
    return { uuid: this.uuid, product: 'LivePremier Plus', productVersion: this.productVersion, layers: model.layers };
  }

  /** The version to answer a message in: the session's from CInf, or the message's own. */
  #replyVersion(c, msg) {
    return at12(c.version) ? c.version : clamp(msg.version);
  }

  async #handle(c, msg) {
    if (msg.layer === 'PINF') {
      if (msg.type === 'PNam') {
        c.name = readRequest(msg)?.name || c.name;
        this.emit('activity');
      }
      return;
    }
    if (msg.layer !== 'MSEX') return;
    this.counts.requests++;
    if (msg.version && (!c.seen || versionCompare(c.seen, msg.version) !== 0)) { c.seen = msg.version; this.emit('activity'); }
    const v = this.#replyVersion(c, msg);
    const reply = { inResponseTo: msg.requestIndex };
    const req = readRequest(msg);
    const model = this.model();

    switch (msg.type) {
      case 'CInf': {
        const common = highestCommon(req?.versions);
        c.version = common;
        if (at12(common)) {
          c.layersKey = model.layers.join('\n');
          this.#send(c, buildSInf(common, this.#info(model), reply));
        }
        this.emit('activity');
        return;
      }
      case 'GELI': {
        if (!req) break;
        /* One level of libraries, under the root; nothing below them. */
        const libs = req.libraryType === LIBRARY_MEDIA && req.parent[0] === 0 ? model.libraries : [];
        const wanted = req.libraries.length ? libs.filter((l) => req.libraries.includes(l.index)) : libs;
        this.#send(c, buildELIn(v, req.libraryType, wanted.map((l) => ({
          index: l.index, dmx: l.dmx, name: l.name, elements: l.elements.length, serial: l.serial,
        })), reply));
        return;
      }
      case 'GEIn': {
        if (!req) break;
        const lib = this.#library(model, req.libraryType, req.library);
        const all = lib ? lib.elements : [];
        const wanted = req.elements.length ? all.filter((e) => req.elements.includes(e.index)) : all;
        const sizeOf = (e) => (lib?.kind === 'LIVE' ? model.video.find((s) => s.id === e.index + 1) : null) || { width: 0, height: 0 };
        this.#send(c, buildMEIn(v, req.library[1] ?? 0, wanted.map((e) => ({
          index: e.index, dmx: e.dmx, name: e.name, serial: e.serial, ...sizeOf(e),
        })), reply));
        return;
      }
      case 'GETh': {
        if (!req) break;
        const lib = this.#library(model, req.libraryType, req.library);
        if (!lib) break;
        const indexes = req.elements.length ? req.elements : lib.elements.map((e) => e.index);
        for (const element of indexes) {
          if (!lib.elements[element]) continue;
          const image = await this.thumbnail({ library: lib.index, element, ...this.#want(req, msg) });
          if (!image) continue;
          this.counts.thumbnails++;
          this.#send(c, buildEThn(v, { libraryType: req.libraryType, library: lib.index, element, image }, reply));
        }
        return;
      }
      case 'GELT': {
        if (!req) break;
        const ids = req.libraries.length ? req.libraries : model.libraries.map((l) => [1, l.index, 0, 0]);
        for (const id of ids) {
          const lib = this.#library(model, req.libraryType, id);
          if (!lib) continue;
          const image = await this.thumbnail({ library: lib.index, element: 0, ...this.#want(req, msg) });
          if (!image) continue;
          this.counts.thumbnails++;
          this.#send(c, buildELTh(v, { libraryType: req.libraryType, library: lib.index, image }, reply));
        }
        return;
      }
      case 'GVSr':
        this.#send(c, buildVSrc(v, model.video, reply));
        return;
      case 'RqSt': {
        if (!req) break;
        if (!model.video.some((s) => s.id === req.source)) break;
        /* Before 1.1 the frames go down this desk's own connection, so the subscription is its own too. */
        const tcp = versionCompare(v, [1, 1]) < 0;
        const key = `${req.source}|${req.format}|${v.join('.')}${tcp ? `|${c.id}` : ''}`;
        const now = Date.now();
        const was = this.#streams.get(key);
        this.#streams.set(key, {
          client: c, tcp, source: req.source, format: req.format, version: v, bgr: tcp,
          width: Math.max(req.width, was?.width || 0), height: Math.max(req.height, was?.height || 0),
          until: now + Math.min(req.timeout, MAX_STREAM_S) * 1000, once: req.timeout === 0, next: was ? was.next : now,
        });
        this.emit('activity');
        return;
      }
      default:
        break;
    }
    /* Unknown, unsupported or unreadable: a 1.2 session is told so; before 1.2 there is no Nack. */
    if (at12(v)) {
      this.counts.nacks++;
      this.#send(c, buildNack(v, msg.type, reply));
    }
  }

  #library(model, type, id) {
    if (type !== LIBRARY_MEDIA || !id || id[0] !== 1) return null;
    return model.libraries[id[1]] || null;
  }

  #want(req, msg) {
    return { format: req.format, width: req.width, height: req.height, bgr: versionCompare(msg.version || V10, [1, 1]) < 0 };
  }

  /* ----------------------------------------------------------- the regulars */

  #status() {
    if (!this.#clients.size) { this.#serials = null; return; }
    const model = this.model();
    const key = model.layers.join('\n');
    const serials = model.libraries.map((l) => l.serial);
    const changed = this.#serials ? model.libraries.filter((l, i) => this.#serials[i] !== l.serial) : [];
    this.#serials = serials;
    for (const c of this.#clients) {
      const v = at12(c.version) ? c.version : V10;
      /* A repatch: say the layers again. */
      if (c.layersKey !== key) {
        c.layersKey = key;
        this.#send(c, buildSInf(v, this.#info(model)));
      }
      for (const lib of changed) this.#send(c, buildELUp(v, LIBRARY_MEDIA, lib.index));
      this.#send(c, buildLSta(v, model.status));
    }
  }

  async #refresh() {
    if (!this.#clients.size || this.#refreshing) return;
    this.#refreshing = true;
    try {
      await this.refresh();
      if (this.errors.refresh) { this.errors.refresh = null; this.emit('activity'); }
    } catch (err) {
      if (this.errors.refresh !== err.message) { this.errors.refresh = err.message; this.emit('activity'); }
    } finally {
      this.#refreshing = false;
    }
  }

  async #pumpStreams() {
    if (this.#pumping || !this.#streams.size) return;
    this.#pumping = true;
    try {
      const now = Date.now();
      for (const [key, s] of this.#streams) {
        if (now > s.until && !s.once) { this.#streams.delete(key); this.emit('activity'); continue; }
        if (now < s.next) continue;
        const fragmented = s.format === FORMATS.FJPG || s.format === FORMATS.FPNG;
        const image = await this.frame({
          source: s.source, format: s.format, width: s.width, height: s.height, bgr: s.bgr, limit: fragmented ? Infinity : undefined,
        });
        s.next = Date.now() + this.timing.streamMs;
        if (s.once) this.#streams.delete(key);
        if (!image) continue;
        this.counts.frames++;
        for (const bytes of buildStFr(s.version, { uuid: this.uuid, source: s.source, image, frameIndex: this.#frameIndex++ })) {
          if (s.tcp) this.#send(s.client, bytes);
          else this.#multicast(bytes, s.client.local);
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  /* ------------------------------------------------------------- reporting */

  describe() {
    const now = Date.now();
    for (const [key, p] of this.#peers) if (now - p.at > PEER_TTL_MS) this.#peers.delete(key);
    return {
      udp: this.bound.udp,
      tcp: this.bound.tcp,
      errors: { ...this.errors },
      clients: [...this.#clients].map((c) => ({
        address: c.address, name: c.name, version: (c.version || c.seen)?.join('.') ?? null, since: c.since,
      })),
      peers: [...this.#peers.values()].map((p) => ({ address: p.address, name: p.name, type: p.type, state: p.state })),
      streams: [...this.#streams.values()].map((s) => ({ source: s.source, format: s.format.trim(), width: s.width, height: s.height })),
      counts: { ...this.counts },
    };
  }
}
