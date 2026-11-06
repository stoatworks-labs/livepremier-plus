/*
 * This app as a U5 mini's switcher, without sockets: what each request is
 * answered with, what a take or cut body means, and the discovery frame.
 *
 * ⚠️ The shapes are the ones a U5 mini's own firmware (V1.0.3) accepted from
 * a stand-in switcher; the golden frames below came from that stand-in's
 * encoder, not from a real Pixelhue switcher, which nobody here has. These
 * tests prove this app agrees with what the mini was seen to take.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  screensFrom, parseScreens, respond, listDetail, listThumb, tbar, nodeDetail, nodeEthernet,
  discoveryProbe, discoveryReply, discoveryBody, readDiscoveryReply, newSerial, newToken, macFor,
  IDENTITY, SWITCHER_PORT, DISCOVERY_PORT, DISCOVERY_CODE,
} from '../plugins/pixelhue/switcher.js';
import { wsFrame, readWsFrame, OP } from '../plugins/pixelhue/ws-client.js';

const FACTS = {
  destinations: [
    { id: 'S2', kind: 'screen', label: 'Wide', isUsed: true },
    { id: 'S1', kind: 'screen', label: 'Main', isUsed: true },
    { id: 'S3', kind: 'screen', label: '', isUsed: false },
    { id: 'A1', kind: 'aux', label: 'Aux 1', isUsed: true },
    { id: 'S10', kind: 'screen', label: '', isUsed: true },
  ],
};
const STATE = { screens: screensFrom(FACTS), serial: 'LPP123456789', token: 'tok', address: '192.168.0.20' };

test('the screens offered are the switcher\'s screens in use, by number, auxes left out', () => {
  assert.deepEqual(screensFrom(FACTS), [
    { n: 1, id: 'S1', label: 'Main' },
    { n: 2, id: 'S2', label: 'Wide' },
    { n: 10, id: 'S10', label: 'Screen 10' },
  ]);
  assert.deepEqual(screensFrom(null), []);
});

test('a take body becomes this app\'s destinations; a screen it never offered is kept apart', () => {
  const take = [
    { screenId: 1, direction: 0, effectSelect: 1, switchEffect: { time: 500, type: 1 }, screenName: '', swapEnable: 0 },
    { screenId: 10, direction: 0, effectSelect: 1, switchEffect: { time: 500, type: 1 }, screenName: '', swapEnable: 0 },
    { screenId: 3 }, { screenId: 1 }, {}, null,
  ];
  assert.deepEqual(parseScreens(take, STATE.screens), { ids: ['S1', 'S10'], unknown: [3, null, null] });
  assert.deepEqual(parseScreens({}, STATE.screens), { ids: [], unknown: [] });
  assert.deepEqual(parseScreens([], STATE.screens), { ids: [], unknown: [] });
});

test('the console\'s two writes are actions, with the screens they name', () => {
  const cut = [{ screenId: 2, direction: 0, screenName: '', screenGuid: 'lppscreen-2', swapEnable: 0 }];
  assert.deepEqual(respond({ method: 'PUT', path: '/unico/v1/screen/cut', body: cut }, STATE), { action: 'cut', ids: ['S2'], unknown: [] });
  const take = [{ screenId: 1, direction: 0, effectSelect: 1, switchEffect: { time: 500, type: 1 }, screenName: '', swapEnable: 0 }];
  assert.deepEqual(respond({ method: 'PUT', path: '/unico/v1/screen/take', body: take }, STATE), { action: 'take', ids: ['S1'], unknown: [] });
});

test('the reads a take needs are answered in the shapes the mini decoded', () => {
  const thumb = respond({ method: 'GET', path: '/unico/v1/screen/list-thumb' }, STATE).reply;
  assert.equal(thumb.code, 0);
  assert.deepEqual(thumb.data.list[0], {
    screenId: 1, screenIdObj: { id: 1, type: 2 }, general: { name: 'Main', area: { areaId: 0, areaName: '' } },
    mosaic: { type: 0, splice: { row: 1, column: 1 } }, enable: 1,
  });
  assert.equal(thumb.data.totalCount, 3);

  const detail = listDetail(STATE.screens);
  assert.deepEqual(detail.list.map((s) => [s.screenId, s.guid, s.general.name, s.select]), [
    [1, 'lppscreen-1', 'Main', 1], [2, 'lppscreen-2', 'Wide', 0], [10, 'lppscreen-10', 'Screen 10', 0],
  ]);
  assert.deepEqual(listThumb([]).list, []);

  /* A list, never an object: an object here fails the console's whole decode. */
  const bar = respond({ method: 'GET', path: '/unico/v1/screen/tbar' }, STATE).reply.data;
  assert.ok(Array.isArray(bar));
  assert.deepEqual(bar[1], { screenId: 2, screenGuid: 'lppscreen-2', percent: 0, effectSelect: 0, switchEffect: { time: 500, type: 1 }, swapEnable: 0 });
  assert.deepEqual(tbar([]), []);

  assert.deepEqual(respond({ method: 'GET', path: '/unico/v1/screen/global/switch-effect' }, STATE).reply, { code: 0, message: 'ok', data: {} });
});

