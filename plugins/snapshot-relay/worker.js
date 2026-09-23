/*
 * The transcode, off the main thread.
 *
 * A 512×288 frame takes a few milliseconds to decode and encode. The process
 * this runs in also relays the Web RCS socket and every vendor request, so
 * thirty of those a second on the main thread would be felt as a lagging
 * T-bar. In a worker it costs the proxy nothing.
 */

import { parentPort } from 'node:worker_threads';
import { decodePng } from './png.js';
import { encodeJpeg } from './jpeg.js';
import { fitWidth } from './resize.js';

/* Imported anywhere but a worker — the module tests link every file in a
   plugin's folder — this does nothing, as a plugin's modules must. */
parentPort?.on('message', ({ id, png, quality, maxWidth }) => {
  try {
    const img = fitWidth(decodePng(Buffer.from(png)), maxWidth);
    const jpeg = encodeJpeg(img.data, img.width, img.height, quality);
    /* Transferred, not copied: the worker has no further use for it. */
    const out = new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.length).slice();
    parentPort.postMessage({ id, jpeg: out, width: img.width, height: img.height }, [out.buffer]);
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
