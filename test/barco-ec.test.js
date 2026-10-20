/*
 * The Barco EC panel, end to end, with no panel: its bytes against Barco's own
 * button map and ec50-panel's captures, both USB roads against stand-ins, the
 * driver against a pretend panel that keeps the protocol's rules
 * (`helpers/fake-ec-panel.js`), the device host, the plugin's meaning for
 * every key, and the supervisor writing to a pretend switcher.
 *
 * What none of it can prove is a panel on a desk. docs/BARCO-EC.md says what
 * is still unverified.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import * as P from '../src/core/ec-panel.js';
import { render, layout, normalise, ascii } from '../src/core/ec-font.js';
import { BarcoEcDriver } from '../devices/modules/barco-ec/driver.js';
import barcoModule from '../devices/modules/barco-ec/module.js';
import { libusbBackend, d2xxBackend, loadFtdi } from '../devices/transports/ftdi.js';
import { createHostCore } from '../devices/core.js';
import { createDeviceHost } from '../server/device-host.js';
import { FakeEcPanel, fakeFtdi } from './helpers/fake-ec-panel.js';
import { fakeAwj } from './helpers/fake-awj.js';
import {
  normaliseBarcoEc, barcoEcChanged, DEFAULT_BARCO_EC, initialView, keyIntent, applyView, pageCounts, paint,
  paintCommand, strokeProgress, ROW_KINDS,
} from '../plugins/barco-ec/core.js';
import { BarcoEcSupervisor } from '../plugins/barco-ec/supervisor.js';
import { Selection } from '../src/core/console-intents.js';
import { NLC } from '../src/core/dialect.js';
import { toAwj } from '../src/core/paths.js';
import { labelPath, slotValidPath } from '../server/console-switcher.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await settle(5); }
  return check();
}
const bytes = (u8) => [...u8];
const key = (name) => P.BUTTON_BY_NAME.get(name).index;

/* =============================================================== the bytes */

test('the button table is the Toolset’s own showConsoleMap.csv, row for row', (t) => {
  const installs = existsSync('/Applications')
    ? readdirSync('/Applications').filter((d) => d.startsWith('EventMaster-'))
      .map((d) => join('/Applications', d, 'EventMaster.app/Contents/MacOS/showConsoleMap.csv'))
      .filter((f) => existsSync(f))
    : [];
  if (!installs.length) { t.skip('no Event Master Toolset installed here to compare against'); return; }
  for (const file of installs) {
    const rows = readFileSync(file, 'latin1').split(/\r?\n/).slice(1).filter((l) => l && !l.startsWith(','));
    assert.equal(rows.length, P.BUTTONS.length, `${file}: one entry a row`);
    for (const line of rows) {
      const [name, index, , reg, byteShift, posShift, lcd, type] = line.split(',');
      const b = P.BUTTON_BY_INDEX.get(Number(index));
      assert.ok(b, `${name} (${index}) is in the table`);
      assert.equal(b.name, name);
      const r = Number.parseInt(reg, 16);
      assert.equal(b.reg, r === 0xffff ? null : r, `${name}'s lamp register`);
      if (b.reg !== null) assert.equal(b.bit, Number(byteShift) + Number(posShift), `${name}'s lamp bit`);
      assert.equal(b.lcd, Number(lcd), `${name}'s LCD cell`);
      assert.equal(b.type, Number(type), `${name}'s models`);
    }
  }
});

test('a blank framebuffer is the one ec50-panel captured from the Toolset, but for which keys the Toolset had lit', async () => {
  /* ec50-panel `protocol.py` _BASE_B64 (MIT): every cell's pixels blanked, the
     header and both colour tables left as captured. Its first colour table is
     the Toolset's own state at that moment — 0xFF on the seven keys it had
     labelled, 0x57 (its blank) on the rest — so ours, all blank, differs there
     and only there. */
  const { inflateSync } = await import('node:zlib');
  const captured = inflateSync(Buffer.from('eNrtzyEOACAMA8D9kl/wMCySx4GdnMAsuZNt0qQRcwcAAAAAAAAAAAAAQBOj4CY5y934pLL18/9taJ0HvKcFbg==', 'base64'));
  const ours = P.newBuffer();
  assert.equal(captured.length, P.PAYLOAD_LEN);
  const table = [P.COLOUR_BASE, P.COLOUR_BASE + P.NUM_CELLS * 4];
  const outside = (buf) => [...buf.subarray(0, table[0]), ...buf.subarray(table[1])];
  assert.deepEqual(outside(ours), outside(captured));
  const lit = [];
  for (let cell = 0; cell < P.NUM_CELLS; cell++) {
    const v = captured.subarray(P.COLOUR_BASE + cell * 4, P.COLOUR_BASE + cell * 4 + 4);
    assert.ok(v.every((b) => b === v[0]) && [P.COLOUR.DIM, P.COLOUR.WHITE].includes(v[0]), `cell ${cell} is one of the Toolset's two values`);
    if (v[0] === P.COLOUR.WHITE) lit.push(cell);
    assert.equal(ours[P.COLOUR_BASE + cell * 4 + 3], P.COLOUR.DIM);
  }
  assert.deepEqual(lit, [9, 10, 11, 14, 16, 17, 36]);
});

