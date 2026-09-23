/*
 * Proxy tests.
 *
 * These run against a throwaway HTTP server standing in for a Web RCS, rather
 * than against mocks, because every bug worth catching here lives in the
 * plumbing: header handling, encodings, streaming and the upgrade handshake.
 * A mocked http.request would agree with whatever the code did.
 *
 * The fake upstream serves a document shaped like the real one — deferred
 * scripts, root-absolute asset paths — since the injection's correctness is
 * entirely a claim about ordering against those script tags.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createProxy, injectInto, buildInjection, splitDevice, validHost, NS } from '../server/proxy.js';
import { StackStore } from '../server/storage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DOC =
  '<!doctype html><html lang="en"><head><title>Web RCS</title>' +
  '<link href="/styles/app.7f6536d9.css" rel="stylesheet"></head><body>' +
  '<div id="root"></div>' +
  '<script defer="defer" src="/boot.57ca06eb.js"></script>' +
  '<script defer="defer" src="/app.9f659f2d.js"></script></body></html>';

/** A stand-in Web RCS: serves the document, an asset, and a WebSocket upgrade. */
function fakeDevice({ gzip = false } = {}) {
  const seen = { upgrades: 0, headers: null, paths: [] };
  /* The upstream half of an upgraded connection keeps this fixture's own
     close() waiting, exactly as it did the proxy's. Track and hang up. */
  const open = new Set();
  const server = http.createServer((req, res) => {
    seen.paths.push(req.url);
    if (req.url === '/') {
      if (gzip) {
        const buf = zlib.gzipSync(Buffer.from(DOC));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
        return res.end(buf);
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(DOC);
    }
    if (req.url === '/api/stores/device') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ device: { system: { pp: { ready: true } } } }));
    }
    if (req.url === '/csp') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "script-src 'self'"
      });
      return res.end(DOC);
    }
    res.writeHead(404).end('nope');
  });
  server.on('upgrade', (req, socket) => {
    seen.upgrades++;
    seen.headers = req.headers;
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
  });
  server.closeRelays = () => { for (const s of [...open]) s.destroy(); open.clear(); };
  return { server, seen };
}

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}
/* Keep-alive sockets from fetch() would hold close() open past the test
   timeout, so drop them explicitly rather than waiting them out. */
const close = (s) => new Promise((r) => {
  s.closeRelays?.();
  s.closeAllConnections?.();
  s.close(r);
});

async function withProxy(opts, fn) {
  const { server: device, seen } = fakeDevice(opts.deviceOpts || {});
  const devicePort = await listen(device);
  const proxy = await createProxy({
    device: `127.0.0.1:${devicePort}`,
    root: ROOT,
    storage: opts.storage || null,
    log: () => {}
  });
  const port = await listen(proxy);
  try {
    await fn({ port, seen, base: `http://127.0.0.1:${port}` });
  } finally {
    await close(proxy);
    await close(device);
  }
}

test('splitDevice and validHost reject anything that is not a plain host', () => {
  assert.deepEqual(splitDevice('192.168.2.142'), { host: '192.168.2.142', port: 80 });
  assert.deepEqual(splitDevice('192.168.2.142:3000'), { host: '192.168.2.142', port: 3000 });
  assert.equal(splitDevice('192.168.2.142:0'), null);
  assert.equal(splitDevice('192.168.2.142:99999'), null);
  assert.equal(splitDevice('host with space'), null);
  assert.equal(validHost('a/../b'), false);
  assert.equal(validHost(''), false);
});

test('the hook is injected ahead of every deferred vendor script', async () => {
  await withProxy({}, async ({ base }) => {
    const html = await (await fetch(base + '/')).text();
    const hook = html.indexOf('data-lpp="hook"');
    const boot = html.indexOf('/boot.57ca06eb.js');
    const app = html.indexOf('/app.9f659f2d.js');
    assert.ok(hook > 0, 'hook present');
    assert.ok(hook < boot && hook < app, 'hook precedes both vendor bundles');
    /* The panels are a module, which is deferred by definition, so it is
       fine — and correct — for it to sit alongside the vendor scripts. */
    assert.ok(html.includes(`${NS}/src/main.js`), 'panel module referenced');
  });
});

test('the injected hook is the real file, not a copy', async () => {
  await withProxy({}, async ({ base }) => {
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('window.__WRU_HOOK'), 'hook body inlined verbatim');
    assert.ok(html.includes('looksAW'), 'including its internals');
  });
});

test('vendor asset URLs are not rewritten', async () => {
  await withProxy({}, async ({ base }) => {
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('href="/styles/app.7f6536d9.css"'), 'stylesheet path untouched');
    assert.ok(html.includes('src="/boot.57ca06eb.js"'), 'script path untouched');
  });
});

