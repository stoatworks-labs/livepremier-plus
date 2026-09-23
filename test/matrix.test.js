/*
 * The external-matrix subsystem: the connector reader, the patch model and
 * the three protocol parsers.
 *
 * ## What these tests can and cannot prove
 *
 * `sim-6.2.73-connectors.json` is **real**: the `inputList` and `outputList`
 * subtrees lifted verbatim out of GET /api/stores/device on a running
 * LivePremier simulator (NLC_CMAX, 6.2.73) on 2026-09-21, trimmed to the
 * three nodes this app reads. So the connector tests are a genuine check
 * against a device's own vocabulary — including the `IN_5`/`5` key asymmetry,
 * which is the thing most likely to be got wrong.
 *
 * The **protocol tests are not that**. They feed each driver the byte
 * sequences its vendor's documentation says it will receive, and check the
 * parse. That proves the parser matches the document; it does not prove the
 * document matches the hardware, and for Lightware and Turtle AV no hardware
 * has ever been in the loop. The Videohub bytes below are the ones BlackMatrix
 * exercised against a working implementation of the protocol, so they are a
 * step better sourced — but still not a real Videohub. Read the header of each
 * driver before trusting it on a show.
 *
 * What they do catch, and what makes them worth having: the zero-based
 * conversion, which is silent, plausible and off by one.
 *
 * Run: node --test test/matrix.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import {
  readConnectors, readAllConnectors, describeConnector, logicalIndex, parseConnectorId,
} from '../src/core/connectors.js';
import {
  normaliseMatrices, normalisePatch, validate, feed, send, currentFor,
  groupCrosspoints, entryForConnector, ROUTER_SIDE, resolveMatrixOsc, toPortList,
  choicesFor, withEntry, normalisePlan, planCrosspoints,
} from '../src/core/patch.js';
import { connectorForPage } from '../plugins/matrix-routing/router-box.js';
import { VideohubDriver } from '../plugins/matrix-routing/routers/videohub.js';
import { LightwareDriver } from '../plugins/matrix-routing/routers/lightware.js';
import { TurtleDriver, sizeFromModel } from '../plugins/matrix-routing/routers/turtle.js';
import { MatrixSupervisor } from '../plugins/matrix-routing/routers/index.js';
import { PlaceholderDriver } from '../plugins/matrix-routing/routers/placeholder.js';
import { LIBRARY, libraryModel } from '../plugins/matrix-routing/library.js';
import { placeholderConfig } from '../plugins/matrix-routing/panel.js';
import activateMatrix from '../plugins/matrix-routing/server.js';

const here = dirname(fileURLToPath(import.meta.url));

function connectorStore() {
  const snapshot = JSON.parse(
    readFileSync(join(here, 'fixtures', 'sim-6.2.73-connectors.json'), 'utf8'));
  const store = new DeviceStore();
  store.hydrate(snapshot);
  return store;
}

/* A driver with no socket: `onData` is pure, and `write` is captured so the
   commands a route produces can be asserted without a network. */
function offline(Driver, options = {}) {
  const driver = new Driver({ id: 'm1', host: '0.0.0.0', ...options });
  driver.sent = [];
  driver.connectionStatus = 'connected';
  driver.socket = { write: (text) => driver.sent.push(text) };
  return driver;
}

/* ------------------------------------------------------------------ */
/* The connector reader                                               */
/* ------------------------------------------------------------------ */

test('inputs are keyed IN_n and outputs are keyed n', () => {
  const store = connectorStore();
  const inputs = readConnectors(store, 'input');
  const outputs = readConnectors(store, 'output');

  assert.equal(inputs[0].key, 'IN_1');
  assert.equal(outputs[0].key, '1');
  /* Both are logical connector 1 despite the different spelling — this is the
     asymmetry the whole file exists to absorb. */
  assert.equal(inputs[0].index, 1);
  assert.equal(outputs[0].index, 1);
  assert.equal(inputs[0].id, 'input:IN_1');
  assert.equal(outputs[0].id, 'output:1');
});

test('a card carries more connectors than its slot numbers suggest', () => {
  const store = connectorStore();
  const inputs = readConnectors(store, 'input');
  const onCard1 = inputs.filter((c) => c.card === 'IN_1');

  /* Eight connectors on card IN_1, and slot runs 0-3 twice. If anything ever
     keys a connector by (card, slot) this test is how it gets caught. */
  assert.equal(onCard1.length, 8);
  assert.deepEqual(onCard1.map((c) => c.slot), [0, 1, 2, 3, 0, 1, 2, 3]);
  /* `physical` is what is actually unique. */
  assert.equal(new Set(onCard1.map((c) => c.physical)).size, 8);
});

test('physical connector numbering is sparse and is not the key', () => {
  const store = connectorStore();
  const inputs = readConnectors(store, 'input');
  const fifth = inputs.find((c) => c.key === 'IN_5');
  /* Logical input 5 is physical connector IN_9 — the chassis leaves gaps. */
  assert.equal(fifth.physical, 'IN_9');
  assert.equal(fifth.card, 'IN_1');

  const outputs = readConnectors(store, 'output');
  const out5 = outputs.find((c) => c.key === '5');
  /* Outputs, by contrast, have physical == key on this chassis, and no IN_
     prefix. Both spellings are in the same store. */
  assert.equal(out5.physical, '5');
  assert.equal(out5.card, 'OUT_2');
});

