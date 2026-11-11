/*
 * Timer Image — a Stagetimer.io room, read from this process (server only).
 *
 * A port of bdstage's client (birddog-play-patcher/stagetimer, Go:
 * stagetimer.go, socketio.go, feed.go), which follows Stagetimer's Web API v1
 * docs (https://stagetimer.io/docs/api-v1/) and what api.stagetimer.io
 * answered on 2026-11-10 to a made-up room. **No real room's events have been
 * seen** — the payloads are the documented ones.
 *
 * - **The feed is Socket.IO v4** (Engine.IO 4) at `/v1/socket.io/`, opened
 *   straight onto the WebSocket transport, which Engine.IO allows and which
 *   skips the load balancer's sticky cookie. The room and key go in the
 *   socket's CONNECT (`40{"room_id","api_key"}`); a refused key or room comes
 *   back as `44{"message"}` (a made-up room: "Access Denied: Room not
 *   found"). It is receive-only: we answer pings and never emit.
 * - **HTTP fills the gaps**: `get_all_timers` once a connection is up (the
 *   feed sends the current timer, not the rundown), and `get_status` every
 *   few seconds while the socket is down. The key goes in an Authorization
 *   header, never the query string, so no proxy logs it. 100 requests a
 *   minute per room is the documented budget; a poll every 5 s is 12.
 * - **The clock offset.** `playback_status` carries `start`, `finish`,
 *   `pause` and `server_time` in the server's milliseconds, and a countdown
 *   is `finish − now` on the server's clock. `server_time` undershoots by the
 *   network delay, so the largest recent sample is the best; an HTTP `Date`
 *   header (whole seconds) bounds it, as bdstage does.
 *
 * The key never leaves this process: it is not in the plugin's settings, not
 * in the setup file, and `describe()` says only whether one is set.
 */

import { EventEmitter } from 'node:events';
import { WsClient } from '../../server/ws-client.js';

export const DEFAULT_BASE = 'https://api.stagetimer.io';
const USER_AGENT = 'livepremier-plus (timer-image)';
const POLL_MS = 5000;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

/** A refusal retrying will not fix: a wrong key or room. */
export class Refused extends Error {}

/** `{ host, port, secure, prefix }` of an API base like https://api.stagetimer.io. */
export function parseBase(base) {
  const u = new URL(String(base || DEFAULT_BASE));
  if (!/^(https?|wss?):$/.test(u.protocol)) throw new Error(`the Stagetimer address ${base} is not http(s)`);
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  return {
    host: u.hostname,
    port: Number(u.port) || (secure ? 443 : 80),
    secure,
    prefix: u.pathname.replace(/\/+$/, ''),
    http: `${secure ? 'https' : 'http'}://${u.host}${u.pathname.replace(/\/+$/, '')}`
  };
}

/** An EVENT body — `[/ns,][ackid]["name", data]` — as `{ name, data }`, or null. */
export function parseEvent(body) {
  let s = String(body);
  if (s.startsWith('/')) {
    const i = s.indexOf(',');
    if (i < 0) return null;
    s = s.slice(i + 1);
  }
  s = s.replace(/^\d+/, '');
  let arr;
  try { arr = JSON.parse(s); } catch { return null; }
  if (!Array.isArray(arr) || typeof arr[0] !== 'string' || !arr[0]) return null;
  return { name: arr[0], data: arr.length > 1 ? arr[1] : null };
}

/** The server's clock minus ours, from `server_time` samples bounded by `Date` headers. */
export function createOffset(now = () => Date.now()) {
  const st = [];
  const date = [];
  const push = (list, v) => { list.push({ v, at: now() }); if (list.length > 6) list.shift(); };
  const recent = (list, ms) => list.filter((x) => now() - x.at <= ms).map((x) => x.v);
  return {
    serverTime(ms, local = now()) { if (ms > 0) push(st, ms - local); },
    dateHeader(serverMs, local = now()) { push(date, serverMs + 500 - local); },
    get() {
      const d = recent(date, 30 * 60000).sort((a, b) => a - b);
      const s = recent(st, 10 * 60000);
      const fromDate = d.length ? d[Math.floor(d.length / 2)] : null;
      if (s.length) {
        const best = Math.max(...s);
        if (fromDate === null || Math.abs(best - fromDate) <= 1500) return best;
      }
      return fromDate ?? 0;
    }
  };
}

