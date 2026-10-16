/*
 * The hands-on half: what only a person at the console can check.
 *
 *   LPP_CONSOLE=192.168.0.50 LPP_CONSOLE_GUIDED=1 LPP_SIM=127.0.0.1:3000 npm run test:console
 *
 * `2-keys.console.test.js` injects presses at UCenter, which proves the
 * console's service and the app agree. It cannot prove the key under a thumb
 * is the key the map says, that a key's display reads what was published,
 * that a hold is a long press, or that the T-bar does anything at all. This
 * walks a person through each, waits for the console to report what they did,
 * and keeps every report — the T-bar's especially, which no one has yet seen
 * from a mini.
 *
 * The prompts go to the terminal itself (`/dev/tty`), not to stdout: `node
 * --test` runs each file in a child whose stdout belongs to the test runner.
 * A step waits for the console, not for Enter; type `s` and Enter to skip one.
 * A question wants `y` or `n`.
 *
 * With the stand-in console there is nobody to ask, so the stand-in does what
 * each step asks — which is how this file is dry-run, and all it proves.
 *
 * The walk starts with nothing selected, so the function keys can be pressed
 * in turn without any of them reaching the switcher. Only the T-bar steps
 * select S1, and `guardScreen` puts it back.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openSync, closeSync, createReadStream, createWriteStream } from 'node:fs';
import readline from 'node:readline';

import {
  SKIP, GUIDED, STAND_IN, MODEL, AREA, FUNCTION_KEYS, functionKey, keyMapOf,
  openConsole, readKeyMap, assertNoOtherDriver, assertQuiet, startPanel, expectedModel,
  panelState, waitPanel, waitHistory, historySince, recorder, sleep,
} from './harness.js';
import { Link, guardScreen, settled, sag, awjGet } from '../sim/harness.js';
import { MINI_KEYS } from '../helpers/fake-ucenter.js';

const ID = 'S1';
const HOLD_MS = 2000;
let con;
let app;
let link;
let guard;
let keyMap;
let expected;
let person = null;
const rec = recorder('hands');

/* Who is at the console: a person on the terminal, or the stand-in. */
const RUN = SKIP
  || (!GUIDED && !STAND_IN && 'LPP_CONSOLE_GUIDED is not set: this file needs a person at the console');

before(async () => {
  if (RUN) return;
  if (!STAND_IN) {
    person = Person.open();
    if (!person) throw new Error('no terminal to ask on (/dev/tty): run this from a terminal, not a pipe');
  }
  await assertNoOtherDriver();
  con = await openConsole();
  keyMap = await readKeyMap();
  if (keyMap.empty && MODEL.id === 'u5mini') keyMap = keyMapOf({ data: MINI_KEYS });
  expected = await expectedModel();
  app = await startPanel();
  link = await Link.open(app);
  guard = await guardScreen(link, ID);
  await assertQuiet(con.witness, [...expected.model.screens, ...expected.model.inputs, ...expected.model.presets].map((o) => o.name));
  person?.say(`Console suite, by hand: a ${MODEL.label} at ${con.witness.host}:${con.witness.port}. ` +
    'Each step waits for the console; type s and Enter to skip one.');
});

after(async () => {
  if (RUN) return;
  try { if (guard) await guard.restore(); }
  finally {
    try { console.log(`# kept ${await rec.save()}`); } catch { /* the run matters more */ }
    person?.close();
    link?.close();
    await app?.close();
    await con?.close();
  }
});

/* ------------------------------------------------------------------ *
 * Asking
 * ------------------------------------------------------------------ */

class Person {
  static open() {
    try { return new Person(openSync('/dev/tty', 'r'), openSync('/dev/tty', 'w')); } catch { return null; }
  }

  constructor(rfd, wfd) {
    this.fds = [rfd, wfd];
    this.out = createWriteStream(null, { fd: wfd, autoClose: false });
    this.input = createReadStream(null, { fd: rfd, autoClose: false });
    this.rl = readline.createInterface({ input: this.input });
    this.waiting = [];
    this.rl.on('line', (l) => { const w = this.waiting.shift(); if (w) w(l.trim()); });
  }

