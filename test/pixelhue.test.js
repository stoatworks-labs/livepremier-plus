/*
 * The Pixelhue panel: the model published, the intents answered, and the
 * WebSocket client that carries them.
 *
 * The command fixtures are **real** — captured from a live UCenter on
 * 2026-09-22 after publishing a LivePremier-shaped model to it, with the keys
 * pressed by injection because there was no panel. That is what makes the
 * intent tests worth anything: they are asserting against what a console
 * actually said, not against what this repo hoped it would say.
 *
 * The WebSocket client is tested against a real socket for the same reason
 * `test/proxy.test.js` uses one: every bug worth catching in a framing codec
 * lives in the plumbing, and a mocked socket would simply agree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  businessModel, readIntent, writesFor, Selection, commandName,
  COMMAND, CONSOLE_MODELS,
} from '../plugins/pixelhue/core.js';
import { NLC } from '../src/core/dialect.js';
import { commandsFor } from '../src/core/commands.js';
import { toAwj } from '../src/core/paths.js';
import { WsClient } from '../plugins/pixelhue/ws-client.js';
import { normalisePixelhue as normalise, pixelhueChanged } from '../plugins/pixelhue/core.js';
import { normalise as normaliseSettings } from '../src/core/settings.js';
import { settings as schema } from '../plugins/pixelhue/server.js';

const reports = JSON.parse(readFileSync(new URL('./fixtures/pixelhue-u5pro-reports.json', import.meta.url)));
const byCommand = (code) => reports.commands.find((c) => c.command === code);

const FACTS = {
  deviceId: '192.168.2.142',
  destinations: [
    { id: 'S1', kind: 'screen', label: 'Main', isUsed: true },
    { id: 'S2', kind: 'screen', label: '', isUsed: true },
    { id: 'S3', kind: 'screen', label: 'Not fitted', isUsed: false },
    { id: 'A1', kind: 'aux', label: 'Stage', isUsed: true },
  ],
  inputs: [
    { number: 1, source: 'LIVE_1', label: 'Camera 1' },
    { number: 5, source: 'LIVE_5', label: '' },
  ],
  presets: [{ slot: 1, label: 'Opening' }, { slot: 7, label: 'Awards' }],
};

/* ---------------------------------------------------------------- the model */

test('the model publishes only destinations in service', () => {
  const model = businessModel(FACTS);
  assert.deepEqual(model.screens.map((s) => s.uid), ['S1', 'S2', 'A1']);
});

test('index is 1-based — publishing from zero loses the first key of every bus', () => {
  const model = businessModel(FACTS);
  assert.deepEqual(model.screens.map((s) => s.index), [[1], [2], [3]]);
  assert.deepEqual(model.inputs.map((i) => i.index), [[1], [2]]);
  assert.deepEqual(model.presets.map((p) => p.index), [[1], [2]]);
});

test('an input keeps its own number, not its position on the bus', () => {
  /* LIVE_5 sits at bus position 2. `id` is what comes back on an intent, so
     getting this wrong routes the wrong source and looks plausible doing it. */
  const model = businessModel(FACTS);
  const five = model.inputs[1];
  assert.equal(five.index[0], 2);
  assert.equal(five.id, 5);
  assert.equal(five.sortNum, 5);
});

test('an unlabelled object falls back to something an operator can read', () => {
  const model = businessModel(FACTS);
  assert.equal(model.screens[1].name, 'S2');
  assert.equal(model.inputs[1].name, 'LIVE_5');
});

test('an aux is published as one', () => {
  const model = businessModel(FACTS);
  assert.equal(model.screens.find((s) => s.uid === 'A1').type, 4);
  assert.equal(model.screens.find((s) => s.uid === 'S1').type, 2);
});

test('the selection is published so the panel can light it', () => {
  const model = businessModel({ ...FACTS, selection: { destination: 'S2' } });
  assert.equal(model.screens.find((s) => s.uid === 'S2').selected, 1);
  assert.equal(model.screens.find((s) => s.uid === 'S1').selected, 0);
});

