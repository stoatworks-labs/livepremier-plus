/*
 * The desk's CITP face and patch export, live: the app's own `desk-control`
 * plugin with CITP on, a pretend desk connecting to it over TCP the way
 * MagicQ does, and the simulator behind it. Read-only: nothing here sends a
 * DMX frame or writes to the switcher, so S1 is not guarded.
 *
 * The desk is a stand-in that speaks MSEX 1.2 from the spec; what a real
 * desk made of the same server is in docs/DESK-CONTROL.md's status block.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';

import { SKIP, SIM, startApp, Link, sag, layerPath, sleep } from './harness.js';
import {
  msexMessage, buildPNam, parseCitp, readRequest, CitpStream, CitpReader, V12, CITP_PORT, CITP_GROUPS,
} from '../../src/core/citp.js';
import { FIXTURES } from '../../src/core/dmx-personality.js';
import { unzipStore } from '../../src/core/zip.js';
import { decodePng } from '../../server/image/png.js';

let app;
let link;
let desk;

const SETTINGS = { deskEnabled: true, deskCitp: true, deskDestinations: ['S1'], deskLayers: 2, deskAllow: ['127.0.0.1'] };

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(20); }
  return null;
};
const le16 = (n) => [n & 0xff, n >> 8];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const ask = (type, body, index) => desk.socket.write(msexMessage(V12, type, Uint8Array.from(body), { inResponseTo: index }));
const ucs2z = (r) => { let s = ''; for (;;) { const c = r.u16(); if (!c) return s; s += String.fromCharCode(c); } };
const reply = (type, index) => until(() => desk.got.find((m) => m.type === type && (index === undefined || m.requestIndex === index)));

before(async () => {
  if (SKIP) return;
  app = await startApp();
  link = await Link.open(app);
  await app.configure({ plugins: { 'desk-control': { enabled: true, settings: SETTINGS } } });
  const tcp = await until(async () => (await app.api('/desk-control/state')).json?.citp?.tcp);
  assert.ok(tcp, 'the CITP server is listening');
  const socket = net.connect(tcp, '127.0.0.1');
  await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j); });
  const stream = new CitpStream();
  desk = { socket, got: [] };
  socket.on('data', (c) => { for (const m of stream.push(new Uint8Array(c))) desk.got.push(parseCitp(m)); });
  socket.write(buildPNam('sim test desk'));
  ask('CInf', [1, ...le16(0x0102)], 1);
});

after(async () => {
  desk?.socket.destroy();
  link?.close();
  await app?.close();
});

test('a desk connecting gets PNam, SInf in 1.2 with the two layers where they are patched, as the Layer GDTF', { skip: SKIP }, async () => {
  assert.ok(await reply('PNam'));
  const sinf = await until(() => desk.got.find((m) => m.type === 'SInf' && m.version[1] === 2));
  assert.ok(sinf, 'a 1.2 SInf after CInf');
  const r = new CitpReader(sinf.body, 36);
  assert.equal(ucs2z(r), 'LivePremier Plus');
  r.at += 3;
  r.at += 1 + 2 * r.b[r.at];
  r.at += 2;
  r.at += 1 + 4 * r.b[r.at];
  r.at += 1 + 4 * r.b[r.at];
  const layers = r.list(r.u8(), () => r.ucs1());
  const personality = `/PersonalityID/{${FIXTURES.layer.guid}}`;
  assert.deepEqual(layers, [`ArtNet/0/0/9${personality}`, `ArtNet/0/0/12${personality}`]);
  const state = (await app.api('/desk-control/state')).json;
  assert.equal(state.citp.clients[0].name, 'sim test desk');
  assert.equal(state.citp.clients[0].version, '1.2');
});

test('the live library is the simulator’s inputs, by number and name', { skip: SKIP }, async () => {
  ask('GELI', [1, 0, 0, 0, 0, ...le16(0)], 2);
  const elin = await reply('ELIn', 2);
  let r = new CitpReader(elin.body);
  assert.equal(r.u8(), 1);
  assert.equal(r.u16(), 6, 'Live inputs, Stills, Screens, Backgrounds, Colour, None');
  /* The facts are read every 30 s; wait for the inputs to be in them. */
  const valid = Object.keys(link.get(['device', 'inputList', 'items']) || {})
    .map((k) => Number(/^IN_(\d+)$/.exec(k)?.[1]))
    .filter((n) => n && n <= 48 && link.get(['device', 'inputList', 'items', `IN_${n}`, 'mapping', 'pp', 'isValid']) === true);
  const top = Math.max(...valid);
  let mein = null;
  for (let i = 3; i < 40 && !mein; i++) {
    ask('GEIn', [1, 1, 0, 0, 0, ...le16(0)], i);
    const m = await reply('MEIn', i);
    if (new CitpReader(m.body, 4).u16() === top) mein = m;
    else await sleep(500);
  }
  assert.ok(mein, `a live library running to IN${top}`);
  r = new CitpReader(mein.body);
  assert.deepEqual(r.libraryId(), [1, 0, 0, 0]);
  const count = r.u16();
  const names = [];
  for (let i = 0; i < count; i++) {
    r.u8(); r.u32();
    const dmx = [r.u8(), r.u8()];
    assert.deepEqual(dmx, [i + 1, i + 1], 'element e is File value e + 1');
    names.push(ucs2z(r));
    r.at += 8 + 2 + 2 + 4 + 1;
  }
  const label = String(link.get(['device', 'inputList', 'items', `IN_${valid[0]}`, 'control', 'pp', 'label']) || '');
  assert.ok(names[valid[0] - 1].startsWith(`IN${valid[0]}`), names[valid[0] - 1]);
  if (label) assert.ok(names[valid[0] - 1].includes(label), `${names[valid[0] - 1]} carries "${label}"`);
});

