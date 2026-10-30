/*
 * grandMA3 — playback feedback read, mapped and sent, offline.
 *
 * The messages are grandMA3 onPC 2.4.2.2's own, recorded on this Mac
 * (`test/fixtures/grandma3-2.4.2.2-feedback.json`, which says how). The switcher
 * is a stand-in exchange; `test/sim/grandma3.sim.test.js` sends the same bytes
 * to the real app in front of the simulator.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decode, createOscServer, createOscDispatcher } from '../server/osc.js';
import { NLC } from '../src/core/dialect.js';
import { toAwj } from '../src/core/paths.js';
import { paramsFor } from '../src/core/osc-dictionary.js';
import { resolveOsc, LIVEPREMIER } from '../src/vendor/mynah-lang.mjs';
import {
  PREFIX, readFeedback, parseMap, faderEdge, actionFor, lineFor, normaliseGrandma3, isFaderFunction,
} from '../plugins/grandma3/core.js';
import { Grandma3Bridge } from '../plugins/grandma3/bridge.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await readFile(join(here, 'fixtures', 'grandma3-2.4.2.2-feedback.json'), 'utf8'));
const packets = fixture.messages.map((m) => Buffer.from(m.hex, 'hex'));
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

/** What the switcher would be written for an address — the resolver's own answer, not a transcription of it. */
const pathsFor = (address, args = []) => resolveOsc({ address, args }, { params: paramsFor(LIVEPREMIER), platform: LIVEPREMIER })
  .ops.map((op) => op.path.toAwj());

/** A LivePremier that answers who it is and takes every write in silence. */
function standIn() {
  const said = [];
  const awj = async (messages) => {
    said.push(...messages);
    return messages.map((m) => (m.op === 'get' && m.path.endsWith('$device/@items/1/@props/dev')
      ? { path: m.path, value: 'NLC_C' }
      : { path: m.op === 'get' ? '' : m.path, value: null }));
  };
  return { said, awj, writes: () => said.filter((m) => m.op === 'replace') };
}

function bridgeWith(map, { drive = true, dispatch, switcher } = {}) {
  const sent = [];
  const b = new Grandma3Bridge({
    dispatch: dispatch || (async (msg) => { sent.push(msg); return { ...msg, summary: 'ok', writes: 1, paths: ['x'] }; }),
    switcher,
    strokeIdleMs: 200,
  });
  b.apply({ grandma3Drive: drive, grandma3Map: map });
  return { b, sent };
}

/* ======================================================= what the desk sends == */

test('the recorded messages decode with their type tags, as the desk sent them', () => {
  for (const [i, buf] of packets.entries()) {
    const [msg] = decode(buf);
    const want = fixture.messages[i];
    assert.equal(msg.address, want.address);
    assert.equal(msg.types, want.types);
    assert.deepEqual(msg.args, want.args);
  }
});

test('every recorded message reads as feedback: faders, keys pressed and released, the cue they fired', () => {
  const read = packets.map((buf) => { const [m] = decode(buf); return readFeedback(m.address, m.args, m.types); });
  assert.ok(read.every(Boolean), 'nothing the desk sent was refused');
  assert.deepEqual(read.slice(0, 5).map((r) => [r.kind, r.fn, r.via, r.value]), [
    ['fader', 'FaderMaster', 1, 0], ['fader', 'FaderMaster', 1, 25.5], ['fader', 'FaderMaster', 1, 100],
    ['fader', 'FaderMaster', 1, 100], ['fader', 'FaderMaster', 1, 0],
  ]);
  assert.deepEqual(read[5], { object: '14.14.1.6.1', fn: 'Go+', kind: 'key', via: null, value: 1, cue: 'Take S1 1 Cue' });
  assert.deepEqual(read.slice(7, 9).map((r) => [r.fn, r.value, r.cue]), [['Flash', 1, null], ['Flash', 0, null]]);
  assert.equal(read[9].object, '14.14.1.6.2', 'the second executor is the second sequence');
  assert.equal(read[9].cue, 'Recall 5 1 Cue');
});

