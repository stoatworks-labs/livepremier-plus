/*
 * Transitions per layer and across a screen — `src/core/transitions.js`.
 *
 * What can go expensively wrong here is a write to the wrong place or of the
 * wrong thing: a window spelt in seconds against a take time that has since
 * changed, a speed spelt for the other platform, a take time put back as the
 * wrong direction's value, a move that writes layers that show nothing. Each
 * has a test. Whether any of it LOOKS right is a frame's question, not this
 * file's: see `docs/NOTES.md` (2026-10-19).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import {
  FULL, MAX_TENTHS, tenthsOf, unitsAt, secondsAt, takeTenths, takeTimeWrites, readLook, lookWrites,
  effectLook, effectsOn, waysOn, takesWay, speedValue, speedWord, styleOf, planMove, normaliseStyles, prettyWay
} from '../src/core/transitions.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

/* ----------------------------------------------------------------- store */

const LAYERS = ['NATIVE', '1', '2', '3'];

function layerNode(src, { left = 0, width = 960, top = 0, height = 1080, anchor = 'TOP_LEFT' } = {}) {
  return {
    source: { pp: { inputNum: src } },
    position: { pp: { anchor, posH: left, posV: top, sizeH: width, sizeV: height } },
    opacity: { pp: { opacity: 256 } },
    transition: {
      pp: { flags: ['FORCE_TRANSITION'] },
      opening: { pp: { type: 'FADE', way: 'LEFT_TO_RIGHT' } },
      closing: { pp: { type: 'FADE', way: 'LEFT_TO_RIGHT' } }
    },
    timing: { pp: { ratio: 32768 }, opening: { pp: { start: 0, end: FULL } }, closing: { pp: { start: 0, end: FULL } } },
    speed: { pp: { type: 'SMOOTH_TRANSITION', point1: 0, point2: 255 } }
  };
}

/**
 * S1 at AT_DOWN — program A, preview B — on a 1920×1080 canvas. Preview has
 * L1 on the left half and L2 on the right half; program has L1 only, full
 * width. L3 shows nothing in either; NATIVE shows nothing either.
 */
function deskStore({ up = 20, down = 20, transition = 'AT_DOWN' } = {}) {
  const layerList = { itemKeys: LAYERS, items: {} };
  for (const key of LAYERS) layerList.items[key] = { status: { pp: { capability: 'DUAL' } } };
  const buffers = {
    A: { NATIVE: layerNode('NONE'), 1: layerNode('LIVE_1', { width: 1920 }), 2: layerNode('NONE'), 3: layerNode('NONE') },
    B: {
      NATIVE: layerNode('NONE'),
      1: layerNode('LIVE_5', { left: 0, width: 960 }),
      2: layerNode('LIVE_6', { left: 960, width: 960 }),
      3: layerNode('NONE')
    },
    C: { NATIVE: layerNode('NONE'), 1: layerNode('NONE'), 2: layerNode('NONE'), 3: layerNode('NONE') }
  };
  const presetList = { itemKeys: ['A', 'B', 'C'], items: {} };
  for (const [letter, items] of Object.entries(buffers)) presetList.items[letter] = { layerList: { itemKeys: LAYERS, items } };
  const store = new DeviceStore();
  store.hydrate({
    device: {
      screenAuxGroupList: {
        itemKeys: ['S1'],
        items: {
          S1: {
            control: { pp: { presetUp: 'B', presetDown: 'A', presetPrevious: 'C', takeUpTime: up, takeDownTime: down } },
            status: { pp: { isUsed: true, transition, take: 'OFF' } }
          }
        }
      },
      screenList: {
        itemKeys: ['S1'],
        items: {
          S1: {
            control: { pp: { label: 'Main' } },
            status: { pp: { mode: 'FREESTYLE', size: { pp: { sizeH: 1920, sizeV: 1080 } } } },
            layerList, presetList
          }
        }
      },
      auxiliaryList: { itemKeys: [], items: {} }
    }
  });
  return store;
}

const at = (store, letter, layer, ...tail) => store.get([
  'device', 'screenList', 'items', 'S1', 'presetList', 'items', letter, 'layerList', 'items', layer, ...tail
]);
const apply = (store, writes) => { for (const w of writes) store.set(w.path, w.value); };
const lookOf = (looks, layer) => (looks.find((l) => l.layer === layer) || {}).look;

