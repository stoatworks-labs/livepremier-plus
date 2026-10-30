/*
 * Desk control's CITP face (`plugins/desk-control/citp.js`): the CITP/MSEX
 * bytes, the switcher as libraries and layers, the pictures, and the peer end
 * to end — a pretend desk on loopback TCP, the multicast sent to a loopback
 * socket instead. What a real desk made of it is in docs/DESK-CONTROL.md's
 * status block.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';

import {
  citpMessage, msexMessage, buildPNam, buildPLoc, buildSInf, buildLSta, buildELIn, buildMEIn, buildEThn, buildStFr,
  buildVSrc, parseCitp, readRequest, highestCommon, CitpStream, CitpReader, V10, V11, V12, FORMATS, LAYER_PLAYING,
} from '../src/core/citp.js';
import { libraries, placeOf, dmxSource, mediaModel, elementSource, SWATCHES } from '../plugins/desk-control/media.js';
import { picture, card, cardFor } from '../plugins/desk-control/pictures.js';
import { CitpPeer } from '../plugins/desk-control/citp.js';
import { layout, FIXTURES, FOLDERS } from '../src/core/dmx-personality.js';
import { decodePng, encodePng } from '../server/image/png.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/* A small hand-written writer for requests, so the tests do not build them with the code under test. */
const le16 = (n) => [n & 0xff, n >> 8];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const request = (version, type, body, index = 7) => msexMessage(version, type, Uint8Array.from(body), { inResponseTo: index });
const ucs2z = (r) => {
  let s = '';
  for (;;) { const c = r.u16(); if (!c) return s; s += String.fromCharCode(c); }
};
const body = (bytes) => new CitpReader(parseCitp(bytes).body);

/* --------------------------------------------------------------- the bytes */

test('the CITP header: cookie, version, request index, size including itself, one part, content type', () => {
  const m = buildPNam('LPP');
  assert.deepEqual([...m.subarray(0, 4)], ascii('CITP'));
  assert.equal(m[4], 1);
  assert.equal(m[5], 0);
  const v = new DataView(m.buffer);
  assert.equal(v.getUint32(8, true), m.length, 'MessageSize is the whole message');
  assert.equal(v.getUint16(12, true), 1, 'MessagePartCount');
  assert.equal(v.getUint16(14, true), 0, 'MessagePart');
  assert.deepEqual([...m.subarray(16, 24)], ascii('PINFPNam'));
  assert.deepEqual([...m.subarray(24)], [...ascii('LPP'), 0], 'ucs1, null-terminated');
  const parsed = parseCitp(m);
  assert.equal(parsed.layer, 'PINF');
  assert.equal(parsed.type, 'PNam');
  assert.deepEqual(readRequest(parsed), { name: 'LPP' });
  assert.equal(parseCitp(Uint8Array.from(ascii('NOPE----------------------'))), null);
});

test('PLoc says MediaServer and the TCP port, and reads back', () => {
  const m = buildPLoc({ port: 4811, name: 'LivePremier Plus', state: 'Running' });
  assert.deepEqual(readRequest(parseCitp(m)), { port: 4811, type: 'MediaServer', name: 'LivePremier Plus', state: 'Running' });
});

