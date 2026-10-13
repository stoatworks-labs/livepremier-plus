/*
 * Inputs and outputs, live: the audio matrix, the EDID bank, mosaic inputs,
 * pitch compensation, the connectors and the sources — each read by the app's
 * own code off the proxied mirror and checked against what the switcher says
 * over AWJ, and the ones that write driven through and put back.
 *
 * Put back means as found, triggers included. The switcher leaves an `x…`
 * trigger reading true once it has fired, and the Journal does not keep
 * pulses; writing false is the arm half of a pulse and does nothing else
 * (watched on output 1's `xUpdate`, the input preconfig's three, a plug's
 * `xStore`/`xReset` and an EDID slot's `xDelete`), so a trigger that read
 * false before a test reads false after it.
 *
 * Two things a per-path journal would miss. The vendor's EDID save works
 * through the switcher's own editor buffer (`system/edid/edit`) and leaves the
 * saved EDID in it, so that buffer is journalled too and checked again once it
 * is back. And a plug's EDID reset writes the stock EDID into the plug's
 * staging (`edid/cmd`), which on a factory plug holds zeros.
 *
 * Found here, and marked todo rather than fixed: `mosaicTargets` offers a
 * GROUPED member of a mosaic as the start of another one.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SKIP, ROOT, startApp, Link, Journal, awjGet, awjGetAll, sleep, deepEqual
} from './harness.js';

import {
  frames, clock, readMatrix, blockState, blockWrites, crosspointWrites, fedBy, takesFrom,
  patch, destMute, sourceMute, txPath, rxMutePath, NONE
} from '../../plugins/audio-matrix/model.js';
import {
  readSlots, readFormats, formatTiming, savePayload, deleteCommand, slotHolding, slotCarrying, SAVE_URL
} from '../../plugins/edid/bank.js';
import {
  mosaicTargets, inspectMosaic, applyMosaic, clearMosaic, servedEdid, readTile, writePlugEdid
} from '../../plugins/edid-mosaic/core.js';
import {
  screenOutputs, toProject, pitchWrites, alreadyApplied, outputPitch, outputPitchCommit
} from '../../src/core/pitch.js';
import { compensate } from '../../src/vendor/pitch-engine.js';
import { readAllConnectors, readConnectors, describeConnector, logicalIndex } from '../../src/core/connectors.js';
import { listSources } from '../../src/core/screens.js';
import { dialectFor } from '../../src/core/dialect.js';

const here = dirname(fileURLToPath(import.meta.url));

let app;
let link;

before(async () => {
  if (SKIP) return;
  app = await startApp();
  link = await Link.open(app);
});

after(async () => {
  link?.close();
  await app?.close();
});

const D = (...p) => ['device', ...p];
const hz = (v) => (typeof v === 'number' ? v / 1000 : null);
const input = (id, ...p) => D('inputList', 'items', id, ...p);
const output = (key, ...p) => D('outputList', 'items', key, ...p);

/** Remember which triggers are idle now; the returned function re-arms the ones that fired. */
function triggers(paths) {
  const idle = paths.filter((p) => link.get(p) === false);
  return async () => {
    const fired = idle.filter((p) => link.get(p) !== false);
    if (fired.length) link.send(fired.map((path) => ({ path, value: false })));
    for (const p of fired) await link.waitFor(p, false);
  };
}

/** AWJ gets in slices, so one exchange never carries the whole matrix. */
async function awjMany(paths, size = 200) {
  const out = [];
  for (let i = 0; i < paths.length; i += size) out.push(...await awjGetAll(paths.slice(i, i + size)));
  return out;
}

/* ================================================================ *
 * Audio Matrix
 * ================================================================ */

const frame = () => frames(link.store)[0];

test('every frame the switcher has carries a matrix, and AWJ agrees on which those are', { skip: SKIP }, async () => {
  const fs = frames(link.store);
  assert.ok(fs.length >= 1, 'at least one frame has a matrix');
  assert.deepEqual(fs, link.keys(D('system', 'deviceList')), 'one matrix per frame of the system');

  /* One known crosspoint per frame, and one past the last, which AWJ does not have. */
  const firstDest = (f) => readMatrix(link.store, f, { fittedOnly: false }).destinations[0].id;
  const past = String(Math.max(...fs.map(Number)) + 1);
  const awj = await awjGetAll([...fs.map((f) => txPath(f, firstDest(f), 1, 'source')), txPath(past, 'OUTPUT_1', 1, 'source')]);
  fs.forEach((f, i) => assert.equal(typeof awj[i], 'string', `frame ${f} answers over AWJ`));
  assert.equal(awj[fs.length], undefined, `there is no frame ${past}`);

  const [clockMode, sampleRate] = await awjGetAll([D('audio', 'status', 'pp', 'clockMode'), D('audio', 'status', 'pp', 'sampleRate')]);
  assert.deepEqual(clock(link.store), { clockMode, sampleRate });
});