/* ------------------------------------------------------------ the numbers */

test('seconds are read as tenths the switcher accepts, and anything else is not a time', () => {
  assert.equal(tenthsOf('1.5'), 15);
  assert.equal(tenthsOf('0,4'), 4, 'a decimal comma is a decimal point');
  assert.equal(tenthsOf(' 2 '), 20);
  assert.equal(tenthsOf('0'), 0, 'zero is a cut, and a time');
  assert.equal(tenthsOf('9999'), MAX_TENTHS, 'clamped to the switcher’s 300 s');
  for (const bad of ['', '   ', 'soon', '-1', null, undefined]) assert.equal(tenthsOf(bad), null, String(bad));
});

test('a window edge in seconds is a fraction of the take time it is read against', () => {
  assert.equal(unitsAt(1, 20), Math.round(FULL / 2), '1 s of a 2 s take is half way');
  assert.equal(unitsAt(5, 20), FULL, 'past the end is the end');
  assert.equal(unitsAt(1, 0), null, 'a cut has no inside to put a window in');
  assert.equal(unitsAt(1, null), null);
  assert.equal(secondsAt(FULL, 40), 4);
  assert.equal(secondsAt(Math.round(FULL / 4), 40).toFixed(2), '1.00');
  /* The trap the panel has to show: the same window, after a recall changed the time. */
  assert.equal(secondsAt(unitsAt(1, 20), 40).toFixed(2), '2.00');
});

/* -------------------------------------------------------------- take time */

test('a take time is set in both directions and put back as each direction held it', () => {
  const store = deskStore({ up: 10, down: 30 });
  assert.equal(takeTenths(store, 'S1'), 10, 'read where the dialect says, the up time');
  const { set, restore } = takeTimeWrites(store, 'S1', 25);
  assert.deepEqual(set.map((w) => [w.path.at(-1), w.value]), [['takeUpTime', 25], ['takeDownTime', 25]]);
  assert.deepEqual(restore.map((w) => [w.path.at(-1), w.value]), [['takeUpTime', 10], ['takeDownTime', 30]]);
});

test('a take time the screen already has writes nothing and has nothing to put back', () => {
  const store = deskStore({ up: 20, down: 20 });
  assert.deepEqual(takeTimeWrites(store, 'S1', 20), { set: [], restore: [] });
  const half = takeTimeWrites(deskStore({ up: 20, down: 5 }), 'S1', 20);
  assert.deepEqual(half.set.map((w) => w.path.at(-1)), ['takeDownTime'], 'only the direction that differs');
});

/* -------------------------------------------------------------- a layer */

test('a look is read off one buffer’s copy of a layer', () => {
  const look = readLook(deskStore(), 'S1', 'B', '2');
  assert.deepEqual(look.opening, { type: 'FADE', way: 'LEFT_TO_RIGHT' });
  assert.deepEqual(look.window.opening, { start: 0, end: FULL });
  assert.equal(look.speed, 'SMOOTH_TRANSITION');
});

test('an effect is written to the buffer asked for, only where it differs, and never a way for a fade', () => {
  const store = deskStore();
  const wipe = lookWrites(store, 'S1', 'B', '2', effectLook('WIPE', 'RIGHT_TO_LEFT'));
  assert.deepEqual(wipe.map((w) => [w.path[6], w.path.slice(10).join('.'), w.value]).sort(), [
    ['B', 'transition.closing.pp.type', 'WIPE'],
    ['B', 'transition.closing.pp.way', 'RIGHT_TO_LEFT'],
    ['B', 'transition.opening.pp.type', 'WIPE'],
    ['B', 'transition.opening.pp.way', 'RIGHT_TO_LEFT']
  ]);
  apply(store, wipe);
  assert.deepEqual(lookWrites(store, 'S1', 'B', '2', effectLook('WIPE', 'RIGHT_TO_LEFT')), [], 'a second pass builds nothing');
  assert.equal(at(store, 'A', '2', 'transition', 'opening', 'pp', 'type'), 'FADE', 'the other buffer is untouched');

  const fade = effectLook('FADE', 'UP_TO_BOTTOM');
  assert.deepEqual(fade, { opening: { type: 'FADE' }, closing: { type: 'FADE' } }, 'a fade goes no way');
  assert.equal(effectLook('', 'LEFT_TO_RIGHT'), null, 'no effect is no look');
});

