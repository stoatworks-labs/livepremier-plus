/*
 * Pixel Map: an image from the switcher's library over a screen's canvas.
 *
 * Three things are pinned here, each the quiet way to get it wrong:
 *
 * - **What the library offers** — the files, not the stills; only loaded
 *   slots; the original file's address, cache-busted by the switcher's own
 *   hash so a re-upload is not the old picture out of the cache. Read against
 *   a cut of the 6.2.73 simulator's store.
 * - **Where the picture sits** — 1:1 means one map pixel per canvas pixel, as
 *   percentages so the card's zoom carries it, and a map that is not the
 *   canvas's size says so.
 * - **That it is never in the way** — laid between the layers and the
 *   handles in the vendor's stack, `pointer-events: none`, `aria-hidden`, and
 *   a second sweep moves nothing. The stub is the card's anatomy as read off
 *   the running simulator on 2026-10-16; the hashes are deliberately not the
 *   live ones.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import { NLC, dialectFor } from '../src/core/dialect.js';
import { detectPlatform, supports } from '../src/core/platform.js';
import { listDestinations } from '../src/core/screens.js';
import { manifestOf } from '../src/core/plugins.js';
import {
  normalise, normaliseMap, withMap, placement, plan, rolesFor, imageLabel, EMPTY, DEFAULT_MAP
} from '../plugins/pixel-map/core.js';
import { install } from './helpers/fake-dom.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

function merge(a, b) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
  return out;
}

function simStore() {
  const s = new DeviceStore();
  s.hydrate(['sim-6.2.73-identity.json', 'sim-6.2.73-screens.json', 'sim-6.2.73-destinations.json',
    'sim-6.2.73-image-library.json'].map(fixture).reduce(merge, {}));
  return s;
}

/* ------------------------------------------------------------- library */

test('the library offers its loaded files, with the original’s address cache-busted by the switcher’s hash', () => {
  const store = simStore();
  assert.equal(dialectFor(store), NLC);
  const images = NLC.libraryImages(store);
  assert.deepEqual(images.map((i) => i.slot), [1], 'slot 2 is empty and is not offered');
  const [one] = images;
  assert.equal(one.fileName, 'pixelmap-1920x1080.png');
  assert.equal(one.width, 1920);
  assert.equal(one.height, 1080);
  assert.equal(one.file, '/api/device/images/download/1?v=e24de612-ef32-4e84-95b6-6c625f15d307');
  assert.equal(one.thumb, '/api/device/snapshots/images_library/1?v=e24de612-ef32-4e84-95b6-6c625f15d307');
});

test('the picture is never fetched from a snapshot path the thumbnail relay would rewrite', () => {
  /* plugins/snapshot-relay/hot.js bumps every `<img>` under /api/device/snapshots/
     inside a screen card. The overlay draws the download, which it leaves alone. */
  const [one] = NLC.libraryImages(simStore());
  assert.ok(!one.file.includes('/api/device/snapshots/'));
});

test('the capability is LivePremier’s, and the plugin asks for it', () => {
  const store = simStore();
  assert.equal(supports(detectPlatform(store), 'imageLibrary'), true);
  const bare = new DeviceStore();
  bare.hydrate(fixture('midra-3.2.29-platform.json'));
  assert.equal(supports(detectPlatform(bare), 'imageLibrary'), false, 'the Midra page draws its cards differently');
  assert.deepEqual(manifestOf('pixel-map').requires.capabilities, ['screens', 'imageLibrary']);
  assert.equal(manifestOf('pixel-map').enabledByDefault, true, 'inert until an image is picked');
});

/* ------------------------------------------------------------ document */

