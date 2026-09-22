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
 * `/__lpp/companion/assets/polyfills-….js`, and the bundle's socket helper
 * comes back as ``Wu([`/__lpp/companion`, e])`` so the UI dials
 * `/__lpp/companion/trpc`.
 *
 * **The trap:** Companion's own Express routes match the *unprefixed* path,
 * and its WebSocket server matches the pathname `/trpc` exactly
 * (`isTrpcUpgradeRequest` in its `UI/Handler.ts`). So the prefix must be
 * stripped from the request line before forwarding and announced only in the
 * header. Forwarding `/__lpp/companion/trpc` verbatim gets a socket that
 * hangs with no error anywhere.
 */

import http from 'node:http';
import net from 'node:net';

import { WsClient } from './ws-client.js';
import { originAllowed, parseFrames, request, stopRequest } from '../src/core/companion.js';

/** The path under the app's namespace that Companion is mounted at. */
export const MOUNT = '/companion';

/**
 * The prefix as Companion wants to be told it, with **no leading slash**.
 *
 * Its `getCustomPrefixHeader` builds `/${header}` itself, and refuses any
 * value containing `://` or `..`. Sending a leading slash produces `//…` in
 * every rewritten URL, which mostly works and occasionally does not.
 */
export const PREFIX_HEADER = '__lpp/companion';

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
export class CompanionLink {
  /** @param {(msg: string) => void} log */
  constructor(log = () => {}) {
    this.log = log;
    this.config = { companionEnabled: false, companionHost: '', companionPort: 0 };
    this.ws = null;
    this.retry = null;
    this.retryMs = RETRY_MIN_MS;
    this.nextId = 0;
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
    });

    ws.on('message', (text) => this.#onMessage(text));

    ws.on('error', (err) => {
      this.state.error = err.message;
      this.log(`companion link: ${err.message}`);
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;             /* superseded by a newer dial */
      this.ws = null;
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
