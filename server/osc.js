/*
 * OSC in, over UDP.
 *
 * The reason this lives in the server and not in a panel is not a preference:
 * **there is no UDP in any browser**, by any route, and there never has been.
 * The MIDI mapping escaped the same trap because serving from loopback makes
 * the page a secure context and Web MIDI then works directly. Nothing does
 * that for UDP. So a show-control input has to be a process, and this process
 * is already the local host the control-surface tooling assumes.
 *
 * ```text
 *   QLab / TouchOSC / Companion / a lighting desk
 *        │  UDP :8000
 *        ▼
 *   this file  ──decode──▶ mynah's OSC resolver ──▶ store paths
 *        │                       (../src/core/osc-dictionary.js widens it)
 *        ▼  AWJ, TCP 10606
 *   the switcher
 * ```
 *
 * ## Why it writes over AWJ rather than through a browser tab
 *
 * The whole point of an OSC input is that it works when nobody is looking at
 * it. A cue fires at 20:03 whether or not an operator happens to have a Web
 * RCS tab open, so routing through a page would make the feature conditional
 * on something nobody would think to check. AWJ is the vendor's own control
 * protocol, it needs no browser, and `awj.js` explains why a write-only,
 * connection-per-exchange AWJ path does not violate the single-source-of-truth
 * rule the store mirror depends on.
 *
 * **This means the device's AWJ port has to be on.** It can be switched off in
 * the Web RCS security settings, and when it is, every OSC message fails with
 * the same connection error. Worth checking first.
 *
 * ## Off by default, and bound to loopback unless told otherwise
 *
 * An open UDP port that fires takes on a video switcher is not something to
 * turn on for someone. It is off until enabled in Settings, and the address it
 * binds is a deliberate choice there too: `127.0.0.1` accepts only what is on
 * this machine, and anything else is the operator saying they want the network
 * to be able to drive the switcher. The setting says so in as many words.
 *
 * ## No replies, and no bundles going out
 *
 * This receives; it does not answer. OSC has no acknowledgement in the shape
 * anything here would use, the device does not acknowledge a write either, and
 * a reply to a spoofable UDP packet is a way of telling an unknown host that
 * something is listening. Incoming bundles *are* unpacked, because senders
 * emit them routinely.
 */

import dgram from 'node:dgram';

import { resolveOsc } from '../src/vendor/mynah-lang.mjs';
import { PARAMS } from '../src/core/osc-dictionary.js';
import { exchange, AWJ_PORT } from './awj.js';

export const DEFAULT_OSC_PORT = 8000;

/* ------------------------------------------------------------------ decode */

/** OSC pads every string and blob to a multiple of four bytes. */
const pad = (n) => (n + 3) & ~3;

function readString(buf, at) {
  let end = at;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) throw new Error('unterminated string');
  return { value: buf.toString('utf8', at, end), next: at + pad(end - at + 1) };
}

/**
 * Decode one OSC packet into a flat list of messages.
 *
 * Bundles are flattened rather than preserved. Their timetags are dropped on
 * purpose: honouring one would mean holding a take until a clock this process
 * does not share says so, and a video cue that fires late because two machines
 * disagree about the time is a worse failure than one that fires now. Senders
 * that need timing have a cue stack of their own.
 */
export function decode(buf) {
  if (buf.length < 4) throw new Error('too short to be OSC');

  if (buf.toString('utf8', 0, 7) === '#bundle') {
    const out = [];
    let at = 16; /* '#bundle\0' is 8, the timetag another 8 */
    while (at + 4 <= buf.length) {
      const size = buf.readInt32BE(at);
      at += 4;
      if (size <= 0 || at + size > buf.length) break;
      /* An unreadable element must not lose the rest of the bundle. */
      try { out.push(...decode(buf.subarray(at, at + size))); } catch { /* skip */ }
      at += size;
    }
    return out;
  }

  const addr = readString(buf, 0);
  if (!addr.value.startsWith('/')) throw new Error('an OSC address starts with /');

  /* The type tag is optional in OSC 1.0, and some senders omit it for a
     message with no arguments. A missing one means exactly that. */
  if (addr.next >= buf.length) return [{ address: addr.value, args: [] }];

  const tags = readString(buf, addr.next);
  if (!tags.value.startsWith(',')) return [{ address: addr.value, args: [] }];

  const args = [];
  let at = tags.next;
  for (const tag of tags.value.slice(1)) {
    switch (tag) {
      case 'i': args.push(buf.readInt32BE(at)); at += 4; break;
      case 'f': args.push(buf.readFloatBE(at)); at += 4; break;
      case 'd': args.push(buf.readDoubleBE(at)); at += 8; break;
      /* int64 via BigInt, narrowed: no address in this dictionary takes a
         number a double cannot hold, and a BigInt downstream would break
         comparisons that read perfectly well. */
      case 'h': args.push(Number(buf.readBigInt64BE(at))); at += 8; break;
      case 's':
      case 'S': { const s = readString(buf, at); args.push(s.value); at = s.next; break; }
      case 'b': { const n = buf.readInt32BE(at); args.push(buf.subarray(at + 4, at + 4 + n)); at += 4 + pad(n); break; }
      case 'T': args.push(true); break;
      case 'F': args.push(false); break;
      case 'N': args.push(null); break;
      /* Impulse — a bang with no value. Read as a press, which is what a
         sender emitting one means by it. */
      case 'I': args.push(1); break;
      default: throw new Error(`unsupported OSC type tag "${tag}"`);
    }
  }
  return [{ address: addr.value, args }];
}

