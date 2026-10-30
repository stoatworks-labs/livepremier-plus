/*
 * Desk control's NDI feeds: the drawing (`src/core/raster.js`), the scenes
 * (`plugins/desk-control/ndi.js`), the media host's core against a pretend
 * runtime (`devices/media/core.js`), and the host itself forked by its
 * supervisor (`server/media-host.js`) with a pictures-sized IPC channel.
 * The real runtime is not loaded here: docs/DESK-CONTROL.md says what was
 * run against it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blank, fill, stroke, draw, text, render } from '../src/core/raster.js';
import { feedsFor, imageKey, sourceName, screenScene, layersScene, layerScene, layerColour, TILE_SIZE } from '../plugins/desk-control/ndi.js';
import { libraries } from '../plugins/desk-control/media.js';
import { normaliseDesk, deskChanged, NDI_SIZES } from '../plugins/desk-control/core.js';
import { createMediaCore } from '../devices/media/core.js';
import { candidates, loadNdi } from '../devices/media/ndi.js';
import { createMediaHost, findMediaHost, absentMedia } from '../server/media-host.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = (pic, x, y) => { const i = (y * pic.width + x) * 4; return [...pic.data.slice(i, i + 3)]; };
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`timed out waiting for ${what}`);
};

/* ------------------------------------------------------------------ drawing */

test('raster: fills clip to the picture, blend by opacity, and outline inside the rectangle', () => {
  const pic = blank(20, 10, [10, 20, 30]);
  fill(pic, { x: -5, y: -5, w: 10, h: 10 }, [200, 0, 0]);
  assert.deepEqual(at(pic, 0, 0), [200, 0, 0]);
  assert.deepEqual(at(pic, 4, 4), [200, 0, 0]);
  assert.deepEqual(at(pic, 5, 5), [10, 20, 30], 'the half off the picture is not drawn, the rest is');
  fill(pic, { x: 10, y: 0, w: 10, h: 10 }, [255, 255, 255], 0.5);
  assert.deepEqual(at(pic, 15, 5), [132, 137, 142]);
  const box = blank(10, 10);
  stroke(box, { x: 0, y: 0, w: 10, h: 10 }, [0, 255, 0], 2);
  assert.deepEqual(at(box, 1, 5), [0, 255, 0]);
  assert.deepEqual(at(box, 2, 5), [0, 0, 0], 'two pixels thick, inside');
  assert.deepEqual(at(box, 9, 9), [0, 255, 0]);
});

test('raster: an image is stretched to its rectangle, its alpha and opacity together covering what is there', () => {
  const img = blank(2, 1);
  img.data.set([255, 0, 0, 255, 0, 0, 255, 255]);
  const pic = blank(40, 20, [0, 255, 0]);
  draw(pic, img, { x: 0, y: 0, w: 40, h: 10 });
  assert.deepEqual(at(pic, 1, 5), [255, 0, 0], 'left half red');
  assert.deepEqual(at(pic, 38, 5), [0, 0, 255], 'right half blue');
  assert.deepEqual(at(pic, 20, 15), [0, 255, 0], 'below the rectangle untouched');
  const half = blank(4, 4, [0, 0, 0]);
  draw(half, blank(1, 1, [200, 200, 200]), { x: 0, y: 0, w: 4, h: 4 }, 0.5);
  assert.deepEqual(at(half, 2, 2), [100, 100, 100]);
  const clear = blank(1, 1, [255, 255, 255]);
  clear.data[3] = 0;
  const under = blank(4, 4, [9, 9, 9]);
  draw(under, clear, { x: 0, y: 0, w: 4, h: 4 });
  assert.deepEqual(at(under, 1, 1), [9, 9, 9], 'a transparent image leaves what is there');
});

