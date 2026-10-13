/*
 * The plugins, live: the host that switches them on and off, a user plugin
 * copied in from `examples/`, the documents each built-in keeps per switcher,
 * the one-file setup, and the services that talk to something other than the
 * switcher — the thumbnail relay, Matrix Routing, HyperDecks, Dante,
 * Companion — each driven through the real app's routes.
 *
 * Almost nothing here writes to the switcher, and that is the point: these
 * features keep their state in this process and its data directory, or in a
 * deck, a router or a Dante network of their own. The switcher is asked only
 * for what they read off it — its connectors, its Dante card, its thumbnails —
 * through the proxied store or straight over AWJ. The HyperDeck and the Dante
 * network are the repo's own emulations, started in this process on loopback;
 * neither proves anything about real hardware, and both say so at the top.
 *
 * Every setting a test changes is put back before it ends, so the tests do
 * not depend on the order they run in.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';

import { SKIP, ROOT, target, startApp, Link, awjGet, sleep } from './harness.js';

import { safeDeviceKey } from '../../server/storage.js';
import { readAllConnectors } from '../../src/core/connectors.js';
import { makeCue } from '../../src/core/cuestack.js';
import { switcherCards, matchSwitcher } from '../../plugins/dante/switcher.js';
import { startHyperDeckSim } from '../../tools/hyperdeck-sim.mjs';
import { startDanteSim } from '../../tools/dante-sim.mjs';

let app;
let link;

before(async () => {
  if (SKIP) return;
  app = await startApp();
  link = await Link.open(app);
});

after(async () => {
  link?.close();
  await app?.close();
});

/** The switcher as the app names it, and as its per-switcher files are keyed. */
const DEVICE = target ? `${target.host}:${target.port}` : '';
const FILE_KEY = safeDeviceKey(DEVICE);

/** Poll until `fn` answers something truthy, or give up and say so. */
async function until(fn, { timeout = 8000, every = 100, label = 'a condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out after ${timeout} ms waiting for ${label}`);
    await sleep(every);
  }
}

const plugin = async (a, id) => (await a.api('/plugins')).json.plugins.find((p) => p.id === id);
const settingsOf = async (a) => (await a.api('/settings')).json.settings;
const exists = (file) => access(file).then(() => true, () => false);
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

/** Layer keys of one screen, as `core/groups.js` writes a member: `S1/2`. */
function layerKeys(id = 'S1', count = 2) {
  const keys = link.keys(['device', 'screenList', 'items', id, 'layerList']).map(String);
  return (keys.length ? keys : ['1', '2']).slice(0, count).map((l) => `${id}/${l}`);
}

/* ================================================================ the host */

test('the plugin list says what each plugin is, where its routes are, and which start off', { skip: SKIP }, async () => {
  const r = await app.api('/plugins');
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.json.plugins.map((p) => [p.id, p]));

  for (const p of r.json.plugins) {
    for (const k of ['id', 'name', 'description', 'where', 'builtIn', 'hosted', 'source', 'apiVersion', 'requires', 'base', 'on', 'reason', 'client']) {
      assert.ok(k in p, `${p.id} has ${k}`);
    }
    assert.equal(p.source, 'built-in');
    assert.equal(p.builtIn, true);
    assert.ok(p.apiVersion <= r.json.apiVersion, `${p.id} speaks an API this build has`);
    /* On means a page half to load; off means none is offered. */
    if (p.on) assert.equal(p.client === null || p.client.startsWith(`/__lpp/plugins/${p.id}/`), true);
    else assert.equal(p.client, null);
  }

  /* The ones that sit in front of something somebody else owns start off. */
  for (const id of ['preview-lock', 'dante', 'snapshot-relay', 'mv-slicer', 'bg-slicer']) {
    assert.equal(byId[id].on, false, `${id} is off by default`);
    assert.equal(byId[id].reason, 'switched off');
  }
  for (const id of ['timeline', 'matrix-routing', 'hyperdeck', 'companion', 'setup-file', 'variables']) {
    assert.equal(byId[id].on, true, `${id} is on by default`);
  }

  /* Routes moved into plugins kept the addresses they always had. */
  assert.equal(byId['matrix-routing'].base, '/__lpp/matrix');
  assert.equal(byId['setup-file'].base, '/__lpp/config');
  assert.equal(byId.edit.base, '/__lpp/memory');
  assert.equal(byId['osc-input'].base, '/__lpp/osc');
  assert.equal(byId.timeline.base, '/__lpp/stack');
  assert.equal(byId.hyperdeck.base, '/__lpp/hyperdeck');
  assert.deepEqual(byId.timecode.requires.plugins, ['timeline']);

  /* A running plugin's page half is served; its server half never is. */
  const client = await app.api('/plugins/hyperdeck/client.js', { raw: true });
  assert.equal(client.status, 200);
  assert.match(client.headers.get('content-type'), /javascript/);
  assert.equal((await app.api('/plugins/hyperdeck/server.js', { raw: true })).status, 404);
  /* And an off plugin's routes say so, rather than reaching the switcher. */
  const off = await app.api('/snapshot-relay/state');
  assert.equal(off.status, 404);
  assert.deepEqual(off.json, { error: 'the snapshot-relay plugin is switched off', plugin: 'snapshot-relay' });
});

