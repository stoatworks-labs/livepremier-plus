/*
 * One deck's connection: HyperDeck protocol over TCP 9993, kept up.
 *
 * Held open for the reason `plugins/matrix-routing/routers/index.js` gives for
 * a router: a deck is not in the switcher's store, nothing else in this
 * process knows what it is doing, and it changes without us — somebody at its
 * front panel, Mitti's own GO, a clip simply ending. A deck is also happy with
 * several clients, so holding one costs nobody a slot.
 *
 * ## The rule it keeps
 *
 * **Nothing here writes the deck's state.** `send()` resolves when the deck
 * answers the command; the transport, the clip and the timecode are only ever
 * what the deck reported. A deck that refuses `play` because it has no disk
 * must not show as playing.
 *
 * ## Knowing a clip ended
 *
 * The protocol has no end-of-clip message. What it has is the transport: a
 * deck playing one clip stops at its end (Mitti pauses at the end of a cue the
 * same way), and a deck playing through its timeline moves to the next clip id
 * without stopping. Both are read as *the clip ended*, unless we caused them —
 * a `stop` or a `goto` we sent in the last moment is ours, not the clip's. A
 * stop well before the end (somebody pressed Stop on the deck) is not an end
 * either, which is what `remaining` is for when the deck lists clip starts.
 *
 * While a deck plays it is asked for its transport four times a second, which
 * is what the countdown and a transition timed to land on the last frame read.
 * Pushed `508`s make the stop itself arrive at once on a deck that sends them.
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';
import {
  HYPERDECK_PORT, ReplyParser, isAsync, isError, readTransport, readClips, readDevice, readSlot,
  clipPosition, COMMANDS, RECORD_COMMANDS, profileOf,
} from './protocol.js';

const REPLY_TIMEOUT_MS = 3000;
const PLAY_POLL_MS = 250;
const IDLE_POLL_MS = 2000;
const CLIPS_EVERY_MS = 15000;
/* A transport change this soon after a stop or goto we sent is ours. */
const OURS_MS = 1500;
/* A stop with this little left is the clip ending, not somebody pressing Stop. */
const END_SLACK_S = 1.0;

export class DeckLink extends EventEmitter {
  /**
   * @param {{id:string, name?:string, host:string, port?:number, profile?:string,
   *          log?:(m:string)=>void, reconnectMs?:number}} options
   */
  constructor(options) {
    super();
    this.id = options.id;
    this.name = options.name || options.id;
    this.host = options.host;
    this.port = options.port || HYPERDECK_PORT;
    this.profile = profileOf(options.profile);
    this.log = options.log ?? (() => {});
    this.reconnectMs = options.reconnectMs ?? 5000;

    this.status = 'disconnected';
    this.error = null;
    this.reset();

    this.socket = null;
    this.retryTimer = null;
    this.pollTimer = null;
    this.closing = false;
  }

  reset() {
    this.device = null;
    this.transport = {};
    this.clips = [];
    this.slot = {};
    this.remoteDisabled = false;
    /* Bumped every time a clip starts playing; the page times a lead-in once per run. */
    this.run = 0;
    this.lastOurs = 0;
    this.clipsAt = 0;
    this.queue = [];
    this.inFlight = null;
    this.parser = new ReplyParser();
  }

  describe() {
    const position = clipPosition(this.transport, this.clips);
    return {
      id: this.id,
      name: this.name,
      host: this.host,
      port: this.port,
      profile: this.profile.id,
      status: this.status,
      error: this.error,
      device: this.device,
      transport: this.transport,
      clips: this.clips,
      slot: this.slot,
      position,
      run: this.run,
      remoteDisabled: this.remoteDisabled,
    };
  }

  connect() {
    this.closing = false;
    this.open();
  }

  close() {
    this.closing = true;
    this.clearTimers();
    this.failAll('the link was closed');
    this.socket?.destroy();
    this.socket = null;
    this.setStatus('disconnected');
  }

  open() {
    this.clearTimers();
    this.reset();
    this.setStatus('connecting');
    const socket = net.connect({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);

    socket.on('connect', () => {
      this.error = null;
      this.setStatus('connected');
      this.log(`hyperdeck ${this.id} (${this.host}:${this.port}) connected`);
      this.hello();
    });
    socket.on('data', (text) => {
      for (const reply of this.parser.push(text)) {
        try { this.onReply(reply); } catch (err) { this.log(`hyperdeck ${this.id}: ${err.message}`); }
      }
    });
    const drop = (why) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      this.failAll(why);
      this.setStatus('disconnected');
      this.log(`hyperdeck ${this.id} ${why}`);
      this.retry();
    };
    socket.on('close', () => drop('closed'));
    socket.on('error', (err) => { this.error = err.message; drop(`error: ${err.message}`); });
  }

  /** Connected: ask for everything, and to be told of changes. */
  hello() {
    if (this.profile.notify) void this.request('notify: transport: true slot: true');
    void this.request('device info');
    void this.refreshClips();
    void this.request('slot info');
    void this.request('transport info');
    this.schedulePoll();
  }