test('a knob is told from a fader by its type tags; typed at the Console, a number is a position', () => {
  assert.equal(readFeedback('/ma3/14.14.1.6.1', ['FaderMaster', 0, -1], 'sii').kind, 'knob');
  assert.equal(readFeedback('/ma3/14.14.1.6.1', ['FaderMaster', 3, 63.5], 'sif').kind, 'fader');
  assert.equal(readFeedback('/ma3/14.14.1.6.1', ['FaderMaster', 1, 40]).kind, 'fader');
  assert.equal(readFeedback('/ma3/14.14.1.6.1', ['Go+', 1]).kind, 'key');
});

test('anything that is not an object address, a function and a value is not feedback', () => {
  assert.equal(readFeedback('/ma3/hello', [42], 'i'), null);
  assert.equal(readFeedback('/ma3/14.14.1.6.1', [42], 'i'), null);
  assert.equal(readFeedback('/ma3/14.14.1.6.1', ['Go+'], 's'), null);
  assert.equal(readFeedback('/lp/screen/1/take', ['Go+', 1], 'si'), null);
  assert.equal(readFeedback('/ma3/14.14.1.6.1', ['Go+', 1, true], 'siT'), null);
});

/* ================================================================ the lines == */

test('a line names the address, the function and a target; notes and blank lines are skipped', () => {
  const { rules, errors } = parseMap([
    '# show: Act One',
    '14.14.1.6.1 Go+ -> /lp/screen/1/take          # Take S1',
    '',
    '14.14.1.6.2 Go+ → /lp/screen/1/memory/5/recall',
    '14.14.1.6.3 FaderMaster -> tbar s1 S2',
    '14.14.1.6.4 FaderMaster -> /lp/screen/1/preset/a/layer/2/opacity/opacity/norm',
    '14.14.1.6.5 Flash -> /lp/screen/1/preset/a/layer/2/opacity/opacity/norm 1',
  ].join('\n'));
  assert.deepEqual(errors, []);
  assert.deepEqual(rules.map((r) => [r.line, r.key, r.target]), [
    [2, '14.14.1.6.1 Go+', { type: 'osc', address: '/lp/screen/1/take', args: [] }],
    [4, '14.14.1.6.2 Go+', { type: 'osc', address: '/lp/screen/1/memory/5/recall', args: [] }],
    [5, '14.14.1.6.3 FaderMaster', { type: 'tbar', screens: ['S1', 'S2'] }],
    [6, '14.14.1.6.4 FaderMaster', { type: 'osc', address: '/lp/screen/1/preset/a/layer/2/opacity/opacity/norm', args: [] }],
    [7, '14.14.1.6.5 Flash', { type: 'osc', address: '/lp/screen/1/preset/a/layer/2/opacity/opacity/norm', args: [1] }],
  ]);
  assert.equal(rules[0].note, 'Take S1');
});