test('register writes and reads are framed as the protocol notes spell them', () => {
  /* PROTOCOL.md: "39 38 00 03 3F 00 00 00 AA BB  write 0x0000003F to 0x3938" */
  const w = P.writeReg(0x3938, 0x3f);
  const cs = P.CS_ASSERT.length;
  assert.deepEqual(bytes(w.subarray(0, cs)), [...P.CS_ASSERT]);
  assert.deepEqual(bytes(w.subarray(cs, cs + 3)), [0x11, 9, 0]);
  assert.deepEqual(bytes(w.subarray(cs + 3, cs + 13)), [0x39, 0x38, 0x00, 0x03, 0x3f, 0, 0, 0, 0xaa, 0xbb]);
  assert.deepEqual(bytes(w.subarray(cs + 13)), [...P.CS_RELEASE]);
  /* "38 10 80 03 AA BB  read 4 bytes from 0x3810", clocked in and out, then 4 more in. */
  const r = P.readReg(P.REG.KEYS);
  assert.equal(r.replyLength, 10);
  assert.deepEqual(bytes(r.bytes.subarray(cs, cs + 9)), [0x31, 5, 0, 0x38, 0x10, 0x80, 0x03, 0xaa, 0xbb]);
  assert.deepEqual(bytes(r.bytes.subarray(cs + 9, cs + 12)), [0x20, 3, 0]);
  assert.equal(r.bytes.at(-1), P.SEND_IMMEDIATE);
});

test('a key reply is read for its event and the T-bar; the queue’s idle byte is no key', () => {
  assert.deepEqual(P.parseKeys([0, 0, 0, 0, 0x34, 0x12, 0x80 | 79, 0, 0, 0]), { key: { index: 79, pressed: true }, tbar: 0x1234 });
  assert.deepEqual(P.parseKeys([0, 0, 0, 0, 0, 0, 79, 0, 0, 0]).key, { index: 79, pressed: false });
  assert.equal(P.parseKeys([0, 0, 0, 0, 0, 0, 0xff, 0, 0, 0]).key, null);
  assert.equal(P.tbarFraction(P.TBAR_MIN), 0);
  assert.equal(P.tbarFraction(P.TBAR_MAX), 1);
  assert.equal(P.tbarFraction(0), 0, 'clamped below the measured travel');
});

test('lamps land on their two bits, and a key with no lamp is skipped', () => {
  const regs = P.ledRegisters(new Map([[key('ASSIGN_1_0'), P.LED.GREEN], [key('ASSIGN_1_3'), P.LED.RED], [key('DEST_UP'), P.LED.GREEN]]));
  assert.equal(regs.get(0x3960), ((2 << 24) | (1 << 30)) >>> 0);
  assert.equal(regs.get(0x3950), 0);
});

test('a cell’s right half is stored a row higher, and cell 0 never overwrites the header', () => {
  const buf = P.newBuffer();
  const img = new Uint8Array(P.CELL_SIZE).fill(0);
  img[5 * 8 + 0] = 0xff;   // row 5, left half
  img[5 * 8 + 7] = 0xff;   // row 5, right half
  P.placeCell(buf, 3, img);
  const at = 3 * P.CELL_SIZE;
  assert.equal(buf[at + 5 * 8 + 0], 0xff, 'the left half stays on its row');
  assert.equal(buf[at + 4 * 8 + 7], 0xff, 'the right half moves up one');
  assert.equal(buf[at + 5 * 8 + 7], 0);
  P.placeCell(buf, 0, new Uint8Array(P.CELL_SIZE).fill(0xff));
  assert.deepEqual(bytes(buf.subarray(0, 4)), [...P.FB_HEADER]);
});

/* ================================================================ the font */

test('a label takes the largest size that fits without breaking a word', () => {
  assert.deepEqual(layout('CAM 1'), { lines: ['CAM 1'], scale: 2, lead: 2 });
  assert.equal(layout('Screen 12').scale, 1, 'one line at 1×, not "Scree / n 12" at 2×');
  assert.deepEqual(layout('Wide shot left').lines, ['Wide shot', 'left']);
  assert.equal(normalise('CAMÉRA ✈'), 'CAMERA ▪', 'accents fold; the rest is a square');
  const lit = ascii(render('I')).join('').split('').filter((c) => c === '#').length;
  assert.equal(lit, 11 * 3 * 3, 'the 5×8 I (eleven pixels) drawn at 3×');
});

