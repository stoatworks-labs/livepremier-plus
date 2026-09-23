/*
 * The Speed Editor plugin's WebHID host, against a fake panel.
 *
 * The fake runs the real handshake — it issues a challenge and checks the
 * answer with the vendored `authResponse` — and says nothing until it has
 * been answered, as the hardware does. What this cannot prove is that Chrome
 * lets a page open the real one; that is the hardware check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import { authResponse, VENDOR_ID, PRODUCT_ID } from '../src/vendor/surface/hid/speed-editor.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

class FakePanel extends EventTarget {
  constructor({ idInFeature = true } = {}) {
    super();
    this.vendorId = VENDOR_ID;
    this.productId = PRODUCT_ID;
    this.productName = 'DaVinci Resolve Speed Editor';
    this.opened = false;
    this.idInFeature = idInFeature;
    this.challenge = 0x0123456789abcdefn;
    this.step = null;
    this.authed = false;
    this.reports = [];
  }
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async sendFeatureReport(id, data) {
    assert.equal(id, 6);
    this.step = data[0];
    if (this.step === 3) {
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[1 + i]);
      this.authed = v === authResponse(this.challenge);
    }
  }
  async receiveFeatureReport(id) {
    const body = new Uint8Array(9);
    if (this.step === 0) {
      for (let i = 0; i < 8; i++) body[1 + i] = Number((this.challenge >> BigInt(8 * i)) & 0xffn);
    } else if (this.step === 1) {
      body[0] = 2;
    } else if (this.step === 3) {
      body[0] = this.authed ? 4 : 0;
      body[1] = 0x58; body[2] = 0x02;                  // 600 s
    }
    const bytes = this.idInFeature ? Uint8Array.of(id, ...body) : body;
    return new DataView(bytes.buffer);
  }
  async sendReport(id, data) { this.reports.push([id, ...data]); }
  /** The panel says something — only once it has been answered. */
  press(...codes) {
    if (!this.authed) return;
    const data = new Uint8Array(12);
    codes.forEach((c, i) => { data[2 * i] = c; });
    const ev = new Event('inputreport');
    ev.reportId = 4;
    ev.data = new DataView(data.buffer);
    this.dispatchEvent(ev);
  }
}

function setup(panel) {
  const hid = new EventTarget();
  hid.getDevices = async () => [panel];
  hid.requestDevice = async () => [panel];
  Object.defineProperty(globalThis, 'navigator', { value: { hid }, configurable: true });
  globalThis.window = { isSecureContext: true, location: new URL('http://127.0.0.1:8080/') };
  globalThis.fetch = async (url) => {
    assert.match(String(url), /speed-editor\.json$/);
    const text = readFileSync(join(here, '..', 'src/vendor/surface/profiles/speed-editor.json'), 'utf8');
    return { ok: true, json: async () => JSON.parse(text) };
  };
  const store = new DeviceStore();
  store.hydrate(fixture('sim-6.2.73-screens.json'));
  const sent = [];
  const session = new EventTarget();
  session.store = store;
  session.send = (w) => { sent.push(w); return true; };
  return { session, sent };
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

for (const idInFeature of [true, false]) {
  test(`a granted panel reconnects, authenticates, and CUT writes xCut (feature report ${idInFeature ? 'with' : 'without'} its id)`, async () => {
    const panel = new FakePanel({ idInFeature });
    const { session, sent } = setup(panel);
    const { createSpeedEditorPanel } = await import(`../plugins/speed-editor/panel.js?${idInFeature}`);
    const se = createSpeedEditorPanel({ session });
    await settle();
    assert.ok(panel.opened, 'opened the granted panel without a click');
    assert.equal(se.state.authed, true, 'answered the challenge');
    assert.equal(se.state.lease, 600);

    await se.start();
    assert.deepEqual(panel.reports.slice(-3), [[2, 0, 0, 0, 0], [3, 0, 0, 0, 0, 0, 0xff], [4, 1]],
      'lamps out, wheel relative, JOG lit');

    panel.press(0x0f);                                  // CUT
    panel.press();
    await settle();
    const cut = sent.find((w) => w.path.at(-1) === 'xCut');
    assert.ok(cut, `no xCut among ${JSON.stringify(sent.map((w) => w.path.join('/')))}`);
    assert.equal(cut.value, true);
    assert.equal(cut.path.join('/'), 'device/screenAuxGroupList/items/S1/control/pp/xCut');
    se.stop();
    clearTimeout(se.state.authTimer);
  });
}

test('a panel that refuses the answer is reported, and its keys reach nothing', async () => {
  const panel = new FakePanel();
  const check = panel.sendFeatureReport.bind(panel);
  panel.sendFeatureReport = async (id, data) => { await check(id, data); if (data[0] === 3) panel.authed = false; };
  const { session, sent } = setup(panel);
  const { createSpeedEditorPanel } = await import('../plugins/speed-editor/panel.js?refused');
  const se = createSpeedEditorPanel({ session });
  await settle();
  assert.equal(se.state.authed, false);
  assert.ok(se.state.activity.some((a) => /authentication failed/.test(a.text)));
  assert.ok(se.state.authTimer, 'a retry is scheduled');
  await se.start();
  panel.press(0x0f);
  await settle();
  assert.equal(sent.length, 0);
  se.stop();
  clearTimeout(se.state.authTimer);
});
