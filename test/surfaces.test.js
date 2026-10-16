/*
 * Surfaces: LED elements as rectangles on a screen's canvas, and layers bound
 * to them kept inside.
 *
 * What is pinned here, each the quiet way to get it wrong:
 *
 * - **The rule** (`constrain`): a move stops at the edge; a resize keeps the
 *   edge that was not dragged; a keep-ratio drag keeps its shape; the whole
 *   canvas, and the full-screen button, mean the whole surface; an alignment
 *   is redone against the surface; and a request already inside comes back
 *   untouched, not re-rounded by half a pixel.
 * - **The shaper**: a whole drag step is shaped as one, writes to anything
 *   else are the same objects, a property the rule had to move is added
 *   after that layer's last write, and a locked layer is left to the lock.
 * - **The hook**: shaped frames are held for one microtask and no longer,
 *   an unrelated frame flushes them first so order holds, and a shaper that
 *   throws or drops frames has the run sent as it came.
 * - **The follower**: preview only, never program, nothing mid-take, nothing
 *   on found state, and a layer something keeps moving out is let go.
 * - **The outlines**: between the layers and the handles, over a Pixel Map,
 *   taking no pointer — and the two overlays never move each other.
 *
 * The store is a cut of the 6.2.73 simulator's: S1 is 1920×1080, program B
 * holds layer 1 full screen, preview A holds it 960×960 in the middle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

import { DeviceStore } from '../src/core/device-store.js';
import { NLC } from '../src/core/dialect.js';
import { manifestOf } from '../src/core/plugins.js';
import { createProgrammer, EDIT } from '../src/core/programmer.js';
import {
  normalise, addSurface, updateSurface, removeSurface, bind, boundSurface, fromOutputs,
  constrain, shapeWrites, parseGeometry, rectFromWire, OPS, EMPTY
} from '../plugins/surfaces/core.js';
import { createSurfaceEngine, FIGHT_LIMIT, FOLLOW_DEBOUNCE_MS, TELL_MS } from '../plugins/surfaces/engine.js';
import { install } from './helpers/fake-dom.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

function merge(a, b) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
  return out;
}

function simStore() {
  const s = new DeviceStore();
  s.hydrate(['sim-6.2.73-identity.json', 'sim-6.2.73-screens.json', 'sim-6.2.73-destinations.json']
    .map(fixture).reduce(merge, {}));
  return s;
}

const LEFT = { id: '1', name: 'LED left', x: 0, y: 0, width: 960, height: 1080 };
const RIGHT = { id: '2', name: 'LED right', x: 960, y: 0, width: 960, height: 1080 };
const CANVAS = { width: 1920, height: 1080 };
const doc = (bindings = { S1: { 1: '1' } }) => normalise({ surfaces: { S1: [LEFT, RIGHT] }, bindings });

const base = (buffer, layer = '1') =>
  ['device', 'screenList', 'items', 'S1', 'presetList', 'items', buffer, 'layerList', 'items', layer, 'position', 'pp'];
const w = (buffer, prop, value, layer = '1') => ({ path: [...base(buffer, layer), prop], value });
const frame = (cmd) => JSON.stringify({ channel: 'DEVICE', data: { path: cmd.path, value: cmd.value } });
const valuesOf = (cmds) => Object.fromEntries(cmds.map((c) => [c.path[12], c.value]));

/* ------------------------------------------------------------ document */

test('a stored document is corrected rather than refused', () => {
  const d = normalise({
    visible: false,
    surfaces: {
      S1: [LEFT, { id: '1', name: 'dupe', x: 0, y: 0, width: 5, height: 5 }, { id: 'x', x: 0, y: 0, width: 1, height: 1 },
        { id: '3', x: 0, y: 0, width: 0, height: 10 }, { id: '4', x: '10', y: 20.4, width: '30', height: 40, name: '  ' }],
      Q9: [LEFT]
    },
    bindings: { S1: { 1: '1', 2: '9', NATIVE: '1', 3: '4' }, S2: { 1: '1' } }
  });
  assert.equal(d.visible, false);
  assert.deepEqual(Object.keys(d.surfaces), ['S1'], 'only screens and auxiliaries');
  assert.deepEqual(d.surfaces.S1.map((s) => s.id), ['1', '4'], 'no duplicate ids, no bad ids, no empty rectangles');
  assert.deepEqual(d.surfaces.S1[1], { id: '4', name: 'Surface 4', x: 10, y: 20, width: 30, height: 40 });
  assert.deepEqual(d.bindings, { S1: { 1: '1', 3: '4' } }, 'no binding to a missing surface, none for NATIVE, none without surfaces');
  assert.deepEqual(normalise(null), { ...EMPTY });
});

