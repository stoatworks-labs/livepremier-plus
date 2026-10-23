/*
 * The link, with no key pressed: the console answers, says what its keys are,
 * takes the app's model and draws it.
 *
 * Nothing here presses a key or writes to the switcher, so it is the file to
 * run first on a console nobody has tried — and the one that tells the rest of
 * the suite which keys this console has.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKIP, MODEL, STAND_IN, AREA, FUNCTION_KEYS, LINK,
  openConsole, readKeyMap, assertNoOtherDriver, assertQuiet, startPanel, panelState, waitPanel, expectedModel,
  recorder, sleep, keyMapOf,
} from './harness.js';
import { MINI_KEYS } from '../helpers/fake-ucenter.js';
import { silentNote } from '../../plugins/pixelhue/core.js';

let con;
let app;
let keyMap;
let expected;
const rec = recorder('link');

before(async () => {
  if (SKIP) return;
  await assertNoOtherDriver();
  con = await openConsole();
});

after(async () => {
  if (SKIP) return;
  try { console.log(`# kept ${await rec.save()}`); }
  finally {
    await app?.close();
    await con?.close();
  }
});

test('the console answers on its control port, and everything it sends decodes', { skip: SKIP }, async () => {
  /* The first frame after a connect is the whole key-state dump — on a U5.
     On a mini, at client-type 5, nobody knows yet: if this times out, the
     results file and the message say what was heard instead. */
  rec.note('socket', con.witness.url);
  try {
    await con.witness.waitFor('keys', () => true, { mark: 1, timeout: 5000, label: 'the first key-state dump' });
  } catch (err) {
    const frames = con.witness.link.state.frames;
    rec.note('firstDump', { keys: 0, frames, undecodable: con.witness.undecodable });
    throw new Error(`${err.message}. ${silentNote(MODEL.id, { after: 5000, frames, clientType: LINK.clientType })}`);
  }
  await sleep(1000);
  rec.note('firstDump', { keys: con.witness.keys.size, undecodable: con.witness.undecodable });
  assert.equal(con.witness.undecodable, 0, 'frames the vendored codec could not read');
});

test(`it serves its own key map for deviceModel ${MODEL ? MODEL.modelId : '?'}`, { skip: SKIP }, async () => {
  keyMap = await readKeyMap();
  rec.note('keyMap', keyMap.keys);
  assert.ok(!keyMap.empty, 'an empty key map: the app could not find the keys that report no command (MVR, SOURCE BACKUP)');
  for (const [name, area] of Object.entries(AREA)) {
    const keys = keyMap.bus(area);
    assert.equal(keys.length, MODEL.busWidth, `the ${name} bus has ${keys.length} positions, not ${MODEL.busWidth}`);
  }
  const present = FUNCTION_KEYS.filter((f) => keyMap.byMode(f.mode) !== null).map((f) => f.name);
  const absent = FUNCTION_KEYS.filter((f) => keyMap.byMode(f.mode) === null).map((f) => f.name);
  rec.note('functionKeys', { present, absent });
  for (const must of ['TAKE', 'CUT']) assert.ok(present.includes(must), `no ${must} key in the map`);
});

test('a U5 mini\'s key map is the one its firmware ships', { skip: SKIP || (MODEL && MODEL.id !== 'u5mini') }, () => {
  assert.ok(keyMap, 'the key map test did not get one');
  const line = (k) => `${k.key}/${k.page}/${k.index}/${k.mode}/${k.area}`;
  const shipped = new Set(keyMapOf({ data: MINI_KEYS }).keys.map(line));
  const served = new Set(keyMap.keys.map(line));
  const missing = [...shipped].filter((x) => !served.has(x));
  const extra = [...served].filter((x) => !shipped.has(x));
  rec.note('keyMapAgainstFirmware', { missing, extra });
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] },
    'key/page/index/mode/area that differ from key_mini.xml V1.0.3 — a newer firmware, or a custom layout. ' +
    'Update test/fixtures/pixelhue-u5mini-keys.json from what this console served (kept in the results file).');
});

test('the app connects to it and publishes the switcher', { skip: SKIP }, async () => {
  expected = await expectedModel();
  app = await startPanel();
  const st = await panelState(app);
  const published = st.history.find((h) => h.kind === 'published');
  rec.note('published', published);
  assert.equal(published.screens, expected.model.screens.length);
  assert.equal(published.inputs, expected.model.inputs.length);
  assert.equal(published.presets, expected.model.presets.length);
  assert.ok(published.screens >= 1, 'the simulator has no screen in service, so there is nothing to drive');
});

