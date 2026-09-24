#!/usr/bin/env node
/*
 * The device host — the program that holds USB and HID devices for
 * LivePremier Plus. `README.md` beside this says why it is a program of its
 * own; `core.js` is what it does.
 *
 * It is not run by hand. LivePremier Plus starts it with `fork`, talks to it
 * over the IPC channel that gives, restarts it if it dies, and stops it when
 * it stops. The channel closing is the end: a host whose app has gone exits,
 * so there is never an orphan holding a panel.
 *
 *   --hid <module>   load this in place of node-hid — the tests' fake panel
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHostCore, loadModules } from './core.js';

const HERE = dirname(fileURLToPath(import.meta.url));

if (!process.send) {
  console.error('The device host is started by LivePremier Plus, not by hand: run the app, and it starts this when devices/ is installed (npm run setup:devices).');
  process.exit(2);
}

const argv = process.argv.slice(2);
const at = argv.indexOf('--hid');
const hidPath = at >= 0 ? argv[at + 1] : null;

async function loadHid() {
  try {
    const mod = await import(hidPath ? pathToFileURL(resolve(hidPath)).href : 'node-hid');
    return { hid: mod.default ?? mod, reason: null };
  } catch (err) {
    const missing = err?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(err?.message ?? '');
    return {
      hid: null,
      reason: missing
        ? 'node-hid is not installed in devices/ (npm run setup:devices).'
        : `node-hid failed to load: ${err.message}`,
    };
  }
}

const send = (msg) => { try { process.send(msg); } catch { /* the app has gone; disconnect ends us */ } };
const log = (text) => send({ type: 'log', text });

const { hid, reason } = await loadHid();
const core = createHostCore({ hid, reason, modules: await loadModules(join(HERE, 'modules'), log), send, log });

process.on('message', (msg) => { void core.handle(msg); });

let ending = false;
async function end() {
  if (ending) return;
  ending = true;
  await core.stop();
  process.exit(0);
}
process.on('disconnect', end);
process.on('SIGTERM', end);
process.on('SIGINT', end);
