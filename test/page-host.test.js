/*
 * The page's plugin host, with the server and the module loader stood in.
 *
 * What is pinned is policy rather than drawing: which plugins are loaded at
 * all, that an entry is only offered where the switcher can carry it, that a
 * plugin which throws halfway leaves nothing behind, and what a settings save
 * actually sends. None of that needs a DOM.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugins, byOrder, KIT } from '../src/ui/plugin-host.js';

/** A fake `/__lpp/plugins` and `/__lpp/settings`, recording what was sent. */
function server(plugins) {
  const sent = [];
  const fetch = async (url, init = {}) => {
    if (url === '/__lpp/plugins') return { ok: true, json: async () => ({ plugins }) };
    if (url === '/__lpp/settings') {
      const body = JSON.parse(init.body);
      sent.push(body);
      const id = Object.keys(body.plugins)[0];
      return { ok: true, json: async () => ({ settings: { plugins: { [id]: { settings: { ...body.plugins[id].settings, corrected: true } } } } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetch, sent };
}

const quiet = { info() {}, warn() {} };
const entry = (id, over = {}) => ({ id, name: id, on: true, client: `/__lpp/plugins/${id}/client.js`, base: `/__lpp/${id}`, requires: { capabilities: [], plugins: [] }, ...over });

test('only the plugins that are on, with a page half, are loaded', async () => {
  const loaded = [];
  const { fetch } = server([
    entry('one'),
    entry('off', { on: false }),
    entry('serveronly', { client: null })
  ]);
  const hosted = await loadPlugins({
    session: {}, platform: () => ({}), can: () => true, refresh() {}, settings: {},
    fetch, log: quiet,
    load: async (url) => { loaded.push(url); return { default: (ctx) => ctx.ui.sidebar({ label: 'One', render: () => null }) }; }
  });
  assert.deepEqual(loaded, ['/__lpp/plugins/one/client.js']);
  assert.deepEqual(hosted.loaded, ['one']);
  assert.equal(hosted.sidebar.length, 1);
  assert.equal(hosted.sidebar[0].id, 'one', 'an entry takes the plugin’s id unless it names its own');
});

test('an entry is offered only where the switcher has what the plugin needs', async () => {
  let vpu = false;
  const { fetch } = server([entry('map', { requires: { capabilities: ['vpuMap'], plugins: [] } })]);
  const hosted = await loadPlugins({
    session: {}, platform: () => ({}), can: (cap) => cap !== 'vpuMap' || vpu, refresh() {}, settings: {},
    fetch, log: quiet,
    load: async () => ({
      default: (ctx) => {
        ctx.ui.sidebar({ id: 'vpu', label: 'VPU Map', render: () => null });
        ctx.ui.settingsSection({ id: 'map', render: () => 'drawn' });
      }
    })
  });
  assert.equal(hosted.sidebar[0].enabled(), false);
  assert.equal(hosted.settings[0].render(), null, 'nor its settings card');
  vpu = true;
  assert.equal(hosted.sidebar[0].enabled(), true, 'asked again every time, as the store arrives');
  assert.equal(hosted.settings[0].render(), 'drawn');
});

test('a plugin that throws or will not load is left out whole, and the rest still load', async () => {
  const { fetch } = server([entry('broken'), entry('missing'), entry('shapeless'), entry('fine')]);
  const hosted = await loadPlugins({
    session: {}, platform: () => ({}), can: () => true, refresh() {}, settings: {},
    fetch, log: quiet,
    load: async (url) => {
      if (url.includes('/missing/')) throw new Error('404');
      if (url.includes('/shapeless/')) return { nothing: true };
      if (url.includes('/broken/')) {
        return { default: (ctx) => { ctx.ui.sidebar({ label: 'Half', render: () => null }); throw new Error('boom'); } };
      }
      return { default: (ctx) => ctx.ui.tab({ label: 'Fine', render: () => null }) };
    }
  });
  assert.deepEqual(hosted.loaded, ['fine']);
  assert.equal(hosted.sidebar.length, 0, 'nothing the broken one registered before it threw');
  assert.equal(hosted.tabs.length, 1);
  assert.deepEqual(hosted.failed.map((f) => f.id), ['broken', 'missing', 'shapeless']);
  assert.match(hosted.failed[0].error, /failed to start: boom/);
});

test('a plugin’s settings are read from its own entry and saved into it', async () => {
  const { fetch, sent } = server([entry('panel')]);
  let ctx = null;
  await loadPlugins({
    session: {}, platform: () => ({}), can: () => true, refresh() {},
    settings: { plugins: { panel: { enabled: true, settings: { host: 'a' } }, other: { settings: { x: 1 } } } },
    fetch, log: quiet,
    load: async () => ({ default: (c) => { ctx = c; } })
  });
  assert.deepEqual(ctx.settings.get(), { host: 'a' });
  const stored = await ctx.settings.set({ host: 'b' });
  assert.deepEqual(sent, [{ plugins: { panel: { settings: { host: 'b' } } } }], 'only its own entry, never the whole map');
  assert.deepEqual(stored, { host: 'b', corrected: true }, 'what the server stored, not what was sent');
  assert.deepEqual(ctx.settings.get(), { host: 'b', corrected: true });
  assert.equal(ctx.url('/state'), '/__lpp/panel/state');
});

test('a busy predicate that throws is not busy', async () => {
  const { fetch } = server([entry('typing'), entry('broken')]);
  let typing = false;
  const hosted = await loadPlugins({
    session: {}, platform: () => ({}), can: () => true, refresh() {}, settings: {},
    fetch, log: quiet,
    load: async (url) => ({
      default: (ctx) => ctx.ui.sidebar({
        label: 'x', render: () => null,
        busy: url.includes('/broken/') ? () => { throw new Error('no'); } : () => typing
      })
    })
  });
  assert.equal(hosted.busy(), false);
  typing = true;
  assert.equal(hosted.busy(), true);
});

test('entries sort by order, stably, with no order last', () => {
  const list = [{ id: 'a' }, { id: 'b', order: 20 }, { id: 'c', order: 10 }, { id: 'd', order: 20 }];
  assert.deepEqual(byOrder(list).map((e) => e.id), ['c', 'b', 'd', 'a']);
});

test('the kit cannot be changed under another plugin', () => {
  assert.equal(Object.isFrozen(KIT), true);
  for (const name of ['h', 'button', 'card', 'note', 'picker', 'panel']) assert.equal(typeof KIT[name], 'function', name);
});

test('a page half contributes cue actions and offers services; one that throws takes back what it added', async () => {
  const { fetch } = server([entry('giver'), entry('broken'), entry('wrongside'), entry('taker', { requires: { capabilities: [], plugins: ['giver'] } })]);
  let seen = null;
  const hosted = await loadPlugins({
    session: {}, platform: () => ({}), can: () => true, refresh() {}, settings: {},
    fetch, log: quiet,
    load: async (url) => {
      if (url.includes('/giver/')) {
        return { default: (ctx) => { ctx.contribute('cueAction', { kind: 'giver:go', label: 'Go', run() {} }); ctx.provide('clock', { now: () => 1 }); } };
      }
      if (url.includes('/broken/')) {
        return { default: (ctx) => { ctx.contribute('cueAction', { kind: 'broken:go', label: 'Go', run() {} }); throw new Error('boom'); } };
      }
      if (url.includes('/wrongside/')) {
        return { default: (ctx) => ctx.contribute('oscAddress', { prefix: '/x/', handle() {} }) };
      }
      return { default: (ctx) => { seen = { clock: ctx.use('clock'), kinds: ctx.contributions('cueAction').map((c) => c.kind) }; } };
    }
  });
  assert.deepEqual(hosted.contributions('cueAction').map((c) => c.kind), ['giver:go'], 'nothing of the broken one’s');
  assert.equal(hosted.use('clock').now(), 1);
  assert.match(hosted.failed.find((f) => f.id === 'wrongside').error, /server contribution — make it from the plugin's server\.js/);
  /* The taker needs the giver, so it started after it and could see it. */
  assert.deepEqual(seen.kinds, ['giver:go']);
  assert.equal(seen.clock.now(), 1);
});
