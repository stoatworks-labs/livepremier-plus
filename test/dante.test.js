/*
 * Dante: the codec against bytes other people captured, the mDNS reader, the
 * routing model, Dante Controller presets, the switcher's card, and the plugin
 * end to end against `tools/dante-sim.mjs`.
 *
 * ## What each part proves
 *
 * - **The codec tests** hold `plugins/dante/protocol.js` to byte vectors from
 *   netaudio (`test/fixtures/dante/netaudio-vectors.json` says where each came
 *   from). The ones marked as Dante Controller's own requests — the 2.8.9 and
 *   2.7.41 subscription pages, the 2.8.12 channel-status queries, the 2.8.15
 *   page continuation — are independent of this codec: they are what the real
 *   controller put on a real network. The captured responses are what real
 *   devices answered. netaudio's golden command bytes are its own encoder's
 *   output, so agreeing with them proves agreement, not truth.
 * - **The preset tests** read a preset Dante Controller saved, published as an
 *   example by DanteArchitect (MIT) — `test/fixtures/dante/dante-controller-preset.xml`.
 * - **The end-to-end tests** run the whole server half against the simulator.
 *   ⚠️ The simulator is built from the same codec tables, so these prove that
 *   discovery, polling, writing, read-back and the routes fit together — and
 *   nothing at all about a real Dante device. Nothing here has met one.
 *
 * Run: node --test test/dante.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as P from '../plugins/dante/protocol.js';
import { buildQuery, buildResponse, parseMessage, readName, servicesFrom, TYPE } from '../plugins/dante/mdns.js';
import {
  normaliseSettings, parseRef, plan, confirm, summarise, changesByDevice, normaliseSnapshots, snapshotOf, snapshotRoutes,
  parseCueText, describeCueAction, parseDanteOsc, blockState, blockRoutes, cellRoute, DANTE_OSC, formatLatency, formatRate
} from '../plugins/dante/core.js';
import { parseXml, readPreset, writePreset, assignRoles, presetRoutes } from '../plugins/dante/preset.js';
import { switcherCards, matchSwitcher, audioPatches, danteKey, flatDante } from '../plugins/dante/switcher.js';
import { DanteLink } from '../plugins/dante/link.js';
import { Discovery, idFromCmc } from '../plugins/dante/discovery.js';
import { writeForm } from '../plugins/dante/supervisor.js';
import activateDante from '../plugins/dante/server.js';
import { startDanteSim } from '../tools/dante-sim.mjs';
import { DeviceStore } from '../src/core/device-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, 'fixtures', 'dante', 'netaudio-vectors.json'), 'utf8'));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(25); }
  return false;
}
const bytes = (hex) => P.fromHex(hex);

/* ============================================ independent: Dante Controller */

test('2.8.9 subscription pages are byte-for-byte what Dante Controller sent, and its answers read as accepted', () => {
  const { exchanges } = V.controllerPages2809;
  assert.equal(exchanges.length, 4);
  for (const x of exchanges) {
    const records = x.records.map((r) => (r.action === 'clear' ? { rx: r.rx_channel } : { rx: r.rx_channel, channel: r.tx_channel, device: r.tx_device }));
    assert.equal(P.hex(P.buildSubscriptionPage(P.PROTOCOL.ARC_2809, x.capacity, records, x.transaction)), x.request, `${x.device} ${x.transaction}`);
    assert.deepEqual(P.writeAccepted(bytes(x.response), x.transaction), { ok: true, result: P.RESULT.SUCCESS });
  }
});

test('2.7.41 subscription pages are byte-for-byte what Dante Controller sent', () => {
  for (const c of V.controllerPages2729.cases) {
    assert.equal(P.hex(P.buildSubscriptionPage2729(c.records, c.transaction)), c.request, c.what);
  }
});

test('2.8.12 channel-status queries are what Dante Controller asked two Shure devices, and their answers parse', () => {
  const seen = [];
  for (const [device, ops] of Object.entries(V.controllerStatus280C.devices)) {
    for (const [op, x] of Object.entries(ops)) {
      const req = bytes(x.request);
      const receiver = op.startsWith('receiver');
      assert.equal(P.hex(P.buildChannelStatusQuery(0x280c, receiver, P.u16(req, 18), P.u16(req, 20), P.u16(req, 22), P.u16(req, 4))), x.request, `${device} ${op}`);
      const page = receiver ? P.parseRxStatusPage(bytes(x.response)) : P.parseTxStatusPage(bytes(x.response));
      assert.ok(page, `${device} ${op} parses`);
      /* Sanitised by the contributor: every name is X's of the right length. */
      assert.ok(page.records.every((r) => /^X+$/.test(r.label)), `${device} ${op}`);
      seen.push(`${device} ${op} ${page.records.length}`);
    }
  }
  assert.deepEqual(seen.sort(), [
    'shure_mxa920 receiver_channel_status 5', 'shure_mxa920 transmitter_channel_status 10',
    'shure_mxwapx4 receiver_channel_status 4', 'shure_mxwapx4 transmitter_channel_status 5'
  ]);
});

test('a modern inventory continues where Dante Controller continued it', () => {
  for (const side of ['receiver', 'transmitter']) {
    const [first, answer, second] = V.controllerPagination280F[side].map(bytes);
    const receiver = side === 'receiver';
    assert.equal(P.hex(P.buildChannelStatusQuery(0x280f, receiver, 1, 1, 0, P.u16(first, 4))), P.hex(first), `${side}: the first question`);
    /* The answer here is netaudio's synthetic device; the next question is the controller's own. */
    const page = receiver ? P.parseRxStatusPage(answer) : P.parseTxStatusPage(answer);
    assert.ok(page && page.more, `${side}: the answer says there is more`);
    const seen = new Set(page.records.map((r) => `${r.media}:${r.mediaId}`));
    const next = P.nextStatusRange(page, seen);
    assert.equal(P.hex(P.buildChannelStatusQuery(0x280f, receiver, next.media, next.first, 0, P.u16(second, 4))), P.hex(second), `${side}: the second question`);
  }
});

/* ===================================================== captured responses */

