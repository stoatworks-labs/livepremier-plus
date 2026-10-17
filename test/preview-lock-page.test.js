/*
 * Preview lock during takes — the page half, against a stand-in of the
 * vendor's own page.
 *
 * `test/preview-lock.test.js` pins when a screen is mid-take; this pins the
 * padlock itself, and one fact about Web RCS 6.2.73 above all (found
 * 2026-10-17): the vendor sends its writes from INSIDE its Redux reducer.
 * Its root reducer (`awStore`) diffs the device state and hands the change
 * to the socket while Redux is still dispatching, and Redux refuses any
 * dispatch made then — "Reducers may not dispatch actions". The hook relays
 * that frame to the plugin synchronously, so a padlock pressed right there
 * runs the vendor's toggle mid-dispatch, and the refusal is thrown inside the
 * click's listener, where a browser reports it and carries on. The vendor's
 * own TAKE button lost the lock exactly that way, every time.
 *
 * The stand-in reproduces those three things and nothing else: a lock per
 * role in a store that refuses a nested dispatch, the TAKE frame sent from
 * inside the reducer, and a padlock whose listener's exceptions go to the
 * page rather than to whoever clicked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { install } from './helpers/fake-dom.js';
import { DeviceStore } from '../src/core/device-store.js';
import activate from '../plugins/preview-lock/client.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const STATUS = (id) => ['device', 'screenAuxGroupList', 'items', id, 'status', 'pp', 'transition'];
const TAKE = (id, prop) => ['device', 'screenAuxGroupList', 'items', id, 'control', 'pp', prop];

/** Every microtask queued so far has run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * One screen card, drawn as 6.2.73 draws it, over a store that behaves like
 * the vendor's Redux. `answers: false` is a padlock whose handler does
 * nothing, for the press that does not take.
 */
function vendorPage(doc, id, { answers = true } = {}) {
  const lock = { PGM: true, PRW: false };
  const errors = [];
  let dispatching = false;
  let socket = () => {};

  function dispatch(action) {
    if (dispatching) throw new Error('Reducers may not dispatch actions.');
    dispatching = true;
    try {
      if (action.type === 'TOGGLE_LOCK') lock[action.role] = !lock[action.role];
      /* awStore: a device write reaches the socket from inside the reducer. */
      if (action.type === 'SET_CONTROL') socket(action.frame);
    } finally {
      dispatching = false;
    }
    draw();
  }

  const card = doc.createElement('div');
  card.className = 'aw-preset-view';
  const heading = doc.createElement('h2');
  heading.textContent = id;
  card.append(heading);
  const uses = {};
  const buttons = {};
  for (const role of ['PGM', 'PRW']) {
    const block = doc.createElement('div');
    block.className = 'screen-overview-container__c__preset___x1Y2z';
    const label = doc.createElement('button');
    label.textContent = role;
    const pad = doc.createElement('button');
    const use = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
    pad.append(use);
    pad.addEventListener('click', () => {
      if (!answers) return;
      /* A listener that throws is reported to the page; `.click()` returns. */
      try { dispatch({ type: 'TOGGLE_LOCK', role }); } catch (err) { errors.push(err); }
    });
    block.append(label, pad);
    card.append(block);
    uses[role] = use;
    buttons[role] = pad;
  }
  function draw() {
    for (const role of ['PGM', 'PRW']) uses[role].setAttribute('href', lock[role] ? '#locked-12' : '#unlocked-12');
  }
  draw();
  doc.body.append(card);

  return {
    lock, errors, buttons,
    /** The vendor's TAKE button: its frame leaves from inside the reducer. */
    take(path) { dispatch({ type: 'SET_CONTROL', frame: { path, value: true, dir: 'out' } }); },
    onSocket(fn) { socket = fn; }
  };
}

/** The plugin's page half, running over a session whose frames we drive. */
function rig({ answers = true } = {}) {
  const dom = install();
  const store = new DeviceStore();
  store.hydrate(fixture('sim-6.2.73-screens.json'));
  const listeners = [];
  const session = {
    store,
    addEventListener(type, fn) { if (type === 'frame') listeners.push(fn); },
    send() {}
  };
  /* An inbound frame lands in the mirror before the session dispatches it. */
  const frame = (f) => {
    if (f.dir === 'in') store.set(f.path, f.value);
    for (const fn of listeners) fn({ detail: f });
  };
  const page = vendorPage(dom.doc, 'S1', { answers });
  page.onSocket(frame);

  const shared = {};
  activate({
    id: 'preview-lock', session, refresh() {}, can: () => true, use: () => null,
    settings: { get: () => ({}), set: async () => ({}) },
    provide() {}, share: (o) => Object.assign(shared, o),
    log: { info() {}, warn() {} },
    ui: { settingsSection() {} }
  });
  const log = () => shared.log().map((e) => e.what).reverse();
  return { dom, page, frame, log, shared };
}

