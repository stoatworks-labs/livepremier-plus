/*
 * Thumbnail relay: the codec, the bookkeeping, and the proxy with the plugin
 * off and on.
 *
 * The switcher's thumbnails are imitated the way its firmware writes them —
 * 8-bit RGBA, stored uncompressed — so the sizes here are the sizes a Pulse
 * sends. The JPEG encoder is checked against an independent decoder (PIL)
 * where one is installed; the structural checks run everywhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng, readHeader, isPng } from '../plugins/snapshot-relay/png.js';
import { encodeJpeg } from '../plugins/snapshot-relay/jpeg.js';
import { fitWidth } from '../plugins/snapshot-relay/resize.js';
import { createRelay, createHotSet } from '../plugins/snapshot-relay/relay.js';
import { snapshotPath, bump, findHot, createHotTracker } from '../plugins/snapshot-relay/hot.js';
import { createEncoder } from '../plugins/snapshot-relay/encoder.js';
import { normalise, ageLimit, DEFAULTS, SNAPSHOT_PATH } from '../plugins/snapshot-relay/core.js';
import { manifestOf, isSwitchedOn } from '../src/core/plugins.js';
import { createProxy } from '../server/proxy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A frame shaped like a camera: gradients, a disc, and a little texture. */
function frame(width, height, seed = 0) {
  const d = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      d[p] = (x * 255) / width;
      d[p + 1] = (y * 255) / height;
      d[p + 2] = (Math.sin((x + seed * 7) / 9) * Math.cos(y / 7) + 1) * 127;
      d[p + 3] = 255;
      if ((x - width / 2 - seed * 4) ** 2 + (y - height / 2) ** 2 < 900) { d[p] = 240; d[p + 1] = 30; d[p + 2] = 30; }
    }
  }
  return d;
}

/** What the firmware sends: RGBA8, stored. */
const devicePng = (seed = 0, w = 512, h = 288) => encodePng(frame(w, h, seed), w, h, { level: 0 });

/* ------------------------------------------------------------------ codec */

test('a device-shaped PNG is the size a Pulse sends', () => {
  const png = devicePng();
  /* 591,155 bytes from the real unit; the stored-deflate framing differs by
     a few hundred bytes from whatever zlib the firmware links. */
  assert.ok(Math.abs(png.length - 591155) < 2000, `${png.length}`);
  assert.deepEqual(readHeader(png), { width: 512, height: 288, bitDepth: 8, colorType: 6, interlace: 0 });
});

test('every row filter decodes back to the exact pixels', () => {
  const rgba = frame(37, 23, 3);
  for (const filter of [0, 1, 2, 3, 4]) {
    const out = decodePng(encodePng(rgba, 37, 23, { filter }));
    assert.equal(out.width, 37);
    assert.deepEqual(Buffer.from(out.data), Buffer.from(rgba), `filter ${filter}`);
  }
});

