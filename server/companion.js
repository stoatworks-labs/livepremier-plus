/*
 * The link to a Bitfocus Companion, and the mount that puts its web UI
 * inside ours.
 *
 * ## Why this one holds a connection open, when `awj.js` refuses to
 *
 * `server/awj.js` argues at length that it must never hold a socket or
 * subscribe to anything. That argument is about the **store mirror** — about
 * not becoming a second source of truth for state the vendor socket already
 * carries. It does not reach here, for the same three reasons
 * `server/matrix/index.js` gives about an external router:
 *
 * - **There is no other source.** Nothing in the store, and nothing in a Web
 *   RCS page, has ever heard of a Companion show. There is no mirror to
 *   contradict.
 * - **It changes without us.** Somebody presses a Stream Deck key, edits a
 *   button, adds a connection at the Companion UI. A poll-on-demand design
 *   would show a panel that was right when it was opened.
 * - **The client budget is the switcher's, not Companion's.** The five-client
 *   limit `awj.js` respects is an AWJ limit on the Analog Way frame.
 *   Companion counts no clients and its own web UI opens one of these per
 *   tab.
 *
 * ## Two sockets, on purpose
 *
 * The panel opens its **own** tRPC socket through the mount, and that is not
 * a duplicate of this one. They carry different traffic for different
 * reasons:
 *
 * - **This one is for managing the show** — adding a connection, writing its
 *   config, installing a module. It has to be here because only this process
 *   knows the address Companion should point our own module at, and because
 *   of the local-client rule below.
 * - **The panel's is for drawing buttons** — one subscription per button
 *   location, a PNG each time one repaints. Funnelling that through this
 *   process would mean relaying a stream of images to the page that the page
 *   could have been handed directly, and it would go on running when nothing
 *   was on screen to want it.
 *
 * ## The local-client rule, which is not about the operator
 *
 * `instances.modulesManager.installModuleTar` is refused for any client that
 * is not on the same machine as Companion — Companion decides that from the
 * socket's own address. Because *this* socket comes from this process, the
 * question is whether **LivePremier Plus** is on Companion's machine, not
 * whether the operator's browser is. A launcher on the show PC beside
 * Companion can install our module; the same launcher reached from a laptop
 * across the room still can, and a launcher on a different machine cannot.
 * That is worth saying in the panel, because the failure is otherwise
 * mystifying.
 *
 * ## The mount
 *
 * Companion has supported being served under a sub-path since 4.1, and does
 * it by rewriting a `/ROOT_URL_HERE` token through every HTML, CSS and JS
 * response according to a `companion-custom-prefix` request header. That is
 * what makes embedding it honest rather than a hack: the emulator, the web
 * buttons and the whole admin UI come back with their own URLs already
 * pointing at us, on our origin, so there is no mixed content, no CORS and
 * no second port for an operator to allow through a firewall.
 *
 * Verified on Companion 5.0.5 rather than taken from the documentation:
 * `<script src="/assets/polyfills-….js">` comes back as
 * `/__lpp/companion/ui/assets/polyfills-….js`, and the bundle's socket helper
 * comes back as ``Wu([`/__lpp/companion/ui`, e])`` so the UI dials
 * `/__lpp/companion/ui/trpc`.
 *
 * **The trap:** Companion's own Express routes match the *unprefixed* path,
 * and its WebSocket server matches the pathname `/trpc` exactly
 * (`isTrpcUpgradeRequest` in its `UI/Handler.ts`). So the prefix must be
 * stripped from the request line before forwarding and announced only in the
 * header. Forwarding the mounted path verbatim gets a socket that opens and
 * then says nothing, with no error at either end.
 */

import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';

import { WsClient } from './ws-client.js';
import {
  addInput, moduleKey, originAllowed, parseFrames, pickVersion, request, stopRequest,
} from '../src/core/companion.js';

/**
 * The path under the app's namespace that Companion is mounted at.
 *
 * A level deeper than it looks like it needs to be, so that `/__lpp/companion`
 * itself stays ours. Everything below the mount belongs to Companion and is
 * forwarded unread — which means the moment this app wants a route of its own
 * about Companion, it has nowhere to put it unless the mount is a sub-path.
 * `/state` and `/connections` live beside `/ui`, not underneath it.
 */
export const API = '/companion';
export const MOUNT = API + '/ui';

