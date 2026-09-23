/*
 * Multiviewer slicer: where the tiles are, where the picture is in a tile,
 * what is cut from a capture, and what the streamer helper will and will not
 * write.
 *
 * The stores are cut down from two real units: an Aquilon C (firmware 6.2.73,
 * 2026-09-09 — multiviewer 1 a 5×4 grid of 384×270 widgets carrying IN_1…) and
 * a Pulse 4K (3.3.10, 2026-09-12 — one multiviewer, 27 widget slots of which
 * `widgetValidity` names 16, and a streamer that offers OUTPUT_MTVW).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DeviceStore } from '../src/core/device-store.js';
import {
  normalise, DEFAULTS, snapshotPathFor, family, multiviewers, raster, tilesFromStore, pictureRect,
  scaleRect, planCrops, pathOfSrc, streamerState, streamerStart, streamerStop, isOurs, whepFromRtmp
} from '../plugins/mv-slicer/core.js';
import { findTargets, sourcePathOf, PATH_ATTR } from '../plugins/mv-slicer/swap.js';
import { manifestOf } from '../src/core/plugins.js';

const widget = (source, x, y, w, h, { enable = true, overlapped = false, statusSize = null } = {}) => ({
  control: { pp: { enable, displayOsd: 'DETAILED', source, posH: x, posV: y, sizeH: w, sizeV: h } },
  status: { pp: { isEnabled: enable, isDuplicated: false, isOverlapped: overlapped, posH: x, posV: y, sizeH: statusSize ? statusSize[0] : w, sizeV: statusSize ? statusSize[1] : h } }
});

function aquilon() {
  const items = {};
  for (let i = 0; i < 20; i++) items[String(i)] = widget(`IN_${i + 1}`, (i % 5) * 384, Math.floor(i / 5) * 270, 384, 270);
  items['20'] = widget('NONE', 960, 270, 240, 135, { enable: false });
  items['21'] = widget('STILL_3', 0, 0, 240, 135, { overlapped: true });
  const mv = (n) => ({
    status: { pp: { sizeH: 1920, sizeV: 1080, format: 'HDTV_1080P' } },
    layout: { widgetList: { itemKeys: Object.keys(items), items: n === 1 ? items : {} } }
  });
  const s = new DeviceStore();
  s.hydrate({ device: { monitoringList: { itemKeys: ['1', '2'], items: { 1: mv(1), 2: mv(2) } } } });
  return s;
}

function pulse({ streaming = {} } = {}) {
  const items = {
    1: widget('SCREEN_PRGM_1', 0, 0, 955, 270),
    2: widget('INPUT_2', 0, 270, 480, 270),
    3: widget('INPUT_3', 480, 270, 480, 270),
    /* Beyond widgetValidity: a stale size the model does not count. */
    20: widget('INPUT_9', 0, 0, 1920, 1080)
  };
  const s = new DeviceStore();
  s.hydrate({
    device: {
      multiviewer: {
        status: { pp: { widgetValidity: Array.from({ length: 16 }, (_, i) => String(i + 1)) } },
        widgetList: { itemKeys: Object.keys(items), items }
      },
      outputList: { items: { MTVW: { status: { pp: { sizeH: 1920, sizeV: 1080 } } } } },
      streaming: {
        destinationBank: { slotList: { itemKeys: ['1', '10'], items: { 1: { pp: { label: 'Youtube', url: 'rtmp://a.rtmp.youtube.com/live2' } }, 10: { pp: { label: '', url: '' } } } } },
        control: { pp: { start: false, mode: 'SERVER' }, destination: { pp: { target: 1 } }, video: { pp: { source: 'OUTPUT_1' } } },
        status: {
          pp: { status: 'NO_REQUEST', mode: 'NONE' },
          video: { pp: { source: 'INPUT_1', profile: '1280_720_30HZ', bitrate: 0, sourceValidity: ['INPUT_1', 'OUTPUT_1', 'OUTPUT_MTVW'] } }
        },
        ...streaming
      }
    }
  });
  return s;
}

/* --------------------------------------------------------------- settings */

test('settings: defaults, clamping, and addresses that are not addresses', () => {
  assert.deepEqual(normalise(undefined), { ...DEFAULTS });
  const s = normalise({ multiviewer: 12, fps: 0, quality: 2, insetPct: 3.5, aspect: 'wide', align: 'top',
    whepUrl: ' http://h:8889/x/whep ', rtmpUrl: 'ftp://nope', streamSlot: 0 });
  assert.equal(s.multiviewer, 8);
  assert.equal(s.fps, 1);
  assert.equal(s.quality, 0.95);
  assert.equal(s.insetPct, 3.5);
  assert.equal(s.aspect, '16:9');
  assert.equal(s.align, 'top');
  assert.equal(s.whepUrl, 'http://h:8889/x/whep');
  assert.equal(s.rtmpUrl, '');
  assert.equal(s.streamSlot, 1);
});

