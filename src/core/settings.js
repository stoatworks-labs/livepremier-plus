/*
 * The app's own settings: what they are, what they default to, and the one
 * place that decides whether a stored value is allowed.
 *
 * ## Why these are server-side and not `localStorage`
 *
 * Two of them are not the page's business at all. The OSC listener is a UDP
 * socket in this process; a browser cannot open one, cannot see one, and
 * cannot be the authority on whether one is bound. And the console can be
 * open in two places at once — the tab and the popped-out window — so a
 * setting kept per-page would have the two of them disagreeing about which
 * language the operator chose.
 *
 * So settings live in `~/.livepremier-plus/settings.json`, read and written
 * over `/__lpp/settings`, and every surface asks the same process.
 *
 * ## Why they are not keyed by device
 *
 * A cue stack belongs to one switcher. These belong to the installation. An
 * operator re-pointing at a backup frame mid-show must not find the command
 * language changed under them or a port a lighting desk is sending to quietly
 * closed.
 *
 * ## `core/` still knows nothing about browsers
 *
 * This file is data and validation. It runs under plain Node — the server
 * imports it to sanitise what it stores, the panels import it for the same
 * table of what is allowed — and it does no I/O of its own.
 *
 * ## A plugin's settings are its own
 *
 * A plugin that keeps settings keeps them in its own entry,
 * `plugins[<id>].settings`, beside its on/off switch — never at the top level,
 * where two plugins could want the same name. What is allowed in them is the
 * plugin's business: it exports a **schema** (see `normalise`), and whoever
 * loaded the plugins hands the schemas in. This file cannot import a plugin
 * itself; `core/` never reaches outside `src/`.
 */

import { normalisePlugins } from './plugins.js';

export const LANGUAGE_CHOICES = [
  {
    id: 'all',
    label: 'All — detect the language of each line',
    what: 'Reads each line as whichever language it looks like, and honours a leading MYNAH, AWJ, JSON or OSC.',
  },
  { id: 'mynah', label: 'Mynah only', what: 'The command language. Detection off.' },
  { id: 'awj', label: 'AWJ only', what: 'Raw AWJ messages, in the vendor’s own protocol. Detection off.' },
  { id: 'json', label: 'JSON only', what: 'Raw Web RCS store writes, as the socket carries them. Detection off.' },
  { id: 'osc', label: 'OSC only', what: 'Addresses from the published OSC dictionary. Detection off.' },
];

export const AWJ_TRANSPORTS = [
  {
    id: 'store',
    label: 'Store writes — the vendor’s own socket',
    what: 'Convert the message to the store spelling and send it on the connection this page already has. Lands at the same node; cannot answer a get.',
  },
  {
    id: 'socket',
    label: 'TCP 10606 — a real AWJ socket',
    what: 'Send the message as typed and read the reply. Opened by this process, one connection per exchange, and it spends one of the device’s five AWJ client slots while it is open.',
  },
];

/**
 * What the OSC listener may bind to.
 *
 * A closed list rather than a free-text field, and that is the safety
 * argument: this port fires takes on a video switcher, so the choice between
 * "only this machine" and "anything on the network" should be a decision
 * somebody made in words, not a value they typed without reading.
 */
export const OSC_BIND_CHOICES = [
  {
    id: '127.0.0.1',
    label: 'This machine only',
    what: 'Only software on this computer can send. The safe default.',
  },
  {
    id: '0.0.0.0',
    label: 'Any interface — the network can drive the switcher',
    what: 'Anything that can reach this machine can fire takes. Only on a show network you control.',
  },
];

export const DEFAULT_SETTINGS = {
  /* Detection, because a console pinned to one language is one an operator has
     to configure before it is useful. */
  consoleLanguage: 'all',
  /* The transport that works everywhere and spends no AWJ client slot.
     Someone who wants the wire-truthful one is being deliberate. */
  awjTransport: 'store',
  /* Off. An open UDP port that fires takes on a switcher is not something to
     turn on for somebody. */
  oscEnabled: false,
  oscPort: 8000,
  oscBind: '127.0.0.1',
  /*
   * Where the Edit page's memory file is written for the device to read.
   *
   * Empty means a temporary directory on this machine, which is right for a
   * simulator — the device software is running here, so our disk is its disk.
   * On a real switcher that path is the SWITCHER's filesystem, so this is the
   * setting an installation points at a share both machines can see. See
   * `server/memory-import.js`.
   */
  memoryImportDir: '',
  /* Which features are switched on, and each plugin's own settings, as
     `{ id: { enabled, settings } }`. Empty means every built-in at its
     default, which is on — see `core/plugins.js`. */
  plugins: {},
};

const ids = (list) => list.map((c) => c.id);

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Move a built-in plugin's settings from the top level, where they lived before
 * plugins had a namespace, into `plugins[<id>].settings`.
 *
 * A schema's `legacy` names those keys — Companion's `companionHost` and its
 * two neighbours were the first. A legacy key that is present **wins** over the
 * namespaced value: it can only be there because it is newer — a settings file
 * from before the move, an older setup file just imported, or a caller that
 * still sends the old shape — and each of those is somebody saying what they
 * want now. Once lifted it is gone from the top level, so it is lifted once.
 *
 * Works on a whole stored file and on a partial update alike.
 */