test('surfaces are added with the next free id, changed, and removed with their bindings', () => {
  let d = normalise(null);
  ({ doc: d } = addSurface(d, 'S1', { name: 'A', x: 0, y: 0, width: 100, height: 100 }));
  const added = addSurface(d, 'S1', { name: 'B', x: 100, y: 0, width: 100, height: 100 });
  d = added.doc;
  assert.equal(added.surface.id, '2');
  d = bind(d, 'S1', '3', '2');
  assert.equal(boundSurface(d, 'S1', 3).name, 'B');
  d = updateSurface(d, 'S1', '2', { width: 0 });
  assert.equal(d.surfaces.S1[1].width, 100, 'a change that would make it invalid is not made');
  d = updateSurface(d, 'S1', '2', { name: 'Right', x: 140 });
  assert.equal(boundSurface(d, 'S1', '3').x, 140);
  d = removeSurface(d, 'S1', '2');
  assert.equal(boundSurface(d, 'S1', '3'), null);
  assert.deepEqual(d.bindings, {});
  ({ doc: d } = addSurface(d, 'S1', {}));
  assert.equal(d.surfaces.S1[1].id, '2', 'ids are numbers after the highest left');
});

test('one surface per output feeding the screen, where each sits on its canvas', () => {
  const outputs = [
    { n: 2, label: '', x: 960, y: 0, cw: 960, ch: 1080, screen: 'S1' },
    { n: 1, label: 'Stage left', x: 0, y: 0, cw: 960, ch: 1080, screen: 'S1' },
    { n: 3, label: 'IMAG', x: 0, y: 0, cw: 1920, ch: 1080, screen: 'S2' },
    { n: 4, label: 'off', x: 0, y: 0, cw: 0, ch: 0, screen: 'S1' }
  ];
  assert.deepEqual(fromOutputs(outputs, 'S1'), [
    { name: 'Stage left', x: 0, y: 0, width: 960, height: 1080 },
    { name: 'Output 2', x: 960, y: 0, width: 960, height: 1080 }
  ]);
});

/* ------------------------------------------------------------- the rule */

const S = { x: 1000, y: 0, width: 920, height: 1080 };
const was = { left: 1100, top: 100, width: 400, height: 300 };

test('a request already inside comes back as it came, half pixels and all', () => {
  const req = { left: 1100.5, top: 100, width: 401, height: 300 };
  assert.equal(constrain(req, S, { before: was }), req);
});

test('a move stops at the edge it would cross', () => {
  assert.deepEqual(constrain({ ...was, left: 1700 }, S, { before: was }), { left: 1520, top: 100, width: 400, height: 300 });
  assert.deepEqual(constrain({ ...was, left: 700, top: -50 }, S, { before: was }), { left: 1000, top: 0, width: 400, height: 300 });
});

test('a resize keeps the edge that was not dragged and stops the dragged one at the surface', () => {
  assert.deepEqual(constrain({ ...was, width: 1000 }, S, { before: was }), { left: 1100, top: 100, width: 820, height: 300 },
    'right edge out: the left edge stays');
  assert.deepEqual(constrain({ ...was, left: 600, width: 900 }, S, { before: was }), { left: 1000, top: 100, width: 500, height: 300 },
    'left edge out: the right edge stays');
});

test('a keep-ratio corner drag stops with its shape', () => {
  const r = constrain({ left: 1100, top: 100, width: 1600, height: 1200 }, S, { before: was });
  assert.equal(r.left, 1100);
  assert.equal(r.top, 100);
  assert.equal(r.width, 820);
  assert.equal(r.height, 615);
});

