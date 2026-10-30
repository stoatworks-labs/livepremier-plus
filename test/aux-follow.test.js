/*
 * Aux follow: the model and the follower.
 *
 * The store is the gang tests' shape (`groups.test.js`) with an aux beside the
 * screens, and the same load-bearing property: **the screen and the aux are on
 * opposite transitions**, so program is letter B on S1 and letter A on A1.
 * Every role assertion below would pass by accident on a store where they
 * agreed. The aux's subtree is LivePremier's — `auxiliaryList/…/presetList`,
 * with the take state in `screenAuxGroupList` beside the screens'.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeviceStore } from '../src/core/device-store.js';
import {
  normalise, followOf, setFollow, followKey, describe, sourceIn, createFollower, VERSION
} from '../plugins/aux-follow/core.js';

function destination({ transition, layers, sources = {} }) {
  const layerList = { itemKeys: layers, items: {} };
  for (const key of layers) layerList.items[key] = { status: { pp: { capability: '4K' } } };
  const presetList = { itemKeys: ['A', 'B', 'C'], items: {} };
  for (const letter of ['A', 'B', 'C']) {
    const items = {};
    for (const key of layers) items[key] = { source: { pp: { inputNum: (sources[letter] || {})[key] || 'NONE' } } };
    presetList.items[letter] = { layerList: { itemKeys: layers, items } };
  }
  return {
    group: {
      control: { pp: { presetUp: 'B', presetDown: 'A', presetPrevious: 'C' } },
      status: { pp: { isUsed: true, transition } }
    },
    node: {
      control: { pp: { label: '' } },
      status: { pp: { mode: 'FREESTYLE', layerCount: layers.length }, size: { pp: { sizeH: 1920, sizeV: 1080 } } },
      layerList,
      presetList
    }
  };
}

function storeWith(spec) {
  const groups = { itemKeys: [], items: {} };
  const lists = { screenList: { itemKeys: [], items: {} }, auxiliaryList: { itemKeys: [], items: {} } };
  for (const [id, cfg] of Object.entries(spec)) {
    const built = destination(cfg);
    groups.itemKeys.push(id);
    groups.items[id] = built.group;
    const list = id.startsWith('A') ? lists.auxiliaryList : lists.screenList;
    list.itemKeys.push(id);
    list.items[id] = built.node;
  }
  const store = new DeviceStore();
  store.hydrate({ device: { screenAuxGroupList: groups, ...lists } });
  return store;
}

/*
 * S1 is `AT_UP`: program B, preview A. A1 is `AT_DOWN`: program A, preview B.
 * S1's layer 2 has LIVE_3 on program and LIVE_5 on preview.
 */
const desk = (over = {}) => storeWith({
  S1: { transition: 'AT_UP', layers: ['1', '2'], sources: { B: { 2: 'LIVE_3' }, A: { 2: 'LIVE_5' } }, ...(over.S1 || {}) },
  A1: { transition: 'AT_DOWN', layers: ['1', '2'], ...(over.A1 || {}) }
});

const screenPath = (letter, layer = '2') => `device/screenList/items/S1/presetList/items/${letter}/layerList/items/${layer}/source/pp/inputNum`;
const auxPath = (letter, layer = '1') => `device/auxiliaryList/items/A1/presetList/items/${letter}/layerList/items/${layer}/source/pp/inputNum`;
const transitionPath = (id) => `device/screenAuxGroupList/items/${id}/status/pp/transition`;
const P = (cmd) => cmd.path.join('/');

const follow = (mode = 'program') => ({ aux: 'A1', layer: '1', from: { id: 'S1', layer: '2' }, mode });

function rig(store, follows) {
  const sent = [];
  const activity = [];
  const list = Array.isArray(follows) ? follows : [follows];
  const follower = createFollower({
    store,
    follows: () => list,
    /* What the switcher would do: take the write and echo it. The echo is
       applied to the mirror, as `Session` applies an inbound frame. */
    send: (cmd) => { sent.push(cmd); store.set(cmd.path, cmd.value); return true; },
    onActivity: (n) => activity.push(n)
  });
  /* As the page does when the list is loaded or changed. */
  follower.prime();
  const frame = (path, value, dir = 'in') => {
    store.set(path.split('/'), value);
    return follower.onFrame({ path: path.split('/'), value, dir });
  };
  return { follower, sent, activity, frame, list };
}

/* -------------------------------------------------------------- the model */

