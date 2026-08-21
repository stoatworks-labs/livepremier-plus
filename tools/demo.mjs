#!/usr/bin/env node
/*
 * The demo environment.
 *
 *   npm run demo
 *
 * Brings up LivePremier Plus against a LivePremier Simulator, with a real
 * Aquilon C's resource map folded in and an example cue stack already loaded —
 * so every panel has something real to show without a switcher in the room.
 *
 * ## Why it needs a simulator, and why that is not a cop-out
 *
 * The panels are not a standalone app. They mount into Web RCS's own sidebar,
 * are drawn with Web RCS's own utility classes, and ride Web RCS's own socket.
 * A demo that stubbed all of that would be a demo of something else. The
 * simulator is Analog Way's own, runs locally, and is the honest way to have
 * the genuine vendor UI without a device — and no vendor asset is copied into
 * this repo to achieve it.
 *
 * What the simulator cannot provide is a VPU: it has no `vpuMixerList` at all.
 * `tools/demo/seed.js` supplies that from the recorded capture. Everything
 * else stays the simulator's own live state, so cues fired from the timeline
 * really do go on the wire.
 *
 * ## What it will not do
 *
 * It will not point at a real device. The demo seeds a cue stack and splices a
 * store subtree, and neither belongs anywhere near a production frame. Pass a
 * real address and it refuses.
 */

import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProxy, NS, splitDevice } from '../server/proxy.js';
import { StackStore } from '../server/storage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.LPP_DEMO_PORT || 8535);

/* Where a simulator usually is. The vendor's own default is 3000; the rest are
   here because people move it. */
const CANDIDATES = (process.env.LPP_DEMO_DEVICE
  ? [process.env.LPP_DEMO_DEVICE]
  : ['127.0.0.1:3000', '127.0.0.1:3001', 'localhost:3000']);

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

/** Is something serving a Web RCS here? */
async function probe(address) {
  const target = splitDevice(address, 80);
  if (!target) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://${target.host}:${target.port}/`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    /* Web RCS serves a tiny document that names itself and defers its bundle. */
    if (!/Web RCS/i.test(html)) return null;
    return `${target.host}:${target.port}`;
  } catch {
    return null;
  }
}

/**
 * Refuse to demo against anything that might be real.
 *
 * The seed splices a store subtree and writes a cue stack. Neither is anything
 * to do near a production frame, and "I thought it was the simulator" is
 * exactly the mistake worth making impossible.
 */
function assertNotRealHardware(address) {
  const host = address.split(':')[0];
  const loopback = host === 'localhost' || host === '127.0.0.1' || host.startsWith('127.');
  if (!loopback) {
    console.error(red(`\nRefusing to run the demo against ${address}.`));
    console.error('The demo splices a recorded capture into the store and seeds a cue stack.');
    console.error('That belongs on a simulator, not on a device someone might be using.\n');
    console.error(dim('To drive a real switcher, use:  npm start -- --device ' + address + '\n'));
    process.exit(2);
  }
}

/** A short cue stack that exercises the engine without needing a show file. */
function demoStack() {
  return {
    version: 1,
    name: 'Demo — house open to act one',
    cues: [
      {
        id: 'demo-1', number: '1', label: 'House open', notes: 'Preset 1 to preview, then take.',
        enabled: true, fade: 1, delay: 0, follow: false, followTime: 0,
        actions: [
          { kind: 'screenPreset', slot: 1, targets: ['S1'], mode: 'PREVIEW' },
          { kind: 'take', targets: ['S1'] }
        ]
      },
      {
        id: 'demo-2', number: '2', label: 'Preshow loop', notes: 'Slower fade.',
        enabled: true, fade: 2.5, delay: 0, follow: false, followTime: 0,
        actions: [
          { kind: 'screenPreset', slot: 2, targets: ['S1'], mode: 'PREVIEW' },
          { kind: 'take', targets: ['S1'] }
        ]
      },
      {
        id: 'demo-3', number: '3', label: 'Lights down', notes: 'Auto-follows into the next cue.',
        enabled: true, fade: 1, delay: 0, follow: true, followTime: 3,
        actions: [
          { kind: 'screenPreset', slot: 3, targets: ['S1'], mode: 'PREVIEW' },
          { kind: 'take', targets: ['S1'] }
        ]
      },
      {
        id: 'demo-4', number: '4', label: 'Act one — hard cut', notes: 'CUT, so no transition time.',
        enabled: true, fade: null, delay: 0, follow: false, followTime: 0,
        actions: [
          { kind: 'screenPreset', slot: 4, targets: ['S1'], mode: 'PREVIEW' },
          { kind: 'cut', targets: ['S1'] }
        ]
      }
    ]
  };
}

