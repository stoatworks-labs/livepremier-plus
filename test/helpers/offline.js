/*
 * The offline suite may not reach a switcher — preloaded into every file
 * `npm test` runs (`node --import ./test/helpers/offline.js --test …`).
 *
 * Found 2026-10-17: `a UDP take reaches the switcher as an AWJ write` in
 * `osc.test.js` stood a pretend device up on a spare port and never told the
 * listener where it was, so the listener asked 127.0.0.1:10606 — the real AWJ
 * port. With nothing there it failed, which the test accepted. With a
 * LivePremier Simulator running on the same Mac, the simulator answered and
 * S1 took: one unexplained TAKE about a second after every `npm test`, by
 * any session, for as long as the test had been there (docs/NOTES.md,
 * 2026-10-17). Nothing in the suite noticed, because nothing about a
 * connection that succeeds where it was expected to fail is an error.
 *
 * So a connection from a test to a port that real kit this app drives
 * listens on — on any host — is refused before it is made, and the file
 * fails, printing the stack that dialled. A pretend device belongs on port
 * 0; a device that is not there belongs on port 1, as `exchange`'s own test
 * has it. Ports, not hosts: `local-client.test.js` dials this machine's own LAN
 * address on purpose. Every protocol here that reaches a switcher, a router,
 * a deck, a console or a Companion is TCP (Dante's ARC is UDP, and its tests
 * never leave a pretend network).
 *
 * **UDP too, since Triggers.** It sends OSC, Art-Net and sACN, and a datagram
 * needs no answer to land: an Art-Net test that went to port 6454 on the LAN,
 * or an sACN one to its multicast group, would set real lights. So a send to
 * a DMX port, to an sACN multicast group or to a sound desk's or QLab's OSC
 * port is refused the same way. A pretend receiver is a socket on port 0 at
 * 127.0.0.1.
 *
 * The live suites (`test/sim/`, `test/console/`) reach a simulator on
 * purpose and do not load this.
 */

import net from 'node:net';
import dgram from 'node:dgram';

/** Port → whose it is. The defaults in the drivers; a test must never dial one. */
export const KIT_PORTS = new Map([
  [80, 'Web RCS on a switcher'],
  [3000, 'Web RCS on a simulator'],
  [10606, 'AWJ on a switcher or simulator'],
  [9993, 'a HyperDeck'],
  [8000, 'a Companion, or a Turtle AV router'],
  [8088, 'a U5 mini’s UCenter'],
  [19999, 'UCenter on a U5 or U5 Pro'],
  [9990, 'a Videohub'],
  [6107, 'a Lightware router (LW3)'],
  [10001, 'a Lightware router (LW2)'],
  [51325, 'an Allen & Heath desk (MIDI over TCP)']
]);

/** UDP port → whose it is. A test must never send to one, on any host. */
export const KIT_UDP_PORTS = new Map([
  [6454, 'Art-Net'],
  [5568, 'sACN'],
  [10023, 'an X32 or M32'],
  [2223, 'a Wing'],
  [53000, 'QLab']
]);

/** sACN's multicast groups, 239.255.x.x: every receiver on the LAN hears them. */
const SACN_GROUP = /^239\.255\.\d+\.\d+$/;

const MARK = Symbol.for('livepremier-plus.offline');

/** Every refused attempt in this process: {host, port, whose, stack}. */
export const refused = globalThis[MARK] || (globalThis[MARK] = install());

function install() {
  const attempts = [];
  const connect = net.Socket.prototype.connect;

  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const opts = first && typeof first === 'object' ? first : null;
    const port = Number(opts ? opts.port : first);
    const whose = opts && opts.path ? null : KIT_PORTS.get(port);
    if (!whose) return connect.apply(this, args);

    const host = (opts ? opts.host : typeof args[1] === 'string' ? args[1] : null) || 'localhost';
    const err = new Error(`the offline suite refused ${host}:${port} (${whose}) — stand a pretend device up on port 0 and pass its port`);
    err.code = 'ECONNREFUSED';
    attempts.push({ host, port, whose, stack: new Error('dialled from').stack });
    process.nextTick(() => this.destroy(err));
    return this;
  };

  const send = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (msg, ...rest) {
    /* send(msg[, offset, length], port[, address][, callback]) */
    const long = typeof rest[0] === 'number' && typeof rest[1] === 'number' && typeof rest[2] === 'number';
    const port = Number(long ? rest[2] : rest[0]);
    const host = (long ? rest[3] : rest[1]);
    const address = typeof host === 'string' ? host : 'localhost';
    const whose = KIT_UDP_PORTS.get(port) || (SACN_GROUP.test(address) ? 'an sACN multicast group' : null);
    if (!whose) return send.call(this, msg, ...rest);
    const callback = rest.find((a) => typeof a === 'function');
    const err = new Error(`the offline suite refused UDP to ${address}:${port} (${whose}) — send to a socket on port 0 at 127.0.0.1`);
    attempts.push({ host: address, port, whose, stack: new Error('sent from').stack });
    if (callback) process.nextTick(() => callback(err));
  };

  process.on('exit', () => {
    if (!attempts.length) return;
    for (const a of attempts) {
      process.stderr.write(`\n✖ a test dialled ${a.host}:${a.port}, ${a.whose}. Refused.\n${a.stack}\n`);
    }
    process.exitCode = 1;
  });

  return attempts;
}
