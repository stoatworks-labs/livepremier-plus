/*
 * This app as a U5 mini's switcher, over real sockets on loopback: a stand-in
 * for the mini's side searches, logs in, holds the WebSocket and presses TAKE
 * and CUT, the way the mini's own firmware (V1.0.3) did against a stand-in
 * switcher in the rig.
 *
 * ⚠️ The mini's side here is written from that rig run, not from a mini on a
 * bench. These tests prove the server answers what the firmware asked; a real
 * console is still the test that matters (docs/PIXELHUE.md).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';

import { SwitcherServer, bindNote, facingAddress } from '../plugins/pixelhue/switcher-server.js';
import { screensFrom, readDiscoveryReply, discoveryReply, DISCOVERY_CODE } from '../plugins/pixelhue/switcher.js';
import { wsFrame, readWsFrame, OP } from '../plugins/pixelhue/ws-client.js';

const SCREENS = screensFrom({ destinations: [{ id: 'S1', label: 'Main', isUsed: true }, { id: 'S2', label: 'Wide', isUsed: true }] });
const IDENTITY = { serial: 'LPP123456789', token: 'kept-token' };

async function standUp(over = {}) {
  const performed = [];
  const server = new SwitcherServer({
    allow: (ip) => ip === '127.0.0.1',
    identity: () => IDENTITY,
    screens: async () => SCREENS,
    address: () => '127.0.0.1',
    perform: async (kind, ids, unknown) => { performed.push({ kind, ids, unknown }); return { ok: true }; },
    ports: { http: 0, udp: 0 },
    bindAddress: '127.0.0.1',
    pingMs: 100,
    ...over,
  });
  await server.start();
  return { server, performed, port: server.bound.http, udp: server.bound.udp };
}

/** One HTTP request as the mini's clients send them. */
function call(port, method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: token } : {}),
        ...(data ? { 'content-length': data.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** Open the WebSocket as nvcontroller does, and count the pings that arrive. */
function openWs(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/unico/v1/ws',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' },
    });
    req.on('upgrade', (res, socket) => {
      const seen = { pings: 0, pongs: 0, closed: false };
      let buf = Buffer.alloc(0);
      socket.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        for (let f = readWsFrame(buf); f; f = readWsFrame(buf)) {
          buf = buf.subarray(f.size);
          assert.equal(f.masked, false, 'a server frame is never masked');
          if (f.opcode === OP.PING) seen.pings++;
          if (f.opcode === OP.PONG) seen.pongs++;
        }
      });
      socket.on('close', () => { seen.closed = true; });
      resolve({ socket, seen, status: res.statusCode });
    });
    req.on('response', (res) => reject(new Error(`no upgrade: HTTP ${res.statusCode}`)));
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a search from the console is answered with this app\'s serial and the search\'s own seq', async (t) => {
  const { server, udp } = await standUp();
  t.after(() => server.stop());
  const probe = discoveryReply({ seq: 42, body: { searchInfo: [], advSearchInfo: { brand: {}, serial: {}, modelId: {} } } });
  const sock = dgram.createSocket('udp4');
  t.after(() => sock.close());
  const answer = new Promise((resolve) => sock.once('message', (m) => resolve(m)));
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  sock.send(probe, udp, '127.0.0.1');
  const back = readDiscoveryReply(await answer);
  assert.equal(back.seq, 42);
  assert.equal(back.code, DISCOVERY_CODE);
  assert.equal(back.body.SN, 'LPP123456789');
  assert.equal(back.body.modelId, 28945);
  assert.equal(server.describe().counts.searches, 1);
});

test('login hands out the kept token; without it every other request is refused', async (t) => {
  const { server, port } = await standUp();
  t.after(() => server.stop());
  const logins = [];
  server.on('login', (l) => logins.push(l));
  const login = await call(port, 'POST', '/unico/v1/system/auth/login', { body: { username: 'admin', password: 'MTIzNDU2' } });
  assert.equal(login.status, 200);
  assert.deepEqual(login.body, { code: 0, message: 'ok', data: { token: 'kept-token' } });
  assert.equal(logins.length, 1);

  const without = await call(port, 'GET', '/unico/v1/screen/list-thumb');
  assert.equal(without.status, 401);
  assert.notEqual(without.body.code, 0);

  const thumb = await call(port, 'GET', '/unico/v1/screen/list-thumb', { token: 'kept-token' });
  assert.equal(thumb.status, 200);
  assert.deepEqual(thumb.body.data.list.map((s) => [s.screenId, s.general.name]), [[1, 'Main'], [2, 'Wide']]);
});