  say(text) { this.out.write(`\n  ▶ ${text}\n`); }

  /** The next line typed, and a way to stop waiting for it. */
  line() {
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    this.waiting.push(resolve);
    return { promise: p, cancel: () => { this.waiting = this.waiting.filter((w) => w !== resolve); } };
  }

  async ask(question) {
    this.out.write(`  ? ${question} `);
    return (await this.line().promise).toLowerCase();
  }

  close() {
    this.rl.close();
    this.input.destroy();
    for (const fd of this.fds) { try { closeSync(fd); } catch { /* gone */ } }
  }
}

const SKIPPED = Symbol('skipped');

/**
 * One instruction: say it (or have the stand-in do it), and resolve with what
 * `until` resolves with — or SKIPPED, when the person types `s`.
 */
async function step(text, { act, until, timeout = 120000 }) {
  const waiting = until(timeout);
  if (STAND_IN) {
    await act(con.standIn);
    return waiting;
  }
  person.say(text);
  const typed = person.line();
  const skip = typed.promise.then((l) => (l === 's' ? SKIPPED : new Promise(() => {})));
  try { return await Promise.race([waiting, skip]); }
  finally { typed.cancel(); }
}

/** A yes/no question; the stand-in answers with `truth`. */
async function confirm(question, truth) {
  if (STAND_IN) return truth(con.standIn);
  for (;;) {
    const a = await person.ask(`${question} [y/n]`);
    if (a === 'y' || a === 'n') return a === 'y';
  }
}

/** The next press of any key (its down), and the command that followed, if any. */
function nextPress(timeout) {
  const mark = con.witness.mark();
  return con.witness.waitFor('press', (d) => d.state === 0, { mark, timeout, label: 'a key press' })
    .then(async (down) => {
      const up = await con.witness.waitFor('press', (d) => d.key === down.key && d.state === 1, { mark, timeout, label: 'the key to come up' })
        .catch(() => null);
      const report = await con.witness.commandAfter(mark, { timeout: 800 });
      return { key: down.key, released: !!up, command: report ? Number(report.command) : null, payload: report && report.payload };
    });
}

const busName = (area) => Object.keys(AREA).find((n) => AREA[n] === area);

/* ------------------------------------------------------------------ *
 * The displays
 * ------------------------------------------------------------------ */

test('the key displays read what was published', { skip: RUN }, async () => {
  const seen = {};
  for (const [area, list] of [[AREA.screen, expected.model.screens], [AREA.input, expected.model.inputs], [AREA.preset, expected.model.presets]]) {
    if (!list.length) continue;
    const key = keyMap.bus(area)[0];
    const yes = await confirm(`Does the first ${busName(area)} key (key ${key}) read "${list[0].name}"?`,
      (s) => s.label(area, key) === list[0].name);
    seen[busName(area)] = yes;
  }
  rec.note('displays', seen);
  assert.deepEqual(Object.values(seen).filter((v) => !v), [], `displays that did not read the model: ${JSON.stringify(seen)}`);
});

/* ------------------------------------------------------------------ *
 * Every function key, under a thumb
 * ------------------------------------------------------------------ */

/* Keys that latch on the console are pressed twice, so the walk leaves them
   as it found them. SHIFT and the area-switch keys change what the other keys
   are, so they have a test of their own, after everything else. */
const TWICE = new Set(['PGM EDIT', 'SAVE TO', 'DEL', 'SWAP', 'FTB', 'FRZ']);
const NOT_IN_WALK = new Set(['SHIFT', 'AREA SWITCH']);

