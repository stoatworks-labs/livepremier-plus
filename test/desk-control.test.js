/*
 * A lighting desk driving the switcher (`plugins/desk-control/`): the packets,
 * which desk is in control, what the channels ask for, the fixture files, and
 * the supervisor end to end — real UDP on loopback, a pretend switcher on AWJ.
 * The live checks (the simulator, MagicQ on this Mac) are in
 * docs/DESK-CONTROL.md's status block.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import {
  OP, parseArtnet, buildArtDmx, buildArtPoll, buildArtTimeCode, buildPollReplies, parsePollReply,
  splitPortAddress, formatPortAddress, STYLE_MEDIA,
} from '../src/core/artnet.js';
import { parseSacn, buildSacnData, outOfOrder, multicastGroup, OPTION_PREVIEW, OPTION_TERMINATED } from '../src/core/sacn.js';
import { DmxInput, SACN_LOSS_MS, ARTNET_LOSS_MS, MAX_SOURCES } from '../src/core/dmx-input.js';
import {
  layout, patchCsv, DeskEngine, CONTROL, readFixture, sourceOf, sourceValue, opacityOf, footprint,
} from '../src/core/dmx-personality.js';
import { descriptionXml, gdtfFile, gdtfName, FIXTURE_KINDS } from '../src/core/desk-gdtf.js';
import { unzipStore } from '../src/core/zip.js';
import { normaliseDesk, deskChanged, DEFAULT_DESK, allowed } from '../plugins/desk-control/core.js';
import { DeskSupervisor } from '../plugins/desk-control/supervisor.js';
import { AwjLink } from '../server/awj-link.js';
import { NLC } from '../src/core/dialect.js';
import { commandsFor } from '../src/core/commands.js';
import { toAwj } from '../src/core/paths.js';
import { fakeAwj } from './helpers/fake-awj.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/* ------------------------------------------------------------- Art-Net */

test('Art-Net: an ArtDmx round-trips, with its 15-bit Port-Address', () => {
  const data = Uint8Array.from({ length: 512 }, (_, i) => i & 0xff);
  const p = parseArtnet(buildArtDmx(0x1234 & 0x7fff, data, { sequence: 7, physical: 2 }));
  assert.equal(p.op, OP.DMX);
  assert.equal(p.portAddress, 0x1234);
  assert.equal(p.sequence, 7);
  assert.equal(p.physical, 2);
  assert.deepEqual([...p.data.subarray(0, 4)], [0, 1, 2, 3]);
  assert.deepEqual(splitPortAddress(0x1234), { net: 0x12, subNet: 0x3, universe: 0x4 });
  assert.equal(formatPortAddress(0x1234), '18:3:4');
  assert.equal(parseArtnet(Buffer.from('not art-net at all')), null);
});

test('Art-Net: ArtPoll and ArtTimeCode are read', () => {
  assert.equal(parseArtnet(buildArtPoll()).op, OP.POLL);
  const tc = parseArtnet(buildArtTimeCode({ hours: 1, minutes: 2, seconds: 3, frames: 4, type: 1 }));
  assert.equal(tc.op, OP.TIMECODE);
  assert.deepEqual([tc.hours, tc.minutes, tc.seconds, tc.frames, tc.rate, tc.dropFrame], [1, 2, 3, 4, 25, false]);
});

test('Art-Net: ArtPollReply says media server, four ports a reply, and which universes have a desk', () => {
  const replies = buildPollReplies({
    ip: [2, 0, 0, 10], universes: [0, 1, 2, 3, 4, 17], shortName: 'LivePremier Plus', longName: 'x', active: new Set([1]),
  });
  /* 0–3 share a reply; 4 is in the same sixteen but the fifth port; 17 is another sub-net. */
  assert.equal(replies.length, 3);
  for (const b of replies) assert.equal(b.length, 239);
  const first = parsePollReply(replies[0]);
  assert.deepEqual(first.universes, [0, 1, 2, 3]);
  assert.deepEqual(first.active, [false, true, false, false]);
  assert.deepEqual(first.ip, [2, 0, 0, 10]);
  assert.equal(replies[0][200], STYLE_MEDIA);
  assert.deepEqual(parsePollReply(replies[1]).universes, [4]);
  assert.deepEqual(parsePollReply(replies[2]).universes, [17]);
  /* BindIndex counts the replies from one node, from 1. */
  assert.deepEqual(replies.map((b) => b[211]), [1, 2, 3]);
});