test('framing headers are rewritten when a chunked document is injected into', async () => {
  await withProxy({}, async ({ base }) => {
    const res = await fetch(base + '/');
    const html = await res.text();
    /* The device serves documents chunked. Re-sending one whole means the
       upstream's transfer-encoding must not survive alongside our
       content-length — a strict client rejects the pair outright. */
    assert.equal(res.headers.get('transfer-encoding'), null, 'chunked header dropped');
    assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(html));
  });
});

test('a gzipped document is decoded, injected, and re-sent plain', async () => {
  await withProxy({ deviceOpts: { gzip: true } }, async ({ base }) => {
    const res = await fetch(base + '/');
    const html = await res.text();
    assert.ok(html.includes('data-lpp="hook"'), 'injected despite compression');
    assert.equal(res.headers.get('content-encoding'), null, 'encoding header dropped');
    assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(html), 'length recomputed');
  });
});

test('a Content-Security-Policy from the device is stripped', async () => {
  await withProxy({}, async ({ base }) => {
    const res = await fetch(base + '/csp');
    assert.equal(res.headers.get('content-security-policy'), null);
    assert.ok((await res.text()).includes('data-lpp="hook"'));
  });
});

test('non-document responses pass through untouched', async () => {
  await withProxy({}, async ({ base }) => {
    const res = await fetch(base + '/api/stores/device');
    const body = await res.json();
    assert.deepEqual(body, { device: { system: { pp: { ready: true } } } });
  });
});

test('our own module tree is served, and cannot escape src/', async () => {
  await withProxy({}, async ({ base }) => {
    const ok = await fetch(`${base}${NS}/src/core/paths.js`);
    assert.equal(ok.status, 200);
    assert.ok((await ok.text()).length > 0);

    for (const bad of ['/../package.json', '/../../etc/passwd', '/package.json']) {
      const res = await fetch(`${base}${NS}${bad}`);
      assert.equal(res.status, 404, `${bad} refused`);
    }
  });
});

test('the socket is relayed, and the device sees exactly one client', async () => {
  await withProxy({}, async ({ port, seen }) => {
    const sock = net.connect(port, '127.0.0.1');
    await new Promise((r) => sock.on('connect', r));
    sock.write(
      'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
    );
    const first = await new Promise((r) => sock.once('data', (d) => r(d.toString())));
    assert.match(first, /101 Switching Protocols/);

    /* Bytes must survive in both directions untouched — the relay knows
       nothing about WebSocket framing and must not need to. */
    sock.write('ping-payload');
    const echoed = await new Promise((r) => sock.once('data', (d) => r(d.toString())));
    assert.equal(echoed, 'echo:ping-payload');

    assert.equal(seen.upgrades, 1, 'one upstream connection');
    assert.equal(seen.headers['sec-websocket-key'], 'dGhlIHNhbXBsZSBub25jZQ==', 'handshake forwarded intact');
    sock.destroy();
  });
});