test('TAKE and CUT from the console are performed for the screens it names', async (t) => {
  const { server, port, performed } = await standUp();
  t.after(() => server.stop());
  const take = await call(port, 'PUT', '/unico/v1/screen/take', {
    token: 'kept-token',
    body: [
      { screenId: 1, direction: 0, effectSelect: 1, switchEffect: { time: 500, type: 1 }, screenName: '', swapEnable: 0 },
      { screenId: 2, direction: 0, effectSelect: 1, switchEffect: { time: 500, type: 1 }, screenName: '', swapEnable: 0 },
    ],
  });
  assert.deepEqual(take.body, { code: 0, message: 'ok', data: {} });
  const cut = await call(port, 'PUT', '/unico/v1/screen/cut', {
    token: 'kept-token', body: [{ screenId: 2, direction: 0, screenName: '', screenGuid: 'lppscreen-2', swapEnable: 0 }, { screenId: 9 }],
  });
  assert.equal(cut.body.code, 0);
  assert.deepEqual(performed, [
    { kind: 'take', ids: ['S1', 'S2'], unknown: [] },
    { kind: 'cut', ids: ['S2'], unknown: [9] },
  ]);
  const d = server.describe();
  assert.equal(d.counts.takes, 1);
  assert.equal(d.counts.cuts, 1);
  assert.deepEqual(d.last.action.ids, ['S2']);
});

test('a take the app refuses is refused to the console too, with the reason', async (t) => {
  const { server, port } = await standUp({ perform: async () => ({ ok: false, error: 'ignored — the panel is locked' }) });
  t.after(() => server.stop());
  const take = await call(port, 'PUT', '/unico/v1/screen/take', { token: 'kept-token', body: [{ screenId: 1 }] });
  assert.equal(take.status, 200);
  assert.notEqual(take.body.code, 0);
  assert.equal(take.body.message, 'ignored — the panel is locked');
  assert.equal(server.describe().last.action.ok, false);
});

test('the WebSocket is pinged often enough to hold nvcontroller, and answers its pings', async (t) => {
  const { server, port } = await standUp();
  t.after(() => server.stop());
  const ws = await openWs(port);
  assert.equal(ws.status, 101);
  ws.socket.write(wsFrame(OP.PING, Buffer.from('hi')));
  await sleep(450);
  assert.ok(ws.seen.pings >= 3, `pings in 450 ms at 100 ms: ${ws.seen.pings}`);
  assert.equal(ws.seen.pongs, 1);
  assert.equal(server.describe().links, 1);
  ws.socket.destroy();
  await sleep(50);
  assert.equal(server.describe().links, 0);
});

test('only the console is served: anyone else is refused at the door, and said once', async (t) => {
  const warned = [];
  const log = Object.assign(() => {}, { warn: (m) => warned.push(m) });
  const { server, port, udp, performed } = await standUp({ allow: () => false, log });
  t.after(() => server.stop());

  const login = await call(port, 'POST', '/unico/v1/system/auth/login', { body: {} });
  assert.equal(login.status, 403);
  const take = await call(port, 'PUT', '/unico/v1/screen/take', { token: 'kept-token', body: [{ screenId: 1 }] });
  assert.equal(take.status, 403);
  assert.deepEqual(performed, []);
  await assert.rejects(openWs(port));

  const sock = dgram.createSocket('udp4');
  t.after(() => sock.close());
  let answered = false;
  sock.on('message', () => { answered = true; });
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  sock.send(discoveryReply({ seq: 1, body: {} }), udp, '127.0.0.1');
  await sleep(150);
  assert.equal(answered, false);
  assert.equal(warned.length, 1, warned.join('\n'));
  assert.match(warned[0], /not the console this app drives/);
});

test('a request nothing here handles is answered, and said once, not once a second', async (t) => {
  const warned = [];
  const log = Object.assign(() => {}, { warn: (m) => warned.push(m) });
  const { server, port } = await standUp({ log });
  t.after(() => server.stop());
  for (let i = 0; i < 3; i++) {
    const r = await call(port, 'PUT', '/unico/v1/screen/ftb', { token: 'kept-token', body: [{ screenId: 1 }] });
    assert.equal(r.body.code, 0);
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /PUT \/unico\/v1\/screen\/ftb/);
});

test('a port something else holds is said in words, and the server still stops cleanly', async (t) => {
  const holder = net.createServer();
  await new Promise((r) => holder.listen(0, '127.0.0.1', r));
  t.after(() => holder.close());
  const taken = holder.address().port;
  const { server } = await standUp({ ports: { http: taken, udp: 0 }, log: Object.assign(() => {}, { warn: () => {} }) });
  assert.equal(server.bound.http, null);
  assert.match(server.errors.http, new RegExp(`Port ${taken}`));
  assert.ok(server.bound.udp > 0, 'discovery still binds');
  await server.stop();

  const words = bindNote('the switcher\'s HTTP', 19999, Object.assign(new Error('in use'), { code: 'EADDRINUSE' }));
  assert.match(words, /PixelFlow/);
  assert.match(words, /UCenter/);
});

test('the address facing a host is one of this machine\'s', async () => {
  assert.equal(await facingAddress('127.0.0.1'), '127.0.0.1');
});
