#!/usr/bin/env node
/*
 * A Dante network on this machine, for the Dante plugin to talk to: devices
 * that answer mDNS questions and the ARC control protocol on loopback ports
 * of their own, hold subscriptions, and change them when asked.
 *
 *   node tools/dante-sim.mjs                     the demo network; prints where it answers
 *   node tools/dante-sim.mjs --mdns-port 5399    answer mDNS questions on that port
 *
 * Point the plugin at it by setting Settings ▸ Dante ▸ discovery target to the
 * address it prints (`discoveryTarget` in the plugin's settings). It binds
 * loopback only, and there is no option to do otherwise: a fake Dante device
 * answering on the show network is one a real controller could find.
 *
 * ## ⚠️ This is not evidence
 *
 * Every byte it sends is built from `plugins/dante/protocol.js`'s own tables
 * — the offsets the parsers read, written by hand the other way round, with
 * the layouts copied from the captures `test/dante.test.js` holds the codec to.
 * So a plugin that talks to it happily has proved that its pieces fit
 * together: discovery to link to poll to write to read-back to panel. It has
 * proved nothing about a real Dante device. `docs/DANTE.md` says what does.
 *
 * ## What it models
 *
 * - Both protocol generations: a device is `classic` (ARC 2.7.41 / 2.8.1,
 *   classic inventory pages; writes by netaudio's add and remove, or Dante
 *   Controller's 2.7.41 page) or `modern` (ARC 2.8.9 / 2.8.15, channel-status
 *   pages and the subscription page).
 * - Subscriptions held by the receiver. A new one reads `IN_PROGRESS` for
 *   `settleMs`, then `DYNAMIC` when the source is a channel on a simulated
 *   device and `UNRESOLVED` when it is not.
 * - Somebody else changing a route: `sim.setSubscription()` is Dante
 *   Controller on another machine, for the polling to notice.
 * - Misbehaviour on request: `refuseWrites` (answers 0x0022), `ignoreWrites`
 *   (answers success and changes nothing), `silent` (answers nothing) and
 *   `noModernQueries` (answers the modern queries 0x0030, as some do).
 */

import dgram from 'node:dgram';
import { fileURLToPath } from 'node:url';
import * as P from '../plugins/dante/protocol.js';
import { buildResponse, parseMessage, TYPE, canonical } from '../plugins/dante/mdns.js';

const enc = new TextEncoder();
const put16 = (out, v) => out.push((v >>> 8) & 0xff, v & 0xff);
const put32 = (out, v) => out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
const set16 = (out, at, v) => { out[at] = (v >>> 8) & 0xff; out[at + 1] = v & 0xff; };

/** The network `node tools/dante-sim.mjs` starts with. AQL-Simulator is the LivePremier Simulator's own card name. */
export const DEMO = [
  { name: 'AQL-Simulator', arcp: '2.7.41', mf: 'Analog Way', model: 'LivePremier Dante card', mac: '665544332211',
    tx: Array.from({ length: 64 }, (_, i) => `${String(i + 1).padStart(2, '0')}`),
    rx: Array.from({ length: 64 }, (_, i) => `${String(i + 1).padStart(2, '0')}`),
    subs: { 1: ['Mix L', 'FOH-Desk'], 2: ['Mix R', 'FOH-Desk'] } },
  { name: 'FOH-Desk', arcp: '2.8.9', mf: 'Audinate', model: 'Console', mac: '001dc1000001',
    tx: ['Mix L', 'Mix R', 'Aux 1', 'Aux 2', 'Aux 3', 'Aux 4', 'Matrix 1', 'Matrix 2'],
    rx: Array.from({ length: 16 }, (_, i) => `Ch ${i + 1}`),
    subs: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i + 1, [`Mic ${i + 1}`, 'Stagebox-A']])) },
  { name: 'Stagebox-A', arcp: '2.7.41', mf: 'Audinate', model: 'Stagebox', mac: '001dc1000002',
    tx: Array.from({ length: 16 }, (_, i) => `Mic ${i + 1}`),
    rx: Array.from({ length: 8 }, (_, i) => `Ret ${i + 1}`),
    subs: { 1: ['Aux 1', 'FOH-Desk'], 2: ['Aux 2', 'FOH-Desk'] } },
  { name: 'Amp-Rack', arcp: '2.8.15', mf: 'Audinate', model: 'Amplifier', mac: '001dc1000003',
    tx: [], rx: ['Main L', 'Main R', 'Sub', 'Fill'],
    subs: { 1: ['Mix L', 'FOH-Desk'], 2: ['Mix R', 'FOH-Desk'], 4: ['Gone 1', 'Old-Desk'] } },
  { name: 'Wall-Plate', arcp: '2.8.1', mf: 'Audinate', model: 'Wall plate', mac: '001dc1000004',
    tx: ['Lectern', 'Radio'], rx: ['Speaker L', 'Speaker R'], subs: {} },
];

