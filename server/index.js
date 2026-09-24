#!/usr/bin/env node
/*
 * LivePremier Plus — command-line entry point.
 *
 * Point it at a switcher, open the port it prints, and the vendor Web RCS
 * comes up with the extra panels already in it:
 *
 *   npx livepremier-plus --device 192.168.2.142
 *
 * The launcher app runs exactly this, with --host/--port supplied from the
 * panel's interface picker. There is no second code path for the desktop
 * build: what the app ships is this process with a window in front of it.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProxy } from './proxy.js';
import { StackStore } from './storage.js';
import { createDeviceHost, findDeviceHost } from './device-host.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = 'true';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  console.log(`LivePremier Plus — a VPU map and a cue stack inside the vendor Web RCS.

  --device <host[:port]>   the switcher. Optional — if omitted, the page asks,
                           and the last one used is remembered.
  --port <n>               local port to listen on   (default 8535)
  --host <addr>            local address to bind      (default 127.0.0.1)
  --data <dir>             where cue stacks are kept  (default ~/.livepremier-plus)
  --appliance              this host is the app's own: Remote access may join
                           and leave Tailscale and ZeroTier networks for it
  --no-devices             do not start the device host (USB panels), even
                           when devices/ is installed

Then open http://<host>:<port>/ in any browser.`);
  process.exit(0);
}

const port = Number(args.port || process.env.LPP_PORT || 8535);
/*
 * Loopback by default. This proxy is an unauthenticated route to a switcher's
 * full control surface, so binding it to every interface is a decision the
 * operator makes deliberately, not the default they get by accident.
 */
const host = args.host || process.env.LPP_HOST || '127.0.0.1';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const WILDCARD = new Set(['0.0.0.0', '::']);
/*
 * Bound to a LAN address, this server also answers on loopback — and a
 * browser on this machine that arrives by the LAN address is sent there
 * (server/local-client.js). Loopback is the one plain-http origin a browser
 * treats as a secure context, and Web MIDI — the MIDI Mapping panel, the MTC
 * timecode source — and audio input for LTC need one. Other machines still
 * need HTTPS for those, which this app does not serve yet; they get
 * everything else.
 *
 * A wildcard bind already includes loopback, so it gets the redirect and no
 * second listener: binding 127.0.0.1:port beside 0.0.0.0:port is refused on
 * Linux and merely redundant elsewhere.
 */
const redirectLocal = !LOOPBACK.has(host);
const loopbackToo = redirectLocal && !WILDCARD.has(host);
/*
 * An appliance: a box that exists to run this app, with no shell anybody at
 * the venue can reach. Only then does Remote access take charge of the host's
 * Tailscale and ZeroTier membership — on a laptop those belong to its owner.
 */
const appliance = Boolean(args.appliance) || /^(1|true|yes)$/i.test(process.env.LPP_APPLIANCE || '');
const dataDir = args.data || process.env.LPP_DATA || join(homedir(), '.livepremier-plus');
const storage = new StackStore(dataDir);

/*
 * A device on the command line wins; otherwise fall back to whichever one we
 * were last pointed at, and failing that start unconfigured and let the setup
 * page ask. The launcher takes this last path — it knows about ports and
 * interfaces, not about switchers.
 */
const device = args.device || process.env.LPP_DEVICE || (await storage.loadDevice());

/* The version is read off package.json rather than hard-coded, so an exported
   configuration file always names the build that actually wrote it. */
const appVersion = await readFile(join(ROOT, 'package.json'), 'utf8')
  .then((t) => JSON.parse(t).version || '')
  .catch(() => '');

/*
 * The device host: USB and HID panels, in a process of its own
 * (devices/README.md). Started whenever it is installed — the desktop app
 * carries it, `npm run setup:devices` installs it in a checkout — and not with
 * --no-devices or LPP_DEVICES=0. Plugins reach it as the `devices` service.
 */
const devicesOff = Boolean(args['no-devices']) || /^(0|false|no|off)$/i.test(process.env.LPP_DEVICES || '');
const found = findDeviceHost(ROOT);
const deviceHost = createDeviceHost({
  ...found,
  installed: found.installed && !devicesOff,
  reason: devicesOff ? 'The device host is switched off (--no-devices).' : found.reason,
  log: (msg) => console.log(`[lpp] ${msg}`)
});
deviceHost.start();

const server = await createProxy({
  device,
  root: ROOT,
  storage,
  appVersion,
  log: (msg) => console.log(`[lpp] ${msg}`),
  loopbackPort: redirectLocal ? port : null,
  bind: host,
  port,
  appliance,
  devices: deviceHost.api
});

server.on('error', (err) => {
  console.error(`[lpp] ${err.code === 'EADDRINUSE' ? `port ${port} is already in use` : err.message}`);
  process.exit(1);
});

server.listen(port, host, () => {
  const dest = server.lppState.device || 'no switcher yet — the page will ask';
  if (appliance) console.log('[lpp] appliance: Remote access may change this host\'s Tailscale and ZeroTier membership');
  console.log(`[lpp] LivePremier Plus on http://${host}:${port}/  ->  ${dest}`);
  if (WILDCARD.has(host)) {
    console.log('[lpp] bound to all interfaces — anyone on this network can drive the switcher');
    console.log(`[lpp] on this machine use http://127.0.0.1:${port}/ — the secure context Web MIDI needs; a local browser arriving by a LAN address is sent there`);
  }
});

const local = loopbackToo ? server.mirrorTo(http.createServer()) : null;
if (local) {
  local.on('error', (err) => {
    /* Not fatal: the LAN listener is up and everything but Web MIDI works
       there. Say so, rather than dying over the convenience door. */
    console.error(`[lpp] loopback listener: ${err.code === 'EADDRINUSE' ? `127.0.0.1:${port} is already in use` : err.message} — Web MIDI on this machine needs it`);
  });
  local.listen(port, '127.0.0.1', () => {
    console.log(`[lpp] also on http://127.0.0.1:${port}/ for this machine — the secure context Web MIDI needs; local browsers are sent there`);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n[lpp] stopping');
    /* Hang up the relayed sockets first. A Web RCS tab holds its connection
       open indefinitely and close() would otherwise wait on it forever —
       which, under the launcher, reads as a Stop button that does nothing. */
    const plugins = server.closeRelays();
    server.closeAllConnections?.();
    local?.closeAllConnections?.();
    local?.close();
    /* Exit once the listeners are closed and the plugins have stopped — one
       of them may be taking down a `tailscale serve` — but never later than
       three seconds: a Stop button that hangs is worse than a stale entry. */
    const closed = new Promise((resolve) => server.close(resolve));
    Promise.allSettled([closed, plugins, deviceHost.stop()]).then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
