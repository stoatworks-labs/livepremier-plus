/*
 * The console suite's harness: a real Pixelhue console, the real app, and a
 * LivePremier simulator at the far end.
 *
 *   LPP_CONSOLE=192.168.0.50 LPP_SIM=127.0.0.1:3000 npm run test:console
 *   LPP_CONSOLE=stand-in     LPP_SIM=127.0.0.1:3000 npm run test:console
 *
 * `test/sim/` drives the app the way the outside world does and checks the
 * switcher over AWJ. This folder does the same with one more party in the
 * loop: the console, on its own control service (UCenter — 8088 on the LAN
 * for a U5 mini, 19999 on loopback for a U5 / U5 Pro, which means running on
 * the console itself). The socket's path is the model's too (`linkFor` in
 * `plugins/pixelhue/core.js`): a mini serves `/unico/v1/ws`, and refuses the
 * U5's `/unico/v1/ucenter/ws`. With `LPP_CONSOLE` unset every test here
 * skips, and `stand-in` swaps the console for `test/helpers/fake-ucenter.js`,
 * which proves the suite runs and nothing else.
 *
 * ## Three witnesses, none of them the app
 *
 * - **The switcher, over AWJ** (`awjGet`, from `test/sim/harness.js`): what a
 *   key really did. Every rule of that harness stands — the switcher must say
 *   it is a simulator, and everything a test changes is put back.
 * - **The console, on a socket of our own** (`Witness`): a second
 *   `client-type=5` connection. UCenter sends every client the same key states
 *   and command reports, so this hears what the console told the app, and
 *   what it drew, without asking the app. It shares the app's frame codec —
 *   there is only one — and nothing else.
 * - **The person at the desk**, for what only eyes and thumbs can check: what
 *   a key's display reads, a long press, the T-bar. `3-hands.console.test.js`.
 *
 * ## Presses are injected, and that is not the same as a thumb
 *
 * `PUT …/key/action` makes UCenter act as if a key went down and up. It is
 * how this was built without a console, and it proves the console's own
 * service takes our model and reports the commands we expect for its keys.
 * It does not prove the key under a thumb is the key the map says. Only the
 * hands-on file does that.
 *
 * ## Nothing else may be listening to the console
 *
 * Every client of a UCenter acts on every press. A second LivePremier Plus
 * pointed at the same console would take, cut and recall on whatever switcher
 * IT drives when this injects a press — which, the day this was written, was
 * the tray app on this Mac, holding its UCenter and pointed at a frame in use.
 * So before anything is pressed:
 * `assertNoOtherDriver` asks every LivePremier Plus on this machine what it is
 * driving and refuses if one shares the console, and `assertQuiet` refuses if
 * anything republishes over our model. PixelFlow, or another laptop, cannot be
 * asked: close it.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SIM, SKIP as SIM_SKIP, ROOT, startApp, sleep } from '../sim/harness.js';
import { UCenterLink } from '../../plugins/pixelhue/ucenter.js';
import { CONSOLE_MODELS, businessModel, linkFor } from '../../plugins/pixelhue/core.js';
import { SURFACE_PORT } from '../../src/vendor/pixelhue/surface.js';
import { PixelhueSupervisor } from '../../plugins/pixelhue/supervisor.js';
import { StandInConsole } from '../helpers/fake-ucenter.js';

export { sleep };

/** The console under test: an address, `stand-in`, or '' when the suite is off. */
export const CONSOLE = (process.env.LPP_CONSOLE || '').trim();
export const STAND_IN = CONSOLE === 'stand-in';

export const MODEL = CONSOLE_MODELS.find((m) => m.id === (process.env.LPP_CONSOLE_MODEL || 'u5mini').trim()) || null;
if (CONSOLE && !MODEL) {
  throw new Error(`LPP_CONSOLE_MODEL is not one of ${CONSOLE_MODELS.map((m) => m.id).join(', ')}`);
}
if (CONSOLE && !STAND_IN && !/^[A-Za-z0-9._-]+$/.test(CONSOLE)) {
  throw new Error(`LPP_CONSOLE is a host, without a port or a scheme (the port comes from the model): ${CONSOLE}`);
}
if (STAND_IN && MODEL.id !== 'u5mini') throw new Error('the stand-in console is a U5 mini');

