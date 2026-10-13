/*
 * The live suite's harness: the real app, pointed at a running simulator.
 *
 * Everything in `test/` above this folder runs with no network. This folder is
 * the opposite: every test here boots the real server (`createProxy`, exactly
 * as `server/index.js` does) against a LivePremier **simulator** and drives it
 * through the doors a user's tools would — the proxied Web RCS socket, the
 * plugin routes, `/awj`, OSC over UDP — then checks the switcher by asking it
 * over AWJ, a path this app's own code is not on.
 *
 *   LPP_SIM=192.168.1.203:3000 npm run test:sim
 *
 * With `LPP_SIM` unset every test here skips, which is what CI sees.
 *
 * ## It refuses anything that is not a simulator
 *
 * These tests take, cut, recall memories, rename slots and write layer
 * properties. That is harmless on a simulator and a disaster on a frame that
 * is on air, so before anything is written the harness asks the device over
 * AWJ whether it is simulated (`deviceList/items/1/pp/isSimulated`) and stops
 * the whole file if it is not. There is no override, on purpose.
 *
 * ## It puts back what it changed
 *
 * The simulator is shared. Every write a test makes goes through a `Journal`,
 * which records the value it replaces *before* writing (the same rule the app
 * keeps), and `restore()` writes them back in reverse and waits for the
 * switcher to echo each one. Pulses (`x…` properties) are not journalled:
 * they are actions, not state, and a test that takes twice is the way to undo
 * a take.
 *
 * ## The mirror is the switcher's, never ours
 *
 * `Link` rides the vendor socket through the proxy, hydrates from the proxied
 * `/api/stores/device` and folds in **inbound** frames only. A write is not
 * applied when sent: the switcher echoes what it accepted, and a refused or
 * clamped value must never look applied — the rule `core/session.js` keeps.
 * The one exception the switcher makes is worth knowing: **writing the value
 * a path already holds is never echoed**, so a wait checks the current value
 * before it waits for a frame.
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProxy, splitDevice } from '../../server/proxy.js';
import { StackStore } from '../../server/storage.js';
import { WsClient } from '../../server/ws-client.js';
import { exchange, AWJ_PORT } from '../../server/awj.js';
import { DeviceStore } from '../../src/core/device-store.js';
import { toAwj, key, samePath } from '../../src/core/paths.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `host[:port]` of the simulator's Web RCS, or '' when the suite is off. */
export const SIM = (process.env.LPP_SIM || '').trim();

/**
 * Pass as `{ skip }` to every test, so an unset `LPP_SIM` reads as a skip with
 * a reason rather than a pass.
 */
export const SKIP = SIM ? false : 'LPP_SIM is not set (e.g. LPP_SIM=192.168.1.203:3000)';

export const target = SIM ? splitDevice(SIM, 80) : null;
if (SIM && !target) throw new Error(`LPP_SIM is not a host[:port]: ${SIM}`);

/** AWJ always lives on the switcher's own address; the port can be moved. */
export const AWJ = target
  ? { host: target.host, port: Number(process.env.LPP_SIM_AWJ_PORT || AWJ_PORT) }
  : null;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * AWJ, as an independent witness
 * ------------------------------------------------------------------ */

/**
 * Read store paths straight off the switcher over AWJ.
 *
 * One exchange, one socket, closed after — the device's five-client budget is
 * shared with everything else on the simulator.
 *
 * @param {string[][]} paths  store paths (`['device', …]`)
 * @returns {Promise<any[]>}  values in the same order
 */
export async function awjGetAll(paths) {
  const replies = await exchange({
    ...AWJ,
    messages: paths.map((p) => ({ op: 'get', path: toAwj(p) }))
  });
  /* Replies carry their path, so match on it rather than trusting order. */
  return paths.map((p) => {
    const want = toAwj(p);
    const hit = replies.find((r) => r.path === want);
    return hit ? hit.value : undefined;
  });
}

export async function awjGet(path) {
  return (await awjGetAll([path]))[0];
}

