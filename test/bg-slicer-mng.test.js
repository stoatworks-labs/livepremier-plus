/*
 * The Background Slicer on a Midra 4K / Alta 4K: the model it reads, the cut,
 * the plan and its refusals, the write lists, and the apply path end to end
 * against a stand-in switcher.
 *
 * `midra-3.2.29-backgrounds.json` was cut from the Midra 4K simulator 3.2.29
 * (Pulse 4K) with nothing edited: S1 on output 1 (1920 × 1080), S2 on output
 * 2 (a 1024 × 640 area of interest of a 1920 × 1080 raster, so a 1024 × 640
 * canvas), every library slot empty — and S1's Background Image 1 pointing at
 * empty slot 1, which is the case the plan has to refuse.
 *
 * As in test/bg-slicer.test.js the pixel tests are the point: a pattern whose
 * every pixel encodes its coordinates goes through the plan and `renderRGBA`
 * and every pixel of every canvas image is compared with where it must have
 * come from — and then each output's crop of that image, done the way the
 * switcher's Auto Crop is drawn, is compared with the picture too.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import { detectPlatform, supports } from '../src/core/platform.js';
import { renderRGBA, isExact, presetPlacement, spanLayout } from '../plugins/bg-slicer/core.js';
import * as mng from '../plugins/bg-slicer/mng.js';
import { modelFor } from '../plugins/bg-slicer/model.js';
import { applyPlan, revert } from '../plugins/bg-slicer/apply.js';
import { describePath } from '../plugins/bg-slicer/apply-mng.js';
import { regionRows, mediaOutputs, toCsv } from '../plugins/bg-slicer/exports.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const D = ['device'];
const S = (n, ...tail) => [...D, 'screenList', 'items', String(n), ...tail];

/** The simulator's store. */
function midra() {
  const s = new DeviceStore();
  s.hydrate(fixture('midra-3.2.29-backgrounds.json'));
  return s;
}

/** The simulator's store with S1's Background Image 1 let go of slot 1, so an upload is safe. */
function midraClear() {
  const s = midra();
  s.set(S(1, 'backFrameList', 'items', '1', 'control', 'pp', 'librarySlot'), 'NONE');
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

function checkEvery(out, picture, expect, label) {
  let checked = 0;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const want = expect(x, y);
      const got = at(out, x, y);
      const ref = want ? at(picture, want[0], want[1]) : [0, 0, 0, 255];
      if (got[0] !== ref[0] || got[1] !== ref[1] || got[2] !== ref[2] || got[3] !== ref[3]) {
        assert.fail(`${label}: ${x},${y} is ${got} — expected ${want ? `picture ${want[0]},${want[1]}` : 'background'} ${ref}`);
      }
      checked++;
    }
  }
  return checked;
}

/**
 * What an output shows of a canvas image under Auto Crop, as the Web RCS
 * draws it: its area of interest in the raster carries its rectangle of the
 * canvas, at pitch 1.000 pixel for pixel; the rest of the raster is black.
 */
