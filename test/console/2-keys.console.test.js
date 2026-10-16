/*
 * Every key the app acts on, pressed through the console's own service, and
 * what each did to the switcher.
 *
 * A press goes in at UCenter (`PUT key/action`), comes back to the app as the
 * console's command report, and lands on the simulator as a write. Each test
 * checks all three: the report on our own socket, the app's history, and the
 * switcher over AWJ. Keys are found by function in the console's own key map,
 * and bus keys by what they show, so the file reads the same on a U5 mini and
 * a U5 Pro.
 *
 * It writes to the simulator's S1 (and nothing else), keeping `test/sim/`'s
 * rules: `guardScreen` puts S1 back, every toggle's paths are read before the
 * first press and written back if a test stops half-way, and the one memory
 * it stores is deleted again. That memory goes in the first free slot of
 * 1–32, not at the top of the bank as `test/sim/` does it — the app chooses
 * the slot, and the panel shows only those 32.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKIP, MODEL, AREA, FUNCTION_KEYS, functionKey, keyMapOf,
  openConsole, readKeyMap, press, assertNoOtherDriver, assertQuiet, startPanel, expectedModel,
  panelState, waitPanel, waitHistory, historySince, recorder, sleep,
} from './harness.js';
import {
  Link, guardScreen, settled, sag, layerPath, previewLook, slotValid, awjGet, awjGetAll, awjReplace, deepEqual, sse,
} from '../sim/harness.js';
import { MINI_KEYS } from '../helpers/fake-ucenter.js';
import { NLC } from '../../src/core/dialect.js';

const ID = 'S1';
let con;
let app;
let link;
let guard;
let keyMap;
let expected;
let injected = false;
const pages = { [AREA.screen]: 0, [AREA.input]: 0, [AREA.layer]: 0, [AREA.preset]: 0 };
const presses = [];
const rec = recorder('keys');

before(async () => {
  if (SKIP) return;
  await assertNoOtherDriver();
  con = await openConsole();
  keyMap = await readKeyMap();
  if (keyMap.empty && MODEL.id === 'u5mini') {
    /* The app would then have no MVR / SOURCE BACKUP keys; the link file says
       so. The presses below still need key codes. */
    keyMap = keyMapOf({ data: MINI_KEYS });
    rec.note('keyMapFallback', 'the console served no key map; pressing by key_mini.xml');
  }
  expected = await expectedModel();
  app = await startPanel();
  link = await Link.open(app);
  guard = await guardScreen(link, ID);
  await assertQuiet(con.witness, [...expected.model.screens, ...expected.model.inputs, ...expected.model.presets].map((o) => o.name));
});

after(async () => {
  if (SKIP) return;
  rec.note('presses', presses);
  try {
    for (const area of Object.keys(pages)) await pageHome(Number(area)).catch(() => {});
    if (guard) await guard.restore();
  } finally {
    try { console.log(`# kept ${await rec.save()}`); } catch { /* the run matters more */ }
    link?.close();
    await app?.close();
    await con?.close();
  }
});

/* ------------------------------------------------------------------ *
 * Pressing, and finding keys
 * ------------------------------------------------------------------ */

/**
 * Press `key` and wait for the console's report. `expect` is the command (or
 * commands) it should report; without it, whatever comes in a second, or
 * null. Every press is kept for the results file.
 */
async function pressed(name, key, { hold = 0, expect, timeout = 3000 } = {}) {
  const mark = con.witness.mark();
  const since = Date.now();
  await press(key, { hold });
  let report = null;
  try {
    report = expect === undefined
      ? await con.witness.commandAfter(mark, { timeout: 1000 })
      : await con.witness.waitFor('command', (d) => [].concat(expect).includes(Number(d.command)),
        { mark, timeout, label: `${name} to report ${[].concat(expect).join(' or ')}` });
  } finally {
    const seen = con.witness.since(mark, 'command').map((e) => e.data);
    presses.push({ name, key, hold, reported: seen.map((d) => ({ command: d.command, index: d.index, payload: d.payload })) });
  }
  return { report, since, mark };
}

