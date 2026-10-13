/*
 * Control surfaces, live: a MIDI fader through the mapping engine, and a
 * Speed Editor end to end — a fake USB panel inside the real device host, the
 * app's own server half holding it, the page half in Node fed by the app's
 * real event stream, and the switcher at the far end.
 *
 * Only the panel itself is a stand-in (`test/helpers/fake-speed-editor.js`,
 * which answers the handshake the way the real one does). Everything between
 * a key press and the switcher is the code that ships.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SKIP, ROOT, startApp, Link, awjGet, sag, settled, guardScreen, layerPath, sleep, sse
} from './harness.js';
import { bankLetter } from '../../src/core/properties.js';
import { Engine } from '../../src/vendor/surface/engine.js';
import speedEditorModule from '../../devices/modules/speed-editor/module.js';
import { createDeviceHost } from '../../server/device-host.js';
import { FakePanel, fakeHid, inProcessFork } from '../helpers/fake-speed-editor.js';

let app;
let link;
let guard;
let host;
let panel;
const realFetch = globalThis.fetch;
const realEventSource = globalThis.EventSource;

before(async () => {
  if (SKIP) return;
  panel = new FakePanel();
  host = createDeviceHost({ entry: 'host.js', fork: inProcessFork({ hid: fakeHid([panel]), modules: [speedEditorModule] }) });
  host.start();
  app = await startApp({ devices: host.api });
  link = await Link.open(app);
  guard = await guardScreen(link, 'S1');

  /* The page half fetches and listens same-origin; give it the app's origin. */
  globalThis.fetch = (url, init) =>
    realFetch(typeof url === 'string' && url.startsWith('/') ? app.base + url : url, init);
  globalThis.EventSource = NodeEventSource;
});

after(async () => {
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
  try { if (guard) await guard.restore(); }
  finally {
    link?.close();
    await app?.close();
    await host?.stop();
  }
});

/** Enough of `EventSource` for a page half, over the app's real stream. */
class NodeEventSource extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1;
    this.stream = sse(app.base + url, (e) => {
      const ev = new Event(e.event);
      ev.data = e.raw;
      this.dispatchEvent(ev);
      if (e.event === 'message' && typeof this.onmessage === 'function') this.onmessage(ev);
    });
  }
  close() { this.readyState = 2; this.closed = true; this.stream.close(); }
}

/** The page's session: the live store, the socket, and its frames as events. */
function pageSession() {
  const session = new EventTarget();
  session.store = link.store;
  session.state = 'live';
  session.send = (cmd) => { link.send(cmd); return true; };
  const off = link.onFrame((f) => session.dispatchEvent(new CustomEvent('frame', { detail: f })));
  return { session, off };
}

const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(25); }
  return false;
};

const preview = (...tail) => layerPath('S1', bankLetter(link.store, 'S1', 'PREVIEW').letter, 1, ...tail);

test('a MIDI fader moves the selected layer’s opacity through the mapping engine', { skip: SKIP }, async () => {
  const profile = JSON.parse(readFileSync(join(ROOT, 'src/vendor/surface/profiles/midicon-2.json'), 'utf8'));
  const engine = new Engine(link.store, profile);
  engine.addEventListener('write', (e) => link.send(e.detail.writes));
  const opacity = preview('opacity', 'pp', 'opacity');

  await settled(link);
  engine.input({ control: 'cc:0:1', kind: 'absolute', value: 1 });
  await link.waitFor(opacity, 256, { timeout: 2000 });
  engine.input({ control: 'cc:0:1', kind: 'absolute', value: 0.5 });
  const half = await link.waitFor(opacity, (v) => v > 100 && v < 160, { timeout: 2000 });
  assert.equal(await awjGet(opacity), half);
  engine.input({ control: 'cc:0:1', kind: 'absolute', value: 0 });
  await link.waitFor(opacity, 0, { timeout: 2000 });
});

test('a Speed Editor drives the switcher: CAM 3 puts IN3 on preview, CUT cuts', { skip: SKIP }, async () => {
  assert.ok(await until(() => host.api.module('speed-editor').state?.present), 'the device host found the panel');
  const state = await app.api('/speed-editor');
  assert.equal(state.status, 200, state.text);
  assert.equal(state.json.available, true);

  const { session, off } = pageSession();
  const { createSpeedEditorPanel } = await import('../../plugins/speed-editor/panel.js');
  const se = createSpeedEditorPanel({ session, url: (p) => `/__lpp/speed-editor${p === '/' ? '' : p}` });
  try {
    await se.start();
    assert.ok(await until(() => panel.authed), 'the panel was opened and answered once a page drove it');
    await sleep(300);

    await settled(link);
    const other = link.get(preview('source', 'pp', 'inputNum')) === 'LIVE_3' ? 0x36 : 0x35;   // CAM 4 or CAM 3
    const want = other === 0x35 ? 'LIVE_3' : 'LIVE_4';
    panel.press(other);
    panel.press();
    await link.waitFor(preview('source', 'pp', 'inputNum'), want, { timeout: 3000 });
    assert.equal(await awjGet(preview('source', 'pp', 'inputNum')), want);

    const from = await settled(link);
    panel.press(0x0f);   // CUT
    panel.press();
    await link.waitFor(sag('S1', 'status', 'transition'), (v) => v !== from, { timeout: 3000 });

    /* And again: the switcher leaves xCut true, and a second CUT must not be
       dropped as a repeat (it was, the first time a real panel met the
       simulator). */
    const back = await settled(link);
    panel.press(0x0f);
    panel.press();
    await link.waitFor(sag('S1', 'status', 'transition'), (v) => v !== back, { timeout: 3000 });

    /* The lamps the page lit went out to the panel. */
    assert.ok(panel.written.length > 0, 'the page wrote the panel’s lamps');
  } finally {
    se.stop();
    off();
  }
  assert.ok(await until(() => panel.closed), 'the panel is let go when no page drives it');
});
