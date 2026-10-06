/*
 * The Background Slicer: the topology it reads, the cuts it makes, the plan,
 * the writes, and the media-server exports.
 *
 * The pixel tests are the point of the file. A background is shown 1:1 in an
 * output's raster, so a cut that is off by one pixel is a visible seam on a
 * wall — and looks entirely plausible in a thumbnail. So a known pattern is
 * pushed through the plan and `renderRGBA` (the nearest-neighbour reference
 * the browser's `drawImage` is held to) and every pixel of every output is
 * compared with where it must have come from, for a straight span, a cropped
 * placement, an output group with two slices on an offset canvas, and each
 * rotation.
 *
 * The stores: `sim-6.2.73-outputs.json` / `-destinations.json` are the
 * simulator's (outputs 2 and 3 moved and pitched, as test/pitch.test.js
 * explains), `sim-6.2.73-backgrounds.json` was cut from the same simulator's
 * store with nothing edited, and the synthetic ones below are built here to
 * have what no simulator has: slices, groups, rotation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import {
  readScreens, screenTopology, outputBlits, renderRGBA, isExact, presetPlacement, spanLayout, placementFor,
  buildPlan, readSets, readStills, readLibrary, contentWrites, stillWrites, setContentPath, edidChoice,
  edidWrites, plugTemplates, templateRate, chooseStillFormat, formatSize, localToRaster, rasterToLocal,
  liveCandidates, suggestInputs, nativeLayer, imageName, libraryDeleteWrites, setLabelWrite, LABEL_MAX
} from '../plugins/bg-slicer/core.js';
import {
  regionRows, toCsv, toJson, toResolume, outputQuad, templateShapes, templateSvg, packFiles, TARGETS,
  toDisguiseTable, toPixeraFeeds, toHippoCsv, toMilluminSvgs, toTouchDesignerTable, mediaOutputs
} from '../plugins/bg-slicer/exports.js';
import { zipStore, unzipStore, crc32 } from '../plugins/bg-slicer/zip.js';
import { applyPlan, revert } from '../plugins/bg-slicer/apply.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

function merge(a, b) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
  return out;
}

/** The simulator, as several captures of it merged. */
function simStore() {
  const s = new DeviceStore();
  s.hydrate(['sim-6.2.73-identity.json', 'sim-6.2.73-screens.json', 'sim-6.2.73-destinations.json',
    'sim-6.2.73-outputs.json', 'sim-6.2.73-backgrounds.json'].map(fixture).reduce(merge, {}));
  return s;
}

/* ------------------------------------------------------- synthetic stores */

const sliceItem = (left, top, w, h) => ({ pp: { top, left }, aoi: { pp: { top: 0, left: 0, width: w, height: h } } });

/** One output node, in the device's own shape, with what the slicer reads. */
function outputNode({ screen, left = 0, top = 0, w, h, ratio = 1000, rotation = 'NONE', group = '1X1', state = 'USED', slices = null, capability = 'DUAL', format = 'HDTV_1080P', rate = 60000 }) {
  const list = slices || [[0, 0, w, h]];
  const odd = rotation === '90_DEGREE' || rotation === '270_DEGREE';
  const fw = Math.floor(((odd ? h : w) * ratio) / 1000);
  const fh = Math.floor(((odd ? w : h) * ratio) / 1000);
  return {
    mapping: { pp: { device: '1', isValid: true } },
    control: { pp: { label: '' } },
    status: { pp: { format, rate, sizeH: w, sizeV: h } },
    plugList: { itemKeys: ['1'], items: { 1: { status: { pp: { type: 'HDMI' } } } } },
    canvas: {
      cmd: { pp: { pitchRatioH: ratio, pitchRatioV: ratio, rotation } },
      status: {
        pp: { isEnabled: state, usedInScreenAux: screen, group, capability, rotation, left, top, pitchedWidth: fw, pitchedHeight: fh, clampedWidth: fw, clampedHeight: fh, maxWidth: w, maxHeight: h },
        slices: {
          pp: { mode: 'FREE', count: list.length },
          boundingBox: { pp: { left: 0, top: 0, width: w, height: h } },
          sliceList: { itemKeys: ['1', '2', '3', '4'], items: Object.fromEntries([0, 1, 2, 3].map((i) => [String(i + 1), list[i] ? sliceItem(...list[i]) : sliceItem(0, 0, w, h)])) }
        }
      }
    }
  };
}

/** A LivePremier-shaped store: screens with canvases, and outputs on them. */
function syntheticStore(screens, outputs) {
  const s = new DeviceStore();
  const ids = Object.keys(screens);
  s.hydrate({
    device: {
      screenAuxGroupList: { itemKeys: ids, items: Object.fromEntries(ids.map((id) => [id, { control: { pp: { presetUp: 'B', presetDown: 'A' } }, status: { pp: { isUsed: true, transition: 'AT_UP' } } }])) },
      screenList: { itemKeys: ids, items: Object.fromEntries(ids.map((id) => [id, { control: { pp: { label: '' } }, status: { pp: { mode: 'FREESTYLE' }, size: { pp: { sizeH: screens[id][0], sizeV: screens[id][1] } } } }])) },
      outputList: { itemKeys: Object.keys(outputs), items: outputs }
    }
  });
  return s;
}

