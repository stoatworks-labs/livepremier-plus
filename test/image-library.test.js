/*
 * Image Library tools: the zip reader, the plans (what a delete takes and
 * keeps, where an upload goes, what a capacity change offers and warns of),
 * the runs against a stand-in switcher, and the controls in the vendor's
 * pages.
 *
 * The stand-in behaves as the LivePremier Simulator 6.2.73 did on 2026-10-20:
 * a library delete empties every still showing the slot; an upload into a
 * slot a still points at shows on that still; a capacity check takes the
 * stills after a larger one out of service (4K takes one, 5K three); an
 * apply makes the staged side current.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { DeviceStore } from '../src/core/device-store.js';
import { crc32, zipStore, listZip, readEntry } from '../src/core/zip.js';
import { readStills, readLibrary, capacityChoices, libraryUsers } from '../src/core/stills.js';
import {
  planDelete, deleteQuestion, slotList, zipPictures, loosePictures, placeUploads, uploadSlots, uploadQuestion,
  capacityView, planCapacity, capacityQuestion, stillsOnBus, naturalCompare
} from '../plugins/image-library/core.js';
import { deleteSlots, uploadPictures, changeCapacity } from '../plugins/image-library/run.js';
import { install } from './helpers/fake-dom.js';

/* ----------------------------------------------------------- zips by hand */

const enc = new TextEncoder();

/**
 * A zip as other tools write them: each entry stored or deflated, with the
 * flags, the zip64 extra field and a lying size available to a test.
 */
function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = typeof e.data === 'string' ? enc.encode(e.data) : (e.data || new Uint8Array());
    const method = e.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const crc = e.crc ?? crc32(data);
    const size = e.size ?? data.length;
    const flags = (e.encrypted ? 1 : 0) | 0x0800;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    /* zip64: the 32-bit sizes say "see the extra field", which holds them. */
    const extra = e.zip64 ? new Uint8Array(4 + 16) : new Uint8Array(0);
    if (e.zip64) {
      const xv = new DataView(extra.buffer);
      xv.setUint16(0, 0x0001, true);
      xv.setUint16(2, 16, true);
      xv.setBigUint64(4, BigInt(size), true);
      xv.setBigUint64(12, BigInt(body.length), true);
    }
    const cen = new Uint8Array(46 + name.length + extra.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 45, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.zip64 ? 0xffffffff : body.length, true);
    cv.setUint32(24, e.zip64 ? 0xffffffff : size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, extra.length, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    cen.set(extra, 46 + name.length);
    parts.push(local, body);
    central.push(cen);
    offset += local.length + body.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22 + 7);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 7, true);
  end.set(enc.encode('comment'), 22);
  const out = new Uint8Array(offset + size + end.length);
  let at = 0;
  for (const p of [...parts, ...central, end]) { out.set(p, at); at += p.length; }
  return out;
}

const png = (n) => { const b = new Uint8Array(200 + n); b.set([137, 80, 78, 71]); for (let i = 4; i < b.length; i++) b[i] = (i * 7 + n) & 0xff; return b; };

test('zip reader: deflated and stored entries, a comment, zip64 sizes — each checked against its CRC', async () => {
  const bytes = makeZip([
    { name: 'show/', data: '' , method: 0 },
    { name: 'show/slide 1.png', data: png(1) },
    { name: 'show/slide 2.png', data: png(2), method: 0 },
    { name: 'show/big.png', data: png(3), zip64: true }
  ]);
  const list = listZip(bytes);
  assert.deepEqual(list.map((e) => [e.name, e.dir, e.method]), [['show/', true, 0], ['show/slide 1.png', false, 8], ['show/slide 2.png', false, 0], ['show/big.png', false, 8]]);
  assert.deepEqual(Array.from(await readEntry(bytes, list[1])), Array.from(png(1)));
  assert.deepEqual(Array.from(await readEntry(bytes, list[2])), Array.from(png(2)));
  assert.equal(list[3].size, png(3).length, 'the size out of the zip64 field');
  assert.deepEqual(Array.from(await readEntry(bytes, list[3])), Array.from(png(3)));
});

test('zip reader: what it cannot read says why, and a header that lies about its size is not believed', async () => {
  const bytes = makeZip([
    { name: 'locked.png', data: png(1), encrypted: true },
    { name: 'bzip.png', data: png(2), method: 12 },
    { name: 'damaged.png', data: png(3), crc: 1234 },
    { name: 'liar.png', data: new Uint8Array(100000), size: 10 }
  ]);
  const list = listZip(bytes);
  await assert.rejects(readEntry(bytes, list[0]), /encrypted/);
  await assert.rejects(readEntry(bytes, list[1]), /method 12/);
  await assert.rejects(readEntry(bytes, list[2]), /CRC/);
  await assert.rejects(readEntry(bytes, list[3]), /more than its header says/);
  assert.throws(() => listZip(enc.encode('not a zip at all, just words')), /not a zip/);
});

