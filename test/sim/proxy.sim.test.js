/*
 * The proxy, in front of the real Web RCS.
 *
 * `test/proxy.test.js` covers the same plumbing against a stand-in on a real
 * socket. This is the other half: the vendor's actual document, bundle,
 * 100-plus MB store and socket, through the app, checked against what the
 * simulator serves directly.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { SKIP, target, startApp, Link, awjGet, sleep, sag, settled, take } from './harness.js';

let app;

before(async () => { if (!SKIP) app = await startApp(); });
after(async () => { if (app) await app.close(); });

/** GET without decompression, so bytes compare as bytes. */
function rawGet(host, port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host, port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

const vendorScripts = (html) => [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);

test('the vendor document comes back with the hook inlined ahead of every vendor script', { skip: SKIP }, async () => {
  const r = await rawGet('127.0.0.1', app.port, '/', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(r.status, 200);
  const html = r.body.toString('utf8');

  assert.match(html, /<title>Web RCS<\/title>/, 'still the vendor page');
  const hook = html.indexOf('__WRU_HOOK');
  assert.ok(hook > 0, 'the socket hook is inlined');
  for (const src of vendorScripts(html).filter((s) => !s.startsWith('/__lpp'))) {
    assert.ok(html.indexOf(src) > hook, `${src} comes after the hook`);
  }
  assert.ok(html.includes('/__lpp/src/main.js'), 'the panels module is injected');

  /* Re-sent whole: one length, no chunking, no stale encoding. */
  assert.equal(r.headers['transfer-encoding'], undefined);
  assert.equal(r.headers['content-encoding'], undefined);
  assert.equal(Number(r.headers['content-length']), r.body.length);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('a vendor bundle streams through byte for byte', { skip: SKIP }, async () => {
  const direct = await rawGet(target.host, target.port, '/');
  const bundle = vendorScripts(direct.body.toString('utf8')).find((s) => /\/app\.[0-9a-f]+\.js$/.test(s));
  assert.ok(bundle, 'the vendor page names an app bundle');

  const headers = { 'accept-encoding': 'gzip' };
  const [a, b] = await Promise.all([
    rawGet(target.host, target.port, bundle, headers),
    rawGet('127.0.0.1', app.port, bundle, headers)
  ]);
  assert.equal(b.status, 200);
  assert.equal(b.headers['content-encoding'], a.headers['content-encoding'], 'encoding passed through untouched');
  assert.ok(b.body.length > 100000, 'a real bundle, not an error page');
  assert.ok(a.body.equals(b.body), 'identical bytes');
});

test('the device store streams through and parses as the vendor serves it', { skip: SKIP }, async () => {
  const res = await fetch(app.base + '/api/stores/device', { headers: { 'cache-control': 'no-cache' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.device, 'rooted at device');
  for (const k of ['screenAuxGroupList', 'presetBank', 'masterPresetBank', 'inputList', 'outputList', 'system', 'preconfig']) {
    assert.ok(body.device[k], `has ${k}`);
  }
  assert.equal(body.device.system.deviceList.items['1'].pp.isSimulated, true);
});

test('a source thumbnail is relayed when no plugin answers it', { skip: SKIP }, async () => {
  const res = await fetch(app.base + '/api/device/snapshots/inputs/1');
  /* The simulator answers something for every input; what matters is that
     the proxy relays its answer rather than inventing one. */
  const direct = await fetch(`http://${target.host}:${target.port}/api/device/snapshots/inputs/1`);
  assert.equal(res.status, direct.status);
  assert.equal(res.headers.get('content-type'), direct.headers.get('content-type'));
});

test('one tab is one socket at the switcher, and the mirror follows a take', { skip: SKIP }, async (t) => {
  const a = await Link.open(app);
  t.after(() => a.close());
  await sleep(300);
  const clientsA = initClients(a);

  const b = await Link.open(app);
  t.after(() => b.close());
  await sleep(300);
  const clientsB = initClients(b);

  assert.equal(clientsB.ws.length, clientsA.ws.length + 1, 'the second tab added exactly one client');
  assert.equal(clientsB.awj.length, clientsA.awj.length, 'and opened no AWJ connection behind it');

  /* A take on one link reaches the other's mirror. */
  const from = await settled(a);
  const to = await take(a);
  assert.notEqual(to, from);
  await b.waitFor(sag('S1', 'status', 'transition'), to);
  assert.equal(await awjGet(sag('S1', 'status', 'transition')), to, 'AWJ agrees');
  await take(a);
  await b.waitFor(sag('S1', 'status', 'transition'), from);
  await a.rearm();
});

function initClients(link) {
  const init = link.remote.find((d) => d && d.channel === 'INIT');
  assert.ok(init, 'the switcher sent its REMOTE snapshot');
  const net = init.snapshot.system.network;
  return { ws: net.websocketServer.clients, awj: net.awjServer.clients };
}

test('status names the simulator and the version', { skip: SKIP }, async () => {
  const r = await app.api('/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.configured, true);
  assert.equal(r.json.device, `${target.host}:${target.port}`);
  assert.match(r.json.version, /^\d+\.\d+\.\d+/);
});

test('/awj gets from the switcher and refuses anything but get and replace', { skip: SKIP }, async () => {
  const ok = await app.api('/awj', {
    method: 'POST',
    body: { messages: [
      { op: 'get', path: 'DeviceObject/system/$device/@items/1/@props/dev' },
      /* A path the model does not have answers null rather than an error. */
      { op: 'get', path: 'DeviceObject/$device/@items/1/@props/dev' }
    ] }
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.replies.length, 2);
  const model = await awjGet(['device', 'system', 'deviceList', 'items', '1', 'pp', 'dev']);
  assert.match(model, /^NLC_/);
  assert.equal(ok.json.replies[0].value, model);
  assert.equal(ok.json.replies[1].value, null);

  const bad = await app.api('/awj', { method: 'POST', body: { messages: [{ op: 'delete', path: 'DeviceObject' }] } });
  assert.equal(bad.status, 400);
  const none = await app.api('/awj', { method: 'POST', body: { messages: [] } });
  assert.equal(none.status, 400);
  const wrong = await app.api('/awj');
  assert.equal(wrong.status, 405);
});

test('/awj replace writes, and a get in the same exchange reads it back', { skip: SKIP }, async () => {
  const path = sag('S1', 'control', 'takeUpTime');
  const awjPath = 'DeviceObject/$screenAuxGroup/@items/S1/control/@props/takeUpTime';
  const was = await awjGet(path);
  try {
    const r = await app.api('/awj', {
      method: 'POST',
      body: { messages: [{ op: 'replace', path: awjPath, value: was === 23 ? 24 : 23 }] }
    });
    assert.equal(r.status, 200);
    await sleep(150);
    assert.equal(await awjGet(path), was === 23 ? 24 : 23);
  } finally {
    await app.api('/awj', { method: 'POST', body: { messages: [{ op: 'replace', path: awjPath, value: was }] } });
    await sleep(150);
    assert.equal(await awjGet(path), was, 'put back');
  }
});

test('our own modules are served, and nothing outside src/ is', { skip: SKIP }, async () => {
  const main = await app.api('/src/main.js', { raw: true });
  assert.equal(main.status, 200);
  assert.match(main.headers.get('content-type'), /javascript/);
  for (const p of ['/src/../package.json', '/src/%2e%2e/package.json', '/server/proxy.js', '/package.json']) {
    const r = await app.api(p, { raw: true });
    assert.equal(r.status, 404, `${p} is not served`);
  }
});

test('the plugin list names every built-in and what state it is in', { skip: SKIP }, async () => {
  const r = await app.api('/plugins');
  assert.equal(r.status, 200);
  assert.ok(Number.isInteger(r.json.apiVersion));
  const ids = r.json.plugins.map((p) => p.id);
  for (const id of ['timeline', 'console', 'memories', 'layer', 'vpu-map', 'osc-input', 'layer-groups', 'matrix-routing']) {
    assert.ok(ids.includes(id), `${id} is listed`);
  }
});

test('re-pointing hangs up the vendor relays and keeps the app working', { skip: SKIP }, async () => {
  const link = await Link.open(app);
  const closed = new Promise((resolve) => link.ws.once('close', resolve));

  const bad = await app.api('/device', { method: 'PUT', body: { device: 'not a host!' } });
  assert.equal(bad.status, 400);

  const r = await app.api('/device', { method: 'PUT', body: { device: `${target.host}:${target.port}` } });
  assert.equal(r.status, 200);
  await Promise.race([closed, sleep(3000).then(() => { throw new Error('the relay was not hung up'); })]);

  /* And a new tab comes straight back. */
  const again = await Link.open(app);
  assert.equal(again.get(sag('S1', 'status', 'isUsed')), true);
  again.close();
});
