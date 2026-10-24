/*
 * Plug names: the label as an EDID can carry it, the bytes that change and
 * the ones that must not, which plugs are offered, and the write and undo
 * against a switcher that stores plug EDIDs the way the 6.2.73 simulator did.
 *
 * `sim-6.2.73-inputs-edid.json` is cut down from a running LivePremier
 * simulator: stock 256-byte EDIDs (ANW8002, serial 0, AQL_HDMI / AQL_DP, the
 * name in the fourth descriptor), two SDI plugs with no EDID.
 *
 * Run: node --test test/edid-names.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import { servedEdid } from '../src/core/plug-edid.js';
import {
  NAME_MAX, nameFor, readName, readSerial, renameEdid, plugRows, withShortName, withWrite, withoutWrite,
  namePlugs, undoPlugs, emptyDocument
} from '../plugins/edid-names/core.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8'));
const TILES = load('edid-editor-mosaic-tiles.json');

const INPUTS = ['device', 'inputList', 'items'];
const PRE = ['device', 'preconfig', 'inputs', 'current', 'inputList', 'items'];
const label = (store, id, text) => store.set([...INPUTS, id, 'control', 'pp', 'label'], text);

function freshStore() {
  const store = new DeviceStore();
  store.hydrate(load('sim-6.2.73-inputs-edid.json'));
  return store;
}

const stock = () => Uint8Array.from(servedEdid(freshStore(), 'IN_1').bytes);
const checksumOk = (bytes) => bytes.slice(0, 128).reduce((a, b) => a + b, 0) % 256 === 0;
const differing = (a, b) => [...a].map((x, i) => (x === b[i] ? null : i)).filter((i) => i !== null);

/** Stores plug EDIDs as the 6.2.73 simulator did: xStore serves what was staged, xReset the stock one. */
class FakeSwitcher {
  constructor(store) {
    this.store = store;
    this.sent = [];
    this.defaults = {};
    for (const id of Object.keys(store.get(INPUTS))) {
      const st = store.get([...INPUTS, id, 'plugList', 'items', '1', 'edid', 'status', 'pp']);
      this.defaults[id] = { data: [...st.data], dataSize: st.dataSize };
    }
  }

  send({ path, value }) {
    this.sent.push({ path: path.join('/'), value });
    setTimeout(() => this.echo(path, value), 0);
    return true;
  }

  echo(path, value) {
    const s = this.store;
    s.set(path, value);
    const cmd = /inputList\/items\/(IN_\d+)\/plugList\/items\/1\/edid\/cmd\/pp\/(\w+)$/.exec(path.join('/'));
    if (!cmd || !value) return;
    const [, id, field] = cmd;
    const base = [...INPUTS, id, 'plugList', 'items', '1', 'edid'];
    if (field === 'xStore') {
      s.set([...base, 'status', 'pp', 'data'], s.get([...base, 'cmd', 'pp', 'data']));
      s.set([...base, 'status', 'pp', 'dataSize'], s.get([...base, 'cmd', 'pp', 'dataSize']));
    }
    if (field === 'xReset') {
      s.set([...base, 'status', 'pp', 'data'], [...this.defaults[id].data]);
      s.set([...base, 'status', 'pp', 'dataSize'], this.defaults[id].dataSize);
    }
  }
}

function rig() {
  const store = freshStore();
  const fake = new FakeSwitcher(store);
  const session = { store, send: (cmd) => fake.send(cmd) };
  const kept = [];
  let doc = emptyDocument();
  const save = async (d) => { doc = d; kept.push({ doc: structuredClone(d), sentSoFar: fake.sent.length }); };
  return { store, fake, session, save, kept, doc: () => doc };
}

// ------------------------------------------------------------------ the name

