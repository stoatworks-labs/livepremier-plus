/*
 * A WebSocket client, in about two hundred lines and with no dependencies.
 *
 * ## Why this exists at all
 *
 * Node grew a global `WebSocket` in 22. This repo's floor is **node 20** —
 * `.github/workflows/ci.yml` says why, and lowering a floor is a decision, not
 * a convenience. pixelhue-bridge upstream simply requires 22 and takes
 * `WebSocketImpl` as an option for exactly this case; this is that option.
 *
 * It is a *client*, which is the easy half of RFC 6455, and the console speaks
 * plain `ws://` on the show LAN. Three things are deliberate:
 *
 * - **No `permessage-deflate`.** It is never offered, so the server cannot
 *   choose it, so there is no inflate path to get wrong. The frames this
 *   carries are a few hundred bytes to a few tens of kilobytes of JSON inside
 *   a binary envelope, on a local network.
 * - **Fragmentation is handled.** The console's first frame after a connect is
 *   its whole key-state dump — 15 KB on a U5 Pro — and whether that arrives in
 *   one frame is the server's choice, not ours.
 * - **Every client frame is masked**, because the RFC requires it and servers
 *   close the connection when it is missing. The mask is from
 *   `crypto.randomBytes`, not `Math.random`, for no better reason than that
 *   the RFC says unpredictable and it costs nothing.
 *
 * `server/proxy.js` relays the browser's own WebSocket byte-for-byte and so
 * has never needed to understand framing. This is the first place in the
 * repo that does.
 */

import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';

/** The RFC's magic string, appended to the key before the accept hash. */
const GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11D';

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/**
 * @fires open
 * @fires message  (Buffer, {binary: boolean})
 * @fires close    ({code, reason})
 * @fires error    (Error)
 */
export class WsClient extends EventEmitter {
  #socket = null;
  #buffer = Buffer.alloc(0);
  #fragments = [];
  #fragmentOp = null;
  #open = false;
  #closing = false;

  /**
   * @param {string} url        ws://host:port/path?query
   * @param {object} [options]
   * @param {number} [options.handshakeMs]  give up on a server that accepts the
   *                                        TCP connection and then says nothing
   */
  constructor(url, { handshakeMs = 8000 } = {}) {
    super();
    this.url = url;
    this.handshakeMs = handshakeMs;
  }

  get isOpen() { return this.#open; }

  connect() {
    const target = new URL(this.url);
    if (target.protocol !== 'ws:') {
      throw new Error(`only ws:// is supported here, not ${target.protocol}`);
    }
    const key = randomBytes(16).toString('base64');
    const accept = createHash('sha1').update(key + GUID).digest('base64');

    const req = http.request({
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    const timer = setTimeout(() => {
      req.destroy(new Error(`no upgrade from ${target.host} within ${this.handshakeMs}ms`));
    }, this.handshakeMs);
    if (timer.unref) timer.unref();

    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      if (res.headers['sec-websocket-accept'] !== accept) {
        socket.destroy();
        this.emit('error', new Error('the server answered with the wrong accept key'));
        return;
      }
      this.#socket = socket;
      this.#open = true;
      socket.setNoDelay(true);
      socket.on('data', (chunk) => this.#feed(chunk));
      socket.on('error', (err) => this.emit('error', err));
      socket.on('close', () => this.#finish(1006, 'socket closed'));
      if (head && head.length) this.#feed(head);
      this.emit('open');
    });

    /* A server that answers the upgrade request with an ordinary response has
       refused it, and its status code is the useful part of the message. */
    req.on('response', (res) => {
      clearTimeout(timer);
      res.resume();
      this.emit('error', new Error(`upgrade refused with HTTP ${res.statusCode}`));
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      this.emit('error', err);
    });
    req.end();
    return this;
  }

  /* ------------------------------------------------------------- reading */

  #feed(chunk) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    for (;;) {
      const frame = this.#readFrame();
      if (!frame) return;
      this.#dispatch(frame);
    }
  }

  /**
   * Pull one whole frame off the buffer, or return null and wait for more.
   *
   * A server frame is never masked; one that is would be a protocol error, and
   * treating it as a short read would hang rather than say so.
   */
  #readFrame() {
    const buf = this.#buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let at = 2;

    if (len === 126) {
      if (buf.length < at + 2) return null;
      len = buf.readUInt16BE(at); at += 2;
    } else if (len === 127) {
      if (buf.length < at + 8) return null;
      const big = buf.readBigUInt64BE(at); at += 8;
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.emit('error', new Error('frame longer than this can address'));
        this.close(1009, 'too big');
        return null;
      }
      len = Number(big);
    }

