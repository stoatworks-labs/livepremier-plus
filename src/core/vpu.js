/*
 * The VPU allocation map, normalised.
 *
 * A VPU is the Aquilon's physical mixing/scaling resource. The device hands
 * them out to (screen, layer) pairs, and a wide canvas consumes several per
 * layer. Every property here is read-only on the device: this is reported
 * allocation, not a set of knobs. The value of drawing it is that it is the
 * budget which decides whether a configuration fits.
 *
 * Two firmware generations spell the same map differently, and both are in
 * the field:
 *
 *   'mixer'   vpuMixerList / PROC_n_MIXER_m, 64 per device, two out-pipes,
 *             a `slice` index, and an A/B scaler pair carrying fill and cut
 *             memory assignments.
 *   'scaler'  vpuLayerList / PROC_n_SCALER_m, 32 per device, eight out-pipes,
 *             no slice index.
 *
 * Rather than pick one, this module reads whichever is present and produces a
 * single shape. `slice` is null on firmwares that do not report it, and the
 * UI has to treat that as "not reported" rather than as slice zero.
 */

import { ROOT, resourceMapping } from './paths.js';

/* Collection names to try, most recent spelling first. */
const UNIT_COLLECTIONS = [
  { name: 'vpuMixerList', variant: 'mixer', alloc: 'mixerAllocation', pipes: 2 },
  { name: 'vpuLayerList', variant: 'scaler', alloc: 'scalerAllocation', pipes: 8 }
];

/** Which of the two models this store reports, or null if neither is present. */
export function detectVariant(store, which = 'current') {
  const base = store.get(resourceMapping(which));
  const devices = base && base.deviceList && base.deviceList.items;
  if (!devices) return null;
  const first = devices[Object.keys(devices)[0]];
  if (!first) return null;
  for (const c of UNIT_COLLECTIONS) if (first[c.name]) return c;
  return null;
}

const PIPE_NONE = 'NONE';

function readUnit(id, node, collection) {
  const pp = (node && node.pp) || {};
  const alloc = ((node && node[collection.alloc]) || {}).pp || {};

  const pipes = [];
  for (let i = 1; i <= collection.pipes; i++) {
    const v = alloc['usedOnOutPipe' + i];
    if (v !== undefined && v !== PIPE_NONE) pipes.push({ index: i, output: v });
  }

  /* Scaler memories exist only on the mixer model, and even there the device
     rejects the read on some firmwares — absent is normal, not an error. */
  const scalers = {};
  const list = node && node.scalerList && node.scalerList.items;
  if (list) {
    for (const [sk, sv] of Object.entries(list)) {
      const spp = (sv && sv.pp) || {};
      scalers[sk] = { fill: spp.memoryFill ?? null, cut: spp.memoryCut ?? null };
    }
  }

  const m = /^PROC_(\d+)_(?:MIXER|SCALER)_(\d+)$/.exec(id);
  return {
    id,
    proc: m ? Number(m[1]) : null,
    index: m ? Number(m[2]) : null,
    available: pp.isAvailable === true,
    enabled: pp.isEnabled === true,
    capability: pp.capability ?? null,
    seamless: pp.seamlessCapa ?? null,
    screen: pp.usedInScreen ?? null,
    layer: pp.usedInLayer ?? null,
    slice: pp.slice ?? null,
    channel: pp.channel ?? null,
    pipes,
    scalers
  };
}

/**
 * Read the whole map for one side of the preconfig.
 *
 * `which` is 'current' (running) or 'new' (staged). The device keeps both, and
 * a configuration is applied by promoting one to the other — so the difference
 * between them is the answer to "what is this change about to cost me".
 */
