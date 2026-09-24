/*
 * Audio Matrix — the model: the store's channel matrix, read as a crosspoint
 * grid, and the writes that change it. No DOM, no I/O.
 *
 * `device/audio/control/deviceList/items/<frame>` holds two collections (see
 * the vendored mynah's `AUDIO` note, which counted them off a running frame):
 *
 * - `rxList` — the SOURCES: `INPUT_<1-64>_CHANNEL_<1-8>`,
 *   `DANTE_<1-8>_CHANNEL_<1-8>` and `NONE`, each with a `mute`.
 * - `txList` — the DESTINATIONS: `OUTPUT_<1-24>`, `DANTE_<1-8>`, `MVW_<1-2>`,
 *   each a `channelList` of eight carrying `source`, `mute` and `sine`.
 *
 * So a destination channel holds exactly one source, and a patch is one write
 * of the source's key into its `source`. There is no crosspoint object: the
 * grid is drawn from the destinations' `source` fields alone, which is why a
 * column can never show two lit points.
 *
 * Dante is eight blocks of eight on the wire and a flat 1–64 to everybody who
 * uses it, the Console included — so the groups are the wire's blocks and the
 * channel labels are the flat numbers.
 */

import { ROOT } from '../../src/core/paths.js';
import { readConnectors, logicalIndex } from '../../src/core/connectors.js';

export const CHANNELS = 8;
export const NONE = 'NONE';

export const matrixRoot = () => [ROOT, 'audio', 'control', 'deviceList'];
const frameRoot = (frame) => [...matrixRoot(), 'items', String(frame)];

/** A destination channel's writable property, as a store path. */
export const txPath = (frame, dest, ch, prop) =>
  [...frameRoot(frame), 'txList', 'items', dest, 'channelList', 'items', String(ch), 'control', 'pp', prop];

/** A source channel's own mute, which silences it into every destination. */
export const rxMutePath = (frame, source) =>
  [...frameRoot(frame), 'rxList', 'items', source, 'control', 'pp', 'mute'];

/** Which frames carry a matrix. A linked system has one per frame. */
export function frames(store) {
  if (!store || !store.ready || !store.get(matrixRoot())) return [];
  return store.itemKeys(matrixRoot()).map(String);
}

/** The switcher's audio clock, for the toolbar: `{ clockMode, sampleRate }` or null. */
export function clock(store) {
  const pp = store && store.ready ? store.get([ROOT, 'audio', 'status', 'pp']) : null;
  return pp ? { clockMode: pp.clockMode ?? null, sampleRate: pp.sampleRate ?? null } : null;
}

const SOURCE_KEY = /^(INPUT|DANTE)_(\d+)_CHANNEL_(\d+)$/;
const DEST_KEY = /^(OUTPUT|DANTE|MVW)_(\d+)$/;

/** `DANTE_2_CHANNEL_3` → 11, the number a Dante channel is known by. */
const danteFlat = (block, ch) => (block - 1) * CHANNELS + ch;

/** `{ kind, unit, ch }` for a source key, or null for NONE and anything unknown. */
export function parseSource(key) {
  const m = SOURCE_KEY.exec(String(key));
  if (!m) return null;
  return { kind: m[1] === 'INPUT' ? 'input' : 'dante', unit: Number(m[2]), ch: Number(m[3]) };
}

/** A source key as a person says it: `Input 3 ch 2`, `Dante 11`, `None`. */
export function describeSource(key) {
  if (key === NONE || key == null) return 'None';
  const s = parseSource(key);
  if (!s) return String(key);
  return s.kind === 'input' ? `Input ${s.unit} ch ${s.ch}` : `Dante ${danteFlat(s.unit, s.ch)}`;
}

/** A destination channel as a person says it: `Output 1 ch 2`, `Dante 11`, `Multiviewer 1 ch 2`. */
export function describeDest(dest, ch) {
  const m = DEST_KEY.exec(String(dest));
  if (!m) return `${dest} ch ${ch}`;
  const unit = Number(m[2]);
  if (m[1] === 'DANTE') return `Dante ${danteFlat(unit, Number(ch))}`;
  return `${m[1] === 'OUTPUT' ? 'Output' : 'Multiviewer'} ${unit} ch ${ch}`;
}

