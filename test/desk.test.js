/*
 * The desk: keypad notes in, words on a Console line out, and the encoders
 * and wheels through awj-surface's engine.
 *
 * No desk exists to press, so these press it in MIDI bytes: the keypad over a
 * real Console line on a real store capture, with a session that records
 * instead of sending, and the whole desk (`desk.js`) over a fake Web MIDI
 * input. What the tests can say is what reaches the wire; what a controller's
 * firmware actually sends is for the first desk to say.
 *
 * The keymap is the desk's, not ours: when a checkout of
 * stoatworks-labs/lpp-control-surface is beside this one (or `LPP_DESK_KEYPAD`
 * names its `docs/KEYPAD.md`), the table there is read and every key checked
 * against `KEYS`. Without one that test is skipped, not failed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { DeviceStore } from '../src/core/device-store.js';
import { createConsolePanel, describeScope } from '../plugins/console/panel.js';
import { KEYS, SECOND_SWITCHES, keyFor, typeKey, oops, createKeypad } from '../plugins/desk/keypad.js';
import { cells, pageFor, outcomeText, formatValue, cellValue, KNOBS, SCREEN } from '../plugins/desk/core.js';
import { createDesk } from '../plugins/desk/desk.js';
import { install } from './helpers/fake-dom.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const hydrated = (name) => { const s = new DeviceStore(); s.hydrate(fixture(name)); return s; };
const profile = () => JSON.parse(readFileSync(join(root, 'src/vendor/surface/profiles/lpp-surface-p1.json'), 'utf8'));
const path = (msg) => msg.path.join('/');
const tick = () => new Promise((r) => setTimeout(r, 0));
/* The engine coalesces writes for 20 ms, as a fader sweep needs. */
const settle = () => new Promise((r) => setTimeout(r, 40));

/** A Console line as the desk gets one, over a store, recording what it sends. */
function deskLine(store = hydrated('aquilon-6.2.73-memories.json')) {
  const sent = [];
  const session = { store, state: 'live', send: (msg) => { sent.push(msg); return true; } };
  const line = createConsolePanel({ session, onRefresh: () => {}, popoutEnabled: false, stickyScope: true });
  return { sent, session, line };
}

/** A keypad on that line, and a way to press keys on it by note. */
function keypadOn(line, opts = {}) {
  const pages = [];
  const keypad = createKeypad({ line, onPage: (p) => pages.push(p), ...opts });
  const down = (n, ch = 0) => keypad.handle([0x90 | ch, n, 100]);
  const up = (n, ch = 0) => keypad.handle([0x80 | ch, n, 0]);
  const press = (...notes) => { for (const n of notes) { down(n); up(n); } };
  return { keypad, pages, down, up, press };
}

const NOTE = Object.fromEntries(KEYS.map((k) => [k.key, k.note]));
const words = (...keys) => keys.map((k) => {
  if (!(k in NOTE)) throw new Error(`no key ${k}`);
  return NOTE[k];
});

/* ------------------------------------------------------------- the keymap */

test('every switch of the 10 × 5 grid has a note, and every note one meaning', () => {
  const notes = KEYS.map((k) => k.note);
  assert.equal(new Set(notes).size, notes.length, 'no note twice');
  const all = new Set([...notes, ...SECOND_SWITCHES]);
  assert.equal(all.size, 50, '45 caps on 50 switches');
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 10; col++) assert.ok(all.has(24 + row * 10 + col), `row ${row}, col ${col}`);
  }
  for (const n of SECOND_SWITCHES) assert.equal(keyFor(n), undefined, `${n} is a second switch, not a key`);
  /* The big keys answer on their first switch: TAKE top left of its 2 × 2,
     Please the top of its two, 0 the left of its two. */
  assert.equal(NOTE.TAKE, 54);
  assert.equal(NOTE.Please, 63);
  assert.equal(NOTE['0'], 70);
});

