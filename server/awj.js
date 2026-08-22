/*
 * AWJ over TCP 10606, from this process.
 *
 * ## Yes, this is the AWJ path AGENTS.md says there deliberately is not
 *
 * That argument is still correct and still stands, so read it before changing
 * anything here. It says: the store is already mirrored from the vendor socket
 * and stays current, so **an AWJ reader would be a second source of truth for
 * the same state**, and two sources that can disagree about what is on air is
 * worse than a slow first paint.
 *
 * Every word of that is about *reading state into the mirror*. This is not
 * that, and the difference is the whole reason it is allowed to exist:
 *
 * - **Nothing here ever touches the store mirror.** A reply is handed back to
 *   whoever asked for it and then forgotten. The mirror has exactly one
 *   source, still, and it is the vendor socket.
 * - **It is not a subscription and it holds no connection.** One socket per
 *   exchange, opened and closed. There is no stream to drift.
 * - **The two callers need something the mirror cannot give.** A typed
 *   `{"op":"get",…}` wants what the *device* says right now, in the protocol's
 *   own spelling — checking the mirror instead would be answering a question
 *   about the device with our own opinion of it. And the OSC server has to
 *   work when no browser is open at all, which is the point of a show-control
 *   input.
 *
 * If you are about to make this hold a connection open, subscribe to anything,
 * or write into the store mirror, the original argument applies to you and you
 * have to beat it first.
 *
 * ## The wire
 *
 * One JSON object per message, terminated by ASCII 0x04 — not a newline, which
 * is what catches out anyone who reads "JSON" and reaches for a line codec.
 * Exactly one `op`, only ever `replace` or `get`.
 *
 * ```text
 * {"op":"get","path":"DeviceObject/system/$device/@items/1/@props/dev"}<0x04>
 * {"path":"DeviceObject/system/$device/@items/1/@props/dev","value":"NLC_RS4"}<0x04>
 * ```
 *
 * ## A write is answered with silence
 *
 * A `replace` produces no reply at all — success is not acknowledged, exactly
 * as on the WebSocket. So replies are waited for only when a `get` was sent,
 * and only until there is one per `get`. Waiting for a reply to a write would
 * time out on every successful command.
 */

import net from 'node:net';

/** The AWJ control port. Fixed by the vendor. */
export const AWJ_PORT = 10606;

/** ASCII end-of-transmission. The message terminator; not a newline. */
const EOT = 0x04;

const CONNECT_TIMEOUT_MS = 3000;
const REPLY_TIMEOUT_MS = 2000;

/**
 * The device allows five AWJ clients at once and counts them.
 *
 * Not enforced here — this opens one connection and closes it — but worth
 * stating where someone will read it, because the budget is shared with
 * anything else on the network and it is the first thing to suspect when a
 * connection is refused on a device that is plainly up.
 */
export const CLIENT_BUDGET = 5;

/**
 * Run one AWJ exchange against a device.
 *
 * @param {object} opts
 * @param {string} opts.host          the switcher
 * @param {number} [opts.port]        AWJ port, 10606 unless someone moved it
 * @param {Array<{op:'replace'|'get', path:string, value?:unknown}>} opts.messages
 * @returns {Promise<Array<{path:string, value:unknown}>>} replies, in arrival order
 */
export function exchange({ host, port = AWJ_PORT, messages }) {
  if (!Array.isArray(messages) || messages.length === 0) return Promise.resolve([]);

  const expected = messages.filter((m) => m.op === 'get').length;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const replies = [];
    let buffer = Buffer.alloc(0);
    let settled = false;

    /* One timer, re-armed for the reply phase. `unref` is deliberate: a
       forgotten timer here would keep the whole process alive after the
       launcher asked it to stop. */
    let timer = setTimeout(() => finish(new Error(
      `no answer from ${host}:${port} — AWJ can be switched off in the Web RCS security settings`
    )), CONNECT_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err); else resolve(value);
    }

    socket.on('error', (err) => finish(new Error(`${host}:${port}: ${err.message}`)));

    /* A device that hangs up mid-exchange is not an error: whatever arrived is
       what there is, and reporting nothing at all would lose it. */
    socket.on('close', () => finish(null, replies));

    socket.connect({ host, port }, () => {
      /* Nagle would hold a short message back waiting for company. Every
         message here is short and every one of them is a command. */
      socket.setNoDelay(true);

      const out = [];
      for (const m of messages) {
        const obj = m.op === 'get'
          ? { op: 'get', path: m.path }
          : { op: 'replace', path: m.path, value: m.value };
        out.push(Buffer.from(JSON.stringify(obj), 'utf8'), Buffer.from([EOT]));
      }
      socket.write(Buffer.concat(out));

      if (expected === 0) {
        /*
         * Nothing is coming back, but the bytes still have to leave.
         *
         * `finish` destroys the socket, and destroying one whose write is
         * still buffered discards it — so a write-only exchange resolved
         * eagerly here would report success on a command the device never
         * received. That is the worst shape of failure this whole file can
         * have, and it is invisible: no error, no reply expected, nothing to
         * notice. `end()`'s callback fires once the stream has flushed and
         * finished, which is the earliest moment it is safe.
         */
        socket.end(() => finish(null, []));
        return;
      }

      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error(
        `no reply within ${REPLY_TIMEOUT_MS}ms — the path may not exist on this firmware`
      )), REPLY_TIMEOUT_MS);
      if (timer.unref) timer.unref();
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      /* Frames are split across reads: one reply may straddle a chunk boundary
         and several may share one, so the buffer carries between events rather
         than being parsed per chunk. */
      let i;
      while ((i = buffer.indexOf(EOT)) !== -1) {
        const frame = buffer.subarray(0, i);
        buffer = buffer.subarray(i + 1);
        if (frame.length === 0) continue;
        try {
          const parsed = JSON.parse(frame.toString('utf8'));
          replies.push({ path: String(parsed.path ?? ''), value: parsed.value ?? null });
        } catch {
          /* Not JSON. The device does not send anything else on this socket,
             so this is a framing problem rather than a message to report —
             dropping it and carrying on is better than failing the exchange. */
        }
        if (replies.length >= expected) return finish(null, replies);
      }
    });
  });
}
