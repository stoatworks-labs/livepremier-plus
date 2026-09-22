/*
 * The server's plugin host, against plugins written to a temporary folder.
 *
 * Real modules imported from disk and real HTTP rather than mocks, because the
 * things worth pinning are lifetimes: a plugin switched off must leave nothing
 * answering — no route, no stream, no relayed socket — and one switched on
 * again must start from nothing. A mocked request would agree with whatever
 * the host did.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { createPluginHost, HttpError } from '../server/plugin-host.js';
import { withDefaults } from '../src/core/plugins.js';
import { normalise as normaliseSettings, mergeSettings, liftLegacy } from '../src/core/settings.js';

/** Write plugin folders: `{ id: { 'server.js': source, … } }`. */
async function pluginsOnDisk(tree) {
  const root = await mkdtemp(join(tmpdir(), 'lpp-plugins-'));
  for (const [id, files] of Object.entries(tree)) {
    await mkdir(join(root, id), { recursive: true });
    for (const [name, body] of Object.entries(files)) await writeFile(join(root, id, name), body);
  }
  return root;
}

const manifest = (over) => withDefaults({ name: over.id, description: '', where: '', server: 'server.js', ...over });

/** A server that does what the proxy does with its namespace, and nothing else. */
async function serve(host) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const rest = url.pathname.slice('/__lpp'.length) || '/';
    if (rest === '/plugins') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(host.list()));
    }
    if (await host.serveFile(rest, res)) return;
    if (await host.handle(req, res, url, rest)) return;
    res.writeHead(404).end('core');
  });
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url, 'http://localhost').pathname.slice('/__lpp'.length);
    if (!host.upgrade(req, socket, head, path)) socket.destroy();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function withHost({ tree, manifests, settings = { plugins: {} }, ...opts }, fn) {
  const dir = await pluginsOnDisk(tree);
  const logs = [];
  const host = await createPluginHost({
    root: dir, manifests, dirOf: (m) => join(dir, m.id), log: (m) => logs.push(m),
    device: () => '10.1.2.3:80', ...opts
  });
  await host.sync(normaliseSettings(settings, host.schemas));
  const { server, base } = await serve(host);
  try {
    await fn({ host, base, logs, dir, schemas: host.schemas });
  } finally {
    await host.stop();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
}

/* A plugin that counts its lives, so a restart is visible from outside. */
const HELLO = `
globalThis.__hello = globalThis.__hello || { starts: 0, stops: 0, changes: [] };
export const settings = {
  normalise: (raw) => ({ level: Number.isInteger(raw.level) ? raw.level : 1, label: String(raw.label || '') }),
  changed: (a, b) => a.level !== b.level,
  legacy: ['level'],
};
export default function activate(ctx) {
  globalThis.__hello.starts++;
  ctx.onDispose(() => { globalThis.__hello.stops++; });
  ctx.settings.onChange((next, prev) => globalThis.__hello.changes.push([prev.level, next.level]));
  ctx.route('GET', '/hi', (req, res, h) => h.json(200, { hi: true, level: ctx.settings.get().level, url: ctx.url('/hi') }));
  ctx.route('POST', '/echo', async (req, res, h) => h.json(200, await h.readJson()));
  ctx.mount('/files', (req, res, { rest }) => { res.writeHead(200); res.end('below:' + rest); });
  const ticks = ctx.stream('/stream', { onOpen: (first) => first.send('hello', { n: 0 }) });
  ctx.route('POST', '/tick', (req, res, h) => { ticks.send('tick', { n: 1 }); h.json(200, { listeners: ticks.size }); });
  ctx.upgrade('/ws', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n');
    return { socket, upstream: null };
  });
}
`;

test('a plugin is started from its server half and answers under its own base', async () => {
  globalThis.__hello = undefined;
  await withHost({ tree: { hello: { 'server.js': HELLO } }, manifests: [manifest({ id: 'hello' })] }, async ({ base }) => {
    const hi = await (await fetch(base + '/__lpp/hello/hi')).json();
    assert.deepEqual(hi, { hi: true, level: 1, url: '/__lpp/hello/hi' });

    const echo = await fetch(base + '/__lpp/hello/echo', { method: 'POST', body: '{"a":1}' });
    assert.deepEqual(await echo.json(), { a: 1 });

    const bad = await fetch(base + '/__lpp/hello/echo', { method: 'POST', body: '{nope' });
    assert.equal(bad.status, 400, 'a malformed body is the caller’s fault');

    /* A mount gets everything below it, query string included. */
    assert.equal(await (await fetch(base + '/__lpp/hello/files/a/b?c=1')).text(), 'below:/a/b?c=1');

    /* The right address under the wrong method says so. */
    assert.equal((await fetch(base + '/__lpp/hello/hi', { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(base + '/__lpp/hello/nothing')).status, 404);
    /* And a path that is nobody's is left for the app's own routes. */
    assert.equal(await (await fetch(base + '/__lpp/elsewhere')).text(), 'core');
  });
});

test('a handler that throws answers for itself and takes nothing else down', async () => {
  const tree = {
    oops: {
      'server.js': `
        export default function activate(ctx) {
          ctx.route('GET', '/boom', () => { throw new Error('kaboom'); });
          ctx.route('GET', '/fine', (req, res, h) => h.json(200, { ok: true }));
        }`
    }
  };
  await withHost({ tree, manifests: [manifest({ id: 'oops' })] }, async ({ base, logs }) => {
    const boom = await fetch(base + '/__lpp/oops/boom');
    assert.equal(boom.status, 500);
    assert.match((await boom.json()).error, /kaboom/);
    assert.ok(logs.some((l) => /oops: GET \/boom: kaboom/.test(l)), 'logged as the plugin’s own fault');
    assert.equal((await fetch(base + '/__lpp/oops/fine')).status, 200);
  });
});

test('an HttpError from a handler answers with its own status', async () => {
  const tree = {
    tea: {
      'server.js': `
        export default function activate(ctx) {
          ctx.route('GET', '/pot', () => { throw new ctx.HttpError(418, 'short and stout'); });
        }`
    }
  };
  await withHost({ tree, manifests: [manifest({ id: 'tea' })] }, async ({ base, logs }) => {
    const res = await fetch(base + '/__lpp/tea/pot');
    assert.equal(res.status, 418);
    assert.equal((await res.json()).error, 'short and stout');
    assert.equal(logs.filter((l) => /short and stout/.test(l)).length, 0, 'a 4xx is not logged as a fault');
  });
  assert.ok(new HttpError(409, 'x') instanceof Error);
});

test('switching a plugin off takes down its routes, streams and sockets at once; on starts it fresh', async () => {
  globalThis.__hello = undefined;
  await withHost({ tree: { hello: { 'server.js': HELLO } }, manifests: [manifest({ id: 'hello' })] }, async ({ host, base, schemas }) => {
    assert.equal(globalThis.__hello.starts, 1);

    /* A page watching the stream is greeted, then hears what is sent. */
    const res = await fetch(base + '/__lpp/hello/stream');
    const reader = res.body.getReader();
    const text = new TextDecoder();
    let seen = '';
    while (!seen.includes('event: hello')) seen += text.decode((await reader.read()).value);
    const tick = await (await fetch(base + '/__lpp/hello/tick', { method: 'POST' })).json();
    assert.equal(tick.listeners, 1);
    while (!seen.includes('event: tick')) seen += text.decode((await reader.read()).value);

    /* A relayed socket. */
    const port = new URL(base).port;
    const sock = net.connect(Number(port), '127.0.0.1');
    await new Promise((r) => sock.on('connect', r));
    sock.write('GET /__lpp/hello/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    await new Promise((r) => sock.once('data', r));
    const closed = new Promise((r) => sock.on('close', r));

    await host.sync(normaliseSettings({ plugins: { hello: { enabled: false } } }, schemas));

    assert.equal(globalThis.__hello.stops, 1, 'its disposer ran');
    assert.equal((await reader.read()).done, true, 'the stream was ended');
    await closed;   /* the relayed socket was hung up */
    const off = await fetch(base + '/__lpp/hello/hi');
    assert.equal(off.status, 404);
    assert.match((await off.json()).error, /switched off/);

    await host.sync(normaliseSettings({ plugins: { hello: { enabled: true } } }, schemas));
    assert.equal(globalThis.__hello.starts, 2, 'started again from scratch');
    assert.equal((await fetch(base + '/__lpp/hello/hi')).status, 200);
  });
});

test('a plugin that throws while starting is marked failed, and the rest of the app carries on', async () => {
  globalThis.__flaky = 0;
  const tree = {
    flaky: {
      'server.js': `
        export default function activate(ctx) {
          globalThis.__flaky++;
          ctx.route('GET', '/half', (req, res, h) => h.json(200, {}));
          throw new Error('no config');
        }`
    },
    steady: { 'server.js': `export default (ctx) => ctx.route('GET', '/ok', (req, res, h) => h.json(200, { ok: true }));` }
  };
  const manifests = [manifest({ id: 'flaky' }), manifest({ id: 'steady' })];
  await withHost({ tree, manifests }, async ({ host, base, schemas }) => {
    const res = await fetch(base + '/__lpp/flaky/half');
    assert.equal(res.status, 503, 'nothing it registered before it threw is answering');
    assert.match((await res.json()).error, /failed to start: no config/);
    assert.equal((await fetch(base + '/__lpp/steady/ok')).status, 200);

    const listed = host.list().find((p) => p.id === 'flaky');
    assert.equal(listed.on, false);
    assert.match(listed.reason, /no config/);

    /* A save that does not touch it does not retry it on every keystroke… */
    await host.sync(normaliseSettings({ plugins: {} }, schemas));
    assert.equal(globalThis.__flaky, 1);
    /* …but switching it off and on again does. */
    await host.sync(normaliseSettings({ plugins: { flaky: { enabled: false } } }, schemas));
    await host.sync(normaliseSettings({ plugins: { flaky: { enabled: true } } }, schemas));
    assert.equal(globalThis.__flaky, 2);
  });
});

test('a server half that will not import is reported and never takes the host down', async () => {
  const tree = {
    broken: { 'server.js': 'export default function ( {' },
    empty: { 'server.js': 'export const nothing = 1;' }
  };
  const manifests = [manifest({ id: 'broken' }), manifest({ id: 'empty' })];
  await withHost({ tree, manifests }, async ({ host, base }) => {
    const broken = host.list().find((p) => p.id === 'broken');
    assert.match(broken.reason, /would not load/);
    assert.equal((await fetch(base + '/__lpp/broken/x')).status, 503);
    assert.match(host.list().find((p) => p.id === 'empty').reason, /no activate function/);
  });
});

test('a plugin asking for a newer plugin API is listed and refused, not loaded', async () => {
  globalThis.__future = 0;
  const tree = { future: { 'server.js': 'globalThis.__future++; export default () => {};' } };
  await withHost({ tree, manifests: [manifest({ id: 'future', apiVersion: 99 })] }, async ({ host }) => {
    const listed = host.list()[0];
    assert.equal(listed.on, false);
    assert.match(listed.reason, /needs plugin API 99/);
    assert.equal(globalThis.__future, 0, 'its code never ran');
  });
});

test('dependants stop before what they need, and start after it', async () => {
  globalThis.__order = [];
  const body = (id) => `
    export default function activate(ctx) {
      globalThis.__order.push('start ${id}');
      ctx.onDispose(() => globalThis.__order.push('stop ${id}'));
    }`;
  const tree = { base: { 'server.js': body('base') }, top: { 'server.js': body('top') } };
  /* Listed dependant-first on purpose: the order comes from `requires`. */
  const manifests = [manifest({ id: 'top', requires: { plugins: ['base'] } }), manifest({ id: 'base' })];
  await withHost({ tree, manifests }, async ({ host, schemas }) => {
    assert.deepEqual(globalThis.__order, ['start base', 'start top']);
    globalThis.__order = [];
    await host.sync(normaliseSettings({ plugins: { base: { enabled: false } } }, schemas));
    assert.deepEqual(globalThis.__order, ['stop top', 'stop base'], 'switching off what it needs takes the dependant too');
    assert.match(host.list().find((p) => p.id === 'top').reason, /needs base/);
  });
});

test('a plugin’s settings are its own: normalised by its schema, lifted from the old place, and change-notified', async () => {
  globalThis.__hello = undefined;
  await withHost({
    tree: { hello: { 'server.js': HELLO } },
    manifests: [manifest({ id: 'hello' })],
    /* `level` at the top level is where a built-in kept it before plugins had a namespace. */
    settings: { level: 4 }
  }, async ({ host, base, schemas }) => {
    assert.equal((await (await fetch(base + '/__lpp/hello/hi')).json()).level, 4, 'lifted into the namespace');

    let settings = normaliseSettings({ level: 4 }, schemas);
    assert.equal(settings.level, undefined, 'and gone from the top level');
    assert.deepEqual(settings.plugins.hello.settings, { level: 4, label: '' });

    /* A change the schema does not care about reaches nobody… */
    settings = normaliseSettings(mergeSettings(settings, { plugins: { hello: { settings: { label: 'x' } } } }), schemas);
    await host.sync(settings);
    assert.deepEqual(globalThis.__hello.changes, []);
    /* …and one it does arrives as (next, prev). */
    settings = normaliseSettings(mergeSettings(settings, liftLegacy({ level: 7 }, schemas)), schemas);
    await host.sync(settings);
    assert.deepEqual(globalThis.__hello.changes, [[4, 7]]);
    assert.equal(settings.plugins.hello.settings.label, 'x', 'the old-shaped update did not wipe the rest');
    assert.equal(globalThis.__hello.starts, 1, 'a settings change is not a restart');
  });
});

test('a running plugin’s folder is served, except its server half and anything outside it', async () => {
  const tree = {
    pics: {
      'server.js': 'export default () => {};',
      'client.js': 'export default () => {};',
      'look.css': 'a{}',
      'notes.txt': 'private'
    },
    off: { 'server.js': 'export default () => {};', 'client.js': 'export default () => {};' }
  };
  const manifests = [manifest({ id: 'pics', client: 'client.js' }), manifest({ id: 'off', client: 'client.js' })];
  await withHost({ tree, manifests, settings: { plugins: { off: { enabled: false } } } }, async ({ base, host }) => {
    const client = await fetch(base + '/__lpp/plugins/pics/client.js');
    assert.equal(client.status, 200);
    assert.match(client.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(base + '/__lpp/plugins/pics/look.css')).status, 200);

    assert.equal((await fetch(base + '/__lpp/plugins/pics/server.js')).status, 404, 'never the server half');
    assert.equal((await fetch(base + '/__lpp/plugins/pics/notes.txt')).status, 404, 'nothing it has no type for');
    assert.equal((await fetch(base + '/__lpp/plugins/pics/%2e%2e/off/client.js')).status, 404, 'no walking out');
    assert.equal((await fetch(base + '/__lpp/plugins/off/client.js')).status, 404, 'nothing of a plugin that is off');

    const listed = Object.fromEntries(host.list().map((p) => [p.id, p]));
    assert.equal(listed.pics.client, '/__lpp/plugins/pics/client.js');
    assert.equal(listed.off.client, null);
  });
});

test('a plugin is handed the app, not the server: device, awj and its own address', async () => {
  const tree = {
    ask: {
      'server.js': `
        export default function activate(ctx) {
          ctx.route('GET', '/facts', async (req, res, h) => h.json(200, {
            device: ctx.device(),
            self: ctx.selfAddress(req),
            replies: await ctx.awj([{ op: 'get', path: 'x' }]),
          }));
        }`
    }
  };
  await withHost({
    tree,
    manifests: [manifest({ id: 'ask' })],
    device: () => '10.0.0.5:80',
    awj: async (messages) => messages.map((m) => ({ path: m.path, value: 1 })),
    splitAddress: (s) => { const [host, port] = s.split(':'); return { host, port: Number(port) }; }
  }, async ({ base }) => {
    const facts = await (await fetch(base + '/__lpp/ask/facts')).json();
    assert.equal(facts.device, '10.0.0.5:80');
    assert.deepEqual(facts.replies, [{ path: 'x', value: 1 }]);
    assert.equal(facts.self.host, '127.0.0.1');
    assert.equal(facts.self.loopback, true, 'the panel is told when its own address will not reach across a room');
  });
});

test('registering after being switched off is refused, not silently live', async () => {
  const tree = {
    late: {
      'server.js': `
        export default function activate(ctx) {
          globalThis.__late = ctx;
        }`
    }
  };
  await withHost({ tree, manifests: [manifest({ id: 'late' })] }, async ({ host, schemas, base }) => {
    const ctx = globalThis.__late;
    await host.sync(normaliseSettings({ plugins: { late: { enabled: false } } }, schemas));
    assert.throws(() => ctx.route('GET', '/zombie', () => {}), /after it was switched off/);
    assert.equal((await fetch(base + '/__lpp/late/zombie')).status, 404);
  });
});

/* ---------------------------------------------------------------- user plugins */

/** A user plugin folder's worth of files, with a manifest. */
const userPlugin = (id, files, manifest = {}) => ({
  'plugin.json': JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1, server: 'server.js', ...manifest }),
  ...files
});

async function withUserPlugins(tree, fn, settings = { plugins: {} }) {
  const userDir = await pluginsOnDisk(tree);
  try {
    await withHost({ tree: {}, manifests: [], userDir, settings }, (h) => fn({ ...h, userDir }));
  } finally {
    await rm(userDir, { recursive: true, force: true });
  }
}

test('a user plugin is listed but off, and none of its code runs until it is switched on', async () => {
  globalThis.__imported = 0;
  const tree = {
    mine: userPlugin('mine', {
      'server.js': `
        globalThis.__imported++;
        export default (ctx) => ctx.route('GET', '/hi', (req, res, h) => h.json(200, { hi: 'mine' }));`,
      'client.js': 'export default () => {};'
    }, { client: 'client.js', enabledByDefault: true })
  };
  await withUserPlugins(tree, async ({ host, base, schemas, userDir }) => {
    const listed = host.list().find((p) => p.id === 'mine');
    assert.equal(listed.source, 'user');
    assert.equal(listed.builtIn, false);
    assert.equal(listed.on, false, 'off, though its manifest asked to be on by default');
    assert.equal(listed.dir, join(userDir, 'mine'));
    assert.equal(globalThis.__imported, 0, 'not imported by being found');
    assert.equal((await fetch(base + '/__lpp/mine/hi')).status, 404);
    assert.equal((await fetch(base + '/__lpp/plugins/mine/client.js')).status, 404, 'nothing served while off');

    await host.sync(normaliseSettings({ plugins: { mine: { enabled: true } } }, schemas));
    assert.equal(globalThis.__imported, 1, 'imported the moment it was switched on');
    assert.deepEqual(await (await fetch(base + '/__lpp/mine/hi')).json(), { hi: 'mine' });
    assert.equal((await fetch(base + '/__lpp/plugins/mine/client.js')).status, 200);
    assert.equal((await fetch(base + '/__lpp/plugins/mine/server.js')).status, 404);
  });
});

test('a folder that is not a plugin is listed with the reason, and can never be switched on', async () => {
  const tree = {
    'no-manifest': { 'server.js': 'export default () => {};' },
    garbled: { 'plugin.json': '{ not json' },
    renamed: userPlugin('something-else', { 'server.js': 'export default () => {};' }),
    settings: userPlugin('settings', { 'server.js': 'export default () => {};' }),
    companion: userPlugin('companion', { 'server.js': 'export default () => {};' }),
    escape: userPlugin('escape', {}, { server: '../../evil.js' }),
    future: userPlugin('future', { 'server.js': 'globalThis.__future2 = true; export default () => {};' }, { apiVersion: 9 })
  };
  const everything = Object.fromEntries(Object.keys(tree).map((id) => [id, { enabled: true }]));
  await withUserPlugins(tree, async ({ host, base }) => {
    const reasons = Object.fromEntries(host.list().filter((p) => p.source === 'user').map((p) => [p.id, p.reason]));
    assert.match(reasons['no-manifest'], /plugin\.json: there is none/);
    assert.match(reasons.garbled, /would not parse/);
    assert.match(reasons.renamed, /must match/);
    assert.match(reasons.settings, /taken by this app/, 'an id that would sit on the settings route');
    assert.match(reasons.companion, /taken by this app/, 'a built-in’s id');
    assert.match(reasons.escape, /inside its own folder/);
    assert.match(reasons.future, /needs plugin API 9/);
    assert.equal(globalThis.__future2, undefined);
    /* Switched on in the settings, and still nothing answers. */
    assert.equal((await fetch(base + '/__lpp/escape/x')).status, 404);
    assert.equal(host.running().length, 0);
  }, { plugins: everything });
});

test('a user plugin’s settings are carried untouched while it is off, and normalised once it is on', async () => {
  const tree = {
    tidy: userPlugin('tidy', {
      'server.js': `
        export const settings = {
          normalise: (raw) => ({ level: Number.isInteger(raw.level) ? raw.level : 3 }),
          legacy: ['consoleLanguage'],
        };
        export default (ctx) => ctx.route('GET', '/level', (req, res, h) => h.json(200, ctx.settings.get()));`
    })
  };
  const stored = { consoleLanguage: 'awj', plugins: { tidy: { settings: { level: 'x', extra: 1 } } } };
  await withUserPlugins(tree, async ({ host, base, schemas }) => {
    assert.equal(schemas.tidy, undefined, 'no schema, because nothing was imported');
    const off = normaliseSettings(stored, schemas);
    assert.deepEqual(off.plugins.tidy.settings, { level: 'x', extra: 1 }, 'untouched while it is off');

    await host.sync(normaliseSettings(mergeSettings(stored, { plugins: { tidy: { enabled: true } } }), schemas));
    assert.deepEqual(await (await fetch(base + '/__lpp/tidy/level')).json(), { level: 3 });
    /* A user plugin cannot lift the app's own fields into itself. */
    assert.deepEqual(schemas.tidy.legacy, []);
    assert.equal(normaliseSettings(stored, schemas).consoleLanguage, 'awj');
  }, stored);
});

test('the example plugin in examples/ works as a user plugin, unchanged', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const src = new URL('../examples/plugins/hello-switcher/', import.meta.url);
  const files = {};
  for (const name of await readdir(src)) files[name] = await readFile(new URL(name, src), 'utf8');
  await withUserPlugins({ 'hello-switcher': files }, async ({ host, base, schemas }) => {
    const listed = host.list().find((p) => p.id === 'hello-switcher');
    assert.equal(listed.reason, 'switched off');
    await host.sync(normaliseSettings({ plugins: { 'hello-switcher': { enabled: true } } }, schemas));

    const hello = await (await fetch(base + '/__lpp/hello-switcher/hello')).json();
    assert.deepEqual(hello, { greeting: 'Hello', switcher: '10.1.2.3:80' });

    const res = await fetch(base + '/__lpp/hello-switcher/ticks');
    const reader = res.body.getReader();
    let seen = '';
    while (!seen.includes('event: tick')) seen += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();

    const client = await fetch(base + '/__lpp/plugins/hello-switcher/client.js');
    assert.equal(client.status, 200);
    assert.equal(host.list().find((p) => p.id === 'hello-switcher').client, '/__lpp/plugins/hello-switcher/client.js');
  }, { plugins: {} });
});
