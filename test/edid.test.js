/*
 * The EDID builder: the bank and the custom format library as the store has
 * them, the write the vendor's upload makes, and the vendored Otter module
 * building EDIDs from custom formats.
 *
 * The store shapes are copied from a LivePremier Simulator 6.2.73 (2026-09-23);
 * the M15 / M16 formats are the two the plugin was verified with there — one a
 * CTA raster, one a LED-wall raster nobody's table has.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readSlots, readFormats, formatTiming, formatEdidName, savePayload, deleteCommand,
  sameTiming, slotCarrying, slotHolding, firstFree, SAVE_URL
} from '../plugins/edid/bank.js';

const here = dirname(fileURLToPath(import.meta.url));

/* A store over a plain object, as `DeviceStore.get` answers. */
const storeOver = (device) => ({
  ready: true,
  get: (path) => path.reduce((node, k) => (node == null ? undefined : node[k]), { device })
});

const slot = (n, over = {}) => ({
  control: { pp: { label: '', xUpdate: false, xDelete: false } },
  status: { pp: {
    isAvailable: false, isProtected: false, data: new Array(512).fill(0xff), dataSize: '256',
    hashCode: 0, productName: '', prefFormatName: '', ...over
  } }
});

/* The status of a custom format bank entry, as the device resolved it. */
const M15 = {
  baseName: '1920x1080 60Hz', mode: 'FULL', hSync: 44, hSyncPol: true, hBackPorch: 148, hFrontPorch: 88,
  hUtil: 1920, hTotal: 2200, vSync: 5, vSyncPol: true, vBackporch: 36, vFrontPorch: 4, vUtil: 1080,
  vTotal: 1125, rate: 60000, capability: 'DUAL', isValid: true
};
const M16 = {
  baseName: '3000x1000 50Hz', mode: 'FULL', hSync: 32, hSyncPol: true, hBackPorch: 80, hFrontPorch: 48,
  hUtil: 3000, hTotal: 3160, vSync: 5, vSyncPol: false, vBackporch: 20, vFrontPorch: 3, vUtil: 1000,
  vTotal: 1028, rate: 50000, capability: 'DUAL', isValid: true
};
const EMPTY_FORMAT = { ...M15, baseName: '', hUtil: 1024, vUtil: 768, vTotal: 0, isValid: false };

function device({ bank = {}, formats = {} } = {}) {
  const items = { DEFAULT_HDMI_2_0: slot('D', { isAvailable: true, isProtected: true, productName: 'AQL_HDMI' }) };
  for (let n = 1; n <= 100; n++) items[String(n)] = bank[n] || slot(n);
  const fItems = {};
  for (let n = 1; n <= 16; n++) {
    const f = formats[n];
    fItems[String(n)] = {
      control: { pp: { userName: (f && f.userName) || '', xDelete: false } },
      status: { pp: f ? f.status : EMPTY_FORMAT }
    };
  }
  return {
    system: { edid: { bankList: { items } } },
    customFormats: { bankList: { items: fItems } }
  };
}

const filled = (bytes, over = {}) => {
  const data = new Array(512).fill(0xff);
  bytes.forEach((b, i) => { data[i] = b; });
  return slot(0, { isAvailable: true, productName: 'X', dataSize: String(bytes.length), data, ...over });
};

/* ------------------------------------------------------------ the bank */

test('the bank is the hundred numbered slots, not the vendor’s defaults', () => {
  const slots = readSlots(storeOver(device()));
  assert.equal(slots.length, 100);
  assert.deepEqual(slots.slice(0, 2).map((s) => s.label), ['ED1', 'ED2']);
  assert.ok(slots.every((s) => /^\d+$/.test(s.id)), 'DEFAULT_* is not a slot');
  assert.ok(slots.every((s) => s.empty && s.bytes === null));
});

test('a filled slot gives back its EDID without the 0xFF padding', () => {
  const bytes = Array.from({ length: 128 }, (_, i) => i);
  const slots = readSlots(storeOver(device({ bank: { 7: filled(bytes, { productName: 'LEDwall', isProtected: true }) } })));
  const ed7 = slots.find((s) => s.id === '7');
  assert.equal(ed7.name, 'LEDwall');
  assert.equal(ed7.locked, true);
  assert.deepEqual([...ed7.bytes], bytes);
});

test('the save is the vendor’s upload: 512 numbers padded with 0xFF, the length as a string, the slot as a key', () => {
  const body = savePayload('7', new Uint8Array(384).fill(1));
  assert.equal(SAVE_URL, '/api/device/edid/save');
  assert.equal(body.data.length, 512);
  assert.equal(body.data[383], 1);
  assert.equal(body.data[384], 0xff);
  assert.equal(body.dataSize, '384');
  assert.deepEqual(body.edidId, { type: 'EDID_BANK_SLOT', keys: { bankxEdidBankSlotKey: '7' } });
});

test('a save the bank cannot hold is refused before anything is sent', () => {
  assert.throws(() => savePayload('7', new Uint8Array(200)), /200 bytes/);
  assert.throws(() => savePayload('0', new Uint8Array(128)), /no EDID bank slot 0/);
  assert.throws(() => savePayload('101', new Uint8Array(128)), /no EDID bank slot 101/);
  for (const n of [128, 256, 384, 512]) assert.equal(savePayload('1', new Uint8Array(n)).dataSize, String(n));
});

