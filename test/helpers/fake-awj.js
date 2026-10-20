/*
 * A pretend switcher on AWJ — one `{op, path, value}` JSON object per message,
 * terminated by 0x04, as `server/awj.js` speaks it — answering `get`s from a
 * store keyed by AWJ path and applying `replace`s to it.
 *
 * A path it does not have is answered the way the real one answers: an empty
 * path and a null value (seen on both simulators, 2026-09-12). It listens on
 * port 0, never on 10606: `helpers/offline.js` refuses that port.
 */

import net from 'node:net';

const EOT = 0x04;

/**
 * @param {Map<string, unknown>|object} initial  AWJ path → value
 * @param {object} [o]
 * @param {(path:string, value:unknown, store:Map) => void} [o.onReplace]  react to a write, as the device would
 */
export async function fakeAwj(initial = {}, { onReplace = null } = {}) {
  const store = new Map(initial instanceof Map ? initial : Object.entries(initial));
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let i;
      while ((i = buffer.indexOf(EOT)) !== -1) {
        const frame = buffer.subarray(0, i);
        buffer = buffer.subarray(i + 1);
        let msg;
        try { msg = JSON.parse(frame.toString('utf8')); } catch { continue; }
        received.push(msg);
        if (msg.op === 'replace') {
          store.set(msg.path, msg.value);
          onReplace?.(msg.path, msg.value, store);
          continue;
        }
        if (msg.op !== 'get') continue;
        const reply = store.has(msg.path) ? { path: msg.path, value: store.get(msg.path) } : { path: '', value: null };
        socket.write(Buffer.concat([Buffer.from(JSON.stringify(reply), 'utf8'), Buffer.from([EOT])]));
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    store,
    received,
    /** The `replace`s received, `{path, value}`, oldest first. */
    writes: () => received.filter((m) => m.op === 'replace').map(({ path, value }) => ({ path, value })),
    clear: () => { received.length = 0; },
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}