test('every object carries the device id back', () => {
  const model = businessModel(FACTS);
  assert.equal(model.screens[0].originId, '192.168.2.142');
  assert.equal(model.inputs[0].deviceSn, '192.168.2.142');
  assert.equal(model.newProtocol, 1);
});

/* -------------------------------------------------------------- the intents */

test('a real screenSelect report names the destination this app published', () => {
  const intent = readIntent(byCommand(COMMAND.screenSelect));
  assert.deepEqual(intent, { kind: 'select', destination: 'S2', at: 2 });
});

test('a real inputSwitch report carries the input number', () => {
  const intent = readIntent(byCommand(COMMAND.inputSwitch));
  assert.equal(intent.kind, 'source');
  assert.equal(intent.input, 2);
  assert.equal(intent.label, 'LIVE_2');
});

test('a real playPreset report carries the memory slot', () => {
  const intent = readIntent(byCommand(COMMAND.playPreset));
  assert.deepEqual(intent, { kind: 'recall', slot: 2, at: 2 });
});

test('a real take report is a take', () => {
  assert.deepEqual(readIntent(byCommand(COMMAND.take)), { kind: 'take' });
});

test('the deviceUnselect a console sends on connect is ignored, not mishandled', () => {
  assert.equal(readIntent(byCommand(0)), null);
});

test('commands outside the vocabulary are ignored rather than guessed at', () => {
  assert.equal(readIntent({ command: 569 }), null);   // playCue
  assert.equal(readIntent({ command: 556 }), null);   // ptzDown
  assert.equal(readIntent(null), null);
  assert.equal(commandName(569), 'command 569');
  assert.equal(commandName(531), 'take');
});

/* --------------------------------------------------------------- the writes */

const ctx = (over = {}) => ({
  dialect: NLC,
  commands: commandsFor(NLC),
  selected: ['S1'],
  layer: 1,
  buffer: 'PREVIEW',
  letterFor: () => 'A',
  ...over,
});

test('take and cut are the same triggers the cue stack fires', () => {
  const take = writesFor({ kind: 'take' }, ctx());
  assert.equal(take.writes.length, 1);
  assert.equal(toAwj(take.writes[0].path), 'DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake');
  assert.equal(take.writes[0].value, true);

  const cut = writesFor({ kind: 'cut' }, ctx());
  assert.equal(toAwj(cut.writes[0].path), 'DeviceObject/$screenAuxGroup/@items/S1/control/@props/xCut');
});

test('a take fans out to every selected destination', () => {
  const { writes } = writesFor({ kind: 'take' }, ctx({ selected: ['S1', 'S2', 'A1'] }));
  assert.equal(writes.length, 3);
  assert.ok(toAwj(writes[2].path).includes('@items/A1/'));
});