const found = [];
for (const candidate of CANDIDATES) {
  const hit = await probe(candidate);
  if (hit) { found.push(hit); break; }
}

if (!found.length) {
  console.error(red('\nNo LivePremier Web RCS found to borrow the UI from.'));
  console.error(`Looked at: ${CANDIDATES.join(', ')}\n`);
  console.error('The demo needs a running ' + bold('LivePremier Simulator') + ', because the panels');
  console.error('mount inside the vendor\'s own Web RCS — a stubbed one would be a demo of');
  console.error('something that is not the product.\n');
  console.error('Start the simulator, then run this again. If it is on another port:');
  console.error(dim('  LPP_DEMO_DEVICE=127.0.0.1:3001 npm run demo\n'));
  process.exit(1);
}

const device = found[0];
assertNotRealHardware(device);

/* A scratch data dir, so the demo's cue stack never lands on top of real work
   in ~/.livepremier-plus. Removed on the way out. */
const dataDir = await mkdtemp(join(tmpdir(), 'lpp-demo-'));
const storage = new StackStore(dataDir);
await storage.save(device, demoStack());

const server = await createProxy({
  device,
  root: ROOT,
  storage,
  extraModules: [`${NS}/demo/seed.js`],
  extraFiles: {
    '/demo/seed.js': join(ROOT, 'tools', 'demo', 'seed.js'),
    '/demo/resources.json': join(ROOT, 'test', 'fixtures', 'aquilon-c-live-resources.json')
  },
  log: (msg) => console.log(dim(`[demo] ${msg}`))
});

server.on('error', (err) => {
  console.error(red(`[demo] ${err.code === 'EADDRINUSE' ? `port ${PORT} is in use` : err.message}`));
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`
${bold('LivePremier Plus — demo environment')}

  ${green('▸')} ${bold(url)}

  Web RCS from   ${device} ${dim('(simulator)')}
  VPU map from   ${dim('a real Aquilon C capture, read 2026-08-21')}
  Cue stack      ${dim('4 demo cues, pre-loaded')}
  Cue data in    ${dim(dataDir)}

${bold('Things worth trying')}

  ${bold('PLUS ▸ VPU Map')}
    32 of 64 mixers fitted, 26 allocated, 6 spare.
    ${dim('CURRENT vs STAGED differ in 26 mixers — and every difference is a link')}
    ${dim('move with no property changed, which a properties-only diff calls "no change".')}
    ${dim('S1 is Optimized, so its 4-link boundary is correctly not drawn.')}

  ${bold('PLUS ▸ Timeline')}
    GO runs the stack. Cue 3 auto-follows into 4 after 3s.
    ${dim('These are real writes — the simulator receives genuine preset recalls and takes.')}

  ${bold('Arithmetic in any numeric field')}
    Select a layer ▸ Properties ▸ Position & Size, then type ${bold('1080-80')}
    into Width and press Enter. ${dim('Also try 1920/2 and (1920-40)/2.')}

${dim('Ctrl-C to stop. The demo cue stack is deleted on exit; ~/.livepremier-plus is untouched.')}
`);
});

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    console.log('\n[demo] stopping');
    server.closeRelays();
    server.closeAllConnections?.();
    server.close();
    await rm(dataDir, { recursive: true, force: true });
    process.exit(0);
  });
}