/**
 * The numbers of the connectors actually fitted on one side, or null when the
 * store does not say — in which case nothing is hidden, because a filter that
 * hid every input on a store it could not read would look like a dead matrix.
 */
function fittedSet(store, side) {
  let list;
  try { list = readConnectors(store, side); } catch { return null; }
  const nums = list.map((c) => logicalIndex(c.key)).filter((n) => Number.isInteger(n));
  return nums.length ? new Set(nums) : null;
}

function connectorLabels(store, side) {
  const out = new Map();
  let list;
  try { list = readConnectors(store, side, { includeUnfitted: true }); } catch { return out; }
  for (const c of list) {
    const n = logicalIndex(c.key);
    if (Number.isInteger(n) && c.label) out.set(n, c.label);
  }
  return out;
}

const pp = (node, side = 'control') => ((node || {})[side] || {}).pp || {};

/**
 * Read one frame's matrix.
 *
 * @param {{get: Function, itemKeys: Function, ready: boolean}} store
 * @param {string} frame
 * @param {{ fittedOnly?: boolean }} [opts]
 * @returns {null | {
 *   frame: string,
 *   sources: Array<Group>, destinations: Array<Group>,
 *   hidden: { sources: number, destinations: number }
 * }}
 *
 * A Group is `{ id, kind, unit, label, name, channels }`; a source channel is
 * `{ key, ch, label, mute, signal }` and a destination channel
 * `{ ch, label, source, mute, sine, signal }`.
 */
export function readMatrix(store, frame, { fittedOnly = true } = {}) {
  if (!store || !store.ready) return null;
  const root = frameRoot(frame);
  const rx = store.get([...root, 'rxList', 'items']);
  const tx = store.get([...root, 'txList', 'items']);
  if (!rx || !tx) return null;

  /* ---------------------------------------------------------- destinations */
  const destinations = [];
  const inUse = new Set();       // source group ids some destination takes from
  const outLabels = connectorLabels(store, 'output');
  for (const id of store.itemKeys([...root, 'txList'])) {
    const m = DEST_KEY.exec(id);
    const node = tx[id];
    if (!m || !node) continue;
    const unit = Number(m[2]);
    const kind = m[1] === 'OUTPUT' ? 'output' : m[1] === 'DANTE' ? 'dante' : 'multiviewer';
    const chNodes = (node.channelList || {}).items || {};
    const channels = [];
    for (let ch = 1; ch <= CHANNELS; ch++) {
      const c = chNodes[String(ch)];
      if (!c) continue;
      const control = pp(c);
      const source = control.source ?? NONE;
      const s = parseSource(source);
      if (s) inUse.add(sourceGroupId(s));
      channels.push({
        ch,
        label: kind === 'dante' ? String(danteFlat(unit, ch)) : String(ch),
        source,
        mute: control.mute === true,
        sine: control.sine === true,
        signal: pp(c, 'status').isLevelDetected === true
      });
    }
    destinations.push({
      id, kind, unit, channels,
      label: kind === 'output' ? `Output ${unit}`
        : kind === 'dante' ? `Dante ${danteFlat(unit, 1)}–${danteFlat(unit, CHANNELS)}`
          : `Multiviewer ${unit}`,
      name: kind === 'output' ? outLabels.get(unit) || '' : '',
      live: channels.some((c) => c.source !== NONE)
    });
  }

  /* --------------------------------------------------------------- sources */
  const byGroup = new Map();
  const inLabels = connectorLabels(store, 'input');
  for (const key of store.itemKeys([...root, 'rxList'])) {
    const s = parseSource(key);
    if (!s || !rx[key]) continue;
    const gid = sourceGroupId(s);
    let g = byGroup.get(gid);
    if (!g) {
      g = {
        id: gid, kind: s.kind, unit: s.unit, channels: [],
        label: s.kind === 'input' ? `Input ${s.unit}`
          : `Dante ${danteFlat(s.unit, 1)}–${danteFlat(s.unit, CHANNELS)}`,
        name: s.kind === 'input' ? inLabels.get(s.unit) || '' : ''
      };
      byGroup.set(gid, g);
    }
    g.channels.push({
      key, ch: s.ch,
      label: s.kind === 'dante' ? String(danteFlat(s.unit, s.ch)) : String(s.ch),
      mute: pp(rx[key]).mute === true,
      signal: pp(rx[key], 'status').isLevelDetected === true
    });
  }
  const sources = [...byGroup.values()];
  for (const g of sources) g.channels.sort((a, b) => a.ch - b.ch);

  /* ---------------------------------------------------------- the filter */
  /* Fitted only hides what is not on the back of this frame — but never a
     group that is patched, because a filter must not hide a live route. */
  let hidden = { sources: 0, destinations: 0 };
  let shownSources = sources;
  let shownDests = destinations;
  if (fittedOnly) {
    const ins = fittedSet(store, 'input');
    const outs = fittedSet(store, 'output');
    shownSources = sources.filter((g) => g.kind !== 'input' || !ins || ins.has(g.unit) || inUse.has(g.id));
    shownDests = destinations.filter((g) => g.kind !== 'output' || !outs || outs.has(g.unit) || g.live);
    hidden = {
      sources: sources.length - shownSources.length,
      destinations: destinations.length - shownDests.length
    };
  }
  return { frame: String(frame), sources: shownSources, destinations: shownDests, hidden };
}

