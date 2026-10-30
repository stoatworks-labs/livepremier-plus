/*
 * Desk control — settings, the patch they make, and how the switcher is
 * addressed. ** PREVIEW **  No I/O.
 *
 * A lighting desk (grandMA3, ChamSys MagicQ, Avolites Titan, anything that
 * sends Art-Net or sACN) drives the switcher the way it drives a media server:
 * fixtures patched on universes, a Screen fixture per screen and a Layer
 * fixture per layer. What the channels mean is `src/core/dmx-personality.js`;
 * the GDTF files a desk imports are `src/core/desk-gdtf.js`; turning frames
 * into AWJ writes is `supervisor.js`. This holds what an operator sets.
 */

import { layout, MODES } from '../../src/core/dmx-personality.js';
import { validUniverse } from '../../src/core/sacn.js';
import { coerce } from '../../src/core/properties.js';

export const PROTOCOLS = Object.freeze([
  { id: 'both', label: 'Art-Net and sACN' },
  { id: 'artnet', label: 'Art-Net only' },
  { id: 'sacn', label: 'sACN only' },
]);

/* A LivePremier has 24 screens and up to 16 layers on one; the patch is never
   wider than the switcher. */
export const MAX_DESTINATIONS = 32;
export const MAX_LAYERS = 16;

/**
 * Off, as every console here starts: it writes to a switcher with nobody at a
 * browser, and nothing of it has met a real desk yet. One screen, four layers
 * and the Master on universe 1 is a patch that fits any desk, onPC included.
 */
export const DEFAULT_DESK = Object.freeze({
  deskEnabled: false,
  deskProtocol: 'both',
  /* '' is the first network interface with an IPv4 address; otherwise one of
     this machine's own addresses. It is where ArtPollReply says the node is
     and where sACN multicast is joined, not what the sockets bind: Art-Net
     arrives by broadcast, which a socket bound to one address never sees. */
  deskInterface: '',
  /* Desks allowed to drive the switcher, by address; empty is any. */
  deskAllow: Object.freeze([]),
  deskFirstUniverse: 1,
  deskDestinations: Object.freeze(['S1']),
  deskLayers: 4,
  deskMaster: true,
  deskMode: 'cue',
  /* The other way: takes on the switcher fire Triggers-plugin triggers
     (`feedback.js`). Its own switch, as it needs no desk patched. */
  deskFeedback: false,
  deskFeedbackRules: Object.freeze([]),
});

export const MAX_FEEDBACK_RULES = 32;
/* A LivePremier's screen bank; a Midra's is 200. */
const MAX_MEMORY = 1000;

/** One rule: a screen ('' any), a memory (null any), a Triggers-plugin trigger id ('' none chosen yet). */
function normaliseRule(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const destination = String(r.destination ?? '').trim().toUpperCase();
  const memory = r.memory === null || r.memory === '' || r.memory === undefined ? null : Number(r.memory);
  return {
    destination: DESTINATION.test(destination) ? destination : '',
    memory: Number.isInteger(memory) && memory >= 1 && memory <= MAX_MEMORY ? memory : null,
    trigger: typeof r.trigger === 'string' ? r.trigger.trim().slice(0, 64) : '',
  };
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const DESTINATION = /^[SA]\d{1,2}$/;

const int = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : d;
};

export function normaliseDesk(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_DESK;
  const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : []);
  const allow = [...new Set(list(input.deskAllow).map((s) => String(s).trim()).filter((s) => IPV4.test(s)))];
  let destinations = [...new Set(list(input.deskDestinations).map((s) => String(s).trim().toUpperCase()).filter((s) => DESTINATION.test(s)))]
    .slice(0, MAX_DESTINATIONS);
  if (!Array.isArray(input.deskDestinations)) destinations = [...d.deskDestinations];
  const first = Number(input.deskFirstUniverse);
  return {
    deskEnabled: input.deskEnabled === true,
    deskProtocol: PROTOCOLS.some((p) => p.id === input.deskProtocol) ? input.deskProtocol : d.deskProtocol,
    deskInterface: typeof input.deskInterface === 'string' && IPV4.test(input.deskInterface.trim()) ? input.deskInterface.trim() : '',
    deskAllow: allow,
    deskFirstUniverse: validUniverse(first) ? first : d.deskFirstUniverse,
    deskDestinations: destinations,
    deskLayers: int(input.deskLayers, 0, MAX_LAYERS, d.deskLayers),
    deskMaster: input.deskMaster !== false,
    deskMode: MODES.some((m) => m.id === input.deskMode) ? input.deskMode : d.deskMode,
    deskFeedback: input.deskFeedback === true,
    deskFeedbackRules: (Array.isArray(input.deskFeedbackRules) ? input.deskFeedbackRules : [])
      .slice(0, MAX_FEEDBACK_RULES).map(normaliseRule),
  };
}