test('the whole canvas, and the full-screen button, mean the whole surface', () => {
  const fill = { left: 1000, top: 0, width: 920, height: 1080 };
  assert.deepEqual(constrain({ left: 0, top: 0, width: 1920, height: 1080 }, S, { before: was, canvas: CANVAS }), fill);
  assert.deepEqual(constrain(was, S, { op: OPS['set-layer-to-fullscreen-18'] }), fill);
});

test('an alignment is redone against the surface', () => {
  const mid = constrain({ left: 760, top: 390, width: 400, height: 300 }, S, { op: OPS['align-screen-middle-18'] });
  assert.deepEqual(mid, { left: 1260, top: 390, width: 400, height: 300 }, 'centred on the surface, not pushed to its edge');
  assert.equal(constrain(was, S, { op: OPS['align-screen-vertical-center-18'] }).left, 1260, 'the vertical centre line is a horizontal centring');
  assert.equal(constrain(was, S, { op: OPS['align-screen-vertical-center-18'] }).top, 100);
  assert.equal(constrain(was, S, { op: OPS['align-screen-horizontal-center-18'] }).top, 390);
  assert.deepEqual(constrain({ ...was, left: 0 }, S, { op: OPS['align-screen-bottom-right-18'] }), { left: 1520, top: 780, width: 400, height: 300 });
});

test('a layer bigger than its surface with no history is fitted keeping its shape', () => {
  assert.deepEqual(constrain({ left: 0, top: 0, width: 1920, height: 1200 }, S),
    { left: 1000, top: 313, width: 920, height: 575 });
});

/* ------------------------------------------------------------ the shaper */

function reader(store, extra = {}) {
  return (path) => (path.join('/') in extra ? extra[path.join('/')] : store.get(path));
}

test('the vendor’s full screen on a bound layer fills its surface, in the writes it sent', () => {
  const store = simStore();
  const cmds = [w('A', 'posH', 960), w('A', 'posV', 540), w('A', 'sizeH', 1920), w('A', 'sizeV', 1080)];
  const out = shapeWrites(cmds, { doc: doc(), read: reader(store), canvasOf: () => CANVAS });
  assert.equal(out.length, 4, 'nothing added: every property was written');
  assert.deepEqual(out.map((c) => c.path[12]), ['posH', 'posV', 'sizeH', 'sizeV'], 'in the order sent');
  assert.deepEqual(valuesOf(out), { posH: 480, posV: 540, sizeH: 960, sizeV: 1080 });
});

test('one size written alone brings the position it had to move with it, after it', () => {
  const store = simStore();
  /* Preview A: 960×960 centred at 960 — already outside LEFT, so widen it. */
  const out = shapeWrites([w('A', 'sizeH', 1200), { path: ['device', 'x'], value: 1 }], {
    doc: doc(), read: reader(store)
  });
  assert.deepEqual(out.map((c) => c.path.at(-1)), ['sizeH', 'posH', 'x'], 'the position straight after the size, before the next write');
  assert.equal(out[0].value, 960, 'no wider than LED left — and not a sliver: it straddled both surfaces');
  const rect = rectFromWire({ anchor: 'MIDDLE_CENTER', posH: out[1].value, posV: 540, sizeH: out[0].value, sizeV: 960 });
  assert.ok(rect.left >= 0 && rect.left + rect.width <= 960, `inside LED left: ${JSON.stringify(rect)}`);
});

test('writes to anything else are the same objects; unbound, locked and in-bounds layers are untouched', () => {
  const store = simStore();
  const other = { path: ['device', 'screenAuxGroupList', 'control', 'pp', 'xUpdate'], value: true };
  const unbound = w('A', 'posH', 5000, '2');
  const cmds = [other, unbound];
  assert.equal(shapeWrites(cmds, { doc: doc(), read: reader(store) }), cmds, 'nothing bound in the run: the same array');
  const locked = [w('A', 'posH', 5000)];
  assert.equal(shapeWrites(locked, { doc: doc(), read: reader(store), exempt: () => true }), locked);
  const fine = [w('A', 'posH', 480), w('A', 'sizeH', 960)];
  const out = shapeWrites(fine, { doc: doc(), read: reader(store, { [[...base('A'), 'sizeV'].join('/')]: 960 }) });
  assert.equal(out[0], fine[0]);
  assert.equal(out[1], fine[1]);
});

