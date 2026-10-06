/*
 * Dante — the switcher's own Dante card, as the store describes it, and what
 * its Audio Matrix does with each Dante channel. No DOM, no I/O: it reads a
 * store mirror, and the tests hand it one cut from the simulator.
 *
 * ## What the store says about the card
 *
 * A LivePremier with a Dante card reports it under
 * `device/system/deviceList/items/<frame>/dante` (read off LivePremier
 * Simulator 6.2.73's store and its model attributes on 2026-10-06):
 *
 *   status/pp      type (BK2_64X64 | BK3_64X64), id (≤ 31 characters),
 *                  version, audinateVersion, ethernetMode — and UNKNOWN /
 *                  NOT_INITIALIZED with no id in a frame slot with no card
 *   ipv4/primary|secondary/status/pp   macAddress, ip [a, b, c, d], isPlugged
 *   channelList/items/DANTE_<b>_CHANNEL_<c>
 *       source/status/pp       label, connectedTo   (a receive channel)
 *       transmitter/status/pp  label                (a transmit channel)
 *
 * ⚠️ Two readings here are inferences, not observations, because the
 * simulator has no card behind those fields (every label is empty, the
 * address is 0.0.0.0):
 *
 * - **`id` is the card's Dante device name.** It is 32 characters long in the
 *   model — a Dante name and its terminator — and the simulator's is
 *   `AQL-Simulator`, the shape of one. Matching by it is the first choice, the
 *   card's addresses the second, and a setting the last.
 * - **`DANTE_<b>_CHANNEL_<c>` is Dante channel (b − 1) × 8 + c.** The Audio
 *   Matrix and the vendored mynah both number it so (`plugins/audio-matrix/
 *   model.js`); nobody has yet put a real card's channel 9 next to its block
 *   2 channel 1.
 *
 * `connectedTo` is shown as the store gives it. Its format on a real card is
 * not known; when it reads `channel@device` the panel compares it with what
 * the card itself reports over Dante.
 *
 * Nothing here imports the Audio Matrix plugin — a plugin never imports
 * another's folder — so the few paths it needs are spelled out again below.
 */

import { ROOT } from '../../src/core/paths.js';

const CHANNELS_PER_BLOCK = 8;
const CHANNEL_KEY = /^DANTE_(\d+)_CHANNEL_(\d+)$/;

/** `DANTE_2_CHANNEL_3` → 11. */
export const flatDante = (block, ch) => (block - 1) * CHANNELS_PER_BLOCK + ch;
/** 11 → `DANTE_2_CHANNEL_3`. */
export const danteKey = (n) => `DANTE_${Math.floor((n - 1) / CHANNELS_PER_BLOCK) + 1}_CHANNEL_${((n - 1) % CHANNELS_PER_BLOCK) + 1}`;

const pp = (node, ...path) => {
  let n = node;
  for (const k of path) n = n && n[k];
  return (n && n.pp) || {};
};

const ip = (v) => (Array.isArray(v) && v.length === 4 && v.some((x) => x) ? v.join('.') : null);

/**
 * The switcher's Dante cards: `[{ frame, name, type, version, ethernetMode,
 * addresses, macs, rx: Map(n → { label, connectedTo }), tx: Map(n → { label }) }]`.
 * Empty when the store is not ready or has no card.
 */
export function switcherCards(store) {
  if (!store || !store.ready) return [];
  const list = [ROOT, 'system', 'deviceList'];
  if (!store.get(list)) return [];
  const out = [];
  for (const frame of store.itemKeys(list).map(String)) {
    const card = store.get([...list, 'items', frame, 'dante']);
    if (!card) continue;
    const status = pp(card, 'status');
    /* Every frame slot of a LivePremier carries the node; a frame with no
       card (or no frame) reads UNKNOWN, NOT_INITIALIZED and no name. */
    if ((!status.type || status.type === 'UNKNOWN') && !status.id) continue;
    const rx = new Map();
    const tx = new Map();
    const channels = (card.channelList && card.channelList.items) || {};
    for (const [key, ch] of Object.entries(channels)) {
      const m = CHANNEL_KEY.exec(key);
      if (!m) continue;
      const n = flatDante(Number(m[1]), Number(m[2]));
      const source = pp(ch, 'source', 'status');
      rx.set(n, { label: source.label || '', connectedTo: source.connectedTo || '' });
      tx.set(n, { label: pp(ch, 'transmitter', 'status').label || '' });
    }
    const side = (s) => pp(card, 'ipv4', s, 'status');
    out.push({
      frame,
      name: typeof status.id === 'string' ? status.id.trim() : '',
      type: status.type || null,
      version: status.version || null,
      ethernetMode: status.ethernetMode || null,
      addresses: [ip(side('primary').ip), ip(side('secondary').ip)].filter(Boolean),
      macs: [side('primary').macAddress, side('secondary').macAddress].filter((m) => typeof m === 'string' && m).map((m) => m.toLowerCase()),
      rx,
      tx
    });
  }
  return out;
}