export const deskChanged = (a, b) =>
  a.deskEnabled !== b.deskEnabled
  || a.deskProtocol !== b.deskProtocol
  || a.deskInterface !== b.deskInterface
  || a.deskAllow.join() !== b.deskAllow.join()
  || a.deskFirstUniverse !== b.deskFirstUniverse
  || a.deskDestinations.join() !== b.deskDestinations.join()
  || a.deskLayers !== b.deskLayers
  || a.deskMaster !== b.deskMaster
  || a.deskMode !== b.deskMode
  || a.deskFeedback !== b.deskFeedback
  || JSON.stringify(a.deskFeedbackRules) !== JSON.stringify(b.deskFeedbackRules);

/** The patch these settings make. */
export function patchOf(settings, labelOf) {
  return layout({
    destinations: settings.deskDestinations,
    layers: settings.deskLayers,
    firstUniverse: settings.deskFirstUniverse,
    master: settings.deskMaster,
    mode: settings.deskMode,
    labelOf,
  });
}

/** Whether a packet from `ip` may drive anything. */
export const allowed = (settings, ip) => !settings.deskAllow.length || settings.deskAllow.includes(ip);

/** A layer parameter's catalogue entry (type, range, path under the layer), by its id. */
export function layerSpec(dialect, id) {
  const list = (dialect && dialect.catalogue && dialect.catalogue.layer) || [];
  return (id && list.find((p) => p.id === id)) || null;
}

/**
 * Where a catalogue parameter is under a layer, by its catalogue id —
 * `layerSourcePath` (console-intents.js) for any parameter.
 */
export function layerTail(dialect, id) {
  const found = layerSpec(dialect, id);
  return found ? found.path : null;
}

/* The catalogue ids that differ between LivePremier and Midra/Alta; null is
   a platform without it. Border and shadow are spelt alike on both. */
const LOOK_IDS = {
  nlc: { colour: 'source.color', crop: 'cropping.classic', mask: 'cropping.mask', frames: 'effects.strobe.frames', keying: 'keying' },
  mng: { colour: 'color', crop: 'crop', mask: 'mask', frames: null, keying: null },
};

/**
 * One part of a desk's layer look (`layerLook` in dmx-personality.js) as
 * `[catalogue id, value]` pairs for this platform, before they are fitted to
 * the catalogue's ranges. Source goes its own way (`sourceValue`). Geometry
 * needs the screen's canvas, `{width, height}`: X and Y are from its centre,
 * and on a LivePremier the anchor is written with them so they mean the
 * centre whatever the memory anchored the layer by.
 */
export function lookParams(dialect, param, value, canvas = null) {
  const ids = LOOK_IDS[dialect.id] || LOOK_IDS.nlc;
  const lp = dialect.layerParams || {};
  const sides = (base) => (base ? ['left', 'right', 'top', 'bottom'].map((side) => [`${base}.${side}`, value[side]]) : []);
  const box = (base) => [
    [`${base}.style`, value.style], [`${base}.radius`, value.radius], [`${base}.sizeH`, value.sizeH], [`${base}.sizeV`, value.sizeV],
    [`${base}.opacity`, value.opacity],
    [`${base}.color.red`, value.red], [`${base}.color.green`, value.green], [`${base}.color.blue`, value.blue],
  ];
  switch (param) {
    case 'opacity': return [[lp.opacity, value]];
    case 'colour': return ['red', 'green', 'blue'].map((c) => [`${ids.colour}.${c}`, value[c]]);
    case 'geometry':
      if (!canvas) return [];
      return [
        ...(lp.anchor ? [[lp.anchor, 'MIDDLE_CENTER']] : []),
        [lp.posH, Math.round(canvas.width / 2 + value.x)], [lp.posV, Math.round(canvas.height / 2 + value.y)],
        [lp.sizeH, value.w], [lp.sizeV, value.h],
      ];
    case 'crop': return sides(ids.crop);
    case 'mask': return sides(ids.mask);
    case 'aspect': return [[`${ids.crop}.aspectOverride`, dialect.id === 'mng' && value === 'NONE' ? 'GLOBAL_SETTING' : value]];
    case 'effects': {
      const flags = [value.flipH && 'FLIP_H', value.flipV && 'FLIP_V', value.effect, value.strobe && 'STROBE'].filter(Boolean);
      return [['effects.flags', flags], ...(value.strobe && ids.frames ? [[ids.frames, value.strobe]] : [])];
    }
    case 'border': return box('border.edge');
    case 'shadow': return box('border.shadow');
    case 'key':
      if (!ids.keying) return [];
      return [[`${ids.keying}.enable`, value.enable], ...(value.enable ? [[`${ids.keying}.source`, `SLOT_${value.slot}`]] : [])];
    default: return [];
  }
}

/**
 * A value fitted to its catalogue entry: numbers clamped, a flag set kept to
 * the flags this platform has (a Midra has no strobe or posterise), anything
 * else that does not fit refused with null.
 */
export function fitValue(spec, raw) {
  if (!spec) return null;
  const value = spec.type === 'map' && Array.isArray(raw) && Array.isArray(spec.values)
    ? raw.filter((f) => spec.values.includes(f)) : raw;
  const r = coerce(spec, value);
  return r.ok ? r.value : null;
}
