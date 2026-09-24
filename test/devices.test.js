/*
 * The device host: the Speed Editor driver, the host's core, and the app's
 * supervisor — the last once in-process and once against the real
 * `devices/host.js`, forked, with a fake panel loaded in place of node-hid.
 *
 * None of it needs node-hid or a panel. What it cannot prove is how node-hid
 * behaves on each platform; that is the hardware check, first passed
 * 2026-09-24 over USB on macOS.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { SpeedEditorDriver } from '../devices/modules/speed-editor/driver.js';
import speedEditorModule from '../devices/modules/speed-editor/module.js';
import { createHostCore, loadModules } from '../devices/core.js';
import { createDeviceHost, findDeviceHost, absentDevices } from '../server/device-host.js';
import { FakePanel, fakeHid, inProcessFork } from './helpers/fake-speed-editor.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await settle(10); }
  return check();
}

/* ------------------------------------------------------------ the driver */

test('the driver finds the panel, opens it only when wanted, and answers its challenge at the report\'s own length', async () => {
  const panel = new FakePanel();
  const driver = new SpeedEditorDriver({ hid: fakeHid([panel]), scanMs: 10, retryMs: 10 });
  const reports = [];
  driver.on('report', (b) => reports.push([...b]));
  driver.start();
  await settle();
  assert.equal(driver.state.present, true, 'found');
  assert.equal(driver.state.connected, false, 'not held while nobody wants it');

  await driver.want(true);
  await settle();
  assert.equal(driver.state.authed, true);
  assert.equal(driver.state.lease, 600);
  assert.ok(panel.reads.every(([id, len]) => id === 6 && len === 10), `read ${JSON.stringify(panel.reads)}`);

  panel.press(0x0f);
  assert.deepEqual(reports.at(-1).slice(0, 3), [4, 0x0f, 0]);
  assert.equal(await driver.write(Uint8Array.of(2, 1, 0, 0, 0)), true);
  assert.deepEqual(panel.written, [[2, 1, 0, 0, 0]]);

  await driver.want(false);
  assert.equal(driver.state.connected, false, 'let go');
  assert.ok(panel.closed);
  await driver.stop();
});

test('a panel that goes away is looked for again, and answered again when it comes back', async () => {
  const first = new FakePanel();
  const hid = fakeHid([first]);
  const driver = new SpeedEditorDriver({ hid, scanMs: 10, retryMs: 10 });
  driver.start();
  await driver.want(true);
  await settle();
  assert.equal(driver.state.handshakes, 1);

  hid.present = [];
  first.emit('error', new Error('could not read from HID device'));
  await settle();
  assert.equal(driver.state.connected, false);
  assert.equal(await driver.write(Uint8Array.of(2, 0, 0, 0, 0)), false, 'nothing to write to');

  hid.present = [new FakePanel()];
  await settle(60);
  assert.equal(driver.state.authed, true);
  assert.equal(driver.state.handshakes, 2);
  await driver.stop();
});

test('a refused answer is reported and retried, and nothing is written meanwhile', async () => {
  const panel = new FakePanel({ refuse: true });
  const driver = new SpeedEditorDriver({ hid: fakeHid([panel]), scanMs: 10, retryMs: 10 });
  driver.start();
  await driver.want(true);
  await settle(50);
  assert.equal(driver.state.authed, false);
  assert.match(driver.state.error, /would not authenticate/);
  const attempts = panel.reads.length;
  await settle(40);
  assert.ok(panel.reads.length > attempts, 'tried again');
  assert.equal(await driver.write(Uint8Array.of(2, 0, 0, 0, 0)), false);
  await driver.stop();
});

/* ------------------------------------------------------------ the core */

test('the host says hello with its modules, and answers want and write for them', async () => {
  const panel = new FakePanel();
  const sent = [];
  const core = createHostCore({ hid: fakeHid([panel]), modules: [speedEditorModule], send: (m) => sent.push(m) });
  const hello = sent.find((m) => m.type === 'hello');
  assert.equal(hello.available, true);
  assert.deepEqual(hello.modules.map((m) => [m.id, m.transport]), [['speed-editor', 'hid']]);

  await core.handle({ op: 'want', id: 1, module: 'speed-editor', wanted: true });
  assert.equal(sent.find((m) => m.type === 'reply' && m.id === 1).ok, true);
  await settle();
  assert.ok(sent.some((m) => m.type === 'state' && m.state.authed));

  panel.press(0x0f);
  const report = sent.find((m) => m.type === 'report');
  assert.deepEqual([...Buffer.from(report.data, 'base64')].slice(0, 2), [4, 0x0f]);

  await core.handle({ op: 'write', id: 2, module: 'speed-editor', reports: [[2, 1, 0, 0, 0]] });
  assert.deepEqual(sent.find((m) => m.id === 2), { type: 'reply', id: 2, ok: true, result: 1 });
  await core.handle({ op: 'write', id: 3, module: 'speed-editor', reports: [[2, 999]] });
  assert.equal(sent.find((m) => m.id === 3).ok, false);
  await core.handle({ op: 'want', id: 4, module: 'nothing', wanted: true });
  assert.match(sent.find((m) => m.id === 4).error, /no module nothing/);
  await core.stop();
});

