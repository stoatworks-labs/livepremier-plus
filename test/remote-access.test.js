/*
 * Remote access: the CLI parsers against captured output, and the plugin's
 * reconcile loop against fake CLIs and a fake `app.listen` — no Tailscale or
 * ZeroTier needed to run it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTailscaleStatus, serveHolder, serveUrl, parseZeroTierNetworks, zeroTierAddresses,
  parseZeroTierInfo, validAuthKey, validHostname, validNetworkId, failure, run
} from '../plugins/remote-access/overlay.js';
import activate, { settings as schema } from '../plugins/remote-access/server.js';

/* Trimmed from `tailscale status --json` on 1.102.4. */
const TS_STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'venue-lpp.tail745ddc.ts.net.', HostName: 'venue-lpp', TailscaleIPs: ['100.111.187.92', 'fd7a:115c:a1e0::5601:bb89'] },
  CertDomains: ['venue-lpp.tail745ddc.ts.net'],
  CurrentTailnet: { Name: 'example.org' }
});

/* Trimmed from `zerotier-cli -j listnetworks` on 1.14. */
const ZT_NETS = JSON.stringify([
  { nwid: '48d6023c4645d470', name: 'venue', status: 'OK', assignedAddresses: ['fd48:d602:3c46:45d4:7099:9382:5436:6c32/88', '10.147.17.93/24'] },
  { nwid: 'a09acf0233e4b070', name: '', status: 'ACCESS_DENIED', assignedAddresses: [] }
]);

test('tailscale status: name without the trailing dot, addresses, HTTPS names', () => {
  const s = parseTailscaleStatus(TS_STATUS);
  assert.equal(s.state, 'Running');
  assert.equal(s.name, 'venue-lpp.tail745ddc.ts.net');
  assert.deepEqual(s.addresses, ['100.111.187.92', 'fd7a:115c:a1e0::5601:bb89']);
  assert.deepEqual(s.httpsNames, ['venue-lpp.tail745ddc.ts.net']);
  assert.equal(parseTailscaleStatus('not json').state, '');
});

test('serve status: our root proxy, somebody else’s, or nobody', () => {
  const ours = { TCP: { 443: { HTTPS: true } }, Web: { 'x.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8535' } } } } };
  assert.equal(serveHolder(ours, 443), 'http://127.0.0.1:8535');
  assert.equal(serveHolder(ours, 8443), null);
  const paths = { TCP: { 443: { HTTPS: true } }, Web: { 'x.ts.net:443': { Handlers: { '/grafana': { Proxy: 'http://127.0.0.1:3000' } } } } };
  assert.equal(serveHolder(paths, 443), '(other)');
  assert.equal(serveHolder({ TCP: { 443: { TCPForward: '127.0.0.1:22' } } }, 443), '(other)');
  assert.equal(serveHolder('{}', 443), null);
});

test('the served URL omits 443', () => {
  assert.equal(serveUrl('a.ts.net', 443), 'https://a.ts.net/');
  assert.equal(serveUrl('a.ts.net', 8443), 'https://a.ts.net:8443/');
});

test('zerotier: only authorised networks give addresses, prefix lengths dropped', () => {
  const nets = parseZeroTierNetworks(ZT_NETS);
  assert.equal(nets.length, 2);
  assert.equal(nets[1].status, 'ACCESS_DENIED');
  assert.deepEqual(zeroTierAddresses(nets), ['fd48:d602:3c46:45d4:7099:9382:5436:6c32', '10.147.17.93']);
  assert.deepEqual(parseZeroTierInfo({ address: '8254366c32', online: true, version: '1.14.2' }), { node: '8254366c32', online: true, version: '1.14.2' });
});

test('inputs are checked before any CLI sees them', () => {
  assert.ok(validAuthKey('tskey-auth-kAbCdEf123-XYZ'));
  assert.ok(!validAuthKey('--reset'));
  assert.ok(!validAuthKey('tskey-auth abc'));
  assert.ok(validHostname('venue-lpp'));
  assert.ok(!validHostname('-venue'));
  assert.ok(!validHostname('venue.lpp'));
  assert.ok(validNetworkId('48d6023c4645d470'));
  assert.ok(!validNetworkId('48d6023c4645d47'));
});

