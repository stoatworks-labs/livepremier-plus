/*
 * The device object model, as a local mirror.
 *
 * The Web RCS front-end hydrates from GET /api/stores/device and then applies
 * a stream of {path, value} writes off the socket. This class is the same
 * idea, kept independent of any UI framework so the standalone client can use
 * it too.
 *
 * One ordering trap worth stating plainly: the snapshot is fetched over HTTP
 * while frames keep arriving on the socket. Frames that predate the fetch are
 * already folded into the snapshot and must be discarded — replaying them
 * would walk state backwards. Frames from the moment the fetch was issued
 * onwards are replayed, which is safe because a write is idempotent.
 */

import { ROOT, startsWith, key } from './paths.js';

export class DeviceStore extends EventTarget {
  constructor() {
    super();
    this.root = null;
    this.ready = false;
    this._subs = [];
  }

  /** Replace the whole tree. `data` is the parsed /api/stores/device body. */
  hydrate(data) {
    this.root = data && data[ROOT] ? data : { [ROOT]: data };
    this.ready = true;
    this.dispatchEvent(new CustomEvent('ready'));
  }

  /** Read a value by store path. Returns undefined for anything absent. */
  get(path) {
    let node = this.root;
    for (const seg of path) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[seg];
    }
    return node;
  }

  /**
   * Apply one {path, value} write.
   *
   * Missing intermediate objects are created. The device sends writes for
   * paths that exist in its model but not necessarily in ours — the snapshot
   * and the stream can disagree briefly across a firmware the table does not
   * know — and dropping them would leave silent holes in the mirror.
   */
  set(path, value) {
    if (!this.root) return;
    let node = this.root;
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i];
      if (node[seg] == null || typeof node[seg] !== 'object') node[seg] = {};
      node = node[seg];
    }
    const leaf = path[path.length - 1];
    const before = node[leaf];
    node[leaf] = value;
    if (before !== value) this._notify(path, value, before);
  }

  /**
   * Watch a sub-tree. The callback fires for any write at or below `prefix`,
   * and once immediately if the store is already hydrated, so callers do not
   * have to handle "subscribed before ready" as a separate case.
   */
  subscribe(prefix, fn, { immediate = true } = {}) {
    const entry = { prefix, fn };
    this._subs.push(entry);
    if (immediate && this.ready) {
      try { fn({ path: prefix, value: this.get(prefix), initial: true }); }
      catch (err) { console.error('[wru] subscriber threw', err); }
    }
    return () => {
      const i = this._subs.indexOf(entry);
      if (i >= 0) this._subs.splice(i, 1);
    };
  }

  _notify(path, value, before) {
    for (const { prefix, fn } of this._subs) {
      if (!startsWith(path, prefix)) continue;
      try { fn({ path, value, before, initial: false }); }
      catch (err) { console.error('[wru] subscriber threw', err, key(path)); }
    }
  }

  /** Item keys of a collection, in the device's own order. */
  itemKeys(collectionPath) {
    const keys = this.get([...collectionPath, 'itemKeys']);
    if (Array.isArray(keys)) return keys;
    const items = this.get([...collectionPath, 'items']);
    return items ? Object.keys(items) : [];
  }
}
