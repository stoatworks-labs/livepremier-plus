/*
 * The programmer.
 *
 * The synthetic store is the one from `groups.test.js` for the same reason it
 * is built that way there: **S1 and S2 rest on opposite ends**, so program is
 * letter B on one and letter A on the other. A programmer that seeded from a
 * letter rather than from a role would pass every assertion below on a desk
 * where the two agreed.
 *
 * The test that matters most is the last one in the first section: a full
 * editing session against a session whose transport counts what it is asked to
 * send, and the count is zero.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeviceStore } from '../src/core/device-store.js';
import { createProgrammer, EDIT } from '../src/core/programmer.js';
import { readLayers, listDestinations, presetBanks } from '../src/core/screens.js';
import { writeCmd, fittedLayers, bankLetter, layerSections } from '../src/core/properties.js';

/* ----------------------------------------------------------------- store */

function screen({ transition, layers, sources = {}, sizes = {} }) {
  const layerList = { itemKeys: layers, items: {} };
  for (const key of layers) layerList.items[key] = { status: { pp: { capability: 'DUAL' } } };

  const presetList = { itemKeys: ['A', 'B', 'C'], items: {} };
  for (const letter of ['A', 'B', 'C']) {
    const items = {};
    for (const key of layers) {
      items[key] = {
        source: { pp: { inputNum: (sources[letter] || {})[key] || 'NONE' } },
        position: {
          pp: {
            anchor: 'MIDDLE_CENTER', posH: 960, posV: 540,
            sizeH: (sizes[letter] || {})[key] || 1920, sizeV: 1080
          }
        },
        opacity: { pp: { opacity: 256 } },
        border: { edge: { pp: { radius: 255 } } }
      };
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
  store.hydrate({
    device: { screenAuxGroupList: groups, screenList: screens, auxiliaryList: { itemKeys: [], items: {} } }
  });
  return store;
}

/**
 * A session that counts what it was asked to put on the wire.
 *
 * `sent` staying at zero is the point of the whole file.
 */
function deskSession() {
  const store = storeWith({
    /* AT_UP: program B, preview A. */
    S1: { transition: 'AT_UP', layers: ['NATIVE', '1', '2'], sources: { A: { 1: 'LIVE_4' }, B: { 1: 'LIVE_9' } } },
    /* AT_DOWN: program A, preview B. The mirror image. */
    S2: { transition: 'AT_DOWN', layers: ['NATIVE', '1'], sources: { A: { 1: 'LIVE_1' }, B: { 1: 'LIVE_2' } } }
  });
  const sent = [];
  return { store, sent, send: (cmd) => { sent.push(cmd); return true; } };
}

const layerPath = (id, buffer, layer, tail) =>
  ['device', 'screenList', 'items', id, 'presetList', 'items', buffer, 'layerList', 'items', layer, ...tail];

const SOURCE = ['source', 'pp', 'inputNum'];

/* ------------------------------------------------------------ the buffer */

test('the programmer answers for its own buffer and delegates everything else', () => {
  const session = deskSession();
  const prog = createProgrammer({ session });

  assert.equal(prog.buffer, EDIT);
  assert.equal(prog.store.ready, true, 'as ready as the device it is drawn against');

  /* Structure is the device's. */
  assert.deepEqual(listDestinations(prog.store).map((d) => d.id), ['S1', 'S2']);
  assert.deepEqual(fittedLayers(prog.store, 'S1').map((l) => l.key), ['1', '2', 'NATIVE']);
  assert.deepEqual(presetBanks(prog.store, 'S1'), presetBanks(session.store, 'S1'));

  /* The buffer is not. */
  assert.equal(prog.store.get(layerPath('S1', EDIT, '1', SOURCE)), undefined);
  assert.equal(prog.store.get(layerPath('S1', 'A', '1', SOURCE)), 'LIVE_4', 'a real letter still reads through');
});

test('a write lands in the programmer and never on the wire', () => {
  const session = deskSession();
  const prog = createProgrammer({ session });
  prog.seed('S1', 'PREVIEW');

  const ok = prog.send({ path: layerPath('S1', EDIT, '1', SOURCE), value: 'LIVE_7' });

  assert.equal(ok, true);
  assert.equal(prog.store.get(layerPath('S1', EDIT, '1', SOURCE)), 'LIVE_7');
  assert.deepEqual(session.sent, [], 'nothing reached the transport');
  assert.equal(session.store.get(layerPath('S1', 'A', '1', SOURCE)), 'LIVE_4', 'the mirror is untouched');
});

test('a write aimed outside the programmer is refused rather than swallowed', () => {
  const session = deskSession();
  const prog = createProgrammer({ session });

  const ok = prog.send({ path: layerPath('S1', 'A', '1', SOURCE), value: 'LIVE_7' });

  assert.equal(ok, false, 'an edit that went nowhere must not look like one that worked');
  assert.equal(session.store.get(layerPath('S1', 'A', '1', SOURCE)), 'LIVE_4');
  assert.deepEqual(session.sent, []);
});

test('a whole editing session sends the device nothing at all', () => {
  const session = deskSession();
  const prog = createProgrammer({ session });

  prog.seed('S1', 'PROGRAM');
  prog.clear('S2');
  prog.seed('S2', 'PREVIEW');

  /* Every writable parameter the catalogue has, driven the way the Layer panel
     drives it — through `writeCmd` and the session's own `send`. */
  let written = 0;
  for (const section of layerSections(prog.store)) {
    for (const spec of section.params) {
      if (spec.readOnly) continue;
      const target = { id: 'S1', bank: EDIT, layer: '1' };
      const current = prog.store.get(['device', 'screenList', 'items', 'S1', 'presetList', 'items', EDIT,
        'layerList', 'items', '1', ...spec.path]);
      if (current === undefined) continue;
      const cmd = writeCmd(target, spec, current, prog.store);
      if (!cmd) continue;
      assert.equal(prog.send(cmd), true);
      written++;
    }
  }

  assert.ok(written > 0, 'the catalogue drove some real writes');
  assert.deepEqual(session.sent, [], 'not one frame was sent to the switcher');
});

/* ------------------------------------------------------------- seeding */

test('seeding names a role and resolves it per screen, not per letter', () => {
  const session = deskSession();
  const prog = createProgrammer({ session });

  prog.seed('S1', 'PROGRAM');
  prog.seed('S2', 'PROGRAM');

  /* S1 is AT_UP so program is B; S2 is AT_DOWN so program is A. A programmer
     that copied a letter would have taken LIVE_4 and LIVE_2 here. */
  assert.equal(prog.store.get(layerPath('S1', EDIT, '1', SOURCE)), 'LIVE_9');
  assert.equal(prog.store.get(layerPath('S2', EDIT, '1', SOURCE)), 'LIVE_1');
});

test('seeding accepts a literal letter, including the one the device keeps for itself', () => {
  const session = deskSession();
  const prog = createProgrammer({ session });

  assert.equal(prog.seed('S1', 'C'), true);
  assert.equal(prog.store.get(layerPath('S1', EDIT, '1', SOURCE)), 'NONE');
});

test('seeding deep-copies, so an edit cannot reach back into the mirror', () => {
  const session = deskSession();
  const prog = createProgrammer({ session });
  prog.seed('S1', 'PREVIEW');

  prog.send({ path: layerPath('S1', EDIT, '1', ['position', 'pp', 'posH']), value: 100 });

  assert.equal(prog.store.get(layerPath('S1', EDIT, '1', ['position', 'pp', 'posH'])), 100);
  assert.equal(session.store.get(layerPath('S1', 'A', '1', ['position', 'pp', 'posH'])), 960,
    'the device store still has its own value');
});

test('seeding a role is refused while the device has not named the letters', () => {
  const store = new DeviceStore();
  store.hydrate({
    device: {
      screenAuxGroupList: { itemKeys: ['S1'], items: { S1: { control: { pp: {} }, status: { pp: { isUsed: true } } } } },
      screenList: {
        itemKeys: ['S1'],
        items: {
          S1: {
            control: { pp: {} },
            status: { pp: { mode: 'FREESTYLE' }, size: { pp: { sizeH: 1920, sizeV: 1080 } } },
            layerList: { itemKeys: ['1'], items: { 1: { status: { pp: { capability: 'DUAL' } } } } },
            presetList: { itemKeys: ['A'], items: { A: { layerList: { itemKeys: ['1'], items: { 1: {} } } } } }
          }
        }
      },
      auxiliaryList: { itemKeys: [], items: {} }
    }
  });

  const prog = createProgrammer({ session: { store, send: () => true } });
  assert.equal(prog.seed('S1', 'PREVIEW'), false, 'a guessed letter is worse than no look');
  assert.equal(prog.has('S1'), false);
});

/* -------------------------------------------------------------- clearing */

test('clearing empties the screen without inventing sixty-six defaults', () => {
  const session = deskSession();
  const prog = createProgrammer({ session });

  assert.equal(prog.clear('S1'), true);

  for (const key of ['NATIVE', '1', '2']) {
    assert.equal(prog.store.get(layerPath('S1', EDIT, key, SOURCE)), 'NONE');
    assert.equal(prog.store.get(layerPath('S1', EDIT, key, ['opacity', 'pp', 'opacity'])), 256);
    assert.equal(prog.store.get(layerPath('S1', EDIT, key, ['position', 'pp', 'sizeH'])), 1920);
    assert.equal(prog.store.get(layerPath('S1', EDIT, key, ['position', 'pp', 'posH'])), 960);
    /* Untouched, and still the device's own value rather than a made-up one. */
    assert.equal(prog.store.get(layerPath('S1', EDIT, key, ['border', 'edge', 'pp', 'radius'])), 255);
  }
});

/* ------------------------------------------------------------ what is drawn */

test('the preview composer draws the programmer buffer as if it were real', () => {
  const session = deskSession();
  const prog = createProgrammer({ session });
  prog.seed('S1', 'PREVIEW');
  prog.send({ path: layerPath('S1', EDIT, '2', SOURCE), value: 'LIVE_3' });
  prog.send({ path: layerPath('S1', EDIT, '2', ['position', 'pp', 'sizeH']), value: 960 });

  const dest = listDestinations(prog.store).find((d) => d.id === 'S1');
  const layers = readLayers(prog.store, dest, EDIT);

  /* Bottom of the stack first, which on LivePremier is NATIVE and then 1..N —
     the device's own item order, and deliberately NOT the order the Layer
     panel's picker uses, where NATIVE sorts last because it is the background
     rather than a layer somebody put a source on. */
  assert.deepEqual(layers.map((l) => l.key), ['NATIVE', '1', '2']);
  const two = layers.find((l) => l.key === '2');
  assert.equal(two.source, 'LIVE_3');
  assert.equal(two.rect.width, 960);
  assert.equal(two.frac.width, 0.5);
});

test('the programmer buffer is never mistaken for the one on air', () => {
  const session = deskSession();
  const prog = createProgrammer({ session });
  const resolved = bankLetter(prog.store, 'S1', EDIT);

  assert.equal(resolved.letter, EDIT);
  assert.equal(resolved.live, false, 'nothing programmed here can be on the output');
});

/* ------------------------------------------------------ looks in and out */

test('a look comes out detached and goes back in detached', () => {
  const session = deskSession();
  const prog = createProgrammer({ session });
  prog.seed('S1', 'PREVIEW');

  const look = prog.look('S1');
  look.layerList.items['1'].source.pp.inputNum = 'LIVE_42';
  assert.equal(prog.store.get(layerPath('S1', EDIT, '1', SOURCE)), 'LIVE_4',
    'editing the copy did not edit the programmer');

  assert.equal(prog.setLook('S1', look), true);
  assert.equal(prog.store.get(layerPath('S1', EDIT, '1', SOURCE)), 'LIVE_42');

  look.layerList.items['1'].source.pp.inputNum = 'LIVE_99';
  assert.equal(prog.store.get(layerPath('S1', EDIT, '1', SOURCE)), 'LIVE_42',
    'and installing it did not leave the caller holding a live reference');
});

test('a look can be sent to another screen entirely', () => {
  const session = deskSession();
  const prog = createProgrammer({ session });
  prog.seed('S1', 'PROGRAM');

  assert.equal(prog.setLook('S2', prog.look('S1')), true);
  assert.equal(prog.store.get(layerPath('S2', EDIT, '1', SOURCE)), 'LIVE_9');
});

test('programmed says which destinations have something in them', () => {
  const session = deskSession();
  const prog = createProgrammer({ session });

  assert.deepEqual(prog.programmed(), []);
  prog.seed('S2', 'PREVIEW');
  assert.deepEqual(prog.programmed(), ['S2']);
  prog.seed('S1', 'PREVIEW');
  assert.deepEqual(prog.programmed(), ['S1', 'S2']);

  prog.discard('S2');
  assert.deepEqual(prog.programmed(), ['S1'], 'discarding is not the same as emptying');
  assert.equal(prog.has('S2'), false);
});

test('a change announces itself, so a panel can repaint', () => {
  const session = deskSession();
  const prog = createProgrammer({ session });

  const seen = [];
  prog.addEventListener('changed', (ev) => seen.push(ev.detail.id));
  prog.addEventListener('frame', () => seen.push('frame'));

  prog.seed('S1', 'PREVIEW');
  prog.send({ path: layerPath('S1', EDIT, '1', SOURCE), value: 'LIVE_5' });

  assert.ok(seen.includes('S1'));
  assert.ok(seen.filter((s) => s === 'frame').length >= 2);
});