function needsInjection(t) {
  if (injected) return false;
  t.skip('injected presses did not reach this console — see the first test');
  return true;
}

/** The key of a function, or skip the test when this console has none. */
function keyOf(t, name) {
  const f = functionKey(name);
  const key = keyMap.byMode(f.mode);
  if (key === null) t.skip(`this console's layout has no ${name} key`);
  return key;
}

const busTexts = (area) => keyMap.bus(area).map((k) => con.witness.text(k));

/** Page a bus once; resolves true if what it shows changed. */
async function page(area, dir) {
  const key = keyMap.pageKey(area, dir);
  if (key === null) return false;
  const before = busTexts(area).join('\u0000');
  const mark = con.witness.mark();
  await press(key);
  await con.witness.waitFor('keys', () => busTexts(area).join('\u0000') !== before, { mark, timeout: 1500 }).catch(() => {});
  const moved = busTexts(area).join('\u0000') !== before;
  if (moved) pages[area] += dir;
  return moved;
}

async function pageHome(area) {
  for (let i = 0; i < 8 && pages[area] > 0; i++) if (!(await page(area, -1))) break;
  pages[area] = 0;
}

/**
 * The bus key showing `want` (a label, or a predicate on one), paging the bus
 * if it is not on the page shown. Waits a moment first: a key relabels after
 * the app republishes.
 */
async function findKey(area, want, { wait = 1500 } = {}) {
  const match = typeof want === 'function' ? want : (text) => text === want;
  const here = () => keyMap.bus(area).find((k) => match(con.witness.text(k))) ?? null;
  const t0 = Date.now();
  while (Date.now() - t0 < wait) {
    if (here() !== null) return here();
    await sleep(50);
  }
  for (let i = 0; i < 8; i++) {
    if (!(await page(area, +1))) break;
    if (here() !== null) return here();
  }
  await pageHome(area);
  if (here() !== null) return here();
  throw new Error(`no ${Object.keys(AREA).find((n) => AREA[n] === area)} key shows ${typeof want === 'function' ? 'what was wanted' : `"${want}"`}; ` +
    `the bus reads ${JSON.stringify(busTexts(area))}`);
}

/* ------------------------------------------------------------------ *
 * The switcher, read and put back
 * ------------------------------------------------------------------ */

const letterOf = (side) => link.get(sag(ID, 'control', side === 'UP' ? 'presetUp' : 'presetDown'));

/** Which preset letter is program and which preview on S1, once it has settled. */
async function letters() {
  const t = await settled(link, ID);
  const program = t === 'AT_UP' ? 'UP' : 'DOWN';
  return { transition: t, program: letterOf(program), preview: letterOf(program === 'UP' ? 'DOWN' : 'UP'), programDest: program };
}

/** Read `paths` over AWJ now, and register putting them back when the test ends. */
async function keep(t, paths) {
  const before = await awjGetAll(paths);
  t.after(async () => {
    const now = await awjGetAll(paths);
    for (let i = 0; i < paths.length; i++) {
      if (!deepEqual(now[i], before[i])) await awjReplace(paths[i], before[i]);
    }
  });
  return before;
}

const source = (letter) => layerPath(ID, letter, 1, 'source', 'pp', 'inputNum');
const loaded = (letter, prop) => ['device', 'presetBank', 'status', 'presetId', 'screenList', 'items', ID, 'presetList', 'items', letter, 'pp', prop];

/** The app's own `sent` line for a press, which names every AWJ path it wrote. */
const sentSince = (since, re) => waitHistory(app, since, (h) => h.kind === 'sent' && (!re || re.test(h.note || '')), { timeout: 4000, label: `a sent line${re ? ` matching ${re}` : ''}` });

/* ------------------------------------------------------------------ *
 * The buses
 * ------------------------------------------------------------------ */