/* ========================================================== the USB roads */

function fakeUsb({ packet = 512 } = {}) {
  const controls = [];
  const written = [];
  const queue = [];
  const inn = {
    direction: 'in', descriptor: { wMaxPacketSize: packet }, timeout: 0,
    transferAsync: async () => {
      const next = queue.shift();
      if (!next) throw new Error('LIBUSB_TRANSFER_TIMED_OUT');
      return Buffer.from(next);
    },
  };
  const out = { direction: 'out', timeout: 0, transferAsync: async (buf) => { written.push([...buf]); return buf.length; } };
  const iface = {
    endpoints: [out, inn],
    isKernelDriverActive: () => false,
    detachKernelDriver() {},
    claim() { iface.claimed = true; },
    release(a, cb) { iface.claimed = false; (typeof a === 'function' ? a : cb)?.(); },
  };
  const panel = {
    deviceDescriptor: { idVendor: 0x0600, idProduct: 0x0336 },
    busNumber: 1, deviceAddress: 4, portNumbers: [2],
    open() { panel.opened = true; }, close() { panel.opened = false; },
    interface: () => iface,
    controlTransfer(rt, req, value, index, data, cb) { controls.push([rt, req, value, index]); cb(); },
  };
  const other = { deviceDescriptor: { idVendor: 0x05ac, idProduct: 0x1234 } };
  return { mod: { getDeviceList: () => [other, panel] }, controls, written, queue, panel, iface };
}

test('libusb: the panel is found by its id, put in MPSSE mode as libftdi does, and every packet’s two status bytes are dropped', async () => {
  const u = fakeUsb();
  const backend = libusbBackend(u.mod);
  const found = await backend.list({ vid: 0x0600, pid: 0x0336 });
  assert.equal(found.length, 1);
  const dev = await backend.open(found[0]);
  assert.deepEqual(u.controls, [
    [0x40, 0x00, 0, 1],          // reset
    [0x40, 0x09, 1, 1],          // latency 1 ms
    [0x40, 0x0b, 0x0000, 1],     // bit mode reset
    [0x40, 0x0b, 0x0200, 1],     // MPSSE
  ]);
  assert.ok(u.iface.claimed);
  await dev.write([1, 2, 3]);
  assert.deepEqual(u.written, [[1, 2, 3]]);

  /* Status only (nothing yet), then data across two packets, with two bytes too many. */
  u.queue.push([0x32, 0x60]);
  u.queue.push([0x32, 0x60, 1, 2, 3]);
  const two = new Uint8Array(512 + 9);
  two.set([0x32, 0x60], 0);
  two.set(Array.from({ length: 510 }, () => 0xee), 2);
  two.set([0x32, 0x60, 4, 5, 6, 7, 8, 9, 10], 512);
  u.queue.push([...two]);
  const got = await dev.read(5 + 510 + 2);
  assert.deepEqual(bytes(got.subarray(0, 3)), [1, 2, 3]);
  assert.ok(got.subarray(3, 513).every((b) => b === 0xee));
  assert.deepEqual(bytes(got.subarray(513)), [4, 5, 6, 7]);
  assert.deepEqual(bytes(await dev.read(3, 50)), [8, 9, 10], 'the surplus is kept for the next read, not lost');
  await assert.rejects(dev.read(1, 30), /sent 0 of 1/);
  await dev.close();
  assert.equal(u.panel.opened, false);
  assert.deepEqual(u.controls.at(-1), [0x40, 0x0b, 0x0000, 1], 'left in its reset bit mode');
});

