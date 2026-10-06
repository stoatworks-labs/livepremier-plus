/*
 * Dante — finding devices: mDNS questions from an ephemeral port, and the
 * answers they get.
 *
 * ## Never port 5353
 *
 * The operating system already runs an mDNS responder that owns UDP 5353 —
 * mDNSResponder on a Mac, Avahi on Linux, the DNS client on Windows — and
 * Dante Virtual Soundcard and Dante Controller lean on it. Binding the port
 * beside it (SO_REUSEPORT) would split the multicast stream between two
 * readers and break exactly the software this app is meant to sit next to.
 * So every question here goes out from a port the OS picked, which makes it a
 * *legacy unicast* query (RFC 6762 §6.7): each responder answers us directly,
 * by unicast, and the shared port is never touched. `mdns.js` has the bytes.
 *
 * The price: nothing is pushed. A device that appears is seen at the next
 * question, so the network is asked again every `browseSeconds`, and a device
 * that has not answered for three of those is dropped.
 *
 * ## Which interface
 *
 * One socket per interface, each bound to that interface's address and
 * sending its multicast out of that interface — a laptop with Wi-Fi and a
 * Dante NIC asks on both unless told which. A device configured by address
 * is asked directly, by a unicast question to its port 5353 (RFC 6762 §5.5),
 * which reaches across a router where multicast does not.
 *
 * Nothing here sends a control packet. Finding a device is all it does;
 * `supervisor.js` decides whether to talk to one.
 */

import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { buildQuery, parseMessage, servicesFrom, TYPE, MDNS_GROUP, MDNS_PORT, canonical } from './mdns.js';
import { SERVICE } from './protocol.js';

/** How many browse intervals a device may stay silent before it is forgotten. */
const EXPIRE_AFTER = 3;
/** The services asked for: the control service, and the one whose TXT carries the device id. */
const BROWSE = [SERVICE.ARC, SERVICE.CMC];

/** This machine's IPv4 interfaces that are up and not loopback: `[{ name, address }]`. */
export function localInterfaces(list = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(list || {})) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

/** The device id and MAC in a CMC advertisement's `id`, when it is the 16 hex digits Dante writes. */
export function idFromCmc(txt) {
  const id = txt && typeof txt.id === 'string' ? txt.id.trim() : '';
  if (!/^[0-9a-fA-F]{16}$/.test(id)) return { deviceId: null, mac: null };
  const mac = id.slice(0, 12).match(/../g).join(':').toLowerCase();
  return { deviceId: id.toUpperCase(), mac };
}

export class Discovery extends EventEmitter {
  /**
   * @param {object} o
   * @param {boolean} [o.multicast]  ask the network at large, not only `manual`
   * @param {string} [o.interfaceAddress]  ask on this interface only
   * @param {{address:string, port:number}|null} [o.target]  ask here instead of the mDNS group
   * @param {Array<{address:string}>} [o.manual]  devices to ask directly
   * @param {number} [o.browseMs]
   * @param {Function} [o.log]
   * @param {Function} [o.interfaces]  for tests: what `localInterfaces()` answers
   */
  constructor({ multicast = true, interfaceAddress = '', target = null, manual = [], browseMs = 30000, log = () => {}, interfaces = localInterfaces } = {}) {
    super();
    this.multicast = multicast;
    this.interfaceAddress = interfaceAddress;
    this.target = target;
    this.manual = manual;
    this.browseMs = browseMs;
    this.log = log;
    this.interfaces = interfaces;
    this.sockets = [];
    this.found = new Map();       // canonical device name → entry
    this.timer = null;
    this.lastBrowse = null;
    this.error = null;
    this.stopped = false;
  }