test('SInf: 1.0 is name, version and bare DMX sources; 1.2 adds the UUID, versions, formats and the personality', () => {
  const info = {
    uuid: '12345678-1234-8234-9234-123456789ABC', product: 'LivePremier Plus', productVersion: [0, 18, 6],
    layers: ['ArtNet/0/0/9/PersonalityID/{7C425188-06C6-4A6B-A928-3A5A9691D485}'],
  };
  const old = parseCitp(buildSInf(V11, info));
  assert.deepEqual(old.version, [1, 0], 'before 1.2 the server speaks the 1.0 SInf');
  let r = new CitpReader(old.body);
  assert.equal(ucs2z(r), 'LivePremier Plus');
  assert.deepEqual([r.u8(), r.u8(), r.u8()], [0, 18, 1]);
  assert.equal(r.ucs1(), 'ArtNet/0/0/9', 'the suffix is a 1.2 thing only');

  const now = parseCitp(buildSInf(V12, info));
  assert.deepEqual(now.version, [1, 2]);
  r = new CitpReader(now.body);
  assert.equal(String.fromCharCode(...now.body.subarray(0, 36)), info.uuid, '36 characters, no terminator');
  r.at = 36;
  assert.equal(ucs2z(r), 'LivePremier Plus');
  assert.deepEqual([r.u8(), r.u8(), r.u8()], [0, 18, 6]);
  assert.deepEqual(r.list(r.u8(), () => r.u16()), [0x0100, 0x0101, 0x0102]);
  assert.equal(r.u16(), 1, 'media libraries only');
  assert.deepEqual(r.list(r.u8(), () => r.cookie()), ['PNG ', 'JPEG', 'RGB8']);
  assert.deepEqual(r.list(r.u8(), () => r.cookie()), ['JPEG', 'fJPG', 'PNG ', 'fPNG', 'RGB8']);
  assert.equal(r.u8(), 1);
  assert.equal(r.ucs1(), info.layers[0]);
});

test('requests read the same in 1.0, 1.1 and 1.2, whatever their counts and library ids', () => {
  const geli10 = readRequest(parseCitp(request(V10, 'GELI', [1, 2, 0, 3])));
  assert.deepEqual(geli10, { libraryType: 1, parent: [0, 0, 0, 0], libraries: [0, 3] });
  const geli12 = readRequest(parseCitp(request(V12, 'GELI', [1, 0, 0, 0, 0, ...le16(0)])));
  assert.deepEqual(geli12, { libraryType: 1, parent: [0, 0, 0, 0], libraries: [] });

  assert.deepEqual(readRequest(parseCitp(request(V10, 'GEIn', [1, 2, 1, 5]))), { libraryType: 1, library: [1, 2, 0, 0], elements: [5] });
  assert.deepEqual(readRequest(parseCitp(request(V11, 'GEIn', [1, 1, 2, 0, 0, 0]))), { libraryType: 1, library: [1, 2, 0, 0], elements: [] });
  assert.deepEqual(readRequest(parseCitp(request(V12, 'GEIn', [1, 1, 0, 0, 0, ...le16(2), 0, 1]))),
    { libraryType: 1, library: [1, 0, 0, 0], elements: [0, 1] });

  const geth = readRequest(parseCitp(request(V12, 'GETh', [...ascii('PNG '), ...le16(128), ...le16(72), 1, 1, 1, 0, 0, 0, ...le16(1), 4])));
  assert.deepEqual(geth, { format: 'PNG ', width: 128, height: 72, flags: 1, libraryType: 1, library: [1, 0, 0, 0], elements: [4] });
  const geth10 = readRequest(parseCitp(request(V10, 'GETh', [...ascii('RGB8'), ...le16(64), ...le16(48), 0, 1, 3, 0])));
  assert.deepEqual(geth10.library, [1, 3, 0, 0]);

  assert.deepEqual(readRequest(parseCitp(request(V12, 'RqSt', [...le16(2), ...ascii('fJPG'), ...le16(320), ...le16(180), 5, 10]))),
    { source: 2, format: 'fJPG', width: 320, height: 180, fps: 5, timeout: 10 });
  assert.deepEqual(readRequest(parseCitp(request(V12, 'CInf', [2, ...le16(0x0101), ...le16(0x0102)]))).versions, [[1, 1], [1, 2]]);
  assert.equal(readRequest(parseCitp(request(V12, 'GEIn', [1]))), null, 'short is null, not a throw');
  assert.equal(readRequest(parseCitp(request(V12, 'Zzzz', []))), null);
});

test('the highest common version is the newest both sides speak', () => {
  assert.deepEqual(highestCommon([[1, 0], [1, 2], [2, 0]]), [1, 2]);
  assert.deepEqual(highestCommon([[1, 1]]), [1, 1]);
  assert.equal(highestCommon([[2, 0]]), null);
});