test('login hands out the kept token, and the switcher says what it is', () => {
  assert.deepEqual(respond({ method: 'POST', path: '/unico/v1/system/auth/login', body: { username: 'admin' } }, STATE).reply.data, { token: 'tok' });

  const node = nodeDetail({ serial: 'LPP123456789' });
  assert.equal(node.modelId, IDENTITY.modelId);
  assert.equal(node.modelId, 28945);
  assert.equal(node.sn, 'LPP123456789');
  assert.equal(node.version, 'V1.9.0');
  assert.equal(node.general.name, 'LivePremier Plus');
  /* The console refuses a take from a switcher in controller, splicer or converter mode. */
  assert.equal(node.mode.workMode, 0);

  /* nvcontroller panics on an interface list with nothing in it. */
  const eth = nodeEthernet({ serial: 'LPP123456789', address: '192.168.0.20' });
  assert.equal(eth.ethernet.infos.length, 1);
  assert.equal(eth.ethernet.infos[0].ip, '192.168.0.20');
  assert.match(eth.ethernet.infos[0].mac, /^02:4c(:[0-9a-f]{2}){4}$/);
  assert.equal(macFor('LPP123456789'), macFor('LPP123456789'));
  assert.notEqual(macFor('LPP123456789'), macFor('LPP987654321'));
});

test('the device list stays empty: listing this app there made the stand-in\'s takes stop', () => {
  assert.deepEqual(respond({ method: 'GET', path: '/unico/v1/ucenter/device-list' }, STATE).reply.data, { list: [] });
});

test('anything else is answered with a bare success and marked, so it can be said once', () => {
  const r = respond({ method: 'PUT', path: '/unico/v1/screen/ftb', body: [{ screenId: 1 }] }, STATE);
  assert.deepEqual(r, { reply: { code: 0, message: 'ok', data: {} }, unhandled: true });
  assert.equal(respond({ method: 'GET', path: '/unico/v1/screen/list-detail' }, STATE).unhandled, undefined);
});

test('a serial and a token are made once, in the shapes the console was given', () => {
  assert.match(newSerial(), /^LPP\d{9}$/);
  assert.equal(newSerial(() => Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 19])), 'LPP012345679');
  assert.match(newToken(), /^[0-9a-f]{32}$/);
  assert.notEqual(newToken(), newToken());
});

/* Built by the rig's stand-in encoder (pixelhue-re `guest/fakeswitch.py`, `nova()`). */
const GOLDEN_REPLY = Buffer.from(
  '4e4f564100010000000000000000000037009fc48c730c0b0a0001000000000001000100000025007b226d6f64656c4964223a32383934352c22534e223a224c5050313233343536373839227d',
  'hex',
);
/* A search with the body nvcontroller sends, the same 111 bytes as the one seen from the mini's firmware. */
const PROBE = Buffer.from(
  '4e4f56410001000000000000000000005900121a6d470700000001000000000001000100000047007b22736561726368496e666f223a5b5d2c22616476536561726368496e666f223a7b226272616e64223a7b7d2c2273657269616c223a7b7d2c226d6f64656c4964223a7b7d7d7d',
  'hex',
);

test('a discovery answer is byte for byte what the stand-in the mini bound to sent', () => {
  const frame = discoveryReply({ seq: 0x0a0b0c, body: { modelId: 28945, SN: 'LPP123456789' } });
  assert.equal(frame.toString('hex'), GOLDEN_REPLY.toString('hex'));
  assert.deepEqual(readDiscoveryReply(frame), { seq: 0x0a0b0c, code: DISCOVERY_CODE, body: { modelId: 28945, SN: 'LPP123456789' } });
});

test('a search is recognised, with its seq, and nothing else on the port is', () => {
  assert.equal(PROBE.length, 111);
  assert.deepEqual(discoveryProbe(PROBE), { seq: 7, code: DISCOVERY_CODE });
  assert.equal(discoveryProbe(Buffer.from('hello')), null);
  assert.equal(discoveryProbe(null), null);
  const other = Buffer.from(PROBE); other.writeUInt32LE(0x00010002, 32);
  assert.equal(discoveryProbe(other), null);
  const notNova = Buffer.from(PROBE); notNova.write('XOVA', 0);
  assert.equal(discoveryProbe(notNova), null);
});

test('the discovery body names where to log in: 19999 for HTTP and the WebSocket', () => {
  const body = discoveryBody({ serial: 'LPP123456789' });
  assert.equal(body.SN, 'LPP123456789');
  assert.equal(body.modelId, 28945);
  assert.equal(body.deviceName, 'LivePremier Plus');
  assert.deepEqual(body.protocols.map((p) => [p.linkType, p.port]), [['http', SWITCHER_PORT], ['websocket', SWITCHER_PORT], ['udp', DISCOVERY_PORT]]);
  assert.equal(SWITCHER_PORT, 19999);
});

test('WebSocket frames: a server\'s go unmasked, a client\'s masked, and both read back', () => {
  for (const size of [0, 5, 125, 126, 65535, 65536]) {
    const payload = Buffer.alloc(size, 0x5a);
    const server = wsFrame(OP.BINARY, payload, { mask: false });
    const client = wsFrame(OP.BINARY, payload);
    assert.equal(server.length + 4, client.length);
    for (const [frame, masked] of [[server, false], [client, true]]) {
      const back = readWsFrame(frame);
      assert.equal(back.masked, masked);
      assert.equal(back.opcode, OP.BINARY);
      assert.equal(back.fin, true);
      assert.equal(back.size, frame.length);
      assert.ok(back.payload.equals(payload), `payload of ${size} bytes`);
    }
  }
  const ping = wsFrame(OP.PING, Buffer.alloc(0), { mask: false });
  assert.deepEqual([...ping], [0x89, 0x00]);
  assert.equal(readWsFrame(Buffer.from([0x89])), null);
  assert.equal(readWsFrame(wsFrame(OP.TEXT, Buffer.from('half')).subarray(0, 5)), null);
});
