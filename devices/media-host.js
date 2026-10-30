#!/usr/bin/env node
/*
 * The media host — the program that sends LivePremier Plus's pictures out as
 * NDI. The device host's sibling: the same folder, the same koffi, the same
 * reasons to be a process of its own (`README.md`), and one more — a runtime
 * that falls over takes this down, not the app driving a show. `media/core.js`
 * is what it does.
 *
 * It is not run by hand. LivePremier Plus starts it with `fork` and
 * `serialization: 'advanced'`, restarts it if it dies, and stops it when it
 * stops; the channel closing is the end, and the feeds go with it.
 *
 *   --ndi <module>   load this in place of `media/ndi.js`'s runtime — its
 *                    default export is `{ lib, reason }` (the tests' pretend runtime)
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMediaCore } from './media/core.js';
import { loadNdi } from './media/ndi.js';

if (!process.send) {
  console.error('The media host is started by LivePremier Plus, not by hand: run the app, and it starts this when devices/ is installed (npm run setup:devices).');
  process.exit(2);
}

const argv = process.argv.slice(2);
const at = argv.indexOf('--ndi');
const standIn = at >= 0 ? argv[at + 1] : null;

const send = (msg) => { try { process.send(msg); } catch { /* the app has gone; disconnect ends us */ } };
const log = (text) => send({ type: 'log', text });

async function runtime() {
  if (!standIn) return loadNdi();
  try {
    const mod = await import(pathToFileURL(resolve(standIn)).href);
    return mod.default ?? mod;
  } catch (err) {
    return { lib: null, reason: `the NDI stand-in did not load: ${err.message}` };
  }
}

const core = createMediaCore({ ndi: await runtime(), send, log });
process.on('message', (msg) => core.handle(msg));

let ending = false;
function end() {
  if (ending) return;
  ending = true;
  core.stop();
  process.exit(0);
}
process.on('disconnect', end);
process.on('SIGTERM', end);
process.on('SIGINT', end);
