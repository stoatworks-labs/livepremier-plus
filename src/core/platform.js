/*
 * Which Analog Way platform is on the other end, and what it can actually do.
 *
 * ## There are two platforms, not one
 *
 * Read off the three simulators' own bundles (`webapp-bundle/bundle.json`) and
 * confirmed against their running stores on 2026-08-22:
 *
 *   LivePremier (Aquilon)   nlc-platform   6.2.1    firmware 6.2.73
 *   Midra 4K                mng-platform   3.2.6    firmware 3.2.29
 *   Alta 4K                 mng-platform   1.3.1    firmware 1.3.7
 *
 * **Midra 4K and Alta 4K are the same platform as each other**, on different
 * version lines, and a different platform from LivePremier. All three serve the
 * same Web RCS architecture — a React app with hashed class names, a store over
 * `GET /api/stores/device`, a socket, and AWJ on TCP 10606 — so the proxy, the
 * hook and the panel-mounting machinery carry over untouched.
 *
 * **The object model does not carry over.** `screenAuxGroupList`, `presetBank`,
 * `masterPresetBank` and `vpuMixerList` do not exist on `mng-platform` at all.
 * Screens are `1`..`4`, not `S1`..`S24`. Transitions live in a top-level
 * `transition` node with one `takeTime` instead of the `takeUpTime` /
 * `takeDownTime` pair. So every path in `core/paths.js` and every command mynah
 * compiles is LivePremier-shaped, and offering them on a Midra would send a
 * switcher writes it has no property for.
 *
 * ## Identity lives somewhere different on each
 *
 * This is the part that has to be got right before anything else can be:
 *
 * - **`mng-platform`** puts it at `device/system/pp` —
 *   `{ dev: 'PULSE', platformId: 1536, platformLabel: 'Midra 4K' }`. There is
 *   **no `deviceList`**, because these are single-frame products.
 * - **`nlc-platform`** leaves `device/system/pp` as `{ ready: true }` and puts
 *   identity in `device/system/deviceList/items/<1-4>/pp` —
 *   `{ dev: 'NLC_CMAX', platformId: 1280, label: 'AQUILON' }` — because a
 *   LivePremier can be up to four linked frames.
 *
 * So the presence of `platformLabel` is the discriminator, and it is a far
 * better one than a list of model codes: it is the vendor naming its own
 * platform, in a field that exists precisely to be read.
 *
 * ## Capabilities are probed, not tabulated
 *
 * A feature is offered when **the part of the store it writes to is there**.
 * Not when the model is on an allowlist — an allowlist is a promise about
 * hardware nobody here has, and it goes stale the first time Analog Way ships
 * a range this file has never met. Probing answers the only question that
 * matters, which is whether this box has the thing.
 *
 * It also degrades the right way: an unknown platform that happens to expose
 * `screenAuxGroupList` gets the cue stack, and one that does not, does not.
 */

import { ROOT } from './paths.js';
import { readIdentity } from './identity.js';

/** The two code families, named as their own bundles name them. */
export const FAMILY = { NLC: 'nlc-platform', MNG: 'mng-platform' };

/*
 * Platform ids seen on a running device. Used only to name a platform we have
 * actually met; anything else falls back to `platformLabel`, which the device
 * supplies anyway. Nothing is gated on these numbers.
 */
const PLATFORM_IDS = {
  1280: { id: 'livepremier', name: 'LivePremier', family: FAMILY.NLC },
  1536: { id: 'midra4k', name: 'Midra 4K', family: FAMILY.MNG },
  1552: { id: 'alta4k', name: 'Alta 4K', family: FAMILY.MNG }
};

/**
 * What each feature needs to exist in the store before it is worth offering.
 *
 * The probe is the path the feature actually reads or writes, not a proxy for
 * it — so a probe that passes is evidence, and one that fails names the thing
 * that is missing.
 */
