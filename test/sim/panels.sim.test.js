/*
 * Every panel, drawn against the live switcher's store.
 *
 * `test/panel-render.test.js` draws them against slices of a recorded store.
 * This draws them against whatever the simulator reports today — all of it,
 * 120-odd MB — then again after a real take has moved the store under them,
 * over the same stand-in DOM. Drawing must never write: the session here
 * counts sends rather than making them, and the count must stay at nought.
 *
 * It exists because a simulator can report what no fixture has: the rack's
 * reports a fully fitted VPU, which the VPU map had never been drawn with.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { SKIP, startApp, Link, settled, take, guardScreen } from './harness.js';
import { install } from '../helpers/fake-dom.js';
import { detectPlatform } from '../../src/core/platform.js';
import { CueStack } from '../../src/core/cuestack.js';

let app;
let link;
let guard;

before(async () => {
  if (SKIP) return;
  app = await startApp();
  link = await Link.open(app);
  guard = await guardScreen(link, 'S1');
});

after(async () => {
  try { if (guard) await guard.restore(); }
  finally {
    link?.close();
    await app?.close();
  }
});

const quietFetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });

async function withDom(fn) {
  const dom = install();
  const fetchBefore = globalThis.fetch;
  const intervalBefore = globalThis.setInterval;
  globalThis.fetch = quietFetch;
  globalThis.setInterval = (...a) => { const t = intervalBefore(...a); if (t && t.unref) t.unref(); return t; };
  try { await fn(dom); }
  finally {
    globalThis.fetch = fetchBefore;
    globalThis.setInterval = intervalBefore;
    dom.uninstall();
  }
}

/** The page's session over the live store, counting what it would send. */
function drawingSession() {
  const session = new EventTarget();
  session.store = link.store;
  session.state = 'live';
  session.sent = [];
  session.send = (cmd) => { session.sent.push(cmd); return true; };
  return session;
}

function renders(name, panel) {
  let first;
  assert.doesNotThrow(() => { first = panel.render(); }, `${name} threw on its first render`);
  assert.ok(first && typeof first === 'object', `${name} rendered nothing`);
  assert.doesNotThrow(() => panel.render(), `${name} threw on a repaint`);
  return first;
}

const DECORATIONS = new Set(['arithmetic', 'layer-names', 'send-to', 'edid-mosaic', 'edid']);

async function drawEverything(session) {
  const platform = () => detectPlatform(session.store);
  const { KIT } = await import('../../src/ui/plugin-host.js');
  const { BUILTINS } = await import('../../src/core/plugins.js');
  const drawn = {};

  const { createTimelinePanel } = await import('../../plugins/timeline/panel.js');
  const { createPropertiesPanel } = await import('../../src/ui/properties-panel.js');
  const { createSettingsPanel } = await import('../../src/ui/settings-panel.js');
  const { createVpuPanel } = await import('../../plugins/vpu-map/panel.js');
  const { createPitchPanel } = await import('../../plugins/pitch/panel.js');
  const stack = new CueStack({ send: () => true });
  stack.add({ number: '1', label: 'Take', actions: [{ kind: 'take', targets: ['S1'] }] });
  const noStorage = { load: async () => null, save: async () => {} };
  drawn.timeline = renders('timeline', createTimelinePanel({ session, stack, storage: noStorage, onRefresh() {}, cueActions: () => [] }));
  drawn.properties = renders('properties', createPropertiesPanel({ session, onRefresh() {}, names: () => ({}), onRename: null }));
  drawn.settings = renders('settings', createSettingsPanel({ session, platform, onRefresh() {}, sections: () => [] }));
  drawn.vpu = renders('vpu-map', createVpuPanel({ session, platform, onRefresh() {} }));
  drawn.pitch = renders('pitch', createPitchPanel({ session, onRefresh() {} }));

  for (const id of BUILTINS.filter((b) => b.client).map((b) => b.id)) {
    const { default: activate } = await import(`../../plugins/${id}/client.js`);
    const registered = [];
    await activate({
      id, session, platform, can: () => true, refresh() {}, kit: KIT,
      url: (p = '/') => `/__lpp/${id}${p === '/' ? '' : p}`,
      settings: { get: () => ({}), set: async () => ({}) },
      contribute() {}, contributions: () => [], provide() {}, use: () => null, share() {},
      log: { info() {}, warn() {} },
      ui: { sidebar: (e) => registered.push(e), tab: (e) => registered.push(e), settingsSection: (e) => registered.push(e) }
    });
    if (!DECORATIONS.has(id)) assert.ok(registered.length, `${id} registered nothing`);
    for (const entry of registered) drawn[`${id}/${entry.id || 'entry'}`] = renders(`${id}’s ${entry.id || 'entry'}`, entry);
  }
  return drawn;
}

test('every panel and page half draws against the live store, and again after a take', { skip: SKIP }, async () => {
  await withDom(async () => {
    const session = drawingSession();
    const drawn = await drawEverything(session);
    assert.ok(Object.keys(drawn).length > 20, `${Object.keys(drawn).length} drawn`);

    /* Move the store under them: a real take, then draw it all again. */
    await settled(link);
    await take(link);
    await drawEverything(session);
    await take(link);

    assert.deepEqual(session.sent.map((c) => c.path.join('/')), [], 'drawing sent nothing');
  });
});

test('the VPU map draws the simulator’s mixers when it reports them, and says why when it does not', { skip: SKIP }, async () => {
  await withDom(async () => {
    const session = drawingSession();
    const platform = () => detectPlatform(session.store);
    const { createVpuPanel } = await import('../../plugins/vpu-map/panel.js');
    const text = renders('vpu-map', createVpuPanel({ session, platform, onRefresh() {} })).textContent;
    const mixers = link.get(['device', 'preconfig', 'resources', 'current', 'status', 'mapping', 'deviceList', 'items', '1', 'vpuMixerList', 'items']);
    if (mixers) {
      assert.doesNotMatch(text, /no VPU/i, 'a fitted VPU is not called absent');
      const all = Object.values(mixers);
      const fitted = all.filter((m) => m.pp.isAvailable).length;
      assert.match(text, new RegExp(`Fitted\\s*${fitted} of ${all.length}`), 'the fitted count is the device’s');
      for (const [name, m] of Object.entries(mixers)) {
        if (m.pp.isEnabled) assert.ok(text.includes(name), `${name}, in use for ${m.pp.usedInScreen}, is drawn`);
      }
    } else {
      assert.match(text, /simulator/i);
    }
    assert.equal(session.sent.length, 0, 'the VPU panel never writes');
  });
});