/* A picture whose every pixel says where it came from. */
function pattern(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x & 255;
      data[i + 1] = y & 255;
      data[i + 2] = ((x >> 8) & 15) | (((y >> 8) & 15) << 4);
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

const at = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

/**
 * Every pixel of `out` against `expect(x, y)` — the picture pixel it must
 * show, or null for the background. Fails on the first difference, naming it.
 */
function checkEvery(out, picture, expect, label) {
  let checked = 0;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const want = expect(x, y);
      const got = at(out, x, y);
      const ref = want ? at(picture, want[0], want[1]) : [0, 0, 0, 255];
      if (got[0] !== ref[0] || got[1] !== ref[1] || got[2] !== ref[2] || got[3] !== ref[3]) {
        assert.fail(`${label}: raster ${x},${y} is ${got} — expected ${want ? `picture ${want[0]},${want[1]}` : 'background'} ${ref}`);
      }
      checked++;
    }
  }
  return checked;
}

/* -------------------------------------------------------------- topology */

test('the simulator’s screens and outputs: S1 has outputs 1-3, each placed where its canvas status says', () => {
  const store = simStore();
  assert.deepEqual(readScreens(store).map((s) => s.id), ['S1']);
  const t = screenTopology(store, 'S1');
  assert.deepEqual(t.outputs.map((o) => o.key), ['1', '2', '3']);
  const [o1, o2, o3] = t.outputs;
  assert.deepEqual(o1.raster, { width: 1920, height: 1080 });
  assert.deepEqual(o1.regions[0].canvas, { x: 0, y: 0, w: 1920, h: 1080 });
  assert.deepEqual(o2.regions[0].canvas, { x: 1920, y: 0, w: 1920, h: 1080 });
  /* Output 3: a 1280 × 720 raster at a pitch of 2.000 covers 2560 × 1440 of canvas. */
  assert.deepEqual(o3.raster, { width: 1280, height: 720 });
  assert.deepEqual(o3.ratio, { h: 2, v: 2 });
  assert.deepEqual(o3.regions[0].canvas, { x: 3840, y: 0, w: 2560, h: 1440 });
  assert.deepEqual(o1.plugs, ['HDMI']);
  assert.equal(o1.format, 'HDTV_1080P');
  assert.equal(o1.rate, 60000);
  assert.equal(o1.slicesRead, true, 'the slices come off the store, not a stand-in');
});

test('an output group is one background at its leader; a member, a clone and an empty raster are skipped and say why', () => {
  const store = syntheticStore({ S1: [3840, 1080] }, {
    1: outputNode({ screen: 'S1', w: 3840, h: 1080, group: '2X1', capability: '4K', slices: [[0, 0, 1920, 1080], [1920, 0, 1920, 1080]] }),
    2: outputNode({ screen: 'S1', w: 1920, h: 1080, state: 'GROUPED' }),
    3: { ...outputNode({ screen: 'S1', w: 1920, h: 1080, state: 'CLONED' }) }
  });
  const t = screenTopology(store, 'S1');
  assert.deepEqual(t.outputs.map((o) => o.key), ['1']);
  assert.deepEqual(t.outputs[0].members, ['1', '2']);
  assert.equal(t.outputs[0].regions.length, 2);
  assert.deepEqual(t.outputs[0].regions.map((r) => r.canvas), [{ x: 0, y: 0, w: 1920, h: 1080 }, { x: 1920, y: 0, w: 1920, h: 1080 }]);
  assert.deepEqual(t.skipped.map((s) => s.key), ['2', '3']);
  assert.match(t.skipped[0].why, /group/);
  assert.match(t.skipped[1].why, /cloned/);
});

test('rasterToLocal undoes localToRaster for every rotation', () => {
  const B = { x: 10, y: 20, w: 300, h: 200 };
  const L = { x: 30, y: 40, w: 50, h: 60 };
  for (const r of [0, 90, 180, 270]) {
    const R = localToRaster(L, B, r);
    const back = rasterToLocal(R, B, r);
    const odd = r % 180 !== 0;
    /* The raster box of a turned local frame is the box turned back. */
    const frame = odd ? { x: B.x, y: B.y, w: B.w, h: B.h } : B;
    assert.ok(R.x >= frame.x && R.y >= frame.y, `rotation ${r} stays inside`);
    assert.deepEqual(back, L, `rotation ${r}`);
  }
});

/* ------------------------------------------------------------ pixel tests */

test('PIXELS: one picture spanning two screens is copied exactly, every pixel of both outputs', () => {
  const store = syntheticStore({ S1: [1920, 1080], S2: [1920, 1080] }, {
    1: outputNode({ screen: 'S1', w: 1920, h: 1080 }),
    2: outputNode({ screen: 'S2', w: 1920, h: 1080 })
  });
  const pic = pattern(3840, 1080);
  const screens = readScreens(store);
  const lay = spanLayout(screens);
  assert.deepEqual(lay.bounds, { x: 0, y: 0, w: 3840, h: 1080 });
  const job = { mode: 'span', span: { offsets: {}, rect: presetPlacement('native', pic, lay.bounds) } };
  for (const [sid, ox] of [['S1', 0], ['S2', 1920]]) {
    const out = screenTopology(store, sid).outputs[0];
    const blits = outputBlits(out, placementFor(job, sid, screens), pic);
    assert.ok(blits.every(isExact), `${sid} is a pixel copy`);
    const img = renderRGBA(blits, pic, 1920, 1080);
    const n = checkEvery(img, pic, (x, y) => [ox + x, y], sid);
    assert.equal(n, 1920 * 1080);
  }
});