export const CAPABILITIES = [
  {
    id: 'vpuMap',
    label: 'VPU map',
    probe: [ROOT, 'preconfig', 'resources', 'current', 'status', 'mapping'],
    needs: 'the VPU allocation map',
    /* Midra 4K and Alta 4K are fixed-architecture: there is no pool of mixers
       to allocate, so there is nothing for this panel to draw. That is not a
       gap to fill later — it is the product being a different shape. */
    absent: 'This switcher has no VPU to map — its processing is fixed rather than allocated.'
  },
  {
    id: 'screens',
    label: 'Screens and auxiliaries',
    probe: [ROOT, 'screenAuxGroupList', 'items'],
    needs: 'screenAuxGroupList',
    absent: 'This platform groups screens differently, so the screen previews cannot be read yet.'
  },
  {
    id: 'cueStack',
    label: 'Cue stack',
    probe: [ROOT, 'presetBank', 'control'],
    needs: 'presetBank',
    absent: 'Preset recall is shaped differently on this platform, so cues cannot be fired yet.'
  },
  {
    id: 'console',
    label: 'Command line',
    probe: [ROOT, 'screenAuxGroupList', 'items'],
    needs: 'screenAuxGroupList',
    absent: 'The command grammar is written against LivePremier paths, which this switcher does not have.'
  },
  {
    id: 'pitchCompensation',
    label: 'Pitch compensation',
    probe: [ROOT, 'outputList', 'items'],
    needs: 'outputList',
    /* The per-output canvas node carrying pitchRatioH/V is nlc-platform's.
       Midra 4K and Alta 4K describe their outputs differently, so the panel
       would have nothing to read the rasters or the current ratios from. */
    absent: 'This platform describes its outputs differently, so pitch compensation cannot be read yet.'
  },
  {
    id: 'audioPatch',
    label: 'Audio patching',
    probe: [ROOT, 'audio', 'control', 'deviceList'],
    needs: 'the audio matrix',
    absent: 'This platform lays its audio matrix out differently.'
  }
];

/**
 * Identify the switcher and work out what it supports.
 *
 * @param {{get: Function, ready?: boolean}} store
 */
export function detectPlatform(store) {
  const ready = !!(store && store.ready);
  const system = store && store.get ? store.get([ROOT, 'system']) : null;
  const head = (system && system.pp) || {};

  let base;
  if (typeof head.platformLabel === 'string' && head.platformLabel !== '') {
    base = mng(head, system);
  } else if (system && system.deviceList) {
    base = nlc(store);
  } else {
    base = {
      id: 'unknown',
      name: ready ? 'Unrecognised switcher' : 'Not connected',
      family: null,
      model: null,
      platformId: null,
      firmware: null,
      serial: null,
      simulated: false,
      frames: []
    };
  }

  return { ...base, ready, capabilities: probe(store, ready) };
}

/** Midra 4K, Alta 4K and anything else that names its own platform. */
function mng(head, system) {
  const known = PLATFORM_IDS[head.platformId];
  const version = (system.version && system.version.pp) || {};
  const serial = (system.serial && system.serial.pp) || {};
  return {
    /* The device's own words win for the name; the table only supplies a
       stable id for code to switch on, and only for platforms we have met. */
    id: known ? known.id : 'mng-' + (head.platformId ?? 'unknown'),
    name: head.platformLabel,
    family: known ? known.family : FAMILY.MNG,
    model: str(head.dev),
    platformId: num(head.platformId),
    firmware: str(version.updater),
    serial: str(serial.serialNumber),
    /* These simulators do not flag themselves the way a LivePremier does. */
    simulated: head.isSimulated === true,
    frames: []
  };
}

/** LivePremier, where identity is per-frame in a list of up to four. */
function nlc(store) {
  const identity = readIdentity(store);
  const primary = identity.primary;
  const known = primary && PLATFORM_IDS[primary.platformId];
  return {
    id: known ? known.id : 'livepremier',
    /* `label` here is the range — AQUILON — which is the useful name. */
    name: (primary && primary.family) || 'LivePremier',
    family: FAMILY.NLC,
    model: primary ? primary.model : null,
    platformId: primary ? primary.platformId : null,
    firmware: primary ? primary.firmware : null,
    serial: primary ? primary.serial : null,
    simulated: !!(primary && primary.simulated),
    chassis: primary ? primary.chassis : null,
    frames: identity.linked
  };
}

/**
 * Ask the store whether each feature's own paths are there.
 *
 * Until the store is hydrated nothing is claimed either way: `supported` is
 * null rather than false, because "we have not looked yet" and "this switcher
 * cannot" must not render as the same thing.
 */
function probe(store, ready) {
  const out = {};
  for (const cap of CAPABILITIES) {
    const found = ready && store.get(cap.probe) !== undefined;
    out[cap.id] = {
      id: cap.id,
      label: cap.label,
      supported: ready ? found : null,
      needs: cap.needs,
      absent: cap.absent
    };
  }
  return out;
}

/**
 * Is this feature safe to offer?
 *
 * Unknown counts as yes. The store arrives a moment after the panels mount,
 * and hiding everything for that moment — or worse, leaving it hidden because
 * a device never answered — is a worse failure than showing a panel that turns
 * out to have nothing in it.
 */
export function supports(platform, capabilityId) {
  const cap = platform && platform.capabilities && platform.capabilities[capabilityId];
  return !cap || cap.supported !== false;
}

/** Why a feature is not on offer, in words for a person. */
export function whyNot(platform, capabilityId) {
  const cap = platform && platform.capabilities && platform.capabilities[capabilityId];
  if (!cap || cap.supported !== false) return null;
  return cap.absent || `This switcher does not expose ${cap.needs}.`;
}

const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
const num = (v) => (typeof v === 'number' ? v : null);