/**
 * The prefix as Companion wants to be told it, with **no leading slash**.
 *
 * Its `getCustomPrefixHeader` builds `/${header}` itself, and refuses any
 * value containing `://` or `..`. Sending a leading slash produces `//…` in
 * every rewritten URL, which mostly works and occasionally does not. More
 * than one segment deep is fine — it is substituted as a string, not walked.
 */
export const PREFIX_HEADER = `__lpp${MOUNT}`;

/* How long to wait before redialling, and the ceiling.
 *
 * Doubling from a second: a Companion that is restarting is back in a few
 * seconds and should be picked up quickly, and one that is switched off for
 * the night should not be dialled every second until morning. */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;

/** A call that has gone unanswered this long is not going to be answered. */
const CALL_TIMEOUT_MS = 10000;

/**
 * One supervised tRPC connection to a Companion, plus the calls this app
 * makes over it.
 *
 * `apply()` is idempotent and diff-based, like the matrix supervisor and for
 * the same reason: settings are saved as a whole, so a change to the OSC port
 * must not drop a Companion link that did not change.
 */
export class CompanionLink extends EventEmitter {
  /** @param {(msg: string) => void} log */
  constructor(log = () => {}) {
    super();
    this.log = log;
    this.config = { companionEnabled: false, companionHost: '', companionPort: 0 };
    this.ws = null;
    this.retry = null;
    this.retryMs = RETRY_MIN_MS;
    this.nextId = 0;
    /** Cancels the show subscription; null while there is no socket. */
    this.unwatch = null;
    /** id -> {resolve, reject, timer, subscription, onValue} */
    this.pending = new Map();

    /* What the panel is shown. `error` is the last failure rather than a
       live flag: a link that is retrying has both a reason and a hope. */
    this.state = { configured: false, connected: false, error: null, version: null };
  }

  /** The address to dial, or null when this link is not configured. */
  get target() {
    const { companionEnabled, companionHost, companionPort } = this.config;
    if (!companionEnabled || !companionHost || !companionPort) return null;
    return { host: companionHost, port: companionPort };
  }

  /**
   * Take a new settings object. Returns true when the socket was rebuilt.
   *
   * The caller decides *whether* anything changed — `companionChanged` in
   * `src/core/companion.js` is the one place that knows which fields mean a
   * new socket, so that the panel and this agree.
   */
  apply(next) {
    this.config = {
      companionEnabled: next.companionEnabled === true,
      companionHost: next.companionHost || '',
      companionPort: next.companionPort || 0,
    };
    this.state.configured = !!this.target;
    this.stop();
    if (this.target) {
      this.retryMs = RETRY_MIN_MS;
      this.#dial();
      return true;
    }
    this.state.error = null;
    return false;
  }

  #dial() {
    const target = this.target;
    if (!target || this.ws) return;

    const ws = new WsClient({ host: target.host, port: target.port, path: '/trpc' });
    this.ws = ws;

    ws.on('open', () => {
      this.state.connected = true;
      this.state.error = null;
      this.retryMs = RETRY_MIN_MS;
      this.log(`companion link open to ${target.host}:${target.port}`);
      /* Asking the version is also the proof that tRPC itself works, not just
         that a socket opened — a reverse proxy in front of Companion can give
         a clean handshake and then answer nothing. */
      this.call('query', 'appInfo.version')
        .then((info) => { this.state.version = info?.appVersion ?? null; })
        .catch(() => { /* reported by the call itself */ });

      /*
       * Watch the show, and use it only as a doorbell.
       *
       * The frames this yields are an init followed by deltas in a shape that
       * is Companion's to change — and this app has already decided that the
       * *truth* about the connection list comes from the documented HTTP API
       * (see `listConnections`). Parsing the deltas as well would be a second
       * reader of the same facts, in the less stable of the two dialects, for
       * no gain.
       *
       * So every frame means only "something moved", and whoever cares
       * re-reads. That matters because the show genuinely changes without us:
       * the operator has Companion's own Connections page embedded in the
       * panel, two clicks away from adding one.
       */
      this.unwatch = this.subscribe('instances.connections.watch', undefined, () => {
        this.emit('showChanged');
      });
    });