test('a label becomes at most 13 characters of plain ASCII', () => {
  assert.deepEqual(nameFor('powerpoint main'), { text: 'powerpoint ma', clipped: true });
  assert.deepEqual(nameFor('PPT MAIN'), { text: 'PPT MAIN', clipped: false });
  assert.equal(nameFor('Café – Ünïcode').text, 'Cafe - Unicod');
  assert.equal(nameFor('  Keynote   🎬  B ').text, 'Keynote B');
  assert.equal(nameFor('Allan’s Mac').text, "Allan's Mac");
  /* Cut, then trimmed: no trailing space left in the 13th place. */
  assert.equal(nameFor('Main Presenter').text, 'Main Presente');
  assert.equal(nameFor('abcdefghijkl mnop').text, 'abcdefghijkl');
  assert.equal(nameFor('').text, '');
  assert.equal(nameFor(null).text, '');
});

test('the stock EDID reads as AQL_HDMI, serial 0', () => {
  const b = stock();
  assert.equal(readName(b), 'AQL_HDMI');
  assert.equal(readSerial(b), 0);
});

test('renaming changes the name, the serial and the checksum, and nothing else', () => {
  const before = stock();
  const { bytes, error } = renameEdid(before, { name: 'PPT MAIN', serial: 5 });
  assert.equal(error, undefined);
  assert.equal(bytes.length, before.length);
  assert.equal(readName(bytes), 'PPT MAIN');
  assert.equal(readSerial(bytes), 5);
  assert.ok(checksumOk(bytes), 'base block checksum');
  for (const i of differing(bytes, before)) {
    const ok = (i >= 12 && i <= 15) || (i >= 108 + 5 && i < 126) || i === 127;
    assert.ok(ok, `byte ${i} changed`);
  }
  assert.deepEqual([...bytes.slice(128)], [...before.slice(128)], 'the extension block is untouched');
  /* The descriptor as EDID Editor writes it: text, 0x0A, spaces. */
  assert.deepEqual([...bytes.slice(108, 126)], [0, 0, 0, 0xfc, 0, ...Buffer.from('PPT MAIN'), 0x0a, 0x20, 0x20, 0x20, 0x20]);
});

test('EDID Editor reads a renamed EDID as the same EDID under a new name', async () => {
  const lib = await import('../src/vendor/edid-editor-embed.js');
  const before = stock();
  const { bytes } = renameEdid(before, { name: 'PPT MAIN', serial: 7 });
  const a = lib.describeEdid(before);
  const b = lib.describeEdid(bytes);
  assert.equal(b.name, 'PPT MAIN');
  assert.deepEqual({ ...b, name: a.name }, a, 'mode, timing and errors as they were');
});

test('a 13-character name fills the descriptor with no terminator', () => {
  const { bytes } = renameEdid(stock(), { name: 'Keynote Left!', serial: 1 });
  assert.equal(readName(bytes), 'Keynote Left!');
  assert.deepEqual([...bytes.slice(113, 126)], [...Buffer.from('Keynote Left!')]);
  assert.equal(NAME_MAX, 13);
});

test('a large serial goes in little-endian', () => {
  const { bytes } = renameEdid(stock(), { name: 'X', serial: 0x01020304 });
  assert.deepEqual([...bytes.slice(12, 16)], [4, 3, 2, 1]);
  assert.equal(readSerial(bytes), 0x01020304);
});

test('with no name descriptor a dummy takes it; with no room it is refused', () => {
  const b = Array.from(stock());
  /* The stock name becomes a dummy: renaming must find it. */
  b.splice(108, 18, 0, 0, 0, 0x10, ...new Array(14).fill(0));
  const r = renameEdid(Uint8Array.from(b), { name: 'Side', serial: 2 });
  assert.equal(readName(r.bytes), 'Side');
  assert.equal(r.bytes[108 + 3], 0xfc);

  /* Every descriptor a timing — copy the preferred DTD into all four. */
  const full = Array.from(stock());
  for (const o of [72, 90, 108]) full.splice(o, 18, ...full.slice(54, 72));
  const refused = renameEdid(Uint8Array.from(full), { name: 'Side', serial: 2 });
  assert.match(refused.error, /no room for a name/);
});