test('plug type comes off the device, and differs across one card', () => {
  const store = connectorStore();
  const inputs = readConnectors(store, 'input');
  assert.equal(inputs.find((c) => c.key === 'IN_1').plug, 'HDMI');
  assert.equal(inputs.find((c) => c.key === 'IN_13').plug, 'SDI');
  assert.equal(inputs.find((c) => c.key === 'IN_17').plug, 'DISPLAY_PORT');
});

test('a connector describes itself in the device\'s own words', () => {
  const store = connectorStore();
  const inputs = readConnectors(store, 'input');
  const thirteen = inputs.find((c) => c.key === 'IN_13');
  assert.equal(describeConnector(thirteen), 'Input 13 · card IN_2 · connector IN_25 · sdi');

  /* An output whose physical matches its key does not say the number twice. */
  const out5 = readConnectors(store, 'output').find((c) => c.key === '5');
  assert.equal(describeConnector(out5), 'Output 5 · card OUT_2 · hdmi');
});

test('both sides read together, and a bad side is a programming error', () => {
  const store = connectorStore();
  const all = readAllConnectors(store);
  assert.equal(all.input.length, 20);
  assert.equal(all.output.length, 8);
  assert.throws(() => readConnectors(store, 'sideways'), /unknown connector side/);
});

test('an empty store yields no connectors rather than throwing', () => {
  const store = new DeviceStore();
  store.hydrate({ device: {} });
  assert.deepEqual(readConnectors(store, 'input'), []);
});

test('logicalIndex reads both spellings and refuses a third', () => {
  assert.equal(logicalIndex('IN_7'), 7);
  assert.equal(logicalIndex('7'), 7);
  assert.equal(logicalIndex('OUT_7'), 7);
  assert.equal(logicalIndex('SDI_A'), null);
  assert.deepEqual(parseConnectorId('input:IN_5'), { side: 'input', key: 'IN_5' });
  assert.equal(parseConnectorId('nonsense'), null);
});

/* ------------------------------------------------------------------ */
/* The patch model                                                    */
/* ------------------------------------------------------------------ */

test('the router side is derived from the switcher side, and inverts', () => {
  /* The single idea in core/patch.js. A switcher input hangs off a router
     OUTPUT; a switcher output arrives at a router INPUT. */
  assert.equal(ROUTER_SIDE.input, 'output');
  assert.equal(ROUTER_SIDE.output, 'input');

  const patch = normalisePatch([
    { side: 'input', key: 'IN_5', matrix: 'hub', port: 1 },
    { side: 'output', key: '2', matrix: 'hub', port: 1 },
  ]);
  assert.equal(patch[0].routerSide, 'output');
  assert.equal(patch[1].routerSide, 'input');
  /* Both name port 1 and neither conflicts: one is the hub's output 1 and the
     other its input 1, which are different sockets. */
  assert.equal(validate(patch, { matrices: [{ id: 'hub', name: 'Hub' }] }).length, 0);
});

test('feeding a switcher input is exactly one crosspoint', () => {
  /* The user's first example: "Card 2 port 1 is connected to Output 1 on a
     videohub, and route videohub in 1 through to that port." */
  const patch = normalisePatch([{ side: 'input', key: 'IN_5', matrix: 'hub', port: 1 }]);
  const result = feed(patch, 'input:IN_5', 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.crosspoints, [{ matrix: 'hub', output: 1, input: 1 }]);
});

test('sending a switcher output is one crosspoint per destination', () => {
  /* The second example: "card 2 output 2 is connected to videohub input 1,
     and route it out of videohub outputs 1-4." */
  const patch = normalisePatch([{ side: 'output', key: '2', matrix: 'hub', port: 1 }]);
  const result = send(patch, 'output:2', [1, 2, 3, 4]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.crosspoints, [
    { matrix: 'hub', output: 1, input: 1 },
    { matrix: 'hub', output: 2, input: 1 },
    { matrix: 'hub', output: 3, input: 1 },
    { matrix: 'hub', output: 4, input: 1 },
  ]);
});

test('the two operations refuse each other\'s connectors', () => {
  const patch = normalisePatch([
    { side: 'input', key: 'IN_5', matrix: 'hub', port: 1 },
    { side: 'output', key: '2', matrix: 'hub', port: 1 },
  ]);
  assert.match(send(patch, 'input:IN_5', [1]).error, /an input is fed, not sent/);
  assert.match(feed(patch, 'output:2', 1).error, /an output is sent, not fed/);
  assert.match(feed(patch, 'input:IN_9', 1).error, /not patched/);
});

test('a destination named twice is routed once', () => {
  const patch = normalisePatch([{ side: 'output', key: '2', matrix: 'hub', port: 3 }]);
  const result = send(patch, 'output:2', [1, 1, 2]);
  assert.deepEqual(result.crosspoints.map((c) => c.output), [1, 2]);
});