test('raster: text lights pixels inside its box only, and render runs operations in order, passing over what it does not know', () => {
  const pic = blank(200, 40);
  text(pic, 'S1 L2', { x: 0, y: 0, w: 200, h: 40 }, [255, 255, 255]);
  let lit = 0;
  for (let i = 0; i < pic.data.length; i += 4) if (pic.data[i] === 255) lit++;
  assert.ok(lit > 100, 'drawn');
  const off = blank(20, 20);
  text(off, 'X', { x: 30, y: 30, w: 50, h: 50 }, [255, 255, 255]);
  assert.equal(off.data.some((v, i) => i % 4 !== 3 && v !== 0), false, 'outside the picture, nothing');
  const r = render({ width: 10, height: 10, background: [1, 2, 3], ops: [
    { op: 'fill', rect: { x: 0, y: 0, w: 10, h: 10 }, rgb: [50, 50, 50] },
    { op: 'image', rect: { x: 0, y: 0, w: 5, h: 5 }, image: 'missing' },
    { op: 'teleport', rect: { x: 0, y: 0, w: 5, h: 5 } },
    { op: 'fill', rect: { x: 5, y: 5, w: 5, h: 5 }, rgb: [90, 90, 90] },
  ] });
  assert.deepEqual(at(r, 0, 0), [50, 50, 50]);
  assert.deepEqual(at(r, 9, 9), [90, 90, 90]);
});

/* ------------------------------------------------------------------ scenes */

const FACTS = { sources: { LIVE: [{ number: 1, label: 'Camera 1' }, { number: 3, label: 'Playback' }], STILL: [{ number: 2, label: 'Logo' }] } };
const patch = (s) => {
  const out = [];
  for (const d of s) for (let l = 1; l <= d.layers; l++) out.push({ kind: 'layer', id: `${d.id}.L${l}`, destination: d.id, layer: l });
  return [{ kind: 'master', id: 'M' }, ...out];
};

test('ndi: a feed per patched screen, one of the layers, and a feed per layer only when asked', () => {
  const fixtures = patch([{ id: 'S1', layers: 2 }, { id: 'A1', layers: 1 }]);
  assert.deepEqual(feedsFor(fixtures).map((f) => [f.id, f.name]), [
    ['screen-S1', 'LivePremier Plus S1'], ['screen-A1', 'LivePremier Plus A1'], ['layers', 'LivePremier Plus layers'],
  ]);
  assert.deepEqual(feedsFor(fixtures, { perLayer: true }).slice(3).map((f) => f.name),
    ['LivePremier Plus S1 L1', 'LivePremier Plus S1 L2', 'LivePremier Plus A1 L1']);
  assert.deepEqual(feedsFor([{ kind: 'master', id: 'M' }]), [], 'no layers patched, no feeds');
});

test('ndi: sources are named as the desk\'s libraries name them, and only inputs and stills have pictures', () => {
  const libs = libraries(FACTS);
  assert.equal(sourceName(libs, 'LIVE_3'), 'IN3 Playback');
  assert.equal(sourceName(libs, 'INPUT_1'), 'IN1 Camera 1', 'a Midra\'s inputs are live inputs');
  assert.equal(sourceName(libs, 'STILL_2'), 'IMG2 Logo');
  assert.equal(sourceName(libs, 'LIVE_2'), 'IN2', 'an input the switcher does not list, by number');
  assert.equal(sourceName(libs, 'NONE'), 'Black');
  assert.equal(sourceName(libs, null), 'Black');
  assert.equal(sourceName(libs, 'COLOR'), 'Colour');
  assert.equal(imageKey('LIVE_3'), 'LIVE_3');
  assert.equal(imageKey('INPUT_2'), 'INPUT_2');
  assert.equal(imageKey('STILL_9'), 'STILL_9');
  assert.equal(imageKey('COLOR'), null);
  assert.equal(imageKey('SCREEN_1'), null);
});

