/*
 * The hand-rolled WebSocket client.
 *
 * ## What these tests can and cannot prove
 *
 * `server/ws-client.js` exists because this repo has no dependencies and CI
 * runs Node 20, where the global `WebSocket` is not available. That trade buys
 * a framing implementation we now own, and framing code fails in a particular
 * way: not by throwing, but by quietly reading the next frame from the wrong
 * offset, so that a message arrives corrupted or a socket stops answering
 * several exchanges after the mistake.
 *
 * So these tests drive it from a **server written here** rather than from a
 * library, which lets each frame be built byte by byte and the awkward shapes
 * produced deliberately: a message split across continuation frames, a ping
 * interleaved between two of those fragments, the 16-bit and 64-bit extended
 * length forms, and a close in the same TCP segment as a message.
 *
 * The client has separately been run against a **live Companion 5.0.5** and
 * carried a 6.8 KB button preview and repeated round-trips without
 * desynchronising. That is the stronger evidence that it works; this file is
 * the evidence that it goes on working.
 *
 * What none of it proves is behaviour against a hostile or broken peer beyond
 * the specific malformations below.
 *
 * Run: node --test test/ws-client.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';

import { WsClient } from '../server/ws-client.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * A WebSocket server that does exactly as it is told.
 *
 * Not a general implementation — it completes the handshake, hands the test a
 * socket to write raw frames onto, and decodes the client's (masked) frames so
 * a test can assert on what was sent.
 */
function serve(onConnection, { accept = true } = {}) {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let handshook = false;
    /* Frames the client has sent, fully decoded. A test asserts on this
       rather than on whatever happened to be in one chunk — a 200 KB message
       is always split by the kernel, so "one chunk is one frame" is a
       property no reader may assume, this one included. */
    const received = [];

    const drainFrames = () => {
      for (;;) {
        if (buf.length < 2) return;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const need = off + (masked ? 4 : 0) + len;
        if (buf.length < need) return;

        const mask = masked ? buf.subarray(off, off + 4) : null;
        const start = off + (masked ? 4 : 0);
        const body = Buffer.from(buf.subarray(start, start + len));
        if (mask) for (let i = 0; i < len; i++) body[i] ^= mask[i & 3];

        received.push({
          opcode: buf[0] & 0x0f,
          fin: (buf[0] & 0x80) !== 0,
          masked,
          text: body.toString('utf8'),
        });
        buf = buf.subarray(need);
      }
    };

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshook) {
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const header = buf.subarray(0, end).toString('latin1');
        buf = buf.subarray(end + 4);
        handshook = true;

        if (!accept) {
          socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        const key = /sec-websocket-key:\s*(\S+)/i.exec(header)?.[1];
        const hash = crypto.createHash('sha1').update(key + GUID).digest('base64');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
            `Connection: Upgrade\r\nSec-WebSocket-Accept: ${hash}\r\n\r\n`
        );
        onConnection(socket, {
          received,
          /** The last frame of a given opcode, or the last of any. */
          last: (opcode) =>
            [...received].reverse().find((f) => opcode === undefined || f.opcode === opcode) ?? null,
          /** Frame a payload as the server does: never masked. */
          frame(opcode, payload, fin = true) {
            const body = Buffer.from(payload);
            const len = body.length;
            const head =
              len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
            head[0] = (fin ? 0x80 : 0x00) | opcode;
            if (len < 126) head[1] = len;
            else if (len < 65536) { head[1] = 126; head.writeUInt16BE(len, 2); }
            else { head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
            return Buffer.concat([head, body]);
          },
        });
        drainFrames();
        return;
      }
      drainFrames();
    });
    socket.on('error', () => { /* a test that ends first is not a failure */ });
  });
  return server;
}

/** Start a server on an ephemeral port and connect a client to it. */
function connect(onConnection, opts = {}) {
  return new Promise((resolve) => {
    const server = serve(onConnection, opts);
    server.listen(0, '127.0.0.1', () => {
      const client = new WsClient({
        host: '127.0.0.1',
        port: server.address().port,
        path: '/trpc',
        timeoutMs: opts.timeoutMs ?? 2000,
      });
      resolve({ server, client, done: () => { client.close(); server.close(); } });
    });
  });
}