test('zip reader: reads back what the zip writer writes', async () => {
  const bytes = zipStore([{ name: 'a.png', data: png(9) }]);
  const [entry] = listZip(bytes);
  assert.deepEqual(Array.from(await readEntry(bytes, entry)), Array.from(png(9)));
});

test('a zip’s pictures: in name order, with macOS and Windows litter passed over in silence and the rest with a reason', () => {
  const e = (name, extra = {}) => ({ name, dir: name.endsWith('/'), method: 8, encrypted: false, size: 500, ...extra });
  const { take, skipped } = zipPictures([
    e('show/'), e('show/slide 10.png'), e('show/slide 2.PNG'), e('show/slide 1.jpg'),
    e('__MACOSX/show/._slide 1.jpg'), e('show/.DS_Store'), e('show/Thumbs.db'),
    e('show/notes.txt'), e('show/old.bmp'), e('show/secret.png', { encrypted: true }),
    e('show/huge.tif', { size: 2e8 }), e('show/empty.gif', { size: 0 }), e('show/README')
  ], { types: ['png', 'jpg', 'jpeg', 'gif', 'tif', 'tiff'], maxBytes: 157286400 });
  assert.deepEqual(take.map((t) => t.name), ['slide 1.jpg', 'slide 2.PNG', 'slide 10.png']);
  assert.deepEqual(skipped.map((s) => s.name), ['show/notes.txt', 'show/old.bmp', 'show/secret.png', 'show/huge.tif', 'show/empty.gif', 'show/README']);
  assert.match(skipped[0].why, /does not take \.txt/);
  assert.match(skipped[3].why, /200\.0 MB, over the switcher’s 157\.3 MB a file/);
  assert.equal(naturalCompare('slide 9', 'slide 10') < 0, true);
  const loose = loosePictures([{ name: 'a.png', size: 5 }, { name: 'b.psd', size: 5 }], { types: ['png'], maxBytes: 100 });
  assert.deepEqual([loose.take.map((f) => f.name), loose.skipped.map((f) => f.name)], [['a.png'], ['b.psd']]);
});

/* ------------------------------------------------------ a switcher's state */

const FORMATS = ['HDTV_720P', 'HDTV_1080P', 'UHDTV_2160P', 'CINEMA_4K', 'COMPUTER_5120_2880_RB', 'COMPUTER_16384_1080_RB'];
const CAP_OF = { HDTV_720P: 'DUAL', HDTV_1080P: 'DUAL', UHDTV_2160P: '4K', CINEMA_4K: '4K', COMPUTER_5120_2880_RB: '5K', COMPUTER_16384_1080_RB: '5K' };
const UNITS = { DUAL: 1, '4K': 2, '5K': 4 };

/**
 * A LivePremier's library and stills, as much of them as these tools read.
 * `slots` fills library slots (of 12): `{ 3: { file, w, h, cap } }`;
 * `stills` sets stills (of 8): `{ 1: { mode, source, program, preview, cap, global, label } }`.
 */
function libStore({ slots = {}, stills = {}, staged = false, maxKB = 972800, sizeKB = 0, sets = null } = {}) {
  const lib = {};
  for (let n = 1; n <= 12; n++) {
    const s = slots[n];
    lib[n] = {
      control: { pp: { xDelete: false } },
      status: { pp: s
        ? { isValid: true, isUsed: false, fileName: s.file, width: s.w || 1920, height: s.h || 1080, capability: s.cap || 'DUAL', fileSize: s.size || 1000 }
        : { isValid: false, isUsed: false, fileName: '', width: 0, height: 0, capability: 'DUAL', fileSize: 0 } }
    };
  }
  const items = {};
  const current = {};
  const next = {};
  for (let n = 1; n <= 8; n++) {
    const s = stills[n] || {};
    const picture = s.mode === 'IMAGE' && slots[s.source];
    items[n] = {
      control: { pp: { label: s.label || '', mode: s.mode || 'NONE', source: s.source ?? 1, rescale: 'NO_RESCALE' } },
      status: { pp: {
        isAvailable: true, isValid: Boolean(picture), isUsed: false, isOnProgram: Boolean(s.program), isOnPreview: Boolean(s.preview),
        capability: s.cap || 'DUAL', outOfCapability: false
      } },
      mapping: { pp: { isValid: true, device: 1 } }
    };
    current[n] = { status: { pp: { global: s.global || 'USED', capability: s.cap || 'DUAL' } } };
    next[n] = {
      control: { helper: { pp: { format: s.format || 'HDTV_1080P' } } },
      status: { pp: { global: s.global || 'USED', capability: s.cap || 'DUAL' }, helper: { pp: { formatValidity: FORMATS } } }
    };
  }
  const store = new DeviceStore();
  store.hydrate({
    device: {
      stillList: {
        itemKeys: Object.keys(items),
        items,
        library: {
          bankList: { itemKeys: Object.keys(lib), items: lib, status: { pp: { size: sizeKB, maxSize: maxKB } } },
          import: { status: { pp: { fileTypeValidity: ['JPEG', 'JPG', 'PNG', 'GIF', 'TIFF', 'TIF'], maxFileSize: 157286400 } } }
        }
      },
      preconfig: {
        stills: {
          current: { stillList: { items: current } },
          new: { stillList: { items: next }, status: { pp: { hasChanged: staged, error: false } }, control: { pp: { xCheck: true, xApply: true, xCopyFromCurrent: true } } }
        },
        backgrounds: sets || { screenList: { items: {} }, stillList: { items: {} } }
      }
    }
  });
  return store;
}

