/*
 * The device store, adapted into the shared VPU model.
 *
 * The model itself lives in `../vendor/vpu-model.js` — a copy of the one
 * aquilon-vpu-map runs, deliberately identical so the two tools cannot reach
 * different conclusions about the same box. This file is the only part that
 * differs between them: that tool assembles mixer records from a few hundred
 * AWJ reads, and this one lifts them straight out of the device store the Web
 * RCS page already has.
 *
 * Store spelling of the AWJ paths the model was built against:
 *
 *   preconfig/resources/{current|new}/status/mapping
 *     /deviceList/items/<1-4>/vpuMixerList/items/PROC_<1-4>_MIXER_<1-16>
 *       /pp/<prop>
 *       /mixerAllocation/pp/usedOnOutPipe<1-8>
 *       /scalerList/items/{A,B}/pp/{memoryFill,memoryCut}
 *   preconfig/resources/{current|new}/screenList/items/S<n>/status/pp/<prop>
 *
 * The screen status is free here. The standalone tool spends 24 round trips on
 * it; the store already holds it, which is the one real advantage of living
 * inside the vendor page.
 */

import { ROOT, resourceMapping } from './paths.js';
import {
  MIXER_IDS, MIXER_PROPS, SCALERS, OUT_PIPES, parseMixerId,
  summarise, buildLinkGrid, optimizedVpus, diff,
  LINKS_PER_VPU, SCALING_ENGINE_BOUNDARY, LAYER_CAPABILITIES, capacityToLinks
} from '../vendor/vpu-model.js';

export {
  MIXER_IDS, MIXER_PROPS, SCALERS, OUT_PIPES, parseMixerId,
  summarise, buildLinkGrid, optimizedVpus, diff,
  LINKS_PER_VPU, SCALING_ENGINE_BOUNDARY, LAYER_CAPABILITIES, capacityToLinks
};

/** Where a device's mixer collection sits under the resource mapping. */
const mixerCollection = (which, deviceKey) =>
  [...resourceMapping(which), 'deviceList', 'items', String(deviceKey), 'vpuMixerList'];

const screenResources = (which) =>
  [ROOT, 'preconfig', 'resources', which, 'screenList'];

/**
 * Which devices the mapping covers. 1 is the master, 2-4 are Link followers.
 */
export function deviceKeys(store, which = 'current') {
  const base = [...resourceMapping(which), 'deviceList'];
  return store.itemKeys(base);
}

/**
 * Mixer records for one device, in the shape the model expects.
 *
 * A mixer that is not fitted is reduced to `{isAvailable: false}` — the same
 * thing the AWJ reader does, and it matters: an absent mixer still reports
 * stale screen and layer values that would otherwise read as an allocation.
 */
export function readMixers(store, { which = 'current', device = '1' } = {}) {
  const base = mixerCollection(which, device);
  const items = store.get([...base, 'items']);
  if (!items) return null;

  const out = {};
  for (const id of MIXER_IDS) {
    const node = items[id];
    if (!node) continue;
    const pp = node.pp || {};
    if (pp.isAvailable !== true) { out[id] = { isAvailable: false }; continue; }

    const rec = { isAvailable: true };
    for (const p of MIXER_PROPS) rec[p] = pp[p];

    const alloc = (node.mixerAllocation || {}).pp || {};
    rec.mixerAllocation = {};
    for (let k = 1; k <= OUT_PIPES; k++) {
      rec.mixerAllocation[`usedOnOutPipe${k}`] = alloc[`usedOnOutPipe${k}`];
    }

    const scalers = (node.scalerList || {}).items;
    if (scalers) {
      rec.scalers = {};
      for (const s of SCALERS) {
        const spp = ((scalers[s] || {}).pp) || {};
        rec.scalers[s] = { memoryFill: spp.memoryFill, memoryCut: spp.memoryCut };
      }
    }
    out[id] = rec;
  }
  return out;
}

/**
 * Per-screen resource status: how much of the box each screen spends, whether
 * it fits, and whether its VPU is in Optimized mode.
 *
 * Screens that are not configured report `mode: 'DISABLED'` and are dropped,
 * matching the standalone reader so both feed `optimizedVpus` the same thing.
 * Only the staged side carries the `remaining…` / `exceeding…` figures — they
 * answer "would this configuration fit", which is a question about `new`.
 */