test('the keymap agrees with the desk’s own KEYPAD.md', (t) => {
  const file = process.env.LPP_DESK_KEYPAD ||
    join(homedir(), 'hardware/video/lpp-control-surface/docs/KEYPAD.md');
  if (!existsSync(file)) { t.skip(`no ${file}`); return; }
  const text = readFileSync(file, 'utf8');
  const block = text.slice(text.indexOf('<!-- keymap:start -->'), text.indexOf('<!-- keymap:end -->'));
  const rows = [...block.matchAll(/^\| \*\*(.+?)\*\* \| (\d), (\d) \| (\d) \| [^|]+ \| ([^|]+?) \| (\d+) \|$/gm)];
  assert.equal(rows.length, KEYS.length, 'one row a key');
  for (const [, name, row, col, , types, note] of rows) {
    const key = KEYS.find((k) => k.key === name);
    assert.ok(key, `${name} is a key here`);
    assert.equal(key.note, Number(note), `${name}'s note`);
    assert.equal(key.note, 24 + Number(row) * 10 + Number(col), `${name}'s note is its first switch`);
    if (key.word) assert.equal(key.word, types.trim(), `${name} types what the table says`);
  }
  /* And the knobs: the screen pixel and the CC of every encoder and wheel. */
  const knobs = [...block.matchAll(/^\| (E\d|Wheel [ABC]) \(?\w*\)? ?\| [\d.]+ \| (\d+) \| CC (\d+)/gm)];
  assert.equal(knobs.length, KNOBS.length);
  for (const [, name, x, cc] of knobs) {
    const knob = KNOBS.find((k) => k.name === name);
    assert.ok(knob, name);
    assert.equal(knob.x, Number(x), `${name}'s pixel`);
    assert.equal(knob.control, `cc:0:${cc}`, `${name}'s CC`);
  }
});

/* --------------------------------------------------------- word by word */

test('digits make numbers, % closes one, and every other key is a word of its own', () => {
  let line = '';
  for (const k of ['Recall', 'Screen', '1', 'Memory', '1', '2']) line = typeKey(line, KEYS.find((x) => x.key === k));
  assert.equal(line, 'Recall Screen 1 Memory 12');
  assert.equal(typeKey('Set Screen 1 Layer 2 Size 50', { act: 'percent', word: '%' }), 'Set Screen 1 Layer 2 Size 50%');
  /* A % with no number before it has nothing to close. */
  assert.equal(typeKey('Set Screen 1 Layer 2 Size', { act: 'percent', word: '%' }), 'Set Screen 1 Layer 2 Size');
  assert.equal(typeKey('', { act: 'percent', word: '%' }), '');
  /* A digit after a word starts a number; after a number word like `Layer 2`
     it does not run into the layer's number unless it is meant to. */
  assert.equal(typeKey('Layer', { act: 'digit', word: '2' }), 'Layer 2');
  assert.equal(typeKey('Screen 1 +', { act: 'digit', word: '3' }), 'Screen 1 + 3');
  assert.equal(typeKey('Screen 1 Thru', { act: 'digit', word: '4' }), 'Screen 1 Thru 4');
  assert.equal(typeKey('', { act: 'word', word: 'Recall' }), 'Recall');
  /* Trailing space from a hand-typed line is not doubled. */
  assert.equal(typeKey('Recall ', { act: 'word', word: 'Screen' }), 'Recall Screen');
});

test('Oops takes back a word, not a letter — a number and a quoted label are each one', () => {
  assert.equal(oops('Recall Screen 1 Memory 12'), 'Recall Screen 1 Memory');
  assert.equal(oops('Recall Screen'), 'Recall');
  assert.equal(oops('Recall'), '');
  assert.equal(oops(''), '');
  assert.equal(oops('Label Memory 5 "Walk in"'), 'Label Memory 5');
  assert.equal(oops('Label Memory 5 "Walk'), 'Label Memory 5');
  assert.equal(oops('Set Screen 1 Layer 2 Size 50%'), 'Set Screen 1 Layer 2 Size');
});

/* ----------------------------------------------- the keypad on a real line */

test('each key types its word onto the line exactly as typing would', () => {
  const { line } = deskLine();
  const { press } = keypadOn(line);
  press(...words('Recall', 'Screen', '1', '+', '3', 'Memory', '5', 'Preview'));
  assert.equal(line.state.line, 'Recall Screen 1 + 3 Memory 5 Preview');
  line.setLine('');
  for (const key of KEYS.filter((k) => k.act === 'word')) {
    line.setLine('');
    press(key.note);
    assert.equal(line.state.line, key.word, key.key);
  }
});