/* ----------------------------------------------------------- the delete */

test('a delete keeps a picture a still on a bus shows, and names the stills that go empty', () => {
  const store = libStore({
    slots: { 1: { file: 'a.png' }, 2: { file: 'b.png' }, 3: { file: 'c.png' }, 4: { file: 'd.png' } },
    stills: { 1: { mode: 'IMAGE', source: 2, label: 'Logo' }, 2: { mode: 'IMAGE', source: 3, preview: true }, 3: { mode: 'IMAGE', source: 4, program: true } }
  });
  const plan = planDelete(store, [4, 1, 2, 3, 3, 9]);
  assert.deepEqual(plan.remove, [1, 2]);
  assert.deepEqual(plan.kept.map((k) => [k.slot, k.why]), [[3, 'Image 2 shows it on preview'], [4, 'Image 3 shows it on program']]);
  assert.deepEqual(plan.emptied, [{ still: '1', name: 'Image 1 “Logo”', slot: 2 }]);
  assert.deepEqual(plan.missing, [9]);
  const q = deleteQuestion(plan, { all: true });
  assert.match(q.text, /^Delete all 2 images in the switcher’s image library\?/);
  assert.match(q.text, /Image 1 “Logo” shows some of them and will go empty\./);
  assert.match(q.text, /Kept, because a still on a bus shows them: slot 3 \(Image 2 shows it on preview\); slot 4 \(Image 3 shows it on program\)\./);
  assert.match(q.text, /no undo/);
  assert.match(deleteQuestion(planDelete(store, [1]), {}).text, /^Delete 1 image from the switcher’s image library \(1\)\?/);
});

test('a delete with nothing to take says why instead of asking', () => {
  const store = libStore({ slots: { 4: { file: 'd.png' } }, stills: { 3: { mode: 'IMAGE', source: 4, program: true } } });
  const q = deleteQuestion(planDelete(store, [4]), { all: true });
  assert.equal(q.text, null);
  assert.match(q.why, /1 picture is on a bus — slot 4 \(Image 3 shows it on program\)/);
  assert.match(deleteQuestion(planDelete(libStore(), [1, 2]), {}).why, /library is empty/);
});

test('a still a background set puts on a bus counts as on it, whatever its own tally says', () => {
  const sets = {
    screenList: { items: { S1: { backgroundSetList: { items: { 1: {
      pp: { label: 'Act 1' }, status: { pp: { isOnProgram: true, isOnPreview: false } },
      outputList: { items: { 1: { control: { pp: { content: 'STILL_5' } } } } }
    } } } } } },
    stillList: { items: {} }
  };
  const store = libStore({ slots: { 7: { file: 'bg.png' } }, stills: { 5: { mode: 'IMAGE', source: 7 } }, sets });
  assert.equal(stillsOnBus(store).get('5'), 'program');
  assert.deepEqual(planDelete(store, [7]).remove, []);
});

test('slots as ranges', () => {
  assert.equal(slotList([9, 1, 2, 3, 7, 10]), '1–3, 7, 9–10');
});

/* ----------------------------------------------------------- the upload */

test('an upload never refills a slot a still on a bus points at, and uses one another still points at last', () => {
  /* Slots 1 and 2 are empty, but stills point at them: Image 1 off air,
     Image 2 on preview. Slot 3 holds a picture. */
  const store = libStore({
    slots: { 3: { file: 'kept.png' } },
    stills: { 1: { mode: 'IMAGE', source: 1 }, 2: { mode: 'IMAGE', source: 2, preview: true } }
  });
  const order = uploadSlots(store);
  assert.deepEqual(order.slice(0, 3).map((s) => s.slot), [4, 5, 6]);
  assert.ok(!order.some((s) => s.slot === 2), 'never the slot a still on preview points at');
  assert.deepEqual(order.at(-1), { slot: 1, stills: ['Image 1'] });
  const files = Array.from({ length: 11 }, (_, i) => ({ name: `p${i + 1}.png`, size: 10 }));
  const { placed, noRoom } = placeUploads(store, files);
  assert.deepEqual(placed.map((p) => p.slot), [4, 5, 6, 7, 8, 9, 10, 11, 12, 1]);
  assert.deepEqual(noRoom, [{ name: 'p11.png', why: 'no free slot left' }]);
  const q = uploadQuestion({ placed, noRoom, skipped: [] });
  assert.match(q, /Upload 10 pictures into slots 1, 4–12\?/);
  assert.match(q, /Image 1 points at empty slot 1: that still shows the picture put there/);
  assert.match(q, /No room for 1 more: p11\.png \(no free slot left\)/);
});

