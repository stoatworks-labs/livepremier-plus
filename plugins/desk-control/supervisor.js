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
 * - **A take is not trusted to have started until it has landed.** The
 *   switcher can go on reporting the resting state a take left for the whole
 *   take — the 6.2.73 simulator does, for the full take time — so after a
 *   take or cut that screen's values wait until the transition reads
 *   differently from before it, or the take has had its time and
 *   `landMarginMs` (a take the switcher refused never moves it).
 * - **Late is dropped.** A recall, take or cut that could not go within
 *   `STALE_MS` of the desk asking is dropped and reported, not sent late: a
 *   take three seconds after the cue is a wrong take.
 *
 * ## The desk owns what its mode has channels for, the memory the rest
 *
 * Whenever something replaces the buffer the desk edits — the desk taking the
 * screen over, a recall into preview, a take — the desk's layer values for
 * that screen are written again (`DeskEngine.layersFor`). That is what makes a
 * Layer fixture mean the same thing whatever memory is loaded: source and
 * opacity in Cue mode, and in the larger modes position, size and the rest
 * too, unless W or H is at zero (`layerLook`). X and Y are from the screen's
 * centre, so its canvas is read with the letters.
 *
 * ## The other way
 *
 * With `deskFeedback` on, the same held connection reads the watched screens
 * about ten times a second and a take fires the Triggers plugin's triggers
 * (`feedback.js` decides what is a take and which rules it matches). It runs
 * whether or not a desk is listened to. A take this supervisor wrote is
 * remembered until it has had its time, and not fired back.
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
import { takeTimePath } from '../../src/core/transitions.js';
import { ARTNET_PORT, OP, parseArtnet, buildPollReplies } from '../../src/core/artnet.js';
import { SACN_PORT, parseSacn, multicastGroup } from '../../src/core/sacn.js';
import { DmxInput, portAddressOfUniverse } from '../../src/core/dmx-input.js';
import { DeskEngine, CONTROL, sourceValue } from '../../src/core/dmx-personality.js';
import { patchOf, allowed, layerSpec, lookParams, fitValue } from './core.js';
import { TakeWatch, matchRules, describeTake } from './feedback.js';

