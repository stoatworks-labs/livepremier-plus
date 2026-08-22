/*
 * LivePremier Plus — the reverse proxy that puts our panels inside the
 * vendor's own Web RCS.
 *
 * This replaces a Chrome extension, and it is worth being precise about why
 * it can. An MV3 content script at `document_start` races the vendor bundle:
 * it usually wins, but nothing in the platform promises it. Here we own the
 * HTML, and every vendor script tag is `defer` — so a plain inline script
 * written into <head> is ordered by the parser to run strictly before
 * boot.js and app.js. That is a guarantee rather than a race, and it is the
 * one thing the hook absolutely requires.
 *
 * Four things this has to get right:
 *
 *  1. Do not rewrite URLs. Every asset the Web RCS references is
 *     root-absolute (`/styles/app.<hash>.css`, `/app.<hash>.js`), so a
 *     path-preserving proxy needs no rewriting at all. Resist adding any —
 *     the vendor's hashes change every firmware and a rewriter would be one
 *     more thing to keep in step.
 *  2. Stream everything except the document. `GET /api/stores/device` is over
 *     100 MB; buffering it to inject into it would be absurd, and it is not
 *     HTML anyway. Only `text/html` is ever collected into memory.
 *  3. Relay the WebSocket at the byte level. The vendor computes
 *     `ws://${location.host}`, which is us, so nothing in the page needs
 *     patching — and because we hold exactly one upstream connection, the
 *     device's client count still reads true.
 *  4. Never let our own failure take the vendor UI down. A broken panel
 *     should look like a missing panel, not a dead console.
 */

import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

/** Where our own routes live. Namespaced so it cannot collide with a vendor path. */
export const NS = '/__lpp';

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

/** Plain host or IP only, before anything reaches net.connect. */
export function validHost(h) {
  return typeof h === 'string' && /^[A-Za-z0-9._-]{1,253}$/.test(h);
}

/**
 * Split "host" or "host:port" into parts, defaulting to the Web RCS port.
 *
 * A real device serves the UI on 80; the simulator uses 3000. Both are just
 * "the HTTP port the app is on" as far as this is concerned.
 */