function autocrop(canvasImage, crop) {
  const { raster, aoi, canvas } = crop;
  const data = new Uint8ClampedArray(raster.width * raster.height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([0, 0, 0, 255], i);
  for (let y = 0; y < aoi.h; y++) {
    for (let x = 0; x < aoi.w; x++) {
      const s = ((canvas.y + y) * canvasImage.width + canvas.x + x) * 4;
      const d = ((aoi.y + y) * raster.width + aoi.x + x) * 4;
      data.set(canvasImage.data.subarray(s, s + 4), d);
    }
  }
  return { width: raster.width, height: raster.height, data };
}

/* ------------------------------------------------------------- the model */

test('the Midra store gets the Midra model, and the platform offers background sets', () => {
  const store = midra();
  assert.equal(modelFor(store), mng);
  assert.equal(modelFor(store).PLATFORM, 'mng');
  assert.equal(modelFor(new DeviceStore()).PLATFORM, 'nlc', 'an empty store gets LivePremier’s, which reads nothing in it');
  const platform = detectPlatform(store);
  assert.equal(platform.capabilities.backgroundSets.supported, true, 'probed on screenList/items/*/backgroundSetList');
  assert.equal(supports(platform, 'backgroundSets'), true);
});

test('topology: S1 and S2 in service; S2’s output shows a 1024 × 640 area of its 1920 × 1080 raster', () => {
  const store = midra();
  assert.deepEqual(mng.readScreens(store).map((s) => [s.id, s.canvas.width, s.canvas.height, s.backgroundType]),
    [['S1', 1920, 1080, 'LIVE_OR_FRAME'], ['S2', 1024, 640, 'LIVE_OR_FRAME']]);
  const t = mng.screenTopology(store, 'S2');
  assert.deepEqual(t.outputs.map((o) => o.key), ['2']);
  const o = t.outputs[0];
  assert.deepEqual(o.raster, { width: 1920, height: 1080 });
  assert.deepEqual(o.aoi, { x: 0, y: 0, w: 1024, h: 640 });
  assert.deepEqual(o.regions[0].canvas, { x: 0, y: 0, w: 1024, h: 640 });
  assert.deepEqual(o.ratio, { h: 1, v: 1 });
  assert.equal(o.rate, 50000, 'the store’s Hz, counted in thousandths as LivePremier’s is');
  assert.deepEqual(o.plugs, ['HDMI', 'SDI'], 'an output’s plugs are copies');
  assert.deepEqual(mng.assumptionsFor(o), ['aoi']);
  assert.deepEqual(t.image.raster, { width: 1024, height: 640 }, 'the one image is the canvas');
  assert.deepEqual(t.image.regions[0].canvas, { x: 0, y: 0, w: 1024, h: 640 });
  assert.equal(mng.screenTopology(store, 'S3'), null, 'a disabled screen is not in service');
});

test('frames, sets and the library: S1 BKG1 points at empty slot 1, everything else is free', () => {
  const store = midra();
  const frames = mng.readFrames(store, 'S1');
  assert.deepEqual(frames.map((f) => [f.index, f.librarySlot, f.free]), [[1, '1', false], [2, 'NONE', true], [3, 'NONE', true], [4, 'NONE', true]]);
  assert.equal(mng.firstFreeFrame(mng.readFrames(store, 'S2')).index, 1);
  const sets = mng.readSets(store, 'S2');
  assert.equal(sets.length, 8);
  assert.ok(sets.every((s) => s.empty && s.mode === 'SINGLE_AUTOCROP' && !s.onProgram && !s.onPreview));
  assert.equal(mng.firstFreeSet(sets).index, 1);
  const lib = mng.readLibrary(store);
  assert.equal(lib.slots.length, 50);
  assert.ok(lib.slots.every((s) => s.free));
  assert.deepEqual(lib.limits, { maxWidth: 18000, maxHeight: 18000, maxPixels: 35389440, maxBytes: 26214400 });
  assert.deepEqual(mng.nextSlots(lib, 2), [1, 2]);
  assert.deepEqual(mng.framesOn(store, 1).map((f) => f.name), ['S1 BKG1']);
  assert.deepEqual(mng.framesOn(store, 2), []);
});

test('a set is on program or preview when that buffer’s background layer selects it', () => {
  const store = midra();
  /* S2 is AT_DOWN: DOWN is program, UP preview. */
  store.set(S(2, 'presetList', 'items', 'DOWN', 'background', 'source', 'pp', 'set'), '3');
  store.set(S(2, 'presetList', 'items', 'UP', 'background', 'source', 'pp', 'set'), '5');
  store.set(S(2, 'backgroundSetList', 'items', '3', 'control', 'pp', 'singleContent'), 'PRESET_FRAME_2');
  const sets = mng.readSets(store, 'S2');
  assert.equal(sets[2].onProgram, true);
  assert.equal(sets[4].onPreview, true);
  assert.deepEqual(sets[2].contents, { canvas: 'PRESET_FRAME_2' });
  const frames = mng.readFrames(store, 'S2', sets);
  assert.equal(frames[1].free, false, 'a frame a set shows is not free, though it points at no slot');
  assert.equal(frames[1].onAir, true);
});

/* ------------------------------------------------------------ pixel tests */

test('PIXELS: a picture placed 1:1 on S2 is the canvas image exactly, and Out 2’s crop of it is the picture', () => {
  const store = midraClear();
  const pic = pattern(1024, 640);
  const plan = mng.buildPlan(store, { screens: ['S2'], mode: 'each', place: { S2: { x: 0, y: 0, w: 1024, h: 640 } }, image: pic });
  assert.equal(plan.ok, true, plan.problems.join('; '));
  const s = plan.screens[0];
  const row = s.outputs[0];
  assert.equal(row.key, 'canvas');
  assert.ok(row.blits.every(isExact) && row.exact, 'a pixel copy');
  const img = renderRGBA(row.blits, pic, 1024, 640);
  assert.equal(checkEvery(img, pic, (x, y) => [x, y], 'S2 canvas'), 1024 * 640);
  /* The switcher's cut: Out 2's area of interest carries the whole canvas. */
  assert.deepEqual(s.crops.map((c) => [c.key, c.exact]), [['2', true]]);
  const shown = autocrop(img, s.crops[0]);
  checkEvery(shown, pic, (x, y) => (x < 1024 && y < 640 ? [x, y] : null), 'Out 2 as cropped');
});

test('PIXELS: one picture spanning S1 and S2 — each canvas image is its part, every pixel', () => {
  const store = midraClear();
  const screens = mng.readScreens(store);
  const lay = spanLayout(screens);
  assert.deepEqual(lay.bounds, { x: 0, y: 0, w: 2944, h: 1080 });
  const pic = pattern(2944, 1080);
  const job = { screens: ['S1', 'S2'], mode: 'span', span: { offsets: {}, rect: presetPlacement('native', pic, lay.bounds) }, image: pic };
  const plan = mng.buildPlan(store, job);
  assert.equal(plan.ok, true, plan.problems.join('; '));
  assert.deepEqual(plan.screens.map((s) => s.outputs[0].librarySlot), [1, 2], 'two uploads, the first two empty slots, in plan order');
  const [s1, s2] = plan.screens;
  checkEvery(renderRGBA(s1.outputs[0].blits, pic, 1920, 1080), pic, (x, y) => [x, y], 'S1');
  checkEvery(renderRGBA(s2.outputs[0].blits, pic, 1024, 640), pic, (x, y) => [1920 + x, y], 'S2');
});

test('PIXELS: a picture off the corner leaves the background where it does not reach, edges exact', () => {
  const store = midraClear();
  const pic = pattern(600, 400);
  const plan = mng.buildPlan(store, { screens: ['S2'], mode: 'each', place: { S2: { x: 700, y: 500, w: 600, h: 400 } }, image: pic });
  const row = plan.screens[0].outputs[0];
  assert.deepEqual(row.blits[0].dst, { x: 700, y: 500, w: 324, h: 140 });
  const img = renderRGBA(row.blits, pic, 1024, 640);
  checkEvery(img, pic, (x, y) => (x >= 700 && y >= 500 ? [x - 700, y - 500] : null), 'corner');
});

test('PIXELS: two outputs side by side on one canvas each crop their own half, with no seam', () => {
  /* What no simulator here has: a 3840 × 1080 canvas over two 1920 × 1080
     outputs. Built from the fixture's own nodes, moved. */
  const store = midraClear();
  const cur = [...D, 'preconfig', 'status', 'stateList', 'items', 'CURRENT'];
  store.set([...cur, 'outputList', 'items', '2', 'pp', 'usedOnScreen'], '1');
  store.set(S(1, 'canvas', 'status', 'size', 'pp', 'sizeH'), 3840);
  const c2 = [...D, 'outputList', 'items', '2', 'canvas', 'status', 'pp'];
  for (const [k, v] of Object.entries({ left: 1920, top: 0, aoiWidth: 1920, aoiHeight: 1080, pitchedWidth: 1920, pitchedHeight: 1080 })) store.set([...c2, k], v);
  const pic = pattern(3840, 1080);
  const plan = mng.buildPlan(store, { screens: ['S1'], mode: 'each', place: { S1: { x: 0, y: 0, w: 3840, h: 1080 } }, image: pic });
  assert.equal(plan.ok, true, plan.problems.join('; '));
  const s = plan.screens[0];
  assert.deepEqual(s.crops.map((c) => [c.key, c.canvas]), [['1', { x: 0, y: 0, w: 1920, h: 1080 }], ['2', { x: 1920, y: 0, w: 1920, h: 1080 }]]);
  const img = renderRGBA(s.outputs[0].blits, pic, 3840, 1080);
  const left = autocrop(img, s.crops[0]);
  const right = autocrop(img, s.crops[1]);
  checkEvery(left, pic, (x, y) => [x, y], 'Out 1');
  checkEvery(right, pic, (x, y) => [1920 + x, y], 'Out 2');
  assert.deepEqual(at(left, 1919, 0), at(pic, 1919, 0));
  assert.deepEqual(at(right, 0, 0), at(pic, 1920, 0), 'the next column, on the next output');
});

test('a pitch other than 1.000 is the switcher scaling the crop, and the plan says so on that output', () => {
  const store = midraClear();
  store.set([...D, 'outputList', 'items', '2', 'canvas', 'pitch', 'pp', 'pitchRatioH'], 1250);
  const plan = mng.buildPlan(store, { screens: ['S2'], mode: 'each', place: { S2: { x: 0, y: 0, w: 1024, h: 640 } }, image: { width: 1024, height: 640 } });
  const crop = plan.screens[0].crops[0];
  assert.equal(crop.exact, false);
  assert.ok(crop.assumptions.includes('pitch'));
  assert.equal(plan.screens[0].outputs[0].exact, true, 'the canvas image itself is still a copy');
});

/* ------------------------------------------------------------------ plan */

const stillsJob = (over = {}) => ({ screens: ['S2'], mode: 'each', place: { S2: { x: 0, y: 0, w: 1024, h: 640 } }, image: { width: 1024, height: 640 }, ...over });

test('the plan refuses an upload that would land in a slot a Background Image points at', () => {
  const plan = mng.buildPlan(midra(), stillsJob());
  assert.equal(plan.ok, false);
  assert.equal(plan.platform, 'mng');
  assert.match(plan.problems.join('\n'), /first empty library slot — slot 1 — and S1 BKG1 already points at it, so it would show this image too/);
});

test('the plan: the canvas image, the first empty slot, the first free Background Image and set, and nothing written', () => {
  const store = midraClear();
  let sent = 0;
  const plan = mng.buildPlan(store, stillsJob());
  assert.equal(plan.ok, true, plan.problems.join('; '));
  const s = plan.screens[0];
  assert.deepEqual([s.setIndex, s.frame.index, s.outputs[0].librarySlot, s.outputs[0].content], [1, 1, 1, 'PRESET_FRAME_1']);
  assert.deepEqual(s.outputs[0].raster, { width: 1024, height: 640 });
  assert.deepEqual(s.display, { ok: true, type: 'LIVE_OR_FRAME', why: null });
  assert.deepEqual(plan.library.slots, [1]);
  assert.equal(sent, 0);
});

test('the plan follows the preconfig’s background layer: stills need frames, live needs inputs', () => {
  const type = (store, t) => store.set([...D, 'preconfig', 'status', 'stateList', 'items', 'CURRENT', 'screenList', 'items', '2', 'pp', 'backgroundLayerType'], t);
  let store = midraClear();
  type(store, 'ONLY_LIVE');
  assert.match(mng.buildPlan(store, stillsJob()).problems.join('\n'), /takes live inputs only .* cannot show a Background Image/);
  assert.equal(mng.buildPlan(store, stillsJob({ options: { assignSet: false } })).ok, true, 'images only touch no set');
  store = midraClear();
  type(store, 'ONLY_FRAME');
  assert.match(mng.buildPlan(store, { ...stillsJob(), source: 'live', live: { 'S2/2': 'INPUT_1' } }).problems.join('\n'), /takes stills only .* cannot hold its inputs/);
  store = midraClear();
  type(store, 'DISABLE');
  const plan = mng.buildPlan(store, stillsJob());
  assert.equal(plan.ok, false);
  assert.equal(plan.screens[0].display.ok, false);
});

test('a set on program, or a Background Image a set on program shows, is refused unless told', () => {
  const store = midraClear();
  store.set(S(2, 'presetList', 'items', 'DOWN', 'background', 'source', 'pp', 'set'), '2');
  assert.match(mng.buildPlan(store, stillsJob({ sets: { S2: 2 } })).problems.join('\n'), /set 2 is on program/);
  assert.equal(mng.buildPlan(store, stillsJob({ sets: { S2: 2 } }), { allowProgram: true }).ok, true);
  store.set(S(2, 'backgroundSetList', 'items', '2', 'control', 'pp', 'singleContent'), 'PRESET_FRAME_3');
  const plan = mng.buildPlan(store, stillsJob({ frames: { S2: 3 } }));
  assert.match(plan.problems.join('\n'), /Background Image 3 is in a set on program/);
  assert.match(plan.warnings.join('\n'), /Background Image 3 is replaced, and set 2 shows it/);
});

test('a canvas larger than the library takes is refused rather than downscaled', () => {
  const store = midraClear();
  store.set(S(2, 'canvas', 'status', 'size', 'pp', 'sizeH'), 8192);
  store.set(S(2, 'canvas', 'status', 'size', 'pp', 'sizeV'), 4800);
  const plan = mng.buildPlan(store, stillsJob());
  assert.match(plan.problems.join('\n'), /8192 × 4800 canvas is larger than the image library takes/);
});

/* ---------------------------------------------------------------- writes */

test('the write lists: frame slot then 1:1 then label; Auto Crop then content; each with what it replaces', () => {
  const store = midraClear();
  const f = mng.frameWrites(store, 'S2', 1, 45, 'A label far too long to fit');
  assert.deepEqual(f.map((w) => [w.path.slice(-4).join('/'), w.value, w.before]), [
    ['1/control/pp/librarySlot', '45', 'NONE'],
    ['1/control/pp/mode', '1_1', 'CENTERED'],
    ['1/control/pp/label', 'A label far too ', '']
  ]);
  assert.deepEqual(f[0].path, ['device', 'screenList', 'items', '2', 'backFrameList', 'items', '1', 'control', 'pp', 'librarySlot']);
  const a = mng.autocropWrites(store, 'S2', 4, 1);
  assert.deepEqual(a.map((w) => [w.path.at(-1), w.value, w.before]), [['singleContent', 'PRESET_FRAME_1', 'NONE']], 'already Auto Crop: the mode is not sent');
  store.set(mng.setPath('S2', 4, 'mode'), 'MULTI_CUSTOM');
  assert.deepEqual(mng.autocropWrites(store, 'S2', 4, 1).map((w) => w.path.at(-1)), ['mode', 'singleContent']);
  const c = mng.customWrites(store, 'S2', 5, { 2: 'INPUT_3' });
  assert.deepEqual(c.map((w) => [w.path.slice(-4, -3)[0], w.path.at(-1), w.value]), [['5', 'mode', 'MULTI_CUSTOM'], ['2', 'multiContent', 'INPUT_3']],
    'top left is already the alignment, so it is not sent');
  assert.deepEqual(mng.presetWrites(store, 'S2', 'UP', 4).map((w) => [w.path.slice(-5).join('/'), w.value, w.before]), [['UP/background/source/pp/set', '4', 'NONE']]);
  assert.deepEqual(mng.libraryDeleteWrites(45).map((w) => [w.path.join('/'), w.value]), [
    ['device/stillLibrary/bankList/items/45/control/pp/xDelete', false], ['device/stillLibrary/bankList/items/45/control/pp/xDelete', true]]);
  assert.equal(describePath(f[0].path), 'S2 BKG1 librarySlot');
  assert.equal(describePath(mng.presetSetPath('S2', 'UP')), 'S2 preset UP background set');
});

/* -------------------------------------------------------- live, and EDIDs */

test('live inputs: the available inputs, and the EDID is a preferred format the plug offers', () => {
  const store = midraClear();
  const cands = mng.liveCandidates(store);
  assert.deepEqual(cands.map((c) => c.key), ['INPUT_1', 'INPUT_2', 'INPUT_3', 'INPUT_4', 'INPUT_5', 'INPUT_6', 'INPUT_7', 'INPUT_8', 'INPUT_9', 'INPUT_10']);
  const out = mng.screenTopology(store, 'S2').outputs[0];
  assert.deepEqual(mng.plugTemplates(store, 'INPUT_1'), {}, 'the simulator lists no preferred formats');
  assert.match(mng.edidChoice(out, {}).why, /lists no EDID preferred formats/);
  assert.deepEqual(mng.edidChoice(out, { '1920_1080_50HZ': true }), { kind: 'template', key: '1920_1080_50HZ', label: '1920×1080 50HZ' });
  assert.deepEqual(mng.edidChoice({ ...out, format: 'COMPUTER_CUSTOM_3' }, { CUSTOM_3: true }), { kind: 'custom', key: 'CUSTOM_3', label: 'custom format 3' });
  const w = mng.edidWrites('INPUT_2', { kind: 'template', key: '1920_1080_50HZ' }, '1');
  assert.deepEqual(w.map((x) => [x.path.slice(-3).join('/'), x.value]), [['cmd/pp/xRequestPrefFormat', 'NONE'], ['cmd/pp/xRequestPrefFormat', '1920_1080_50HZ']]);
});

test('a live plan is a Custom set with an input per output, and the export names the cable', () => {
  const store = midraClear();
  const job = { source: 'live', screens: ['S1', 'S2'], mode: 'span', span: { offsets: {}, rect: { x: 0, y: 0, w: 2944, h: 1080 } }, image: { width: 2944, height: 1080 }, live: { 'S1/1': 'INPUT_1', 'S2/2': 'INPUT_2' } };
  const plan = mng.buildPlan(store, job);
  assert.equal(plan.ok, true, plan.problems.join('; '));
  assert.deepEqual(plan.screens.map((s) => s.outputs.map((o) => [o.key, o.content, o.align])), [[['1', 'INPUT_1', 'TOP_LEFT']], [['2', 'INPUT_2', 'TOP_LEFT']]]);
  assert.deepEqual(mediaOutputs(plan).map((m) => [m.name, m.width, m.height]), [['IN 1 → S1 Out 1', 1920, 1080], ['IN 2 → S2 Out 2', 1920, 1080]]);
  /* S2's region: the canvas it shows lands in its area of interest. */
  const rows = regionRows(plan);
  assert.deepEqual(rows[1].content, { x: 1920, y: 0, w: 1024, h: 640 });
  assert.deepEqual(rows[1].raster, { x: 0, y: 0, w: 1024, h: 640 });
  assert.match(toCsv(plan, { width: 2944, height: 1080 }), /IN 2 → S2 Out 2,INPUT_2,S2,1,2,1920,1080,HDTV_1080P,50,/);
  const twice = mng.buildPlan(store, { ...job, live: { 'S1/1': 'INPUT_1', 'S2/2': 'INPUT_1' } });
  assert.match(twice.problems.join('\n'), /one input per output/);
});

test('the stills export on a Midra is one media output per canvas', () => {
  const plan = mng.buildPlan(midraClear(), stillsJob());
  assert.deepEqual(mediaOutputs(plan).map((m) => [m.name, m.width, m.height]), [['S2 canvas', 1024, 640]]);
  assert.equal(mng.imageName('S2', plan.screens[0].outputs[0], 'My Show.png'), 'My_Show_S2_canvas_1024x640.png');
});

/* ----------------------------------------------- the apply path, end to end */

/**
 * A stand-in Midra: every write is echoed a tick later; a Background Image
 * pointing at a valid slot reports itself valid at the image's size in 1:1
 * (`frameSize` overrides that); the upload route imports into the first
 * empty slot, as the simulator's server does, at the size `sizes` gives.
 */
function standIn(store, { sizes = {}, status = 'FINISH', frameSize = null } = {}) {
  const log = [];
  const refresh = () => {
    for (const sk of ['1', '2', '3', '4']) {
      for (const k of ['1', '2', '3', '4']) {
        const ctl = store.get(S(sk, 'backFrameList', 'items', k, 'control', 'pp')) || {};
        const slot = ctl.librarySlot;
        const lib = slot && slot !== 'NONE' ? store.get([...D, 'stillLibrary', 'bankList', 'items', slot, 'status', 'pp']) : null;
        const valid = !!(lib && lib.isValid);
        const size = !valid ? [0, 0] : frameSize || (ctl.mode === '1_1' ? [lib.width, lib.height] : [ctl.sizeH, ctl.sizeV]);
        const st = S(sk, 'backFrameList', 'items', k, 'status', 'pp');
        store.set([...st, 'isValid'], valid);
        store.set([...st, 'width'], size[0]);
        store.set([...st, 'height'], size[1]);
      }
    }
  };
  const session = {
    store,
    send({ path, value }) {
      log.push([path.join('/'), value]);
      setTimeout(() => {
        store.set(path, value);
        const p = path.join('/');
        if (/stillLibrary\/bankList\/items\/\d+\/control\/pp\/xDelete$/.test(p) && value === true) {
          store.set([...path.slice(0, -3), 'status', 'pp', 'isValid'], false);
        }
        refresh();
      }, 1);
      return true;
    }
  };
  const uploads = [];
  const fetchImpl = async (url, init) => {
    const file = init.body.get('FILES');
    uploads.push([url, file.name, [...init.body.keys()]]);
    const slot = mng.nextSlots(mng.readLibrary(store), 1)[0];
    const [w, h] = sizes[file.name] || [1, 1];
    setTimeout(() => {
      if (/^FINISH/.test(status)) {
        const st = [...D, 'stillLibrary', 'bankList', 'items', String(slot), 'status', 'pp'];
        store.set([...st, 'fileName'], file.name);
        store.set([...st, 'width'], status === 'FINISH_WITH_DOWNSCALE' ? Math.round(w / 2) : w);
        store.set([...st, 'height'], status === 'FINISH_WITH_DOWNSCALE' ? Math.round(h / 2) : h);
        store.set([...st, 'isValid'], true);
        refresh();
      }
    }, 2);
    return { ok: true, status: 200, json: async () => ({ [file.name]: status }), text: async () => '' };
  };
  return { session, log, uploads, fetchImpl };
}

const imagesFor = (plan) => new Map(plan.screens.map((s) => [`${s.id}/canvas`, { blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), name: `bg_${s.id}.png` }]));
const sizesFor = (plan) => Object.fromEntries(plan.screens.map((s) => [`bg_${s.id}.png`, [s.outputs[0].raster.width, s.outputs[0].raster.height]]));

