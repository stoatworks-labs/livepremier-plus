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
  businessModel, readIntent, writesFor, tbarWrites, Selection, commandName,
  COMMAND, CONSOLE_MODELS, layerIdFor, layerKeyOf,
} from '../plugins/pixelhue/core.js';
import { NLC, MNG } from '../src/core/dialect.js';
import { commandsFor } from '../src/core/commands.js';
import { toAwj } from '../src/core/paths.js';
import { WsClient, acceptFor } from '../plugins/pixelhue/ws-client.js';
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

test('every selected screen is lit, so pressing one again can deselect it', () => {
  /* The console picks select (101) or unselect (103) from this flag. Lighting
     only the first selected screen made every other one impossible to drop. */
  const model = businessModel({ ...FACTS, selection: { destinations: ['S1', 'A1'] } });
  const lit = model.screens.filter((s) => s.selected === 1).map((s) => s.uid);
  assert.deepEqual(lit, ['S1', 'A1']);
});

test('screens carry the fields PixelFlow sends: screenId, enable and the key lamps', () => {
  const facts = {
    ...FACTS,
    destinations: FACTS.destinations.map((d) => (d.id === 'S2' ? { ...d, faded: true, frozen: true } : d)),
  };
  const model = businessModel({ ...facts, selection: { buffer: 'PROGRAM' } });
  const [s1, s2] = model.screens;
  assert.deepEqual([s1.screenId, s2.screenId], [1, 2]);
  assert.equal(s1.enable, 1);
  assert.equal(s1.isEmpty, false);
  assert.deepEqual([s1.ftb, s2.ftb, s2.freeze], [0, 1, 1]);
  assert.equal(s1.pgmEdit, 1, 'PGM EDIT lamp follows the buffer the panel edits');
});

test('layers bind: type normal, attached to their own screen, ids unique across screens', () => {
  /* type 0 is not a type the console binds (PixelFlow's isaVailableLayer), and
     a layer pinned to screen 1 whatever its screen never showed on S2. */
  const layers = [
    { destination: 'S1', key: 1 }, { destination: 'S1', key: 2 },
    { destination: 'S2', key: 1 }, { destination: 'S3', key: 1 },
  ];
  const model = businessModel({ ...FACTS, layers, selection: { destinations: ['S2'], layer: 1 } });
  assert.equal(model.layers.length, 3, 'S3 is not in service, so neither is its layer');
  for (const l of model.layers) assert.equal(l.type, 2);
  const s2 = model.layers.find((l) => l.attachScreenUid === 'S2');
  assert.equal(s2.attachScreenId, 2);
  assert.deepEqual(s2.index, [1], "each screen's layers start at the first key");
  assert.equal(s2.selected, 1);
  assert.equal(model.layers.find((l) => l.attachScreenUid === 'S1' && l.serial === 1).selected, 0);
  assert.equal(new Set(model.layers.map((l) => l.id)).size, 3);
  assert.equal(model.layers.find((l) => l.attachScreenUid === 'S1' && l.serial === 2).name, 'Layer 2');
  for (const l of model.layers) assert.equal(l.region, 4);
});

test('the screen selected last is the active one, so its layers are the ones shown', () => {
  const model = businessModel({ ...FACTS, selection: { destinations: ['S1', 'S2'] } });
  const active = model.screens.filter((s) => s.activeRegion === 4).map((s) => s.uid);
  assert.deepEqual(active, ['S2']);
  const none = businessModel(FACTS);
  assert.equal(none.screens.every((s) => s.activeRegion === 1), true);
});