test('switching a built-in off takes its routes and addresses away at once, and on brings them back', { skip: SKIP }, async (t) => {
  t.after(() => app.configure({ plugins: { hyperdeck: { enabled: true }, timeline: { enabled: true } } }));

  assert.equal((await app.api('/hyperdeck')).status, 200);
  const prefixes = async () => (await app.api('/addresses')).json.addresses.map((a) => a.prefix);
  assert.ok((await prefixes()).includes('/hyperdeck/'));

  await app.configure({ plugins: { hyperdeck: { enabled: false } } });
  const gone = await app.api('/hyperdeck');
  assert.equal(gone.status, 404);
  assert.deepEqual(gone.json, { error: 'the hyperdeck plugin is switched off', plugin: 'hyperdeck' });
  assert.equal((await app.api('/hyperdeck/command', { method: 'POST', body: { deck: '1', command: 'play' } })).status, 404);
  assert.equal((await plugin(app, 'hyperdeck')).on, false);
  assert.equal((await app.api('/plugins/hyperdeck/client.js', { raw: true })).status, 404, 'its page half goes too');
  assert.ok(!(await prefixes()).includes('/hyperdeck/'), 'its OSC addresses are withdrawn');
  const run = await app.api('/addresses/run', { method: 'POST', body: { address: '/hyperdeck/1/play' } });
  assert.equal(run.status, 404);
  assert.match(run.json.error, /no plugin answers \/hyperdeck\/1\/play/);

  await app.configure({ plugins: { hyperdeck: { enabled: true } } });
  assert.equal((await app.api('/hyperdeck')).status, 200, 'back, with no restart');
  assert.equal((await plugin(app, 'hyperdeck')).on, true);
  assert.ok((await prefixes()).includes('/hyperdeck/'));

  /* A plugin that needs another goes with it, and says which. */
  await app.configure({ plugins: { timeline: { enabled: false } } });
  const tc = await plugin(app, 'timecode');
  assert.deepEqual([tc.on, tc.reason], [false, 'needs Timeline']);
  assert.equal((await app.api('/stack')).status, 404);
  assert.equal((await app.api('/timecode')).status, 404);
  await app.configure({ plugins: { timeline: { enabled: true } } });
  assert.equal((await plugin(app, 'timecode')).on, true);
  assert.equal((await app.api('/timecode')).status, 200);
});