/* ---------------------------------------------------------------- sACN */

test('sACN: a data packet round-trips; preview and terminated are flags', () => {
  const data = new Uint8Array(512).fill(9);
  const p = parseSacn(buildSacnData(300, data, { cid: 'ab'.repeat(16), sourceName: 'MA3', priority: 150, sequence: 200 }));
  assert.equal(p.kind, 'data');
  assert.equal(p.universe, 300);
  assert.equal(p.priority, 150);
  assert.equal(p.sequence, 200);
  assert.equal(p.sourceName, 'MA3');
  assert.equal(p.cid, 'ab'.repeat(16));
  assert.equal(p.data.length, 512);
  assert.equal(p.preview, false);
  assert.equal(parseSacn(buildSacnData(1, data, { options: OPTION_PREVIEW })).preview, true);
  assert.equal(parseSacn(buildSacnData(1, data, { options: OPTION_TERMINATED })).terminated, true);
  assert.equal(parseSacn(buildArtPoll()), null);
});

test('sACN: the multicast group and the out-of-order rule', () => {
  assert.equal(multicastGroup(1), '239.255.0.1');
  assert.equal(multicastGroup(256), '239.255.1.0');
  assert.equal(outOfOrder(null, 5), false);
  assert.equal(outOfOrder(10, 11), false);
  assert.equal(outOfOrder(10, 10), true);
  assert.equal(outOfOrder(10, 0), true);
  assert.equal(outOfOrder(10, 246), false);      /* -20: a restarted source, accepted */
  assert.equal(outOfOrder(255, 0), false);        /* wrapped */
});

/* ------------------------------------------------------- who is in control */

const level = (v) => new Uint8Array(512).fill(v);

test('arbitration: highest priority wins, Art-Net counts as 100, and a quiet source is let go', () => {
  const input = new DmxInput({ universes: [1] });
  const r1 = input.artnet({ ip: '2.0.0.1', portAddress: 0, data: level(10) }, 0);
  assert.equal(r1.active, 'artnet:2.0.0.1:0');
  assert.equal(r1.activeChanged, true);
  const r2 = input.sacn(parseSacn(buildSacnData(1, level(20), { cid: '01'.repeat(16), priority: 150 })), 10);
  assert.equal(r2.active, `sacn:${'01'.repeat(16)}`);
  assert.equal(input.frame(1)[0], 20);
  /* The sACN main goes quiet; the Art-Net desk is in control again. */
  input.artnet({ ip: '2.0.0.1', portAddress: 0, data: level(10) }, SACN_LOSS_MS);
  const lost = input.expire(SACN_LOSS_MS + 20);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].active, 'artnet:2.0.0.1:0');
  assert.equal(input.frame(1)[0], 10);
  assert.equal(input.expire(SACN_LOSS_MS + ARTNET_LOSS_MS + 100)[0].active, null);
  assert.equal(input.frame(1), null);
});

test('arbitration: equal priority is the lowest key, every time — not whoever booted first', () => {
  const input = new DmxInput({ universes: [1] });
  input.artnet({ ip: '2.0.0.9', portAddress: 0, data: level(9) }, 0);
  input.artnet({ ip: '2.0.0.1', portAddress: 0, data: level(1) }, 1);
  assert.equal(input.frame(1)[0], 1);
});

test('arbitration: preview data and alternate START codes never drive; terminated lets go; old packets are dropped', () => {
  const input = new DmxInput({ universes: [1] });
  const cid = '02'.repeat(16);
  assert.equal(input.sacn(parseSacn(buildSacnData(1, level(5), { cid, options: OPTION_PREVIEW })), 0), null);
  assert.equal(input.sacn(parseSacn(buildSacnData(1, level(5), { cid, startCode: 0xdd })), 0), null);
  input.sacn(parseSacn(buildSacnData(1, level(5), { cid, sequence: 10 })), 0);
  assert.equal(input.sacn(parseSacn(buildSacnData(1, level(6), { cid, sequence: 9 })), 1), null);
  assert.equal(input.frame(1)[0], 5);
  const end = input.sacn(parseSacn(buildSacnData(1, level(6), { cid, sequence: 11, options: OPTION_TERMINATED })), 2);
  assert.equal(end.active, null);
  assert.equal(end.why, 'terminated');
});