test('apply: upload, the Background Image at 1:1, the Auto Crop set, the preview — each echoed — and revert takes it all back', async () => {
  const store = midraClear();
  const plan = mng.buildPlan(store, stillsJob());
  const { session, log, uploads, fetchImpl } = standIn(store, { sizes: sizesFor(plan) });
  const steps = [];
  const result = await applyPlan({ session, plan, images: imagesFor(plan), fetchImpl, options: { label: 'Act 1', loadPreview: true }, onStep: (t, s) => steps.push([s, t]) });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(uploads, [['/api/device/images/upload', 'bg_S2.png', ['FILES']]], 'the file and nothing else: the switcher picks the slot');
  assert.deepEqual(result.journal.uploads, [1]);
  assert.equal(store.get(mng.framePath('S2', 1, 'librarySlot')), '1');
  assert.equal(store.get(mng.framePath('S2', 1, 'mode')), '1_1');
  assert.equal(store.get(mng.framePath('S2', 1, 'label')), 'Act 1');
  assert.deepEqual([store.get(mng.frameStatusPath('S2', 1, 'width')), store.get(mng.frameStatusPath('S2', 1, 'height'))], [1024, 640]);
  assert.equal(store.get(mng.setPath('S2', 1, 'singleContent')), 'PRESET_FRAME_1');
  assert.equal(store.get(mng.presetSetPath('S2', 'UP')), '1', 'S2 is AT_DOWN, so UP is preview');
  assert.equal(store.get(mng.presetSetPath('S2', 'DOWN')), 'NONE', 'program untouched');
  const order = log.map(([p]) => p);
  assert.deepEqual(order, [
    'device/screenList/items/2/backFrameList/items/1/control/pp/librarySlot',
    'device/screenList/items/2/backFrameList/items/1/control/pp/mode',
    'device/screenList/items/2/backFrameList/items/1/control/pp/label',
    'device/screenList/items/2/backgroundSetList/items/1/control/pp/singleContent',
    'device/screenList/items/2/presetList/items/UP/background/source/pp/set'
  ]);
  assert.ok(steps.some(([s, t]) => s === 'done' && /shows slot 1 at 1:1 — the switcher reports 1024 × 640/.test(t)));
  assert.ok(!log.some(([p]) => p.includes('/screenList/items/1/')), 'nothing under S1');

  const undone = await revert({ session, journal: result.journal });
  assert.equal(undone.ok, true, undone.problems.join('; '));
  assert.equal(store.get(mng.presetSetPath('S2', 'UP')), 'NONE');
  assert.equal(store.get(mng.setPath('S2', 1, 'singleContent')), 'NONE');
  assert.deepEqual(['librarySlot', 'mode', 'label'].map((p) => store.get(mng.framePath('S2', 1, p))), ['NONE', 'CENTERED', '']);
  assert.ok(mng.readLibrary(store).slots.every((s) => s.free), 'the uploaded slot emptied');
  assert.deepEqual(log.slice(-2).map(([p, v]) => [p, v]), [
    ['device/stillLibrary/bankList/items/1/control/pp/xDelete', false], ['device/stillLibrary/bankList/items/1/control/pp/xDelete', true]],
  'the slot is emptied last, once no frame of ours shows it');
});