test('a stored document is corrected rather than refused', () => {
  assert.deepEqual(normalise(null), EMPTY);
  const d = normalise({
    visible: 'yes', buffers: 'sideways',
    maps: {
      S1: { slot: '3', mode: 'nonsense', opacity: 7, fit: 'pixels' },
      S2: { slot: 0 },
      A1: { slot: 4, mode: 'lines', opacity: -1, fit: 'stretch' },
      'S1/2': { slot: 1 },
      L3: { slot: 1 }
    }
  });
  assert.equal(d.visible, true, 'only an explicit false hides the maps');
  assert.equal(d.buffers, 'preview');
  assert.deepEqual(Object.keys(d.maps), ['S1', 'A1'], 'no image is no entry; only destinations');
  assert.deepEqual(d.maps.S1, { slot: 3, mode: 'mask', opacity: 1, fit: 'pixels' });
  assert.deepEqual(d.maps.A1, { slot: 4, mode: 'lines', opacity: 0, fit: 'stretch' });
  assert.deepEqual(normaliseMap({}), DEFAULT_MAP);
});

test('one destination is changed at a time, and choosing no image removes it', () => {
  let d = withMap(null, 'S1', { slot: 2 });
  assert.deepEqual(d.maps.S1, { ...DEFAULT_MAP, slot: 2 });
  d = withMap(d, 'S2', { slot: 5, mode: 'over' });
  d = withMap(d, 'S1', { opacity: 0.356 });
  assert.equal(d.maps.S1.opacity, 0.36);
  assert.equal(d.maps.S2.mode, 'over');
  d = withMap(d, 'S1', { slot: null });
  assert.deepEqual(Object.keys(d.maps), ['S2']);
});

test('PRW by default; both means both', () => {
  assert.deepEqual(rolesFor('preview'), ['PRW']);
  assert.deepEqual(rolesFor('program'), ['PGM']);
  assert.deepEqual(rolesFor('both'), ['PGM', 'PRW']);
  assert.deepEqual(rolesFor(undefined), ['PRW']);
});

/* ------------------------------------------------------------ placement */

test('1:1 is one map pixel per canvas pixel, in percentages of the canvas', () => {
  const canvas = { width: 1920, height: 1080 };
  assert.deepEqual(placement({ width: 1920, height: 1080 }, canvas, 'pixels'), { left: 0, top: 0, width: 100, height: 100 });
  assert.deepEqual(placement({ width: 960, height: 540 }, canvas, 'pixels'), { left: 0, top: 0, width: 50, height: 50 });
  assert.deepEqual(placement({ width: 3840, height: 1080 }, canvas, 'pixels'), { left: 0, top: 0, width: 200, height: 100 });
  assert.deepEqual(placement({ width: 1000, height: 300 }, { width: 3000, height: 900 }, 'pixels'),
    { left: 0, top: 0, width: 33.3333, height: 33.3333 });
  assert.deepEqual(placement({ width: 960, height: 540 }, canvas, 'stretch'), { left: 0, top: 0, width: 100, height: 100 });
  assert.deepEqual(placement({ width: 0, height: 0 }, canvas, 'pixels'), { left: 0, top: 0, width: 100, height: 100 },
    'no size to place by: stretched, never guessed');
});

test('the plan draws what is loaded, says what is not, and names a map the wrong size', () => {
  const store = simStore();
  const dests = listDestinations(store);
  const images = NLC.libraryImages(store);
  const s1 = dests.find((d) => d.id === 'S1');
  assert.ok(s1, 'S1 is in service on the simulator');

  const p = plan({ maps: { S1: { slot: 1, mode: 'mask' }, A9: { slot: 1 } } }, dests, images);
  const one = p.get('S1');
  assert.equal(one.image.slot, 1);
  assert.equal(one.blend, 'multiply');
  assert.equal(one.opacity, DEFAULT_MAP.opacity);
  if (s1.canvas.width === 1920 && s1.canvas.height === 1080) assert.deepEqual(one.notes, []);
  assert.equal(p.has('A9'), false, 'a destination not in service is not planned');

  const gone = plan({ maps: { S1: { slot: 2 } } }, [s1], images);
  assert.deepEqual(gone.get('S1'), { missing: 2, map: normaliseMap({ slot: 2 }) }, 'an emptied slot is reported, not drawn');

  const odd = plan({ maps: { S1: { slot: 1, mode: 'lines', fit: 'pixels' } } },
    [{ id: 'S1', canvas: { width: 3840, height: 1080 } }], images).get('S1');
  assert.equal(odd.blend, 'screen');
  assert.deepEqual(odd.place, { left: 0, top: 0, width: 50, height: 100 });
  assert.match(odd.notes[0], /1920×1080; S1’s canvas is 3840×1080\. Drawn 1:1/);

  assert.equal(imageLabel(images[0]), '1 · pixelmap-1920x1080.png · 1920×1080');
});

