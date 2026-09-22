/*
 * The plugin host — the server half.
 *
 * A plugin is a folder. The ones that ship with the app are under `plugins/`,
 * and each has a page half, a server half, or both, named in its manifest (the
 * built-ins' manifests are the table in `src/core/plugins.js`). This file loads
 * the server halves, hands each one a `ctx` to register what it serves, and
 * owns everything about their lifetime:
 *
 * - **Routes** under `/__lpp/<id>/…`, exact or as a mount, dispatched here so
 *   `proxy.js` does not grow another `if` for every feature.
 * - **Streams**: server-sent events fanned out to every page watching. The
 *   proxy wrote that pattern out by hand five times before this existed.
 * - **Relayed sockets**: an upgrade a plugin accepts is tracked, so switching
 *   the plugin off, or stopping the app, hangs it up. An upgraded socket is
 *   invisible to `server.close()`, and a Stop button that waits on one forever
 *   is the bug `proxy.js` already paid for once.
 * - **Disposal**: everything a plugin registered is undone, in reverse order,
 *   when it is switched off or the app stops. A plugin has only to say what
 *   else it holds, with `ctx.onDispose`.
 * - **Isolation**: a plugin that throws while it starts is marked failed, says
 *   why on the settings page and in the log, and the app carries on without
 *   it. No plugin may be able to take the switcher's own interface down with
 *   it — the same promise `proxy.js` makes about the panels.
 *
 * ## Switching is live, on this side
 *
 * `sync()` runs on every settings save. A plugin switched off is disposed at
 * once — its routes answer 404, its sockets close, its services stop — and one
 * switched on is started again from scratch, with no restart. The page half
 * applies on the next load; `src/ui/plugin-host.js` says why.
 *
 * ## What a server half is
 *
 *     export default async function activate(ctx) { … }
 *     export const settings = { normalise, changed?, legacy? };   // optional
 *
 * **Importing the module must do nothing by itself.** The host imports every
 * built-in at startup, switched on or not, because a plugin's settings schema
 * has to be known while it is off: switching a plugin off must not lose what
 * it was set to. Everything with an effect belongs in `activate`.
 *
 * ## User plugins
 *
 * Folders in `<data dir>/plugins/`, each with a `plugin.json`
 * (`validateManifest` in `src/core/plugins.js` says what it must hold). They
 * are found at startup and listed, but **nothing of theirs is imported until
 * somebody switches them on** — a user plugin's code does not run on this
 * machine because it was copied into a folder. They start off, whatever their
 * manifest says, and their settings are carried untouched while they are off.
 *
 * `ctx` is described where it is built, in `makeContext`, and for plugin
 * authors in docs/PLUGINS.md.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, extname, relative, isAbsolute, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

import { API_VERSION, BUILTINS, createRegistry, routeBase, validateManifest } from '../src/core/plugins.js';
import { changedPluginSettings } from '../src/core/settings.js';

/** What a plugin's folder may serve to the page, by extension. Nothing else is. */
const SERVED = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

/**
 * An error a route handler throws to answer with that status.
 *
 * Anything else a handler throws is a 500, and is logged as the plugin's own
 * fault; a 400 for a malformed body is the caller's, and is not.
 */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** One server-sent event, in the framing every panel's EventSource expects. */
const sseFrame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

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
      if (size > limit) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Does `path` fall at or below `prefix`, a whole segment at a time? */
const under = (path, prefix) => path === prefix || path.startsWith(prefix + '/');

/**
 * Everything one running plugin has registered.
 *
 * A fresh one per start, and thrown away on stop — so a plugin switched off and
 * on again starts from nothing, and nothing it registered the first time can
 * still be answering the second.
 */
class Scope {
  constructor() {
    this.routes = new Map();       /* "GET /state" -> handler */
    this.mounts = [];              /* {prefix, handler}, longest first */
    this.upgrades = [];            /* {prefix, handler} */
    this.streams = [];
    this.pairs = new Set();        /* relayed sockets, {socket, upstream} */
    this.disposers = [];
    this.settingsListeners = [];
    this.closed = false;
  }