test('a Recall typed on the keypad and run with Please goes to preview, and says so first', () => {
  const { line, sent } = deskLine();
  const { press } = keypadOn(line);
  press(...words('Recall', 'Screen', '1', 'Memory', '5'));
  assert.equal(line.state.line, 'Recall Screen 1 Memory 5');
  /* Before Please: the line says what it will do, and that air is safe. */
  assert.equal(line.state.outcome.program, false);
  const said = outcomeText(line.state.outcome);
  assert.equal(said.tone, 'ok');
  assert.match(said.text, /^→ 1 op: Recall 5 → Screen 1 Preview — nothing reaches program$/);
  press(NOTE.Please);
  assert.equal(sent.length, 1);
  assert.match(path(sent[0]), /\/screenList\/items\/S1\/presetList\/items\/PREVIEW\/pp\/xRequest$/);
  assert.equal(line.state.line, '', 'Please empties the line');
  assert.equal(line.state.log[0].kind, 'ok');
});

test('only the Program key reaches program, and the line says so before Please', () => {
  const { line, sent } = deskLine();
  const { press } = keypadOn(line);
  press(...words('Recall', 'Screen', '1', 'Memory', '5', 'Program'));
  assert.equal(line.state.outcome.program, true);
  const said = outcomeText(line.state.outcome);
  assert.equal(said.tone, 'air');
  assert.match(said.text, /REACHES PROGRAM$/);
  /* And no key types Program but Program. */
  for (const k of KEYS) assert.ok(k.key === 'Program' || !/program/i.test(k.word || ''), k.key);
  assert.equal(sent.length, 0, 'nothing sent before Please');
});

test('a Recall with no target on the line and no scope is refused, not guessed', () => {
  const { line, sent } = deskLine();
  const { press } = keypadOn(line);
  press(...words('Recall', 'Memory', '5', 'Please'));
  assert.equal(sent.length, 0);
  assert.equal(line.state.log[0].kind, 'error');
});

test('Select sets the sticky scope; TAKE takes it at once and leaves the line alone', () => {
  const { line, sent } = deskLine();
  const { press } = keypadOn(line);
  press(...words('Select', 'Screen', '1', '+', '3', 'Please'));
  assert.equal(line.scope(), 'Screen 1 + 3');
  assert.equal(sent.length, 0, 'Select sends nothing');
  /* Half a command on the line, then TAKE. */
  press(...words('Recall', 'Memory'));
  press(NOTE.TAKE);
  assert.deepEqual(sent.map(path).sort(), [
    'device/screenAuxGroupList/items/S1/control/pp/xTake',
    'device/screenAuxGroupList/items/S3/control/pp/xTake'
  ]);
  assert.equal(line.state.line, 'Recall Memory', 'TAKE does not touch the line');
  /* The half-typed Recall now inherits the scope too. */
  press(...words('5', 'Please'));
  assert.equal(sent.length, 4);
  assert.ok(sent.slice(2).every((m) => /\/presetList\/items\/PREVIEW\/pp\/xRequest$/.test(path(m))));
});

test('TAKE with no scope takes nothing', () => {
  const { line, sent } = deskLine();
  const { press } = keypadOn(line);
  press(NOTE.TAKE);
  assert.equal(sent.length, 0);
  assert.equal(line.state.log[0].kind, 'error');
});

test('Shift + TAKE types the word, for a one-off scope', () => {
  const { line, sent } = deskLine();
  const { down, up, press, keypad } = keypadOn(line);
  down(NOTE.Shift);
  assert.equal(keypad.shift, true);
  press(NOTE.TAKE);
  up(NOTE.Shift);
  assert.equal(keypad.shift, false, 'Shift is held, not latched');
  assert.equal(line.state.line, 'Take');
  assert.equal(sent.length, 0);
  press(...words('Screen', '2', 'Please'));
  assert.deepEqual(sent.map(path), ['device/screenAuxGroupList/items/S2/control/pp/xTake']);
  /* A note on at velocity 0 is a note off — Shift lets go on one too. */
  down(NOTE.Shift);
  keypad.handle([0x90, NOTE.Shift, 0]);
  assert.equal(keypad.shift, false);
});

test('Clear empties the line, and only on an empty line the scope', () => {
  const { line } = deskLine();
  const { press } = keypadOn(line);
  press(...words('Select', 'Screen', '1', 'Please'));
  press(...words('Recall', 'Memory'));
  press(NOTE.Clear);
  assert.equal(line.state.line, '');
  assert.equal(line.scope(), 'Screen 1', 'the scope survives the first Clear');
  press(NOTE.Clear);
  assert.equal(line.scope(), '');
  assert.match(line.state.log[0].detail, /scope cleared/);
});