/* ------------------------------------------------------------------- server */

/**
 * Listen for OSC and drive a switcher with it.
 *
 * @param {object} opts
 * @param {number} [opts.port]        UDP port to bind
 * @param {string} [opts.address]     interface to bind. Loopback by default.
 * @param {() => string|null} opts.deviceHost  the current switcher, read per
 *   message rather than captured — the operator can re-point at a backup frame
 *   without restarting anything, and an OSC input that kept driving the old box
 *   afterwards would be the worst possible version of that feature.
 * @param {(entry: object) => void} [opts.onActivity]  every message and what
 *   became of it, for the console log
 * @param {(msg: string) => void} [opts.log]
 */
export function createOscServer({
  port = DEFAULT_OSC_PORT,
  address = '127.0.0.1',
  deviceHost,
  onActivity = () => {},
  log = () => {},
}) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const state = { listening: false, port, address, received: 0, sent: 0, failed: 0, lastError: null };

  socket.on('error', (err) => {
    state.lastError = err.message;
    log(`OSC: ${err.message}`);
    /* A bind failure leaves the socket unusable. Reported through state rather
       than thrown, because it happens asynchronously after `start()` returned
       and there is nobody left holding a promise to reject. */
    try { socket.close(); } catch { /* already gone */ }
    state.listening = false;
  });

  socket.on('message', (packet, rinfo) => {
    state.received++;
    const from = `${rinfo.address}:${rinfo.port}`;

    let messages;
    try {
      messages = decode(packet);
    } catch (err) {
      state.failed++;
      return note({ from, address: '(undecodable)', error: err.message });
    }

    for (const msg of messages) void handle(msg, from);
  });

  async function handle(msg, from) {
    /*
     * Resolved from the decoded message, never from a rendered line.
     *
     * `resolveOsc` takes an address and already-typed arguments, which is what
     * came off the wire. Rendering the message back to text and re-parsing it
     * would lose exactly the things OSC bothers to type — a float that happens
     * to be whole would come back an int, and a string argument with a space
     * in it would come back as two arguments. A memory label is a string with
     * spaces in it.
     *
     * No `buffer` fact is supplied, so `preview` and `program` are refused
     * with their own explanation rather than guessed at. That is the right
     * answer and not a gap: this process holds no store mirror, the take state
     * is device state, and a fader that landed in whichever buffer happened to
     * be live would be the exact failure rule 5 exists to prevent. A sender
     * that wants a live layer addresses the buffer — /a, /b, /c.
     */
    const resolved = resolveOsc(msg, { params: PARAMS });

    if (!resolved.ok) {
      state.failed++;
      return note({ from, address: msg.address, args: msg.args, error: resolved.errors[0].message });
    }

    if (resolved.ops.length === 0) {
      /* A button release. Logged rather than dropped, so a surface sending
         something correctly ignored still shows up when someone is wondering
         why nothing happened. */
      return note({ from, address: msg.address, args: msg.args, summary: resolved.summary, writes: 0 });
    }

    const host = deviceHost();
    if (!host) {
      state.failed++;
      return note({ from, address: msg.address, args: msg.args, error: 'no switcher configured' });
    }

    try {
      await exchange({
        host,
        messages: resolved.ops.map((op) => ({ op: 'replace', path: op.path.toAwj(), value: op.value })),
      });
      state.sent += resolved.ops.length;
      note({
        from,
        address: msg.address,
        args: msg.args,
        summary: resolved.summary,
        writes: resolved.ops.length,
        paths: resolved.ops.map((op) => op.path.toAwj()),
      });
    } catch (err) {
      state.failed++;
      note({ from, address: msg.address, args: msg.args, error: err.message });
    }
  }

  function note(entry) {
    const full = { at: Date.now(), ...entry };
    if (entry.error) log(`OSC ${entry.address} from ${entry.from}: ${entry.error}`);
    try { onActivity(full); } catch { /* a listener must not take the socket down */ }
  }

  return {
    state,

    start() {
      return new Promise((resolve) => {
        socket.bind(port, address, () => {
          state.listening = true;
          state.lastError = null;
          /* The bound port, not the requested one. They differ when 0 was
             asked for, and the settings page prints this — a page saying
             "listening on :0" would be worse than saying nothing. */
          const bound = socket.address();
          state.port = bound.port;
          state.address = bound.address;
          log(`OSC listening on ${state.address}:${state.port} — writes go out over AWJ on ${AWJ_PORT}`);
          resolve(state);
        });
      });
    },

    stop() {
      return new Promise((resolve) => {
        if (!state.listening) return resolve();
        state.listening = false;
        socket.close(() => resolve());
      });
    },
  };
}

const fmt = (v) => (typeof v === 'string' ? v : Buffer.isBuffer(v) ? `<${v.length}B>` : String(v));
