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
 * `takeDownTime` pair; memories live under `preset/bank`, `preset/auxBank` and
 * `preset/masterBank`. So every path in `core/paths.js` and every command
 * mynah compiles is LivePremier-shaped, and offering them on a Midra would
 * send a switcher writes it has no property for.
 *
 * `core/dialect.js` is the other half of this file: it spells both models, so
 * the cue stack and the memory banks are offered on both families, and the
 * table below says which features still only know one. Read off a live
 * Pulse 4K (3.3.10, 2026-09-12) and the Midra 4K simulator (3.2.29).
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

/*
 * The `dev` codes the mng-platform simulators can be told to be, in the order
 * their own binary lists them, with the product each stands for. Display only:
 * the device's `platformLabel` names the range and these name the box. An
 * unlisted code is shown as itself, which is still correct.
 */
const MNG_MODELS = {
  QVU: 'QuickVu 4K',
  PULSE: 'Pulse 4K',
  EIKOS: 'Eikos 4K',
  QMX: 'QuickMatrix 4K',
  ZEN100: 'Zenith 100',
  ZEN200: 'Zenith 200',
  MNG_DEBUG: 'mng debug build'
};

/**
 * What each feature needs to exist in the store before it is worth offering.
 *
 * The probe is the path the feature actually reads or writes, not a proxy for
 * it — so a probe that passes is evidence, and one that fails names the thing
 * that is missing. A feature that speaks both object models lists a probe per
 * family (`core/dialect.js` has the spellings); one that lists only `nlc` is
 * LivePremier-only, and `absent` says why in words for the operator.
 *
 * A `*` segment means "any item of this collection": the pitch panel writes
 * under each output's `canvas/cmd`, and which outputs exist is the device's
 * business.
 */
export const CAPABILITIES = [
  {
    id: 'vpuMap',
    label: 'VPU map',
    probes: { nlc: [ROOT, 'preconfig', 'resources', 'current', 'status', 'mapping'] },
    needs: 'the VPU allocation map',
    /* Midra 4K and Alta 4K are fixed-architecture: there is no pool of mixers
       to allocate, so there is nothing for this panel to draw. That is not a
       gap to fill later — it is the product being a different shape. */
    absent: 'This switcher has no VPU to map — its processing is fixed rather than allocated.'
  },
  {
    id: 'screens',
    label: 'Screens and auxiliaries',
    probes: {
      nlc: [ROOT, 'screenAuxGroupList', 'items'],
      mng: [ROOT, 'transition', 'screenList', 'items']
    },
    needs: 'the screen list',
    absent: 'This platform groups screens differently, so the screen previews cannot be read yet.'
  },
  {
    id: 'cueStack',
    label: 'Cue stack',
    probes: {
      nlc: [ROOT, 'presetBank', 'control'],
      mng: [ROOT, 'preset', 'bank', 'control']
    },
    needs: 'the memory banks',
    absent: 'Preset recall is shaped differently on this platform, so cues cannot be fired yet.'
  },
  {
    id: 'console',
    label: 'Command line',
    probes: { nlc: [ROOT, 'screenAuxGroupList', 'items'] },
    needs: 'LivePremier paths',
    /* Mynah — the grammar, and the OSC address space built on it — compiles
       to LivePremier paths and knows no other spelling. Offering it here
       would send a Midra writes it has no property for, silently. The port
       belongs upstream in mynah, not in a table of exceptions here. */
    absent: 'The command grammar is written against LivePremier paths, which this switcher does not have.'
  },
  {
    id: 'layerProperties',
    label: 'Layer properties',
    probes: { nlc: [ROOT, 'screenAuxGroupList', 'items'] },
    needs: 'a layer catalogue for this platform',
    /* The panel renders `vendor/surface/catalogue.json`, generated from a
       LivePremier bundle: 67 parameters, spelled `layerList/…/inputNum`. A
       Midra layer is `liveLayerList/…/input` with size split from position,
       and its bundle is minified where LivePremier's is not, so the generator
       has to learn it before there is anything to render. */
    absent: 'The layer catalogue was generated from a LivePremier, and this platform spells its layers differently.'
  },
  {
    id: 'pitchCompensation',
    label: 'Pitch compensation',
    probes: { nlc: [ROOT, 'outputList', 'items', '*', 'canvas', 'cmd'] },
    needs: 'the per-output pitch command node',
    /* Midra keeps its ratios under `canvas/pitch` and says which screen an
       output belongs to in the preconfig rather than on the output. Close,
       and not the same; until it is read from there the panel has nothing
       honest to show. */
    absent: 'This platform describes its outputs differently, so pitch compensation cannot be read yet.'
  },
  {
    id: 'audioPatch',
    label: 'Audio patching',
    probes: { nlc: [ROOT, 'audio', 'control', 'deviceList'] },
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
    /* The product behind the code, when the code is one the simulators
       list — `PULSE` is a Pulse 4K. */
    modelName: MNG_MODELS[head.dev] || str(head.dev),
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
    const found = ready && Object.values(cap.probes).some((path) => present(store, path));
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

/** Does the store have this path — with `*` standing for any item key? */
function present(store, path) {
  const star = path.indexOf('*');
  if (star < 0) return store.get(path) !== undefined;
  const head = path.slice(0, star);
  const tail = path.slice(star + 1);
  const items = store.get(head);
  if (!items || typeof items !== 'object') return false;
  return Object.keys(items).some((k) => present(store, [...head, k, ...tail]));
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