    ws.on('message', (text) => this.#onMessage(text));

    ws.on('error', (err) => {
      this.state.error = err.message;
      this.log(`companion link: ${err.message}`);
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;             /* superseded by a newer dial */
      this.ws = null;
      /* The subscription died with the socket; forget it so the next dial
         does not stack a second one on top. */
      this.unwatch = null;
      this.state.connected = false;
      this.state.version = null;
      /* Everything in flight is now never going to answer. Failing them is
         the difference between a panel that says so and one that spins. */
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject?.(new Error('the Companion link closed'));
        this.pending.delete(id);
      }
      this.#scheduleRetry();
    });
  }

  #scheduleRetry() {
    if (!this.target || this.retry) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.#dial();
    }, wait);
    /* A pending redial must not be the reason the launcher's Stop button
       waits — the same rule the OSC socket and the matrix timers follow. */
    this.retry.unref?.();
  }

  #onMessage(text) {
    for (const frame of parseFrames(text)) {
      const entry = this.pending.get(frame.id);
      if (!entry) continue;

      if (frame.kind === 'error') {
        clearTimeout(entry.timer);
        this.pending.delete(frame.id);
        entry.reject?.(new Error(frame.error));
        continue;
      }
      if (frame.kind === 'started') { entry.started = true; continue; }
      if (frame.kind === 'stopped') {
        clearTimeout(entry.timer);
        this.pending.delete(frame.id);
        entry.resolve?.(undefined);
        continue;
      }
      if (frame.kind !== 'data') continue;

      if (entry.subscription) {
        entry.onValue(frame.data);
      } else {
        clearTimeout(entry.timer);
        this.pending.delete(frame.id);
        entry.resolve?.(frame.data);
      }
    }
  }

  /** One query or mutation. Rejects rather than hanging when there is no link. */
  call(method, path, input) {
    if (!this.ws || !this.ws.open) {
      return Promise.reject(new Error(this.state.configured ? 'not connected to Companion' : 'no Companion configured'));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Companion did not answer ${path}`));
      }, CALL_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, subscription: false });
      this.ws.send(JSON.stringify(request(id, method, path, input)));
    });
  }

  /**
   * Open a subscription. Returns a function that ends it.
   *
   * Ending it sends `subscription.stop` rather than closing the socket —
   * every other subscription on this link is somebody else's.
   */
  subscribe(path, input, onValue) {
    if (!this.ws || !this.ws.open) return () => {};
    const id = ++this.nextId;
    this.pending.set(id, { subscription: true, onValue, timer: null });
    this.ws.send(JSON.stringify(request(id, 'subscription', path, input)));
    return () => {
      if (!this.pending.delete(id)) return;
      if (this.ws && this.ws.open) this.ws.send(JSON.stringify(stopRequest(id)));
    };
  }

  /** Hang up and cancel any pending redial. Safe to call repeatedly. */
  stop() {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const ws = this.ws;
    this.ws = null;
    this.unwatch = null;
    this.state.connected = false;
    this.state.version = null;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject?.(new Error('the Companion link was closed'));
      this.pending.delete(id);
    }
    if (ws) ws.close();
  }
}

/* ------------------------------------------------------------- the two jobs */

/**
 * Read the show's connection list.
 *
 * Over the **documented** HTTP API rather than the tRPC socket, deliberately.
 * `GET /api/connections` is published, CORS-enabled and stable across
 * releases; `instances.connections.watch` returns the same thing over an
 * interface Companion is free to change between point releases. Listing is
 * the one thing here that has a supported answer, so it uses it — and a
 * Companion whose internals have moved can still draw the panel.
 */
export function listConnections(target, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!target) return reject(new Error('no Companion configured'));
    const req = http.request(
      { host: target.host, port: target.port, path: '/api/connections', method: 'GET' },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`Companion answered ${res.statusCode}`));
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(Array.isArray(parsed) ? parsed : []);
          } catch (err) {
            reject(new Error(`Companion's connection list did not parse: ${err.message}`));
          }
        });
      }
    );
    req.on('error', (err) => reject(new Error(`could not reach Companion: ${err.message}`)));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Companion did not answer in time')); });
    req.end();
  });
}

/**
 * The modules Companion has, read once.
 *
 * `instances.modules.watch` is a **subscription**, not a query — there is no
 * one-shot form of it. It yields `{type:'init', info}` immediately and then
 * stays open feeding changes, so this takes the first frame and hangs up.
 *
 * That is not a poll pretending to be a stream: nothing here wants to know
 * when a module is installed, only what is installed at the moment somebody
 * pressed a button. A held subscription would be this process keeping a
 * second copy of a list it needs twice a show.
 */