test('an upload stops at the library’s room, and asks nothing when everything fits clean', () => {
  const store = libStore({ maxKB: 1000, sizeKB: 990 });
  const { placed, noRoom } = placeUploads(store, [{ name: 'a.png', size: 6000 }, { name: 'b.png', size: 6000 }]);
  assert.deepEqual(placed.map((p) => [p.file.name, p.slot]), [['a.png', 1]]);
  assert.match(noRoom[0].why, /the library has 4 kB left/);
  const fits = placeUploads(libStore(), [{ name: 'a.png', size: 10 }]);
  assert.equal(uploadQuestion({ ...fits, skipped: [] }), null);
});

/* --------------------------------------------------------- the capacity */

test('the capacity dropdown offers the capacities the switcher’s formats reach, and says when it cannot be used', () => {
  assert.deepEqual(capacityChoices(FORMATS).map((c) => [c.capability, c.units, c.format]),
    [['DUAL', 1, 'HDTV_1080P'], ['4K', 2, 'UHDTV_2160P'], ['5K', 4, 'COMPUTER_5120_2880_RB']]);
  assert.deepEqual(capacityChoices(['HDTV_1080P']).map((c) => c.capability), ['DUAL']);
  const store = libStore({ stills: { 1: { cap: '4K', format: 'UHDTV_2160P' }, 2: { global: 'DISABLE' }, 3: { program: true } } });
  assert.deepEqual(capacityView(store, '1'), { key: '1', current: '4K', choices: capacityChoices(FORMATS), disabled: null });
  assert.match(capacityView(store, '2').disabled, /Out of service/);
  assert.equal(capacityView(store, '2').current, 'OFF');
  assert.match(capacityView(store, '3').disabled, /On program/);
  assert.equal(capacityView(store, '99'), null);
  assert.match(capacityView(libStore({ staged: true }), '1').disabled, /Preconfig ▸ Images has changes waiting/);
});

test('a capacity below what the picture needs, or a still on preview, is warned of', () => {
  const store = libStore({
    slots: { 6: { file: 'big4k.png', w: 3840, h: 2160, cap: '4K' } },
    stills: { 3: { mode: 'IMAGE', source: 6, cap: '4K', format: 'UHDTV_2160P', preview: true } }
  });
  const plan = planCapacity(store, '3', 'DUAL');
  assert.equal(plan.error, null);
  assert.deepEqual(plan.change, { still: '3', format: 'HDTV_1080P', to: 'DUAL', from: '4K', before: 'UHDTV_2160P' });
  assert.deepEqual(plan.warnings, [
    'Image 3 is on preview.',
    'Its picture (big4k.png, 3840 × 2160) needs 4K: at Dual the switcher will mark it out of capacity.'
  ]);
  const q = capacityQuestion(plan, { lost: [], regained: ['4'] });
  assert.match(q, /^Image 3: 4K → Dual\?/);
  assert.match(q, /Image 4 comes back into service\./);
  assert.match(q, /This applies Preconfig ▸ Images now\.$/);
  assert.equal(planCapacity(store, '3', '4K').change, null, 'the capacity it has is no change');
  assert.match(planCapacity(store, '3', '8K').error, /not a capacity this still can be asked for/);
});

/* ------------------------------------------------- a stand-in switcher */

/**
 * The switcher, as the LivePremier Simulator 6.2.73 behaved: a write that
 * changes something comes back inbound a tick later; the bin empties a slot
 * and every still showing it; an upload fills a slot and any still pointing
 * at it; the capacity check stages what the formats ask for and takes the
 * stills after a larger one out of service; the apply makes it current.
 */