test('apply refuses when the library’s first empty slot moved since the plan, and writes nothing', async () => {
  const store = midraClear();
  const plan = mng.buildPlan(store, stillsJob());
  const { session, log, uploads, fetchImpl } = standIn(store, { sizes: sizesFor(plan) });
  store.set([...D, 'stillLibrary', 'bankList', 'items', '1', 'status', 'pp', 'isValid'], true);
  const result = await applyPlan({ session, plan, images: imagesFor(plan), fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /first empty slots are now 2, not 1 — plan again/);
  assert.equal(log.length + uploads.length, 0);
});

test('apply refuses when a frame has come to point at the predicted slot since the plan', async () => {
  const store = midraClear();
  const plan = mng.buildPlan(store, stillsJob());
  const { session, uploads, fetchImpl } = standIn(store, { sizes: sizesFor(plan) });
  store.set(S(1, 'backFrameList', 'items', '1', 'control', 'pp', 'librarySlot'), '1');
  const result = await applyPlan({ session, plan, images: imagesFor(plan), fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /S1 BKG1 points at slot 1 — refused/);
  assert.equal(uploads.length, 0);
});

test('a downscaled import is a failure, and the slot it filled is journalled for Undo', async () => {
  const store = midraClear();
  const plan = mng.buildPlan(store, stillsJob());
  const { session, fetchImpl } = standIn(store, { sizes: sizesFor(plan), status: 'FINISH_WITH_DOWNSCALE' });
  const result = await applyPlan({ session, plan, images: imagesFor(plan), fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /downscaled bg_S2.png on the way in/);
  assert.deepEqual(result.journal.uploads, [1]);
  assert.equal(result.journal.writes.length, 0);
  const undone = await revert({ session, journal: result.journal });
  assert.equal(undone.ok, true);
  assert.ok(mng.readLibrary(store).slots.every((s) => s.free));
});

test('a Background Image that does not report the canvas size stops the run before the set', async () => {
  const store = midraClear();
  const plan = mng.buildPlan(store, stillsJob());
  const { session, log, fetchImpl } = standIn(store, { sizes: sizesFor(plan), frameSize: [1728, 1080] });
  const result = await applyPlan({ session, plan, images: imagesFor(plan), fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /Background Image 1 reports 1728 × 1080, not the 1024 × 640 canvas/);
  assert.ok(!log.some(([p]) => p.includes('backgroundSetList')));
});

test('live apply: Custom, then each output’s input — and back', async () => {
  const store = midraClear();
  store.set(mng.setOutputPath('S2', 1, '2', 'multiAlign'), 'MIDDLE_CENTER');
  const plan = mng.buildPlan(store, { source: 'live', ...stillsJob(), live: { 'S2/2': 'INPUT_4' } });
  assert.equal(plan.ok, true, plan.problems.join('; '));
  const { session, log } = standIn(store);
  const result = await applyPlan({ session, plan, options: { edids: true, loadPreview: false } });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(log.map(([p, v]) => [p.split('/').slice(-4).join('/'), v]), [
    ['1/control/pp/mode', 'MULTI_CUSTOM'],
    ['2/control/pp/multiContent', 'INPUT_4'],
    ['2/control/pp/multiAlign', 'TOP_LEFT']
  ], 'no EDID asked for: the plug offers none');
  const undone = await revert({ session, journal: result.journal });
  assert.equal(undone.ok, true);
  assert.equal(store.get(mng.setPath('S2', 1, 'mode')), 'SINGLE_AUTOCROP');
  assert.equal(store.get(mng.setOutputPath('S2', 1, '2', 'multiContent')), 'NONE');
  assert.equal(store.get(mng.setOutputPath('S2', 1, '2', 'multiAlign')), 'MIDDLE_CENTER', 'what it was, not the default');
});

test('the preview load is skipped mid-take and on a screen with no background layer', async () => {
  const store = midraClear();
  store.set([...D, 'transition', 'screenList', 'items', '2', 'status', 'pp', 'transition'], 'EFFECT_FROM_DOWN');
  const plan = mng.buildPlan(store, stillsJob());
  const { session, log, fetchImpl } = standIn(store, { sizes: sizesFor(plan) });
  const steps = [];
  const result = await applyPlan({ session, plan, images: imagesFor(plan), fetchImpl, options: { loadPreview: true }, onStep: (t, s) => steps.push([s, t]) });
  assert.equal(result.ok, true, result.error);
  assert.ok(steps.some(([s, t]) => s === 'note' && /a take is under way/.test(t)));
  assert.ok(!log.some(([p]) => p.includes('presetList')));
});

/**
 * The page as it really behaves: the mirror takes this page's own outbound
 * write at once (`transports/page-socket.js`), and the switcher echoes back
 * inbound only what it accepted — as the Midra 4K simulator did, a refused
 * enum value not at all. A store-value wait would pass a refused write.
 */
function pageLike(store, refuse = () => false) {
  const session = new EventTarget();
  session.store = store;
  const log = [];
  session.send = ({ path, value }) => {
    log.push([path.join('/'), value]);
    store.set(path, value);
    session.dispatchEvent(new CustomEvent('frame', { detail: { path, value, dir: 'out' } }));
    if (!refuse(path, value)) setTimeout(() => session.dispatchEvent(new CustomEvent('frame', { detail: { path, value, dir: 'in' } })), 1);
    return true;
  };
  return { session, log };
}

test('a write the switcher refuses is a failure, though the page mirror shows it: only its inbound echo counts', async () => {
  const store = midraClear();
  const plan = mng.buildPlan(store, { source: 'live', ...stillsJob(), live: { 'S2/2': 'INPUT_4' } });
  const accepted = pageLike(store);
  const ok = await applyPlan({ session: accepted.session, plan, options: {} });
  assert.equal(ok.ok, true, ok.error);
  await revert({ session: accepted.session, journal: ok.journal });

  const store2 = midraClear();
  const plan2 = mng.buildPlan(store2, { source: 'live', ...stillsJob(), live: { 'S2/2': 'INPUT_4' } });
  const refused = pageLike(store2, (path) => path.at(-1) === 'multiContent');
  const t0 = Date.now();
  const bad = await applyPlan({ session: refused.session, plan: plan2, options: {} });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /S2 set 1 did not take its inputs — the switcher did not echo it/);
  assert.equal(store2.get(mng.setOutputPath('S2', 1, '2', 'multiContent')), 'INPUT_4', 'the mirror shows it all the same');
  assert.ok(Date.now() - t0 >= 5000, 'it waited for the echo rather than reading the mirror');
  assert.equal(bad.journal.writes.length, 2, 'journalled, so Undo puts back what may have landed');
});
