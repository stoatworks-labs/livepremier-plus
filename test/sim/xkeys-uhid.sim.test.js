/*
 * X-keys through the kernel, on Linux: a virtual XKE-124 T-bar made with uhid
 * (`test/helpers/uhid-xkeys.py`, run as root beside this), found and held by
 * the REAL device host — `devices/host.js` forked as the app forks it,
 * node-hid on hidraw — and the app's xkeys plugin driving the simulator.
 * Every other X-keys test hands the device host a pretend node-hid; this one
 * is the only one where the bytes cross a kernel.
 *
 * Skips unless the panel is running and `LPP_SIM` is set:
 *
 *     sudo modprobe uhid      # Ubuntu: linux-modules-extra-$(uname -r) has it
 *     npm run setup:devices
 *     sudo python3 test/helpers/uhid-xkeys.py /tmp/xk-ctl /tmp/xk-state.json &
 *     LPP_SIM=192.168.1.203:3000 XK_FIFO=/tmp/xk-ctl XK_STATE=/tmp/xk-state.json \
 *       node --test test/sim/xkeys-uhid.sim.test.js
 *     echo quit > /tmp/xk-ctl
 *
 * Still not a panel on a desk: the virtual one only behaves as the xkeys
 * library says a panel does.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, openSync, writeSync, closeSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SKIP, startApp, Link, awjGet, sag, settled, guardScreen, layerPath, sleep, offeredInputs } from './harness.js';
import { bankLetter } from '../../src/core/properties.js';
import { createDeviceHost, findDeviceHost } from '../../server/device-host.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIFO = process.env.XK_FIFO;
const STATE = process.env.XK_STATE;

const panel = {
  state: () => JSON.parse(readFileSync(STATE, 'utf8')),
  /* Never blocks: with no panel reading the FIFO, this throws rather than hangs. */
  say(line) {
    const fd = openSync(FIFO, constants.O_WRONLY | constants.O_NONBLOCK);
    try { writeSync(fd, `${line}\n`); } finally { closeSync(fd); }
  },
  tap(i) { this.say(`tap ${i}`); },
  setTbar(v) { this.say(`tbar ${v}`); },
  lampOf(i) {
    const { leds } = this.state();
    const b = leds[String(i - 1)] ?? 0;
    const r = leds[String(i - 1 + 128)] ?? 0;
    const word = b && r ? 'both' : b ? 'blue' : r ? 'red' : 'off';
    return (b === 2 || r === 2) ? `${word}*` : word;
  },
  dark() {
    const s = this.state();
    return Object.values(s.leds).every((v) => v === 0) && s.indicators.green === 0 && s.indicators.red === 0
      && s.banks['0'] === 0 && s.banks['1'] === 0;
  },
};

let app;
let link;
let guard;
let host;
const hostLog = [];

const KEY = { IN_A: 1, IN_B: 9, S1: 3, L1: 4, TAKE: 121, EMPTY: 50 };

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(50); }
  return false;
};

/** The live inputs the plugin keeps, in order — the rule the console reader and the Web RCS picker share. */
const liveInputs = () => offeredInputs(link, 20);

let inputs = [];
const skip = SKIP || !FIFO || !STATE || process.platform !== 'linux';

before(async () => {
  if (skip) return;
  const found = findDeviceHost(ROOT);
  assert.equal(found.installed, true, found.reason || 'device host installed');
  host = createDeviceHost({ ...found, log: (m) => hostLog.push(String(m)) });
  host.start();
  app = await startApp({ devices: host.api });
  link = await Link.open(app);
  guard = await guardScreen(link, 'S1');
  inputs = liveInputs();
  const [a, b] = inputs;
  await app.configure({
    plugins: {
      xkeys: {
        enabled: true,
        settings: {
          xkeysEnabled: true,
          xkeysLayouts: {
            XKE124TBAR: {
              [KEY.IN_A]: { do: 'input', n: a ?? 1 },
              [KEY.IN_B]: { do: 'input', n: b ?? 2 },
              [KEY.S1]: { do: 'screen', id: 'S1' },
              [KEY.L1]: { do: 'layer', n: 1 },
              [KEY.TAKE]: { do: 'take' },
            },
          },
        },
      },
    },
  });
});