test('cue stacks round-trip through the launcher', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lpp-'));
  try {
    await withProxy({ storage: new StackStore(dir) }, async ({ base }) => {
      const empty = await (await fetch(`${base}${NS}/stack`)).json();
      assert.equal(empty.data, null, 'no stack to begin with');

      const cues = { cues: [{ id: 1, label: 'Opening' }] };
      const put = await fetch(`${base}${NS}/stack`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: cues })
      });
      assert.equal(put.status, 200);

      const back = await (await fetch(`${base}${NS}/stack`)).json();
      assert.deepEqual(back.data, cues);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('layer groups round-trip, in a file of their own', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lpp-'));
  try {
    await withProxy({ storage: new StackStore(dir) }, async ({ base }) => {
      const empty = await (await fetch(`${base}${NS}/groups`)).json();
      assert.equal(empty.data, null, 'no groups to begin with');

      const groups = { version: 1, groups: [{ id: 'g1', name: 'Sides', gang: true, members: [{ id: 'S1', layer: '2' }] }] };
      const put = await fetch(`${base}${NS}/groups`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: groups })
      });
      assert.equal(put.status, 200);
      assert.deepEqual((await (await fetch(`${base}${NS}/groups`)).json()).data, groups);

      /* And the cue stack is untouched by it — same device key, two files.
         Sharing one would mean an edit to either racing the other's save. */
      assert.equal((await (await fetch(`${base}${NS}/stack`)).json()).data, null);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('layer names round-trip through their plugin, in the file they always had', async () => {
  /* The names moved into `plugins/layer-names/`; the address, the `{ data }`
     shape and the file on disk did not — a Companion module reads the first
     two, and the one-file setup and an older build read the third. */
  const dir = await mkdtemp(join(tmpdir(), 'lpp-'));
  try {
    const store = new StackStore(dir);
    await withProxy({ storage: store }, async ({ base }) => {
      assert.equal((await (await fetch(`${base}${NS}/layer-names`)).json()).data, null);
      const names = { version: 1, names: { 'S1/2': 'IMAG' } };
      const put = await fetch(`${base}${NS}/layer-names`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: names })
      });
      assert.equal(put.status, 200);
      assert.deepEqual((await (await fetch(`${base}${NS}/layer-names`)).json()).data, names);
      const device = (await (await fetch(`${base}${NS}/status`)).json()).device;
      assert.deepEqual(await store.loadNames(device), names, 'where the setup file and an older build look');

      const empty = await fetch(`${base}${NS}/layer-names`, { method: 'PUT', body: '' });
      assert.equal(empty.status, 400, 'an empty body is refused, not saved over every name');
      assert.equal((await fetch(`${base}${NS}/layer-names`, { method: 'DELETE' })).status, 405);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt stack file reads as absent rather than throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lpp-'));
  try {
    const store = new StackStore(dir);
    await store.save('1.2.3.4:80', { cues: [] });
    const { writeFile, readdir } = await import('node:fs/promises');
    const [name] = await readdir(dir);
    await writeFile(join(dir, name), '{ not json');
    assert.equal(await store.load('1.2.3.4:80'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stack keys are sanitised before they reach the filesystem', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lpp-'));
  try {
    const store = new StackStore(dir);
    await store.save('../../escape:80', { cues: ['x'] });
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.ok(!files[0].includes('..'), `${files[0]} carries no traversal`);
    assert.ok(!files[0].includes('/'), `${files[0]} stays in one segment`);
    /* And it still round-trips under the key it was written with. */
    assert.deepEqual(await store.load('../../escape:80'), { cues: ['x'] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('injectInto falls back sensibly on a document with no head close', () => {
  const frag = '<!--F-->';
  assert.ok(injectInto('<html><head></head><body>x</body>', frag).includes('<!--F--></head>'));
  const noHead = injectInto('<html><body><script src="a.js"></script></body>', frag);
  assert.ok(noHead.indexOf(frag) < noHead.indexOf('<script'), 'lands before the first script');
  assert.ok(injectInto('<html><body>x</body>', frag).indexOf(frag) < injectInto('<html><body>x</body>', frag).indexOf('<body'));
  assert.equal(injectInto('plain', frag), frag + 'plain');
});

test('buildInjection puts the hook first and the panels second', () => {
  const out = buildInjection('/*H*/');
  assert.ok(out.indexOf('data-lpp="hook"') < out.indexOf('data-lpp="panels"'));
  assert.ok(out.includes('/*H*/'));
});

test('an unreachable device answers 502 rather than hanging', async () => {
  const proxy = await createProxy({ device: '127.0.0.1:9', root: ROOT, log: () => {} });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 502);
    assert.match(await res.text(), /cannot reach/);
  } finally {
    await close(proxy);
  }
});

test('a relayed socket does not keep the server from shutting down', async () => {
  /* The failure this pins is a hang, not a wrong value: an upgraded socket is
     invisible to the HTTP server's own connection tracking, so without
     closeRelays() the launcher's Stop never completes. */
  const { server: device } = fakeDevice();
  const devicePort = await listen(device);
  const proxy = await createProxy({ device: `127.0.0.1:${devicePort}`, root: ROOT, log: () => {} });
  const port = await listen(proxy);

  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => sock.on('connect', r));
  sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  await new Promise((r) => sock.once('data', r));
  assert.equal(proxy.lppState.clients, 1, 'relay is open');

  /* Deliberately leave the client socket connected — that is the real case,
     a Web RCS tab that never disconnects on its own. */
  const shutdown = await Promise.race([
    close(proxy).then(() => 'closed'),
    new Promise((r) => setTimeout(() => r('hung'), 4000))
  ]);
  assert.equal(shutdown, 'closed', 'server shut down with a socket still attached');
  assert.equal(proxy.lppState.clients, 0);

  sock.destroy();
  await close(device);
});

test('with no switcher chosen, every path serves the setup page', async () => {
  const proxy = await createProxy({ device: null, root: ROOT, log: () => {} });
  const port = await listen(proxy);
  try {
    const base = `http://127.0.0.1:${port}`;
    /* A deep link into the Web RCS must land on setup too, not a 502 — an
       operator's bookmark points at a page, not at the root. */
    for (const path of ['/', '/live/screens', '/api/stores/device']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.match(await res.text(), /Switcher address/, path);
    }
    const status = await (await fetch(`${base}${NS}/status`)).json();
    assert.equal(status.configured, false);
    assert.equal(status.device, null);
  } finally {
    await close(proxy);
  }
});

test('an unconfigured proxy refuses a socket instead of crashing', async () => {
  const proxy = await createProxy({ device: null, root: ROOT, log: () => {} });
  const port = await listen(proxy);
  try {
    const sock = net.connect(port, '127.0.0.1');
    await new Promise((r) => sock.on('connect', r));
    sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    const ended = await new Promise((r) => {
      sock.on('close', () => r('closed'));
      setTimeout(() => r('still open'), 2000);
    });
    assert.equal(ended, 'closed');
  } finally {
    await close(proxy);
  }
});

test('the switcher can be set, and re-set, at runtime', async () => {
  const { server: device, seen } = fakeDevice();
  const devicePort = await listen(device);
  const proxy = await createProxy({ device: null, root: ROOT, log: () => {} });
  const port = await listen(proxy);
  const base = `http://127.0.0.1:${port}`;
  try {
    const bad = await fetch(`${base}${NS}/device`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'not a host/at all' })
    });
    assert.equal(bad.status, 400, 'a malformed address is refused');

    const ok = await fetch(`${base}${NS}/device`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: `127.0.0.1:${devicePort}` })
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).device, `127.0.0.1:${devicePort}`);

    /* And now it actually proxies, injection and all. */
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('data-lpp="hook"'), 'proxying after configuration');
    assert.ok(seen.paths.includes('/'), 'request reached the device');
  } finally {
    await close(proxy);
    await close(device);
  }
});