test('a failure keeps the CLI’s first line and pulls out a URL', () => {
  assert.deepEqual(failure({ missing: true }, 'tailscale'), { error: 'tailscale is not installed on this host' });
  assert.deepEqual(failure({ stderr: '\nServe is not enabled on your tailnet.\nTo enable, visit:\n\n  https://login.tailscale.com/f/serve?node=abc\n', stdout: '', timedOut: true }, 'tailscale serve'),
    { error: 'tailscale serve is waiting on a page in a browser', url: 'https://login.tailscale.com/f/serve?node=abc' });
  assert.deepEqual(failure({ stderr: 'access denied: …\n', stdout: '', timedOut: false }, 'tailscale up'), { error: 'access denied: …' });
});

test('run: a missing binary is an answer, not a throw', async () => {
  const r = await run('lpp-no-such-binary-anywhere', []);
  assert.equal(r.ok, false);
  assert.equal(r.missing, true);
});

test('settings: off by default, unknown values refused', () => {
  assert.deepEqual(schema.normalise(undefined), { tailscale: 'off', httpsPort: 443, zerotier: false });
  assert.deepEqual(schema.normalise({ tailscale: 'funnel', httpsPort: 80, zerotier: 'yes' }), { tailscale: 'off', httpsPort: 443, zerotier: false });
  assert.deepEqual(schema.normalise({ tailscale: 'serve', httpsPort: '8443', zerotier: true }), { tailscale: 'serve', httpsPort: 8443, zerotier: true });
});

/* ---------------------------------------------------------- the plugin -- */

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function harness({ appliance = false, bind = '127.0.0.1', initial = {}, ts = {}, zt = {} } = {}) {
  let current = schema.normalise(initial);
  const listeners = [];
  const disposers = [];
  const routes = new Map();
  const open = new Set();
  const calls = [];
  let serveConfig = null;

  const app = {
    appliance, bind, port: 8535,
    async listen(address) {
      if (address.startsWith('fd48')) { const e = new Error('address not available'); e.code = 'EADDRNOTAVAIL'; throw e; }
      open.add(address);
      return { address, port: 8535, close: async () => { open.delete(address); } };
    }
  };
  const tailscale = {
    status: async () => ({ installed: true, ...parseTailscaleStatus(TS_STATUS), ...ts }),
    serveHolder: async () => serveConfig,
    serve: async (httpsPort, port) => { calls.push(['serve', httpsPort]); serveConfig = `http://127.0.0.1:${port}`; return { ok: true }; },
    unserve: async (httpsPort) => { calls.push(['unserve', httpsPort]); serveConfig = null; return { ok: true }; },
    up: async (key) => { calls.push(['up', key]); return { ok: true }; },
    down: async () => ({ ok: true }),
    rename: async (n) => { calls.push(['rename', n]); return { ok: true }; }
  };
  const zerotier = {
    status: async () => ({ installed: true, node: '8254366c32', online: true, networks: parseZeroTierNetworks(ZT_NETS), error: null, ...zt }),
    join: async (id) => { calls.push(['join', id]); return { ok: true }; },
    leave: async (id) => { calls.push(['leave', id]); return { ok: true }; }
  };
  const ctx = {
    HttpError,
    log: () => {},
    use: (name) => (name === 'app' ? app : null),
    settings: { get: () => current, onChange: (fn) => listeners.push(fn) },
    onDispose: (fn) => disposers.push(fn),
    route: (method, path, handler) => routes.set(`${method} ${path}`, handler)
  };
  const call = async (method, path, body) => {
    let answer;
    const h = { json: (status, b) => { answer = { status, body: b }; }, readJson: async () => body };
    try { await routes.get(`${method} ${path}`)({}, {}, h); }
    catch (err) { answer = { status: err.status || 500, body: { error: err.message } }; }
    return answer;
  };
  return {
    start: () => activate(ctx, { tailscale, zerotier, every: 1e9 }),
    set: async (patch) => {
      const prev = current;
      current = schema.normalise({ ...current, ...patch });
      for (const fn of listeners) fn(current, prev);
      await call('GET', '/state');
    },
    stop: async () => { for (const fn of disposers.reverse()) await fn(); },
    call, open, calls, serve: () => serveConfig
  };
}

