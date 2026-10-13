/*
 * The Console, typed at against a live switcher.
 *
 * The real panel (`plugins/console/panel.js`), with the live mirror as its
 * store and the proxied vendor socket as its session — what the page does —
 * and its own `fetch` calls (`/__lpp/awj`, `/__lpp/addresses`) answered by the
 * running app. Each line typed is checked where it matters: on the switcher,
 * over AWJ. `test/console.test.js` reads what a line *would* send; this
 * reads what the switcher made of it.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKIP, startApp, Link, awjGet, awjGetAll, sag, settled, guardScreen, layerPath, spareSlots, sleep
} from './harness.js';
import { bankLetter } from '../../src/core/properties.js';
import { createConsolePanel } from '../../plugins/console/panel.js';
import { createVariables } from '../../plugins/variables/service.js';

let app;
let link;
let guard;
let panel;
let sentOnSocket = 0;
const realFetch = globalThis.fetch;
const slots = [];

before(async () => {
  if (SKIP) return;
  app = await startApp();
  link = await Link.open(app);
  guard = await guardScreen(link, 'S1');

  /* The panel fetches same-origin paths, as a page would. In Node a path has
     no origin, so give it the app's. */
  globalThis.fetch = (url, init) =>
    realFetch(typeof url === 'string' && url.startsWith('/') ? app.base + url : url, init);

  const vars = createVariables({ store: () => link.store, load: async () => ({ variables: [] }), save: async () => {} });
  await vars.start();
  const session = {
    store: link.store,
    state: 'live',
    send: (cmd) => { sentOnSocket++; link.send(cmd); return true; }
  };
  panel = createConsolePanel({ session, popoutEnabled: false, variables: () => vars.service });
  /* It asks the server which address subtrees plugins answer as it starts. */
  await sleep(300);
});

after(async () => {
  globalThis.fetch = realFetch;
  try {
    for (const slot of slots) {
      if (link.get(slotValid(slot)) === true) {
        link.send({ path: ['device', 'presetBank', 'bankList', 'items', String(slot), 'control', 'pp', 'xDelete'], value: true });
        await link.waitFor(slotValid(slot), false).catch(() => {});
      }
    }
    if (guard) await guard.restore();
  } finally {
    link?.close();
    await app?.close();
  }
});

const slotValid = (slot) => ['device', 'presetBank', 'bankList', 'items', String(slot), 'status', 'pp', 'isValid'];

/**
 * Type a line and press Enter; resolve with the log row once it has settled.
 * Lines that go to the server (AWJ, a plugin's address) report "sending…"
 * first and fill in when the answer comes back.
 */
async function type(line) {
  panel.state.line = line;
  panel.execute();
  const row = panel.state.log[0];
  const until = Date.now() + 5000;
  while (/sending/.test(row.detail || '') && Date.now() < until) await sleep(20);
  return row;
}

const pv = () => bankLetter(link.store, 'S1', 'PREVIEW').letter;
const pg = () => bankLetter(link.store, 'S1', 'PROGRAM').letter;
const prop = (letter, ...tail) => layerPath('S1', letter, 1, ...tail);

test('Set writes preview by default and program only when said', { skip: SKIP }, async () => {
  await settled(link);
  const row = await type('Set Screen 1 Layer 1 Opacity 128');
  assert.equal(row.kind, 'ok', row.detail);
  await link.waitFor(prop(pv(), 'opacity', 'pp', 'opacity'), 128);

  const row2 = await type('Set Screen 1 Layer 1 Opacity 200 Program');
  assert.equal(row2.kind, 'ok', row2.detail);
  await link.waitFor(prop(pg(), 'opacity', 'pp', 'opacity'), 200);

  assert.deepEqual(await awjGetAll([prop(pv(), 'opacity', 'pp', 'opacity'), prop(pg(), 'opacity', 'pp', 'opacity')]), [128, 200]);
});

test('a source by number, and a size as a share of the canvas', { skip: SKIP }, async () => {
  const letter = pv();
  assert.equal((await type('Set Screen 1 Layer 1 Source 3')).kind, 'ok');
  await link.waitFor(prop(letter, 'source', 'pp', 'inputNum'), 'LIVE_3');

  const row = await type('Set Screen 1 Layer 1 Size 50% Position 960 540');
  assert.equal(row.kind, 'ok', row.detail);
  const canvas = link.get(['device', 'screenList', 'items', 'S1', 'status', 'pp', 'canvasWidth']) ?? 1920;
  await link.waitFor(prop(letter, 'position', 'pp', 'sizeH'), Math.round(canvas / 2));
  await link.waitFor(prop(letter, 'position', 'pp', 'posH'), 960);
  await link.waitFor(prop(letter, 'position', 'pp', 'posV'), 540);
  assert.equal(await awjGet(prop(letter, 'source', 'pp', 'inputNum')), 'LIVE_3');
});