test('the matrix reads what the switcher reports, crosspoint for crosspoint and mute for mute', { skip: SKIP }, async () => {
  const f = frame();
  const m = readMatrix(link.store, f, { fittedOnly: false });
  for (const g of [...m.sources, ...m.destinations]) assert.equal(g.channels.length, 8, g.id);

  const cells = m.destinations.flatMap((d) => d.channels.map((c) => ({ d, c })));
  const awjTx = await awjMany(cells.flatMap(({ d, c }) => [txPath(f, d.id, c.ch, 'source'), txPath(f, d.id, c.ch, 'mute')]));
  cells.forEach(({ d, c }, i) => {
    assert.equal(c.source, awjTx[i * 2], `${d.id} ch ${c.ch} source`);
    assert.equal(c.mute, awjTx[i * 2 + 1], `${d.id} ch ${c.ch} mute`);
  });

  const chans = m.sources.flatMap((g) => g.channels);
  const awjRx = await awjMany(chans.map((c) => rxMutePath(f, c.key)));
  chans.forEach((c, i) => assert.equal(c.mute, awjRx[i], `${c.key} mute`));

  /* Fitted only hides an input that has no card behind it and feeds nothing —
     checked against the card the switcher reports, not the app's reading of it. */
  const shown = readMatrix(link.store, f, { fittedOnly: true });
  const hidden = m.sources.filter((g) => !shown.sources.some((s) => s.id === g.id));
  assert.equal(shown.hidden.sources, hidden.length);
  assert.ok(hidden.every((g) => g.kind === 'input'), 'Dante is never filtered');
  const fitted = await awjMany(hidden.map((g) => input(`IN_${g.unit}`, 'mapping', 'pp', 'isValid')));
  hidden.forEach((g, i) => assert.notEqual(fitted[i], true, `${g.id} is hidden, so it has no card`));
  for (const g of hidden) {
    assert.ok(!m.destinations.some((d) => d.channels.some((c) => g.channels.some((s) => s.key === c.source))),
      `${g.id} is hidden, so nothing takes from it`);
  }
});

/** A fitted input to patch from, and an output channel carrying nothing to patch into. */
function audioPick(m) {
  const fittedIns = new Set(readConnectors(link.store, 'input').map((c) => logicalIndex(c.key)));
  const src = m.sources.filter((g) => g.kind === 'input' && fittedIns.has(g.unit)).at(-1);
  const dst = m.destinations.filter((d) => d.kind === 'output' && d.channels.some((c) => c.source === NONE)).at(-1);
  return { src, dst };
}

test('a crosspoint click patches a channel, and a second click on it takes it back to None', { skip: SKIP }, async (t) => {
  const f = frame();
  const { src, dst } = audioPick(readMatrix(link.store, f));
  if (!src || !dst) return t.skip('no fitted input, or no output with a free channel');
  const ch = dst.channels.find((c) => c.source === NONE);
  const j = new Journal(link);
  try {
    const on = crosspointWrites(f, dst, ch, src.channels[0]);
    assert.deepEqual(on, [patch(f, dst.id, ch.ch, src.channels[0].key)], 'a click on an empty point is one patch');
    j.write(on);
    await link.waitFor(on[0].path, src.channels[0].key);
    assert.equal(await awjGet(on[0].path), src.channels[0].key, 'AWJ sees the patch');

    const lit = readMatrix(link.store, f);
    const litDst = lit.destinations.find((d) => d.id === dst.id);
    const litSrc = lit.sources.find((g) => g.id === src.id);
    assert.equal(fedBy(litSrc.channels[0], litDst), 1);
    assert.equal(takesFrom(litDst.channels.find((c) => c.ch === ch.ch), litSrc).key, src.channels[0].key);
    assert.equal(blockState(litSrc, litDst).count, 1);

    const off = crosspointWrites(f, litDst, litDst.channels.find((c) => c.ch === ch.ch), litSrc.channels[0]);
    assert.deepEqual(off.map((w) => w.value), [NONE], 'a click on a lit point is a patch to None');
    j.write(off);
    await link.waitFor(off[0].path, NONE);
    assert.equal(await awjGet(off[0].path), NONE);
  } finally {
    await j.restore();
  }
  assert.equal(await awjGet(txPath(f, dst.id, ch.ch, 'source')), ch.source, 'put back');
});

test('a block click lays a source channel for channel, completes a half block, and clears a straight one', { skip: SKIP }, async (t) => {
  const f = frame();
  const m = readMatrix(link.store, f);
  const { src } = audioPick(m);
  if (!src) return t.skip('no fitted input to patch from');
  /* A multiviewer: on the simulator nobody listens to one, and it has eight channels like any output. */
  const dst = m.destinations.filter((d) => d.kind === 'multiviewer' && !blockState(src, d).straight).at(-1);
  if (!dst) return t.skip('no multiviewer to patch into');
  const paths = dst.channels.map((c) => txPath(f, dst.id, c.ch, 'source'));
  const was = paths.map((p) => link.get(p));
  const j = new Journal(link);
  const group = () => {
    const now = readMatrix(link.store, f);
    return { s: now.sources.find((g) => g.id === src.id), d: now.destinations.find((g) => g.id === dst.id) };
  };
  try {
    const lay = blockWrites(f, src, dst);
    assert.equal(lay.length, dst.channels.filter((c, i) => c.source !== src.channels[i].key).length, 'only the channels that change');
    j.write(lay);
    for (const w of lay) await link.waitFor(w.path, w.value);
    assert.deepEqual(await awjGetAll(paths), src.channels.map((c) => c.key), 'AWJ: 1→1 … 8→8');
    assert.deepEqual(blockState(group().s, group().d), { count: 8, straight: true });

    /* Knock one channel out, and the block click sends only that channel back. */
    j.write(patch(f, dst.id, 4, NONE));
    await link.waitFor(paths[3], NONE);
    const fill = blockWrites(f, group().s, group().d);
    assert.deepEqual(fill.map((w) => [w.path[11], w.value]), [['4', src.channels[3].key]]);
    j.write(fill);
    await link.waitFor(paths[3], src.channels[3].key);

    /* Straight again, so the click clears the whole block. */
    const clear = blockWrites(f, group().s, group().d);
    assert.equal(clear.length, 8);
    assert.ok(clear.every((w) => w.value === NONE));
    j.write(clear);
    for (const w of clear) await link.waitFor(w.path, NONE);
    assert.deepEqual(await awjGetAll(paths), new Array(8).fill(NONE), 'AWJ: cleared');
    assert.equal(blockState(group().s, group().d).count, 0);
  } finally {
    await j.restore();
  }
  assert.deepEqual(await awjGetAll(paths), was, 'put back');
});