test('ELIn and MEIn: a number before 1.1, an id after; uint8 counts before 1.2, uint16 and serials from it', () => {
  const libs = [{ index: 2, dmx: [3, 3], name: 'Screens', elements: 4, serial: 99 }];
  let r = body(buildELIn(V10, 1, libs));
  assert.deepEqual([r.u8(), r.u8(), r.u8(), r.u8(), r.u8()], [1, 1, 2, 3, 3]);
  assert.equal(ucs2z(r), 'Screens');
  assert.equal(r.u8(), 4);
  assert.equal(r.at, r.b.length);

  r = body(buildELIn(V12, 1, libs));
  assert.equal(r.u8(), 1);
  assert.equal(r.u16(), 1);
  assert.deepEqual(r.libraryId(), [1, 2, 0, 0]);
  assert.equal(r.u32(), 99);
  assert.deepEqual([r.u8(), r.u8()], [3, 3]);
  assert.equal(ucs2z(r), 'Screens');
  assert.deepEqual([r.u16(), r.u16()], [0, 4]);

  r = body(buildMEIn(V12, 0, [{ index: 0, dmx: [1, 1], name: 'IN1 Cam', serial: 5, width: 256, height: 144 }]));
  assert.deepEqual(r.libraryId(), [1, 0, 0, 0]);
  assert.equal(r.u16(), 1);
  assert.equal(r.u8(), 0);
  assert.equal(r.u32(), 5);
  assert.deepEqual([r.u8(), r.u8()], [1, 1]);
  assert.equal(ucs2z(r), 'IN1 Cam');
  r.at += 8;
  assert.deepEqual([r.u16(), r.u16(), r.u32(), r.u8()], [256, 144, 0, 0]);
  assert.equal(r.at, r.b.length);
});

test('LSta: 1.0 names the library by number, 1.2 by type and id', () => {
  const layers = [{ layer: 0, output: 1, library: 0, element: 2, name: 'IN3', flags: LAYER_PLAYING }];
  const old = parseCitp(buildLSta(V11, layers));
  assert.deepEqual(old.version, [1, 0]);
  let r = new CitpReader(old.body);
  assert.deepEqual([r.u8(), r.u8(), r.u8(), r.u8(), r.u8()], [1, 0, 1, 0, 2]);
  assert.equal(ucs2z(r), 'IN3');
  r.at += 9;
  assert.equal(r.u32(), 1);
  r = body(buildLSta(V12, layers));
  assert.deepEqual([r.u8(), r.u8(), r.u8(), r.u8()], [1, 0, 1, 1]);
  assert.deepEqual(r.libraryId(), [1, 0, 0, 0]);
  assert.equal(r.u8(), 2);
});

test('StFr: one message unfragmented; fJPG in fragments, each with its preamble; 1.2 carries the server UUID', () => {
  const uuid = 'AAAAAAAA-BBBB-8CCC-9DDD-EEEEEEEEEEEE';
  const data = Uint8Array.from({ length: 3000 }, (_, i) => i & 0xff);
  const one = buildStFr(V11, { uuid, source: 3, image: { format: 'JPEG', width: 64, height: 36, data } });
  assert.equal(one.length, 1);
  let r = body(one[0]);
  assert.deepEqual([r.u16(), r.cookie(), r.u16(), r.u16(), r.u16()], [3, 'JPEG', 64, 36, 3000]);

  const parts = buildStFr(V12, { uuid, source: 3, image: { format: 'fJPG', width: 64, height: 36, data }, frameIndex: 9, fragmentSize: 1400 });
  assert.equal(parts.length, 3);
  const rebuilt = new Uint8Array(3000);
  parts.forEach((m, i) => {
    const b = parseCitp(m).body;
    assert.equal(String.fromCharCode(...b.subarray(0, 36)), uuid);
    r = new CitpReader(b, 36);
    assert.deepEqual([r.u16(), r.cookie(), r.u16(), r.u16()], [3, 'fJPG', 64, 36]);
    const size = r.u16();
    assert.deepEqual([r.u32(), r.u16(), r.u16()], [9, 3, i]);
    const offset = r.u32();
    assert.equal(offset, i * 1400);
    rebuilt.set(b.subarray(r.at), offset);
    assert.equal(size, 12 + b.length - r.at, 'FrameBufferSize is the preamble and the fragment');
  });
  assert.deepEqual(rebuilt, data);
});

