/*
 * The Speed Editor plugin: the server's link to the panel, the server's
 * routes, and the page that runs the mapping — each against fakes.
 *
 * The fake panel runs the real handshake: it issues a challenge, checks the
 * answer with the vendored `authResponse`, and says nothing until it has been
 * answered, as the hardware does. It also refuses a feature read at any
 * length but the report's own, which is what the real panel does on macOS
 * and why WebHID could never read the challenge (see `link.js`). What these
 * cannot prove is how node-hid behaves on each platform; that is the
 * hardware check, first passed on 2026-09-24 over USB on macOS.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import { authResponse, VENDOR_ID, PRODUCT_ID } from '../src/vendor/surface/hid/speed-editor.js';
import { PanelLink } from '../plugins/speed-editor/link.js';
import { createSpeedEditorServer } from '../plugins/speed-editor/server.js';
import { HttpError } from '../server/plugin-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ fakes */

/** node-hid's HIDAsync, as the Speed Editor answers it. */
class FakePanel extends EventEmitter {
  constructor({ refuse = false } = {}) {
    super();
    this.challenge = 0x0123456789abcdefn;
    this.step = null;
    this.authed = false;
    this.refuse = refuse;
    this.reads = [];
    this.written = [];
    this.closed = false;
  }
  async sendFeatureReport(data) {
    assert.equal(data[0], 6);
    this.step = data[1];
    if (this.step === 3) {
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[2 + i]);
      this.authed = !this.refuse && v === authResponse(this.challenge);
    }
    return data.length;
  }
  async getFeatureReport(id, length) {
    this.reads.push([id, length]);
    /* The real panel on macOS: IOHIDDeviceGetReport 0xE0005000 at any other length. */
    if (id !== 6 || length !== 10) throw new Error('IOHIDDeviceGetReport failed: (0xE0005000)');
    const out = Buffer.alloc(10);
    out[0] = 6;
    if (this.step === 0) {
      for (let i = 0; i < 8; i++) out[2 + i] = Number((this.challenge >> BigInt(8 * i)) & 0xffn);
    } else if (this.step === 1) {
      out[1] = 2;
    } else if (this.step === 3) {
      out[1] = this.authed ? 4 : 0;
      out[2] = 0x58; out[3] = 0x02;                   // 600 s
    }
    return out;
  }
  async write(data) { this.written.push([...data]); return data.length; }
  async close() { this.closed = true; }
  /** The panel says something — only once it has been answered. */
  press(...codes) {
    if (!this.authed) return;
    const data = Buffer.alloc(13);
    data[0] = 4;
    codes.forEach((c, i) => { data[1 + 2 * i] = c; });
    this.emit('data', data);
  }
}

function fakeHid(panels) {
  const hid = {
    present: [...panels],
    opened: [],
    async devicesAsync() {
      return hid.present.map((p, i) => ({ vendorId: VENDOR_ID, productId: PRODUCT_ID, path: `panel-${i}`, product: 'DaVinci Resolve Speed Editor', panel: p }));
    },
    HIDAsync: {
      async open(path, opts) {
        assert.equal(opts?.nonExclusive, true, 'opened shared, not seized');
        const p = hid.present[Number(path.split('-')[1])];
        hid.opened.push(p);
        return p;
      },
    },
  };
  return hid;
}

