/*
 * Thumbnail relay — the plugin's server half.  ** PREVIEW, OFF BY DEFAULT **
 *
 * The switcher's source thumbnails are PNGs its firmware writes with next to
 * no compression: ~148 KB for 256×144 on an Aquilon C, ~590 KB for 512×288 on
 * a Pulse 4K, each asked for about once a second per source by the Web RCS.
 * Ten inputs on a Pulse is ~47 Mbit/s of thumbnails.
 *
 * Switched on, this answers `/api/device/snapshots/…` in the proxy's place:
 * it fetches the PNG from the switcher, re-encodes it as a JPEG in a worker,
 * and hands the same frame to every page that asks within `maxAgeMs`. The
 * vendor's own `<img>` tags get the JPEG without a line of their code changed
 * — the browser reads the bytes, not the URL, to decide what it is.
 *
 * The proxy asks for this as the `snapshots` service (see `server/proxy.js`),
 * so when the plugin is off, or not running, requests go to the switcher
 * exactly as they always did. Anything this cannot do — a non-PNG answer, an
 * encoder that is behind — is served as the switcher sent it.
 *
 * Off by default until it has run against a real frame: a thumbnail that
 * looks right on a simulator's placeholder proves little about a camera feed.
 */

import http from 'node:http';
import { normalise, SNAPSHOT_PATH } from './core.js';
import { createRelay } from './relay.js';
import { createEncoder } from './encoder.js';

export const settings = { normalise };

/* The switcher answers a thumbnail in tens of milliseconds; one that has not
   in this long is not going to, and the vendor's next poll is due anyway. */
const FETCH_TIMEOUT_MS = 3000;
/* Headers from the page that the switcher may care about. Everything else —
   `if-none-match` above all — is ours to answer, not the device's. */
const FORWARD = ['cookie', 'authorization', 'user-agent', 'accept-language'];

export default function activate(ctx) {
  /* Keep-alive, and a small pool: the device is a switcher, not a web
     server, and the vendor asks for its inputs one at a time anyway. */
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  const encoder = createEncoder({ settings: ctx.settings.get, log: ctx.log });

  function fetchFromDevice(path, headers) {
    const device = ctx.device();
    if (!device) return Promise.reject(new Error('no switcher configured'));
    const [host, port] = splitHostPort(device);
    const out = { host: device };
    for (const k of FORWARD) if (headers[k]) out[k] = headers[k];
    return new Promise((resolve, reject) => {
      const req = http.get({ host, port, path, agent, headers: out, timeout: FETCH_TIMEOUT_MS }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`no answer from ${device} in ${FETCH_TIMEOUT_MS} ms`)));
      req.on('error', reject);
    });
  }

  const relay = createRelay({ fetch: fetchFromDevice, transcode: encoder.transcode, settings: ctx.settings.get });

  /**
   * Answer one vendor snapshot request, or say it is not ours (false) and let
   * the proxy relay it as before. Never throws.
   */
  async function serve(req, res, url) {
    if (req.method !== 'GET' || !SNAPSHOT_PATH.test(url.pathname)) return false;
    let r;
    try {
      r = await relay.get(url.pathname, req.headers);
    } catch (err) {
      ctx.log(`thumbnail relay: ${url.pathname}: ${err.message}`);
      /* Unreachable is the proxy's to report, the way it reports everything
         else unreachable — hand it back rather than invent a second message. */
      return false;
    }
    if (res.headersSent || res.destroyed) return true;
    const headers = {
      'content-type': r.type,
      'content-length': r.body.length,
      /* The vendor cache-busts every request itself; no-store keeps a browser
         from filling its cache with a thousand one-use thumbnails. */
      'cache-control': 'no-store',
      'x-lpp-relay': r.via
    };
    if (r.etag) {
      headers.etag = r.etag;
      if (req.headers['if-none-match'] === r.etag) {
        res.writeHead(304, { etag: r.etag, 'cache-control': 'no-store', 'x-lpp-relay': r.via });
        res.end();
        return true;
      }
    }
    res.writeHead(r.status, headers);
    res.end(r.body);
    return true;
  }

  ctx.provide('snapshots', Object.freeze({ serve }));

  ctx.route('GET', '/state', (req, res, h) => h.json(200, relay.stats()));

  /* The card follows the numbers live while it is open, and costs nothing
     while nobody is looking. */
  const stream = ctx.stream('/stream', { onOpen: (first) => first.send('stats', relay.stats()) });
  const beat = setInterval(() => { if (stream.size > 0) stream.send('stats', relay.stats()); }, 1000);
  beat.unref();

  ctx.onDispose(async () => {
    clearInterval(beat);
    agent.destroy();
    await encoder.stop();
  });
}

/** `host:port` → [host, port]; an IPv6 literal keeps its brackets off. */
function splitHostPort(device) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(device) || /^([^:]+):(\d+)$/.exec(device);
  return m ? [m[1], Number(m[2])] : [device, 80];
}