/** Where the app will dial: the app takes the port, socket path and client
    type from the model, so this does. */
export const HOST = STAND_IN ? '127.0.0.1' : CONSOLE;
export const LINK = MODEL ? linkFor(MODEL.id) : null;
export const PORT = LINK ? LINK.port : null;

export const SKIP = !CONSOLE
  ? 'LPP_CONSOLE is not set (a console\'s address, or stand-in)'
  : SIM_SKIP ? `${SIM_SKIP}; the console suite writes to a simulator, never a frame` : false;

/** The hands-on file asks a person, so it runs only when one is there. */
export const GUIDED = process.env.LPP_CONSOLE_GUIDED === '1';

/* ------------------------------------------------------------------ *
 * The console's vocabulary
 * ------------------------------------------------------------------ */

/** UCenter's `areaType` for the four buses. */
export const AREA = Object.freeze({ screen: 1, input: 3, layer: 4, preset: 5 });
const BUS_MODE = { 1: 100, 3: 102, 4: 101, 5: 103 };
const PAGE_UP = 105;
const PAGE_DOWN = 106;

/**
 * The function keys, by the console's own `keyMode`, with the commands
 * `plugins/pixelhue/mapping.js` expects each to report. `reports: []` is a key
 * known to report no command; `null` is one nobody has yet seen pressed —
 * finding out is part of what the suite is for. The last four are on a U5
 * mini's layout (its key_mini.xml) and on no U5's.
 */
export const FUNCTION_KEYS = Object.freeze([
  { mode: 154, name: 'TAKE', reports: [531] },
  { mode: 153, name: 'CUT', reports: [532] },
  { mode: 109, name: 'MATCH PGM', reports: [529] },
  { mode: 110, name: 'PGM EDIT', reports: [530] },
  { mode: 107, name: 'FTB', reports: [518] },
  { mode: 108, name: 'FRZ', reports: [517] },
  { mode: 150, name: 'SWAP', reports: [533] },
  { mode: 151, name: 'TIME', reports: [509] },
  { mode: 122, name: 'SAVE TO', reports: [520] },
  { mode: 123, name: 'DEL', reports: [521] },
  { mode: 121, name: 'LOCK PANEL', reports: [523, 524], long: true },
  { mode: 180, name: 'SIGNAL SOURCE', reports: [587] },
  { mode: 179, name: 'SWITCH DEVICE', reports: [586] },
  { mode: 112, name: 'MVR', reports: [] },
  { mode: 111, name: 'CTRL', reports: [] },
  { mode: 113, name: 'MEDIA', reports: [] },
  { mode: 120, name: 'LOCK T-BAR', reports: [] },
  { mode: 184, name: 'LOAD TO PGM', reports: null },
  { mode: 185, name: 'TEST PATTERN', reports: null },
  { mode: 186, name: 'SHIFT', reports: null },
  { mode: 187, name: 'AREA SWITCH', reports: null },
]);
export const functionKey = (name) => FUNCTION_KEYS.find((f) => f.name === name);

/**
 * A console's key map, from its own `GET key/active-custom?deviceModel=` —
 * flattened, and asked by function rather than by key code, so a test reads
 * the same on a U5 mini and a U5.
 */
export function keyMapOf(json) {
  const areas = (json && json.data && Array.isArray(json.data.areaList)) ? json.data.areaList : [];
  const keys = [];
  for (const a of areas) {
    for (const k of a.keyList || []) {
      keys.push({ key: Number(k.keyCode), page: Number(k.pageIndex), index: Number(k.keyIndex), mode: Number(k.keyMode), area: Number(a.areaType) });
    }
  }
  return {
    empty: !keys.length,
    keys,
    /** The key that has `mode` on the unshifted layer, or null. */
    byMode: (mode, page = 0) => {
      const k = keys.find((x) => x.mode === mode && x.page === page);
      return k ? k.key : null;
    },
    /** Every key with `mode` — the area-switch key is on every bus. */
    allByMode: (mode, page = 0) => keys.filter((x) => x.mode === mode && x.page === page).map((x) => x.key),
    /** A bus's position keys, position 1 first. */
    bus: (area) => keys.filter((x) => x.area === area && x.mode === BUS_MODE[area] && x.page === 0)
      .sort((a, b) => a.index - b.index).map((x) => x.key),
    /** A bus's own page key: `+1` down (next), `-1` up. */
    pageKey: (area, dir) => {
      const k = keys.find((x) => x.area === area && x.mode === (dir > 0 ? PAGE_DOWN : PAGE_UP));
      return k ? k.key : null;
    },
  };
}

