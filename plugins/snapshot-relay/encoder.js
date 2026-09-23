/*
 * The main thread's side of the transcode worker.
 *
 * Its one promise is to never make a thumbnail later than the switcher would
 * have: a queue that is full, a worker that has died, a frame it cannot read —
 * each answers null at once, and the relay serves the PNG as it came.
 */

import { Worker } from 'node:worker_threads';

/* Frames waiting at most. Past this the worker is not keeping up, and waiting
   in line would only make every thumbnail late. */
const MAX_QUEUE = 8;
/* A frame the worker has not answered in this long is served as it came. */
const TIMEOUT_MS = 2000;

/**
 * @param {{settings: () => {quality: number, maxWidth: number}, log?: (msg: string) => void}} opts
 * @returns {{transcode: (png: Buffer) => Promise<{type: string, body: Buffer}|null>, stop: () => Promise<void>}}
 */
export function createEncoder({ settings, log = () => {} }) {
  let worker = null;
  let nextId = 1;
  const pending = new Map();
  let stopped = false;

  function settle(id, value) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(value);
  }

  function start() {
    worker = new Worker(new URL('./worker.js', import.meta.url));
    worker.on('message', (msg) => {
      if (msg.error) return settle(msg.id, null);
      settle(msg.id, { type: 'image/jpeg', body: Buffer.from(msg.jpeg.buffer, msg.jpeg.byteOffset, msg.jpeg.length) });
    });
    /* A dead worker fails what it held and is replaced on the next frame. */
    const lost = (why) => {
      log(`thumbnail relay: the encoder stopped (${why}); frames pass through until it restarts`);
      worker = null;
      for (const id of [...pending.keys()]) settle(id, null);
    };
    worker.on('error', (err) => lost(err.message));
    worker.on('exit', (code) => { if (!stopped && worker) lost(`exit ${code}`); });
    /* Not a reason to keep the app alive at shutdown. */
    worker.unref();
  }

  function transcode(png) {
    if (stopped || pending.size >= MAX_QUEUE) return Promise.resolve(null);
    if (!worker) start();
    const { quality, maxWidth } = settings();
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(id, null), TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      worker.postMessage({ id, png, quality, maxWidth });
    });
  }

  async function stop() {
    stopped = true;
    for (const id of [...pending.keys()]) settle(id, null);
    const w = worker;
    worker = null;
    if (w) await w.terminate();
  }

  return { transcode, stop };
}
