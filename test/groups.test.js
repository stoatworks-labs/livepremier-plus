/*
 * Layer groups: the model, the fan-out and the gang.
 *
 * The synthetic store here is small on purpose but it is not arbitrary. Its
 * one load-bearing property is the thing a real desk does constantly and a
 * convenient fixture would not: **S1 and S2 are on opposite transitions**, so
 * program is letter B on one and letter A on the other. Every assertion about
 * roles below would pass by accident on a store where the two agreed, which
 * is exactly how a gang that copies letter to letter gets shipped.
 *
 * The shape of each subtree is the Aquilon C's own — `screenAuxGroupList`
 * carrying `presetUp`/`presetDown`/`transition`, `screenList/…/layerList`
 * carrying `status/pp/capability`, and the layer source at
 * `presetList/items/<L>/layerList/items/<n>/source/pp/inputNum` — and
 * `dialect.test.js` pins those paths against the real capture.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeviceStore } from '../src/core/device-store.js';
import { NLC, MNG } from '../src/core/dialect.js';
import {
  normalise, newId, addMember, memberKey, groupOf, resolveMembers,
  sourceSpec, sourceCommands, createGang, SETTLE_MS, PENDING_TTL, GROUPS_VERSION
} from '../src/core/groups.js';

/* ----------------------------------------------------------------- store */

/** One screen: which letters it is between, and which layer slots are real. */
function screen({ transition, layers, sources = {} }) {
  const layerList = { itemKeys: layers, items: {} };
  for (const key of layers) layerList.items[key] = { status: { pp: { capability: '4K' } } };

  const presetList = { itemKeys: ['A', 'B', 'C'], items: {} };
  for (const letter of ['A', 'B', 'C']) {
    const items = {};
    for (const key of layers) {
      items[key] = { source: { pp: { inputNum: (sources[letter] || {})[key] || 'NONE' } } };
    }
    presetList.items[letter] = { layerList: { itemKeys: layers, items } };
  }

  return {
    group: {
      control: { pp: { presetUp: 'B', presetDown: 'A', presetPrevious: 'C' } },
      status: { pp: { isUsed: true, transition } }
    },
    screen: {
      control: { pp: { label: '' } },
      status: { pp: { mode: 'FREESTYLE', layerCount: layers.length }, size: { pp: { sizeH: 1920, sizeV: 1080 } } },
      layerList,
      presetList
    }
  };
}

function storeWith(spec) {
  const groups = { itemKeys: [], items: {} };
  const screens = { itemKeys: [], items: {} };
  for (const [id, cfg] of Object.entries(spec)) {
    const built = screen(cfg);
    groups.itemKeys.push(id);
    groups.items[id] = built.group;
    screens.itemKeys.push(id);
    screens.items[id] = built.screen;
  }
  const store = new DeviceStore();
  store.hydrate({ device: { screenAuxGroupList: groups, screenList: screens, auxiliaryList: { itemKeys: [], items: {} } } });
  return store;
}

/*
 * S1 is `AT_UP`, so its program is B and its preview A.
 * S2 is `AT_DOWN`, so its program is A and its preview B.
 * The two are mirror images, which is the whole point.
 */
const desk = () => storeWith({
  S1: { transition: 'AT_UP', layers: ['1', '2'] },
  S2: { transition: 'AT_DOWN', layers: ['1'] },
  S3: { transition: 'AT_DOWN', layers: ['1'] }
});

const sides = () => ({
  id: 'g1', name: 'Sides', gang: true,
  members: [{ id: 'S1', layer: '2' }, { id: 'S2', layer: '1' }, { id: 'S3', layer: '1' }]
});

const P = (cmd) => cmd.path.join('/');
const layerPath = (id, letter, layer) =>
  `device/screenList/items/${id}/presetList/items/${letter}/layerList/items/${layer}/source/pp/inputNum`;

/* ----------------------------------------------------------- the model */

