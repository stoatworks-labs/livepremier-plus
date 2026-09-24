/*
 * The device host's core: its modules, and the messages it trades with
 * LivePremier Plus. No process, no channel, no node-hid of its own — `host.js`
 * hands it those — so the tests run it in-process against fakes.
 *
 * ## The messages
 *
 * Over Node's parent–child IPC channel (`process.send`), one object each:
 *
 * ```text
 *   host → app   { type: 'hello',  available, reason, modules: [{ id, name, transport, state }] }
 *                { type: 'state',  module, state }        whenever a driver's state changes
 *                { type: 'report', module, data }         an input report, base64
 *                { type: 'log',    text }
 *                { type: 'reply',  id, ok, result | error }
 *   app → host   { op: 'want',  id, module, wanted }      open it (a page drives it) or let it go
 *                { op: 'write', id, module, reports }     output reports, each a list of bytes
 * ```
 *
 * A driver is an EventEmitter with `start()`, `stop()`, `want(bool)`,
 * `write(bytes) -> Promise<bool>` and a `state` getter, emitting `state` and
 * `report` — `modules/speed-editor/driver.js` is the one there is.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ID = /^[a-z][a-z0-9-]*$/;
/* One report is a few bytes; a batch is a page's lamps changing at once. */
const MAX_REPORTS = 16;
const MAX_REPORT_BYTES = 64;

/** Every `modules/<id>/module.js`, in name order. A folder that is not one is skipped, loudly. */
export async function loadModules(dir, log = () => {}) {
  let names = [];
  try { names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
  catch { return []; }
  const out = [];
  for (const name of names) {
    try {
      const mod = (await import(pathToFileURL(join(dir, name, 'module.js')).href)).default;
      if (!mod || mod.id !== name || !ID.test(mod.id) || typeof mod.create !== 'function') {
        log(`modules/${name}: not a module (its id must be its folder's name, and it needs create())`);
        continue;
      }
      out.push(mod);
    } catch (err) {
      log(`modules/${name}: could not load: ${err.message}`);
    }
  }
  return out;
}

/**
 * @param o.hid      node-hid, or null when it could not be loaded
 * @param o.reason   why there is no node-hid, when there is none
 * @param o.modules  module definitions, `{ id, name, transport, create({ hid, log }) }`
 * @param o.send     fn(message) to the app
 */
export function createHostCore({ hid, reason = null, modules, send, log = () => {} }) {
  const drivers = new Map();
  if (hid) {
    for (const m of modules) {
      let driver;
      try {
        driver = m.create({ hid, log: (text) => log(`${m.id}: ${text}`) });
      } catch (err) {
        log(`${m.id}: could not start: ${err.message}`);
        continue;
      }
      driver.on('state', (state) => send({ type: 'state', module: m.id, state }));
      driver.on('report', (bytes) => send({ type: 'report', module: m.id, data: Buffer.from(bytes).toString('base64') }));
      drivers.set(m.id, driver);
      driver.start();
    }
  }

  send({
    type: 'hello',
    available: !!hid,
    reason: hid ? null : reason,
    modules: modules.map((m) => ({ id: m.id, name: m.name, transport: m.transport ?? null, state: drivers.get(m.id)?.state ?? null })),
  });

  const reply = (id, ok, body) => { if (id !== undefined) send({ type: 'reply', id, ok, ...body }); };

  async function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    const driver = drivers.get(msg.module);
    if (!driver) return reply(msg.id, false, { error: hid ? `no module ${msg.module}` : reason });
    try {
      if (msg.op === 'want') {
        await driver.want(!!msg.wanted);
        return reply(msg.id, true, { result: driver.state });
      }
      if (msg.op === 'write') {
        const reports = Array.isArray(msg.reports) ? msg.reports : [];
        if (reports.length > MAX_REPORTS) throw new Error(`at most ${MAX_REPORTS} reports`);
        let written = 0;
        for (const r of reports) {
          if (!Array.isArray(r) || !r.length || r.length > MAX_REPORT_BYTES || !r.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
            throw new Error('a report is a list of bytes, id first');
          }
          if (await driver.write(Uint8Array.from(r))) written++;
        }
        return reply(msg.id, true, { result: written });
      }
      return reply(msg.id, false, { error: `unknown op ${msg.op}` });
    } catch (err) {
      return reply(msg.id, false, { error: err.message });
    }
  }

  async function stop() {
    await Promise.all([...drivers.values()].map((d) => d.stop().catch(() => {})));
    drivers.clear();
  }

  return { handle, stop, drivers };
}