  async start() {
    this.stopped = false;
    const binds = this.target
      ? [{ name: 'target', address: this.target.address === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0', multicast: false }]
      : this.multicast ? this.chosenInterfaces().map((i) => ({ ...i, multicast: true })) : [];
    if (!binds.length && this.manual.length) binds.push({ name: 'any', address: '0.0.0.0', multicast: false });
    for (const b of binds) {
      try { this.sockets.push(await this.open(b)); } catch (err) {
        this.error = `could not ask on ${b.address}: ${err.message}`;
        this.log(`dante: ${this.error}`);
      }
    }
    if (!this.sockets.length && !this.error && (this.multicast || this.manual.length)) this.error = 'no network interface to ask on';
    this.browse();
    this.timer = setInterval(() => this.browse(), this.browseMs);
    this.timer.unref?.();
  }

  chosenInterfaces() {
    const all = this.interfaces();
    return this.interfaceAddress ? all.filter((i) => i.address === this.interfaceAddress) : all;
  }

  open(bind) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      socket.once('error', reject);
      socket.bind({ address: bind.address, port: 0, exclusive: true }, () => {
        socket.removeListener('error', reject);
        socket.on('error', (err) => this.log(`dante: discovery socket ${bind.address}: ${err.message}`));
        if (bind.multicast) {
          try {
            socket.setMulticastInterface(bind.address);
            socket.setMulticastTTL(255);
            socket.setMulticastLoopback(true);
          } catch (err) { this.log(`dante: multicast on ${bind.address}: ${err.message}`); }
        }
        socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
        resolve({ socket, bind });
      });
    });
  }

  /** Ask now: the group (or the target) on every socket, and each device configured by address. */
  browse() {
    if (this.stopped) return;
    this.lastBrowse = Date.now();
    const query = buildQuery({ id: (Math.random() * 0xfffe + 1) | 0, questions: BROWSE.map((name) => ({ name, type: TYPE.PTR })) });
    for (const { socket, bind } of this.sockets) {
      if (this.target) { if (this.multicast) this.send(socket, query, this.target.port, this.target.address); }
      else if (bind.multicast) this.send(socket, query, MDNS_PORT, MDNS_GROUP);
    }
    /* A device given by address is asked directly — through the target
       instead, when there is one, because that is where the simulator
       answers for every device it runs. */
    if (this.sockets[0] && this.manual.length) {
      if (this.target) this.send(this.sockets[0].socket, query, this.target.port, this.target.address);
      else for (const m of this.manual) this.send(this.sockets[0].socket, query, MDNS_PORT, m.address);
    }
    this.expire();
  }

  send(socket, bytes, port, address) {
    try { socket.send(bytes, port, address, (err) => { if (err) this.log(`dante: ask ${address}: ${err.message}`); }); } catch (err) {
      this.log(`dante: ask ${address}: ${err.message}`);
    }
  }

  onMessage(msg, rinfo) {
    const message = parseMessage(new Uint8Array(msg));
    if (!message || !message.response) return;
    const services = servicesFrom(message, BROWSE);
    let changed = false;
    for (const s of services) {
      const key = canonical(s.name);
      const entry = this.found.get(key) || { name: s.name, address: null, port: null, arc: null, cmc: null, seenAt: 0, via: rinfo.address };
      entry.seenAt = Date.now();
      entry.via = rinfo.address;
      if (s.type === canonical(SERVICE.ARC)) {
        const address = s.addresses[0] || entry.address || rinfo.address;
        if (address !== entry.address || (s.port && s.port !== entry.port) || JSON.stringify(s.txt) !== JSON.stringify(entry.arc && entry.arc.txt)) changed = true;
        entry.address = address;
        if (s.port) entry.port = s.port;
        entry.arc = { txt: s.txt || (entry.arc && entry.arc.txt) || {}, host: s.host };
        /* An answer that named the instance and nothing else: ask the device itself for the rest. */
        if (!s.port) this.followUp(s.instance, rinfo);
      } else {
        const before = JSON.stringify(entry.cmc);
        entry.cmc = { txt: s.txt || (entry.cmc && entry.cmc.txt) || {} };
        if (before !== JSON.stringify(entry.cmc)) changed = true;
        if (!entry.address) entry.address = s.addresses[0] || rinfo.address;
      }
      if (!this.found.has(key)) changed = true;
      this.found.set(key, entry);
    }
    if (changed) this.emit('change', this.list());
  }

  followUp(instance, rinfo) {
    const socket = this.sockets[0] && this.sockets[0].socket;
    if (!socket) return;
    const query = buildQuery({ id: (Math.random() * 0xfffe + 1) | 0, questions: [{ name: instance, type: TYPE.SRV }, { name: instance, type: TYPE.TXT }] });
    this.send(socket, query, rinfo.port, rinfo.address);
  }

  expire() {
    const cutoff = Date.now() - this.browseMs * EXPIRE_AFTER - 1000;
    let changed = false;
    for (const [key, e] of this.found) {
      if (e.seenAt < cutoff) { this.found.delete(key); changed = true; }
    }
    if (changed) this.emit('change', this.list());
  }

  /** What has been found: `[{ name, address, port, txt, cmc, deviceId, mac, seenAt }]`, only devices with a control service. */
  list() {
    return [...this.found.values()].filter((e) => e.arc && e.port && e.address).map((e) => ({
      name: e.name,
      address: e.address,
      port: e.port,
      txt: e.arc.txt || {},
      cmc: e.cmc ? e.cmc.txt : null,
      ...idFromCmc(e.cmc && e.cmc.txt),
      seenAt: e.seenAt
    }));
  }

  describe() {
    return {
      running: !this.stopped && this.sockets.length > 0,
      multicast: this.multicast,
      asking: this.target ? [`${this.target.address}:${this.target.port}`] : this.sockets.map((s) => s.bind.address),
      lastBrowse: this.lastBrowse,
      error: this.error
    };
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const { socket } of this.sockets) { try { socket.close(); } catch { /* already closed */ } }
    this.sockets = [];
  }
}