test('the TCP stream: messages split across chunks and run together come out whole; garbage stops it', () => {
  const a = buildPNam('one');
  const b = buildPNam('two');
  const joined = new Uint8Array([...a, ...b]);
  const s = new CitpStream();
  assert.deepEqual(s.push(joined.subarray(0, 5)), []);
  const got = [...s.push(joined.subarray(5, a.length + 3)), ...s.push(joined.subarray(a.length + 3))];
  assert.deepEqual(got.map((m) => readRequest(parseCitp(m)).name), ['one', 'two']);
  const bad = new CitpStream();
  bad.push(Uint8Array.from(ascii('HTTP/1.1 200 OK\r\n\r\n')));
  assert.equal(bad.broken, true);
});

/* ------------------------------------------------------------ the switcher */

const FACTS = {
  sources: {
    LIVE: [{ number: 1, label: 'Cam 1' }, { number: 3, label: '' }],
    STILL: [{ number: 2, label: 'STILL_2' }],
    SCREEN: [{ number: 1, label: 'Main' }],
  },
};

test('libraries are the Layer fixture’s folders: library DMX is the Folder value, element e is File e + 1', () => {
  const libs = libraries(FACTS);
  const numbered = FOLDERS.filter((f) => f.kind);
  assert.deepEqual(libs.map((l) => [l.kind, l.dmx]), numbered.map((f) => [f.kind, [f.value, f.value]]));
  const live = libs[0];
  assert.deepEqual(live.elements.map((e) => [e.index, e.dmx, e.name]),
    [[0, [1, 1], 'IN1 Cam 1'], [1, [2, 2], 'IN2 (not in use)'], [2, [3, 3], 'IN3']]);
  assert.equal(libs[1].elements[1].name, 'IMG2', 'the facts’ STILL_n placeholder is no name');
  assert.equal(libs.find((l) => l.kind === 'NATIVE').elements.length, 0);
  assert.deepEqual(libs.find((l) => l.kind === 'COLOR').elements[0].dmx, [0, 255]);
  assert.equal(libraries(FACTS)[0].serial, live.serial, 'the same contents, the same serial');
  assert.notEqual(libraries({ sources: { LIVE: [{ number: 1, label: 'Cam 2' }] } })[0].serial, live.serial);
  assert.deepEqual(elementSource(live, 2), { kind: 'LIVE', number: 3 });
  assert.deepEqual(elementSource(libs.find((l) => l.kind === 'COLOR'), 0), { kind: 'COLOR', number: null });
});

test('a layer’s source places in its library, a Midra’s INPUT_n among the live inputs', () => {
  const libs = libraries(FACTS);
  assert.deepEqual(placeOf(libs, 'LIVE_3'), { library: 0, element: 2, name: 'IN3' });
  assert.deepEqual(placeOf(libs, 'INPUT_1'), { library: 0, element: 0, name: 'IN1 Cam 1' });
  assert.deepEqual(placeOf(libs, 'NATIVE_2'), { library: 3, element: 1, name: 'BG2' });
  assert.deepEqual(placeOf(libs, 'COLOR'), { library: 4, element: 0, name: 'Colour' });
  assert.equal(placeOf(libs, 'SOMETHING'), null);
});

test('DMX source strings: Art-Net net and sub-net/universe from the universe, sACN as it is', () => {
  assert.equal(dmxSource({ universe: 1, address: 9 }), 'ArtNet/0/0/9');
  assert.equal(dmxSource({ universe: 17, address: 1 }), 'ArtNet/0/16/1');
  assert.equal(dmxSource({ universe: 300, address: 2 }), 'ArtNet/1/43/2');
  assert.equal(dmxSource({ universe: 2, address: 5 }, 'sacn'), 'BSRE1.31/2/5');
});

