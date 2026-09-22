/*
 * Getting a look out of the programmer and into a real slot.
 *
 * The direct route is a file and a server conversation, so what is testable
 * here is the file it composes — `preset-file.test.js` pins that against the
 * device's own export. What this file is really for is the *other* route, the
 * one that borrows the preview buffer, because that one writes to a live
 * switcher and its failure modes are the expensive kind:
 *
 *   - writing while a take is in flight, which lands the look on the output;
 *   - leaving preview holding the experiment when the save fails.
 *
 * Both have a test below, and the second one asserts the restore happens on
 * the failure path rather than on the happy one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeviceStore } from '../src/core/device-store.js';
import { createProgrammer, EDIT } from '../src/core/programmer.js';
import {
  composeMemory, bufferWrites, saveViaPreview, applyLook, lookFromMemory
} from '../src/core/save-look.js';
import { fromMemory } from '../src/core/preset-file.js';

/* ----------------------------------------------------------------- store */

function deskStore({ transition = 'AT_DOWN', layers = ['NATIVE', '1', '2'], native = 'DUAL' } = {}) {
  const layerList = { itemKeys: layers, items: {} };
  for (const key of layers) {
    layerList.items[key] = { status: { pp: { capability: key === 'NATIVE' ? native : 'DUAL' } } };
  }

  const presetList = { itemKeys: ['A', 'B', 'C'], items: {} };
  for (const letter of ['A', 'B', 'C']) {
    const items = {};
    for (const key of layers) {
      items[key] = {
        source: { pp: { inputNum: letter === 'A' ? 'LIVE_1' : 'NONE' } },
        position: { pp: { anchor: 'MIDDLE_CENTER', posH: 960, posV: 540, sizeH: 1920, sizeV: 1080 } },
        opacity: { pp: { opacity: 256 } }
      };
    }
    presetList.items[letter] = { layerList: { itemKeys: layers, items } };
  }

  const store = new DeviceStore();
  store.hydrate({
    device: {
      screenAuxGroupList: {
        itemKeys: ['S1'],
        items: {
          S1: {
            control: { pp: { presetUp: 'B', presetDown: 'A', presetPrevious: 'C' } },
            status: { pp: { isUsed: true, transition } }
          }
        }
      },
      screenList: {
        itemKeys: ['S1'],
        items: {
          S1: {
            control: { pp: { label: 'Main' } },
            status: { pp: { mode: 'FREESTYLE', layerCount: layers.length }, size: { pp: { sizeH: 2560, sizeV: 1080 } } },
            layerList,
            presetList
          }
        }
      },
      auxiliaryList: { itemKeys: [], items: {} },
      presetBank: { bankList: { itemKeys: ['7'], items: { 7: { status: { pp: { isValid: false } } }, } } }
    }
  });
  return store;
}

/**
 * A session that applies what it is sent, the way a device echoing its writes
 * back onto the socket would — so a restore can be checked by reading.
 *
 * `onSave` is the device's own bookkeeping: the bank flag turns over a moment
 * after the save, and that flag is the only confirmation there is.
 */
function fakeSession(store, { saveLands = true } = {}) {
  const sent = [];
  const session = {
    store,
    sent,
    send(cmd) {
      sent.push(cmd);
      if (cmd.path.includes('presetBank') && cmd.path.includes('save')) {
        if (saveLands) {
          store.set(['device', 'presetBank', 'bankList', 'items', '7', 'status', 'pp', 'isValid'], true);
        }
        return true;
      }
      store.set(cmd.path, cmd.value);
      return true;
    }
  };
  return session;
}

const sourceAt = (store, letter, layer) => store.get([
  'device', 'screenList', 'items', 'S1', 'presetList', 'items', letter,
  'layerList', 'items', layer, 'source', 'pp', 'inputNum'
]);

/* ------------------------------------------------------------- composing */

test('a composed memory takes its canvas and capabilities from the device', () => {
  const store = deskStore();
  const prog = createProgrammer({ session: { store, send: () => true } });
  prog.seed('S1', 'PROGRAM');

  const memory = composeMemory({ programmer: prog, id: 'S1', slot: 7, label: 'Wide' });

  assert.equal(memory.BankSlot, 7);
  assert.equal(memory.xPEMEM_BANK_LABEL, 'Wide');
  /* The screen is 2560x1080, not the 1920x1080 a layer happens to be. A memory
     records the screen it came from. */
  assert.equal(memory.xPEMEM_BANK_SCREEN_WIDTH, 2560);
  assert.equal(memory.xPEMEM_BANK_SCREEN_HEIGHT, 1080);
  assert.deepEqual(Object.keys(memory.Layer).sort(), ['0', '1', '2']);
  assert.equal(memory.Layer['0'].xPEMEM_BANK_LAYER_CAPABILITY, 'DUAL', 'NATIVE, straight off the screen');
  assert.equal(memory.Layer['1'].xPEMEM_BANK_LAYER_CAPABILITY, 'DUAL');
});

test('a layer slot the screen has not allocated is not in the memory', () => {
  /* NATIVE reads OFF on hardware where it is not allocated, and a preset
     carries geometry for every slot whether or not it exists — so a memory
     built from the preset alone would claim a layer the screen does not have.
     The gate is the screen's own list, as everywhere else. */
  const store = deskStore({ native: 'OFF' });
  const prog = createProgrammer({ session: { store, send: () => true } });
  prog.seed('S1', 'PROGRAM');

  const memory = composeMemory({ programmer: prog, id: 'S1', slot: 7 });

  assert.deepEqual(Object.keys(memory.Layer).sort(), ['1', '2']);
  assert.deepEqual(memory.xPEMEM_BANK_FILTER_LAYER, ['1', '2']);
});