test('PIXELS: a picture placed off the corner leaves the background where it does not reach, and the edge pixels are exact', () => {
  const store = syntheticStore({ S1: [1920, 1080] }, { 1: outputNode({ screen: 'S1', w: 1920, h: 1080 }) });
  const pic = pattern(1000, 600);
  const place = { x: 1500, y: 700, w: 1000, h: 600 };
  const out = screenTopology(store, 'S1').outputs[0];
  const blits = outputBlits(out, place, pic);
  assert.deepEqual(blits[0].dst, { x: 1500, y: 700, w: 420, h: 380 });
  assert.deepEqual(blits[0].src, { x: 0, y: 0, w: 420, h: 380 });
  const img = renderRGBA(blits, pic, 1920, 1080);
  checkEvery(img, pic, (x, y) => (x >= 1500 && y >= 700 ? [x - 1500, y - 700] : null), 'corner');
  assert.deepEqual(at(img, 1499, 700), [0, 0, 0, 255], 'one left of the edge is background');
  assert.deepEqual(at(img, 1500, 700), at(pic, 0, 0), 'the edge is the picture’s first pixel');
  assert.deepEqual(at(img, 1919, 1079), at(pic, 419, 379), 'the last pixel');
});

test('PIXELS: an output group of two slices, on an offset canvas, is one raster cut across both', () => {
  const store = syntheticStore({ S1: [4200, 1300] }, {
    1: outputNode({ screen: 'S1', left: 100, top: 50, w: 3840, h: 1080, group: '2X1', slices: [[0, 0, 1920, 1080], [1920, 0, 1920, 1080]] })
  });
  const pic = pattern(4200, 1300);
  const out = screenTopology(store, 'S1').outputs[0];
  const blits = outputBlits(out, { x: 0, y: 0, w: 4200, h: 1300 }, pic);
  assert.equal(blits.length, 2);
  const img = renderRGBA(blits, pic, 3840, 1080);
  checkEvery(img, pic, (x, y) => [100 + x, 50 + y], 'group');
  assert.deepEqual(at(img, 1919, 0), at(pic, 2019, 50), 'the last pixel of slice 1');
  assert.deepEqual(at(img, 1920, 0), at(pic, 2020, 50), 'the first pixel of slice 2 follows it with no seam');
});

test('PIXELS: a rotated output is turned so it reads upright on the turned display, at 90, 180 and 270', () => {
  for (const [rotation, deg] of [['90_DEGREE', 90], ['180_DEGREE', 180], ['270_DEGREE', 270]]) {
    const odd = deg !== 180;
    const canvas = odd ? [1080, 1920] : [1920, 1080];
    const store = syntheticStore({ S1: canvas }, { 1: outputNode({ screen: 'S1', w: 1920, h: 1080, rotation }) });
    const out = screenTopology(store, 'S1').outputs[0];
    assert.deepEqual(out.regions[0].canvas, { x: 0, y: 0, w: canvas[0], h: canvas[1] }, `${deg}: the footprint is turned`);
    const pic = pattern(canvas[0], canvas[1]);
    const blits = outputBlits(out, { x: 0, y: 0, w: canvas[0], h: canvas[1] }, pic);
    assert.ok(blits.every(isExact));
    const img = renderRGBA(blits, pic, 1920, 1080);
    /* Counter-clockwise: at 90 the canvas's left edge is the raster's bottom
       edge, so raster (x, y) shows canvas (1079 − y, x). */
    const expect = {
      90: (x, y) => [1079 - y, x],
      180: (x, y) => [1919 - x, 1079 - y],
      270: (x, y) => [y, 1919 - x]
    }[deg];
    checkEvery(img, pic, expect, `rotation ${deg}`);
  }
});

test('a scaled placement or a pitch ratio is marked resampled, never passed off as a copy', () => {
  const store = syntheticStore({ S1: [1920, 1080] }, { 1: outputNode({ screen: 'S1', w: 1920, h: 1080 }) });
  const out = screenTopology(store, 'S1').outputs[0];
  const fit = presetPlacement('fit', { width: 3840, height: 2160 }, { x: 0, y: 0, w: 1920, h: 1080 });
  assert.deepEqual(fit, { x: 0, y: 0, w: 1920, h: 1080 });
  assert.equal(outputBlits(out, fit, { width: 3840, height: 2160 }).every(isExact), false);
  const sim = screenTopology(simStore(), 'S1').outputs[2];
  assert.equal(outputBlits(sim, { x: 3840, y: 0, w: 2560, h: 1440 }, { width: 2560, height: 1440 }).every(isExact), false);
});

test('placement presets: fit, fill, stretch, 1:1 and centre, in whole pixels', () => {
  const img = { width: 1000, height: 500 };
  const frame = { x: 0, y: 0, w: 1920, h: 1080 };
  assert.deepEqual(presetPlacement('fit', img, frame), { x: 0, y: 60, w: 1920, h: 960 });
  assert.deepEqual(presetPlacement('fill', img, frame), { x: -120, y: 0, w: 2160, h: 1080 });
  assert.deepEqual(presetPlacement('stretch', img, frame), frame);
  assert.deepEqual(presetPlacement('native', img, frame), { x: 0, y: 0, w: 1000, h: 500 });
  assert.deepEqual(presetPlacement('centre', img, frame, { w: 1000, h: 500 }), { x: 460, y: 290, w: 1000, h: 500 });
});

