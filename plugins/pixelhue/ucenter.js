/*
 * The link to a console's UCenter service.  ** PREVIEW **
 *
 * One WebSocket for what the console says, `fetch` for what we tell it.
 *
 *   ws://<console>:<port>/unico/v1/ucenter/ws?client-type=5
 *   PUT http://<console>:<port>/unico/v1/ucenter/video-station/data-change
 *
 * ## Why this holds a connection open, when `server/awj.js` refuses to
 *
 * `awj.js` argues at length that it must never hold a socket or subscribe, and
 * `plugins/matrix-routing/routers/index.js` had to beat that argument before it could keep a
 * router connected. Both arguments are about **the store mirror** — about not
 * becoming a second source of truth for switcher state the vendor socket
 * already carries.
 *
 * A console is not in the store, and never will be. Nothing else in this
 * process or in a browser tab knows that an operator has three screens
 * selected on a panel; the panel is the only source there is. And a console
 * that reported presses only while somebody had a Web RCS tab open would not
 * be a console. The five-client budget `awj.js` respects is a limit on the
 * Analog Way frame, not on a Pixelhue panel.
 *
 * What this *does* inherit is the rule that matters: it never writes state it
 * has not been told. The model it publishes comes from the switcher; the
 * selection it keeps comes from the panel; neither is invented here.
 *
 * ## `client-type=5`
 *
 * Unico's own `ClientTypeE` is `{PCUnico: 0, UnicoEC: 2, PCPixelFlow: 8,
 * PixelFlowEC: 9}` and **5 is not in it** — 5 is hard-coded in the console's
 * on-screen keyboard app. It is nonetheless the right one to use: a
 * `client-type=5` connection was observed receiving *both* the raw key states
 * and the semantic commands, so nothing has to be given up to get it.
 */

import { EventEmitter } from 'node:events';

import { WsClient } from './ws-client.js';
import { decodeFrame, PING } from '../../src/vendor/pixelhue/apollo.js';
import { TAGS } from '../../src/vendor/pixelhue/tags.js';

/** 19999 on a U5 / U5 Pro (loopback only), 8088 on a U5 mini (on the LAN). */
export const DEFAULT_PORT = 19999;
export const MINI_PORT = 8088;

/**
 * ⚠️ The T-bar reports on `0x00101358`, not the `TAGS.TBAR` (`0x00101304`)
 * the vendored `tags.js` guessed: `{index, direction, percent, mapValue,
 * maxValue, minValue}`, read off a virtual U5 on 2026-09-23. The correction
 * belongs upstream in pixelhue-bridge; the vendored file stays as it came.
 */
export const TBAR_REPORT = 0x00101358;

/** A bound fader or encoder moved: `{unique, value, type, frameValue}`. */
export const MIDI_REPORT = 0x0010031c;

const PING_MS = 1000;
const RECONNECT_MS = 3000;
const REST_TIMEOUT_MS = 8000;

export class UCenterLink extends EventEmitter {
  #ws = null;
  #ping = null;
  #retry = null;
  #stopped = true;

  constructor({ host, port = DEFAULT_PORT, clientType = 5, log = () => {} } = {}) {
    super();
    this.host = host;
    this.port = Number(port) || DEFAULT_PORT;
    this.clientType = clientType;
    this.log = log;
    this.state = {
      host, port: this.port, connected: false, lastError: null,
      frames: 0, commands: 0, keys: 0, published: 0, lastCommand: null,
    };
  }

  get base() { return `http://${this.host}:${this.port}/unico/v1`; }
  get wsUrl() {
    return `ws://${this.host}:${this.port}/unico/v1/ucenter/ws?client-type=${this.clientType}`;
  }

  start() {
    this.#stopped = false;
    this.#connect();
    return this;
  }

