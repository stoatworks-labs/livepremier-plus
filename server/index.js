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

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProxy } from './proxy.js';
import { StackStore } from './storage.js';

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
const dataDir = args.data || process.env.LPP_DATA || join(homedir(), '.livepremier-plus');
const storage = new StackStore(dataDir);

/*
 * A device on the command line wins; otherwise fall back to whichever one we
 * were last pointed at, and failing that start unconfigured and let the setup
 * page ask. The launcher takes this last path — it knows about ports and
 * interfaces, not about switchers.
 */
const device = args.device || process.env.LPP_DEVICE || (await storage.loadDevice());

const server = await createProxy({
  device,
  root: ROOT,
  storage,
  log: (msg) => console.log(`[lpp] ${msg}`)
});

server.on('error', (err) => {
  console.error(`[lpp] ${err.code === 'EADDRINUSE' ? `port ${port} is already in use` : err.message}`);
  process.exit(1);
});

server.listen(port, host, () => {
  const dest = server.lppState.device || 'no switcher yet — the page will ask';
  console.log(`[lpp] LivePremier Plus on http://${host}:${port}/  ->  ${dest}`);
  if (host === '0.0.0.0') console.log('[lpp] bound to all interfaces — anyone on this network can drive the switcher');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n[lpp] stopping');
    /* Hang up the relayed sockets first. A Web RCS tab holds its connection
       open indefinitely and close() would otherwise wait on it forever —
       which, under the launcher, reads as a Stop button that does nothing. */
    server.closeRelays();
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
