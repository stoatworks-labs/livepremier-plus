/*
 * The Speed Editor plugin: its server half (which page drives the panel, and
 * when it is wanted) over the app's `devices` service, and the page that runs
 * the mapping. The panel is the fake in `helpers/fake-speed-editor.js`, run
 * through the real supervisor, host core and driver in this process; the
 * device host itself has its own tests in `devices.test.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import speedEditorModule from '../devices/modules/speed-editor/module.js';
import { createDeviceHost, absentDevices } from '../server/device-host.js';
import { createSpeedEditorServer } from '../plugins/speed-editor/server.js';
import { HttpError } from '../server/plugin-host.js';
import { FakePanel, fakeHid, inProcessFork } from './helpers/fake-speed-editor.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await settle(10); }
  return check();
}

/** Enough of a plugin's server ctx to run the half, with `devices` as its service. */
function fakeCtx(devices) {
  const routes = new Map();
  const sent = [];
  const disposers = [];
  return {
    routes, sent, disposers,
    HttpError,
    log: () => {},
    use: (name) => (name === 'devices' ? devices : null),
    route: (method, path, fn) => routes.set(`${method} ${path}`, fn),
    stream: () => ({ send: (event, data) => sent.push([event, data]) }),
    onDispose: (fn) => disposers.push(fn),
    async call(method, path, body) {
      let status = 200, payload;
      const h = { json: (s, b) => { status = s; payload = b; }, readJson: async () => body ?? {} };
      try { await routes.get(`${method} ${path}`)({}, {}, h); } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        status = err.status; payload = { error: err.message };
      }
      return { status, body: payload };
    },
  };
}

/* ------------------------------------------------------------ the server */

test('only the page holding the lease writes to the panel, another can take it over, and it is held only while driven', async (t) => {
  const panel = new FakePanel();
  const host = createDeviceHost({ entry: 'host.js', fork: inProcessFork({ hid: fakeHid([panel]), modules: [speedEditorModule] }) });
  t.after(() => host.stop());
  host.start();
  const ctx = fakeCtx(host.api);
  createSpeedEditorServer(ctx);
  const state = async () => (await ctx.call('GET', '/')).body;
  assert.ok(await until(() => host.api.module('speed-editor').state?.present));
  assert.equal((await state()).available, true);
  assert.equal((await state()).connected, false, 'found, but not held while nobody drives it');

  assert.deepEqual((await ctx.call('POST', '/driver', { id: 'a' })).body, { driver: 'a' });
  assert.ok(await until(() => host.api.module('speed-editor').state?.authed), 'opened and answered once a page drives it');
  assert.deepEqual((await ctx.call('POST', '/driver', { id: 'b' })).body, { driver: 'a' }, 'held');
  assert.equal((await ctx.call('POST', '/output', { id: 'b', reports: [[2, 1, 0, 0, 0]] })).status, 409);
  assert.equal((await ctx.call('POST', '/output', { id: 'a', reports: [[2, 1, 0, 0, 0]] })).body.written, 1);
  assert.equal((await ctx.call('POST', '/output', { id: 'a', reports: [[2, 999]] })).status, 400);

  assert.deepEqual((await ctx.call('POST', '/driver', { id: 'b', take: true })).body, { driver: 'b' });
  assert.equal((await ctx.call('POST', '/output', { id: 'a', reports: [[2, 0, 0, 0, 0]] })).status, 409);
  panel.press(0x0f);
  assert.ok(await until(() => ctx.sent.some(([e]) => e === 'report')));
  const report = ctx.sent.find(([e]) => e === 'report');
  assert.deepEqual([...Buffer.from(report[1], 'base64')].slice(0, 2), [4, 0x0f]);

  assert.deepEqual((await ctx.call('POST', '/driver', { id: 'b', release: true })).body, { driver: null });
  assert.ok(await until(() => panel.closed), 'let go when the last driver does');
  assert.deepEqual(panel.written, [[2, 1, 0, 0, 0]]);
  for (const fn of ctx.disposers) await fn();
});

test('with no device host the half still answers, and says why there is no panel', async () => {
  const ctx = fakeCtx(absentDevices('The device host is not installed (npm run setup:devices).'));
  createSpeedEditorServer(ctx);
  const state = (await ctx.call('GET', '/')).body;
  assert.equal(state.available, false);
  assert.match(state.reason, /setup:devices/);
  assert.equal((await ctx.call('POST', '/output', { id: 'a', reports: [] })).status, 503);
});