test('captured 2.8.9 status pages read as the devices reported them', () => {
  const pk = V.capturedStatus2809.packets;
  const rx = P.parseRxStatusPage(bytes(pk['protocol_2809_opcode_3400_id_7019.bin']));
  assert.deepEqual(rx.records.map((r) => [r.number, r.label, r.txChannel, r.txDevice, r.status, r.rxStatus, r.sampleRate]), [
    [1, 'mic-mix-1', 'mic-mix-high', 'lx-dante', 9, 0x0101, 48000],
    [2, 'mic-mix-2', 'mic-mix-high', 'lx-dante', 9, 0x0101, 48000]
  ]);
  assert.equal(P.subscriptionStatus(9, 0x0101).state, 'connected');
  const empty = P.parseRxStatusPage(bytes(pk['protocol_2809_opcode_3400_id_7013.bin']));
  assert.deepEqual(empty.records.map((r) => [r.label, r.txChannel, r.status]), [['01', null, 0], ['02', null, 0]]);
  const tx = P.parseTxStatusPage(bytes(pk['protocol_2809_opcode_2400_id_2.bin']));
  assert.deepEqual(tx.records.map((r) => [r.number, r.label, r.factory]), [[1, 'bluetooth:left', 'Left'], [2, 'bluetooth:right', 'Right']]);
  /* A device that does not do the modern queries says so with 0x0030 and nothing else. */
  const refused = P.envelope(bytes(pk['protocol_2809_opcode_2400_id_8.bin']));
  assert.equal(refused.result, P.RESULT.FRONTEND_UNAVAILABLE);
  assert.equal(P.parseTxStatusPage(bytes(pk['protocol_2809_opcode_2400_id_8.bin'])), null);
  /* The questions in the same capture are the codec's. */
  assert.equal(P.hex(P.buildChannelStatusQuery(0x2809, true, 1, 1, 0, 0x284a)), pk['protocol_2809_opcode_3400_id_28728.bin']);
  assert.equal(P.hex(P.buildChannelStatusQuery(0x2809, false, 1, 1, 0, 0x2852)), pk['protocol_2809_opcode_2400_id_1.bin']);
});

test('captured classic receive pages read with their subscriptions and statuses', () => {
  const h = V.historicalClassic.packets;
  const aes = P.parseRxPage(bytes(h['20250517_200646_429145_avio-aes3-1_get_receivers_response.bin']), 1);
  assert.deepEqual(aes.map((c) => [c.number, c.label, c.txChannel, c.txDevice, c.status, c.rxStatus]), [
    [1, 'unused-1', 'linux-mic-mix:high', 'lx-dante', 1, 0], [2, 'unused-2', 'linux-mic-mix:high', 'lx-dante', 1, 0]
  ]);
  assert.equal(P.subscriptionStatus(1, 0).name, 'UNRESOLVED');
  const lx = P.parseRxPage(bytes(h['20250517_200646_289003_lx-dante_get_receivers_response.bin']), 1);
  assert.equal(lx.length, 16);
  assert.deepEqual([lx[6].label, lx[6].txChannel, lx[6].txDevice, lx[6].status], ['windows-gaming:left', 'windows-gaming:left', 'avio-usb-1', 9]);
  assert.deepEqual([lx[10].txDevice, lx[10].status], ['avio-usb-2', 10]);
  assert.deepEqual([lx[8].txChannel, lx[8].txDevice], [null, null]);
  /* A page that says there is more must be full — this one is page 1 of 2. */
  assert.equal(P.envelope(bytes(h['20250517_200646_289003_lx-dante_get_receivers_response.bin'])).result, P.RESULT.MORE_PAGES);
  const page2 = P.parseRxPage(bytes(V.captured2729Receivers.packets['protocol_2729_opcode_3000_id_8137.bin']), 17);
  assert.equal(page2[0].number, 17);
  assert.equal(page2[0].txDevice, 'avio-usb-3');
  assert.equal(P.parseRxPage(bytes(V.captured2729Receivers.packets['protocol_2729_opcode_3000_id_8137.bin']), 1), null, 'the wrong page origin is refused, not misread');
});

test('captured device name, channel count, settings and transmit labels', () => {
  const h = V.historicalClassic.packets;
  assert.equal(P.parseDeviceName(bytes(h['core_device_name_avio-aes3-1.bin'])), 'avio-aes3-1');
  assert.deepEqual(P.parseChannelCount(bytes(h['20250517_200646_416392_avio-aes3-1_get_channel_count_response.bin'])), { tx: 2, rx: 2, capabilities: 0x0df9 });
  const s = P.parseDeviceSettings(bytes(h['core_device_settings_lx-dante.bin']));
  assert.equal(s.sampleRate, 48000);
  assert.equal(s.latencyNs, 1000000);
  assert.equal(s.minLatencyNs, 150000);
  assert.deepEqual(P.parseTxNamesPage(bytes(V.issue59.transmitterNames), 1), Array.from({ length: 16 }, (_, i) => [i + 1, `TX ${i + 1}`]));
});

test('requests agree with netaudio’s encoder (regression, not independent)', () => {
  const g = V.goldenCommands.cases;
  assert.equal(P.hex(P.buildDeviceName(7)), g['device_name:1'].hex);
  assert.equal(P.hex(P.buildChannelCount(1)), g['channel_count:2'].hex);
  assert.equal(P.hex(P.buildDeviceSettings(0)), g['device_settings:3'].hex);
  assert.equal(P.hex(P.buildReceivers(0, 0)), g['receivers:6'].hex);
  assert.equal(P.hex(P.buildReceivers(3, 9)), g['receivers:7'].hex);
  assert.equal(P.hex(P.buildTransmitters(0, 0)), g['transmitters:8'].hex);
  assert.equal(P.hex(P.buildTransmitterNames(128, 0)), g['transmitters:9'].hex);
  for (const k of ['add_subscriptions:14', 'add_subscriptions:15']) {
    const spec = g[k].spec;
    const subs = spec.subscriptions.map((s) => ({ rx: s.rx_channel, channel: s.tx_channel, device: s.tx_device }));
    assert.equal(P.hex(P.buildAddSubscriptions(subs, spec.message_id || 0)), g[k].hex, k);
  }
  assert.equal(P.hex(P.buildRemoveSubscriptions([3], 0)), g['remove_subscriptions:16'].hex);
  assert.equal(P.hex(P.buildRemoveSubscriptions([1, 2, 7, 16], 0)), g['remove_subscriptions:17'].hex);
});