function standIn(store, { refuse = () => false, fail = () => null } = {}) {
  const session = new EventTarget();
  session.store = store;
  const log = [];
  const report = (path, value) => {
    const changed = !Object.is(store.get(path), value);
    store.set(path, value);
    if (changed) session.dispatchEvent(new CustomEvent('frame', { detail: { path, value, dir: 'in' } }));
  };
  const D = (...p) => ['device', ...p];
  const pre = (...p) => D('preconfig', 'stills', ...p);
  const stillsShowing = (slot) => Object.entries(store.get(D('stillList', 'items')) || {})
    .filter(([, v]) => v.control.pp.mode === 'IMAGE' && v.control.pp.source === slot).map(([k]) => k);
  function check() {
    let blockedUntil = 0;
    for (let n = 1; n <= 8; n++) {
      const format = store.get(pre('new', 'stillList', 'items', String(n), 'control', 'helper', 'pp', 'format'));
      const cap = CAP_OF[format] || 'DUAL';
      if (n <= blockedUntil) { report(pre('new', 'stillList', 'items', String(n), 'status', 'pp', 'global'), 'DISABLE'); continue; }
      report(pre('new', 'stillList', 'items', String(n), 'status', 'pp', 'global'), 'USED');
      report(pre('new', 'stillList', 'items', String(n), 'status', 'pp', 'capability'), cap);
      blockedUntil = n + UNITS[cap] - 1;
    }
    report(pre('new', 'status', 'pp', 'hasChanged'), true);
  }
  function copy(from, to) {
    for (let n = 1; n <= 8; n++) {
      for (const k of ['global', 'capability']) report(pre(to, 'stillList', 'items', String(n), 'status', 'pp', k), store.get(pre(from, 'stillList', 'items', String(n), 'status', 'pp', k)));
    }
  }
  session.send = ({ path, value }) => {
    const p = path.join('/');
    log.push([p, value]);
    setTimeout(() => {
      if (refuse(path, value)) return;
      report(path, value);
      if (value !== true) return;
      const del = /library\/bankList\/items\/(\d+)\/control\/pp\/xDelete$/.exec(p);
      if (del) {
        report(D('stillList', 'library', 'bankList', 'items', del[1], 'status', 'pp', 'isValid'), false);
        for (const k of stillsShowing(Number(del[1]))) report(D('stillList', 'items', k, 'status', 'pp', 'isValid'), false);
      }
      if (p.endsWith('stills/new/control/pp/xCheck')) check();
      if (p.endsWith('stills/new/control/pp/xCopyFromCurrent')) { copy('current', 'new'); report(pre('new', 'status', 'pp', 'hasChanged'), false); }
      if (p.endsWith('stills/new/control/pp/xApply')) { copy('new', 'current'); setTimeout(() => report(pre('new', 'status', 'pp', 'hasChanged'), false), 2); }
    }, 1);
    return true;
  };
  const uploads = [];
  const fetchImpl = async (url, init) => {
    const slot = Number(init.body.get('librarySlot'));
    const file = init.body.get('FILES');
    uploads.push([slot, file.name]);
    const why = fail(file.name);
    if (why) return { ok: true, status: 200, json: async () => ({ [file.name]: why }), text: async () => '' };
    setTimeout(() => {
      report(D('stillList', 'library', 'bankList', 'items', String(slot), 'status', 'pp', 'fileName'), file.name);
      report(D('stillList', 'library', 'bankList', 'items', String(slot), 'status', 'pp', 'isValid'), true);
      for (const k of stillsShowing(slot)) report(D('stillList', 'items', k, 'status', 'pp', 'isValid'), true);
    }, 2);
    return { ok: true, status: 200, json: async () => ({ [file.name]: 'FINISH' }), text: async () => '' };
  };
  return { session, log, uploads, fetchImpl };
}

test('deleting: one slot at a time, each waited for; a slot that went on a bus since the question is kept', async () => {
  const store = libStore({
    slots: { 1: { file: 'a.png' }, 2: { file: 'b.png' }, 3: { file: 'c.png' } },
    stills: { 1: { mode: 'IMAGE', source: 2 }, 2: { mode: 'IMAGE', source: 3 } }
  });
  const { session, log } = standIn(store);
  const plan = planDelete(store, [1, 2, 3]);
  assert.deepEqual(plan.remove, [1, 2, 3]);
  /* A take after the question: Image 2 goes to program. */
  store.set(['device', 'stillList', 'items', '2', 'status', 'pp', 'isOnProgram'], true);
  const steps = [];
  const res = await deleteSlots({ session, slots: plan.remove, onStep: (d, t) => steps.push(`${d}/${t}`) });
  assert.deepEqual(res.deleted, [1, 2]);
  assert.deepEqual(res.kept.map((k) => k.slot), [3]);
  assert.deepEqual(res.failed, []);
  assert.deepEqual(steps, ['0/3', '1/3', '2/3', '3/3']);
  assert.deepEqual(log.map(([p, v]) => [p.split('/').slice(-6).join('/'), v]), [
    ['bankList/items/1/control/pp/xDelete', false], ['bankList/items/1/control/pp/xDelete', true],
    ['bankList/items/2/control/pp/xDelete', false], ['bankList/items/2/control/pp/xDelete', true]
  ]);
  assert.equal(readStills(store).find((s) => s.key === '1').mode, 'IMAGE', 'the emptied still keeps pointing at the slot');
  assert.equal(store.get(['device', 'stillList', 'items', '1', 'status', 'pp', 'isValid']), false, 'and has no picture');
});

