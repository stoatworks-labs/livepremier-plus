/*
 * Desk control's NDI feeds, live: the app's own `desk-control` plugin with
 * NDI on, the real media host and the real NDI runtime on this machine, the
 * simulator behind it, and an NDI receiver in this process standing in for
 * the desk. Skipped without the runtime or without `devices/` installed.
 *
 * One write: S1's program layer 1 opacity, to see a change reach the
 * picture, under `guardScreen`, which puts S1 back. The simulator has no
 * snapshots, so every source is drawn as its card colour: that is what is
 * checked, pixel by pixel, allowing for NDI's compression.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { SKIP, ROOT, startApp, Link, sag, layerPath, sleep, guardScreen } from './harness.js';
import { createMediaHost, findMediaHost } from '../../server/media-host.js';
import { ndiReceiver } from '../helpers/ndi-receiver.js';
import { anchorToTopLeft } from '../../src/core/screens.js';
import { SWATCHES } from '../../plugins/desk-control/media.js';

const found = findMediaHost(ROOT);
const rx = SKIP ? { open: null, reason: SKIP } : ndiReceiver(ROOT);
const skip = SKIP || (!found.installed && found.reason) || (!rx.open && rx.reason) || false;

let media;
let app;
let link;
const opened = [];

const SETTINGS = { deskEnabled: true, deskNdi: true, deskDestinations: ['S1'], deskLayers: 2, deskAllow: ['127.0.0.1'] };
const SIZE = { width: 1280, height: 720 };
/* SpeedHQ is 4:2:2 and lossy: a flat colour comes back within a few levels. */
const near = (a, b, tol = 12) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const at = (pic, x, y) => { const i = (Math.round(y) * pic.width + Math.round(x)) * 4; return [...pic.data.slice(i, i + 3)]; };

const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  return null;
};

/** S1's program layers as the simulator reports them, in canvas pixels. */
function programLook() {
  const t = link.get(sag('S1', 'status', 'transition'));
  const letter = link.get(sag('S1', 'control', String(t).endsWith('DOWN') ? 'presetDown' : 'presetUp'));
  const pp = (l, group, prop) => link.get(layerPath('S1', letter, l, group, 'pp', prop));
  const canvas = { width: link.get(['device', 'screenList', 'items', 'S1', 'status', 'size', 'pp', 'sizeH']), height: link.get(['device', 'screenList', 'items', 'S1', 'status', 'size', 'pp', 'sizeV']) };
  const layers = [1, 2].map((l) => {
    const w = pp(l, 'position', 'sizeH');
    const h = pp(l, 'position', 'sizeV');
    const { left, top } = anchorToTopLeft(pp(l, 'position', 'anchor'), pp(l, 'position', 'posH'), pp(l, 'position', 'posV'), w, h);
    return { layer: l, source: pp(l, 'source', 'inputNum') || 'NONE', opacity: (pp(l, 'opacity', 'opacity') ?? 256) / 256, rect: { left, top, width: w, height: h } };
  });
  return { letter, canvas, layers };
}

/** Where a canvas point lands in the 720p picture: below a 50-pixel title band, the canvas fitted in what is left. */
function toPicture(canvas, x, y) {
  const band = Math.round(SIZE.height * 0.07);
  const k = Math.min(SIZE.width / canvas.width, (SIZE.height - band) / canvas.height);
  const ox = (SIZE.width - canvas.width * k) / 2;
  const oy = band + (SIZE.height - band - canvas.height * k) / 2;
  return [ox + x * k, oy + y * k];
}

const swatch = (source) => SWATCHES[(/^([A-Z]+)/.exec(source) || [, 'NONE'])[1]] || SWATCHES.NONE;

/**
 * A canvas point clear of every layer's outline and label band, and the
 * colour the picture should have there: each layer covering it, bottom first,
 * its card colour at its opacity over what is below, over black.
 */
function sample(look) {
  /* A label band is at most 5% of the picture's height: 36 pixels at 720p. */
  const band = 36;
  const k = (toPicture(look.canvas, 1000, 0)[0] - toPicture(look.canvas, 0, 0)[0]) / 1000;
  const clear = (x, y) => look.layers.every(({ rect: r }) => {
    const inside = x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
    if (!inside) return true;
    /* In picture pixels: away from the edges, and below where two stacked label bands could reach. */
    return (x - r.left) * k > 6 && (r.left + r.width - x) * k > 6 && (y - r.top) * k > 2 * band + 6 && (r.top + r.height - y) * k > 6;
  });
  for (const fy of [0.6, 0.75, 0.9, 0.45]) {
    for (const fx of [0.5, 0.3, 0.7, 0.1, 0.9]) {
      const x = look.canvas.width * fx;
      const y = look.canvas.height * fy;
      if (!clear(x, y)) continue;
      let c = [0, 0, 0];
      for (const l of look.layers) {
        const r = l.rect;
        if (!(x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height)) continue;
        c = c.map((v, i) => v * (1 - l.opacity) + swatch(l.source)[i] * l.opacity);
      }
      return { at: toPicture(look.canvas, x, y), want: c.map(Math.round) };
    }
  }
  return null;
}

