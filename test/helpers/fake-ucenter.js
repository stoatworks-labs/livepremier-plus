/*
 * A stand-in Pixelhue console: enough of a U5 mini's UCenter to dry-run the
 * console suite (`test/console/`) before a real one is on the desk.
 *
 *   LPP_CONSOLE=stand-in LPP_SIM=127.0.0.1:3000 npm run test:console
 *
 * ⚠️ **A pass against this proves the suite runs. It proves nothing about a
 * console.** Every behaviour below is an opinion of how UCenter behaves, built
 * from what has been seen of it — the key map in
 * `test/fixtures/pixelhue-u5mini-keys.json`, the report shapes in
 * `pixelhue-u5pro-reports.json`, and `docs/PIXELHUE.md` — and where nobody has
 * seen what a key does (loadToPgm, testPattern, SHIFT, the area-switch keys),
 * this does nothing at all rather than guess. The suite records what a real
 * console reports; this is not where anyone should look it up.
 *
 * What it does, on a real socket the way the proxy tests' stand-in Web RCS
 * does:
 *
 *   PUT  …/video-station/data-change   keeps the model, redraws every bus key
 *   POST …/video-station/midi/binding  says yes
 *   GET  …/video-station/key/active-custom?deviceModel=  the fixture's key map
 *   PUT  …/video-station/key/action    a press: a raw key state, then a command
 *   WS   /unico/v1/ws                  NOVA frames to every client
 *
 * ⚠️ **The socket is at the mini's path, and only there.** Until 2026-10-22
 * this served the U5's `/unico/v1/ucenter/ws`, the app dialled the same, every
 * dry run passed, and the first real mini answered that path with an ordinary
 * HTTP 200 — the GUID-typo trap in `ws-client.js` again: a stand-in that
 * shares the code's mistake proves nothing. A mini runs `nvcontroller`, not
 * UCenter, and its binary has no `ucenter/ws` at all; its own LCD app connects
 * to `/unico/v1/ws?client-type=11` (firmware V1.0.3, `docs/PIXELHUE.md`). So
 * the U5's path is answered here as the mini answered it: a 200 and no
 * upgrade. What a mini serves at that path, beyond the status, nobody has seen.
 *
 * It decides between select, active and unselect from the published model's
 * `selected` / `activeRegion` flags, the way `core.js` says the console does,
 * and acts on the RELEASE, which is when a long press can be told from a short
 * one. It pages its buses eight keys at a time.
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';

import { acceptFor } from '../../plugins/pixelhue/ws-client.js';
import { encodeFrame } from '../../src/vendor/pixelhue/apollo.js';
import { TAGS } from '../../src/vendor/pixelhue/tags.js';
import { TBAR_REPORT } from '../../plugins/pixelhue/ucenter.js';

export const MINI_KEYS = JSON.parse(readFileSync(new URL('../fixtures/pixelhue-u5mini-keys.json', import.meta.url)));

const BASE = '/unico/v1/ucenter';
/** The mini's socket (nvcontroller), and the U5's, which a mini does not serve. */
export const MINI_WS_PATH = '/unico/v1/ws';
export const U5_WS_PATH = '/unico/v1/ucenter/ws';
const LONG_MS = 1000;
const PER_PAGE = 8;

/* keyMode → the command a function key reports. Bus keys, SAVE TO, DEL and
   LOCK PANEL are decided in `#release`. */
const FUNCTION = {
  107: 518, 108: 517, 109: 529, 110: 530, 150: 533, 151: 509,
  153: 532, 154: 531, 179: 586, 180: 587,
};
/* keyMode → which bus it pages, by areaType. */
const BUS_MODES = { 100: 1, 101: 4, 102: 3, 103: 5 };

export class StandInConsole {
  constructor({ keyMap = MINI_KEYS, port = 8088, host = '127.0.0.1', wsPath = MINI_WS_PATH } = {}) {
    this.keyMap = keyMap;
    this.port = port;
    this.host = host;
    this.wsPath = wsPath;
    /* Upgrades turned away, `{path, status}`, so a test can say which. */
    this.refused = [];
    this.model = { screens: [], layers: [], inputs: [], presets: [] };
    this.pages = { 1: 0, 3: 0, 4: 0, 5: 0 };
    this.armed = null;
    this.downAt = new Map();
    this.bindings = [];
    this.published = 0;
    this.pressed = [];
    this.sockets = new Set();
    this.seq = 1;
    /* Every key that is a bus position, by areaType, in position order. */
    this.bus = {};
    for (const area of keyMap.areaList) {
      for (const k of area.keyList) {
        if (BUS_MODES[k.keyMode] === undefined) continue;
        (this.bus[area.areaType] ||= []).push(k);
      }
    }
    for (const list of Object.values(this.bus)) list.sort((a, b) => a.keyIndex - b.keyIndex);
  }

