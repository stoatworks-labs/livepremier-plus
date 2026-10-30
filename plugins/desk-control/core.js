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
});

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
  || a.deskMode !== b.deskMode;

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

/**
 * Where a catalogue parameter is under a layer, by its catalogue id —
 * `layerSourcePath` (console-intents.js) for any parameter.
 */
export function layerTail(dialect, id) {
  const list = (dialect && dialect.catalogue && dialect.catalogue.layer) || [];
  const found = list.find((p) => p.id === id);
  return found ? found.path : null;
}
