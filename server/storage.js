/*
 * Cue-stack persistence.
 *
 * The extension brokered chrome.storage through a content script because the
 * page could not reach it directly. Nothing so involved is needed now: the
 * launcher is a process with a disk, and it writes one JSON file per device.
 *
 * Keyed by device address, because a cue stack is written against a specific
 * box's screens and presets and is meaningless pointed at another one. The
 * key is sanitised rather than trusted — it arrives from the proxy's own
 * state, not from the page, but it ends up in a filename either way.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export class StackStore {
  /** @param {string} dir directory to keep stacks in; created on demand. */
  constructor(dir) {
    this.dir = dir;
  }

  /**
   * The switcher this launcher was last pointed at.
   *
   * Remembered so that starting the app puts you back where you were, which
   * on a show day is almost always what you want. It is deliberately a
   * separate file from the stacks — the stacks are keyed BY device, and a
   * remembered address is not one of them.
   */
  async loadDevice() {
    try {
      const raw = JSON.parse(await readFile(join(this.dir, 'device.json'), 'utf8'));
      return typeof raw.device === 'string' ? raw.device : null;
    } catch {
      return null;
    }
  }

  async saveDevice(device) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, 'device.json'), JSON.stringify({ device }, null, 2), 'utf8');
  }

  _file(deviceKey) {
    /* Dots are excluded along with everything else outside the allowlist, so
       no key can produce a name containing `..` — the filename stays obviously
       inert rather than merely being safe by argument. */
    const safe = String(deviceKey).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'default';
    return join(this.dir, `stack-${safe}.json`);
  }

  async load(deviceKey) {
    try {
      return JSON.parse(await readFile(this._file(deviceKey), 'utf8'));
    } catch {
      /* Absent or unreadable both mean "no stack yet". A corrupt file is not
         worth failing the whole panel over — the operator can rebuild a cue
         list far more easily than they can debug a launcher that will not
         start mid-show. */
      return null;
    }
  }

  /**
   * Write atomically.
   *
   * Saves happen on every cue edit, and a show laptop gets closed abruptly.
   * A half-written stack that parses as valid JSON would be worse than none,
   * so the write lands on a temporary file and is renamed into place.
   */
  async save(deviceKey, data) {
    await mkdir(this.dir, { recursive: true });
    const file = this._file(deviceKey);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, file);
  }
}