test('the plugin is described, and off until it has met a real multiviewer', () => {
  const m = manifestOf('mv-slicer');
  assert.ok(m);
  assert.equal(m.enabledByDefault, false);
  assert.equal(m.server, 'server.js');
  assert.equal(m.client, 'client.js');
});

/* ---------------------------------------------------------------- sources */

test('multiviewer sources map to the thumbnails the Web RCS draws, both spellings', () => {
  assert.equal(snapshotPathFor('IN_7'), '/api/device/snapshots/inputs/7');
  assert.equal(snapshotPathFor('INPUT_7'), '/api/device/snapshots/inputs/7');
  assert.equal(snapshotPathFor('STILL_2'), '/api/device/snapshots/images/2');
  for (const s of ['PROGRAM_S1', 'PREVIEW_S1', 'SCREEN_PRGM_1', 'A1', 'TIMER_1', 'NONE', 'LIVE_1', '', null]) {
    assert.equal(snapshotPathFor(s), null, String(s));
  }
});

test('an <img src> names its source whatever the cache-buster', () => {
  assert.equal(pathOfSrc('/api/device/snapshots/inputs/3?1727000000'), '/api/device/snapshots/inputs/3');
  assert.equal(pathOfSrc('http://10.0.0.5/api/device/snapshots/images/12?x'), '/api/device/snapshots/images/12');
  assert.equal(pathOfSrc('blob:http://x/abc'), null);
  assert.equal(pathOfSrc('/api/device/snapshots/multiviewer'), null);
  assert.equal(pathOfSrc(''), null);
});

/* ------------------------------------------------------------------ tiles */

test('LivePremier: the tiles of the chosen multiviewer, as the Aquilon had them', () => {
  const s = aquilon();
  assert.equal(family(s), 'nlc');
  assert.deepEqual(multiviewers(s), [1, 2]);
  assert.deepEqual(raster(s, 1), { width: 1920, height: 1080 });
  const tiles = tilesFromStore(s, 1);
  assert.equal(tiles.length, 20, 'the disabled NONE and the overlapped still are left out');
  assert.deepEqual(tiles[0], { widget: '0', source: 'IN_1', osd: 'DETAILED', rect: { x: 0, y: 0, w: 384, h: 270 }, path: '/api/device/snapshots/inputs/1' });
  assert.deepEqual(tiles[19].rect, { x: 1536, y: 810, w: 384, h: 270 });
  assert.deepEqual(tilesFromStore(s, 2), []);
});

test('the switcher’s reading of a widget wins over what was asked for', () => {
  const s = aquilon();
  s.set(['device', 'monitoringList', 'items', '1', 'layout', 'widgetList', 'items', '0', 'status', 'pp', 'sizeH'], 380);
  assert.equal(tilesFromStore(s, 1)[0].rect.w, 380);
});

test('Midra / Alta: one multiviewer, its raster on the MTVW output, only the valid widgets', () => {
  const s = pulse();
  assert.equal(family(s), 'mng');
  assert.deepEqual(multiviewers(s), [1]);
  assert.deepEqual(raster(s, 1), { width: 1920, height: 1080 });
  const tiles = tilesFromStore(s, 1);
  assert.deepEqual(tiles.map((t) => t.source), ['SCREEN_PRGM_1', 'INPUT_2', 'INPUT_3']);
  assert.equal(tiles[0].path, null, 'a screen’s program is not a source thumbnail');
  assert.equal(tiles[1].path, '/api/device/snapshots/inputs/2');
});

test('a store with no multiviewer, or none yet, answers nothing', () => {
  const s = new DeviceStore();
  assert.equal(family(s), null);
  assert.deepEqual(tilesFromStore(s, 1), []);
  assert.equal(raster(s, 1), null);
  s.hydrate({ device: { screenList: {} } });
  assert.equal(family(s), null);
  assert.deepEqual(multiviewers(s), []);
});

/* --------------------------------------------------------------- geometry */

const at = (aspect, align = 'center', insetPct = 0) => ({ aspect, align, insetPct });

test('a 16:9 picture letterboxed in the Aquilon’s 384×270 widget', () => {
  const tile = { x: 384, y: 270, w: 384, h: 270 };
  assert.deepEqual(pictureRect(tile, at('16:9')), { x: 384, y: 297, w: 384, h: 216 });
  assert.deepEqual(pictureRect(tile, at('16:9', 'top')), { x: 384, y: 270, w: 384, h: 216 });
  assert.deepEqual(pictureRect(tile, at('16:9', 'bottom')), { x: 384, y: 324, w: 384, h: 216 });
  assert.deepEqual(pictureRect(tile, at('tile')), tile);
});

