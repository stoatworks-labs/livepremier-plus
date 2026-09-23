/*
 * Layer locks and partial takes.
 *
 * Neither exists on the switcher; both are built from one fact — a layer
 * identical in program and preview has nothing to transition. What can go
 * expensively wrong is all about *which buffer* gets written and *when*:
 *
 *   - writing the program letter instead of preview, which is a layer change
 *     on air;
 *   - writing mid-take, when preview names no buffer honestly;
 *   - a TAKE overtaking the writes meant to go ahead of it, or a second TAKE
 *     overtaking a held first one;
 *   - a held take never leaving.
 *
 * Each has a test below. The hook's gate is exercised in a VM against a
 * stand-in WebSocket, because it is inlined into the vendor's page and is the
 * one place a bug could swallow the vendor's own TAKE.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

import { DeviceStore } from '../src/core/device-store.js';
import { dialectFor } from '../src/core/dialect.js';
import {
  normalise, takeTarget, syncWrites, inSync, snapshot, restoreWrites, verdict, partialPlan, lockedOn
} from '../src/core/layer-lock.js';
import { createLockEngine } from '../plugins/layer-lock/engine.js';

const here = dirname(fileURLToPath(import.meta.url));

/* ----------------------------------------------------------------- store */

const LAYERS = ['NATIVE', '1', '2'];

function layerNode(src, posH = 960) {
  return {
    source: { pp: { inputNum: src } },
    position: { pp: { anchor: 'MIDDLE_CENTER', posH, posV: 540, sizeH: 1920, sizeV: 1080 } },
    opacity: { pp: { opacity: 256 } }
  };
}

/**
 * S1 at AT_DOWN: program is A, preview is B. Layer 1 differs between them,
 * layer 2 differs, NATIVE is the same in both.
 */
function deskStore({ transition = 'AT_DOWN', status = null } = {}) {
  const layerList = { itemKeys: LAYERS, items: {} };
  for (const key of LAYERS) {
    layerList.items[key] = { status: { pp: { capability: 'DUAL', ...(status ? status[key] : {}) } } };
  }
  const buffers = {
    A: { NATIVE: layerNode('NONE'), 1: layerNode('LIVE_1'), 2: layerNode('LIVE_2', 400) },
    B: { NATIVE: layerNode('NONE'), 1: layerNode('LIVE_5'), 2: layerNode('LIVE_6', 1200) },
    C: { NATIVE: layerNode('NONE'), 1: layerNode('NONE'), 2: layerNode('NONE') }
  };
  const presetList = { itemKeys: ['A', 'B', 'C'], items: {} };
  for (const [letter, items] of Object.entries(buffers)) {
    presetList.items[letter] = { layerList: { itemKeys: LAYERS, items } };
  }
  const store = new DeviceStore();
  store.hydrate({
    device: {
      screenAuxGroupList: {
        itemKeys: ['S1'],
        items: {
          S1: {
            control: { pp: { presetUp: 'B', presetDown: 'A', presetPrevious: 'C', takeUpTime: 1, takeDownTime: 1 } },
            status: { pp: { isUsed: true, transition, take: 'OFF' } }
          }
        }
      },
      screenList: {
        itemKeys: ['S1'],
        items: { S1: { control: { pp: { label: 'Main' } }, status: { pp: { mode: 'FREESTYLE' } }, layerList, presetList } }
      },
      auxiliaryList: { itemKeys: [], items: {} }
    }
  });
  return store;
}

const at = (store, letter, layer, ...tail) => store.get([
  'device', 'screenList', 'items', 'S1', 'presetList', 'items', letter, 'layerList', 'items', layer, ...tail
]);
const src = (store, letter, layer) => at(store, letter, layer, 'source', 'pp', 'inputNum');
const posH = (store, letter, layer) => at(store, letter, layer, 'position', 'pp', 'posH');
const TAKE = ['device', 'screenAuxGroupList', 'items', 'S1', 'control', 'pp', 'xTake'];
const TRANSITION = ['device', 'screenAuxGroupList', 'items', 'S1', 'status', 'pp', 'transition'];

/* ------------------------------------------------------------------ rules */

test('a stored lock list is cleaned rather than refused', () => {
  const doc = normalise({ locks: ['S1/2', 's1/2', 'S2/native', { id: 'A1', layer: 3 }, 'nonsense', 'S1/1', 42] });
  assert.deepEqual(doc.locks, ['S1/1', 'S1/2', 'S2/NATIVE', 'A1/3']);
  assert.deepEqual(lockedOn(doc.locks, 'S1'), ['1', '2']);
});