test('arbitration: a fifth desk on one universe is counted, not tracked; unwatched universes are ignored', () => {
  const input = new DmxInput({ universes: [1] });
  for (let i = 1; i <= MAX_SOURCES + 1; i++) input.artnet({ ip: `2.0.0.${i}`, portAddress: 0, data: level(i) }, i);
  assert.equal(input.describe(10)[0].sources.length, MAX_SOURCES);
  assert.equal(input.describe(10)[0].exceeded, true);
  assert.equal(input.artnet({ ip: '2.0.0.1', portAddress: 5, data: level(1) }, 0), null);
});

/* ------------------------------------------------------------- the patch */

test('the patch: Master, then each screen and its layers; a screen never straddles two universes', () => {
  const { fixtures, universes } = layout({ destinations: ['S1', 'S2'], layers: 4, firstUniverse: 1 });
  assert.deepEqual(fixtures.map((f) => `${f.id}@${f.universe}.${f.address}`),
    ['master@1.1', 'S1@1.5', 'S1.L1@1.9', 'S1.L2@1.12', 'S1.L3@1.15', 'S1.L4@1.18',
      'S2@1.21', 'S2.L1@1.25', 'S2.L2@1.28', 'S2.L3@1.31', 'S2.L4@1.34']);
  assert.deepEqual(universes, [1]);
  const block = footprint('screen') + 16 * footprint('layer');
  const big = layout({ destinations: Array.from({ length: 12 }, (_, i) => `S${i + 1}`), layers: 16, firstUniverse: 3, master: false });
  for (const id of big.fixtures.filter((f) => f.kind === 'screen').map((f) => f.destination)) {
    const us = new Set(big.fixtures.filter((f) => f.destination === id).map((f) => f.universe));
    assert.equal(us.size, 1, `${id} is in one universe`);
  }
  assert.equal(big.fixtures[0].universe, 3);
  assert.equal(big.universes.length, Math.ceil(12 / Math.floor(512 / block)));
  const csv = patchCsv(fixtures).split('\r\n');
  assert.equal(csv[0], 'Name,Fixture type,Mode,Universe,Address,Channels');
  assert.equal(csv[2], 'S1,LPP Screen,Cue,1,5,4');
});

test('the channels: a layer is folder, file and opacity; folder 0 holds; full is 256', () => {
  const [f] = layout({ destinations: ['S1'], layers: 1, firstUniverse: 1, master: false }).fixtures.slice(1);
  const frame = new Uint8Array(512);
  frame.set([1, 3, 255], f.address - 1);
  const v = readFixture(f, frame);
  assert.deepEqual(v, { folder: 1, file: 3, opacity: 255 });
  assert.deepEqual(sourceOf(v), { kind: 'LIVE', number: 3 });
  assert.equal(sourceOf({ folder: 0, file: 3 }), null);
  assert.equal(sourceOf({ folder: 1, file: 0 }), null);
  assert.deepEqual(sourceOf({ folder: 6, file: 0 }), { kind: 'NONE', number: null });
  assert.equal(sourceOf({ folder: 99, file: 1 }), null);
  assert.equal(opacityOf(255), 256);
  assert.equal(opacityOf(0), 0);
  assert.equal(sourceValue('nlc', { kind: 'STILL', number: 12 }), 'STILL_12');
  assert.equal(sourceValue('nlc', { kind: 'COLOR', number: null }), 'COLOR');
  assert.equal(sourceValue('mng', { kind: 'LIVE', number: 3 }), 'INPUT_3');
  assert.equal(sourceValue('mng', { kind: 'STILL', number: 3 }), null);
});

/* ------------------------------------------------------------- the engine */

function rig(layers = 2) {
  const patch = layout({ destinations: ['S1'], layers, firstUniverse: 1 });
  const engine = new DeskEngine(patch.fixtures);
  const frame = new Uint8Array(512);
  const at = (id) => patch.fixtures.find((f) => f.id === id).address - 1;
  const set = (id, values) => { frame.set(values, at(id)); return engine.update(1, frame); };
  return { engine, frame, set, at, patch };
}

test('engine: nothing fires on the first frame, even with Take and Control at full', () => {
  const { engine, frame, at } = rig();
  frame.set([255, 7, 255, 255], at('S1'));
  frame.set([1, 2, 255], at('S1.L1'));
  assert.deepEqual(engine.update(1, frame), []);
  assert.equal(engine.control('S1'), CONTROL.PROGRAM);
});