test('a plugin’s own settings survive it being switched off and on', { skip: SKIP }, async (t) => {
  const was = (await settingsOf(app)).plugins.companion.settings;
  t.after(() => app.configure({ plugins: { companion: { enabled: true, settings: was } } }));

  /* An address, but not "Connect": nothing dials out. */
  await app.configure({ plugins: { companion: { settings: { companionHost: 'companion.test', companionPort: 8123 } } } });
  await app.configure({ plugins: { companion: { enabled: false } } });
  assert.equal((await app.api('/companion/state')).status, 404);

  const held = (await settingsOf(app)).plugins.companion;
  assert.equal(held.enabled, false);
  assert.deepEqual(held.settings, { companionEnabled: false, companionHost: 'companion.test', companionPort: 8123 });
  const onDisk = (await app.storage.loadSettings()).plugins.companion.settings;
  assert.equal(onDisk.companionHost, 'companion.test', 'and in settings.json, not only in memory');

  await app.configure({ plugins: { companion: { enabled: true } } });
  const state = await app.api('/companion/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.settings.companionHost, 'companion.test', 'the restarted plugin reads what it had');
  assert.equal(state.json.settings.companionPort, 8123);
  assert.equal(state.json.link.configured, false, '"Connect" is still off, so there is no link');
});

/* ============================================================ user plugins */

/*
 * A plugin of nobody's, for what the example does not do: it keeps a
 * document, and importing it leaves a mark. The mark breaks the rule every
 * plugin is asked to keep — importing must do nothing — on purpose, as a
 * tripwire: it shows exactly when the host imported the file.
 */
const NOTES_MANIFEST = {
  id: 'sim-notes', name: 'Sim notes', version: '0.0.1', apiVersion: 1,
  description: 'A test fixture', server: 'server.js'
};
const NOTES_SERVER = `
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./imported', import.meta.url), 'imported');

export default function activate(ctx) {
  ctx.route('PUT', '/note', async (req, res, h) => {
    const body = await h.readJson();
    await ctx.storage.save('note', body, { perDevice: true });
    await ctx.storage.save('shared', body);
    h.json(200, { ok: true });
  });
  ctx.route('GET', '/note', async (req, res, h) => {
    h.json(200, { data: await ctx.storage.load('note', { perDevice: true }), shared: await ctx.storage.load('shared') });
  });
}
`;

async function seedUserPlugins(dir) {
  const plugins = join(dir, 'plugins');
  await cp(join(ROOT, 'examples', 'plugins', 'hello-switcher'), join(plugins, 'hello-switcher'), { recursive: true });
  await mkdir(join(plugins, 'sim-notes'), { recursive: true });
  await writeFile(join(plugins, 'sim-notes', 'plugin.json'), JSON.stringify(NOTES_MANIFEST));
  await writeFile(join(plugins, 'sim-notes', 'server.js'), NOTES_SERVER);
  /* Two folders that are not plugins, which the list must still show. */
  await mkdir(join(plugins, 'no-manifest'), { recursive: true });
  await mkdir(join(plugins, 'broken'), { recursive: true });
  await writeFile(join(plugins, 'broken', 'plugin.json'), '{ "id": "broken", ');
}

/** The first `event` on a server-sent stream, or null if none comes in time. */
async function firstEvent(url, event, timeout = 4000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      text += dec.decode(value, { stream: true });
      const m = new RegExp(`event: ${event}\\ndata: (.*)\\n\\n`).exec(text);
      if (m) return JSON.parse(m[1]);
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

test('the example plugin is listed off and unread until switched on, then answers as itself', { skip: SKIP }, async (t) => {
  const u = await startApp({ prepare: seedUserPlugins });
  t.after(() => u.close());

  const listed = await plugin(u, 'hello-switcher');
  assert.equal(listed.source, 'user');
  assert.equal(listed.builtIn, false);
  assert.equal(listed.on, false);
  assert.equal(listed.reason, 'switched off');
  assert.equal(listed.version, '1.0.0');
  assert.equal(listed.base, '/__lpp/hello-switcher');
  assert.equal(listed.dir, join(u.dir, 'plugins', 'hello-switcher'));
  assert.equal(listed.client, null);

  /* Folders that are not plugins are listed with the reason, never loaded. */
  const all = (await u.api('/plugins')).json.plugins;
  const bad = Object.fromEntries(all.filter((p) => p.invalid).map((p) => [p.id, p.reason]));
  assert.equal(bad['no-manifest'], 'plugin.json: there is none');
  assert.match(bad.broken, /^plugin\.json: it would not parse/);

  assert.deepEqual((await u.api('/hello-switcher/hello')).json,
    { error: 'the hello-switcher plugin is switched off', plugin: 'hello-switcher' });
  assert.equal((await u.api('/plugins/hello-switcher/client.js', { raw: true })).status, 404);

  /* Its settings are carried as they were typed while its schema is unread —
     which is the proof nothing of it has been imported. */
  let s = await u.configure({ plugins: { 'hello-switcher': { settings: { greeting: '  Evening  ' } } } });
  assert.equal(s.plugins['hello-switcher'].settings.greeting, '  Evening  ');

  s = await u.configure({ plugins: { 'hello-switcher': { enabled: true } } });
  assert.equal(s.plugins['hello-switcher'].settings.greeting, 'Evening', 'its own schema, read once it was imported');
  const on = await plugin(u, 'hello-switcher');
  assert.deepEqual([on.on, on.reason, on.client], [true, null, '/__lpp/plugins/hello-switcher/client.js']);
  assert.ok(u.logs.includes('hello-switcher: started'), 'activate ran');

  const hello = await u.api('/hello-switcher/hello');
  assert.equal(hello.status, 200);
  assert.deepEqual(hello.json, { greeting: 'Evening', switcher: DEVICE });
  assert.equal((await u.api('/plugins/hello-switcher/client.js', { raw: true })).status, 200);
  assert.equal((await u.api('/plugins/hello-switcher/server.js', { raw: true })).status, 404);

  const tick = await firstEvent(`${u.base}/__lpp/hello-switcher/ticks`, 'tick');
  assert.ok(tick && !Number.isNaN(Date.parse(tick.at)), 'its stream ticks');

  const addr = (await u.api('/addresses')).json.addresses.find((a) => a.prefix === '/hello/');
  assert.equal(addr.owner, 'hello-switcher');
  const ping = await u.api('/addresses/run', { method: 'POST', body: { address: '/hello/ping' } });
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.json, { ok: true, summary: `Evening, ${DEVICE}`, owner: 'hello-switcher' });
  const other = await u.api('/addresses/run', { method: 'POST', body: { address: '/hello/wave' } });
  assert.equal(other.status, 404, 'an address it does not recognise is nobody’s');

  await u.configure({ plugins: { 'hello-switcher': { settings: { greeting: 'Morning' } } } });
  assert.equal((await u.api('/hello-switcher/hello')).json.greeting, 'Morning');
  assert.ok(u.logs.includes('hello-switcher: greeting is now “Morning”'), 'it was told of the change');

  /* Off: an open stream is hung up, the routes go, and the setting stays. */
  const res = await fetch(`${u.base}/__lpp/hello-switcher/ticks`);
  const reader = res.body.getReader();
  await reader.read();
  await u.configure({ plugins: { 'hello-switcher': { enabled: false } } });
  const ended = await Promise.race([
    (async () => { for (;;) { const { done } = await reader.read(); if (done) return true; } })(),
    sleep(3000).then(() => false)
  ]);
  assert.equal(ended, true, 'switching it off ended the open stream');
  assert.equal((await u.api('/hello-switcher/hello')).status, 404);
  assert.ok(!(await u.api('/addresses')).json.addresses.some((a) => a.prefix === '/hello/'));
  assert.equal((await settingsOf(u)).plugins['hello-switcher'].settings.greeting, 'Morning');
});

test('a user plugin is imported only when switched on, and keeps its data in a folder of its own', { skip: SKIP }, async (t) => {
  const u = await startApp({ prepare: seedUserPlugins });
  t.after(() => u.close());
  const mark = join(u.dir, 'plugins', 'sim-notes', 'imported');

  assert.equal((await plugin(u, 'sim-notes')).on, false);
  assert.equal(await exists(mark), false, 'listed, and not imported');

  await u.configure({ plugins: { 'sim-notes': { enabled: true } } });
  assert.equal(await exists(mark), true, 'imported the moment it was switched on');

  const note = { text: 'stage left', at: 3 };
  assert.equal((await u.api('/sim-notes/note', { method: 'PUT', body: note })).status, 200);
  assert.deepEqual((await u.api('/sim-notes/note')).json, { data: note, shared: note });

  const own = join(u.dir, 'plugin-data', 'sim-notes');
  assert.deepEqual(await readJson(join(own, `note-${FILE_KEY}.json`)), note, 'per switcher, keyed by it');
  assert.deepEqual(await readJson(join(own, 'shared.json')), note);
  /* Not beside the app's own files, and not in its code folder, which is served. */
  assert.equal(await exists(join(u.dir, `note-${FILE_KEY}.json`)), false);
  assert.equal(await exists(join(u.dir, 'plugins', 'sim-notes', 'shared.json')), false);
});

/* =============================================== documents, per switcher */

const DOCS = () => {
  const [a, b] = layerKeys();
  return [
    { route: '/layer-names', file: 'names', data: { version: 1, names: { [a]: 'Lectern', [b]: 'IMAG wide' } } },
    { route: '/groups', file: 'groups', data: { version: 1, groups: [{ id: 'gsim', name: 'Sim pair', gang: true, members: [a, b].map((k) => ({ id: k.split('/')[0], layer: k.split('/')[1] })) }] } },
    { route: '/layer-lock', file: 'locks', data: { version: 1, locks: [a] } },
    { route: '/stack', file: 'stack', data: { version: 1, name: 'Sim suite', cues: [makeCue({ id: 'c1', number: '1', label: 'Walk-in' })] } }
  ];
};

test('each document round-trips on its own route, in a file named for the switcher', { skip: SKIP }, async (t) => {
  for (const { route, file, data } of DOCS()) {
    const before = (await app.api(route)).json.data;
    t.after(() => app.api(route, { method: 'PUT', body: { data: before } }));

    const put = await app.api(route, { method: 'PUT', body: { data } });
    assert.equal(put.status, 200, `${route}: ${put.text}`);
    assert.deepEqual((await app.api(route)).json, { data }, `${route} reads back`);
    assert.deepEqual(await readJson(join(app.dir, `${file}-${FILE_KEY}.json`)), data, `${route} is ${file}-${FILE_KEY}.json`);

    /* The bare document is taken as well as `{ data }`; a body that is not
       JSON, or no body at all, is refused rather than saved over it. */
    assert.equal((await app.api(route, { method: 'POST', body: data })).status, 200);
    assert.equal((await app.api(route, { method: 'PUT', body: '{' })).status, 400);
    assert.equal((await app.api(route, { method: 'PUT', body: '' })).status, 400);
    assert.equal((await app.api(route, { method: 'DELETE' })).status, 405);
    assert.deepEqual((await app.api(route)).json.data, data, `${route} survived the refusals`);
  }
});

test('the documents belong to one switcher: pointed at another, the app reads none of them', { skip: SKIP }, async (t) => {
  /* A throwaway app, so re-pointing hangs up nobody's socket. 192.0.2.0/24 is
     documentation space: nothing answers there, and nothing here asks it. */
  const b = await startApp();
  t.after(() => b.close());
  const names = DOCS()[0].data;
  await b.api('/layer-names', { method: 'PUT', body: { data: names } });

  assert.equal((await b.api('/device', { method: 'PUT', body: { device: '192.0.2.10:80' } })).status, 200);
  assert.equal((await b.api('/layer-names')).json.data, null);
  await b.api('/layer-names', { method: 'PUT', body: { data: { version: 1, names: { 'S1/1': 'Backup' } } } });
  assert.equal(await exists(join(b.dir, 'names-192_0_2_10_80.json')), true);

  assert.equal((await b.api('/device', { method: 'PUT', body: { device: DEVICE } })).status, 200);
  assert.deepEqual((await b.api('/layer-names')).json.data, names, 'its own names, untouched');
});

test('variables are normalised on the way in, and what is stored is what comes back', { skip: SKIP }, async (t) => {
  const before = (await app.api('/variables')).json.data;
  t.after(() => app.api('/variables', { method: 'PUT', body: { data: before } }));

  const put = await app.api('/variables', { method: 'PUT', body: { data: { variables: [
    { id: 'v-gap', name: 'gap', value: 40 },
    { name: 'GAP', value: 1 },                                   // the same name in another case
    { name: '1st', value: 2 },                                   // not a name
    { id: 'Not An Id!', name: 'wall.left', value: '  $S1.width   /  2 ' },
    'not a row'
  ] } } });
  assert.equal(put.status, 200, put.text);
  const doc = put.json.data;
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.variables.map((v) => [v.name, v.value]), [['gap', '40'], ['wall.left', '$S1.width / 2']]);
  assert.equal(doc.variables[0].id, 'v-gap', 'a usable id is kept');
  assert.match(doc.variables[1].id, /^v[a-z0-9]+$/, 'an unusable one is replaced');

  assert.deepEqual((await app.api('/variables')).json, { data: doc });
  assert.deepEqual(await readJson(join(app.dir, `variables-${FILE_KEY}.json`)), doc);
});