test('a line that cannot be read says which and why, and the good ones still stand', () => {
  const { rules, errors } = parseMap([
    '14.14.1.6.1 Go+ /lp/screen/1/take',
    'Seq1 Go+ -> /lp/screen/1/take',
    '14.14.1.6.1 Go+ -> /lp/screen/1/take',
    '14.14.1.6.1 Go+ -> /lp/screen/2/take',
    '14.14.1.6.2 Go+ -> tbar S1',
    '14.14.1.6.3 FaderMaster -> tbar',
    '14.14.1.6.3 FaderMaster -> tbar Q1',
    '14.14.1.6.4 Flash -> /ma3/14.14.1.6.1',
    '14.14.1.6.5 Flash -> lp/screen/1/take',
    '14.14.1.6.6 Flash -> /lp/screen/1/take 1 2',
    '14.14.1.6.7 Flash ->',
  ].join('\n'));
  assert.equal(rules.length, 1);
  assert.deepEqual(errors.map((e) => e.line), [1, 2, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.match(errors[1].message, /not an address grandMA3 sends/);
  assert.match(errors[2].message, /already mapped on line 3/);
  assert.match(errors[3].message, /only a fader can be a T-bar/);
  assert.match(errors[6].message, /grandMA3's own subtree/);
});

test('a heard handle becomes a line with the arrow left for its target', () => {
  assert.equal(lineFor({ object: '14.14.1.6.1', fn: 'Go+', cue: 'Take S1 2 Cue' }), '14.14.1.6.1 Go+ ->    # Take S1 2 Cue');
  assert.equal(lineFor({ object: '14.14.1.6.1', fn: 'FaderMaster', cue: null }), '14.14.1.6.1 FaderMaster -> ');
  assert.ok(isFaderFunction('FaderTemp') && !isFaderFunction('Flash'));
});

test('settings: off, empty, and a pasted show file is cut short rather than kept', () => {
  assert.deepEqual(normaliseGrandma3(undefined), { grandma3Drive: false, grandma3Map: '' });
  assert.deepEqual(normaliseGrandma3({ grandma3Drive: 'yes', grandma3Map: 'a\r\nb' }), { grandma3Drive: false, grandma3Map: 'a\nb' });
  assert.equal(normaliseGrandma3({ grandma3Map: 'x'.repeat(50_000) }).grandma3Map.length, 20_000);
});

/* ============================================================== the actions == */

test('a key sends on press only; a fader sends its position, throws a T-bar, or is a button', () => {
  const rule = (target) => ({ target });
  const key = (value) => ({ kind: 'key', value });
  const fader = { kind: 'fader', value: 40 };
  const osc = (address, args = []) => ({ type: 'osc', address, args });
  assert.deepEqual(actionFor(rule(osc('/lp/screen/1/take')), key(1)), { do: 'send' });
  assert.equal(actionFor(rule(osc('/lp/screen/1/take')), key(0)).do, 'nothing');
  assert.equal(actionFor(rule({ type: 'tbar', screens: ['S1'] }), key(1)).do, 'nothing');
  assert.equal(actionFor(rule({ type: 'tbar', screens: ['S1'] }), fader).do, 'tbar');
  assert.equal(actionFor(rule(osc('/lp/x/norm')), fader).do, 'value');
  assert.equal(actionFor(rule(osc('/lp/x/norm', [1])), fader).do, 'edge');
  assert.equal(actionFor(rule(osc('/lp/screen/1/take')), fader).do, 'edge');
  assert.equal(actionFor(rule(osc('/lp/screen/1/take')), { kind: 'knob', value: -1 }).do, 'nothing');
});

test('a fader as a button fires once on the way up, and not until it has been back to the bottom', () => {
  let armed = false;
  const fired = [];
  for (const v of [80, 100, 3, 40, 60, 70, 49, 2, 90]) {
    const e = faderEdge(armed, v);
    armed = e.armed;
    if (e.fire) fired.push(v);
  }
  assert.deepEqual(fired, [60, 90], 'not the 80 it was first heard at, and not the 70 after firing');
});

/* =============================================================== the engine == */

test('driving off: a mapped press is heard and named, and nothing is sent', async () => {
  const { b, sent } = bridgeWith('14.14.1.6.1 Go+ -> /lp/screen/1/take', { drive: false });
  const answer = await b.handle('/ma3/14.14.1.6.1', ['Go+', 1, 'Take S1 2 Cue'], { types: 'sis' });
  assert.equal(answer.ok, true);
  assert.match(answer.summary, /not sent: driving the switcher is off/);
  assert.equal(sent.length, 0);
  assert.deepEqual(b.describe().heard.map((h) => [h.object, h.fn, h.cue, h.mapped]), [['14.14.1.6.1', 'Go+', 'Take S1 2 Cue', true]]);
});

test('a press sends its target once; the release sends nothing; an unmapped handle is only heard', async () => {
  const { b, sent } = bridgeWith('14.14.1.6.1 Flash -> /lp/screen/1/take');
  await b.handle('/ma3/14.14.1.6.1', ['Flash', 1], { types: 'si' });
  const release = await b.handle('/ma3/14.14.1.6.1', ['Flash', 0], { types: 'si' });
  const other = await b.handle('/ma3/14.14.1.6.2', ['Go+', 1, 'Recall 5 1 Cue'], { types: 'sis' });
  assert.deepEqual(sent, [{ address: '/lp/screen/1/take', args: [] }]);
  assert.match(release.summary, /released/);
  assert.equal(other.ok, true);
  assert.match(other.summary, /not mapped/);
  assert.equal(b.describe().heard.find((h) => h.object === '14.14.1.6.2').mapped, false);
});

test('a fader on a /norm address sends one position at a time, the newest waiting', async () => {
  const sent = [];
  let open = null;
  const dispatch = (msg) => new Promise((resolve) => {
    sent.push(msg.args[0]);
    open = () => resolve({ ...msg, writes: 1 });
  });
  const { b } = bridgeWith('14.14.1.6.4 FaderMaster -> /lp/screen/1/preset/a/layer/2/opacity/opacity/norm', { dispatch });
  const first = b.handle('/ma3/14.14.1.6.4', ['FaderMaster', 3, 10], { types: 'sif' });
  const second = b.handle('/ma3/14.14.1.6.4', ['FaderMaster', 3, 20], { types: 'sif' });
  const third = b.handle('/ma3/14.14.1.6.4', ['FaderMaster', 3, 30], { types: 'sif' });
  assert.match((await second).summary, /overtaken by a newer position/);
  open();
  assert.equal((await first).count, 1);
  await settle();
  open();
  assert.equal((await third).count, 1);
  assert.deepEqual(sent, [0.1, 0.3], 'the 20 % reading never went out');
});

test('a fader as a button fires its target on the way up past halfway, once', async () => {
  const { b, sent } = bridgeWith('14.14.1.6.1 FaderMaster -> /lp/screen/1/take');
  for (const v of [80, 0, 30, 60, 100, 0, 75]) await b.handle('/ma3/14.14.1.6.1', ['FaderMaster', 3, v], { types: 'sif' });
  assert.equal(sent.length, 2);
});

test('a fader as a T-bar: where it rests, then a stroke, and the throw back is the next take', async () => {
  const writes = [];
  let rest = 0;
  const switcher = {
    dialect: null,
    identify: async () => NLC,
    restsFor: async (ids) => new Map(ids.map((id) => [id, rest])),
    write: async (w) => { writes.push(...w); },
  };
  const { b } = bridgeWith('14.14.1.6.3 FaderMaster -> tbar S1', { switcher });
  const at = (v) => b.handle('/ma3/14.14.1.6.3', ['FaderMaster', 3, v], { types: 'sif' });
  const tbar = toAwj(NLC.takeControl('S1', 'tbarPosition'));

  assert.match((await at(0)).summary, /where the fader rests/);
  await settle();
  assert.equal(writes.length, 0, 'the first reading moves nothing');

  await at(50);
  await settle();
  await at(100);
  await settle(30);
  assert.deepEqual(writes.map((w) => [toAwj(w.path), w.value]), [[tbar, 32768], [tbar, 65535]]);
  assert.match(b.describe().history[0].note, /T-bar take on S1/);

  /* After the take the T-bar rests at the top; the fader coming back down is the next take. */
  rest = 65535;
  writes.length = 0;
  await at(0);
  await settle(30);
  assert.deepEqual(writes.map((w) => w.value), [0]);
});

test('a refusal from the dispatcher is an error on the press and in the history', async () => {
  const { b } = bridgeWith('14.14.1.6.1 Go+ -> /lp/screen/1/preset/preview/layer/1/opacity/opacity/norm 1', {
    dispatch: async (msg) => ({ ...msg, error: 'preview needs the take state' }),
  });
  const answer = await b.handle('/ma3/14.14.1.6.1', ['Go+', 1, 'x 1 Cue'], { types: 'sis' });
  assert.equal(answer.ok, false);
  assert.match(b.describe().history[0].error, /preview needs the take state/);
});

test('a changed line starts its handle afresh; an unchanged one carries on', async () => {
  const two = (first) => `${first}\n14.14.1.6.2 FaderMaster -> /lp/screen/2/take`;
  const { b, sent } = bridgeWith(two('14.14.1.6.1 FaderMaster -> /lp/screen/1/take'));
  await b.handle('/ma3/14.14.1.6.1', ['FaderMaster', 3, 0], { types: 'sif' });
  await b.handle('/ma3/14.14.1.6.2', ['FaderMaster', 3, 0], { types: 'sif' });
  b.apply({ grandma3Drive: true, grandma3Map: two('14.14.1.6.1 FaderMaster -> /lp/screen/3/take') });
  await b.handle('/ma3/14.14.1.6.1', ['FaderMaster', 3, 90], { types: 'sif' });
  assert.equal(sent.length, 0, 'armed under the old line is not armed under the new one');
  await b.handle('/ma3/14.14.1.6.2', ['FaderMaster', 3, 90], { types: 'sif' });
  assert.deepEqual(sent.map((m) => m.address), ['/lp/screen/2/take'], 'the line nobody touched is still armed');
});

/* ======================================== through the OSC listener, as wired == */

test('the desk’s own Go+ bytes, over UDP, through the listener and the dispatcher, take S1', async () => {
  const sw = standIn();
  const dispatcher = createOscDispatcher({ deviceHost: () => 'switcher.example:80', awj: sw.awj });
  const { b } = bridgeWith('14.14.1.6.1 Go+ -> /lp/screen/1/take', { dispatch: (msg) => dispatcher.dispatch(msg) });
  const entries = [];
  let wake = () => {};
  const osc = createOscServer({
    port: 0, address: '127.0.0.1',
    deviceHost: () => 'switcher.example:80',
    awj: sw.awj,
    addresses: () => [{ prefix: PREFIX, handle: (a, args, meta) => b.handle(a, args, meta) }],
    onActivity: (e) => { entries.push(e); wake(); },
  });
  await osc.start();
  try {
    const goPlus = packets[fixture.messages.findIndex((m) => m.args[0] === 'Go+' && m.address.endsWith('.1'))];
    const heard = new Promise((r) => { wake = r; });
    const client = dgram.createSocket('udp4');
    await new Promise((r) => client.send(goPlus, osc.state.port, '127.0.0.1', () => { client.close(); r(); }));
    await Promise.race([heard, new Promise((_, rej) => setTimeout(() => rej(new Error('nothing heard')), 3000))]);
    const entry = entries.at(-1);
    assert.equal(entry.error, undefined, entry.error);
    assert.equal(entry.writes, pathsFor('/lp/screen/1/take').length);
    assert.deepEqual(sw.writes().map((m) => m.path), pathsFor('/lp/screen/1/take'));
    assert.equal(osc.state.sent, entry.writes);
    assert.equal(b.describe().history[0].note, '/lp/screen/1/take — 1 write', 'the address once, then what it did');
  } finally {
    await osc.stop();
  }
});

test('over the dispatcher, a line for preview is refused with the listener’s own reason', async () => {
  const sw = standIn();
  const dispatcher = createOscDispatcher({ deviceHost: () => 'switcher.example:80', awj: sw.awj });
  const { b } = bridgeWith('14.14.1.6.4 FaderMaster -> /lp/screen/1/preset/preview/layer/1/opacity/opacity/norm', {
    dispatch: (msg) => dispatcher.dispatch(msg),
  });
  const answer = await b.handle('/ma3/14.14.1.6.4', ['FaderMaster', 3, 50], { types: 'sif' });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /preview|program/i);
  assert.equal(sw.writes().length, 0);
});