test('a span lays screens side by side in order, and an offset moves one', () => {
  const screens = [{ id: 'S1', canvas: { width: 1920, height: 1080 } }, { id: 'S2', canvas: { width: 1280, height: 720 } }];
  assert.deepEqual(spanLayout(screens).screens.map((p) => [p.id, p.x, p.y]), [['S1', 0, 0], ['S2', 1920, 0]]);
  const moved = spanLayout(screens, { S2: { x: 2000, y: 100 } });
  assert.deepEqual(moved.bounds, { x: 0, y: 0, w: 3280, h: 1080 });
  assert.deepEqual(placementFor({ mode: 'span', span: { offsets: { S2: { x: 2000, y: 100 } }, rect: { x: 0, y: 0, w: 3280, h: 1080 } } }, 'S2'), { x: -2000, y: -100, w: 3280, h: 1080 });
});

/* ------------------------------------------------------------------ plan */

test('the plan takes only free library slots and free stills, the first free set, and writes nothing', () => {
  const store = simStore();
  let sent = 0;
  assert.equal(readLibrary(store).maxKB, 972800);
  assert.deepEqual(readLibrary(store).slots.filter((s) => s.free).map((s) => s.slot), [1, 2, 3, 4, 200]);
  const stills = readStills(store);
  assert.deepEqual(stills.filter((s) => s.free).map((s) => s.key), ['1', '2', '3', '4', '5'], 'still 49 is past the frame and unfitted');
  assert.equal(stills[0].capability, 'DUAL');
  const plan = buildPlan(store, { screens: ['S1'], mode: 'each', place: { S1: { x: 0, y: 0, w: 1920, h: 1080 } }, image: { width: 1920, height: 1080 } });
  assert.equal(plan.ok, true, plan.problems.join('; '));
  const s = plan.screens[0];
  assert.equal(s.setIndex, 1);
  assert.deepEqual(s.outputs.map((o) => [o.key, o.librarySlot, o.still, o.content, o.capacityChange]),
    [['1', 1, '1', 'STILL_1', null], ['2', 2, '2', 'STILL_2', null], ['3', 3, '3', 'STILL_3', null]]);
  assert.equal(s.outputs[0].exact, true);
  assert.equal(s.outputs[1].covered, false, 'output 2 is beside the picture');
  assert.match(plan.warnings.join('\n'), /S1 Out 2: the picture does not reach/);
  assert.equal(sent, 0);
});

test('the plan refuses a set on program unless told, and names a set it would overwrite', () => {
  const store = simStore();
  store.set(['device', 'preconfig', 'backgrounds', 'screenList', 'items', 'S1', 'backgroundSetList', 'items', '2', 'status', 'pp', 'isOnProgram'], true);
  store.set(setContentPath('S1', 2, '1'), 'LIVE_4');
  const job = { screens: ['S1'], mode: 'each', place: { S1: { x: 0, y: 0, w: 1920, h: 1080 } }, image: { width: 1920, height: 1080 }, sets: { S1: 2 } };
  const refused = buildPlan(store, job);
  assert.equal(refused.ok, false);
  assert.match(refused.problems.join('\n'), /on program/);
  const allowed = buildPlan(store, job, { allowProgram: true });
  assert.equal(allowed.ok, true);
  assert.match(allowed.warnings.join('\n'), /replaces LIVE_4/);
  assert.equal(readSets(store, 'S1')[1].onProgram, true);
});

test('a still that has to change capacity gets a format of the output’s own size, or the plan says it cannot', () => {
  const store = simStore();
  const o = { format: 'UHDTV_2160P', raster: { width: 3840, height: 2160 } };
  const validity = readStills(store)[0].formats;
  assert.ok(validity.includes('UHDTV_2160P'));
  assert.equal(chooseStillFormat(validity, { ...o, capability: '4K' }), 'UHDTV_2160P', 'the output’s own format');
  assert.equal(chooseStillFormat(validity, { format: 'COMPUTER_CUSTOM_3', raster: { width: 3840, height: 1080 }, capability: '4K' }), 'COMPUTER_3840_1080');
  /* A 4K-capacity output running 1080p (an Aquilon C's outputs 1-4 report
     exactly that): 1080p would give DUAL, so 4K's own format is asked for
     instead, and the switcher's check says whether it gave 4K. */
  assert.equal(chooseStillFormat(validity, { format: 'HDTV_1080P', raster: { width: 1920, height: 1080 }, capability: '4K' }), 'UHDTV_2160P');
  assert.equal(chooseStillFormat(validity, { format: 'HDTV_1080P', raster: { width: 1920, height: 1080 }, capability: '3' }), null, 'an odd capacity is not guessed');
  assert.equal(chooseStillFormat([], o), null);
  assert.deepEqual(formatSize('COMPUTER_5120_2880_RB'), { width: 5120, height: 2880 });
  assert.equal(formatSize('COMPUTER_SWXGAPB'), null, 'a name whose size is not certain matches nothing');
});

test('the plan picks a free still on the output’s own frame', () => {
  const store = simStore();
  store.set(['device', 'stillList', 'items', '1', 'mapping', 'pp', 'device'], '2');
  const plan = buildPlan(store, { screens: ['S1'], mode: 'each', place: { S1: { x: 0, y: 0, w: 1920, h: 1080 } }, image: { width: 1920, height: 1080 } });
  assert.deepEqual(plan.screens[0].outputs.map((o) => o.still), ['2', '3', '4']);
});

/* ---------------------------------------------------------------- writes */