test('a take is recognised from the dialect’s own path, and nothing else is', () => {
  const store = deskStore();
  const d = dialectFor(store);
  assert.deepEqual(takeTarget(d, TAKE), { id: 'S1', prop: 'xTake' });
  assert.deepEqual(takeTarget(d, [...TAKE.slice(0, -1), 'xCut']), { id: 'S1', prop: 'xCut' });
  assert.equal(takeTarget(d, TAKE, false), null, 'a trigger reset is not a take');
  assert.equal(takeTarget(d, [...TAKE.slice(0, -1), 'takeUpTime'], true), null);
  assert.equal(takeTarget(d, ['device', 'screenList', 'items', 'S1', 'control', 'pp', 'xTake']), null, 'wrong collection');
});

test('lining up writes preview’s letter, only what differs, and never program', () => {
  const store = deskStore();
  const r = syncWrites(store, 'S1', ['1', '2', 'NATIVE']);
  assert.equal(r.refused, null);
  assert.ok(r.writes.length > 0);
  for (const w of r.writes) assert.equal(w.path[6], 'B', `every write goes to preview (B): ${w.path.join('/')}`);
  const tails = r.writes.map((w) => `${w.path[9]}:${w.path.slice(10).join('.')}`).sort();
  assert.deepEqual(tails, ['1:source.pp.inputNum', '2:position.pp.posH', '2:source.pp.inputNum'],
    'NATIVE already agrees and gets nothing; only the differing properties are written');
  for (const w of r.writes) store.set(w.path, w.value);
  assert.ok(inSync(store, 'S1', ['1', '2', 'NATIVE']), 'a second pass has nothing to do');
  assert.equal(src(store, 'A', '1'), 'LIVE_1', 'program untouched');
});

test('the role is resolved per take: at AT_UP preview is A', () => {
  const store = deskStore({ transition: 'AT_UP' });
  const r = syncWrites(store, 'S1', ['1']);
  assert.equal(r.preview, 'A');
  assert.deepEqual(r.writes.map((w) => [w.path[6], w.value]), [['A', 'LIVE_5']]);
});

test('nothing is written mid-take', () => {
  const store = deskStore({ transition: 'EFFECT_FROM_DOWN' });
  const r = syncWrites(store, 'S1', ['1']);
  assert.match(r.refused, /take is in flight/);
  assert.equal(r.writes.length, 0);
});

test('a layer the screen does not have is never written', () => {
  const store = deskStore();
  store.set(['device', 'screenList', 'items', 'S1', 'layerList', 'items', '2', 'status', 'pp', 'capability'], 'OFF');
  const r = syncWrites(store, 'S1', ['2']);
  assert.equal(r.writes.length, 0);
});

test('a preview look round-trips through a snapshot', () => {
  const store = deskStore();
  const snap = snapshot(store, 'S1', 'B', ['2']);
  store.set(['device', 'screenList', 'items', 'S1', 'presetList', 'items', 'B', 'layerList', 'items', '2', 'source', 'pp', 'inputNum'], 'LIVE_9');
  const writes = restoreWrites(store, 'S1', 'B', snap);
  assert.deepEqual(writes.map((w) => w.value), ['LIVE_6'], 'only the property that moved is written back');
});

test('the switcher’s own verdict is read, and the next direction chosen from the resting state', () => {
  const store = deskStore({ status: { 1: { up: 'CROSS', down: 'OFF' }, 2: {}, NATIVE: {} } });
  assert.deepEqual(verdict(store, 'S1', '1'), { up: 'CROSS', down: 'OFF', next: 'CROSS' });
  assert.equal(verdict(store, 'S1', '2'), null, 'no status, no verdict');
});

test('a partial take holds the rest, refuses a locked target, and restores only unlocked layers', () => {
  const store = deskStore();
  const { plans, refused } = partialPlan(store, [{ id: 'S1', layer: '2' }, { id: 'S1', layer: 'native' }, { id: 'S1', layer: '9' }], ['S1/NATIVE', 'S1/1']);
  assert.deepEqual(refused.sort(), ['S1 L9 is not fitted', 'S1 LNATIVE is locked — unlock it to take it']);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].go, ['2']);
  assert.deepEqual(plans[0].hold.sort(), ['1', 'NATIVE']);
  assert.deepEqual(plans[0].restore, [], 'both held layers are locked: nothing of the operator’s to put back');
});

/* ----------------------------------------------------------------- engine */

/**
 * A device: applies what it is sent, echoes it back inbound a tick later, and
 * lands a take after `takeMs` by swapping which letter is program.
 */