test('Oops on the keypad takes the last word off the line', () => {
  const { line } = deskLine();
  const { press } = keypadOn(line);
  press(...words('Recall', 'Screen', '1', '2', 'Oops'));
  assert.equal(line.state.line, 'Recall Screen');
});

test('attribute keys page the wheels on an empty line and type their word otherwise', () => {
  const { line } = deskLine();
  const { press, pages } = keypadOn(line);
  press(NOTE.Position, NOTE.Size, NOTE.Opacity, NOTE.Source, NOTE.Category);
  assert.deepEqual(pages, ['position', 'size', 'opacity', 'source', 'category']);
  assert.equal(line.state.line, '');
  press(...words('Set', 'Screen', '1', 'Layer', '2', 'Position'));
  assert.equal(line.state.line, 'Set Screen 1 Layer 2 Position');
  assert.equal(pages.length, 5, 'no page change with words on the line');
});

test('a big key’s other switches, another channel and anything not a note are not the keypad’s to type', () => {
  const { line, sent } = deskLine();
  const { keypad, press } = keypadOn(line);
  press(...words('Select', 'Screen', '1', 'Please'));
  for (const n of SECOND_SWITCHES) {
    assert.equal(keypad.handle([0x90, n, 100]), true, `${n} is swallowed`);
    keypad.handle([0x80, n, 0]);
  }
  assert.equal(sent.length, 0, 'a second TAKE switch does not take again');
  assert.equal(line.state.line, '');
  /* Channel 2: someone else's. */
  assert.equal(keypad.handle([0x91, NOTE.Recall, 100]), false);
  assert.equal(line.state.line, '');
  /* The encoders are CCs, and the pushes notes the keypad does not have. */
  assert.equal(keypad.handle([0xb0, 16, 1]), false);
  assert.equal(keypad.handle([0x90, 96, 100]), false);
});

test('U1 has no job of its own yet, and says so rather than typing', () => {
  const { line } = deskLine();
  let asked = 0;
  const { press } = keypadOn(line, { onUser: () => { asked++; } });
  press(NOTE.U1);
  assert.equal(asked, 1);
  assert.equal(line.state.line, '');
});

test('the typed Console keeps no sticky scope — only the desk’s line does', () => {
  const store = hydrated('aquilon-6.2.73-memories.json');
  const sent = [];
  const session = { store, state: 'live', send: (m) => { sent.push(m); return true; } };
  const typed = createConsolePanel({ session, onRefresh: () => {}, popoutEnabled: false });
  typed.state.line = 'Select Screen 1';
  typed.execute();
  typed.state.line = 'Take';
  typed.execute();
  assert.equal(sent.length, 0, 'a Select there scopes nothing');
  assert.equal(typed.scope(), '');
  assert.equal(describeScope(null), '');
});

/* ------------------------------------------------------------ the screen */

test('a cell sits over its knob, cut back at the screen’s edge rather than slid', () => {
  const all = cells();
  assert.equal(all.length, 7);
  for (const c of all) {
    assert.ok(c.left >= SCREEN.margin && c.left + c.width <= SCREEN.width - SCREEN.margin + 1e-9, c.name);
    assert.equal(c.tick, c.x);
    assert.ok(c.tick > c.left && c.tick < c.left + c.width, `${c.name}'s tick is inside its cell`);
  }
  const e1 = all[0];
  assert.equal(e1.left, 12);
  assert.ok(Math.abs(e1.width - 130.65) < 0.01, 'E1, 39 px in, is narrow as in the mock-up');
  /* Neighbours never overlap. */
  for (let i = 1; i < all.length; i++) assert.ok(all[i].left >= all[i - 1].left + all[i - 1].width, all[i].name);
});

test('Category steps through the pages no key names; the others name their own', () => {
  const pages = profile().pages;
  assert.equal(pageFor('position', 'size', pages), 'position');
  assert.equal(pageFor('source', 'size', pages), 'source');
  assert.equal(pageFor('category', 'position', pages), 'crop');
  assert.equal(pageFor('category', 'crop', pages), 'border');
  assert.equal(pageFor('category', 'border', pages), 'crop');
  assert.equal(pageFor('colour', 'crop', pages), null);
  assert.equal(pageFor('category', null, []), null);
});