test('layer status says what S1’s layers have in program, as the switcher reports it', { skip: SKIP }, async () => {
  const t = link.get(sag('S1', 'status', 'transition'));
  const program = link.get(sag('S1', 'control', String(t).endsWith('DOWN') ? 'presetDown' : 'presetUp'));
  const want = [1, 2].map((l) => link.get(layerPath('S1', program, l, 'source', 'pp', 'inputNum')));
  const expect = (source) => {
    const m = /^(LIVE|STILL|SCREEN|NATIVE)_(\d+)$/.exec(String(source));
    const order = ['LIVE', 'STILL', 'SCREEN', 'NATIVE', 'COLOR', 'NONE'];
    return m ? [order.indexOf(m[1]), Number(m[2]) - 1] : [order.indexOf(String(source)), 0];
  };
  const ok = await until(() => {
    const lsta = [...desk.got].reverse().find((m) => m.type === 'LSta');
    if (!lsta) return false;
    const r = new CitpReader(lsta.body);
    const n = r.u8();
    const rows = [];
    for (let i = 0; i < n; i++) {
      r.u8(); r.u8(); r.u8();
      const lib = r.libraryId()[1];
      const el = r.u8();
      ucs2z(r);
      r.at += 4 + 4 + 1 + 4;
      rows.push([lib, el]);
    }
    return JSON.stringify(rows) === JSON.stringify(want.map(expect)) && rows;
  });
  assert.ok(ok, `LSta matches ${want.join(', ')} on ${program}`);
});

test('a thumbnail comes back as a PNG of the size asked for or smaller', { skip: SKIP }, async () => {
  ask('GETh', [...ascii('PNG '), ...le16(128), ...le16(72), 1, 1, 1, 0, 0, 0, ...le16(1), 0], 50);
  const ethn = await reply('EThn', 50);
  assert.ok(ethn, 'an EThn');
  const r = new CitpReader(ethn.body);
  r.u8(); r.libraryId(); r.u8();
  assert.equal(r.cookie(), 'PNG ');
  const [w, h] = [r.u16(), r.u16()];
  assert.ok(w <= 128 && h <= 72, `${w}×${h}`);
  const size = r.u16();
  const png = decodePng(Buffer.from(ethn.body.subarray(r.at, r.at + size)));
  assert.deepEqual([png.width, png.height], [w, h]);
});

test('PLoc reaches the multicast group, naming the TCP port', { skip: SKIP }, async () => {
  const sim = SIM.split(':')[0].split('.').map(Number);
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal
    && i.address.split('.').every((o, k) => ((Number(o) ^ sim[k]) & Number(i.netmask.split('.')[k])) === 0));
  const tcp = (await app.api('/desk-control/state')).json.citp.tcp;
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const heard = [];
  socket.on('message', (b) => { const m = parseCitp(new Uint8Array(b)); if (m && m.type === 'PLoc') heard.push(readRequest(m)); });
  await new Promise((r) => socket.bind(CITP_PORT, '0.0.0.0', r));
  socket.addMembership(CITP_GROUPS[0], lan?.address);
  try {
    const loc = await until(() => heard.find((l) => /LivePremier Plus/.test(l.name)), 4000);
    assert.ok(loc, 'a PLoc from the app');
    assert.equal(loc.type, 'MediaServer');
    assert.equal(loc.port, tcp);
  } finally { socket.close(); }
});

test('the patch as MVR: the scene and the GDTF files it names, from the running app', { skip: SKIP }, async () => {
  const res = await fetch(`${app.base}/__lpp/desk-control/patch.mvr`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /livepremier-plus-patch\.mvr/);
  const files = unzipStore(new Uint8Array(await res.arrayBuffer()));
  assert.deepEqual(files.map((f) => f.name).sort(),
    ['GeneralSceneDescription.xml', 'Stoatworks@LPP_Layer@v2.gdtf', 'Stoatworks@LPP_Master@v2.gdtf', 'Stoatworks@LPP_Screen@v2.gdtf']);
  const scene = new TextDecoder().decode(files.find((f) => f.name === 'GeneralSceneDescription.xml').data);
  assert.equal((scene.match(/<Fixture /g) || []).length, 4);
  assert.match(scene, /<FixtureID>101<\/FixtureID>/);
});

test('CITP off: the server stops and the desk is let go', { skip: SKIP }, async () => {
  const closed = new Promise((r) => desk.socket.once('close', r));
  await app.configure({ plugins: { 'desk-control': { settings: { deskCitp: false } } } });
  await closed;
  assert.equal((await app.api('/desk-control/state')).json.citp, null);
});
