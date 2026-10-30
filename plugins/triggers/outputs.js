/*
 * Triggers — the sending: one UDP socket for OSC, Art-Net and sACN, a TCP
 * link per MIDI-over-TCP destination, and the universes this app holds.
 *
 * ## A universe is a stream, not a message
 *
 * An OSC message or a MIDI note is sent once. A DMX level is not: a node or
 * an sACN receiver expects the universe again and again, and lets go of a
 * source it stops hearing (sACN after 2.5 s). So a universe, once a line has
 * set a channel in it, is kept here and sent every second while it holds
 * still, and 25 times a second while a fade runs. That is also why this is
 * the server's job and never a page's: a background tab's timers are slowed
 * by the browser, and a house-light fade that stuttered every time somebody
 * switched tabs would be the least of it.
 *
 * **Release** stops a universe. sACN says so in the packet — three with the
 * stream-terminated bit, as E1.31 asks — and a receiver goes back to its other
 * sources at once. Art-Net has no such word; the node merges this source out
 * or holds its last look, as it is set to.
 *
 * Nothing here knows a trigger or a hold. It is handed parsed lines, with any
 * `before` already turned into levels by the server.
 */

import dgram from 'node:dgram';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

import {
  encodeOsc, encodeArtDmx, encodeSacn, sacnMulticast, SACN_TERMINATED, DMX_SLOTS,
  noteOn, noteOff, controlChange, programChange, mscMessage, hexBytes,
} from './protocol.js';

const TICK_MS = 40;
export const KEEPALIVE_MS = 1000;
const CONNECT_MS = 2000;

/** One MIDI-over-TCP destination's socket, opened on first use and kept. */
class MidiLink {
  constructor({ host, port }) {
    this.host = host;
    this.port = port;
    this.socket = null;
    this.ready = null;
  }

  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      const timer = setTimeout(() => { socket.destroy(new Error(`no answer from ${this.host}:${this.port}`)); }, CONNECT_MS);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 5000);
      /* A desk talks back — meters, its own changes. Nothing here reads it. */
      socket.on('data', () => {});
      socket.once('connect', () => { clearTimeout(timer); this.socket = socket; resolve(socket); });
      socket.on('error', (err) => { clearTimeout(timer); reject(err); });
      socket.on('close', () => { clearTimeout(timer); this.socket = null; this.ready = null; });
    });
    /* A failed connect is retried on the next line, not held against it. */
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }

  async write(bytes) {
    const socket = await this.connect();
    await new Promise((resolve, reject) => socket.write(bytes, (err) => (err ? reject(err) : resolve())));
  }

  close() {
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.ready = null;
  }
}

function midiBytes(msg, dest) {
  switch (msg.msg) {
    case 'note': return noteOn(msg.channel, msg.note, msg.velocity);
    case 'off': return noteOff(msg.channel, msg.note, msg.velocity);
    case 'cc': return controlChange(msg.channel, msg.controller, msg.value);
    case 'pc': return programChange(msg.channel, msg.program);
    case 'msc': return mscMessage({ ...msg, device: dest.mscDevice ?? 0x7f, format: dest.mscFormat || 'all' });
    case 'hex': return hexBytes(msg.hex);
    default: throw new Error(`no MIDI message “${msg.msg}”`);
  }
}

const sameStream = (a, b) => a.kind === b.kind && a.universe === b.universe && a.host === b.host && a.port === b.port;

export class Outputs {
  constructor({ log = () => {}, source = 'LivePremier Plus' } = {}) {
    this.log = log;
    this.source = source;
    this.cid = randomBytes(16);
    this.udp = null;
    this.universes = new Map();
    this.midi = new Map();
    this.timer = null;
    this.onChange = () => {};
  }

  socket() {
    if (!this.udp) {
      this.udp = new Promise((resolve, reject) => {
        const s = dgram.createSocket({ type: 'udp4' });
        s.once('error', reject);
        s.bind(0, () => {
          s.removeListener('error', reject);
          /* Art-Net to a .255 address is a broadcast; harmless to unicast. */
          try { s.setBroadcast(true); } catch { /* not every platform asks */ }
          s.on('error', (err) => this.log(`triggers: UDP: ${err.message}`));
          s.unref();
          resolve(s);
        });
      });
      this.udp.catch(() => { this.udp = null; });
    }
    return this.udp;
  }

  async sendUdp(buf, port, host) {
    const s = await this.socket();
    await new Promise((resolve, reject) => s.send(buf, port, host, (err) => (err ? reject(err) : resolve())));
  }

