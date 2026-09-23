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

import {
  normalise as normaliseSettings, DEFAULT_SETTINGS,
  liftLegacy, mergeSettings,
} from '../src/core/settings.js';
import { API_VERSION, isEnabled as pluginOn, routeOwner } from '../src/core/plugins.js';
import { createPluginHost } from './plugin-host.js';
import { oscAddressFor } from '../src/core/contributions.js';
import { exchange as awjExchange } from './awj.js';
import { loopbackRedirect } from './local-client.js';

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
 * @param {string|null} [opts.pluginDir]  user plugins; defaults to `plugins/` in the data directory
 * @param {(msg:string)=>void} [opts.log]
 */
export async function createProxy({
  device = null, devicePort = 80, root, storage = null,
  extraModules = [], extraFiles = {}, log = () => {},
  /* Recorded in an exported configuration file, so a document says which
     build wrote it. Cosmetic; an empty string is fine. */
  appVersion = '',
  /* The port a loopback listener answers on, when this server is also bound
     to a LAN address — see local-client.js. Null means never redirect. */
  loopbackPort = null,
  /* Where index.js listens — the address and port — and whether it was
     started as an appliance (`--appliance`). None of it changes what this
     server does; it is what the `app` service tells plugins, so Remote access
     can open a door on another interface at the same port, and only takes
     charge of this host's networking when it was told the host is its own. */
  bind = null, port = null, appliance = false,
  /* Where user plugins are looked for: `plugins/` beside everything else this
     app keeps — `~/.livepremier-plus/plugins`, or `/config/plugins` in Docker.
     Null for none, which is what a caller with no data directory gets. */
  pluginDir = storage && storage.dir ? join(storage.dir, 'plugins') : null
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
   * The plugin host — see `server/plugin-host.js`.
   *
   * Created before the settings are read, because a plugin's settings schema
   * decides what of the stored file is kept and what a legacy field becomes.
   * The host loads every hosted plugin's server half now, switched on or not;
   * nothing is *started* until `host.sync` below.
   */
  const host = await createPluginHost({
    root,
    ns: NS,
    userDir: pluginDir,
    dataDir: storage && storage.dir ? storage.dir : null,
    /* Read per use, never captured: the switcher can be re-pointed. */
    device: () => state.device,
    awj: (messages) => (target
      ? awjExchange({ host: target.host, messages })
      : Promise.reject(new Error('no switcher configured'))),
    splitAddress: splitDevice,
    log
  });

  /*
   * Settings, and the UDP socket one of them opens.
   *
   * Loaded once at startup and held in memory: the panels read them on every
   * repaint, and hitting the disk for that would be silly. `src/core/settings.js`
   * owns what is allowed — a stored file that a person has edited is coerced
   * rather than rejected, because refusing to start over one bad field would
   * take the app down for a typo.
   */
  let settings = normaliseSettings(
    storage && storage.loadSettings ? await storage.loadSettings() : {}, host.schemas);

  /*
   * Whether a plugin is switched on — see `src/core/plugins.js`. Read per call,
   * never captured, so switching one off in the settings page is seen by the
   * next request and the next apply. The platform half of the question lives in
   * the page (it needs the device store); here it is the switch and the
   * dependencies.
   */
  const on = (id) => pluginOn(settings.plugins, id);

  /**
   * Apply a settings patch: merged onto what is already held, so a panel may
   * send one field without restating the rest and without racing another
   * surface that is changing a different one. A plugin's entry is merged a
   * level deeper, so a switch and its settings never wipe each other — and a
   * field from before plugins had a namespace is lifted into its plugin's on
   * the way in. See `core/settings.js`. The plugins are diffed by the host,
   * each by its own schema: settings are saved as a whole, and a change to
   * the console language must not rebind the OSC listener's socket.
   */
  async function applySettings(raw) {
    const patch = liftLegacy(raw, host.schemas);
    settings = normaliseSettings(mergeSettings(settings, patch), host.schemas);
    if (storage && storage.saveSettings) await storage.saveSettings(settings);
    await host.sync(settings);
    /* A user plugin switched on just now has only now brought its schema:
       fill its defaults in, so the page is sent what the plugin reads. */
    settings = normaliseSettings(settings, host.schemas);
    return settings;
  }

  /*
   * What the app offers its plugins, as the `app` service: its settings, and
   * the facts about this build and this switcher a setup file records. The
   * Setup file plugin restores `installation.settings` through it, so a
   * restored setting reaches the running app — and its plugins — at once,
   * rather than sitting in a file the running app would later overwrite.
   */
  host.provide('app', Object.freeze({
    version: appVersion || version || '',
    platform: () => state.platform || '',
    settings: () => settings,
    applySettings,
    hasStorage: Boolean(storage),
    appliance: Boolean(appliance),
    bind,
    port,
    listen
  }));

  /* The hosted plugins, started after the app's own services so that anything
     a plugin asks of the app is already there to answer. A user plugin's
     settings schema only arrives when it starts — its code is not imported
     before — so the settings are read through the schemas once more after. */
  await host.sync(settings);
  settings = normaliseSettings(settings, host.schemas);

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

  /*
   * Doors a plugin opened with the `app` service's `listen` — see below.
   * Kept here so a shutdown hangs them up with everything else.
   */
  const doors = new Set();
  let built;
  const serverBuilt = new Promise((resolve) => { built = resolve; });

  /**
   * Answer on one more address, at the app's own port: the same server —
   * every handler, relay and piece of state — behind another listener, as
   * the loopback door beside a LAN bind is.
   *
   * It is the one way a plugin gets a listener, and the plugin does not get
   * to hold it: it gets `close()`, and the host's own shutdown closes every
   * door that is still open. Remote access opens one on each ZeroTier (and,
   * when asked, Tailscale) address this host has.
   *
   * @param {string} address  an IP address of this host
   * @returns {Promise<{address: string, port: number, close: () => Promise<void>}>}
   */
  async function listen(address) {
    if (!port) throw new Error('this server was not told its port');
    /* The plugins start before the server below exists; a door asked for
       then waits for it rather than touching it in its temporal dead zone. */
    const mirror = await serverBuilt;
    const door = mirror(http.createServer());
    return new Promise((resolve, reject) => {
      const failed = (err) => { door.close(); reject(err); };
      door.once('error', failed);
      door.listen(port, address, () => {
        door.off('error', failed);
        door.on('error', (err) => log(`door ${address}: ${err.message}`));
        doors.add(door);
        resolve({
          address, port,
          close: () => new Promise((done) => {
            if (!doors.delete(door)) return done();
            door.closeAllConnections?.();
            door.close(() => done());
          })
        });
      });
    });
  }

  async function serveOwn(req, res, url) {
    const rest = url.pathname.slice(NS.length) || '/';

    const owner = routeOwner(rest);
    if (owner && !on(owner)) {
      return sendJson(res, 404, { error: `the ${owner} plugin is switched off`, plugin: owner });
    }

    /*
     * The plugins.
     *
     * `/plugins` is the list the page host loads from and the settings page
     * will draw; `/plugins/<id>/…` is a running plugin's own files; and a
     * hosted plugin's routes are answered by the host. A path that is no
     * hosted plugin's falls through to the app's own routes below.
     */
    if (rest === '/plugins') {
      return sendJson(res, 200, { apiVersion: API_VERSION, plugins: host.list() });
    }
    if (await host.serveFile(rest, res)) return undefined;
    if (await host.handle(req, res, url, rest)) return undefined;

    /*
     * Settings.
     *
     * Server-side rather than in the page because two of them are not the
     * page's business: the OSC listener is a UDP socket in this process, and
     * the console exists in two windows at once — a per-page setting would
     * have the tab and the popout disagreeing about which language the
     * operator chose. See `src/core/settings.js`.
     */
    if (rest === '/settings') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { settings });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await collect(req, 16 * 1024);
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'invalid JSON' }); }

        await applySettings(parsed.settings ?? parsed);
        return sendJson(res, 200, { ok: true, settings });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    /*
     * A real AWJ exchange, on behalf of the page.
     *
     * The browser cannot open TCP 10606; this process can. Note what this is
     * NOT: it never reads into the store mirror, holds no connection and
     * subscribes to nothing. `awj.js` sets out why that keeps the
     * single-source-of-truth rule intact — read it before extending this.
     */
    if (rest === '/awj') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      if (!target) return sendJson(res, 409, { error: 'no switcher configured' });

      const body = await collect(req, 256 * 1024);
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch { return sendJson(res, 400, { error: 'invalid JSON' }); }

      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      if (messages.length === 0) return sendJson(res, 400, { error: 'no messages' });

      /* The op set is closed, and it is checked here rather than trusted from
         the page: this is the one route in the app that puts bytes on a socket
         chosen by whatever posted to it. */
      for (const m of messages) {
        if (m.op !== 'replace' && m.op !== 'get') {
          return sendJson(res, 400, { error: 'op must be "replace" or "get" — AWJ has no others' });
        }
        if (typeof m.path !== 'string' || !m.path) {
          return sendJson(res, 400, { error: 'every message needs a path' });
        }
      }

      try {
        const replies = await awjExchange({ host: target.host, messages });
        return sendJson(res, 200, { ok: true, replies });
      } catch (err) {
        /* 502, not 500: the failure is upstream, and saying so is what tells
           an operator to go and check the device's own AWJ setting. */
        return sendJson(res, 502, { error: err.message });
      }
    }

    /*
     * The address subtrees plugins answer, and one address run through them.
     *
     * This is how the Console reaches a plugin's addresses: a line typed there
     * that falls under one of these prefixes is posted here and takes exactly
     * the path the same address arriving over UDP takes. Two implementations
     * of one address space is how they drift, and the drift would show up as a
     * command that works from QLab and not from the Console — which is a
     * miserable thing to debug on a show. The app's own; nobody switches it off.
     */
    if (rest === '/addresses') {
      return sendJson(res, 200, {
        addresses: host.contributions('oscAddress').map((c) => ({
          prefix: c.prefix, describe: c.describe || '', owner: c.owner,
          entries: Array.isArray(c.entries) ? c.entries : []
        }))
      });
    }
    if (rest === '/addresses/run') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      const body = await collect(req, 16 * 1024);
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
      const address = String(parsed.address ?? '');
      const owner = oscAddressFor(host.contributions('oscAddress'), address);
      let answer = null;
      if (owner) {
        try { answer = await owner.handle(address, Array.isArray(parsed.args) ? parsed.args : []); }
        catch (err) { answer = { ok: false, error: err.message }; }
      }
      if (!answer) return sendJson(res, 404, { error: `no plugin answers ${address || 'that address'}` });
      return sendJson(res, answer.ok ? 200 : 409, { ...answer, owner: owner.owner });
    }


    if (rest === '/status') {
      return sendJson(res, 200, {
        ...state, ok: true, configured: !!target,
        settings
      });
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
           quietly driving the old one.

           ⚠️ The vendor relays ONLY. This used to call `closeRelays`, which by
           then also stopped the OSC listener, the routers, the Pixelhue panel
           and the Companion link — so pointing the app at a backup frame
           silently switched all four off until the next restart, the exact
           opposite of what each of them promises about a failover. The last
           two are plugins now, and the host keeps them running. */
        hangUpVendorRelays();
        target = next;
        state.device = `${next.host}:${next.port}`;
        state.upstreamError = null;
        if (storage && storage.saveDevice) await storage.saveDevice(state.device);
        log(`pointed at ${state.device}`);
        return sendJson(res, 200, { ok: true, device: state.device });
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

  const onRequest = (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { res.writeHead(400); return res.end('bad request'); }

    /* A browser on this machine looking at us through the LAN address is one
       redirect away from a secure context, and Web MIDI with it. */
    const better = loopbackRedirect(
      { method: req.method, url: req.url, headers: req.headers,
        remoteAddress: req.socket?.remoteAddress, localAddress: req.socket?.localAddress },
      { port: loopbackPort });
    if (better) {
      res.writeHead(302, { location: better, 'cache-control': 'no-store' });
      return res.end(`Opening LivePremier Plus at ${better} — a secure context, so Web MIDI works there.`);
    }

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

    /*
     * Source thumbnails, when a plugin offers to answer them — the `snapshots`
     * service, which the Thumbnail relay provides while it is on. It answers
     * false for anything it will not take, and then the request is relayed
     * exactly as if it had never been asked; with no provider, it never is.
     */
    if (req.method === 'GET' && url.pathname.startsWith('/api/device/snapshots/')) {
      const snapshots = host.use('snapshots');
      if (snapshots) {
        snapshots.serve(req, res, url)
          .catch((err) => { log(`snapshots: ${err.message}`); return false; })
          .then((served) => { if (!served && !res.headersSent) proxyHttp(req, res, url); });
        return;
      }
    }

    proxyHttp(req, res, url);
  };
  const server = http.createServer(onRequest);

  /*
   * The socket.
   *
   * Relayed byte-for-byte, which means this process never has to understand
   * WebSocket framing, continuation frames, or the ping/pong pair. It also
   * means exactly one connection reaches the device per browser tab, so the
   * client count in the Web RCS header stays honest.
   */
  const onUpgrade = (req, socket, head) => {
    /*
     * An upgrade under our own namespace is a plugin's, never the switcher's.
     *
     * The host offers it to the plugin whose base it is under — Companion's
     * embedded UI dials `/__lpp/companion/ui/trpc` — and tracks what that
     * plugin relays, so switching the plugin off or stopping the app hangs it
     * up. Anything under the namespace that no running plugin takes is refused
     * here: relaying it on to the switcher would hand the device a path it has
     * never heard of, from a plugin that may just have been switched off.
     */
    let upgradePath = null;
    try { upgradePath = new URL(req.url, 'http://localhost').pathname; }
    catch { socket.destroy(); return; }

    if (upgradePath === NS || upgradePath.startsWith(NS + '/')) {
      if (host.upgrade(req, socket, head, upgradePath.slice(NS.length) || '/')) return;
      /* Answering rather than destroying: a browser left hanging on an
         unanswered upgrade retries forever and reports nothing useful. */
      if (socket.writable) socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

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
  };
  server.on('upgrade', onUpgrade);

  server.lppState = state;

  /**
   * Serve the same thing on a second listener.
   *
   * The launcher can bind this server to a LAN interface so other machines
   * can reach it; index.js then opens a loopback listener beside it, because
   * loopback is the one plain-http origin a browser treats as a secure
   * context. Both listeners share every handler and every piece of state —
   * the relays, the client count, the OSC listener — so the switcher still
   * sees one connection per tab whichever door the tab came in by.
   */
  server.mirrorTo = (other) => {
    other.on('request', onRequest);
    other.on('upgrade', onUpgrade);
    return other;
  };
  built(server.mirrorTo);

  /**
   * Stop, for real.
   *
   * `closeAllConnections()` covers ordinary requests; the relayed sockets are
   * ours to hang up. Without this a launcher Stop, or a test's teardown, waits
   * on a Web RCS tab that has no reason to ever disconnect.
   */
  function hangUpVendorRelays() {
    for (const { socket, upstream } of [...relays]) {
      upstream.destroy();
      socket.destroy();
    }
    relays.clear();
    state.clients = 0;
  }

  server.closeRelays = () => {
    hangUpVendorRelays();
    for (const door of doors) { door.closeAllConnections?.(); door.close(); }
    doors.clear();

    /* And every plugin: the host stops each one, which ends its streams,
       hangs up the sockets it relayed and runs its own disposers — the
       Companion link's socket and redial timer, and the Pixelhue console's,
       among them. Returned, so a shutdown can wait for disposers that have
       something outside this process to undo — Remote access's
       `tailscale serve` — rather than leave it pointing at a closed port. */
    return host.stop();
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