function fakeDevice(store, { takeMs = 5, echo = true } = {}) {
  const sent = [];
  let engine = null;
  const device = {
    sent,
    attach(e) { engine = e; },
    send(cmd) {
      sent.push(cmd);
      store.set(cmd.path, cmd.value);   // the page mirrors its own outbound frames
      engine && engine.onFrame({ ...cmd, dir: 'out' });
      if (cmd.path[cmd.path.length - 1] === 'xTake') {
        const from = store.get(TRANSITION);
        setTimeout(() => {
          const to = from === 'AT_DOWN' ? 'AT_UP' : 'AT_DOWN';
          store.set(TRANSITION, to);
          engine && engine.onFrame({ path: TRANSITION, value: to, dir: 'in' });
        }, takeMs);
      } else if (echo) {
        setTimeout(() => engine && engine.onFrame({ ...cmd, dir: 'in' }), 1);
      }
      return true;
    }
  };
  return device;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the follower puts a locked layer back in line after a change to its preview', async () => {
  const store = deskStore();
  const device = fakeDevice(store);
  const locks = ['S1/1'];
  const engine = createLockEngine({ store, send: device.send, locks: () => locks });
  device.attach(engine);

  engine.syncAll();
  assert.equal(src(store, 'B', '1'), 'LIVE_1', 'setting the lock lines it up at once');

  /* A recall lands something else in preview — on the locked layer and on an
     unlocked one. */
  const recall = (layer, value) => {
    const path = ['device', 'screenList', 'items', 'S1', 'presetList', 'items', 'B', 'layerList', 'items', layer, 'source', 'pp', 'inputNum'];
    store.set(path, value);
    engine.onFrame({ path, value, dir: 'in' });
  };
  device.sent.length = 0;
  recall('1', 'LIVE_7');
  recall('2', 'LIVE_8');
  await sleep(80);
  assert.equal(src(store, 'B', '1'), 'LIVE_1', 'the locked layer is put back');
  assert.equal(src(store, 'B', '2'), 'LIVE_8', 'the unlocked one is left alone');
  assert.ok(device.sent.every((c) => c.path[6] === 'B'), 'only preview is written');
  engine.dispose();
});

test('the follower does not act on the state it finds, only on changes', async () => {
  const store = deskStore();
  const device = fakeDevice(store);
  const engine = createLockEngine({ store, send: device.send, locks: () => ['S1/1'] });
  device.attach(engine);
  engine.onFrame({ path: ['device', 'outputList', 'items', '1', 'x'], value: 1, dir: 'in' });
  await sleep(60);
  assert.equal(device.sent.length, 0);
  engine.dispose();
});

const takeFrame = () => JSON.stringify({ channel: 'DEVICE', data: { path: TAKE, value: true } });

test('a take on an out-of-line locked layer is held until the writes are echoed', async () => {
  const store = deskStore();
  const device = fakeDevice(store);
  const order = [];
  const send = (cmd) => { order.push(cmd.path[cmd.path.length - 1]); return device.send(cmd); };
  const engine = createLockEngine({ store, send, locks: () => ['S1/2'] });
  device.attach(engine);

  let released = false;
  const held = engine.gate(takeFrame(), () => { released = true; order.push('TAKE'); });
  assert.equal(held, true);
  assert.equal(released, false, 'not straight away');
  await sleep(30);
  assert.equal(released, true, 'released once the echoes are in');
  assert.deepEqual([...order].sort(), ['TAKE', 'inputNum', 'posH']);
  assert.equal(order.indexOf('TAKE'), 2, 'the writes go ahead of the take');
  assert.ok(inSync(store, 'S1', ['2']));
  engine.dispose();
});

test('an earlier write’s echo on the same path does not release the take', async () => {
  /* Found on the simulator: a recall writes preview L1, the lock writes it
     straight back, and the recall's echo arrives first. */
  const store = deskStore();
  const engine = createLockEngine({ store, send: (cmd) => { store.set(cmd.path, cmd.value); return true; }, locks: () => ['S1/1'] });
  const path = ['device', 'screenList', 'items', 'S1', 'presetList', 'items', 'B', 'layerList', 'items', '1', 'source', 'pp', 'inputNum'];
  let released = false;
  assert.equal(engine.gate(takeFrame(), () => { released = true; }), true);
  engine.onFrame({ path, value: 'LIVE_5', dir: 'in' });   // the recall's own echo
  await sleep(10);
  assert.equal(released, false, 'a stale value on the right path is not the lock’s echo');
  engine.onFrame({ path, value: 'LIVE_1', dir: 'in' });
  await sleep(10);
  assert.equal(released, true);
  engine.dispose();
});

test('a take with nothing to fix is not held at all', () => {
  const store = deskStore();
  const engine = createLockEngine({ store, send: () => true, locks: () => ['S1/NATIVE'] });
  assert.equal(engine.gate(takeFrame(), () => {}), false);
  const noLocks = createLockEngine({ store, send: () => true, locks: () => [] });
  assert.equal(noLocks.gate(takeFrame(), () => {}), false);
  assert.equal(noLocks.gate('{"channel":"DEVICE","data":{"path":["device","x"],"value":1}}', () => {}), false);
});