test('two cables cannot share one port, or one socket', () => {
  const matrices = [{ id: 'hub', name: 'Hub' }];
  const doubled = normalisePatch([
    { side: 'input', key: 'IN_1', matrix: 'hub', port: 4 },
    { side: 'input', key: 'IN_2', matrix: 'hub', port: 4 },
  ]);
  const problems = validate(doubled, { matrices });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /already has input IN_1 on it/);

  const twice = normalisePatch([
    { side: 'input', key: 'IN_1', matrix: 'hub', port: 4 },
    { side: 'input', key: 'IN_1', matrix: 'hub', port: 5 },
  ]);
  assert.match(validate(twice, { matrices })[0].message, /patched twice/);
});

test('a port beyond the router is an error only once the router has said so', () => {
  const matrices = [{ id: 'hub', name: 'Hub' }];
  const patch = normalisePatch([{ side: 'input', key: 'IN_1', matrix: 'hub', port: 40 }]);

  /* Offline: unconfirmed, not wrong. Crying wolf every time the network
     hiccups is how a warning gets ignored when it matters. */
  assert.equal(validate(patch, { matrices }).length, 0);
  /* Connected and 12x12: now it is provably wrong. */
  const problems = validate(patch, { matrices, state: { hub: { inputs: 12, outputs: 12 } } });
  assert.match(problems[0].message, /has 12 outputs; this names 40/);
});

test('an unconfigured matrix is named in the error', () => {
  const patch = normalisePatch([{ side: 'input', key: 'IN_1', matrix: 'ghost', port: 1 }]);
  assert.match(validate(patch, { matrices: [] })[0].message, /No matrix called “ghost”/);
});

test('normalise drops the unusable and keeps duplicates for validate to report', () => {
  const patch = normalisePatch([
    { side: 'sideways', key: 'IN_1', matrix: 'hub', port: 1 },   // no such side
    { side: 'input', key: '', matrix: 'hub', port: 1 },           // no connector
    { side: 'input', key: 'IN_1', matrix: '', port: 1 },          // no matrix
    { side: 'input', key: 'IN_1', matrix: 'hub', port: 0 },       // ports count from 1
    { side: 'input', key: 'IN_1', matrix: 'hub', port: 2 },       // keeper
    { side: 'input', key: 'IN_1', matrix: 'hub', port: 3 },       // conflicting keeper
  ]);
  assert.equal(patch.length, 2);
  assert.equal(validate(patch, { matrices: [{ id: 'hub', name: 'Hub' }] }).length, 1);
});

test('matrices normalise to a usable list, and slugs survive a round trip', () => {
  const list = normaliseMatrices([
    { id: 'Machine Room', kind: 'videohub', host: '10.0.0.5' },
    { id: 'lw', kind: 'lightware', host: '10.0.0.6' },
    { id: 'tv', kind: 'turtle', host: '10.0.0.7' },
    { id: 'dup', kind: 'videohub', host: '10.0.0.8' },
    { id: 'dup', kind: 'videohub', host: '10.0.0.9' },   // second one dropped
    { id: 'nohost', kind: 'videohub' },                   // nothing to fall back to
    { id: 'odd', kind: 'not-a-driver', host: '10.0.0.10' },
  ]);
  assert.deepEqual(list.map((m) => m.id), ['machine-room', 'lw', 'tv', 'dup', 'odd']);
  /* Each kind's own default port, and an unknown kind falls back rather than
     taking the list down. */
  assert.deepEqual(list.map((m) => m.port), [9990, 6107, 8000, 9990, 9990]);
  assert.equal(list.find((m) => m.id === 'odd').kind, 'videohub');
});

test('currentFor reads an input\'s source and an output\'s destinations', () => {
  const patch = normalisePatch([
    { side: 'input', key: 'IN_5', matrix: 'hub', port: 2 },
    { side: 'output', key: '2', matrix: 'hub', port: 7 },
  ]);
  const routing = { hub: { 1: 7, 2: 4, 3: 7, 4: 1 } };

  /* The input hangs off hub output 2, which is showing hub input 4. */
  assert.deepEqual(currentFor(patch, 'input:IN_5', routing),
    { entry: entryForConnector(patch, 'input:IN_5'), known: true, source: 4 });

  /* The output arrives at hub input 7, which is on hub outputs 1 and 3. */
  assert.deepEqual(currentFor(patch, 'output:2', routing).destinations, [1, 3]);

  /* A router that has said nothing yet is "not known", never "nothing". */
  assert.equal(currentFor(patch, 'input:IN_5', {}).known, false);
});

test('crosspoints group per matrix, last write wins within one action', () => {
  const grouped = groupCrosspoints([
    { matrix: 'a', output: 1, input: 2 },
    { matrix: 'b', output: 1, input: 3 },
    { matrix: 'a', output: 2, input: 2 },
    /* A contradiction inside one action: sending both would make the result
       depend on arrival order. */
    { matrix: 'a', output: 1, input: 9 },
  ]);
  assert.deepEqual(grouped, [
    { matrix: 'a', routes: [{ output: 1, input: 9 }, { output: 2, input: 2 }] },
    { matrix: 'b', routes: [{ output: 1, input: 3 }] },
  ]);
});

/* ------------------------------------------------------------------ */
/* The OSC address space                                              */
/* ------------------------------------------------------------------ */

const OSC_PATCH = normalisePatch([
  { side: 'input', key: 'IN_5', matrix: 'hub', port: 2 },
  { side: 'output', key: '2', matrix: 'hub', port: 7 },
]);