  async dispose(log) {
    this.closed = true;
    for (const stream of this.streams) stream.end();
    for (const pair of this.pairs) {
      try { pair.upstream?.destroy(); } catch { /* already gone */ }
      try { pair.socket?.destroy(); } catch { /* already gone */ }
    }
    this.pairs.clear();
    /* Reverse order, like a stack of `finally`s: what was set up last may
       depend on what was set up first. */
    for (const fn of this.disposers.reverse()) {
      try { await fn(); } catch (err) { log(`while stopping: ${err.message}`); }
    }
    this.disposers = [];
    this.routes.clear();
    this.mounts = [];
    this.upgrades = [];
    this.streams = [];
    this.settingsListeners = [];
  }
}

/**
 * Load the plugins and return the host.
 *
 * @param {object} o
 * @param {string} o.root           the repo root; built-ins live in `<root>/plugins/<id>/`
 * @param {string} [o.ns]           the app's route namespace, `/__lpp`
 * @param {object[]} [o.manifests]  defaults to the built-ins; tests pass their own
 * @param {(m: object) => string} [o.dirOf]  where a manifest's folder is
 * @param {() => string|null} [o.device]     the switcher this app points at now
 * @param {(messages: object[]) => Promise<object[]>} [o.awj]  a one-shot AWJ exchange
 * @param {(addr: string, port: number) => {host, port}|null} [o.splitAddress]
 *        the app's one opinion about what a host:port looks like — `splitDevice`
 * @param {string|null} [o.userDir]  where user plugins are, `<data dir>/plugins`; null for none
 * @param {(msg: string) => void} [o.log]
 */
