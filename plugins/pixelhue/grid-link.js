/*
 * The link to a U5 mini's LCD key grid, TCP 17100.  ** PREVIEW **
 *
 * The same link the console's built-in Companion holds (`src/vendor/pixelhue/
 * surface.js` has the wire, `grid.js` what is drawn on it). It sits beside
 * the control-service socket (`ucenter.js`), not instead of it: TAKE, CUT and
 * the T-bar still come from there, if a mini reports them at all.
 *
 * ## One client at a time, and who wins
 *
 * The console's LCD app serves one client (firmware V1.0.3, `TcpServer::
 * acceptThread`). Connecting from the LAN takes the grid from a client on the
 * console itself — its built-in Companion, which Pixelhue's build keeps
 * connected to 127.0.0.1 — and that Companion's retries are then refused for
 * as long as this holds the grid: no fight. A client from another LAN address
 * takes it from this one, though, and this would take it straight back on its
 * next dial, and so would that one. So a grid the console keeps closing is let
 * go after `TAKEOVERS` closes in `TAKEOVER_WINDOW_MS`, and the panel says so,
 * the way the display lock lets go of a layout something else keeps
 * reverting. The same count catches the other way the console closes a new
 * connection: one from this address while it still holds an older one that
 * dropped without saying goodbye.
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';

import {
  SurfaceStream, decodePacket, encodeDraw, keyEventFrom, PING, SURFACE_PORT,
} from '../../src/vendor/pixelhue/surface.js';

/* The vendor plugin's own pace: a ping every 5 s; two unanswered, and the link is dead. */
const HEARTBEAT_MS = 5000;
const MISSED_PONGS = 2;
const RECONNECT_MS = 3000;
export const TAKEOVERS = 3;
export const TAKEOVER_WINDOW_MS = 60_000;

export class GridLink extends EventEmitter {
  #socket = null;
  #stream = new SurfaceStream();
  #heartbeat = null;
  #retry = null;
  #stopped = true;
  #awaitingPong = 0;
  #closes = [];
  #closing = false;

  constructor({
    host, port = SURFACE_PORT, log = () => {}, reconnectMs = RECONNECT_MS, heartbeatMs = HEARTBEAT_MS,
    takeovers = TAKEOVERS, takeoverWindowMs = TAKEOVER_WINDOW_MS,
  } = {}) {
    super();
    this.host = host;
    this.port = Number(port) || SURFACE_PORT;
    this.log = log;
    this.reconnectMs = reconnectMs;
    this.heartbeatMs = heartbeatMs;
    this.takeovers = takeovers;
    this.takeoverWindowMs = takeoverWindowMs;
    this.state = {
      host, port: this.port, connected: false, lastError: null, drawn: 0, presses: 0,
      /* Closes the console made, in the current window. */
      takenBack: 0,
      /* `{at, count}` once the link has stopped dialling because the console kept closing it. */
      letGo: null,
    };
  }

  start() {
    this.#stopped = false;
    this.state.letGo = null;
    this.#closes = [];
    this.#open();
    return this;
  }