export class StagetimerLink extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.roomId
   * @param {string} o.apiKey
   * @param {string} [o.base]       API base; a fake server's in tests
   * @param {Function} [o.fetchImpl]
   * @param {(msg: string) => void} [o.log]
   */
  constructor({ roomId, apiKey, base = DEFAULT_BASE, fetchImpl = (...a) => fetch(...a), log = () => {} }) {
    super();
    this.roomId = String(roomId || '');
    this.apiKey = String(apiKey || '');
    this.base = parseBase(base);
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.offset = createOffset();
    this.snap = { status: null, current: null, next: null, timers: [], room: null };
    this.state = 'off';
    this.error = null;
    this.lastData = 0;
    this.attempt = 0;
    this.ws = null;
    this.timers = new Set();
    this.stopped = true;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.roomId || !this.apiKey) { this.#set('off', 'a room ID and an API key are both needed'); return; }
    this.#connect();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.ws) { try { this.ws.close(); } catch { /* gone */ } this.ws = null; }
    this.#set('off', null);
  }

  /** What `core.stagetimerView` reads. */
  snapshot() { return { ...this.snap, offsetMs: this.offset.get() }; }

  /** For the panel: never the key. */
  describe() {
    return {
      state: this.state,
      error: this.error,
      roomId: this.roomId,
      keySet: Boolean(this.apiKey),
      roomName: (this.snap.room && this.snap.room.name) || '',
      timerName: (this.snap.current && this.snap.current.name) || '',
      lastData: this.lastData || null,
      offsetMs: Math.round(this.offset.get())
    };
  }

  #set(state, error) {
    const changed = state !== this.state || error !== this.error;
    this.state = state;
    this.error = error;
    if (changed) this.emit('state', this.describe());
  }

  #later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.stopped) fn(); }, ms);
    t.unref?.();
    this.timers.add(t);
    return t;
  }

  /* ------------------------------------------------------------- HTTP */

  async get(endpoint) {
    const url = `${this.base.http}/v1/${endpoint}?room_id=${encodeURIComponent(this.roomId)}`;
    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json', 'User-Agent': USER_AGENT } });
    const date = Date.parse(res.headers.get('date') || '');
    if (Number.isFinite(date)) this.offset.dateHeader(date);
    let env = null;
    try { env = await res.json(); } catch { env = null; }
    if (!env || typeof env !== 'object') throw new Error(`Stagetimer answered HTTP ${res.status} with something that is not JSON`);
    if (!env.ok || res.status !== 200) {
      const msg = `Stagetimer: ${env.message || 'refused'} (HTTP ${res.status})`;
      throw [400, 401, 403, 404].includes(res.status) ? new Refused(msg) : new Error(msg);
    }
    return env.data ?? null;
  }

  /** Check the room and key together, without the feed. */
  async testAuth() { await this.get('test_auth'); return true; }

  async #refreshTimers() {
    try {
      const timers = await this.get('get_all_timers');
      if (Array.isArray(timers)) { this.snap.timers = timers; this.emit('data'); }
    } catch (err) {
      if (err instanceof Refused) this.#refuse(err.message);
    }
  }

  async #poll() {
    if (this.stopped || this.state === 'live' || this.state === 'refused') return;
    try {
      const st = await this.get('get_status');
      if (st && typeof st === 'object') {
        this.#onEvent('playback_status', st);
        if (this.state !== 'live') this.#set('polling', 'the live feed is down; reading Stagetimer every 5 s');
      }
    } catch (err) {
      if (err instanceof Refused) { this.#refuse(err.message); return; }
      if (this.state !== 'live') this.#set('error', err.message);
    }
    if (this.state !== 'live' && this.state !== 'refused') this.#later(() => this.#poll(), POLL_MS);
  }

  #refuse(message) {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.ws) { try { this.ws.close(); } catch { /* gone */ } this.ws = null; }
    this.#set('refused', message);
  }

  /* ------------------------------------------------------------- feed */

  #connect() {
    if (this.stopped) return;
    this.#set(this.state === 'polling' ? 'polling' : 'connecting', this.state === 'polling' ? this.error : null);
    const { host, port, secure, prefix } = this.base;
    let ws;
    try {
      ws = new WsClient({ host, port, secure, path: `${prefix}/v1/socket.io/?EIO=4&transport=websocket`, headers: { 'User-Agent': USER_AGENT }, timeoutMs: 15000 });
    } catch (err) {
      this.#retry(err.message);
      return;
    }
    this.ws = ws;
    let open = null;
    let deadline = null;
    const alive = () => {
      if (deadline) clearTimeout(deadline);
      const ms = open ? open.pingInterval + open.pingTimeout : 20000;
      deadline = setTimeout(() => { try { ws.close(); } catch { /* gone */ } }, ms);
      deadline.unref?.();
    };
    ws.on('open', alive);
    ws.on('message', (text) => {
      alive();
      const pk = String(text);
      if (pk[0] === '0' && !open) {
        try { open = JSON.parse(pk.slice(1)); } catch { open = {}; }
        open.pingInterval = Number(open.pingInterval) > 0 ? open.pingInterval : 25000;
        open.pingTimeout = Number(open.pingTimeout) > 0 ? open.pingTimeout : 20000;
        ws.send(`40${JSON.stringify({ room_id: this.roomId, api_key: this.apiKey })}`);
        return;
      }
      if (pk === '2') { ws.send('3'); return; }
      if (pk === '1' || pk.startsWith('41')) { try { ws.close(); } catch { /* gone */ } return; }
      if (pk.startsWith('44')) {
        let m = '';
        try { m = JSON.parse(pk.slice(2)).message || ''; } catch { m = pk.slice(2); }
        this.#refuse(`Stagetimer refused the connection${m ? `: ${m}` : ''}`);
        return;
      }
      if (pk.startsWith('40')) {
        this.attempt = 0;
        this.#set('live', null);
        void this.#refreshTimers();
        return;
      }
      if (pk.startsWith('42')) {
        const ev = parseEvent(pk.slice(2));
        if (ev) this.#onEvent(ev.name, ev.data);
      }
    });
    ws.on('error', (err) => { this.lastError = err.message; });
    ws.on('close', () => {
      if (deadline) clearTimeout(deadline);
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      this.#retry(this.lastError || 'the live feed closed');
    });
  }

  #retry(why) {
    if (this.stopped) return;
    const ms = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.lastError = null;
    if (this.state !== 'polling') {
      this.#set('error', `${why}; trying again in ${Math.round(ms / 1000)} s`);
      void this.#poll();
    }
    this.#later(() => this.#connect(), ms);
  }

  #onEvent(name, data) {
    this.lastData = Date.now();
    switch (name) {
      case 'playback_status':
        if (data && typeof data === 'object') {
          this.snap.status = data;
          this.offset.serverTime(Number(data.server_time) || 0);
        }
        break;
      case 'current_timer':
      case 'next_timer': {
        const t = data && typeof data === 'object' ? data : null;
        if (name === 'current_timer') this.snap.current = t; else this.snap.next = t;
        if (t && t._id) {
          const i = this.snap.timers.findIndex((x) => x && x._id === t._id);
          if (i >= 0) this.snap.timers[i] = t; else this.snap.timers.push(t);
        }
        break;
      }
      case 'room':
        if (data && typeof data === 'object') this.snap.room = data;
        break;
      case 'timers_changed':
        void this.#refreshTimers();
        break;
      default:
        return;
    }
    this.emit('data');
  }
}