test('variables the switcher reports, in a Set', { skip: SKIP }, async () => {
  const letter = pv();
  const row = await type('Set Screen 1 Layer 1 Size ($S1.width / 4) ($S1.height / 4)');
  assert.equal(row.kind, 'ok', row.detail);
  const dest = await awjGetAll([
    ['device', 'screenList', 'items', 'S1', 'status', 'pp', 'canvasWidth'],
    ['device', 'screenList', 'items', 'S1', 'status', 'pp', 'canvasHeight']
  ]);
  const [w, h] = typeof dest[0] === 'number' ? dest : [1920, 1080];
  await link.waitFor(prop(letter, 'position', 'pp', 'sizeH'), w / 4);
  await link.waitFor(prop(letter, 'position', 'pp', 'sizeV'), h / 4);
});

test('Take Screen 1, then a fade time by OSC address, typed', { skip: SKIP }, async () => {
  assert.equal((await type('/lp/screen/1/group/control/takeUpTime 6')).kind, 'ok');
  assert.equal((await type('/lp/screen/1/group/control/takeDownTime 6')).kind, 'ok');
  await link.waitFor(sag('S1', 'control', 'takeDownTime'), 6);

  const from = await settled(link);
  const row = await type('Take Screen 1');
  assert.equal(row.kind, 'ok', row.detail);
  await link.waitFor(sag('S1', 'status', 'transition'), from === 'AT_UP' ? 'AT_DOWN' : 'AT_UP', { timeout: 4000 });
});

test('Store, Label, Recall and Delete a memory by name', { skip: SKIP }, async () => {
  const [slot] = spareSlots(link, 1);
  slots.push(slot);
  await settled(link);
  const programSource = link.get(prop(pg(), 'source', 'pp', 'inputNum'));

  const store = await type(`Store Screen 1 Memory ${slot}`);
  assert.equal(store.kind, 'ok', store.detail);
  await link.waitFor(slotValid(slot), true, { timeout: 6000 });

  assert.equal((await type(`Label Screen 1 Memory ${slot} "From the Console"`)).kind, 'ok');
  await link.waitFor(['device', 'presetBank', 'bankList', 'items', String(slot), 'control', 'pp', 'label'], 'From the Console');

  const letter = pv();
  const other = programSource === 'LIVE_13' ? 'LIVE_14' : 'LIVE_13';
  assert.equal((await type(`Set Screen 1 Layer 1 Source ${other.slice(5)}`)).kind, 'ok');
  await link.waitFor(prop(letter, 'source', 'pp', 'inputNum'), other);

  assert.equal((await type(`Recall Screen 1 Memory ${slot}`)).kind, 'ok');
  await link.waitFor(prop(letter, 'source', 'pp', 'inputNum'), programSource, { timeout: 5000 });

  const del = await type(`Delete Screen 1 Memory ${slot}`);
  assert.equal(del.kind, 'ok', del.detail);
  await link.waitFor(slotValid(slot), false);
  assert.equal(await awjGet(slotValid(slot)), false);
});

test('a raw AWJ get answers with what the switcher says, through the server', { skip: SKIP }, async () => {
  const before = sentOnSocket;
  const value = await awjGet(sag('S1', 'control', 'takeUpTime'));
  const row = await type('get DeviceObject/$screenAuxGroup/@items/S1/control/@props/takeUpTime');
  assert.equal(row.kind, 'ok', row.detail);
  assert.match(row.detail, new RegExp(`takeUpTime = ${value}\\b`));
  assert.equal(sentOnSocket, before, 'a read never touches the vendor socket');
});

test('a raw AWJ replace and a raw store write both land', { skip: SKIP }, async () => {
  const up = sag('S1', 'control', 'takeUpTime');
  const down = sag('S1', 'control', 'takeDownTime');
  const r1 = await type('replace DeviceObject/$screenAuxGroup/@items/S1/control/@props/takeUpTime = 21');
  assert.equal(r1.kind, 'ok', r1.detail);
  await link.waitFor(up, 21);

  const r2 = await type(JSON.stringify({ path: down, value: 22 }));
  assert.equal(r2.kind, 'ok', r2.detail);
  await link.waitFor(down, 22);
  assert.deepEqual(await awjGetAll([up, down]), [21, 22]);
});

test('a line that does not compile is refused, and nothing is sent', { skip: SKIP }, async () => {
  const before = sentOnSocket;
  const mark = link.mark();
  for (const line of ['Set Screen 1 Layer 1 Opacity', 'Recall Screen 99 Memory 1', 'Fly to the moon']) {
    const row = await type(line);
    assert.equal(row.kind, 'error', `${line}: ${row.detail}`);
  }
  await sleep(300);
  assert.equal(sentOnSocket, before);
  assert.equal(link.since(mark, ['device', 'screenList']).length, 0);
});

test('an address a plugin owns goes to that plugin, not to mynah or the switcher', { skip: SKIP }, async () => {
  const before = sentOnSocket;
  const row = await type('/hyperdeck/nobody/play');
  /* No deck called "nobody" is configured: the HyperDeck plugin says so. A
     line mynah had swallowed would come back as a grammar error instead. */
  assert.equal(row.kind, 'error');
  assert.doesNotMatch(row.detail, /unexpected|expected/i);
  assert.match(row.detail, /nobody|deck/i);
  assert.equal(sentOnSocket, before);
});