test('a widget wider than the picture is pillarboxed, always centred', () => {
  const r = pictureRect({ x: 0, y: 0, w: 955, h: 270 }, at('16:9', 'top'));
  assert.equal(r.h, 270);
  assert.equal(Math.round(r.w), 480);
  assert.equal(Math.round(r.x), 238);
});

test('trim comes off every edge, in percent of the picture', () => {
  assert.deepEqual(pictureRect({ x: 0, y: 0, w: 400, h: 200 }, at('tile', 'center', 5)), { x: 20, y: 10, w: 360, h: 180 });
});

test('a rectangle scales from the multiviewer raster to the capture’s', () => {
  assert.deepEqual(scaleRect({ x: 384, y: 270, w: 384, h: 270 }, { width: 1920, height: 1080 }, { width: 1280, height: 720 }),
    { x: 256, y: 180, w: 256, h: 180 });
});

test('crops: the Aquilon grid out of a 720p stream, one per thumbnail', () => {
  const s = aquilon();
  const plan = planCrops(tilesFromStore(s, 1), raster(s, 1), { width: 1280, height: 720 }, normalise({}));
  assert.equal(plan.size, 20);
  assert.deepEqual(plan.get('/api/device/snapshots/inputs/7'), {
    source: 'IN_7', widget: '6',
    crop: { x: 256, y: 198, w: 256, h: 144 },
    width: 256, height: 144
  });
});

test('crops: a source on two widgets is cut from the larger; max width caps the drawing, not the cut', () => {
  const tiles = [
    { widget: 'a', source: 'IN_1', rect: { x: 0, y: 0, w: 480, h: 270 }, path: '/api/device/snapshots/inputs/1' },
    { widget: 'b', source: 'IN_1', rect: { x: 480, y: 0, w: 1440, h: 810 }, path: '/api/device/snapshots/inputs/1' },
    { widget: 'c', source: 'PROGRAM_S1', rect: { x: 0, y: 810, w: 480, h: 270 }, path: null }
  ];
  const mv = { width: 1920, height: 1080 };
  const plan = planCrops(tiles, mv, mv, normalise({ maxWidth: 640 }));
  assert.equal(plan.size, 1);
  const c = plan.get('/api/device/snapshots/inputs/1');
  assert.equal(c.widget, 'b');
  assert.deepEqual(c.crop, { x: 480, y: 0, w: 1440, h: 810 });
  assert.deepEqual([c.width, c.height], [640, 360]);
});

test('crops: nothing to cut from a capture that has no size yet', () => {
  const s = aquilon();
  assert.equal(planCrops(tilesFromStore(s, 1), raster(s, 1), { width: 0, height: 0 }, normalise({})).size, 0);
  assert.equal(planCrops(tilesFromStore(s, 1), null, { width: 1920, height: 1080 }, normalise({})).size, 0);
});

/* --------------------------------------------------------------- streamer */

test('the streamer, read off a Pulse 4K', () => {
  const st = streamerState(pulse());
  assert.equal(st.status, 'NO_REQUEST');
  assert.equal(st.running, false);
  assert.equal(st.canMultiviewer, true);
  assert.equal(st.profile, '1280_720_30HZ');
  assert.equal(st.slot(1).label, 'Youtube');
  assert.equal(streamerState(aquilon()), null, 'a LivePremier has none');
});

test('starting it: our destination slot, the multiviewer as the picture, then start — in that order', () => {
  const st = streamerState(pulse());
  const r = streamerStart(st, { rtmpUrl: 'rtmp://192.168.2.69:1935/lpp-mv', slot: 10 });
  assert.equal(r.ok, true);
  const S = ['device', 'streaming'];
  assert.deepEqual(r.cmds, [
    { path: [...S, 'destinationBank', 'slotList', 'items', '10', 'pp', 'label'], value: 'LPP multiviewer' },
    { path: [...S, 'destinationBank', 'slotList', 'items', '10', 'pp', 'url'], value: 'rtmp://192.168.2.69:1935/lpp-mv' },
    { path: [...S, 'destinationBank', 'slotList', 'items', '10', 'pp', 'key'], value: '' },
    { path: [...S, 'control', 'destination', 'pp', 'target'], value: 10 },
    { path: [...S, 'control', 'video', 'pp', 'source'], value: 'OUTPUT_MTVW' },
    { path: [...S, 'control', 'pp', 'start'], value: true }
  ]);
  assert.deepEqual(streamerStop(), { path: [...S, 'control', 'pp', 'start'], value: false });
});

