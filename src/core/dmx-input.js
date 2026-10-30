/*
 * Which desk is in control of each universe — no I/O, time passed in.
 *
 * Art-Net and sACN arrive at the same universes, from one desk or from two,
 * and a video switcher cannot merge them the way a dimmer can: the larger of
 * two layer positions means nothing. So each universe has exactly one source
 * in control, and the rest are listed and ignored. The rules, which E1.31
 * asks a receiver to write down:
 *
 * - **Highest priority wins.** sACN carries one (0–200); Art-Net has none and
 *   counts as 100, sACN's default. A backup desk at a lower priority is
 *   therefore a tracking backup: it takes over when the main desk stops.
 * - **Equal priority: the lowest source key wins**, which is the same answer
 *   every time. E1.31 discourages "first source wins", because it hands
 *   control to whichever desk happened to boot first.
 * - **A source is gone** after 2.5 s without a packet (sACN, as the standard
 *   says), on sACN's Stream_Terminated, or after 10 s for Art-Net, which some
 *   desks only refresh every few seconds when nothing changes.
 * - **Preview data never drives anything** (sACN's Preview_Data option).
 * - **At most four sources per universe** are tracked. A fifth is counted as
 *   "sources exceeded", which the settings card shows.
 *
 * Losing the source in control, or a change of source, is reported, so the
 * caller can treat what follows as a new stream: triggers re-arm rather than
 * fire on whatever the new source happens to be sending.
 *
 * Universes are numbered as a desk numbers them, from 1: Art-Net Port-Address
 * 0 (0:0:0) is universe 1, and sACN universe 1 is universe 1.
 */

import { outOfOrder } from './sacn.js';

export const SACN_LOSS_MS = 2500;
export const ARTNET_LOSS_MS = 10_000;
export const ARTNET_PRIORITY = 100;
export const MAX_SOURCES = 4;

/** Art-Net Port-Address → universe number; and back. */
export const universeOfPortAddress = (pa) => pa + 1;
export const portAddressOfUniverse = (u) => u - 1;

export class DmxInput {
  /** @type {Map<number, {sources: Map<string, object>, active: string|null, data: Uint8Array|null, exceeded: number}>} */
  #universes = new Map();

  /** Only these universes are listened to; everything else is dropped. */
  constructor({ universes = [] } = {}) {
    this.watch(universes);
  }

  /** Change which universes are listened to. State for the ones dropped goes. */
  watch(universes) {
    const want = new Set(universes);
    for (const u of [...this.#universes.keys()]) if (!want.has(u)) this.#universes.delete(u);
    for (const u of want) {
      if (!this.#universes.has(u)) this.#universes.set(u, { sources: new Map(), active: null, data: null, exceeded: 0 });
    }
  }

  get universes() { return [...this.#universes.keys()].sort((a, b) => a - b); }

  /**
   * One ArtDmx. Returns what changed for its universe, or null when the
   * universe is not watched.
   */
  artnet({ ip, physical = 0, portAddress, data }, at) {
    const u = universeOfPortAddress(portAddress);
    return this.#offer(u, `artnet:${ip}:${physical}`, {
      protocol: 'artnet', label: ip, priority: ARTNET_PRIORITY, lossMs: ARTNET_LOSS_MS, data,
    }, at);
  }

  /** One sACN data packet, from `parseSacn`. */
  sacn(packet, at, ip = null) {
    if (!packet || packet.kind !== 'data') return null;
    /* Alternate START codes (0xDD per-address priority among them) are not
       level data. Preview data must not drive output. */
    if (packet.startCode !== 0 || packet.preview) return null;
    const key = `sacn:${packet.cid}`;
    const universe = this.#universes.get(packet.universe);
    if (!universe) return null;
    if (packet.terminated) return this.#drop(packet.universe, key, at, 'terminated');
    const known = universe.sources.get(key);
    if (known && outOfOrder(known.sequence, packet.sequence)) return null;
    return this.#offer(packet.universe, key, {
      protocol: 'sacn', label: packet.sourceName || ip || packet.cid.slice(0, 8),
      priority: packet.priority, lossMs: SACN_LOSS_MS, data: packet.data, sequence: packet.sequence,
    }, at);
  }

  /** Forget sources that have gone quiet. Returns the universes whose control changed. */
  expire(at) {
    const changed = [];
    for (const [u, universe] of this.#universes) {
      let lost = false;
      for (const [key, s] of universe.sources) {
        if (at - s.at > s.lossMs) { universe.sources.delete(key); lost = true; }
      }
      if (lost) {
        const result = this.#elect(u, universe);
        if (result.activeChanged) changed.push(result);
      }
    }
    return changed;
  }

  /** The 512 slots in control of a universe now, or null when nobody is. */
  frame(u) {
    const universe = this.#universes.get(u);
    return universe && universe.active ? universe.data : null;
  }

  describe(at = Date.now()) {
    return this.universes.map((u) => {
      const universe = this.#universes.get(u);
      return {
        universe: u,
        active: universe.active,
        exceeded: universe.exceeded > 0,
        sources: [...universe.sources.entries()].map(([key, s]) => ({
          key, protocol: s.protocol, label: s.label, priority: s.priority,
          inControl: key === universe.active, ageMs: at - s.at,
        })),
      };
    });
  }

  #offer(u, key, src, at) {
    const universe = this.#universes.get(u);
    if (!universe) return null;
    let s = universe.sources.get(key);
    if (!s) {
      if (universe.sources.size >= MAX_SOURCES) { universe.exceeded++; return null; }
      s = { data: new Uint8Array(512) };
      universe.sources.set(key, s);
    }
    s.protocol = src.protocol;
    s.label = src.label;
    s.priority = src.priority;
    s.lossMs = src.lossMs;
    s.sequence = src.sequence ?? null;
    s.at = at;
    /* A short packet leaves the slots it did not send at 0, as a desk that
       sends fewer than 512 channels means. */
    s.data.fill(0);
    s.data.set(src.data.subarray(0, 512));
    return this.#elect(u, universe);
  }

  #drop(u, key, at, why) {
    const universe = this.#universes.get(u);
    if (!universe || !universe.sources.delete(key)) return null;
    return { ...this.#elect(u, universe), why };
  }

  /**
   * Choose the source in control and say what changed: whether the source
   * did (`activeChanged`) and whether the slots it holds did (`changed`).
   */
  #elect(u, universe) {
    let best = null;
    for (const [key, s] of universe.sources) {
      if (!best || s.priority > best.s.priority || (s.priority === best.s.priority && key < best.key)) best = { key, s };
    }
    const active = best ? best.key : null;
    const activeChanged = active !== universe.active;
    universe.active = active;
    if (!best) {
      const had = universe.data !== null;
      universe.data = null;
      return { universe: u, active: null, activeChanged, changed: had };
    }
    let changed = activeChanged || !universe.data;
    if (!changed) {
      for (let i = 0; i < 512; i++) if (universe.data[i] !== best.s.data[i]) { changed = true; break; }
    }
    if (changed) universe.data = best.s.data.slice();
    return { universe: u, active, activeChanged, changed };
  }
}
