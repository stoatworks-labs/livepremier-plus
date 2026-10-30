/*
 * The media host's core: NDI feeds, and the messages it trades with
 * LivePremier Plus. No process and no NDI of its own — `../media-host.js`
 * hands it those — so the tests run it in-process against a pretend runtime.
 *
 * ## The messages
 *
 * Over Node's parent–child IPC channel, with `serialization: 'advanced'` so a
 * picture crosses as bytes rather than as JSON:
 *
 * ```text
 *   host → app   { type: 'hello', available, reason, runtime: { path, version } | null }
 *                { type: 'feeds', feeds: [{ id, name, fullName, connections, frames, error }] }
 *                                                  when one is made or dropped, and when a
 *                                                  feed's receivers change (asked every second)
 *                { type: 'log',   text }
 *   app → host   { op: 'feeds', feeds: [{ id, name }] }   the feeds there should be; any other is dropped
 *                { op: 'frame', id, scene, images }       a picture for one feed, drawn here
 *                                                         (`src/core/raster.js`'s `render`)
 * ```
 *
 * A frame is drawn and sent as it arrives; the app sends one when there is
 * something to see, about once a second, so nothing here keeps time.
 */

import { render } from '../../src/core/raster.js';

const NAME = /^[\w .:+()#-]{1,63}$/;
/* 4K is the most any desk takes; a scene asking for more is a mistake. */
const MAX_SIDE = 3840;
const POLL_MS = 1000;

/**
 * @param o.ndi     `{ lib, reason }` from `ndi.js`'s `loadNdi`
 * @param o.send    fn(message) to the app
 * @param o.pollMs  how often each feed's receivers are counted
 */
export function createMediaCore({ ndi, send, log = () => {}, pollMs = POLL_MS }) {
  const lib = ndi && ndi.lib;
  const feeds = new Map();   // id -> { id, name, inst, fullName, connections, frames, error }

  send({
    type: 'hello',
    available: !!lib,
    reason: lib ? null : (ndi && ndi.reason) || 'no NDI runtime',
    runtime: lib ? { path: lib.path, version: lib.version } : null,
  });

  const report = () => send({
    type: 'feeds',
    feeds: [...feeds.values()].map(({ id, name, fullName, connections, frames, error }) => ({ id, name, fullName, connections, frames, error })),
  });

  function setFeeds(list) {
    const wanted = new Map();
    for (const f of Array.isArray(list) ? list : []) {
      const id = String(f && f.id || '');
      const name = String(f && f.name || '');
      if (!id || !NAME.test(name)) { log(`feed ${JSON.stringify(id)}: not a name NDI can carry (${JSON.stringify(name)})`); continue; }
      wanted.set(id, name);
    }
    let changed = false;
    for (const [id, f] of feeds) {
      if (wanted.get(id) === f.name) continue;
      if (f.inst) { try { lib.destroy(f.inst); } catch { /* gone anyway */ } }
      feeds.delete(id);
      changed = true;
    }
    for (const [id, name] of wanted) {
      if (feeds.has(id)) continue;
      const f = { id, name, inst: null, fullName: null, connections: 0, frames: 0, error: null };
      if (!lib) f.error = 'no NDI runtime';
      else {
        try {
          f.inst = lib.create(name);
          f.fullName = lib.fullName(f.inst);
        } catch (err) { f.error = err.message; }
      }
      feeds.set(id, f);
      changed = true;
    }
    if (changed) report();
  }

  function frame(id, scene, images) {
    const f = feeds.get(String(id));
    if (!f || !f.inst || !scene) return;
    const width = Math.round(Number(scene.width));
    const height = Math.round(Number(scene.height));
    if (!(width >= 16 && height >= 16 && width <= MAX_SIDE && height <= MAX_SIDE)) {
      log(`feed ${f.id}: a ${scene.width} × ${scene.height} picture is not one to send`);
      return;
    }
    try {
      const pic = render({ ...scene, width, height }, images && typeof images === 'object' ? images : {});
      lib.send(f.inst, pic, scene.fps || 1);
      f.frames++;
      if (f.error) { f.error = null; report(); }
    } catch (err) {
      if (f.error !== err.message) { f.error = err.message; log(`feed ${f.id}: ${err.message}`); report(); }
    }
  }

  /* Receivers come and go without telling anyone; asking is cheap. The frame
     counts go with the answer, at most once a poll, not once a frame. */
  let told = new Map();
  const poll = setInterval(() => {
    let changed = false;
    for (const f of feeds.values()) {
      if (f.inst) {
        let n = 0;
        try { n = lib.connections(f.inst); } catch { n = 0; }
        if (n !== f.connections) { f.connections = n; changed = true; }
      }
      if (told.get(f.id) !== f.frames) changed = true;
    }
    if (!changed) return;
    told = new Map([...feeds.values()].map((f) => [f.id, f.frames]));
    report();
  }, pollMs);
  poll.unref?.();

  function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.op === 'feeds') setFeeds(msg.feeds);
    else if (msg.op === 'frame') frame(msg.id, msg.scene, msg.images);
  }

  function stop() {
    clearInterval(poll);
    for (const f of feeds.values()) if (f.inst) { try { lib.destroy(f.inst); } catch { /* gone anyway */ } }
    feeds.clear();
  }

  return { handle, stop, feeds };
}
