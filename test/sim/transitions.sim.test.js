/*
 * Transitions per layer and across a screen, against a live switcher.
 *
 * What a simulator can show, and so what is checked here: that every write
 * `src/core/transitions.js` builds is one the switcher takes and reports back
 * over AWJ, in the buffer it was meant for; that a "take only" with a time of
 * its own runs for that long and leaves the screen's own time as it was; and
 * that its effect is on the layer that moved, and nowhere else.
 *
 * What it cannot: the picture. The simulator's output is a placeholder, so
 * whether a wipe runs inside its box, which copy a closing is read from, and
 * whether a window does what its numbers say are a frame's questions — see
 * `docs/NOTES.md` (2026-10-19). Nothing here passes on them.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { SKIP, startApp, Link, awjGet, sag, settled, guardScreen, layerPath } from './harness.js';
import { bankLetter, fittedLayers } from '../../src/core/properties.js';
import { topLeftToAnchor } from '../../src/core/screens.js';
import { createLockEngine } from '../../plugins/layer-lock/engine.js';
import {
  FULL, lookWrites, readLook, planMove, takeTimeWrites, specOf
} from '../../src/core/transitions.js';

let app;
let link;
let guard;

before(async () => {
  if (SKIP) return;
  app = await startApp();
  link = await Link.open(app);
  guard = await guardScreen(link, 'S1');
});

after(async () => {
  try {
    if (guard) await guard.restore();
  } finally {
    link?.close();
    await app?.close();
  }
});

const letter = (role) => bankLetter(link.store, 'S1', role).letter;
const src = (role) => layerPath('S1', letter(role), 1, 'source', 'pp', 'inputNum');
const opening = (l, field) => layerPath('S1', l, 1, 'transition', 'opening', 'pp', field);

async function times(up, down = up) {
  link.send([{ path: sag('S1', 'control', 'takeUpTime'), value: up }, { path: sag('S1', 'control', 'takeDownTime'), value: down }]);
  await link.waitFor(sag('S1', 'control', 'takeUpTime'), up);
  await link.waitFor(sag('S1', 'control', 'takeDownTime'), down);
}

async function split(programSource, previewSource) {
  await settled(link);
  link.send([{ path: src('PROGRAM'), value: programSource }, { path: src('PREVIEW'), value: previewSource }]);
  await link.waitFor(src('PROGRAM'), programSource);
  await link.waitFor(src('PREVIEW'), previewSource);
}

/** Send some writes and wait until AWJ, not only the mirror, reads every one back. */
async function landedOverAwj(writes) {
  link.send(writes);
  for (const w of writes) await link.waitFor(w.path, w.value, { timeout: 4000 });
  for (const w of writes) assert.deepEqual(await awjGet(w.path), w.value, `AWJ reads ${w.path.join('/')}`);
}

function lockEngine() {
  const engine = createLockEngine({ store: link.store, send: (c) => { link.send(c); return true; }, locks: () => [] });
  const off = link.onFrame((f) => engine.onFrame(f));
  return { engine, done: () => { off(); engine.dispose(); } };
}

/* ------------------------------------------------------------ the writes */

test('a whole look is taken by the switcher, in preview, and program is left alone', { skip: SKIP }, async () => {
  await settled(link);
  const pvw = letter('PREVIEW');
  const pgm = letter('PROGRAM');
  const before = readLook(link.store, 'S1', pgm, '1');
  const look = {
    opening: { type: 'SLIDE', way: 'BOTTOM_TO_UP' },
    closing: { type: 'CIRCLE', way: 'HV_FROM_TO_CENTER' },
    window: { opening: { start: 1000, end: 40000 }, closing: { start: 20000, end: 60000 } },
    speed: 'LINEAR'
  };
  const writes = lookWrites(link.store, 'S1', pvw, '1', look);
  assert.ok(writes.length >= 9, `a full look is nine fields (${writes.length} differed)`);
  for (const w of writes) assert.equal(w.path[6], pvw, 'every write is to preview');
  await landedOverAwj(writes);
  const read = readLook(link.store, 'S1', pvw, '1');
  assert.deepEqual(read.opening, look.opening);
  assert.deepEqual(read.closing, look.closing);
  assert.deepEqual(read.window, look.window);
  assert.equal(read.speed, 'LINEAR_TRANSITION');
  assert.deepEqual(readLook(link.store, 'S1', pgm, '1'), before, 'program untouched');
});

test('every effect and every direction the catalogue offers is accepted', { skip: SKIP }, async () => {
  await settled(link);
  const pvw = letter('PREVIEW');
  for (const type of specOf(link.store, 'openingType').values) {
    await landedOverAwj([{ path: opening(pvw, 'type'), value: type }]);
  }
  for (const way of specOf(link.store, 'openingWay').values) {
    await landedOverAwj([{ path: opening(pvw, 'way'), value: way }]);
  }
});

/**
 * Preview as two layers side by side — L1 on the left half, L2 on the right —
 * each showing a source, so a move has two boxes in different places to
 * work out. Written through each layer's own anchor, whatever it is.
 */