/** Write over AWJ, as an outside client would. */
export async function awjReplace(path, value) {
  await exchange({ ...AWJ, messages: [{ op: 'replace', path: toAwj(path), value }] });
}

/**
 * Stop the file unless the device says it is a simulator.
 *
 * Called by `startApp` before the app is pointed anywhere, so a typo in
 * `LPP_SIM` that lands on a real frame fails here with nothing written.
 */
export async function assertSimulator() {
  const [simulated, model] = await awjGetAll([
    ['device', 'system', 'deviceList', 'items', '1', 'pp', 'isSimulated'],
    ['device', 'system', 'deviceList', 'items', '1', 'pp', 'dev']
  ]);
  if (simulated !== true) {
    throw new Error(
      `${SIM} does not say it is a simulator (isSimulated = ${JSON.stringify(simulated)}, ` +
      `dev = ${JSON.stringify(model)}). The live suite writes to the switcher, so it refuses.`);
  }
  return { model };
}

/* ------------------------------------------------------------------ *
 * The app
 * ------------------------------------------------------------------ */

/**
 * Boot the real app against the simulator, on an ephemeral loopback port with
 * a throwaway data directory.
 *
 * @param {object} [opts]
 * @param {object} [opts.settings]  written as `settings.json` before start, so
 *                                  plugins are switched on the way a user's
 *                                  saved settings would switch them on
 * @param {(dir:string)=>Promise<void>} [opts.prepare]  seed the data directory
 * @param {object} [opts.devices]  a device host's `api` — a fake USB panel's, say
 */