test('deleting: a slot the switcher never reports empty is a failure, and Stop stops between slots', async () => {
  const store = libStore({ slots: { 1: { file: 'a.png' }, 2: { file: 'b.png' }, 3: { file: 'c.png' } } });
  const { session } = standIn(store, { refuse: (path) => path.join('/').includes('/items/1/control/pp/xDelete') });
  let n = 0;
  const res = await deleteSlots({ session, slots: [1, 2, 3], ms: 50, stopped: () => n++ >= 2 });
  assert.deepEqual(res.failed.map((f) => f.slot), [1]);
  assert.deepEqual(res.deleted, [2]);
  assert.equal(res.stopped, true);
});

test('uploading: each picture into its slot, read only when its turn comes; a slot taken since is swapped; a refusal does not stop the rest', async () => {
  const store = libStore({ slots: { 2: { file: 'x.png' } } });
  const { session, uploads, fetchImpl } = standIn(store, { fail: (name) => (name === 'bad.png' ? 'ERROR_INVALID_FILE' : null) });
  const reads = [];
  const item = (name, slot) => ({ name, slot, read: async () => { reads.push(name); return new Blob([png(1)], { type: 'image/png' }); } });
  const { placed } = placeUploads(store, [{ name: 'a.png', size: 1 }, { name: 'bad.png', size: 1 }, { name: 'c.png', size: 1 }]);
  assert.deepEqual(placed.map((p) => p.slot), [1, 3, 4]);
  /* Slot 3 is filled from elsewhere before the run gets there. */
  store.set(['device', 'stillList', 'library', 'bankList', 'items', '3', 'status', 'pp', 'isValid'], true);
  const res = await uploadPictures({ session, fetchImpl, items: placed.map((p) => item(p.file.name, p.slot)) });
  assert.deepEqual(uploads, [[1, 'a.png'], [5, 'bad.png'], [4, 'c.png']]);
  assert.deepEqual(res.uploaded, [{ slot: 1, name: 'a.png' }, { slot: 4, name: 'c.png' }]);
  assert.match(res.failed[0].why, /did not import bad\.png: ERROR_INVALID_FILE/);
  assert.deepEqual(reads, ['a.png', 'bad.png', 'c.png']);
  assert.deepEqual(readLibrary(store).slots.filter((s) => !s.free).map((s) => s.slot), [1, 2, 3, 4]);
});

test('a capacity: staged, checked, asked about in the switcher’s words, then applied', async () => {
  const store = libStore({ stills: { 3: { label: 'Map' } } });
  const { session, log } = standIn(store);
  const asked = [];
  const res = await changeCapacity({ session, still: '3', to: '4K', ask: async (t) => { asked.push(t); return true; } });
  assert.deepEqual(res, { ok: true, changed: true });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^Image 3 “Map”: Dual → 4K\?\n\nThe switcher takes Image 4 out of service for it \(it is empty\)\./);
  assert.equal(store.get(['device', 'preconfig', 'stills', 'current', 'stillList', 'items', '3', 'status', 'pp', 'capability']), '4K');
  assert.equal(store.get(['device', 'preconfig', 'stills', 'current', 'stillList', 'items', '4', 'status', 'pp', 'global']), 'DISABLE');
  const writes = log.map(([p, v]) => `${p.split('/').at(-1)}=${v}`);
  assert.deepEqual(writes, ['xCopyFromCurrent=false', 'xCopyFromCurrent=true', 'format=UHDTV_2160P', 'xCheck=false', 'xCheck=true', 'xApply=false', 'xApply=true']);
});

test('a capacity: Cancel puts the staged side back and applies nothing', async () => {
  const store = libStore();
  const { session, log } = standIn(store);
  const res = await changeCapacity({ session, still: '1', to: '5K', ask: async (t) => { assert.match(t, /takes Image 2, Image 3 and Image 4 out of service/); return false; } });
  assert.deepEqual(res, { ok: true, changed: false, cancelled: true });
  assert.ok(!log.some(([p]) => p.endsWith('xApply')));
  assert.equal(log.at(-1)[0].split('/').at(-1), 'xCopyFromCurrent');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.get(['device', 'preconfig', 'stills', 'new', 'status', 'pp', 'hasChanged']), false);
  assert.equal(store.get(['device', 'preconfig', 'stills', 'current', 'stillList', 'items', '1', 'status', 'pp', 'capability']), 'DUAL');
});

test('a capacity that would take a still holding a picture out of service is refused before anything is asked or applied', async () => {
  const store = libStore({ slots: { 1: { file: 'a.png' } }, stills: { 2: { mode: 'IMAGE', source: 1 } } });
  const { session, log } = standIn(store);
  let asked = false;
  const res = await changeCapacity({ session, still: '1', to: '4K', ask: async () => { asked = true; return true; } });
  assert.equal(res.ok, false);
  assert.match(res.error, /would take still 2 out of service, and it holds something — refused/);
  assert.equal(asked, false);
  assert.ok(!log.some(([p]) => p.endsWith('xApply')));
});

