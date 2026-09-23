/*
 * HyperDecks: the protocol parser, the link against an emulated deck, the
 * rules, and the plugin's routes.
 *
 * ⚠️ The deck on the other end is `tools/hyperdeck-sim.mjs` — Blackmagic's
 * published protocol, answered by this repo. These tests prove the link and
 * the emulation agree with the document and with each other. They do not
 * prove a real HyperDeck or a real Mitti agrees; nobody has run one against
 * this yet.
 *
 * The on-air tests use the simulator's own store fixtures (the same ones
 * `core.test.js` reads), so "on program" is decided by the same buffer
 * arithmetic the screen cards use.
 *
 * Run: node --test test/hyperdeck.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import { ROOT } from '../src/core/paths.js';
import {
  ReplyParser, readClips, readTransport, frameRate, tcSeconds, clipPosition, COMMANDS,
} from '../plugins/hyperdeck/protocol.js';
import {
  normaliseDecks, resolveDecks, parseCueText, describeCueAction, sourceForInput, airState, decide, endAction,
} from '../plugins/hyperdeck/core.js';
import { DeckLink } from '../plugins/hyperdeck/link.js';
import activateHyperdeck from '../plugins/hyperdeck/server.js';
import { startHyperDeckSim } from '../tools/hyperdeck-sim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(20); }
  return false;
}

/* ------------------------------------------------------------ protocol */

test('replies split into single lines and blocks, CRLF or LF', () => {
  const p = new ReplyParser();
  const out = [
    ...p.push('500 connection info:\r\nprotocol version: 1.11\r\nmodel: HyperDeck Studio\r\n\r\n200 o'),
    ...p.push('k\n208 transport info:\nstatus: play\nclip id: 2\n\n'),
  ];
  assert.deepEqual(out.map((r) => r.code), [500, 200, 208]);
  assert.equal(out[0].fields.model, 'HyperDeck Studio');
  assert.equal(out[1].text, 'ok');
  assert.deepEqual(readTransport(out[2].fields), { status: 'play', clip: 2 });
});

test('both clip line shapes read, names with spaces included', () => {
  const clips = readClips([
    'clip count: 3',
    '1: Walk in loop.mov 00:00:00:00 00:00:30:00',
    '2: Opener.mov H.264 1080p25 00:00:08:00',
    '3: Plain 00:00:05:00',
  ]);
  assert.deepEqual(clips.map((c) => c.name), ['Walk in loop.mov', 'Opener.mov', 'Plain']);
  assert.equal(clips[0].start, '00:00:00:00');
  assert.equal(clips[1].start, null);
  assert.equal(clips[1].duration, '00:00:08:00');
});

test('timecode arithmetic follows the format, interlaced counting fields as frames/2', () => {
  assert.equal(frameRate('1080p50'), 50);
  assert.equal(frameRate('1080i50'), 25);
  assert.equal(frameRate('1080p2997'), 29.97);
  assert.equal(frameRate('garbage'), null);
  assert.equal(tcSeconds('00:01:00:12', 25), 60.48);
  const pos = clipPosition(
    { clip: 2, timecode: '00:00:40:00', videoFormat: '1080p25' },
    [{ id: 1, start: '00:00:00:00', duration: '00:00:30:00' }, { id: 2, start: '00:00:30:00', duration: '00:00:12:00' }]);
  assert.deepEqual(pos, { elapsed: 10, remaining: 2, length: 12 });
});

test('commands are the protocol’s words', () => {
  assert.equal(COMMANDS.play(), 'play');
  assert.equal(COMMANDS.play({ loop: true }), 'play: loop: true');
  assert.equal(COMMANDS.record({ name: 'Act: 1' }), 'record: name: Act  1');
  assert.equal(COMMANDS.clip({ clip: 3 }), 'goto: clip id: 3');
  assert.equal(COMMANDS.clip({ clip: 0 }), null);
  assert.equal(COMMANDS.next(), 'goto: clip id: +1');
});

/* ------------------------------------------------------------ the link */

test('a link reads a deck, plays it, and hears a single clip end by itself', async (t) => {
  const sim = await startHyperDeckSim({ port: 0, clips: [{ name: 'Short.mov', seconds: 0.6 }, { name: 'Next.mov', seconds: 5 }] });
  const link = new DeckLink({ id: 'a', host: '127.0.0.1', port: sim.port, reconnectMs: 100 });
  t.after(async () => { link.close(); await sim.close(); });
  link.connect();
  assert.ok(await until(() => link.clips.length === 2 && link.transport.status), 'clip list and transport arrive');
  assert.equal(link.device.model, 'HyperDeck Studio HD Plus');

  const ended = [];
  link.on('ended', (e) => ended.push(e));
  sim.state.single = true;
  assert.deepEqual(await link.send('play'), { ok: true });
  assert.ok(await until(() => ended.length === 1, 3000), 'the stop at the end is reported as an end');
  assert.equal(ended[0].clip, 1);
  assert.equal(link.transport.status, 'stopped');
});