test('each function key is the key the map says, and reports what the table says', { skip: RUN }, async (t) => {
  const present = FUNCTION_KEYS.filter((f) => keyMap.byMode(f.mode) !== null && !f.long && !NOT_IN_WALK.has(f.name));
  const found = [];
  const since = Date.now();
  for (const f of present) {
    const key = keyMap.byMode(f.mode);
    const times = TWICE.has(f.name) ? 2 : 1;
    for (let n = 1; n <= times; n++) {
      const got = await step(`Press ${f.name}${times > 1 ? (n === 1 ? ' (once now, and again when asked)' : ' again') : ''}.`, {
        act: (s) => s.thumb(key),
        until: nextPress,
      });
      if (got === SKIPPED) { found.push({ name: f.name, skipped: true }); break; }
      found.push({ name: f.name, mapKey: key, pressed: got.key, command: got.command, payload: got.payload });
    }
  }
  rec.note('functionKeys', found);
  /* Nothing was selected, so none of this may have reached the switcher. */
  const lines = await historySince(app, since);
  assert.ok(!lines.some((h) => h.kind === 'sent'), `something was sent with nothing selected: ${JSON.stringify(lines.filter((h) => h.kind === 'sent'))}`);
  const wrong = found.filter((x) => !x.skipped && x.pressed !== x.mapKey);
  assert.deepEqual(wrong, [], 'keys whose press reported a different key code from the map');
  const unexpected = found.filter((x) => {
    const f = functionKey(x.name);
    if (x.skipped || f.reports === null) return false;
    return f.reports.length ? !f.reports.includes(x.command) : x.command !== null;
  });
  assert.deepEqual(unexpected, [], 'keys that reported something other than mapping.js expects');
  const unknown = found.filter((x) => functionKey(x.name).reports === null && !x.skipped);
  if (unknown.length) t.diagnostic(`first sightings: ${unknown.map((x) => `${x.name} → ${x.command ?? 'nothing'}`).join(', ')}`);
});

/* ------------------------------------------------------------------ *
 * Holds
 * ------------------------------------------------------------------ */

test('LOCK PANEL: a tap does nothing here, a hold locks, and a locked panel does not take', { skip: RUN }, async (t) => {
  const lock = keyMap.byMode(functionKey('LOCK PANEL').mode);
  if (lock === null) { t.skip('no LOCK PANEL key on this layout'); return; }
  const take = keyMap.byMode(functionKey('TAKE').mode);
  const out = {};
  out.hold = await step(`Hold LOCK PANEL for ${HOLD_MS / 1000} seconds, then let go.`, {
    act: (s) => s.thumb(lock, HOLD_MS),
    until: nextPress,
  });
  if (out.hold === SKIPPED) { t.skip('skipped at the console'); return; }
  t.after(async () => { if ((await panelState(app)).locked) rec.note('leftLocked', true); });
  await waitPanel(app, (s) => s.locked === true, { label: 'the panel to lock', timeout: 3000 });
  out.takeWhileLocked = await step('Press TAKE (nothing should happen).', { act: (s) => s.thumb(take), until: nextPress });
  out.release = await step(`Hold LOCK PANEL for ${HOLD_MS / 1000} seconds again.`, {
    act: (s) => s.thumb(lock, HOLD_MS),
    until: nextPress,
  });
  rec.note('lockPanel', out);
  assert.ok([523, 524].includes(out.hold.command), `a held LOCK PANEL reported ${out.hold.command}`);
  await waitPanel(app, (s) => s.locked === false, { label: 'the panel to unlock', timeout: 3000 });
});

test('a held screen key drops a selected screen', { skip: RUN }, async (t) => {
  const s1 = expected.model.screens.find((s) => s.uid === ID);
  if (!s1) { t.skip(`${ID} is not in service`); return; }
  const key = keyMap.bus(AREA.screen)[expected.model.screens.indexOf(s1)];
  if (key === undefined) { t.skip(`${ID} is not on the first page of the screen bus`); return; }
  const select = await step(`Press the "${s1.name}" screen key once.`, { act: (s) => s.thumb(key), until: nextPress });
  if (select === SKIPPED) { t.skip('skipped at the console'); return; }
  await waitPanel(app, (s) => s.selection.destinations.includes(ID), { label: `${ID} to be selected` });
  const lamp = await confirm(`Is the "${s1.name}" key lit as selected?`, () => true);
  const drop = await step(`Now hold it for ${HOLD_MS / 1000} seconds, then let go.`, {
    act: (s) => s.thumb(key, HOLD_MS),
    until: nextPress,
  });
  rec.note('screenHold', { select, lamp, drop });
  assert.equal(select.command, 101);
  assert.equal(drop.command, 103, 'a held selected screen reports unselect');
  await waitPanel(app, (s) => !s.selection.destinations.includes(ID), { label: `${ID} to be dropped` });
});