/** Enough of a plugin's server ctx to run the half. */
function fakeCtx() {
  const routes = new Map();
  const sent = [];
  const disposers = [];
  return {
    routes, sent, disposers,
    HttpError,
    log: () => {},
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

/* ------------------------------------------------------------ the link */

test('the link finds the panel, answers its challenge at the report\'s own length, and passes its reports on', async () => {
  const panel = new FakePanel();
  const link = new PanelLink({ hid: fakeHid([panel]), scanMs: 10, retryMs: 10 });
  const reports = [];
  link.on('report', (b) => reports.push([...b]));
  link.start();
  void link.want(true);
  await settle();
  assert.equal(link.state.connected, true);
  assert.equal(link.state.authed, true);
  assert.equal(link.state.lease, 600);
  assert.ok(panel.reads.every(([id, len]) => id === 6 && len === 10), `read ${JSON.stringify(panel.reads)}`);

  panel.press(0x0f);
  assert.deepEqual(reports.at(-1).slice(0, 3), [4, 0x0f, 0]);
  assert.equal(await link.write(Uint8Array.of(2, 1, 0, 0, 0)), true);
  assert.deepEqual(panel.written, [[2, 1, 0, 0, 0]]);
  await link.stop();
  assert.ok(panel.closed);
});

test('a panel that goes away is looked for again, and answered again when it comes back', async () => {
  const first = new FakePanel();
  const hid = fakeHid([first]);
  const link = new PanelLink({ hid, scanMs: 10, retryMs: 10 });
  link.start();
  void link.want(true);
  await settle();
  assert.equal(link.state.handshakes, 1);

  hid.present = [];
  first.emit('error', new Error('could not read from HID device'));
  await settle();
  assert.equal(link.state.connected, false);
  assert.equal(await link.write(Uint8Array.of(2, 0, 0, 0, 0)), false, 'nothing to write to');

  const second = new FakePanel();
  hid.present = [second];
  await settle(60);
  assert.equal(link.state.connected, true);
  assert.equal(link.state.authed, true);
  assert.equal(link.state.handshakes, 2);
  await link.stop();
});

test('a refused answer is reported and retried, and nothing is written meanwhile', async () => {
  const panel = new FakePanel({ refuse: true });
  const link = new PanelLink({ hid: fakeHid([panel]), scanMs: 10, retryMs: 10 });
  link.start();
  void link.want(true);
  await settle(50);
  assert.equal(link.state.authed, false);
  assert.match(link.state.error, /would not authenticate/);
  const attempts = panel.reads.length;
  await settle(40);
  assert.ok(panel.reads.length > attempts, 'tried again');
  assert.equal(await link.write(Uint8Array.of(2, 0, 0, 0, 0)), false);
  await link.stop();
});

/* ------------------------------------------------------------ the server */

test('only the page holding the lease writes to the panel, and another can take it over', async () => {
  const panel = new FakePanel();
  const ctx = fakeCtx();
  const { link } = createSpeedEditorServer(ctx, { hid: fakeHid([panel]), reason: null });
  await settle();
  assert.equal(link.state.present, true, 'found');
  assert.equal(link.state.connected, false, 'but not held while nobody drives it');

  assert.deepEqual((await ctx.call('POST', '/driver', { id: 'a' })).body, { driver: 'a' });
  await settle();
  assert.equal(link.state.authed, true, 'opened and answered once a page drives it');
  assert.deepEqual((await ctx.call('POST', '/driver', { id: 'b' })).body, { driver: 'a' }, 'held');
  assert.equal((await ctx.call('POST', '/output', { id: 'b', reports: [[2, 1, 0, 0, 0]] })).status, 409);
  assert.equal((await ctx.call('POST', '/output', { id: 'a', reports: [[2, 1, 0, 0, 0]] })).body.written, 1);
  assert.equal((await ctx.call('POST', '/output', { id: 'a', reports: [[2, 999]] })).status, 400);

  assert.deepEqual((await ctx.call('POST', '/driver', { id: 'b', take: true })).body, { driver: 'b' });
  assert.equal((await ctx.call('POST', '/output', { id: 'a', reports: [[2, 0, 0, 0, 0]] })).status, 409);
  panel.press(0x0f);
  const report = ctx.sent.find(([e]) => e === 'report');
  assert.deepEqual([...Buffer.from(report[1], 'base64')].slice(0, 2), [4, 0x0f]);

  assert.deepEqual((await ctx.call('POST', '/driver', { id: 'b', release: true })).body, { driver: null });
  await settle();
  assert.equal(link.state.connected, false, 'let go when the last driver does');
  assert.ok(panel.closed);
  assert.deepEqual(panel.written, [[2, 1, 0, 0, 0]]);
  await link.stop();
});

test('without node-hid the half still answers, and says why there is no panel', async () => {
  const ctx = fakeCtx();
  createSpeedEditorServer(ctx, { hid: null, reason: 'no USB in this build' });
  const state = (await ctx.call('GET', '/')).body;
  assert.equal(state.available, false);
  assert.equal(state.reason, 'no USB in this build');
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
  return b.toString('base64');
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