export function readMap(store, which = 'current') {
  const collection = detectVariant(store, which);
  if (!collection) return null;

  const base = store.get(resourceMapping(which));
  const deviceItems = base.deviceList.items;
  const deviceKeys = base.deviceList.itemKeys || Object.keys(deviceItems);

  const devices = [];
  for (const dk of deviceKeys) {
    const dnode = deviceItems[dk];
    if (!dnode) continue;
    const unitItems = (dnode[collection.name] || {}).items || {};
    const unitKeys = (dnode[collection.name] || {}).itemKeys || Object.keys(unitItems);
    const units = unitKeys.map((uk) => readUnit(uk, unitItems[uk], collection));

    const pipeItems = (dnode.pipeList || {}).items || {};
    const pipes = Object.entries(pipeItems).map(([pk, pv]) => ({
      id: pk,
      used: !!((pv && pv.pp) || {}).isUsed
    }));

    devices.push({
      key: dk,
      role: dk === '1' ? 'Master' : 'Follower ' + dk,
      fitted: units.some((u) => u.available),
      units,
      pipes
    });
  }

  return { variant: collection.variant, which, devices, ...summarise(devices) };
}

function summarise(devices) {
  let total = 0, available = 0, enabled = 0;
  const byScreen = new Map();
  for (const d of devices) {
    for (const u of d.units) {
      total++;
      if (u.available) available++;
      /* An unavailable unit still carries stale screen/layer values, so only
         enabled ones are counted as an allocation. */
      if (!u.available || !u.enabled) continue;
      enabled++;
      const sk = u.screen ?? '—';
      if (!byScreen.has(sk)) byScreen.set(sk, new Map());
      const layers = byScreen.get(sk);
      const lk = u.layer ?? '—';
      if (!layers.has(lk)) layers.set(lk, []);
      layers.get(lk).push({ device: d.key, ...u });
    }
  }
  return {
    totals: { total, available, enabled, spare: available - enabled },
    byScreen
  };
}

/**
 * What changes between the running configuration and the staged one.
 *
 * Returns per-unit deltas keyed by "device/unit". Only fields that actually
 * differ are listed, so an unchanged map produces an empty array — which is
 * the normal reading when nothing is staged.
 */
export function diffMaps(current, next) {
  if (!current || !next) return [];
  const index = (map) => {
    const out = new Map();
    for (const d of map.devices) for (const u of d.units) out.set(d.key + '/' + u.id, u);
    return out;
  };
  const a = index(current), b = index(next);
  const fields = ['available', 'enabled', 'capability', 'screen', 'layer', 'slice', 'channel'];
  const changes = [];
  for (const [k, before] of a) {
    const after = b.get(k);
    if (!after) { changes.push({ key: k, gone: true, before }); continue; }
    const changed = fields.filter((f) => before[f] !== after[f]);
    if (changed.length) changes.push({ key: k, before, after, fields: changed });
  }
  for (const [k, after] of b) if (!a.has(k)) changes.push({ key: k, added: true, after });
  return changes;
}

/**
 * Emit one device's units in the flat record shape the standalone
 * `aquilon-vpu-map` tool reads, so a map captured here can be opened there
 * and vice versa. Deliberately an adapter rather than a shared import: that
 * tool reaches the device over AWJ, which a browser extension cannot do, and
 * a vendored copy of its model would drift the moment either side moved.
 */
export function toMixerRecords(map, deviceKey = '1') {
  const device = map && map.devices.find((d) => d.key === String(deviceKey));
  if (!device) return {};
  const out = {};
  for (const u of device.units) {
    if (!u.available) { out[u.id] = { isAvailable: false }; continue; }
    const rec = {
      isAvailable: true,
      isEnabled: u.enabled,
      usedInScreen: u.screen,
      usedInLayer: u.layer,
      channel: u.channel,
      slice: u.slice,
      capability: u.capability,
      seamlessCapa: u.seamless,
      mixerAllocation: {
        usedOnOutPipe1: pipeAt(u, 1),
        usedOnOutPipe2: pipeAt(u, 2)
      }
    };
    if (Object.keys(u.scalers).length) {
      rec.scalers = Object.fromEntries(Object.entries(u.scalers).map(
        ([k, v]) => [k, { memoryFill: v.fill, memoryCut: v.cut }]));
    }
    out[u.id] = rec;
  }
  return out;
}

const pipeAt = (unit, index) => {
  const found = unit.pipes.find((p) => p.index === index);
  return found ? found.output : PIPE_NONE;
};

/** Human label for a (screen, layer) allocation group. */
export const layerLabel = (layer) =>
  layer === 'NATIVE' ? 'Background' : layer == null ? '—' : 'Layer ' + layer;

export { ROOT };