test('osc: an address that is not ours returns null, not an error', () => {
  /* This is what lets `/lp/screen/1/take` fall through to mynah untouched.
     Returning an error here would break every switcher address. */
  assert.equal(resolveMatrixOsc('/lp/screen/1/take', [1], OSC_PATCH), null);
  assert.equal(resolveMatrixOsc('/something/else', [], OSC_PATCH), null);
});

test('osc: feeding an input names the connector number, not the store key', () => {
  /* `/input/5` is the socket the device calls `IN_5` — a sender never has to
     know the prefix exists. */
  const r = resolveMatrixOsc('/lp/matrix/input/5/source', [7], OSC_PATCH);
  assert.equal(r.ok, true);
  assert.deepEqual(r.crosspoints, [{ matrix: 'hub', output: 2, input: 7 }]);
});

test('osc: sending an output takes a range in one string or several ints', () => {
  const asRange = resolveMatrixOsc('/lp/matrix/output/2/destinations', ['1-4'], OSC_PATCH);
  const asInts = resolveMatrixOsc('/lp/matrix/output/2/destinations', [1, 2, 3, 4], OSC_PATCH);
  /* Senders differ and both are obviously what was meant. */
  assert.deepEqual(asRange.crosspoints, asInts.crosspoints);
  assert.deepEqual(asRange.crosspoints.map((c) => c.output), [1, 2, 3, 4]);
  assert.equal(asRange.crosspoints[0].input, 7);
});

test('osc: an unpatched connector is refused by name', () => {
  const r = resolveMatrixOsc('/lp/matrix/input/9/source', [1], OSC_PATCH);
  assert.equal(r.ok, false);
  assert.match(r.error, /switcher input 9 is not patched/);
});

test('osc: the raw form needs no patch at all', () => {
  const r = resolveMatrixOsc('/lp/matrix/hub/route/3', [9], []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.crosspoints, [{ matrix: 'hub', output: 3, input: 9 }]);
  /* And it refuses a non-port rather than routing port 0. */
  assert.equal(resolveMatrixOsc('/lp/matrix/hub/route/3', ['x'], []).ok, false);
});

test('osc: an address under our prefix that means nothing is an error', () => {
  /* Distinct from `null`: this one IS ours, it is just wrong, and saying so
     is more use than letting mynah reject it in its own vocabulary. */
  const r = resolveMatrixOsc('/lp/matrix/input/5/nonsense', [1], OSC_PATCH);
  assert.equal(r.ok, false);
  assert.match(r.error, /no such matrix address/);
});

