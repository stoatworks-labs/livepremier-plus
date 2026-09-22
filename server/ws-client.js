/*
 * A WebSocket client, in about as few bytes as RFC 6455 allows.
 *
 * ## Why this exists rather than `ws`
 *
 * This repo has no dependencies and no build step — CI says so in as many
 * words — and the test matrix runs Node **20**, 22 and 26. Node's own global
 * `WebSocket` is not usable across that range: it is flagged on 20 and only
 * became dependable on 22. So the choice was a dependency, dropping Node 20,
 * or this file. This file is about a hundred and fifty lines and the protocol
 * has not changed since 2011.
 *
 * It is also less of a departure than it looks: `server/proxy.js` already
 * relays this protocol at the byte level and `server/awj.js` already speaks a
 * framed protocol over a raw socket. What is new here is only that we are the
 * client rather than the pipe.
 *
 * ## What it deliberately does not do
 *
 * No `permessage-deflate`, no subprotocol negotiation, no binary send, no
 * automatic reconnect. The one server it talks to is Companion's tRPC
 * endpoint, which negotiates none of those, and reconnection is a policy
 * question that belongs to the thing that knows what a lost link *means* —
 * see `plugins/companion/link.js`.
 *
 * ## The four things that are easy to get wrong
 *
 *  - **A client frame must be masked.** RFC 6455 §5.3 requires it and a
 *    conforming server closes the connection when it is not. The mask is four
 *    random bytes and it is not security — it exists so that a hostile page
 *    cannot make a proxy see attacker-chosen plaintext.
 *  - **The bytes after the handshake are already frame data.** The 101
 *    response and the first frame very often arrive in one TCP segment.
 *    Throwing away the remainder of that chunk loses a message that was never
 *    resent, and it happens rarely enough to look like a different bug.
 *  - **Control frames interleave.** A ping can arrive between two fragments
 *    of a text message, so the reader cannot assume a continuation follows a
 *    fragment immediately.
 *  - **A server frame is not masked**, and reading it as if it were produces
 *    plausible rubbish rather than an error.
 */

import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

/** The GUID from RFC 6455 §1.3. It is a constant, not a secret. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/*
 * A ceiling on one message.
 *
 * Nothing Companion sends on this socket is large — the biggest is a button
 * preview, a PNG data URL a few tens of kilobytes across. A frame claiming
 * more than this is either a bug at the far end or something that would sit
 * in this process's memory until it died, and failing loudly is better than
 * either.
 */
const MAX_MESSAGE = 32 * 1024 * 1024;

/**
 * Connect, and emit `open`, `message`, `close` and `error`.
 *
 * `message` carries a string: this client asks for text frames and a binary
 * frame from a server that was never told we wanted one is dropped rather
 * than guessed at.
 */