function sourceGroupId(s) {
  return s.kind === 'input' ? `INPUT_${s.unit}` : `DANTE_${s.unit}`;
}

/* ------------------------------------------------------------------ cells */

/**
 * How a whole source group meets a whole destination group.
 *
 * `count` is how many of the destination's channels take a source from the
 * group; `straight` is true when every one of them does, channel for channel
 * (1→1 … 8→8) — the one-click "Input 3 to Output 1" the Console spells
 * `Set Audio Patch Input 3 Channel 1 Thru 8 To Output 1`.
 */
export function blockState(src, dst) {
  const keys = new Set(src.channels.map((c) => c.key));
  let count = 0;
  let straight = dst.channels.length > 0;
  for (const c of dst.channels) {
    if (keys.has(c.source)) count += 1;
    const want = src.channels.find((s) => s.ch === c.ch);
    if (!want || c.source !== want.key) straight = false;
  }
  return { count, straight };
}

/** How many channels of `dst` take this one source channel. */
export const fedBy = (srcChannel, dst) => dst.channels.filter((c) => c.source === srcChannel.key).length;

/** Whether this destination channel takes any channel of `src`, and which. */
export function takesFrom(dstChannel, src) {
  return src.channels.find((s) => s.key === dstChannel.source) || null;
}

/* ----------------------------------------------------------------- writes */

/** One patch: `source` (a key, or NONE) into one destination channel. */
export const patch = (frame, dest, ch, source) => ({ path: txPath(frame, dest, ch, 'source'), value: source });

/**
 * The writes for a click on a crosspoint: patch it, or — when that point is
 * already what the channel carries — take it back to None.
 */
export function crosspointWrites(frame, dst, dstChannel, srcChannel) {
  const next = dstChannel.source === srcChannel.key ? NONE : srcChannel.key;
  return [patch(frame, dst.id, dstChannel.ch, next)];
}

/**
 * The writes for a click on a whole block: lay the source across the
 * destination channel for channel, or — when that is already exactly what it
 * carries — clear the destination. Only channels that change are written, so
 * a half-patched block sends half a block.
 */
export function blockWrites(frame, src, dst) {
  const { straight } = blockState(src, dst);
  const out = [];
  for (const c of dst.channels) {
    const want = src.channels.find((s) => s.ch === c.ch);
    const next = straight || !want ? NONE : want.key;
    if (c.source !== next) out.push(patch(frame, dst.id, c.ch, next));
  }
  return out;
}

/** Mute or unmute one destination channel. */
export const destMute = (frame, dst, ch, mute) => ({ path: txPath(frame, dst, ch, 'mute'), value: !!mute });

/** Mute or unmute one source channel, into every destination at once. */
export const sourceMute = (frame, key, mute) => ({ path: rxMutePath(frame, key), value: !!mute });