test('who shows what: a still points at a slot by mode and source', () => {
  const store = libStore({ slots: { 1: { file: 'a.png' } }, stills: { 1: { mode: 'IMAGE', source: 1 }, 2: { mode: 'NONE', source: 1 }, 3: { mode: 'IMAGE', source: 1 } } });
  assert.deepEqual(libraryUsers(store).get(1).map((s) => s.key), ['1', '3']);
});

/* ------------------------------------------------------------- the pages */

/** The Image Library page as Web RCS 6.2.73 draws it, cut down to what is matched. */
function libraryPage(doc, filled) {
  const panel = doc.createElement('div');
  const header = doc.createElement('div');
  header.className = 'aw-header aw-relative aw-header--huge';
  const title = doc.createElement('div');
  title.className = 'aw-header__items';
  const h1 = doc.createElement('h1');
  h1.textContent = 'Image Library';
  title.append(h1);
  header.append(title);
  const grid = doc.createElement('div');
  grid.className = 'aw-grid aw-cols-4 aw-gap-col-big';
  for (let n = 1; n <= 6; n++) {
    const wrap = doc.createElement('div');
    wrap.className = 'aw-min-width-0';
    if (filled.includes(n)) {
      const card = doc.createElement('div');
      card.className = 'aw-card aw-card--fluid';
      const ch = doc.createElement('div');
      ch.className = 'aw-header';
      const items = doc.createElement('div');
      items.className = 'aw-header__items';
      const num = doc.createElement('div');
      num.className = 'aw-font-bold';
      num.textContent = String(n);
      items.append(num);
      ch.append(items);
      const content = doc.createElement('div');
      content.className = 'aw-card__content aw-relative';
      card.append(ch, content);
      wrap.append(card);
    }
    grid.append(wrap);
  }
  panel.append(header, grid);
  doc.body.append(panel);
  return { header, grid };
}

/** The Images page: one card per still, the number and the tools in the footer header. */
function imagesPage(doc, keys) {
  const list = doc.createElement('div');
  for (const k of keys) {
    const card = doc.createElement('div');
    card.className = 'aw-card';
    const header = doc.createElement('div');
    header.className = 'aw-header';
    const items = doc.createElement('div');
    items.className = 'aw-header__items';
    const num = doc.createElement('div');
    num.className = 'aw-padding-left-medium';
    num.textContent = String(k);
    items.append(num);
    const tools = doc.createElement('div');
    tools.className = 'aw-header__items aw-margin-left-auto';
    tools.append(doc.createElement('div'));
    header.append(items, tools);
    card.append(header);
    list.append(card);
  }
  doc.body.append(list);
  return list;
}

async function withDom(fn) {
  const dom = install();
  try { await fn(dom); } finally { dom.uninstall(); }
}

test('the Image Library page gets a toolbar; Select puts a tick on each filled card, a click and a shift-click pick, Done clears', async () => {
  await withDom(async ({ doc }) => {
    const { installLibraryTools } = await import('../plugins/image-library/decorate.js');
    const { header, grid } = libraryPage(doc, [2, 3, 5]);
    const calls = [];
    const loc = { pathname: '/image-library' };
    const tools = installLibraryTools({
      enabled: () => true, doc, loc,
      actions: {
        filled: () => [2, 3, 5], status: () => ({ busy: false, text: '' }),
        deleteSlots: async (slots, o) => { calls.push(['delete', slots, o.all]); return true; },
        upload: async (files) => { calls.push(['upload', files.map((f) => f.name)]); },
        stop() {}, capacity: () => null, capacityBusy: () => null, setCapacity: async () => {}
      }
    });
    tools.sweepNow();
    const bar = header.querySelector('[data-lpp-library-tools]');
    assert.ok(bar, 'the toolbar is on the end of the page header');
    const buttons = () => bar.querySelectorAll('button').map((b) => b.textContent);
    assert.deepEqual(buttons(), ['Select', 'Delete all', 'Upload .zip']);
    bar.querySelectorAll('button')[1].click();
    assert.deepEqual(calls[0], ['delete', [2, 3, 5], true]);

    bar.querySelectorAll('button')[0].click();
    tools.sweepNow();
    assert.deepEqual(buttons(), ['All', 'None', 'Delete selected', 'Done']);
    const picks = () => grid.querySelectorAll('[data-lpp-pick]');
    assert.deepEqual(picks().map((p) => p.getAttribute('data-lpp-pick')), ['2', '3', '5']);
    assert.ok(grid.hasAttribute('data-lpp-selecting'));
    picks()[0].dispatchEvent({ type: 'click' });
    tools.sweepNow();
    picks()[2].dispatchEvent({ type: 'click', shiftKey: true });
    tools.sweepNow();
    assert.deepEqual(tools.selection().selected, [2, 3, 5]);
    assert.deepEqual(picks().map((p) => p.classList.contains('is-on')), [true, true, true]);
    picks()[1].dispatchEvent({ type: 'click' });
    tools.sweepNow();
    assert.deepEqual(tools.selection().selected, [2, 5]);

    /* A settled sweep changes nothing: the same nodes, no rebuild. */
    const before = [bar.querySelector('[data-lpp-bar-body]').firstElementChild, ...picks()];
    tools.sweepNow();
    assert.deepEqual([bar.querySelector('[data-lpp-bar-body]').firstElementChild, ...picks()], before);

    bar.querySelectorAll('button').find((b) => b.textContent === 'Delete selected').click();
    assert.deepEqual(calls[1], ['delete', [2, 5], false]);
    bar.querySelectorAll('button').find((b) => b.textContent === 'Done').click();
    tools.sweepNow();
    assert.equal(picks().length, 0);
    assert.equal(grid.hasAttribute('data-lpp-selecting'), false);
    assert.deepEqual(tools.selection(), { selecting: false, selected: [] });

    /* Away from the page, nothing of ours stays. */
    loc.pathname = '/images/all';
    tools.sweepNow();
    assert.equal(doc.querySelector('[data-lpp-library-tools]'), null);
    tools.stop();
  });
});