test('without node-hid the host still says hello, and says why nothing will open', async () => {
  const sent = [];
  const core = createHostCore({ hid: null, reason: 'node-hid is not installed', modules: [speedEditorModule], send: (m) => sent.push(m) });
  assert.deepEqual(sent[0], { type: 'hello', available: false, reason: 'node-hid is not installed', modules: [{ id: 'speed-editor', name: 'DaVinci Resolve Speed Editor', transport: 'hid', state: null }] });
  await core.handle({ op: 'want', id: 1, module: 'speed-editor', wanted: true });
  assert.equal(sent[1].error, 'node-hid is not installed');
});

test('modules are the folders under modules/, and a folder that is not one is skipped with a reason', async () => {
  assert.deepEqual((await loadModules(join(ROOT, 'devices/modules'))).map((m) => m.id), ['speed-editor']);
  const dir = await mkdtemp(join(tmpdir(), 'lpp-modules-'));
  try {
    await mkdir(join(dir, 'wrong-id'));
    await writeFile(join(dir, 'wrong-id', 'module.js'), "export default { id: 'other', create() {} };");
    await mkdir(join(dir, 'empty'));
    const said = [];
    assert.deepEqual(await loadModules(dir, (t) => said.push(t)), []);
    assert.equal(said.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ the supervisor */

test('the supervisor hands out module handles that outlive a restart, and asks again for what was wanted', async () => {
  const panel = new FakePanel();
  const fork = inProcessFork({ hid: fakeHid([panel]), modules: [speedEditorModule] });
  const host = createDeviceHost({ entry: 'host.js', fork, restartMinMs: 10 });
  const se = host.api.module('speed-editor');
  const states = [];
  se.on('state', (s) => states.push(s));
  host.start();
  assert.ok(await until(() => se.available), 'the host said hello');
  assert.equal(se.state.present, true);

  await se.want(true);
  assert.ok(await until(() => se.state?.authed), 'opened and answered');
  assert.equal(await se.write([[2, 1, 0, 0, 0]]), 1);

  fork.children[0].kill('SIGKILL');                          // the host dies
  assert.ok(await until(() => se.state && !se.state.connected), 'says it is gone');
  assert.ok(await until(() => fork.children.length === 2 && se.state?.authed), 'restarted, and the panel wanted again');
  assert.equal(host.api.status().restarts, 1);

  await host.stop();
  assert.equal(host.api.status().running, false);
});

test('a host that is not installed is never started, and says why', async () => {
  let forked = 0;
  const host = createDeviceHost({ entry: 'host.js', installed: false, reason: 'not installed (npm run setup:devices)', fork: () => { forked++; } });
  host.start();
  assert.equal(forked, 0);
  const status = host.api.status();
  assert.equal(status.running, false);
  assert.match(status.reason, /setup:devices/);
  assert.equal(host.api.module('speed-editor').available, false);
  assert.match(absentDevices().status().reason, /No device host/);
  const found = findDeviceHost(join(tmpdir(), 'no-such-app'));
  assert.equal(found.installed, false);
});

test('the real host process, forked with a fake panel: hello, want, a report across the channel, and a clean stop', async () => {
  const host = createDeviceHost({
    entry: join(ROOT, 'devices/host.js'),
    args: ['--hid', join(here, 'helpers/fake-hid-module.mjs')],
  });
  const se = host.api.module('speed-editor');
  const reports = [];
  se.on('report', (b) => reports.push([...b]));
  host.start();
  try {
    assert.ok(await until(() => se.available, 5000), `no hello: ${JSON.stringify(host.api.status())}`);
    await se.want(true);
    assert.ok(await until(() => reports.length >= 2), 'the panel\'s CUT came back across the channel');
    assert.deepEqual(reports[0].slice(0, 2), [4, 0x0f]);
    assert.equal(await se.write([[2, 1, 0, 0, 0]]), 1);
  } finally {
    await host.stop();
  }
  assert.equal(host.api.status().running, false);
});