test('Companion memory triggers are kept per switcher and normalised', { skip: SKIP }, async (t) => {
  const before = (await app.api('/companion/triggers')).json.data;
  t.after(() => app.api('/companion/triggers', { method: 'PUT', body: { data: before } }));

  const r = await app.api('/companion/triggers', { method: 'PUT', body: { data: { memories: {
    'screen:3': [{ pageNumber: 1, row: 0, column: 2 }, { pageNumber: 0, row: 0, column: 0 }],
    'not a memory': [{ pageNumber: 1, row: 1, column: 1 }]
  } } } });
  assert.equal(r.status, 200, r.text);
  const want = { version: 1, memories: { 'screen:3': [{ pageNumber: 1, row: 0, column: 2 }] } };
  assert.deepEqual(r.json.data, want, 'page 0 and a key that names no memory are dropped');
  assert.deepEqual((await app.api('/companion/triggers')).json.data, want);
  assert.deepEqual(await readJson(join(app.dir, `companion-triggers-${FILE_KEY}.json`)), want);
});

/* ============================================================ setup file */

test('the setup file carries a show to a fresh app, skips what is switched off, and restores settings only when named', { skip: SKIP }, async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  const b = await startApp();
  t.after(() => b.close());

  const docs = DOCS();
  for (const { route, data } of docs) await a.api(route, { method: 'PUT', body: { data } });
  const vars = (await a.api('/variables', { method: 'PUT', body: { data: { variables: [{ id: 'v-gap', name: 'gap', value: 40 }] } } })).json.data;
  await a.configure({ consoleLanguage: 'mynah' });

  const exp = await a.api('/config');
  assert.equal(exp.status, 200);
  const { doc, summary } = exp.json;
  assert.equal(doc.format, 'livepremier-plus/config');
  assert.equal(doc.device.address, DEVICE);
  assert.deepEqual([...summary.sections].sort(), ['groups', 'locks', 'names', 'settings', 'stack', 'variables']);
  assert.deepEqual([summary.cues, summary.stackName, summary.groups, summary.names, summary.hasSettings], [1, 'Sim suite', 1, 2, true]);
  assert.equal(doc.installation.settings.consoleLanguage, 'mynah');

  const dl = await a.api('/config?download=1', { raw: true });
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="livepremier-plus\.json"/);
  assert.equal((await dl.json()).format, 'livepremier-plus/config');

  /* What a restore would do, asked of the app it would be done to. */
  const look = await b.api('/config/inspect', { method: 'POST', body: { doc } });
  assert.equal(look.status, 200, look.text);
  assert.equal(look.json.device, DEVICE);
  assert.ok(!look.json.defaultSections.includes('settings'), 'settings are not restored unless named');
  for (const k of ['stack', 'groups', 'names', 'locks', 'variables']) assert.ok(look.json.defaultSections.includes(k), k);
  assert.match((await b.api('/config/inspect', { method: 'POST', body: { doc: { format: 'other' } } })).json.error, /not a LivePremier Plus configuration/);
  assert.match((await b.api('/config/inspect', { method: 'POST', body: { doc: { format: doc.format, version: 1 } } })).json.error, /empty/);

  /* A section whose plugin is off is neither written nor restored. */
  await b.configure({ plugins: { 'layer-lock': { enabled: false } } });
  let r = await b.api('/config', { method: 'POST', body: { doc } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([...r.json.applied].sort(), ['groups', 'names', 'stack', 'variables']);
  assert.deepEqual([...r.json.skipped].sort(), ['locks', 'settings']);
  assert.deepEqual([r.json.remapped, r.json.reloadPages], [false, true]);
  assert.equal(await exists(join(b.dir, `locks-${FILE_KEY}.json`)), false);

  await b.configure({ plugins: { 'layer-lock': { enabled: true } } });
  r = await b.api('/config', { method: 'POST', body: { doc } });
  assert.ok(r.json.applied.includes('locks'));

  for (const { route, file, data } of docs) {
    assert.deepEqual((await b.api(route)).json.data, data, `${route} arrived`);
    assert.equal(await exists(join(b.dir, `${file}-${FILE_KEY}.json`)), true);
  }
  assert.deepEqual((await b.api('/variables')).json.data, vars);
  assert.equal((await settingsOf(b)).consoleLanguage, 'all', 'and the settings did not come with them');

  r = await b.api('/config', { method: 'POST', body: { doc, sections: ['settings'] } });
  assert.deepEqual([r.json.applied, r.json.reloadPages], [['settings'], false]);
  assert.equal((await settingsOf(b)).consoleLanguage, 'mynah', 'named, they do');

  /* Onto a backup frame at another address: written against that one. */
  r = await b.api('/config', { method: 'POST', body: { doc, sections: ['names'], device: '192.0.2.10:80' } });
  assert.deepEqual([r.json.applied, r.json.remapped], [['names'], true]);
  assert.deepEqual(await readJson(join(b.dir, 'names-192_0_2_10_80.json')), docs[0].data);
});

