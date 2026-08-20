/*
 * A live view of one device.
 *
 * Ties the three pieces together: a snapshot over HTTP, a stream of writes off
 * whatever transport it is given, and a store to fold them into. Nothing in
 * here knows it is running inside a browser extension.
 *
 * The transport contract is small on purpose, so that a direct AWJ socket can
 * satisfy it later:
 *
 *   transport.onFrame(fn)     subscribe to inbound {path, value} writes
 *   transport.send(cmd)       write one property, returns boolean "left here"
 *   transport.mark()          an opaque position marker in the inbound stream
 *   transport.replay(mark)    frames at or after a marker
 *   transport.snapshotUrl     where to fetch the full object model
 */

import { DeviceStore } from './device-store.js';

export class Session extends EventTarget {
  constructor(transport) {
    super();
    this.transport = transport;
    this.store = new DeviceStore();
    this.state = 'idle';
    this._unsub = null;
  }

  /**
   * Fetch the snapshot and start following the stream.
   *
   * The marker is taken before the fetch is issued, not after it returns.
   * Frames that arrived while the 100-plus MB snapshot was in flight may or
   * may not be reflected in it, and re-applying a write we already have costs
   * nothing, whereas missing one leaves the mirror quietly wrong.
   */
  async start() {
    if (this.state === 'starting' || this.state === 'live') return;
    this._set('starting');

    const mark = this.transport.mark();
    this._unsub = this.transport.onFrame((frame) => this._onFrame(frame));

    let data;
    try {
      const res = await fetch(this.transport.snapshotUrl, {
        headers: { 'Cache-Control': 'no-cache' },
        credentials: 'same-origin'
      });
      if (!res.ok) throw new Error('snapshot HTTP ' + res.status);
      data = await res.json();
    } catch (err) {
      this._set('failed', { error: err });
      return;
    }

    this.store.hydrate(data);
    for (const frame of this.transport.replay(mark)) this._onFrame(frame, true);
    this._set('live');
  }

  stop() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    this._set('idle');
  }

  /**
   * Write one property.
   *
   * The mirror is not updated here. The device echoes every accepted write
   * back on the stream, and taking that echo as the source of truth is what
   * keeps a rejected or clamped value from showing as applied in the UI.
   */
  send(cmd) {
    const ok = this.transport.send(cmd);
    this.dispatchEvent(new CustomEvent('sent', { detail: { cmd, ok } }));
    return ok;
  }

  _onFrame(frame, replayed = false) {
    if (!frame || !Array.isArray(frame.path)) return;
    if (!this.store.ready) return;
    this.store.set(frame.path, frame.value);
    if (!replayed) this.dispatchEvent(new CustomEvent('frame', { detail: frame }));
  }

  _set(state, detail = {}) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, ...detail } }));
  }
}