test('the line under the line always answers whether it reaches program', () => {
  assert.deepEqual(outcomeText(null), { tone: 'dim', text: '' });
  assert.equal(outcomeText(null, { error: 'Unknown keyword' }).tone, 'error');
  assert.equal(outcomeText({ fn: 'Select', summary: 'Select Screen 1', ops: 0, reads: 0 }).text, '→ the scope becomes what this selects — Screen 1');
  assert.equal(outcomeText({ fn: 'Clear', summary: 'Clear', ops: 0, reads: 0 }).text, '→ clears the scope');
  const unsure = outcomeText({ fn: null, summary: 'raw', ops: 2, reads: 0, program: null });
  assert.equal(unsure.tone, 'warn');
  assert.match(unsure.text, /^→ 2 ops: raw — can’t tell whether this reaches program$/);
  assert.match(outcomeText({ fn: 'Get', summary: 'Get x', ops: 0, reads: 1, program: false }).text, /^→ 1 read:/);
});

test('values read as the switcher means them', () => {
  assert.equal(formatValue(['x'], 960), '960 px');
  assert.equal(formatValue(['opacity', 'pp', 'opacity'], 256), '256');
  assert.equal(formatValue(['control', 'pp', 'takeUpTime'], 8), '0.8 s');
  assert.equal(formatValue(['pp', 'inputNum'], 'IN_3'), 'IN 3');
  assert.equal(formatValue(['x'], undefined), '—');
  assert.equal(cellValue(['1920 px', '1080 px']), '1920 px · 1080 px');
  assert.equal(cellValue(['0.8 s', '0.8 s']), '0.8 s');
  assert.equal(cellValue([]), '—');
});

/* ------------------------------------------------- the desk, from MIDI in */

/** A Web MIDI that has the given inputs and grants at once, with a Web Lock. */
function fakeMidi(names, { held = false } = {}) {
  const inputs = new Map(names.map((name, i) => [`in-${i}`, { id: `in-${i}`, name, onmidimessage: null }]));
  const access = { inputs, onstatechange: null };
  const locks = {
    request: (name, opts, fn) => Promise.resolve(fn(held ? null : { name }))
  };
  return { requestMIDIAccess: async () => access, locks, access };
}

async function deskOver({ names = ['LPP Surface P1'], held = false, storage = null } = {}) {
  const store = hydrated('aquilon-6.2.73-memories.json');
  const sent = [];
  const session = { store, state: 'live', send: (msg) => { sent.push(msg); return true; } };
  /* The `console` service as the Console plugin provides it. */
  const service = {
    line: (opts) => createConsolePanel({ session, onRefresh: () => {}, popoutEnabled: false, stickyScope: true, ...opts })
  };
  const midi = fakeMidi(names, { held });
  const desk = createDesk({ session, consoleService: () => service, midi, loadProfile: async () => profile(), storage });
  await desk.ready();
  await desk.connect();
  await tick();
  const input = () => [...midi.access.inputs.values()].find((i) => i.onmidimessage);
  const send = (...bytes) => input().onmidimessage({ data: Uint8Array.from(bytes) });
  return { desk, line: desk.line, sent, midi, input, send };
}

test('the desk opens the one port whose name says it is the desk', async () => {
  const { desk, input } = await deskOver({ names: ['IAC Bus 1', 'LPP Surface P1'] });
  assert.equal(desk.state.status, 'listening');
  assert.equal(input().name, 'LPP Surface P1');
  desk.dispose();
});

test('with no port that says so, the desk asks rather than guessing', async () => {
  const { desk } = await deskOver({ names: ['IAC Bus 1', 'nanoKONTROL2'] });
  assert.equal(desk.state.status, 'choose');
  assert.equal(desk.inputs().every((i) => i.onmidimessage === null), true);
  desk.dispose();
});

test('a second tab finds the desk held and stays deaf', async () => {
  const { desk, midi } = await deskOver({ held: true });
  assert.equal(desk.state.status, 'elsewhere');
  assert.ok([...midi.access.inputs.values()].every((i) => i.onmidimessage === null));
  desk.dispose();
});