test('a destination channel mutes alone; a source channel mutes into every destination', { skip: SKIP }, async (t) => {
  const f = frame();
  const { src, dst } = audioPick(readMatrix(link.store, f));
  if (!src || !dst) return t.skip('no fitted input or output to mute');
  const dPath = txPath(f, dst.id, 1, 'mute');
  const sPath = rxMutePath(f, src.channels[1].key);
  const was = [link.get(dPath), link.get(sPath)];
  const j = new Journal(link);
  try {
    const on = [destMute(f, dst.id, 1, !was[0]), sourceMute(f, src.channels[1].key, !was[1])];
    j.write(on);
    await link.waitFor(dPath, !was[0]);
    await link.waitFor(sPath, !was[1]);
    assert.deepEqual(await awjGetAll([dPath, sPath]), [!was[0], !was[1]]);

    const m = readMatrix(link.store, f);
    const d = m.destinations.find((x) => x.id === dst.id);
    assert.deepEqual(d.channels.map((c) => c.mute), [!was[0], ...dst.channels.slice(1).map((c) => c.mute)],
      'one channel of the destination, and only that one');
    const s = m.sources.find((x) => x.id === src.id);
    assert.equal(s.channels[1].mute, !was[1]);
    assert.equal(s.channels[0].mute, src.channels[0].mute, 'its neighbour is untouched');

    /* And the same builders unmute. */
    j.write([destMute(f, dst.id, 1, was[0]), sourceMute(f, src.channels[1].key, was[1])]);
    await link.waitFor(dPath, was[0]);
    await link.waitFor(sPath, was[1]);
  } finally {
    await j.restore();
  }
  assert.deepEqual(await awjGetAll([dPath, sPath]), was, 'put back');
});

/* ================================================================ *
 * EDID bank
 * ================================================================ */

const BANK = D('system', 'edid', 'bankList', 'items');
const slotStatus = (id, k) => [...BANK, String(id), 'status', 'pp', k];

test('the bank reads as the hundred slots the switcher reports, and the formats as its valid ones', { skip: SKIP }, async () => {
  const slots = readSlots(link.store);
  assert.equal(slots.length, 100);
  const awj = await awjMany(slots.flatMap((s) => [slotStatus(s.id, 'isAvailable'), slotStatus(s.id, 'isProtected'), slotStatus(s.id, 'productName')]));
  slots.forEach((s, i) => {
    assert.equal(s.empty, !awj[i * 3], `${s.label} empty`);
    assert.equal(s.locked, !!awj[i * 3 + 1], `${s.label} protected`);
    assert.equal(s.name, s.empty ? '' : awj[i * 3 + 2], `${s.label} name`);
  });

  const valid = await awjGetAll(Array.from({ length: 16 }, (_, i) => D('customFormats', 'bankList', 'items', String(i + 1), 'status', 'pp', 'isValid')));
  assert.deepEqual(readFormats(link.store).map((f) => f.index), valid.flatMap((v, i) => (v ? [i + 1] : [])));
});

/* Two custom formats from test/edid.test.js: one a CTA raster (256 bytes, VIC
   16), one no table has (128 bytes). Which is saved follows the size the free
   slot last held, because an emptied slot keeps the size of what was in it —
   saving the other would leave it unlike its neighbours. */
const M15 = { hSync: 44, hSyncPol: true, hBackPorch: 148, hFrontPorch: 88, hUtil: 1920, vSync: 5, vSyncPol: true, vBackporch: 36, vFrontPorch: 4, vUtil: 1080, rate: 60000, isValid: true };
const M16 = { hSync: 32, hSyncPol: true, hBackPorch: 80, hFrontPorch: 48, hUtil: 3000, vSync: 5, vSyncPol: false, vBackporch: 20, vFrontPorch: 3, vUtil: 1000, rate: 50000, isValid: true };