test('a second name descriptor is turned into a dummy, not left as a stale half', () => {
  const b = Array.from(stock());
  b.splice(72, 18, 0, 0, 0, 0xfc, 0, ...Buffer.from('MORE NAME'), 0x0a, 0x20, 0x20, 0x20);
  /* 72 comes first, so it is the one renamed; 108 goes dummy. */
  const { bytes } = renameEdid(Uint8Array.from(b), { name: 'Front', serial: 3 });
  assert.equal(readName(bytes), 'Front');
  assert.equal(bytes[72 + 3], 0xfc);
  assert.equal(bytes[108 + 3], 0x10);
  assert.ok(checksumOk(bytes));
});

test('not an EDID is refused', () => {
  assert.match(renameEdid(new Uint8Array(100), { name: 'A' }).error, /not a whole EDID/);
  assert.match(renameEdid(new Uint8Array(128), { name: 'A' }).error, /no EDID header/);
  assert.match(renameEdid(stock(), { name: '  ' }).error, /no name/);
});

// ------------------------------------------------------------------ the plugs

test('rows: plugs with an EDID, named from their labels; SDI and unlabelled say why', () => {
  const store = freshStore();
  label(store, 'IN_1', 'powerpoint main');
  label(store, 'IN_2', 'PPT BACKUP');
  const rows = plugRows(store, emptyDocument());
  assert.deepEqual(rows.map((r) => r.id), ['IN_1', 'IN_2', 'IN_12', 'IN_17', 'IN_18', 'IN_19', 'IN_20', 'IN_21', 'IN_22', 'IN_23', 'IN_24'],
    'IN_13 and IN_14 are SDI: no EDID');
  const [one, two, twelve] = rows;
  assert.equal(one.name, 'powerpoint ma');
  assert.equal(one.clipped, true);
  assert.equal(one.current.name, 'AQL_HDMI');
  assert.equal(readSerial(one.bytes), 1);
  assert.equal(two.name, 'PPT BACKUP');
  assert.equal(readSerial(two.bytes), 2);
  assert.equal(twelve.bytes, null);
  assert.match(twelve.why, /no label/);
  assert.equal(rows.find((r) => r.id === 'IN_17').current.name, 'AQL_DP');
});

test('rows: a short name holds for the label it was typed against', () => {
  const store = freshStore();
  label(store, 'IN_1', 'powerpoint main');
  let doc = withShortName(emptyDocument(), 'IN_1', 'powerpoint main', 'PPT MAIN');
  let one = plugRows(store, doc)[0];
  assert.equal(one.name, 'PPT MAIN');
  assert.equal(one.clipped, false);
  label(store, 'IN_1', 'keynote main');
  one = plugRows(store, doc)[0];
  assert.equal(one.name, 'keynote main', 'a new label takes over from a short name typed for the old one');
  doc = withShortName(doc, 'IN_1', 'keynote main', '');
  assert.deepEqual(doc.plugs, {}, 'clearing it leaves nothing behind');
});

test('rows: a short name names an unlabelled input', () => {
  const store = freshStore();
  const doc = withShortName(emptyDocument(), 'IN_12', '', 'Spare');
  const row = plugRows(store, doc).find((r) => r.id === 'IN_12');
  assert.equal(row.name, 'Spare');
  assert.equal(row.why, null);
});

test('rows: mosaic leaders, members and tile EDIDs are left alone', () => {
  const store = freshStore();
  for (const id of ['IN_17', 'IN_18', 'IN_19']) label(store, id, `DP ${id}`);
  store.set([...PRE, 'IN_17', 'status', 'pp', 'group'], '2X1');
  store.set([...PRE, 'IN_18', 'status', 'pp', 'global'], 'GROUPED');
  const tile = Buffer.from(TILES['3840x1080-2x1'][0].hex, 'hex');
  const data = [...tile]; while (data.length < 512) data.push(0xff);
  store.set([...INPUTS, 'IN_19', 'plugList', 'items', '1', 'edid', 'status', 'pp', 'data'], data);
  store.set([...INPUTS, 'IN_19', 'plugList', 'items', '1', 'edid', 'status', 'pp', 'dataSize'], '384');
  const rows = plugRows(store, emptyDocument());
  for (const id of ['IN_17', 'IN_18', 'IN_19']) {
    const r = rows.find((x) => x.id === id);
    assert.equal(r.bytes, null, id);
    assert.match(r.why, /mosaic/, id);
  }
});