test('a stored file is coerced rather than trusted', () => {
  const out = normalise({
    groups: [
      null,
      { id: 'g1', name: '  Sides  ', members: [{ id: 's1', layer: 2 }, { id: 'S1', layer: '2' }, { id: 'nope', layer: '1' }] },
      { id: 'g1', name: '', gang: false, members: [{ id: 'S2', layer: '1' }] }
    ]
  });

  assert.equal(out.version, GROUPS_VERSION);
  assert.equal(out.groups.length, 2);
  assert.equal(out.groups[0].name, 'Sides', 'names are trimmed');
  assert.equal(out.groups[1].name, 'Group', 'an empty name gets a placeholder rather than nothing');
  assert.notEqual(out.groups[1].id, 'g1', 'a duplicate id is replaced, so nothing addresses two groups');

  /* `s1` is upper-cased and the numeric layer stringified, so the two spellings
     of the same member collapse to one; `nope` is not a destination at all. */
  assert.deepEqual(out.groups[0].members, [{ id: 'S1', layer: '2' }]);

  assert.equal(out.groups[0].gang, true, 'ganging is the default');
  assert.equal(out.groups[1].gang, false, 'and turning it off survives the round trip');
});

test('a layer can only belong to one group, whatever the file says', () => {
  const out = normalise({
    groups: [
      { id: 'a', name: 'First', members: [{ id: 'S1', layer: '1' }, { id: 'S2', layer: '1' }] },
      { id: 'b', name: 'Second', members: [{ id: 'S2', layer: '1' }, { id: 'S3', layer: '1' }] }
    ]
  });
  assert.deepEqual(out.groups[0].members.map(memberKey), ['S1/1', 'S2/1']);
  assert.deepEqual(out.groups[1].members.map(memberKey), ['S3/1'], 'the second claim is dropped');
});

test('joining a group is a move, and says what it displaced', () => {
  const groups = normalise({
    groups: [
      { id: 'a', name: 'First', members: [{ id: 'S1', layer: '1' }] },
      { id: 'b', name: 'Second', members: [] }
    ]
  }).groups;

  const { groups: next, movedFrom } = addMember(groups, 'b', { id: 'S1', layer: '1' });
  assert.equal(movedFrom.name, 'First');
  assert.deepEqual(next[0].members, []);
  assert.deepEqual(next[1].members.map(memberKey), ['S1/1']);
  assert.equal(groupOf(next, { id: 'S1', layer: '1' }).id, 'b');

  /* Adding it where it already is changes nothing and displaces nothing. */
  const again = addMember(next, 'b', { id: 'S1', layer: '1' });
  assert.equal(again.movedFrom, null);
  assert.deepEqual(again.groups[1].members.map(memberKey), ['S1/1']);
});

test('ids are unique enough to key a list by', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(newId());
  assert.equal(seen.size, 500);
});

test('a member the device does not have is flagged, not dropped', () => {
  const store = desk();
  const group = { ...sides(), members: [...sides().members, { id: 'S2', layer: '7' }] };
  const resolved = resolveMembers(store, group);
  assert.deepEqual(resolved.map((m) => m.fitted), [true, true, true, false]);
});

/* --------------------------------------------------------- the fan-out */

test('a role is resolved per screen, not copied letter for letter', () => {
  const store = desk();
  const { cmds, refused } = sourceCommands(store, sides().members, 'LIVE_4', 'PROGRAM');

  assert.deepEqual(refused, []);
  /* S1 is AT_UP so program is B; S2 and S3 are AT_DOWN so program is A. A
     gang that copied the letter would have put a preview edit on air on two
     screens out of three. */
  assert.deepEqual(cmds.map(P), [
    layerPath('S1', 'B', '2'),
    layerPath('S2', 'A', '1'),
    layerPath('S3', 'A', '1')
  ]);
  assert.deepEqual([...new Set(cmds.map((c) => c.value))], ['LIVE_4']);
});

test('preview is the mirror of program, screen by screen', () => {
  const { cmds } = sourceCommands(desk(), sides().members, 'LIVE_4', 'PREVIEW');
  assert.deepEqual(cmds.map(P), [
    layerPath('S1', 'A', '2'),
    layerPath('S2', 'B', '1'),
    layerPath('S3', 'B', '1')
  ]);
});

test('program is reported as live so a caller can say so', () => {
  assert.equal(sourceCommands(desk(), sides().members, 'LIVE_4', 'PROGRAM').live, true);
  assert.equal(sourceCommands(desk(), sides().members, 'LIVE_4', 'PREVIEW').live, false);
});

test('a layer the hardware does not have is refused by name', () => {
  const { cmds, refused } = sourceCommands(desk(), [{ id: 'S2', layer: '4' }], 'LIVE_4', 'PROGRAM');
  assert.deepEqual(cmds, []);
  assert.equal(refused.length, 1);
  assert.match(refused[0].why, /S2 has no layer 4/);
});