  schedulePoll() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const playing = this.transport.status === 'play' || this.transport.status === 'record';
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (this.status !== 'connected') return;
      /* One poll outstanding at a time: a deck that is slow to answer is not
         sent a second question on top of the first. */
      const polls = this.queue.filter((q) => q.poll).length + (this.inFlight?.poll ? 1 : 0);
      if (!polls) {
        void this.request('transport info', { poll: true });
        if (Date.now() - this.clipsAt > CLIPS_EVERY_MS) void this.refreshClips();
      }
      this.schedulePoll();
    }, playing ? PLAY_POLL_MS : IDLE_POLL_MS);
    this.pollTimer.unref?.();
  }

  refreshClips() {
    this.clipsAt = Date.now();
    return this.request('clips get', { poll: true });
  }

  retry() {
    if (this.closing || this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.open(); }, this.reconnectMs);
    this.retryTimer.unref?.();
  }

  clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.retryTimer = null;
    this.pollTimer = null;
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('change', this.describe());
  }

  changed() { this.emit('change', this.describe()); }

  /* ---------------------------------------------------------- requests */

  /**
   * Send one line and resolve with the deck's reply to it. One at a time: the
   * protocol answers in order, and keeping one in flight is what makes a slow
   * or silent deck time out on the command it did not answer rather than on
   * whichever came after it.
   */
  request(line, { poll = false } = {}) {
    return new Promise((resolve) => {
      if (this.status !== 'connected' || !this.socket) {
        resolve({ code: 0, text: 'not connected', fields: {}, lines: [] });
        return;
      }
      this.queue.push({ line, resolve, poll });
      this.pump();
    });
  }

  pump() {
    if (this.inFlight || !this.queue.length || !this.socket) return;
    const next = this.queue.shift();
    next.timer = setTimeout(() => {
      if (this.inFlight !== next) return;
      this.inFlight = null;
      next.resolve({ code: 0, text: 'no answer', fields: {}, lines: [] });
      this.pump();
    }, REPLY_TIMEOUT_MS);
    next.timer.unref?.();
    this.inFlight = next;
    this.socket.write(`${next.line}\r\n`);
  }

  failAll(why) {
    const pending = [...(this.inFlight ? [this.inFlight] : []), ...this.queue];
    this.inFlight = null;
    this.queue = [];
    for (const p of pending) {
      if (p.timer) clearTimeout(p.timer);
      p.resolve({ code: 0, text: why, fields: {}, lines: [] });
    }
  }

  onReply(reply) {
    if (isAsync(reply)) { this.fold(reply); return; }
    const done = this.inFlight;
    if (done) {
      clearTimeout(done.timer);
      this.inFlight = null;
    }
    this.fold(reply);
    done?.resolve(reply);
    this.pump();
  }

  /** Whatever the deck said, answered or volunteered, into what we hold. */
  fold(reply) {
    switch (reply.code) {
      case 500: this.device = { ...(this.device || {}), ...readDevice(reply.fields) }; break;
      case 204: this.device = { ...(this.device || {}), ...readDevice(reply.fields) }; break;
      case 205: this.clips = readClips(reply.lines); break;
      case 202: case 502: {
        const slot = readSlot(reply.fields);
        /* A disk that came or went changes the clip list. */
        if (slot.status && slot.status !== this.slot.status) this.clipsAt = 0;
        this.slot = { ...this.slot, ...slot };
        break;
      }
      case 208: case 508: this.foldTransport(readTransport(reply.fields)); return;
      case 111: this.remoteDisabled = true; break;
      default: return;
    }
    this.changed();
  }

  foldTransport(next) {
    const before = this.transport;
    const was = before.status;
    const after = { ...before, ...next };
    const wasPlaying = was === 'play';
    const nowPlaying = after.status === 'play';
    const ours = Date.now() - this.lastOurs < OURS_MS;

    if (wasPlaying && !nowPlaying && !ours) {
      /* Stopped by itself. The end of the clip, unless we can see plenty was left. */
      const { remaining } = clipPosition(before, this.clips);
      if (remaining == null || remaining <= END_SLACK_S) this.emit('ended', { deck: this.id, clip: before.clip, run: this.run });
    }
    const clipChanged = before.clip != null && after.clip != null && after.clip !== before.clip;
    if (wasPlaying && nowPlaying && clipChanged && !ours) {
      /* Played on into the next clip. */
      this.emit('ended', { deck: this.id, clip: before.clip, run: this.run, next: after.clip });
    }
    if ((!wasPlaying && nowPlaying) || (nowPlaying && clipChanged)) this.run += 1;
    if (was === 'record' && after.status !== 'record') this.clipsAt = 0;

    const moved = JSON.stringify(before) !== JSON.stringify(after);
    this.transport = after;
    if (was !== after.status) this.schedulePoll();
    if (moved) this.changed();
  }

  /* ---------------------------------------------------------- commands */

  /**
   * A named command from `protocol.js`, answered `{ ok, error? }` once the
   * deck has replied. A deck that says remote control is off is told to allow
   * it and asked once more — the one setting this app will change on a deck,
   * and only because the command it was just sent says the operator wants it
   * controlled.
   */
  async send(name, args = {}) {
    const build = COMMANDS[name];
    if (!build) return { ok: false, error: `no command "${name}"` };
    if (RECORD_COMMANDS.has(name) && !this.profile.record) {
      return { ok: false, error: `${this.name} does not record (${this.profile.label})` };
    }
    const line = build(args);
    if (!line) return { ok: false, error: `${name}: bad argument` };
    if (this.status !== 'connected') return { ok: false, error: `${this.name} is not connected` };
    if (name !== 'play' && name !== 'record') this.lastOurs = Date.now();
    let reply = await this.request(line);
    if (reply.code === 111) {
      this.log(`hyperdeck ${this.id}: remote control was off — enabling it`);
      await this.request('remote: enable: true');
      reply = await this.request(line);
      if (reply.code !== 111) { this.remoteDisabled = false; this.changed(); }
    }
    /* Ask straight away rather than wait for the next poll. */
    void this.request('transport info', { poll: true });
    if (isError(reply) || reply.code === 0) return { ok: false, error: `${this.name}: ${reply.text}` };
    return { ok: true };
  }
}