test('composing nothing is nothing, not an empty memory', () => {
  const store = deskStore();
  const prog = createProgrammer({ session: { store, send: () => true } });
  assert.equal(composeMemory({ programmer: prog, id: 'S1', slot: 7 }), null);
});

/* ---------------------------------------------------------------- writes */

test('the writes for a buffer name that buffer and skip what the screen has not got', () => {
  const store = deskStore({ layers: ['NATIVE', '1'] });
  const prog = createProgrammer({ session: { store, send: () => true } });
  prog.seed('S1', 'PROGRAM');

  const writes = bufferWrites({ store, id: 'S1', buffer: 'B', look: prog.look('S1') });

  assert.ok(writes.length > 0);
  assert.ok(writes.every((w) => w.path.includes('B')), 'every write names the buffer it was asked for');
  assert.ok(!writes.some((w) => w.path.includes('2')), 'layer 2 is not fitted on this screen');
  assert.ok(writes.some((w) => w.path.join('/').endsWith('source/pp/inputNum')));
});

/* ------------------------------------------------------- via preview */

test('a save via preview writes preview, saves, and puts preview back', async () => {
  const store = deskStore({ transition: 'AT_DOWN' });   /* program A, preview B */
  const session = fakeSession(store);
  const prog = createProgrammer({ session });
  prog.seed('S1', 'PROGRAM');                            /* LIVE_1 on every layer */

  assert.equal(sourceAt(store, 'B', '1'), 'NONE', 'preview starts empty');

  const out = await saveViaPreview({ session, programmer: prog, id: 'S1', slot: 7, label: 'Wide' });

  assert.equal(out.ok, true, out.message);
  assert.equal(sourceAt(store, 'B', '1'), 'NONE', 'preview was put back');
  assert.equal(sourceAt(store, 'A', '1'), 'LIVE_1', 'program was never touched');

  const paths = session.sent.map((c) => c.path.join('/'));
  assert.ok(paths.some((p) => p.includes('presetBank') && p.includes('save') && p.includes('PREVIEW')),
    'the save named PREVIEW');
  assert.ok(!paths.some((p) => p.includes('PROGRAM')), 'and never PROGRAM');
  assert.ok(paths.some((p) => p.endsWith('control/pp/label')), 'the slot was labelled');
});

test('preview is put back even when the save never lands', async () => {
  const store = deskStore({ transition: 'AT_DOWN' });
  const session = fakeSession(store, { saveLands: false });
  const prog = createProgrammer({ session });
  prog.seed('S1', 'PROGRAM');

  const out = await saveViaPreview({ session, programmer: prog, id: 'S1', slot: 7, timeoutMs: 300 });

  assert.equal(out.ok, false);
  assert.match(out.message, /did not come back valid/);
  assert.equal(sourceAt(store, 'B', '1'), 'NONE',
    'a failed save must not leave preview holding the experiment');
});

test('a save via preview is refused mid-take', async () => {
  const store = deskStore({ transition: 'EFFECT_FROM_DOWN' });
  const session = fakeSession(store);
  const prog = createProgrammer({ session });
  prog.seed('S1', 'PROGRAM');

  const out = await saveViaPreview({ session, programmer: prog, id: 'S1', slot: 7 });

  assert.equal(out.ok, false);
  assert.match(out.message, /take is in flight/);
  assert.deepEqual(session.sent, [], 'nothing was written while the answer was a guess');
});

test('a save via preview is refused while the device has not named its buffers', async () => {
  const store = deskStore();
  store.set(['device', 'screenAuxGroupList', 'items', 'S1', 'control', 'pp', 'presetUp'], undefined);
  const session = fakeSession(store);
  const prog = createProgrammer({ session });
  prog.seed('S1', 'A');

  const out = await saveViaPreview({ session, programmer: prog, id: 'S1', slot: 7 });

  assert.equal(out.ok, false);
  assert.match(out.message, /which buffer is preview/);
  assert.deepEqual(session.sent, []);
});

/* ----------------------------------------------------------- loading back */

test('a thin memory lands on a complete look rather than leaving holes', () => {
  const store = deskStore();
  const prog = createProgrammer({ session: { store, send: () => true } });

  /* A memory saved with SOURCE only — twelve fields, no size. Installed as the
     buffer it would leave a layer with no geometry, which draws as nothing. */
  const thin = fromMemory({
    BankSlot: 7,
    Layer: { 1: { xPEMEM_BANK_INPUTNUM: 'LIVE_9' } },
    xPEMEM_BANK_LABEL: 'Thin',
    xPEMEM_BANK_SCREEN_WIDTH: 2560,
    xPEMEM_BANK_SCREEN_HEIGHT: 1080
  });

  const sent = applyLook({ programmer: prog, id: 'S1', look: lookFromMemory(thin) });

  assert.equal(sent, 1, 'only what the memory carried was written');
  assert.equal(prog.store.get(['device', 'screenList', 'items', 'S1', 'presetList', 'items', EDIT,
    'layerList', 'items', '1', 'source', 'pp', 'inputNum']), 'LIVE_9');
  assert.equal(prog.store.get(['device', 'screenList', 'items', 'S1', 'presetList', 'items', EDIT,
    'layerList', 'items', '1', 'position', 'pp', 'sizeH']), 1920,
  'and the rest came from the seed, so the look is complete');
});