/** Resolve on the first `message`, or reject on `error`/`close`. */
const firstMessage = (client) =>
  new Promise((resolve, reject) => {
    client.once('message', resolve);
    client.once('error', reject);
    client.once('close', () => reject(new Error('closed before a message arrived')));
  });

test('a whole text message arrives', async () => {
  const { client, done } = await connect((socket, w) => {
    socket.write(w.frame(0x1, 'hello'));
  });
  assert.equal(await firstMessage(client), 'hello');
  done();
});

test('a message split across continuation frames is reassembled', async () => {
  const { client, done } = await connect((socket, w) => {
    /* The opcode is only on the first frame; a continuation carries 0x0 and
       the reader has to remember what it was continuing. */
    socket.write(w.frame(0x1, 'one ', false));
    socket.write(w.frame(0x0, 'two ', false));
    socket.write(w.frame(0x0, 'three', true));
  });
  assert.equal(await firstMessage(client), 'one two three');
  done();
});

test('a ping between two fragments is answered without corrupting the message', async () => {
  let harness = null;
  const { client, done } = await connect((socket, w) => {
    harness = w;
    socket.write(w.frame(0x1, 'frag-', false));
    socket.write(w.frame(0x9, 'ping-payload'));      /* control frame, interleaved */
    socket.write(w.frame(0x0, 'ment', true));
  });

  assert.equal(await firstMessage(client), 'frag-ment');
  /* The pong must echo the ping's payload, and must arrive — a server that
     pings an unresponsive client eventually hangs up on it. */
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(harness.last(0xa)?.text, 'ping-payload');
  done();
});

test('the 16-bit extended length form is read', async () => {
  const big = 'x'.repeat(5000);          /* > 125, < 65536 */
  const { client, done } = await connect((socket, w) => socket.write(w.frame(0x1, big)));
  assert.equal((await firstMessage(client)).length, 5000);
  done();
});

test('the 64-bit extended length form is read', async () => {
  const huge = 'y'.repeat(70000);        /* >= 65536 */
  const { client, done } = await connect((socket, w) => socket.write(w.frame(0x1, huge)));
  assert.equal((await firstMessage(client)).length, 70000);
  done();
});

test('a frame arriving in the same segment as the handshake is not lost', async () => {
  /* The 101 and the first frame very often share a TCP segment. Discarding
     what follows the blank line loses a message that is never resent, and it
     is rare enough to look like a different bug entirely. */
  const { client, done } = await connect((socket, w) => {
    /* `serve` has already written the 101 by the time this runs, but Nagle
       coalesces them; writing immediately is the closest this can get to
       forcing the case, and the buffer path is the same either way. */
    socket.write(w.frame(0x1, 'racing'));
  });
  assert.equal(await firstMessage(client), 'racing');
  done();
});

test('two messages in one write are both delivered, in order', async () => {
  const seen = [];
  const { client, done } = await connect((socket, w) => {
    socket.write(Buffer.concat([w.frame(0x1, 'first'), w.frame(0x1, 'second')]));
  });
  client.on('message', (m) => seen.push(m));
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(seen, ['first', 'second']);
  done();
});

test('what the client sends is masked, as the spec requires of a client', async () => {
  let harness = null;
  const { client, done } = await connect((_socket, w) => { harness = w; });
  await new Promise((resolve) => client.once('open', resolve));
  client.send('{"id":1}');
  await new Promise((r) => setTimeout(r, 60));

  /* A conforming server closes the connection on an unmasked client frame,
     so this is not a detail — it is whether the socket survives at all. */
  const sent = harness.last(0x1);
  assert.equal(sent.masked, true);
  assert.equal(sent.text, '{"id":1}');
  assert.equal(sent.opcode, 0x1);
  assert.equal(sent.fin, true);
  done();
});

test('a long message from the client uses an extended length and still round-trips', async () => {
  let harness = null;
  const { client, done } = await connect((_socket, w) => { harness = w; });
  await new Promise((resolve) => client.once('open', resolve));
  /* Over 65536, so the 64-bit length branch of the writer is the one under
     test — and far larger than one TCP segment, so the server here has to
     reassemble it from several chunks. */
  const long = JSON.stringify({ blob: 'z'.repeat(200000) });
  client.send(long);
  await new Promise((r) => setTimeout(r, 200));
  const sent = harness.last(0x1);
  assert.equal(sent.masked, true);
  assert.equal(sent.text.length, long.length);
  assert.equal(sent.text, long, 'a mask applied at the wrong offset corrupts the tail only');
  done();
});