/* ======================================================= thumbnail relay */

const SNAP = '/api/device/snapshots/';
const isPng = (b) => b.length > 24 && b.readUInt32BE(0) === 0x89504e47;
const pngSize = (b) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });

/** Width and height off a JPEG's frame header. */
function jpegSize(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

async function grab(base, path, headers = {}) {
  const res = await fetch(base + path, { headers });
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    relay: res.headers.get('x-lpp-relay'),
    etag: res.headers.get('etag'),
    body: Buffer.from(await res.arrayBuffer())
  };
}

/*
 * The simulator draws no input thumbnails: `inputs/1` answers 404, ENOENT on a
 * PNG under the simulator's own session folder. Its timers do have them —
 * 256 × 144 and only a kilobyte or two, so at the default width a JPEG is the
 * bigger file and the relay rightly serves the PNG. The relay is set to its
 * smallest width here so there is something to shrink.
 */
test('the thumbnail relay re-encodes what it can shrink, answers 304 for a frame a page has, and steps aside when off', { skip: SKIP }, async (t) => {
  const was = (await settingsOf(app)).plugins['snapshot-relay'];
  t.after(() => app.configure({ plugins: { 'snapshot-relay': { enabled: false, settings: was.settings } } }));
  const sim = `http://${target.host}:${target.port}`;

  const candidates = ['inputs/1', 'timers/1', 'timers/2', 'timers/3', 'timers/4'];
  const direct = {};
  for (const c of candidates) direct[c] = await grab(sim, SNAP + c);
  const pngs = candidates.filter((c) => direct[c].status === 200 && isPng(direct[c].body));
  if (!pngs.length) return t.skip('the simulator serves no PNG thumbnail on any of ' + candidates.join(', '));

  /* Off: exactly what the switcher sent. */
  const off = await grab(app.base, SNAP + pngs[0]);
  assert.equal(off.relay, null);
  assert.equal(off.type, direct[pngs[0]].type);
  assert.ok(off.body.equals(direct[pngs[0]].body));

  await app.configure({ plugins: { 'snapshot-relay': { enabled: true, settings: { quality: 30, maxWidth: 128 } } } });

  for (const c of candidates.filter((x) => !pngs.includes(x))) {
    /* Not a picture: handed on as it came, status and all. */
    const r = await grab(app.base, SNAP + c);
    assert.deepEqual([r.status, r.type, r.relay], [direct[c].status, direct[c].type, 'passthrough'], c);
    assert.ok(r.body.equals(direct[c].body), `${c} body untouched`);
  }

  const served = {};
  for (const c of pngs) {
    /* The vendor cache-busts every request with the time; the relay keys on the path. */
    const r = await grab(app.base, `${SNAP}${c}?${Date.now()}`);
    const png = direct[c].body;
    assert.equal(r.status, 200, c);
    assert.equal(r.relay, 'fresh', c);
    assert.match(r.etag, /^"lpp-\d+"$/);
    if (r.type === 'image/jpeg') {
      assert.ok(r.body.length < png.length, `${c}: ${r.body.length} bytes against the switcher's ${png.length}`);
      const { width, height } = pngSize(png);
      const want = Math.min(width, 128);
      assert.deepEqual(jpegSize(r.body), { width: want, height: Math.round(height * want / width) }, `${c} scaled`);
    } else {
      /* A JPEG that would have been bigger is not served. */
      assert.equal(r.type, 'image/png', c);
      assert.ok(r.body.equals(png), `${c} is the switcher's own bytes`);
    }
    served[c] = r;
  }
  const shrunk = pngs.filter((c) => served[c].type === 'image/jpeg');
  if (!shrunk.length) return t.skip('no thumbnail on this simulator comes out smaller as a JPEG, even at 128 px');

  /* A page that already holds the frame is told so, and sent nothing. */
  const c = shrunk[0];
  const again = await grab(app.base, SNAP + c, { 'if-none-match': served[c].etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal(again.etag, served[c].etag);
  assert.ok(['shared', 'unchanged'].includes(again.relay), again.relay);
  const stale = await grab(app.base, SNAP + c, { 'if-none-match': '"lpp-0"' });
  assert.equal(stale.status, 200);
  assert.ok(stale.body.equals(served[c].body));

  const st = (await app.api('/snapshot-relay/state')).json;
  assert.ok(st.requests >= pngs.length + 2, `requests ${st.requests}`);
  assert.ok(st.encoded >= pngs.length, 'every PNG went through the encoder');
  assert.equal(st.passthrough, candidates.length - pngs.length, 'and nothing else did');
  const source = st.sources.find((s) => s.path === c);
  assert.deepEqual([source.type, source.bytesIn, source.bytesOut], ['image/jpeg', direct[c].body.length, served[c].body.length]);

  /* Off again: the next request goes to the switcher as it always did. */
  await app.configure({ plugins: { 'snapshot-relay': { enabled: false } } });
  const after = await grab(app.base, SNAP + c);
  assert.deepEqual([after.relay, after.type], [null, direct[c].type]);
  assert.ok(after.body.equals(direct[c].body));
  assert.equal((await app.api('/snapshot-relay/state')).status, 404);
});

/*
 * `relay.get` counts the frame into `bytesOut` before `server.js` decides the
 * page already has it and answers 304 with no body, so the settings card's
 * "To the pages" rate and its "saved" share count a revalidated frame as sent
 * in full. Nothing in the app sends `If-None-Match` today (the relay answers
 * `no-store`), so only an outside caller sees it.
 */
test('a 304 is not counted as a frame sent to the pages', {
  skip: SKIP,
  todo: 'relay.js counts bytesOut in get() before server.js answers 304 with no body'
}, async (t) => {
  const was = (await settingsOf(app)).plugins['snapshot-relay'];
  t.after(() => app.configure({ plugins: { 'snapshot-relay': { enabled: false, settings: was.settings } } }));
  const sim = `http://${target.host}:${target.port}`;
  let path = null;
  for (const c of ['timers/1', 'timers/2', 'timers/3', 'timers/4', 'inputs/1']) {
    const d = await grab(sim, SNAP + c);
    if (d.status === 200 && isPng(d.body)) { path = SNAP + c; break; }
  }
  if (!path) return t.skip('the simulator serves no PNG thumbnail to revalidate');

  await app.configure({ plugins: { 'snapshot-relay': { enabled: true } } });
  const first = await grab(app.base, path);
  assert.ok(first.etag, 'the relay tagged the frame');
  const before = (await app.api('/snapshot-relay/state')).json.bytesOut;
  const again = await grab(app.base, path, { 'if-none-match': first.etag });
  assert.equal(again.status, 304);
  const after = (await app.api('/snapshot-relay/state')).json.bytesOut;
  assert.equal(after - before, again.body.length, `counted ${after - before} bytes for a 304 that sent none`);
});

/* ========================================================= matrix routing */

test('Matrix Routing: a placeholder router, patched to the switcher’s real connectors, routed by route and by OSC', { skip: SKIP }, async (t) => {
  const { input, output } = readAllConnectors(link.store);
  const inp = input.find((x) => x.index === 5) || input[0];
  const out = output.find((x) => x.index === 2) || output[0];
  if (!inp || !out) return t.skip('the switcher reports no fitted input or output');

  const empty = (await app.api('/matrix')).json;
  t.after(async () => {
    await app.api('/matrix/patch', { method: 'PUT', body: { patch: [] } });
    await app.api('/matrix', { method: 'PUT', body: { matrices: [] } });
    const now = (await app.api('/matrix')).json;
    assert.deepEqual([now.matrices, now.patch, now.routing], [[], [], {}], 'put back as it was');
  });
  assert.deepEqual([empty.matrices, empty.patch, empty.routing], [[], [], {}]);

  const put = await app.api('/matrix', { method: 'PUT', body: { matrices: [
    { id: 'Sim Router', kind: 'placeholder', inputs: 16, outputs: 16, host: 'ignored.test', port: 9990 }
  ] } });
  assert.equal(put.status, 200, put.text);
  const router = put.json.matrices[0];
  assert.deepEqual([router.id, router.status, router.placeholder], ['sim-router', 'connected', true]);
  assert.deepEqual(put.json.routing['sim-router'][3], 3, 'factory routing: output n from input n');

  /* Switcher input ← router output 3; switcher output → router input 5. */
  const patched = await app.api('/matrix/patch', { method: 'PUT', body: { patch: [
    { side: 'input', key: inp.key, matrix: 'sim-router', port: 3, note: 'from the router' },
    { side: 'output', key: out.key, matrix: 'sim-router', port: 5 }
  ] } });
  assert.equal(patched.status, 200, patched.text);
  assert.deepEqual(patched.json.patch.map((e) => [e.side, e.key, e.routerSide, e.port]),
    [['input', inp.key, 'output', 3], ['output', out.key, 'input', 5]]);
  assert.deepEqual(patched.json.problems, []);
  assert.deepEqual(await readJson(join(app.dir, `patch-${FILE_KEY}.json`)), { entries: patched.json.patch }, 'the patch is per switcher');

  const routing = async () => (await app.api('/matrix')).json.routing['sim-router'];

  let r = await app.api('/matrix/feed', { method: 'POST', body: { connector: inp.id, source: 7 } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.crosspoints, [{ matrix: 'sim-router', output: 3, input: 7 }]);
  assert.deepEqual(r.json.results, [{ matrix: 'sim-router', ok: true, sent: 1 }]);
  assert.equal((await routing())[3], 7);

  r = await app.api('/matrix/send', { method: 'POST', body: { connector: out.id, destinations: [1, 2, 2] } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.crosspoints.map((x) => [x.output, x.input]), [[1, 5], [2, 5]], 'a destination named twice is routed once');

  r = await app.api('/matrix/route', { method: 'POST', body: { matrix: 'sim-router', output: 9, input: 11 } });
  assert.equal(r.status, 200, r.text);
  const table = await routing();
  assert.deepEqual([table[1], table[2], table[3], table[9]], [5, 5, 7, 11]);

  /* Refusals name the reason. */
  r = await app.api('/matrix/feed', { method: 'POST', body: { connector: out.id, source: 1 } });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /is an output — an output is sent, not fed/);
  r = await app.api('/matrix/feed', { method: 'POST', body: { connector: 'input:IN_999', source: 1 } });
  assert.match(r.json.error, /not patched to a matrix/);
  assert.equal((await app.api('/matrix/route', { method: 'POST', body: { matrix: 'sim-router', output: 0, input: 1 } })).status, 400);
  r = await app.api('/matrix/route', { method: 'POST', body: { matrix: 'nobody', output: 1, input: 1 } });
  assert.deepEqual([r.status, r.json.results[0].error], [409, 'no such matrix']);

  /* The same, as OSC — the path a Console line and a QLab packet both take. */
  const osc = (address, args) => app.api('/addresses/run', { method: 'POST', body: { address, args } });
  r = await osc(`/lp/matrix/input/${inp.index}/source`, [12]);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, summary: `feed input ${inp.index} from sim-router input 12`, count: 1, owner: 'matrix-routing' });
  r = await osc(`/lp/matrix/output/${out.index}/destinations`, ['10-11']);
  assert.equal(r.json.summary, `send output ${out.index} to sim-router outputs 10, 11`);
  r = await osc('/lp/matrix/sim-router/route/4', [2]);
  assert.equal(r.status, 200, r.text);
  r = await osc('/lp/matrix/input/99/source', [1]);
  assert.deepEqual([r.status, r.json.ok, r.json.error], [409, false, 'switcher input 99 is not patched to a matrix']);
  const after = await routing();
  assert.deepEqual([after[3], after[10], after[11], after[4]], [12, 5, 5, 2]);

  /* A placeholder's routing is the show's plan, saved into its configuration. */
  const plan = await until(async () => {
    const m = (await readJson(join(app.dir, 'matrices.json'))).matrices[0];
    return m && m.plan && m.plan['4'] === 2 && m.plan;
  }, { label: 'the plan to be saved' });
  assert.deepEqual([plan['1'], plan['3'], plan['9'], plan['10']], [5, 12, 11, 5]);
  assert.equal(plan['5'], undefined, 'factory routing is not part of the plan');
});

/* ============================================================== HyperDeck */

test('HyperDecks: a deck on loopback, played, stopped and cued by route and by OSC', { skip: SKIP }, async (t) => {
  const deck = await startHyperDeckSim({ port: 0 });
  t.after(async () => {
    await app.api('/hyperdeck', { method: 'PUT', body: { decks: [] } });
    await deck.close();
  });

  const put = await app.api('/hyperdeck', { method: 'PUT', body: { decks: [{ name: 'Opener deck', host: '127.0.0.1', port: deck.port }] } });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.decks[0].id, 'opener-deck');
  await until(async () => (await app.api('/hyperdeck')).json.live[0]?.status === 'connected', { label: 'the deck to connect' });

  const cmd = (body) => app.api('/hyperdeck/command', { method: 'POST', body });
  let r = await cmd({ deck: 'opener-deck', command: 'clip', clip: 2 });
  assert.equal(r.status, 200, r.text);
  assert.equal(deck.state.clip, 2);
  r = await cmd({ deck: 'Opener deck', command: 'play' });
  assert.equal(r.status, 200, r.text);
  assert.equal(deck.state.status, 'play');
  /* The deck reports back, and the app shows what it says rather than what was sent. */
  await until(async () => (await app.api('/hyperdeck')).json.live[0].transport.status === 'play', { label: 'the deck to report play' });
  r = await cmd({ deck: '1', command: 'stop' });
  assert.equal(deck.state.status, 'stopped');

  r = await cmd({ deck: 'opener-deck', sequence: [{ command: 'clip', clip: 3 }, { command: 'play', single: true }] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([deck.state.clip, deck.state.single, deck.state.status], [3, true, 'play']);

  r = await cmd({ deck: 'nobody', command: 'play' });
  assert.deepEqual([r.status, r.json.error], [409, 'no deck “nobody”']);
  r = await cmd({ deck: 'opener-deck', command: 'eject' });
  assert.deepEqual([r.status, r.json.error], [409, 'no command “eject”']);

  const osc = (address, args) => app.api('/addresses/run', { method: 'POST', body: { address, args } });
  r = await osc('/hyperdeck/opener-deck/stop');
  assert.deepEqual([r.status, r.json.summary, r.json.owner], [200, 'opener-deck stop', 'hyperdeck']);
  assert.equal(deck.state.status, 'stopped');
  r = await osc('/hyperdeck/1/clip', [1]);
  assert.equal(deck.state.clip, 1);
  /* A surface's release (0) does nothing, or one press would act twice. */
  r = await osc('/hyperdeck/1/play', [0]);
  assert.deepEqual([r.status, r.json.count, deck.state.status], [200, 0, 'stopped']);
  r = await osc('/hyperdeck/all/play', [1]);
  assert.deepEqual([r.status, deck.state.status, deck.state.loop], [200, 'play', true]);
  r = await osc('/hyperdeck/players/stop');
  assert.equal(deck.state.status, 'stopped');

  /* Taken out of the list, the deck is hung up. */
  await app.api('/hyperdeck', { method: 'PUT', body: { decks: [] } });
  await until(() => deck.clients.size === 0, { label: 'the deck to be hung up' });
});

/* ================================================================== Dante */

test('Dante: the simulated network found and routed through the app, and the switcher’s own card matched', { skip: SKIP }, async (t) => {
  const was = (await settingsOf(app)).plugins.dante;
  const sim = await startDanteSim({ mdnsPort: 0, settleMs: 300 });
  t.after(async () => {
    await app.configure({ plugins: { dante: { enabled: was.enabled ?? false, settings: was.settings } } });
    await sim.close();
  });

  /* The target first, in the same save: switched on with none, it would ask
     the show network. */
  await app.configure({ plugins: { dante: { enabled: true, settings: { discoveryTarget: sim.target, pollSeconds: 1 } } } });
  const devices = await until(async () => {
    const d = (await app.api('/dante')).json.devices;
    return d.filter((x) => x.status === 'ok').length === 5 && d;
  }, { timeout: 15000, label: 'five Dante devices to be read' });
  const aql = devices.find((d) => d.name === 'AQL-Simulator');
  assert.ok(aql, 'the switcher’s card is on the simulated network');
  assert.deepEqual([aql.rx.length, aql.tx.length], [64, 64]);

  /* The switcher's side: its card, as its own store reports it, and over AWJ. */
  const cards = switcherCards(link.store);
  assert.equal(cards.length, 1, 'one frame with a card');
  assert.equal(cards[0].name, await awjGet(['device', 'system', 'deviceList', 'items', '1', 'dante', 'status', 'pp', 'id']));
  const matched = matchSwitcher(devices, cards);
  assert.deepEqual([matched.get('AQL-Simulator')?.frame, matched.get('AQL-Simulator')?.by], ['1', 'name']);
  const byMac = matchSwitcher(devices.map((d) => (d === aql ? { ...d, name: 'renamed' } : d)), cards);
  assert.equal(byMac.get('renamed')?.by, 'MAC', 'and by its MAC when the name differs');

  const writes = () => sim.device('AQL-Simulator').received.filter((x) => [0x3010, 0x3014, 0x3410].includes(x.opcode)).length;
  const route = { rx: '3@AQL-Simulator', tx: 'Aux 1@FOH-Desk' };

  const dry = await app.api('/dante/apply', { method: 'POST', body: { dryRun: true, routes: [route] } });
  assert.equal(dry.status, 200, dry.text);
  assert.deepEqual([dry.json.dryRun, dry.json.results[0].outcome, dry.json.summary], [true, 'change', '1 to change']);
  assert.equal(writes(), 0, 'a dry run sends nothing');

  const real = await app.api('/dante/apply', { method: 'POST', body: { routes: [route] } });
  assert.equal(real.status, 200, real.text);
  assert.equal(real.json.results[0].outcome, 'confirmed', 'read back, not assumed');
  assert.deepEqual(real.json.results[0].now, { channel: 'Aux 1', device: 'FOH-Desk' });
  assert.equal(writes(), 1);
  const ch3 = async () => (await app.api('/dante')).json.devices.find((d) => d.name === 'AQL-Simulator').rx[2];
  assert.equal((await ch3()).sub.channel, 'Aux 1');
  await until(async () => (await ch3()).status.name === 'DYNAMIC', { label: 'the subscription to settle on a later poll' });

  /* Applying it again changes nothing, and says so. */
  const same = await app.api('/dante/apply', { method: 'POST', body: { routes: [route] } });
  assert.deepEqual([same.status, same.json.results[0].outcome, writes()], [200, 'same', 1]);

  const osc = await app.api('/addresses/run', { method: 'POST', body: { address: '/lp/dante/clear/AQL-Simulator/3', args: [] } });
  assert.deepEqual([osc.status, osc.json.owner, osc.json.summary], [200, 'dante', 'Dante: 1 confirmed']);
  assert.equal((await ch3()).sub, null);

  /* Off: the routes go and the polling stops. */
  await app.configure({ plugins: { dante: { enabled: false } } });
  assert.equal((await app.api('/dante')).status, 404);
  const heard = sim.device('AQL-Simulator').received.length;
  await sleep(2500);
  assert.equal(sim.device('AQL-Simulator').received.length, heard, 'nothing asked the network after it was switched off');
});

/* ============================================================== Companion */

const answers = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const s = net.connect({ port, host });
  s.setTimeout(500);
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('timeout', () => { s.destroy(); resolve(false); });
  s.once('error', () => resolve(false));
});

