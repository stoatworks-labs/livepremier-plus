/*
 * Audio Matrix — the model against the simulator's own audio tree (frame 1 of
 * a LivePremier Simulator 6.2.73, captured 2026-09-24), and the panel's clicks
 * against a session that records what it would have sent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { install } from './helpers/fake-dom.js';
import { DeviceStore } from '../src/core/device-store.js';
import { detectPlatform, supports } from '../src/core/platform.js';
import {
  frames, clock, readMatrix, blockState, blockWrites, crosspointWrites, fedBy, takesFrom,
  describeSource, describeDest, parseSource, txPath, destMute, sourceMute, NONE
} from '../plugins/audio-matrix/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

function simStore({ connectors = true } = {}) {
  const s = new DeviceStore();
  const audio = fixture('sim-6.2.73-audio.json');
  const tree = connectors ? fixture('sim-6.2.73-connectors.json') : { device: {} };
  const root = tree.device || tree;
  root.audio = audio.device.audio;
  s.hydrate({ device: root });
  return s;
}

const src = (m, id) => m.sources.find((g) => g.id === id);
const dst = (m, id) => m.destinations.find((g) => g.id === id);

/* ------------------------------------------------------------------ model */

test('the simulator’s matrix reads as 64 inputs and 8 Dante blocks onto 24 outputs, 8 Dante blocks and 2 multiviewers', () => {
  const store = simStore();
  assert.deepEqual(frames(store), ['1']);
  assert.deepEqual(clock(store), { clockMode: 'INTERNAL', sampleRate: '48K' });
  const m = readMatrix(store, '1', { fittedOnly: false });
  assert.equal(m.sources.filter((g) => g.kind === 'input').length, 64);
  assert.equal(m.sources.filter((g) => g.kind === 'dante').length, 8);
  assert.equal(m.destinations.filter((g) => g.kind === 'output').length, 24);
  assert.equal(m.destinations.filter((g) => g.kind === 'dante').length, 8);
  assert.equal(m.destinations.filter((g) => g.kind === 'multiviewer').length, 2);
  for (const g of [...m.sources, ...m.destinations]) assert.equal(g.channels.length, 8, g.id);
  assert.ok(!m.sources.some((g) => g.id === 'NONE'), 'NONE is the absence of a source, not a row');
});

test('Dante is labelled flat, the way the Console and everybody else counts it', () => {
  const m = readMatrix(simStore(), '1', { fittedOnly: false });
  assert.equal(src(m, 'DANTE_2').label, 'Dante 9–16');
  assert.deepEqual(src(m, 'DANTE_2').channels.map((c) => c.label), ['9', '10', '11', '12', '13', '14', '15', '16']);
  assert.equal(dst(m, 'DANTE_8').label, 'Dante 57–64');
  assert.equal(describeSource('DANTE_2_CHANNEL_3'), 'Dante 11');
  assert.equal(describeSource('INPUT_12_CHANNEL_4'), 'Input 12 ch 4');
  assert.equal(describeSource(NONE), 'None');
  assert.equal(describeDest('DANTE_2', 3), 'Dante 11');
  assert.equal(describeDest('MVW_1', 2), 'Multiviewer 1 ch 2');
  assert.deepEqual(parseSource('INPUT_64_CHANNEL_8'), { kind: 'input', unit: 64, ch: 8 });
  assert.equal(parseSource('NONE'), null);
});

test('fitted only hides unfitted connectors — but never one that is patched', () => {
  const m = readMatrix(simStore(), '1', { fittedOnly: true });
  /* The sim has IN_1–IN_20 and outputs 1–8 fitted. Its factory patch sends
     inputs 1–32 into Dante and Dante onto all 24 outputs, so 21–32 and 9–24
     stay: a filter must not hide a route. Only inputs 33–64 go. */
  const ins = m.sources.filter((g) => g.kind === 'input').map((g) => g.unit);
  assert.deepEqual(ins, Array.from({ length: 32 }, (_, i) => i + 1));
  const outs = m.destinations.filter((g) => g.kind === 'output').map((g) => g.unit);
  assert.deepEqual(outs, Array.from({ length: 24 }, (_, i) => i + 1));
  assert.deepEqual(m.hidden, { sources: 32, destinations: 0 });
  assert.equal(m.sources.filter((g) => g.kind === 'dante').length, 8, 'Dante is never filtered');

  /* Take Input 25 out of Dante 7 and it is unfitted and unpatched: hidden. */
  const store = simStore();
  store.set(txPath('1', 'DANTE_7', 1, 'source'), NONE);
  store.set(txPath('1', 'DANTE_7', 2, 'source'), NONE);
  const after = readMatrix(store, '1', { fittedOnly: true });
  assert.ok(!after.sources.some((g) => g.id === 'INPUT_25'));
  assert.ok(after.sources.some((g) => g.id === 'INPUT_26'));
});