test('re-pointing hangs up relays aimed at the old switcher', async () => {
  const { server: deviceA } = fakeDevice();
  const { server: deviceB } = fakeDevice();
  const portA = await listen(deviceA);
  const portB = await listen(deviceB);
  const proxy = await createProxy({ device: `127.0.0.1:${portA}`, root: ROOT, log: () => {} });
  const port = await listen(proxy);
  try {
    const sock = net.connect(port, '127.0.0.1');
    await new Promise((r) => sock.on('connect', r));
    sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    await new Promise((r) => sock.once('data', r));
    assert.equal(proxy.lppState.clients, 1);

    await fetch(`http://127.0.0.1:${port}${NS}/device`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: `127.0.0.1:${portB}` })
    });
    /* A socket left attached to the previous frame would keep driving it while
       the operator believed they had moved to the backup. */
    assert.equal(proxy.lppState.clients, 0, 'old relay dropped');
    assert.equal(proxy.lppState.device, `127.0.0.1:${portB}`);
    sock.destroy();
  } finally {
    await close(proxy);
    await close(deviceA);
    await close(deviceB);
  }
});

test('the remembered switcher survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lpp-'));
  try {
    const store = new StackStore(dir);
    assert.equal(await store.loadDevice(), null);
    await store.saveDevice('192.168.2.142:80');
    assert.equal(await new StackStore(dir).loadDevice(), '192.168.2.142:80');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extra modules are injected after the panels, and only when asked for', async () => {
  const { server: device } = fakeDevice();
  const devicePort = await listen(device);
  const proxy = await createProxy({
    device: `127.0.0.1:${devicePort}`,
    root: ROOT,
    extraModules: [`${NS}/demo/seed.js`],
    extraFiles: { '/demo/seed.js': join(ROOT, 'tools', 'demo', 'seed.js') },
    log: () => {}
  });
  const port = await listen(proxy);
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const panels = html.indexOf('data-lpp="panels"');
    const extra = html.indexOf('data-lpp="extra"');
    assert.ok(extra > panels, 'extras run after the panels, so window.__WRU exists');

    const served = await fetch(`http://127.0.0.1:${port}${NS}/demo/seed.js`);
    assert.equal(served.status, 200);
    assert.match(await served.text(), /LivePremier Plus demo/);
  } finally {
    await close(proxy);
    await close(device);
  }
});

test('an unregistered extra path is not reachable', async () => {
  const { server: device } = fakeDevice();
  const devicePort = await listen(device);
  const proxy = await createProxy({
    device: `127.0.0.1:${devicePort}`,
    root: ROOT,
    extraFiles: { '/demo/seed.js': join(ROOT, 'tools', 'demo', 'seed.js') },
    log: () => {}
  });
  const port = await listen(proxy);
  try {
    /* extraFiles is an exact-match table, so nothing about the request builds a
       path — but check the neighbours anyway. */
    for (const bad of ['/demo/other.js', '/demo/', '/demo/seed.js/../../package.json']) {
      const res = await fetch(`http://127.0.0.1:${port}${NS}${bad}`);
      assert.equal(res.status, 404, bad);
    }
  } finally {
    await close(proxy);
    await close(device);
  }
});