test('a stored file is coerced rather than trusted', () => {
  const doc = normalise({
    follows: [
      { aux: ' a1 ', layer: 1, from: { id: 's1', layer: '2' }, mode: 'both' },
      { aux: 'A1', layer: '1', from: { id: 'S2', layer: '1' } },
      { aux: 'S1', layer: '1', from: { id: 'S2', layer: '1' } },
      { aux: 'A2', layer: '1', from: { id: 'A1', layer: '1' } },
      { aux: 'A2', layer: '1', from: { id: 'S2', layer: '1' }, mode: 'sideways' },
      null,
      'nonsense'
    ]
  });
  assert.equal(doc.version, VERSION);
  assert.deepEqual(doc.follows, [
    { aux: 'A1', layer: '1', from: { id: 'S1', layer: '2' }, mode: 'both' },
    { aux: 'A2', layer: '1', from: { id: 'S2', layer: '1' }, mode: 'program' }
  ], 'one leader per aux layer, auxes follow screens, never the other way, and an unknown mode is program');
  assert.deepEqual(normalise(null), { version: VERSION, follows: [] });
});

test('setting a follow replaces the one before it, and null takes it away', () => {
  let doc = normalise(null);
  doc = setFollow(doc, 'A1', '1', { id: 'S1', layer: '2' });
  doc = setFollow(doc, 'A1', '1', { id: 'S2', layer: '1' }, 'both');
  assert.equal(doc.follows.length, 1);
  assert.deepEqual(followOf(doc, 'A1', '1').from, { id: 'S2', layer: '1' });
  assert.equal(followOf(doc, 'A1', '1').mode, 'both');
  doc = setFollow(doc, 'A1', '1', null);
  assert.equal(followOf(doc, 'A1', '1'), null);
  assert.equal(followKey({ aux: 'A1', layer: '1' }), 'A1/1');
});

test('a source is read by role, on each end’s own letter', () => {
  const store = desk();
  assert.deepEqual(sourceIn(store, 'S1', '2', 'PROGRAM'), { value: 'LIVE_3', letter: 'B', settled: true });
  assert.deepEqual(sourceIn(store, 'A1', '1', 'PROGRAM'), { value: 'NONE', letter: 'A', settled: true });
  assert.equal(sourceIn(store, 'S1', '9', 'PROGRAM'), null);
  const d = describe(store, follow('both'));
  assert.deepEqual(d.roles.map((r) => [r.role, r.leader, r.aux, r.same]), [['PROGRAM', 'LIVE_3', 'NONE', false], ['PREVIEW', 'LIVE_5', 'NONE', false]]);
  assert.match(describe(store, { ...follow(), from: { id: 'S1', layer: '7' } }).why, /S1 has no layer 7/);
});

/* ----------------------------------------------------------- the follower */

test('setting a follow brings the aux’s program into line, and only its program', () => {
  const { follower, sent } = rig(desk(), follow());
  assert.equal(follower.sync(follow()), 1);
  assert.deepEqual(sent.map((c) => [P(c), c.value]), [[auxPath('A'), 'LIVE_3']], 'A1’s program is its letter A');
});

test('in both roles, setting a follow brings program and preview into line', () => {
  const { follower, sent } = rig(desk(), follow('both'));
  follower.sync(follow('both'));
  assert.deepEqual(sent.map((c) => [P(c), c.value]), [[auxPath('A'), 'LIVE_3'], [auxPath('B'), 'LIVE_5']]);
});

test('a program change on the screen cuts the aux’s program', () => {
  const { sent, frame } = rig(desk(), follow());
  frame(screenPath('B'), 'LIVE_7');
  assert.deepEqual(sent.map((c) => [P(c), c.value]), [[auxPath('A'), 'LIVE_7']]);
});

test('a preview change is not followed in program mode, and is in both', () => {
  const p = rig(desk(), follow());
  p.frame(screenPath('A'), 'LIVE_8');
  assert.deepEqual(p.sent, []);

  const b = rig(desk(), follow('both'));
  b.frame(screenPath('A'), 'LIVE_8');
  assert.deepEqual(b.sent.map((c) => [P(c), c.value]), [[auxPath('B'), 'LIVE_8']], 'preview to preview, on A1’s own preview letter');
});

test('the third buffer is neither role, so nothing follows from it', () => {
  const { sent, frame } = rig(desk(), follow('both'));
  frame(screenPath('C'), 'LIVE_9');
  assert.deepEqual(sent, []);
});