test('off by default: no doors, no serve, no CLI touched', async () => {
  const hs = harness();
  await hs.start();
  assert.equal(hs.open.size, 0);
  assert.deepEqual(hs.calls, []);
  const st = await hs.call('GET', '/state');
  assert.equal(st.body.tailscale, null);
  assert.equal(st.body.zerotier, null);
  await hs.stop();
});

test('ZeroTier: a door on each authorised address; one not yet up is retried, not fatal', async () => {
  const hs = harness({ initial: { zerotier: true } });
  await hs.start();
  assert.deepEqual([...hs.open], ['10.147.17.93']);
  const st = await hs.call('GET', '/state');
  assert.deepEqual(st.body.doors, [{ address: '10.147.17.93', via: 'ZeroTier', port: 8535 }]);
  await hs.set({ zerotier: false });
  assert.equal(hs.open.size, 0);
  await hs.stop();
});

test('Tailscale serve: on, moved to another port, then off — and only ever ours is removed', async () => {
  const hs = harness({ initial: { tailscale: 'serve' } });
  await hs.start();
  assert.equal(hs.serve(), 'http://127.0.0.1:8535');
  let st = await hs.call('GET', '/state');
  assert.equal(st.body.tailscale.url, 'https://venue-lpp.tail745ddc.ts.net/');
  await hs.set({ httpsPort: 8443 });
  assert.deepEqual(hs.calls, [['serve', 443], ['unserve', 443], ['serve', 8443]]);
  await hs.set({ tailscale: 'off' });
  assert.equal(hs.serve(), null);
  st = await hs.call('GET', '/state');
  assert.equal(st.body.tailscale, null);
  await hs.stop();
});

test('Tailscale serve without HTTPS certificates says where to switch them on', async () => {
  const hs = harness({ initial: { tailscale: 'serve' }, ts: { httpsNames: [] } });
  await hs.start();
  const st = await hs.call('GET', '/state');
  assert.match(st.body.tailscale.serveError.error, /HTTPS certificates are off/);
  assert.equal(hs.serve(), null);
  await hs.stop();
});

test('Tailscale bind: doors on the tailnet addresses; a wildcard bind needs none', async () => {
  const hs = harness({ initial: { tailscale: 'bind' } });
  await hs.start();
  assert.deepEqual([...hs.open].sort(), ['100.111.187.92', 'fd7a:115c:a1e0::5601:bb89']);
  await hs.stop();
  assert.equal(hs.open.size, 0);

  const wide = harness({ bind: '0.0.0.0', initial: { tailscale: 'bind', zerotier: true } });
  await wide.start();
  assert.equal(wide.open.size, 0);
  assert.equal((await wide.call('GET', '/state')).body.wildcard, true);
  await wide.stop();
});

test('membership is refused unless started as an appliance', async () => {
  const hs = harness();
  await hs.start();
  const r = await hs.call('POST', '/zerotier/join', { network: '48d6023c4645d470' });
  assert.equal(r.status, 403);
  assert.deepEqual(hs.calls, []);
  await hs.stop();
});

test('an appliance joins and renames, with bad input refused before the CLI', async () => {
  const hs = harness({ appliance: true });
  await hs.start();
  assert.equal((await hs.call('POST', '/zerotier/join', { network: '48D6023C4645D470' })).status, 200);
  assert.equal((await hs.call('POST', '/zerotier/join', { network: '; rm -rf /' })).status, 409);
  assert.equal((await hs.call('POST', '/tailscale/up', { authKey: '--reset' })).status, 409);
  assert.equal((await hs.call('POST', '/tailscale/up', { authKey: 'tskey-auth-kAbCdEf123-XYZ' })).status, 200);
  assert.equal((await hs.call('POST', '/tailscale/rename', { name: 'venue-lpp-2' })).status, 200);
  /* No key, and the node is Running rather than Stopped: nothing to reconnect. */
  assert.equal((await hs.call('POST', '/tailscale/up', {})).status, 409);
  assert.deepEqual(hs.calls, [['join', '48d6023c4645d470'], ['up', 'tskey-auth-kAbCdEf123-XYZ'], ['rename', 'venue-lpp-2']]);
  await hs.stop();
});