test('a value the catalogue does not offer is left out, not sent', () => {
  const store = deskStore();
  assert.deepEqual(lookWrites(store, 'S1', 'B', '1', { opening: { type: 'SPARKLE' } }), []);
  assert.ok(!effectsOn(store).includes('WIPE_ADVANCED'), 'the enum has it; the layer property does not offer it');
  assert.ok(effectsOn(store).includes('WIPE'));
  assert.equal(waysOn(store).length, 11);
  assert.equal(takesWay('CUT'), false);
  assert.equal(takesWay('SLIDE'), true);
  assert.equal(prettyWay('UP_TO_BOTTOM'), 'Top to bottom');
});

test('an easing is spelt for the platform the store speaks', () => {
  const lp = deskStore();
  const pulse = new DeviceStore();
  pulse.hydrate(fixture('midra-3.2.29-pulse4k.json'));
  assert.equal(speedValue(lp, 'LINEAR'), 'LINEAR_TRANSITION');
  assert.equal(speedValue(pulse, 'LINEAR'), 'LINEAR');
  const midra = lookWrites(pulse, 'S1', 'UP', '1', { speed: 'LINEAR', opening: { type: 'WIPE', way: 'LEFT_TO_RIGHT' } });
  assert.ok(midra.length >= 3);
  for (const w of midra) {
    assert.deepEqual(w.path.slice(0, 8), ['device', 'screenList', 'items', '1', 'presetList', 'items', 'UP', 'liveLayerList'],
      'a Midra layer lives under liveLayerList, keyed 1 not S1');
  }
  assert.ok(midra.some((w) => w.path.join('/').endsWith('speed/pp/type') && w.value === 'LINEAR'));
  assert.equal(speedWord('SMOOTH_TRANSITION'), 'SMOOTH');
  assert.equal(speedWord('LINEAR'), 'LINEAR');
});

/* ------------------------------------------------------------------ moves */

test('a wipe across the screen gives each layer the part of the take the edge crosses it', () => {
  const store = deskStore();
  const { looks, refused } = planMove(store, 'S1', 'wipe', { way: 'LEFT_TO_RIGHT' });
  assert.equal(refused, null);
  assert.deepEqual(looks.map((l) => l.layer).sort(), ['1', '2'], 'L3 and NATIVE show nothing and are left alone');
  const l1 = lookOf(looks, '1');
  const l2 = lookOf(looks, '2');
  assert.deepEqual(l1.window.opening, { start: 0, end: Math.round(FULL / 2) }, 'L1 enters on the left half');
  assert.deepEqual(l2.window.opening, { start: Math.round(FULL / 2), end: FULL }, 'L2 on the right half');
  assert.deepEqual(l1.window.closing, { start: 0, end: FULL }, 'L1 leaves program full width: the whole take');
  assert.deepEqual(l1.opening, { type: 'WIPE', way: 'LEFT_TO_RIGHT' });
  assert.equal(l1.speed, 'LINEAR', 'an eased layer would break the line at every layer’s edge');

  const back = planMove(store, 'S1', 'wipe', { way: 'RIGHT_TO_LEFT' }).looks;
  assert.deepEqual(lookOf(back, '2').window.opening, { start: 0, end: Math.round(FULL / 2) }, 'right to left: L2 first');
});

test('a wipe’s writes land in the chosen buffer and read back as the plan', () => {
  const store = deskStore();
  const { looks } = planMove(store, 'S1', 'wipe', { way: 'LEFT_TO_RIGHT' });
  for (const { layer, look } of looks) apply(store, lookWrites(store, 'S1', 'B', layer, look));
  const l2 = readLook(store, 'S1', 'B', '2');
  assert.deepEqual(l2.window.opening, { start: Math.round(FULL / 2), end: FULL });
  assert.equal(l2.speed, 'LINEAR_TRANSITION');
  assert.equal(readLook(store, 'S1', 'A', '2').speed, 'SMOOTH_TRANSITION', 'program untouched');
});