test('ndi: a screen\'s program puts each layer where the switcher has it, scaled to the picture, its snapshot at its opacity', () => {
  const look = { canvas: { width: 3840, height: 1080 }, layers: [
    { layer: 1, source: 'LIVE_3', rect: { left: 1920, top: 0, width: 1920, height: 1080 }, opacity: 1 },
    { layer: 2, source: 'COLOR', rect: { left: 0, top: 540, width: 960, height: 540 }, opacity: 0.5 },
  ] };
  const red = blank(16, 9, [255, 0, 0]);
  const size = { width: 1280, height: 720 };
  const scene = screenScene('S1', look, { size, facts: FACTS, images: { LIVE_3: red } });
  /* 3840 × 1080 fitted into 1280 × (720 − the title band): 1280 wide, 360 tall, centred below the band. */
  const image = scene.ops.find((o) => o.op === 'image');
  assert.equal(image.image, 'LIVE_3');
  assert.deepEqual(image.rect, { x: 640, y: 50 + (670 - 360) / 2, w: 640, h: 360 });
  const colour = scene.ops.find((o) => o.op === 'fill' && o.opacity === 0.5);
  assert.deepEqual(colour.rect, { x: 0, y: 50 + (670 - 360) / 2 + 180, w: 320, h: 180 });
  const labels = scene.ops.filter((o) => o.op === 'text').map((o) => o.text);
  assert.deepEqual(labels, ['L1 IN3 Playback', 'L2 Colour 50%', 'S1 PROGRAM   3840 × 1080']);
  assert.deepEqual(scene.ops.find((o) => o.op === 'text').rgb, layerColour(1));
  const pic = render(scene, { LIVE_3: red });
  assert.deepEqual(at(pic, 960, 360), [255, 0, 0], 'the input where layer 1 is');
  assert.deepEqual([pic.width, pic.height], [1280, 720]);
  /* Labels come after every layer, so the top layer never hides a name. */
  const lastLayerOp = Math.max(...scene.ops.map((o, i) => (o.op === 'image' || (o.op === 'fill' && o.opacity === 0.5) ? i : -1)));
  assert.ok(scene.ops.findIndex((o) => o.op === 'text') > lastLayerOp);
});

test('ndi: two layers with the same top edge stack their labels rather than print one over the other', () => {
  const full = { left: 0, top: 0, width: 1920, height: 1080 };
  const look = { canvas: { width: 1920, height: 1080 }, layers: [
    { layer: 1, source: 'LIVE_1', rect: full, opacity: 1 },
    { layer: 2, source: 'NONE', rect: full, opacity: 0 },
  ] };
  const scene = screenScene('S1', look, { size: { width: 1280, height: 720 }, facts: FACTS });
  const bands = scene.ops.filter((o) => o.op === 'fill' && o.opacity === 0.6).map((o) => o.rect);
  assert.equal(bands.length, 2);
  assert.equal(bands[1].y, bands[0].y + bands[0].h, 'the second under the first');
  assert.deepEqual(scene.ops.filter((o) => o.op === 'text').slice(0, 2).map((o) => o.text), ['L1 IN1 Camera 1', 'L2 Black 0%']);
});

test('ndi: a screen whose size or layers could not be read still draws, and says so', () => {
  const scene = screenScene('S2', null, { size: { width: 1280, height: 720 }, facts: null });
  assert.equal(scene.ops.filter((o) => o.op === 'image').length, 0);
  assert.match(scene.ops.at(-1).text, /S2 PROGRAM\s+size not read/);
  assert.deepEqual([render(scene).width, render(scene).height], [1280, 720]);
});

test('ndi: the layers as tiles in patch order, each with its screen and layer, its source and its opacity', () => {
  const fixtures = patch([{ id: 'S1', layers: 2 }, { id: 'S2', layers: 1 }]);
  const looks = new Map([['S1', { canvas: null, layers: [
    { layer: 1, source: 'LIVE_1', rect: { left: 0, top: 0, width: 10, height: 10 }, opacity: 1 },
    { layer: 2, source: 'STILL_2', rect: { left: 0, top: 0, width: 10, height: 10 }, opacity: 0.25 },
  ] }]]);
  const scene = layersScene(fixtures, looks, { size: { width: 1280, height: 720 }, facts: FACTS, images: {} });
  const texts = scene.ops.filter((o) => o.op === 'text').map((o) => o.text);
  assert.deepEqual(texts, ['S1 L1', 'IN1 Camera 1', 'S1 L2', 'IMG2 Logo 25%', 'S2 L1', 'not read']);
  const tiles = scene.ops.filter((o) => o.op === 'stroke').map((o) => o.rect);
  assert.equal(tiles.length, 3);
  assert.ok(tiles.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= 1280 && r.y + r.h <= 720), 'every tile inside the picture');
  assert.ok(tiles[0].w > 300, 'three tiles fill a 720p picture in one row');
  const one = layerScene(fixtures[1], looks, { facts: FACTS });
  assert.deepEqual([one.width, one.height], [TILE_SIZE.width, TILE_SIZE.height]);
  assert.deepEqual(one.ops.filter((o) => o.op === 'text').map((o) => o.text), ['S1 L1', 'IN1 Camera 1']);
});