test('a server that does not upgrade is an error, not a hang', async () => {
  const { client, done } = await connect(() => {}, { accept: false });
  const err = await new Promise((resolve) => client.once('error', resolve));
  assert.match(err.message, /expected 101/);
  done();
});

test('a wrong Sec-WebSocket-Accept is refused', async () => {
  /* Computing the accept is what distinguishes a WebSocket server from
     something that happened to answer 101 — a peer that did not compute it
     never read our key and is not speaking this protocol. */
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.indexOf('\r\n\r\n') === -1) return;
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
          'Connection: Upgrade\r\nSec-WebSocket-Accept: obviously-wrong\r\n\r\n'
      );
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new WsClient({ host: '127.0.0.1', port: server.address().port, path: '/', timeoutMs: 1500 });
  const err = await new Promise((resolve) => client.once('error', resolve));
  assert.match(err.message, /Sec-WebSocket-Accept/);
  client.close();
  server.close();
});

test('a masked server frame is refused rather than decoded into rubbish', async () => {
  const { client, done } = await connect((socket) => {
    /* MASK set on a server frame. Reading it as unmasked would yield
       plausible-looking bytes and leave every later frame misaligned. */
    socket.write(Buffer.from([0x81, 0x85, 0x01, 0x02, 0x03, 0x04, 0x69, 0x67, 0x6f, 0x68, 0x6e]));
  });
  const err = await new Promise((resolve) => client.once('error', resolve));
  assert.match(err.message, /masked frame/);
  done();
});

test('an oversized control frame is refused', async () => {
  const { client, done } = await connect((socket, w) => {
    /* A control frame must be <= 125 bytes and never fragmented. */
    socket.write(w.frame(0x9, 'p'.repeat(200)));
  });
  const err = await new Promise((resolve) => client.once('error', resolve));
  assert.match(err.message, /control frame/);
  done();
});

test('a close from the server ends the socket and emits close exactly once', async () => {
  let closes = 0;
  const { client, server } = await connect((socket, w) => {
    socket.write(w.frame(0x1, 'bye-first'));
    socket.write(w.frame(0x8, Buffer.from([0x03, 0xe8])));
  });
  client.on('close', () => closes++);
  assert.equal(await firstMessage(client), 'bye-first');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(closes, 1, 'the supervisor above decides to redial on close, so twice means twice');
  assert.equal(client.open, false);
  server.close();
});

test('close() before the handshake finishes does not throw', async () => {
  /* The launcher's Stop button can land here, and a teardown that throws
     leaves the process alive for the wrong reason. */
  const server = net.createServer(() => { /* never answers */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new WsClient({ host: '127.0.0.1', port: server.address().port, path: '/', timeoutMs: 5000 });
  client.on('error', () => {});
  client.close();
  assert.equal(client.closed, true);
  server.close();
});

test('send() after close is ignored rather than throwing', async () => {
  const { client, done } = await connect(() => {});
  await new Promise((resolve) => client.once('open', resolve));
  client.close();
  assert.equal(client.send('anything'), false);
  done();
});


/*
 * 2026-09-23: Companion's tRPC server keeps a socket alive with a bare TEXT
 * `PING` after 30 s of silence, and terminates it unless something comes back
 * within 5 s. The link never answered, so it was closed and redialled every 35
 * seconds with no error at either end. It answers `PONG`, as tRPC's own
 * client does.
 */
test('the Companion link answers tRPC’s text PING with PONG, so Companion keeps it open', async () => {
  const { CompanionLink } = await import('../plugins/companion/link.js');
  let wire = null;
  const server = serve((socket, w) => {
    wire = w;
    socket.write(w.frame(0x1, 'PING'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const link = new CompanionLink();
  try {
    link.apply({ companionEnabled: true, companionHost: '127.0.0.1', companionPort: server.address().port });
    for (let i = 0; i < 100 && !(wire && wire.received.some((f) => f.opcode === 0x1 && f.text === 'PONG')); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const pong = wire && wire.received.find((f) => f.opcode === 0x1 && f.text === 'PONG');
    assert.ok(pong, 'a text PONG came back');
    assert.equal(pong.masked, true, 'masked, as every client frame must be');
  } finally {
    link.stop();
    server.close();
  }
});