test('a drop on the Image Library page that carries a zip is ours; one without is left for the vendor', async () => {
  await withDom(async ({ doc }) => {
    const { installLibraryTools } = await import('../plugins/image-library/decorate.js');
    libraryPage(doc, []);
    const uploads = [];
    const tools = installLibraryTools({
      enabled: () => true, doc, loc: { pathname: '/image-library' },
      actions: {
        filled: () => [], status: () => ({ busy: false }), deleteSlots: async () => {}, upload: async (f) => { uploads.push(f.map((x) => x.name)); },
        stop() {}, capacity: () => null, capacityBusy: () => null, setCapacity: async () => {}
      }
    });
    const drop = (files) => {
      const ev = { dataTransfer: { files }, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      tools.handlers.onDrop(ev);
      return ev;
    };
    const plain = drop([{ name: 'a.png', type: 'image/png' }]);
    assert.deepEqual([plain.prevented, plain.stopped, uploads.length], [false, false, 0]);
    const zipped = drop([{ name: 'show.zip', type: 'application/zip' }, { name: 'extra.png', type: 'image/png' }]);
    assert.deepEqual([zipped.prevented, zipped.stopped], [true, true]);
    assert.deepEqual(uploads, [['show.zip', 'extra.png']]);
    const over = { dataTransfer: { items: [{ kind: 'file', type: 'application/x-zip-compressed' }] }, prevented: false, preventDefault() { this.prevented = true; } };
    tools.handlers.onDragOver(over);
    assert.equal(over.prevented, true);
    tools.stop();
  });
});

test('the Images page gets a capacity dropdown on each still’s card, drawn from the view and calling for a change', async () => {
  await withDom(async ({ doc }) => {
    const { installLibraryTools } = await import('../plugins/image-library/decorate.js');
    const list = imagesPage(doc, [1, 2, 3]);
    const store = libStore({ stills: { 2: { global: 'DISABLE' } } });
    const changes = [];
    const tools = installLibraryTools({
      enabled: () => true, doc, loc: { pathname: '/images/all' },
      actions: {
        filled: () => [], status: () => ({ busy: false }), deleteSlots: async () => {}, upload: async () => {}, stop() {},
        capacity: (key) => capacityView(store, key), capacityBusy: () => null,
        setCapacity: async (key, to) => { changes.push([key, to]); }
      }
    });
    tools.sweepNow();
    const menus = list.querySelectorAll('select[data-lpp-capacity]');
    assert.deepEqual(menus.map((m) => m.getAttribute('data-lpp-capacity')), ['1', '2', '3']);
    assert.ok(menus.every((m) => m.parentElement.classList.contains('aw-margin-left-auto') && m.parentElement.firstElementChild === m), 'first in the card’s tools');
    assert.deepEqual(menus[0].querySelectorAll('option').map((o) => o.textContent), ['1 · Dual', '2 · 4K', '4 · 5K']);
    assert.equal(menus[0].disabled, false);
    assert.equal(menus[1].disabled, true);
    assert.match(menus[1].title, /Out of service/);
    assert.deepEqual(menus[1].querySelectorAll('option').map((o) => o.textContent), ['0 · Off']);
    menus[0].value = '4K';
    menus[0].dispatchEvent({ type: 'change' });
    assert.deepEqual(changes, [['1', '4K']]);
    assert.deepEqual(tools.describe(), { bar: false, cards: 0, picks: 0, stills: 3, dropdowns: 3 });
    tools.stop();
    assert.equal(list.querySelectorAll('select[data-lpp-capacity]').length, 0);
  });
});