test('engine: a screen ignores the desk until Control rises, and is handed the desk’s layers when it does', () => {
  const { set } = rig();
  set('S1', [0, 0, 0, 0]);
  assert.deepEqual(set('S1.L1', [1, 2, 255]), [], 'Control is off');
  const out = set('S1', [64, 0, 0, 0]);
  assert.deepEqual(out, [
    { type: 'engage', destination: 'S1', buffer: CONTROL.PREVIEW },
    { type: 'layer', destination: 'S1', layer: 1, param: 'source', value: { kind: 'LIVE', number: 2 } },
    { type: 'layer', destination: 'S1', layer: 1, param: 'opacity', value: 256 },
    { type: 'layer', destination: 'S1', layer: 2, param: 'opacity', value: 0 },
  ]);
  assert.deepEqual(set('S1', [0, 0, 0, 0]), [{ type: 'release', destination: 'S1' }]);
});

test('engine: one frame that recalls, sets a layer and takes comes out in that order', () => {
  const { set, frame, at, engine } = rig();
  set('S1', [64, 0, 0, 0]);
  set('S1', [64, 0, 0, 0]);
  frame.set([64, 3, 255, 0], at('S1'));
  frame.set([2, 5, 0], at('S1.L1'));
  const out = engine.update(1, frame).map((a) => a.type + (a.param ? `:${a.param}` : ''));
  assert.deepEqual(out, ['recall', 'layer:source', 'take']);
});

test('engine: triggers fire on a rise past 50%, memories on a change to non-zero', () => {
  const { set } = rig();
  set('S1', [200, 0, 0, 0]);
  assert.deepEqual(set('S1', [200, 0, 127, 0]), []);
  assert.deepEqual(set('S1', [200, 0, 128, 0]), [{ type: 'take', destination: 'S1' }]);
  assert.deepEqual(set('S1', [200, 0, 255, 0]), [], 'held, not risen');
  assert.deepEqual(set('S1', [200, 0, 0, 200]), [{ type: 'cut', destination: 'S1' }]);
  assert.deepEqual(set('S1', [200, 4, 0, 200]), [{ type: 'recall', destination: 'S1', slot: 4 }]);
  assert.deepEqual(set('S1', [200, 0, 0, 200]), [], 'back to zero recalls nothing');
});

test('engine: a new desk in control starts from a baseline', () => {
  const { engine, frame, at } = rig();
  frame.set([200, 0, 0, 0], at('S1'));
  engine.update(1, frame);
  frame.set([200, 0, 255, 0], at('S1'));
  assert.deepEqual(engine.update(1, frame, { fresh: true }), []);
  assert.equal(engine.control('S1'), CONTROL.PROGRAM, 'a lost desk does not let go of a screen');
});

test('engine: the Master recalls master memories and takes every screen the desk holds', () => {
  const { set } = rig();
  set('master', [0, 0, 0, 0]);
  assert.deepEqual(set('master', [0, 2, 0, 0]), [], 'Master control off');
  set('master', [200, 2, 0, 0]);
  assert.deepEqual(set('master', [200, 5, 200, 0]), [{ type: 'recallMaster', slot: 5 }, { type: 'takeAll' }]);
});

/* -------------------------------------------------------- the fixture files */

test('GDTF: one file per fixture type, a zip holding description.xml, a mode per personality mode', () => {
  assert.deepEqual([...FIXTURE_KINDS], ['master', 'screen', 'layer']);
  const xml = descriptionXml('layer');
  assert.match(xml, /<GDTF DataVersion="1.2">/);
  assert.match(xml, /<DMXMode Name="Cue" Geometry="Base">/);
  assert.equal((xml.match(/<DMXChannel /g) || []).length, 3);
  assert.match(xml, /Attribute="Dimmer" Snap="No" Master="Grand"/);
  assert.match(xml, /InitialFunction="Base_MediaFolder1.MediaFolder1.MediaFolder1"/);
  assert.equal(gdtfName('layer', '1'), 'Stoatworks@LPP_Layer@v1.gdtf');
  const files = unzipStore(gdtfFile('screen'));
  assert.deepEqual(files.map((f) => f.name), ['description.xml']);
  assert.equal(new TextDecoder().decode(files[0].data), descriptionXml('screen'));
  assert.deepEqual(gdtfFile('master'), gdtfFile('master'), 'the same bytes every time');
});