test('the model: a layer per Layer fixture, its personality the Layer GDTF, its status what is in program', () => {
  const { fixtures } = layout({ destinations: ['S1', 'S2'], layers: 2, firstUniverse: 1, mode: 'cue' });
  const sources = new Map([['S1.L1', 'LIVE_1'], ['S1.L2', 'NONE'], ['S2.L1', null]]);
  const m = mediaModel({ fixtures, facts: FACTS, sources, protocol: 'both' });
  assert.equal(m.layers.length, 4);
  const first = fixtures.find((f) => f.id === 'S1.L1');
  assert.equal(m.layers[0], `ArtNet/0/0/${first.address}/PersonalityID/{${FIXTURES.layer.guid}}`);
  assert.deepEqual(m.status.map((s) => [s.layer, s.output, s.library, s.element, s.name, s.flags]), [
    [0, 0, 0, 0, 'IN1 Cam 1', LAYER_PLAYING],
    [1, 0, 5, 0, 'Black', 0],
    [2, 1, 5, 0, '', 0],
    [3, 1, 5, 0, '', 0],
  ]);
  assert.deepEqual(m.video.map((v) => v.id), [1, 3], 'inputs in use only');
});

/* ------------------------------------------------------------- the pictures */

function gradient(width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([200, 100, 50, 255], i * 4);
  return { width, height, data };
}

test('pictures: fitted inside the box asked for, never enlarged; RGB8 is 3 bytes a pixel and BGR for 1.0', () => {
  const img = gradient(256, 144);
  const png = picture(img, { format: FORMATS.PNG, width: 128, height: 128 });
  assert.deepEqual([png.width, png.height], [128, 72]);
  assert.deepEqual(decodePng(Buffer.from(png.data)).width, 128);
  const rgb = picture(img, { format: FORMATS.RGB8, width: 64, height: 36 });
  assert.equal(rgb.data.length, 64 * 36 * 3);
  assert.deepEqual([...rgb.data.subarray(0, 3)], [200, 100, 50]);
  const bgr = picture(img, { format: FORMATS.RGB8, width: 64, height: 36, bgr: true });
  assert.deepEqual([...bgr.data.subarray(0, 3)], [50, 100, 200]);
  const big = picture(img, { format: FORMATS.JPEG, width: 1920, height: 1080 });
  assert.deepEqual([big.width, big.height], [256, 144], 'not grown');
  assert.deepEqual([...big.data.subarray(0, 2)], [0xff, 0xd8]);
  assert.equal(picture(img, { format: 'BMP ', width: 64, height: 64 }).format, 'JPEG', 'an unknown format is answered in JPEG');
});

test('pictures: one too big for a uint16 buffer is made again smaller', () => {
  const img = gradient(512, 288);
  const out = picture(img, { format: FORMATS.RGB8, width: 512, height: 288 });
  assert.ok(out.data.length < 65_000, `${out.data.length} bytes`);
  assert.ok(out.width < 512);
  const card1 = cardFor(SWATCHES.LIVE, 1000, 1000);
  assert.deepEqual([card1.width, card1.height], [160, 90], 'a card is small whatever is asked');
});

/* ------------------------------------------------------- the peer, end to end */

/** A pretend desk: a TCP client that collects whole CITP messages. */
async function deskClient(port) {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j); });
  const stream = new CitpStream();
  const got = [];
  socket.on('data', (c) => { for (const m of stream.push(new Uint8Array(c))) got.push(parseCitp(m)); });
  const next = async (type, from = 0, ms = 2000) => {
    const i = await until(() => { const k = got.findIndex((m, j) => j >= from && m.type === type); return k >= 0 ? k + 1 : 0; }, ms, type);
    return got[i - 1];
  };
  return { socket, got, next, send: (bytes) => socket.write(bytes), close: () => socket.destroy() };
}

