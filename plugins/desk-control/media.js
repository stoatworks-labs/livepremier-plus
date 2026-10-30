/*
 * Desk control — the switcher as a media server, for CITP. ** PREVIEW **
 * No I/O.
 *
 * What `citp.js` tells a desk, worked out from the patch, the switcher's
 * facts and the sources last read off its layers:
 *
 * - **Libraries are the Layer fixture's source folders**, in the same order,
 *   and each library's DMX range is its Folder value. Within a numbered
 *   library, element e is File value e + 1. So the picture a desk shows for
 *   an element is what its number selects, with nothing to translate.
 *   MSEX 1.2 wants elements numbered from 0 without gaps, so a library runs
 *   up to the highest number in use and a number not in use is listed by
 *   name as such.
 * - **Layers are the patched Layer fixtures.** Each one's DMX source string
 *   says where it is patched (`ArtNet/<net>/<universe>/<channel>`, or sACN's
 *   `BSRE1.31/<universe>/<channel>`), and from MSEX 1.2 carries the Layer
 *   GDTF's fixture type id as its personality. That is how a desk that patches
 *   from CITP knows which fixture each layer is.
 * - **Layer status is what each layer has in program**, as library, element
 *   and name — the "layer assignments" a desk shows beside its fixtures.
 * - **Video sources are the live inputs**, each one's snapshot at about a
 *   frame a second. The switcher has no snapshot of a screen.
 */

import { FOLDERS, FIXTURES } from '../../src/core/dmx-personality.js';
import { portAddressOfUniverse } from '../../src/core/dmx-input.js';
import { LAYER_PLAYING } from '../../src/core/citp.js';
import { crc32 } from '../../src/core/zip.js';

/* The folders a desk can pick from, by switcher source kind. */
const LIBRARY_FOLDERS = FOLDERS.filter((f) => f.kind);
const SHORT = { LIVE: 'IN', STILL: 'IMG', SCREEN: 'S', NATIVE: 'BG' };
const UNNUMBERED = { COLOR: 'Colour', NONE: 'Black' };

/* A switcher's thumbnails are 256×144 on an Aquilon C and 512×288 on a Pulse 4K; until one is read, the smaller. */
export const DEFAULT_PICTURE = Object.freeze({ width: 256, height: 144 });

const hash = (s) => crc32(new TextEncoder().encode(s));

/** The facts' sources of one kind, as `{number, label}`. */
function listed(facts, kind) {
  return ((facts && facts.sources && facts.sources[kind]) || [])
    .filter((s) => Number.isInteger(s.number) && s.number >= 1 && s.number <= 255);
}

/**
 * The libraries, in Folder order: `{index, kind, name, dmx, serial, elements}`,
 * each element `{index, dmx, name, source}`.
 */
export function libraries(facts) {
  return LIBRARY_FOLDERS.map((folder, index) => {
    let elements;
    if (!folder.numbered) {
      elements = [{ index: 0, dmx: [0, 255], name: UNNUMBERED[folder.kind] || folder.name, source: folder.kind }];
    } else {
      const known = new Map(listed(facts, folder.kind).map((s) => [s.number, s.label]));
      const top = known.size ? Math.max(...known.keys()) : 0;
      elements = Array.from({ length: top }, (_, e) => {
        const n = e + 1;
        const short = `${SHORT[folder.kind]}${n}`;
        /* readFacts names an unlabelled still STILL_n; that is no name. */
        const label = known.get(n);
        const named = label && label !== short && label !== `${folder.kind}_${n}`;
        const name = !known.has(n) ? `${short} (not in use)` : named ? `${short} ${label}` : short;
        return { index: e, dmx: [n, n], name, source: `${folder.kind}_${n}` };
      });
    }
    /* Change detection (MSEX 1.2's SerialNumber): the same contents, the same number, across restarts. */
    elements = elements.map((e) => ({ ...e, serial: hash(e.name) }));
    const serial = hash(JSON.stringify(elements.map((e) => e.name)));
    return { index, kind: folder.kind, name: folder.name, dmx: [folder.value, folder.value], serial, elements };
  });
}