/* -------------------------------------------------------------- settings */

test('settings: off, one screen, four layers, the Master, universe 1', () => {
  assert.deepEqual(normaliseDesk({}), { ...DEFAULT_DESK, deskAllow: [], deskDestinations: ['S1'] });
  const s = normaliseDesk({
    deskEnabled: true, deskProtocol: 'nonsense', deskInterface: '10.0.0.300', deskAllow: '2.0.0.1, bad 2.0.0.2',
    deskFirstUniverse: 70000, deskDestinations: ['s2', 'S2', 'X9', 'A1'], deskLayers: 40, deskMaster: false, deskMode: 'full',
  });
  assert.equal(s.deskProtocol, 'both');
  assert.equal(s.deskInterface, '');
  assert.deepEqual(s.deskAllow, ['2.0.0.1', '2.0.0.2']);
  assert.equal(s.deskFirstUniverse, 1);
  assert.deepEqual(s.deskDestinations, ['S2', 'A1']);
  assert.equal(s.deskLayers, 4);
  assert.equal(s.deskMaster, false);
  assert.equal(s.deskMode, 'cue');
  assert.deepEqual(normaliseDesk({ deskDestinations: [] }).deskDestinations, [], 'no screens is a choice');
  assert.equal(deskChanged(s, normaliseDesk(s)), false);
  assert.equal(deskChanged(s, { ...s, deskLayers: 2 }), true);
  assert.equal(allowed(s, '2.0.0.1'), true);
  assert.equal(allowed(s, '2.0.0.3'), false);
  assert.equal(allowed(normaliseDesk({}), '2.0.0.3'), true);
});

/* --------------------------------------------------------- the held link */

test('the held link: one connection for many exchanges, writes resolve, and it hangs up when idle', async () => {
  const awj = await fakeAwj({ 'a/b': 1, 'c/d': 'two' });
  const link = new AwjLink({ host: () => '127.0.0.1', port: awj.port, idleMs: 100 });
  try {
    const [r1, r2] = await Promise.all([
      link.exchange({ messages: [{ op: 'get', path: 'a/b' }, { op: 'get', path: 'c/d' }] }),
      link.exchange({ messages: [{ op: 'replace', path: 'a/b', value: 5 }, { op: 'get', path: 'a/b' }] }),
    ]);
    assert.deepEqual(r1.map((r) => r.value), [1, 'two']);
    assert.deepEqual(r2.map((r) => r.value), [5]);
    assert.deepEqual(await link.exchange({ messages: [{ op: 'replace', path: 'c/d', value: 'x' }] }), []);
    await until(() => awj.store.get('c/d') === 'x', 1000, 'the write');
    assert.equal(link.stats.connects, 1);
    assert.equal(link.open, true);
    await until(() => !link.open, 1000, 'the idle hang-up');
    await link.exchange({ messages: [{ op: 'get', path: 'a/b' }] });
    assert.equal(link.stats.connects, 2, 'opened again by the next exchange');
  } finally {
    link.dispose();
    await awj.close();
  }
});

test('the held link: no switcher is an error, not a hang', async () => {
  const link = new AwjLink({ host: () => null });
  await assert.rejects(link.exchange({ messages: [{ op: 'get', path: 'x' }] }), /no switcher configured/);
  link.dispose();
});

/* ------------------------------------------------------ the supervisor */

const LOOPBACK = () => ({ lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true }] });