/** A PNG of any colour type, written by hand, for the paths encodePng never takes. */
function handmadePng({ width, height, bitDepth, colorType, rows, plte = null, trns = null }) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(tb));
    return Buffer.concat([len, tb, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth; ihdr[9] = colorType;
  const raw = Buffer.concat(rows.map((r) => Buffer.from([0, ...r])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(plte ? [chunk('PLTE', Buffer.from(plte))] : []),
    ...(trns ? [chunk('tRNS', Buffer.from(trns))] : []),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

test('palette, grey and 16-bit images decode — the simulators send palettes', () => {
  /* 2-bit palette, four colours, the last one half transparent. */
  const pal = handmadePng({
    width: 4, height: 1, bitDepth: 2, colorType: 3,
    rows: [[0b00011011]],
    plte: [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255],
    trns: [255, 255, 255, 128]
  });
  assert.deepEqual([...decodePng(pal).data],
    [0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 128]);

  const grey = handmadePng({ width: 2, height: 1, bitDepth: 8, colorType: 0, rows: [[10, 200]] });
  assert.deepEqual([...decodePng(grey).data], [10, 10, 10, 255, 200, 200, 200, 255]);

  const deep = handmadePng({ width: 1, height: 1, bitDepth: 16, colorType: 2, rows: [[0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]] });
  assert.deepEqual([...decodePng(deep).data], [0x12, 0x56, 0x9a, 255]);

  assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
});

test('the JPEG is well formed, the right size, and a fraction of the PNG', () => {
  const rgba = frame(512, 288);
  const jpeg = encodeJpeg(rgba, 512, 288, DEFAULTS.quality);
  assert.equal(jpeg[0], 0xff); assert.equal(jpeg[1], 0xd8);
  assert.equal(jpeg[jpeg.length - 2], 0xff); assert.equal(jpeg[jpeg.length - 1], 0xd9);
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.equal(jpeg.readUInt16BE(sof + 5), 288);
  assert.equal(jpeg.readUInt16BE(sof + 7), 512);
  assert.ok(jpeg.length < devicePng().length / 15, `${jpeg.length} bytes`);
  /* Odd sizes and white noise exercise the edge padding and every Huffman code. */
  const noise = new Uint8Array(517 * 291 * 4).map(() => Math.random() * 256);
  assert.ok(encodeJpeg(noise, 517, 291, 100).length > 0);
  assert.ok(encodeJpeg(noise.subarray(0, 12), 1, 3, 30).length > 0);
});

test('an independent decoder reads the JPEG back close to the source', async (t) => {
  const probe = spawnSync('python3', ['-c', 'import PIL, numpy'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('python3 with PIL and numpy is not installed');
  const dir = await mkdtemp(join(tmpdir(), 'lpp-jpeg-'));
  try {
    const rgba = frame(517, 291, 2);
    await writeFile(join(dir, 'src.rgba'), rgba);
    await writeFile(join(dir, 'out.jpg'), encodeJpeg(rgba, 517, 291, 90));
    const script = [
      'import sys, math, numpy as np',
      'from PIL import Image',
      `src = np.frombuffer(open(sys.argv[1] + "/src.rgba", "rb").read(), dtype=np.uint8).reshape(291, 517, 4)[:, :, :3].astype(float)`,
      'im = Image.open(sys.argv[1] + "/out.jpg"); im.load()',
      'a = np.asarray(im.convert("RGB")).astype(float)',
      'w = [0.299, 0.587, 0.114]',
      'mse = (((a @ w) - (src @ w)) ** 2).mean()',
      'print(im.size[0], im.size[1], round(10 * math.log10(255 ** 2 / mse), 1))'
    ].join('\n');
    const r = spawnSync('python3', ['-c', script, dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const [w, h, psnr] = r.stdout.trim().split(' ').map(Number);
    assert.equal(w, 517); assert.equal(h, 291);
    /* Luma, where the eye is: at quality 90 a correct encoder is well past 40 dB. */
    assert.ok(psnr > 40, `luma PSNR ${psnr} dB`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fitWidth shrinks, keeps the aspect, and never enlarges', () => {
  const img = { width: 512, height: 288, data: frame(512, 288) };
  const small = fitWidth(img, 256);
  assert.equal(small.width, 256); assert.equal(small.height, 144);
  assert.equal(fitWidth(img, 0), img);
  assert.equal(fitWidth(img, 1024), img);
  /* A flat colour averages to itself. */
  const flat = { width: 10, height: 10, data: new Uint8Array(400).fill(77) };
  assert.ok(fitWidth(flat, 3).data.every((v) => v === 77));
});

test('settings are corrected, not refused', () => {
  assert.deepEqual(normalise({}), { ...DEFAULTS });
  assert.deepEqual(normalise({ quality: 500, maxWidth: 50, maxAgeMs: -4 }),
    { quality: 95, maxWidth: 128, maxAgeMs: 0, hotHz: DEFAULTS.hotHz, idleMs: DEFAULTS.idleMs });
  /* The tiers: 0 is off, not the bottom of the range; Hz go in halves. */
  assert.equal(normalise({ hotHz: 0 }).hotHz, 0);
  assert.equal(normalise({ hotHz: 0.2 }).hotHz, 0.5);
  assert.equal(normalise({ hotHz: 3.3 }).hotHz, 3.5);
  assert.equal(normalise({ hotHz: 99 }).hotHz, 10);
  assert.equal(normalise({ hotHz: 'fast' }).hotHz, DEFAULTS.hotHz);
  assert.equal(normalise({ idleMs: 0 }).idleMs, 0);
  assert.equal(normalise({ idleMs: 10 }).idleMs, 1000);
  assert.equal(normalise({ idleMs: 60000 }).idleMs, 15000);
  assert.equal(normalise({ maxWidth: 0 }).maxWidth, 0);
  assert.equal(normalise({ quality: 'x' }).quality, DEFAULTS.quality);
  assert.ok(SNAPSHOT_PATH.test('/api/device/snapshots/inputs/3'));
  assert.ok(SNAPSHOT_PATH.test('/api/device/snapshots/multiviewer'));
  assert.ok(SNAPSHOT_PATH.test('/api/device/snapshots/screens/1/back/2'));
  assert.ok(!SNAPSHOT_PATH.test('/api/device/snapshots/../stores/device'));
  assert.ok(!SNAPSHOT_PATH.test('/api/stores/device'));
});

test('the plugin is off until somebody switches it on', () => {
  assert.equal(manifestOf('snapshot-relay').enabledByDefault, false);
  assert.equal(isSwitchedOn({}, 'snapshot-relay'), false);
  assert.equal(isSwitchedOn({ 'snapshot-relay': { enabled: true } }, 'snapshot-relay'), true);
});

/* ------------------------------------------------------------- the relay */

/** A switcher in a script: `frames[path]` is what it answers now. */
function scripted() {
  const frames = {};
  const calls = [];
  return {
    frames,
    calls,
    fetch: async (path) => {
      calls.push(path);
      const body = frames[path];
      if (!body) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('nope') };
      return { status: 200, headers: { 'content-type': 'image/png' }, body };
    }
  };
}

const fakeTranscode = async (png) => ({ type: 'image/jpeg', body: Buffer.from(`jpeg:${png.length}`) });

test('pages asking within maxAgeMs share one fetch; after it, the switcher is asked again', async () => {
  const dev = scripted();
  let t = 1000;
  const relay = createRelay({ fetch: dev.fetch, transcode: fakeTranscode, settings: () => ({ maxAgeMs: 300 }), now: () => t });
  dev.frames['/api/device/snapshots/inputs/1'] = devicePng(1);

  const a = await relay.get('/api/device/snapshots/inputs/1');
  assert.equal(a.via, 'fresh');
  assert.equal(a.type, 'image/jpeg');
  t += 100;
  const b = await relay.get('/api/device/snapshots/inputs/1');
  assert.equal(b.via, 'shared');
  assert.equal(dev.calls.length, 1, 'one fetch for two pages');

  t += 500;
  const c = await relay.get('/api/device/snapshots/inputs/1');
  assert.equal(c.via, 'unchanged', 'asked again, same picture');
  assert.equal(c.etag, a.etag);
  assert.equal(dev.calls.length, 2);

  dev.frames['/api/device/snapshots/inputs/1'] = devicePng(2);
  t += 500;
  const d = await relay.get('/api/device/snapshots/inputs/1');
  assert.equal(d.via, 'fresh');
  assert.notEqual(d.etag, a.etag);

  const s = relay.stats();
  assert.equal(s.requests, 4);
  assert.equal(s.fetches, 3);
  assert.equal(s.shared, 1);
  assert.equal(s.unchanged, 1);
  assert.equal(s.encoded, 2, 'the unchanged frame was not encoded again');
  assert.equal(s.sources[0].path, 'inputs/1');
  /* Changes seen at t=1000 and t=2100; the unchanged fetch between them does not count. */
  assert.equal(s.sources[0].changeMs, 1100);
});

test('requests that overlap a fetch in flight wait for it rather than starting another', async () => {
  const dev = scripted();
  dev.frames['/api/device/snapshots/inputs/2'] = devicePng();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async (path) => { await gate; return dev.fetch(path); };
  const relay = createRelay({ fetch: slow, transcode: fakeTranscode, settings: () => ({ maxAgeMs: 0 }) });
  const both = Promise.all([relay.get('/api/device/snapshots/inputs/2'), relay.get('/api/device/snapshots/inputs/2')]);
  release();
  const [a, b] = await both;
  assert.equal(dev.calls.length, 1);
  assert.equal(a.via, 'fresh');
  assert.equal(b.via, 'shared');
  assert.deepEqual(a.body, b.body);
});

test('what the relay cannot improve is passed through as it came', async () => {
  const dev = scripted();
  const relay = createRelay({ fetch: dev.fetch, transcode: fakeTranscode, settings: () => ({ maxAgeMs: 0 }) });

  const missing = await relay.get('/api/device/snapshots/inputs/9');
  assert.equal(missing.status, 404);
  assert.equal(missing.via, 'passthrough');

  /* A tiny placeholder would grow as a JPEG: the PNG is served. */
  const tiny = encodePng(new Uint8Array(4 * 4 * 4), 4, 4);
  dev.frames['/api/device/snapshots/inputs/3'] = tiny;
  const grown = createRelay({ fetch: dev.fetch, transcode: async () => ({ type: 'image/jpeg', body: Buffer.alloc(tiny.length + 10) }), settings: () => ({ maxAgeMs: 0 }) });
  const r = await grown.get('/api/device/snapshots/inputs/3');
  assert.equal(r.type, 'image/png');
  assert.deepEqual(r.body, tiny);

  /* An encoder that gives up — full, dead, or confused — leaves the PNG. */
  const refusing = createRelay({ fetch: dev.fetch, transcode: async () => null, settings: () => ({ maxAgeMs: 0 }) });
  const p = await refusing.get('/api/device/snapshots/inputs/3');
  assert.ok(isPng(p.body));
  assert.equal(refusing.stats().passthrough, 1);

  /* Unreachable is an error, for the proxy to report as it reports the rest. */
  const down = createRelay({ fetch: async () => { throw new Error('ECONNREFUSED'); }, transcode: fakeTranscode, settings: () => ({ maxAgeMs: 0 }) });
  await assert.rejects(down.get('/api/device/snapshots/inputs/1'), /ECONNREFUSED/);
  assert.equal(down.stats().errors, 1);
});

test('the worker encoder turns a device PNG into a JPEG, and gives up rather than queue', async () => {
  const enc = createEncoder({ settings: () => ({ quality: 70, maxWidth: 256 }) });
  try {
    const out = await enc.transcode(devicePng());
    assert.equal(out.type, 'image/jpeg');
    assert.equal(out.body[0], 0xff);
    const sof = out.body.indexOf(Buffer.from([0xff, 0xc0]));
    assert.equal(out.body.readUInt16BE(sof + 7), 256, 'resized in the worker');
    assert.equal(await enc.transcode(Buffer.from('garbage')), null);
    /* Nine at once: the ninth is not worth waiting for. */
    const burst = await Promise.all(Array.from({ length: 9 }, () => enc.transcode(devicePng())));
    assert.equal(burst.filter((r) => r === null).length, 1);
  } finally {
    await enc.stop();
  }
  assert.equal(await enc.transcode(devicePng()), null, 'stopped means stopped');
});

/* ---------------------------------------------------------- through the proxy */

function fakeSwitcher() {
  const seen = [];
  let seed = 0;
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (/^\/api\/device\/snapshots\/inputs\/[1-4](\?|$)/.test(req.url)) {
      const png = devicePng(seed);
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
      return res.end(png);
    }
    if (req.url.startsWith('/api/stores/device')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"device":{}}');
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('nope');
  });
  return { server, seen, next: () => { seed++; } };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); });

test('through the proxy: off, the switcher’s PNG; on, a JPEG; off again, the PNG', async () => {
  const sw = fakeSwitcher();
  const devicePort = await listen(sw.server);
  let saved = {};
  const storage = { loadSettings: async () => saved, saveSettings: async (s) => { saved = s; } };
  const proxy = await createProxy({ device: `127.0.0.1:${devicePort}`, root: ROOT, storage, log: () => {} });
  const port = await listen(proxy);
  const base = `http://127.0.0.1:${port}`;
  const snap = (q = Date.now()) => fetch(`${base}/api/device/snapshots/inputs/1?${q}`);
  const toggle = (enabled) => fetch(`${base}/__lpp/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plugins: { 'snapshot-relay': { enabled } } })
  });
  try {
    let res = await snap();
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-lpp-relay'), null, 'off by default: untouched');
    assert.ok((await res.arrayBuffer()).byteLength > 500_000);
    assert.equal((await fetch(`${base}/__lpp/snapshot-relay/state`)).status, 404);

    assert.equal((await toggle(true)).status, 200);
    res = await snap(1);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('x-lpp-relay'), 'fresh');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const jpeg = Buffer.from(await res.arrayBuffer());
    assert.equal(jpeg[0], 0xff); assert.equal(jpeg[1], 0xd8);
    assert.ok(jpeg.length < 60_000, `${jpeg.length} bytes`);
    const etag = res.headers.get('etag');

    /* A second page inside the window rides on the first fetch. */
    const before = sw.seen.length;
    res = await snap(2);
    assert.equal(res.headers.get('x-lpp-relay'), 'shared');
    await res.arrayBuffer();
    assert.equal(sw.seen.length, before, 'the switcher was not asked');

    /* An If-None-Match for the frame it has is a 304. */
    res = await fetch(`${base}/api/device/snapshots/inputs/1?3`, { headers: { 'if-none-match': etag } });
    assert.equal(res.status, 304);

    /* What it will not take goes to the switcher as before: a 404 stays a 404,
       and nothing outside the snapshot routes is touched. */
    res = await fetch(`${base}/api/device/snapshots/inputs/7?1`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'nope');
    res = await fetch(`${base}/api/stores/device`);
    assert.equal(res.headers.get('x-lpp-relay'), null);
    await res.text();

    const stats = await (await fetch(`${base}/__lpp/snapshot-relay/state`)).json();
    assert.ok(stats.requests >= 3);
    assert.ok(stats.bytesIn > stats.bytesOut * 10, 'the pages got a tenth of the bytes, or less');

    assert.equal((await toggle(false)).status, 200);
    res = await snap(4);
    assert.equal(res.headers.get('content-type'), 'image/png', 'off again, no restart');
    await res.arrayBuffer();
  } finally {
    await close(proxy);
    await close(sw.server);
  }
});

/* ------------------------------------------------------------- hot and idle */

test('each tier gets its own age limit, and nobody editing changes nothing', () => {
  const settings = { maxAgeMs: 300, hotHz: 2, idleMs: 4000 };
  assert.equal(ageLimit({ hot: true, editing: true, settings }), 250, 'half a 2 Hz period');
  assert.equal(ageLimit({ hot: true, editing: true, settings: { ...settings, hotHz: 10 } }), 50);
  assert.equal(ageLimit({ hot: false, editing: true, settings }), 4000, 'idle while somebody edits');
  assert.equal(ageLimit({ hot: false, editing: false, settings }), 300, 'nobody editing: as before');
  assert.equal(ageLimit({ hot: false, editing: true, settings: { ...settings, idleMs: 0 } }), 300, 'idle hold off');
  assert.equal(ageLimit({ hot: true, editing: true, settings: { ...settings, hotHz: 0 } }), 300, 'hot refresh off');
});

test('an idle source is answered from its kept frame until idleMs, and says so', async () => {
  const dev = scripted();
  let t = 0;
  const relay = createRelay({ fetch: dev.fetch, transcode: fakeTranscode, settings: () => ({ maxAgeMs: 300 }), now: () => t });
  const path = '/api/device/snapshots/inputs/5';
  dev.frames[path] = devicePng(1);
  assert.equal((await relay.get(path, {}, { maxAgeMs: 4000 })).via, 'fresh');
  t = 1500;
  assert.equal((await relay.get(path, {}, { maxAgeMs: 4000 })).via, 'idle');
  t = 1600;
  assert.equal((await relay.get(path, {}, { maxAgeMs: 4000 })).via, 'idle');
  assert.equal(dev.calls.length, 1, 'the switcher was asked once');
  t = 4100;
  assert.equal((await relay.get(path, {}, { maxAgeMs: 4000 })).via, 'unchanged', 'past idleMs it asks again');
  assert.equal(dev.calls.length, 2);
  /* Inside the share window it is sharing, not idling. */
  t = 4200;
  assert.equal((await relay.get(path, {}, { maxAgeMs: 4000 })).via, 'shared');
  const s = relay.stats();
  assert.equal(s.idle, 2);
  assert.equal(s.shared, 1);
});

test('hot lists are per page, held on a lease, and a union', () => {
  let t = 0;
  const hot = createHotSet({ leaseMs: 5000, now: () => t });
  assert.equal(hot.editing(), false);
  hot.set('a', ['/api/device/snapshots/inputs/1', '/api/device/snapshots/inputs/2']);
  hot.set('b', ['/api/device/snapshots/inputs/2', '/api/device/snapshots/inputs/10']);
  assert.deepEqual(hot.list(), ['/api/device/snapshots/inputs/1', '/api/device/snapshots/inputs/2', '/api/device/snapshots/inputs/10']);
  assert.equal(hot.editing(), true);
  t = 3000;
  hot.set('b', []);
  assert.equal(hot.has('/api/device/snapshots/inputs/10'), false, 'b stopped editing');
  assert.equal(hot.has('/api/device/snapshots/inputs/1'), true);
  t = 5500;
  assert.equal(hot.has('/api/device/snapshots/inputs/1'), false, 'a went quiet and its lease ran out');
  assert.equal(hot.editing(), false, 'b is still there, editing nothing');
  assert.equal(hot.pages(), 1);
});

/** Just enough of a page for the tracker: images, a canvas, a viewport. */
function fakePage() {
  const imgs = [];
  const add = (src, { canvas = false, own = false, visible = true } = {}) => {
    const attrs = { src };
    if (own) attrs['data-lpp-snapshot'] = src.split('?')[0];
    const img = {
      isConnected: true,
      getAttribute: (k) => attrs[k] ?? null,
      setAttribute: (k, v) => { attrs[k] = v; },
      hasAttribute: (k) => k in attrs,
      closest: (sel) => (canvas && sel === '.aw-preset-view' ? {} : null),
      getBoundingClientRect: () => (visible ? { width: 100, height: 56, top: 10, left: 10, bottom: 66, right: 110 } : { width: 100, height: 56, top: 2000, left: 10, bottom: 2056, right: 110 })
    };
    imgs.push(img);
    return img;
  };
  const timers = [];
  const doc = { hidden: false, querySelectorAll: () => imgs };
  const win = {
    innerWidth: 1200, innerHeight: 800,
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; }
  };
  return { add, doc, win, timers };
}

test('snapshot paths come out of any img src; a bump only changes the cache-buster', () => {
  assert.equal(snapshotPath('/api/device/snapshots/inputs/3?1790'), '/api/device/snapshots/inputs/3');
  assert.equal(snapshotPath('http://10.0.0.5/api/device/snapshots/outputs/2'), '/api/device/snapshots/outputs/2');
  assert.equal(snapshotPath('/api/stores/device'), null);
  assert.equal(snapshotPath(''), null);
  assert.equal(bump('/api/device/snapshots/inputs/3?1790', 42), '/api/device/snapshots/inputs/3?42');
});

test('only canvas thumbnails on screen are hot — never the Sources list', () => {
  const page = fakePage();
  page.add('/api/device/snapshots/inputs/1?1');                          /* a source card */
  page.add('/api/device/snapshots/inputs/2?1', { canvas: true });        /* a layer in S1 PRW */
  page.add('/api/device/snapshots/inputs/2?1', { canvas: true });        /* the same in PGM */
  page.add('/api/device/snapshots/inputs/3?1', { canvas: true, visible: false }); /* scrolled away */
  page.add('/api/device/snapshots/inputs/4?1', { own: true });           /* this app's Edit page */
  const hot = findHot(page.doc, page.win);
  assert.deepEqual([...hot.keys()].sort(), ['/api/device/snapshots/inputs/2', '/api/device/snapshots/inputs/4']);
  assert.equal(hot.get('/api/device/snapshots/inputs/2').length, 2);
});

test('the tracker reports changes, renews, clears once, and refreshes only hot images', async () => {
  const page = fakePage();
  const card = page.add('/api/device/snapshots/inputs/1?1');
  const layer = page.add('/api/device/snapshots/inputs/2?1', { canvas: true });
  const posts = [];
  let t = 1000;
  let hz = 2;
  const tracker = createHotTracker({ doc: page.doc, win: page.win, timers: page.win, post: (p) => { posts.push(p); }, settings: () => ({ hotHz: hz }), now: () => t });
  tracker.start();
  assert.deepEqual(posts, [['/api/device/snapshots/inputs/2']]);
  const refresh = page.timers.find((x) => x.ms === 500 && x.fn === tracker.refresh) || page.timers[1];
  assert.equal(refresh.ms, 500, '2 Hz');

  t = 1500; tracker.scan();
  assert.equal(posts.length, 1, 'nothing changed, not yet due');
  t = 3100; tracker.scan();
  assert.equal(posts.length, 2, 'renewed inside the lease');

  t = 3200; tracker.refresh();
  assert.equal(layer.getAttribute('src'), '/api/device/snapshots/inputs/2?3200');
  assert.equal(card.getAttribute('src'), '/api/device/snapshots/inputs/1?1', 'a source card is left to the vendor');

  page.doc.hidden = true; t = 3300; tracker.refresh();
  assert.equal(layer.getAttribute('src'), '/api/device/snapshots/inputs/2?3200', 'a hidden page asks for nothing');
  page.doc.hidden = false;

  /* The rate follows the setting. */
  hz = 4; tracker.scan();
  assert.ok(page.timers.some((x) => x.fn && x.ms === 250));

  /* Editing stops: one empty list, then quiet. */
  layer.isConnected = false;
  layer.closest = () => null;
  t = 4000; tracker.scan();
  assert.deepEqual(posts.at(-1), []);
  const n = posts.length;
  t = 9000; tracker.scan();
  assert.equal(posts.length, n, 'an empty list is not repeated');
  tracker.stop();
});

test('through the proxy: a page’s hot list makes the rest idle, and only while it is editing', async () => {
  const sw = fakeSwitcher();
  const devicePort = await listen(sw.server);
  let saved = { plugins: { 'snapshot-relay': { enabled: true, settings: { idleMs: 4000, hotHz: 2 } } } };
  const storage = { loadSettings: async () => saved, saveSettings: async (x) => { saved = x; } };
  const proxy = await createProxy({ device: `127.0.0.1:${devicePort}`, root: ROOT, storage, log: () => {} });
  const port = await listen(proxy);
  const base = `http://127.0.0.1:${port}`;
  const get = async (n, q) => {
    const res = await fetch(`${base}/api/device/snapshots/inputs/${n}?${q}`);
    await res.arrayBuffer();
    return res.headers.get('x-lpp-relay');
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const hot = (paths) => fetch(`${base}/__lpp/snapshot-relay/hot`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: 'test-page', paths })
  });
  try {
    /* Refused: not a snapshot path, or no page. */
    let res = await hot(['/api/stores/device', '/api/device/snapshots/inputs/1']);
    assert.deepEqual((await res.json()).hot, ['/api/device/snapshots/inputs/1'], 'only snapshot paths are taken');
    res = await fetch(`${base}/__lpp/snapshot-relay/hot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 400);

    /* Editing input 1: input 3 is idle. */
    assert.equal(await get(3, 1), 'fresh');
    await wait(400);
    const before = sw.seen.length;
    assert.equal(await get(3, 2), 'idle', 'past the share window, but held');
    assert.equal(sw.seen.length, before, 'the switcher was not asked');

    /* The hot one is fetched on every refresh a page asks for. */
    assert.equal(await get(1, 1), 'fresh');
    await wait(300);
    assert.notEqual(await get(1, 2), 'idle');
    assert.ok(sw.seen.length > before, 'the hot source reached the switcher');

    /* Editing stops: input 3 is treated as it always was. */
    await hot([]);
    assert.equal(await get(3, 3), 'unchanged', 'asked again once nobody edits');

    const state = await (await fetch(`${base}/__lpp/snapshot-relay/state`)).json();
    assert.equal(state.editing, false);
    assert.ok(state.idle >= 1);
  } finally {
    await close(proxy);
    await close(sw.server);
  }
});