test('Companion with none configured: its state answers and its actions say why they cannot', { skip: SKIP }, async () => {
  const s = await app.api('/companion/state');
  assert.equal(s.status, 200);
  assert.deepEqual(s.json.link, { configured: false, connected: false, error: null, version: null });
  assert.equal(s.json.settings.companionEnabled, false);
  assert.deepEqual([s.json.connections, s.json.plan, s.json.error], [null, null, null]);
  assert.equal(s.json.facts.device, DEVICE);
  assert.equal(s.json.facts.selfIsLoopback, true, 'the page arrived on loopback, and the panel is told so');
  assert.ok(s.json.modules.awj && s.json.modules.lpp);

  const conn = await app.api('/companion/connections', { method: 'POST', body: {} });
  assert.deepEqual([conn.status, conn.json], [409, { error: 'no Companion configured' }]);
  const press = await app.api('/companion/press', { method: 'POST', body: { location: { pageNumber: 1, row: 0, column: 0 } } });
  assert.deepEqual([press.status, press.json], [409, { error: 'no Companion configured' }]);
  const nowhere = await app.api('/companion/press', { method: 'POST', body: {} });
  assert.equal(nowhere.status, 400, 'a press with no button is the caller’s mistake, whatever is configured');
  const ui = await app.api('/companion/ui/');
  assert.deepEqual([ui.status, ui.json], [503, { error: 'no Companion configured' }]);
});