async function bench({ settings = {}, store: extra = [] } = {}) {
  const store = new Map([['DeviceObject/system/$device/@items/1/@props/dev', 'NLC_AQL_C']]);
  const set = (path, v) => store.set(toAwj(path), v);
  set(NLC.takeStatus('S1', 'isUsed'), true);
  set(NLC.takeControl('S1', 'presetUp'), 'A');
  set(NLC.takeControl('S1', 'presetDown'), 'B');
  set(NLC.takeControl('S1', 'presetPrevious'), 'C');
  set(NLC.takeStatus('S1', 'transition'), 'AT_DOWN');
  for (const [p, v] of extra) set(p, v);
  const takePath = toAwj(NLC.takeControl('S1', 'xTake'));
  const transitionPath = toAwj(NLC.takeStatus('S1', 'transition'));
  /* A take swaps which letter is on air, as the switcher does. */
  const awj = await fakeAwj(store, {
    onReplace: (path, value, st) => {
      if (path === takePath && value === true) st.set(transitionPath, st.get(transitionPath) === 'AT_DOWN' ? 'AT_UP' : 'AT_DOWN');
    },
  });
  const timecodes = [];
  const sup = new DeskSupervisor({
    deviceHost: () => '127.0.0.1', awjPort: awj.port,
    ports: { artnet: 0, sacn: 0 }, bindAddress: '127.0.0.1', pollReplyPort: null,
    interfaces: LOOPBACK, settleMs: 60, idleMs: 2000,
    timecode: () => ({ push: (tc) => timecodes.push(tc) }),
  });
  await sup.apply(normaliseDesk({ deskEnabled: true, deskDestinations: ['S1'], deskLayers: 2, ...settings }));
  const desk = dgram.createSocket('udp4');
  await new Promise((r) => desk.bind(0, '127.0.0.1', r));
  const heard = [];
  desk.on('message', (b) => heard.push(b));
  const frame = new Uint8Array(512);
  const at = (id) => sup.patch.fixtures.find((f) => f.id === id).address - 1;
  let seq = 0;
  const send = (buf, proto = 'artnet') => new Promise((r) => desk.send(buf, sup.bound[proto], '127.0.0.1', r));
  const dmx = (id, values) => { if (id) frame.set(values, at(id)); return send(buildArtDmx(0, frame, { sequence: ++seq & 0xff })); };
  const writes = () => awj.writes();
  const close = async () => {
    sup.stop();
    desk.close();
    await awj.close();
  };
  /* fakeAwj keeps its own copy of the store: change the switcher through it. */
  const change = (path, v) => awj.store.set(toAwj(path), v);
  return { sup, awj, set: change, desk, heard, send, dmx, frame, at, writes, timecodes, close };
}

const layerPath = (letter, layer, tail) => toAwj(NLC.layerParamPath('S1', letter, layer, tail));

test('supervisor: answers ArtPoll as a media server, with the patched universes', async () => {
  const b = await bench();
  try {
    await b.send(buildArtPoll());
    await until(() => b.heard.length, 2000, 'an ArtPollReply');
    const reply = parsePollReply(b.heard[0]);
    assert.deepEqual(reply.universes, [0]);
    assert.deepEqual(reply.ip, [127, 0, 0, 1]);
    assert.equal(b.heard[0][200], STYLE_MEDIA);
  } finally { await b.close(); }
});

test('supervisor: a desk takes S1 over, sets a layer in preview, recalls, takes — in order, to the right letters', async () => {
  const b = await bench();
  try {
    const opacity = NLC.catalogue.layer.find((p) => p.id === NLC.layerParams.opacity).path;
    const source = NLC.catalogue.layer.find((p) => p.id === NLC.sourceParam).path;
    /* Baseline: everything at zero. Then a layer is set while S1 is not the desk's. */
    await b.dmx(null);
    await b.dmx('S1.L1', [1, 2, 255]);
    await sleep(80);
    assert.deepEqual(b.writes(), [], 'Control is off: nothing written');

    /* Control to preview: the desk's layers go to preview, which is A (AT_DOWN: B on air). */
    await b.dmx('S1', [100, 0, 0, 0]);
    await until(() => b.writes().length >= 3, 2000, 'the engage writes');
    assert.deepEqual(b.writes(), [
      { path: layerPath('A', 1, source), value: 'LIVE_2' },
      { path: layerPath('A', 1, opacity), value: 256 },
      { path: layerPath('A', 2, opacity), value: 0 },
    ]);
    b.awj.clear();

    /* One cue: memory 3, layer 2 to STILL 4 at half, take. */
    b.frame.set([100, 3, 255, 0], b.at('S1'));
    b.frame.set([2, 4, 128], b.at('S1.L2'));
    await b.dmx(null);
    const recall = commandsFor(NLC).recallScreenPreset(3, 'S1', 'PREVIEW');
    const take = toAwj(NLC.takeControl('S1', 'xTake'));
    await until(() => b.writes().some((w) => w.path === take), 3000, 'the take');
    const w = b.writes().map((x) => x.path);
    const iRecall = w.indexOf(toAwj(recall.path));
    const iLayer = w.indexOf(layerPath('A', 2, source));
    const iTake = w.indexOf(take);
    assert.ok(iRecall >= 0 && iLayer > iRecall && iTake > iLayer, `recall, layer, take: ${w.join('\n')}`);
    /* After the take B is preview; the desk's layers are written to it again. */
    await until(() => b.writes().some((x) => x.path === layerPath('B', 2, source)), 2000, 'the re-push to the new preview');
    assert.equal(b.writes().find((x) => x.path === layerPath('B', 2, source)).value, 'STILL_4');
    assert.equal(b.sup.link.stats.connects, 1, 'one held connection throughout');
  } finally { await b.close(); }
});