test('mid-take, a role names no buffer and nothing is written', () => {
  const store = storeWith({
    S1: { transition: 'EFFECT_FROM_UP', layers: ['1'] },
    S2: { transition: 'AT_DOWN', layers: ['1'] }
  });
  const members = [{ id: 'S1', layer: '1' }, { id: 'S2', layer: '1' }];

  const { cmds, refused } = sourceCommands(store, members, 'LIVE_4', 'PROGRAM');
  assert.deepEqual(cmds.map(P), [layerPath('S2', 'A', '1')], 'the settled screen is still written');
  assert.equal(refused.length, 1);
  assert.match(refused[0].why, /S1 is mid-take/);

  /* A literal letter is the operator naming a buffer rather than a role, and
     that is answerable whatever the T-bar is doing. */
  const literal = sourceCommands(store, members, 'LIVE_4', 'B');
  assert.deepEqual(literal.refused, []);
  assert.deepEqual(literal.cmds.map(P), [layerPath('S1', 'B', '1'), layerPath('S2', 'B', '1')]);
});

test('a layer already showing the source is left alone', () => {
  const store = storeWith({
    S1: { transition: 'AT_UP', layers: ['1'], sources: { B: { 1: 'LIVE_4' } } },
    S2: { transition: 'AT_DOWN', layers: ['1'] }
  });
  const { cmds, unchanged } = sourceCommands(store, [{ id: 'S1', layer: '1' }, { id: 'S2', layer: '1' }], 'LIVE_4', 'PROGRAM');
  assert.deepEqual(unchanged.map(memberKey), ['S1/1']);
  assert.deepEqual(cmds.map(P), [layerPath('S2', 'A', '1')]);
});

test('a source the platform does not offer is refused', () => {
  const { cmds, refused } = sourceCommands(desk(), [{ id: 'S1', layer: '1' }], 'BANANA_1', 'PROGRAM');
  assert.deepEqual(cmds, []);
  assert.match(refused[0].why, /not a source this platform offers/);
});

test('without a platform nothing is spelled at all', () => {
  const empty = new DeviceStore();
  empty.hydrate({ device: {} });
  assert.equal(sourceSpec(empty), null);
  const { cmds, refused } = sourceCommands(empty, [{ id: 'S1', layer: '1' }], 'LIVE_1', 'PROGRAM');
  assert.deepEqual(cmds, []);
  assert.equal(refused.length, 1);
});

/* ------------------------------------------------------------- the gang */

function gangRig(store, groups, { now = () => 1000 } = {}) {
  const sent = [];
  const activity = [];
  const gang = createGang({
    store,
    groups: () => groups,
    send: (cmd) => { sent.push(cmd); return true; },
    onActivity: (r) => activity.push(r),
    now
  });
  /* Frames are applied to the mirror the way `Session` applies them, so the
     "only write what differs" rule is exercised rather than assumed. */
  const frame = (path, value) => {
    store.set(path.split('/'), value);
    return gang.onFrame({ path: path.split('/'), value });
  };
  return { gang, sent, activity, frame };
}

test('a change on one member is written to the rest, in the same role', () => {
  const { sent, frame } = gangRig(desk(), [sides()]);
  /* S1's letter B is its PROGRAM. */
  frame(layerPath('S1', 'B', '2'), 'LIVE_7');
  assert.deepEqual(sent.map(P), [layerPath('S2', 'A', '1'), layerPath('S3', 'A', '1')]);
  assert.deepEqual([...new Set(sent.map((c) => c.value))], ['LIVE_7']);
});

test('the same change in preview stays in preview', () => {
  const { sent, frame } = gangRig(desk(), [sides()]);
  /* S1's letter A is its PREVIEW, and S2/S3's preview is B. */
  frame(layerPath('S1', 'A', '2'), 'LIVE_7');
  assert.deepEqual(sent.map(P), [layerPath('S2', 'B', '1'), layerPath('S3', 'B', '1')]);
});

test('the third buffer is neither role, so nothing follows from it', () => {
  const { sent, frame } = gangRig(desk(), [sides()]);
  /* C is `presetPrevious` — a real buffer that is not on air and is not next. */
  frame(layerPath('S1', 'C', '2'), 'LIVE_7');
  assert.deepEqual(sent, []);
});

