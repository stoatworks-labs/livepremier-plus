/*
 * Store paths, AWJ paths, and the layer address.
 *
 * The device is one JSON object addressed through two spellings of the same
 * tree. The Web RCS WebSocket carries the store spelling; the AWJ socket on TCP
 * 10606 carries its own. They map mechanically:
 *
 *   store  ["device","screenList","items","S1","presetList","items","A",
 *           "layerList","items","1","opacity","pp","opacity"]
 *   AWJ    DeviceObject/$screen/@items/S1/$preset/@items/A/$layer/@items/1/opacity/@props/opacity
 *
 * Everything internal speaks the store spelling, because it is an array and so
 * needs no escaping or splitting, and converts at the wire.
 */

export const ROOT = 'device';

/*
 * `xList` -> `$x` covers every collection seen on firmware 6.2. The `List`
 * suffix is a store spelling only: AWJ answers E12 for `$timerList` and serves
 * `$timer`. Kept as an explicit map rather than a bare rule so that a
 * collection which breaks the pattern on a later firmware has somewhere to go.
 */
const AWJ_COLLECTIONS = {
  screenList: '$screen',
  auxiliaryList: '$auxiliary',
  screenAuxGroupList: '$screenAuxGroup',
  presetList: '$preset',
  layerList: '$layer',
  inputList: '$input',
  outputList: '$output',
  stillList: '$still',
  timerList: '$timer',
  deviceList: '$device',
  monitoringList: '$monitoring'
};

/** Convert a store path array to the AWJ path string for the same node. */
export function toAwj(path) {
  const out = [];
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (i === 0 && seg === ROOT) out.push('DeviceObject');
    else if (seg === 'pp') out.push('@props');
    else if (seg === 'items') out.push('@items');
    else if (seg.endsWith('List')) out.push(AWJ_COLLECTIONS[seg] || `$${seg.slice(0, -4)}`);
    else out.push(seg);
  }
  return out.join('/');
}

const AWJ_TO_STORE = Object.fromEntries(
  Object.entries(AWJ_COLLECTIONS).map(([store, awj]) => [awj, store])
);

/** Convert an AWJ path string back to a store path array. */
export function fromAwj(str) {
  return str.split('/').map((seg, i) => {
    if (i === 0 && seg === 'DeviceObject') return ROOT;
    if (seg === '@props') return 'pp';
    if (seg === '@items') return 'items';
    if (seg.startsWith('$')) return AWJ_TO_STORE[seg] || `${seg.slice(1)}List`;
    return seg;
  });
}

/** A stable string key for a path, for use in maps and sets. */
export const key = (path) => path.join('/');

export const samePath = (a, b) =>
  a.length === b.length && a.every((seg, i) => seg === b[i]);

/** True when `prefix` is a leading sub-path of `path`. */
export const startsWith = (path, prefix) =>
  prefix.length <= path.length && prefix.every((seg, i) => seg === path[i]);

/* ------------------------------------------------------------- addressing */

/**
 * Path to a property inside one layer of one screen preset.
 *
 * `preset` is a literal preset key — 'A', 'B' or 'C'. Callers that want to
 * address PREVIEW or PROGRAM must resolve through `preset.js` first: which
 * letter is on air is device state, not a constant.
 */
export const layerParam = (screen, preset, layer, tail) => [
  ROOT, 'screenList', 'items', screen,
  'presetList', 'items', preset,
  'layerList', 'items', String(layer),
  ...tail
];

/** Path to a property of a screen's take/transition group. */
export const screenGroupParam = (screen, tail) => [
  ROOT, 'screenAuxGroupList', 'items', screen, ...tail
];

/** Path to the auxiliary equivalent of `layerParam`. */
export const auxLayerParam = (aux, preset, layer, tail) => [
  ROOT, 'auxiliaryList', 'items', aux,
  'presetList', 'items', preset,
  'layerList', 'items', String(layer),
  ...tail
];