async function peerBench({ facts = FACTS, sources = new Map([['S1.L1', 'LIVE_3']]), snapshot = true, allow } = {}) {
  const heard = dgram.createSocket('udp4');
  await new Promise((r) => heard.bind(0, '127.0.0.1', r));
  const multicast = [];
  heard.on('message', (b) => multicast.push(parseCitp(new Uint8Array(b))));
  const { fixtures } = layout({ destinations: ['S1'], layers: 2, firstUniverse: 1, mode: 'cue' });
  const asked = [];
  let refreshes = 0;
  const peer = new CitpPeer({
    name: 'LivePremier Plus - test', uuid: '11111111-2222-8333-9444-555555555555', productVersion: [0, 18, 6],
    model: () => mediaModel({ fixtures, facts, sources, protocol: 'artnet' }),
    refresh: async () => { refreshes++; },
    thumbnail: async (want) => { asked.push(want); return picture(gradient(256, 144), want); },
    frame: async (want) => (snapshot ? picture(gradient(256, 144), want) : null),
    ports: { udp: 0, tcp: 0 }, bindAddress: '127.0.0.1', targets: [{ address: '127.0.0.1', port: heard.address().port }],
    locMs: 50, statusMs: 50, refreshMs: 50, streamMs: 100, ...(allow ? { allow } : {}),
  });
  await peer.start();
  return {
    peer, heard, multicast, asked, refreshes: () => refreshes,
    close: () => { peer.stop(); heard.close(); },
  };
}

test('peer: PLoc goes out with the TCP port; a 1.2 desk gets PNam, a 1.0 SInf, then a 1.2 SInf on CInf', async () => {
  const b = await peerBench();
  const d = await deskClient(b.peer.bound.tcp);
  try {
    const loc = await until(() => b.multicast.find((m) => m.type === 'PLoc'), 2000, 'PLoc');
    assert.equal(readRequest(loc).port, b.peer.bound.tcp);
    assert.equal(readRequest(loc).type, 'MediaServer');
    await d.next('PNam');
    const first = await d.next('SInf');
    assert.deepEqual(first.version, [1, 0]);
    d.send(buildPNam('MagicQ test'));
    d.send(request(V12, 'CInf', [3, ...le16(0x0100), ...le16(0x0101), ...le16(0x0102)], 1));
    const second = await d.next('SInf', d.got.indexOf(first) + 1);
    assert.deepEqual(second.version, [1, 2]);
    assert.equal(second.requestIndex, 1, 'InResponseTo the CInf');
    await until(() => b.peer.describe().clients[0]?.name === 'MagicQ test', 2000, 'the desk’s name');
    assert.equal(b.peer.describe().clients[0].version, '1.2');
    const lsta = await d.next('LSta', d.got.indexOf(second) + 1);
    assert.deepEqual(lsta.version, [1, 2]);
    const r = new CitpReader(lsta.body);
    assert.equal(r.u8(), 2, 'two layers patched');
    assert.deepEqual([r.u8(), r.u8(), r.u8()], [0, 0, 1]);
    assert.deepEqual(r.libraryId(), [1, 0, 0, 0]);
    assert.equal(r.u8(), 2);
    assert.equal(ucs2z(r), 'IN3');
    assert.ok(b.refreshes() > 0, 'the switcher is read while a desk is connected');
  } finally { d.close(); b.close(); }
});

test('peer: a desk not on the "Only these desks" list is hung up on before it is told anything', async () => {
  const b = await peerBench({ allow: (ip) => ip === '192.0.2.7' });
  const d = await deskClient(b.peer.bound.tcp);
  try {
    await new Promise((r) => d.socket.once('close', r));
    assert.equal(d.got.length, 0);
    assert.equal(b.peer.describe().clients.length, 0);
    assert.equal(b.peer.counts.refused, 1);
  } finally { d.close(); b.close(); }
});