export async function startApp({ settings = null, prepare = null, pluginDir, devices } = {}) {
  await assertSimulator();

  const dir = await mkdtemp(join(tmpdir(), 'lpp-sim-'));
  const storage = new StackStore(dir);
  if (settings) await storage.saveSettings(settings);
  if (prepare) await prepare(dir);

  const logs = [];
  const appVersion = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
  const server = await createProxy({
    device: SIM,
    root: ROOT,
    storage,
    appVersion,
    log: (msg) => logs.push(msg),
    ...(pluginDir !== undefined ? { pluginDir } : {}),
    ...(devices ? { devices } : {})
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  /** A JSON call to one of the app's own routes (`/__lpp/…`). */
  async function api(path, { method = 'GET', body, raw = false } = {}) {
    const res = await fetch(base + '/__lpp' + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
    });
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  /** Merge a settings patch, the way the settings page saves one. */
  async function configure(patch) {
    const r = await api('/settings', { method: 'PUT', body: { settings: patch } });
    if (r.status !== 200) throw new Error(`settings PUT ${r.status}: ${r.text}`);
    return r.json.settings;
  }

  async function close() {
    try { await server.closeRelays(); } catch { /* best effort */ }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }

  return { server, port, base, dir, storage, logs, api, configure, close };
}

/* ------------------------------------------------------------------ *
 * The vendor socket, through the proxy
 * ------------------------------------------------------------------ */

/**
 * One Web RCS session's worth of mirror, in Node.
 *
 * This is what the page does — `core/session.js` over `page-socket.js` — with
 * a real WebSocket in place of the hook: it rides the proxied socket and
 * hydrates from the proxied snapshot, taking the stream marker before the
 * fetch is issued.
 */
export class Link {
  /**
   * @param {object} app  from `startApp`
   * @returns {Promise<Link>}
   */
  static async open(app) {
    const link = new Link(app);
    await link._open();
    return link;
  }

  constructor(app) {
    this.app = app;
    this.store = new DeviceStore();
    this.frames = [];
    this.seq = 0;
    this.remote = [];
    this.ws = null;
    this.listeners = new Set();
    /* Every trigger seen to fire, with what it read before — see `rearm`. */
    this.fired = new Map();
  }

  async _open() {
    this.ws = new WsClient({ host: '127.0.0.1', port: this.app.port, path: '/' });
    this.ws.on('message', (text) => this._onMessage(text));
    this.ws.on('error', () => { /* surfaced through waits that time out */ });
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });

    const mark = this.mark();
    const res = await fetch(this.app.base + '/api/stores/device', { headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
    this.store.hydrate(await res.json());
    for (const f of this.frames) if (f.seq >= mark) this.store.set(f.path, f.value);
  }

  _onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.channel === 'REMOTE') { this.remote.push(msg.data); return; }
    if (msg.channel !== 'DEVICE') return;
    const data = msg.data;
    if (!data || !Array.isArray(data.path) || data.value === undefined) return;
    const frame = { seq: ++this.seq, path: data.path, value: data.value, dir: 'in', at: Date.now() };
    this.frames.push(frame);
    /* A long run produces a lot of timer frames; the waits only look back a
       little way. */
    if (this.frames.length > 50000) this.frames.splice(0, 10000);
    if (this.store.ready) {
      this._noteTrigger(frame.path);
      this.store.set(frame.path, frame.value);
    }
    this._emit(frame);
  }

  /**
   * Hear every frame, inbound and outbound, the way the page's engines do —
   * `page-socket.js` tags each `dir: 'in'` or `'out'`, and the gang, the lock
   * follower and the preview guard tell the two apart. Returns an unsubscribe.
   */
  onFrame(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(frame) {
    for (const fn of [...this.listeners]) {
      try { fn(frame); } catch (err) { console.error('frame listener threw', err); }
    }
  }

  /** `{store, send}` — the shape `core/` takes for a session. */
  get session() {
    return { store: this.store, send: (cmd) => { this.send(cmd); return true; } };
  }

  _noteTrigger(path) {
    if (!isPulse(path)) return;
    const k = key(path);
    if (!this.fired.has(k)) this.fired.set(k, { path, before: this.store.get(path) });
  }

  /**
   * Put fired triggers back to false.
   *
   * The switcher leaves an `x…` trigger reading true once it has fired, and a
   * journal does not keep pulses. Writing false is the arm half of a pulse and
   * does nothing else (watched on the take, cut, recall, save, delete, EDID
   * and preconfig triggers), so every trigger that read false before this
   * link saw it fire — fired by the test, by the app on its behalf, or over
   * OSC — is written false again, and the switcher is left as it was found.
   */
  async rearm({ timeout = 3000 } = {}) {
    const cmds = [...this.fired.values()]
      .filter((f) => f.before === false && this.get(f.path) === true)
      .map((f) => ({ path: f.path, value: false }));
    this.send(cmds);
    for (const c of cmds) await this.waitFor(c.path, false, { timeout }).catch(() => {});
    this.fired.clear();
    return cmds.length;
  }

  /** The sequence number the next inbound frame will carry. */
  mark() { return this.seq + 1; }

  /** Inbound frames at or after `mark`, optionally under a path prefix. */
  since(mark, prefix = null) {
    return this.frames.filter((f) => f.seq >= mark &&
      (!prefix || (prefix.length <= f.path.length && prefix.every((s, i) => s === f.path[i]))));
  }

  get(path) { return this.store.get(path); }

  /** Write one or more `{path, value}` commands on the vendor socket. */
  send(cmds) {
    for (const c of [].concat(cmds)) {
      if (!c || !Array.isArray(c.path)) throw new Error('not a command: ' + JSON.stringify(c));
      if (this.store.ready) this._noteTrigger(c.path);
      this.ws.send(JSON.stringify({ channel: 'DEVICE', data: { path: c.path, value: c.value } }));
      this._emit({ seq: null, path: c.path, value: c.value, dir: 'out', at: Date.now() });
    }
  }

  /**
   * Resolve once the mirror's value at `path` satisfies `pred`.
   *
   * Checks the current value first: a write of the value a path already holds
   * is never echoed, so waiting for a frame there would wait forever.
   */
  waitFor(path, pred, { timeout = 5000, label } = {}) {
    const test = typeof pred === 'function' ? pred : (v) => deepEqual(v, pred);
    if (test(this.get(path))) return Promise.resolve(this.get(path));
    return new Promise((resolve, reject) => {
      let unsub = null;
      const timer = setTimeout(() => {
        unsub && unsub();
        reject(new Error(`timed out after ${timeout} ms waiting for ${label || key(path)}; ` +
          `it reads ${JSON.stringify(this.get(path))}`));
      }, timeout);
      unsub = this.store.subscribe(path, () => {
        const v = this.get(path);
        if (test(v)) { clearTimeout(timer); unsub(); resolve(v); }
      }, { immediate: false });
    });
  }

  /** Resolve on the first inbound frame for exactly `path` at or after `mark`. */
  waitFrame(path, { mark = this.mark(), pred = () => true, timeout = 5000 } = {}) {
    const hit = () => this.frames.find((f) => f.seq >= mark && samePath(f.path, path) && pred(f.value));
    const found = hit();
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        const f = hit();
        if (f) { clearInterval(tick); resolve(f); }
        else if (Date.now() - t0 > timeout) {
          clearInterval(tick);
          reject(new Error(`no frame for ${key(path)} within ${timeout} ms`));
        }
      }, 10);
    });
  }

  /** Item keys of a collection, as the device orders them. */
  keys(path) { return this.store.itemKeys(path); }

  close() {
    try { this.ws.close(); } catch { /* already gone */ }
  }
}