test('the codec refuses rather than guesses', () => {
  assert.equal(P.envelope(Uint8Array.from([0x27, 0xff, 0x00, 0x20])), null, 'too short');
  const name = bytes(V.historicalClassic.packets['core_device_name_avio-aes3-1.bin']);
  const lying = Uint8Array.from(name); lying[3] += 1;
  assert.equal(P.parseDeviceName(lying), null, 'a declared length that is not the length received');
  for (let n = 0; n < 300; n++) {
    const junk = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n * 47) & 0xff);
    assert.equal(P.parseRxPage(junk, 1), null);
    assert.equal(P.parseTxPage(junk, 1), null);
    assert.equal(P.parseRxStatusPage(junk), null);
    assert.equal(P.parseTxStatusPage(junk), null);
  }
  assert.throws(() => P.buildAddSubscriptions([{ rx: 300, channel: 'a', device: 'b' }], 1), /1-255/);
  assert.throws(() => P.buildAddSubscriptions([{ rx: 1, channel: 'a', device: 'bad name' }], 1), /letters, digits and hyphens/);
  assert.throws(() => P.buildSubscriptionPage(P.PROTOCOL.ARC_2809, 1, [{ rx: 1, channel: 'a', device: '.' }], 1), /no "\."/);
  assert.deepEqual(P.arcProtocol('2.7.41'), { protocolId: 0x2729, modern: false, version: '2.7.41' });
  assert.equal(P.arcProtocol('2.8.9').modern, true);
  assert.equal(P.arcProtocol('2.9.0').protocolId, 0x280f, 'capped at the newest revision netaudio knows');
  assert.ok(P.arcProtocol('2.7.40').error, 'a revision netaudio has no observation of');
  assert.equal(P.arcProtocol(undefined), null);
  assert.equal(P.subscriptionStatus(0x0099, 0).state, 'unknown');
  assert.equal(P.subscriptionStatus(1, 0x0202).state, 'unknown', 'status 1 is ambiguous without its receiver status');
});

/* ================================================================== mDNS */

test('a legacy query and a compressed answer round-trip, and a looping name is refused', () => {
  const q = parseMessage(buildQuery({ id: 0x1234, questions: [{ name: P.SERVICE.ARC, type: TYPE.PTR }, { name: P.SERVICE.CMC, type: TYPE.PTR }] }));
  assert.equal(q.id, 0x1234);
  assert.equal(q.response, false);
  assert.deepEqual(q.questions.map((x) => [x.name, x.type, x.unicast]), [[P.SERVICE.ARC, TYPE.PTR, false], [P.SERVICE.CMC, TYPE.PTR, false]]);
  const inst = `Desk.${P.SERVICE.ARC}`;
  const answer = buildResponse({
    id: 0x1234, questions: q.questions,
    answers: [{ name: P.SERVICE.ARC, type: TYPE.PTR, data: inst }],
    additionals: [
      { name: inst, type: TYPE.SRV, flush: true, data: { port: 4440, target: 'Desk.local' } },
      { name: inst, type: TYPE.TXT, data: { arcp_vers: '2.8.9', mf: 'Audinate', model: 'X' } },
      { name: 'Desk.local', type: TYPE.A, data: '192.0.2.10' }
    ]
  });
  /* Compression did happen: the service type is written once and pointed at after. */
  assert.ok(answer.length < 200, `${answer.length} bytes`);
  const m = parseMessage(answer);
  assert.equal(m.response, true);
  assert.deepEqual(servicesFrom(m, [P.SERVICE.ARC]), [{
    type: '_netaudio-arc._udp.local', instance: inst, name: 'Desk', host: 'Desk.local', port: 4440,
    txt: { arcp_vers: '2.8.9', mf: 'Audinate', model: 'X' }, addresses: ['192.0.2.10']
  }]);
  /* RFC 1035 §4.1.4 by hand: "a" at 12, then a pointer back to 12 — fine; a pointer to itself — refused. */
  const ok = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0x61, 0, 1, 0x62, 0xc0, 12]);
  assert.equal(readName(ok, 15).name, 'b.a');
  const loop = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xc0, 12]);
  assert.equal(readName(loop, 12), null);
  const forward = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xc0, 14, 1, 0x61, 0]);
  assert.equal(readName(forward, 12), null, 'a pointer forwards is refused');
  assert.equal(parseMessage(answer.subarray(0, answer.length - 3)), null, 'a truncated answer is dropped whole');
  assert.deepEqual(idFromCmc({ id: '001dc10b0ad20000' }), { deviceId: '001DC10B0AD20000', mac: '00:1d:c1:0b:0a:d2' });
  assert.deepEqual(idFromCmc({ id: 'nonsense' }), { deviceId: null, mac: null });
});

/* ================================================================== core */

const dev = (name, rx, tx = [], extra = {}) => ({
  name, status: 'ok', writable: true, why: null,
  rx: rx.map((r, i) => ({ number: i + 1, label: r[0], sub: r[1] ? { channel: r[1], device: r[2] } : null, status: P.subscriptionStatus(r[1] ? 9 : 0, r[1] ? 0x0101 : 0) })),
  tx: tx.map((label, i) => ({ number: i + 1, label })),
  ...extra
});

test('settings are corrected, never refused', () => {
  const s = normaliseSettings({ manualDevices: '192.168.1.20, 10.0.0.5:4440, nope, 999.1.1.1', pollSeconds: 0, interface: 'x', discoveryTarget: '127.0.0.1:5399' });
  assert.deepEqual(s.manualDevices, ['192.168.1.20', '10.0.0.5:4440']);
  assert.equal(s.pollSeconds, 1);
  assert.equal(s.interface, '');
  assert.equal(s.discoveryTarget, '127.0.0.1:5399');
  assert.equal(normaliseSettings({}).discovery, true);
  assert.deepEqual(parseRef('Mix L@Desk'), { channel: 'Mix L', device: 'Desk' });
  assert.deepEqual(parseRef('a@b@Desk'), { channel: 'a@b', device: 'Desk' }, 'a label may hold an @; a device name cannot');
  assert.equal(parseRef('nobody'), null);
});