test('setting a set’s content sends what the Web RCS sends: release the old claim, claim, then the content', () => {
  const store = simStore();
  const claim = (kind, n) => ['device', 'preconfig', 'backgrounds', kind, 'items', n, 'control', 'pp', 'useOnOutput'];
  /* STILL_5 is on output 1 of set 1, and nowhere else. */
  store.set(setContentPath('S1', 1, '1'), 'STILL_5');
  store.set(claim('stillList', '5'), '1');
  const writes = contentWrites(store, 'S1', 1, '1', 'STILL_3');
  assert.deepEqual(writes, [
    { path: claim('stillList', '5'), value: 'NONE' },
    { path: claim('stillList', '3'), value: '1' },
    { path: setContentPath('S1', 1, '1'), value: 'STILL_3' }
  ]);
  /* STILL_5 also on output 2 of S2's set 4: the claim is handed there. */
  store.set(setContentPath('S2', 4, '2'), 'STILL_5');
  assert.deepEqual(contentWrites(store, 'S1', 1, '1', 'LIVE_2')[0], { path: claim('stillList', '5'), value: '2' });
  assert.deepEqual(contentWrites(store, 'S1', 1, '1', 'LIVE_2')[1], { path: claim('inputList', 'IN_2'), value: '1' });
  /* Back to nothing claims nothing. */
  assert.deepEqual(contentWrites(store, 'S1', 1, '2', 'NONE'), [{ path: setContentPath('S1', 1, '2'), value: 'NONE' }]);
});

test('a still is pointed at a library slot the way the image picker does it: mode, then source', () => {
  const w = stillWrites('7', 12, 'A very long background name');
  assert.deepEqual(w.map((x) => [x.path.at(-1), x.value]), [['mode', 'IMAGE'], ['source', 12], ['rescale', 'NO_RESCALE'], ['label', 'A very long back']]);
  assert.equal(setLabelWrite('S1', 3, 'x'.repeat(40)).value.length, LABEL_MAX);
  assert.deepEqual(libraryDeleteWrites(9).map((x) => x.value), [false, true]);
});

/* -------------------------------------------------------- live, and EDIDs */

test('live inputs: fitted inputs are offered, and an output’s EDID is the switcher’s own template for its format', () => {
  const store = simStore();
  const cands = liveCandidates(store);
  assert.deepEqual(cands.map((c) => c.key), ['IN_1', 'IN_2', 'IN_3', 'IN_4']);
  assert.deepEqual(suggestInputs(cands, '1', new Set(['IN_1'])).map((c) => c.key)[0], 'IN_2');
  const templates = plugTemplates(store, 'IN_1');
  assert.equal(templates['1920_1080_60HZ'], true);
  const out = screenTopology(store, 'S1').outputs[0];
  assert.deepEqual(edidChoice(out, templates), { kind: 'template', key: '1920_1080_60HZ', label: '1920×1080 60HZ' });
  assert.equal(edidChoice({ ...out, format: 'COMPUTER_3840_2160_RB', raster: { width: 3840, height: 2160 } }, templates).key, '3840_2160_60HZ_RB');
  assert.deepEqual(edidChoice({ ...out, format: 'COMPUTER_CUSTOM_4' }, templates), { kind: 'custom', key: '4', label: 'custom format M4' });
  assert.match(edidChoice({ ...out, raster: { width: 4096, height: 2160 } }, templates).why, /no EDID template for 4096 × 2160/, 'an invalid template is not offered');
  assert.equal(templateRate(59940), '59HZ94');
  const w = edidWrites('IN_3', { kind: 'template', key: '1920_1080_60HZ' });
  assert.deepEqual(w.map((x) => x.value), [false, true]);
  assert.deepEqual(w[0].path.slice(-6), ['fromTemplate', 'bankList', 'items', '1920_1080_60HZ', 'pp', 'xApply']);
});

test('a live plan maps each output to an input, one input per output', () => {
  const store = simStore();
  const base = { source: 'live', screens: ['S1'], mode: 'each', place: { S1: { x: 0, y: 0, w: 6400, h: 1440 } }, image: { width: 6400, height: 1440 } };
  const plan = buildPlan(store, { ...base, live: { 'S1/1': 'IN_1', 'S1/2': 'IN_2', 'S1/3': 'IN_3' } });
  assert.equal(plan.ok, true, plan.problems.join('; '));
  assert.deepEqual(plan.screens[0].outputs.map((o) => o.content), ['LIVE_1', 'LIVE_2', 'LIVE_3']);
  const twice = buildPlan(store, { ...base, live: { 'S1/1': 'IN_1', 'S1/2': 'IN_1', 'S1/3': 'IN_3' } });
  assert.match(twice.problems.join('\n'), /one input per output/);
});

/* --------------------------------------------------------------- exports */

function livePlan() {
  const store = syntheticStore({ S1: [3840, 1080], S2: [1080, 1920] }, {
    1: outputNode({ screen: 'S1', w: 3840, h: 1080, group: '2X1', slices: [[0, 0, 1920, 1080], [1920, 0, 1920, 1080]] }),
    5: outputNode({ screen: 'S2', w: 1920, h: 1080, rotation: '90_DEGREE' })
  });
  const job = {
    source: 'live', screens: ['S1', 'S2'], mode: 'span',
    span: { offsets: {}, rect: { x: 0, y: 0, w: 4920, h: 1920 } }, image: { width: 4920, height: 1920 },
    live: { 'S1/1': 'IN_5', 'S2/5': 'IN_6' }
  };
  return { store, plan: buildPlan(store, job), content: { width: 4920, height: 1920 } };
}