const FORMAT = (rate) => {
  const f = [];
  put32(f, rate);
  for (const v of [0x0101, 24, 0x0400, 24, 24, 0x0004]) put16(f, v);
  return f;
};

/** A response packet: the request's protocol, transaction and opcode, a result, a body. */
function answer(req, result, body = [], protocolId = P.u16(req, 0)) {
  const out = [];
  put16(out, protocolId);
  put16(out, 10 + body.length);
  put16(out, P.u16(req, 4));
  put16(out, P.u16(req, 6));
  put16(out, result);
  return Uint8Array.from([...out, ...body]);
}

/** Strings placed after a fixed block, pointers absolute from the packet start. */
function strings(base) {
  const bytes = [];
  const at = new Map();
  return {
    bytes,
    ptr(s) {
      if (s == null) return 0;
      if (at.has(s)) return at.get(s);
      const p = base + bytes.length;
      bytes.push(...enc.encode(s), 0);
      at.set(s, p);
      return p;
    }
  };
}

class SimDevice {
  constructor(spec, net) {
    this.net = net;
    this.name = spec.name;
    this.arcp = spec.arcp;
    this.protocol = P.arcProtocol(spec.arcp);
    this.modern = Boolean(this.protocol && this.protocol.modern);
    this.mf = spec.mf || 'Simulated';
    this.model = spec.model || 'Simulated device';
    this.mac = spec.mac || null;
    this.sampleRate = spec.sampleRate || 48000;
    this.latencyNs = spec.latencyNs || 1000000;
    this.tx = (spec.tx || []).map((label, i) => ({ number: i + 1, label, factory: String(i + 1).padStart(2, '0') }));
    this.rx = (spec.rx || []).map((label, i) => ({ number: i + 1, label, sub: null, since: 0 }));
    for (const [n, [channel, device]] of Object.entries(spec.subs || {})) {
      const c = this.rx[Number(n) - 1];
      if (c) { c.sub = { channel, device }; c.since = 0; }
    }
    this.refuseWrites = !!spec.refuseWrites;
    this.ignoreWrites = !!spec.ignoreWrites;
    this.silent = !!spec.silent;
    this.noModernQueries = !!spec.noModernQueries;
    this.received = [];
    this.socket = null;
    this.port = null;
  }

  /** What a receive channel's status reads as now. */
  status(c) {
    if (!c.sub) return { status: 0, rxStatus: 0 };
    if (Date.now() - c.since < this.net.settleMs) return { status: 0x0008, rxStatus: 0 };
    if (c.sub.device === this.name || c.sub.device === '.') return { status: 0x0004, rxStatus: 0x0101 };
    const tx = this.net.devices.find((d) => d.name.toLowerCase() === c.sub.device.toLowerCase());
    if (tx && tx.tx.some((t) => t.label === c.sub.channel)) return { status: 0x0009, rxStatus: 0x0101 };
    return { status: 0x0001, rxStatus: 0 };
  }

  subscribe(number, sub) {
    const c = this.rx.find((x) => x.number === number);
    if (!c) return false;
    c.sub = sub && sub.channel ? { channel: sub.channel, device: sub.device === '.' ? this.name : sub.device } : null;
    c.since = Date.now();
    return true;
  }