test('a bound layer is kept in on every buffer: program, the third letter and the programmer', () => {
  const store = simStore();
  for (const buffer of ['B', 'C', EDIT]) {
    const out = shapeWrites([w(buffer, 'posH', 1500)], {
      doc: doc(), read: (p) => ({ anchor: 'MIDDLE_CENTER', posH: 480, posV: 540, sizeH: 400, sizeV: 300 })[p[12]]
    });
    assert.equal(out[0].value, 760, `${buffer}: right edge on LED left’s`);
  }
  assert.equal(parseGeometry([...base('A'), 'opacity']), null);
});

test('an anchor that is not the centre is honoured both ways', () => {
  const read = (p) => ({ anchor: 'TOP_LEFT', posH: 100, posV: 100, sizeH: 400, sizeV: 300 })[p[12]];
  const out = shapeWrites([w('A', 'posH', 900)], { doc: doc(), read });
  assert.equal(out[0].value, 560, 'the left edge, which is what TOP_LEFT positions');
  const br = (p) => ({ anchor: 'BOTTOM_RIGHT', posH: 500, posV: 400, sizeH: 400, sizeV: 300 })[p[12]];
  const out2 = shapeWrites([w('A', 'posH', 1500)], { doc: doc(), read: br });
  assert.equal(out2[0].value, 960, 'the right edge, on LED left’s');
});

/* ------------------------------------------------------------ the engine */