test('a take is released even when the switcher never echoes', async () => {
  const store = deskStore();
  const device = fakeDevice(store, { echo: false });
  const engine = createLockEngine({ store, send: device.send, locks: () => ['S1/1'] });
  device.attach(engine);
  let released = false;
  assert.equal(engine.gate(takeFrame(), () => { released = true; }), true);
  await sleep(400);
  assert.equal(released, true);
  engine.dispose();
});

test('a second TAKE pressed while the first is held waits behind it', async () => {
  const store = deskStore();
  const device = fakeDevice(store);
  const engine = createLockEngine({ store, send: device.send, locks: () => ['S1/1'] });
  device.attach(engine);
  const order = [];
  assert.equal(engine.gate(takeFrame(), () => order.push('first')), true);
  assert.equal(engine.gate(takeFrame(), () => order.push('second')), true, 'held too, although nothing is left to fix');
  await sleep(40);
  assert.deepEqual(order, ['first', 'second']);
  engine.dispose();
});

test('take only: the chosen layer moves, the rest are held, and preview is put back', async () => {
  const store = deskStore();
  const device = fakeDevice(store);
  const engine = createLockEngine({ store, send: device.send, locks: () => [] });
  device.attach(engine);

  const r = await engine.takeOnly([{ id: 'S1', layer: '2' }]);
  assert.equal(r.ok, true, r.message);
  assert.equal(store.get(TRANSITION), 'AT_UP', 'the take landed: program is now B');

  /* On air (B): layer 2 is the preview look that was taken; layer 1 is what
     was on program before, untouched by the take. */
  assert.equal(src(store, 'B', '2'), 'LIVE_6');
  assert.equal(src(store, 'B', '1'), 'LIVE_1');
  /* New preview (A): layer 1 has the operator's pending look back. */
  assert.equal(src(store, 'A', '1'), 'LIVE_5');
  assert.equal(posH(store, 'A', '2'), 400, 'the layer that went keeps what came off air, as any take leaves it');
  engine.dispose();
});

test('take only is refused mid-take, before anything is written', async () => {
  const store = deskStore({ transition: 'EFFECT_FROM_DOWN' });
  const device = fakeDevice(store);
  const engine = createLockEngine({ store, send: device.send, locks: () => [] });
  device.attach(engine);
  const r = await engine.takeOnly([{ id: 'S1', layer: '2' }]);
  assert.equal(r.ok, false);
  assert.match(r.message, /take is in flight/);
  assert.equal(device.sent.length, 0);
});

/* -------------------------------------------------------------- the hook */

function loadHook() {
  const code = readFileSync(join(here, '..', 'src', 'hook', 'ws-hook.js'), 'utf8');
  const sent = [];
  class FakeSocket {
    constructor() { this.readyState = 1; this.listeners = {}; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    send(data) { sent.push(data); }
  }
  const window = { WebSocket: FakeSocket, dispatchEvent() {} };
  const context = vm.createContext({ window, CustomEvent: class { constructor(t) { this.type = t; } }, console, setTimeout, clearTimeout });
  vm.runInContext(code, context);
  const socket = new window.WebSocket('ws://x');
  return { hook: window.__WRU_HOOK, socket, sent };
}

test('the hook sends a held frame when the gate releases it, once', () => {
  const { hook, socket, sent } = loadHook();
  let release = null;
  hook.setGate((raw, r) => { if (raw.includes('xTake')) { release = r; return true; } return false; });
  socket.send(takeFrame());
  assert.equal(sent.length, 0, 'held');
  release();
  release();
  assert.equal(sent.length, 1, 'sent once, however often it is released');
  socket.send(JSON.stringify({ channel: 'DEVICE', data: { path: ['device', 'y'], value: 2 } }));
  assert.equal(sent.length, 2, 'anything the gate declines goes straight out');
});

test('the hook sends a held frame itself if the gate never releases it', async () => {
  const { hook, socket, sent } = loadHook();
  hook.setGate(() => true);
  socket.send(takeFrame());
  assert.equal(sent.length, 0);
  await sleep(800);
  assert.equal(sent.length, 1, 'a bug in a gate may delay a take, never swallow one');
});

test('a gate that throws lets the frame through', () => {
  const { hook, socket, sent } = loadHook();
  const quiet = console.error;
  console.error = () => {};
  try {
    hook.setGate(() => { throw new Error('boom'); });
    socket.send(takeFrame());
  } finally { console.error = quiet; }
  assert.equal(sent.length, 1);
});