export const MIN_GAP_MS = 33;
export const SETTLE_MS = 150;
export const STALE_MS = 2000;
export const LAND_MARGIN_MS = 1500;
/* A take whose time could not be read: longer than any take a show runs on a cue. */
const LAND_UNKNOWN_MS = 10_000;
const HOLD_RETRY_MS = 40;
/* How often a watched screen is read for takes: AWJ pushes nothing. */
export const WATCH_MS = 100;
const ERROR_RETRY_MS = 1000;
const EXPIRE_EVERY_MS = 500;
const REFRESH_MS = 30_000;
const HISTORY = 60;
/* Only the screens and their layers: no inputs, stills or memories. */
const LIMITS = { screens: 24, auxes: 0, inputs: 0, memories: 0, layers: 16, stills: 0 };
/* With CITP on, the inputs and stills are read too: they are its libraries. */
const CITP_LIMITS = { ...LIMITS, inputs: 48, stills: 48 };
const PROTOCOL_IDS = ['artnet', 'sacn'];
/* What `plugins/triggers` names its sACN streams. */
const OWN_SOURCE = 'LivePremier Plus';

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
  /* id → { from, until }: a take or cut written, not yet seen to land. */
  #landing = new Map();
  /* id → until: a take or cut this wrote, not to be fired back to the desk. */
  #ownTakes = new Map();
  #takeWatch = new TakeWatch();
  #watchTimer = null;
  /* Bumped by every stop, so a read still in flight when the watch stopped cannot start a second loop. */
  #watchRun = 0;
  #fired = new Map();
  /** Layer fixture id → the source it has in program, as last read for CITP (`readLayerSources`). */
  layerSources = new Map();

  /**
   * @param {object} o
   * @param {() => string|null} o.deviceHost  the switcher's host, read per use
   * @param {() => {push: Function}|null} [o.timecode]  the timecode plugin's service
   * @param {() => {list: Function, fire: Function}|null} [o.triggers]  the Triggers plugin's service
   * @param {{artnet?: number, sacn?: number}} [o.ports]  0 for any (tests)
   * @param {string} [o.bindAddress]   '0.0.0.0'; tests bind loopback
   * @param {number|null} [o.pollReplyPort]  where ArtPollReply goes; null answers the poll's own port
   */
  constructor({
    deviceHost = () => null, awjPort = AWJ_PORT, log = () => {}, timecode = () => null, triggers = () => null,
    ports = {}, bindAddress = '0.0.0.0', pollReplyPort = ARTNET_PORT,
    interfaces = () => os.networkInterfaces(), minGapMs = MIN_GAP_MS, settleMs = SETTLE_MS, idleMs,
    landMarginMs = LAND_MARGIN_MS, watchMs = WATCH_MS,
  } = {}) {
    super();
    this.deviceHost = deviceHost;
    this.log = log;
    this.timecode = timecode;
    this.triggers = triggers;
    this.watchMs = watchMs;
    this.ports = { artnet: ARTNET_PORT, sacn: SACN_PORT, ...ports };
    this.bound = { artnet: null, sacn: null };
    this.socketErrors = { artnet: null, sacn: null };
    this.multicastError = null;
    this.bindAddress = bindAddress;
    this.pollReplyPort = pollReplyPort;
    this.interfaces = interfaces;
    this.minGapMs = minGapMs;
    this.settleMs = settleMs;
    this.landMarginMs = landMarginMs;
    this.link = new AwjLink({ host: () => this.deviceHost(), port: awjPort, ...(idleMs ? { idleMs } : {}) });
    this.switcher = new ConsoleSwitcher({ deviceHost: () => this.deviceHost(), awjPort, limits: LIMITS, exchange: this.link.exchange });
    this.facts = null;
    this.history = [];
    this.counts = {
      artnet: 0, sacn: 0, refused: 0, own: 0, polls: 0, timecode: 0, bursts: 0, written: 0, held: 0, dropped: 0,
      takes: 0, fired: 0, echoes: 0,
    };
  }

  get patch() { return this.#patch; }

  /* ------------------------------------------------------------ lifecycle */

  /** Follow the settings: listen while enabled, let everything go when not. */
  async apply(settings) {
    const was = this.#settings;
    this.#settings = settings;
    this.switcher.limits = settings?.deskCitp ? CITP_LIMITS : LIMITS;
    this.#repatch();
    this.#followFeedback(was);
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
    this.#stopWatching();
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
    this.#landing.clear();
    if (!this.#watchTimer) this.link.close();
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
      /* Pointed before the read, not after: a desk asking for layer sources
         while it is in flight would otherwise take the switcher for a new one
         and hang up on the read. */
      this.#pointAt(this.deviceHost());
      this.facts = await this.switcher.readFacts();
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
    /* This app's own Triggers output, multicast onto a universe patched here,
       would be the switcher driving itself. Its streams carry this name. */
    if (p.sourceName.startsWith(OWN_SOURCE)) { this.counts.own++; return; }
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
      const taking = [];
      let letters = new Map();

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
        if (a.type !== 'recall') taking.push(id);
        sent.push({
          a, note: built.note,
          after: () => {
            this.#readyAt.set(id, Date.now() + this.settleMs);
            if (a.type !== 'recall') this.#taken(id, a.type, letters.get(id));
            const buffer = this.#engine.control(id);
            /* A recall replaced preview; a take or cut replaced both. */
            if (buffer === CONTROL.PREVIEW || (a.type !== 'recall' && buffer !== CONTROL.OFF)) this.#repush(id);
          },
        });
      }

      /* Then the layer values, to the letters read now. A screen about to
         take is read too: the state its take leaves is how it is seen to land. */
      if (runs.size || taking.length) {
        try {
          letters = await this.#letters([...new Set([...runs.keys(), ...taking])], dialect);
        } catch (err) {
          this.#error(`reading the preset letters: ${err.message}`);
        }
        for (const [id, run] of runs) {
          const buffer = this.#engine.control(id);
          if (buffer === CONTROL.OFF) continue;
          const r = letters.get(id);
          const wait = !r ? 'preset letters not known' : !r.settled ? 'mid-transition'
            : this.#landed(id, r) ? null : 'the take landing';
          if (wait) {
            this.#unshiftRun(id, run);
            this.counts.held++;
            this.#held.set(id, wait);
            soon(Date.now() + (r ? HOLD_RETRY_MS : ERROR_RETRY_MS));
            continue;
          }
          this.#held.delete(id);
          const letter = buffer === CONTROL.PROGRAM ? r.program : r.preview;
          writes.push(...this.#layerWrites(dialect, id, letter, run, r.canvas));
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
    this.#pointAt(host);
    if (!this.switcher.dialect) this.switcher.dialect = await this.switcher.identify(host);
    return this.switcher.dialect;
  }

  /** `refresh` and `#ensureDialect` both come through here before using the link, so a held connection is always to `#dialectHost`. */
  #pointAt(host) {
    if (!host || host === this.#dialectHost) return;
    /* Re-pointed: the held connection is to the old switcher. */
    if (this.#dialectHost) this.link.close();
    this.switcher.dialect = null;
    this.#dialectHost = host;
  }

  /** A take or cut has just been written to `id`; `r` is its letters read before it. */
  #taken(id, type, r) {
    const ms = type === 'cut' ? 0 : r && r.tenths !== null ? r.tenths * 100 : LAND_UNKNOWN_MS;
    const until = Date.now() + ms + this.landMarginMs;
    this.#landing.set(id, { from: r ? r.transition : null, until });
    this.#ownTakes.set(id, until);
  }

  /** Whether the last take or cut written to `id` has been seen to land, given its letters read now. */
  #landed(id, r) {
    const l = this.#landing.get(id);
    if (!l) return true;
    if ((l.from !== null && r.transition !== l.from) || Date.now() >= l.until) {
      this.#landing.delete(id);
      return true;
    }
    return false;
  }

  /**
   * Each screen's preset letters, with whether they are settled, how long its
   * next take runs (`tenths`, null if unknown) and its canvas (null if
   * unknown), read now. The canvas is read every time for the same reason
   * the letters are: a preconfig change resizes it under the desk.
   */
  async #letters(ids, dialect, { watch = false } = {}) {
    const props = ['presetUp', 'presetDown', 'presetPrevious'];
    /* Both directions' take times: which one runs next depends on the transition read with them. */
    const times = (id) => (watch ? [] : [...new Map(['AT_DOWN', 'AT_UP'].map((t) => takeTimePath(dialect, id, t))
      .filter(Boolean).map((p) => [toAwj(p), p])).values()]);
    const canvas = (id) => (!watch && dialect.canvasSize ? ['sizeH', 'sizeV'].map((p) => dialect.canvasSize(id, p)).filter(Boolean) : []);
    /* For the watch, the memory every buffer holds: which one is going to air is read in the same burst. */
    const memory = (id) => (watch && dialect.bufferMemory ? dialect.bufferLetters.map((l) => [l, dialect.bufferMemory(id, l)]).filter(([, p]) => p) : []);
    const paths = [];
    for (const id of ids) {
      for (const p of props) paths.push(dialect.takeControl(id, p));
      paths.push(dialect.takeStatus(id, 'transition'), ...times(id), ...canvas(id), ...memory(id).map(([, p]) => p));
    }
    const got = await this.switcher.read(paths);
    return new Map(ids.map((id) => {
      const transition = got.get(toAwj(dialect.takeStatus(id, 'transition')));
      const time = takeTimePath(dialect, id, transition);
      const tenths = time ? got.get(toAwj(time)) : null;
      const [width, height] = canvas(id).map((p) => got.get(toAwj(p)));
      const r = resolve({
        control: { pp: Object.fromEntries(props.map((p) => [p, got.get(toAwj(dialect.takeControl(id, p)))])) },
        status: { pp: { transition } },
      });
      const memories = Object.fromEntries(memory(id).map(([l, p]) => {
        const slot = got.get(toAwj(p));
        return [l, Number.isInteger(slot) && slot > 0 ? slot : null];
      }));
      return [id, r && {
        ...r,
        tenths: Number.isFinite(tenths) ? tenths : null,
        canvas: width > 0 && height > 0 ? { width, height } : null,
        memories,
      }];
    }));
  }

  #layerWrites(dialect, id, letter, run, canvas) {
    const out = [];
    const sourceTail = layerSourcePath(dialect);
    for (const a of run) {
      if (a.param === 'source') {
        const value = sourceValue(dialect.id, a.value);
        const path = value && sourceTail ? dialect.layerParamPath(id, letter, a.layer, sourceTail) : null;
        if (path) out.push({ path, value });
        continue;
      }
      if (a.param === 'geometry' && !canvas) {
        this.#note({ kind: 'noted', destination: id, note: `${id} L${a.layer}: position not written, the screen's size is not known` }, { quiet: true });
        continue;
      }
      /* A part this platform lacks — a Midra's key, an aux's layers — is passed over. */
      for (const [param, raw] of lookParams(dialect, a.param, a.value, canvas)) {
        const spec = layerSpec(dialect, param);
        const value = fitValue(spec, raw);
        const path = spec && value !== null ? dialect.layerParamPath(id, letter, a.layer, spec.path) : null;
        if (path) out.push({ path, value });
      }
    }
    return out;
  }

  /**
   * What every patched layer has in program, for CITP's layer status: Layer
   * fixture id → the switcher's source value (`LIVE_3`, `COLOR`…), null where
   * it could not be read. Two bursts on the held connection: the letters,
   * then a source per layer.
   */
  async readLayerSources() {
    const dialect = await this.#ensureDialect();
    const tail = layerSourcePath(dialect);
    const layers = this.#patch.fixtures.filter((f) => f.kind === 'layer');
    const ids = [...new Set(layers.map((f) => f.destination))];
    if (!tail || !ids.length) {
      this.layerSources = new Map();
      return this.layerSources;
    }
    const letters = await this.#letters(ids, dialect, { watch: true });
    const pathOf = (f) => {
      const r = letters.get(f.destination);
      return r && r.program ? dialect.layerParamPath(f.destination, r.program, f.layer, tail) : null;
    };
    const paths = layers.map(pathOf).filter(Boolean);
    const got = paths.length ? await this.switcher.read(paths) : new Map();
    this.layerSources = new Map(layers.map((f) => {
      const path = pathOf(f);
      const value = path ? got.get(toAwj(path)) : null;
      return [f.id, typeof value === 'string' && value ? value : null];
    }));
    return this.layerSources;
  }

  /**
   * The IPv4 addresses CITP multicasts on: the chosen interface, or every one
   * that is not loopback — a desk may be on any of them.
   */
  interfaceAddresses() {
    const all = Object.values(this.interfaces() || {}).flat()
      .filter((i) => i && (i.family === 'IPv4' || i.family === 4));
    const chosen = this.#settings?.deskInterface;
    if (chosen) return all.some((i) => i.address === chosen) ? [chosen] : [];
    const out = all.filter((i) => !i.internal).map((i) => i.address);
    return out.length ? out : all.map((i) => i.address);
  }

  /* ----------------------------------------------------------- the other way */

  #watching() {
    const s = this.#settings;
    return !!s?.deskFeedback && s.deskFeedbackRules.some((r) => r.trigger);
  }

  /** The screens a rule names; a rule for any screen watches the patched ones. */
  #watchIds() {
    const rules = this.#settings.deskFeedbackRules.filter((r) => r.trigger);
    const ids = new Set(rules.map((r) => r.destination).filter(Boolean));
    if (rules.some((r) => !r.destination)) for (const id of this.#settings.deskDestinations) ids.add(id);
    return [...ids];
  }

  #followFeedback(was) {
    const on = this.#watching();
    const wasOn = !!was?.deskFeedback && was.deskFeedbackRules.some((r) => r.trigger);
    if (on && !this.#watchTimer) {
      this.#takeWatch.clear();
      this.#fired.clear();
      const run = this.#watchRun;
      this.#watchTimer = setTimeout(() => { void this.#watchTick(run); }, 0);
      this.#watchTimer.unref?.();
    }
    if (!on) this.#stopWatching();
    if (on !== wasOn) this.#note({ kind: on ? 'watching' : 'unwatched', note: on ? 'watching the switcher for takes' : 'stopped watching for takes' });
    /* A changed rule list starts every screen from a baseline again. */
    if (on && wasOn && JSON.stringify(was.deskFeedbackRules) !== JSON.stringify(this.#settings.deskFeedbackRules)) this.#takeWatch.clear();
  }

  #stopWatching() {
    clearTimeout(this.#watchTimer);
    this.#watchTimer = null;
    this.#watchRun++;
    this.#takeWatch.clear();
    if (!this.#settings?.deskEnabled) this.link.close();
  }

  async #watchTick(run) {
    if (run !== this.#watchRun || !this.#watching()) return;
    let delay = this.watchMs;
    try {
      const dialect = await this.#ensureDialect();
      const ids = this.#watchIds();
      const readings = await this.#letters(ids, dialect, { watch: true });
      for (const id of ids) {
        const take = this.#takeWatch.observe(id, readings.get(id) || null);
        if (take) this.#onTake(take);
      }
    } catch (err) {
      this.#takeWatch.clear();
      this.#error(`watching the switcher for takes: ${err.message}`);
      delay = ERROR_RETRY_MS;
    }
    if (run !== this.#watchRun || !this.#watching()) return;
    this.#watchTimer = setTimeout(() => { void this.#watchTick(run); }, delay);
    this.#watchTimer.unref?.();
  }

  #onTake(take) {
    this.counts.takes++;
    const id = take.destination;
    const what = describeTake(take);
    const own = this.#ownTakes.get(id);
    this.#ownTakes.delete(id);
    if (own && own >= Date.now()) {
      this.counts.echoes++;
      this.#note({ kind: 'echo', destination: id, note: `${what}: the desk’s own take, not fired back` }, { quiet: true });
      return;
    }
    const ids = matchRules(this.#settings.deskFeedbackRules, take, Date.now(), this.#fired);
    if (!ids.length) {
      this.#note({ kind: 'take', destination: id, note: `${what}: no rule` }, { quiet: true });
      return;
    }
    const svc = this.triggers();
    if (!svc) {
      this.#error(`${what}: the Triggers plugin is off, so nothing was fired`);
      return;
    }
    void (async () => {
      try {
        const r = await svc.fire(ids, what);
        this.counts.fired++;
        const bad = (r?.results || []).filter((x) => !x.ok);
        this.#note({
          kind: 'fired', destination: id,
          note: `${what}: fired ${r?.names?.join(', ') || ids.join(', ')}${bad.length ? ` — ${bad.map((x) => `${x.line}: ${x.error}`).join('; ')}` : ''}`,
          ...(bad.length ? { error: `firing ${ids.join(', ')}: ${bad[0].error}` } : {}),
        });
      } catch (err) {
        this.#error(`${what}: firing ${ids.join(', ')}: ${err.message}`);
      }
    })();
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
      feedback: {
        on: this.#watching(),
        watching: this.#watching() ? this.#watchIds() : [],
        triggers: (() => { try { return this.triggers()?.list() ?? null; } catch { return null; } })(),
      },
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