test('exports: one media output per input, one row per region, in pixels', () => {
  const { plan, content } = livePlan();
  assert.deepEqual(mediaOutputs(plan).map((m) => [m.name, m.width, m.height]), [['IN 5 → S1 Out 1', 3840, 1080], ['IN 6 → S2 Out 5', 1920, 1080]]);
  const rows = regionRows(plan);
  assert.deepEqual(rows.map((r) => [r.mediaOutput, r.content, r.raster, r.rotation]), [
    ['IN 5 → S1 Out 1', { x: 0, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 1920, h: 1080 }, 0],
    ['IN 5 → S1 Out 1', { x: 1920, y: 0, w: 1920, h: 1080 }, { x: 1920, y: 0, w: 1920, h: 1080 }, 0],
    ['IN 6 → S2 Out 5', { x: 3840, y: 0, w: 1080, h: 1920 }, { x: 0, y: 0, w: 1920, h: 1080 }, 90]
  ]);
  const csv = toCsv(plan, content).trim().split('\n');
  assert.equal(csv.length, 4);
  assert.match(csv[0], /^media_output,switcher_input,screen/);
  assert.match(csv[3], /^IN 6 → S2 Out 5,IN_6,S2,,5,1920,1080,HDTV_1080P,60,1,1,90,3840,0,1080,1920,0,0,1920,1080,yes,4920,1920$/);
  const json = JSON.parse(toJson(plan, content));
  assert.equal(json.mediaOutputs.length, 2);
  assert.equal(json.mediaOutputs[0].regions.length, 2);
});

test('the Arena preset: a Screen per media output, a Slice per region, a turned region as a turned quad', () => {
  const { plan, content } = livePlan();
  const xml = toResolume(plan, content, 'Test');
  assert.match(xml, /^<\?xml version="1.0" encoding="utf-8"\?>\n<XmlState name="Test">/);
  assert.equal((xml.match(/<Screen name=/g) || []).length, 2);
  assert.equal((xml.match(/<Slice uniqueId=/g) || []).length, 3);
  assert.match(xml, /<CurrentCompositionTextureSize width="4920" height="1920"\/>/);
  assert.match(xml, /<OutputDeviceVirtual deviceId="VirtualIN 6 → S2 Out 5"/);
  /* The turned region: content's top-left lands at the raster's bottom-left, so the top edge points up. */
  const rot = regionRows(plan)[2];
  const q = outputQuad(rot.blit);
  assert.deepEqual(q, [{ x: 0, y: 1080 }, { x: 0, y: 0 }, { x: 1920, y: 0 }, { x: 1920, y: 1080 }]);
  assert.match(xml, /<OutputRect orientation="-1.570796">/);
  assert.equal((xml.match(/<InputRect/g) || []).length, 3);
});

test('the other servers’ files: disguise, Pixera, Hippotizer, Millumin, TouchDesigner', () => {
  const { plan, content } = livePlan();
  const d = toDisguiseTable(plan, content).trim().split('\n');
  assert.equal(d[0], 'screen name,head,output rect x pos,output rect y pos,output rect width,output rect height,source rect x pos,source rect y pos,source rect width,source rect height,locked,rotation');
  assert.equal(d[3], 'LPP content,2,0,0,1920,1080,3840,0,1080,1920,1,90');
  const p = toPixeraFeeds(plan).split('\r\n');
  assert.equal(p[0].split(',').length, 36);
  assert.equal(p[1].split(',').length, 36);
  assert.equal(toHippoCsv(plan).trim().split('\n')[2], '3840,0,1080,1920,0,False,False,0,0,1920,1080,90,255,255,255');
  const svgs = toMilluminSvgs(plan);
  assert.equal(svgs.length, 2);
  assert.match(svgs[1].data, /<polygon id="S2_Out5_1" fill="[^"]+" points="0.00 1080.00 0.00 0.00 1920.00 0.00 1920.00 1080.00"\/>/);
  const td = toTouchDesignerTable(plan, content).trim().split('\n');
  assert.equal(td[1].split('\t')[13], String(1920 - 0 - 1080), 'content y flipped for a bottom-left origin');
});

test('templates: every region labelled with its size, as SVG; the pack holds every file', () => {
  const { plan, content } = livePlan();
  const shapes = templateShapes(plan, content, 'content');
  assert.equal(shapes.rects.length, 3);
  assert.match(shapes.rects[2].sub, /^1080 × 1920 → IN 6 → S2 Out 5 · turned 90°$/);
  const svg = templateSvg(shapes);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="4920" height="1920"/);
  assert.match(svg, /S1 Out 1 · slice 2/);
  const files = packFiles(plan, content).map((f) => f.name);
  for (const want of ['pixel-map.csv', 'pixel-map.json', 'template-content.svg', 'README.txt', 'resolume/resolume-advanced-output.xml', 'disguise/disguise-feed-table.csv', 'millumin/millumin-IN_6_S2_Out_5.svg']) {
    assert.ok(files.includes(want), `${want} in ${files.join(', ')}`);
  }
  assert.ok(TARGETS.every((t) => t.how && t.kind), 'every target says how');
});