test('supervisor: mid-transition the layer values wait, and go to the letter that is preview after it', async () => {
  const b = await bench();
  try {
    const source = NLC.catalogue.layer.find((p) => p.id === NLC.sourceParam).path;
    await b.dmx('S1', [100, 0, 0, 0]);
    await b.dmx('S1', [100, 0, 0, 0]);
    b.set(NLC.takeStatus('S1', 'transition'), 'EFFECT_FROM_DOWN');
    await sleep(60);
    b.awj.clear();
    await b.dmx('S1.L1', [1, 7, 0]);
    await sleep(150);
    assert.deepEqual(b.writes(), [], 'nothing written mid-transition');
    assert.equal(b.sup.describe().screens[0].held, 'mid-transition');
    b.set(NLC.takeStatus('S1', 'transition'), 'AT_UP');
    await until(() => b.writes().length, 2000, 'the held write');
    /* AT_UP: A on air, B preview. */
    assert.deepEqual(b.writes()[0], { path: layerPath('B', 1, source), value: 'LIVE_7' });
  } finally { await b.close(); }
});

test('supervisor: a fader pulled fast is a few writes of where it went, not one per frame', async () => {
  const b = await bench();
  try {
    const opacity = NLC.catalogue.layer.find((p) => p.id === NLC.layerParams.opacity).path;
    await b.dmx('S1', [100, 0, 0, 0]);
    await b.dmx('S1', [100, 0, 0, 0]);
    await sleep(80);
    b.awj.clear();
    for (let v = 0; v <= 255; v += 5) await b.dmx('S1.L1', [0, 0, v]);
    await until(() => b.writes().some((w) => w.value === 256), 3000, 'the last value');
    const n = b.writes().filter((w) => w.path === layerPath('A', 1, opacity)).length;
    assert.ok(n < 20, `${n} writes for 52 frames`);
  } finally { await b.close(); }
});

test('supervisor: the allow list refuses other desks; sACN drives the same way; ArtTimeCode reaches the timecode service', async () => {
  const b = await bench({ settings: { deskAllow: ['10.9.9.9'] } });
  try {
    await b.dmx('S1', [100, 0, 0, 0]);
    await b.dmx('S1', [100, 0, 0, 0]);
    await until(() => b.sup.counts.refused >= 2, 1000, 'refusals');
    assert.deepEqual(b.sup.describe().universes[0].sources, []);
    await b.sup.apply(normaliseDesk({ deskEnabled: true, deskDestinations: ['S1'], deskLayers: 2, deskProtocol: 'both' }));
    const cid = '0a'.repeat(16);
    b.frame.fill(0);
    await b.send(buildSacnData(1, b.frame, { cid, sequence: 1 }), 'sacn');
    b.frame.set([200, 0, 0, 0], b.at('S1'));
    await b.send(buildSacnData(1, b.frame, { cid, sequence: 2 }), 'sacn');
    await until(() => b.sup.describe().screens[0].control === 'program', 1000, 'program control over sACN');
    await b.send(buildArtTimeCode({ hours: 10, minutes: 0, seconds: 1, frames: 2, type: 1 }));
    await until(() => b.timecodes.length, 1000, 'a timecode');
    assert.deepEqual(b.timecodes[0], { hours: 10, minutes: 0, seconds: 1, frames: 2, rate: 25, dropFrame: false });
  } finally { await b.close(); }
});

test('supervisor: switched off, it closes its ports', async () => {
  const b = await bench();
  try {
    assert.ok(b.sup.bound.artnet && b.sup.bound.sacn);
    await b.sup.apply(normaliseDesk({ deskEnabled: false }));
    assert.equal(b.sup.bound.artnet, null);
    assert.equal(b.sup.bound.sacn, null);
    assert.equal(b.sup.describe().enabled, false);
  } finally { await b.close(); }
});