/* ------------------------------------------------------------------ *
 * Putting things back
 * ------------------------------------------------------------------ */

/**
 * Record before you write; write back in reverse.
 *
 * `write` journals the path's current value (once — the first value seen is
 * the one to go back to) and sends. `remember` journals without sending, for
 * paths something else is about to change: the app's own routes, OSC, a cue.
 */
export class Journal {
  constructor(link) {
    this.link = link;
    this.entries = new Map();
  }

  remember(path) {
    const k = key(path);
    if (this.entries.has(k)) return;
    const value = this.link.get(path);
    if (value === undefined) throw new Error(`cannot journal ${k}: the mirror has no value there`);
    this.entries.set(k, { path, value: structuredClone(value) });
  }

  write(cmds) {
    for (const c of [].concat(cmds)) {
      if (!isPulse(c.path)) this.remember(c.path);
    }
    this.link.send(cmds);
  }

  /** Put every journalled path back, newest first; report what would not go. */
  async restore({ timeout = 4000 } = {}) {
    const failed = [];
    const entries = [...this.entries.values()].reverse();
    for (const { path, value } of entries) {
      if (deepEqual(this.link.get(path), value)) continue;
      this.link.send({ path, value });
    }
    for (const { path, value } of entries) {
      try { await this.link.waitFor(path, value, { timeout }); }
      catch (err) { failed.push(`${key(path)}: ${err.message}`); }
    }
    this.entries.clear();
    if (failed.length) throw new Error('could not restore:\n  ' + failed.join('\n  '));
  }
}

/** A pulse is an action (`xTake`, `xRequest`, …) rather than state to restore. */
export const isPulse = (path) => /^x[A-Z]/.test(String(path[path.length - 1]));

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

/* ------------------------------------------------------------------ *
 * The simulator's screen S1, which is the one it has in use
 * ------------------------------------------------------------------ */

export const sag = (id, side, prop) =>
  ['device', 'screenAuxGroupList', 'items', id, side, 'pp', prop];

/**
 * Which of a screen's two buffers is on program right now.
 *
 * The switcher has no fixed program and preview: a take moves the screen from
 * `AT_DOWN` to `AT_UP` and back, and the buffer the screen is AT is program.
 * So "program" is `DOWN` while it reads `AT_DOWN`.
 */
export function programSide(link, id = 'S1') {
  const t = link.get(sag(id, 'status', 'transition'));
  if (t === 'AT_DOWN') return { program: 'DOWN', preview: 'UP' };
  if (t === 'AT_UP') return { program: 'UP', preview: 'DOWN' };
  throw new Error(`${id} is mid-transition (${t})`);
}

/** Wait for a screen to finish any transition, then report where it sits. */
export async function settled(link, id = 'S1', timeout = 15000) {
  await link.waitFor(sag(id, 'status', 'transition'), (v) => v === 'AT_UP' || v === 'AT_DOWN',
    { timeout, label: `${id} to settle` });
  return link.get(sag(id, 'status', 'transition'));
}