export function readScreenStatus(store, { which = 'current' } = {}) {
  const base = screenResources(which);
  const keys = store.itemKeys(base);
  const out = {};
  for (const id of keys) {
    const pp = store.get([...base, 'items', id, 'status', 'pp']);
    if (!pp || pp.mode === undefined || pp.mode === 'DISABLED') continue;
    out[id] = { ...pp };
  }
  return out;
}

/**
 * Is there a VPU mapping to draw at all, and if not, why not.
 *
 * Worth distinguishing carefully. A simulator carries a `vpuLayerList`
 * collection that is present and permanently empty, and no `vpuMixerList` —
 * `$vpuLayer` answers E12 on real hardware, so that collection is an artefact
 * of the simulator rather than a second firmware generation. Reporting it as
 * "no VPU support" or drawing it as an empty chassis would both be misleading.
 */
export function inspectMapping(store, which = 'current') {
  const mapping = store.get(resourceMapping(which));
  if (!mapping || !mapping.deviceList) return { present: false, reason: 'no-mapping' };

  const keys = deviceKeys(store, which);
  const withMixers = keys.filter((k) => store.get([...mixerCollection(which, k), 'items']));
  if (!withMixers.length) {
    const first = (mapping.deviceList.items || {})[keys[0]] || {};
    if (first.vpuLayerList) return { present: false, reason: 'simulator', devices: keys };
    return { present: false, reason: 'no-mixer-collection', devices: keys };
  }

  const fitted = withMixers.some((k) => {
    const items = store.get([...mixerCollection(which, k), 'items']) || {};
    return Object.values(items).some((n) => n && n.pp && n.pp.isAvailable === true);
  });
  return { present: true, devices: withMixers, fitted };
}

/**
 * Everything the panel needs for one side of the preconfig, per device.
 *
 * Returns null when there is no mapping, so callers can tell "nothing to draw"
 * from "an empty chassis" — see `inspectMapping` for the difference.
 */
export function readSide(store, which = 'current') {
  const info = inspectMapping(store, which);
  if (!info.present) return null;
  const screenStatus = readScreenStatus(store, { which });
  const devices = info.devices.map((key) => {
    const mixers = readMixers(store, { which, device: key });
    // Optimized mode decides whether a layer's bar may cross the centre line, so
    // the grid has to know it before it lays anything out (§5.5.6) — work it out
    // first and hand it in, rather than only using it to style the boundary.
    const optimized = optimizedVpus(mixers, screenStatus);
    return {
      key,
      role: key === '1' ? 'Master' : 'Follower ' + key,
      mixers,
      summary: summarise(mixers),
      grids: buildLinkGrid(mixers, optimized),
      optimized
    };
  });
  return { which, devices, screenStatus, fitted: info.fitted };
}

/**
 * What a staged preconfig would change, per device.
 *
 * The model's `diff` compares output links as well as properties — a staged
 * configuration can move a layer onto different links with every other value
 * identical, and comparing properties alone calls that no change.
 */
export function diffSides(store) {
  const current = inspectMapping(store, 'current');
  const staged = inspectMapping(store, 'new');
  if (!current.present || !staged.present) return [];
  return current.devices.map((key) => ({
    device: key,
    changes: diff(
      readMixers(store, { which: 'current', device: key }),
      readMixers(store, { which: 'new', device: key })
    )
  })).filter((d) => d.changes.length);
}

/**
 * How a layer slot is written in the UI.
 *
 * `NATIVE` is the first entry of the device's PRECONFIG_SCREEN_LAYER enum — a
 * layer slot that consumes mixers and is counted by `layerCount`. It is **not**
 * the screen's background: backgrounds live in `preconfig/backgrounds/`, cost
 * no mixer at all, and calling this one a background is the confusion to avoid.
 */
export const layerLabel = (layer) =>
  layer === 'NATIVE' ? 'Native layer' : layer == null ? '—' : 'Layer ' + layer;

export const layerShort = (layer) => (layer === 'NATIVE' ? 'NAT' : 'L' + layer);