test('peer: libraries, elements, thumbnails, video sources and a stream, answered in 1.2; the unknown is Nacked', async () => {
  const b = await peerBench();
  const d = await deskClient(b.peer.bound.tcp);
  try {
    d.send(request(V12, 'CInf', [1, ...le16(0x0102)], 1));
    await d.next('SInf', 2);
    d.send(request(V12, 'GELI', [1, 0, 0, 0, 0, ...le16(0)], 2));
    const elin = await d.next('ELIn');
    assert.equal(elin.requestIndex, 2);
    let r = new CitpReader(elin.body);
    assert.equal(r.u8(), 1);
    assert.equal(r.u16(), FOLDERS.filter((f) => f.kind).length);

    d.send(request(V12, 'GEIn', [1, 1, 0, 0, 0, ...le16(0)], 3));
    const mein = await d.next('MEIn');
    r = new CitpReader(mein.body);
    assert.deepEqual(r.libraryId(), [1, 0, 0, 0]);
    assert.equal(r.u16(), 3, 'IN1 to IN3');

    d.send(request(V12, 'GETh', [...ascii('PNG '), ...le16(128), ...le16(72), 1, 1, 1, 0, 0, 0, ...le16(2), 0, 2], 4));
    const t1 = await d.next('EThn');
    const t2 = await d.next('EThn', d.got.indexOf(t1) + 1);
    r = new CitpReader(t2.body);
    assert.equal(r.u8(), 1);
    assert.deepEqual(r.libraryId(), [1, 0, 0, 0]);
    assert.equal(r.u8(), 2, 'in the order asked');
    assert.deepEqual([r.cookie(), r.u16(), r.u16()], ['PNG ', 128, 72]);
    const size = r.u16();
    assert.equal(decodePng(Buffer.from(t2.body.subarray(r.at, r.at + size))).height, 72);
    assert.deepEqual(b.asked.map((a) => [a.library, a.element, a.format]), [[0, 0, 'PNG '], [0, 2, 'PNG ']]);

    d.send(request(V12, 'GVSr', [], 5));
    const vsrc = await d.next('VSrc');
    r = new CitpReader(vsrc.body);
    assert.equal(r.u16(), 2);
    assert.equal(r.u16(), 1);
    assert.equal(ucs2z(r), 'IN1 Cam 1');
    assert.deepEqual([r.u8(), r.u8()], [0xff, 0xff]);

    d.send(request(V12, 'RqSt', [...le16(3), ...ascii('fJPG'), ...le16(128), ...le16(72), 1, 2], 6));
    const frame = await until(() => b.multicast.find((m) => m.type === 'StFr'), 3000, 'a stream frame');
    assert.deepEqual(frame.version, [1, 2]);
    r = new CitpReader(frame.body, 36);
    assert.deepEqual([r.u16(), r.cookie()], [3, 'fJPG']);
    assert.equal(b.peer.describe().streams[0].source, 3);

    d.send(request(V12, 'GELT', [...ascii('JPEG'), ...le16(64), ...le16(36), 1, 1, ...le16(1), 1, 2, 0, 0], 8));
    const elth = await d.next('ELTh');
    r = new CitpReader(elth.body);
    assert.equal(r.u8(), 1);
    assert.deepEqual(r.libraryId(), [1, 2, 0, 0]);

    d.send(request(V12, 'GELI', [2, 0, 0, 0, 0, ...le16(0)], 9));
    const effects = await d.next('ELIn', d.got.indexOf(elin) + 1);
    r = new CitpReader(effects.body);
    assert.deepEqual([r.u8(), r.u16()], [2, 0], 'no effect libraries');

    d.send(request(V12, 'XXXX', [], 10));
    const nack = await d.next('Nack');
    assert.equal(nack.requestIndex, 10);
    assert.equal(new CitpReader(nack.body).cookie(), 'XXXX');
  } finally { d.close(); b.close(); }
});