test('Companion on 127.0.0.1:8000: the link comes up and reads the show', { skip: SKIP }, async (t) => {
  if (!(await answers(8000))) {
    return t.skip('nothing answers on 127.0.0.1:8000 — the link, the show and a press need a running Companion');
  }
  /* Read only, even then: adding connections or pressing buttons on
     somebody's running Companion is not this suite's business. */
  const was = (await settingsOf(app)).plugins.companion.settings;
  t.after(() => app.configure({ plugins: { companion: { settings: was } } }));
  await app.configure({ plugins: { companion: { settings: { companionEnabled: true, companionHost: '127.0.0.1', companionPort: 8000 } } } });
  const s = await until(async () => {
    const st = (await app.api('/companion/state')).json;
    return st.link.connected && st;
  }, { timeout: 10000, label: 'the Companion link' });
  assert.ok(Array.isArray(s.connections), s.error || 'a connection list');
  assert.ok(s.plan);
});

/* ===================================== remote access, devices, Pixelhue */

test('remote access, the device host and the Pixelhue panel report absent rather than throw', { skip: SKIP }, async () => {
  const ra = await app.api('/remote-access/state');
  assert.equal(ra.status, 200, ra.text);
  assert.equal(ra.json.appliance, false);
  assert.deepEqual(ra.json.settings, { tailscale: 'off', httpsPort: 443, zerotier: false });
  /* Both off, so neither tool is even asked. */
  assert.deepEqual([ra.json.tailscale, ra.json.zerotier, ra.json.doors], [null, null, []]);

  /* Membership is the host's owner's, not a web page's. */
  for (const p of ['/tailscale/up', '/tailscale/down', '/tailscale/rename', '/zerotier/join', '/zerotier/leave']) {
    const r = await app.api('/remote-access' + p, { method: 'POST', body: { authKey: 'tskey-nothing', network: '0123456789abcdef', name: 'x' } });
    assert.equal(r.status, 403, p);
    assert.match(r.json.error, /not started as an appliance/);
  }

  const dev = await app.api('/devices');
  assert.equal(dev.status, 200);
  assert.deepEqual([dev.json.installed, dev.json.running, typeof dev.json.reason], [false, false, 'string']);
  const restart = await app.api('/devices/restart', { method: 'POST', body: {} });
  assert.deepEqual([restart.status, restart.json.error], [409, dev.json.reason]);

  const ph = await app.api('/pixelhue/state');
  assert.equal(ph.status, 200);
  assert.deepEqual([ph.json.preview, ph.json.configured, ph.json.host, ph.json.link], [true, false, null, null]);
});