export class WsClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} opts.port
   * @param {string} opts.path      request target, e.g. `/trpc`
   * @param {number} [opts.timeoutMs] how long to wait for the 101
   */
  constructor({ host, port, path = '/', timeoutMs = 8000 }) {
    super();
    this.host = host;
    this.port = port;
    this.path = path;
    this.open = false;
    this.closed = false;

    this.key = crypto.randomBytes(16).toString('base64');
    this.accept = crypto.createHash('sha1').update(this.key + GUID).digest('base64');

    /* Everything received and not yet consumed — handshake first, then
       frames. One buffer rather than two because the boundary between them
       lands wherever TCP puts it, not where the protocol changes. */
    this.buf = Buffer.alloc(0);
    this.handshook = false;
    /* A message being reassembled across fragments, and the opcode it began
       with — a continuation frame does not carry one. */
    this.fragments = [];
    this.fragmentOp = null;

    this.socket = net.connect({ host, port }, () => this.#sendHandshake());

    this.timer = setTimeout(() => {
      if (!this.open) this.#fail(new Error(`no WebSocket handshake from ${host}:${port} in ${timeoutMs}ms`));
    }, timeoutMs);
    /* The timer must not be the reason this process stays alive. */
    this.timer.unref?.();

    this.socket.on('data', (chunk) => this.#onData(chunk));
    this.socket.on('error', (err) => this.#fail(err));
    this.socket.on('close', () => this.#finish());
  }

  #sendHandshake() {
    /* `Host` carries the port whenever it is not the scheme default, because
       a server that virtual-hosts will otherwise route us somewhere else. */
    const host = this.port === 80 ? this.host : `${this.host}:${this.port}`;
    this.socket.write(
      `GET ${this.path} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${this.key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n'
    );
  }

  #onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;

    if (!this.handshook) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end === -1) {
        /* A header this long is not a header. */
        if (this.buf.length > 64 * 1024) this.#fail(new Error('handshake response never ended'));
        return;
      }
      const header = this.buf.subarray(0, end).toString('latin1');
      /* Whatever followed the blank line is frame data and must survive. */
      this.buf = this.buf.subarray(end + 4);

      const status = /^HTTP\/1\.1 (\d+)/.exec(header);
      if (!status || status[1] !== '101') {
        return this.#fail(new Error(`expected 101 from ${this.host}:${this.port}, got ${status ? status[1] : 'no status line'}`));
      }
      /* Checking the accept header is what makes this a WebSocket handshake
         rather than an HTTP request that happened to get a 101 — a server
         that did not compute it never read our key. */
      const accept = /\r\nsec-websocket-accept:\s*(\S+)/i.exec('\r\n' + header);
      if (!accept || accept[1] !== this.accept) {
        return this.#fail(new Error('Sec-WebSocket-Accept did not match the key we sent'));
      }

      this.handshook = true;
      this.open = true;
      clearTimeout(this.timer);
      this.emit('open');
    }

    this.#readFrames();
  }

  #readFrames() {
    for (;;) {
      if (this.buf.length < 2) return;

      const first = this.buf[0];
      const second = this.buf[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      /* A server frame is never masked. One that is, is not a server we
         understand, and reading past it would desynchronise everything
         after it. */
      const masked = (second & 0x80) !== 0;
      if (masked) return this.#fail(new Error('server sent a masked frame'));

      let len = second & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.#fail(new Error('frame larger than this client will hold'));
        len = Number(big);
        offset = 10;
      }

      /* A control frame is small and never fragmented; anything else is a
         far end that is not following the spec. */
      if (opcode >= 0x8 && (len > 125 || !fin)) return this.#fail(new Error('malformed control frame'));

      if (this.buf.length < offset + len) return;   /* wait for the rest */
      const payload = this.buf.subarray(offset, offset + len);
      this.buf = this.buf.subarray(offset + len);

      if (opcode === OP.PING) { this.#write(OP.PONG, payload); continue; }
      if (opcode === OP.PONG) continue;
      if (opcode === OP.CLOSE) { this.#write(OP.CLOSE, payload.subarray(0, 2)); this.socket.end(); return; }

      if (opcode === OP.CONTINUATION) {
        if (this.fragmentOp === null) return this.#fail(new Error('continuation with nothing to continue'));
      } else {
        if (this.fragmentOp !== null) return this.#fail(new Error('new message began before the last one ended'));
        this.fragmentOp = opcode;
      }

      this.fragments.push(payload);
      const total = this.fragments.reduce((n, f) => n + f.length, 0);
      if (total > MAX_MESSAGE) return this.#fail(new Error('message larger than this client will hold'));

      if (!fin) continue;

      const message = Buffer.concat(this.fragments);
      const wasText = this.fragmentOp === OP.TEXT;
      this.fragments = [];
      this.fragmentOp = null;
      /* Binary is dropped rather than decoded: we asked for none, so one
         arriving means the far end is not the thing we think it is. */
      if (wasText) this.emit('message', message.toString('utf8'));
    }
  }

  /** Send one text message. Silently ignored once the socket has gone. */
  send(text) {
    if (!this.open || this.closed) return false;
    this.#write(OP.TEXT, Buffer.from(String(text), 'utf8'));
    return true;
  }

  #write(opcode, payload) {
    if (this.socket.destroyed) return;
    const len = payload.length;
    /* 2 bytes of header, up to 8 of extended length, 4 of mask. */
    const head = Buffer.alloc(len < 126 ? 6 : len < 65536 ? 8 : 14);
    head[0] = 0x80 | opcode;                    /* FIN, no reserved bits */

    if (len < 126) {
      head[1] = 0x80 | len;                     /* MASK | length */
    } else if (len < 65536) {
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    } else {
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }

    const mask = crypto.randomBytes(4);
    mask.copy(head, head.length - 4);

    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];

    /* One write, not two.
     *
     * Two writes can be flushed as two TCP segments, which puts a frame
     * header on the wire without its payload behind it. Every conforming
     * server reassembles, so this is not a correctness bug on the wire — but
     * it doubles the syscalls per message, and it makes any peer that reads
     * a chunk at a time see something it has to buffer. It also made this
     * repo's own test server decode the payload as if it were a second
     * frame, which is a fair imitation of a naive peer. */
    this.socket.write(Buffer.concat([head, masked]));
  }

  /** Hang up. Idempotent, and safe to call before the handshake finished. */
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    try {
      if (this.open) this.#write(OP.CLOSE, Buffer.from([0x03, 0xe8]));   /* 1000, normal */
    } catch { /* the socket beat us to it */ }
    this.socket.destroy();
  }

  #fail(err) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.emit('error', err);
    this.socket.destroy();
  }

  #finish() {
    clearTimeout(this.timer);
    this.open = false;
    this.closed = true;
    /* Always, and exactly once — `close` is how the supervisor above decides
       whether to redial, and a failure that emitted only `error` would leave
       it waiting for a socket that is already gone. */
    this.emit('close');
  }
}
