/*
 * What every matrix driver is, and the TCP plumbing all three share.
 *
 * Three routers, three wire formats, one job: tell us how big you are, what
 * your ports are called, what is routed where, and take a crosspoint. The
 * differences between them are real but small, and they are all in the
 * subclasses.
 *
 * ## The rule the whole layer is built on
 *
 * **A driver never writes its own state.** `route()` sends and returns; every
 * field of `state` is only ever set from what the router said. This is
 * borrowed, with the reasoning, from BlackMatrix's Videohub client, and it is
 * not fastidiousness — a request can be refused by a lock, clamped, ignored
 * by a frame in a mode that forbids it, or overridden a moment later by
 * somebody at the front panel. A UI that shows what it asked for rather than
 * what happened is a UI that lies during exactly the minute it matters.
 *
 * The visible consequence is that a click does not move the grid until the
 * router agrees. That is the feature.
 *
 * ## Push and poll
 *
 * A Videohub and an LW3 Lightware push changes unasked, so their grids stay
 * live for free. LW2 and Turtle AV answer questions and volunteer nothing,
 * so those are polled — and polling is a compromise, not a design: a change
 * made at the front panel is invisible until the next tick. `pollMs` is
 * therefore a driver's own declaration rather than a setting, because the
 * right value is a property of the protocol.
 *
 * ## Numbering
 *
 * ⚠️ **This interface is 1-based, in both directions.** `route(output, input)`
 * takes the numbers printed on the front of the router. A protocol that
 * counts from 0 — and the Videohub does — converts inside its own driver and
 * nowhere else. See `core/patch.js`.
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';

export const STATUS = ['disconnected', 'connecting', 'connected'];

/** How long a router gets to answer before we call the link dead. */
const IDLE_TIMEOUT_MS = 30000;

/**
 * An empty state, which is also the shape every driver reports.
 *
 * `routing` is a plain object keyed by 1-based destination, value the 1-based
 * source — not an array, because an array invites the reader to assume index
 * 0 is destination 0 and that is the exact mistake this layer exists to stop.
 */
export function emptyState() {
  return {
    model: '',
    name: '',
    inputs: 0,
    outputs: 0,
    inputLabels: {},
    outputLabels: {},
    routing: {},
    /** Set by a driver that knows a destination is locked against it. */
    locks: {},
  };
}

export class MatrixDriver extends EventEmitter {
  /**
   * @param {{id:string, name?:string, host:string, port:number,
   *          log?:(m:string)=>void, reconnectMs?:number}} options
   */
  constructor(options) {
    super();
    this.id = options.id;
    this.name = options.name || options.id;
    this.host = options.host;
    this.port = options.port;
    this.log = options.log ?? (() => {});
    this.reconnectMs = options.reconnectMs ?? 5000;

    /** Subclasses that are polled set this to a period in ms. */
    this.pollMs = 0;

    this.current = emptyState();
    this.connectionStatus = 'disconnected';
    this.lastError = null;

    this.socket = null;
    this.retryTimer = null;
    this.pollTimer = null;
    this.closing = false;
  }

  /** What this driver speaks. Subclasses override. */
  static get kind() { return 'abstract'; }
  get kind() { return this.constructor.kind; }

  get status() { return this.connectionStatus; }

  /** Null until the router has said enough to be worth showing. */
  get state() {
    return this.connectionStatus === 'connected' && this.current.outputs > 0 ? this.current : null;
  }

  /** Everything a panel needs about this matrix in one object. */
  describe() {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      host: this.host,
      port: this.port,
      status: this.connectionStatus,
      error: this.lastError,
      state: this.state,
    };
  }

  connect() {
    this.closing = false;
    this.open();
  }

  close() {
    this.closing = true;
    this.clearTimers();
    /* destroy(), not end(): a router that has stopped answering will not
       complete a graceful close either, and the launcher's Stop button has to
       actually stop. */
    this.socket?.destroy();
    this.socket = null;
    this.setStatus('disconnected');
  }

  open() {
    this.clearTimers();
    this.setStatus('connecting');
    this.current = emptyState();

    const socket = net.connect({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    /* A router sends nothing while idle, so a dead link looks exactly like a
       quiet one until TCP notices on its own schedule. Keepalive is what makes
       it notice in seconds rather than minutes. */
    socket.setKeepAlive(true, 10000);
    socket.setTimeout(IDLE_TIMEOUT_MS);

    socket.on('connect', () => {
      this.lastError = null;
      this.setStatus('connected');
      this.log(`${this.kind} ${this.id} (${this.host}:${this.port}) connected`);
      try { this.onOpen(); } catch (err) { this.log(`${this.id} onOpen threw: ${err.message}`); }
      if (this.pollMs) {
        this.pollTimer = setInterval(() => {
          try { this.onPoll(); } catch (err) { this.log(`${this.id} poll threw: ${err.message}`); }
        }, this.pollMs);
        /* The poll must not be the reason this process cannot exit. */
        this.pollTimer.unref?.();
      }
    });

    socket.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      try { this.onData(text); } catch (err) { this.log(`${this.id} parse threw: ${err.message}`); }
    });

    socket.on('timeout', () => {
      /* Idle past the timeout is not proof of death, but it is the only signal
         available on a protocol with no heartbeat. Ask something cheap; if the
         link is really gone the write fails and 'error' follows. */
      try { this.onIdle(); } catch { /* the drop below is the real handler */ }
    });

    const drop = (why) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      this.setStatus('disconnected');
      this.log(`${this.kind} ${this.id} ${why}`);
      this.retry();
    };
    socket.on('close', () => drop('closed'));
    socket.on('error', (err) => {
      this.lastError = err.message;
      drop(`error: ${err.message}`);
    });
  }

  retry() {
    if (this.closing || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, this.reconnectMs);
    this.retryTimer.unref?.();
  }

  clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.retryTimer = null;
    this.pollTimer = null;
  }

  setStatus(status) {
    if (this.connectionStatus === status) return;
    this.connectionStatus = status;
    this.emit('status', status);
    this.emit('change', this.describe());
  }

  /** Subclasses call this once they have folded something new into `current`. */
  changed() {
    this.emit('state', this.current);
    this.emit('change', this.describe());
  }

  write(text) {
    if (!this.socket || this.connectionStatus !== 'connected') {
      this.log(`${this.id}: dropped a command — not connected`);
      return false;
    }
    this.socket.write(text);
    return true;
  }

  /* ---- the four things a subclass implements ---------------------------- */

  /** Connected: ask for everything. */
  onOpen() {}

  /** Bytes arrived. */
  onData() {}

  /** Only called when `pollMs` is set. */
  onPoll() {}

  /** Nothing has arrived for a long time; poke it. Default: re-ask. */
  onIdle() { this.onPoll(); }

  /**
   * Take a crosspoint. 1-based, both arguments.
   *
   * Returns whether the command reached the socket — never whether the router
   * did it, which arrives later as state, if at all.
   */
  route() { throw new Error('route() not implemented'); }
}

/**
 * Feed bytes in, get whole lines out. CRLF and bare LF both terminate, which
 * is not pedantry: Lightware answers CRLF, Turtle answers CRLF, and a telnet
 * session against either sends whatever the client feels like.
 */
export class LineParser {
  constructor() { this.buffer = ''; }

  push(chunk) {
    this.buffer += chunk;
    const out = [];
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      out.push(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    }
    /* A router that answers without a terminator would otherwise grow this
       for ever. Nothing legitimate is this long. */
    if (this.buffer.length > 64 * 1024) this.buffer = '';
    return out;
  }
}