test('the echo of a fan-out produces no second round', () => {
  let clock = 1000;
  const store = desk();
  const { sent, frame } = gangRig(store, [sides()], { now: () => clock });

  frame(layerPath('S1', 'B', '2'), 'LIVE_7');
  assert.equal(sent.length, 2);

  /* The device echoes both writes back. Past the settle window, so it is the
     value check and not the window doing the work here. */
  clock += SETTLE_MS * 2;
  frame(layerPath('S2', 'A', '1'), 'LIVE_7');
  frame(layerPath('S3', 'A', '1'), 'LIVE_7');
  assert.equal(sent.length, 2, 'every member already reads LIVE_7, so there is nothing to write');
});

test('a frame that contradicts what we sent is not mistaken for our echo', () => {
  let clock = 1000;
  const store = desk();
  const { sent, frame } = gangRig(store, [sides()], { now: () => clock });

  frame(layerPath('S1', 'B', '2'), 'LIVE_7');
  assert.equal(sent.length, 2, 'S2 and S3 written');

  /*
   * S2 comes back carrying something else — the device clamped it, or the
   * operator moved it again in the same breath. That is not our echo and it
   * must not be swallowed as one.
   */
  clock += SETTLE_MS + 1;
  frame(layerPath('S2', 'A', '1'), 'LIVE_9');
  assert.deepEqual(sent.slice(2).map(P), [layerPath('S1', 'B', '2'), layerPath('S3', 'A', '1')]);
  assert.deepEqual([...new Set(sent.slice(2).map((c) => c.value))], ['LIVE_9']);
});

test('a write whose echo never comes is eventually forgotten', () => {
  let clock = 1000;
  const store = desk();
  const { gang, frame } = gangRig(store, [sides()], { now: () => clock });

  frame(layerPath('S1', 'B', '2'), 'LIVE_7');
  assert.equal(gang.pending(), 2, 'two writes are outstanding');

  /* Nothing echoes. A later fan-out prunes the records rather than letting
     them accumulate for the life of the page. */
  clock += PENDING_TTL + SETTLE_MS + 1;
  frame(layerPath('S1', 'B', '2'), 'LIVE_8');
  assert.equal(gang.pending(), 2, 'the stale pair is gone, replaced by this round');
});

test('a whole group written by someone else is not written again', () => {
  const store = desk();
  const { gang, sent, frame } = gangRig(store, [sides()]);

  /* What the `…` menu does when a group is the target: every member, in one
     go. The gang is told, so the echoes that follow are recognised. */
  const { cmds } = sourceCommands(store, sides().members, 'LIVE_11', 'PROGRAM');
  gang.expect(cmds);
  for (const cmd of cmds) store.set(cmd.path, cmd.value);

  frame(layerPath('S1', 'B', '2'), 'LIVE_11');
  frame(layerPath('S2', 'A', '1'), 'LIVE_11');
  frame(layerPath('S3', 'A', '1'), 'LIVE_11');
  assert.deepEqual(sent, [], 'the group was already where it was sent');
});

test('a send to one member of a group is still followed by the rest', () => {
  const store = desk();
  const { gang, sent, frame } = gangRig(store, [sides()]);

  /* The same menu aimed at S1 L2 alone. `main.js` deliberately does not call
     `expect` here — following it is the entire point of ganging — and this
     pins that the gang would act even if it had been told nothing. */
  assert.equal(typeof gang.expect, 'function');
  frame(layerPath('S1', 'B', '2'), 'LIVE_11');
  assert.deepEqual(sent.map(P), [layerPath('S2', 'A', '1'), layerPath('S3', 'A', '1')]);
});

test('a burst settles to the first change rather than fighting itself', () => {
  const store = desk();
  const { sent, frame } = gangRig(store, [sides()]);

  /* A memory recall rewriting several members at once with different values,
     all inside the settle window. */
  frame(layerPath('S1', 'B', '2'), 'LIVE_7');
  frame(layerPath('S2', 'A', '1'), 'LIVE_9');
  frame(layerPath('S3', 'A', '1'), 'LIVE_9');

  assert.deepEqual(sent.map(P), [layerPath('S2', 'A', '1'), layerPath('S3', 'A', '1')]);
  assert.deepEqual([...new Set(sent.map((c) => c.value))], ['LIVE_7'], 'the first change into the group wins');
});