test('rows: an input on program or preview says so', () => {
  const store = freshStore();
  store.set([...INPUTS, 'IN_1', 'status', 'pp', 'isOnProgram'], true);
  store.set([...INPUTS, 'IN_2', 'status', 'pp', 'isOnPreview'], true);
  const [one, two, twelve] = plugRows(store, emptyDocument());
  assert.deepEqual([one.onAir, two.onAir, twelve.onAir], ['program', 'preview', null]);
});

test('rows: busy or invalid plugs are not offered', () => {
  const store = freshStore();
  label(store, 'IN_1', 'A'); label(store, 'IN_2', 'B');
  store.set([...INPUTS, 'IN_1', 'plugList', 'items', '1', 'edid', 'status', 'pp', 'isBusy'], true);
  store.set([...INPUTS, 'IN_2', 'plugList', 'items', '1', 'edid', 'status', 'pp', 'isValid'], false);
  const [one, two] = plugRows(store, emptyDocument());
  assert.match(one.why, /busy/);
  assert.match(two.why, /not valid/);
});

// ------------------------------------------------------------------ writing

test('naming records the original before the write goes out, then the plug serves it', async () => {
  const r = rig();
  label(r.store, 'IN_1', 'PPT MAIN');
  label(r.store, 'IN_2', 'PPT BACKUP');
  const rows = plugRows(r.store, r.doc()).filter((x) => ['IN_1', 'IN_2'].includes(x.id));
  const res = await namePlugs(r.session, rows, { doc: r.doc(), save: r.save, timeout: 1000 });
  assert.equal(res.ok, true, res.problems.join('; '));
  assert.deepEqual(res.steps, ['In1 → PPT MAIN', 'In2 → PPT BACKUP']);

  /* Each save lands before that plug's first write. */
  assert.equal(r.kept[0].sentSoFar, 0);
  assert.deepEqual(r.kept[0].doc.plugs.IN_1.original, [...stock()]);
  assert.equal(r.kept[1].sentSoFar, 4, 'IN_2 is recorded after IN_1’s four writes and before its own');

  assert.equal(readName(servedEdid(r.store, 'IN_1').bytes), 'PPT MAIN');
  assert.equal(readSerial(servedEdid(r.store, 'IN_2').bytes), 2);
  const after = plugRows(r.store, r.doc());
  assert.equal(after[0].done, true);
  assert.equal(after[1].done, true);
  assert.ok(after[0].undo, 'undo is offered');
  assert.deepEqual([...after[0].undo], [...stock()]);
  /* The vendor's own write sequence, nothing more. */
  assert.deepEqual(r.fake.sent.slice(0, 4).map((s) => s.path.split('/').pop()), ['dataSize', 'data', 'xStore', 'xStore']);
  assert.deepEqual(r.fake.sent.slice(2, 4).map((s) => s.value), [false, true]);
});

test('a plug already named is not written again', async () => {
  const r = rig();
  label(r.store, 'IN_1', 'PPT MAIN');
  await namePlugs(r.session, plugRows(r.store, r.doc()).slice(0, 1), { doc: r.doc(), save: r.save, timeout: 1000 });
  const sent = r.fake.sent.length;
  const res = await namePlugs(r.session, plugRows(r.store, r.doc()).slice(0, 1), { doc: r.doc(), save: r.save, timeout: 1000 });
  assert.equal(r.fake.sent.length, sent);
  assert.deepEqual(res.steps, []);
});