export function readModules(link, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let stop = null;
    const timer = setTimeout(() => {
      if (stop) stop();
      reject(new Error('Companion did not send its module list in time'));
    }, timeoutMs);
    timer.unref?.();

    stop = link.subscribe('instances.modules.watch', undefined, (value) => {
      /* Later frames are deltas and are not what this asked for. */
      if (!value || value.type !== 'init') return;
      clearTimeout(timer);
      if (stop) stop();
      resolve(value.info && typeof value.info === 'object' ? value.info : {});
    });

    /* `subscribe` returns a no-op when there is no socket, and would otherwise
       leave this promise pending until the timeout for no reason. */
    if (!link.ws || !link.ws.open) {
      clearTimeout(timer);
      reject(new Error('not connected to Companion'));
    }
  });
}

/**
 * Create the connections a plan says are missing, and report what happened.
 *
 * Never throws for one module's sake: a show where the AWJ module is present
 * and ours is not should end up with ours added and a clear note about the
 * other, rather than with an exception and no way to tell which half ran.
 *
 * Config is written only for a connection **we just created**. An adopted one
 * is somebody else's, possibly pointed at a backup frame on purpose, and this
 * is not the place to have an opinion about it — `planConnections` says why.
 */
export async function addConnections(link, plan, facts, want, target) {
  const results = [];
  const wanted = new Set(want && want.length ? want : plan.add.map((a) => a.key));

  /* Which modules Companion actually has, and what it calls their versions.
   *
   * Read before anything is created, because `add` needs a real version
   * string — see `pickVersion`. It also answers the question the schema error
   * cannot: whether the module is installed at all. Our own module is not on
   * anybody's Companion yet, so that is the *expected* answer for it, and it
   * deserves a sentence rather than a validation failure. */
  let modules = {};
  let modulesError = null;
  try {
    modules = await readModules(link);
  } catch (err) {
    modulesError = err.message;
  }

  /* Add first, configure second, with a read of the show in between.
   *
   * Not one pass, because of `makeLabelUnique`: Companion renames a colliding
   * label on the way in, so a show that already has something called "AWJ"
   * gets ours as "AWJ 2" — and `setConfig` *requires* a label, so sending the
   * one we asked for would either rename the wrong thing or be refused as a
   * duplicate. The only way to know what a connection is actually called is
   * to look. */
  for (const { key, spec } of plan.add) {
    if (!wanted.has(key)) continue;

    const entry = modules[moduleKey(spec.moduleId)];
    const versionId = pickVersion(entry);
    if (!versionId) {
      results.push({
        key, spec, ok: false, id: null, configured: false,
        note: modulesError
          ? `could not read Companion's module list: ${modulesError}`
          : `Companion has no “${spec.moduleId}” module installed. Install it in Companion first — `
            + 'Modules > Manage, or by importing its package.',
      });
      continue;
    }

    try {
      const created = await link.call('mutation', 'instances.connections.add', addInput(spec, versionId));
      /* The mutation answers with the new connection's id, as a bare string. */
      const id = typeof created === 'string' ? created : created?.id;
      results.push({
        key, spec, ok: !!id, id: id ?? null, configured: false, version: versionId,
        note: id ? null : 'added, but Companion named no id',
      });
    } catch (err) {
      results.push({ key, spec, ok: false, id: null, configured: false, note: err.message });
    }
  }

  const added = results.filter((r) => r.ok && r.id);
  if (added.length) {
    /* Labels as Companion actually assigned them. A failure to read them back
       is not a failure of the adds, which have already happened. */
    let labels = new Map();
    try {
      const list = await listConnections(target);
      labels = new Map(list.map((c) => [c.id, c.label]));
    } catch (err) {
      for (const r of added) r.note = `added, but the show could not be re-read to configure it: ${err.message}`;
    }

    for (const r of added) {
      const label = labels.get(r.id);
      if (!label) continue;
      try {
        /* ⚠️ `setConfig` does NOT throw on refusal — it *resolves* with a
           string explaining itself, and resolves with null on success. A
           truthy answer here is a failure wearing the shape of a result, and
           treating it as success is how a connection ends up pointed at
           nothing while the panel says it worked. */
        const refusal = await link.call('mutation', 'instances.connections.setConfig', {
          connectionId: r.id,
          label,
          config: r.spec.configure(facts),
        });
        if (refusal) r.note = `added, but its address was refused: ${refusal}`;
        else r.configured = true;
      } catch (err) {
        /* A connection that exists but is pointed nowhere is still progress,
           and it is visible in Companion where somebody can finish it. */
        r.note = `added, but its address could not be set: ${err.message}`;
      }
    }
  }

  /* `spec` was carried through for `configure()` and is not the caller's
     business — it is a function table, not a result. */
  return results.map(({ spec: _spec, ...rest }) => rest);
}