test('the demo cue stack is valid for the cue engine', async () => {
  /* The demo seeds a stack straight to disk, bypassing the UI, so nothing else
     would catch a malformed cue until someone pressed GO. */
  const { CueStack } = await import('../src/core/cuestack.js');
  const { readFile } = await import('node:fs/promises');
  const demoSrc = await readFile(join(ROOT, 'tools', 'demo.mjs'), 'utf8');
  assert.match(demoSrc, /function demoStack/, 'demo still defines a stack');

  const sent = [];
  const stack = new CueStack({ send: (cmd) => { sent.push(cmd); return true; } });
  /* Rebuild the same shape the demo writes. */
  stack.load({
    version: 1,
    name: 'Demo',
    cues: [{
      id: 'demo-1', number: '1', label: 'House open', notes: '', enabled: true,
      fade: 1, delay: 0, follow: false, followTime: 0,
      actions: [
        { kind: 'screenPreset', slot: 1, targets: ['S1'], mode: 'PREVIEW' },
        { kind: 'take', targets: ['S1'] }
      ]
    }]
  });
  assert.equal(stack.cues.length, 1);
  const result = stack.fire(stack.cues[0]);
  assert.ok(result.sent > 0, 'the demo cue actually produces writes');
  assert.ok(sent.some((c) => Array.isArray(c.path)), 'writes are {path, value} commands');
});

/*
 * The popped-out console is one of ours, not one of the switcher's.
 *
 * It has to be served from this origin rather than proxied, because it drives
 * the Web RCS tab's session through `window.opener` — and that reference is
 * only live between same-origin documents. It also has to be reachable before
 * a switcher is chosen, since the namespace is answered ahead of the proxy.
 */
test('the popped-out console is served by us, on our own origin', async () => {
  const proxy = await createProxy({ device: null, root: ROOT, log: () => {} });
  const port = await listen(proxy);
  try {
    /* From the Console plugin's own folder, which the plugin host serves. */
    const res = await fetch(`http://127.0.0.1:${port}${NS}/plugins/console/popout.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const body = await res.text();
    assert.match(body, /popout\.js/, 'boots the popout module');
    /* Nothing about the vendor may be baked in here: the stylesheet hrefs and
       the icon sprite are copied off the opener at runtime, because their
       hashes change every firmware. */
    assert.doesNotMatch(body, /\/styles\/(app|boot)\./, 'no hard-coded vendor stylesheet');
  } finally {
    await close(proxy);
  }
});

/*
 * Every popout is on those same terms, and the list is worth pinning as a
 * list: adding one is four edits — the document, the mount, the route and the
 * button — and forgetting the route is the one that fails as a blank window
 * rather than as an error anyone would notice in a test.
 */
test('every popout route is served by us, before a switcher is chosen', async () => {
  const proxy = await createProxy({ device: null, root: ROOT, log: () => {} });
  const port = await listen(proxy);
  try {
    for (const route of ['/plugins/timeline/popout.html', '/plugins/layer/popout.html', '/plugins/memories/popout.html', '/plugins/console/popout.html']) {
      const res = await fetch(`http://127.0.0.1:${port}${NS}${route}`);
      assert.equal(res.status, 200, `${route} is served`);
      assert.match(res.headers.get('content-type'), /text\/html/);
      const body = await res.text();
      assert.match(body, /popout\.js/, `${route} boots the popout module`);
      assert.doesNotMatch(body, /\/styles\/(app|boot)\./,
        `${route} hard-codes no vendor stylesheet`);
    }
  } finally {
    await close(proxy);
  }
});

test('our version is reported so the settings page need not guess it', async () => {
  const proxy = await createProxy({ device: null, root: ROOT, log: () => {} });
  const port = await listen(proxy);
  try {
    const status = await (await fetch(`http://127.0.0.1:${port}${NS}/status`)).json();
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(status.version, pkg.version);
  } finally {
    await close(proxy);
  }
});

/*
 * Timecode pushed in from outside.
 *
 * The page reads MTC and LTC itself; this is the path for a generator on
 * another machine, or anything else that can make an HTTP request.
 */
