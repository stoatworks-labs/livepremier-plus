/*
 * The sockets for this app as a U5 mini's switcher.  ** PREVIEW **
 *
 * `switcher.js` decides what each request is answered with; this moves the
 * bytes. Three listeners, all for one console:
 *
 * - **UDP 5600**, discovery. nvcontroller searches once a second, broadcast
 *   and to each address in its `device-ips`, and binds to the switcher whose
 *   serial its binding names.
 * - **TCP 19999**, HTTP. The LCD app logs in here, whatever port was
 *   advertised, and so does nvcontroller. Every read and the two writes
 *   arrive here.
 * - **The WebSocket at `/unico/v1/ws`**, on the same port. nvcontroller opens
 *   it, sends nothing, and drops it after 4 s without a WebSocket ping. So
 *   one goes out every second, which held the link for over sixteen minutes
 *   in the rig.
 *
 * ## Who is answered
 *
 * Both sockets bind 0.0.0.0, as desk control's do: a socket bound to one
 * address never sees a broadcast search. **The console's address is the
 * lock.** Anything else is refused at the door, and said once per address.
 * After login, every request must carry the token login handed out, in
 * `authorization`, as both of the mini's clients send it. The token and the
 * serial are kept between runs (`server.js`), so a console still logged in
 * when this app restarts is not refused.
 *
 * ## The port
 *
 * ⚠️ **19999 is PixelFlow's UCenter's port.** Installed, UCenter runs as a
 * root service on `*:19999`, and macOS then refuses every other bind on that
 * port: one address, every address, `SO_REUSEADDR` or `SO_REUSEPORT` (measured
 * 2026-11-06). Its Windows build takes the port too. A refused bind is said in
 * those words on the card, not as an errno.
 */

import { EventEmitter } from 'node:events';
import http from 'node:http';
import dgram from 'node:dgram';

import { acceptFor, wsFrame, readWsFrame, OP } from './ws-client.js';
import { levelled } from './grid-link.js';
import {
  respond, refusal, ok, discoveryProbe, discoveryReply, discoveryBody, SWITCHER_PORT, DISCOVERY_PORT,
} from './switcher.js';

const PING_MS = 1000;
const BODY_LIMIT = 64 * 1024;
const WS_PATH = '/unico/v1/ws';
const LOGIN_PATH = '/unico/v1/system/auth/login';

/** What a refused bind says, in words for someone with a console in front of them. */
export function bindNote(what, port, err) {
  if (err && err.code === 'EADDRINUSE') {
    return port === SWITCHER_PORT
      ? `Port ${port} is in use. On a computer with PixelFlow installed, its UCenter service holds it; stop UCenter `
        + 'to use the console\'s own TAKE and CUT.'
      : `Port ${port} (${what}) is in use by another program.`;
  }
  if (err && err.code === 'EACCES') return `Port ${port} (${what}) is not this app's to use: ${err.message}.`;
  return `${what} on port ${port}: ${err ? err.message : 'failed'}`;
}

/** The address an IPv4-mapped peer is really at: `::ffff:192.168.0.5` is 192.168.0.5. */
const plain = (ip) => String(ip || '').replace(/^::ffff:/, '');

/**
 * This machine's address on the way to `host`: what the mini will see this
 * app as. A UDP socket's `connect` picks the route and sends nothing.
 */
export function facingAddress(host, { port = DISCOVERY_PORT } = {}) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const done = (value) => { try { s.close(); } catch { /* already closed */ } resolve(value); };
    s.once('error', () => done(null));
    try {
      s.connect(port, host, () => {
        try { done(s.address().address); } catch { done(null); }
      });
    } catch { done(null); }
  });
}

export class SwitcherServer extends EventEmitter {
  #http = null;
  #udp = null;
  #ws = new Set();
  #pinger = null;
  #unhandled = new Set();
  #refused = new Set();