test('a second decision after the window is followed normally', () => {
  let clock = 1000;
  const store = desk();
  const { sent, frame } = gangRig(store, [sides()], { now: () => clock });

  frame(layerPath('S1', 'B', '2'), 'LIVE_7');
  clock += SETTLE_MS + 1;
  frame(layerPath('S1', 'B', '2'), 'LIVE_8');

  assert.equal(sent.length, 4);
  assert.deepEqual(sent.slice(2).map((c) => c.value), ['LIVE_8', 'LIVE_8']);
});

test('ganging off means the group is only a target', () => {
  const { sent, frame } = gangRig(desk(), [{ ...sides(), gang: false }]);
  frame(layerPath('S1', 'B', '2'), 'LIVE_7');
  assert.deepEqual(sent, []);
});

test('a layer in no group, and a group of one, are both inert', () => {
  const { sent, frame } = gangRig(desk(), [
    sides(),
    { id: 'g2', name: 'Lonely', gang: true, members: [{ id: 'S1', layer: '1' }] }
  ]);
  /* S1/1 is a group of one — there is no "rest" to write. */
  frame(layerPath('S1', 'B', '1'), 'LIVE_7');
  assert.deepEqual(sent, []);

  /* And a path that is not a ganged layer's source at all. */
  frame('device/screenAuxGroupList/items/S1/status/pp/transition', 'AT_DOWN');
  assert.deepEqual(sent, []);
});

test('mid-take on the screen that changed, the gang refuses and says so', () => {
  const store = storeWith({
    S1: { transition: 'EFFECT_FROM_UP', layers: ['1'] },
    S2: { transition: 'AT_DOWN', layers: ['1'] }
  });
  const { sent, activity, frame } = gangRig(store, [{
    id: 'g1', name: 'Pair', gang: true, members: [{ id: 'S1', layer: '1' }, { id: 'S2', layer: '1' }]
  }]);

  frame(layerPath('S1', 'B', '1'), 'LIVE_7');
  assert.deepEqual(sent, [], 'the letter that changed names no role while the T-bar is moving');
  assert.equal(activity.length, 1);
  assert.match(activity[0].refused[0].why, /mid-take/);
});

test('the index follows the groups as they are edited', () => {
  const store = desk();
  let groups = [];
  const sent = [];
  const gang = createGang({ store, groups: () => groups, send: (cmd) => { sent.push(cmd); return true; } });

  const path = layerPath('S1', 'B', '2').split('/');
  gang.onFrame({ path, value: 'LIVE_7' });
  assert.deepEqual(sent, [], 'no groups yet');

  groups = [sides()];
  /* Three members, three buffers each, minus nothing: the index is rebuilt on
     the next frame rather than at construction. */
  assert.equal(gang.size(), 9);
  gang.onFrame({ path, value: 'LIVE_7' });
  assert.equal(sent.length, 2);
});

/* --------------------------------------------- naming a source from a card */

test('a snapshot URL names the source that owns it, both ways', () => {
  for (const source of ['LIVE_1', 'LIVE_128', 'STILL_7']) {
    assert.equal(NLC.sourceFromSnapshot(NLC.snapshotUrl(source)), source);
  }
  assert.equal(MNG.sourceFromSnapshot(MNG.snapshotUrl('INPUT_3')), 'INPUT_3');

  /* Web RCS hangs a cache-buster on the src it renders. */
  assert.equal(NLC.sourceFromSnapshot('/api/device/snapshots/inputs/3?1790022045017'), 'LIVE_3');
});

test('a card with no picture, or the wrong kind, names nothing', () => {
  for (const url of [null, '', '/api/device/snapshots/outputs/1', '/somewhere/else/3']) {
    assert.equal(NLC.sourceFromSnapshot(url), null);
  }
  /* ⚠️ A still is not a layer source on Midra — `LAYER_CONTENT` is NONE,
     INPUT_1..16 and COLOR — so an images URL must name nothing rather than
     borrowing LivePremier's spelling for a value the device would refuse. */
  assert.equal(MNG.sourceFromSnapshot('/api/device/snapshots/images/7'), null);
  assert.equal(NLC.sourceFromSnapshot('/api/device/snapshots/images/7'), 'STILL_7');
});