export async function createPluginHost({
  root,
  ns = '/__lpp',
  manifests = BUILTINS,
  dirOf = (m) => join(root, 'plugins', m.id),
  userDir = null,
  device = () => null,
  awj = null,
  splitAddress = () => null,
  log = () => {}
} = {}) {
  /** id -> record. Only plugins with a half of their own; in-place built-ins are the proxy's. */
  const plugins = new Map();
  /** id -> settings schema, for `core/settings.js`'s `normalise`. */
  const schemas = {};
  /** User plugin folders whose `plugin.json` was refused: listed, never loaded. */
  const refused = [];
  let settings = { plugins: {} };

  const newRecord = (manifest, dir, user) => ({
    id: manifest.id,
    manifest,
    dir,
    user,
    base: routeBase(manifest),
    module: null,
    scope: null,
    on: false,
    /* A load error is for good — the module will not import, or asks for an
       API this build does not speak. A start error clears when the plugin is
       switched off, so switching it back on is how an operator retries. */
    loadError: null,
    startError: null
  });

  for (const manifest of manifests) {
    if (!manifest.hosted) continue;
    const record = newRecord(manifest, dirOf(manifest), false);
    plugins.set(manifest.id, record);
    if (refuseNewerApi(record)) continue;
    /* A built-in's server half is imported now, on or off, for its schema. */
    if (manifest.server) await importServer(record);
  }

  const found = userDir ? await discover(userDir, log) : [];
  for (const { folder, dir, manifest, error } of found) {
    if (error) {
      refused.push({ id: folder, dir, reason: `plugin.json: ${error}` });
      log(`user plugin ${folder}: plugin.json: ${error}`);
      continue;
    }
    const record = newRecord(manifest, dir, true);
    plugins.set(manifest.id, record);
    refuseNewerApi(record);
    /* Not imported: a user plugin's code runs when somebody switches it on. */
  }

  const registry = createRegistry([...manifests, ...found.filter((f) => f.manifest).map((f) => f.manifest)]);

  function refuseNewerApi(record) {
    if (record.manifest.apiVersion <= API_VERSION) return false;
    record.loadError = `needs plugin API ${record.manifest.apiVersion}; this build speaks ${API_VERSION}`;
    log(`plugin ${record.id}: ${record.loadError}`);
    return true;
  }

  /** Import a plugin's server half and read its settings schema. False when it would not load. */
  async function importServer(record) {
    try {
      record.module = await import(pathToFileURL(join(record.dir, record.manifest.server)).href);
      if (typeof record.module.default !== 'function') {
        record.loadError = 'its server half exports no activate function';
      }
      const schema = record.module.settings;
      if (schema && typeof schema.normalise === 'function') {
        /* `legacy` is for built-ins' own history; a user plugin has none, and
           honouring one would let it lift the app's own fields into itself. */
        schemas[record.id] = record.user ? { ...schema, legacy: [] } : schema;
      }
    } catch (err) {
      record.loadError = `its server half would not load: ${err.message}`;
    }
    if (record.loadError) {
      record.module = null;
      log(`plugin ${record.id}: ${record.loadError}`);
      return false;
    }
    return true;
  }

  const pluginLog = (r) => (msg) => log(`${r.id}: ${msg}`);
  /* A user plugin's settings are stored raw until its schema is known — it is
     only imported once switched on — so they are normalised here on the way
     out as well. For a built-in that is a second, idempotent pass. */
  const settingsOf = (id) => {
    const raw = (settings.plugins && settings.plugins[id] && settings.plugins[id].settings) || {};
    return schemas[id] ? schemas[id].normalise({ ...raw }) : { ...raw };
  };

  /**
   * Hosted plugins in the order they can be started: everything a plugin
   * requires comes before it. Stopping walks the same list backwards.
   */
  function startOrder() {
    const out = [];
    const seen = new Set();
    const visit = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const r = plugins.get(id);
      if (!r) return;
      for (const dep of r.manifest.requires.plugins) visit(dep);
      out.push(r);
    };
    for (const id of plugins.keys()) visit(id);
    return out;
  }

  /**
   * The address a request arrived on, which is the one address this process
   * is known to be reachable at.
   *
   * This process does not know how it is reachable. It may be bound to
   * loopback, to one LAN address or to everything; it may sit behind the
   * launcher, a tunnel or a container's port mapping. The one address known to
   * work is **the one the request in hand arrived on**, because a browser just
   * used it — so that is what a plugin that has to tell somebody else how to
   * find this app is offered.
   *
   * ⚠️ It can still be the wrong answer: a page opened on this machine arrives
   * as `127.0.0.1`, and telling a machine across the room to dial that points it
   * at itself. `loopback` says so, and it is left to the plugin to phrase — there
   * is no address this process could substitute that would not be a guess.
   */
  function selfAddress(req) {
    const self = splitAddress(String((req && req.headers && req.headers.host) || ''), 80);
    if (!self) return null;
    return { host: self.host, port: self.port, loopback: self.host === '127.0.0.1' || self.host === 'localhost' };
  }

  /**
   * The `ctx` a server half is started with.
   *
   * Everything here is either a question about the app (`device`, `settings`,
   * `selfAddress`) or a way to put something on it (`route`, `mount`,
   * `upgrade`, `stream`) that the host will take down again. There is
   * deliberately no handle on the HTTP server itself: a plugin that could add
   * its own listener could also leave it behind.
   */
  function makeContext(r, scope) {
    const plog = pluginLog(r);
    const guard = (what) => {
      if (scope.closed) throw new Error(`${r.id} tried to add ${what} after it was switched off`);
    };
    const path = (p, what) => {
      if (typeof p !== 'string' || !p.startsWith('/')) throw new Error(`${r.id}: ${what} paths start with "/", not ${JSON.stringify(p)}`);
      return p.length > 1 ? p.replace(/\/+$/, '') : p;
    };

    return Object.freeze({
      id: r.id,
      manifest: r.manifest,
      apiVersion: API_VERSION,
      log: plog,
      /** Throw one from a route handler to answer with its status: `throw new ctx.HttpError(409, 'why')`. */
      HttpError,

      /** The switcher this app is pointed at now, `host:port`, or null. Read it per use: it changes. */
      device: () => device(),

      /** Where one of this plugin's routes is, as a page would ask for it: `ctx.url('/state')`. */
      url: (p = '/') => `${ns}${r.base}${p === '/' ? '' : path(p, 'url')}`,

      selfAddress,

      settings: Object.freeze({
        /** This plugin's settings, normalised by its own schema. A copy: change them by saving. */
        get: () => settingsOf(r.id),
        /** Called with (next, prev) after a save that changed them — as the schema's `changed` judges. */
        onChange: (fn) => { guard('a settings listener'); scope.settingsListeners.push(fn); }
      }),

      /**
       * An exact route, `ctx.route('GET', '/state', handler)`, at
       * `/__lpp/<id>/state`. The handler gets `(req, res, h)`, where `h` has
       * `url`, `json(status, body)`, `readJson(limit)` and `readBody(limit)`.
       * Throw an `HttpError` to answer with its status.
       */
      route(method, p, handler) {
        guard(`route ${p}`);
        scope.routes.set(`${String(method).toUpperCase()} ${path(p, 'route')}`, handler);
      },

      /**
       * Everything at or below a prefix, any method: `ctx.mount('/ui', handler)`.
       * The handler gets `(req, res, { url, rest })`, `rest` being the request
       * target below the prefix, query string included.
       */
      mount(prefix, handler) {
        guard(`mount ${prefix}`);
        scope.mounts.push({ prefix: path(prefix, 'mount'), handler });
        scope.mounts.sort((a, b) => b.prefix.length - a.prefix.length);
      },

      /**
       * WebSocket upgrades at or below a prefix. The handler gets
       * `(req, socket, head, { rest })` and returns the `{ socket, upstream }`
       * pair it relayed, or null; the pair is hung up when the plugin stops.
       */
      upgrade(prefix, handler) {
        guard(`upgrade ${prefix}`);
        scope.upgrades.push({ prefix: path(prefix, 'upgrade'), handler });
      },

      /**
       * A live stream of server-sent events at `GET /__lpp/<id><path>`.
       * `send(event, data)` goes to every page listening; `size` says whether
       * anybody is, so a plugin can skip work nobody would see. `onOpen(first)`
       * may greet a page that has just connected with `first.send(event, data)`.
       */
      stream(p, { onOpen } = {}) {
        guard(`stream ${p}`);
        const listeners = new Set();
        const stream = {
          send(event, data) {
            if (!listeners.size) return;
            const line = sseFrame(event, data);
            for (const res of listeners) {
              /* A page that went away without closing cleanly must not stop the
                 others hearing. */
              try { res.write(line); } catch { listeners.delete(res); }
            }
          },
          get size() { return listeners.size; },
          end() {
            for (const res of listeners) { try { res.end(); } catch { /* gone */ } }
            listeners.clear();
          }
        };
        scope.streams.push(stream);
        scope.routes.set(`GET ${path(p, 'stream')}`, (req, res) => {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            /* Nginx and friends buffer event streams into uselessness. */
            'x-accel-buffering': 'no'
          });
          res.write(`: ${r.id} stream open\n\n`);
          listeners.add(res);
          req.on('close', () => listeners.delete(res));
          if (onOpen) {
            try { onOpen({ send: (event, data) => res.write(sseFrame(event, data)) }); }
            catch (err) { plog(`stream ${p}: ${err.message}`); }
          }
        });
        return stream;
      },

      /** Run `fn` when this plugin is switched off or the app stops. Last registered, first run. */
      onDispose(fn) { guard('a disposer'); scope.disposers.push(fn); },

      /**
       * One AWJ exchange with the switcher: `[{op, path, value?}]` in, the
       * replies to its gets out. Opened, used and closed — see `server/awj.js`
       * for why nothing here ever holds that socket.
       */
      awj: (messages) => (awj ? awj(messages) : Promise.reject(new Error('no switcher configured')))
    });
  }

  async function startPlugin(r) {
    /* A user plugin's server half is first imported here, the moment it is
       switched on — never before. */
    if (r.user && r.manifest.server && !r.module && !(await importServer(r))) return;
    /* A plugin with no server half has nothing to start here; being on is all
       it needs for the page to load its other half. */
    if (!r.module) { r.on = true; return; }
    const scope = new Scope();
    try {
      await r.module.default(makeContext(r, scope));
      r.scope = scope;
      r.on = true;
      r.startError = null;
      log(`plugin ${r.id}: on`);
    } catch (err) {
      await scope.dispose(pluginLog(r));
      r.startError = `failed to start: ${err.message}`;
      log(`plugin ${r.id}: ${r.startError}`);
    }
  }

  async function stopPlugin(r) {
    const scope = r.scope;
    r.scope = null;
    r.on = false;
    if (scope) {
      await scope.dispose(pluginLog(r));
      log(`plugin ${r.id}: off`);
    }
  }

  /** Settings as the plugins' schemas read them — what "changed" is judged on. */
  const effective = (s) => ({
    plugins: Object.fromEntries(Object.keys(schemas).map((id) => [id, {
      settings: schemas[id].normalise({ ...((s && s.plugins && s.plugins[id] && s.plugins[id].settings) || {}) })
    }]))
  });

  /** Tell a running plugin its settings changed. A listener that throws is logged, not fatal. */
  function notify(r, prev, next) {
    const read = (s) => ({ ...((s.plugins && s.plugins[r.id] && s.plugins[r.id].settings) || {}) });
    for (const fn of r.scope.settingsListeners) {
      try {
        const out = fn(read(next), read(prev));
        if (out && typeof out.catch === 'function') out.catch((err) => pluginLog(r)(`settings: ${err.message}`));
      } catch (err) {
        pluginLog(r)(`settings: ${err.message}`);
      }
    }
  }

  /**
   * Bring every plugin into line with a settings object — the one just loaded,
   * or the one just saved. Stops first, dependants before what they depend on,
   * then starts in the other order, then tells the plugins that stayed on about
   * any change to their own settings.
   */
  async function sync(next) {
    const prev = settings;
    settings = next;
    const order = startOrder();
    const wanted = (r) => !r.loadError && registry.isEnabled(next.plugins, r.id);
    /* A user plugin that would not import stays failed until the app restarts:
       the file it would import is the same file until somebody edits it. */

    for (const r of [...order].reverse()) {
      if (wanted(r)) continue;
      if (r.on) await stopPlugin(r);
      /* Switched off clears a failure to start: switching it on again retries. */
      r.startError = null;
    }

    /* Compared as each plugin's schema reads them, so defaults filled in for a
       plugin whose schema has only just arrived are not taken for a change. */
    const changed = new Set(changedPluginSettings(effective(prev), effective(next), schemas));
    for (const r of order) {
      if (!wanted(r)) continue;
      if (!r.on && !r.startError) await startPlugin(r);
      else if (r.on && r.scope && changed.has(r.id)) notify(r, prev, next);
    }
  }

  /** The hosted plugin a path below the namespace belongs to, if any. */
  const recordFor = (rest) => {
    for (const r of plugins.values()) if (under(rest, r.base)) return r;
    return null;
  };

  /**
   * Answer a request under a hosted plugin's base. Returns false for a path
   * that is no hosted plugin's, so the proxy can go on to its own routes.
   */
  async function handle(req, res, url, rest) {
    const r = recordFor(rest);
    if (!r) return false;

    if (!r.scope) {
      const why = r.loadError || r.startError;
      if (why) sendJson(res, 503, { error: `the ${r.id} plugin ${why}`, plugin: r.id });
      else if (!r.on) sendJson(res, 404, { error: `the ${r.id} plugin is switched off`, plugin: r.id });
      else sendJson(res, 404, { error: `the ${r.id} plugin has no server routes`, plugin: r.id });
      return true;
    }

    const scope = r.scope;
    const plog = pluginLog(r);
    const sub = rest.slice(r.base.length) || '/';

    const fail = (err, where) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) plog(`${req.method} ${where}: ${err.message}`);
      if (!res.headersSent) sendJson(res, status, { error: err.message, plugin: r.id });
      else res.destroy();
    };

    const exact = scope.routes.get(`${req.method} ${sub}`);
    if (exact) {
      const h = {
        url,
        json: (status, body) => sendJson(res, status, body),
        readBody: (limit = 64 * 1024) => collect(req, limit),
        async readJson(limit = 64 * 1024) {
          const raw = await collect(req, limit);
          if (!raw.length) return {};
          try { return JSON.parse(raw.toString('utf8')); }
          catch { throw new HttpError(400, 'invalid JSON'); }
        }
      };
      try { await exact(req, res, h); } catch (err) { fail(err, sub); }
      return true;
    }

    const mount = scope.mounts.find((m) => under(sub, m.prefix));
    if (mount) {
      const below = sub.slice(mount.prefix.length) || '/';
      try { await mount.handler(req, res, { url, rest: below + (url.search || '') }); }
      catch (err) { fail(err, sub); }
      return true;
    }

    /* A path this plugin has under another method is a 405, not a 404: the
       difference tells whoever is calling that the address was right. */
    const other = [...scope.routes.keys()].some((k) => k.slice(k.indexOf(' ') + 1) === sub);
    sendJson(res, other ? 405 : 404, { error: other ? 'method not allowed' : 'not found', plugin: r.id });
    return true;
  }

  /**
   * Offer an upgrade to the plugin whose base it is under. Returns false when
   * no running plugin takes it — the proxy then refuses it, rather than relay
   * a path under its own namespace to the switcher.
   */
  function upgrade(req, socket, head, pathname) {
    const r = recordFor(pathname);
    if (!r || !r.scope) return false;
    const scope = r.scope;
    const sub = pathname.slice(r.base.length) || '/';
    const entry = scope.upgrades.find((u) => under(sub, u.prefix));
    if (!entry) return false;

    /* The request target below the prefix, query string and all, taken off the
       raw URL rather than the parsed path so nothing is re-encoded on the way. */
    const mounted = ns + r.base + entry.prefix;
    const rest = String(req.url).slice(mounted.length) || '/';
    let pair = null;
    try {
      pair = entry.handler(req, socket, head, { rest });
    } catch (err) {
      pluginLog(r)(`upgrade ${sub}: ${err.message}`);
      socket.destroy();
      return true;
    }
    if (pair && (pair.socket || pair.upstream)) {
      scope.pairs.add(pair);
      const drop = () => scope.pairs.delete(pair);
      pair.socket?.on?.('close', drop);
      pair.upstream?.on?.('close', drop);
    }
    return true;
  }

  /**
   * Serve a file out of a running plugin's folder: `/plugins/<id>/<path>`.
   *
   * Every file there with an extension in `SERVED` goes to the page **except
   * the server entry**, which is the one file whose source a page has no use
   * for. Resolved and then checked to still be inside the folder, so an encoded
   * `..` cannot walk out of it. Returns false for a path that is not of this
   * shape; anything of the shape is answered, a 404 included.
   */
  async function serveFile(rest, res) {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(rest);
    if (!m) return false;
    const notFound = () => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return true; };

    const r = plugins.get(m[1]);
    if (!r || !r.on || r.loadError) return notFound();
    let file;
    try { file = decodeURIComponent(m[2]); } catch { return notFound(); }
    const full = normalize(join(r.dir, file));
    const rel = relative(r.dir, full);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return notFound();
    if (r.manifest.server && rel === normalize(r.manifest.server)) return notFound();
    const type = SERVED[extname(full)];
    if (!type) return notFound();
    try {
      const body = await readFile(full);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      notFound();
    }
    return true;
  }

  /**
   * Every plugin the app knows, hosted or still in place, and whether it is on.
   * What `GET /__lpp/plugins` answers, and what the page host loads from.
   */
  function list() {
    const userManifests = [...plugins.values()].filter((r) => r.user).map((r) => r.manifest);
    return [
      ...[...manifests, ...userManifests].map((m) => {
        const r = plugins.get(m.id);
        const st = registry.status(settings.plugins, m.id);
        const on = m.hosted ? Boolean(r && r.on) : st.on;
        return {
          id: m.id,
          name: m.name,
          version: m.version || null,
          description: m.description,
          where: m.where,
          builtIn: m.builtIn,
          hosted: m.hosted,
          /* Where a user plugin came from, so the settings page can say. */
          source: r && r.user ? 'user' : 'built-in',
          dir: r && r.user ? r.dir : null,
          apiVersion: m.apiVersion,
          requires: m.requires,
          base: m.hosted ? ns + routeBase(m) : null,
          on,
          reason: (r && (r.loadError || r.startError)) || (on ? null : st.reason),
          client: m.hosted && m.client && on ? `${ns}/plugins/${m.id}/${m.client}` : null
        };
      }),
      /* Folders that are not plugins yet, and why — the settings page is where
         somebody who has just copied one in will look. */
      ...refused.map((f) => ({
        id: f.id, name: f.id, version: null, description: '', where: '', builtIn: false, hosted: true,
        source: 'user', dir: f.dir, apiVersion: null, requires: { capabilities: [], plugins: [] },
        base: null, on: false, reason: f.reason, client: null, invalid: true
      }))
    ];
  }

  /** Stop every running plugin — the app is stopping. */
  async function stop() {
    for (const r of startOrder().reverse()) if (r.on) await stopPlugin(r);
  }

  return {
    schemas,
    sync,
    handle,
    upgrade,
    serveFile,
    list,
    stop,
    /** For tests and the status route: which hosted plugins are running. */
    running: () => [...plugins.values()].filter((r) => r.on).map((r) => r.id)
  };
}

/**
 * The folders in the user plugin directory, each with its manifest or the
 * reason it has none. A directory that does not exist is no plugins, not an
 * error: most installations will never make one.
 */
async function discover(userDir, log) {
  let entries;
  try {
    entries = await readdir(userDir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') log(`user plugins: could not read ${userDir}: ${err.message}`);
    return [];
  }
  const out = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(userDir, entry.name);
    let raw;
    try {
      raw = JSON.parse(await readFile(join(dir, 'plugin.json'), 'utf8'));
    } catch (err) {
      out.push({ folder: entry.name, dir, error: err.code === 'ENOENT' ? 'there is none' : `it would not parse: ${err.message}` });
      continue;
    }
    const checked = validateManifest(raw, entry.name);
    out.push({ folder: entry.name, dir, ...checked });
  }
  return out;
}