test('a pushed timecode is accepted in both spellings', async () => {
  const proxy = await createProxy({ device: null, root: ROOT, log: () => {} });
  const port = await listen(proxy);
  const base = `http://127.0.0.1:${port}${NS}/timecode`;
  const push = (body) => fetch(base, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  try {
    const text = await (await push('01:02:03:04')).json();
    assert.equal(text.ok, true);
    assert.deepEqual(text.timecode, { hours: 1, minutes: 2, seconds: 3, frames: 4, rate: null, dropFrame: false });

    /* A semicolon before the frames is how the industry spells drop-frame. */
    const drop = await (await push({ timecode: '10:00:00;12', rate: 30 })).json();
    assert.equal(drop.timecode.dropFrame, true);
    assert.equal(drop.timecode.rate, 30);

    const obj = await (await push({ hours: 5, minutes: 6, seconds: 7, frames: 8 })).json();
    assert.equal(obj.timecode.hours, 5);

    /* And the last one is readable, so a page that has just opened knows
       where things are without waiting for the next push. */
    const now = await (await fetch(base)).json();
    assert.equal(now.timecode.hours, 5);
  } finally {
    await close(proxy);
  }
});

/*
 * Out of range is refused, not clamped. A frame number of 40 is a bug in
 * whatever sent it, and a clamped 29 would hide it behind a plausible value a
 * cue stack would then act on.
 */
test('a timecode that cannot be one is refused rather than clamped', async () => {
  const proxy = await createProxy({ device: null, root: ROOT, log: () => {} });
  const port = await listen(proxy);
  const base = `http://127.0.0.1:${port}${NS}/timecode`;
  try {
    for (const body of ['99:00:00:00', '01:02:03', { hours: 1 }, { hours: 1, minutes: 2, seconds: 3, frames: 99 }, 'nonsense']) {
      const res = await fetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  } finally {
    await close(proxy);
  }
});

test('the timecode stream hands over what it already knows, then the next push', async () => {
  const proxy = await createProxy({ device: null, root: ROOT, log: () => {} });
  const port = await listen(proxy);
  const base = `http://127.0.0.1:${port}${NS}/timecode`;
  try {
    await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '"01:00:00:00"' });

    const res = await fetch(base + '/stream');
    assert.match(res.headers.get('content-type'), /event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    /* The opening frame carries the last known position, so a page does not
       sit blank until the next message. */
    let seen = '';
    while (!seen.includes('"hours":1')) seen += decoder.decode((await reader.read()).value);

    await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '"02:00:00:00"' });
    let next = '';
    while (!next.includes('"hours":2')) next += decoder.decode((await reader.read()).value);

    await reader.cancel();
  } finally {
    await close(proxy);
  }
});

/* ------------------------------------------------------------ plugin switches */

/*
 * A plugin switched off must leave no surface: its routes answer 404 with the
 * reason, and switching it back on over /__lpp/settings brings them back at once
 * — the server half of a switch needs no restart. Companion is the example
 * because its mount is the widest surface any plugin has.
 */
test('a switched-off plugin answers 404 on every route it owns, and comes back when switched on', async () => {
  let saved = { plugins: { companion: { enabled: false } } };
  const storage = {
    loadSettings: async () => saved,
    saveSettings: async (s) => { saved = s; }
  };
  await withProxy({ storage }, async ({ base }) => {
    for (const path of ['/__lpp/companion/state', '/__lpp/companion/ui/buttons']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 404, path);
      const body = await res.json();
      assert.equal(body.plugin, 'companion');
      assert.match(body.error, /switched off/);
    }

    /* The core's own routes are nobody's to switch off. */
    assert.equal((await fetch(base + '/__lpp/settings')).status, 200);

    const put = await fetch(base + '/__lpp/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugins: { companion: { enabled: true } } })
    });
    assert.equal(put.status, 200);
    assert.equal(saved.plugins.companion.enabled, true, 'the switch was saved');
    /* …beside the plugin's own settings, which a switch must never wipe. */
    assert.equal(saved.plugins.companion.settings.companionPort, 8000);

    const back = await fetch(base + '/__lpp/companion/state');
    assert.equal(back.status, 200, 'on again, with no restart');
  });
});

test('an untouched install has every plugin on', async () => {
  await withProxy({}, async ({ base }) => {
    assert.equal((await fetch(base + '/__lpp/companion/state')).status, 200);
    assert.equal((await fetch(base + '/__lpp/matrix')).status, 200);
  });
});

/* ------------------------------------------------------------- the plugin host */

test('the hosted Companion is listed with its page half, which is served — its server half is not', async () => {
  await withProxy({}, async ({ base }) => {
    const { apiVersion, plugins } = await (await fetch(base + '/__lpp/plugins')).json();
    assert.equal(apiVersion, 1);
    const companion = plugins.find((p) => p.id === 'companion');
    assert.equal(companion.hosted, true);
    assert.equal(companion.on, true);
    assert.equal(companion.base, '/__lpp/companion');
    assert.equal(companion.client, '/__lpp/plugins/companion/client.js');
    /* A built-in still wired in by hand is listed too, with no page half to load. */
    for (const p of plugins.filter((x) => !x.hosted)) assert.equal(p.client, null, p.id);

    for (const file of ['client.js', 'panel.js', 'core.js']) {
      const res = await fetch(`${base}/__lpp/plugins/companion/${file}`);
      assert.equal(res.status, 200, file);
      assert.match(res.headers.get('content-type'), /javascript/);
    }
    assert.equal((await fetch(base + '/__lpp/plugins/companion/server.js')).status, 404);
  });
});