before(async () => {
  if (skip) return;
  media = createMediaHost({ ...found, log: () => {} });
  media.start();
  app = await startApp({ media: media.api });
  link = await Link.open(app);
  await app.configure({ plugins: { 'desk-control': { enabled: true, settings: SETTINGS } } });
});

after(async () => {
  for (const r of opened) r.close();
  rx.close?.();
  link?.close();
  await app?.close();
  await media?.stop();
});

test('the feeds are on the network under their names, and the card says which runtime made them', { skip }, async () => {
  for (const name of ['LivePremier Plus S1', 'LivePremier Plus layers']) {
    assert.ok(await rx.find(name, 15_000), `${name} found by NDI discovery`);
  }
  const ndi = await until(async () => {
    const n = (await app.api('/desk-control/state')).json?.ndi;
    return n && n.available && n.feeds.length === 2 && n.feeds.every((f) => f.fullName) ? n : null;
  });
  assert.ok(ndi, 'the state lists both feeds, made');
  assert.match(ndi.runtime.version, /^\d+\.\d+/);
  assert.deepEqual(ndi.feeds.map((f) => f.name), ['LivePremier Plus S1', 'LivePremier Plus layers']);
});

test('S1\'s feed draws layer 1 where the simulator has it on program, in its card colour', { skip }, async () => {
  const r = await rx.open('LivePremier Plus S1');
  assert.ok(r, 'connected');
  opened.push(r);
  const t0 = Date.now();
  const first = await r.next(8000);
  assert.ok(first, 'a frame within 8 s of connecting');
  console.log(`# first S1 frame ${first.at - t0} ms after connecting`);
  assert.deepEqual([first.width, first.height], [SIZE.width, SIZE.height]);
  const look = programLook();
  const point = sample(look);
  assert.ok(point, 'somewhere to look clear of outlines and labels');
  const [px, py] = point.at;
  /* The next frame, to be sure of a whole one drawn after the read. */
  const pic = (await r.next(3000)) || first;
  assert.ok(near(at(pic, px, py), point.want), `at (${Math.round(px)}, ${Math.round(py)}): ${at(pic, px, py)}, wanted about ${point.want} (${look.layers.map((l) => `L${l.layer} ${l.source} ${l.opacity}`).join(', ')})`);
  const s1 = await until(async () => (await app.api('/desk-control/state')).json.ndi.feeds.find((f) => f.id === 'screen-S1' && f.connections >= 1 && f.frames >= 1));
  assert.ok(s1, 'the receiver and the frames counted');
});

test('the layers feed shows each patched layer\'s program source as a tile', { skip }, async () => {
  const r = await rx.open('LivePremier Plus layers');
  assert.ok(r, 'connected');
  opened.push(r);
  const pic = await r.next(8000);
  assert.ok(pic, 'a frame');
  const look = programLook();
  /* Two tiles fill a 720p picture side by side: each tile's picture is the top 76% of it. Sample the middle of each. */
  assert.ok(await until(async () => (await app.api('/desk-control/state')).json.ndi.feeds.find((f) => f.id === 'layers' && f.frames > 0)), 'frames counted');
  const quarter = [SIZE.width * 0.25, SIZE.width * 0.75];
  for (const [i, l] of look.layers.entries()) {
    const c = at(pic, quarter[i], SIZE.height * 0.4);
    assert.ok(near(c, swatch(l.source)), `tile ${i + 1} (${l.source}): ${c}, wanted about ${swatch(l.source)}`);
  }
});

test('a change on the switcher reaches the picture: layer 1 at half opacity is drawn at half', { skip }, async () => {
  const guard = await guardScreen(link, 'S1');
  const r = opened[0];
  try {
    const look = programLook();
    const was = link.get(layerPath('S1', look.letter, 1, 'opacity', 'pp', 'opacity'));
    const to = was === 128 ? 256 : 128;
    const t0 = Date.now();
    link.send({ path: layerPath('S1', look.letter, 1, 'opacity', 'pp', 'opacity'), value: to });
    await link.waitFor(layerPath('S1', look.letter, 1, 'opacity', 'pp', 'opacity'), to);
    const point = sample({ ...look, layers: look.layers.map((l) => (l.layer === 1 ? { ...l, opacity: to / 256 } : l)) });
    const [px, py] = point.at;
    const want = point.want;
    let seen = null;
    while (!seen && Date.now() - t0 < 6000) {
      const pic = await r.next(2000);
      if (pic && near(at(pic, px, py), want)) seen = pic;
    }
    assert.ok(seen, `layer 1 drawn at ${to}/256 within 6 s`);
    console.log(`# opacity ${was} → ${to} in the picture ${seen.at - t0} ms after it was written`);
  } finally {
    await guard.restore();
  }
});

test('switched off, the feeds go', { skip }, async () => {
  await app.configure({ plugins: { 'desk-control': { enabled: true, settings: { ...SETTINGS, deskNdi: false } } } });
  const gone = await until(async () => (await app.api('/desk-control/state')).json?.ndi === null);
  assert.ok(gone, 'the card shows no NDI');
  await until(() => media.api.status().feeds.length === 0);
  assert.deepEqual(media.api.status().feeds, []);
  const still = await until(() => !rx.names().some((s) => s.name.endsWith('(LivePremier Plus S1)')), 15_000);
  console.log(`# S1 ${still ? 'gone from' : 'still in'} NDI discovery 15 s after`);
});