test('the zip writer: stored entries an unzipper reads back, CRC and all', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const bytes = zipStore([{ name: 'a.txt', data: 'hello' }, { name: 'images/b.png', data: new Uint8Array([137, 80, 78, 71]) }]);
  const back = unzipStore(bytes);
  assert.deepEqual(back.map((f) => f.name), ['a.txt', 'images/b.png']);
  assert.equal(new TextDecoder().decode(back[0].data), 'hello');
  assert.deepEqual(Array.from(back[1].data), [137, 80, 78, 71]);
});

test('image names say screen, output and raster, and are file-safe', () => {
  assert.equal(imageName('S1', { key: '3', raster: { width: 1920, height: 1080 } }, 'My Show (final).png'), 'My_Show_final__S1_Out3_1920x1080.png');
});

/* ----------------------------------------------- the apply path, end to end */

/**
 * A stand-in switcher: every write is echoed into the store a tick later, the
 * upload route marks the slot it was given valid, and the staged still
 * preconfig behaves as the simulator's does.
 */
function standIn(store) {
  const log = [];
  const session = {
    store,
    send({ path, value }) {
      log.push([path.join('/'), value]);
      setTimeout(() => {
        store.set(path, value);
        const p = path.join('/');
        if (/library\/bankList\/items\/\d+\/control\/pp\/xDelete$/.test(p) && value === true) {
          store.set([...path.slice(0, -3), 'status', 'pp', 'isValid'], false);
        }
        if (p.endsWith('preconfig/stills/new/control/pp/xCheck') && value === true) {
          store.set(['device', 'preconfig', 'stills', 'new', 'status', 'pp', 'hasChanged'], true);
        }
      }, 1);
      return true;
    }
  };
  const uploads = [];
  const fetchImpl = async (url, init) => {
    const slot = Number(init.body.get('librarySlot'));
    const file = init.body.get('FILES');
    uploads.push([url, slot, file.name]);
    setTimeout(() => store.set(['device', 'stillList', 'library', 'bankList', 'items', String(slot), 'status', 'pp', 'isValid'], true), 2);
    return { ok: true, status: 200, json: async () => ({ [file.name]: 'FINISH' }), text: async () => '' };
  };
  return { session, log, uploads, fetchImpl };
}

test('apply: uploads, stills, the set and its label in order, each confirmed by its echo — and revert takes it all back', async () => {
  const store = simStore();
  const { session, log, uploads, fetchImpl } = standIn(store);
  const plan = buildPlan(store, { screens: ['S1'], mode: 'each', place: { S1: { x: 0, y: 0, w: 6400, h: 1440 } }, image: { width: 6400, height: 1440 } });
  assert.equal(plan.ok, true, plan.problems.join('; '));
  const images = new Map(plan.screens[0].outputs.map((o) => [`S1/${o.key}`, { blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), name: `bg_${o.key}.png` }]));
  const steps = [];
  const result = await applyPlan({ session, plan, images, fetchImpl, options: { label: 'Act 1', loadPreview: true }, onStep: (t, s) => steps.push([s, t]) });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(uploads, [['/api/device/images/upload', 1, 'bg_1.png'], ['/api/device/images/upload', 2, 'bg_2.png'], ['/api/device/images/upload', 3, 'bg_3.png']]);
  assert.equal(store.get(['device', 'stillList', 'items', '1', 'control', 'pp', 'mode']), 'IMAGE');
  assert.equal(store.get(['device', 'stillList', 'items', '2', 'control', 'pp', 'source']), 2);
  assert.equal(store.get(setContentPath('S1', 1, '3')), 'STILL_3');
  assert.equal(store.get(['device', 'preconfig', 'backgrounds', 'stillList', 'items', '3', 'control', 'pp', 'useOnOutput']), '3');
  assert.equal(readSets(store, 'S1')[0].label, 'Act 1');
  /* The still is set before the set names it; the claim before the content. */
  const order = log.map(([p]) => p);
  assert.ok(order.indexOf('device/stillList/items/1/control/pp/mode') < order.indexOf(setContentPath('S1', 1, '1').join('/')));
  assert.ok(order.indexOf('device/preconfig/backgrounds/stillList/items/1/control/pp/useOnOutput') < order.indexOf(setContentPath('S1', 1, '1').join('/')));
  /* The simulator's S1 has no NATIVE layer, so the preview is not touched. */
  assert.equal(nativeLayer(store, 'S1').fitted, false);
  assert.ok(steps.some(([s, t]) => s === 'note' && /NATIVE layer is not allocated/.test(t)));
  assert.equal(result.journal.natives.length, 0);

  const undone = await revert({ session, journal: result.journal });
  assert.equal(undone.ok, true, undone.problems.join('; '));
  assert.equal(store.get(setContentPath('S1', 1, '1')), 'NONE');
  assert.equal(store.get(['device', 'preconfig', 'backgrounds', 'stillList', 'items', '1', 'control', 'pp', 'useOnOutput']), 'NONE');
  assert.equal(store.get(['device', 'stillList', 'items', '1', 'control', 'pp', 'mode']), 'NONE');
  assert.equal(store.get(['device', 'stillList', 'items', '1', 'control', 'pp', 'rescale']), 'SCALE_TO_CAPABILITY', 'the rescale it had');
  assert.equal(store.get(['device', 'stillList', 'items', '2', 'control', 'pp', 'source']), 1, 'the source it had');
  assert.equal(readSets(store, 'S1')[0].label, '');
  assert.deepEqual(readLibrary(store).slots.filter((s) => s.free).map((s) => s.slot), [1, 2, 3, 4, 200]);
});

