/*
 * Store paths, and their relationship to AWJ paths.
 *
 * The Web RCS front-end and the AWJ protocol address the same device object
 * model through two different spellings of the same tree:
 *
 *   AWJ    DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake
 *   store  ["device","screenAuxGroupList","items","S1","control","pp","xTake"]
 *
 * The extension speaks store paths, because that is what the socket carries.
 * The AWJ spelling is kept here so the same core can drive a direct AWJ
 * transport later without a second path table.
 */

/** Root segment of every store path. */
export const ROOT = 'device';

/** Collections whose AWJ name is not simply the store name minus "List". */
const AWJ_COLLECTION_OVERRIDES = {
  deviceList: '$device',
  screenAuxGroupList: '$screenAuxGroup',
  presetModeList: '$preset',
  slotList: '$slot',
  presetList: '$preset'
};

/** Turn a store path array into the AWJ path string for the same node. */
export function toAwj(path) {
  const out = [];
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (i === 0 && seg === ROOT) { out.push('DeviceObject'); continue; }
    if (seg === 'pp') { out.push('@props'); continue; }
    if (seg === 'items') { out.push('@items'); continue; }
    if (seg.endsWith('List')) {
      out.push(AWJ_COLLECTION_OVERRIDES[seg] || '$' + seg.slice(0, -4));
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** Compare two store paths for equality. */
export const samePath = (a, b) =>
  a.length === b.length && a.every((seg, i) => seg === b[i]);

/** True when `prefix` is a leading sub-path of `path`. */
export const startsWith = (path, prefix) =>
  prefix.length <= path.length && prefix.every((seg, i) => seg === path[i]);

/** Join for logging and for use as a Map key. Never sent on the wire. */
export const key = (path) => path.join('/');

/* ------------------------------------------------------------------ *
 * Named paths.
 *
 * Every one of these was read out of a live device store rather than
 * transcribed from the protocol guide, because the guide is a firmware behind:
 * $screenGroup in the v4.0 document no longer exists.
 * ------------------------------------------------------------------ */

/** Screens are S1..S24, auxiliaries A1..A96; both live in screenAuxGroupList. */
export const screenAuxControl = (id, prop) =>
  [ROOT, 'screenAuxGroupList', 'items', id, 'control', 'pp', prop];

export const screenAuxStatus = (id, prop) =>
  [ROOT, 'screenAuxGroupList', 'items', id, 'status', 'pp', prop];

/**
 * Screen preset recall. `mode` is PROGRAM or PREVIEW — loading to PREVIEW and
 * then taking is the two-step the cue stack relies on for a previewable GO.
 */
export const screenPresetRecall = (slot, screenId, mode) => [
  ROOT, 'presetBank', 'control', 'load', 'slotList', 'items', String(slot),
  screenId.startsWith('A') ? 'auxiliaryList' : 'screenList', 'items', screenId,
  'presetList', 'items', mode, 'pp', 'xRequest'
];

export const masterPresetRecall = (slot, mode) => [
  ROOT, 'masterPresetBank', 'control', 'load', 'slotList', 'items', String(slot),
  'presetList', 'items', mode, 'pp', 'xRequest'
];

export const presetBankSlot = (slot, prop) =>
  [ROOT, 'presetBank', 'bankList', 'items', String(slot), 'status', 'pp', prop];

export const masterPresetBankSlot = (slot, prop) =>
  [ROOT, 'masterPresetBank', 'bankList', 'items', String(slot), 'status', 'pp', prop];

export const screenStatus = (screenId, prop) =>
  [ROOT, 'screenList', 'items', screenId, 'status', 'pp', prop];

export const deviceProp = (deviceKey, prop) =>
  [ROOT, 'system', 'deviceList', 'items', String(deviceKey), 'pp', prop];

/** Where both firmware generations put the VPU allocation map. */
export const resourceMapping = (which /* 'current' | 'new' */) =>
  [ROOT, 'preconfig', 'resources', which, 'status', 'mapping'];

/* ------------------------------------------------------------------ *
 * Commands.
 *
 * Every device command is a property write; there is no verb channel. The
 * x-prefixed properties are edge triggers — the device acts on the write and
 * reports nothing back, so the caller must watch status to learn the outcome.
 * ------------------------------------------------------------------ */

export const CMD = {
  take: (id) => ({ path: screenAuxControl(id, 'xTake'), value: true }),
  cut: (id) => ({ path: screenAuxControl(id, 'xCut'), value: true }),
  stepBack: (id) => ({ path: screenAuxControl(id, 'xStepBack'), value: true }),
  takeUp: (id) => ({ path: screenAuxControl(id, 'xTakeUp'), value: true }),
  takeDown: (id) => ({ path: screenAuxControl(id, 'xTakeDown'), value: true }),
  abort: (id) => ({ path: screenAuxControl(id, 'xTakeAbort'), value: true }),
  copyProgramToPreview: (id) =>
    ({ path: screenAuxControl(id, 'xCopyProgramToPreview'), value: true }),

  /* Transition durations are in tenths of a second on the wire. */
  takeUpTime: (id, tenths) =>
    ({ path: screenAuxControl(id, 'takeUpTime'), value: tenths }),
  takeDownTime: (id, tenths) =>
    ({ path: screenAuxControl(id, 'takeDownTime'), value: tenths }),

  recallScreenPreset: (slot, screenId, mode = 'PREVIEW') =>
    ({ path: screenPresetRecall(slot, screenId, mode), value: true }),
  recallMasterPreset: (slot, mode = 'PREVIEW') =>
    ({ path: masterPresetRecall(slot, mode), value: true })
};