test('an EDID saved through the app fills a free slot, and the bin empties it again', { skip: SKIP }, async (t) => {
  const { edidForTiming, describeEdid } = await import('../../src/vendor/otter-edid-embed.js');
  const free = readSlots(link.store).filter((s) => s.empty && !s.locked).at(-1);
  if (!free) return t.skip('the EDID bank is full');
  const id = free.id;
  const sizeWas = link.get(slotStatus(id, 'dataSize'));
  const format = sizeWas === '128' ? M16 : M15;
  const timing = formatTiming(format);
  const built = edidForTiming(timing, { name: 'lpp io sim' });
  const bytes = Array.from(built.bytes);

  const EDIT = D('system', 'edid', 'edit');
  const editStatus = structuredClone(link.get([...EDIT, 'status', 'pp']));
  /* What the buffer held before the save put ours in it. */
  const original = {
    data: structuredClone(link.get([...EDIT, 'control', 'pp', 'data'])),
    dataSize: link.get([...EDIT, 'control', 'pp', 'dataSize'])
  };
  const j = new Journal(link);
  j.remember([...EDIT, 'control', 'pp', 'data']);
  j.remember([...EDIT, 'control', 'pp', 'dataSize']);
  const rearm = triggers([
    [...EDIT, 'control', 'pp', 'xCheck'],
    D('system', 'edid', 'save', 'bankList', 'items', id, 'pp', 'xRequest'),
    [...BANK, id, 'control', 'pp', 'xDelete']
  ]);

  try {
    /* Posted the way the page posts it: to the app, which relays `/api/…`. */
    const res = await fetch(app.base + SAVE_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(savePayload(id, built.bytes))
    });
    assert.equal(res.status, 200, await res.text());
    await link.waitFor(slotStatus(id, 'isAvailable'), true, { timeout: 8000, label: `ED${id} to fill` });
    await link.waitFor(slotStatus(id, 'productName'), 'lpp io sim');

    const slot = readSlots(link.store).find((s) => s.id === id);
    assert.equal(slot.empty, false);
    assert.equal(slot.name, 'lpp io sim');
    assert.deepEqual(Array.from(slot.bytes), bytes, 'the mirror holds our bytes, unpadded');
    assert.equal(slotHolding(readSlots(link.store), built.bytes).id, id);
    assert.equal(slotCarrying(readSlots(link.store), timing, describeEdid).id, id, 'and auto-fill would know the format is covered');

    const [avail, name, size, data] = await awjGetAll([
      slotStatus(id, 'isAvailable'), slotStatus(id, 'productName'), slotStatus(id, 'dataSize'), slotStatus(id, 'data')
    ]);
    assert.deepEqual([avail, name, size], [true, 'lpp io sim', String(bytes.length)]);
    assert.deepEqual(data.slice(0, bytes.length), bytes, 'AWJ serves the same bytes');
    assert.ok(data.slice(bytes.length).every((b) => b === 0xff), 'padded with 0xFF, as the vendor pads');

    link.send(deleteCommand(id));
    await link.waitFor(slotStatus(id, 'isAvailable'), false, { timeout: 8000, label: `ED${id} to empty` });
    assert.equal(readSlots(link.store).find((s) => s.id === id).bytes, null);
    assert.equal(await awjGet(slotStatus(id, 'isAvailable')), false);
  } finally {
    if (link.get(slotStatus(id, 'isAvailable')) === true && link.get(slotStatus(id, 'productName')) === 'lpp io sim') {
      link.send(deleteCommand(id));
      await link.waitFor(slotStatus(id, 'isAvailable'), false, { timeout: 8000 }).catch(() => {});
    }
    /* The editor buffer back, and checked again so its status follows. */
    const changed = !deepEqual(link.get([...EDIT, 'status', 'pp']), editStatus);
    const check = async () => {
      link.send({ path: [...EDIT, 'control', 'pp', 'xCheck'], value: false });
      await sleep(150);
      link.send({ path: [...EDIT, 'control', 'pp', 'xCheck'], value: true });
      await sleep(400);
    };
    await j.restore();
    if (changed) {
      await check();
      /*
       * The extension fields are only worked out when a VALID EDID is
       * checked; checking anything else (the empty buffer included) leaves
       * them saying whatever the last valid one had. So if they still differ,
       * check a valid EDID with as many blocks as the original reported —
       * M16 builds one block, M15 two — then put the buffer back and check
       * that, which sets the rest.
       */
      if (!deepEqual(link.get([...EDIT, 'status', 'pp', 'extensionAvailable']), editStatus.extensionAvailable)) {
        const prime = edidForTiming(formatTiming((editStatus.extensionAvailable || []).length ? M15 : M16), { name: 'lpp prime' });
        const padded = Array.from(prime.bytes).concat(new Array(512 - prime.bytes.length).fill(0));
        link.send([
          { path: [...EDIT, 'control', 'pp', 'data'], value: padded },
          { path: [...EDIT, 'control', 'pp', 'dataSize'],
            value: typeof original.dataSize === 'number' ? prime.bytes.length : String(prime.bytes.length) }
        ]);
        await sleep(300);
        await check();
        await link.waitFor([...EDIT, 'status', 'pp', 'extensionAvailable'], editStatus.extensionAvailable,
          { timeout: 4000, label: 'the primed EDID to be checked' }).catch(() => {});
        link.send([
          { path: [...EDIT, 'control', 'pp', 'data'], value: original.data },
          { path: [...EDIT, 'control', 'pp', 'dataSize'], value: original.dataSize }
        ]);
        await sleep(300);
        await check();
      }
      /* A check is a pulse; one that lands while the data is still arriving
         reads the old buffer, so give it a second go before giving up. */
      for (let tries = 0; tries < 2; tries++) {
        const ok = await link.waitFor([...EDIT, 'status', 'pp'], editStatus, { timeout: 4000, label: 'the EDID editor buffer to read as before' })
          .then(() => true, () => false);
        if (ok) break;
        await check();
      }
    }
    await rearm();
  }

  const [avail, size, name] = await awjGetAll([slotStatus(id, 'isAvailable'), slotStatus(id, 'dataSize'), slotStatus(id, 'productName')]);
  assert.deepEqual([avail, size, name], [false, sizeWas, ''], `ED${id} is empty and the size it had`);
  assert.deepEqual(link.get([...EDIT, 'status', 'pp']), editStatus, 'the editor buffer reads as it did');
  assert.equal(await awjGet([...BANK, id, 'control', 'pp', 'xDelete']), false);
});

/* ================================================================ *
 * EDID Mosaic
 * ================================================================ */

const pre = (id, k) => D('preconfig', 'inputs', 'current', 'inputList', 'items', id, 'status', 'pp', k);
const plug = (id, ...p) => input(id, 'plugList', 'items', '1', ...p);