/* -------------------------------------------------------------- overlay */

/** One screen card as Web RCS 6.2.73 draws it, PGM above PRW. */
function card(doc, id, { selected = false, shape = 'stack' } = {}) {
  const el = (tag, cls, ...kids) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    for (const k of kids) n.append(k);
    return n;
  };
  const buffer = (role) => {
    const layers = el('div', '', el('div', 'aw-absolute', el('div', 'canvas-item-module__c___Xx1 aw-relative')));
    const stack = shape === 'stack'
      ? el('div', 'aw-full-width-height aw-absolute', layers, ...(selected ? [el('div', '', el('div', 'aw-absolute aw-cursor-ns-resize'))] : []))
      : el('div', 'aw-full-width-height', layers);
    const raster = el('div', 'aw-absolute aw-background-black', el('div', 'aw-relative aw-full-width-height', stack));
    raster.setAttribute('style', 'left: 24px; top: 70px; width: 203px; height: 114px;');
    const zoom = el('div', 'react-transform-component transform-component-module_content__Zz9',
      el('div', 'aw-full-width-height', el('div', 'aw-relative aw-full-width-height',
        raster, el('div', 'aw-absolute aw-pointer-none aw-full-width-height'))));
    const label = el('button', 'ui button');
    label.textContent = role;
    return el('div', 'aw-flex-row screen-overview-container__c__preset___Qq7',
      el('div', 'live-content-header__c___Hh2', label),
      el('div', 'preset-overview-container__c__canvas___Cc3', el('div', 'react-transform-wrapper', zoom)));
  };
  const h2 = el('h2');
  h2.textContent = id;
  return el('div', 'aw-preset-view', h2, buffer('PGM'), buffer('PRW'));
}

async function overlayRig(build) {
  const dom = install();
  const { installPixelMaps, MARK } = await import('../plugins/pixel-map/overlay.js');
  build(dom.doc);
  const images = NLC.libraryImages(simStore());
  let doc = { maps: { S1: { slot: 1 } } };
  let roles = ['PRW'];
  const overlay = installPixelMaps({
    plan: () => plan(doc, [{ id: 'S1', canvas: { width: 1920, height: 1080 } }, { id: 'S2', canvas: { width: 1920, height: 1080 } }], images),
    roles: () => roles,
    doc: dom.doc
  });
  return {
    dom, overlay, MARK,
    set: (d) => { doc = d; }, setRoles: (r) => { roles = r; },
    done: () => { overlay.stop(); dom.uninstall(); }
  };
}

test('the map goes between the layers and the handles, and takes no pointer', async () => {
  const rig = await overlayRig((doc) => doc.body.append(card(doc, 'S1', { selected: true })));
  try {
    rig.overlay.sweepNow();
    const boxes = rig.dom.doc.querySelectorAll(`[${rig.MARK}]`);
    assert.equal(boxes.length, 1, 'PRW only by default');
    const [box] = boxes;
    assert.equal(box.getAttribute(rig.MARK), 'S1/PRW');
    const stack = box.parentElement;
    assert.ok(stack.classList.contains('aw-absolute'));
    assert.equal(stack.children.indexOf(box), 1, 'after the layers, before the handles');
    assert.equal(box.style.pointerEvents, 'none');
    assert.equal(box.firstElementChild.style.pointerEvents, 'none');
    assert.equal(box.getAttribute('aria-hidden'), 'true');
    assert.equal(box.firstElementChild.getAttribute('draggable'), 'false');
    assert.equal(box.style.mixBlendMode, 'multiply');
    assert.equal(box.firstElementChild.getAttribute('src'), '/api/device/images/download/1?v=e24de612-ef32-4e84-95b6-6c625f15d307');
    assert.equal(box.firstElementChild.style.width, '100%');
    assert.deepEqual(rig.overlay.describe(), { cards: 1, blocks: 2, rasters: 2, drawn: 1, between: 1, top: 0, notDrawn: [] });

    /* A second sweep, with nothing changed, moves and rebuilds nothing. */
    rig.overlay.sweepNow();
    const again = rig.dom.doc.querySelectorAll(`[${rig.MARK}]`);
    assert.equal(again.length, 1);
    assert.equal(again[0], box);
    assert.equal(box.parentElement.children.indexOf(box), 1);
  } finally {
    rig.done();
  }
});