/** Take a screen and wait for the transition to land. */
export async function take(link, id = 'S1', timeout = 15000) {
  const from = await settled(link, id, timeout);
  const to = from === 'AT_UP' ? 'AT_DOWN' : 'AT_UP';
  link.send({ path: sag(id, 'control', 'xTake'), value: true });
  await link.waitFor(sag(id, 'status', 'transition'), to, { timeout, label: `${id} to reach ${to}` });
  return to;
}

/** Restore a screen to the side it was on, taking once if it moved. */
export async function returnTo(link, id, side) {
  const now = await settled(link, id);
  if (now !== side) await take(link, id);
}

/* ------------------------------------------------------------------ *
 * A whole screen, kept and put back
 * ------------------------------------------------------------------ */

/**
 * Remember everything a test is about to disturb on one screen — which side
 * is program, both fade times, and every writable layer property in every
 * buffer — and put it back with the app's own `bufferWrites`, the function
 * `saveViaPreview` restores preview with.
 *
 * Memory recalls are why this exists: a recall rewrites a whole buffer and
 * the fade time with it, which no per-path journal sees coming.
 */
export async function guardScreen(link, id = 'S1') {
  const { dialectFor } = await import('../../src/core/dialect.js');
  const { bufferWrites } = await import('../../src/core/save-look.js');
  const side = await settled(link, id);
  const dialect = dialectFor(link.store);
  const letters = Object.keys(link.get(['device', 'screenList', 'items', id, 'presetList', 'items']) || {});
  const buffers = Object.fromEntries(letters.map((l) => [l, structuredClone(link.get(dialect.bufferPath(id, l)))]));
  const times = {
    up: link.get(sag(id, 'control', 'takeUpTime')),
    down: link.get(sag(id, 'control', 'takeDownTime'))
  };
  /* Whether each buffer reads as an unmodified memory. The switcher keeps it,
     nobody can write it, and a recall sets it — see `restore`. */
  const modifiedFlag = (l) => ['device', 'presetBank', 'status', 'presetId', 'screenList', 'items', id,
    'presetList', 'items', l, 'pp', 'isNotModified'];
  const flags = Object.fromEntries(letters.map((l) => [l, link.get(modifiedFlag(l))]));

  return {
    side,
    times,
    buffers,
    /** Put it all back, and say which properties would not go. */
    async restore({ timeout = 6000 } = {}) {
      await returnTo(link, id, side);
      const writes = [];
      for (const letter of letters) {
        writes.push(...bufferWrites({ store: link.store, id, buffer: letter, look: buffers[letter] }));
      }
      const changed = writes.filter((w) => !deepEqual(link.get(w.path), w.value));
      link.send(changed);
      link.send([
        { path: sag(id, 'control', 'takeUpTime'), value: times.up },
        { path: sag(id, 'control', 'takeDownTime'), value: times.down }
      ]);
      const failed = [];
      for (const w of [...changed,
        { path: sag(id, 'control', 'takeUpTime'), value: times.up },
        { path: sag(id, 'control', 'takeDownTime'), value: times.down }]) {
        try { await link.waitFor(w.path, w.value, { timeout }); }
        catch (err) { failed.push(err.message); }
      }
      /*
       * A buffer that read as modified before a recall reads as an unmodified
       * memory after it, even once every property is back. Any change marks it
       * modified again, so nudge one property and put it straight back.
       */
      for (const l of letters) {
        if (flags[l] !== false || link.get(modifiedFlag(l)) !== true) continue;
        const opacity = layerPath(id, l, 1, 'opacity', 'pp', 'opacity');
        const was = link.get(opacity);
        if (typeof was !== 'number') continue;
        link.send({ path: opacity, value: was === 256 ? 255 : was + 1 });
        await link.waitFor(modifiedFlag(l), false, { timeout }).catch(() => {});
        link.send({ path: opacity, value: was });
        await link.waitFor(opacity, was, { timeout }).catch((err) => failed.push(err.message));
      }
      await link.rearm();
      if (failed.length) throw new Error(`${id} not fully restored:\n  ` + failed.join('\n  '));
      return changed.length;
    }
  };
}