test('a screen key, pressed by injection, selects that screen', { skip: SKIP }, async (t) => {
  const s1 = expected.model.screens.find((s) => s.uid === ID);
  if (!s1) { t.skip(`${ID} is not in service on the simulator`); return; }
  const key = await findKey(AREA.screen, s1.name);
  let report;
  try {
    ({ report } = await pressed('screen key', key, { expect: [101, 102] }));
  } catch (err) {
    rec.note('injection', err.message);
    throw new Error(`an injected press did not come back as a command: ${err.message}`);
  }
  injected = true;
  rec.note('injection', 'works');
  assert.equal(report.payload.uid, ID, 'the screen comes back with the uid it was published under');
  await waitPanel(app, (s) => s.selection.destinations.includes(ID), { label: `${ID} to be selected` });
  /* ⚠️ The console shows the active screen's layers only, and only when the
     screen is published active on preview — so this is the test that layers
     bind on this console. */
  const firstLayer = expected.facts.layers.find((l) => l.destination === ID);
  if (firstLayer) await con.witness.waitText(keyMap.bus(AREA.layer)[0], `Layer ${firstLayer.key}`);
  rec.note('screenLamp', { key, state: con.witness.state(key) });
});

test('a layer key selects that layer for the input bus', { skip: SKIP }, async (t) => {
  if (needsInjection(t)) return;
  const fitted = expected.facts.layers.filter((l) => l.destination === ID).map((l) => l.key);
  if (!fitted.length) { t.skip(`${ID} has no fitted layer`); return; }
  for (const n of [...fitted.slice(1, 2), fitted[0]]) {
    const key = await findKey(AREA.layer, `Layer ${n}`);
    const { report } = await pressed(`layer ${n}`, key, { expect: 201 });
    assert.equal(Number(report.payload.id) % 1000, n, 'the layer id carries its slot');
    await waitPanel(app, (s) => s.selection.layer === n, { label: `layer ${n} to be selected` });
  }
});

test('an input key puts that input on the selected layer, in preview only', { skip: SKIP }, async (t) => {
  if (needsInjection(t)) return;
  const inputs = expected.facts.inputs;
  if (inputs.length < 2) { t.skip('the simulator has fewer than two inputs'); return; }
  const pv = await previewLook(link, { source: inputs[0].source }, ID);
  const { program } = await letters();
  const onAir = await awjGet(source(program));
  const key = await findKey(AREA.input, expected.model.inputs[1].name);
  const since = Date.now();
  const { report } = await pressed('input key', key, { expect: 300 });
  assert.equal(Number(report.payload.id), inputs[1].number, 'the input comes back with its own number');
  await sentSince(since, /on layer/);
  assert.equal(await awjGet(source(pv)), inputs[1].source, 'preview layer 1 carries the input');
  assert.equal(await awjGet(source(program)), onAir, 'program is untouched');
});

test('a preset key recalls that memory to preview, never program', { skip: SKIP }, async (t) => {
  if (needsInjection(t)) return;
  const first = expected.model.presets[0];
  if (!first) { t.skip('no labelled memory in slots 1–32'); return; }
  const { preview, program } = await letters();
  const programHeld = await awjGet(loaded(program, 'id'));
  const key = await findKey(AREA.preset, first.name);
  const since = Date.now();
  const { report } = await pressed('preset key', key, { expect: 401 });
  assert.equal(Number(report.payload.id), first.id, 'the memory comes back with its slot');
  await sentSince(since, /recall/);
  await link.waitFor(loaded(preview, 'id'), first.id, { timeout: 5000 });
  assert.equal(await awjGet(loaded(preview, 'id')), first.id, 'preview holds the memory');
  assert.equal(await awjGet(loaded(program, 'id')), programHeld, 'program is untouched');
});

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

for (const [name, code] of [['TAKE', 531], ['CUT', 532]]) {
  test(`${name} moves preview to program`, { skip: SKIP }, async (t) => {
    if (needsInjection(t)) return;
    const key = keyOf(t, name);
    if (key === null) return;
    const from = await settled(link, ID);
    const to = from === 'AT_UP' ? 'AT_DOWN' : 'AT_UP';
    const since = Date.now();
    await pressed(name, key, { expect: code });
    await sentSince(since);
    await link.waitFor(sag(ID, 'status', 'transition'), to, { timeout: 15000, label: `${ID} to reach ${to}` });
    assert.equal(await awjGet(sag(ID, 'status', 'transition')), to);
  });
}

