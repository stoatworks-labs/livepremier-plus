/*
 * Desk control — a lighting desk driving the switcher.  ** PREVIEW **
 *
 * Art-Net and sACN in on UDP, AWJ out to the switcher, nothing in a browser.
 * The parts that decide are elsewhere and have no I/O:
 *
 *   src/core/artnet.js, sacn.js     the packets
 *   src/core/dmx-input.js           which desk is in control of each universe
 *   src/core/dmx-personality.js     what the channels ask for (DeskEngine)
 *   src/core/console-intents.js     what a recall, take or cut writes
 *
 * This moves bytes between them, and keeps the order of things.
 *
 * ## One queue per screen, one step per screen per burst
 *
 * A desk sends every universe up to 44 times a second whether anything moved
 * or not; the switcher wants far fewer writes than that. So what the desk asks
 * for is queued per destination, and a pump sends at most one burst every
 * `minGapMs` (30 a second):
 *
 * - **Layer values coalesce.** A fader pulled through 200 values between two
 *   bursts is one write of where it stopped. Only within a run of layer
 *   values, though: a value queued before a take is never merged with one
 *   queued after it, or the take would carry the wrong look.
 * - **Recalls, takes and cuts never coalesce** and go out in the order the
 *   desk asked, one per destination per burst. After each, that destination
 *   waits `settleMs`: a memory is still loading into preview when its recall
 *   has been written, and a take written straight after it would take the
 *   old preview.
 * - **Which preset letter is preview and which is program is read before
 *   every burst of layer values**, through the held AWJ connection. A take
 *   from the Web RCS, a T-bar, another console — any of them swaps the
 *   letters between two bursts, and a write to a remembered letter is a write
 *   to air. Mid-transition there is no honest answer, so that destination's
 *   values wait until the transition has finished.
 * - **Late is dropped.** A recall, take or cut that could not go within
 *   `STALE_MS` of the desk asking is dropped and reported, not sent late: a
 *   take three seconds after the cue is a wrong take.
 *
 * ## The desk owns source and opacity, the memory owns the rest
 *
 * Whenever something replaces the buffer the desk edits — the desk taking the
 * screen over, a recall into preview, a take — the desk's layer values for
 * that screen are written again (`DeskEngine.layersFor`). That is what makes a
 * Cue-mode Layer fixture mean the same thing whatever memory is loaded.
 *
 * ## The held connection
 *
 * `server/awj-link.js`, argued at its head: one of the switcher's five AWJ
 * clients, closed after five seconds with nothing to say.
 */

import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';

import { AwjLink } from '../../server/awj-link.js';
import { ConsoleSwitcher } from '../../server/console-switcher.js';
import { AWJ_PORT } from '../../server/awj.js';
import { commandsFor } from '../../src/core/commands.js';
import { writesFor, layerSourcePath } from '../../src/core/console-intents.js';
import { resolve } from '../../src/vendor/surface/preset.js';
import { toAwj } from '../../src/core/paths.js';
import { ARTNET_PORT, OP, parseArtnet, buildPollReplies } from '../../src/core/artnet.js';
import { SACN_PORT, parseSacn, multicastGroup } from '../../src/core/sacn.js';
import { DmxInput, portAddressOfUniverse } from '../../src/core/dmx-input.js';
import { DeskEngine, CONTROL, sourceValue } from '../../src/core/dmx-personality.js';
import { patchOf, allowed, layerTail } from './core.js';

export const MIN_GAP_MS = 33;
export const SETTLE_MS = 150;
export const STALE_MS = 2000;
const HOLD_RETRY_MS = 40;
const ERROR_RETRY_MS = 1000;
const EXPIRE_EVERY_MS = 500;
const REFRESH_MS = 30_000;
const HISTORY = 60;
/* Only the screens and their layers: no inputs, stills or memories. */
const LIMITS = { screens: 24, auxes: 0, inputs: 0, memories: 0, layers: 16, stills: 0 };
const PROTOCOL_IDS = ['artnet', 'sacn'];