test('keypad notes type on the desk’s line; the wheels move the selected layer on preview', async () => {
  const { desk, line, sent, send } = await deskOver();
  send(0x90, NOTE.Select, 100); send(0x80, NOTE.Select, 0);
  send(0x90, NOTE.Screen, 100); send(0x80, NOTE.Screen, 0);
  send(0x90, NOTE['1'], 100); send(0x80, NOTE['1'], 0);
  assert.equal(line.state.line, 'Select Screen 1');
  assert.equal(sent.length, 0, 'a keypad note never reaches the engine');
  send(0x90, NOTE.Please, 100); send(0x80, NOTE.Please, 0);
  await tick();

  /* The wheels follow the scope's first screen, on the position page. */
  const snap = desk.snapshot();
  assert.equal(snap.scope, 'Screen 1');
  assert.equal(snap.page, 'position');
  assert.match(snap.wheelsAt, /^S1 L1 preview$/);
  /* Wheel A, two clicks clockwise: X, on the preview buffer, never program. */
  send(0xb0, 20, 2);
  await settle();
  assert.equal(sent.length, 1);
  assert.match(path(sent[0]), /^device\/screenList\/items\/S1\/presetList\/items\/[ABC]\/layerList\/items\/1\/position\/pp\/posH$/);
  const ctx = line.runContext();
  assert.equal(path(sent[0]).split('/')[6], ctx.facts.buffer({ kind: 'screen', n: 1 }, 'PREVIEW'));
  await tick();
  const cell = desk.snapshot().cells.find((c) => c.control === 'cc:0:20');
  assert.equal(cell.label, 'Position X');
  assert.match(cell.value, / px$/);
  desk.dispose();
});

test('an attribute key on the desk’s empty line turns the wheels to its page', async () => {
  const { desk, send } = await deskOver();
  send(0x90, NOTE.Size, 100); send(0x80, NOTE.Size, 0);
  await tick();
  assert.equal(desk.snapshot().page, 'size');
  const labels = desk.snapshot().cells.filter((c) => c.kind === 'wheel').map((c) => c.label);
  assert.deepEqual(labels, ['Width', 'Height', 'Size']);
  send(0x90, NOTE.Category, 100); send(0x80, NOTE.Category, 0);
  await tick();
  assert.equal(desk.snapshot().page, 'crop');
  desk.dispose();
});

test('TAKE pressed through the desk takes once, on the scope', async () => {
  const { sent, send } = await deskOver();
  for (const k of ['Select', 'Screen', '2', 'Please']) { send(0x90, NOTE[k], 100); send(0x80, NOTE[k], 0); }
  /* All four of TAKE's switches, as a firmware that sent them all would. */
  for (const n of [54, 55, 64, 65]) send(0x90, n, 100);
  for (const n of [54, 55, 64, 65]) send(0x80, n, 0);
  assert.deepEqual(sent.map(path), ['device/screenAuxGroupList/items/S2/control/pp/xTake']);
});

/* ------------------------------------------------------- drawn, not seen */

test('the Desk panel and the strip screen draw from the desk, and the screen follows it', async () => {
  const dom = install();
  try {
    dom.window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
    const { createDeskPanel } = await import('../plugins/desk/panel.js');
    const { buildScreen } = await import('../plugins/desk/screen.js');
    const { desk, send } = await deskOver();
    const panel = createDeskPanel({ desk, screenUrl: '/__lpp/plugins/desk/screen.html' });
    assert.match(panel.render().textContent, /listening: LPP Surface P1/);
    panel.render();

    const screen = buildScreen(document, desk);
    const text = () => document.body.textContent;
    assert.match(text(), /no scope/);
    assert.match(text(), /type on the keypad/);
    /* Six pages, one tab each; seven cells, one over each knob. */
    assert.equal(document.querySelectorAll('.tab').length, 6);
    assert.equal(document.querySelectorAll('.cell').length, 7);
    assert.equal(document.querySelectorAll('.tick').length, 7);
    assert.equal(document.querySelector('.tab.on').textContent, 'Position');

    for (const k of ['Select', 'Screen', '1', 'Please', 'Recall', 'Memory', '5']) { send(0x90, NOTE[k], 100); send(0x80, NOTE[k], 0); }
    await settle();
    assert.equal(document.querySelector('.scope').textContent, 'Screen 1');
    assert.match(document.querySelector('.cmd').textContent, /^Recall Memory 5/);
    const will = document.querySelector('.will');
    assert.match(will.textContent, /nothing reaches program$/);
    assert.ok(will.classList.contains('ok'));

    /* A tab tapped on the screen turns the wheels in the Web RCS tab. */
    document.querySelectorAll('.tab')[1].click();
    await settle();
    assert.equal(desk.snapshot().page, 'size');
    assert.equal(document.querySelector('.tab.on').textContent, 'Size');
    screen.stop();
    desk.dispose();
  } finally {
    dom.uninstall();
  }
});