test('MATCH PGM copies program into preview', { skip: SKIP }, async (t) => {
  if (needsInjection(t)) return;
  const key = keyOf(t, 'MATCH PGM');
  if (key === null) return;
  const { program } = await letters();
  const onAir = await awjGet(source(program));
  const other = expected.facts.inputs.find((i) => i.source !== onAir);
  if (!other) { t.skip('every input is the one on air'); return; }
  const pv = await previewLook(link, { source: other.source }, ID);
  const since = Date.now();
  await pressed('MATCH PGM', key, { expect: 529 });
  await sentSince(since);
  await link.waitFor(source(pv), onAir, { timeout: 5000 });
  assert.equal(await awjGet(source(pv)), onAir);
});

test('PGM EDIT latches which buffer the panel edits, and back', { skip: SKIP }, async (t) => {
  if (needsInjection(t)) return;
  const key = keyOf(t, 'PGM EDIT');
  if (key === null) return;
  await pressed('PGM EDIT', key, { expect: 530 });
  await waitPanel(app, (s) => s.selection.buffer === 'PROGRAM', { label: 'the panel to edit program' });
  await pressed('PGM EDIT', key, { expect: 530 });
  await waitPanel(app, (s) => s.selection.buffer === 'PREVIEW', { label: 'the panel to edit preview again' });
});

/* ------------------------------------------------------------------ *
 * Toggles: each read first, pressed twice, and checked both ways
 * ------------------------------------------------------------------ */

test('FTB fades the screen to black, and up again', { skip: SKIP }, async (t) => {
  if (needsInjection(t)) return;
  const key = keyOf(t, 'FTB');
  if (key === null) return;
  const path = NLC.fadeToBlackPath(ID);
  const [was] = await keep(t, [path]);
  assert.equal(was, false, `${ID} is already faded; the test wants it up`);
  let since = Date.now();
  await pressed('FTB', key, { expect: 518 });
  await sentSince(since, /fade to black/);
  await link.waitFor(path, true, { timeout: 5000 });
  since = Date.now();
  await pressed('FTB', key, { expect: 518 });
  await sentSince(since, /fade up/);
  await link.waitFor(path, false, { timeout: 5000 });
});

test('FRZ freezes what is on air on every fitted layer, and lets go', { skip: SKIP }, async (t) => {
  if (needsInjection(t)) return;
  const key = keyOf(t, 'FRZ');
  if (key === null) return;
  const fitted = expected.facts.layers.filter((l) => l.destination === ID).map((l) => String(l.key));
  const paths = fitted.map((k) => NLC.layerFreezePath(ID, k));
  const was = await keep(t, paths);
  const { programDest } = await letters();
  let since = Date.now();
  await pressed('FRZ', key, { expect: 517 });
  await sentSince(since, /freeze/);
  for (const p of paths) await link.waitFor(p, (v) => Array.isArray(v) && v.includes(programDest), { timeout: 5000 });
  since = Date.now();
  await pressed('FRZ', key, { expect: 517 });
  await sentSince(since, /unfreeze/);
  for (let i = 0; i < paths.length; i++) {
    await link.waitFor(paths[i], (v) => Array.isArray(v) && !v.includes(programDest), { timeout: 5000 });
    assert.deepEqual([...(await awjGet(paths[i]))].sort(), [...was[i]].filter((d) => d !== programDest).sort());
  }
});

test('SWAP flips whether a take swaps or copies, and back', { skip: SKIP }, async (t) => {
  if (needsInjection(t)) return;
  const key = keyOf(t, 'SWAP');
  if (key === null) return;
  const path = NLC.copyModePath(ID);
  const [was] = await keep(t, [path]);
  await pressed('SWAP', key, { expect: 533 });
  await link.waitFor(path, !was, { timeout: 5000 });
  await pressed('SWAP', key, { expect: 533 });
  await link.waitFor(path, was, { timeout: 5000 });
});