async function sideBySide() {
  await settled(link);
  const pvw = letter('PREVIEW');
  const keys = fittedLayers(link.store, 'S1').map((l) => l.key).filter((k) => k !== 'NATIVE');
  assert.ok(keys.length >= 2, `S1 needs two fitted layers for this (has ${keys.join(', ')})`);
  const writes = [];
  for (const [i, key] of keys.slice(0, 2).entries()) {
    const at = (...tail) => layerPath('S1', pvw, key, ...tail);
    const anchor = link.get(at('position', 'pp', 'anchor')) || 'MIDDLE_CENTER';
    const { posH, posV } = topLeftToAnchor(anchor, i * 960, 0, 960, 1080);
    writes.push(
      { path: at('source', 'pp', 'inputNum'), value: i ? 'LIVE_4' : 'LIVE_3' },
      { path: at('position', 'pp', 'sizeH'), value: 960 },
      { path: at('position', 'pp', 'sizeV'), value: 1080 },
      { path: at('position', 'pp', 'posH'), value: posH },
      { path: at('position', 'pp', 'posV'), value: posV });
  }
  link.send(writes);
  for (const w of writes) await link.waitFor(w.path, w.value, { timeout: 4000 });
  return { pvw, left: keys[0], right: keys[1] };
}

test('every move’s writes are taken and read back as planned', { skip: SKIP }, async () => {
  const { pvw, left, right } = await sideBySide();
  const half = Math.round(FULL / 2);

  const wipe = planMove(link.store, 'S1', 'wipe', { way: 'RIGHT_TO_LEFT' });
  assert.equal(wipe.refused, null, wipe.refused);
  const windowOf = (looks, key) => looks.find((l) => l.layer === key).look.window.opening;
  assert.deepEqual(windowOf(wipe.looks, right), { start: 0, end: half }, 'right to left: the right-hand layer first');
  assert.deepEqual(windowOf(wipe.looks, left), { start: half, end: FULL });

  for (const [move, opts] of [['wipe', { way: 'RIGHT_TO_LEFT' }], ['cascade', { order: 'left', overlap: 0.3 }], ['dip', { split: 0.3 }], ['reset', {}]]) {
    const { looks, refused } = planMove(link.store, 'S1', move, opts);
    assert.equal(refused, null, `${move}: ${refused}`);
    assert.ok(looks.length >= 2, `${move} moves both layers`);
    const writes = looks.flatMap(({ layer, look }) => lookWrites(link.store, 'S1', pvw, layer, look));
    assert.ok(writes.length > 0, `${move} changes something`);
    await landedOverAwj(writes);
    for (const { layer, look } of looks) {
      const read = readLook(link.store, 'S1', pvw, layer);
      if (look.window && look.window.opening) assert.deepEqual(read.window.opening, look.window.opening, `${move} L${layer} opening window`);
      if (look.window && look.window.closing) assert.deepEqual(read.window.closing, look.window.closing, `${move} L${layer} closing window`);
      if (look.opening) assert.deepEqual(read.opening, look.opening, `${move} L${layer} opening effect`);
    }
  }
  assert.deepEqual(readLook(link.store, 'S1', pvw, left).window.opening, { start: 0, end: FULL }, 'whole take put the windows back');
});

/* ------------------------------------------------ take only, timed and styled */

test('take only with a time of its own runs for that long and leaves the screen’s time as it was', { skip: SKIP }, async () => {
  const { engine, done } = lockEngine();
  try {
    await times(3, 4);
    await split('LIVE_5', 'LIVE_6');
    const from = await settled(link);
    const started = Date.now();
    const r = await engine.takeOnly([{ id: 'S1', layer: '1' }], { tenths: 15 });
    const took = Date.now() - started;
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /in 1\.5 s/);
    assert.notEqual(link.get(sag('S1', 'status', 'transition')), from, 'the take landed');
    assert.equal(await awjGet(src('PROGRAM')), 'LIVE_6', 'layer 1 went to air');
    /* The simulator runs a take for its time and then lands. With the screen
       left at 0.3/0.4 s this would have been back well inside a second. */
    assert.ok(took >= 1300, `the take ran ${took} ms, which is the 1.5 s asked for, not the screen’s 0.3 s`);
    await link.waitFor(sag('S1', 'control', 'takeUpTime'), 3, { timeout: 3000 });
    assert.equal(await awjGet(sag('S1', 'control', 'takeUpTime')), 3);
    assert.equal(await awjGet(sag('S1', 'control', 'takeDownTime')), 4, 'each direction its own time back');
  } finally {
    done();
  }
});

test('take only with an effect leaves it on the layer that moved, and nowhere else', { skip: SKIP }, async () => {
  const { engine, done } = lockEngine();
  try {
    await times(3);
    await split('LIVE_7', 'LIVE_8');
    const pvw = letter('PREVIEW');
    const pgm = letter('PROGRAM');
    /* A known effect on both copies first, so the change is the take's. */
    await landedOverAwj([
      { path: opening(pvw, 'type'), value: 'FADE' }, { path: opening(pgm, 'type'), value: 'FADE' }
    ]);
    const r = await engine.takeOnly([{ id: 'S1', layer: '1' }], { effect: { type: 'WIPE', way: 'UP_TO_BOTTOM' } });
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /with wipe top to bottom/);
    /* What was preview is program now. */
    assert.equal(letter('PROGRAM'), pvw);
    assert.equal(await awjGet(opening(pvw, 'type')), 'WIPE', 'the layer that went to air carries the effect');
    assert.equal(await awjGet(opening(pvw, 'way')), 'UP_TO_BOTTOM');
    assert.equal(await awjGet(layerPath('S1', pvw, 1, 'transition', 'closing', 'pp', 'type')), 'WIPE');
    assert.equal(await awjGet(opening(pgm, 'type')), 'FADE', 'the copy that was program, preview now, was never written');
    assert.equal(await awjGet(src('PROGRAM')), 'LIVE_8');
  } finally {
    done();
  }
});

test('a take time the screen already has is not written at all', { skip: SKIP }, async () => {
  await times(6);
  assert.deepEqual(takeTimeWrites(link.store, 'S1', 6), { set: [], restore: [] });
});