/* ------------------------------------------------------------------ *
 * The console, on a socket of our own
 * ------------------------------------------------------------------ */

/**
 * Hears everything the console says, and keeps what each key shows.
 *
 * Rides `UCenterLink` — the app's own client, for its codec and keep-alive —
 * on a connection of its own. Every report is an event with a sequence
 * number, so a test takes a `mark()` before it presses and waits for what
 * came after.
 */
export class Witness {
  static async open(target, { timeout = 8000 } = {}) {
    const w = new Witness(target);
    await w.#ready(timeout);
    return w;
  }

  constructor({ host, port, wsPath, clientType }) {
    this.host = host;
    this.port = port;
    this.events = [];
    this.seq = 0;
    this.keys = new Map();
    this.redraws = 0;
    this.undecodable = 0;
    this.link = new UCenterLink({ host, port, wsPath, clientType });
    this.url = this.link.wsUrl;
    this.link.on('command', (d) => this.#push('command', d));
    this.link.on('keystate', (items) => {
      if (items.length === 1 && (items[0].state === 0 || items[0].state === 1)) {
        this.#push('press', { key: Number(items[0].key), state: items[0].state });
        return;
      }
      for (const k of items) if (k && Number.isFinite(Number(k.key))) this.keys.set(Number(k.key), { ...k });
      this.redraws++;
      this.#push('keys', items);
    });
    this.link.on('tbar', (d) => this.#push('tbar', d));
    this.link.on('midi', (d) => this.#push('midi', d));
    this.link.on('undecodable', () => { this.undecodable++; });
    this.link.start();
  }

  #push(kind, data) {
    this.events.push({ seq: ++this.seq, at: Date.now(), kind, data });
    if (this.events.length > 20000) this.events.splice(0, 5000);
  }

  #ready(timeout) {
    if (this.link.state.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no answer from a console at ${this.url} in ${timeout} ms` +
          (this.link.state.lastError ? ` (${this.link.state.lastError})` : '')));
      }, timeout);
      this.link.once('open', () => { clearTimeout(timer); resolve(); });
    });
  }

  mark() { return this.seq + 1; }

  since(mark, kind) { return this.events.filter((e) => e.seq >= mark && (!kind || e.kind === kind)); }

  /** The first event of `kind` at or after `mark` that `pred` likes. */
  waitFor(kind, pred = () => true, { mark = this.mark(), timeout = 3000, label } = {}) {
    const hit = () => this.events.find((e) => e.seq >= mark && e.kind === kind && pred(e.data));
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const e = hit();
        if (e) return resolve(e.data);
        if (Date.now() - t0 > timeout) {
          const seen = this.since(mark, 'command').map((x) => x.data.command);
          return reject(new Error(`timed out after ${timeout} ms waiting for ${label || kind}` +
            (seen.length ? `; the console reported ${seen.join(', ')}` : '; the console reported no command')));
        }
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  /** The command a press reported, or null if it reported none within `timeout`. */
  async commandAfter(mark, { timeout = 1000 } = {}) {
    try { return await this.waitFor('command', (d) => Number(d.command) !== 0, { mark, timeout }); }
    catch { return null; }
  }

  text(key) { const k = this.keys.get(key); return k ? String(k.text || '') : ''; }
  state(key) { const k = this.keys.get(key); return k ? k.state : undefined; }

  /** Of `keys`, the one showing `text` now, or null. */
  showing(keys, text) { return keys.find((k) => this.text(k) === text) ?? null; }

  /** Resolve once `key` shows `text` (checks first: the console may already). */
  waitText(key, text, { timeout = 4000 } = {}) {
    if (this.text(key) === text) return Promise.resolve();
    return this.waitFor('keys', () => this.text(key) === text, { timeout, label: `key ${key} to read "${text}" (it reads "${this.text(key)}")` });
  }

  async close() { await this.link.stop(); }
}

/* ------------------------------------------------------------------ *
 * Talking to the console's REST side
 * ------------------------------------------------------------------ */

/**
 * One call to UCenter, answered whole. Like `ucenter.js`, it carries no
 * `ip`/`port` headers — a UCenter that proxies to devices would forward the
 * call instead of answering it.
 */
export async function rest(path, body = null, method = 'PUT') {
  const res = await fetch(`http://${HOST}:${PORT}/unico/v1/${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 0) {
    throw new Error(`${method} ${path}: HTTP ${res.status} ${json ? JSON.stringify(json) : 'unreadable'}`);
  }
  return json;
}

export const readKeyMap = async () => keyMapOf(
  await rest(`ucenter/video-station/key/active-custom?deviceModel=${MODEL.modelId}`, null, 'GET'));

/**
 * Inject a press. `hold` is how long the key stays down, in ms: down and up
 * are then two calls, which is the only way to inject a long press.
 */
export async function press(key, { hold = 0 } = {}) {
  if (!hold) {
    await rest('ucenter/video-station/key/action', [{ key: Number(key), state: 0 }, { key: Number(key), state: 1 }]);
    return;
  }
  await rest('ucenter/video-station/key/action', [{ key: Number(key), state: 0 }]);
  await sleep(hold);
  await rest('ucenter/video-station/key/action', [{ key: Number(key), state: 1 }]);
}

/* ------------------------------------------------------------------ *
 * Nobody else on the console
 * ------------------------------------------------------------------ */

const LOOPBACK = /^(127\.|localhost$|::1$)/;
const sameHost = (a, b) => a === b || (LOOPBACK.test(a) && LOOPBACK.test(b));

/**
 * Refuse if another LivePremier Plus on this machine is set to drive the same
 * console. It asks each one (`/__lpp/pixelhue/state`) on the app's default
 * port, the tray app's, and any in `LPP_CONSOLE_PEERS` (`8600,8601`); a port
 * with nothing on it is fine. Configured counts, connected or not: the link
 * redials on its own.
 */
export async function assertNoOtherDriver() {
  const ports = [8535, 8536, ...String(process.env.LPP_CONSOLE_PEERS || '').split(',').map(Number).filter(Boolean)];
  for (const port of [...new Set(ports)]) {
    let state;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/__lpp/pixelhue/state`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) continue;
      state = await res.json();
    } catch { continue; }
    if (state && state.configured && Number(state.port) === PORT && sameHost(String(state.host), HOST)) {
      throw new Error(
        `the LivePremier Plus on 127.0.0.1:${port} is driving this console too ` +
        `(${state.model} at ${state.host}:${state.port}, on ${state.platform || 'a switcher'}). ` +
        'Every press this suite injects would be acted on there as well. Switch its Pixelhue panel off ' +
        '(Settings → Pixelhue panel), or quit it, and run again.');
    }
  }
}

/**
 * Refuse if something republishes over our model: a whole-panel redraw that
 * carries none of our labels, within `ms` of our labels being drawn. That is
 * PixelFlow, or another app, and every press would go to it too.
 */
export async function assertQuiet(witness, labels, { ms = 4000 } = {}) {
  const ours = new Set(labels.filter(Boolean));
  await witness.waitFor('keys', () => [...witness.keys.values()].some((k) => ours.has(k.text)),
    { mark: 1, timeout: 8000, label: 'the console to draw our labels' });
  const mark = witness.mark();
  await sleep(ms);
  const foreign = witness.since(mark, 'keys')
    .filter((e) => e.data.length >= 40 && !e.data.some((k) => k && ours.has(k.text)));
  if (foreign.length) {
    throw new Error(`something else republished to the console ${foreign.length} time(s) in ${ms} ms ` +
      '(PixelFlow, or another app). Close it: every press would be acted on there too.');
  }
}

/* ------------------------------------------------------------------ *
 * The console, and the app driving it
 * ------------------------------------------------------------------ */

/**
 * The console under test (starting the stand-in when asked for), with our own
 * socket on it. Opened BEFORE the app, so that a console which drops its
 * model when a client connects has done so before the app publishes.
 */
export async function openConsole() {
  let standIn = null;
  if (STAND_IN) {
    /* With its key grid on 17100, where the app dials a mini's (`grid-link.js`). */
    try { standIn = await new StandInConsole({ port: PORT, host: HOST, grid: true, gridPort: SURFACE_PORT }).start(); }
    catch (err) {
      throw new Error(`the stand-in console needs ${HOST}:${PORT} and ${HOST}:${SURFACE_PORT}, and one is taken (${err.code || err.message})`);
    }
  }
  const witness = await Witness.open({ host: HOST, ...LINK });
  return {
    standIn,
    witness,
    async close() {
      await witness.close();
      if (standIn) await standIn.stop();
    },
  };
}

/** What the switcher looks like to the panel: the facts and the model the app builds from them. */
export async function expectedModel() {
  const sup = new PixelhueSupervisor({ deviceHost: () => SIM.split(':')[0] });
  const facts = await sup.readFacts();
  return { facts, model: businessModel(facts) };
}

/** The app's view of the panel: `GET /__lpp/pixelhue/state`. */
export async function panelState(app) {
  const r = await app.api('/pixelhue/state');
  if (r.status !== 200) throw new Error(`/pixelhue/state ${r.status}: ${r.text}`);
  return r.json;
}

/** Resolve with the panel state once `pred` likes it. */
export async function waitPanel(app, pred, { timeout = 5000, label = 'the panel' } = {}) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    last = await panelState(app);
    if (pred(last)) return last;
    if (Date.now() - t0 > timeout) {
      const recent = (last.history || []).slice(0, 4)
        .map((h) => `${h.kind}${h.command ? ` ${h.command}` : ''}${h.note ? `: ${h.note}` : ''}${h.error ? `: ${h.error}` : ''}`);
      throw new Error(`timed out after ${timeout} ms waiting for ${label}; latest history: ${recent.join(' | ') || 'none'}`);
    }
    await sleep(50);
  }
}

/** The first history line since `since` that `pred` likes. */
export async function waitHistory(app, since, pred, opts = {}) {
  const st = await waitPanel(app, (s) => (s.history || []).some((h) => h.at >= since && pred(h)), opts);
  return st.history.find((h) => h.at >= since && pred(h));
}

/** History lines since `since`, oldest first. */
export async function historySince(app, since) {
  const st = await panelState(app);
  return (st.history || []).filter((h) => h.at >= since).reverse();
}

/**
 * Boot the app against the simulator and switch its Pixelhue panel on,
 * pointed at the console under test. Resolves once it has published.
 */
export async function startPanel(settings = {}) {
  const app = await startApp();
  await app.configure({
    plugins: {
      pixelhue: {
        enabled: true,
        settings: { pixelhueEnabled: true, pixelhueHost: HOST, pixelhueModel: MODEL.id, ...settings },
      },
    },
  });
  await waitPanel(app, (s) => s.link && s.link.connected && (s.history || []).some((h) => h.kind === 'published'),
    { timeout: 20000, label: 'the panel to connect and publish' });
  return app;
}

/* ------------------------------------------------------------------ *
 * What was seen, kept
 * ------------------------------------------------------------------ */

/**
 * Everything a run learns about the console, written to `test/console/results/`
 * (ignored by git) when the file ends. A run on a real console is the only
 * source for some of it — what loadToPgm reports, what a mini's T-bar sends —
 * and the useful parts belong in `test/fixtures/` afterwards.
 */
export function recorder(name) {
  const data = {
    file: name,
    console: CONSOLE, host: HOST, port: PORT, model: MODEL && MODEL.id, standIn: STAND_IN, sim: SIM,
    socket: LINK ? `ws://${HOST}:${LINK.port}${LINK.wsPath}?client-type=${LINK.clientType}` : null,
    startedAt: new Date().toISOString(),
    notes: {},
  };
  return {
    data,
    note(key, value) { data.notes[key] = value; },
    async save() {
      const dir = join(ROOT, 'test', 'console', 'results');
      await mkdir(dir, { recursive: true });
      const stamp = data.startedAt.replace(/[:.]/g, '-').slice(0, 19);
      const file = join(dir, `${stamp}-${data.model}${STAND_IN ? '-stand-in' : ''}-${name}.json`);
      await writeFile(file, JSON.stringify({ ...data, endedAt: new Date().toISOString() }, null, 2) + '\n');
      return file;
    },
  };
}