test('a stop we sent is not a clip ending', async (t) => {
  const sim = await startHyperDeckSim({ port: 0 });
  const link = new DeckLink({ id: 'a', host: '127.0.0.1', port: sim.port });
  t.after(async () => { link.close(); await sim.close(); });
  link.connect();
  await until(() => link.clips.length);
  const ended = [];
  link.on('ended', (e) => ended.push(e));
  await link.send('play');
  await until(() => link.transport.status === 'play');
  await link.send('stop');
  await until(() => link.transport.status === 'stopped');
  await wait(300);
  assert.equal(ended.length, 0);
});

test('Mitti is refused record before it reaches the wire', async (t) => {
  const sim = await startHyperDeckSim({ port: 0, mitti: true });
  const link = new DeckLink({ id: 'm', name: 'Mitti', host: '127.0.0.1', port: sim.port, profile: 'mitti' });
  t.after(async () => { link.close(); await sim.close(); });
  link.connect();
  await until(() => link.status === 'connected');
  const r = await link.send('record');
  assert.equal(r.ok, false);
  assert.match(r.error, /does not record/);
});

test('remote control off is switched on once, and the command retried', async (t) => {
  const sim = await startHyperDeckSim({ port: 0 });
  sim.state.remote = false;
  const link = new DeckLink({ id: 'a', host: '127.0.0.1', port: sim.port });
  t.after(async () => { link.close(); await sim.close(); });
  link.connect();
  await until(() => link.status === 'connected');
  assert.deepEqual(await link.send('play'), { ok: true });
  assert.equal(sim.state.remote, true);
});

/* ------------------------------------------------------------ decks and cues */

test('the deck list is normalised: ids unique, group words kept free, rules off by default', () => {
  const decks = normaliseDecks([
    { name: 'Opener', host: '10.0.0.5', input: 'input:IN_3' },
    { name: 'Opener', host: '10.0.0.6' },
    { name: 'All', role: 'recorder', output: 'output:5', port: 99999 },
  ]);
  assert.deepEqual(decks.map((d) => d.id), ['opener', 'opener-2', 'all-2']);
  assert.equal(decks[0].rules.automate, false);
  assert.equal(decks[2].port, 9993);
  assert.equal(decks[2].role, 'recorder');
  assert.deepEqual(resolveDecks(decks, 'recorders').map((d) => d.id), ['all-2']);
  assert.deepEqual(resolveDecks(decks, '2').map((d) => d.id), ['opener-2']);
});

test('a cue line names a deck, however many words, then what to do', () => {
  const decks = normaliseDecks([{ name: 'Big Screen Deck' }, { name: 'REC', role: 'recorder' }]);
  const actions = parseCueText('Big Screen Deck clip 3; big screen deck play; REC rec Act 1; recorders stop', decks);
  assert.deepEqual(actions, [
    { kind: 'hyperdeck', deck: 'big-screen-deck', command: 'clip', clip: 3 },
    { kind: 'hyperdeck', deck: 'big-screen-deck', command: 'play' },
    { kind: 'hyperdeck', deck: 'rec', command: 'record', name: 'Act 1' },
    { kind: 'hyperdeck', deck: 'recorders', command: 'stop' },
  ]);
  assert.equal(describeCueAction(actions[0], decks), 'Big Screen Deck clip 3');
  assert.throws(() => parseCueText('Nobody play', decks), /not a deck/);
  assert.throws(() => parseCueText('REC dance', decks), /say a deck/);
});

/* ------------------------------------------------------------ on air */

function airStore() {
  const store = new DeviceStore();
  const merge = (a, b) => {
    for (const [k, v] of Object.entries(b)) {
      a[k] = a[k] && typeof a[k] === 'object' && v && typeof v === 'object' ? merge(a[k], v) : v;
    }
    return a;
  };
  store.hydrate(['sim-6.2.73-identity.json', 'sim-6.2.73-destinations.json', 'sim-6.2.73-connectors.json']
    .map(fixture).reduce(merge, {}));
  return store;
}
const setSource = (store, bank, source) => store.set(
  [ROOT, 'screenList', 'items', 'S1', 'presetList', 'items', bank, 'layerList', 'items', '1', 'source', 'pp', 'inputNum'], source);
const setTransition = (store, transition) => store.set([ROOT, 'screenAuxGroupList', 'items', 'S1', 'status', 'pp'],
  { isUsed: true, transition, take: 'OFF', tbarPosition: 0 });

test('an input connector is the dialect’s own source name', () => {
  assert.equal(sourceForInput(airStore(), 'input:IN_1'), 'LIVE_1');
  assert.equal(sourceForInput(airStore(), 'output:5'), null);
});

test('program is the program buffer; mid-transition, both buffers are on air', () => {
  const store = airStore();
  /* AT_UP: B is program. */
  setSource(store, 'A', 'NONE');
  setSource(store, 'B', 'LIVE_1');
  let air = airState(store, new Set(['LIVE_1']));
  assert.deepEqual([...air.get('LIVE_1').program], ['S1']);

  setSource(store, 'B', 'NONE');
  setSource(store, 'A', 'LIVE_1');
  air = airState(store, new Set(['LIVE_1']));
  assert.deepEqual([...air.get('LIVE_1').program], []);
  assert.deepEqual([...air.get('LIVE_1').preview], ['S1']);

  setTransition(store, 'EFFECT_FROM_UP');
  air = airState(store, new Set(['LIVE_1']));
  assert.deepEqual([...air.get('LIVE_1').program], ['S1'], 'arriving on air as the take starts');
});