/* ------------------------------------------------------------------ the mount */

/**
 * Proxy one request through to Companion under the mount.
 *
 * Nothing is buffered and nothing is rewritten here — Companion does its own
 * rewriting, which is the entire reason this mount can exist without the URL
 * rewriter `server/proxy.js` refuses to grow.
 *
 * @param {string} rest the path *below* the mount, always starting with `/`
 */
export function proxyToCompanion(req, res, rest, target, log = () => {}) {
  if (!target) {
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: 'no Companion configured' }));
  }

  const headers = { ...req.headers };
  /* Companion virtual-hosts nothing, but it does compare the Host against
     loopback for its DNS-rebinding guard on `/int`, so it has to be the
     address we actually dialled rather than ours. */
  headers.host = target.port === 80 ? target.host : `${target.host}:${target.port}`;
  headers['companion-custom-prefix'] = PREFIX_HEADER;
  /* Hop-by-hop headers belong to the connection we received on, not to the
     one we are about to make. */
  delete headers.connection;
  delete headers['keep-alive'];
  delete headers['proxy-connection'];
  delete headers['transfer-encoding'];
  delete headers.upgrade;

  const upstream = http.request(
    { host: target.host, port: target.port, method: req.method, path: rest, headers },
    (up) => {
      const out = { ...up.headers };
      /* Node frames our own response; copying the upstream's framing headers
         on top of that is the illegal combination `server/proxy.js` already
         learned about — a content-length beside a transfer-encoding, which
         strict clients reject outright. `content-encoding` is NOT one of
         these: this client does not decompress, so the body really is still
         gzipped and the header is still true. */
      delete out['transfer-encoding'];
      delete out.connection;
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    }
  );

  upstream.on('error', (err) => {
    log(`companion mount: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: `could not reach Companion: ${err.message}` }));
    } else {
      res.destroy();
    }
  });

  req.pipe(upstream);
}

/**
 * Relay a WebSocket upgrade under the mount through to Companion.
 *
 * Byte-for-byte after the request line, exactly as the vendor socket is
 * relayed — this process has no reason to understand what the page and
 * Companion say to each other, and every reason not to have an opinion about
 * it.
 *
 * `rest` must already have the mount stripped: Companion matches the tRPC
 * upgrade on the pathname `/trpc` and nothing else.
 */
export function relayUpgradeToCompanion(req, socket, head, rest, target, log = () => {}) {
  if (!target) { socket.destroy(); return null; }

  /*
   * The cross-origin check, kept — see `originAllowed` in
   * `src/core/companion.js` for the whole argument.
   *
   * Short version: Companion refuses a cross-origin upgrade because a
   * WebSocket gets no CORS preflight, and mounting it under our origin would
   * quietly defeat that. So we make the comparison instead, against the host
   * the browser used to reach *us*, and only then restate the origin as
   * Companion's own. A page on another site is refused here rather than
   * laundered through.
   */
  if (!originAllowed(req.headers.origin, req.headers.host)) {
    log(`companion socket refused: origin ${req.headers.origin} is not ${req.headers.host}`);
    /* Answering rather than destroying: a browser left hanging on an
       unanswered upgrade retries forever and reports nothing useful. */
    if (socket.writable) socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }

  const upstream = net.connect(target.port, target.host, () => {
    const headers = { ...req.headers };
    const upstreamHost = target.port === 80 ? target.host : `${target.host}:${target.port}`;
    headers.host = upstreamHost;
    headers['companion-custom-prefix'] = PREFIX_HEADER;
    /* Restated, not forged: the question this answers was already asked
       above, by the only party still in a position to ask it. Companion
       compares Origin against the Host we are about to send, so the two have
       to agree. */
    if (headers.origin !== undefined) headers.origin = `http://${upstreamHost}`;

    upstream.write(
      `${req.method} ${rest} HTTP/1.1\r\n` +
        Object.entries(headers)
          .map(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`).join('\r\n') : `${k}: ${v}`))
          .join('\r\n') +
        '\r\n\r\n'
    );
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
    log(`companion socket relayed (${rest})`);
  });

  const done = () => { upstream.destroy(); socket.destroy(); };
  upstream.on('error', (err) => { log(`companion socket upstream: ${err.message}`); done(); });
  socket.on('error', done);
  upstream.on('close', done);
  socket.on('close', done);

  return { socket, upstream };
}