function fakeClock() {
  let t = 1000;
  const timers = new Map();
  let next = 1;
  return {
    now: () => t,
    setTimeout(fn, ms) { const id = next++; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    tick(ms) {
      t += ms;
      for (const [id, tm] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (tm.at <= t && timers.has(id)) { timers.delete(id); tm.fn(); }
      }
    }
  };
}

function rig({ bindings, exempt } = {}) {
  const store = simStore();
  const clock = fakeClock();
  const sent = [];
  const told = [];
  let d = doc(bindings);
  const engine = createSurfaceEngine({
    store, doc: () => d, exempt, clock,
    send: (cmd) => { sent.push(cmd); store.set(cmd.path, cmd.value); return true; },
    tellPage: (raw) => { told.push(JSON.parse(raw).data); return true; }
  });
  const arrive = (cmd) => { store.set(cmd.path, cmd.value); engine.onFrame({ ...cmd, dir: 'in' }); };
  return { store, clock, sent, told, engine, arrive, setDoc: (x) => { d = x; } };
}

test('the hook is asked only about geometry of a bound layer', () => {
  const { engine } = rig();
  assert.equal(engine.wants(frame(w('A', 'posH', 100))), true);
  assert.equal(engine.wants(frame(w('A', 'posH', 100, '2'))), false, 'layer 2 is not bound');
  assert.equal(engine.wants(frame({ path: [...base('A').slice(0, 10), 'opacity', 'pp', 'opacity'], value: 100 })), false, 'not geometry');
  assert.equal(engine.wants('{"channel":"DEVICE","data":{"path":["device","screenAuxGroupList","items","S1","control","pp","xTake"],"value":true}}'), false);
  assert.equal(engine.wants('not json "position" "presetList"'), false);
  const locked = rig({ exempt: () => true });
  assert.equal(locked.engine.wants(frame(w('A', 'posH', 100))), false, 'a locked layer is the lock’s');
});

test('a frame the shaper leaves alone goes out byte for byte; a changed one is re-encoded', () => {
  const { engine } = rig();
  const raws = [frame(w('A', 'posV', 540)), frame(w('A', 'posH', 1500))];
  const out = engine.shape(raws);
  assert.equal(out[0], raws[0]);
  assert.notEqual(out[1], raws[1]);
  assert.equal(JSON.parse(out[1]).data.value, 480, 'a 960-wide layer can only sit at 480 in LED left');
  assert.equal(engine.recent()[0].kind, 'kept');
});

test('a rewritten value is told back to the page after its own write lands, while the switcher still holds it', () => {
  const { engine, clock, told, store } = rig();
  const out = engine.shape([frame(w('A', 'posH', 1500)), frame(w('A', 'posV', 540))]);
  const kept = JSON.parse(out[0]).data;
  store.set(kept.path, kept.value);           // the mirror takes what went out
  assert.equal(told.length, 0, 'not at once: the vendor applies its own write a few ms after sending it');
  clock.tick(TELL_MS[0]);
  assert.deepEqual(told.map((t) => [t.path[12], t.value]), [['posH', 480]], 'only the value the shaper changed');
  clock.tick(TELL_MS[1]);
  assert.equal(told.length, 2, 'and once more, for a busy machine');

  engine.shape([frame(w('A', 'posH', 1500))]);
  store.set([...base('A'), 'posH'], 200);     // something newer arrived meanwhile
  clock.tick(TELL_MS[1]);
  assert.equal(told.length, 2, 'never talks over a newer value');
});

test('a toolbar alignment pressed just now is redone against the surface', () => {
  const { engine, clock } = rig();
  /* Preview A layer 1, shrunk first so there is room to align in. */
  const raws = [frame(w('A', 'sizeH', 400)), frame(w('A', 'sizeV', 300)), frame(w('A', 'posH', 200)), frame(w('A', 'posV', 150))];
  engine.shape(raws);
  engine.setIntent(OPS['align-screen-middle-18']);
  const out = engine.shape([frame(w('A', 'posH', 960)), frame(w('A', 'posV', 540))]).map((r) => JSON.parse(r).data.value);
  assert.deepEqual(out, [480, 540], 'the middle of LED left, where clamping alone would have said 760');
  clock.tick(1);
  const later = engine.shape([frame(w('A', 'posH', 960))]).map((r) => JSON.parse(r).data.value);
  assert.deepEqual(later, [760], 'the intent ends with its task: a later write is only kept in');
});

test('the follower pulls a bound layer back in on preview, once the frames settle', () => {
  const { engine, arrive, clock, sent, store } = rig();
  arrive(w('A', 'sizeH', 400));
  arrive(w('A', 'sizeV', 300));
  arrive(w('A', 'posH', 1500));
  assert.equal(sent.length, 0, 'nothing before the burst has settled');
  clock.tick(FOLLOW_DEBOUNCE_MS);
  assert.deepEqual(sent.map((c) => [c.path[6], c.path[12], c.value]), [['A', 'posH', 760]]);
  assert.equal(store.get([...base('A'), 'posH']), 760);
  assert.equal(engine.recent()[0].kind, 'pulled');
  clock.tick(FOLLOW_DEBOUNCE_MS);
  assert.equal(sent.length, 1, 'convergent: the second look finds nothing');
});

test('the follower never touches program, and program out of bounds is reported', () => {
  const { engine, arrive, clock, sent } = rig();
  arrive(w('B', 'posH', 1500));
  clock.tick(FOLLOW_DEBOUNCE_MS);
  assert.equal(sent.length, 0);
  const out = engine.outside().map((x) => `${x.id}/${x.layer}/${x.role}`);
  assert.ok(out.includes('S1/1/PGM'), 'B is program, and full screen is outside LED left');
});

test('the follower does nothing on found state, mid-take, or on a locked layer', () => {
  const found = rig();
  found.clock.tick(1000);
  assert.equal(found.sent.length, 0, 'preview A is outside LED left in the capture, and nobody changed anything');

  const mid = rig();
  mid.store.set(NLC.takeStatus('S1', 'transition'), 'EFFECT_FROM_UP');
  mid.arrive(w('A', 'posH', 1500));
  mid.clock.tick(FOLLOW_DEBOUNCE_MS);
  assert.equal(mid.sent.length, 0);

  const locked = rig({ exempt: () => true });
  locked.arrive(w('A', 'posH', 1500));
  locked.clock.tick(FOLLOW_DEBOUNCE_MS);
  assert.equal(locked.sent.length, 0);
});

test('a layer something keeps moving out is let go, not fought over, until its binding changes', () => {
  const { engine, arrive, clock, sent, setDoc } = rig();
  for (let i = 0; i < FIGHT_LIMIT + 2; i++) {
    arrive(w('A', 'posH', 1500));
    clock.tick(FOLLOW_DEBOUNCE_MS);
  }
  assert.equal(sent.length, FIGHT_LIMIT, `${FIGHT_LIMIT} corrections of one write each, then no more`);
  assert.deepEqual(engine.letGo(), ['S1/1']);
  assert.equal(engine.recent()[0].kind, 'let-go');
  setDoc(bind(doc(), 'S1', '1', '2'));
  engine.reset();
  assert.deepEqual(engine.letGo(), []);
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

const shapedFrame = (n) => JSON.stringify({ channel: 'DEVICE', data: { path: ['device', 'shape', String(n)], value: n } });
const plainFrame = (n) => JSON.stringify({ channel: 'DEVICE', data: { path: ['device', 'plain', String(n)], value: n } });
const tick = () => new Promise((r) => setImmediate(r));

test('the hook holds what the shaper wants until the task ends, then sends what it made of it', async () => {
  const { hook, socket, sent } = loadHook();
  const runs = [];
  hook.setShaper({
    wants: (raw) => raw.includes('"shape"'),
    shape: (raws) => { runs.push(raws.length); return [...raws.map((r) => r.replace('"value":', '"value":1')), plainFrame(99)]; }
  });
  socket.send(shapedFrame(1));
  socket.send(shapedFrame(2));
  assert.equal(sent.length, 0, 'held');
  await tick();
  assert.deepEqual(runs, [2], 'one run, both frames');
  assert.equal(sent.length, 3, 'what the shaper made of them, additions included');
  assert.equal(JSON.parse(sent[0]).data.value, 11);
});

test('a frame the shaper does not want flushes the held run first, and goes out at once', () => {
  const { hook, socket, sent } = loadHook();
  hook.setShaper({ wants: (raw) => raw.includes('"shape"'), shape: (raws) => raws });
  socket.send(shapedFrame(1));
  socket.send(plainFrame(2));
  assert.deepEqual(sent.map((r) => JSON.parse(r).data.value), [1, 2], 'in order, synchronously');
  assert.equal(hook.send(shapedFrame(3)), true, 'our own sends are shaped too');
  hook.send(shapedFrame(4));
  assert.equal(sent.length, 2, 'held');
  hook.send(plainFrame(5));
  assert.deepEqual(sent.map((r) => JSON.parse(r).data.value).slice(2), [3, 4, 5]);
});

test('a shaper that throws, or drops a frame, has the run sent as it came', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const shape of [() => { throw new Error('boom'); }, () => [], () => 'nonsense']) {
      const { hook, socket, sent } = loadHook();
      hook.setShaper({ wants: () => true, shape });
      socket.send(shapedFrame(1));
      socket.send(shapedFrame(2));
      await tick();
      assert.deepEqual(sent.map((r) => JSON.parse(r).data.value), [1, 2]);
    }
  } finally { console.error = quiet; }
});

