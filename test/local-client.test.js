/*
 * The loopback door for a LAN-bound server: who gets sent to 127.0.0.1, and
 * who must never be.
 *
 * Web MIDI and getUserMedia need a secure context, which plain http only has
 * on loopback. When the launcher binds the server to a LAN interface, a
 * browser on this very machine that arrives by the LAN address is one 302
 * from working — but the redirect must fire for that browser alone. The
 * decision is pure (server/local-client.js), so every arm of it is pinned
 * here without a socket; the proxy test proves it over one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loopbackRedirect, plainAddress, hostnameOf, isLoopbackHost } from '../server/local-client.js';
import { insecureContextAdvice, isLoopbackLocation } from '../src/core/secure-context.js';
import { createProxy, NS } from '../server/proxy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* A local browser at the LAN address: same address at both ends of the socket. */
const local = (over = {}) => ({
  method: 'GET', url: '/live/screens',
  headers: { host: '192.168.2.69:8534', accept: 'text/html,application/xhtml+xml' },
  remoteAddress: '192.168.2.69', localAddress: '192.168.2.69',
  ...over
});
const PORT = 8534;

test('a local browser at the LAN address is sent to loopback, path intact', () => {
  assert.equal(loopbackRedirect(local(), { port: PORT }), 'http://127.0.0.1:8534/live/screens');
  assert.equal(loopbackRedirect(local({ method: 'HEAD' }), { port: PORT }), 'http://127.0.0.1:8534/live/screens');
  /* v4 clients on a dual-stack socket arrive with the ::ffff: prefix on both ends. */
  assert.equal(loopbackRedirect(local({ remoteAddress: '::ffff:192.168.2.69', localAddress: '::ffff:192.168.2.69' }), { port: PORT }),
    'http://127.0.0.1:8534/live/screens');
});