  async stop() {
    this.#stopped = true;
    clearTimeout(this.#retry); this.#retry = null;
    clearInterval(this.#ping); this.#ping = null;
    const ws = this.#ws;
    this.#ws = null;
    this.state.connected = false;
    if (ws) ws.close(1000, 'stopping');
  }

  /* --------------------------------------------------------------- socket */

  #connect() {
    if (this.#stopped) return;
    let ws;
    try {
      ws = new WsClient(this.wsUrl).connect();
    } catch (err) {
      this.#fail(err);
      return;
    }
    this.#ws = ws;

    ws.on('open', () => {
      this.state.connected = true;
      this.state.lastError = null;
      this.log(`console ${this.host}:${this.port} connected`);
      /* The vendor's clients send this exact 79-byte frame once a second. It
         is reproduced byte for byte upstream and that test is the codec's
         anchor to reality, so it is sent rather than something equivalent. */
      this.#ping = setInterval(() => {
        try { ws.send(PING); } catch { /* the close handler will deal with it */ }
      }, PING_MS);
      if (this.#ping.unref) this.#ping.unref();
      this.emit('open');
    });

    ws.on('message', (buf, { binary }) => {
      if (!binary) return;
      this.state.frames++;
      let frame;
      try {
        frame = decodeFrame(buf);
      } catch (err) {
        /* A frame this cannot read is worth one line and no more: the console
           sends telemetry we have never catalogued, and failing loudly on it
           would make a working panel look broken. */
        this.emit('undecodable', { error: err.message, bytes: buf.length });
        return;
      }
      this.emit('frame', frame);
      this.#route(frame);
    });

    ws.on('error', (err) => this.#fail(err));
    ws.on('close', () => {
      const was = this.state.connected;
      this.state.connected = false;
      clearInterval(this.#ping); this.#ping = null;
      if (was) this.emit('close');
      this.#schedule();
    });
  }

  #route(frame) {
    switch (frame.tag) {
      case TAGS.COMMAND_DATA: {
        /* ⚠️ The vendored `tags.js` still describes this as "{layers, inputs,
           additionInfos}". That is the shape of the *outgoing* data-change
           body; what arrives here is the console's semantic command report,
           `{index, command, payload}`. The correction belongs upstream in
           pixelhue-bridge, not in a vendored file. */
        this.state.commands++;
        this.state.lastCommand = frame.data;
        this.emit('command', frame.data);
        break;
      }
      case TAGS.KEY_STATE:
        this.state.keys++;
        this.emit('keystate', [].concat(frame.data || []));
        break;
      case MIDI_REPORT:
        if (frame.data && typeof frame.data === 'object') this.emit('midi', frame.data);
        break;
      case TBAR_REPORT:
      case TAGS.TBAR:
        if (frame.data && typeof frame.data === 'object') this.emit('tbar', frame.data);
        break;
      default:
        break;
    }
  }

  #fail(err) {
    this.state.lastError = err.message;
    this.log(`console ${this.host}:${this.port}: ${err.message}`);
    this.emit('failure', err);
    this.#schedule();
  }

  #schedule() {
    if (this.#stopped || this.#retry) return;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#connect();
    }, RECONNECT_MS);
    if (this.#retry.unref) this.#retry.unref();
  }

  /* ----------------------------------------------------------------- REST */

  async #send(path, body, method = 'PUT') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    try {
      const res = await fetch(`${this.base}/${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = await res.json().catch(() => ({ code: -1, message: 'unreadable reply' }));
      /*
       * ⚠️ A rejected field comes back as a Go unmarshal error naming the
       * struct and the field — `{"Struct":"RInput","Field":"inputs.hasBackup"}`
       * — and it is by far the most useful thing this API says. Pass it
       * through whole rather than flattening it to "failed".
       */
      if (json && json.code !== 0) {
        const detail = typeof json.data === 'object' && json.data
          ? ` (${JSON.stringify(json.data)})` : '';
        throw new Error(`${path}: ${json.message || 'refused'}${detail}`);
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Publish the whole business model. There is no partial update in this API. */
  async publish(model) {
    const res = await this.#send('ucenter/video-station/data-change', model);
    this.state.published++;
    return res;
  }

  /**
   * Bind faders and encoders to `attributes` (`[{unique, type, index}]`).
   * ⚠️ UCenter answers this itself; it must not carry `ip`/`port` headers,
   * or a UCenter that proxies to devices forwards it instead.
   */
  bindControls(attributes) {
    return this.#send('ucenter/video-station/midi/binding', { attributes }, 'POST');
  }

  /**
   * Inject a key press, as the console's own on-screen keyboard does.
   *
   * This is how the whole chain is exercised without a panel, and it is the
   * only reason a rig with no hardware can test anything. Not used in service.
   */
  pressKey(key) {
    return this.#send('ucenter/video-station/key/action', [
      { key: Number(key), state: 0 }, { key: Number(key), state: 1 },
    ]);
  }

  /**
   * Stop UCenter acting on key presses itself (`state: 1` blocks).
   *
   * Deliberately not called anywhere. Publishing a model is the supported way
   * to drive this console, and blocking its own logic would also take away the
   * labelling, paging and long-press behaviour that make the model worth
   * publishing. It is here because the option is real and someone will want it
   * for a key the model cannot express.
   */
  setResponseState(state) {
    return this.#send('ucenter/video-station/key/response-state', { state: state ? 1 : 0 });
  }
}