test('renaming again keeps the first original, so undo goes all the way back', async () => {
  const r = rig();
  label(r.store, 'IN_1', 'First');
  await namePlugs(r.session, plugRows(r.store, r.doc()).slice(0, 1), { doc: r.doc(), save: r.save, timeout: 1000 });
  label(r.store, 'IN_1', 'Second');
  const row = plugRows(r.store, r.doc())[0];
  assert.equal(row.done, false, 'the label changed, so the plug is out of date');
  assert.equal(row.current.name, 'First');
  await namePlugs(r.session, [row], { doc: r.doc(), save: r.save, timeout: 1000 });
  assert.equal(readName(servedEdid(r.store, 'IN_1').bytes), 'Second');

  const res = await undoPlugs(r.session, plugRows(r.store, r.doc()).slice(0, 1), { doc: r.doc(), save: r.save, timeout: 1000 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.steps, ['In1 back to AQL_HDMI']);
  assert.deepEqual([...servedEdid(r.store, 'IN_1').bytes], [...stock()]);
  assert.deepEqual(r.doc().plugs, {}, 'nothing left to undo');
  assert.equal(plugRows(r.store, r.doc())[0].undo, null);
});

test('an EDID loaded since on the vendor page is not undone', async () => {
  const r = rig();
  label(r.store, 'IN_1', 'PPT MAIN');
  await namePlugs(r.session, plugRows(r.store, r.doc()).slice(0, 1), { doc: r.doc(), save: r.save, timeout: 1000 });
  /* Somebody drops another EDID onto In1: here, the stock one with a byte of difference. */
  const other = [...stock()];
  other[20] ^= 1; other[127] = (other[127] - 1 + 256) % 256;
  r.store.set([...INPUTS, 'IN_1', 'plugList', 'items', '1', 'edid', 'status', 'pp', 'data'], other);
  const row = plugRows(r.store, r.doc())[0];
  assert.equal(row.undo, null);
  assert.equal(row.replaced, true);
  /* Naming it now takes that EDID as the original. */
  await namePlugs(r.session, [row], { doc: r.doc(), save: r.save, timeout: 1000 });
  assert.deepEqual(r.doc().plugs.IN_1.original, other.slice(0, 256));
});

test('a save that fails stops the run before anything is written', async () => {
  const r = rig();
  label(r.store, 'IN_1', 'PPT MAIN');
  const save = async () => { throw new Error('disk full'); };
  await assert.rejects(namePlugs(r.session, plugRows(r.store, r.doc()).slice(0, 1), { doc: r.doc(), save, timeout: 1000 }), /disk full/);
  assert.equal(r.fake.sent.length, 0);
});

test('a plug that never reports the new EDID is a problem, and its record stays harmless', async () => {
  const r = rig();
  label(r.store, 'IN_1', 'PPT MAIN');
  const deaf = { store: r.store, send: () => true };
  const res = await namePlugs(deaf, plugRows(r.store, r.doc()).slice(0, 1), { doc: r.doc(), save: r.save, timeout: 200 });
  assert.equal(res.ok, false);
  assert.match(res.problems[0], /In1 did not take/);
  const row = plugRows(r.store, res.doc)[0];
  assert.equal(row.undo, null, 'the plug never served what was written, so there is nothing to undo');
  assert.equal(row.done, false);
});

test('document helpers leave other plugs alone', () => {
  let doc = withShortName(emptyDocument(), 'IN_2', 'x', 'Two');
  doc = withWrite(doc, 'IN_1', [1, 2], [3, 4]);
  doc = withWrite(doc, 'IN_1', [3, 4], [5, 6]);
  assert.deepEqual(doc.plugs.IN_1, { original: [1, 2], written: [5, 6] });
  doc = withoutWrite(doc, 'IN_1');
  assert.deepEqual(doc.plugs, { IN_2: { short: 'Two', forLabel: 'x' } });
});

// ------------------------------------------------------------------ the panel

test('the panel lists the plugs, names two after asking, and undoes them', async () => {
  const { install } = await import('./helpers/fake-dom.js');
  const { createNamesPanel } = await import('../plugins/edid-names/panel.js');
  const dom = install();
  try {
    const r = rig();
    label(r.store, 'IN_1', 'powerpoint main');
    label(r.store, 'IN_2', 'PPT BACKUP');
    const session = new EventTarget();
    session.store = r.store;
    session.send = (cmd) => r.fake.send(cmd);
    let kept = { plugs: {} };
    const storage = { load: async () => structuredClone(kept), save: async (d) => { kept = structuredClone(d); } };
    const asked = [];
    let answer = true;
    const win = { confirm: (text) => { asked.push(text); return answer; } };
    const target = document.createElement('div');
    document.body.append(target);
    const panel = createNamesPanel({ target, session, storage, log: { info() {}, warn() {} }, win });
    const settle = (ms = 50) => new Promise((ok) => setTimeout(ok, ms));
    const buttonNamed = (re) => target.querySelectorAll('button').find((b) => re.test(b.textContent));
    await settle();

    let text = target.textContent;
    assert.match(text, /What a computer plugged into each input sees/);
    assert.match(text, /In1powerpoint ma/, 'In1 will be called the label, cut');
    assert.match(text, /13\/13, cut from the label/);
    assert.match(text, /Shows AQL_HDMI, serial 0/);
    assert.match(text, /no label — give the input one, or type a name/, 'IN_12 has none');
    assert.ok(!/In13|In14/.test(text), 'SDI plugs are not listed');

    /* Asked first, and nothing goes out when the answer is no. */
    answer = false;
    buttonNamed(/^Name 2 plugs$/).click();
    await settle();
    assert.equal(asked.length, 1);
    assert.match(asked[0], /In1 → powerpoint ma, In2 → PPT BACKUP/);
    assert.equal(r.fake.sent.length, 0);

    answer = true;
    buttonNamed(/^Name 2 plugs$/).click();
    await settle(700);
    assert.equal(readName(servedEdid(r.store, 'IN_1').bytes), 'powerpoint ma');
    assert.equal(readName(servedEdid(r.store, 'IN_2').bytes), 'PPT BACKUP');
    assert.deepEqual(Object.keys(kept.plugs).sort(), ['IN_1', 'IN_2'], 'both originals kept');
    text = target.textContent;
    assert.match(text, /In1 → powerpoint ma; In2 → PPT BACKUP/);
    assert.match(text, /Named, serial 1/);
    assert.ok(buttonNamed(/^Undo 2$/), 'undo is offered for both');

    /* One plug alone, off air: no question. */
    asked.length = 0;
    target.querySelectorAll('button').filter((b) => b.textContent === 'Undo')[0].click();
    await settle(400);
    assert.equal(asked.length, 0);
    assert.equal(readName(servedEdid(r.store, 'IN_1').bytes), 'AQL_HDMI');
    assert.deepEqual(Object.keys(kept.plugs), ['IN_2']);

    panel.stop();
  } finally {
    dom.uninstall();
  }
});

test('the panel asks before naming one plug that is on program, and writes nothing if it cannot read its document', async () => {
  const { install } = await import('./helpers/fake-dom.js');
  const { createNamesPanel } = await import('../plugins/edid-names/panel.js');
  const dom = install();
  try {
    const r = rig();
    label(r.store, 'IN_1', 'LIVE');
    r.store.set([...INPUTS, 'IN_1', 'status', 'pp', 'isOnProgram'], true);
    const session = new EventTarget();
    session.store = r.store;
    session.send = (cmd) => r.fake.send(cmd);
    const asked = [];
    const settle = (ms = 50) => new Promise((ok) => setTimeout(ok, ms));

    let target = document.createElement('div');
    let panel = createNamesPanel({
      target, session, log: { info() {}, warn() {} }, win: { confirm: (t) => { asked.push(t); return false; } },
      storage: { load: async () => ({ plugs: {} }), save: async () => {} }
    });
    await settle();
    assert.match(target.textContent, / · on program/);
    target.querySelectorAll('button').find((b) => b.textContent === 'Name').click();
    await settle();
    assert.match(asked[0], /In1 is on program/);
    assert.equal(r.fake.sent.length, 0);
    panel.stop();

    target = document.createElement('div');
    panel = createNamesPanel({
      target, session, log: { info() {}, warn() {} }, win: { confirm: () => true },
      storage: { load: async () => { throw new Error('could not read the saved plug names (500)'); }, save: async () => {} }
    });
    await settle();
    assert.match(target.textContent, /Nothing is written until it can be read/);
    const name = target.querySelectorAll('button').find((b) => b.textContent === 'Name');
    assert.ok(name.hasAttribute('disabled'));
    panel.stop();
  } finally {
    dom.uninstall();
  }
});