/* ------------------------------------------------------------------ *
 * The T-bar
 * ------------------------------------------------------------------ */

/** Every T-bar report from `mark`, once the app says the stroke completed (or a minute passes). */
function stroke(since) {
  return (timeout) => {
    const mark = con.witness.mark();
    return waitHistory(app, since, (h) => /T-bar completed/.test(h.note || ''), { timeout, label: 'the T-bar stroke to complete' })
      .then(() => con.witness.since(mark, 'tbar').map((e) => ({ at: e.at, ...e.data })));
  };
}

test('the T-bar takes S1 one way, and back the other', { skip: RUN }, async (t) => {
  const s1 = expected.model.screens.find((s) => s.uid === ID);
  const key = s1 && keyMap.bus(AREA.screen)[expected.model.screens.indexOf(s1)];
  if (key === undefined) { t.skip(`${ID} is not on the first page of the screen bus`); return; }
  const select = await step(`Press the "${s1.name}" screen key once, to select it.`, { act: (s) => s.thumb(key), until: nextPress });
  if (select === SKIPPED) { t.skip('skipped at the console'); return; }
  await waitPanel(app, (s) => s.selection.destinations.includes(ID), { label: `${ID} to be selected` });

  const throws = [];
  for (const way of ['all the way to the other end', 'all the way back']) {
    const from = await settled(link, ID);
    const to = from === 'AT_UP' ? 'AT_DOWN' : 'AT_UP';
    const reports = await step(`Push the T-bar ${way}, steadily.`, { act: (s) => s.throwTbar(), until: stroke(Date.now()) });
    if (reports === SKIPPED) { t.skip('skipped at the console'); return; }
    await link.waitFor(sag(ID, 'status', 'transition'), to, { timeout: 15000, label: `${ID} to reach ${to}` });
    throws.push({
      from, to, count: reports.length,
      first: reports.slice(0, 3), last: reports.slice(-3),
      fields: reports.length ? Object.keys(reports[0]) : [],
    });
  }
  rec.note('tbar', throws);
  for (const th of throws) assert.ok(th.count > 0, 'a stroke with no reports');
  assert.equal(await awjGet(sag(ID, 'status', 'transition')), throws[0].from, `${ID} is back where it started`);

  /* The selection is left as the walk found it. */
  await step(`Hold the "${s1.name}" key for ${HOLD_MS / 1000} seconds to drop it.`, { act: (s) => s.thumb(key, HOLD_MS), until: nextPress });
});

/* ------------------------------------------------------------------ *
 * Paging, SHIFT and the area-switch keys: recorded, for the docs
 * ------------------------------------------------------------------ */

test('a bus\'s page keys move it on a page, and back', { skip: RUN }, async (t) => {
  const down = keyMap.pageKey(AREA.preset, +1);
  const up = keyMap.pageKey(AREA.preset, -1);
  if (down === null || up === null) { t.skip('no page keys on the preset bus'); return; }
  const before = keyMap.bus(AREA.preset).map((k) => con.witness.text(k));
  const pressDown = await step('Press the preset bus\'s page-down (▼) key.', { act: (s) => s.thumb(down), until: nextPress });
  if (pressDown === SKIPPED) { t.skip('skipped at the console'); return; }
  await sleep(500);
  const after = keyMap.bus(AREA.preset).map((k) => con.witness.text(k));
  const moved = await confirm('Did the preset keys move on to another page?', () => JSON.stringify(after) !== JSON.stringify(before));
  await step('Press the preset bus\'s page-up (▲) key.', { act: (s) => s.thumb(up), until: nextPress });
  await sleep(500);
  rec.note('paging', { pressDown, before, after, moved, back: keyMap.bus(AREA.preset).map((k) => con.witness.text(k)) });
  assert.equal(pressDown.key, down, 'the page-down key is the one the map says');
});