test('mosaic targets give the reasons the switcher’s own fields give', { skip: SKIP }, async () => {
  const targets = mosaicTargets(link.store, 2, 1);
  assert.ok(targets.some((t) => t.ok), 'at least one 2 × 1 run can be grouped');
  const ids = [...new Set(targets.flatMap((t) => t.members))];
  const awj = await awjMany(ids.flatMap((id) => [
    input(id, 'mapping', 'pp', 'card'), plug(id, 'status', 'pp', 'type'),
    plug(id, 'edid', 'status', 'pp', 'dataSizeAvailable'), pre(id, 'groupValidity'), pre(id, 'group')
  ]));
  const dev = Object.fromEntries(ids.map((id, i) => [id, {
    card: awj[i * 5], type: awj[i * 5 + 1], sizes: (awj[i * 5 + 2] || []).map(String), validity: awj[i * 5 + 3] || [], group: awj[i * 5 + 4]
  }]));

  for (const t of targets) {
    const [a, b] = t.members.map((id) => dev[id]);
    assert.equal(Number(t.members[1].slice(3)), Number(t.members[0].slice(3)) + 1, `${t.id}: consecutive inputs`);
    const reasons = {
      validity: !a.validity.includes('2X1'),
      card: a.card !== b.card,
      type: a.type !== b.type,
      size: ![a, b].every((x) => x.sizes.includes('384'))
    };
    if (t.ok) assert.deepEqual(reasons, { validity: false, card: false, type: false, size: false }, t.label);
    if (reasons.validity) assert.match(t.why, /cannot be grouped 2X1/, t.id);
    if (reasons.card) assert.match(t.why, /another card/, t.id);
    if (reasons.type) assert.match(t.why, /connector types/, t.id);
    if (reasons.size) assert.match(t.why, /384-byte/, t.id);
  }

  /* An input the switcher says is 1X1 inspects as not grouped, at the size it serves. */
  const single = targets.find((t) => t.ok && dev[t.id].group === '1X1');
  if (single) {
    const seen = inspectMosaic(link.store, single.id);
    assert.equal(seen.group, '1X1');
    assert.equal(seen.ok, false);
    assert.match(seen.problems.join('\n'), new RegExp(`${single.id} is not grouped`));
    assert.equal(seen.members[0].size, Number(await awjGet(plug(single.id, 'edid', 'status', 'pp', 'dataSize'))));
  }

  for (const t of mosaicTargets(link.store, 2, 2).filter((x) => x.ok)) {
    assert.ok((await awjGet(pre(t.id, 'groupValidity'))).includes('2X2'), `${t.id} can be grouped 2X2`);
  }
});

/** Inputs the other files in this folder put on layers. A grouped member stops
    being a valid layer source, so a mosaic must not land on one of theirs. */
function inputsUsedElsewhere() {
  const used = new Set();
  for (const f of readdirSync(here)) {
    if (!f.endsWith('.sim.test.js') || f === 'io.sim.test.js') continue;
    for (const m of readFileSync(join(here, f), 'utf8').matchAll(/LIVE_(\d+)/g)) used.add(`IN_${m[1]}`);
  }
  return used;
}

/** The stock EDIDs the switcher can reset a plug to, as byte strings. */
function stockEdids() {
  const items = link.get(BANK) || {};
  return new Set(Object.keys(items).filter((k) => k.startsWith('DEFAULT_')).map((k) => {
    const s = items[k].status.pp;
    return s.data.slice(0, Number(s.dataSize)).join(',');
  }));
}

/*
 * 2 × 1 only: core.js records that a 2 × 2 put two members in one place on the
 * simulator, so it refuses there. Clearing resets each plug to the switcher's
 * default EDID, which puts back the EDID a plug was serving only when that was
 * a stock one — so a plug serving anything else is a skip, not a guess.
 */