export function splitDevice(device, fallbackPort = 80) {
  const m = String(device).match(/^([^:]+)(?::(\d+))?$/);
  if (!m || !validHost(m[1])) return null;
  const port = m[2] ? Number(m[2]) : fallbackPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

/**
 * Build the fragment injected into <head>.
 *
 * The hook goes in as an inline classic script rather than a src= tag: a
 * classic script with a src is *also* deferred relative to nothing, but an
 * inline one is guaranteed to execute at the point the parser reaches it,
 * which is before any deferred vendor script. The panels follow as a module,
 * which is deferred by definition and lands after the vendor bundle — exactly
 * where we want it, since it needs the app's DOM.
 */
export function buildInjection(hookSource, extraModules = []) {
  const extra = extraModules
    .map((src) => `\n<script type="module" src="${src}" data-lpp="extra"></script>`)
    .join('');
  return (
    `\n<script data-lpp="hook">\n${hookSource}\n</script>` +
    `\n<script type="module" src="${NS}/src/main.js" data-lpp="panels"></script>` +
    /* After the panels, so anything extra can rely on window.__WRU existing —
       modules execute in document order. Used by the demo environment to fold
       a recorded capture into a live store; empty in normal use. */
    `${extra}\n`
  );
}

/** Decompress an upstream body according to its Content-Encoding. */
function decode(buf, encoding) {
  switch ((encoding || '').trim().toLowerCase()) {
    case 'gzip': return zlib.gunzipSync(buf);
    case 'deflate': return zlib.inflateSync(buf);
    case 'br': return zlib.brotliDecompressSync(buf);
    default: return buf;
  }
}

/**
 * Create the proxy server.
 *
 * @param {object} opts
 * @param {string} opts.device        host or host:port of the Web RCS
 * @param {number} [opts.devicePort]  default port when `device` carries none
 * @param {string} opts.root          repo root, where src/ is served from
 * @param {object} [opts.storage]     {load(), save(data)} for cue stacks
 * @param {string[]} [opts.extraModules]  extra module URLs to inject after the panels
 * @param {Record<string,string>} [opts.extraFiles]  NS-relative path -> file on disk
 * @param {(msg:string)=>void} [opts.log]
 */
export async function createProxy({
  device = null, devicePort = 80, root, storage = null,
  extraModules = [], extraFiles = {}, log = () => {}
}) {
  /*
   * The switcher is chosen at runtime, not baked in at startup.
   *
   * Every other launcher in the fleet picks an interface and a port and is
   * done; this one also has to be pointed at a device, and a show operator
   * changes that more often than they restart anything. Keeping it here —
   * rather than as a startup flag the launcher would need a new field for —
   * means the desktop shell needs no special case at all, and re-pointing at
   * the backup frame costs a form submission instead of a restart.
   */
  let target = null;
  if (device) {
    target = splitDevice(device, devicePort);
    if (!target) throw new Error(`invalid device address: ${device}`);
  }

  /* Read the hook off disk once, at startup. Keeping it as a real file rather
     than a string in here means the tests and any future front-end load the
     same bytes the browser gets. */
  const hookSource = await readFile(join(root, 'src/hook/ws-hook.js'), 'utf8');
  const injection = buildInjection(hookSource, extraModules);

  /* Shown until a switcher is chosen. Self-contained on purpose: at this
     point there is no device to borrow a stylesheet from. */
  const setupPage = await readFile(join(root, 'server/setup.html'), 'utf8');

  /* The popped-out console. A document of ours rather than a proxied one, so
     it is served from here and not fetched from the switcher — but it must be
     on this origin, because it drives the Web RCS tab's own session through
     `window.opener` and that only works same-origin. */
  const consolePage = await readFile(join(root, 'server/console.html'), 'utf8');

  /*
   * Our own version, read off the manifest rather than duplicated in a
   * constant — the settings page prints it, and a number that has to be kept
   * in step by hand is a number that will eventually be wrong. A build that
   * cannot read it says so instead of inventing one.
   */
  let version = null;
  try { version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version || null; }
  catch { version = null; }

  const state = { device: target ? `${target.host}:${target.port}` : null, clients: 0, upstreamError: null, version };

  /*
   * Every socket pair we have relayed.
   *
   * An upgraded connection is detached from the HTTP server's own bookkeeping,
   * so `server.close()` neither counts it nor closes it — it simply waits, and
   * a Web RCS tab holds its socket open indefinitely. The launcher supervises
   * this process and its Stop button has to actually stop it, so shutdown has
   * to hang up the relays itself.
   */
  const relays = new Set();

  async function serveOwn(req, res, url) {
    const rest = url.pathname.slice(NS.length) || '/';

    if (rest === '/console') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(consolePage);
    }

    if (rest === '/status') {
      return sendJson(res, 200, { ...state, ok: true, configured: !!target });
    }

    if (rest === '/device') {
      if (req.method === 'GET') return sendJson(res, 200, { device: state.device });
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await collect(req, 4096);
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
        const next = splitDevice(String(parsed.device || ''), devicePort);
        if (!next) return sendJson(res, 400, { error: 'not a valid host or host:port' });

        /* Re-pointing means every relay is now attached to the wrong box.
           Hang them up so the page reconnects to the new one rather than
           quietly driving the old one. */
        server.closeRelays();
        target = next;
        state.device = `${next.host}:${next.port}`;
        state.upstreamError = null;
        if (storage && storage.saveDevice) await storage.saveDevice(state.device);
        log(`pointed at ${state.device}`);
        return sendJson(res, 200, { ok: true, device: state.device });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (rest === '/stack') {
      if (!storage) return sendJson(res, 501, { error: 'no storage configured' });
      if (req.method === 'GET') {
        return sendJson(res, 200, { data: await storage.load(state.device) });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await collect(req, 4 * 1024 * 1024);
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
        await storage.save(state.device, parsed && parsed.data !== undefined ? parsed.data : parsed);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    /* Anything a caller registered explicitly, by exact path. Nothing here is
       derived from the request, so there is no traversal surface — the demo
       environment uses it to serve a capture and its seed script. */
    if (Object.prototype.hasOwnProperty.call(extraFiles, rest)) {
      try {
        const body = await readFile(extraFiles[rest]);
        res.writeHead(200, {
          'content-type': TYPES[extname(extraFiles[rest])] || 'application/octet-stream',
          'cache-control': 'no-store'
        });
        return res.end(body);
      } catch (err) {
        log(`extra file ${rest}: ${err.message}`);
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
      }
    }

    /* Our own module tree. Path traversal is stripped before it touches the
       filesystem; only src/ is reachable regardless. */
    const clean = normalize(decodeURIComponent(rest)).replace(/^(\.\.[/\\])+/, '');
    if (!clean.startsWith('/src/')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    try {
      const body = await readFile(join(root, clean));
      res.writeHead(200, {
        'content-type': TYPES[extname(clean)] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  }

  function proxyHttp(req, res, url) {
    const headers = { ...req.headers, host: state.device };
    /* We are one hop, not a cache. Leave the rest of the request alone —
       the Web RCS API is unauthenticated but the vendor may add headers we
       know nothing about, and forwarding blind is the safe default. */
    delete headers['accept-encoding-original'];

    const upstream = http.request(
      { host: target.host, port: target.port, path: req.url, method: req.method, headers },
      (ur) => {
        const out = { ...ur.headers };
        /* A CSP from the device would forbid our inline hook. None is served
           today, on either the simulator or a real Aquilon — this is here so
           a future firmware that adds one does not silently break the panels. */
        delete out['content-security-policy'];
        delete out['content-security-policy-report-only'];

        const isHtml = String(ur.headers['content-type'] || '').includes('text/html');
        if (!isHtml) {
          res.writeHead(ur.statusCode, out);
          ur.pipe(res);
          return;
        }

        /* Documents only: collect, inject, re-send. These are ~600 bytes. */
        const chunks = [];
        ur.on('data', (c) => chunks.push(c));
        ur.on('end', () => {
          let body;
          try {
            body = decode(Buffer.concat(chunks), ur.headers['content-encoding']).toString('utf8');
          } catch (err) {
            log(`could not decode document: ${err.message}`);
            res.writeHead(ur.statusCode, out);
            res.end(Buffer.concat(chunks));
            return;
          }
          const injected = injectInto(body, injection);
          const buf = Buffer.from(injected, 'utf8');
          /* We are re-sending a body of our own length, in one piece. Both of
             the upstream's framing headers have to go: keeping
             transfer-encoding alongside a content-length is illegal and is
             rejected outright by strict clients. The device serves documents
             chunked, so this is the normal path, not an edge case. */
          delete out['content-encoding'];
          delete out['transfer-encoding'];
          out['content-length'] = String(buf.length);
          out['cache-control'] = 'no-store';
          res.writeHead(ur.statusCode, out);
          res.end(buf);
        });
      }
    );

    upstream.on('error', (err) => {
      state.upstreamError = err.message;
      log(`upstream ${state.device}: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`LivePremier Plus: cannot reach ${state.device} — ${err.message}`);
    });

    req.pipe(upstream);
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { res.writeHead(400); return res.end('bad request'); }

    if (url.pathname === NS || url.pathname.startsWith(NS + '/')) {
      serveOwn(req, res, url).catch((err) => {
        log(`own route failed: ${err.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: err.message });
      });
      return;
    }

    /* Nothing to proxy to yet. Serving the setup page for any path (rather
       than only for /) means a bookmarked deep link into the Web RCS also
       lands somewhere useful instead of on a 502. */
    if (!target) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(setupPage);
      return;
    }

    proxyHttp(req, res, url);
  });

  /*
   * The socket.
   *
   * Relayed byte-for-byte, which means this process never has to understand
   * WebSocket framing, continuation frames, or the ping/pong pair. It also
   * means exactly one connection reaches the device per browser tab, so the
   * client count in the Web RCS header stays honest.
   */
  server.on('upgrade', (req, socket, head) => {
    if (!target) { socket.destroy(); return; }
    const here = target;
    const upstream = net.connect(here.port, here.host, () => {
      const headers = { ...req.headers, host: state.device };
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(headers)
          .map(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`).join('\r\n') : `${k}: ${v}`))
          .join('\r\n') +
        '\r\n\r\n'
      );
      if (head && head.length) upstream.write(head);
      state.clients++;
      socket.pipe(upstream);
      upstream.pipe(socket);
      log(`socket relayed to ${state.device} (${state.clients} open)`);
    });

    const pair = { socket, upstream };
    relays.add(pair);

    const done = () => {
      if (!relays.delete(pair)) return;
      state.clients = Math.max(0, state.clients - 1);
      upstream.destroy();
      socket.destroy();
    };
    upstream.on('error', (err) => { log(`socket upstream: ${err.message}`); done(); });
    socket.on('error', done);
    upstream.on('close', done);
    socket.on('close', done);
  });

  server.lppState = state;

  /**
   * Stop, for real.
   *
   * `closeAllConnections()` covers ordinary requests; the relayed sockets are
   * ours to hang up. Without this a launcher Stop, or a test's teardown, waits
   * on a Web RCS tab that has no reason to ever disconnect.
   */
  server.closeRelays = () => {
    for (const { socket, upstream } of [...relays]) {
      upstream.destroy();
      socket.destroy();
    }
    relays.clear();
    state.clients = 0;
  };

  return server;
}

/**
 * Put the fragment in front of the vendor's scripts.
 *
 * `</head>` is the normal case. The fallbacks matter because a firmware could
 * serve a document without an explicit head close — and landing before the
 * first <script> is still early enough, since what we need is only to precede
 * the deferred vendor bundle.
 */
export function injectInto(html, fragment) {
  if (html.includes('</head>')) return html.replace('</head>', `${fragment}</head>`);
  if (html.includes('<script')) return html.replace('<script', `${fragment}<script`);
  if (html.includes('<body')) return html.replace('<body', `${fragment}<body`);
  return fragment + html;
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store'
  });
  res.end(buf);
}

function collect(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
