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
 * address on purpose. TCP only — every protocol here that reaches a
 * switcher, a router, a deck, a console or a Companion is TCP (Dante's ARC is
 * UDP, and its tests never leave a pretend network).
 *
 * The live suites (`test/sim/`, `test/console/`) reach a simulator on
 * purpose and do not load this.
 */

import net from 'node:net';

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
  [10001, 'a Lightware router (LW2)']
]);

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

  process.on('exit', () => {
    if (!attempts.length) return;
    for (const a of attempts) {
      process.stderr.write(`\n✖ a test dialled ${a.host}:${a.port}, ${a.whose}. Refused.\n${a.stack}\n`);
    }
    process.exitCode = 1;
  });

  return attempts;
}