test('a recall always lands in preview, whatever the panel is editing', () => {
  const { writes } = writesFor({ kind: 'recall', slot: 12 }, ctx({ buffer: 'PROGRAM' }));
  assert.equal(writes.length, 1);
  assert.match(toAwj(writes[0].path), /@items\/PREVIEW\/@props\/xRequest$/);
  assert.match(toAwj(writes[0].path), /\$slot\/@items\/12\//);
});

test('a source change goes to the resolved letter, not to PREVIEW', () => {
  const { writes } = writesFor({ kind: 'source', input: 3 }, ctx({ letterFor: () => 'B' }));
  assert.equal(writes.length, 1);
  assert.equal(
    toAwj(writes[0].path),
    'DeviceObject/$screen/@items/S1/$preset/@items/B/$layer/@items/1/source/@props/inputNum',
  );
  assert.equal(writes[0].value, 'LIVE_3');
});

test('a source change is refused when the letter is not known', () => {
  /* The same refusal `server/osc.js` makes. A layer move landing in whichever
     buffer happened to be live is the failure this is defending against. */
  const { writes, note } = writesFor({ kind: 'source', input: 3 }, ctx({ letterFor: () => null }));
  assert.equal(writes.length, 0);
  assert.match(note, /refused/);
});

test('nothing is sent when the panel has no destination selected', () => {
  for (const kind of ['take', 'cut', 'recall', 'source']) {
    const { writes, note } = writesFor({ kind, slot: 1, input: 1 }, ctx({ selected: [] }));
    assert.equal(writes.length, 0, kind);
    assert.match(note, /no destination selected/);
  }
});

test('freeze and FTB are understood and deliberately not sent', () => {
  for (const kind of ['ftb', 'freeze']) {
    const { writes, note } = writesFor({ kind }, ctx());
    assert.equal(writes.length, 0);
    assert.match(note, /not mapped/);
  }
});

test('no platform yet means no writes at all', () => {
  const { writes } = writesFor({ kind: 'take' }, { dialect: null, commands: null });
  assert.equal(writes.length, 0);
});

/* ------------------------------------------------------------- the selection */

test('the panel selection is kept here, because the switcher does not keep it', () => {
  const sel = new Selection();
  sel.apply(readIntent(byCommand(COMMAND.screenSelect)));
  assert.deepEqual(sel.list, ['S2']);
  sel.apply({ kind: 'select', destination: 'S1' });
  assert.deepEqual(sel.list, ['S2', 'S1']);
  sel.apply({ kind: 'unselect', destination: 'S2' });
  assert.deepEqual(sel.list, ['S1']);
  sel.apply({ kind: 'selectLayer', layer: 4 });
  assert.equal(sel.layer, 4);
});

test('PGM EDIT moves which buffer a source change edits, and nothing else', () => {
  const sel = new Selection();
  assert.equal(sel.buffer, 'PREVIEW');
  sel.apply({ kind: 'pgmEdit' });
  assert.equal(sel.buffer, 'PROGRAM');
  sel.apply({ kind: 'pgmEdit' });
  assert.equal(sel.buffer, 'PREVIEW');
});

/* --------------------------------------------------------------- settings */

test('the panel is off by default and its host is sanitised', () => {
  const fresh = normalise({});
  assert.equal(fresh.pixelhueEnabled, false);
  assert.equal(fresh.pixelhueHost, '');
  assert.equal(fresh.pixelhueModel, 'u5mini');

  assert.equal(normalise({ pixelhueHost: '  10.0.0.9 ' }).pixelhueHost, '10.0.0.9');
  assert.equal(normalise({ pixelhueHost: 'http://10.0.0.9' }).pixelhueHost, '');
  assert.equal(normalise({ pixelhueModel: 'u3' }).pixelhueModel, 'u5mini');
});

test('the panel’s settings live in its own plugin entry, lifted from where they were', () => {
  /* The shape every settings file had up to 0.12. */
  const s = normaliseSettings({ pixelhueEnabled: true, pixelhueHost: '10.0.0.9' }, { pixelhue: schema });
  assert.deepEqual(s.plugins.pixelhue.settings, { pixelhueEnabled: true, pixelhueHost: '10.0.0.9', pixelhueModel: 'u5mini' });
  assert.equal('pixelhueHost' in s, false);
  /* Renaming nothing does not redial a console somebody is holding. */
  const same = normalise({ pixelhueEnabled: true, pixelhueHost: '10.0.0.9' });
  assert.equal(pixelhueChanged(same, { ...same }), false);
  assert.equal(pixelhueChanged(same, { ...same, pixelhueModel: 'u5' }), true);
});

test('the mini is the only model reachable over the LAN', () => {
  const mini = CONSOLE_MODELS.find((m) => m.id === 'u5mini');
  assert.equal(mini.overLan, true);
  assert.equal(mini.port, 8088);
  assert.equal(CONSOLE_MODELS.find((m) => m.id === 'u5pro').port, 19999);
});

/* ------------------------------------------------------- the WebSocket client */

const GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11D';

/** A WebSocket server in thirty lines, so the client is tested against a socket. */
function stubServer(onOpen) {
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    onOpen(socket);
  });
  return server;
}