    let mask = null;
    if (masked) {
      if (buf.length < at + 4) return null;
      mask = buf.subarray(at, at + 4); at += 4;
    }
    if (buf.length < at + len) return null;

    const payload = Buffer.from(buf.subarray(at, at + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.#buffer = buf.subarray(at + len);
    return { fin, opcode, payload };
  }

  #dispatch({ fin, opcode, payload }) {
    if (opcode === OP.PING) { this.#send(OP.PONG, payload); return; }
    if (opcode === OP.PONG) { this.emit('pong', payload); return; }
    if (opcode === OP.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      if (!this.#closing) this.#send(OP.CLOSE, payload);
      this.#finish(code, reason);
      return;
    }

    if (opcode === OP.CONT) {
      if (this.#fragmentOp === null) {
        this.emit('error', new Error('a continuation frame with nothing to continue'));
        return;
      }
      this.#fragments.push(payload);
    } else {
      if (this.#fragmentOp !== null) {
        this.emit('error', new Error('a new message began before the last one finished'));
        this.#fragments = [];
      }
      this.#fragmentOp = opcode;
      this.#fragments = [payload];
    }

    if (!fin) return;
    const body = this.#fragments.length === 1 ? this.#fragments[0] : Buffer.concat(this.#fragments);
    const op = this.#fragmentOp;
    this.#fragments = [];
    this.#fragmentOp = null;
    this.emit('message', body, { binary: op === OP.BINARY });
  }

  /* ------------------------------------------------------------- writing */

  send(data, { binary = Buffer.isBuffer(data) } = {}) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this.#send(binary ? OP.BINARY : OP.TEXT, body);
  }

  ping(data = Buffer.alloc(0)) { this.#send(OP.PING, data); }

  #send(opcode, payload) {
    if (!this.#socket || !this.#open) return;
    const len = payload.length;
    const head = len < 126 ? 2 : len < 65536 ? 4 : 10;
    const frame = Buffer.allocUnsafe(head + 4 + len);
    frame[0] = 0x80 | opcode;
    if (len < 126) frame[1] = 0x80 | len;
    else if (len < 65536) { frame[1] = 0x80 | 126; frame.writeUInt16BE(len, 2); }
    else { frame[1] = 0x80 | 127; frame.writeBigUInt64BE(BigInt(len), 2); }

    const mask = randomBytes(4);
    mask.copy(frame, head);
    for (let i = 0; i < len; i++) frame[head + 4 + i] = payload[i] ^ mask[i & 3];
    try { this.#socket.write(frame); } catch (err) { this.emit('error', err); }
  }

  close(code = 1000, reason = '') {
    if (!this.#open || this.#closing) { this.#socket?.destroy(); return; }
    this.#closing = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2, 'utf8');
    this.#send(OP.CLOSE, body);
    /* Give the server a moment to answer, then stop waiting. A console that
       has been unplugged never answers, and the launcher's Stop button must
       not hang on it — the same failure `server.closeRelays()` exists for. */
    const timer = setTimeout(() => this.#socket?.destroy(), 500);
    if (timer.unref) timer.unref();
  }

  #finish(code, reason) {
    if (!this.#open) return;
    this.#open = false;
    this.#socket?.destroy();
    this.#socket = null;
    this.emit('close', { code, reason });
  }
}