test('a 2 × 1 mosaic groups two plugs and loads their tiles, and clearing it puts both back', { skip: SKIP }, async (t) => {
  const tiles = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'otter-mosaic-tiles.json'), 'utf8'))['3840x1080-2x1']
    .map((x) => ({ ...x, bytes: Uint8Array.from(Buffer.from(x.hex, 'hex')) }));

  const NEW = D('preconfig', 'inputs', 'new');
  if (link.get([...NEW, 'status', 'pp', 'hasChanged']) === true) {
    return t.skip('somebody has input preconfig changes staged; copying from current would throw them away');
  }
  const avoid = inputsUsedElsewhere();
  const stock = stockEdids();
  const quiet = mosaicTargets(link.store, 2, 1).filter((x) => x.ok && x.members.every((id) => {
    const st = link.get(input(id, 'status', 'pp')) || {};
    /* Clearing ungroups, so only a run that is not grouped now can be put back by it. */
    const single = link.get(pre(id, 'group')) === '1X1' && link.get(pre(id, 'global')) !== 'GROUPED';
    return single && !avoid.has(id) && !st.isOnProgram && !st.isOnPreview && stock.has(servedEdid(link.store, id).bytes.join(','));
  }));
  /* DP first: it is where a Mac's mosaic arrives, and what the fixtures were cut from. */
  const target = quiet.find((x) => /\(DP,/.test(x.label)) || quiet[0];
  if (!target) return t.skip('no ungrouped 2 × 1 run that is off screen, unused by the other files, and serving stock EDIDs');
  const [first, second] = target.members;

  const was = Object.fromEntries(target.members.map((id) => [id, {
    served: servedEdid(link.store, id).bytes,
    staged: structuredClone(link.get(plug(id, 'edid', 'cmd', 'pp', 'data'))),
    group: link.get(pre(id, 'group')),
    global: link.get(pre(id, 'global'))
  }]));
  const j = new Journal(link);
  for (const id of target.members) {
    j.remember(plug(id, 'edid', 'cmd', 'pp', 'data'));
    j.remember(plug(id, 'edid', 'cmd', 'pp', 'dataSize'));
  }
  j.remember([...NEW, 'inputList', 'items', first, 'control', 'pp', 'group']);
  const rearm = triggers([
    ...['xCopyFromCurrent', 'xCheck', 'xApply'].map((k) => [...NEW, 'control', 'pp', k]),
    ...target.members.flatMap((id) => ['xStore', 'xReset'].map((k) => plug(id, 'edid', 'cmd', 'pp', k)))
  ]);
  const served = (id) => servedEdid(link.store, id).bytes;

  try {
    const r = await applyMosaic(link.session, first, tiles);
    assert.equal(r.ok, true, [...r.steps, ...r.problems].join('; '));

    const [group, global, left, sizeA, sizeB, dataA, dataB] = await awjGetAll([
      pre(first, 'group'), pre(second, 'global'), plug(second, 'status', 'signal', 'pp', 'imagePlugLeft'),
      plug(first, 'edid', 'status', 'pp', 'dataSize'), plug(second, 'edid', 'status', 'pp', 'dataSize'),
      plug(first, 'edid', 'status', 'pp', 'data'), plug(second, 'edid', 'status', 'pp', 'data')
    ]);
    assert.deepEqual([group, global], ['2X1', 'GROUPED'], 'AWJ: grouped');
    assert.equal(left, readTile(tiles[0].bytes).width, 'the right plug sits one tile in');
    assert.deepEqual([sizeA, sizeB], ['384', '384']);
    assert.deepEqual(dataA.slice(0, 384), Array.from(tiles[0].bytes), `${first} serves the left tile`);
    assert.deepEqual(dataB.slice(0, 384), Array.from(tiles[1].bytes), `${second} serves the right tile`);

    const seen = inspectMosaic(link.store, first);
    assert.equal(seen.ok, true, seen.problems.join('; '));
    assert.deepEqual(seen.members.map((m) => [m.id, m.tile.col, m.tile.row]), [[first, 0, 0], [second, 1, 0]]);
    assert.equal(mosaicTargets(link.store, 2, 1).find((x) => x.id === first).ok, true, 're-applying is still offered');

    /*
     * The partner is GROUPED into the first input, yet it is offered as the
     * start of a mosaic of its own: `mosaicTargets` checks the rest of a run
     * for GROUPED members but never the input the run starts at. The unit
     * test's "partner cannot start a group" looks at the input BEFORE the pair,
     * because its fixture has nothing after it. Not applied here, so what the
     * switcher would make of it is not known.
     */
    await t.test('the partner of a grouped pair is not offered as the start of another', {
      todo: 'core.js mosaicTargets: a GROUPED first input is not refused (live, 6.2.73)'
    }, async () => {
      const offered = mosaicTargets(link.store, 2, 1).find((x) => x.id === second);
      assert.equal(await awjGet(pre(second, 'global')), 'GROUPED', `${second} is a member of ${first}'s group`);
      assert.equal(offered?.ok ?? false, false, `${second} is offered: ${offered && offered.label}`);
    });
  } finally {
    await clearMosaic(link.session, first);
    await link.waitFor(pre(first, 'group'), was[first].group, { timeout: 15000 }).catch(() => {});
    for (const id of target.members) {
      const back = await link.waitFor(plug(id, 'edid', 'status', 'pp', 'data'),
        () => deepEqual(served(id), was[id].served), { timeout: 8000 }).then(() => true, () => false);
      /* Not the stock EDID after all: put the bytes back by hand, and let the
         assertions below say so. */
      if (!back) await writePlugEdid(link.session, id, was[id].served);
    }
    /* The reset writes the stock EDID into the plug's staging too; that goes back last. */
    await j.restore();
    await rearm();
  }

  for (const id of target.members) {
    const [group, global, size, data, cmd] = await awjGetAll([
      pre(id, 'group'), pre(id, 'global'), plug(id, 'edid', 'status', 'pp', 'dataSize'),
      plug(id, 'edid', 'status', 'pp', 'data'), plug(id, 'edid', 'cmd', 'pp', 'data')
    ]);
    assert.deepEqual([group, global], [was[id].group, was[id].global], `${id} grouping put back`);
    assert.equal(Number(size), was[id].served.length);
    assert.deepEqual(data.slice(0, Number(size)), was[id].served, `${id} serves the EDID it served before`);
    assert.deepEqual(cmd, was[id].staged, `${id} staging holds what it held`);
  }
  assert.equal(inspectMosaic(link.store, first).group, was[first].group);
});

/* ================================================================ *
 * Pitch compensation
 * ================================================================ */

const canvas = (key, k) => output(key, 'canvas', 'status', 'pp', k);