test('a layer key reports the published id, and the selection keeps its slot', () => {
  assert.equal(layerIdFor(1, 3), 2003);
  assert.equal(layerKeyOf(2003), 3);
  assert.equal(layerKeyOf(0), null);
  const intent = readIntent({ command: COMMAND.layerSelect, payload: { id: 2003 } });
  assert.deepEqual(intent, { kind: 'selectLayer', layer: 3, at: null });
  /* An empty layer key reports 200, "create"; that is never acted on. */
  assert.equal(readIntent({ command: COMMAND.layerCreate, payload: {} }), null);
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

test('store saves the active screen\'s edited buffer into the reported slot', () => {
  /* One slot is one preset: saving it from every selected screen would keep
     only the last one's layers and recall them on all of them. */
  const { writes, note } = writesFor({ kind: 'store', slot: 7 }, ctx({ selected: ['S1', 'S2'] }));
  assert.deepEqual(writes.map((w) => toAwj(w.path)), [
    toAwj(NLC.save('screen', 7, { mode: 'PREVIEW', id: 'S2' }).path),
  ]);
  assert.match(note, /of S2 to memory 7/);
  const pgm = writesFor({ kind: 'store', slot: 7 }, ctx({ buffer: 'PROGRAM' }));
  assert.match(toAwj(pgm.writes[0].path), /PROGRAM/);
});

test('store to a new slot names it, so it shows on the preset bus', () => {
  const { writes } = writesFor({ kind: 'store', slot: 3, label: 'Memory 3' }, ctx());
  assert.equal(writes.length, 2);
  assert.equal(toAwj(writes[1].path), toAwj(NLC.label('screen', 3, '').path));
  assert.equal(writes[1].value, 'Memory 3');
  assert.match(writesFor({ kind: 'store', slot: null }, ctx()).note, /no slot/);
});

test('FTB fades the selection out unless all of it is already black', () => {
  const sel = ['S1', 'A1'];
  const out = writesFor({ kind: 'ftb' }, ctx({ selected: sel, fadedOf: (id) => id === 'A1' }));
  assert.deepEqual(out.writes.map((w) => [toAwj(w.path), w.value]), [
    [toAwj(NLC.fadeToBlackPath('S1')), true],
    [toAwj(NLC.fadeToBlackPath('A1')), true],
  ]);
  const back = writesFor({ kind: 'ftb' }, ctx({ selected: sel, fadedOf: () => true }));
  assert.deepEqual(back.writes.map((w) => w.value), [false, false]);
  assert.match(back.note, /fade up/);
});

test('FTB refuses rather than guesses when the state could not be read', () => {
  const { writes, note } = writesFor({ kind: 'ftb' }, ctx({ fadedOf: () => null }));
  assert.equal(writes.length, 0);
  assert.match(note, /refused/);
});

test('freeze adds the on-air destination to every fitted layer, and only that', () => {
  const freezeOf = () => ({
    programDest: 'DOWN',
    layers: [{ key: '1', freeze: [] }, { key: '2', freeze: ['UP'] }],
  });
  const on = writesFor({ kind: 'freeze' }, ctx({ freezeOf }));
  assert.deepEqual(on.writes.map((w) => [toAwj(w.path), w.value]), [
    [toAwj(NLC.layerFreezePath('S1', '1')), ['DOWN']],
    [toAwj(NLC.layerFreezePath('S1', '2')), ['UP', 'DOWN']],
  ]);
  const frozen = () => ({
    programDest: 'DOWN',
    layers: [{ key: '1', freeze: ['DOWN'] }, { key: '2', freeze: ['UP', 'DOWN'] }],
  });
  const off = writesFor({ kind: 'freeze' }, ctx({ freezeOf: frozen }));
  assert.deepEqual(off.writes.map((w) => w.value), [[], ['UP']],
    'unfreezing leaves a freeze the operator set elsewhere');
});

test('freeze refuses without knowing what is on air', () => {
  const out = writesFor({ kind: 'freeze' }, ctx({ freezeOf: () => ({ programDest: null, layers: [] }) }));
  assert.equal(out.writes.length, 0);
  assert.match(out.note, /refused/);
});

test('FTB and freeze stay unmapped on Midra, which has no verified path', () => {
  for (const kind of ['ftb', 'freeze']) {
    const { writes, note } = writesFor({ kind }, ctx({ dialect: MNG, commands: commandsFor(MNG) }));
    assert.equal(writes.length, 0);
    assert.match(note, /not mapped/);
  }
});

test('the T-bar maps stroke progress from wherever each screen rests', () => {
  /* The console reports progress within a stroke; the switcher's T-bar is
     absolute. From rest at 0 a stroke climbs, from rest at 65535 it falls. */
  const report = { mapValue: 1024, maxValue: 4096, percent: 25, direction: 1 };
  const rests = { S1: 0, S2: 65535, S3: null };
  const { writes, progress } = tbarWrites(report, {
    dialect: NLC, selected: ['S1', 'S2', 'S3'], restOf: (id) => rests[id],
  });
  assert.equal(progress, 0.25);
  assert.deepEqual(writes.map((w) => [toAwj(w.path), w.value]), [
    [toAwj(NLC.takeControl('S1', 'tbarPosition')), 16384],
    [toAwj(NLC.takeControl('S2', 'tbarPosition')), 49151],
  ], 'a screen whose rest could not be read is left alone');
  const end = tbarWrites({ mapValue: 4096, maxValue: 4096 }, { dialect: NLC, selected: ['S2'], restOf: () => 65535 });
  assert.equal(end.writes[0].value, 0);
  assert.equal(end.progress, 1);
});

test('no platform yet means no writes at all', () => {
  const { writes } = writesFor({ kind: 'take' }, { dialect: null, commands: null });
  assert.equal(writes.length, 0);
});

/* ------------------------------------------------------------- the selection */

test('the panel selection is kept here, because the switcher does not keep it', () => {
  const sel = new Selection().restrict(['S1', 'S2']);
  sel.apply(readIntent(byCommand(COMMAND.screenSelect)));
  assert.deepEqual(sel.list, ['S2']);
  sel.apply({ kind: 'select', destination: 'S1' });
  assert.deepEqual(sel.list, ['S2', 'S1']);
  sel.apply({ kind: 'unselect', destination: 'S2' });
  assert.deepEqual(sel.list, ['S1']);
  sel.apply({ kind: 'selectLayer', layer: 4 });
  assert.equal(sel.layer, 4);
});

test('only a screen this app published can be selected', () => {
  const sel = new Selection();
  assert.equal(sel.accepts({ kind: 'select', destination: 'S1' }), false,
    'nothing is selectable before the first publish');
  sel.restrict(['S1', 'S2']);
  sel.apply({ kind: 'select', destination: 'S1' });
  /* A uid from another app's model on the same UCenter — PixelFlow's P20. */
  const foreign = { kind: 'select', destination: 'fb8c7c30-d82b-4f5b-a13d-f9afafb17e30' };
  assert.equal(sel.accepts(foreign), false);
  sel.apply(foreign);
  assert.deepEqual(sel.list, ['S1']);
});

test('a republish drops what is no longer published, and reset forgets everything', () => {
  const sel = new Selection().restrict(['S1', 'S2']);
  sel.apply({ kind: 'select', destination: 'S1' });
  sel.apply({ kind: 'select', destination: 'S2' });
  sel.apply({ kind: 'selectLayer', layer: 3 });
  sel.restrict(['S2']);
  assert.deepEqual(sel.list, ['S2']);
  sel.reset();
  assert.deepEqual(sel.describe(), { destinations: [], layer: 1, buffer: 'PREVIEW' });
  assert.equal(sel.known, null);
});

test('activating a selected screen makes it the one whose layers the bus shows', () => {
  const sel = new Selection().restrict(['S1', 'S2']);
  sel.apply(readIntent({ command: COMMAND.screenSelect, payload: { uid: 'S1' } }));
  sel.apply(readIntent({ command: COMMAND.screenSelect, payload: { uid: 'S2' } }));
  sel.apply(readIntent({ command: COMMAND.screenActive, payload: { uid: 'S1' } }));
  assert.deepEqual(sel.list, ['S2', 'S1']);
  const model = businessModel({ ...FACTS, selection: { destinations: sel.list } });
  assert.equal(model.screens.find((s) => s.activeRegion === 4).uid, 'S1');
  /* A long press reports 103 and drops it. */
  sel.apply(readIntent({ command: COMMAND.screenUnselect, payload: { uid: 'S1' } }));
  assert.deepEqual(sel.list, ['S2']);
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

test('both dialects can ask which layers are fitted without a store', () => {
  const nlc = NLC.layerProbe('S1', 4);
  assert.deepEqual(nlc.slots, ['1', '2', '3', '4']);
  assert.equal(toAwj(nlc.path('2')), 'DeviceObject/$screen/@items/S1/$layer/@items/2/status/@props/capability');
  assert.equal(nlc.fitted('DUAL'), true);
  assert.equal(nlc.fitted('OFF'), false);
  const mng = MNG.layerProbe('S1', 16);
  assert.equal(mng.slots.length, 8);
  assert.equal(mng.fitted('DISABLE'), false);
  assert.deepEqual(MNG.layerProbe('A1').slots, []);
  assert.equal(NLC.layerFreezePath('A1', 1), null, 'auxes have no layer freeze');
});

test('the mini is the only model reachable over the LAN', () => {
  const mini = CONSOLE_MODELS.find((m) => m.id === 'u5mini');
  assert.equal(mini.overLan, true);
  assert.equal(mini.port, 8088);
  assert.equal(CONSOLE_MODELS.find((m) => m.id === 'u5pro').port, 19999);
});

/* ------------------------------------------------------- the WebSocket client */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

test('the handshake answer matches RFC 6455 §1.3’s own worked example', () => {
  /* Pinned to the RFC, not to a constant shared with the stub below — a typo
     in both once passed every test while no real server would talk to it. */
  assert.equal(acceptFor('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

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