  /**
   * @param {object} o
   * @param {(ip: string) => boolean} o.allow  whether a request from this address is the console's
   * @param {() => {serial: string, token: string}} o.identity  kept between runs
   * @param {() => Promise<Array>} o.screens  `screensFrom(facts)`, fresh enough to answer with
   * @param {() => string|null} [o.address]  this app's address on the console's network
   * @param {(kind: 'take'|'cut', ids: string[], unknown: Array) => Promise<{ok: boolean, error?: string}>} o.perform
   * @param {{http?: number, udp?: number}} [o.ports]  for tests and the rig: the real ones are fixed
   * @param {string} [o.bindAddress]
   */
  constructor({
    allow, identity, screens, address = () => null, perform, ports = {}, bindAddress = '0.0.0.0', pingMs = PING_MS, log = () => {},
  }) {
    super();
    Object.assign(this, { allow, identity, screens, address, perform, bindAddress, pingMs });
    this.log = levelled(log);
    this.ports = { http: SWITCHER_PORT, udp: DISCOVERY_PORT, ...ports };
    this.bound = { http: null, udp: null };
    this.errors = { http: null, udp: null };
    this.counts = { searches: 0, logins: 0, requests: 0, refused: 0, takes: 0, cuts: 0 };
    this.last = { search: null, login: null, action: null };
  }

  /* ------------------------------------------------------------ lifecycle */