test('D2XX through koffi, against a stand-in ftd2xx: only the panel listed, opened into MPSSE, bytes both ways', async (t) => {
  if (process.platform === 'win32') { t.skip('builds a stand-in library with a Unix compiler'); return; }
  let koffi;
  try { koffi = createRequire(join(ROOT, 'devices', 'package.json'))('koffi'); } catch { t.skip('koffi not installed in devices/ (npm run setup:devices)'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'lpp-d2xx-'));
  const lib = join(dir, process.platform === 'darwin' ? 'libftd2xx-mock.dylib' : 'libftd2xx-mock.so');
  try {
    try {
      /* execFile, not a shell: the compiler, never a shell function of the same name. */
      execFileSync('cc', ['-shared', '-fPIC', '-o', lib, join(here, 'fixtures/ftd2xx-mock/ftd2xx-mock.c')], { stdio: 'ignore' });
    } catch { t.skip('no C compiler here to build the stand-in'); return; }
    const backend = d2xxBackend(koffi, lib);
    const found = await backend.list({ vid: 0x0600, pid: 0x0336, descriptions: P.PRODUCT_STRINGS });
    assert.deepEqual(found.map((e) => [e.index, e.serial, e.description, e.busy]), [[1, 'EC50SN', 'EC Show Board', false]]);
    const dev = await backend.open(found[0]);
    const mock = koffi.load(lib);
    assert.equal(mock.func('uint8_t mock_mode(void)')(), 2, 'MPSSE');
    assert.equal(mock.func('uint8_t mock_latency(void)')(), 1);
    await dev.write([1, 2, 3]);
    assert.deepEqual(bytes(await dev.read(3)), [0xfe, 0xfd, 0xfc]);
    await dev.close();
    assert.equal(mock.func('int mock_opened(void)')(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the FTDI road is chosen by platform, and a missing library is a reason, not a crash', async () => {
  const none = async () => { const e = new Error("Cannot find package 'x'"); e.code = 'ERR_MODULE_NOT_FOUND'; throw e; };
  assert.match((await loadFtdi({ platform: 'darwin', importer: none })).reason, /usb is not installed/);
  assert.match((await loadFtdi({ platform: 'win32', importer: none })).reason, /koffi is not installed/);
  const noDll = await loadFtdi({ platform: 'win32', importer: async () => ({ load() { throw new Error('cannot open'); } }) });
  assert.equal(noDll.ftdi, null);
  assert.match(noDll.reason, /ftd2xx\.dll\) did not load/);
  const u = fakeUsb();
  assert.equal((await loadFtdi({ platform: 'linux', importer: async () => u.mod })).ftdi.name, 'libusb');
});

/* ============================================================== the driver */

function driverOn(panels, opts = {}) {
  const d = new BarcoEcDriver({ ftdi: fakeFtdi(panels), scanMs: 10, pollMs: 2, ...opts });
  const reports = [];
  d.on('report', (b) => reports.push(P.readReport(b)));
  return { d, reports };
}

test('the panel is only looked for until wanted; opened, it is set up, its lagging first reply is thrown away, and keys come back', async () => {
  const panel = new FakeEcPanel();
  const { d, reports } = driverOn([panel]);
  d.start();
  try {
    assert.ok(await until(() => d.state.present));
    assert.equal(panel.open, false, 'found, not held');
    await d.want(true);
    assert.ok(await until(() => d.state.connected));
    assert.equal(panel.badCommands, 0, 'every MPSSE byte was one the chip knows');
    for (const [addr, value] of P.INIT_REGS) assert.equal(panel.regs.get(addr), value, `LCD setup ${addr.toString(16)}`);
    await settle(40);
    assert.ok(!reports.some((r) => r.type === 'key'), 'no key from the stale first reply');
    panel.tap(key('ALL_TRANS'));
    assert.ok(await until(() => reports.filter((r) => r.type === 'key').length === 2));
    assert.deepEqual(reports.filter((r) => r.type === 'key'), [
      { type: 'key', index: 79, pressed: true },
      { type: 'key', index: 79, pressed: false },
    ]);
    const tbars = () => reports.filter((r) => r.type === 'tbar').length;
    const before = tbars();
    panel.setTbar(P.TBAR_MIN + 10);
    await settle(30);
    assert.equal(tbars(), before, 'a jitter inside the deadband is not a move');
    panel.setTbar(0x8000);
    assert.ok(await until(() => reports.some((r) => r.type === 'tbar' && r.raw === 0x8000)));
    await d.want(false);
    assert.equal(panel.open, false, 'let go when no longer wanted');
  } finally {
    await d.stop();
  }
});

test('labels and lamps: drawn pixel for pixel, the framebuffer sent twice so neither bank is stale, lamps latched', async () => {
  const panel = new FakeEcPanel();
  const { d } = driverOn([panel]);
  d.start();
  try {
    await d.want(true);
    assert.ok(await until(() => d.state.connected));
    const cell = P.BUTTON_BY_NAME.get('ASSIGN_1_0').lcd;
    const r = await d.command({
      cells: [{ cell, text: 'CAM 1', colour: P.COLOUR.GREEN }],
      leds: [{ index: key('ASSIGN_1_0'), state: P.LED.GREEN }, { index: key('CUT'), state: P.LED.RED }],
    });
    assert.deepEqual(r, { connected: true, pushed: true });
    assert.ok(panel.shown(), 'both banks hold the same frame');
    assert.deepEqual(bytes(panel.cellImage(cell)), bytes(render('CAM 1')));
    assert.equal(panel.colourOf(cell), P.COLOUR.GREEN);
    assert.equal(panel.ledOf(key('ASSIGN_1_0')), P.LED.GREEN);
    assert.equal(panel.ledOf(key('CUT')), P.LED.RED);
    assert.equal(panel.discarded, 0);
    await assert.rejects(d.command({ cells: [{ cell: 45, text: 'x' }] }), /no LCD cell 45/);
    await assert.rejects(d.command({ leds: [{ index: 79, state: 3 }] }), /lamp state/);
  } finally {
    await d.stop();
  }
});

test('the pretend panel keeps the protocol’s rules: one framebuffer pass is a torn panel, and nothing unlatched shows', async () => {
  const panel = new FakeEcPanel();
  const dev = await fakeFtdi([panel]).open({ panel });
  await dev.write(P.SETUP_BYTES);
  await dev.write(P.framebufferFrame(P.newBuffer()));
  await dev.write(P.writeReg(P.REG.COMMIT, P.COMMIT.LCD));
  assert.equal(panel.shown(), null, 'one bank only');
  await dev.write(P.writeReg(0x3950, 0xffffffff));
  assert.equal(panel.ledOf(key('DEST_0')), 0, 'written, not latched');
  const zeroed = P.newBuffer();
  zeroed.fill(0, 0, 4);
  await dev.write(P.framebufferFrame(zeroed));
  assert.equal(panel.discarded, 1, 'a zeroed header is discarded whole');
});

test('a panel the Toolset holds is reported busy and left alone, and taken once it is free', async () => {
  const panel = new FakeEcPanel({ busy: true });
  const said = [];
  const { d } = driverOn([panel], { log: (t) => said.push(t) });
  d.start();
  try {
    await d.want(true);
    assert.ok(await until(() => d.state.busy));
    assert.equal(d.state.connected, false);
    panel.busy = false;
    assert.ok(await until(() => d.state.connected));
  } finally {
    await d.stop();
  }
});

test('unplugged, it is let go and looked for; plugged back in, it is painted again from the copy kept', async () => {
  const panel = new FakeEcPanel();
  const { d, reports } = driverOn([panel]);
  d.start();
  try {
    await d.want(true);
    assert.ok(await until(() => d.state.connected));
    const cell = P.BUTTON_BY_NAME.get('ASSIGN_2_0').lcd;
    await d.command({ cells: [{ cell, text: 'Opener', colour: P.COLOUR.YELLOW }] });
    panel.press(key('CUT'));
    assert.ok(await until(() => d.state.held.includes(key('CUT'))));
    panel.unplug();
    assert.ok(await until(() => !d.state.connected));
    assert.ok(reports.some((r) => r.type === 'key' && r.index === key('CUT') && !r.pressed), 'a key held when it went is released');
    const fresh = new FakeEcPanel();
    Object.assign(panel, { plugged: true, banks: fresh.banks, leds: fresh.leds, fifo: [] });
    assert.ok(await until(() => d.state.connected));
    assert.ok(await until(() => panel.shown()));
    assert.deepEqual(bytes(panel.cellImage(cell)), bytes(render('Opener')));
  } finally {
    await d.stop();
  }
});

/* ================================================================ the host */

test('the host starts the EC module on the FTDI road even with no node-hid, and passes commands to it', async () => {
  const sent = [];
  const panel = new FakeEcPanel();
  const core = createHostCore({
    hid: null, reason: 'node-hid is not installed', ftdi: fakeFtdi([panel]),
    modules: [barcoModule], send: (m) => sent.push(m),
  });
  try {
    const hello = sent[0];
    assert.equal(hello.modules[0].id, 'barco-ec');
    assert.equal(hello.modules[0].available, true);
    await core.handle({ op: 'want', id: 1, module: 'barco-ec', wanted: true });
    assert.ok(await until(() => sent.some((m) => m.type === 'state' && m.state.connected)));
    await core.handle({ op: 'command', id: 2, module: 'barco-ec', command: { leds: [{ index: 95, state: 1 }] } });
    const reply = sent.find((m) => m.type === 'reply' && m.id === 2);
    assert.equal(reply.ok, true);
    assert.equal(panel.ledOf(95), 1);
    await core.handle({ op: 'command', id: 3, module: 'barco-ec', command: 'nope' });
    assert.equal(sent.find((m) => m.id === 3).ok, false);
  } finally {
    await core.stop();
  }
  const bare = [];
  createHostCore({ hid: null, reason: 'no hid', ftdi: null, ftdiReason: 'usb is not installed in devices/', modules: [barcoModule], send: (m) => bare.push(m) });
  assert.deepEqual(bare[0].modules[0], { id: 'barco-ec', name: barcoModule.name, transport: 'ftdi', state: null, available: false, reason: 'usb is not installed in devices/' });
});

test('the real host process, forked with a pretend panel: a press crosses the channel and a command comes back answered', async () => {
  const host = createDeviceHost({
    entry: join(ROOT, 'devices/host.js'),
    args: ['--hid', join(here, 'helpers/fake-hid-module.mjs'), '--ftdi', join(here, 'helpers/fake-ftdi-module.mjs')],
  });
  const ec = host.api.module('barco-ec');
  const reports = [];
  ec.on('report', (b) => reports.push(P.readReport(b)));
  host.start();
  try {
    assert.ok(await until(() => ec.available, 5000), `no hello: ${JSON.stringify(host.api.status())}`);
    await ec.want(true);
    assert.ok(await until(() => reports.some((r) => r.type === 'key' && r.index === 79 && r.pressed), 5000), 'ALL TRANS came back');
    assert.deepEqual(await ec.command({ cells: [{ cell: 39, text: 'LIVE 1', colour: P.COLOUR.WHITE }] }), { connected: true, pushed: true });
  } finally {
    await host.stop();
  }
});

/* ============================================================ the meaning */

const FACTS = {
  destinations: [
    { id: 'S1', kind: 'screen', label: 'LED 1', isUsed: true, faded: false, frozen: false },
    { id: 'S2', kind: 'screen', label: 'LED 2', isUsed: true, faded: false, frozen: true },
    { id: 'S3', kind: 'screen', label: '', isUsed: false },
  ],
  sources: {
    LIVE: Array.from({ length: 14 }, (_, i) => ({ number: i + 1, source: `LIVE_${i + 1}`, label: i === 0 ? 'CAM 1' : '' })),
    STILL: [{ number: 1, source: 'STILL_1', label: 'Logo' }],
    SCREEN: [],
  },
  presets: [{ slot: 1, label: 'Opener' }, { slot: 4, label: 'Walk-in' }],
  layers: [{ destination: 'S1', key: 1 }, { destination: 'S1', key: 2 }, { destination: 'S2', key: 1 }],
};

function ctxWith({ model = 'ec-50', settings = DEFAULT_BARCO_EC, select = [] } = {}) {
  const selection = new Selection();
  selection.restrict(['S1', 'S2']);
  for (const d of select) selection.apply({ kind: 'select', destination: d });
  return { model, view: initialView(settings), facts: FACTS, selection };
}

test('settings: off by default, a bad model or row falls back, and only what matters counts as a change', () => {
  assert.deepEqual(normaliseBarcoEc(undefined), { barcoEcEnabled: false, barcoEcModel: 'ec-50', barcoEcRows: ['stills', 'inputs', 'memories'] });
  assert.deepEqual(normaliseBarcoEc({ barcoEcEnabled: true, barcoEcModel: 'ec-99', barcoEcRows: ['memories', 'bogus'] }).barcoEcRows, ['memories', 'inputs', 'memories']);
  const a = normaliseBarcoEc({});
  assert.equal(barcoEcChanged(a, { ...a }), false);
  assert.equal(barcoEcChanged(a, { ...a, barcoEcRows: ['inputs', 'inputs', 'memories'] }), true);
  assert.ok(ROW_KINDS.every((k) => k.id && k.label));
});

test('every bus key means what the page it is on holds', () => {
  const ctx = ctxWith({ select: ['S1'] });
  assert.deepEqual(keyIntent(key('DEST_0'), ctx), { kind: 'unselect', destination: 'S1', key: 'DEST_0' });
  assert.deepEqual(keyIntent(key('DEST_1'), ctx), { kind: 'select', destination: 'S2', key: 'DEST_1' });
  assert.equal(keyIntent(key('DEST_2'), ctx).kind, 'none', 'S3 is not in service');
  assert.deepEqual(keyIntent(key('LAYER_1'), ctx), { kind: 'selectLayer', layer: 2, key: 'LAYER_1' });
  assert.equal(keyIntent(key('LAYER_2'), ctx).kind, 'none');
  assert.deepEqual(keyIntent(key('ASSIGN_1_0'), ctx), { kind: 'source', input: 1, sourceKind: 'LIVE', label: 'CAM 1', key: 'ASSIGN_1_0' });
  assert.deepEqual(keyIntent(key('ASSIGN_0_0'), ctx), { kind: 'source', input: 1, sourceKind: 'STILL', label: 'Logo', key: 'ASSIGN_0_0' });
  assert.deepEqual(keyIntent(key('ASSIGN_2_1'), ctx), { kind: 'recall', slot: 4, label: 'Walk-in', key: 'ASSIGN_2_1' });
  assert.deepEqual(keyIntent(key('ALL_TRANS'), ctx), { kind: 'take', key: 'ALL_TRANS' });
  assert.equal(keyIntent(key('LAYER_TRANS'), ctx).kind, 'none');
  assert.match(keyIntent(key('LAYER_TRANS'), ctx).why, /takes a screen, not a layer/);
  const ec30 = ctxWith({ model: 'ec-30' });
  assert.equal(keyIntent(key('ASSIGN_0_0'), ec30).why, 'not on this model');
});

test('paging moves twelve at a time and stops at the ends; a label press cycles what its row holds', () => {
  const ctx = ctxWith();
  const counts = pageCounts(ctx.view, ctx.facts, ctx.selection);
  assert.deepEqual(counts.rows, [1, 2, 1]);
  let view = applyView(ctx.view, { kind: 'page', target: 'row', row: 1, delta: 1 }, counts);
  assert.equal(view.rowPages[1], 1);
  assert.deepEqual(keyIntent(key('ASSIGN_1_0'), { ...ctx, view }).input, 13);
  view = applyView(view, { kind: 'page', target: 'row', row: 1, delta: 1 }, counts);
  assert.equal(view.rowPages[1], 1, 'clamped at the last page');
  view = applyView(view, { kind: 'cycleRow', row: 1 }, counts);
  assert.deepEqual([view.rowKinds[1], view.rowPages[1]], ['stills', 0]);
});

test('the panel drawn: names on the keys in each row’s colour, selection and layers on the lamps, a held key lit', () => {
  const ctx = ctxWith({ select: ['S2', 'S1'] });
  ctx.selection.apply({ kind: 'selectLayer', layer: 2 });
  ctx.view.held.add(key('ALL_TRANS'));
  const { cells, leds } = paint(ctx);
  const lcd = (name) => P.BUTTON_BY_NAME.get(name).lcd;
  assert.deepEqual(cells.get(lcd('ASSIGN_1_0')), { text: 'CAM 1', colour: P.COLOUR.WHITE });
  assert.deepEqual(cells.get(lcd('ASSIGN_1_1')), { text: 'IN 2', colour: P.COLOUR.WHITE }, 'an unnamed input by its number');
  assert.deepEqual(cells.get(lcd('ASSIGN_0_0')), { text: 'Logo', colour: P.COLOUR.CYAN });
  assert.deepEqual(cells.get(lcd('ASSIGN_2_1')), { text: 'Walk-in', colour: P.COLOUR.YELLOW });
  assert.deepEqual(cells.get(lcd('ASSIGN_2_2')), { text: '', colour: P.COLOUR.OFF });
  assert.deepEqual(cells.get(lcd('ASSIGN_1_LABEL')), { text: 'INPUTS\n1-12', colour: P.COLOUR.WHITE });
  assert.equal(leds.get(key('DEST_0')), P.LED.GREEN);
  assert.equal(leds.get(key('DEST_1')), P.LED.GREEN);
  assert.equal(leds.get(key('LAYER_0')), P.LED.RED, 'fitted on the active screen');
  assert.equal(leds.get(key('LAYER_1')), P.LED.GREEN, 'the selected layer');
  assert.equal(leds.get(key('LAYER_2')), P.LED.OFF);
  assert.equal(leds.get(key('FREEZE_PGM')), P.LED.RED, 'S2 has a frozen layer');
  assert.equal(leds.get(key('ALL_TRANS')), P.LED.GREEN, 'held');
  const ec30 = paint(ctxWith({ model: 'ec-30' }));
  assert.deepEqual(ec30.cells.get(lcd('ASSIGN_0_0')), { text: '', colour: P.COLOUR.OFF }, 'an EC-30 has no top row to draw');
  const diff = paintCommand(paint(ctx), paint(ctx));
  assert.deepEqual(diff, { cells: [], leds: [] });
});

test('a T-bar stroke counts up from the bottom and down from the top', () => {
  assert.equal(strokeProgress(0.01, 0.4), 0.4);
  assert.equal(strokeProgress(0.99, 0.4), 0.6);
  assert.equal(strokeProgress(0.99, 1), 0);
});

/* ========================================================= the supervisor */

/** A LivePremier with two screens, three inputs, a still and two memories. */
function lpStore() {
  const s = new Map();
  const set = (path, v) => s.set(toAwj(path), v);
  s.set('DeviceObject/system/$device/@items/1/@props/dev', 'NLC_RS4');
  for (const [id, label] of [['S1', 'LED 1'], ['S2', 'LED 2']]) {
    set(NLC.takeStatus(id, 'isUsed'), true);
    set(labelPath(NLC, id), label);
    set(NLC.takeControl(id, 'presetUp'), 'A');
    set(NLC.takeControl(id, 'presetDown'), 'B');
    set(NLC.takeControl(id, 'presetPrevious'), 'C');
    set(NLC.takeStatus(id, 'transition'), 'AT_DOWN');
    set(NLC.takeStatus(id, 'tbarPosition'), 0);
    set(NLC.fadeToBlackPath(id), false);
    const probe = NLC.layerProbe(id, 16);
    for (const k of probe.slots) set(probe.path(k), Number(k) <= (id === 'S1' ? 2 : 1) ? 'FULL' : 'OFF');
  }
  ['CAM 1', 'CAM 2', 'PPT'].forEach((label, i) => {
    set(['device', 'inputList', 'items', `IN_${i + 1}`, 'mapping', 'pp', 'isValid'], true);
    set(['device', 'inputList', 'items', `IN_${i + 1}`, 'control', 'pp', 'label'], label);
  });
  set(['device', 'stillList', 'items', '1', 'mapping', 'pp', 'isValid'], true);
  set(['device', 'stillList', 'items', '1', 'control', 'pp', 'label'], 'Logo');
  [['1', 'Opener'], ['2', 'Walk-in']].forEach(([slot, label]) => {
    set(NLC.label('screen', Number(slot), '').path, label);
    set(slotValidPath(NLC, Number(slot)), true);
  });
  return s;
}

/** The `devices` service, holding a real driver on a pretend panel in this process. */
function devicesWith(driver) {
  const events = new EventEmitter();
  driver.on('state', (st) => events.emit('state', st));
  driver.on('report', (b) => events.emit('report', b));
  const handle = {
    get state() { return driver.state; },
    get available() { return true; },
    reason: null,
    want: (w) => driver.want(w),
    command: (c) => driver.command(c),
    on(ev, fn) { events.on(ev, fn); return () => events.off(ev, fn); },
  };
  return { module: () => handle, status: () => ({ installed: true, running: true, reason: null }) };
}

test('the supervisor end to end: a screen picked, an input put on its preview, a memory recalled, a take, and a T-bar throw', async () => {
  const awj = await fakeAwj(lpStore());
  const panel = new FakeEcPanel();
  const driver = new BarcoEcDriver({ ftdi: fakeFtdi([panel]), scanMs: 10, pollMs: 2 });
  driver.start();
  const sup = new BarcoEcSupervisor({ deviceHost: () => '127.0.0.1', awjPort: awj.port, devices: () => devicesWith(driver) });
  const lcd = (name) => P.BUTTON_BY_NAME.get(name).lcd;
  try {
    await sup.apply(normaliseBarcoEc({ barcoEcEnabled: true }));
    assert.ok(await until(() => panel.shown() && panel.colourOf(lcd('ASSIGN_1_0')) === P.COLOUR.WHITE), 'the panel painted from the switcher');
    assert.deepEqual(bytes(panel.cellImage(lcd('ASSIGN_1_0'))), bytes(render('CAM 1')));
    assert.deepEqual(bytes(panel.cellImage(lcd('ASSIGN_2_1'))), bytes(render('Walk-in')));

    panel.tap(key('DEST_0'));
    assert.ok(await until(() => panel.ledOf(key('DEST_0')) === P.LED.GREEN), 'S1 selected and lit');
    assert.deepEqual(sup.selection.list, ['S1']);
    assert.ok(await until(() => panel.ledOf(key('LAYER_0')) === P.LED.GREEN && panel.ledOf(key('LAYER_1')) === P.LED.RED));

    awj.clear();
    panel.tap(key('ASSIGN_1_1'));   // CAM 2
    assert.ok(await until(() => awj.writes().length));
    const [w] = awj.writes();
    assert.match(w.path, /\$screen\/@items\/S1\/\$preset\/@items\/A\/\$layer\/@items\/1\/source\/@props\/inputNum$/, `the preview letter's layer 1: ${w.path}`);
    assert.equal(w.value, 'LIVE_2');

    awj.clear();
    panel.tap(key('ASSIGN_2_0'));   // Opener
    assert.ok(await until(() => awj.writes().length));
    assert.match(awj.writes()[0].path, /\$slot\/@items\/1\/\$screen\/@items\/S1\/\$preset\/@items\/PREVIEW\/@props\/xRequest$/, 'to preview, always');

    awj.clear();
    panel.tap(key('ALL_TRANS'));
    assert.ok(await until(() => awj.writes().length));
    assert.deepEqual(awj.writes(), [{ path: toAwj(NLC.takeControl('S1', 'xTake')), value: true }]);

    awj.clear();
    panel.setTbar(P.TBAR_MIN);             // where the lever rests: not a stroke
    await settle(30);
    assert.equal(awj.writes().length, 0);
    panel.setTbar(0x7e28);                 // half way
    assert.ok(await until(() => awj.writes().some((x) => x.path.endsWith('tbarPosition'))));
    panel.setTbar(P.TBAR_MAX);
    assert.ok(await until(() => awj.writes().some((x) => x.path.endsWith('tbarPosition') && x.value === 65535)), 'the throw completes the take');
    assert.ok(sup.history.some((e) => /T-bar take on S1/.test(e.note || '')));

    panel.tap(key('LAYER_TRANS'));
    assert.ok(await until(() => sup.history.some((e) => e.key === 'LAYER_TRANS')), 'an unmapped key says why');
  } finally {
    await sup.stop();
    await driver.stop();
    await awj.close();
  }
  assert.equal(panel.open, false, 'let go when stopped');
});