test('the Edit page kept its memory route and its setting when it became a plugin', async () => {
  /* `memoryImportDir` was a top-level setting; it is the Edit plugin's now,
     lifted from wherever an older file still has it. */
  let saved = { memoryImportDir: '/Volumes/showshare/lpp' };
  const storage = { loadSettings: async () => saved, saveSettings: async (s) => { saved = s; } };
  await withProxy({ storage }, async ({ base }) => {
    const { settings } = await (await fetch(base + '/__lpp/settings')).json();
    assert.equal(settings.memoryImportDir, undefined, 'not at the top level any more');
    assert.equal(settings.plugins.edit.settings.memoryImportDir, '/Volumes/showshare/lpp');

    const relative = await fetch(base + '/__lpp/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugins: { edit: { settings: { memoryImportDir: 'relative/path' } } } })
    });
    assert.equal((await relative.json()).settings.plugins.edit.settings.memoryImportDir, '',
      'resolved by the switcher, so only an absolute path means anything');

    /* Still at /__lpp/memory: what the Edit page posts to. */
    const empty = await fetch(base + '/__lpp/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, 'no memories');
    assert.equal((await fetch(base + '/__lpp/memory')).status, 400, 'a read names its slots');
  });
});

test('Companion settings from before plugins had a namespace are moved into it', async () => {
  /* The shape every settings file had up to 0.12. */
  let saved = { consoleLanguage: 'awj', companionEnabled: false, companionHost: 'companion.local', companionPort: 9000 };
  const storage = {
    loadSettings: async () => saved,
    saveSettings: async (s) => { saved = s; }
  };
  await withProxy({ storage }, async ({ base }) => {
    const state = await (await fetch(base + '/__lpp/companion/state')).json();
    assert.deepEqual(state.settings, { companionEnabled: false, companionHost: 'companion.local', companionPort: 9000 });

    const { settings } = await (await fetch(base + '/__lpp/settings')).json();
    assert.equal(settings.companionHost, undefined, 'not at the top level any more');
    assert.equal(settings.plugins.companion.settings.companionHost, 'companion.local');
    assert.equal(settings.consoleLanguage, 'awj');

    /* A caller still sending the old shape is lifted the same way. */
    const put = await fetch(base + '/__lpp/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { companionPort: 9100 } })
    });
    assert.equal(put.status, 200);
    assert.equal(saved.companionPort, undefined);
    assert.deepEqual(saved.plugins.companion.settings,
      { companionEnabled: false, companionHost: 'companion.local', companionPort: 9100 });
  });
});

/*
 * 2026-09-22: pointing the app at another switcher called `closeRelays`, which
 * by then also stopped the OSC listener, the routers, the Pixelhue panel and
 * the Companion link — all four silently off until the next restart, on the
 * one operation each of them promises to survive.
 */
test('pointing the app at another switcher leaves the plugins and the OSC listener running', async () => {
  const { server: deviceA } = fakeDevice();
  const { server: deviceB } = fakeDevice();
  const portA = await listen(deviceA);
  const portB = await listen(deviceB);
  const free = await new Promise((resolve) => {
    const probe = dgram.createSocket('udp4');
    probe.bind(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  /* The shape settings had before OSC input was a plugin — lifted into it. */
  let saved = { oscEnabled: true, oscPort: free };
  const storage = { loadSettings: async () => saved, saveSettings: async (s) => { saved = s; } };
  const proxy = await createProxy({ device: `127.0.0.1:${portA}`, root: ROOT, storage, log: () => {} });
  const port = await listen(proxy);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await (await fetch(base + '/__lpp/osc/state')).json()).listening, true);

    await fetch(`${base}${NS}/device`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: `127.0.0.1:${portB}` })
    });

    assert.equal((await (await fetch(base + '/__lpp/osc/state')).json()).listening, true, 'OSC still listening');
    const { plugins } = await (await fetch(base + '/__lpp/plugins')).json();
    assert.equal(plugins.find((p) => p.id === 'companion').on, true, 'Companion still running');
    assert.equal((await fetch(base + '/__lpp/companion/state')).status, 200);
  } finally {
    await close(proxy);
    await close(deviceA);
    await close(deviceB);
  }
});

