/*
 * The device host's supervisor — the app's end of `devices/host.js`.
 *
 * The host is a program of its own that holds USB and HID devices
 * (`devices/README.md` says why). This starts it with `fork`, speaks to it
 * over the IPC channel that gives, restarts it when it dies, and offers it to
 * plugins as the `devices` service. A plugin never sees the process: it asks
 * for a module by id and gets a handle that outlives any number of restarts.
 *
 * ## It holds no state of the switcher's
 *
 * The host knows about panels, not about the switcher, and nothing it says
 * reaches the store mirror. A device's controls become switcher writes in the
 * page, where the mirror is, exactly as MIDI Mapping's do. So this is not the
 * second source of truth `server/awj.js` argues against: nothing else in the
 * app knows what a Speed Editor is doing.
 *
 * ## When it is not there
 *
 * `devices/node_modules` missing (a bare checkout, CI, the Docker image) or
 * `--no-devices`: nothing is started, the service still answers, and its
 * `status()` says why, so a page can tell the operator what to do rather than
 * showing a panel that never appears.
 */

import { fork as nodeFork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

const RESTART_MIN_MS = 1000;
const RESTART_MAX_MS = 30_000;
/* Up this long, and the next crash starts the backoff again from the bottom. */
const STABLE_MS = 30_000;
const REPLY_MS = 3000;
const STOP_MS = 2000;

/** Where the host is, and whether it is installed there. */
export function findDeviceHost(root) {
  const entry = join(root, 'devices', 'host.js');
  if (!existsSync(entry)) return { entry: null, installed: false, reason: 'This build has no device host.' };
  if (!existsSync(join(root, 'devices', 'node_modules', 'node-hid', 'package.json'))) {
    return { entry, installed: false, reason: 'The device host is not installed (npm run setup:devices).' };
  }
  return { entry, installed: true, reason: null };
}

/**
 * @param o.entry      devices/host.js, or null
 * @param o.installed  false: never started, and `reason` says why
 * @param o.args       extra arguments for the host (the tests' `--hid`)
 * @param o.fork       child_process.fork, replaced in tests
 */
export function createDeviceHost({
  entry, installed = true, reason = null, args = [], log = () => {},
  fork = nodeFork, restartMinMs = RESTART_MIN_MS, restartMaxMs = RESTART_MAX_MS,
} = {}) {
  const events = new EventEmitter();
  const modules = new Map();         // id -> { id, name, transport, state, wanted, events }
  const pending = new Map();         // reply id -> { resolve, reject, timer }
  const status = {
    installed: !!(installed && entry),
    running: false,
    available: null,                 // whether node-hid loaded, once the host has said
    reason: installed && entry ? null : (reason || 'The device host is not installed.'),
    restarts: 0,
    lastExit: null,
  };

  let child = null;
  let stopping = false;
  let restartTimer = null;
  let backoff = restartMinMs;
  let startedAt = 0;
  let nextId = 1;

  const changed = () => events.emit('status', api.status());

  function moduleEntry(id) {
    let m = modules.get(id);
    if (!m) {
      m = { id, name: id, transport: null, state: null, wanted: false, events: new EventEmitter() };
      modules.set(id, m);
    }
    return m;
  }

  function start() {
    if (!status.installed || child || stopping) return;
    startedAt = Date.now();
    try {
      child = fork(entry, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
    } catch (err) {
      status.reason = `The device host could not start: ${err.message}`;
      changed();
      return scheduleRestart();
    }
    const lines = (stream) => {
      let rest = '';
      stream?.setEncoding?.('utf8');
      stream?.on?.('data', (chunk) => {
        const parts = (rest + chunk).split('\n');
        rest = parts.pop();
        for (const line of parts) if (line.trim()) log(`devices: ${line}`);
      });
    };
    lines(child.stdout);
    lines(child.stderr);
    child.on('message', onMessage);
    child.on('error', (err) => log(`devices: ${err.message}`));
    child.on('exit', (code, signal) => onExit(code, signal));
    status.running = true;
    changed();
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') {
      status.available = !!msg.available;
      status.reason = msg.available ? null : (msg.reason || 'node-hid did not load');
      for (const info of msg.modules || []) {
        const m = moduleEntry(info.id);
        m.name = info.name || info.id;
        m.transport = info.transport ?? null;
        m.state = info.state ?? null;
        m.events.emit('state', m.state);
        /* A restarted host starts with nothing open: ask again for what was wanted. */
        if (m.wanted) void request('want', { module: m.id, wanted: true }).catch(() => {});
      }
      log(`devices: host up — ${[...modules.keys()].join(', ') || 'no modules'}${msg.available ? '' : ` (${status.reason})`}`);
      changed();
    } else if (msg.type === 'state') {
      const m = moduleEntry(msg.module);
      m.state = msg.state ?? null;
      m.events.emit('state', m.state);
    } else if (msg.type === 'report') {
      const m = modules.get(msg.module);
      if (m) m.events.emit('report', Uint8Array.from(Buffer.from(String(msg.data || ''), 'base64')));
    } else if (msg.type === 'log') {
      log(`devices: ${msg.text}`);
    } else if (msg.type === 'reply') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'the device host refused'));
    }
  }

  function onExit(code, signal) {
    child = null;
    status.running = false;
    status.lastExit = { code, signal, at: Date.now() };
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('the device host stopped')); pending.delete(id); }
    /* Nothing is open while it is down; say so rather than leave the last state standing. */
    for (const m of modules.values()) {
      if (m.state) { m.state = { ...m.state, connected: false, authed: false }; m.events.emit('state', m.state); }
    }
    if (stopping) { changed(); return; }
    log(`devices: host exited (${signal || `code ${code}`})`);
    status.reason = 'The device host stopped; restarting it.';
    changed();
    scheduleRestart();
  }

  function scheduleRestart() {
    if (stopping) return;
    if (Date.now() - startedAt > STABLE_MS) backoff = restartMinMs;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => { status.restarts++; start(); }, backoff);
    restartTimer.unref?.();
    backoff = Math.min(backoff * 2, restartMaxMs);
  }

  function request(op, body) {
    if (!child || !child.connected) return Promise.reject(new Error(status.reason || 'the device host is not running'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('the device host did not answer')); }, REPLY_MS);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try { child.send({ op, id, ...body }); } catch (err) { clearTimeout(timer); pending.delete(id); reject(err); }
    });
  }

  async function stop() {
    stopping = true;
    clearTimeout(restartTimer);
    const c = child;
    if (!c) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, STOP_MS);
      timer.unref?.();
      c.once('exit', () => { clearTimeout(timer); resolve(); });
      /* Closing the channel is the host's cue to let its devices go and exit. */
      try { c.disconnect(); } catch { try { c.kill('SIGTERM'); } catch { /* gone */ } }
    });
  }

  /** What plugins get, as the `devices` service. */
  const api = Object.freeze({
    status: () => ({
      ...status,
      modules: [...modules.values()].map((m) => ({ id: m.id, name: m.name, transport: m.transport, state: m.state, wanted: m.wanted })),
    }),
    onStatus(fn) { events.on('status', fn); return () => events.off('status', fn); },
    /** A handle on one module. It survives the host restarting. */
    module(id) {
      const m = moduleEntry(String(id));
      return Object.freeze({
        id: m.id,
        get state() { return m.state; },
        /** The host is up, node-hid loaded, and the host has this module. */
        get available() { return status.running && status.available === true && m.state !== null; },
        want(wanted) {
          m.wanted = !!wanted;
          return request('want', { module: m.id, wanted: m.wanted }).catch((err) => { if (m.wanted) log(`devices: ${m.id}: ${err.message}`); return null; });
        },
        write: (reports) => request('write', { module: m.id, reports }),
        on(event, fn) { m.events.on(event, fn); return () => m.events.off(event, fn); },
      });
    },
    restart() {
      if (!status.installed) return;
      stopping = false;
      backoff = restartMinMs;
      if (child) { try { child.kill('SIGTERM'); } catch { /* gone */ } return; }
      start();
    },
  });

  return { start, stop, api };
}

/**
 * The service when no host was made at all — the tests' proxies, and any
 * embedding that does not start one. Answers like a host that is not installed.
 */
export function absentDevices(reason = 'No device host in this process.') {
  return createDeviceHost({ entry: null, installed: false, reason }).api;
}