test('handles mounted after the map land over it; a map pushed out of place is put back', async () => {
  const rig = await overlayRig((doc) => doc.body.append(card(doc, 'S1')));
  try {
    rig.overlay.sweepNow();
    const box = rig.dom.doc.querySelector(`[${rig.MARK}]`);
    const stack = box.parentElement;
    /* React appends the handles group when a layer is selected. */
    const handles = rig.dom.doc.createElement('div');
    stack.append(handles);
    assert.deepEqual(stack.children.map((c) => (c === box ? 'map' : c === handles ? 'handles' : 'layers')), ['layers', 'map', 'handles']);
    /* A re-render that inserts the layers group again ahead of everything. */
    const layers = stack.children[0];
    stack.insertBefore(box, layers);
    rig.overlay.sweepNow();
    assert.deepEqual(stack.children.map((c) => (c === box ? 'map' : c === handles ? 'handles' : 'layers')), ['layers', 'map', 'handles']);
  } finally {
    rig.done();
  }
});

test('a stack shaped otherwise gets the map on top, and says so', async () => {
  const rig = await overlayRig((doc) => doc.body.append(card(doc, 'S1', { shape: 'other' })));
  try {
    rig.overlay.sweepNow();
    const box = rig.dom.doc.querySelector(`[${rig.MARK}]`);
    assert.ok(box.parentElement.classList.contains('aw-background-black'), 'appended to the raster');
    assert.equal(box.parentElement.children[box.parentElement.children.length - 1], box);
    assert.equal(rig.overlay.describe().top, 1);
  } finally {
    rig.done();
  }
});

test('buffers, cards and maps that come and go are followed', async () => {
  const rig = await overlayRig((doc) => doc.body.append(card(doc, 'S1'), card(doc, 'S2')));
  try {
    rig.setRoles(['PGM', 'PRW']);
    rig.overlay.sweepNow();
    assert.deepEqual(rig.dom.doc.querySelectorAll(`[${rig.MARK}]`).map((b) => b.getAttribute(rig.MARK)), ['S1/PGM', 'S1/PRW']);

    rig.set({ maps: { S1: { slot: 1 }, S2: { slot: 1, mode: 'over', opacity: 0.4, fit: 'stretch' } } });
    rig.setRoles(['PGM']);
    rig.overlay.sweepNow();
    const keys = rig.dom.doc.querySelectorAll(`[${rig.MARK}]`).map((b) => b.getAttribute(rig.MARK));
    assert.deepEqual(keys, ['S1/PGM', 'S2/PGM'], 'PRW maps taken away');
    const s2 = rig.dom.doc.querySelector(`[${rig.MARK}="S2/PGM"]`);
    assert.equal(s2.style.mixBlendMode, 'normal');
    assert.equal(s2.style.opacity, '0.4');

    rig.set({ maps: { S2: { slot: 9 } } });
    rig.overlay.sweepNow();
    assert.equal(rig.dom.doc.querySelectorAll(`[${rig.MARK}]`).length, 0, 'an empty slot draws nothing');

    rig.set({ maps: { S1: { slot: 1 }, S3: { slot: 1 } } });
    rig.overlay.sweepNow();
    assert.deepEqual(rig.overlay.describe().notDrawn, [], 'S3 is not in service, so it is not in the plan at all');
  } finally {
    rig.done();
  }
});

test('stop() takes every map back out of the vendor’s page', async () => {
  const rig = await overlayRig((doc) => doc.body.append(card(doc, 'S1')));
  rig.overlay.sweepNow();
  assert.equal(rig.dom.doc.querySelectorAll(`[${rig.MARK}]`).length, 1);
  rig.overlay.stop();
  assert.equal(rig.dom.doc.querySelectorAll(`[${rig.MARK}]`).length, 0);
  rig.dom.uninstall();
});