/** Where a source string from the switcher sits: `{library, element, name}`, or null. */
export function placeOf(libs, source) {
  const s = String(source ?? '');
  const m = /^(LIVE|STILL|SCREEN|NATIVE|INPUT)_(\d+)$/.exec(s);
  /* A Midra's live inputs are INPUT_n. */
  const kind = m ? (m[1] === 'INPUT' ? 'LIVE' : m[1]) : s;
  const lib = libs.find((l) => l.kind === kind);
  if (!lib) return null;
  if (!m) return { library: lib.index, element: 0, name: lib.elements[0].name };
  const n = Number(m[2]);
  const known = lib.elements[n - 1];
  return { library: lib.index, element: Math.min(n - 1, 255), name: known ? known.name : `${SHORT[kind]}${n}` };
}

/** One fixture's DMX source string, as CITP's SDMX layer spells them. */
export function dmxSource(fixture, protocol = 'both') {
  if (protocol === 'sacn') return `BSRE1.31/${fixture.universe}/${fixture.address}`;
  const pa = portAddressOfUniverse(fixture.universe);
  return `ArtNet/${pa >> 8}/${pa & 0xff}/${fixture.address}`;
}

/** The MSEX 1.2 personality suffix: the fixture's GDTF type id. */
export const personality = (fixture) => `/PersonalityID/{${FIXTURES[fixture.kind].guid}}`;

/**
 * Everything the CITP face says, as of now.
 *
 * @param {object} o
 * @param {object[]} o.fixtures     the patch
 * @param {object|null} o.facts     the switcher's last `readFacts()`
 * @param {Map<string, string|null>} o.sources  Layer fixture id → its program source, as last read
 * @param {'both'|'artnet'|'sacn'} o.protocol
 * @param {Map<number, {width: number, height: number}>} [o.sizes]  live input → its snapshot's size, once seen
 */
export function mediaModel({ fixtures, facts, sources, protocol, sizes = new Map() }) {
  const libs = libraries(facts);
  const layers = fixtures.filter((f) => f.kind === 'layer');
  const outputs = [...new Set(layers.map((f) => f.destination))];
  const status = layers.map((f, i) => {
    const source = sources.get(f.id);
    const at = source ? placeOf(libs, source) : null;
    const none = libs.find((l) => l.kind === 'NONE');
    return {
      layer: i,
      output: Math.min(outputs.indexOf(f.destination), 255),
      library: at ? at.library : none.index,
      element: at ? at.element : 0,
      name: at ? at.name : '',
      flags: at && source !== 'NONE' ? LAYER_PLAYING : 0,
    };
  });
  const live = libs.find((l) => l.kind === 'LIVE');
  const video = live.elements.filter((e) => !e.name.endsWith('(not in use)')).map((e) => {
    const n = e.index + 1;
    return { id: n, name: e.name, ...(sizes.get(n) || DEFAULT_PICTURE) };
  });
  return {
    layers: layers.map((f) => dmxSource(f, protocol) + personality(f)),
    libraries: libs,
    status,
    video,
  };
}

/**
 * The source an element selects, as `{kind, number}` (`sourceValue` in
 * dmx-personality.js spells it for the platform), or null.
 */
export function elementSource(lib, element) {
  if (!lib || !lib.elements[element]) return null;
  const folder = FOLDERS.find((f) => f.kind === lib.kind);
  return { kind: lib.kind, number: folder && folder.numbered ? element + 1 : null };
}

/* A plain card for an element with no snapshot, by library. Dark, so a desk's
   white text stays readable on it. */
export const SWATCHES = Object.freeze({
  LIVE: [28, 44, 74], STILL: [30, 64, 44], SCREEN: [60, 36, 74], NATIVE: [24, 60, 64], COLOR: [200, 200, 200], NONE: [0, 0, 0],
});