test('a store with no connector list hides nothing rather than everything', () => {
  const m = readMatrix(simStore({ connectors: false }), '1', { fittedOnly: true });
  assert.equal(m.sources.filter((g) => g.kind === 'input').length, 64);
  assert.equal(m.destinations.filter((g) => g.kind === 'output').length, 24);
});

test('a block says how many channels a source feeds, and whether it is straight', () => {
  const m = readMatrix(simStore(), '1');
  /* The simulator's factory patch: Output 1 takes Dante 1 and 2 on channels 1–2. */
  assert.deepEqual(blockState(src(m, 'DANTE_1'), dst(m, 'OUTPUT_1')), { count: 2, straight: false });
  assert.deepEqual(blockState(src(m, 'INPUT_3'), dst(m, 'OUTPUT_1')), { count: 0, straight: false });
  const d = src(m, 'DANTE_1').channels[0];
  assert.equal(fedBy(d, dst(m, 'OUTPUT_1')), 1);
  assert.equal(takesFrom(dst(m, 'OUTPUT_1').channels[1], src(m, 'DANTE_1')).key, 'DANTE_1_CHANNEL_2');
});

test('a block click lays a source channel for channel, writing only what changes', () => {
  const m = readMatrix(simStore(), '1');
  const writes = blockWrites('1', src(m, 'INPUT_3'), dst(m, 'OUTPUT_1'));
  assert.equal(writes.length, 8);
  assert.deepEqual(writes[0], {
    path: ['device', 'audio', 'control', 'deviceList', 'items', '1', 'txList', 'items', 'OUTPUT_1',
      'channelList', 'items', '1', 'control', 'pp', 'source'],
    value: 'INPUT_3_CHANNEL_1'
  });
  assert.deepEqual(writes.map((w) => w.value), Array.from({ length: 8 }, (_, i) => `INPUT_3_CHANNEL_${i + 1}`));
});

test('a block that is already straight clears; a half-straight one completes', () => {
  const store = simStore();
  for (let ch = 1; ch <= 8; ch++) store.set(txPath('1', 'OUTPUT_2', ch, 'source'), `INPUT_5_CHANNEL_${ch}`);
  let m = readMatrix(store, '1');
  assert.deepEqual(blockState(src(m, 'INPUT_5'), dst(m, 'OUTPUT_2')), { count: 8, straight: true });
  const clear = blockWrites('1', src(m, 'INPUT_5'), dst(m, 'OUTPUT_2'));
  assert.equal(clear.length, 8);
  assert.ok(clear.every((w) => w.value === NONE));

  store.set(txPath('1', 'OUTPUT_2', 4, 'source'), NONE);
  m = readMatrix(store, '1');
  const complete = blockWrites('1', src(m, 'INPUT_5'), dst(m, 'OUTPUT_2'));
  assert.deepEqual(complete.map((w) => [w.path[11], w.value]), [['4', 'INPUT_5_CHANNEL_4']]);
});

test('a crosspoint patches, and a lit one goes back to None', () => {
  const m = readMatrix(simStore(), '1');
  const out1 = dst(m, 'OUTPUT_1');
  const [on] = crosspointWrites('1', out1, out1.channels[0], src(m, 'DANTE_1').channels[0]);
  assert.equal(on.value, NONE, 'Dante 1 is already on Output 1 ch 1');
  const [swap] = crosspointWrites('1', out1, out1.channels[0], src(m, 'INPUT_7').channels[1]);
  assert.equal(swap.value, 'INPUT_7_CHANNEL_2');
});

test('mutes are the device’s own props, on both sides', () => {
  assert.equal(destMute('1', 'MVW_2', 3, true).path.join('/'),
    'device/audio/control/deviceList/items/1/txList/items/MVW_2/channelList/items/3/control/pp/mute');
  assert.equal(sourceMute('1', 'DANTE_4_CHANNEL_1', false).path.join('/'),
    'device/audio/control/deviceList/items/1/rxList/items/DANTE_4_CHANNEL_1/control/pp/mute');
});

test('an empty store has no frames and no matrix', () => {
  const s = new DeviceStore();
  assert.deepEqual(frames(s), []);
  assert.equal(readMatrix(s, '1'), null);
});