test('a U5 mini\'s key grid takes this app\'s connection, and is drawn whole', { skip: SKIP || (MODEL && !MODEL.grid && 'only a U5 mini has a key grid') }, async () => {
  /* A mini's bus keys are its LCD app's, so the app draws them over TCP 17100
     (`plugins/pixelhue/grid-link.js`). Nothing here needs a person: whether
     the console takes a client from the LAN, and whether every key went out,
     the app can say. Whether they SHOW is `3-hands`'s question — a row shows
     them only once switched to Companion. */
  let st = null;
  try {
    st = await waitPanel(app, (x) => x.grid && ((x.grid.connected && x.grid.drawn >= 40) || x.grid.letGo),
      { timeout: 15000, label: 'the key grid to connect and be drawn' });
  } finally {
    st = st || await panelState(app);
    rec.note('grid', st.grid);
  }
  assert.equal(st.grid.letGo, null, st.grid.letGo && st.grid.letGo.note);
  assert.equal(st.grid.connected, true, st.grid.lastError || 'the key grid did not connect');
  assert.ok(st.grid.drawn >= 40, `${st.grid.drawn} of 40 keys drawn`);
  if (STAND_IN) {
    const lcd = con.standIn.lcd;
    assert.ok(lcd.current && !lcd.current.local, 'the stand-in\'s grid is held by the app, from the LAN');
    assert.ok(lcd.draws >= 40, `the stand-in took ${lcd.draws} draws`);
    assert.deepEqual(lcd.rejected, [], 'every draw is one the LCD app would take');
  }
});

test('nothing else is publishing to the console', { skip: SKIP }, async () => {
  const labels = [...expected.model.screens, ...expected.model.inputs, ...expected.model.presets].map((o) => o.name);
  await assertQuiet(con.witness, labels);
});

test('the console draws the model from position 1 of every bus', { skip: SKIP }, async (t) => {
  /* ⚠️ `index` is 1-based: publishing from zero drops the first object of
     every bus with no error. On a console this is the test that shows it.
     ⚠️ Not on a real U5 mini: its bus keys are its LCD app's, so what its
     control service reports for them is recorded and said, not required. */
  const drawn = {};
  if (MODEL.grid && !STAND_IN) {
    await sleep(2000);
    const differ = [];
    for (const [bus, list] of [['screen', expected.model.screens], ['input', expected.model.inputs], ['preset', expected.model.presets]]) {
      const keys = keyMap.bus(AREA[bus]);
      drawn[bus] = keys.map((k) => con.witness.text(k));
      if (list.length && drawn[bus][0] !== list[0].name) differ.push(`${bus}: "${drawn[bus][0]}" for "${list[0].name}"`);
    }
    rec.note('drawn', drawn);
    if (differ.length) t.diagnostic(`the mini's control service does not report the published names (${differ.join('; ')}) — expected, since its LCD app owns those keys`);
    return;
  }
  for (const [bus, list] of [['screen', expected.model.screens], ['input', expected.model.inputs], ['preset', expected.model.presets]]) {
    const keys = keyMap.bus(AREA[bus]);
    drawn[bus] = keys.map((k) => con.witness.text(k));
    if (!list.length) continue;
    await con.witness.waitText(keys[0], list[0].name);
    const shown = Math.min(keys.length, list.length);
    for (let i = 0; i < shown; i++) {
      assert.equal(con.witness.text(keys[i]), list[i].name, `${bus} position ${i + 1} (key ${keys[i]})`);
    }
  }
  rec.note('drawn', drawn);
});

test('the faders and encoders bind, or the console says why', { skip: SKIP }, async (t) => {
  const st = await panelState(app);
  const refused = st.history.find((h) => h.error && /binding faders and encoders/.test(h.error));
  rec.note('binding', refused ? refused.error : 'accepted');
  if (STAND_IN || MODEL.id !== 'u5mini') {
    assert.equal(refused, undefined, refused && refused.error);
    return;
  }
  /* A U5 mini has no faders or encoders. Whether its UCenter takes the
     binding anyway is worth knowing and not worth failing on. */
  if (refused) t.diagnostic(`the mini refused the binding: ${refused.error}`);
});

test('the keys that report nothing are found in the console\'s key map', { skip: SKIP }, () => {
  const silent = { MVR: keyMap.byMode(112), 'SOURCE BACKUP': keyMap.byMode(181, 3) ?? keyMap.keys.find((k) => k.mode === 181)?.key ?? null };
  rec.note('silentKeys', silent);
  if (MODEL.id === 'u5mini') {
    /* key_mini.xml has neither; the mini's own map says whether a newer one does. */
    return;
  }
  assert.notEqual(silent.MVR, null, 'no MVR key in the map');
});