test('a plan sends only what differs and names everything else', () => {
  const devices = [
    dev('Desk', [['Ch 1', 'Mic 1', 'Box'], ['Ch 2', null]], ['Mix L', 'Mix R']),
    dev('Box', [['Ret 1', null]], ['Mic 1', 'Mic 2']),
    dev('Old', [['In 1', null]], [], { writable: false, why: 'Old advertises an unsupported ARC protocol 0x2600' })
  ];
  const planned = plan(devices, [
    { rx: { device: 'desk', channel: 1 }, tx: 'Mic 1@Box' },
    { rx: { device: 'Desk', channel: 'Ch 2' }, tx: { device: 'Box', channel: 'Mic 2' } },
    { rx: '1@Box', tx: 'Mix L@Desk' },
    { rx: '1@Box', tx: 'Mix R@Desk' },
    { rx: '1@Old', tx: null },
    { rx: '1@Old', tx: 'x@Desk' },
    { rx: '9@Desk', tx: null },
    { rx: '1@Gone', tx: null },
    { rx: 'Ch 2@Desk', tx: 'Mic 2@Bad Name' }
  ], { validate: (tx) => P.deviceNameProblem(tx.device) });
  const o = Object.fromEntries(planned.map((p) => [`${p.rx.device}/${p.rx.channel}`, p.outcome]));
  assert.equal(o['Desk/1'], 'same', 'already so, so not sent');
  assert.equal(o['Desk/Ch 2'] || o['Desk/2'], 'refused', 'the last route for a channel wins — and a name Dante will not take is refused');
  assert.equal(o['Box/1'], 'change');
  assert.equal(planned.find((p) => p.rx.device === 'Box').tx.channel, 'Mix R', 'the later of two routes for one channel');
  assert.equal(o['Old/1'], 'refused');
  assert.equal(o['Desk/9'], 'missing');
  assert.equal(o['1@Gone/1'] ?? planned.find((p) => p.rx.device === 'Gone').outcome, 'missing');
  assert.deepEqual([...changesByDevice(planned)], [['Box', [{ number: 1, tx: { device: 'Desk', channel: 'Mix R' } }]]]);

  /* What the devices say afterwards decides the outcome, not what was asked. */
  const after = [devices[0], dev('Box', [['Ret 1', 'Mix L', 'Desk']], ['Mic 1', 'Mic 2']), devices[2]];
  const results = confirm(planned, after);
  assert.equal(results.find((r) => r.rx.device === 'Box').outcome, 'unconfirmed');
  assert.match(results.find((r) => r.rx.device === 'Box').error, /reports Mix L@Desk/);
  const good = confirm(planned, [devices[0], dev('Box', [['Ret 1', 'Mix R', 'Desk']], ['Mic 1']), devices[2]]);
  assert.equal(good.find((r) => r.rx.device === 'Box').outcome, 'confirmed');
  assert.match(summarise(good), /1 confirmed/);
});

test('a self-subscription reported as "." reads as the device itself', () => {
  const d = dev('Desk', [['Ch 1', 'Mix L', '.']], ['Mix L']);
  assert.equal(plan([d], [{ rx: '1@Desk', tx: 'Mix L@Desk' }])[0].outcome, 'same');
  assert.equal(plan([d], [{ rx: '1@Desk', tx: 'Mix L@.' }])[0].outcome, 'same');
});

test('blocks and crosspoints', () => {
  const box = dev('Box', [['Ret 1', null], ['Ret 2', null]], ['Mic 1', 'Mic 2', 'Mic 3']);
  const desk = dev('Desk', [['Ch 1', 'Mic 1', 'Box'], ['Ch 2', 'Mic 2', 'Box'], ['Ch 3', null]], ['Mix L']);
  assert.deepEqual(blockState(desk, box), { count: 2, straight: false, span: 3 });
  assert.deepEqual(blockRoutes(desk, box).map((r) => r.tx && r.tx.channel), ['Mic 1', 'Mic 2', 'Mic 3']);
  const full = dev('Desk', [['Ch 1', 'Mic 1', 'Box'], ['Ch 2', 'Mic 2', 'Box'], ['Ch 3', 'Mic 3', 'Box']]);
  assert.equal(blockState(full, box).straight, true);
  assert.deepEqual(blockRoutes(full, box).map((r) => r.tx), [null, null, null], 'a straight block clears');
  assert.equal(cellRoute(desk, desk.rx[0], box, box.tx[0]).tx, null, 'a lit cell clears');
  assert.deepEqual(cellRoute(desk, desk.rx[2], box, box.tx[2]).tx, { device: 'Box', channel: 'Mic 3' });
});

test('snapshots keep every channel, and recall asks for all of them', () => {
  const devices = [dev('Desk', [['Ch 1', 'Mic 1', 'Box'], ['Ch 2', null]], ['Mix L']), dev('Box', [], ['Mic 1'])];
  const s = snapshotOf(devices, 'Show A', [], '2026-10-06T10:00:00.000Z');
  assert.deepEqual(s.devices.map((d) => d.name), ['Desk'], 'a device with nothing to receive is not saved');
  assert.deepEqual(snapshotRoutes(s), [
    { rx: { device: 'Desk', channel: 1 }, tx: { channel: 'Mic 1', device: 'Box' } },
    { rx: { device: 'Desk', channel: 2 }, tx: null }
  ]);
  assert.deepEqual(normaliseSnapshots([s, { ...s, name: 'show a' }, { name: '' }]).map((x) => x.name), ['Show A'], 'names are unique ignoring case');
});

test('the cue field and the OSC addresses', () => {
  const actions = parseCueText('snapshot Show A; 1@Amp-1 <- Mix L@Desk; Front L@Amp-1 <- none');
  assert.deepEqual(actions, [
    { kind: 'dante:route', snapshot: 'Show A' },
    { kind: 'dante:route', rx: '1@Amp-1', tx: 'Mix L@Desk' },
    { kind: 'dante:route', rx: 'Front L@Amp-1', tx: null }
  ]);
  assert.equal(actions.map(describeCueAction).join('; '), 'Dante snapshot Show A; 1@Amp-1 <- Mix L@Desk; Front L@Amp-1 <- none');
  assert.throws(() => parseCueText('Amp-1 gets Mix L'), /snapshot <name>/);
  assert.deepEqual(parseDanteOsc('/lp/dante/route/Amp-1/2', ['Mix R@Desk']), { route: { rx: { device: 'Amp-1', channel: 2 }, tx: { channel: 'Mix R', device: 'Desk' } } });
  assert.deepEqual(parseDanteOsc('/lp/dante/route/Amp-1/Front-L', ['']).route.rx.channel, 'Front L');
  assert.deepEqual(parseDanteOsc('/lp/dante/clear/Amp-1/2', [0]), { released: true });
  assert.equal(parseDanteOsc('/lp/dante/snapshot/Show-A/recall', []).snapshot, 'Show A');
  assert.equal(parseDanteOsc('/lp/dante/snapshot/Show-A/recall', [0]).released, true);
  assert.ok(parseDanteOsc('/lp/dante/nonsense', []).error);
  assert.equal(parseDanteOsc('/lp/screen/1/take', []), null, 'not ours');
  for (const e of DANTE_OSC) assert.ok(e.address.startsWith('/lp/dante/'));
  assert.equal(formatLatency(1000000), '1 ms');
  assert.equal(formatLatency(250000), '0.25 ms');
  assert.equal(formatRate(44100), '44.1 kHz');
});