test('a take landing on the screen cuts the aux to what is now on program', () => {
  const { sent, frame } = rig(desk(), follow());
  /* AT_UP → AT_DOWN: program moves from B to A, which holds LIVE_5. */
  frame(transitionPath('S1'), 'AT_DOWN');
  assert.deepEqual(sent.map((c) => [P(c), c.value]), [[auxPath('A'), 'LIVE_5']]);
});

test('a take that leaves the layer’s program source as it was writes nothing', () => {
  const store = desk({ S1: { sources: { A: { 2: 'LIVE_3' }, B: { 2: 'LIVE_3' } } } });
  const { follower, sent, frame } = rig(store, follow());
  follower.sync(follow());
  sent.length = 0;
  frame(transitionPath('S1'), 'AT_DOWN');
  assert.deepEqual(sent, []);
});

test('a take is followed once it lands, never while it is moving', () => {
  const { sent, frame } = rig(desk(), follow());
  frame(transitionPath('S1'), 'EFFECT_FROM_UP');
  assert.deepEqual(sent, [], 'mid-take, nothing');
  frame(transitionPath('S1'), 'AT_DOWN');
  assert.deepEqual(sent.map((c) => [P(c), c.value]), [[auxPath('A'), 'LIVE_5']]);
});

test('a frame about the screen that is not a take writes nothing', () => {
  const { sent, frame } = rig(desk(), follow());
  frame('device/screenAuxGroupList/items/S1/control/pp/takeUpTime', 10);
  frame('device/screenAuxGroupList/items/S1/status/pp/transition', 'AT_UP');
  assert.deepEqual(sent, []);
});

test('mid-take on the aux, the write is owed and made when it lands', () => {
  const store = desk({ A1: { transition: 'EFFECT_FROM_DOWN' } });
  const { sent, activity, frame, follower } = rig(store, follow());
  frame(screenPath('B'), 'LIVE_7');
  assert.deepEqual(sent, []);
  assert.equal(activity.at(-1).kind, 'owed');
  assert.deepEqual(follower.owed(), [{ key: 'A1/1', roles: ['PROGRAM'] }]);
  /* A1 lands AT_UP: its program is now B. */
  frame(transitionPath('A1'), 'AT_UP');
  assert.deepEqual(sent.map((c) => [P(c), c.value]), [[auxPath('B'), 'LIVE_7']]);
  assert.deepEqual(follower.owed(), []);
});

test('an aux taken with the screen is left alone when it already agrees', () => {
  /* Both buffers of A1 agree with S1's: the same take on both ends needs nothing. */
  const store = desk({ A1: { sources: { A: { 1: 'LIVE_3' }, B: { 1: 'LIVE_5' } } } });
  const { sent, frame } = rig(store, follow('both'));
  frame(transitionPath('S1'), 'EFFECT_FROM_UP');
  frame(transitionPath('A1'), 'EFFECT_FROM_DOWN');
  frame(transitionPath('S1'), 'AT_DOWN');
  frame(transitionPath('A1'), 'AT_UP');
  assert.deepEqual(sent, [], 'S1 program A=LIVE_5 = A1 program B=LIVE_5; previews likewise');
});

test('in both roles, an aux left out of the take is put back in line', () => {
  const store = desk({ A1: { sources: { A: { 1: 'LIVE_3' }, B: { 1: 'LIVE_5' } } } });
  const { sent, frame } = rig(store, follow('both'));
  frame(transitionPath('S1'), 'AT_DOWN');
  assert.deepEqual(sent.map((c) => [P(c), c.value]), [[auxPath('A'), 'LIVE_5'], [auxPath('B'), 'LIVE_3']]);
});

test('this page’s own outbound frames are not the switcher’s state', () => {
  const { sent, frame } = rig(desk(), follow());
  frame(screenPath('B'), 'LIVE_7', 'out');
  assert.deepEqual(sent, []);
  frame(screenPath('B'), 'LIVE_7', 'in');
  assert.equal(sent.length, 1, 'the echo is what counts');
});

test('the echo of its own write, and a second page doing the same, write nothing more', () => {
  const store = desk();
  const one = rig(store, follow());
  const two = createFollower({ store, follows: () => [follow()], send: (cmd) => { one.sent.push(cmd); return true; } });
  one.frame(screenPath('B'), 'LIVE_7');
  two.onFrame({ path: screenPath('B').split('/'), value: 'LIVE_7', dir: 'in' });
  assert.equal(one.sent.length, 1, 'the second page finds the aux already in line');
  /* The aux's echo is not a leader's path: nothing. */
  one.frame(auxPath('A'), 'LIVE_7');
  assert.equal(one.sent.length, 1);
});