test('ndi: the settings are off, at 720p and without a feed per layer until asked, and a change to them is a change', () => {
  const d = normaliseDesk({});
  assert.equal(d.deskNdi, false);
  assert.equal(d.deskNdiSize, '720p');
  assert.equal(d.deskNdiPerLayer, false);
  assert.equal(normaliseDesk({ deskNdi: 'yes', deskNdiSize: '4k' }).deskNdiSize, '720p');
  assert.equal(normaliseDesk({ deskNdi: 'yes' }).deskNdi, false);
  assert.ok(NDI_SIZES.some((z) => z.id === '1080p'));
  assert.equal(deskChanged(d, normaliseDesk({ deskNdi: true })), true);
  assert.equal(deskChanged(d, normaliseDesk({ deskNdiSize: '1080p' })), true);
  assert.equal(deskChanged(d, normaliseDesk({ deskNdiPerLayer: true })), true);
});

/* ------------------------------------------------------------------ the runtime */

test('ndi runtime: looked for where NDI Tools and the SDK put it, the app\'s own bundle first, an env override before that', () => {
  const mac = candidates({ platform: 'darwin', env: {}, execPath: '/Applications/LivePremier Plus.app/Contents/Resources/node' });
  assert.equal(mac[0], '/Applications/LivePremier Plus.app/Contents/Frameworks/libndi.dylib');
  assert.ok(mac.includes('/usr/local/lib/libndi.dylib'));
  assert.ok(mac.includes('/Library/NDI SDK for Apple/lib/macOS/libndi.dylib'));
  assert.equal(candidates({ platform: 'darwin', env: { NDI_RUNTIME_DIR_V6: '/x' } })[0], '/x/libndi.dylib');
  assert.ok(candidates({ platform: 'win32', env: { NDI_RUNTIME_DIR_V6: 'C:\\NDI' } })[0].endsWith('Processing.NDI.Lib.x64.dll'));
  assert.ok(candidates({ platform: 'linux', env: {} }).includes('/usr/lib/libndi.so.6'));
});

test('ndi runtime: without koffi, or with no runtime found, it says why rather than throwing', async () => {
  const noKoffi = await loadNdi({ importer: async () => { const e = new Error('Cannot find package koffi'); e.code = 'ERR_MODULE_NOT_FOUND'; throw e; } });
  assert.equal(noKoffi.lib, null);
  assert.match(noKoffi.reason, /npm run setup:devices/);
  const none = await loadNdi({ importer: async () => ({ default: {} }), exists: () => false });
  assert.equal(none.lib, null);
  assert.match(none.reason, /ndi\.video\/tools/);
});

/* ------------------------------------------------------------------ the media host's core */

function pretendRuntime({ connections = 0 } = {}) {
  const made = [];
  const destroyed = [];
  const sent = [];
  let n = connections;
  const lib = {
    path: '/pretend', version: '6.0.0',
    create: (name) => { if (name === 'refuse') throw new Error('no'); const inst = { name }; made.push(inst); return inst; },
    destroy: (inst) => destroyed.push(inst.name),
    fullName: (inst) => `HOST (${inst.name})`,
    connections: () => n,
    send: (inst, pic) => sent.push({ name: inst.name, pic }),
  };
  return { lib, made, destroyed, sent, setConnections: (v) => { n = v; } };
}