test('TIME adds a tenth of a second to the take time', { skip: SKIP }, async (t) => {
  if (needsInjection(t)) return;
  const key = keyOf(t, 'TIME');
  if (key === null) return;
  const path = NLC.fadeTimePath(ID);
  const [was] = await keep(t, [path]);
  const since = Date.now();
  await pressed('TIME', key, { expect: [509, 510] });
  await sentSince(since, /take time/);
  await link.waitFor(path, Math.min(100, Number(was) + 1), { timeout: 5000 });
});

/* ------------------------------------------------------------------ *
 * Memories: stored from an empty key, deleted with DEL
 * ------------------------------------------------------------------ */

test('SAVE TO then an empty preset key stores a new memory, and DEL deletes it', { skip: SKIP }, async (t) => {
  if (needsInjection(t)) return;
  const save = keyOf(t, 'SAVE TO');
  if (save === null) return;
  const del = keyOf(t, 'DEL');
  if (del === null) return;
  const slot = expected.facts.freeSlots[0];
  if (!slot) { t.skip('no free memory slot in 1–32'); return; }
  const label = NLC.label('screen', slot, '').path;
  const labelWas = await awjGet(label);
  t.after(async () => {
    /* However far it got, the slot goes back to empty and unnamed. */
    if (await awjGet(slotValid(slot)) === true) {
      link.send({ path: ['device', 'presetBank', 'bankList', 'items', String(slot), 'control', 'pp', 'xDelete'], value: true });
      await link.waitFor(slotValid(slot), false, { timeout: 5000 }).catch(() => {});
    }
    if (await awjGet(label) !== labelWas) await awjReplace(label, labelWas);
  });

  await pressed('SAVE TO', save, { expect: 520 });
  let empty;
  try {
    empty = await findKey(AREA.preset, (text) => text === '');
  } catch (err) {
    /* A bus exactly full of memories may page no further. That is the
       console's call and worth knowing, but not a fault in the app. */
    rec.note('emptyPresetKey', err.message);
    await pressed('SAVE TO, to disarm', save, { expect: 520 });
    t.skip(`no empty preset key on any page the console shows (${expected.model.presets.length} memories published)`);
    return;
  }
  let since = Date.now();
  const { report } = await pressed('an empty preset key', empty, { expect: 400 });
  assert.equal(Number(report.payload.id) || 0, 0, 'an empty key reports no slot');
  const stored = await sentSince(since, /store/);
  assert.match(stored.note, new RegExp(`memory ${slot} as "Memory ${slot}"`));
  await link.waitFor(slotValid(slot), true, { timeout: 8000 });
  assert.equal(await awjGet(label), `Memory ${slot}`);

  /* The app reads the switcher again and republishes; the new memory shows. */
  const shown = await findKey(AREA.preset, `Memory ${slot}`, { wait: 4000 });
  await pressed('DEL', del, { expect: 521 });
  since = Date.now();
  const gone = await pressed('the new memory', shown, { expect: 403 });
  assert.equal(Number(gone.report.payload.id), slot);
  await sentSince(since, /delete memory/);
  await link.waitFor(slotValid(slot), false, { timeout: 8000 });
});

test('DEL then a screen key is reported, and never acted on', { skip: SKIP }, async (t) => {
  if (needsInjection(t)) return;
  const del = keyOf(t, 'DEL');
  if (del === null) return;
  const s1 = expected.model.screens.find((s) => s.uid === ID);
  const key = await findKey(AREA.screen, s1.name);
  await pressed('DEL', del, { expect: 521 });
  const since = Date.now();
  const { report } = await pressed('a screen key with DEL armed', key, { expect: 104 });
  assert.equal(report.payload.uid, ID);
  await waitHistory(app, since, (h) => h.code === 104, { label: 'the delete to be noted' });
  const lines = await historySince(app, since);
  assert.ok(!lines.some((h) => h.kind === 'sent'), 'nothing was sent');
  assert.ok((await panelState(app)).selection.destinations.includes(ID), `${ID} is still selected`);
});

/* ------------------------------------------------------------------ *
 * Keys the app does not act on, and the panel lock
 * ------------------------------------------------------------------ */

