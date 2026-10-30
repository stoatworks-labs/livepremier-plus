/*
 * Triggers: the wire formats, reading lines and the cue field, the sending
 * against pretend receivers, and the plugin's holds — ended by a timer, by
 * the next cue, by hand, and by a clip ending on the emulated deck.
 *
 * ⚠️ Every receiver here is a socket on port 0 at 127.0.0.1. Nothing is sent
 * to a real desk, node or multicast group — `helpers/offline.js` refuses UDP
 * to the DMX ports and sACN's groups as well as TCP to the kit's. These tests
 * prove the bytes match the documents (OSC 1.0, Art-Net 4, E1.31, MIDI 1.0
 * and MSC) and the plugin's own behaviour. They do not prove a real desk or
 * node agrees; nobody has run one against this yet.
 *
 * Run: node --import ./test/helpers/offline.js --test test/triggers.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';

import { decode } from '../server/osc.js';
import {
  encodeOsc, encodeArtDmx, encodeSacn, sacnMulticast, SACN_TERMINATED,
  noteOn, controlChange, programChange, mscMessage,
} from '../plugins/triggers/protocol.js';
import {
  normaliseSetup, parseLine, parseCueText, formatCueText, describeCueAction, parseUniverse, formatUniverse,
  parseChannels, parseDuration, lineProblems, normaliseHolds,
} from '../plugins/triggers/core.js';
import { Outputs } from '../plugins/triggers/outputs.js';
import activateTriggers from '../plugins/triggers/server.js';
import activateHyperdeck from '../plugins/hyperdeck/server.js';
import { startHyperDeckSim } from '../tools/hyperdeck-sim.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(10); }
  return false;
}

/** A pretend UDP receiver at 127.0.0.1 on a spare port. */
async function udpSink() {
  const socket = dgram.createSocket('udp4');
  const got = [];
  socket.on('message', (buf) => got.push({ at: Date.now(), buf }));
  await new Promise((r) => socket.bind(0, '127.0.0.1', r));
  return { port: socket.address().port, got, close: () => new Promise((r) => socket.close(r)) };
}

