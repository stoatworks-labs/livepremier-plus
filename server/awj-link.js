/*
 * One AWJ connection, held while a lighting desk is driving the switcher.
 *
 * ## This is the thing `awj.js` says to argue for first
 *
 * `server/awj.js` opens a socket per exchange and says: "If you are about to
 * make this hold a connection open, subscribe to anything, or write into the
 * store mirror, the original argument applies to you and you have to beat
 * it." The original argument (AGENTS.md, and the head of `awj.js`) is that
 * the store is already mirrored from the vendor socket, so an AWJ reader would
 * be a second source of truth for the same state. This holds a connection, so
 * here is why that argument still does not reach it:
 *
 * - **Nothing comes down it unasked.** AWJ does not push: a second socket held
 *   open on the 6.2.73 simulator heard nothing while another client changed a
 *   screen's take time, and the writer gets no echo either (measured
 *   2026-10-30). So a held socket is not a subscription and cannot drift into
 *   being a mirror. Every value read is the answer to a `get` asked that
 *   moment, handed back and forgotten, exactly as `exchange()` does.
 * - **It reads what the desk consoles already read.** Which preset letter is
 *   preview and which is program, per screen, before writing to one — the
 *   same `get`s `console-switcher.js` makes in bursts, made more often.
 *   Nothing touches the store mirror.
 * - **The rate needs it.** A desk sends DMX up to 44 times a second. One TCP
 *   connection per exchange would open and close sockets at that rate against
 *   a switcher that counts its five AWJ clients. One held socket is one client.
 *
 * What it costs is that one client of the five, for as long as a desk is
 * driving. It is closed after `idleMs` without an exchange, and opened again
 * by the next one.
 *
 * ## The interface is `exchange()`'s
 *
 * `link.exchange({ messages })` resolves with the replies to its `get`s, as
 * `awj.js`'s does, so anything written against that (`ConsoleSwitcher` takes
 * an `exchange` to use) runs on a held socket unchanged. Exchanges go one at a
 * time: AWJ answers in order and carries no request id, so two interleaved
 * bursts could not be told apart.
 */

import net from 'node:net';
import { AWJ_PORT } from './awj.js';

const EOT = 0x04;
const CONNECT_TIMEOUT_MS = 3000;
const REPLY_TIMEOUT_MS = 2000;
export const IDLE_MS = 5000;

export class AwjLink {
  #socket = null;
  #connecting = null;
  #buffer = Buffer.alloc(0);
  #waiting = null;          /* { expected, replies, resolve, reject, timer } */
  #queue = Promise.resolve();
  #idle = null;
  #closed = false;

  /**
   * @param {object} o
   * @param {() => string|null} o.host  the switcher, read per connection
   * @param {number} [o.port]
   * @param {number} [o.idleMs]
   */
  constructor({ host, port = AWJ_PORT, idleMs = IDLE_MS } = {}) {
    this.host = host;
    this.port = port;
    this.idleMs = idleMs;
    this.stats = { connects: 0, exchanges: 0, sent: 0, errors: 0 };
    this.lastError = null;
    /* Bound so it can be handed around as a plain function. */
    this.exchange = this.exchange.bind(this);
  }

  get open() { return !!this.#socket; }

  /**
   * Send `messages` (`{op:'get'|'replace', path, value?}`) and resolve with the
   * replies to the `get`s, in arrival order.
   */
  exchange({ messages }) {
    const run = this.#queue.then(() => this.#run(messages));
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Hang up now. The next exchange opens a new connection. */
  close() {
    clearTimeout(this.#idle);
    this.#idle = null;
    const s = this.#socket;
    this.#socket = null;
    this.#connecting = null;
    if (s) s.destroy();
    this.#fail(new Error('AWJ link closed'));
  }

  /** Close for good: the plugin is stopping. */
  dispose() {
    this.#closed = true;
    this.close();
  }

  async #run(messages) {
    if (this.#closed) throw new Error('AWJ link closed');
    if (!Array.isArray(messages) || !messages.length) return [];
    clearTimeout(this.#idle);
    const socket = await this.#connect();
    const expected = messages.filter((m) => m.op === 'get').length;
    const out = [];
    for (const m of messages) {
      const obj = m.op === 'get' ? { op: 'get', path: m.path } : { op: 'replace', path: m.path, value: m.value };
      out.push(Buffer.from(JSON.stringify(obj), 'utf8'), Buffer.from([EOT]));
    }
    this.stats.exchanges++;
    this.stats.sent += messages.length;
    try {
      const replies = await new Promise((resolve, reject) => {
        if (expected === 0) {
          /* A write is answered with silence. Resolve once the bytes have
             left this process, not before: a write still buffered when the
             socket is closed would be lost with no error anywhere. */
          socket.write(Buffer.concat(out), (err) => (err ? reject(err) : resolve([])));
          return;
        }
        const timer = setTimeout(() => {
          this.#waiting = null;
          reject(new Error(`no reply within ${REPLY_TIMEOUT_MS}ms — the path may not exist on this firmware`));
          /* Late replies would be taken for the next burst's: start again. */
          this.close();
        }, REPLY_TIMEOUT_MS);
        timer.unref?.();
        this.#waiting = { expected, replies: [], resolve, reject, timer };
        socket.write(Buffer.concat(out));
      });
      this.#armIdle();
      return replies;
    } catch (err) {
      this.stats.errors++;
      this.lastError = err.message;
      throw err;
    }
  }

  #armIdle() {
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.close(), this.idleMs);
    this.#idle.unref?.();
  }

  #connect() {
    if (this.#socket) return Promise.resolve(this.#socket);
    if (this.#connecting) return this.#connecting;
    const host = this.host();
    if (!host) return Promise.reject(new Error('no switcher configured'));
    this.#connecting = new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`no answer from ${host}:${this.port} — AWJ can be switched off in the Web RCS security settings`));
      }, CONNECT_TIMEOUT_MS);
      timer.unref?.();
      socket.on('error', (err) => {
        clearTimeout(timer);
        this.lastError = `${host}:${this.port}: ${err.message}`;
        if (this.#socket === socket) this.close();
        reject(new Error(this.lastError));
      });
      socket.on('close', () => {
        if (this.#socket === socket) { this.#socket = null; this.#fail(new Error(`${host} hung up`)); }
      });
      socket.on('data', (chunk) => this.#onData(chunk));
      socket.connect({ host, port: this.port }, () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        this.#socket = socket;
        this.#buffer = Buffer.alloc(0);
        this.stats.connects++;
        resolve(socket);
      });
    }).finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let i;
    while ((i = this.#buffer.indexOf(EOT)) !== -1) {
      const frame = this.#buffer.subarray(0, i);
      this.#buffer = this.#buffer.subarray(i + 1);
      let msg;
      try { msg = JSON.parse(frame.toString('utf8')); } catch { continue; }
      const w = this.#waiting;
      /* Nothing asked for: AWJ does not push, so this would be a stray reply
         to a burst that already timed out. Dropped. */
      if (!w) continue;
      w.replies.push(msg);
      if (w.replies.length >= w.expected) {
        clearTimeout(w.timer);
        this.#waiting = null;
        w.resolve(w.replies);
      }
    }
  }

  #fail(err) {
    const w = this.#waiting;
    if (!w) return;
    clearTimeout(w.timer);
    this.#waiting = null;
    w.reject(err);
  }
}