  async stop() {
    this.#stopped = true;
    clearTimeout(this.#retry); this.#retry = null;
    clearInterval(this.#heartbeat); this.#heartbeat = null;
    const socket = this.#socket;
    this.#socket = null;
    this.state.connected = false;
    if (socket && !socket.destroyed) {
      this.#closing = true;
      await new Promise((resolve) => { socket.once('close', resolve); socket.destroy(); });
      this.#closing = false;
    }
  }

  /**
   * Draw keys: `[{row, column, page, png}]`, one request each, as the vendor
   * plugin sends them. False when there is no grid to draw on; what was not
   * drawn is drawn again whole when the link next opens.
   */
  draw(keys) {
    const socket = this.#socket;
    if (!socket || !this.state.connected) return false;
    for (const k of keys) {
      socket.write(encodeDraw({ column: k.column, row: k.row, page: k.page, png: k.png }));
      this.state.drawn++;
    }
    return true;
  }

  /* --------------------------------------------------------------- socket */

  #open() {
    if (this.#stopped) return;
    const socket = net.createConnection({ host: this.host, port: this.port, keepAlive: true });
    this.#socket = socket;
    this.#stream = new SurfaceStream();
    let ended = false;
    socket.setNoDelay(true);
    socket.on('connect', () => {
      this.state.connected = true;
      this.state.lastError = null;
      this.#awaitingPong = 0;
      this.log(`console grid ${this.host}:${this.port} connected`);
      socket.write(PING);
      clearInterval(this.#heartbeat);
      this.#heartbeat = setInterval(() => this.#beat(socket), this.heartbeatMs);
      this.#heartbeat.unref?.();
      this.emit('open');
    });
    socket.on('data', (chunk) => this.#onData(chunk));
    /* The console closing its side: a takeover, or a connection it would not take. */
    socket.on('end', () => { ended = true; });
    socket.on('error', (err) => {
      this.state.lastError = err.message;
      this.emit('failure', err);
    });
    socket.on('close', () => {
      const was = this.state.connected;
      if (this.#socket === socket) this.#socket = null;
      this.state.connected = false;
      clearInterval(this.#heartbeat); this.#heartbeat = null;
      if (this.#stopped || this.#closing) return;
      if (was || ended) this.emit('close', { byConsole: ended });
      if (ended && this.#takenBack()) return;
      this.#schedule();
    });
  }

  #beat(socket) {
    if (socket !== this.#socket || !this.state.connected) return;
    if (this.#awaitingPong >= MISSED_PONGS) {
      this.state.lastError = `no answer to ${MISSED_PONGS} pings`;
      this.emit('failure', new Error(`the console's grid did not answer ${MISSED_PONGS} pings; reconnecting`));
      socket.destroy();
      return;
    }
    this.#awaitingPong++;
    socket.write(PING);
  }

  #onData(chunk) {
    const { packets, heartbeats } = this.#stream.push(chunk);
    if (heartbeats.includes('pong')) this.#awaitingPong = 0;
    for (const p of packets) {
      let packet;
      try {
        packet = decodePacket(p);
      } catch {
        continue;
      }
      const key = keyEventFrom(packet.data);
      if (!key || !Number.isInteger(key.row) || !Number.isInteger(key.column)) continue;
      this.state.presses++;
      this.emit('press', key);
    }
  }

  /** Count a close the console made; true when that is one too many and the link has let go. */
  #takenBack() {
    const now = Date.now();
    this.#closes = this.#closes.filter((at) => now - at < this.takeoverWindowMs);
    this.#closes.push(now);
    this.state.takenBack = this.#closes.length;
    if (this.#closes.length < this.takeovers) return false;
    this.#stopped = true;
    this.state.letGo = { at: now, count: this.#closes.length, windowMs: this.takeoverWindowMs };
    this.log(`console grid ${this.host}:${this.port}: closed by the console ${this.#closes.length} times; let go`);
    this.emit('letgo', this.state.letGo);
    return true;
  }

  #schedule() {
    if (this.#stopped || this.#retry) return;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#open();
    }, this.reconnectMs);
    this.#retry.unref?.();
  }
}

/**
 * The words for a link that has let go, for the history and the card. Both
 * causes, because from here the two look the same.
 */
export function letGoNote({ count, windowMs } = {}) {
  const span = Math.round((windowMs || TAKEOVER_WINDOW_MS) / 1000);
  return `The console closed this app's connection to its key grid ${count} times in ${span} s, so this app has stopped `
    + 'drawing on it. Either something else on the network holds the grid — a Companion with the U5 mini surface, '
    + 'pixelhue-bridge or another copy of this app; close it — or the console still holds an older connection from '
    + 'this computer, which it drops only once it notices. Then turn "Drive a Pixelhue console" off and on.';
}