test('it will not take a streamer that is carrying something else', () => {
  const busy = pulse({
    streaming: {
      destinationBank: { slotList: { itemKeys: ['1'], items: { 1: { pp: { label: 'Youtube', url: 'rtmp://a.rtmp.youtube.com/live2' } } } } },
      control: { pp: { start: true }, destination: { pp: { target: 1 } }, video: { pp: { source: 'OUTPUT_1' } } },
      status: { pp: { status: 'RUNNING' }, video: { pp: { source: 'OUTPUT_1', sourceValidity: ['OUTPUT_1', 'OUTPUT_MTVW'] } } }
    }
  });
  const st = streamerState(busy);
  assert.equal(st.running, true);
  const r = streamerStart(st, { rtmpUrl: 'rtmp://h/lpp-mv', slot: 10 });
  assert.equal(r.ok, false);
  assert.match(r.why, /already carrying OUTPUT_1/);
});

test('ours is ours: running our multiviewer to our address may be restarted and stopped', () => {
  const mine = pulse({
    streaming: {
      destinationBank: { slotList: { itemKeys: ['10'], items: { 10: { pp: { label: 'LPP multiviewer', url: 'rtmp://h:1935/lpp-mv/' } } } } },
      control: { pp: { start: true }, destination: { pp: { target: 10 } }, video: { pp: { source: 'OUTPUT_MTVW' } } },
      status: { pp: { status: 'RUNNING' }, video: { pp: { source: 'OUTPUT_MTVW', sourceValidity: ['OUTPUT_MTVW'] } } }
    }
  });
  const st = streamerState(mine);
  assert.equal(isOurs(st, 'rtmp://h:1935/lpp-mv'), true);
  assert.equal(streamerStart(st, { rtmpUrl: 'rtmp://h:1935/lpp-mv', slot: 10 }).ok, true);
  assert.equal(isOurs(st, 'rtmp://elsewhere/lpp-mv'), false);
});

test('no address, or a streamer without the multiviewer, is refused with a reason', () => {
  const st = streamerState(pulse());
  assert.match(streamerStart(st, { rtmpUrl: '', slot: 10 }).why, /RTMP address/);
  assert.match(streamerStart({ ...st, canMultiviewer: false }, { rtmpUrl: 'rtmp://h/p', slot: 10 }).why, /multiviewer/);
  assert.match(streamerStart(null, { rtmpUrl: 'rtmp://h/p', slot: 10 }).why, /no streamer/);
});

test('MediaMTX’s WHEP address from the RTMP one', () => {
  assert.equal(whepFromRtmp('rtmp://192.168.2.69:1935/lpp-mv'), 'http://192.168.2.69:8889/lpp-mv/whep');
  assert.equal(whepFromRtmp('rtmp://host/live/mv/'), 'http://host:8889/live/mv/whep');
  assert.equal(whepFromRtmp('rtmp://host'), '');
  assert.equal(whepFromRtmp(''), '');
});

/* ------------------------------------------------------------ the swapper */

function fakeImg(src, rect = { width: 180, height: 100, top: 10, left: 10, bottom: 110, right: 190 }) {
  const attrs = new Map([['src', src]]);
  return {
    tagName: 'IMG',
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getBoundingClientRect: () => rect
  };
}

test('targets: every on-screen image of a source with a crop, whether ours already or the vendor’s', () => {
  const vendor = fakeImg('/api/device/snapshots/inputs/1?123');
  const already = fakeImg('blob:http://x/1');
  already.setAttribute(PATH_ATTR, '/api/device/snapshots/inputs/1');
  const offscreen = fakeImg('/api/device/snapshots/inputs/1?9', { width: 180, height: 100, top: 2000, left: 0, bottom: 2100, right: 180 });
  const uncut = fakeImg('/api/device/snapshots/inputs/2?123');
  const other = fakeImg('/logo.png');
  const doc = { querySelectorAll: () => [vendor, already, offscreen, uncut, other] };
  const win = { innerWidth: 1200, innerHeight: 800 };
  const crops = new Map([['/api/device/snapshots/inputs/1', {}]]);
  const found = findTargets(doc, win, crops);
  assert.deepEqual([...found.keys()], ['/api/device/snapshots/inputs/1']);
  assert.deepEqual(found.get('/api/device/snapshots/inputs/1'), [vendor, already]);
  assert.equal(sourcePathOf(already), '/api/device/snapshots/inputs/1');
  /* The vendor re-pointed a card of ours at another input: its src wins. */
  const moved = fakeImg('/api/device/snapshots/inputs/4?5');
  moved.setAttribute(PATH_ATTR, '/api/device/snapshots/inputs/1');
  assert.equal(sourcePathOf(moved), '/api/device/snapshots/inputs/4');
  assert.equal(findTargets(doc, win, new Map()).size, 0);
});