test('the hook can hand the page a frame as if the switcher had sent it, and sends nothing', () => {
  const code = readFileSync(join(here, '..', 'src', 'hook', 'ws-hook.js'), 'utf8');
  const sent = [];
  const heard = [];
  class FakeSocket {
    constructor() { this.readyState = 1; this.listeners = {}; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    dispatchEvent(ev) { for (const fn of this.listeners[ev.type] || []) fn(ev); return true; }
    send(data) { sent.push(data); }
  }
  class MessageEvent { constructor(type, init) { this.type = type; this.data = init.data; } }
  const window = { WebSocket: FakeSocket, dispatchEvent() {} };
  vm.runInContext(code, vm.createContext({ window, MessageEvent, CustomEvent: class { constructor(t) { this.type = t; } }, console, setTimeout, clearTimeout }));
  const hook = window.__WRU_HOOK;
  const socket = new window.WebSocket('ws://x');
  assert.equal(hook.tellPage(plainFrame(1)), false, 'no app socket yet');
  socket.addEventListener('message', (ev) => heard.push(ev.data));
  socket.send(plainFrame(0));
  assert.equal(hook.tellPage(plainFrame(7)), true);
  assert.deepEqual(heard, [plainFrame(7)], 'the page’s own listeners hear it');
  assert.equal(hook.ring.at(-1).dir, 'in', 'and so does the mirror, as an echo');
  assert.equal(sent.length, 1, 'nothing more went to the switcher');
  assert.equal(hook.tellPage('not a frame'), false);
});

test('shaped frames still pass the take gate', async () => {
  const { hook, socket, sent } = loadHook();
  const seen = [];
  hook.setGate((raw) => { seen.push(raw); return false; });
  hook.setShaper({ wants: (raw) => raw.includes('"shape"'), shape: (raws) => raws });
  socket.send(shapedFrame(1));
  await tick();
  assert.equal(seen.length, 1);
  assert.equal(sent.length, 1);
});

/* ------------------------------------------------------------- the Edit page */

test('the programmer shapes a run before it lands, and still lands it without a shaper', () => {
  const store = simStore();
  const d = doc();
  let shapedRuns = 0;
  const programmer = createProgrammer({
    session: { store, send: () => true },
    shape: (cmds, read) => { shapedRuns++; return shapeWrites(cmds, { doc: d, read }); }
  });
  assert.ok(programmer.seed('S1', 'PREVIEW'));
  const n = programmer.sendMany([w(EDIT, 'sizeH', 400), w(EDIT, 'sizeV', 300), w(EDIT, 'posH', 1500), w(EDIT, 'posV', 540)]);
  assert.equal(n, 4);
  assert.equal(shapedRuns, 1, 'one run, not four');
  assert.equal(programmer.store.get([...base(EDIT), 'posH']), 760);
  assert.equal(store.get([...base(EDIT), 'posH']), undefined, 'nothing reached the device');

  const plain = createProgrammer({ session: { store, send: () => true } });
  plain.seed('S1', 'PREVIEW');
  assert.equal(plain.send(w(EDIT, 'posH', 1500)), true);
  assert.equal(plain.store.get([...base(EDIT), 'posH']), 1500);
});

/* ------------------------------------------------------------ the outlines */

/** One screen card as Web RCS 6.2.73 draws it, PGM above PRW — as in the Pixel Map tests. */
function card(doc, id, { selected = false } = {}) {
  const el = (tag, cls, ...kids) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    for (const k of kids) n.append(k);
    return n;
  };
  const buffer = (role) => {
    const layers = el('div', '', el('div', 'aw-absolute', el('div', 'canvas-item-module__c___Xx1 aw-relative')));
    const stack = el('div', 'aw-full-width-height aw-absolute', layers,
      ...(selected ? [el('div', '', el('div', 'aw-absolute aw-cursor-ns-resize'))] : []));
    const raster = el('div', 'aw-absolute aw-background-black', el('div', 'aw-relative aw-full-width-height', stack));
    raster.setAttribute('style', 'left: 24px; top: 70px; width: 203px; height: 114px;');
    const zoom = el('div', 'react-transform-component transform-component-module_content__Zz9',
      el('div', 'aw-full-width-height', el('div', 'aw-relative aw-full-width-height', raster)));
    const label = el('button', 'ui button');
    label.textContent = role;
    return el('div', 'aw-flex-row screen-overview-container__c__preset___Qq7',
      el('div', 'live-content-header__c___Hh2', label),
      el('div', 'preset-overview-container__c__canvas___Cc3', el('div', 'react-transform-wrapper', zoom)));
  };
  const h2 = el('h2');
  h2.textContent = id;
  return el('div', 'aw-preset-view', h2, buffer('PGM'), buffer('PRW'));
}

