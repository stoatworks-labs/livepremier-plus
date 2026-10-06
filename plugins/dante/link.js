/*
 * Dante — one device's control link: a UDP socket, requests matched to
 * answers by transaction id, a timeout and a retry, and one request in flight
 * at a time.
 *
 * ## Why this holds a socket per device, when `server/awj.js` holds none
 *
 * `awj.js` refuses to keep a connection to the switcher because the switcher's
 * state already has one source, the vendor socket, and a second reader could
 * disagree with it about what is on air. None of that reaches a Dante device:
 *
 * - **Nothing else here knows its routing.** A Dante subscription is held by
 *   the receiving device and nowhere else — not in the switcher's store, not
 *   in the page. There is no mirror for this to contradict.
 * - **It changes without us.** Dante Controller, a console's own Dante page,
 *   another copy of this app: a grid read once when the panel opened would be
 *   wrong from the next change on. So it is read again on a timer.
 * - **There is no client budget to spend.** ARC is datagrams with a
 *   transaction id; the device keeps no session for us, and the five-client
 *   limit `awj.js` respects is the Analog Way frame's, not a Dante card's.
 *
 * What it keeps from `awj.js`, and from Matrix Routing's drivers, is the rule
 * that matters: **nothing here writes its own state.** A write is sent, the
 * device's answer code is noted, and the receive channels are read again;
 * what the panel shows is that read, never the request.
 *
 * ## Manners
 *
 * Small embedded devices answer this, and some answer slowly, so: one
 * request in flight per device, a short gap between requests, a timeout and
 * two retries before a device counts as not answering, and an answer accepted
 * only from the device's own address with the transaction id we sent.
 */

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { transactionOf } from './protocol.js';

export const TIMEOUT_MS = 700;
export const RETRIES = 2;
export const GAP_MS = 8;

export class DanteLink extends EventEmitter {
  /**
   * @param {{address:string, port:number, timeoutMs?:number, retries?:number, gapMs?:number, log?:Function}} o
   */
  constructor({ address, port, timeoutMs = TIMEOUT_MS, retries = RETRIES, gapMs = GAP_MS, log = () => {} }) {
    super();
    this.address = address;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.gapMs = gapMs;
    this.log = log;
    this.socket = null;
    this.queue = [];
    this.busy = false;
    this.txn = Math.floor(Math.random() * 0xfff0) + 1;
    this.pending = null;          // { txn, resolve, reject, timer }
    this.lastSent = 0;
    this.closed = false;
    this.sent = 0;
    this.answered = 0;
  }

  open() {
    if (this.socket || this.closed) return;
    const socket = dgram.createSocket('udp4');
    socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
    socket.on('error', (err) => this.log(`dante ${this.address}:${this.port}: ${err.message}`));
    socket.bind(0);
    socket.unref?.();
    this.socket = socket;
  }

  /** The next transaction id: 1..65535, never 0, which netaudio refuses. */
  nextTxn() {
    this.txn = this.txn >= 0xffff ? 1 : this.txn + 1;
    return this.txn;
  }

  /**
   * Send `build(txn)` and resolve with the answer's bytes. Queued behind
   * whatever is in flight; rejects with "no answer" after the retries.
   */
  request(build) {
    return new Promise((resolve, reject) => {
      this.queue.push({ build, resolve, reject });
      this.pump();
    });
  }

  pump() {
    if (this.busy || !this.queue.length) return;
    if (this.closed) {
      for (const q of this.queue.splice(0)) q.reject(new Error('the link is closed'));
      return;
    }
    this.open();
    this.busy = true;
    const job = this.queue.shift();
    const txn = this.nextTxn();
    let packet;
    try { packet = job.build(txn); } catch (err) {
      this.busy = false;
      job.reject(err);
      this.pump();
      return;
    }
    let attempts = 0;
    /* A request in flight keeps the process alive until it is answered or
       given up on — at most (retries + 1) × timeout. An idle link does not:
       its socket is unref'd. */
    const pending = { txn, timer: null, wait: null, done: false, finish: null };
    const finish = (err, bytes) => {
      if (pending.done) return;
      pending.done = true;
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.wait) clearTimeout(pending.wait);
      if (this.pending === pending) this.pending = null;
      this.busy = false;
      if (err) job.reject(err); else job.resolve(bytes);
      setTimeout(() => this.pump(), this.gapMs);
    };
    pending.finish = finish;
    const attempt = () => {
      if (pending.done) return;
      if (this.closed) { finish(new Error('the link is closed')); return; }
      attempts += 1;
      const wait = Math.max(0, this.lastSent + this.gapMs - Date.now());
      const t = setTimeout(() => {
        if (pending.done) return;
        if (this.closed || !this.socket) { finish(new Error('the link is closed')); return; }
        this.lastSent = Date.now();
        this.sent += 1;
        this.socket.send(packet, this.port, this.address, (err) => { if (err) finish(err); });
        pending.timer = setTimeout(() => {
          if (attempts <= this.retries) attempt();
          else finish(new Error(`no answer from ${this.address}:${this.port}`));
        }, this.timeoutMs);
      }, wait);
      pending.wait = t;
    };
    this.pending = pending;
    attempt();
  }

  onMessage(msg, rinfo) {
    if (rinfo.address !== this.address || !this.pending) return;
    const bytes = new Uint8Array(msg);
    if (bytes.length < 6 || transactionOf(bytes) !== this.pending.txn) return;
    this.answered += 1;
    this.pending.finish(null, bytes);
  }

  close() {
    this.closed = true;
    if (this.pending) this.pending.finish(new Error('the link is closed'));
    for (const q of this.queue.splice(0)) q.reject(new Error('the link is closed'));
    if (this.socket) { try { this.socket.close(); } catch { /* already closed */ } }
    this.socket = null;
  }
}