test('peer: a desk that never sends CInf is answered in its own version — 1.0 RGB8 thumbnails in BGR, frames down its connection', async () => {
  const b = await peerBench();
  const d = await deskClient(b.peer.bound.tcp);
  try {
    await d.next('SInf');
    d.send(request(V10, 'GELI', [1, 0], 1));
    const elin = await d.next('ELIn');
    assert.deepEqual(elin.version, [1, 0]);
    const r0 = new CitpReader(elin.body);
    assert.deepEqual([r0.u8(), r0.u8(), r0.u8()], [1, 6, 0], 'type, uint8 count, library number');

    d.send(request(V10, 'GETh', [...ascii('RGB8'), ...le16(16), ...le16(9), 0, 1, 0, 1, 0], 2));
    const ethn = await d.next('EThn');
    assert.deepEqual(ethn.version, [1, 0]);
    const r = new CitpReader(ethn.body);
    assert.deepEqual([r.u8(), r.u8(), r.u8(), r.cookie(), r.u16(), r.u16(), r.u16()], [1, 0, 0, 'RGB8', 16, 9, 16 * 9 * 3]);
    assert.deepEqual([r.u8(), r.u8(), r.u8()], [50, 100, 200], 'blue first');

    const lsta = await d.next('LSta');
    assert.deepEqual(lsta.version, [1, 0], 'unsolicited messages in 1.0 without a CInf');
    d.send(request(V10, 'XXXX', [], 3));
    await sleep(150);
    assert.equal(d.got.some((m) => m.type === 'Nack'), false, 'no Nack before 1.2');
    assert.equal(b.peer.describe().clients[0].version, '1.0', 'the version its requests came in');

    /* MagicQ 1.9.6.5's own request, byte for byte: IN1, RGB8, 88 × 64, 24 fps, 10 s. */
    d.send(request(V10, 'RqSt', [...le16(1), ...ascii('RGB8'), ...le16(88), ...le16(64), 24, 10], 4));
    const frame = await d.next('StFr', 0, 3000);
    assert.deepEqual(frame.version, [1, 0]);
    const f = new CitpReader(frame.body);
    const [source, format, w, h, size] = [f.u16(), f.cookie(), f.u16(), f.u16(), f.u16()];
    assert.deepEqual([source, format], [1, 'RGB8']);
    assert.ok(w <= 88 && h <= 64, `${w}×${h}`);
    assert.equal(size, w * h * 3);
    assert.equal(b.multicast.some((m) => m.type === 'StFr'), false, 'not multicast: a 1.0 desk may have no socket on 4809');
  } finally { d.close(); b.close(); }
});

test('peer: a library that changes is announced with ELUp; stopping closes the connection', async () => {
  const sources = new Map();
  const facts = { sources: { ...FACTS.sources } };
  const b = await peerBench({ sources, facts });
  const d = await deskClient(b.peer.bound.tcp);
  try {
    d.send(request(V12, 'CInf', [1, ...le16(0x0102)], 1));
    const s1 = await d.next('SInf', 2);
    await d.next('LSta', d.got.indexOf(s1) + 1);
    /* An input coming into use changes the live library: the desk is told. */
    facts.sources = { ...facts.sources, LIVE: [...facts.sources.LIVE, { number: 4, label: 'New' }] };
    const up = await d.next('ELUp', d.got.indexOf(s1) + 1);
    const r = new CitpReader(up.body);
    assert.equal(r.u8(), 1);
    assert.deepEqual(r.libraryId(), [1, 0, 0, 0]);
    const closed = new Promise((res) => d.socket.once('close', res));
    b.peer.stop();
    await closed;
    assert.equal(b.peer.bound.tcp, null);
  } finally { d.close(); b.close(); }
});

test('the codec stands alone: a CITP message with no payload type it knows is still parsed, not thrown on', () => {
  const m = citpMessage('SDMX', Uint8Array.from(ascii('UNam')));
  assert.deepEqual(parseCitp(m), { layer: 'SDMX', type: 'UNam', requestIndex: 0, version: null, body: new Uint8Array(0) });
  assert.equal(readRequest(parseCitp(m)), null);
  assert.ok(card([1, 2, 3], 2, 2).data.length === 16);
  assert.ok(buildVSrc(V12, []).length > 0);
  assert.ok(buildEThn(V12, { library: 0, element: 0, image: { format: 'JPEG', width: 1, height: 1, data: new Uint8Array(1) } }).length > 0);
  assert.ok(encodePng(new Uint8Array(4), 1, 1).length > 0);
});