/* =============================================================== presets */

const presetXml = readFileSync(join(here, 'fixtures', 'dante', 'dante-controller-preset.xml'), 'utf8');

test('a preset Dante Controller saved reads as its roles and subscriptions', () => {
  const p = readPreset(presetXml);
  assert.equal(p.version, '2.1.0');
  assert.equal(p.roles.length, 9);
  const desk = p.roles.find((r) => r.name === 'AllenHth-Dante-Karte-IliveIo');
  assert.equal(desk.deviceId, '001DC10B0AD20000');
  assert.equal(desk.tx.length, 64);
  assert.equal(desk.tx[0].labels[0], 'Ilive In A1');
  assert.equal(desk.rx.length, 64);
  assert.equal(desk.sampleRate, 48000);
  assert.equal(desk.latencyUs, 1000);
  const mon = p.roles.find((r) => r.name === 'KS-FMOD-9732--4-Mon1-4');
  assert.deepEqual(mon.rx.map((c) => c.sub && c.sub.channel), ['Ilive In A3', 'Ilive In A4', 'Ilive In A5', 'Ilive In A6']);
  assert.equal(p.roles.reduce((n, r) => n + r.rx.filter((c) => c.sub).length, 0), 17);
});

test('the preset reader refuses what a preset never needs', () => {
  assert.throws(() => readPreset('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "boom">]><preset><device><name>&e;</name></device></preset>'), /document type or entities/);
  assert.throws(() => readPreset('<network version="1"/>'), /legacy/);
  assert.throws(() => readPreset('<preset><device><name>A</name></device><device><name>a</name></device></preset>'), /two roles/);
  assert.throws(() => readPreset('<preset><device><name>A</name><rxchannel danteId="1"/><rxchannel danteId="1"/></device></preset>'), /twice/);
  assert.throws(() => parseXml('<a><b></a>'), /closes/);
  assert.equal(parseXml('<a x="1 &amp; 2"><![CDATA[<raw>]]>&#65;&lt;</a>').text, '<raw>A<');
});

test('a preset written here reads back, and applying it clears what it does not list', () => {
  const devices = [
    dev('Desk', [['Ch 1', 'Mic 1', 'Box'], ['Ch 2', null]], ['Mix L & Co'], { deviceId: '001DC1000001000', sampleRate: 48000, latencyNs: 1000000 }),
    dev('Box', [['Ret 1', 'Mix L & Co', 'Desk']], ['Mic 1'])
  ];
  const xml = writePreset({ name: 'Test <1>', devices });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8" standalone="yes"\?>\n<preset version="2.1.0">/);
  assert.match(xml, /<subscribed_channel>Mix L &amp; Co<\/subscribed_channel>/);
  assert.match(xml, /<unicast_latency>1000<\/unicast_latency>/);
  const back = readPreset(xml);
  assert.equal(back.name, 'Test <1>');
  assert.deepEqual(back.roles.map((r) => r.rx.map((c) => c.sub)), [[{ channel: 'Mic 1', device: 'Box' }, null], [{ channel: 'Mix L & Co', device: 'Desk' }]]);

  /* Onto a network where Desk has a third channel the preset never saw. */
  const live = [dev('Desk', [['Ch 1', null], ['Ch 2', 'Mic 1', 'Box'], ['Ch 3', 'Mic 1', 'Box']], ['Mix L & Co']), devices[1]];
  const assignments = assignRoles(back, live);
  assert.deepEqual(assignments.map((a) => [a.role, a.device, a.by]), [['Desk', 'Desk', 'name'], ['Box', 'Box', 'name']]);
  const routes = presetRoutes(back, live, assignments);
  const planned = plan(live, routes);
  assert.deepEqual(planned.map((p) => [p.rx.device, p.rx.channel, p.outcome]), [['Desk', 1, 'change'], ['Desk', 2, 'change'], ['Desk', 3, 'change'], ['Box', 1, 'same']]);
  assert.equal(routes.find((r) => r.rx.channel === 3).implied, true, 'Dante Controller clears a channel the preset does not list');
  assert.deepEqual(assignRoles(back, live, { Desk: '' }).find((a) => a.role === 'Desk'), { role: 'Desk', device: null, by: 'skipped' });
  assert.equal(assignRoles(back, live, { Desk: 'Box' }).find((a) => a.role === 'Desk').by, 'chosen');
});

/* ============================================================== switcher */

function simulatorStore() {
  const merge = (a, b) => {
    if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b;
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
    return out;
  };
  const s = new DeviceStore();
  s.hydrate(merge(fixture('sim-6.2.73-dante.json'), fixture('sim-6.2.73-audio.json')));
  return s;
}

test('the switcher’s card is read from the store and matched by its Dante name', () => {
  const store = simulatorStore();
  const cards = switcherCards(store);
  assert.equal(cards.length, 1, 'frames 2–4 of the simulator report no card');
  assert.deepEqual([cards[0].frame, cards[0].name, cards[0].type, cards[0].rx.size, cards[0].tx.size], ['1', 'AQL-Simulator', 'BK2_64X64', 64, 64]);
  assert.deepEqual(cards[0].addresses, [], '0.0.0.0 is no address');
  assert.deepEqual(cards[0].macs, ['66:55:44:33:22:11', '77:66:55:44:33:22']);
  const devices = [{ name: 'aql-simulator', address: '10.0.0.9' }, { name: 'Desk', address: '10.0.0.2' }];
  assert.equal(matchSwitcher(devices, cards).get('aql-simulator').by, 'name');
  assert.equal(matchSwitcher([{ name: 'Card', mac: '66:55:44:33:22:11' }], cards).get('Card').by, 'MAC');
  assert.equal(matchSwitcher([{ name: 'Other' }], cards, 'other').get('Other').by, 'setting');
  assert.equal(matchSwitcher([{ name: 'Other' }], cards).size, 0);
  assert.equal(flatDante(2, 3), 11);
  assert.equal(danteKey(11), 'DANTE_2_CHANNEL_3');
});