  async start() {
    await Promise.all([this.#listen(), this.#bindUdp()]);
    this.#pinger = setInterval(() => this.#pingAll(), this.pingMs);
    this.#pinger.unref?.();
    return this.describe();
  }

  async stop() {
    clearInterval(this.#pinger); this.#pinger = null;
    for (const socket of this.#ws) socket.destroy();
    this.#ws.clear();
    const server = this.#http;
    this.#http = null;
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
    try { this.#udp?.close(); } catch { /* already closed */ }
    this.#udp = null;
    this.bound = { http: null, udp: null };
  }

  #listen() {
    return new Promise((done) => {
      const server = http.createServer((req, res) => { void this.#onRequest(req, res); });
      server.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head));
      server.on('clientError', (err, socket) => { socket.destroy(); });
      server.once('error', (err) => {
        this.errors.http = bindNote('the switcher\'s HTTP', this.ports.http, err);
        this.log.warn(`pixelhue switcher: ${this.errors.http}`);
        if (this.#http === server) this.#http = null;
        done();
      });
      this.#http = server;
      server.listen(this.ports.http, this.bindAddress, () => {
        this.errors.http = null;
        this.bound.http = server.address().port;
        done();
      });
    });
  }

  #bindUdp() {
    return new Promise((done) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('message', (buf, rinfo) => this.#onDatagram(buf, rinfo));
      socket.once('error', (err) => {
        this.errors.udp = bindNote('discovery', this.ports.udp, err);
        this.log.warn(`pixelhue switcher: ${this.errors.udp}`);
        try { socket.close(); } catch { /* never bound */ }
        if (this.#udp === socket) this.#udp = null;
        done();
      });
      this.#udp = socket;
      socket.bind(this.ports.udp, this.bindAddress, () => {
        this.errors.udp = null;
        this.bound.udp = socket.address().port;
        done();
      });
    });
  }

  /* ------------------------------------------------------------ the door */

  #admit(ip, what) {
    if (this.allow(ip)) return true;
    this.counts.refused++;
    if (!this.#refused.has(ip)) {
      this.#refused.add(ip);
      this.log.warn(`pixelhue switcher: refused ${what} from ${ip}, which is not the console this app drives`);
      this.emit('activity');
    }
    return false;
  }

  /* ------------------------------------------------------------ discovery */

  #onDatagram(buf, rinfo) {
    const probe = discoveryProbe(buf);
    if (!probe) return;
    if (!this.#admit(rinfo.address, 'a discovery search')) return;
    this.counts.searches++;
    const first = !this.last.search;
    this.last.search = { at: Date.now(), from: rinfo.address };
    const { serial } = this.identity();
    const frame = discoveryReply({ seq: probe.seq, code: probe.code, body: discoveryBody({ serial }) });
    this.#udp?.send(frame, rinfo.port, rinfo.address);
    if (first) this.emit('activity');
  }

  /* ----------------------------------------------------------------- HTTP */

  async #onRequest(req, res) {
    const ip = plain(req.socket.remoteAddress);
    const send = (status, body) => {
      const data = Buffer.from(JSON.stringify(body), 'utf8');
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length });
      res.end(data);
    };
    if (!this.#admit(ip, `${req.method} ${req.url}`)) { send(403, refusal('not the console this switcher serves', 403)); return; }

    let body = null;
    try { body = await readBody(req); } catch (err) { send(413, refusal(err.message, 413)); return; }
    const path = String(req.url || '').split('?')[0];
    const { serial, token } = this.identity();
    this.counts.requests++;

    if (path !== LOGIN_PATH && req.headers.authorization !== token) {
      send(401, refusal('not logged in', 401));
      return;
    }

    let screens = [];
    try { screens = await this.screens(); } catch (err) { this.log.debug(`pixelhue switcher: screens: ${err.message}`); }
    const answer = respond({ method: req.method, path, body }, { screens, serial, token, address: this.address() });

    if (path === LOGIN_PATH) {
      this.counts.logins++;
      /* Two clients log in, nvcontroller and the LCD app; only the first after a quiet spell is news. */
      const news = !this.last.login || Date.now() - this.last.login.at > 60_000;
      this.last.login = { at: Date.now(), from: ip, agent: req.headers['user-agent'] ? 'nvcontroller' : 'LCD app' };
      if (news) this.emit('login', this.last.login);
      this.emit('activity');
    }

    if (answer.action) {
      const { action, ids, unknown } = answer;
      this.counts[action === 'take' ? 'takes' : 'cuts']++;
      let result;
      try {
        result = await this.perform(action, ids, unknown);
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      this.last.action = { at: Date.now(), kind: action, ids, ok: !!(result && result.ok), error: result && result.error };
      this.emit('activity');
      send(200, result && result.ok ? ok({}) : refusal((result && result.error) || `${action} refused`));
      return;
    }

    if (answer.unhandled) {
      const key = `${req.method} ${path}`;
      if (!this.#unhandled.has(key)) {
        this.#unhandled.add(key);
        this.log.warn(`pixelhue switcher: the console asked for ${key}, which this app does not handle yet; answered with a bare success`);
      }
    }
    send(200, answer.reply);
  }

  /* ------------------------------------------------------------ WebSocket */

  #onUpgrade(req, socket) {
    const ip = plain(socket.remoteAddress);
    const path = String(req.url || '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    if (!this.#admit(ip, 'a WebSocket') || path !== WS_PATH || !key) { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${acceptFor(key)}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    this.#ws.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      for (;;) {
        let frame;
        try { frame = readWsFrame(buffer); } catch { socket.destroy(); return; }
        if (!frame) return;
        buffer = buffer.subarray(frame.size);
        if (frame.opcode === OP.PING) socket.write(wsFrame(OP.PONG, frame.payload, { mask: false }));
        else if (frame.opcode === OP.CLOSE) { socket.end(wsFrame(OP.CLOSE, frame.payload, { mask: false })); return; }
      }
    });
    const forget = () => { this.#ws.delete(socket); this.emit('activity'); };
    socket.on('close', forget);
    /* The HTTP server leaves an upgraded socket half open: a console that has gone sends its FIN and no more. */
    socket.on('end', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    this.emit('activity');
  }

  #pingAll() {
    const ping = wsFrame(OP.PING, Buffer.alloc(0), { mask: false });
    for (const socket of this.#ws) {
      try { socket.write(ping); } catch { socket.destroy(); }
    }
  }

  /* -------------------------------------------------------------- reporting */

  describe() {
    return {
      listening: { ...this.bound },
      errors: { ...this.errors },
      links: this.#ws.size,
      counts: { ...this.counts },
      last: { ...this.last },
    };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) { resolve(null); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
    });
    req.on('error', reject);
  });
}