export function liftLegacy(input, schemas = {}) {
  if (!isPlainObject(input)) return {};
  let out = input;
  for (const [id, schema] of Object.entries(schemas)) {
    const keys = (schema.legacy || []).filter((k) => Object.prototype.hasOwnProperty.call(out, k));
    if (!keys.length) continue;
    out = { ...out };
    const moved = {};
    for (const k of keys) { moved[k] = out[k]; delete out[k]; }
    const plugins = isPlainObject(out.plugins) ? { ...out.plugins } : {};
    const entry = isPlainObject(plugins[id]) ? { ...plugins[id] } : {};
    entry.settings = { ...(isPlainObject(entry.settings) ? entry.settings : {}), ...moved };
    plugins[id] = entry;
    out.plugins = plugins;
  }
  return out;
}

/**
 * Apply a partial update to the settings held now.
 *
 * Shallow for the app's own fields — a panel may send one without restating
 * the rest — and one level deeper for `plugins`, so that switching a plugin
 * off does not wipe its settings and saving a plugin's settings does not flip
 * its switch. Within a plugin's `settings` it is shallow again, for the same
 * reason as at the top.
 */
export function mergeSettings(current, patch) {
  const base = isPlainObject(current) ? current : {};
  if (!isPlainObject(patch)) return { ...base };
  const out = { ...base, ...patch };
  if (isPlainObject(patch.plugins)) {
    const plugins = isPlainObject(base.plugins) ? { ...base.plugins } : {};
    for (const [id, entry] of Object.entries(patch.plugins)) {
      if (!isPlainObject(entry)) continue;
      const prev = isPlainObject(plugins[id]) ? plugins[id] : {};
      const next = { ...prev, ...entry };
      if (isPlainObject(entry.settings)) {
        next.settings = { ...(isPlainObject(prev.settings) ? prev.settings : {}), ...entry.settings };
      }
      plugins[id] = next;
    }
    out.plugins = plugins;
  }
  return out;
}

/**
 * Coerce anything into a valid settings object.
 *
 * Every field is checked against its own closed list or range and falls back
 * to the default rather than being rejected wholesale. That is deliberate:
 * this runs on a file that a previous version wrote and that a person may have
 * edited, and refusing to start over one bad field would take the whole app
 * down for a typo. A field that is wrong is reported by being *not what was
 * typed*, which is visible in the settings page.
 *
 * `schemas` are the settings schemas of the plugins that are installed, by id:
 *
 *     { normalise(raw) -> settings,  changed?(a, b) -> bool,  legacy?: [keys] }
 *
 * Each installed plugin gets its settings normalised — and filled in with its
 * defaults when it has none yet — whether it is switched on or not: switching a
 * plugin off must not lose what it was set to. A plugin that is not installed
 * keeps whatever it had, unread.
 */
export function normalise(raw, schemas = {}) {
  const input = liftLegacy(isPlainObject(raw) ? raw : {}, schemas);
  const pick = (value, list, fallback) => (ids(list).includes(value) ? value : fallback);

  const plugins = normalisePlugins(input.plugins);
  for (const [id, schema] of Object.entries(schemas)) {
    const entry = plugins[id] || {};
    plugins[id] = { ...entry, settings: schema.normalise(entry.settings || {}) };
  }

  const port = Number(input.oscPort);
  return {
    consoleLanguage: pick(input.consoleLanguage, LANGUAGE_CHOICES, DEFAULT_SETTINGS.consoleLanguage),
    awjTransport: pick(input.awjTransport, AWJ_TRANSPORTS, DEFAULT_SETTINGS.awjTransport),
    oscEnabled: input.oscEnabled === true,
    /* Above 1024 so it never needs privilege to bind, which would be a
       surprising thing for this app to ask for. */
    oscPort: Number.isInteger(port) && port > 1024 && port < 65536 ? port : DEFAULT_SETTINGS.oscPort,
    oscBind: pick(input.oscBind, OSC_BIND_CHOICES, DEFAULT_SETTINGS.oscBind),
    memoryImportDir: pathOrNothing(input.memoryImportDir),
    plugins,
  };
}

/**
 * Which installed plugins' settings differ between two settings objects.
 *
 * A schema's own `changed` decides where it has one, so a plugin whose
 * settings include something cosmetic can say that a change to it needs no
 * reconnect. Otherwise any difference counts.
 */
export function changedPluginSettings(prev, next, schemas = {}) {
  const read = (s, id) => (s && s.plugins && s.plugins[id] && s.plugins[id].settings) || {};
  return Object.keys(schemas).filter((id) => {
    const a = read(prev, id);
    const b = read(next, id);
    const schema = schemas[id];
    return schema.changed ? schema.changed(a, b) : JSON.stringify(a) !== JSON.stringify(b);
  });
}

/**
 * An absolute directory, or nothing.
 *
 * Absolute because the device resolves it, not this process, and a relative
 * path would be relative to whatever the switcher's own working directory
 * happens to be. Sanitised rather than checked for existence: on a real
 * installation this names a directory on the *switcher*, which this machine
 * has no way to stat.
 */
function pathOrNothing(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.length > 1024) return '';
  return value.startsWith('/') ? value : '';
}

/** True when a change needs the UDP socket rebound rather than just noted. */
export const oscChanged = (a, b) =>
  a.oscEnabled !== b.oscEnabled || a.oscPort !== b.oscPort || a.oscBind !== b.oscBind;