test('a cascade slices the take in the order asked for, overlapping as asked', () => {
  const store = deskStore();
  const plain = planMove(store, 'S1', 'cascade', { order: 'left' }).looks;
  assert.deepEqual(plain.map((l) => l.layer), ['1', '2']);
  assert.deepEqual(lookOf(plain, '1').window.opening, { start: 0, end: Math.round(FULL / 2) });
  assert.deepEqual(lookOf(plain, '2').window.opening, { start: Math.round(FULL / 2), end: FULL });
  assert.deepEqual(lookOf(plain, '2').window.closing, lookOf(plain, '2').window.opening);
  assert.equal(lookOf(plain, '1').opening, undefined, 'a cascade keeps each layer’s own effect');

  const backwards = planMove(store, 'S1', 'cascade', { order: 'right' }).looks;
  assert.deepEqual(backwards.map((l) => l.layer), ['2', '1']);

  /* Two slices overlapping by half: each is 2/3 of the take, the second starting at 1/3. */
  const over = planMove(store, 'S1', 'cascade', { order: 'stack', overlap: 0.5 }).looks;
  assert.deepEqual(lookOf(over, '1').window.opening, { start: 0, end: Math.round((FULL * 2) / 3) });
  assert.deepEqual(lookOf(over, '2').window.opening, { start: Math.round(FULL / 3), end: FULL });
});

test('a dip closes every layer before the split and opens it after', () => {
  const { looks } = planMove(deskStore(), 'S1', 'dip', { split: 0.4 });
  assert.deepEqual(looks.map((l) => l.layer).sort(), ['1', '2']);
  for (const { look } of looks) {
    assert.deepEqual(look.window.closing, { start: 0, end: Math.round(FULL * 0.4) });
    assert.deepEqual(look.window.opening, { start: Math.round(FULL * 0.4), end: FULL });
    assert.equal(look.opening, undefined);
  }
  const odd = planMove(deskStore(), 'S1', 'dip', { split: 3 }).looks;
  assert.equal(lookOf(odd, '1').window.closing.end, Math.round(FULL * 0.9), 'the split is kept inside the take');
});

test('whole take puts every fitted layer’s windows back, shown or not', () => {
  const { looks } = planMove(deskStore(), 'S1', 'reset');
  assert.deepEqual(looks.map((l) => l.layer).sort(), ['1', '2', '3', 'NATIVE']);
  for (const { look } of looks) assert.deepEqual(look, { window: { opening: { start: 0, end: FULL }, closing: { start: 0, end: FULL } } });
});

test('a move with nothing to move, or nowhere to move it, says why', () => {
  assert.match(planMove(deskStore(), 'S9', 'wipe').refused, /not on this switcher/);
  assert.match(planMove(deskStore(), 'S1', 'swirl').refused, /no such move/);
  assert.match(planMove(new DeviceStore(), 'S1', 'wipe').refused, /store has not arrived/);
});

/* ----------------------------------------------------------------- styles */

test('a stored style list is cleaned rather than refused', () => {
  const doc = normaliseStyles({
    styles: [
      { name: '  Wipe L→R  ', look: { opening: { type: 'WIPE', way: 'LEFT_TO_RIGHT' }, speed: 'LINEAR' } },
      { name: 'wipe l→r', look: { opening: { type: 'CUT' } } },
      { name: 'No look', look: {} },
      { name: '', look: { opening: { type: 'FADE' } } },
      { name: 'Bad window', look: { window: { opening: { start: 9, end: 2 } }, closing: { type: 'FADE', way: 'nonsense' } } },
      'nonsense'
    ]
  });
  assert.deepEqual(doc.styles.map((s) => s.name), ['Wipe L→R', 'Bad window']);
  assert.deepEqual(doc.styles[1].look, { closing: { type: 'FADE' } }, 'the bad window and the bad way are dropped, the rest kept');
});

test('a layer’s look is kept as a style in words, not in one platform’s spelling', () => {
  const look = readLook(deskStore(), 'S1', 'B', '1');
  const style = styleOf(look);
  assert.equal(style.speed, 'SMOOTH');
  assert.deepEqual(style.window.opening, { start: 0, end: FULL });
});