after(async () => {
  try { if (guard) await guard.restore(); }
  finally {
    link?.close();
    await app?.close();
    await host?.stop();
    if (hostLog.length) console.log(`device host log:\n  ${hostLog.slice(-20).join('\n  ')}`);
  }
});

const state = async () => (await app.api('/xkeys/state')).json;

test('the real device host finds the uhid panel on hidraw, opens it and asks for its version and keys', { skip }, async () => {
  assert.ok(await until(() => panel.state().opened > 0), 'hidraw opened');
  assert.ok(await until(() => panel.state().written.some((w) => w[0] === 214)), 'version asked');
  assert.ok(await until(() => panel.state().written.some((w) => w[0] === 177)), 'keys asked');
  assert.ok(await until(async () => (await state()).panel.ready === true), 'ready');
  const s = await state();
  console.log('panel state:', JSON.stringify(s.panel));
  assert.equal(s.panel.model, 'XKE124TBAR');
  assert.equal(s.panel.firmware, 38, 'firmware read from the version reply, through the kernel');
  assert.ok(await until(async () => (await state()).tally), 'tally read');
  assert.ok(await until(() => panel.lampOf(KEY.S1) === 'blue'), 'S1’s key lit: driven');
  assert.ok(await until(() => panel.state().indicators.green === 1), 'the green lamp on');
});

test('through hidraw: an input to preview lit blue, TAKE and the T-bar take, an empty key writes nothing', { skip }, async () => {
  await settled(link, 'S1');
  const [, b] = inputs;
  const pv = bankLetter(link.store, 'S1', 'PREVIEW').letter;
  panel.tap(KEY.IN_B);
  await link.waitFor(layerPath('S1', pv, 1, 'source', 'pp', 'inputNum'), `LIVE_${b}`, { timeout: 5000 });
  assert.ok(await until(() => panel.lampOf(KEY.IN_B) === 'blue'), 'its key went blue');

  const from = await settled(link, 'S1');
  const to = from === 'AT_UP' ? 'AT_DOWN' : 'AT_UP';
  panel.tap(KEY.TAKE);
  await link.waitFor(sag('S1', 'status', 'transition'), to, { timeout: 15000 });
  assert.ok(await until(() => panel.lampOf(KEY.IN_B) === 'red'), 'on air now: red');

  await settled(link, 'S1');
  panel.setTbar(0);
  await sleep(300);
  panel.setTbar(128);
  await sleep(300);
  panel.setTbar(255);
  await link.waitFor(sag('S1', 'status', 'transition'), from, { timeout: 15000 });
  assert.ok((await state()).history.some((e) => /T-bar take on S1/.test(e.note || '')), 'the stroke is in the history');

  const before = await awjGet(layerPath('S1', bankLetter(link.store, 'S1', 'PREVIEW').letter, 1, 'source', 'pp', 'inputNum'));
  panel.tap(KEY.EMPTY);
  assert.ok(await until(async () => (await state()).history.some((e) => e.index === KEY.EMPTY && /no job/.test(e.note || ''))));
  assert.equal(await awjGet(layerPath('S1', bankLetter(link.store, 'S1', 'PREVIEW').letter, 1, 'source', 'pp', 'inputNum')), before);
});

test('unplugged and plugged back in: the host sees it go, opens it again, and the plugin relights it', { skip }, async () => {
  panel.say('unplug');
  assert.ok(await until(async () => (await state()).panel.connected === false), 'the card says it went');
  panel.say('replug');
  assert.ok(await until(() => panel.state().hidraw), 'the kernel made it again');
  assert.ok(await until(async () => (await state()).panel.ready === true, 12000), 'opened and ready again');
  assert.ok(await until(() => panel.lampOf(KEY.S1) === 'blue'), 'S1’s key relit on the new panel');
  assert.ok(await until(() => panel.state().indicators.green === 1), 'the green lamp too');
});

test('switched off: hidraw closed and the panel left dark', { skip }, async () => {
  await app.configure({ plugins: { xkeys: { settings: { xkeysEnabled: false } } } });
  assert.ok(await until(() => panel.state().closed), 'hidraw closed');
  assert.ok(panel.dark(), `left dark: ${JSON.stringify(panel.state().banks)}`);
});