test('SHIFT and the area-switch keys, pressed and recorded', { skip: RUN }, async (t) => {
  const shift = keyMap.byMode(functionKey('SHIFT').mode);
  const areas = keyMap.allByMode(functionKey('AREA SWITCH').mode);
  if (shift === null && !areas.length) { t.skip('this layout has neither'); return; }
  const out = {};
  if (shift !== null) {
    const del = keyMap.byMode(functionKey('DEL').mode);
    out.shift = await step('Hold SHIFT, press DEL (the keypad\'s 1), then let go of both.', {
      act: async (s) => { await s.thumb(shift, 50); await s.thumb(del); },
      until: (timeout) => collect(timeout, STAND_IN ? 500 : 4000),
    });
  }
  for (const key of areas) {
    const bus = keyMap.keys.find((k) => k.key === key);
    const name = busName(bus ? bus.area : 0) || 'a';
    out[`area-${key}`] = await step(`Press the ${name} bus's area-switch key (key ${key}), and look at what that row shows.`, {
      act: (s) => s.thumb(key),
      until: nextPress,
    });
    if (!STAND_IN && out[`area-${key}`] !== SKIPPED) {
      out[`area-${key}-shows`] = await person.ask('What does the row show now? (a few words, then Enter)');
      await step('Press it until the row shows what it did before, then type s and Enter.', { act: () => {}, until: () => new Promise(() => {}) });
    }
  }
  rec.note('shiftAndAreas', JSON.parse(JSON.stringify(out, (k, v) => (v === SKIPPED ? 'skipped' : v))));
});

/** Everything pressed and reported over `ms` after the first press. */
function collect(timeout, ms) {
  const mark = con.witness.mark();
  return con.witness.waitFor('press', () => true, { mark, timeout, label: 'a key press' })
    .then(() => sleep(ms))
    .then(() => ({
      presses: con.witness.since(mark, 'press').map((e) => e.data),
      commands: con.witness.since(mark, 'command').map((e) => ({ command: e.data.command, payload: e.data.payload })),
    }));
}

/* ------------------------------------------------------------------ *
 * Faders and encoders: a U5 or U5 Pro only
 * ------------------------------------------------------------------ */

test('fader 1 moves layer 1\'s opacity on the selected screen', { skip: RUN || (MODEL && MODEL.id === 'u5mini' && 'a U5 mini has no faders') }, async (t) => {
  const s1 = expected.model.screens.find((s) => s.uid === ID);
  const key = s1 && keyMap.bus(AREA.screen)[expected.model.screens.indexOf(s1)];
  if (key === undefined) { t.skip(`${ID} is not on the first page of the screen bus`); return; }
  await step(`Press the "${s1.name}" screen key once.`, { act: (s) => s.thumb(key), until: nextPress });
  const since = Date.now();
  const moved = await step('Move fader 1 all the way up, then all the way down.', {
    act: () => {},
    until: (timeout) => waitHistory(app, since, (h) => h.command === 'fader.1' && h.kind === 'sent', { timeout, label: 'a fader gesture' }),
  });
  rec.note('fader', { moved, midi: con.witness.since(1, 'midi').slice(-6).map((e) => e.data) });
  if (moved === SKIPPED) { t.skip('skipped at the console'); return; }
  assert.ok(moved.sent && moved.sent.length, 'the gesture wrote nothing');
  await step(`Hold the "${s1.name}" key for ${HOLD_MS / 1000} seconds to drop it.`, { act: (s) => s.thumb(key, HOLD_MS), until: nextPress });
});