test('media core: says hello with the runtime, makes and drops senders to match the feeds asked for', () => {
  const rt = pretendRuntime();
  const said = [];
  const core = createMediaCore({ ndi: { lib: rt.lib, reason: null }, send: (m) => said.push(m), pollMs: 10_000 });
  try {
    assert.deepEqual(said[0], { type: 'hello', available: true, reason: null, runtime: { path: '/pretend', version: '6.0.0' } });
    core.handle({ op: 'feeds', feeds: [{ id: 'a', name: 'LPP S1' }, { id: 'b', name: 'LPP layers' }, { id: 'c', name: 'bad/name' }] });
    assert.deepEqual(rt.made.map((i) => i.name), ['LPP S1', 'LPP layers'], 'a name NDI cannot carry is refused');
    assert.deepEqual(said.at(-1).feeds.map((f) => [f.id, f.fullName]), [['a', 'HOST (LPP S1)'], ['b', 'HOST (LPP layers)']]);
    core.handle({ op: 'feeds', feeds: [{ id: 'a', name: 'LPP S1' }] });
    assert.deepEqual(rt.destroyed, ['LPP layers']);
    core.handle({ op: 'feeds', feeds: [{ id: 'a', name: 'LPP S1 renamed' }] });
    assert.deepEqual(rt.destroyed, ['LPP layers', 'LPP S1'], 'a new name is a new sender');
    core.handle({ op: 'feeds', feeds: [{ id: 'z', name: 'refuse' }] });
    assert.equal(said.at(-1).feeds[0].error, 'no');
  } finally { core.stop(); }
});

test('media core: a frame is drawn and sent to its feed; a size no desk takes, or a feed it does not have, is passed over', () => {
  const rt = pretendRuntime();
  const logs = [];
  const core = createMediaCore({ ndi: { lib: rt.lib }, send: () => {}, log: (t) => logs.push(t), pollMs: 10_000 });
  try {
    core.handle({ op: 'feeds', feeds: [{ id: 'a', name: 'LPP S1' }] });
    const img = blank(2, 2, [0, 0, 255]);
    core.handle({ op: 'frame', id: 'a', scene: { width: 64, height: 36, background: [5, 5, 5], ops: [{ op: 'image', rect: { x: 0, y: 0, w: 32, h: 36 }, image: 'k' }] }, images: { k: img } });
    assert.equal(rt.sent.length, 1);
    assert.deepEqual(at(rt.sent[0].pic, 10, 10), [0, 0, 255]);
    assert.deepEqual(at(rt.sent[0].pic, 50, 10), [5, 5, 5]);
    core.handle({ op: 'frame', id: 'a', scene: { width: 10_000, height: 36 } });
    core.handle({ op: 'frame', id: 'nope', scene: { width: 64, height: 36 } });
    assert.equal(rt.sent.length, 1);
    assert.match(logs.join('\n'), /10000 × 36 picture is not one to send/);
    assert.equal(core.feeds.get('a').frames, 1);
  } finally { core.stop(); }
});

test('media core: with no runtime it says why, and every feed carries the reason', () => {
  const said = [];
  const core = createMediaCore({ ndi: { lib: null, reason: 'No NDI runtime on this machine.' }, send: (m) => said.push(m), pollMs: 10_000 });
  try {
    assert.equal(said[0].available, false);
    assert.equal(said[0].reason, 'No NDI runtime on this machine.');
    core.handle({ op: 'feeds', feeds: [{ id: 'a', name: 'LPP S1' }] });
    core.handle({ op: 'frame', id: 'a', scene: { width: 64, height: 36 } });
    assert.equal(said.at(-1).feeds[0].error, 'no NDI runtime');
  } finally { core.stop(); }
});

test('media core: receivers are counted on a poll, and a change in them or in frames sent is reported', async () => {
  const rt = pretendRuntime();
  const said = [];
  const core = createMediaCore({ ndi: { lib: rt.lib }, send: (m) => said.push(m), pollMs: 20 });
  try {
    core.handle({ op: 'feeds', feeds: [{ id: 'a', name: 'LPP S1' }] });
    const before = said.length;
    rt.setConnections(2);
    await until(() => said.slice(before).some((m) => m.type === 'feeds' && m.feeds[0].connections === 2), 1000, 'the receivers reported');
    const quiet = said.length;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(said.length, quiet, 'nothing changed, nothing said');
    core.handle({ op: 'frame', id: 'a', scene: { width: 32, height: 18 } });
    await until(() => said.slice(quiet).some((m) => m.type === 'feeds' && m.feeds[0].frames === 1), 1000, 'the frame count reported');
  } finally { core.stop(); }
});

/* ------------------------------------------------------------------ the host, forked */