  handle(req) {
    const protocolId = P.u16(req, 0);
    const opcode = P.u16(req, 6);
    this.received.push({ protocolId, opcode, hex: P.hex(req) });
    if (this.silent) return null;
    switch (opcode) {
      case P.OPCODE.DEVICE_NAME: return answer(req, P.RESULT.SUCCESS, [...enc.encode(this.name), 0]);
      case P.OPCODE.CHANNEL_COUNT: {
        const body = [];
        put16(body, this.modern ? 0x1030 : 0x0030);
        put16(body, this.tx.length);
        put16(body, this.rx.length);
        while (body.length < 38) body.push(0);
        return answer(req, P.RESULT.SUCCESS, body);
      }
      case P.OPCODE.DEVICE_SETTINGS: return this.settings(req);
      case P.OPCODE.RX_CHANNELS: return this.classicRx(req);
      case P.OPCODE.TX_CHANNELS: return this.classicTx(req);
      case P.OPCODE.TX_CHANNEL_NAMES: return this.classicTxNames(req);
      case P.OPCODE.RX_CHANNEL_STATUS:
      case P.OPCODE.TX_CHANNEL_STATUS: return this.modernStatus(req, opcode === P.OPCODE.RX_CHANNEL_STATUS);
      case P.OPCODE.SUBSCRIPTION_ADD: return protocolId === P.PROTOCOL.ARC_2729 ? this.page2729(req) : this.classicAdd(req);
      case P.OPCODE.SUBSCRIPTION_REMOVE: return this.classicRemove(req);
      case P.OPCODE.SUBSCRIPTION_PAGE: return this.modernPage(req);
      default: return answer(req, P.RESULT.ERROR);
    }
  }

  settings(req) {
    const records = [[0x8020, this.sampleRate], [0x8205, this.latencyNs], [0x8301, this.latencyNs]];
    const body = [0x00, records.length];
    const valuesAt = 10 + 2 + records.length * 4;
    const values = [];
    records.forEach(([code, v], i) => {
      put16(body, code);
      put16(body, valuesAt + i * 4);
      put32(values, v);
    });
    return answer(req, P.RESULT.SUCCESS, [...body, ...values]);
  }

  classicRx(req) {
    const start = P.u16(req, 12);
    const page = this.rx.filter((c) => c.number >= start).slice(0, P.RX_PER_PAGE);
    const more = this.rx.some((c) => c.number >= start + P.RX_PER_PAGE);
    const body = [page.length, page.length];
    const formatAt = 10 + 2 + page.length * 20;
    const s = strings(formatAt + 16);
    for (const c of page) {
      const st = this.status(c);
      put16(body, c.number);
      put16(body, 0x000f);
      put16(body, formatAt);
      put16(body, c.sub ? s.ptr(c.sub.channel) : 0);
      put16(body, c.sub ? s.ptr(c.sub.device) : 0);
      put16(body, s.ptr(c.label));
      put16(body, st.rxStatus);
      put16(body, st.status);
      body.push(0, 0, 0, 0);
    }
    return answer(req, more ? P.RESULT.MORE_PAGES : P.RESULT.SUCCESS, page.length ? [...body, ...FORMAT(this.sampleRate), ...s.bytes] : [0, 0]);
  }

  classicTx(req) {
    const start = P.u16(req, 12);
    const page = this.tx.filter((c) => c.number >= start).slice(0, P.TX_PER_PAGE);
    const more = this.tx.some((c) => c.number >= start + P.TX_PER_PAGE);
    if (!page.length) return answer(req, P.RESULT.SUCCESS, [0, 0]);
    const body = [page.length, page.length];
    const formatAt = 10 + 2 + page.length * 8;
    const s = strings(formatAt + 16);
    for (const c of page) {
      put16(body, c.number);
      put16(body, 0x0007);
      put16(body, formatAt);
      put16(body, s.ptr(c.factory));
    }
    return answer(req, more ? P.RESULT.MORE_PAGES : P.RESULT.SUCCESS, [...body, ...FORMAT(this.sampleRate), ...s.bytes]);
  }

  classicTxNames(req) {
    const first = P.u16(req, 12);
    const last = P.u16(req, 14) || this.tx.length;
    const page = this.tx.filter((c) => c.number >= first && c.number <= last).slice(0, P.TX_PER_PAGE);
    const body = [page.length, page.length];
    const s = strings(10 + 2 + page.length * 6 + 4);
    for (const c of page) {
      put16(body, c.number);
      put16(body, c.number);
      put16(body, s.ptr(c.label));
    }
    return answer(req, P.RESULT.SUCCESS, [...body, 0, 0, 0, 0, ...s.bytes]);
  }