/** Date.now, under the test's control, put back afterwards. */
function holdClock(t) {
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  t.after(() => { Date.now = real; });
  return { advance(ms) { now += ms; } };
}

test('the vendor’s own TAKE shuts PRW — after its reducer, never inside it — and the landing opens it', async (t) => {
  const { dom, page, frame, log } = rig();
  t.after(() => dom.uninstall());

  page.take(TAKE('S1', 'xTakeUp'));
  assert.deepEqual(page.errors, [], 'nothing was pressed while the vendor’s reducer was running');
  await settle();
  assert.deepEqual(page.errors, [], 'the press was not refused');
  assert.equal(page.lock.PRW, true, 'PRW is shut in the vendor’s own store');
  assert.equal(page.lock.PGM, true, 'and PGM is not touched');

  frame({ path: STATUS('S1'), value: 'EFFECT_FROM_DOWN', dir: 'in' });
  await settle();
  assert.equal(page.lock.PRW, true, 'still shut while the take runs');

  frame({ path: STATUS('S1'), value: 'AT_UP', dir: 'in' });
  await settle();
  assert.equal(page.lock.PRW, false, 'open again once the take has landed');
  assert.deepEqual(log(), ['PRW locked: take sent', 'PRW unlocked: take landed']);
  assert.deepEqual(page.errors, []);
});

test('a press that never takes is reported as one, not as the operator opening the padlock', async (t) => {
  const clock = holdClock(t);
  const { dom, page, frame, log } = rig({ answers: false });
  t.after(() => dom.uninstall());

  page.take(TAKE('S1', 'xTakeUp'));
  await settle();
  assert.equal(page.lock.PRW, false);

  clock.advance(500);
  frame({ path: STATUS('S1'), value: 'EFFECT_FROM_DOWN', dir: 'in' });
  frame({ path: STATUS('S1'), value: 'AT_UP', dir: 'in' });
  await settle();
  assert.deepEqual(log(), ['PRW locked: take sent', 'PRW did NOT lock — the padlock did not answer the press']);
  assert.ok(!log().some((l) => /operator/.test(l)), 'the operator is not blamed for a press that did nothing');
});

test('a padlock the operator opens mid-take is theirs: not shut again, not touched on landing', async (t) => {
  const clock = holdClock(t);
  const { dom, page, frame, log } = rig();
  t.after(() => dom.uninstall());

  page.take(TAKE('S1', 'xTakeUp'));
  await settle();
  assert.equal(page.lock.PRW, true);

  page.buttons.PRW.click();
  assert.equal(page.lock.PRW, false, 'the operator opened it');

  clock.advance(500);
  frame({ path: STATUS('S1'), value: 'EFFECT_FROM_DOWN', dir: 'in' });
  frame({ path: STATUS('S1'), value: 'AT_UP', dir: 'in' });
  await settle();
  assert.equal(page.lock.PRW, false, 'left open');
  assert.deepEqual(log(), [
    'PRW locked: take sent',
    'PRW opened by the operator mid-take — left open',
    'take landed — PRW left as the operator set it'
  ]);
});

test('a padlock already shut when the take starts is the operator’s, and stays shut after', async (t) => {
  const { dom, page, frame, log } = rig();
  t.after(() => dom.uninstall());

  page.buttons.PRW.click();
  assert.equal(page.lock.PRW, true);

  page.take(TAKE('S1', 'xTakeUp'));
  await settle();
  frame({ path: STATUS('S1'), value: 'EFFECT_FROM_DOWN', dir: 'in' });
  frame({ path: STATUS('S1'), value: 'AT_UP', dir: 'in' });
  await settle();
  assert.equal(page.lock.PRW, true, 'still shut: it was never ours');
  assert.deepEqual(log(), ['take started — PRW was already locked, left as it is']);
  assert.deepEqual(page.errors, []);
});