test('the outlines sit over a Pixel Map and under the handles, take no pointer, and say which layer is out', async () => {
  const dom = install();
  try {
    const { installSurfaceOutlines, MARK } = await import('../plugins/surfaces/overlay.js');
    const { installPixelMaps, MARK: MAP } = await import('../plugins/pixel-map/overlay.js');
    dom.doc.body.append(card(dom.doc, 'S1', { selected: true }));
    /* The panel's own section for S1, which once carried the overlay's mark
       as a data attribute and was swept away as a stray outline. */
    const section = dom.doc.createElement('div');
    section.setAttribute(MARK, 'S1');
    dom.doc.body.append(section);
    const outside = { PGM: new Map([['1', 'L1 outside']]), PRW: new Map() };
    const outlines = installSurfaceOutlines({
      plan: () => new Map([['S1', { canvas: CANVAS, surfaces: [LEFT, RIGHT], outside }]]),
      doc: dom.doc
    });
    outlines.sweepNow();
    const map = installPixelMaps({
      plan: () => new Map([['S1', { image: { file: '/x.png', thumb: '/t.png' }, place: { left: 0, top: 0, width: 100, height: 100 }, blend: 'multiply', opacity: 1 }]]),
      roles: () => ['PGM', 'PRW'],
      doc: dom.doc
    });
    map.sweepNow();
    outlines.sweepNow();
    map.sweepNow();

    const prw = dom.doc.querySelector(`[${MARK}="S1/PRW"]`);
    const stack = prw.parentElement;
    const order = stack.children.map((c) => (c.hasAttribute(MAP) ? 'map' : c.hasAttribute(MARK) ? 'surfaces' : 'vendor'));
    assert.deepEqual(order, ['vendor', 'map', 'surfaces', 'vendor'], 'layers, map, outlines, handles');
    assert.equal(prw.style.pointerEvents, 'none');
    assert.equal(prw.getAttribute('aria-hidden'), 'true');
    assert.equal(prw.children.length, 2);
    assert.equal(prw.children[1].style.left, '50%');
    assert.equal(prw.children[1].style.width, '50%');

    const pgm = dom.doc.querySelector(`[${MARK}="S1/PGM"]`);
    assert.match(pgm.children[0].textContent, /LED left · L1 outside/);
    assert.match(pgm.children[0].style.border, /#FF5252|rgb\(255, 82, 82\)/i);

    /* Settled: more sweeps from either move nothing. */
    const before = stack.children.slice();
    outlines.sweepNow(); map.sweepNow(); outlines.sweepNow();
    assert.deepEqual(stack.children, before);
    assert.deepEqual(outlines.describe(), { cards: 1, blocks: 2, rasters: 2, drawn: 2, between: 2, top: 0 });
    assert.ok(section.parentNode, 'a node of somebody else’s with the same attribute is not an outline');
    outlines.stop();
    map.stop();
    assert.equal(dom.doc.querySelectorAll(`[${MARK}]`).length, 1, 'only the panel’s section is left');
  } finally {
    dom.uninstall();
  }
});

test('a press on the vendor’s full-screen or align button is read by its icon', async () => {
  const dom = install();
  try {
    const { opFromEvent } = await import('../plugins/surfaces/client.js');
    const button = dom.doc.createElement('button');
    const svg = dom.doc.createElement('svg');
    const use = dom.doc.createElement('use');
    use.setAttribute('xlink:href', '#align-screen-middle-18');
    svg.append(use);
    button.append(svg);
    dom.doc.body.append(button);
    assert.equal(opFromEvent({ target: svg }), OPS['align-screen-middle-18']);
    use.setAttribute('xlink:href', '#set-layer-to-fullscreen-18');
    assert.equal(opFromEvent({ target: button }), OPS['set-layer-to-fullscreen-18']);
    use.setAttribute('xlink:href', '#locked-18');
    assert.equal(opFromEvent({ target: button }), null);
  } finally {
    dom.uninstall();
  }
});

test('the plugin is off until it has met a frame, and asks only for screens', () => {
  const m = manifestOf('surfaces');
  assert.equal(m.enabledByDefault, false);
  assert.deepEqual(m.requires.capabilities, ['screens']);
});