test('a leader layer the screen no longer has is refused by name', () => {
  const { follower, activity, sent } = rig(desk(), { ...follow(), from: { id: 'S1', layer: '9' } });
  follower.sync({ ...follow(), from: { id: 'S1', layer: '9' } });
  assert.deepEqual(sent, []);
  assert.match(activity.at(-1).why, /S1 has no layer 9/);
});

test('one screen layer may lead several aux layers', () => {
  const list = [follow(), { aux: 'A1', layer: '2', from: { id: 'S1', layer: '2' }, mode: 'program' }];
  const { sent, frame } = rig(desk(), list);
  frame(screenPath('B'), 'LIVE_7');
  assert.deepEqual(sent.map(P).sort(), [auxPath('A', '1'), auxPath('A', '2')].sort());
});

test('with no follows, a frame costs nothing and writes nothing', () => {
  const { follower, sent, frame } = rig(desk(), []);
  frame(screenPath('B'), 'LIVE_7');
  frame(transitionPath('S1'), 'AT_DOWN');
  assert.deepEqual(sent, []);
  assert.equal(follower.size(), 0);
});

test('primed, the first frame after the list changes is still seen as a landing', () => {
  /* The session applies a frame to the mirror before dispatching it, so an
     index built lazily on that frame would read the take state it brought. */
  const store = desk();
  let list = [];
  const sent = [];
  const follower = createFollower({ store, follows: () => list, send: (cmd) => { sent.push(cmd); return true; } });
  list = [follow()];
  follower.prime();
  store.set(transitionPath('S1').split('/'), 'AT_DOWN');
  follower.onFrame({ path: transitionPath('S1').split('/'), value: 'AT_DOWN', dir: 'in' });
  assert.deepEqual(sent.map((c) => c.value), ['LIVE_5']);
});

test('the index follows the list as it is edited', () => {
  const store = desk();
  let list = [];
  const sent = [];
  const follower = createFollower({ store, follows: () => list, send: (cmd) => { sent.push(cmd); return true; } });
  follower.onFrame({ path: screenPath('B').split('/'), value: 'LIVE_7', dir: 'in' });
  assert.equal(sent.length, 0);
  list = [follow()];
  store.set(screenPath('B').split('/'), 'LIVE_8');
  follower.onFrame({ path: screenPath('B').split('/'), value: 'LIVE_8', dir: 'in' });
  assert.deepEqual(sent.map((c) => c.value), ['LIVE_8']);
});

/* ---------------------------------------------------------------- the tab */

/*
 * A staged Follow is one click when it would not change the aux's program and
 * two when it would. On an Aquilon C mini (2026-10-30) the programs changed
 * after the row was drawn, the row was not drawn again, and one click cut the
 * aux's program on air. Both halves: the row redraws, and the click decides
 * again.
 */
test('a staged Follow that has become a cut since it was drawn asks again instead of cutting', async () => {
  const { install } = await import('./helpers/fake-dom.js');
  const { createAuxFollowPanel } = await import('../plugins/aux-follow/panel.js');
  const dom = install();
  try {
    let differs = false;
    const sets = [];
    const view = createAuxFollowPanel({
      doc: () => ({ version: 1, follows: [] }),
      set: (...a) => sets.push(a),
      auxes: () => [{ id: 'A1', label: '' }],
      layers: () => [{ key: '1', label: 'L1' }],
      leaders: () => [{ id: 'S1', layer: '1', label: 'S1 · L1' }],
      describe: () => ({ roles: [{ role: 'PROGRAM', same: !differs, aux: 'NONE', leader: differs ? 'LIVE_3' : 'NONE' }] }),
      sourceName: (v) => v, recent: () => [], owed: () => [], ready: () => true, platform: () => true
    });
    const picker = view.render().querySelectorAll('select').find((el) => el.getAttribute('aria-label') === 'A1 L1 follows');
    picker.value = 'S1/1';
    picker.dispatchEvent({ type: 'change' });
    const button = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);
    const stale = button(view.render(), 'Follow');
    assert.ok(stale, 'a one-click Follow while the programs agree');

    differs = true;
    assert.ok(button(view.render(), 'Follow'), 'drawn again: Follow, now the first of two');
    stale.click();
    assert.deepEqual(sets, [], 'the old button cuts nothing');
    const confirm = button(view.render(), 'Confirm — cuts to LIVE_3');
    assert.ok(confirm, 'it asks the second time instead');
    confirm.click();
    assert.equal(sets.length, 1, 'and the second click makes it');
  } finally {
    dom.uninstall();
  }
});