test('keys with no meaning here write nothing to the switcher', { skip: SKIP }, async (t) => {
  if (needsInjection(t)) return;
  const unknown = FUNCTION_KEYS.filter((f) => f.reports === null && f.name !== 'SHIFT' && f.name !== 'AREA SWITCH')
    .map((f) => ({ ...f, key: keyMap.byMode(f.mode) })).filter((f) => f.key !== null);
  if (!unknown.length) { t.skip('this layout has none of LOAD TO PGM, TEST PATTERN'); return; }
  const seen = {};
  for (const f of unknown) {
    const from = await settled(link, ID);
    const { report, since } = await pressed(f.name, f.key);
    await sleep(500);
    seen[f.name] = report ? { command: report.command, payload: report.payload } : null;
    const lines = await historySince(app, since);
    assert.ok(!lines.some((h) => h.kind === 'sent'), `${f.name} sent something: ${JSON.stringify(lines)}`);
    assert.equal(await awjGet(sag(ID, 'status', 'transition')), from, `${f.name} moved ${ID}`);
  }
  rec.note('unmappedKeys', seen);
});

test('LOCK PANEL, held, stops every key but itself; held again, lets go', { skip: SKIP }, async (t) => {
  if (needsInjection(t)) return;
  const lock = keyOf(t, 'LOCK PANEL');
  if (lock === null) return;
  const take = keyMap.byMode(functionKey('TAKE').mode);
  const short = await pressed('LOCK PANEL, a tap', lock);
  rec.note('lockTap', short.report && short.report.command);
  t.after(async () => {
    if ((await panelState(app)).locked) await press(lock, { hold: 1500 });
  });
  await pressed('LOCK PANEL, held', lock, { hold: 1500, expect: [523, 524], timeout: 4000 });
  await waitPanel(app, (s) => s.locked === true, { label: 'the panel to lock' });

  const from = await settled(link, ID);
  const { report } = await pressed('TAKE while locked', take);
  rec.note('takeWhileLocked', report ? report.command : 'the console reported nothing');
  await sleep(800);
  assert.equal(await awjGet(sag(ID, 'status', 'transition')), from, 'a locked panel took');

  await pressed('LOCK PANEL, held again', lock, { hold: 1500, expect: [523, 524], timeout: 4000 });
  await waitPanel(app, (s) => s.locked === false, { label: 'the panel to unlock' });
});

test('MVR opens the multiviewers page in the open page', { skip: SKIP }, async (t) => {
  if (needsInjection(t)) return;
  const key = keyOf(t, 'MVR');
  if (key === null) return;
  const stream = sse(`${app.base}/__lpp/pixelhue/stream`);
  t.after(() => stream.close());
  await app.api('/pixelhue/runner', { method: 'POST', body: { id: 'console-suite' } });
  await pressed('MVR', key);
  const t0 = Date.now();
  while (!stream.events.some((e) => e.event === 'page') && Date.now() - t0 < 2000) await sleep(50);
  const ev = stream.events.find((e) => e.event === 'page');
  assert.ok(ev, 'no page event');
  assert.equal(ev.data.path, '/live/multiviewers');
  assert.equal(ev.data.runner, 'console-suite');
});

test('a long press on a selected screen drops it, and then nothing takes', { skip: SKIP }, async (t) => {
  if (needsInjection(t)) return;
  const s1 = expected.model.screens.find((s) => s.uid === ID);
  const key = await findKey(AREA.screen, s1.name);
  await pressed('screen key, held', key, { hold: 1500, expect: 103, timeout: 4000 });
  await waitPanel(app, (s) => !s.selection.destinations.includes(ID), { label: `${ID} to be dropped` });
  const take = keyMap.byMode(functionKey('TAKE').mode);
  const from = await settled(link, ID);
  const { since } = await pressed('TAKE with nothing selected', take, { expect: 531 });
  await waitHistory(app, since, (h) => /no destination selected/.test(h.note || ''), { label: 'the take to be refused' });
  assert.equal(await awjGet(sag(ID, 'status', 'transition')), from);
});