  /**
   * Send one parsed line. A DMX line carries `levels`, `[[channel, level]]`,
   * already worked out by the caller — `before` included.
   */
  async send(dest, msg) {
    if (!dest.enabled) throw new Error(`${dest.name} is switched off`);
    if (msg.type === 'osc') {
      if (!dest.host) throw new Error(`${dest.name} has no address`);
      await this.sendUdp(encodeOsc(msg.address, msg.args), dest.port, dest.host);
      return;
    }
    if (msg.type === 'midi') {
      if (!dest.host) throw new Error(`${dest.name} has no address`);
      let link = this.midi.get(dest.id);
      if (link && (link.host !== dest.host || link.port !== dest.port)) { link.close(); link = null; }
      if (!link) { link = new MidiLink(dest); this.midi.set(dest.id, link); }
      await link.write(midiBytes(msg, dest));
      return;
    }
    if (msg.type === 'dmx') {
      if (dest.kind === 'artnet' && !dest.host) throw new Error(`${dest.name} has no node address`);
      if (msg.release) { await this.release(dest.id); return; }
      this.setLevels(dest, msg.levels, msg.fade || 0);
      return;
    }
    throw new Error(`nothing sends a “${msg.type}” line`);
  }

  /* ---------------------------------------------------------- universes */

  universe(dest) {
    let u = this.universes.get(dest.id);
    if (u && !sameStream(u.dest, dest)) { void this.release(dest.id); u = null; }
    if (!u) {
      u = { dest, data: new Uint8Array(DMX_SLOTS), fades: new Map(), seq: 0, lastSent: 0, dirty: true, error: null };
      this.universes.set(dest.id, u);
    }
    u.dest = dest;
    return u;
  }

  /** Where a channel is headed: a running fade's end, else its level now. Null for a universe not held. */
  level(destId, channel) {
    const u = this.universes.get(destId);
    if (!u) return null;
    const f = u.fades.get(channel);
    return f ? f.to : u.data[channel - 1];
  }

  setLevels(dest, levels, fade) {
    const u = this.universe(dest);
    const now = Date.now();
    for (const [ch, to] of levels) {
      if (fade > 0) u.fades.set(ch, { from: u.data[ch - 1], to, start: now, ms: fade * 1000 });
      else { u.fades.delete(ch); u.data[ch - 1] = to; }
    }
    u.dirty = true;
    this.tick();
    this.ensureTicker();
    this.onChange();
  }

  ensureTicker() {
    if (this.timer || !this.universes.size) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  tick() {
    const now = Date.now();
    for (const u of this.universes.values()) {
      for (const [ch, f] of u.fades) {
        const t = Math.min(1, (now - f.start) / f.ms);
        const v = Math.round(f.from + (f.to - f.from) * t);
        if (u.data[ch - 1] !== v) { u.data[ch - 1] = v; u.dirty = true; }
        if (t >= 1) u.fades.delete(ch);
      }
      if (u.dirty || now - u.lastSent >= KEEPALIVE_MS) this.sendUniverse(u, 0);
    }
    if (!this.universes.size && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  packet(u, options) {
    const { dest } = u;
    if (dest.kind === 'artnet') {
      u.seq = u.seq >= 255 ? 1 : u.seq + 1;
      return { buf: encodeArtDmx({ universe: dest.universe, sequence: u.seq, data: u.data }), host: dest.host };
    }
    u.seq = (u.seq + 1) & 0xff;
    return {
      buf: encodeSacn({ universe: dest.universe, sequence: u.seq, data: u.data, priority: dest.priority, cid: this.cid, source: this.source, options }),
      host: dest.host || sacnMulticast(dest.universe),
    };
  }

  sendUniverse(u, options) {
    u.dirty = false;
    u.lastSent = Date.now();
    const { buf, host } = this.packet(u, options);
    return this.sendUdp(buf, u.dest.port, host).then(() => {
      if (u.error) { u.error = null; this.onChange(); }
    }, (err) => {
      if (u.error !== err.message) { u.error = err.message; this.log(`triggers: ${u.dest.name}: ${err.message}`); this.onChange(); }
    });
  }

  /** Stop sending a universe: sACN says so three times, Art-Net just stops. */
  async release(destId) {
    const u = this.universes.get(destId);
    if (!u) return;
    this.universes.delete(destId);
    if (u.dest.kind === 'sacn') {
      for (let i = 0; i < 3; i++) await this.sendUniverse(u, SACN_TERMINATED);
    }
    this.onChange();
  }

  /** Put the outputs in line with a saved destination list: a stream whose destination went or moved is released. */
  apply(destinations) {
    const byId = new Map(destinations.map((d) => [d.id, d]));
    for (const [id, u] of [...this.universes]) {
      const d = byId.get(id);
      if (!d || !d.enabled || !sameStream(u.dest, d)) void this.release(id);
      else u.dest = d;
    }
    for (const [id, link] of [...this.midi]) {
      const d = byId.get(id);
      if (!d || !d.enabled || d.kind !== 'midi-tcp' || d.host !== link.host || d.port !== link.port) { link.close(); this.midi.delete(id); }
    }
  }

  describe() {
    return [...this.universes.values()].map((u) => ({
      dest: u.dest.id,
      fading: u.fades.size > 0,
      lit: u.data.reduce((n, v) => n + (v > 0 ? 1 : 0), 0),
      error: u.error,
    }));
  }

  async stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await Promise.all([...this.universes.keys()].map((id) => this.release(id).catch(() => {})));
    for (const link of this.midi.values()) link.close();
    this.midi.clear();
    const udp = this.udp;
    this.udp = null;
    if (udp) { try { (await udp).close(); } catch { /* never bound */ } }
  }
}