/**
 * Screen memory slots that are empty, highest first — a test saves into the
 * top of the bank, well away from anything a person would have used.
 */
export function spareSlots(link, count, { kind = 'screen', from } = {}) {
  const bank = kind === 'master' ? 'masterPresetBank' : 'presetBank';
  const items = link.get(['device', bank, 'bankList', 'items']) || {};
  const top = from || Math.max(...Object.keys(items).map(Number));
  const out = [];
  for (let n = top; n >= 1 && out.length < count; n--) {
    const st = items[String(n)] && items[String(n)].status && items[String(n)].status.pp;
    if (st && st.isValid === false) out.push(n);
  }
  if (out.length < count) throw new Error(`only ${out.length} empty ${kind} slots`);
  return out;
}

/** The path of one layer property in one buffer of one screen. */
export const layerPath = (id, letter, layer, ...tail) =>
  ['device', 'screenList', 'items', id, 'presetList', 'items', letter, 'layerList', 'items', String(layer), ...tail];

/* ------------------------------------------------------------------ *
 * Small shared pieces
 * ------------------------------------------------------------------ */

export const slotValid = (slot, bank = 'presetBank') =>
  ['device', bank, 'bankList', 'items', String(slot), 'status', 'pp', 'isValid'];

/**
 * Put a known source and opacity on layer 1 of a screen's preview, and wait
 * until the switcher holds it — including its second confirmation of the
 * source under `status`, which can trail the first and would otherwise land
 * in the next test's window.
 */
export async function previewLook(link, { source, opacity = 256 }, id = 'S1') {
  await settled(link, id);
  const t = link.get(sag(id, 'status', 'transition'));
  const pv = t === 'AT_DOWN' ? link.get(sag(id, 'control', 'presetUp')) : link.get(sag(id, 'control', 'presetDown'));
  link.send([
    { path: layerPath(id, pv, 1, 'source', 'pp', 'inputNum'), value: source },
    { path: layerPath(id, pv, 1, 'opacity', 'pp', 'opacity'), value: opacity }
  ]);
  await link.waitFor(layerPath(id, pv, 1, 'source', 'pp', 'inputNum'), source);
  await link.waitFor(layerPath(id, pv, 1, 'opacity', 'pp', 'opacity'), opacity);
  await link.waitFor(layerPath(id, pv, 1, 'source', 'status', 'pp', 'inputNum'), source);
  return pv;
}

/** Save what preview holds into an empty screen memory, and wait for it. */
export async function saveFromPreview(link, slot, id = 'S1') {
  link.send({
    path: ['device', 'presetBank', 'control', 'save', 'screenList', 'items', id, 'presetList', 'items', 'PREVIEW',
      'slotList', 'items', String(slot), 'pp', 'xRequest'],
    value: true
  });
  await link.waitFor(slotValid(slot), true, { timeout: 8000 });
}

/** Delete screen memories a test made, if they are still there. */
export async function deleteSlots(link, slots) {
  for (const slot of slots) {
    if (link.get(slotValid(slot)) === true) {
      link.send({ path: ['device', 'presetBank', 'bankList', 'items', String(slot), 'control', 'pp', 'xDelete'], value: true });
    }
  }
  for (const slot of slots) await link.waitFor(slotValid(slot), false).catch(() => {});
}

/**
 * Follow one of the app's server-sent streams, as a page's EventSource would.
 * Returns `{events, close}`; `events` fills as `{event, data}` arrive.
 */
export function sse(url, onEvent = () => {}) {
  const ctrl = new AbortController();
  const events = [];
  const done = (async () => {
    const res = await fetch(url, { signal: ctrl.signal });
    const reader = res.body.getReader();
    let buf = '';
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += Buffer.from(value).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message';
        const data = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        const raw = data.join('\n');
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* text */ }
        const e = { event, data: parsed, raw, at: Date.now() };
        events.push(e);
        try { onEvent(e); } catch { /* a listener must not end the stream */ }
      }
    }
  })().catch(() => {});
  return { events, close: () => { ctrl.abort(); return done; } };
}