test('the rules walk a show: preview rewinds, program plays, leaving loads the next clip', () => {
  const [deck] = normaliseDecks([{ name: 'VT', input: 'input:IN_1', rules: {
    automate: true, onProgram: 'play', onPreview: 'rewind', onLeave: 'next', onEnd: 'take',
  } }]);
  const at = (program, preview) => new Map([[deck.id, { program: new Set(program), preview: new Set(preview) }]]);
  const off = at([], []);
  assert.deepEqual(decide([deck], off, at([], ['S1'])).map((a) => a.sequence.map((s) => s.command)), [['rewind']]);
  assert.deepEqual(decide([deck], at([], ['S1']), at(['S1'], [])).map((a) => a.sequence.map((s) => s.command)), [['play']]);
  assert.deepEqual(decide([deck], at(['S1'], []), at(['S1', 'S2'], [])), [], 'a second screen is not a second play');
  assert.deepEqual(decide([deck], at(['S1'], []), off).map((a) => a.sequence.map((s) => s.command)), [['stop', 'next']]);
  assert.deepEqual(endAction(deck, { program: new Set(['S1']) }), { type: 'take', screens: ['S1'] });
  assert.equal(endAction(deck, { program: new Set() }), null, 'off air, nobody needs a transition');
});

test('rules that are off, or scoped to other screens, do nothing', () => {
  const [off, scoped] = normaliseDecks([
    { name: 'A', input: 'input:IN_1' },
    { name: 'B', input: 'input:IN_2', rules: { automate: true, screens: ['S2'] } },
  ]);
  const was = new Map([[off.id, { program: new Set(), preview: new Set() }], [scoped.id, { program: new Set(), preview: new Set() }]]);
  const now = new Map([[off.id, { program: new Set(['S1']), preview: new Set() }], [scoped.id, { program: new Set(['S1']), preview: new Set() }]]);
  assert.deepEqual(decide([off, scoped], was, now), []);
});

/* ------------------------------------------------------------ the plugin */

function hostFor() {
  const routes = new Map();
  const contributions = [];
  const disposers = [];
  const docs = new Map();
  const sent = [];
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const ctx = {
    HttpError,
    log: () => {},
    route: (method, path, fn) => routes.set(`${method} ${path}`, fn),
    stream: () => ({ send: (event, data) => sent.push({ event, data }) }),
    onDispose: (fn) => disposers.push(fn),
    contribute: (point, spec) => contributions.push({ point, spec }),
    storage: {
      load: async (name) => docs.get(name) ?? null,
      save: async (name, data) => { docs.set(name, data); },
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
  return { ctx, call, contributions, sent, docs, stop: () => disposers.reverse().forEach((fn) => fn()) };
}

test('the plugin saves decks, commands one by name, and answers OSC', async (t) => {
  const sim = await startHyperDeckSim({ port: 0 });
  const host = hostFor();
  await activateHyperdeck(host.ctx);
  t.after(async () => { host.stop(); await sim.close(); });

  const saved = await host.call('PUT', '/', { decks: [{ name: 'VT 1', host: '127.0.0.1', port: sim.port, input: 'input:IN_1' }] });
  assert.equal(saved.status, 200);
  assert.equal(host.docs.get('hyperdecks').decks[0].id, 'vt-1');

  assert.ok(await until(async () => (await host.call('GET', '/')).body.live[0]?.status === 'connected'));
  const r = await host.call('POST', '/command', { deck: 'VT 1', sequence: [{ command: 'clip', clip: 2 }, { command: 'play' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(await until(() => sim.state.status === 'play' && sim.state.clip === 2));

  const osc = host.contributions.find((c) => c.point === 'oscAddress').spec;
  const stopped = await osc.handle('/hyperdeck/1/stop', []);
  assert.equal(stopped.ok, true);
  assert.equal(sim.state.status, 'stopped');
  const refused = await osc.handle('/hyperdeck/nobody/play', []);
  assert.equal(refused.ok, false);

  const bad = await host.call('POST', '/command', { deck: 'players', command: 'record' });
  assert.equal(bad.status, 200, 'record to a group skips the decks that are only players');

  assert.equal(host.contributions.find((c) => c.point === 'configSection').spec.key, 'hyperdecks');
});

test('the rules lease is one page at a time, and lapses', async (t) => {
  const host = hostFor();
  await activateHyperdeck(host.ctx);
  t.after(() => host.stop());
  assert.equal((await host.call('POST', '/runner', { id: 'page-a' })).body.runner, 'page-a');
  assert.equal((await host.call('POST', '/runner', { id: 'page-b' })).body.runner, 'page-a');
  await host.call('POST', '/runner', { id: 'page-a', release: true });
  assert.equal((await host.call('POST', '/runner', { id: 'page-b' })).body.runner, 'page-b');
});