  modernStatus(req, receiver) {
    if (this.noModernQueries || !this.modern) return answer(req, P.RESULT.FRONTEND_UNAVAILABLE);
    const first = P.u16(req, 20);
    const list = (receiver ? this.rx : this.tx).filter((c) => c.number >= first);
    const capacity = Math.min(16, Math.max(1, list.length));
    const page = list.slice(0, capacity);
    const more = list.length > capacity;
    const size = receiver ? 56 : 40;
    /* Laid out as the captures are: pointer table, format block, strings, records. */
    const out = [0, 0, 0, 0, 0, 0, capacity, page.length];
    const tableAt = 18;
    const formatAt = tableAt + page.length * 2;
    const s = strings(formatAt + 16);
    for (const c of page) { s.ptr(c.label); if (c.factory) s.ptr(c.factory); if (c.sub) { s.ptr(c.sub.channel); s.ptr(c.sub.device); } }
    let recordsAt = formatAt + 16 + s.bytes.length;
    const records = [];
    const pointers = [];
    for (const c of page) {
      const r = new Array(size).fill(0);
      set16(r, 0, receiver ? 0x141C : 0x1414);
      set16(r, 2, c.number);
      set16(r, 6, P.MEDIA.AUDIO);
      set16(r, 8, c.number);
      set16(r, 14, receiver ? 0x0006 : 0x0007);
      set16(r, 20, s.ptr(c.label));
      set16(r, 22, formatAt);
      set16(r, 30, s.ptr(c.factory || c.label));
      if (receiver) {
        const st = this.status(c);
        set16(r, 44, c.sub ? s.ptr(c.sub.channel) : 0);
        set16(r, 46, c.sub ? s.ptr(c.sub.device) : 0);
        set16(r, 48, st.status);
        set16(r, 50, st.rxStatus);
      }
      pointers.push(recordsAt);
      records.push(...r);
      recordsAt += size;
    }
    for (const p of pointers) put16(out, p);
    return answer(req, more ? P.RESULT.MORE_PAGES : P.RESULT.SUCCESS, [...out, ...FORMAT(this.sampleRate), ...s.bytes, ...records]);
  }

  apply(changes) {
    if (this.refuseWrites) return false;
    if (!this.ignoreWrites) for (const c of changes) this.subscribe(c.rx, c.sub);
    return true;
  }

  /* netaudio's `parse_add_subscriptions_request`, the other way round from the builder. */
  classicAdd(req) {
    if (req[10] !== 2) return answer(req, P.RESULT.ERROR);
    const changes = [];
    for (let i = 0; i < req[11]; i++) {
      const at = 12 + i * 6;
      changes.push({ rx: P.u16(req, at), sub: { channel: P.stringAt(req, P.u16(req, at + 2)), device: P.stringAt(req, P.u16(req, at + 4)) } });
    }
    return answer(req, this.apply(changes) ? P.RESULT.SUCCESS : P.RESULT.ERROR);
  }

  classicRemove(req) {
    const count = P.u32(req, 8);
    const changes = [];
    for (let i = 0; i < count; i++) changes.push({ rx: P.u32(req, 12 + i * 4), sub: null });
    return answer(req, this.apply(changes) ? P.RESULT.SUCCESS : P.RESULT.ERROR);
  }

  page2729(req) {
    const changes = [];
    for (let i = 0; i < req[11]; i++) {
      const at = 12 + i * 6;
      const cp = P.u16(req, at + 2);
      changes.push({ rx: P.u16(req, at), sub: cp ? { channel: P.stringAt(req, cp), device: P.stringAt(req, P.u16(req, at + 4)) } : null });
    }
    return answer(req, this.apply(changes) ? P.RESULT.SUCCESS : P.RESULT.ERROR);
  }

  modernPage(req) {
    const capacity = req[18];
    const changes = [];
    for (let i = 0; i < req[19]; i++) {
      const at = 20 + i * 8;
      const cp = P.u16(req, at + 4);
      changes.push({ rx: P.u16(req, at), sub: cp ? { channel: P.stringAt(req, cp), device: P.stringAt(req, P.u16(req, at + 6)) } : null });
    }
    const ok = this.apply(changes);
    /* As the captured acknowledgements read: six zeros, the capacity, a zero, a word per slot. */
    return answer(req, ok ? P.RESULT.SUCCESS : P.RESULT.ERROR, [0, 0, 0, 0, 0, 0, capacity, 0, ...new Array(capacity * 2).fill(0)]);
  }