test('emptying a slot is the vendor card’s bin, on the socket', () => {
  assert.deepEqual(deleteCommand('5'), {
    path: ['device', 'system', 'edid', 'bankList', 'items', '5', 'control', 'pp', 'xDelete'], value: true
  });
});

test('the first free slot skips filled and protected ones', () => {
  const slots = readSlots(storeOver(device({ bank: { 1: filled([0]), 2: slot(2, { isProtected: true }) } })));
  assert.equal(firstFree(slots).label, 'ED3');
  assert.equal(firstFree(slots, new Set(['3'])).label, 'ED4');
});

/* ------------------------------------------------- the custom formats */

test('only valid custom formats are read, in M order, named as typed', () => {
  const store = storeOver(device({ formats: {
    16: { status: M16, userName: 'LEDwall' },
    15: { status: M15 }
  } }));
  const formats = readFormats(store);
  assert.deepEqual(formats.map((f) => f.label), ['M15', 'M16']);
  assert.equal(formats[0].name, '1920x1080 60Hz', 'no label typed: the device’s own description');
  assert.equal(formats[1].name, 'LEDwall', 'the label typed on the Formats page, which lives on control');
});

test('a format’s timing: vBackporch’s lower-case p, polarity true is positive, the rate in millihertz', () => {
  const t = formatTiming(M15);
  assert.deepEqual(t, {
    hActive: 1920, hFront: 88, hSync: 44, hBack: 148,
    vActive: 1080, vFront: 4, vSync: 5, vBack: 36,
    interlaced: false, hSyncPositive: true, vSyncPositive: true,
    pixelClockHz: 148_500_000
  });
  assert.equal(formatTiming(M16).vSyncPositive, false);
  assert.equal(formatTiming({ ...M15, rate: 59940 }).pixelClockHz, 148_351_500);
  assert.equal(formatTiming({ ...M15, hUtil: 0 }), null);
  assert.equal(formatTiming({ ...M15, rate: 0 }), null);
});

test('the EDID name says where it came from, in thirteen characters', () => {
  assert.equal(formatEdidName({ label: 'M16', name: 'LEDwall' }, '3000x1000p50'), 'LEDwall');
  assert.equal(formatEdidName({ label: 'M3', name: 'A name far too long' }, '1080p50'), 'M3 1080p50');
  assert.equal(formatEdidName({ label: 'M12', name: '' }, '15360x1200p60'), 'M12');
});

test('a timing is the same mode to within one 10 kHz clock step, and no further', () => {
  const t = formatTiming(M16);
  assert.ok(sameTiming(t, { ...t, pixelClockHz: 162_420_000 }), '162.424 MHz goes into a DTD as 162.42');
  assert.ok(!sameTiming(t, { ...t, pixelClockHz: 162_400_000 }));
  assert.ok(!sameTiming(t, { ...t, vSyncPositive: true }));
  assert.ok(!sameTiming(t, { ...t, hBack: t.hBack + 1 }));
});

/* ------------------------------------------------ the vendored Otter */

const otter = () => import('../src/vendor/otter-edid-embed.js');

test('the vendored Otter builds a custom format’s EDID with the CTA VIC when the raster is one', async () => {
  const { edidForTiming, describeEdid } = await otter();
  const built = edidForTiming(formatTiming(M15), { name: 'CTA1080' });
  assert.equal(built.vic, 16);
  assert.equal(built.bytes.length, 256, 'a VIC needs the CTA block');
  const back = describeEdid(built.bytes);
  assert.equal(back.name, 'CTA1080');
  assert.deepEqual(back.errors, []);
  assert.ok(sameTiming(back.timing, formatTiming(M15)));
});

test('a raster no table has keeps every porch, as a detailed timing in one block', async () => {
  const { edidForTiming, describeEdid } = await otter();
  const t = formatTiming(M16);
  const built = edidForTiming(t, { name: 'LEDwall' });
  assert.equal(built.vic, undefined);
  assert.equal(built.bytes.length, 128);
  assert.ok(sameTiming(describeEdid(built.bytes).timing, t),
    'what the switcher read back on the simulator: identical porches and polarity, 49.998 Hz');
});

test('a slot counts as carrying a format when its preferred mode is the format, bytes aside', async () => {
  const { edidForTiming, describeEdid } = await otter();
  const t = formatTiming(M16);
  const pristine = edidForTiming(t, { name: 'LEDwall' }).bytes;
  const edited = edidForTiming(t, { name: 'LEDwall edit' }).bytes;
  const slots = readSlots(storeOver(device({ bank: { 2: filled([...edited]) } })));
  assert.equal(slotHolding(slots, pristine), null, 'not the same bytes');
  assert.equal(slotCarrying(slots, t, describeEdid).label, 'ED2', 'but the same mode — auto-fill must leave it be');
  assert.equal(slotCarrying(slots, formatTiming(M15), describeEdid), null);
});

test('the vendored Otter matches upstream', async (t) => {
  const upstream = join(here, '..', '..', 'otter-edid-editor', 'dist-embed', 'otter-edid-embed.js');
  let source;
  try {
    source = await readFile(upstream, 'utf8');
  } catch {
    t.skip('no otter-edid-editor checkout beside this repo (or dist-embed not built)');
    return;
  }
  const copy = await readFile(join(here, '..', 'src', 'vendor', 'otter-edid-embed.js'), 'utf8');
  const hash = createHash('sha256').update(source).digest('hex');
  assert.ok(copy.includes(`sha256:    ${hash}`),
    'src/vendor/otter-edid-embed.js has drifted — run: npm run sync:otter-edid');
});