/**
 * Which discovered Dante device is which of the switcher's cards:
 * `Map(device name → { frame, by })`. By the card's Dante name, then an
 * address, then a MAC, then the `switcherDevice` setting.
 */
export function matchSwitcher(devices, cards, setting = '') {
  const out = new Map();
  const lower = (s) => String(s || '').toLowerCase();
  for (const card of cards) {
    let hit = null;
    let by = null;
    if (card.name) { hit = devices.find((d) => lower(d.name) === lower(card.name)); by = 'name'; }
    if (!hit && card.addresses.length) { hit = devices.find((d) => card.addresses.includes(d.address)); by = 'address'; }
    if (!hit && card.macs.length) { hit = devices.find((d) => d.mac && card.macs.includes(lower(d.mac))); by = 'MAC'; }
    if (!hit && setting) { hit = devices.find((d) => lower(d.name) === lower(setting)); by = 'setting'; }
    if (hit && !out.has(hit.name)) out.set(hit.name, { frame: card.frame, by, card });
  }
  if (!out.size && setting && !cards.length) {
    const hit = devices.find((d) => lower(d.name) === lower(setting));
    if (hit) out.set(hit.name, { frame: null, by: 'setting', card: null });
  }
  return out;
}

/* ------------------------------------------------- the Audio Matrix side */

const audioRoot = (frame) => [ROOT, 'audio', 'control', 'deviceList', 'items', String(frame)];
const DEST_KEY = /^(OUTPUT|DANTE|MVW)_(\d+)$/;
const SOURCE_KEY = /^(INPUT|DANTE)_(\d+)_CHANNEL_(\d+)$/;

/** An audio-matrix source key as the Audio Matrix says it. */
export function describeSource(key) {
  if (!key || key === 'NONE') return null;
  const m = SOURCE_KEY.exec(key);
  if (!m) return key;
  return m[1] === 'INPUT' ? `Input ${m[2]} ch ${m[3]}` : `Dante ${flatDante(Number(m[2]), Number(m[3]))}`;
}

function describeDest(dest, ch) {
  const m = DEST_KEY.exec(dest);
  if (!m) return `${dest} ch ${ch}`;
  if (m[1] === 'DANTE') return `Dante ${flatDante(Number(m[2]), Number(ch))}`;
  return `${m[1] === 'OUTPUT' ? 'Output' : 'Multiviewer'} ${m[2]} ch ${ch}`;
}

/**
 * What the switcher's own Audio Matrix does with each Dante channel of one
 * frame: `rx` — Dante receive channel n feeds these destinations; `tx` —
 * Dante transmit channel n carries this source. Empty maps when the frame
 * has no matrix.
 */
export function audioPatches(store, frame) {
  const rx = new Map();
  const tx = new Map();
  if (!store || !store.ready || frame == null) return { rx, tx };
  const items = store.get([...audioRoot(frame), 'txList', 'items']);
  if (!items) return { rx, tx };
  for (const [dest, node] of Object.entries(items)) {
    const chs = (node && node.channelList && node.channelList.items) || {};
    for (const [ch, c] of Object.entries(chs)) {
      const source = pp(c, 'control').source;
      const d = DEST_KEY.exec(dest);
      if (d && d[1] === 'DANTE') tx.set(flatDante(Number(d[2]), Number(ch)), describeSource(source));
      const s = SOURCE_KEY.exec(source || '');
      if (s && s[1] === 'DANTE') {
        const n = flatDante(Number(s[2]), Number(s[3]));
        if (!rx.has(n)) rx.set(n, []);
        rx.get(n).push(describeDest(dest, ch));
      }
    }
  }
  return { rx, tx };
}