  /** The mDNS records that advertise this device. */
  records() {
    const host = `${this.name}.local`;
    const arc = `${this.name}.${P.SERVICE.ARC}`;
    const cmc = `${this.name}.${P.SERVICE.CMC}`;
    const txt = { arcp_vers: this.arcp, arcp_min: '0.2.4', router_vers: '4.0.2', mf: this.mf, model: this.model };
    return {
      arc: { ptr: { name: P.SERVICE.ARC, type: TYPE.PTR, ttl: 10, data: arc },
        srv: { name: arc, type: TYPE.SRV, ttl: 10, flush: true, data: { port: this.port, target: host } },
        txt: { name: arc, type: TYPE.TXT, ttl: 10, flush: true, data: txt } },
      cmc: { ptr: { name: P.SERVICE.CMC, type: TYPE.PTR, ttl: 10, data: cmc },
        srv: { name: cmc, type: TYPE.SRV, ttl: 10, flush: true, data: { port: P.PORT.CONTROL, target: host } },
        txt: { name: cmc, type: TYPE.TXT, ttl: 10, flush: true, data: { id: `${this.mac || '000000000000'}0000`, mf: this.mf, model: this.model } } },
      a: { name: host, type: TYPE.A, ttl: 10, flush: true, data: '127.0.0.1' }
    };
  }
}

/**
 * Start a simulated network.
 *
 * @param {{devices?:Array, mdnsPort?:number, settleMs?:number}} [options]
 * @returns {Promise<{mdnsPort:number, target:string, devices:SimDevice[], device:Function,
 *   setSubscription:Function, queries:Array, close:Function}>}
 */
export async function startDanteSim({ devices = DEMO, mdnsPort = 0, settleMs = 300 } = {}) {
  const net = { devices: [], settleMs, queries: [] };
  const bind = (socket, port) => new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, '127.0.0.1', () => { socket.removeListener('error', reject); resolve(socket.address().port); });
  });
  for (const spec of devices) {
    const d = new SimDevice(spec, net);
    d.socket = dgram.createSocket('udp4');
    d.socket.on('message', (msg, rinfo) => {
      const reply = d.handle(new Uint8Array(msg));
      if (reply) d.socket.send(reply, rinfo.port, rinfo.address);
    });
    d.port = await bind(d.socket, 0);
    net.devices.push(d);
  }

  const mdns = dgram.createSocket('udp4');
  mdns.on('message', (msg, rinfo) => {
    const q = parseMessage(new Uint8Array(msg));
    if (!q || q.response) return;
    net.queries.push({ from: `${rinfo.address}:${rinfo.port}`, questions: q.questions });
    const answers = [];
    const additionals = [];
    for (const question of q.questions) {
      const name = canonical(question.name);
      for (const d of net.devices) {
        const r = d.records();
        for (const svc of [r.arc, r.cmc]) {
          if (question.type === TYPE.PTR && canonical(svc.ptr.name) === name) {
            answers.push(svc.ptr);
            additionals.push(svc.srv, svc.txt, r.a);
          } else if (canonical(svc.srv.name) === name && (question.type === TYPE.SRV || question.type === TYPE.ANY)) answers.push(svc.srv);
          else if (canonical(svc.txt.name) === name && (question.type === TYPE.TXT || question.type === TYPE.ANY)) answers.push(svc.txt);
        }
        if (question.type === TYPE.A && canonical(r.a.name) === name) answers.push(r.a);
      }
    }
    if (!answers.length) return;
    /* RFC 6762 §6.7: a legacy query's answer echoes its id and its questions, by unicast. */
    const seen = new Set();
    const extra = additionals.filter((r) => { const k = `${r.type}:${r.name}`; if (seen.has(k)) return false; seen.add(k); return true; });
    mdns.send(buildResponse({ id: q.id, questions: q.questions, answers, additionals: extra }), rinfo.port, rinfo.address);
  });
  const port = await bind(mdns, mdnsPort);

  const device = (name) => net.devices.find((d) => d.name.toLowerCase() === String(name).toLowerCase()) || null;
  return {
    mdnsPort: port,
    target: `127.0.0.1:${port}`,
    devices: net.devices,
    queries: net.queries,
    device,
    /** Change a route behind the plugin's back, as Dante Controller on another machine would. */
    setSubscription(name, number, sub) { return device(name).subscribe(number, sub); },
    close: () => new Promise((resolve) => {
      for (const d of net.devices) { try { d.socket.close(); } catch { /* closed */ } }
      mdns.close(() => resolve());
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--mdns-port');
  const sim = await startDanteSim({ mdnsPort: at >= 0 ? Number(args[at + 1]) || 0 : 0 });
  console.log(`Simulated Dante network (NOT a real device — see the head of this file)`);
  console.log(`mDNS answers on ${sim.target} — set the Dante plugin's discovery target to that.`);
  for (const d of sim.devices) console.log(`  ${d.name.padEnd(14)} ARC ${d.arcp.padEnd(7)} 127.0.0.1:${d.port}  ${d.tx.length} tx, ${d.rx.length} rx`);
}