test('the outputs on S1 are the ones the switcher puts there, as it reports them', { skip: SKIP }, async () => {
  const outs = screenOutputs(link.store, 'S1');
  assert.ok(outs.length >= 1, 'S1 drives at least one output');

  /* Every fitted output, and which screen AWJ says it is on. */
  const fitted = readConnectors(link.store, 'output').map((c) => c.key);
  const on = await awjGetAll(fitted.map((k) => canvas(k, 'usedInScreenAux')));
  assert.deepEqual(outs.map((o) => o.key), fitted.filter((k, i) => on[i] === 'S1'), 'the same outputs, in output order');

  for (const o of outs) {
    const [w, h, x, y, pw, ph, rh, rv] = await awjGetAll([
      canvas(o.key, 'maxWidth'), canvas(o.key, 'maxHeight'), canvas(o.key, 'left'), canvas(o.key, 'top'),
      canvas(o.key, 'pitchedWidth'), canvas(o.key, 'pitchedHeight'),
      outputPitch(o.key, 'H'), outputPitch(o.key, 'V')
    ]);
    assert.deepEqual(
      [o.pxWidth, o.pxHeight, o.canvasX, o.canvasY, o.footprintWidth, o.footprintHeight, o.liveRawH, o.liveRawV],
      [w, h, x, y, pw, ph, rh, rv], `output ${o.key}`);
  }
});

/** S1's first output, and a pitch project for it against a finer wall that has
    no output: S1 drives one output on the simulator, a ratio needs two pitches,
    and `pitchWrites` writes nothing for a group with no output key. */
function pitchProject(hMm) {
  const [out] = screenOutputs(link.store, 'S1');
  const reference = { key: '', pxWidth: out.pxWidth, pxHeight: out.pxHeight };
  const project = toProject([out, reference], { [out.key]: { hMm, vMm: hMm }, '': { hMm: 2.5, vMm: 2.5 } });
  const result = compensate(project);
  return { out, result, group: result.groups.find((g) => g.group.outputKey === out.key) };
}

test('a ratio written without xUpdate moves the field and leaves the footprint where it was', { skip: SKIP }, async () => {
  const [out] = screenOutputs(link.store, 'S1');
  const H = outputPitch(out.key, 'H');
  const j = new Journal(link);
  try {
    j.write({ path: H, value: out.liveRawH === 2000 ? 1500 : 2000 });
    await link.waitFor(H, (v) => v !== out.liveRawH);
    await sleep(800);
    assert.equal(link.get(canvas(out.key, 'pitchedWidth')), out.footprintWidth, 'the mirror');
    assert.equal(await awjGet(canvas(out.key, 'pitchedWidth')), out.footprintWidth, 'and AWJ');
  } finally {
    await j.restore();
  }
  assert.deepEqual(await awjGetAll([H, canvas(out.key, 'pitchedWidth')]), [out.liveRawH, out.footprintWidth]);
});

/*
 * 3.085 mm against 2.5 mm is exactly 1.234, the ratio the engine's notes
 * measured the floor with: 1080 × 1.234 is 1332.72, and the switcher must say
 * 1332, not 1333.
 */
test('compensation for two pitches lands on the switcher as the engine predicted, floor and all', { skip: SKIP }, async () => {
  const { out, result, group } = pitchProject(3.085);
  assert.deepEqual([group.h.raw, group.v.raw], [1234, 1234]);
  assert.equal(group.v.footprint, Math.floor(out.pxHeight * 1234 / 1000));
  assert.equal(alreadyApplied(result, screenOutputs(link.store, 'S1')), out.liveRawH === 1234 && out.liveRawV === 1234);

  const writes = pitchWrites(result);
  assert.deepEqual(writes, [
    { path: outputPitch(out.key, 'H'), value: 1234 },
    { path: outputPitch(out.key, 'V'), value: 1234 },
    { path: outputPitchCommit(out.key), value: true }
  ], 'one output, ratios then the commit; the reference wall with no output writes nothing');

  const rearm = triggers([outputPitchCommit(out.key)]);
  const j = new Journal(link);
  try {
    j.write(writes);
    await link.waitFor(canvas(out.key, 'pitchedWidth'), group.h.footprint, { timeout: 8000 });
    await link.waitFor(canvas(out.key, 'pitchedHeight'), group.v.footprint, { timeout: 8000 });
    assert.deepEqual(
      await awjGetAll([outputPitch(out.key, 'H'), outputPitch(out.key, 'V'), canvas(out.key, 'pitchedWidth'), canvas(out.key, 'pitchedHeight')]),
      [1234, 1234, group.h.footprint, group.v.footprint], 'AWJ: the ratio, and the footprint it floors to');
    assert.equal(alreadyApplied(result, screenOutputs(link.store, 'S1')), true, 'the panel would say already set');
  } finally {
    await j.restore();
    link.send({ path: outputPitchCommit(out.key), value: true });
    await link.waitFor(canvas(out.key, 'pitchedWidth'), out.footprintWidth, { timeout: 8000 }).catch(() => {});
    await link.waitFor(canvas(out.key, 'pitchedHeight'), out.footprintHeight, { timeout: 8000 }).catch(() => {});
    await rearm();
  }
  assert.deepEqual(
    await awjGetAll([outputPitch(out.key, 'H'), outputPitch(out.key, 'V'), canvas(out.key, 'pitchedWidth'),
      canvas(out.key, 'pitchedHeight'), outputPitchCommit(out.key)]),
    [out.liveRawH, out.liveRawV, out.footprintWidth, out.footprintHeight, false], 'put back, commit re-armed');
});

test('an out-of-range ratio is never built, and the switcher discards one sent anyway', { skip: SKIP }, async () => {
  const { out, result, group } = pitchProject(30);
  assert.equal(group.h.outOfRange, true, '30 mm against 2.5 mm is 12.000, past the field’s 10.000');
  assert.deepEqual(pitchWrites(result), []);

  /* Straight to the wire, past the engine: the two values the engine's notes
     say were discarded, either side of the range. */
  const H = outputPitch(out.key, 'H');
  const j = new Journal(link);
  try {
    for (const bad of [10001, 99]) {
      j.write({ path: H, value: bad });
      await sleep(800);
      assert.equal(link.get(H), out.liveRawH, `${bad} left the mirror alone`);
      assert.equal(await awjGet(H), out.liveRawH, `${bad} left the switcher alone`);
    }
  } finally {
    await j.restore();
  }
});