test('the Audio Matrix side of each of the card’s channels', () => {
  const { rx, tx } = audioPatches(simulatorStore(), '1');
  assert.deepEqual(rx.get(13), ['Output 7 ch 1'], 'DANTE_2_CHANNEL_5 feeds Output 7 channel 1 in the simulator');
  assert.deepEqual(rx.get(1), ['Output 1 ch 1']);
  assert.equal(tx.get(1), 'Input 1 ch 1', 'Dante transmit 1 carries Input 1 channel 1');
  assert.deepEqual(audioPatches(new DeviceStore(), '1').rx.size, 0, 'an empty store is no matrix');
});

/* ================================================================== link */

test('the link matches answers by transaction id, retries, and gives up', async (t) => {
  const quiet = dgram.createSocket('udp4');
  const heard = [];
  let answerAfter = 2;
  quiet.on('message', (msg, rinfo) => {
    heard.push(P.transactionOf(new Uint8Array(msg)));
    if (heard.length < answerAfter) return;
    const reply = Uint8Array.from(msg);
    reply[4] ^= 0xff;    // a stray answer to some other transaction first
    quiet.send(reply, rinfo.port, rinfo.address);
    quiet.send(Uint8Array.from([...msg.subarray(0, 8), 0, 1]), rinfo.port, rinfo.address);
  });
  await new Promise((r) => quiet.bind(0, '127.0.0.1', r));
  t.after(() => quiet.close());
  const link = new DanteLink({ address: '127.0.0.1', port: quiet.address().port, timeoutMs: 80, retries: 2 });
  t.after(() => link.close());
  const answer = await link.request(P.buildDeviceName);
  assert.equal(heard.length, 2, 'asked twice before the answer came');
  assert.equal(heard[0], heard[1], 'a retry keeps its transaction id');
  assert.equal(P.transactionOf(answer), heard[1]);
  answerAfter = Infinity;
  heard.length = 0;
  await assert.rejects(() => link.request(P.buildDeviceName), /no answer/);
  assert.equal(heard.length, 3, 'one try and two retries');
});

/* ======================================================== end to end (sim) */

/** The plugin's server half on a stand-in host, as `hyperdeck.test.js` does it. */
function hostFor(settings) {
  const routes = new Map();
  const contributions = [];
  const disposers = [];
  const docs = new Map();
  const changes = [];
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  let current = normaliseSettings(settings);
  const ctx = {
    HttpError,
    log: () => {},
    settings: { get: () => current, onChange: (fn) => changes.push(fn) },
    route: (method, path, fn) => routes.set(`${method} ${path}`, fn),
    stream: () => ({ send() {} }),
    onDispose: (fn) => disposers.push(fn),
    contribute: (point, spec) => contributions.push({ point, spec }),
    storage: { load: async (name) => docs.get(name) ?? null, save: async (name, data) => { docs.set(name, data); } }
  };
  const call = async (method, path, body, query = '') => {
    let status = 0;
    let payload = null;
    const res = { writeHead: (s) => { status = s; }, end: (x) => { payload = x; } };
    try {
      await routes.get(`${method} ${path}`)({}, res, {
        url: new URL(`http://127.0.0.1/__lpp/dante${path}${query}`),
        readJson: async () => body ?? {},
        json: (s, b) => { status = s; payload = b; }
      });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      status = err.status;
      payload = { error: err.message };
    }
    return { status, body: payload };
  };
  const set = async (patch) => { current = normaliseSettings({ ...current, ...patch }); for (const fn of changes) await fn(current); };
  return { ctx, call, set, contributions, docs, stop: () => disposers.reverse().forEach((fn) => fn()) };
}

const devicesOf = async (host) => (await host.call('GET', '/')).body.devices;
const named = async (host, name) => (await devicesOf(host)).find((d) => d.name === name);