/* ------------------------------------------------------------ capability */

test('only a LivePremier offers the matrix; a Midra routes audio at the Console', () => {
  const lp = detectPlatform(simStore());
  assert.equal(supports(lp, 'audioMatrix'), true);
  const pulse = new DeviceStore();
  pulse.hydrate(fixture('midra-3.2.29-pulse4k.json'));
  const p = detectPlatform(pulse);
  assert.equal(supports(p, 'audioPatch'), true, 'the Console still routes audio there');
  assert.equal(supports(p, 'audioMatrix'), false);
});

/* ----------------------------------------------------------------- panel */

function sessionOver(store) {
  const sent = [];
  const session = new EventTarget();
  session.store = store;
  session.send = (w) => { sent.push(w); return true; };
  return { session, sent };
}

/** Every element under `el`, depth first. */
function* walk(el) {
  yield el;
  for (const c of el.children || []) yield* walk(c);
}
const byClass = (el, cls) => [...walk(el)].filter((e) => (e.className || '').split(' ').includes(cls));

test('the panel draws blocks, and a block click sends the eight writes', async () => {
  const dom = install();
  try {
    const { createAudioMatrixPanel } = await import('../plugins/audio-matrix/panel.js');
    const store = simStore();
    const { session, sent } = sessionOver(store);
    const panel = createAudioMatrixPanel({ session, popoutEnabled: false });
    const root = panel.render();
    assert.equal(panel.render(), root, 'redrawn in place');

    const rows = byClass(root, 'lpp-am-rh--group');
    assert.equal(rows.length, 40, '32 inputs (fitted or patched) + 8 Dante blocks');
    const blocks = byClass(root, 'lpp-am-x--block');
    assert.equal(blocks.length, 40 * 34, '40 source groups × (24 outputs + 8 Dante + 2 MVW)');

    /* Output 1 ← Dante 1–8 shows 2 (the factory patch), in the Dante 1 row. */
    const danteRow = rows.findIndex((r) => r.textContent.includes('Dante 1–8'));
    assert.ok(danteRow >= 0);
    const dante1Out1 = blocks[danteRow * 34];
    assert.equal(dante1Out1.textContent, '2');

    /* Input 3 × Output 1: lay it across. */
    blocks[2 * 34].click();
    assert.equal(sent.length, 8);
    assert.deepEqual(sent.map((w) => w.value), Array.from({ length: 8 }, (_, i) => `INPUT_3_CHANNEL_${i + 1}`));
    panel.render();
    assert.ok(blocks[2 * 34].className.includes('lpp-am-x--pending'), 'pending until the switcher echoes');

    /* The echo lights it solid. */
    for (const w of sent) store.set(w.path, w.value);
    panel.render();
    assert.ok(blocks[2 * 34].className.includes('lpp-am-x--full'));
    assert.ok(!blocks[2 * 34].className.includes('lpp-am-x--pending'));
  } finally {
    dom.uninstall();
  }
});

test('opening a row and a column gives single crosspoints; the lock patches nothing', async () => {
  const dom = install();
  try {
    const { createAudioMatrixPanel } = await import('../plugins/audio-matrix/panel.js');
    const { session, sent } = sessionOver(simStore());
    const panel = createAudioMatrixPanel({ session, popoutEnabled: false });
    let root = panel.render();
    byClass(root, 'lpp-am-rh--group')[0].click();   // Input 1
    byClass(root, 'lpp-am-gh')[0].click();          // Output 1
    root = panel.render();
    /* Row 0 is Input 1's group row; rows 1–8 are its channels. The first
       eight columns are Output 1's channels. */
    const body = [...walk(root)].find((e) => e.tagName === 'TBODY');
    const ch2 = body.children[2];
    const cells = ch2.children.filter((c) => c.tagName === 'TD');
    cells[4].click();                              // Input 1 ch 2 → Output 1 ch 5
    assert.equal(sent.length, 1);
    assert.equal(sent[0].value, 'INPUT_1_CHANNEL_2');
    assert.equal(sent[0].path[11], '5');

    const lock = byClass(root, 'lpp-chip').find((b) => b.textContent === 'Lock');
    lock.click();
    root = panel.render();
    const body2 = [...walk(root)].find((e) => e.tagName === 'TBODY');
    body2.children[2].children.filter((c) => c.tagName === 'TD')[4].click();
    assert.equal(sent.length, 1, 'locked: nothing sent');
  } finally {
    dom.uninstall();
  }
});