test('an upgrade under the namespace that no plugin takes is refused, never relayed to the switcher', async () => {
  await withProxy({}, async ({ port, seen }) => {
    const sock = net.connect(port, '127.0.0.1');
    await new Promise((r) => sock.on('connect', r));
    sock.write('GET /__lpp/nobody/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    const reply = await new Promise((r) => sock.once('data', (d) => r(d.toString())));
    assert.match(reply, /^HTTP\/1\.1 404/);
    assert.equal(seen.upgrades, 0);
    sock.destroy();
  });
});

test('the Pixelhue panel is a hosted plugin: its state has a route, and its old settings are lifted', async () => {
  let saved = { pixelhueHost: '10.0.0.9', pixelhueModel: 'u5' };
  const storage = { loadSettings: async () => saved, saveSettings: async (s) => { saved = s; } };
  await withProxy({ storage }, async ({ base }) => {
    const state = await fetch(base + '/__lpp/pixelhue/state');
    assert.equal(state.status, 200);
    const body = await state.json();
    assert.equal(body.preview, true);
    assert.equal(body.configured, false, 'off until "Drive a Pixelhue console" is ticked');

    const { settings } = await (await fetch(base + '/__lpp/settings')).json();
    assert.deepEqual(settings.plugins.pixelhue.settings,
      { pixelhueEnabled: false, pixelhueHost: '10.0.0.9', pixelhueModel: 'u5' });
    assert.equal(settings.pixelhueHost, undefined);

    /* Switched off, it is gone; its settings are not. */
    await fetch(base + '/__lpp/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugins: { pixelhue: { enabled: false } } })
    });
    assert.equal((await fetch(base + '/__lpp/pixelhue/state')).status, 404);
    assert.equal(saved.plugins.pixelhue.settings.pixelhueHost, '10.0.0.9');
  });
});

test('a plugin copied into the data directory is found, starts off, and runs once switched on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lpp-data-'));
  const { cp } = await import('node:fs/promises');
  await cp(join(ROOT, 'examples/plugins/hello-switcher'), join(dir, 'plugins/hello-switcher'), { recursive: true });
  const { server: device } = fakeDevice();
  const devicePort = await listen(device);
  const proxy = await createProxy({ device: `127.0.0.1:${devicePort}`, root: ROOT, storage: new StackStore(dir), log: () => {} });
  const port = await listen(proxy);
  const base = `http://127.0.0.1:${port}`;
  try {
    const listed = (await (await fetch(base + '/__lpp/plugins')).json()).plugins.find((p) => p.id === 'hello-switcher');
    assert.equal(listed.source, 'user');
    assert.equal(listed.on, false);
    assert.equal((await fetch(base + '/__lpp/hello-switcher/hello')).status, 404);

    /* Switched on alone: the page is sent the plugin's defaults, though its
       schema only arrived when it started. */
    const on = await (await fetch(base + '/__lpp/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugins: { 'hello-switcher': { enabled: true } } })
    })).json();
    assert.deepEqual(on.settings.plugins['hello-switcher'].settings, { greeting: 'Hello' });

    await fetch(base + '/__lpp/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugins: { 'hello-switcher': { enabled: true, settings: { greeting: 'Evening' } } } })
    });
    const hello = await (await fetch(base + '/__lpp/hello-switcher/hello')).json();
    assert.deepEqual(hello, { greeting: 'Evening', switcher: `127.0.0.1:${devicePort}` });

    /* And it is still there after a restart, switched on, with its setting. */
    await close(proxy);
    const again = await createProxy({ device: `127.0.0.1:${devicePort}`, root: ROOT, storage: new StackStore(dir), log: () => {} });
    const port2 = await listen(again);
    try {
      const back = await (await fetch(`http://127.0.0.1:${port2}/__lpp/hello-switcher/hello`)).json();
      assert.equal(back.greeting, 'Evening');
    } finally {
      await close(again);
    }
  } finally {
    await close(proxy).catch(() => {});
    await close(device);
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------ contributed addresses */

test('the Console’s path to a plugin’s addresses: listed, run, and gone when the plugin is off', async () => {
  let saved = {};
  const storage = { loadSettings: async () => saved, saveSettings: async (s) => { saved = s; } };
  await withProxy({ storage }, async ({ base }) => {
    const { addresses } = await (await fetch(base + '/__lpp/addresses')).json();
    assert.deepEqual(addresses.map((a) => [a.prefix, a.owner]), [['/lp/matrix/', 'matrix-routing']]);

    /* Matrix Routing's own answer, through the same path a UDP message takes:
       with nothing patched, a route is refused with the reason. */
    const refused = await fetch(base + '/__lpp/addresses/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: '/lp/matrix/input/1/source', args: [3] })
    });
    assert.equal(refused.status, 409);
    const why = await refused.json();
    assert.equal(why.ok, false);
    assert.equal(why.owner, 'matrix-routing');
    assert.ok(why.error);

    const nobody = await fetch(base + '/__lpp/addresses/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: '/nobody/here', args: [] })
    });
    assert.equal(nobody.status, 404);

    await fetch(base + '/__lpp/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugins: { 'matrix-routing': { enabled: false } } })
    });
    const after = await (await fetch(base + '/__lpp/addresses')).json();
    assert.deepEqual(after.addresses, [], 'switched off, its addresses are nobody’s');
  });
});