test('end to end against the simulator: discovery, both dialects, all three write forms, read-back', async (t) => {
  const sim = await startDanteSim({ settleMs: 1500 });
  const host = hostFor({ discoveryTarget: sim.target, pollSeconds: 1 });
  await activateDante(host.ctx);
  t.after(async () => { host.stop(); await sim.close(); });

  assert.ok(await until(async () => (await devicesOf(host)).filter((d) => d.status === 'ok').length === 5), 'five devices found and read');
  const list = await devicesOf(host);
  const by = Object.fromEntries(list.map((d) => [d.name, d]));
  assert.deepEqual(Object.fromEntries(list.map((d) => [d.name, [d.protocol, d.inventory, d.form]])), {
    'AQL-Simulator': ['2.7.41', 'classic', 'page-2729'],
    'Amp-Rack': ['2.8.15', 'modern', 'modern'],
    'FOH-Desk': ['2.8.9', 'modern', 'modern'],
    'Stagebox-A': ['2.7.41', 'classic', 'page-2729'],
    'Wall-Plate': ['2.8.1', 'classic', 'classic']
  });
  assert.equal(by['AQL-Simulator'].rx.length, 64, 'four classic pages of sixteen');
  assert.equal(by['AQL-Simulator'].tx.length, 64, 'two classic pages of thirty-two');
  assert.equal(by['FOH-Desk'].rx.length, 16, 'two modern pages');
  assert.deepEqual([by['FOH-Desk'].sampleRate, by['FOH-Desk'].latencyNs], [48000, 1000000]);
  assert.equal(by['FOH-Desk'].rx[0].sub.channel, 'Mic 1');
  assert.equal(by['Amp-Rack'].rx[3].status.name, 'UNRESOLVED', 'a source not on the network');
  assert.equal(by['Stagebox-A'].deviceId, '001DC10000020000', 'from the CMC advertisement');

  const r = await host.call('POST', '/apply', { routes: [
    { rx: '9@FOH-Desk', tx: 'Mic 9@Stagebox-A' },
    { rx: 'Ret 3@Stagebox-A', tx: 'Aux 3@FOH-Desk' },
    { rx: 'Speaker L@Wall-Plate', tx: 'Mix L@FOH-Desk' },
    { rx: '4@Amp-Rack', tx: null },
    { rx: '1@FOH-Desk', tx: 'Mic 1@Stagebox-A' }
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.results.map((x) => x.outcome), ['confirmed', 'confirmed', 'confirmed', 'confirmed', 'same']);
  assert.equal(r.body.results[0].status.name, 'IN_PROGRESS', 'confirmed is the subscription; its status is reported beside it');
  const writes = (name) => sim.device(name).received.filter((x) => [0x3010, 0x3014, 0x3410].includes(x.opcode)).map((x) => `${x.protocolId.toString(16)}/${x.opcode.toString(16)}`);
  assert.deepEqual(writes('FOH-Desk'), ['2809/3410']);
  assert.deepEqual(writes('Stagebox-A'), ['2729/3010']);
  assert.deepEqual(writes('Wall-Plate'), ['27ff/3010']);
  assert.deepEqual(writes('Amp-Rack'), ['280f/3410']);
  assert.ok(await until(async () => (await named(host, 'FOH-Desk')).rx[8].status.name === 'DYNAMIC', 6000), 'settles to connected on a later poll');

  /* Somebody else changes a route; the next poll shows it. */
  sim.setSubscription('Wall-Plate', 2, { channel: 'Mix R', device: 'FOH-Desk' });
  assert.ok(await until(async () => ((await named(host, 'Wall-Plate')).rx[1].sub || {}).channel === 'Mix R', 4000));

  /* Clears in the classic form go as a remove. */
  const c = await host.call('POST', '/apply', { routes: [{ rx: '2@Wall-Plate', tx: null }] });
  assert.equal(c.body.results[0].outcome, 'confirmed');
  assert.deepEqual(writes('Wall-Plate').slice(-1), ['27ff/3014']);
});

test('end to end: a device that refuses, one that ignores, one that is silent, one we cannot write', async (t) => {
  const sim = await startDanteSim({ settleMs: 0, devices: [
    { name: 'Refuser', arcp: '2.8.9', tx: ['Out'], rx: ['In'], refuseWrites: true },
    { name: 'Ignorer', arcp: '2.7.41', tx: ['Out'], rx: ['In'], ignoreWrites: true },
    { name: 'Ancient', arcp: '2.6.0', tx: ['Out'], rx: ['In'] },
    { name: 'Classic-Only', arcp: '2.8.9', tx: ['Out'], rx: ['In'], noModernQueries: true }
  ] });
  const host = hostFor({ discoveryTarget: sim.target, pollSeconds: 1 });
  await activateDante(host.ctx);
  t.after(async () => { host.stop(); await sim.close(); });
  assert.ok(await until(async () => (await devicesOf(host)).filter((d) => d.status === 'ok').length === 4));
  const ancient = await named(host, 'Ancient');
  assert.equal(ancient.writable, false, 'read, never written');
  assert.match(ancient.why, /unsupported ARC protocol/);
  assert.equal((await named(host, 'Classic-Only')).inventory, 'classic', 'a 2.8.9 device that answers 0x0030 is read the classic way');
  const r = await host.call('POST', '/apply', { routes: [
    { rx: '1@Refuser', tx: 'Out@Ignorer' }, { rx: '1@Ignorer', tx: 'Out@Refuser' }, { rx: '1@Ancient', tx: 'Out@Refuser' }
  ] });
  assert.equal(r.status, 409);
  const o = Object.fromEntries(r.body.results.map((x) => [x.rx.device, [x.outcome, x.error]]));
  assert.equal(o.Refuser[0], 'refused');
  assert.match(o.Refuser[1], /refused the change: the device answered 0x0022/);
  assert.equal(o.Ignorer[0], 'unconfirmed', 'it said yes and changed nothing — the read-back says so');
  assert.equal(o.Ancient[0], 'refused');
});

test('end to end: snapshots, presets, OSC, the setup file, a device by address', async (t) => {
  const sim = await startDanteSim({ settleMs: 0 });
  const host = hostFor({ discoveryTarget: sim.target, pollSeconds: 1 });
  await activateDante(host.ctx);
  t.after(async () => { host.stop(); await sim.close(); });
  assert.ok(await until(async () => (await devicesOf(host)).filter((d) => d.status === 'ok').length === 5));

  const saved = await host.call('POST', '/snapshots', { name: 'Show A' });
  assert.equal(saved.status, 200);
  assert.equal(host.docs.get('dante-snapshots').snapshots[0].name, 'Show A');
  await host.call('POST', '/apply', { routes: [{ rx: '1@Amp-Rack', tx: null }, { rx: '2@Amp-Rack', tx: 'Aux 4@FOH-Desk' }] });
  const dry = await host.call('POST', '/snapshots/recall', { name: 'show a', dryRun: true });
  assert.equal(dry.body.results.filter((x) => x.outcome === 'change').length, 2, 'only what differs');
  const back = await host.call('POST', '/snapshots/recall', { name: 'Show A' });
  assert.equal(back.status, 200, JSON.stringify(back.body.error));
  assert.equal((await named(host, 'Amp-Rack')).rx[1].sub.channel, 'Mix R');

  /* Export, change the network, read the export back: the difference is what changed. */
  const exported = await host.call('GET', '/preset', null, '?name=Before');
  assert.equal(exported.status, 200);
  assert.equal(readPreset(exported.body).roles.length, 5);
  await host.call('POST', '/apply', { routes: [{ rx: '1@Amp-Rack', tx: 'Aux 1@FOH-Desk' }] });
  const diff = await host.call('POST', '/preset/diff', { xml: exported.body });
  const changes = diff.body.results.filter((x) => x.outcome === 'change');
  assert.deepEqual(changes.map((x) => [x.rx.device, x.rx.channel, x.from.channel, x.tx.channel]), [['Amp-Rack', 1, 'Aux 1', 'Mix L']]);
  assert.ok(diff.body.assignments.every((a) => a.by === 'device id'), 'the export carries each device id');
  const stale = await host.call('POST', '/preset/apply', { xml: exported.body, digest: 'not-the-one-shown' });
  assert.equal(stale.status, 409, 'a difference that is not the one shown is not applied');
  const applied = await host.call('POST', '/preset/apply', { xml: exported.body, digest: diff.body.digest });
  assert.equal(applied.status, 200);
  assert.equal((await named(host, 'Amp-Rack')).rx[0].sub.channel, 'Mix L');
  const dc = await host.call('POST', '/preset/diff', { xml: presetXml });
  assert.ok(dc.body.assignments.every((a) => a.device === null), 'none of the example preset’s devices are on this network');

  const osc = host.contributions.find((c) => c.point === 'oscAddress').spec;
  assert.equal(osc.prefix, '/lp/dante/');
  assert.equal((await osc.handle('/lp/dante/route/Amp-Rack/3', ['Aux 2@FOH-Desk'])).ok, true);
  assert.equal((await named(host, 'Amp-Rack')).rx[2].sub.channel, 'Aux 2');
  assert.deepEqual(await osc.handle('/lp/dante/clear/Amp-Rack/3', [0]), { ok: true, summary: '/lp/dante/clear/Amp-Rack/3 — released, nothing sent', count: 0 });
  assert.equal((await osc.handle('/lp/dante/clear/Amp-Rack/3', [])).ok, true);
  assert.equal((await named(host, 'Amp-Rack')).rx[2].sub, null);
  assert.equal((await osc.handle('/lp/dante/snapshot/Show-A/recall', [1])).ok, true);
  assert.equal((await osc.handle('/lp/dante/route/Nobody/1', [''])).ok, false);

  const section = host.contributions.find((c) => c.point === 'configSection').spec;
  assert.deepEqual([section.key, section.group], ['danteSnapshots', 'installation']);
  const out = await section.export();
  await section.import([...out, { name: 'From a file', devices: [{ name: 'Amp-Rack', rx: [{ number: 1, sub: null }] }] }]);
  assert.deepEqual((await host.call('GET', '/snapshots')).body.snapshots.map((s) => s.name), ['Show A', 'From a file']);

  /* Discovery off, one device by address: it is read with no advertisement to go on. */
  const wall = sim.device('Wall-Plate');
  await host.set({ discovery: false, manualDevices: [`127.0.0.1:${wall.port}`] });
  assert.ok(await until(async () => (await named(host, 'Wall-Plate'))?.status === 'ok'));
  await wait(400);
  /* The simulator answers the question for all five; only the one configured counts. */
  assert.deepEqual((await devicesOf(host)).map((d) => [d.name, d.source]), [['Wall-Plate', 'manual']]);
});

test('a device that stops answering is marked, and comes back', async (t) => {
  const sim = await startDanteSim({ settleMs: 0, devices: [{ name: 'Flaky', arcp: '2.7.41', tx: ['Out'], rx: ['In'] }] });
  const host = hostFor({ discoveryTarget: sim.target, pollSeconds: 1 });
  await activateDante(host.ctx);
  t.after(async () => { host.stop(); await sim.close(); });
  assert.ok(await until(async () => (await named(host, 'Flaky'))?.status === 'ok'));
  sim.device('Flaky').silent = true;
  assert.ok(await until(async () => (await named(host, 'Flaky')).status === 'unreachable', 9000), 'two missed polls');
  const refused = await host.call('POST', '/apply', { routes: [{ rx: '1@Flaky', tx: 'Out@Flaky' }] });
  assert.equal(refused.body.results[0].outcome, 'refused', 'nothing is sent to a device that is not answering');
  sim.device('Flaky').silent = false;
  assert.ok(await until(async () => (await named(host, 'Flaky')).status === 'ok', 9000));
});

test('discovery never binds 5353 and asks from a port of its own', async (t) => {
  const sim = await startDanteSim({ settleMs: 0, devices: [{ name: 'One', arcp: '2.8.9', tx: [], rx: ['In'] }] });
  const d = new Discovery({ target: { address: '127.0.0.1', port: sim.mdnsPort }, browseMs: 60000 });
  t.after(async () => { d.stop(); await sim.close(); });
  await d.start();
  assert.ok(await until(() => d.list().length === 1));
  assert.deepEqual(d.list().map((x) => [x.name, x.address, x.port, x.txt.arcp_vers]), [['One', '127.0.0.1', sim.device('One').port, '2.8.9']]);
  const from = sim.queries[0].from.split(':');
  assert.notEqual(Number(from[1]), 5353);
  assert.ok(d.sockets.every(({ socket }) => socket.address().port !== 5353));
});

test('a supervisor with nothing read has nothing to write', () => {
  assert.equal(writeForm({ status: 'reading', name: 'X' }).form, null);
  assert.equal(writeForm({ status: 'ok', name: 'X', inventory: 'modern', protocol: { protocolId: 0x2809, modern: true } }).form, 'modern');
  assert.equal(writeForm({ status: 'ok', name: 'X', inventory: 'classic', protocol: null }).form, 'classic', 'a device by address that read cleanly the classic way');
});

test('a redundant device answering on both networks keeps one address', () => {
  const d = new Discovery({ browseMs: 30000 });
  const answer = (address) => buildResponse({
    questions: [{ name: P.SERVICE.ARC, type: TYPE.PTR }],
    answers: [{ name: P.SERVICE.ARC, type: TYPE.PTR, data: `Desk.${P.SERVICE.ARC}` }],
    additionals: [
      { name: `Desk.${P.SERVICE.ARC}`, type: TYPE.SRV, data: { port: 4440, target: 'Desk.local' } },
      { name: `Desk.${P.SERVICE.ARC}`, type: TYPE.TXT, data: { arcp_vers: '2.8.9' } },
      { name: 'Desk.local', type: TYPE.A, data: address }
    ]
  });
  let changes = 0;
  d.on('change', () => { changes += 1; });
  d.onMessage(Buffer.from(answer('192.168.1.10')), { address: '192.168.1.10', port: 5353 });
  d.onMessage(Buffer.from(answer('192.168.2.10')), { address: '192.168.2.10', port: 5353 });
  d.onMessage(Buffer.from(answer('192.168.1.10')), { address: '192.168.1.10', port: 5353 });
  assert.deepEqual(d.list().map((x) => x.address), ['192.168.1.10']);
  assert.equal(changes, 1, 'the secondary network’s answer is not a change of address');
});
