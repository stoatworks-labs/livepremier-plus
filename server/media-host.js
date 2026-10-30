/*
 * The media host's supervisor — the app's end of `devices/media-host.js`.
 *
 * The media host sends pictures out as NDI (`devices/README.md`, "The media
 * host"). This starts it with `fork`, restarts it when it dies, and offers it
 * to plugins as the `media` service: a plugin says which feeds it wants and
 * hands over a picture for one when it has something to show. It never sees
 * the process, and its feeds are made again whenever the host restarts.
 *
 * Shaped like `device-host.js` and kept apart from it: the device host's
 * channel carries JSON a few bytes at a time, this one pictures
 * (`serialization: 'advanced'`), and a runtime that falls over must not take
 * the USB panels with it.
 *
 * ## When it is not there
 *
 * No `devices/node_modules` (a bare checkout, CI, the Docker image — which is
 * the point: NDI's licence keeps it to the desktop app), or `--no-media`:
 * nothing is started, the service still answers, and `status()` says why.
 */

import { fork as nodeFork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

const RESTART_MIN_MS = 1000;
const RESTART_MAX_MS = 30_000;
const STABLE_MS = 30_000;
const STOP_MS = 2000;

/** Where the host is, and whether it is installed there. */
export function findMediaHost(root) {
  const entry = join(root, 'devices', 'media-host.js');
  if (!existsSync(entry)) return { entry: null, installed: false, reason: 'This build has no media host.' };
  if (!existsSync(join(root, 'devices', 'node_modules', 'koffi', 'package.json'))) {
    return { entry, installed: false, reason: 'The media host is not installed (npm run setup:devices).' };
  }
  return { entry, installed: true, reason: null };
}

/**
 * @param o.entry      devices/media-host.js, or null
 * @param o.installed  false: never started, and `reason` says why
 * @param o.args       extra arguments for the host (the tests' `--ndi`)
 * @param o.fork       child_process.fork, replaced in tests
 */
export function createMediaHost({
  entry, installed = true, reason = null, args = [], log = () => {},
  fork = nodeFork, restartMinMs = RESTART_MIN_MS, restartMaxMs = RESTART_MAX_MS,
} = {}) {
  const events = new EventEmitter();
  const owners = new Map();          // owner -> Map(id -> name)
  const reported = new Map();        // full id -> what the host last said of the feed
  const sending = new Set();         // full ids with a frame on its way to the host
  const status = {
    installed: !!(installed && entry),
    running: false,
    available: null,                 // whether the NDI runtime loaded, once the host has said
    reason: installed && entry ? null : (reason || 'The media host is not installed.'),
    runtime: null,
    restarts: 0,
    lastExit: null,
  };

  let child = null;
  let stopping = false;
  let restartTimer = null;
  let backoff = restartMinMs;
  let startedAt = 0;

  const changed = () => events.emit('status', api.status());
  const fullId = (owner, id) => `${owner}/${id}`;

  function pushFeeds() {
    if (!child || !child.connected) return;
    const feeds = [];
    for (const [owner, list] of owners) for (const [id, name] of list) feeds.push({ id: fullId(owner, id), name });
    try { child.send({ op: 'feeds', feeds }); } catch { /* exiting; it is told again on restart */ }
  }

  function start() {
    if (!status.installed || child || stopping) return;
    startedAt = Date.now();
    try {
      child = fork(entry, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [], serialization: 'advanced' });
    } catch (err) {
      status.reason = `The media host could not start: ${err.message}`;
      changed();
      return scheduleRestart();
    }
    const lines = (stream) => {
      let rest = '';
      stream?.setEncoding?.('utf8');
      stream?.on?.('data', (chunk) => {
        const parts = (rest + chunk).split('\n');
        rest = parts.pop();
        for (const line of parts) if (line.trim()) log(`media: ${line}`);
      });
    };
    lines(child.stdout);
    lines(child.stderr);
    child.on('message', onMessage);
    child.on('error', (err) => log(`media: ${err.message}`));
    child.on('exit', (code, signal) => onExit(code, signal));
    status.running = true;
    changed();
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') {
      status.available = !!msg.available;
      status.reason = msg.available ? null : (msg.reason || 'The NDI runtime did not load.');
      status.runtime = msg.runtime || null;
      log(`media: host up — ${msg.available ? `NDI ${status.runtime?.version || ''}`.trim() : status.reason}`);
      pushFeeds();
      changed();
    } else if (msg.type === 'feeds') {
      reported.clear();
      for (const f of msg.feeds || []) reported.set(f.id, f);
      changed();
    } else if (msg.type === 'log') {
      log(`media: ${msg.text}`);
    }
  }

  function onExit(code, signal) {
    child = null;
    status.running = false;
    status.lastExit = { code, signal, at: Date.now() };
    reported.clear();
    sending.clear();
    if (stopping) { changed(); return; }
    log(`media: host exited (${signal || `code ${code}`})`);
    status.reason = 'The media host stopped; restarting it.';
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

  async function stop() {
    stopping = true;
    clearTimeout(restartTimer);
    const c = child;
    if (!c) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, STOP_MS);
      timer.unref?.();
      c.once('exit', () => { clearTimeout(timer); resolve(); });
      /* Closing the channel is the host's cue to drop its feeds and exit. */
      try { c.disconnect(); } catch { try { c.kill('SIGTERM'); } catch { /* gone */ } }
    });
  }

  /** What one owner's feeds look like now, by its own ids. */
  function feedsOf(owner) {
    const list = owners.get(owner) || new Map();
    return [...list].map(([id, name]) => {
      const r = reported.get(fullId(owner, id));
      return {
        id, name,
        fullName: r?.fullName ?? null,
        connections: r?.connections ?? 0,
        frames: r?.frames ?? 0,
        error: r ? r.error : (status.available === false ? status.reason : null),
      };
    });
  }

  /** What plugins get, as the `media` service. */
  const api = Object.freeze({
    status: () => ({
      ...status,
      pid: child ? child.pid ?? null : null,
      feeds: [...owners.keys()].flatMap((owner) => feedsOf(owner).map((f) => ({ owner, ...f }))),
    }),
    onStatus(fn) { events.on('status', fn); return () => events.off('status', fn); },
    /** One plugin's end of it, by the plugin's id. Its feeds are its own; another's are untouched. */
    client(owner) {
      const key = String(owner);
      return Object.freeze({
        /** The host is up and NDI loaded. */
        get available() { return status.running && status.available === true; },
        get reason() { return status.available === true ? null : status.reason; },
        /** The feeds this plugin wants, `[{id, name}]`; any it had and has not listed are dropped. */
        setFeeds(list) {
          const next = new Map((list || []).map((f) => [String(f.id), String(f.name)]));
          const prev = owners.get(key) || new Map();
          if (next.size === prev.size && [...next].every(([id, name]) => prev.get(id) === name)) return;
          if (next.size) owners.set(key, next); else owners.delete(key);
          pushFeeds();
          changed();
        },
        feeds: () => feedsOf(key),
        /**
         * A picture for one feed: a scene for `src/core/raster.js`'s `render`
         * and the images it names. Dropped, not queued, while the last one for
         * the same feed is still on its way: a picture late is a picture wrong.
         */
        frame(id, scene, images = {}) {
          const fid = fullId(key, String(id));
          if (!child || !child.connected || !owners.get(key)?.has(String(id)) || sending.has(fid)) return false;
          sending.add(fid);
          try {
            child.send({ op: 'frame', id: fid, scene, images }, () => sending.delete(fid));
            return true;
          } catch {
            sending.delete(fid);
            return false;
          }
        },
        onChange(fn) { events.on('status', fn); return () => events.off('status', fn); },
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

/** The service when no host was made at all: answers like one that is not installed. */
export function absentMedia(reason = 'No media host in this process.') {
  return createMediaHost({ entry: null, installed: false, reason }).api;
}