/** Frame a server->client message: never masked, split at `pieces` fragments. */
function serverFrames(payload, { opcode = 0x2, pieces = 1 } = {}) {
  const size = Math.ceil(payload.length / pieces);
  const out = [];
  for (let i = 0; i < pieces; i++) {
    const chunk = payload.subarray(i * size, (i + 1) * size);
    const fin = i === pieces - 1 ? 0x80 : 0;
    const op = i === 0 ? opcode : 0x0;
    let head;
    if (chunk.length < 126) head = Buffer.from([fin | op, chunk.length]);
    else if (chunk.length < 65536) {
      head = Buffer.alloc(4); head[0] = fin | op; head[1] = 126;
      head.writeUInt16BE(chunk.length, 2);
    } else {
      head = Buffer.alloc(10); head[0] = fin | op; head[1] = 127;
      head.writeBigUInt64BE(BigInt(chunk.length), 2);
    }
    out.push(Buffer.concat([head, chunk]));
  }
  return Buffer.concat(out);
}

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

test('the client completes a handshake and reads a binary message', async () => {
  const body = Buffer.from('NOVA-ish payload');
  const server = stubServer((socket) => socket.write(serverFrames(body)));
  const port = await listen(server);
  try {
    const ws = new WsClient(`ws://127.0.0.1:${port}/unico/v1/ucenter/ws?client-type=5`).connect();
    const got = await new Promise((resolve, reject) => {
      ws.on('message', (buf, meta) => resolve({ buf, meta }));
      ws.on('error', reject);
    });
    assert.equal(got.meta.binary, true);
    assert.deepEqual(got.buf, body);
    ws.close();
  } finally { server.close(); }
});

test('a fragmented message is reassembled', async () => {
  /* The console's first frame after a connect is its whole key-state dump —
     15 KB on a U5 Pro — and whether that arrives whole is the server's choice. */
  const body = Buffer.alloc(40_000, 0x41);
  const server = stubServer((socket) => socket.write(serverFrames(body, { pieces: 5 })));
  const port = await listen(server);
  try {
    const ws = new WsClient(`ws://127.0.0.1:${port}/`).connect();
    const buf = await new Promise((resolve, reject) => {
      ws.on('message', resolve);
      ws.on('error', reject);
    });
    assert.equal(buf.length, 40_000);
    assert.ok(buf.equals(body));
    ws.close();
  } finally { server.close(); }
});

test('a client frame is masked, which is what a server refuses without', async () => {
  let seen = null;
  const server = stubServer((socket) => {
    socket.once('data', (chunk) => { seen = chunk; });
  });
  const port = await listen(server);
  try {
    const ws = new WsClient(`ws://127.0.0.1:${port}/`).connect();
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(Buffer.from([1, 2, 3, 4]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(seen, 'the server saw nothing');
    assert.equal(seen[0] & 0x0f, 0x2, 'binary opcode');
    assert.equal(seen[1] & 0x80, 0x80, 'the mask bit must be set');
    /* Unmask it back and check the payload survived the round trip. */
    const mask = seen.subarray(2, 6);
    const body = Buffer.from(seen.subarray(6));
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    assert.deepEqual([...body], [1, 2, 3, 4]);
    ws.close();
  } finally { server.close(); }
});

test('a ping is answered with a pong without troubling the caller', async () => {
  let reply = null;
  const server = stubServer((socket) => {
    socket.write(serverFrames(Buffer.from('hi'), { opcode: 0x9 }));
    socket.once('data', (chunk) => { reply = chunk; });
  });
  const port = await listen(server);
  try {
    const ws = new WsClient(`ws://127.0.0.1:${port}/`).connect();
    let messages = 0;
    ws.on('message', () => { messages++; });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(reply, 'no pong');
    assert.equal(reply[0] & 0x0f, 0xa, 'pong opcode');
    assert.equal(messages, 0, 'a control frame is not a message');
    ws.close();
  } finally { server.close(); }
});

test('a refused upgrade is reported rather than hung on', async () => {
  const server = http.createServer((req, res) => { res.statusCode = 403; res.end('no'); });
  const port = await listen(server);
  try {
    const ws = new WsClient(`ws://127.0.0.1:${port}/`).connect();
    const err = await new Promise((resolve) => ws.on('error', resolve));
    assert.match(err.message, /403/);
  } finally { server.close(); }
});

test('only ws:// is accepted, because that is all a console speaks', () => {
  assert.throws(() => new WsClient('wss://example.test/').connect(), /only ws:\/\//);
});
