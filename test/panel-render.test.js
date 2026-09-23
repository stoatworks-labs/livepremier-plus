/*
 * Every panel renders — against an empty store, which is how every panel
 * first renders before the switcher has answered, and against a store built
 * from the simulator's own captures.
 *
 * Found the hard way, 2026-09-23: the Timeline panel took an option called
 * `actions`, and a function of its own called `actions()` shadowed it, so the
 * first cue with a plugin's action in it threw on every render and left an
 * empty tab. Nothing caught it because nothing rendered the panel. The plugin
 * work is moving every panel into a folder of its own, which is exactly the
 * kind of change that breaks a render without breaking an import — so each
 * one is drawn here, twice (a first render, then a repaint), with the
 * dependencies `main.js` gives it.
 *
 * What this does not catch: anything that goes wrong only in a real browser —
 * layout, the vendor's stylesheet, a failed fetch's handler. It is a smoke
 * test, and the browser check is still the proof.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { install } from './helpers/fake-dom.js';
import { DeviceStore } from '../src/core/device-store.js';
import { CueStack } from '../src/core/cuestack.js';
import { detectPlatform } from '../src/core/platform.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

/** Deep-merge the simulator's capture slices into one device store. */
function merged(...names) {
  const merge = (a, b) => {
    if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b;
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
    return out;
  };
  return names.map(fixture).reduce(merge, {});
}

const STORES = {
  empty: () => new DeviceStore(),
  simulator: () => {
    const s = new DeviceStore();
    s.hydrate(merged('sim-6.2.73-identity.json', 'sim-6.2.73-screens.json', 'sim-6.2.73-destinations.json',
      'sim-6.2.73-connectors.json', 'sim-6.2.73-outputs.json', 'sim-6.2.73-resources.json',
      'sim-6.2.73-memory.json'));
    return s;
  }
};

function sessionOver(store) {
  const session = new EventTarget();
  session.store = store;
  session.state = 'live';
  session.send = () => true;
  return session;
}

/* A fetch that answers nothing useful, as a launcher that has not started would. */
const quietFetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });

async function withDom(fn) {
  const dom = install();
  const before = globalThis.fetch;
  const setIntervalBefore = globalThis.setInterval;
  globalThis.fetch = quietFetch;
  /* A page half may start a clock the way a page would — the Edit page's
     snapshot refresh does — and a page is never closed here, so the clock
     must not be what keeps this process alive after the test. */
  globalThis.setInterval = (...a) => { const t = setIntervalBefore(...a); if (t && t.unref) t.unref(); return t; };
  try {
    await fn(dom);
  } finally {
    globalThis.fetch = before;
    globalThis.setInterval = setIntervalBefore;
    dom.uninstall();
  }
}

/** Render twice, and say which panel threw if one does. */
function renders(name, panel) {
  let first;
  assert.doesNotThrow(() => { first = panel.render(); }, `${name} threw on its first render`);
  assert.ok(first && typeof first === 'object', `${name} rendered nothing`);
  assert.doesNotThrow(() => panel.render(), `${name} threw on a repaint`);
  return first;
}

const noStorage = { load: async () => null, save: async () => {} };

/** Page halves that put nothing in the sidebar or on a strip. */
const DECORATIONS = new Set(['arithmetic', 'layer-names', 'send-to']);

for (const [storeName, makeStore] of Object.entries(STORES)) {
  test(`every panel in src/ui renders against ${storeName === 'empty' ? 'an empty store' : 'the simulator’s store'}`, async () => {
    await withDom(async () => {
      const store = makeStore();
      const session = sessionOver(store);
      const platform = () => detectPlatform(store);

      const { createTimelinePanel } = await import('../plugins/timeline/panel.js');
      const { createMatrixPanel } = await import('../src/ui/matrix-panel.js');
      const { createPropertiesPanel } = await import('../src/ui/properties-panel.js');
      const { createSettingsPanel } = await import('../src/ui/settings-panel.js');

      const stack = new CueStack({ send: () => true });
      /* A plugin's action, one whose plugin is off, and a built-in one. */
      stack.add({
        number: '1', label: 'Mixed',
        actions: [
          { kind: 'matrixFeed', connector: 'input:IN_1', source: 3 },
          { kind: 'gone:away' },
          { kind: 'take', targets: ['S1'] }
        ]
      });
      const cueActions = () => [{ kind: 'matrixFeed', label: 'Route', describe: (a) => `route ${a.source}`, run() {} }];
      const timeline = createTimelinePanel({ session, stack, storage: noStorage, onRefresh() {}, cueActions });
      const drawn = renders('timeline', timeline);
      if (store.ready) {
        const cells = drawn.querySelectorAll('.wru-cue-actions').map((td) => td.textContent);
        assert.deepEqual(cells, ['route 3 · gone:away · take S1'], 'a plugin’s action in its own words, a missing one by name');
      } else {
        assert.match(drawn.textContent, /Waiting for the device store/, 'before the store arrives it says so, and lists nothing');
      }

      renders('matrix', createMatrixPanel({ session, onRefresh() {} }));
      const names = () => ({});
      const properties = createPropertiesPanel({ session, onRefresh() {}, names, onRename: null });
      renders('properties', properties);
      renders('settings', createSettingsPanel({ session, platform, onRefresh() {}, sections: () => [] }));
    });
  });

  test(`every built-in plugin’s page half renders against ${storeName === 'empty' ? 'an empty store' : 'the simulator’s store'}`, async () => {
    await withDom(async () => {
      const store = makeStore();
      const session = sessionOver(store);
      const platform = () => detectPlatform(store);
      const { KIT } = await import('../src/ui/plugin-host.js');

      const { createVpuPanel } = await import('../plugins/vpu-map/panel.js');
      const { createPitchPanel } = await import('../plugins/pitch/panel.js');
      const { createCompanionPanel } = await import('../plugins/companion/panel.js');
      renders('vpu-map', createVpuPanel({ session, platform, onRefresh() {} }));
      renders('pitch', createPitchPanel({ session, onRefresh() {} }));
      renders('companion', createCompanionPanel({
        kit: KIT, url: (p) => `/__lpp/companion${p === '/' ? '' : p}`,
        settings: { get: () => ({}), set: async () => ({}) }, onRefresh() {}
      }));

      /* The page halves themselves, through a stand-in ctx: what each
         registers must render too. Every built-in with a page half is here —
         read off the manifests, so a plugin that moves cannot be missed. */
      const { BUILTINS } = await import('../src/core/plugins.js');
      const halves = BUILTINS.filter((b) => b.client).map((b) => b.id);
      assert.ok(halves.includes('console') && halves.includes('memories'), halves.join(', '));
      for (const id of halves) {
        const { default: activate } = await import(`../plugins/${id}/client.js`);
        const registered = [];
        const ctx = {
          id, session, platform, can: () => true, refresh() {}, kit: KIT,
          url: (p = '/') => `/__lpp/${id}${p === '/' ? '' : p}`,
          settings: { get: () => ({}), set: async () => ({}) },
          contribute() {}, contributions: () => [], provide() {}, use: () => null, share() {},
          log: { info() {}, warn() {} },
          ui: {
            sidebar: (e) => registered.push(e), tab: (e) => registered.push(e),
            settingsSection: (e) => registered.push(e)
          }
        };
        await activate(ctx);
        /* Field arithmetic and the layer names decorate the vendor's own
           page, and the names are a service: neither registers an entry. */
        if (!DECORATIONS.has(id)) assert.ok(registered.length, `${id} registered nothing`);
        for (const entry of registered) renders(`${id}’s ${entry.id || 'entry'}`, entry);
      }
    });
  });
}