test('apply refuses a slot or still taken since the plan, and writes nothing', async () => {
  const store = simStore();
  const { session, log, fetchImpl } = standIn(store);
  const plan = buildPlan(store, { screens: ['S1'], mode: 'each', place: { S1: { x: 0, y: 0, w: 1920, h: 1080 } }, image: { width: 1920, height: 1080 } });
  store.set(['device', 'stillList', 'library', 'bankList', 'items', '2', 'status', 'pp', 'isValid'], true);
  const result = await applyPlan({ session, plan, images: new Map(), fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /library slot 2 is no longer free/);
  assert.equal(log.length, 0);
});

test('apply stops at a refused upload and the journal holds only what landed', async () => {
  const store = simStore();
  const { session } = standIn(store);
  let n = 0;
  const fetchImpl = async (url, init) => {
    n++;
    const slot = Number(init.body.get('librarySlot'));
    if (n === 2) return { ok: true, status: 200, json: async () => ({ x: 'ERROR_NO_FREE_SPACE' }), text: async () => '' };
    setTimeout(() => store.set(['device', 'stillList', 'library', 'bankList', 'items', String(slot), 'status', 'pp', 'isValid'], true), 2);
    return { ok: true, status: 200, json: async () => ({ x: 'FINISH' }), text: async () => '' };
  };
  const plan = buildPlan(store, { screens: ['S1'], mode: 'each', place: { S1: { x: 0, y: 0, w: 6400, h: 1440 } }, image: { width: 6400, height: 1440 } });
  const images = new Map(plan.screens[0].outputs.map((o) => [`S1/${o.key}`, { blob: new Blob([new Uint8Array([1])]), name: `b${o.key}.png` }]));
  const result = await applyPlan({ session, plan, images, fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /ERROR_NO_FREE_SPACE/);
  assert.deepEqual(result.journal.uploads, [1]);
  assert.equal(result.journal.stills.length, 1);
  assert.equal(result.journal.sets.length, 0);
});

test('live apply: the EDID templates are loaded, then the set takes the inputs and they claim their outputs', async () => {
  const store = simStore();
  const { session, log } = standIn(store);
  const out = screenTopology(store, 'S1').outputs;
  const job = {
    source: 'live', screens: ['S1'], mode: 'each', place: { S1: { x: 0, y: 0, w: 6400, h: 1440 } }, image: { width: 6400, height: 1440 },
    live: { 'S1/1': 'IN_1', 'S1/2': 'IN_2', 'S1/3': 'IN_3' },
    edid: { 'S1/1': edidChoice(out[0], plugTemplates(store, 'IN_1')) }
  };
  const plan = buildPlan(store, job);
  const result = await applyPlan({ session, plan, options: { edids: true } });
  assert.equal(result.ok, true, result.error);
  assert.equal(log[0][0], 'device/inputList/items/IN_1/plugList/items/1/edid/cmd/fromTemplate/bankList/items/1920_1080_60HZ/pp/xApply');
  assert.deepEqual([log[0][1], log[1][1]], [false, true]);
  assert.equal(store.get(setContentPath('S1', 1, '2')), 'LIVE_2');
  assert.equal(store.get(['device', 'preconfig', 'backgrounds', 'inputList', 'items', 'IN_2', 'control', 'pp', 'useOnOutput']), '2');
});

/*
 * The preset against Arena itself: every element-and-attribute shape a
 * generated preset contains must appear in a file a real Arena 7.27 wrote —
 * output-map's conformance rule (its docs/resolume-export.md), run here on
 * this plugin's own output, rotated and grouped regions included. The
 * reference files live in an output-map checkout; without one, skipped.
 */
test('the Arena preset uses only shapes a real Arena wrote', async (t) => {
  const refs = ['resolume-arena-preset.xml', 'resolume-arena-rotated-ndi.xml']
    .map((f) => join(here, '..', '..', 'output-map', 'src', 'lib', '__tests__', 'fixtures', f));
  let texts;
  try {
    texts = refs.map((f) => readFileSync(f, 'utf8'));
  } catch {
    t.skip('no output-map checkout beside this repo');
    return;
  }
  const VOCAB = new Set(['Params', 'Param', 'ParamChoice', 'ParamRange', 'ValueRange']);
  const shapes = (xml) => {
    const out = new Set();
    const stack = [];
    for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w]*)((?:\s+[\w:]+="[^"]*")*)\s*(\/?)>/g)) {
      const [, close, tag, attrs, self] = m;
      if (close) { stack.pop(); continue; }
      const names = [...attrs.matchAll(/([\w:]+)="([^"]*)"/g)];
      const vocab = VOCAB.has(tag) ? names.find(([, k]) => k === 'name') : null;
      const key = `${stack.join('/')}/${tag}${vocab ? `[name=${vocab[2]}]` : ''}`;
      out.add(`${key} ${names.map(([, k]) => k).filter((k) => !(k === 'name' && !VOCAB.has(tag))).sort().join(',')}`);
      if (!self) stack.push(tag + (vocab ? `[name=${vocab[2]}]` : ''));
    }
    return out;
  };
  const real = new Set(texts.flatMap((x) => [...shapes(x)]));
  const { plan, content } = livePlan();
  const ours = shapes(toResolume(plan, content, 'Shape check'));
  const missing = [...ours].filter((s) => !real.has(s));
  assert.deepEqual(missing, [], 'every shape is one Arena wrote');
  assert.ok(ours.size > 30);
});