/** A pretend MIDI-over-TCP desk. */
async function tcpSink() {
  const chunks = [];
  const sockets = new Set();
  const server = net.createServer((s) => { sockets.add(s); s.on('data', (d) => chunks.push(d)); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    bytes: () => Buffer.concat(chunks),
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  };
}

/* ------------------------------------------------------------ protocol */

test('an OSC message reads back through the OSC input’s own decoder', () => {
  const buf = encodeOsc('/ch/17/mix/on', [{ type: 'i', value: 1 }, { type: 'f', value: 0.75 }, { type: 's', value: 'VT' }, { type: 'T' }, { type: 'F' }]);
  assert.equal(buf.length % 4, 0);
  assert.deepEqual(decode(buf), [{ address: '/ch/17/mix/on', args: [1, 0.75, 'VT', true, false], types: 'ifsTF' }]);
  assert.deepEqual(decode(encodeOsc('/eos/cue/1/45/fire')), [{ address: '/eos/cue/1/45/fire', args: [], types: '' }]);
});

test('ArtDmx is Art-Net 4’s: OpCode low byte first, version 14, Net and SubUni split', () => {
  const data = new Uint8Array(512);
  data[0] = 255; data[511] = 7;
  const buf = encodeArtDmx({ universe: parseUniverse('1:2:3', 'artnet'), sequence: 9, data });
  assert.equal(buf.length, 530);
  assert.equal(buf.toString('latin1', 0, 8), 'Art-Net\0');
  assert.deepEqual([...buf.subarray(8, 18)], [0x00, 0x50, 0x00, 0x0e, 9, 0, 0x23, 0x01, 0x02, 0x00]);
  assert.equal(buf[18], 255);
  assert.equal(buf[529], 7);
  assert.equal(formatUniverse(parseUniverse('1:2:3', 'artnet'), 'artnet'), '1:2:3');
  assert.equal(parseUniverse('5', 'artnet'), 5);
  assert.throws(() => parseUniverse('0', 'sacn'), /1–63999/);
  assert.throws(() => parseUniverse('0:0:1', 'sacn'), /Art-Net’s way/);
});

test('an sACN packet is E1.31’s 638 bytes, with its fixed flags and lengths', () => {
  const data = new Uint8Array(512);
  data[3] = 128;
  const cid = Buffer.alloc(16, 0xab);
  const buf = encodeSacn({ universe: 258, sequence: 4, data, priority: 150, cid, source: 'Test', options: SACN_TERMINATED });
  assert.equal(buf.length, 638);
  assert.equal(buf.readUInt16BE(0), 0x0010);
  assert.equal(buf.toString('latin1', 4, 16), 'ASC-E1.17\0\0\0');
  assert.equal(buf.readUInt16BE(16), 0x726e);
  assert.equal(buf.readUInt32BE(18), 4);
  assert.deepEqual(buf.subarray(22, 38), cid);
  assert.equal(buf.readUInt16BE(38), 0x7258);
  assert.equal(buf.readUInt32BE(40), 2);
  assert.equal(buf.toString('utf8', 44, 48), 'Test');
  assert.equal(buf[108], 150);
  assert.equal(buf[111], 4);
  assert.equal(buf[112], 0x40);
  assert.equal(buf.readUInt16BE(113), 258);
  assert.equal(buf.readUInt16BE(115), 0x720b);
  assert.equal(buf[117], 0x02);
  assert.equal(buf[118], 0xa1);
  assert.equal(buf.readUInt16BE(123), 513);
  assert.equal(buf[125], 0);
  assert.equal(buf[129], 128);
  assert.equal(sacnMulticast(258), '239.255.1.2');
});

test('MIDI channel messages count channels from 1, and MSC is the published sysex', () => {
  assert.deepEqual([...noteOn(1, 60, 127)], [0x90, 60, 127]);
  assert.deepEqual([...controlChange(16, 7, 100)], [0xbf, 7, 100]);
  assert.deepEqual([...programChange(2, 5)], [0xc1, 5]);
  assert.deepEqual([...mscMessage({ command: 'go', cue: '45', list: '1', device: 1, format: 'lighting' })],
    [0xf0, 0x7f, 0x01, 0x02, 0x01, 0x01, 0x34, 0x35, 0x00, 0x31, 0xf7]);
  assert.deepEqual([...mscMessage({ command: 'go', cue: '1.5' })], [0xf0, 0x7f, 0x7f, 0x02, 0x7f, 0x01, 0x31, 0x2e, 0x35, 0xf7]);
  assert.deepEqual([...mscMessage({ command: 'fire', macro: 3 })], [0xf0, 0x7f, 0x7f, 0x02, 0x7f, 0x07, 3, 0xf7]);
  assert.throws(() => noteOn(0, 60, 1), /1–16/);
});

/* ------------------------------------------------------------ lines */

const SETUP = normaliseSetup({
  destinations: [
    { name: 'Desk', kind: 'osc', host: '127.0.0.1', port: 10024 },
    { name: 'Desk 2', kind: 'midi-tcp', host: '127.0.0.1' },
    { name: 'House', kind: 'sacn', universe: 7, priority: 150 },
    { name: 'Node', kind: 'artnet', host: '2.0.0.10', universe: '0:1:2' },
  ],
  triggers: [{ name: 'VT audio', go: ['Desk /ch/17/mix/on 1'], back: ['Desk /ch/17/mix/on 0'] }],
});

test('a line starts with its destination, the longest name first, then that destination’s words', () => {
  assert.deepEqual(parseLine('Desk /ch/17/mix/on 1 0.5 "two words" true s:3 f:2', SETUP.destinations), {
    dest: 'desk', type: 'osc', address: '/ch/17/mix/on',
    args: [{ type: 'i', value: 1 }, { type: 'f', value: 0.5 }, { type: 's', value: 'two words' }, { type: 'T', value: true }, { type: 's', value: '3' }, { type: 'f', value: 2 }],
  });
  assert.equal(parseLine('desk 2 cc 1 7 100', SETUP.destinations).dest, 'desk-2', 'Desk 2 is not Desk with a 2');
  assert.deepEqual(parseLine('Desk 2 msc go 45 list 1', SETUP.destinations), { dest: 'desk-2', type: 'midi', msg: 'msc', command: 'go', cue: '45', list: '1' });
  assert.deepEqual(parseLine('House 1-4 @ 0 fade 3', SETUP.destinations), { dest: 'house', type: 'dmx', channels: [1, 2, 3, 4], level: 0, before: false, fade: 3 });
  assert.deepEqual(parseLine('House 1 thru 3 @ 50%', SETUP.destinations).channels, [1, 2, 3]);
  assert.equal(parseLine('House 1 @ 50%', SETUP.destinations).level, 128);
  assert.equal(parseLine('House 1,3 at full fade 1:30', SETUP.destinations).fade, 90);
  assert.equal(parseLine('House 1-4 @ before fade 5', SETUP.destinations).before, true);
  assert.deepEqual(parseLine('Node release', SETUP.destinations), { dest: 'node', type: 'dmx', release: true });
  assert.deepEqual(parseChannels('1,3,5-7'), [1, 3, 5, 6, 7]);
  assert.equal(parseDuration('2.5s'), 2.5);
  assert.equal(parseDuration('1:02:03'), 3723);
});

test('a line that does not read says why, and the panel lists it rather than dropping it', () => {
  assert.throws(() => parseLine('Lights 1 @ 0', SETUP.destinations), /starts with a destination — Desk, Desk 2, House, Node/);
  assert.throws(() => parseLine('Desk ch/1', SETUP.destinations), /an OSC line is an address/);
  assert.throws(() => parseLine('Desk 2 note 17 60 1', SETUP.destinations), /channel is 1–16/);
  assert.throws(() => parseLine('Desk 2 msc go', SETUP.destinations), /needs a cue number/);
  assert.throws(() => parseLine('Desk 2 msc alloff 3', SETUP.destinations), /takes no cue number/);
  assert.throws(() => parseLine('House 0-4 @ 0', SETUP.destinations), /1–512/);
  assert.throws(() => parseLine('House 1 @ 300', SETUP.destinations), /not a level/);
  const setup = normaliseSetup({ ...SETUP, triggers: [{ name: 'Bad', go: ['Lights 1 @ 0', 'Desk /ok 1'] }] });
  assert.deepEqual(lineProblems(setup).map((p) => [p.side, p.index]), [['go', 0]]);
  assert.equal(setup.triggers[0].go.length, 2);
});

test('names stay unique and clear of the cue field’s words', () => {
  const s = normaliseSetup({
    destinations: [{ name: 'Desk' }, { name: 'desk' }, { name: 'a;b' }],
    triggers: [{ name: 'restore lights' }, { name: 'VT' }, { name: 'vt' }],
  });
  assert.deepEqual(s.destinations.map((d) => d.name), ['Desk', 'desk 2', 'a b']);
  assert.deepEqual(s.triggers.map((t) => t.name), ['Trigger restore lights', 'VT', 'vt 2']);
});

/* ------------------------------------------------------------ the cue field */

const NAMES = {
  triggers: normaliseSetup({ triggers: [{ name: 'VT audio' }, { name: 'House down' }] }).triggers,
  decks: [{ id: 'mitti', name: 'Mitti' }, { id: 'vt-2', name: 'VT 2' }],
};

test('the cue field names triggers and one restore clause, and reads back as typed', () => {
  const actions = parseCueText('vt audio; House down; restore when Mitti ends or after 5:00 then go', NAMES);
  assert.deepEqual(actions, [{
    fire: ['vt-audio', 'house-down'],
    restore: { deck: 'mitti', after: 300, next: false, manual: false, then: 'go' },
  }]);
  assert.equal(formatCueText(actions, NAMES), 'VT audio; House down; restore when Mitti ends or after 5:00 then go');
  assert.equal(describeCueAction(actions[0], NAMES), 'Triggers VT audio, House down · restore when Mitti ends or after 5:00 then go');

  const next = parseCueText('House down; restore at next cue then cue 13', NAMES)[0];
  assert.deepEqual(next.restore, { deck: null, after: null, next: true, manual: false, then: { cue: '13' } });
  assert.equal(formatCueText([next], NAMES), 'House down; restore at next cue then cue 13');
  assert.deepEqual(parseCueText('restore when VT 2 ends then go', NAMES)[0].fire, [], 'a restore with nothing to send back still does its then');
  assert.deepEqual(parseCueText('  ', NAMES), []);
});

test('the cue field refuses what it cannot do, saying why', () => {
  assert.throws(() => parseCueText('Lights', NAMES), /no trigger called “Lights” — VT audio, House down/);
  assert.throws(() => parseCueText('VT audio; restore when Nobody ends', NAMES), /no HyperDeck called “Nobody” — Mitti, VT 2/);
  assert.throws(() => parseCueText('VT audio; restore when Mitti ends', { triggers: NAMES.triggers, decks: [] }), /HyperDecks plugin on/);
  assert.throws(() => parseCueText('VT audio; restore soon', NAMES), /restore when <deck> ends/);
  assert.throws(() => parseCueText('VT audio; restore by hand then dance', NAMES), /after “then”/);
  assert.throws(() => parseCueText('restore by hand; restore at next cue', NAMES), /one restore clause/);
});

/* ------------------------------------------------------------ the sending */

test('OSC and MIDI over TCP reach their receivers', async (t) => {
  const osc = await udpSink();
  const midi = await tcpSink();
  const out = new Outputs();
  t.after(async () => { await out.stop(); await osc.close(); await midi.close(); });
  const desk = { id: 'desk', name: 'Desk', kind: 'osc', host: '127.0.0.1', port: osc.port, enabled: true };
  const ah = { id: 'ah', name: 'AH', kind: 'midi-tcp', host: '127.0.0.1', port: midi.port, enabled: true, mscDevice: 1, mscFormat: 'sound' };

  await out.send(desk, parseLine('Desk /ch/17/mix/on 1', [desk]));
  assert.ok(await until(() => osc.got.length === 1));
  assert.deepEqual(decode(osc.got[0].buf), [{ address: '/ch/17/mix/on', args: [1], types: 'i' }]);

  await out.send(ah, parseLine('AH note 1 60 127', [ah]));
  await out.send(ah, parseLine('AH msc go 3', [ah]));
  assert.ok(await until(() => midi.bytes().length === 3 + 8));
  assert.deepEqual([...midi.bytes()], [0x90, 60, 127, 0xf0, 0x7f, 0x01, 0x02, 0x10, 0x01, 0x33, 0xf7]);

  await assert.rejects(out.send({ ...desk, enabled: false }, parseLine('Desk /x', [desk])), /switched off/);
  await assert.rejects(out.send({ ...ah, port: 1 }, parseLine('AH pc 1 1', [ah])), /ECONNREFUSED|no answer/);
});

test('a universe is kept: resent every second, faded in steps, and released', async (t) => {
  const node = await udpSink();
  const recv = await udpSink();
  const out = new Outputs();
  t.after(async () => { await out.stop(); await node.close(); await recv.close(); });
  const art = { id: 'art', name: 'Node', kind: 'artnet', host: '127.0.0.1', port: node.port, universe: 1, enabled: true };
  const sacn = { id: 'sacn', name: 'House', kind: 'sacn', host: '127.0.0.1', port: recv.port, universe: 7, priority: 150, enabled: true };

  out.setLevels(art, [[1, 255]], 0);
  assert.ok(await until(() => node.got.length >= 1));
  assert.equal(node.got[0].buf[18], 255);
  assert.ok(await until(() => node.got.length >= 2, 1600), 'resent with nothing changing');
  assert.ok(node.got[1].at - node.got[0].at >= 900, 'about a second apart');

  out.setLevels(sacn, [[1, 200]], 0);
  out.setLevels(sacn, [[1, 0]], 0.4);
  assert.equal(out.level('sacn', 1), 0, 'a fade answers where it is headed');
  assert.ok(await until(() => recv.got.some((p) => p.buf[126] === 0), 2000));
  const steps = new Set(recv.got.map((p) => p.buf[126]));
  assert.ok(steps.size >= 5, `the fade went out in steps: ${[...steps].join(' ')}`);
  assert.equal(recv.got[0].buf[108], 150, 'its priority');

  const before = recv.got.length;
  await out.release('sacn');
  assert.ok(await until(() => recv.got.length >= before + 3));
  const last = recv.got.slice(-3);
  assert.ok(last.every((p) => p.buf[112] === SACN_TERMINATED), 'three packets saying the stream is over');
  await wait(1200);
  assert.equal(recv.got.length, before + 3, 'and then nothing');
  assert.equal(out.level('sacn', 1), null);
});

/* ------------------------------------------------------------ the plugin */

function hostFor(services = new Map()) {
  const routes = new Map();
  const contributions = [];
  const disposers = [];
  const docs = new Map();
  const events = [];
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const ctx = {
    HttpError,
    log: () => {},
    route: (method, path, fn) => routes.set(`${method} ${path}`, fn),
    stream: () => ({ send: (event, data) => events.push({ event, data }) }),
    onDispose: (fn) => disposers.push(fn),
    contribute: (point, spec) => contributions.push({ point, spec }),
    provide: (name, api) => services.set(name, api),
    use: (name) => services.get(name) ?? null,
    storage: {
      load: async (name) => (docs.has(name) ? JSON.parse(JSON.stringify(docs.get(name))) : null),
      save: async (name, data) => { docs.set(name, JSON.parse(JSON.stringify(data))); },
    },
  };
  const call = async (method, path, body) => {
    let status = 0;
    let payload = null;
    await routes.get(`${method} ${path}`)({}, {}, {
      readJson: async () => body,
      json: (s, b) => { status = s; payload = b; },
    });
    return { status, body: payload };
  };
  return { ctx, call, contributions, events, docs, stop: async () => { for (const fn of disposers.reverse()) await fn(); } };
}

async function rig(t, { services, docs } = {}) {
  const osc = await udpSink();
  const dmx = await udpSink();
  const host = hostFor(services);
  if (docs) for (const [k, v] of docs) host.docs.set(k, v);
  await activateTriggers(host.ctx);
  t.after(async () => { await host.stop(); await osc.close(); await dmx.close(); });
  const saved = await host.call('PUT', '/', {
    destinations: [
      { name: 'Desk', kind: 'osc', host: '127.0.0.1', port: osc.port },
      { name: 'House', kind: 'sacn', host: '127.0.0.1', port: dmx.port, universe: 1 },
    ],
    triggers: [
      { name: 'VT audio', go: ['Desk /ch/17/mix/on 1', 'Desk /ch/18/mix/on 1'], back: ['Desk /ch/17/mix/on 0', 'Desk /ch/18/mix/on 0'] },
      { name: 'House down', go: ['House 1-4 @ 0'], back: ['House 1-4 @ before', 'Desk /house/back 1'] },
    ],
  });
  assert.equal(saved.status, 200);
  const sent = () => osc.got.map((p) => decode(p.buf)[0]).map((m) => `${m.address} ${m.args.join(' ')}`.trim());
  const level = () => dmx.got.length ? dmx.got[dmx.got.length - 1].buf[126] : null;
  return { host, osc, dmx, sent, level };
}

const CUE = { id: 'c12', number: '12', label: 'Sizzle reel' };

test('a cue fires its triggers, and after its time the back lines go in reverse, levels from before', async (t) => {
  const { host, sent, level } = await rig(t);
  /* The house is up, as the lighting look left it. */
  await host.call('PUT', '/', { ...(await host.call('GET', '/')).body, triggers: [
    ...(await host.call('GET', '/')).body.triggers,
    { name: 'House up', go: ['House 1-4 @ full'], back: [] },
  ] });
  await host.call('POST', '/test', { trigger: 'house-up', side: 'go' });
  assert.ok(await until(() => level() === 255));

  const r = await host.call('POST', '/fire', { page: 'p1', cue: CUE, fire: ['vt-audio', 'house-down'], restore: { after: 0.4, then: 'go' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.hold);
  assert.ok(await until(() => level() === 0), 'house down');
  assert.ok(sent().includes('/ch/17/mix/on 1') && sent().includes('/ch/18/mix/on 1'));
  assert.equal(host.docs.get('trigger-holds').holds[0].before.house[1], 255, 'the level before was journalled with the hold');

  const firstBack = sent().length;
  assert.ok(await until(() => host.events.some((e) => e.event === 'restored'), 2000), 'restored after its time');
  assert.ok(await until(() => level() === 255), 'house back to where it was');
  assert.deepEqual(sent().slice(firstBack), ['/house/back 1', '/ch/17/mix/on 0', '/ch/18/mix/on 0'], 'House down’s back first: reverse order');
  const restored = host.events.find((e) => e.event === 'restored').data;
  assert.equal(restored.then, 'go');
  assert.equal(restored.hold.page, 'p1');
  assert.deepEqual((await host.call('GET', '/')).body.holds, []);
  assert.deepEqual(host.docs.get('trigger-holds').holds, []);

  /* The page that fired it says it did the GO. */
  await host.call('POST', '/then', { hold: restored.hold.id, ok: true, text: 'cue 12 → GO' });
  await wait(50);
  assert.ok((await host.call('GET', '/')).body.log.some((l) => l.text === 'then: cue 12 → GO'));
});

test('at the next cue restores that page’s holds — not the cue’s own, nor another page’s — and skips the then', async (t) => {
  const { host, sent } = await rig(t);
  await host.call('POST', '/fire', { page: 'p1', cue: CUE, fire: ['vt-audio'], restore: { next: true, then: 'go' } });
  await host.call('POST', '/fire', { page: 'p2', cue: { id: 'c40' }, fire: ['vt-audio'], restore: { next: true } });
  assert.equal((await host.call('POST', '/next', { page: 'p1', cue: 'c12' })).body.restored, 0, 'the cue that made the hold');
  const r = await host.call('POST', '/next', { page: 'p1', cue: 'c13' });
  assert.equal(r.body.restored, 1);
  assert.ok(await until(() => sent().filter((s) => s === '/ch/17/mix/on 0').length === 1));
  const left = (await host.call('GET', '/')).body.holds;
  assert.deepEqual(left.map((h) => h.page), ['p2']);
  assert.equal(host.events.filter((e) => e.event === 'restored').length, 0, 'the operator moved the stack: no then');
});

test('re-firing a cue keeps the first look as its before', async (t) => {
  const { host, level } = await rig(t);
  await host.call('PUT', '/', { ...(await host.call('GET', '/')).body, triggers: [
    ...(await host.call('GET', '/')).body.triggers, { name: 'House up', go: ['House 1-4 @ 200'] },
  ] });
  await host.call('POST', '/test', { trigger: 'house-up', side: 'go' });
  assert.ok(await until(() => level() === 200));
  await host.call('POST', '/fire', { page: 'p1', cue: CUE, fire: ['house-down'], restore: { manual: true } });
  await host.call('POST', '/fire', { page: 'p1', cue: CUE, fire: ['house-down'], restore: { manual: true } });
  const holds = (await host.call('GET', '/')).body.holds;
  assert.equal(holds.length, 1);
  assert.equal(holds[0].before.house[1], 200);
  await host.call('POST', '/restore', { id: holds[0].id });
  assert.ok(await until(() => level() === 200));
});

test('a hold left when the app stopped is offered, never fired by itself', async (t) => {
  const left = normaliseHolds([{ id: 'old', page: 'gone', cue: CUE, fire: ['vt-audio'], restore: { after: 0.1, then: 'go' }, at: Date.now() - 60000 }]);
  const { host, sent } = await rig(t, { docs: new Map([['trigger-holds', { holds: left }]]) });
  await wait(400);
  let state = (await host.call('GET', '/')).body;
  assert.equal(state.holds.length, 1);
  assert.equal(state.holds[0].stale, true);
  assert.deepEqual(sent(), [], 'nothing sent by itself');
  assert.ok(state.log.some((l) => /waiting when the app stopped/.test(l.text)));

  await host.call('POST', '/restore', { id: 'old' });
  assert.ok(await until(() => sent().includes('/ch/17/mix/on 0')));
  assert.equal(host.events.filter((e) => e.event === 'restored').length, 0);
  state = (await host.call('GET', '/')).body;
  assert.equal(state.holds.length, 0);
});

test('Restore all, Discard, and a deleted trigger', async (t) => {
  const { host, sent } = await rig(t);
  await host.call('POST', '/fire', { page: 'p1', cue: CUE, fire: ['vt-audio'], restore: { manual: true } });
  await host.call('POST', '/fire', { page: 'p1', cue: { id: 'c13', number: '13' }, fire: ['house-down'], restore: { manual: true } });
  await host.call('POST', '/fire', { page: 'p1', cue: { id: 'c14', number: '14' }, fire: ['nobody'], restore: { manual: true } });
  const holds = (await host.call('GET', '/')).body.holds;
  assert.equal(holds.length, 3);
  assert.equal((await host.call('POST', '/discard', { id: holds[1].id })).status, 200);
  assert.ok(await until(() => sent().length === 2), 'the go lines have landed');
  const before = sent().length;
  const all = await host.call('POST', '/restore', { all: true });
  assert.equal(all.status, 207, 'the hold naming a deleted trigger reports it');
  assert.ok(await until(() => sent().length === before + 2));
  assert.ok(!sent().slice(before).includes('/house/back 1'), 'the discarded hold sent nothing');
  assert.equal((await host.call('GET', '/')).body.holds.length, 0);
});

test('the setup file carries destinations and triggers as an installation section', async (t) => {
  const { host } = await rig(t);
  const section = host.contributions.find((c) => c.point === 'configSection').spec;
  assert.equal(section.key, 'triggers');
  assert.equal(section.group, 'installation');
  const exported = section.export();
  assert.equal(exported.triggers.length, 2);
  await section.import({ destinations: [], triggers: [] });
  assert.equal(section.export(), undefined, 'nothing to write once empty');
});

test('a clip ending on the emulated deck restores the hold, with no page anywhere', async (t) => {
  const sim = await startHyperDeckSim({ port: 0, mitti: true, clips: [{ name: 'Reel.mov', seconds: 0.6 }, { name: 'Next.mov', seconds: 5 }] });
  const services = new Map();
  const decks = hostFor(services);
  await activateHyperdeck(decks.ctx);
  t.after(async () => { await decks.stop(); await sim.close(); });
  await decks.call('PUT', '/', { decks: [{ name: 'Mitti', host: '127.0.0.1', port: sim.port, profile: 'mitti' }] });
  assert.ok(await until(async () => (await decks.call('GET', '/')).body.live[0]?.status === 'connected'));

  const { host, sent } = await rig(t, { services });
  assert.deepEqual((await host.call('GET', '/')).body.decks, [{ id: 'mitti', name: 'Mitti' }]);
  const action = parseCueText('VT audio; restore when Mitti ends then go', (await host.call('GET', '/')).body)[0];
  await host.call('POST', '/fire', { page: 'p1', cue: CUE, ...action });
  assert.ok(await until(() => sent().includes('/ch/17/mix/on 1')));

  /* Mitti’s “pause at end” — the transport stops by itself at the end of the clip. */
  sim.state.single = true;
  assert.equal((await decks.call('POST', '/command', { deck: 'Mitti', command: 'play' })).status, 200);
  assert.ok(await until(() => sent().includes('/ch/17/mix/on 0'), 4000), 'back lines when the clip ended');
  const restored = host.events.find((e) => e.event === 'restored');
  assert.ok(restored, 'and the then handed to the page');
  assert.match((await host.call('GET', '/')).body.log.find((l) => /restored/.test(l.text)).text, /Mitti clip 1 ended/);
});

/* ------------------------------------------------------------ the page half */

/**
 * The page half with a real cue stack and the server answered by hand: what
 * it POSTs, and what it does with a `restored` it hears on the stream.
 */
async function pageHalf(t) {
  const { CueStack } = await import('../src/core/cuestack.js');
  const { default: activate } = await import('../plugins/triggers/client.js');
  const posts = [];
  const streams = [];
  const realFetch = globalThis.fetch;
  const realSource = globalThis.EventSource;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('/__lpp/triggers', '');
    const body = init.body ? JSON.parse(init.body) : null;
    if (init.method === 'POST') posts.push({ path, body });
    const reply = path === '/fire' ? { ok: true, results: [], hold: `h-${body.cue.id}` }
      : (!init.method || init.method === 'GET') ? { triggers: [{ id: 'vt-audio', name: 'VT audio' }], decks: [{ id: 'mitti', name: 'Mitti' }], holds: [] }
        : { ok: true };
    return { ok: true, status: 200, json: async () => reply };
  };
  globalThis.EventSource = class {
    constructor() { this.on = {}; streams.push(this); }
    addEventListener(name, fn) { this.on[name] = fn; }
    emit(name, data) { this.on[name]?.({ data: JSON.stringify(data) }); }
  };
  t.after(() => { globalThis.fetch = realFetch; globalThis.EventSource = realSource; });

  const contributions = [];
  const services = new Map();
  const stack = new CueStack({
    send: () => true,
    commands: () => ({}),
    actions: (kind) => contributions.find((c) => c.kind === kind) || null,
  });
  const fired = [];
  stack.addEventListener('fired', (ev) => fired.push(ev.detail.cueId));
  services.set('stack', {
    go: () => stack.go(), gotoId: (id) => stack.gotoId(id), get standby() { return stack.standby; },
    cues: () => stack.cues, addEventListener: (...a) => stack.addEventListener(...a),
  });
  activate({
    url: (p) => `/__lpp/triggers${p}`,
    refresh: () => {},
    log: { info: () => {}, warn: () => {} },
    use: (name) => services.get(name) ?? null,
    contribute: (point, spec) => contributions.push(spec),
    ui: { sidebar: () => {} },
  });
  const field = contributions[0].field;
  /* The trigger list arrives with the page half's first load. */
  assert.ok(await until(() => { try { return field.parse('VT audio').length === 1; } catch { return false; } }));
  return { stack, field, posts, streams, fired };
}

test('the page fires a cue’s triggers in one POST, and does a restore’s then only while the stack is where it was', async (t) => {
  const { stack, field, posts, streams, fired } = await pageHalf(t);
  const c12 = stack.add({ number: '12', actions: field.parse('VT audio; restore when Mitti ends then go').map((a) => ({ ...a, kind: 'triggers' })) });
  const c13 = stack.add({ number: '13', actions: [] });
  stack.add({ number: '14', actions: [] });

  stack.go();
  await until(() => posts.some((p) => p.path === '/fire'));
  const fire = posts.find((p) => p.path === '/fire').body;
  assert.deepEqual(fire.fire, ['vt-audio']);
  assert.equal(fire.restore.deck, 'mitti');
  assert.equal(fire.cue.number, '12');
  assert.equal(streams.length, 1, 'a hold with a then opens the stream');

  /* Another page's restore is not this page's to act on. */
  streams[0].emit('restored', { hold: { id: 'h-x', page: 'someone-else', cue: { id: c12.id } }, then: 'go' });
  assert.deepEqual(fired, [c12.id]);

  streams[0].emit('restored', { hold: { id: `h-${c12.id}`, page: fire.page, cue: { id: c12.id, number: '12' } }, then: 'go' });
  assert.deepEqual(fired, [c12.id, c13.id], 'GO fired the cue after');
  await until(() => posts.some((p) => p.path === '/then'));
  assert.deepEqual(posts.find((p) => p.path === '/then').body, { hold: `h-${c12.id}`, ok: true, text: 'cue 12 → GO' });

  /* The same restore again: the stack has moved on, so nothing more fires. */
  streams[0].emit('restored', { hold: { id: `h-${c12.id}`, page: fire.page, cue: { id: c12.id, number: '12' } }, then: 'go' });
  assert.deepEqual(fired, [c12.id, c13.id]);
  await until(() => posts.filter((p) => p.path === '/then').length === 2);
  assert.match(posts.filter((p) => p.path === '/then')[1].body.text, /moved on/);
});

test('a page with an at-next-cue hold tells the server when it fires the next cue', async (t) => {
  const { stack, field, posts } = await pageHalf(t);
  const c1 = stack.add({ number: '1', actions: field.parse('VT audio; restore at next cue').map((a) => ({ ...a, kind: 'triggers' })) });
  const c2 = stack.add({ number: '2', actions: [] });
  stack.go();
  await until(() => posts.some((p) => p.path === '/fire'));
  await wait(20);
  assert.equal(posts.filter((p) => p.path === '/next').length, 0, 'not for the cue that made the hold');
  stack.go();
  await until(() => posts.some((p) => p.path === '/next'));
  const next = posts.find((p) => p.path === '/next').body;
  assert.equal(next.cue, c2.id);
  assert.notEqual(next.cue, c1.id);
});