/* ================================================================ *
 * Connectors, sources and signal
 * ================================================================ */

test('the connectors read as the switcher reports them, in its own spelling', { skip: SKIP }, async () => {
  const all = readAllConnectors(link.store);
  for (const side of ['input', 'output']) {
    const list = all[side];
    const collection = side === 'input' ? 'inputList' : 'outputList';
    assert.ok(list.length > 0, `some ${side}s are fitted`);

    /* Fitted is the card the switcher says is there — counted over every position. */
    const every = link.keys(D(collection));
    const valid = await awjMany(every.map((k) => D(collection, 'items', k, 'mapping', 'pp', 'isValid')));
    assert.deepEqual(list.map((c) => c.key), every.filter((k, i) => valid[i] === true), `${side}: fitted is isValid`);

    const awj = await awjMany(list.flatMap((c) => [
      D(collection, 'items', c.key, 'mapping', 'pp', 'card'),
      D(collection, 'items', c.key, 'mapping', 'pp', 'physical'),
      D(collection, 'items', c.key, 'plugList', 'items', '1', 'status', 'pp', 'type'),
      D(collection, 'items', c.key, 'control', 'pp', 'label')
    ]));
    list.forEach((c, i) => {
      const [card, physical, type, label] = awj.slice(i * 4, i * 4 + 4);
      assert.deepEqual([c.card, c.physical, c.plug, c.label], [card, physical, type, label || ''], c.id);
      /* The asymmetry connectors.js warns about: IN_ on inputs, bare on outputs. */
      assert.match(c.key, side === 'input' ? /^IN_\d+$/ : /^\d+$/);
      const words = [`${side === 'input' ? 'Input' : 'Output'} ${logicalIndex(c.key)}`, `card ${card}`,
        ...(physical !== c.key ? [`connector ${physical}`] : []), ...(type ? [type.replace(/_/g, ' ').toLowerCase()] : [])].join(' · ');
      assert.equal(describeConnector(c), label ? `${words} — ${label}` : words);
    });
  }
});

test('sources are the fitted inputs and loaded stills, labelled as the switcher labels them', { skip: SKIP }, async () => {
  const sources = listSources(link.store);
  const inputs = sources.filter((s) => s.kind === 'input');
  const fitted = readConnectors(link.store, 'input');
  assert.deepEqual(inputs.map((s) => s.value), fitted.map((c) => `LIVE_${logicalIndex(c.key)}`));

  const labels = await awjMany(fitted.map((c) => input(c.key, 'control', 'pp', 'label')));
  inputs.forEach((s, i) => assert.equal(s.label, labels[i] || `IN${logicalIndex(fitted[i].key)}`, s.value));

  /* An input with no card is not offered, and the switcher calls it disabled. */
  const unfitted = readConnectors(link.store, 'input', { includeUnfitted: true }).find((c) => !c.fitted);
  if (unfitted) {
    assert.ok(!sources.some((s) => s.value === `LIVE_${logicalIndex(unfitted.key)}`));
    assert.deepEqual(await awjGetAll([input(unfitted.key, 'mapping', 'pp', 'isValid'), input(unfitted.key, 'status', 'pp', 'global')]),
      [false, 'DISABLE']);
  }

  const stills = sources.filter((s) => s.kind === 'still');
  const loaded = await awjMany(stills.map((s) => D('stillList', 'items', s.value.slice(6), 'status', 'pp', 'isValid')));
  stills.forEach((s, i) => assert.equal(loaded[i], true, `${s.value} holds a picture`));
});

test('what each input receives and each output drives reads as the switcher reports it', { skip: SKIP }, async () => {
  const d = dialectFor(link.store);
  const ins = d.inputFormats(link.store);
  assert.deepEqual(ins.map((x) => x.key), readConnectors(link.store, 'input').map((c) => c.key));
  for (const x of [...ins.slice(0, 4), ins.at(-1)]) {
    const sig = (k) => input(x.key, 'plugList', 'items', x.plug, 'status', 'signal', 'pp', k);
    const [plugNow, valid, w, h, rate, name] = await awjGetAll([
      input(x.key, 'status', 'pp', 'plug'), sig('isValid'), sig('formatWidth'), sig('formatHeight'), sig('fieldFrequency'), sig('formatName')
    ]);
    assert.equal(x.plug, String(plugNow), `${x.key} reads the active plug`);
    assert.deepEqual([x.valid, x.width, x.height, x.rate, x.format], [valid === true, w, h, hz(rate), name], x.key);
  }

  const outs = d.outputFormats(link.store);
  for (const o of outs.slice(0, 3)) {
    const [w, h, rate, cw, ch, screen] = await awjGetAll([
      output(o.key, 'status', 'pp', 'sizeH'), output(o.key, 'status', 'pp', 'sizeV'), output(o.key, 'status', 'pp', 'rate'),
      canvas(o.key, 'pitchedWidth'), canvas(o.key, 'pitchedHeight'), canvas(o.key, 'usedInScreenAux')
    ]);
    assert.deepEqual([o.width, o.height, o.rate, o.cw, o.ch, o.screen], [w, h, hz(rate), cw, ch, screen], `output ${o.key}`);
  }
});