export class DeskSupervisor extends EventEmitter {
  #settings = null;
  #patch = { fixtures: [], universes: [] };
  #patchKey = '';
  #input = new DmxInput();
  #engine = new DeskEngine();
  #sockets = { artnet: null, sacn: null };
  #joined = new Set();
  #global = [];
  #queues = new Map();
  #readyAt = new Map();
  #pumping = false;
  #timer = null;
  #timerAt = Infinity;
  #lastBurst = 0;
  #expireTimer = null;
  #refreshTimer = null;
  #pollReplies = 0;
  #dialectHost = null;
  #lastError = null;
  #held = new Map();

  /**
   * @param {object} o
   * @param {() => string|null} o.deviceHost  the switcher's host, read per use
   * @param {() => {push: Function}|null} [o.timecode]  the timecode plugin's service
   * @param {{artnet?: number, sacn?: number}} [o.ports]  0 for any (tests)
   * @param {string} [o.bindAddress]   '0.0.0.0'; tests bind loopback
   * @param {number|null} [o.pollReplyPort]  where ArtPollReply goes; null answers the poll's own port
   */
  constructor({
    deviceHost = () => null, awjPort = AWJ_PORT, log = () => {}, timecode = () => null,
    ports = {}, bindAddress = '0.0.0.0', pollReplyPort = ARTNET_PORT,
    interfaces = () => os.networkInterfaces(), minGapMs = MIN_GAP_MS, settleMs = SETTLE_MS, idleMs,
  } = {}) {
    super();
    this.deviceHost = deviceHost;
    this.log = log;
    this.timecode = timecode;
    this.ports = { artnet: ARTNET_PORT, sacn: SACN_PORT, ...ports };
    this.bound = { artnet: null, sacn: null };
    this.socketErrors = { artnet: null, sacn: null };
    this.multicastError = null;
    this.bindAddress = bindAddress;
    this.pollReplyPort = pollReplyPort;
    this.interfaces = interfaces;
    this.minGapMs = minGapMs;
    this.settleMs = settleMs;
    this.link = new AwjLink({ host: () => this.deviceHost(), port: awjPort, ...(idleMs ? { idleMs } : {}) });
    this.switcher = new ConsoleSwitcher({ deviceHost: () => this.deviceHost(), awjPort, limits: LIMITS, exchange: this.link.exchange });
    this.facts = null;
    this.history = [];
    this.counts = { artnet: 0, sacn: 0, refused: 0, polls: 0, timecode: 0, bursts: 0, written: 0, held: 0, dropped: 0 };
  }