  async start() {
    this.server = http.createServer((req, res) => this.#http(req, res));
    this.server.on('upgrade', (req, socket) => this.#upgrade(req, socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });
    /* `port: 0` asks for any free port; this is the one it got. */
    this.port = this.server.address().port;
    return this;
  }

  async stop() {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (this.server) await new Promise((resolve) => this.server.close(() => resolve()));
  }

  /* ------------------------------------------------------------- the wire */

  async #http(req, res) {
    const url = new URL(req.url, 'http://stand-in');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = null;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { /* not JSON */ }
    const reply = (json) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(json)); };
    const ok = (data = null) => reply({ code: 0, data, message: 'ok' });
    const path = url.pathname;

    if (req.method === 'PUT' && path === `${BASE}/video-station/data-change`) {
      if (!body || !Array.isArray(body.screens)) return reply({ code: 1, message: 'invalid param', data: { Struct: 'DataChange', Field: 'screens' } });
      this.model = body;
      this.published++;
      this.#redraw();
      return ok();
    }
    if (req.method === 'POST' && path === `${BASE}/video-station/midi/binding`) {
      this.bindings = (body && body.attributes) || [];
      return ok();
    }
    if (req.method === 'GET' && path === `${BASE}/video-station/key/active-custom`) {
      const asked = Number(url.searchParams.get('deviceModel'));
      return ok(asked === this.keyMap.deviceModel
        ? { configName: 'DefaultConfig', isDefault: true, deviceModel: asked, areaList: this.keyMap.areaList }
        : {});
    }
    if (req.method === 'PUT' && path === `${BASE}/video-station/key/action`) {
      for (const k of [].concat(body || [])) this.#key(Number(k.key), Number(k.state));
      return ok();
    }
    if (req.method === 'PUT' && path === `${BASE}/video-station/key/response-state`) return ok();
    res.statusCode = 404;
    reply({ code: 404, message: 'not found' });
  }

  #upgrade(req, socket) {
    const path = new URL(req.url, 'http://stand-in').pathname;
    if (path !== this.wsPath) {
      /* As the user's mini answered the U5's path: an ordinary 200, no
         upgrade. The body is a placeholder — only the status was reported. */
      const status = path === U5_WS_PATH ? 200 : 404;
      this.refused.push({ path, status });
      const body = status === 200 ? 'stand-in: not a socket here' : 'not found';
      socket.end(`HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Not Found'}\r\n`
        + `Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      return;
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptFor(req.headers['sec-websocket-key'])}`, '', '',
    ].join('\r\n'));
    this.sockets.add(socket);
    /* The client's keep-alive pings and its close are read and dropped. */
    socket.on('data', () => {});
    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));
    this.#redraw([socket]);
  }

  #send(tag, data, to = this.sockets) {
    const payload = encodeFrame({ tag, data, seq: this.seq++ });
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x82, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x82; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x82; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    for (const s of to) s.write(Buffer.concat([head, payload]));
  }

  #command(command, payload = {}, index = 0) {
    this.#send(TAGS.COMMAND_DATA, {
      index, command,
      payload: { id: 0, uid: '', type: 0, deviceSN: '', text: '', ...payload },
      additionInfos: [],
    });
  }

  /* ------------------------------------------------------------ the panel */

  /** What a bus shows, in position order: screens, the active screen's layers, inputs, presets. */
  #items(areaType) {
    const m = this.model;
    const byIndex = (a, b) => (a.index?.[0] ?? 0) - (b.index?.[0] ?? 0);
    if (areaType === 1) return [...(m.screens || [])].sort(byIndex);
    if (areaType === 3) return [...(m.inputs || [])].sort(byIndex);
    if (areaType === 5) return [...(m.presets || [])].sort(byIndex);
    const active = (m.screens || []).find((s) => s.activeRegion === 4);
    if (!active) return [];
    return (m.layers || []).filter((l) => l.attachScreenUid === active.uid && l.region === 4).sort(byIndex);
  }

  /** The object under a bus key on the page the bus shows, or null. */
  #at(areaType, key) {
    const keys = this.bus[areaType] || [];
    const i = keys.findIndex((k) => k.keyCode === key);
    if (i < 0) return null;
    return this.#items(areaType)[this.pages[areaType] * PER_PAGE + i] || null;
  }

  /** One whole-panel key-state redraw, as UCenter sends after a publish. */
  #redraw(to) {
    const out = [];
    for (const [type, keys] of Object.entries(this.bus)) {
      keys.forEach((k) => {
        const o = this.#at(Number(type), k.keyCode);
        const lit = o && o.selected === 1;
        out.push({
          key: k.keyCode, page: 0, open: true,
          text: o ? String(o.name || '') : '',
          businessID: o ? String(o.uid || o.id || '') : '',
          businessType: o ? 2 : 0,
          state: !o ? 0 : Number(type) * 100 + (lit ? 2 : 1),
        });
      });
    }
    /* The function keys too, so a redraw is the size of a real one. */
    for (const area of this.keyMap.areaList) {
      for (const k of area.keyList) {
        if (BUS_MODES[k.keyMode] !== undefined || k.pageIndex !== 0) continue;
        out.push({ key: k.keyCode, page: 0, open: true, text: '', businessID: '', businessType: 0, state: 0 });
      }
    }
    this.#send(TAGS.KEY_STATE, out, to);
  }

  #modeOf(key) {
    for (const area of this.keyMap.areaList) {
      const k = area.keyList.find((x) => x.keyCode === key && x.pageIndex === 0);
      if (k) return { mode: k.keyMode, areaType: area.areaType };
    }
    return null;
  }

  #key(key, state) {
    this.#send(TAGS.KEY_STATE, [{ key, state }]);
    if (state === 0) { this.downAt.set(key, Date.now()); return; }
    if (state !== 1) return;
    const held = Date.now() - (this.downAt.get(key) ?? Date.now());
    this.downAt.delete(key);
    this.pressed.push({ key, held });
    this.#release(key, held >= LONG_MS);
  }

  #release(key, long) {
    const found = this.#modeOf(key);
    if (!found) return;
    const { mode, areaType } = found;

    if (mode === 105 || mode === 106) {
      /* One page past the last object, so a full bus still has an empty key
         to SAVE TO. Whether a real console pages that far is for it to say. */
      const total = this.#items(areaType).length;
      const last = Math.max(0, Math.ceil((total + 1) / PER_PAGE) - 1);
      this.pages[areaType] = Math.min(last, Math.max(0, this.pages[areaType] + (mode === 106 ? 1 : -1)));
      this.#redraw();
      return;
    }

    const o = BUS_MODES[mode] !== undefined ? this.#at(areaType, key) : null;
    const position = o ? o.index[0] : 0;
    switch (mode) {
      case 100:
        if (!o) return;
        if (this.armed === 'del') { this.armed = null; this.#command(104, { uid: o.uid, type: 2, text: o.name }, position); return; }
        if (o.selected === 1 && long) { this.#command(103, { uid: o.uid, type: 2, text: o.name }, position); return; }
        this.#command(o.selected === 1 ? 102 : 101, { uid: o.uid, type: 2, text: o.name }, position);
        return;
      case 101:
        if (!o) { this.#command(200); return; }
        this.#command(201, { id: o.id, type: 2, text: o.name }, position);
        return;
      case 102:
        if (!o) return;
        this.#command(300, { id: o.id, type: 2, deviceSN: o.deviceSn || '', text: o.name }, position);
        return;
      case 103:
        if (this.armed === 'save') { this.armed = null; this.#command(400, { id: o ? o.id : 0, type: 1, text: o ? o.name : '' }, position); return; }
        if (this.armed === 'del') { this.armed = null; if (o) this.#command(403, { id: o.id, type: 1, text: o.name }, position); return; }
        if (o) this.#command(401, { id: o.id, type: 1, deviceSN: o.deviceSn || '', text: o.name }, position);
        return;
      case 122: this.armed = this.armed === 'save' ? null : 'save'; this.#command(520); return;
      case 123: this.armed = this.armed === 'del' ? null : 'del'; this.#command(521); return;
      case 121: if (long) this.#command(523); return;
      default:
        if (FUNCTION[mode] !== undefined) this.#command(FUNCTION[mode]);
    }
  }

  /* ------------------------------------------------- what hands would do */

  /** Throw the T-bar end to end, as `steps` reports `ms` apart. */
  async throwTbar({ steps = 12, ms = 25, max = 4095 } = {}) {
    for (let i = 1; i <= steps; i++) {
      const mapValue = Math.round((i / steps) * max);
      this.#send(TBAR_REPORT, {
        index: 1, direction: 1, percent: Math.round((i / steps) * 100), mapValue, maxValue: max, minValue: 0,
      });
      await new Promise((r) => setTimeout(r, ms));
    }
  }

  /** Press and release a key from inside, as a thumb would; `hold` in ms. */
  async thumb(key, hold = 80) {
    this.#key(key, 0);
    await new Promise((r) => setTimeout(r, hold));
    this.#key(key, 1);
  }

  /** What the bus key at `key` reads now, as the console would draw it. */
  label(areaType, key) {
    const o = this.#at(areaType, key);
    return o ? String(o.name || '') : '';
  }
}