test('port lists parse the way people write them', () => {
  assert.deepEqual(toPortList('1-4'), [1, 2, 3, 4]);
  assert.deepEqual(toPortList('1,2,5-8'), [1, 2, 5, 6, 7, 8]);
  assert.deepEqual(toPortList([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(toPortList(4), [4]);
  /* A descending range is a typo, not a request to count backwards. */
  assert.deepEqual(toPortList('4-1'), []);
  /* Unparseable is dropped, never coerced to 0 — port 0 is refused elsewhere
     and would surface as an error about a port nobody typed. */
  assert.deepEqual(toPortList('one, 2'), [2]);
  assert.deepEqual(toPortList(null), []);
});

/* ------------------------------------------------------------------ */
/* Videohub                                                           */
/* ------------------------------------------------------------------ */

const VIDEOHUB_HELLO = [
  'PROTOCOL PREAMBLE:', 'Version: 2.3', '',
  'VIDEOHUB DEVICE:', 'Device present: true', 'Model name: Smart Videohub 12x12',
  'Friendly name: Machine room', 'Video inputs: 12', 'Video outputs: 12', '',
  'INPUT LABELS:', '0 Camera 1', '1 Camera 2', '',
  'VIDEO OUTPUT ROUTING:', '0 3', '1 0', '',
].join('\n') + '\n';

test('videohub: a dump is parsed, and zero-based becomes one-based', () => {
  const driver = offline(VideohubDriver);
  driver.onData(VIDEOHUB_HELLO);

  const state = driver.state;
  assert.equal(state.model, 'Smart Videohub 12x12');
  assert.equal(state.name, 'Machine room');
  assert.equal(state.inputs, 12);
  assert.equal(state.outputs, 12);

  /* THE conversion. On the wire `0 3` means output 0 takes input 3; in this
     app that is output 1 taking input 4. An off-by-one here routes a real
     crosspoint next to the one asked for. */
  assert.equal(state.routing[1], 4);
  assert.equal(state.routing[2], 1);
  assert.equal(state.routing[0], undefined);

  /* Labels shift the same way: wire index 0 is input 1. */
  assert.equal(state.inputLabels[1], 'Camera 1');
  assert.equal(state.inputLabels[2], 'Camera 2');
});

test('videohub: a route is sent zero-based', () => {
  const driver = offline(VideohubDriver);
  driver.onData(VIDEOHUB_HELLO);
  driver.route(1, 4);
  assert.equal(driver.sent.at(-1), 'VIDEO OUTPUT ROUTING:\n0 3\n\n');
});

test('videohub: state is never written from our own request', () => {
  const driver = offline(VideohubDriver);
  driver.onData(VIDEOHUB_HELLO);
  driver.route(5, 9);
  /* The grid must not move until the router says it moved. */
  assert.equal(driver.state.routing[5], undefined);
  driver.onData('VIDEO OUTPUT ROUTING:\n4 8\n\n');
  assert.equal(driver.state.routing[5], 9);
});

test('videohub: a router that is not present reports rather than shows a stub', () => {
  const driver = offline(VideohubDriver);
  driver.onData('VIDEOHUB DEVICE:\nDevice present: needs_update\n\n');
  assert.equal(driver.state, null);
  assert.match(driver.lastError, /needs_update/);
});

test('videohub: blocks split across packets, and unknown blocks are skipped', () => {
  const driver = offline(VideohubDriver);
  /* TCP does not respect block boundaries. */
  driver.onData(VIDEOHUB_HELLO.slice(0, 90));
  driver.onData(VIDEOHUB_HELLO.slice(90));
  assert.equal(driver.state.routing[1], 4);

  /* A block a later firmware adds must not derail the parser. */
  driver.onData('SOMETHING NEW:\nwhatever: 1\n\nVIDEO OUTPUT ROUTING:\n2 5\n\n');
  assert.equal(driver.state.routing[3], 6);
});

/* ------------------------------------------------------------------ */
/* Lightware                                                          */
/* ------------------------------------------------------------------ */

test('lightware: LW3 is detected and its connection list is positional', () => {
  const driver = offline(LightwareDriver);
  driver.onData('pr /.ProductName=MX2-16x16-HDMI20\r\n');
  assert.equal(driver.dialect, 'lw3');

  driver.onData('pr /MEDIA/VIDEO/XP.DestinationPortCount=4\r\n');
  driver.onData('pr /MEDIA/VIDEO/XP.DestinationConnectionList=I1;I1;I5;I2\r\n');

  /* Position is the destination, value the source. Both 1-based, so unlike
     the Videohub there is nothing to convert. */
  assert.deepEqual(driver.state.routing, { 1: 1, 2: 1, 3: 5, 4: 2 });
  assert.equal(driver.state.model, 'MX2-16x16-HDMI20');
});

test('lightware: LW3 routes with a switch call', () => {
  const driver = offline(LightwareDriver, { protocol: 'lw3' });
  driver.route(2, 3);
  assert.equal(driver.sent.at(-1), 'CALL /MEDIA/VIDEO/XP:switch(I3:O2)\n');
});

test('lightware: a refused LW3 switch does not move the grid', () => {
  const driver = offline(LightwareDriver, { protocol: 'lw3' });
  driver.onData('pr /MEDIA/VIDEO/XP.DestinationConnectionList=I1;I1\r\n');
  driver.route(2, 8);
  driver.onData('mF /MEDIA/VIDEO/XP:switch %E004\r\n');
  assert.equal(driver.state.routing[2], 1);
});

test('lightware: LW2 is detected from a parenthesised answer', () => {
  const driver = offline(LightwareDriver);
  driver.onData('(I: MX-FR17R)\r\n');
  assert.equal(driver.dialect, 'lw2');
  assert.equal(driver.state?.model ?? driver.current.model, 'MX-FR17R');

  driver.onData('(ALL I01 I01 I05 I02)\r\n');
  assert.deepEqual(driver.current.routing, { 1: 1, 2: 1, 3: 5, 4: 2 });

  driver.onData('(O03 I07)\r\n');
  assert.equal(driver.current.routing[3], 7);
});

test('lightware: LW2 routes with braces', () => {
  const driver = offline(LightwareDriver, { protocol: 'lw2' });
  driver.route(3, 1);
  assert.equal(driver.sent.at(-1), '{1@3}\r\n');
});

test('lightware: an unidentified frame is not guessed at', () => {
  const driver = offline(LightwareDriver);
  /* Sending LW2 braces at an LW3 frame, or the reverse, is how you find out
     what a parser does with garbage on a show day. */
  assert.equal(driver.route(1, 1), false);
  assert.equal(driver.sent.length, 0);
});

/* ------------------------------------------------------------------ */
/* Turtle AV                                                          */
/* ------------------------------------------------------------------ */

test('turtle: the routing reply is parsed and sized', () => {
  const driver = offline(TurtleDriver);
  driver.onData('HDP-MXB88VW\r\n');
  driver.onData([
    'output 1->input 1', 'output 2->input 2', 'output 3->input 7', 'output 4->input 7',
  ].join('\r\n') + '\r\n');

  assert.equal(driver.state.model, 'HDP-MXB88VW');
  /* The model name is the only source for the input count — an input nothing
     is routed to never appears in the routing reply. */
  assert.equal(driver.state.inputs, 8);
  assert.equal(driver.state.outputs, 8);
  assert.deepEqual(driver.state.routing, { 1: 1, 2: 2, 3: 7, 4: 7 });
});

test('turtle: a route is a bang-terminated command', () => {
  const driver = offline(TurtleDriver);
  driver.route(2, 5);
  assert.equal(driver.sent.at(-1), 's output 2 in source 5!\n');
});

test('turtle: output 0 is refused, because it would route every output', () => {
  const driver = offline(TurtleDriver);
  assert.equal(driver.route(0, 1), false);
  assert.equal(driver.sent.length, 0);
});

test('turtle: an error code is reported in words', () => {
  const driver = offline(TurtleDriver);
  driver.onData('E01\r\n');
  assert.match(driver.lastError, /parameter out of range/);
});

test('turtle: the device\'s chatter is ignored', () => {
  const driver = offline(TurtleDriver);
  driver.onData('output 1->input 1\r\n');
  driver.onData(['power on', 'system initializing...', 'cpld fw: 1.00.03',
    'initialization finished!'].join('\r\n') + '\r\n');
  assert.deepEqual(driver.current.routing, { 1: 1 });
});

test('turtle: the model size hint splits evenly or not at all', () => {
  assert.deepEqual(sizeFromModel('HDP-MXB88VW'), { inputs: 8, outputs: 8 });
  assert.deepEqual(sizeFromModel('HDP-MXB1616VW'), { inputs: 16, outputs: 16 });
  /* `168` is 16x8 or 1x68 and the manual does not say. A hint that is
     sometimes absent is fine; one that is sometimes wrong is not. */
  assert.equal(sizeFromModel('HDP-MXB168VW'), null);
  assert.equal(sizeFromModel('something else'), null);
});

/* ------------------------------------------------------------------ */
/* The supervisor                                                     */
/* ------------------------------------------------------------------ */

/* The supervisor's own seam, so `apply`'s bookkeeping can be exercised
   without opening sockets to addresses that do not exist. */
class OfflineSupervisor extends MatrixSupervisor {
  createDriver(config) {
    const driver = super.createDriver(config);
    if (!driver) return null;
    driver.connect = () => { driver.opened = true; };
    driver.close = () => { driver.closed = true; };
    return driver;
  }
}

test('supervisor: a rename keeps the socket, a re-address replaces it', () => {
  const supervisor = new OfflineSupervisor();

  supervisor.apply(normaliseMatrices([{ id: 'hub', kind: 'videohub', host: '10.0.0.5' }]));
  const first = supervisor.get('hub');

  supervisor.apply(normaliseMatrices([
    { id: 'hub', kind: 'videohub', host: '10.0.0.5', name: 'Machine room' },
  ]));
  assert.equal(supervisor.get('hub'), first, 'a rename must not drop a live grid');
  assert.equal(supervisor.get('hub').name, 'Machine room');

  supervisor.apply(normaliseMatrices([{ id: 'hub', kind: 'videohub', host: '10.0.0.6' }]));
  assert.notEqual(supervisor.get('hub'), first, 'a new address is a new socket');

  supervisor.apply([]);
  assert.equal(supervisor.get('hub'), null);
});

test('supervisor: routing into a matrix that is not there fails with a reason', () => {
  const supervisor = new MatrixSupervisor();
  const results = supervisor.route([{ matrix: 'ghost', routes: [{ output: 1, input: 1 }] }]);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /no such matrix/);
});

/* ------------------------------------------- per-socket surfaces (router-box) */

test('a page names its socket from the URL, or from the Preconfig heading', () => {
  assert.equal(connectorForPage('/inputs/IN_5/signal'), 'input:IN_5');
  assert.equal(connectorForPage('/outputs/5/format'), 'output:5');
  /* The two sides are keyed differently — see core/connectors.js. */
  assert.equal(connectorForPage('/inputs/5/signal'), null);
  assert.equal(connectorForPage('/outputs/OUT_5/format'), null);
  assert.equal(connectorForPage('/preconfig/inputs', 'In13'), 'input:IN_13');
  assert.equal(connectorForPage('/preconfig/resources/outputs', 'Out2'), 'output:2');
  /* The card list's own heading, and a page with nothing selected, are not a socket. */
  assert.equal(connectorForPage('/preconfig/inputs', 'Inputs'), null);
  assert.equal(connectorForPage('/preconfig/inputs', ''), null);
  /* A heading only counts on its own page: "Out2" on the inputs page is not an input. */
  assert.equal(connectorForPage('/preconfig/inputs', 'Out2'), null);
  assert.equal(connectorForPage('/screens'), null);
});

test('choices: an input chooses among router inputs, and exactly one is live', () => {
  const [entry] = normalisePatch([{ side: 'input', key: 'IN_1', matrix: 'hub', port: 3 }]);
  const state = { inputs: 4, outputs: 4, inputLabels: { 2: 'Cam 2' } };
  const { side, ports } = choicesFor(entry, state, { 1: 1, 2: 2, 3: 2, 4: 4 });
  assert.equal(side, 'input');
  assert.deepEqual(ports.map((p) => p.port), [1, 2, 3, 4]);
  assert.deepEqual(ports.filter((p) => p.live).map((p) => p.port), [2],
    'router output 3 carries input 2, so input 2 is what this socket sees');
  assert.equal(ports[1].label, 'Cam 2');
});

test('choices: an output chooses among router outputs, any number live, each with what it shows', () => {
  const [entry] = normalisePatch([{ side: 'output', key: '1', matrix: 'hub', port: 5 }]);
  const { side, ports } = choicesFor(entry, { inputs: 8, outputs: 3 }, { 1: 5, 2: 7, 3: 5 });
  assert.equal(side, 'output');
  assert.deepEqual(ports.filter((p) => p.live).map((p) => p.port), [1, 3]);
  assert.equal(ports[1].source, 7, 'what a destination shows now, so a send says what it displaces');
});

test('choices: no ports until the router has said how big it is', () => {
  const [entry] = normalisePatch([{ side: 'input', key: 'IN_1', matrix: 'hub', port: 1 }]);
  assert.deepEqual(choicesFor(entry, null, {}).ports, []);
});

test('withEntry: replaces one socket\'s cable and leaves every other entry alone', () => {
  const patch = normalisePatch([
    { side: 'input', key: 'IN_1', matrix: 'hub', port: 1 },
    { side: 'output', key: '1', matrix: 'hub', port: 5 },
  ]);
  const moved = withEntry(patch, 'input:IN_1', { matrix: 'hub', port: 4 });
  assert.equal(entryForConnector(moved, 'input:IN_1').port, 4);
  assert.equal(entryForConnector(moved, 'input:IN_1').routerSide, 'output');
  assert.deepEqual(entryForConnector(moved, 'output:1'), patch[1]);

  const added = withEntry(patch, 'output:2', { matrix: 'hub', port: 6 });
  assert.equal(added.length, 3);
  assert.equal(entryForConnector(added, 'output:2').routerSide, 'input');

  const removed = withEntry(patch, 'input:IN_1', { matrix: null });
  assert.equal(entryForConnector(removed, 'input:IN_1'), null);
  assert.equal(removed.length, 1);

  assert.equal(withEntry(patch, 'nonsense', { matrix: 'hub', port: 1 }), patch);
});

/* ------------------------------------------------------------------ */
/* Placeholder routers                                                */
/* ------------------------------------------------------------------ */

test('placeholder: normalised with no address, dropped with no size', () => {
  const list = normaliseMatrices([
    { id: 'stage', kind: 'placeholder', inputs: 40, outputs: 40, model: 'bmd-videohub-40x40-12g',
      modelLabel: 'Videohub 40×40 12G', plan: { 1: 3, 2: '4', 0: 1, 41: 1, x: 2 } },
    { id: 'nosize', kind: 'placeholder' },
    { id: 'hub', kind: 'videohub', host: '10.0.0.5', plan: { 5: 6 } },
  ]);
  assert.deepEqual(list.map((m) => m.id), ['stage', 'hub']);
  assert.equal(list[0].host, '');
  assert.equal(list[0].port, 0);
  assert.deepEqual(list[0].plan, { 1: 3, 2: 4, 41: 1 }, 'bad pairs go one at a time');
  assert.deepEqual(list[1].plan, { 5: 6 }, 'a live router keeps the plan it was built on');
});

test('placeholder: factory routing is N from N, and a plan overrides it', () => {
  const fresh = new PlaceholderDriver({ id: 'p', inputs: 4, outputs: 6 });
  fresh.connect();
  assert.equal(fresh.status, 'connected');
  assert.deepEqual(fresh.state.routing, { 1: 1, 2: 2, 3: 3, 4: 4, 5: 4, 6: 4 });

  const planned = new PlaceholderDriver({ id: 'p', inputs: 4, outputs: 2, plan: { 1: 3, 2: 9 } });
  planned.connect();
  assert.deepEqual(planned.state.routing, { 1: 3, 2: 2 }, 'a plan port past the size is ignored');
});

test('placeholder: a route moves the grid at once, and out of range is refused', () => {
  const driver = new PlaceholderDriver({ id: 'p', inputs: 8, outputs: 8 });
  driver.connect();
  let changes = 0;
  driver.on('change', () => changes++);
  assert.equal(driver.route(3, 7), true);
  assert.equal(driver.state.routing[3], 7);
  assert.equal(changes, 1);
  assert.equal(driver.route(3, 7), true, 'a no-op route is still accepted');
  assert.equal(changes, 2, 'and announced, because it is now part of the plan');
  assert.deepEqual(driver.planned, { 3: 7 }, 'the plan is what was taken, not the factory table');
  assert.equal(driver.route(9, 1), false);
  assert.equal(driver.route(1, 9), false);
  assert.equal(driver.route(0, 1), false);
});

test('placeholder: the supervisor routes to it through the patch, with no socket', () => {
  const supervisor = new MatrixSupervisor();
  supervisor.apply(normaliseMatrices([{ id: 'stage', kind: 'placeholder', inputs: 12, outputs: 12 }]));
  const patch = normalisePatch([{ side: 'input', key: 'IN_5', matrix: 'stage', port: 3 }]);
  const resolved = feed(patch, 'input:IN_5', 9);
  assert.equal(resolved.ok, true);
  const results = supervisor.route(groupCrosspoints(resolved.crosspoints));
  assert.equal(results[0].ok, true);
  assert.equal(supervisor.routing().stage[3], 9);
  assert.equal(currentFor(patch, 'input:IN_5', supervisor.routing()).source, 9);
  assert.deepEqual(supervisor.sizes().stage, { inputs: 12, outputs: 12 });
  supervisor.stop();
});

test('placeholder: resizing rebuilds it, renaming does not', () => {
  const supervisor = new MatrixSupervisor();
  const base = { id: 'stage', kind: 'placeholder', inputs: 12, outputs: 12 };
  supervisor.apply(normaliseMatrices([base]));
  const first = supervisor.get('stage');
  supervisor.apply(normaliseMatrices([{ ...base, name: 'Stage', plan: { 1: 2 } }]));
  assert.equal(supervisor.get('stage'), first);
  supervisor.apply(normaliseMatrices([{ ...base, inputs: 20, outputs: 20 }]));
  assert.notEqual(supervisor.get('stage'), first);
  supervisor.stop();
});

test('plan: only what differs is sent, and what does not fit is named', () => {
  const state = { inputs: 20, outputs: 20, routing: { 1: 1, 2: 5, 3: 3 } };
  const { crosspoints, outOfRange, already } =
    planCrosspoints('hub', { 1: 1, 2: 6, 3: 3, 30: 1, 4: 25 }, state);
  assert.deepEqual(crosspoints, [{ matrix: 'hub', output: 2, input: 6 }]);
  assert.deepEqual(outOfRange, [{ output: 4, input: 25 }, { output: 30, input: 1 }]);
  assert.equal(already, 2);
  assert.equal(normalisePlan({}), null);
});

test('library: every model is a live kind with a sane size and a unique id', () => {
  const ids = new Set();
  for (const m of LIBRARY) {
    assert.ok(['videohub', 'lightware', 'turtle'].includes(m.kind), m.id);
    assert.ok(m.inputs >= 1 && m.outputs >= 1, m.id);
    assert.ok(!ids.has(m.id), `duplicate ${m.id}`);
    ids.add(m.id);
  }
  const made = placeholderConfig({ name: 'Stage', model: 'bmd-videohub-40x40-12g' });
  assert.equal(made.inputs, 40);
  assert.equal(made.modelLabel, libraryModel('bmd-videohub-40x40-12g').label);
  assert.equal(normaliseMatrices([made])[0].kind, 'placeholder');
  assert.equal(placeholderConfig({ name: 'X', model: 'custom', inputs: '', outputs: '4' }).constructor, String);
  assert.equal(placeholderConfig({ name: 'X', model: 'custom', inputs: '6', outputs: '4' }).outputs, 4);
});

/* The plugin's server half against a fake context: no HTTP, no disk. */
async function matrixServer(initial) {
  const saved = { matrices: initial };
  const routes = new Map();
  const disposers = [];
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const ctx = {
    log: () => {},
    stream: () => ({ send: () => {} }),
    onDispose: (fn) => disposers.push(fn),
    device: () => 'sim',
    HttpError,
    contribute: () => {},
    route: (method, path, fn) => routes.set(`${method} ${path}`, fn),
    storage: {
      load: async (name) => saved[name] ?? null,
      save: async (name, value) => { saved[name] = JSON.parse(JSON.stringify(value)); },
    },
  };
  await activateMatrix(ctx);
  const call = async (method, path, body) => {
    let reply;
    try {
      await routes.get(`${method} ${path}`)({}, {}, {
        readJson: async () => body ?? {},
        json: (status, payload) => { reply = { status, ...payload }; },
      });
    } catch (err) {
      reply = { status: err.status ?? 500, error: err.message };
    }
    return reply;
  };
  return { call, saved, dispose: () => disposers.forEach((fn) => fn()) };
}

test('server: a placeholder\'s routes become its plan, and survive a save without them', async () => {
  const server = await matrixServer({ matrices: [
    { id: 'stage', kind: 'placeholder', inputs: 8, outputs: 8, model: 'lw-mx2-8x8', modelLabel: 'MX2-8x8-HDMI20' },
  ] });
  assert.equal((await server.call('POST', '/route', { matrix: 'stage', output: 2, input: 7 })).ok, true);

  /* The panel's save names the router by what describe() gave it: no size,
     no plan. Both must survive, and the plan must be the click just made. */
  const put = await server.call('PUT', '/', { matrices: [{ id: 'stage', name: 'Stage', kind: 'placeholder', host: '', port: 0 }] });
  const stage = put.matrices.find((m) => m.id === 'stage');
  assert.equal(stage.status, 'connected');
  assert.equal(stage.placeholder, true);
  assert.equal(stage.planning.inputs, 8);
  assert.equal(stage.planning.plan[2], 7);
  assert.equal(server.saved.matrices.matrices[0].plan[2], 7, 'written to disk');
  server.dispose();
});

test('server: going live keeps the id and the plan; push refuses until it answers', async () => {
  const server = await matrixServer({ matrices: [
    { id: 'stage', kind: 'placeholder', inputs: 8, outputs: 8, plan: { 1: 4 } },
  ] });
  const put = await server.call('PUT', '/', { matrices: [
    { id: 'stage', name: 'stage', kind: 'videohub', host: '127.0.0.1', port: 1 },
  ] });
  const stage = put.matrices.find((m) => m.id === 'stage');
  assert.equal(stage.kind, 'videohub');
  assert.equal(stage.placeholder, undefined);
  assert.deepEqual(stage.planning.plan, { 1: 4 });

  const push = await server.call('POST', '/plan/push', { matrix: 'stage' });
  assert.equal(push.status, 409);
  assert.match(push.error, /not answered/);

  const discard = await server.call('POST', '/plan/discard', { matrix: 'stage' });
  assert.equal(discard.ok, true);
  assert.equal(discard.matrices[0].planning.plan, undefined);
  assert.equal(server.saved.matrices.matrices[0].plan, undefined);
  server.dispose();
});