  get patch() { return this.#patch; }

  /* ------------------------------------------------------------ lifecycle */

  /** Follow the settings: listen while enabled, let everything go when not. */
  async apply(settings) {
    const was = this.#settings;
    this.#settings = settings;
    this.#repatch();
    if (!settings?.deskEnabled) {
      if (was?.deskEnabled) {
        this.#shut();
        this.#note({ kind: 'stopped' });
      }
      return this.describe();
    }
    await Promise.all(PROTOCOL_IDS.map((p) => (this.#wants(p) ? this.#open(p) : this.#close(p))));
    this.#joinGroups();
    if (!this.#expireTimer) {
      this.#expireTimer = setInterval(() => this.#expire(), EXPIRE_EVERY_MS);
      this.#expireTimer.unref?.();
    }
    if (!was?.deskEnabled) this.#note({ kind: 'started', note: this.#listening() });
    void this.refresh();
    return this.describe();
  }

  /** The plugin is stopping. */
  stop() {
    this.#shut();
    this.link.dispose();
  }

  #shut() {
    for (const p of PROTOCOL_IDS) this.#close(p);
    clearInterval(this.#expireTimer);
    this.#expireTimer = null;
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#timerAt = Infinity;
    this.#global = [];
    this.#queues.clear();
    this.#readyAt.clear();
    this.#held.clear();
    this.link.close();
  }

  #wants(protocol) {
    const p = this.#settings?.deskProtocol;
    return !!this.#settings?.deskEnabled && (p === 'both' || p === protocol);
  }

  /* The patch follows the settings at once, enabled or not: the card shows
     it and the GDTF and CSV come from it. */
  #repatch() {
    if (!this.#settings) return;
    const patch = patchOf(this.#settings, (id) => this.#labelOf(id));
    const key = patch.fixtures.map((f) => `${f.id}@${f.universe}.${f.address}:${f.mode}`).join();
    this.#patch = patch;
    if (key === this.#patchKey) return;
    this.#patchKey = key;
    this.#engine.repatch(patch.fixtures);
    this.#input.watch(patch.universes);
    this.#global = [];
    this.#queues.clear();
    this.#held.clear();
    /* What each universe holds now is the new patch's baseline, so the next
       change after a repatch is a change and not a first frame. */
    for (const u of patch.universes) {
      const frame = this.#input.frame(u);
      if (frame) this.#engine.update(u, frame, { fresh: true });
    }
    this.#joinGroups();
  }

  #labelOf(id) {
    const d = this.facts?.destinations?.find((x) => x.id === id);
    return d ? d.label : '';
  }

  /** Read the switcher's screens, for their names and which are in service. */
  async refresh() {
    clearTimeout(this.#refreshTimer);
    if (!this.#settings?.deskEnabled) return null;
    try {
      this.facts = await this.switcher.readFacts();
      this.#dialectHost = this.deviceHost();
      this.#repatch();
      this.#ok();
      this.#note({ kind: 'read', note: `${this.facts.destinations.filter((d) => d.isUsed).length} screens in service` }, { quiet: true });
    } catch (err) {
      this.#error(`reading the switcher: ${err.message}`);
    }
    if (this.#settings?.deskEnabled) {
      this.#refreshTimer = setTimeout(() => { void this.refresh(); }, REFRESH_MS);
      this.#refreshTimer.unref?.();
    }
    return this.facts;
  }

  /* ------------------------------------------------------------- sockets */

  #open(protocol) {
    if (this.#sockets[protocol]) return Promise.resolve();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.#sockets[protocol] = socket;
    socket.on('message', (buf, rinfo) => {
      try {
        if (protocol === 'artnet') this.#onArtnet(buf, rinfo);
        else this.#onSacn(buf, rinfo);
      } catch (err) {
        this.#error(`${protocol} packet from ${rinfo.address}: ${err.message}`);
      }
    });
    return new Promise((done) => {
      socket.once('error', (err) => {
        /* Another program holding the port without SO_REUSEADDR, most
           likely. Said on the card; the other protocol carries on. */
        this.socketErrors[protocol] = err.message;
        this.#error(`${protocol === 'artnet' ? 'Art-Net' : 'sACN'}: ${err.message}`);
        this.#close(protocol);
        done();
      });
      socket.bind(this.ports[protocol], this.bindAddress, () => {
        this.socketErrors[protocol] = null;
        this.bound[protocol] = socket.address().port;
        if (protocol === 'artnet') socket.setBroadcast(true);
        else { this.#joined.clear(); this.#joinGroups(); }
        done();
      });
    });
  }

  #close(protocol) {
    const socket = this.#sockets[protocol];
    this.#sockets[protocol] = null;
    this.bound[protocol] = null;
    if (protocol === 'sacn') this.#joined.clear();
    if (socket) { try { socket.close(); } catch { /* already closed */ } }
  }

  /** Join each patched universe's sACN multicast group, and leave the rest. */
  #joinGroups() {
    const socket = this.#sockets.sacn;
    if (!socket || !this.bound.sacn) return;
    const want = new Set(this.#patch.universes.map(multicastGroup));
    const iface = this.#iface().address;
    this.multicastError = null;
    for (const g of [...this.#joined]) {
      if (want.has(g)) continue;
      try { socket.dropMembership(g, iface); } catch { /* gone with the interface */ }
      this.#joined.delete(g);
    }
    for (const g of want) {
      if (this.#joined.has(g)) continue;
      try {
        socket.addMembership(g, iface);
        this.#joined.add(g);
      } catch (err) {
        /* Unicast sACN still arrives; the card says multicast does not. */
        this.multicastError = `${g} on ${iface}: ${err.message}`;
      }
    }
  }

  /**
   * The address this node answers as. A chosen interface, or the one on the
   * asker's own subnet, or the first that is not loopback: a desk on 2.x.x.x
   * must be told the 2.x.x.x address, not the office one.
   */
  #iface(remote = null) {
    const all = Object.values(this.interfaces() || {}).flat()
      .filter((i) => i && (i.family === 'IPv4' || i.family === 4));
    const chosen = this.#settings?.deskInterface;
    let pick = chosen ? all.find((i) => i.address === chosen) : null;
    if (!pick && remote) pick = all.find((i) => sameSubnet(i.address, remote, i.netmask));
    if (!pick) pick = all.find((i) => !i.internal) || all[0];
    return pick ? { address: pick.address, mac: pick.mac || '00:00:00:00:00:00' } : { address: '0.0.0.0', mac: '00:00:00:00:00:00' };
  }

  #listening() {
    const parts = [];
    if (this.bound.artnet) parts.push(`Art-Net on ${this.bound.artnet}`);
    if (this.bound.sacn) parts.push(`sACN on ${this.bound.sacn}`);
    const u = this.#patch.universes;
    return `${parts.join(', ') || 'no sockets'}; universe${u.length === 1 ? '' : 's'} ${u.join(', ') || 'none'}`;
  }

  /* ------------------------------------------------------------- packets */

  #onArtnet(buf, rinfo) {
    const p = parseArtnet(buf);
    if (!p) return;
    /* Discovery is answered whoever asks: it changes nothing, and a desk the
       allow list refuses should still see why nothing happens. */
    if (p.op === OP.POLL) { this.#replyPoll(rinfo); return; }
    if (!allowed(this.#settings, rinfo.address)) { this.counts.refused++; return; }
    if (p.op === OP.DMX) {
      this.counts.artnet++;
      this.#frame(this.#input.artnet({ ip: rinfo.address, physical: p.physical, portAddress: p.portAddress, data: p.data }, Date.now()));
    } else if (p.op === OP.TIMECODE) {
      this.#timecode(p);
    }
  }

  #onSacn(buf, rinfo) {
    const p = parseSacn(buf);
    if (!p || p.kind !== 'data') return;
    if (!allowed(this.#settings, rinfo.address)) { this.counts.refused++; return; }
    this.counts.sacn++;
    this.#frame(this.#input.sacn(p, Date.now(), rinfo.address));
  }

  #expire() {
    for (const result of this.#input.expire(Date.now())) this.#frame(result);
  }

  /** What a universe now holds, from whichever desk is in control of it. */
  #frame(result) {
    if (!result) return;
    const { universe, active, activeChanged, changed } = result;
    if (!active) {
      /* Nobody in control. The screens it held stay held and nothing is
         written; the next desk's first frame is a baseline. */
      this.#engine.forget(universe);
      if (activeChanged) this.#note({ kind: 'lost', note: `universe ${universe}: no desk${result.why ? ` (${result.why})` : ''}` });
      return;
    }
    if (activeChanged) this.#note({ kind: 'source', note: `universe ${universe}: ${this.#sourceLabel(universe)} in control` });
    if (!changed) return;
    const actions = this.#engine.update(universe, this.#input.frame(universe), { fresh: activeChanged });
    for (const a of actions) this.#enqueue(a);
  }

  #sourceLabel(universe) {
    const u = this.#input.describe(Date.now()).find((x) => x.universe === universe);
    const s = u?.sources.find((x) => x.inControl);
    return s ? `${s.protocol === 'artnet' ? 'Art-Net' : 'sACN'} ${s.label}` : 'a desk';
  }

  #replyPoll(rinfo) {
    this.counts.polls++;
    const socket = this.#sockets.artnet;
    if (!socket) return;
    const iface = this.#iface(rinfo.address);
    const at = Date.now();
    const active = new Set(this.#input.describe(at).filter((u) => u.active).map((u) => portAddressOfUniverse(u.universe)));
    const host = this.deviceHost();
    const packets = buildPollReplies({
      ip: iface.address.split('.').map(Number),
      mac: iface.mac.split(':').map((h) => parseInt(h, 16) || 0),
      universes: this.#patch.universes.map(portAddressOfUniverse),
      shortName: 'LivePremier Plus',
      longName: `LivePremier Plus desk control${host ? ` - ${host}` : ''}`,
      report: this.#lastError ? 'switcher unreachable' : 'OK',
      replies: this.#pollReplies++,
      active,
    });
    const port = this.pollReplyPort ?? rinfo.port;
    /* A desk on this same machine — onPC or MagicQ beside the app — listens
       on 6454 too, and of two sockets sharing a port the system hands a
       unicast datagram to one only: this app's own, on macOS 26.4 (measured
       2026-10-30). A broadcast on that interface reaches every one of them. */
    const own = this.#ownAddress(rinfo.address);
    const to = own && !own.internal && own.netmask ? broadcastOf(own.address, own.netmask) : rinfo.address;
    for (const b of packets) socket.send(b, port, to);
  }

  #ownAddress(ip) {
    return Object.values(this.interfaces() || {}).flat()
      .find((i) => i && (i.family === 'IPv4' || i.family === 4) && i.address === ip) || null;
  }

  #timecode(p) {
    this.counts.timecode++;
    const service = this.timecode();
    if (!service?.push) return;
    service.push({ hours: p.hours, minutes: p.minutes, seconds: p.seconds, frames: p.frames, rate: p.rate, dropFrame: p.dropFrame });
  }

  /* --------------------------------------------------------------- queue */

  #queue(id) {
    let q = this.#queues.get(id);
    if (!q) { q = []; this.#queues.set(id, q); }
    return q;
  }

  #enqueue(a) {
    const at = Date.now();
    switch (a.type) {
      case 'engage':
        this.#note({ kind: 'engage', destination: a.destination, note: `${a.destination}: the desk has it (${a.buffer})` });
        return;
      case 'release':
        this.#queues.delete(a.destination);
        this.#held.delete(a.destination);
        this.#note({ kind: 'release', destination: a.destination, note: `${a.destination}: let go` });
        return;
      case 'recallMaster':
        this.#global.push({ ...a, at });
        break;
      case 'takeAll':
      case 'cutAll': {
        /* Into each screen's own queue, behind whatever it already has: a
           take-all carries each screen's layer values with it. */
        const type = a.type === 'takeAll' ? 'take' : 'cut';
        const ids = this.#engine.engaged().map((e) => e.id);
        if (!ids.length) { this.#note({ kind: 'noted', note: `${type} all: no screen is under the desk's control` }); return; }
        for (const id of ids) this.#queue(id).push({ type, destination: id, at, all: true });
        break;
      }
      case 'layer': {
        const q = this.#queue(a.destination);
        const key = `${a.layer}|${a.param}`;
        for (let i = q.length - 1; i >= 0 && q[i].type === 'layer'; i--) {
          if (q[i].key === key) { q.splice(i, 1); break; }
        }
        q.push({ ...a, key, at });
        break;
      }
      default:
        this.#queue(a.destination).push({ ...a, at });
    }
    this.#schedule();
  }

  /**
   * The desk's values for a screen, at the front of its queue: something has
   * just replaced the buffer the desk edits. A value already queued in the
   * leading run is replaced by the current one; one queued behind a recall,
   * take or cut is a later cue's and is left where it is.
   */
  #repush(id) {
    const q = this.#queue(id);
    const actions = this.#engine.layersFor(id).map((a) => ({ ...a, key: `${a.layer}|${a.param}`, at: Date.now() }));
    let run = 0;
    while (run < q.length && q[run].type === 'layer') run++;
    const later = new Set(q.slice(run).filter((a) => a.type === 'layer').map((a) => a.key));
    const fresh = actions.filter((a) => !later.has(a.key));
    const keys = new Set(fresh.map((a) => a.key));
    const kept = q.slice(0, run).filter((a) => !keys.has(a.key));
    q.splice(0, run, ...fresh, ...kept);
  }

  /** Put back a run of layer values that could not go yet, behind nothing newer. */
  #unshiftRun(id, run) {
    const q = this.#queue(id);
    let lead = 0;
    while (lead < q.length && q[lead].type === 'layer') lead++;
    const newer = new Set(q.slice(0, lead).map((a) => a.key));
    q.unshift(...run.filter((a) => !newer.has(a.key)));
  }

  #hasWork() {
    if (this.#global.length) return true;
    for (const q of this.#queues.values()) if (q.length) return true;
    return false;
  }

  #schedule(at = Date.now()) {
    if (!this.#hasWork() || this.#pumping) return;
    const when = Math.max(at, this.#lastBurst + this.minGapMs);
    if (this.#timer && this.#timerAt <= when) return;
    clearTimeout(this.#timer);
    this.#timerAt = when;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#timerAt = Infinity;
      void this.#pump();
    }, Math.max(0, when - Date.now()));
  }

  /* ---------------------------------------------------------------- pump */

  async #pump() {
    if (this.#pumping || !this.#settings?.deskEnabled) return;
    this.#pumping = true;
    let next = null;
    const soon = (t) => { next = next === null ? t : Math.min(next, t); };
    try {
      let dialect;
      try {
        dialect = await this.#ensureDialect();
      } catch (err) {
        this.#dropDiscrete(`the switcher: ${err.message}`);
        this.#error(`the switcher: ${err.message}`);
        soon(Date.now() + ERROR_RETRY_MS);
        return;
      }
      const commands = commandsFor(dialect);
      const now = Date.now();
      this.#lastBurst = now;
      const writes = [];
      const sent = [];            /* { a, note, after } for each recall, take or cut */
      const runs = new Map();

      /* The Master's recalls first: a memory for the whole switcher. */
      while (this.#global.length) {
        const a = this.#global.shift();
        if (now - a.at > STALE_MS) { this.#drop(a, 'too late'); continue; }
        const cmd = commands.recallMasterPreset(a.slot, 'PREVIEW');
        if (!cmd) { this.#note({ kind: 'noted', note: `master memory ${a.slot}: this platform has no master memories` }); continue; }
        writes.push(...[].concat(cmd));
        sent.push({
          a, note: `master memory ${a.slot} to preview`,
          after: () => {
            for (const { id, buffer } of this.#engine.engaged()) {
              this.#readyAt.set(id, Date.now() + this.settleMs);
              if (buffer === CONTROL.PREVIEW) this.#repush(id);
            }
          },
        });
      }

      /* Then one step per screen. */
      for (const [id, q] of this.#queues) {
        if (!q.length || (this.#readyAt.get(id) || 0) > now) continue;
        if (q[0].type === 'layer') {
          let n = 0;
          while (n < q.length && q[n].type === 'layer') n++;
          runs.set(id, q.splice(0, n));
          continue;
        }
        const a = q.shift();
        if (now - a.at > STALE_MS) { this.#drop(a, 'too late'); continue; }
        const intent = a.type === 'recall' ? { kind: 'recall', slot: a.slot } : { kind: a.type };
        const built = writesFor(intent, { dialect, commands, selected: [id] });
        if (!built.writes.length) { this.#note({ kind: 'noted', destination: id, note: built.note }); continue; }
        writes.push(...built.writes);
        sent.push({
          a, note: built.note,
          after: () => {
            this.#readyAt.set(id, Date.now() + this.settleMs);
            const buffer = this.#engine.control(id);
            /* A recall replaced preview; a take or cut replaced both. */
            if (buffer === CONTROL.PREVIEW || (a.type !== 'recall' && buffer !== CONTROL.OFF)) this.#repush(id);
          },
        });
      }

      /* Then the layer values, to the letters read now. */
      if (runs.size) {
        let letters = new Map();
        try {
          letters = await this.#letters([...runs.keys()], dialect);
        } catch (err) {
          this.#error(`reading the preset letters: ${err.message}`);
        }
        for (const [id, run] of runs) {
          const buffer = this.#engine.control(id);
          if (buffer === CONTROL.OFF) continue;
          const r = letters.get(id);
          if (!r || !r.settled) {
            this.#unshiftRun(id, run);
            this.counts.held++;
            if (!this.#held.has(id)) this.#held.set(id, r ? 'mid-transition' : 'preset letters not known');
            soon(Date.now() + (r ? HOLD_RETRY_MS : ERROR_RETRY_MS));
            continue;
          }
          this.#held.delete(id);
          const letter = buffer === CONTROL.PROGRAM ? r.program : r.preview;
          writes.push(...this.#layerWrites(dialect, id, letter, run));
        }
      }

      if (writes.length) {
        try {
          await this.switcher.write(writes);
        } catch (err) {
          for (const [id, run] of runs) if (!this.#held.has(id)) this.#unshiftRun(id, run);
          for (const { a } of sent) this.#drop(a, `the switcher did not take it (${err.message})`);
          this.#error(`writing to the switcher: ${err.message}`);
          soon(Date.now() + ERROR_RETRY_MS);
          return;
        }
        this.counts.bursts++;
        this.counts.written += writes.length;
        this.#ok();
        for (const { a, note, after } of sent) {
          this.#note({ kind: 'sent', destination: a.destination ?? null, note });
          after();
        }
        this.emit('activity');
      }

      /* What is left goes in the next burst, or when its screen is ready. */
      const t = Date.now();
      if (this.#global.length) soon(t);
      for (const [id, q] of this.#queues) if (q.length) soon(Math.max(t, this.#readyAt.get(id) || 0));
    } catch (err) {
      this.#error(err.message);
      soon(Date.now() + ERROR_RETRY_MS);
    } finally {
      this.#pumping = false;
      this.#schedule(next ?? Date.now());
    }
  }

  async #ensureDialect() {
    const host = this.deviceHost();
    if (!host) throw new Error('no switcher configured');
    if (host !== this.#dialectHost) {
      /* Re-pointed: the held connection is to the old switcher. */
      this.link.close();
      this.switcher.dialect = null;
      this.#dialectHost = host;
    }
    if (!this.switcher.dialect) this.switcher.dialect = await this.switcher.identify(host);
    return this.switcher.dialect;
  }

  /** Each screen's preset letters, with whether they are settled, read now. */
  async #letters(ids, dialect) {
    const props = ['presetUp', 'presetDown', 'presetPrevious'];
    const paths = [];
    for (const id of ids) {
      for (const p of props) paths.push(dialect.takeControl(id, p));
      paths.push(dialect.takeStatus(id, 'transition'));
    }
    const got = await this.switcher.read(paths);
    return new Map(ids.map((id) => [id, resolve({
      control: { pp: Object.fromEntries(props.map((p) => [p, got.get(toAwj(dialect.takeControl(id, p)))])) },
      status: { pp: { transition: got.get(toAwj(dialect.takeStatus(id, 'transition'))) } },
    })]));
  }

  #layerWrites(dialect, id, letter, run) {
    const out = [];
    const sourceTail = layerSourcePath(dialect);
    const opacityTail = layerTail(dialect, dialect.layerParams?.opacity);
    for (const a of run) {
      if (a.param === 'source') {
        const value = sourceValue(dialect.id, a.value);
        const path = value && sourceTail ? dialect.layerParamPath(id, letter, a.layer, sourceTail) : null;
        if (path) out.push({ path, value });
      } else if (a.param === 'opacity') {
        const path = opacityTail ? dialect.layerParamPath(id, letter, a.layer, opacityTail) : null;
        if (path) out.push({ path, value: a.value });
      }
    }
    return out;
  }

  #drop(a, why) {
    this.counts.dropped++;
    const what = a.type === 'recallMaster' ? `master memory ${a.slot}`
      : a.type === 'recall' ? `${a.destination} memory ${a.slot}` : `${a.destination} ${a.type}`;
    this.#note({ kind: 'dropped', destination: a.destination ?? null, note: `${what}: dropped, ${why}` });
  }

  /** The switcher cannot be reached: recalls, takes and cuts are not kept for later. */
  #dropDiscrete(why) {
    for (const a of this.#global.splice(0)) this.#drop(a, why);
    for (const q of this.#queues.values()) {
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].type !== 'layer') this.#drop(q.splice(i, 1)[0], why);
      }
    }
  }

  /* ------------------------------------------------------------ reporting */

  #ok() { this.#lastError = null; }

  #error(message) {
    if (message === this.#lastError) return;
    this.#lastError = message;
    this.#note({ kind: 'error', error: message });
  }

  #note(entry, { quiet = false } = {}) {
    const e = { at: Date.now(), ...entry };
    if (!quiet || entry.kind === 'error') {
      this.history.unshift(e);
      this.history.length = Math.min(this.history.length, HISTORY);
      if (entry.error) this.log(`desk-control: ${entry.error}`);
    }
    this.emit('activity', e);
  }

  describe() {
    const at = Date.now();
    const s = this.#settings;
    const iface = this.#iface();
    const screens = this.#patch.fixtures.filter((f) => f.kind === 'screen').map((f) => ({
      id: f.destination,
      label: this.#labelOf(f.destination),
      control: this.#engine.control(f.destination),
      queued: (this.#queues.get(f.destination) || []).length,
      held: this.#held.get(f.destination) || null,
    }));
    return {
      enabled: !!s?.deskEnabled,
      protocol: s?.deskProtocol ?? null,
      interface: iface,
      interfaces: Object.values(this.interfaces() || {}).flat()
        .filter((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal).map((i) => i.address),
      sockets: {
        artnet: { open: !!this.bound.artnet, port: this.bound.artnet, error: this.socketErrors.artnet },
        sacn: { open: !!this.bound.sacn, port: this.bound.sacn, error: this.socketErrors.sacn, groups: [...this.#joined], multicastError: this.multicastError },
      },
      switcher: {
        host: this.deviceHost(),
        platform: this.switcher.dialect?.id ?? null,
        link: { open: this.link.open, ...this.link.stats, lastError: this.link.lastError },
        error: this.#lastError,
        destinations: (this.facts?.destinations || []).filter((d) => d.isUsed).map((d) => ({ id: d.id, label: d.label })),
      },
      patch: this.#patch,
      universes: this.#input.describe(at),
      master: this.#patch.fixtures.some((f) => f.kind === 'master') ? this.#engine.control('master') : null,
      screens,
      counts: { ...this.counts },
      history: this.history,
    };
  }
}

const ipNumber = (s) => s.split('.').reduce((v, x) => ((v << 8) | Number(x)) >>> 0, 0);

function sameSubnet(a, b, mask) {
  if (!mask) return false;
  const m = ipNumber(mask);
  return (ipNumber(a) & m) === (ipNumber(b) & m);
}

function broadcastOf(address, mask) {
  const n = (ipNumber(address) | (~ipNumber(mask) >>> 0)) >>> 0;
  return [24, 16, 8, 0].map((sh) => (n >>> sh) & 255).join('.');
}