test('nobody else is: another machine, a NAT’d VM, a fetch, a socket, or loopback itself', () => {
  /* Another machine: its own address as source. */
  assert.equal(loopbackRedirect(local({ remoteAddress: '192.168.2.50' }), { port: PORT }), null);
  /* A VM behind a NAT bridge whose gateway is one of OUR addresses — the case
     the "one of our addresses" test got wrong. Source is the bridge, not the
     interface it is talking to. */
  assert.equal(loopbackRedirect(local({ remoteAddress: '192.168.64.1', localAddress: '192.168.2.69' }), { port: PORT }), null);
  /* The vendor app's own fetches and its socket are left where they are. */
  assert.equal(loopbackRedirect(local({ headers: { host: '192.168.2.69:8534', accept: 'application/json' } }), { port: PORT }), null);
  assert.equal(loopbackRedirect(local({ headers: { host: '192.168.2.69:8534', accept: 'text/html', upgrade: 'websocket' } }), { port: PORT }), null);
  assert.equal(loopbackRedirect(local({ method: 'POST' }), { port: PORT }), null);
  /* Already on loopback, whatever the Host header claims. */
  assert.equal(loopbackRedirect(local({ headers: { host: '127.0.0.1:8534', accept: 'text/html' } }), { port: PORT }), null);
  assert.equal(loopbackRedirect(local({ headers: { host: 'localhost:8534', accept: 'text/html' } }), { port: PORT }), null);
  assert.equal(loopbackRedirect(local({ remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' }), { port: PORT }), null);
  /* No loopback listener means no door to point at. */
  assert.equal(loopbackRedirect(local(), { port: null }), null);
  /* Missing addresses are not a match. */
  assert.equal(loopbackRedirect(local({ remoteAddress: undefined, localAddress: undefined }), { port: PORT }), null);
});

test('address and host parsing', () => {
  assert.equal(plainAddress('::ffff:10.0.0.7'), '10.0.0.7');
  assert.equal(plainAddress('fe80::1'), 'fe80::1');
  assert.equal(plainAddress(undefined), '');
  assert.equal(hostnameOf('192.168.2.69:8534'), '192.168.2.69');
  assert.equal(hostnameOf('LOCALHOST:8535'), 'localhost');
  assert.equal(hostnameOf('[::1]:8535'), '::1');
  assert.equal(hostnameOf('::1'), '::1');
  assert.equal(isLoopbackHost('127.0.0.1:8535'), true);
  assert.equal(isLoopbackHost('192.168.2.69:8534'), false);
});

test('the advice names the page that is open and the loopback door with its port and path', () => {
  const text = insecureContextAdvice({ protocol: 'http:', host: '192.168.2.69:8534', port: '8534', hostname: '192.168.2.69', pathname: '/live/screens' });
  assert.match(text, /open at http:\/\/192\.168\.2\.69:8534/);
  assert.match(text, /http:\/\/127\.0\.0\.1:8534\/live\/screens/);
  assert.match(text, /MIDI Mapping/);
  assert.match(text, /LTC/);
  assert.match(text, /HTTPS, which this app does not serve yet/);
  /* Never the old wording, which told an operator already inside LivePremier
     Plus to open LivePremier Plus. */
  assert.doesNotMatch(text, /switcher's own address/);
  /* A default port is spelled out rather than left empty. */
  assert.match(insecureContextAdvice({ protocol: 'http:', host: 'lpp.local', pathname: '/' }), /http:\/\/127\.0\.0\.1:80\//);
  assert.equal(isLoopbackLocation({ hostname: 'localhost' }), true);
  assert.equal(isLoopbackLocation({ hostname: '[::1]' }), true);
  assert.equal(isLoopbackLocation({ hostname: '192.168.2.69' }), false);
});

/* ------------------------------------------------------------------ over a socket */

const lanAddress = () => {
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
};
const listen = (server, host) => new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
const close = (s) => new Promise((r) => { s.closeRelays?.(); s.closeAllConnections?.(); s.close(r); });

test('a LAN-bound proxy redirects a local top-level navigation to its loopback listener, and only that', { skip: !lanAddress() && 'no non-loopback IPv4 on this machine' }, async () => {
  const lan = lanAddress();
  const proxy = await createProxy({ device: null, root: ROOT, log: () => {}, loopbackPort: 1 });
  /* `loopbackPort: 1` is a stand-in: the port is only interpolated into the
     Location header, so the test reads it back rather than opening a second
     listener. index.js passes the real port. */
  const port = await listen(proxy, '0.0.0.0');
  try {
    const get = (host, headers) => new Promise((resolve, reject) => {
      http.get({ host, port, path: `${NS}/status`, headers }, (res) => {
        res.resume(); res.on('end', () => resolve(res));
      }).on('error', reject);
    });
    /* Arriving by the LAN address, wanting a page: 302 to loopback. */
    const page = await get(lan, { accept: 'text/html' });
    assert.equal(page.statusCode, 302);
    assert.equal(page.headers.location, `http://127.0.0.1:1${NS}/status`);
    /* The same address, wanting JSON — the vendor app's own requests: served. */
    const json = await get(lan, { accept: 'application/json' });
    assert.equal(json.statusCode, 200);
    /* Arriving by loopback: served, no matter what it wants. */
    const lo = await get('127.0.0.1', { accept: 'text/html' });
    assert.equal(lo.statusCode, 200);
  } finally {
    await close(proxy);
  }
});

test('mirrorTo serves the same routes and shares state on a second listener', async () => {
  const proxy = await createProxy({ device: null, root: ROOT, log: () => {} });
  const mirror = proxy.mirrorTo(http.createServer());
  const a = await listen(proxy, '127.0.0.1');
  const b = await listen(mirror, '127.0.0.1');
  try {
    const sa = await (await fetch(`http://127.0.0.1:${a}${NS}/status`)).json();
    const sb = await (await fetch(`http://127.0.0.1:${b}${NS}/status`)).json();
    assert.equal(sa.ok, true);
    assert.deepEqual(sb, sa, 'one state behind both doors');
    /* An upgrade through the mirror reaches the same handler: with no device
       configured it is refused the same way — destroyed, not answered. */
    const sock = net.connect(b, '127.0.0.1');
    await new Promise((r) => sock.on('connect', r));
    sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    const ended = await new Promise((r) => { sock.once('close', () => r('closed')); sock.once('data', (d) => r(d.toString().slice(0, 12))); });
    assert.equal(ended, 'closed');
  } finally {
    await close(mirror);
    await close(proxy);
  }
});