/* ------------------------------------------------------------ the page */

class FakeEventSource extends EventTarget {
  static last = null;
  constructor(url) { super(); this.url = url; FakeEventSource.last = this; }
  close() { this.closed = true; }
  emit(type, data) { const ev = new Event(type); ev.data = data; this.dispatchEvent(ev); }
}

function page({ driver = 'self' } = {}) {
  const posted = [];
  const snapshot = { available: true, connected: true, authed: true, lease: 600, product: 'DaVinci Resolve Speed Editor', battery: null, error: null, handshakes: 1, driver: null };
  globalThis.EventSource = FakeEventSource;
  let pageId = null;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('speed-editor.json')) {
      const text = readFileSync(join(here, '..', 'src/vendor/surface/profiles/speed-editor.json'), 'utf8');
      return { ok: true, json: async () => JSON.parse(text) };
    }
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.endsWith('/driver')) {
      pageId = body.id;
      snapshot.driver = driver === 'self' ? (body.release ? null : body.id) : driver;
      return { ok: true, json: async () => ({ driver: snapshot.driver }) };
    }
    if (u.endsWith('/output')) { posted.push(...body.reports); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({ ...snapshot }) };
  };
  const store = new DeviceStore();
  store.hydrate(fixture('sim-6.2.73-screens.json'));
  const sent = [];
  const session = new EventTarget();
  session.store = store;
  session.send = (w) => { sent.push(w); return true; };
  return { session, sent, posted, snapshot, url: (p) => `/__lpp/speed-editor${p === '/' ? '' : p}`, id: () => pageId };
}

const keys = (...codes) => {
  const b = Buffer.alloc(13);
  b[0] = 4;
  codes.forEach((c, i) => { b[1 + 2 * i] = c; });
  /* Exactly as `ctx.stream` frames it: JSON, so a quoted string. */
  return JSON.stringify(b.toString('base64'));
};

test('a started page drives the panel from the server\'s reports: its lamps are set, and CUT writes xCut', async (t) => {
  const { session, sent, posted, snapshot, url } = page();
  const { createSpeedEditorPanel } = await import('../plugins/speed-editor/panel.js?drives');
  const se = createSpeedEditorPanel({ session, url });
  t.after(() => se.stop());
  await se.start();
  FakeEventSource.last.emit('state', JSON.stringify(snapshot));
  await settle();
  assert.deepEqual(posted.slice(0, 3), [[2, 0, 0, 0, 0], [3, 0, 0, 0, 0, 0, 0xff], [4, 1]],
    'lamps out, wheel relative, JOG lit');

  FakeEventSource.last.emit('report', keys(0x0f));   // CUT
  FakeEventSource.last.emit('report', keys());
  await settle();
  const cut = sent.find((w) => w.path.at(-1) === 'xCut');
  assert.ok(cut, `no xCut among ${JSON.stringify(sent.map((w) => w.path.join('/')))}`);
  assert.equal(cut.path.join('/'), 'device/screenAuxGroupList/items/S1/control/pp/xCut');

  /* The switcher leaves xCut at true after a cut. The second CUT must still
     go out: it was dropped as redundant the first time a real panel was
     pressed at the simulator. */
  session.store.set(cut.path, true);
  sent.length = 0;
  FakeEventSource.last.emit('report', keys(0x0f));
  FakeEventSource.last.emit('report', keys());
  await settle();
  assert.ok(sent.some((w) => w.path.at(-1) === 'xCut' && w.value === true), 'the second CUT was dropped');
  se.stop();
  assert.ok(FakeEventSource.last.closed, 'the stream is let go');
});

test('a page that does not hold the lease hears the panel and does nothing with it', async (t) => {
  const { session, sent, posted, snapshot, url } = page({ driver: 'someone-else' });
  const { createSpeedEditorPanel } = await import('../plugins/speed-editor/panel.js?elsewhere');
  const se = createSpeedEditorPanel({ session, url });
  t.after(() => se.stop());
  await se.start();
  FakeEventSource.last.emit('state', JSON.stringify({ ...snapshot }));
  FakeEventSource.last.emit('report', keys(0x0f));
  FakeEventSource.last.emit('report', keys());
  await settle();
  assert.equal(sent.length, 0);
  assert.equal(posted.length, 0);
  se.stop();
});
