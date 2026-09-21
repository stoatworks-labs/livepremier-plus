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

  /**
   * App settings, which are NOT keyed by device.
   *
   * A cue stack belongs to one switcher; how the console reads a typed line
   * and whether an OSC port is open belong to this installation. Re-pointing
   * at a backup frame mid-show must not silently change the command language
   * or close a port a lighting desk is sending to — so these live in their own
   * file with no device in the key.
   */
  async loadSettings() {
    try {
      const raw = JSON.parse(await readFile(join(this.dir, 'settings.json'), 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  async saveSettings(settings) {
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, 'settings.json');
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8');
    await rename(tmp, file);
  }

  /**
   * The external routers in the rack. NOT keyed by device, for the same
   * reason the settings are not.
   *
   * A Videohub does not move when you fail over to a backup frame, so
   * re-pointing the app must not drop the routers off the network. See
   * `src/core/patch.js` for the other half of this split — the *patch* is
   * per device, because that describes one frame's own sockets.
   */
  async loadMatrices() {
    try {
      const raw = JSON.parse(await readFile(join(this.dir, 'matrices.json'), 'utf8'));
      return Array.isArray(raw) ? raw : Array.isArray(raw?.matrices) ? raw.matrices : [];
    } catch {
      return [];
    }
  }

  async saveMatrices(matrices) {
    await this._writeAtomic('matrices.json', { matrices });
  }

  /**
   * The cable schedule between one switcher and those routers.
   *
   * Keyed by device, and filed beside the cue stack and the layer groups
   * rather than inside either: a stack is a show and a patch is the rig it
   * runs on, and an operator importing somebody else's cue list must not
   * import their cabling with it.
   */
  async loadPatch(deviceKey) {
    try {
      const raw = JSON.parse(await readFile(this._file(deviceKey, 'patch'), 'utf8'));
      return Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
    } catch {
      return [];
    }
  }

  async savePatch(deviceKey, entries) {
    await this._writeAtomic(`patch-${this._safe(deviceKey)}.json`, { entries });
  }

  _safe(deviceKey) {
    /* Dots are excluded along with everything else outside the allowlist, so
       no key can produce a name containing `..` — the filename stays obviously
       inert rather than merely being safe by argument. */
    return String(deviceKey).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'default';
  }

  async _writeAtomic(name, data) {
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, file);
  }

  _file(deviceKey, kind = 'stack') {
    return join(this.dir, `${kind}-${this._safe(deviceKey)}.json`);
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

  /*
   * Layer groups, on exactly the cue stack's terms and for the same reason.
   *
   * A group names screens and layer slots — `S1/2`, `S2/1` — which only mean
   * anything on the box they were written against. Re-point at a backup frame
   * with a different preconfig and last night's groups would name layers that
   * are not there, so they are keyed by device like the stacks and kept in
   * their own file beside them.
   */
  async loadGroups(deviceKey) {
    try {
      return JSON.parse(await readFile(this._file(deviceKey, 'groups'), 'utf8'));
    } catch {
      return null;
    }
  }

  async saveGroups(deviceKey, data) {
    await mkdir(this.dir, { recursive: true });
    const file = this._file(deviceKey, 'groups');
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, file);
  }
}