test('media host: findMediaHost needs devices/ installed; absent, the service answers with the reason', () => {
  const nowhere = findMediaHost(mkdtempSync(join(tmpdir(), 'lpp-media-')));
  assert.equal(nowhere.installed, false);
  assert.match(nowhere.reason, /no media host/);
  const here = findMediaHost(ROOT);
  assert.equal(here.entry, join(ROOT, 'devices', 'media-host.js'));
  assert.equal(here.installed, existsSync(join(ROOT, 'devices', 'node_modules', 'koffi', 'package.json')));
  const absent = absentMedia('nothing here');
  const client = absent.client('desk-control');
  assert.equal(client.available, false);
  assert.equal(client.reason, 'nothing here');
  client.setFeeds([{ id: 'a', name: 'LPP S1' }]);
  assert.equal(client.frame('a', { width: 32, height: 18 }), false);
  assert.deepEqual(client.feeds().map((f) => f.id), ['a']);
});

test('media host: forked with its pretend runtime, it makes the feeds asked for, draws what it is sent, and makes them again after a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lpp-media-'));
  const out = join(dir, 'sent.json');
  const env = process.env.LPP_TEST_NDI_OUT;
  process.env.LPP_TEST_NDI_OUT = out;
  const logs = [];
  const host = createMediaHost({
    entry: join(ROOT, 'devices', 'media-host.js'),
    args: ['--ndi', join(ROOT, 'test', 'helpers', 'fake-ndi.js')],
    log: (t) => logs.push(t), restartMinMs: 50,
  });
  try {
    host.start();
    await until(() => host.api.status().available, 5000, 'the host up with its runtime');
    assert.equal(host.api.status().runtime.version, '6.0.0-test');
    const client = host.api.client('desk-control');
    const other = host.api.client('someone-else');
    client.setFeeds([{ id: 'screen-S1', name: 'LivePremier Plus S1' }]);
    other.setFeeds([{ id: 'x', name: 'Another plugin' }]);
    await until(() => client.feeds()[0].fullName, 3000, 'the feed made');
    assert.deepEqual(client.feeds().map((f) => [f.id, f.fullName]), [['screen-S1', 'TEST (LivePremier Plus S1)']]);
    assert.deepEqual(other.feeds().map((f) => f.fullName), ['TEST (Another plugin)'], 'each plugin\'s feeds are its own');
    await until(() => client.feeds()[0].connections === 1, 3000, 'its receiver counted');
    /* A 1280 × 720 picture with a 640 × 360 image in it, across the channel as bytes. */
    const img = blank(640, 360, [255, 128, 0]);
    assert.equal(client.frame('screen-S1', { width: 1280, height: 720, background: [0, 0, 40], ops: [{ op: 'image', rect: { x: 320, y: 180, w: 640, h: 360 }, image: 'LIVE_1' }] }, { LIVE_1: img }), true);
    assert.equal(client.frame('nope', { width: 32, height: 18 }), false, 'not one of its feeds');
    await until(() => existsSync(out) && JSON.parse(readFileSync(out, 'utf8')).length, 3000, 'the frame drawn and sent');
    const [first] = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(first, { name: 'LivePremier Plus S1', width: 1280, height: 720, centre: [255, 128, 0], corner: [0, 0, 40] });
    await until(() => client.feeds()[0].frames === 1, 3000, 'the frame counted');
    /* It dies; it comes back, and both plugins' feeds are made again without being asked. */
    rmSync(out);
    const pid = host.api.status().pid;
    assert.ok(pid);
    process.kill(pid, 'SIGKILL');
    await until(() => host.api.status().restarts === 1 && host.api.status().pid && host.api.status().pid !== pid, 5000, 'the host restarted');
    await until(() => client.feeds()[0].fullName && other.feeds()[0].fullName, 5000, 'both plugins\' feeds made again');
    assert.equal(client.feeds()[0].frames, 0, 'a new host, a new count');
    assert.equal(client.frame('screen-S1', { width: 64, height: 36, background: [9, 9, 9] }), true);
    await until(() => existsSync(out), 3000, 'a frame from the new host');
    assert.ok(logs.some((t) => /host exited \(SIGKILL\)/.test(t)));
  } finally {
    await host.stop();
    if (env === undefined) delete process.env.LPP_TEST_NDI_OUT; else process.env.LPP_TEST_NDI_OUT = env;
    rmSync(dir, { recursive: true, force: true });
  }
});
