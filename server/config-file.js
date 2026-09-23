/*
 * The portable configuration file — `livepremier-plus.json`.
 *
 * ## Why this exists
 *
 * A rig is two halves. The processor restores from the vendor's own `.awc`;
 * this app holds the other half — the cue stack, the layer groups, the layer
 * names, the cable schedule to the routers. Restoring one without the other
 * leaves an operator half rigged, on a show day, which is exactly when nobody
 * has time to rebuild a cue list by hand.
 *
 * So the app can write everything it knows into one file, and read one back.
 * Showbook carries that file beside the `.awc` (in a `.showbook` bundle, or
 * embedded inside the `.awc` itself), but nothing here depends on Showbook —
 * it is a plain JSON document anyone can read, diff or keep in a git repo.
 *
 * ## The three sections, and why they are not one bag
 *
 * `storage.js` files these separately and argues why; this file must not undo
 * that by flattening them:
 *
 *   installation  settings, matrices    NOT keyed by device
 *   show          stack, groups, names  keyed by device
 *   rig           patch                 keyed by device
 *
 * An import takes whichever sections it is asked for. That choice only stays
 * available if the file keeps them apart, and it matters most for the section
 * an operator is least likely to want: `settings` carries the OSC port and
 * bind address, so applying it can close a port a lighting desk is sending to.
 * `DEFAULT_IMPORT` therefore leaves it out — restoring somebody's show must
 * not silently re-plumb this installation.
 *
 * ## Who holds each section
 *
 * The features do, not this file. Each section is a `configSection` a plugin
 * contributes (`src/core/contributions.js`) — the Timeline's `stack`, Matrix
 * Routing's `matrices` and `patch` — with its own `export(device)` and
 * `import(data, device)`, so a restore reaches the running feature as well as
 * its file, and a plugin of somebody else's can add a section of its own. The
 * functions here take that list as `sections`. Given a `storage` instead, they
 * build the app's six from the files directly (`storageSections`), which is
 * what the tests do and what the format was first written against.
 */

export const FORMAT = 'livepremier-plus/config';
export const VERSION = 1;

/** The app's own sections, where each sits, and what an import reports it as. */
export const SECTIONS = {
  settings: { group: 'installation', keyed: false, label: 'App settings' },
  matrices: { group: 'installation', keyed: false, label: 'External routers' },
  stack: { group: 'show', keyed: true, label: 'Cue stack' },
  groups: { group: 'show', keyed: true, label: 'Layer groups' },
  names: { group: 'show', keyed: true, label: 'Layer names' },
  patch: { group: 'rig', keyed: true, label: 'Patch' }
};

/**
 * What an import applies unless told otherwise.
 *
 * Everything that describes the show and the rig, and nothing that re-plumbs
 * this installation — see the note above about the OSC port.
 */
export const DEFAULT_IMPORT = ['stack', 'groups', 'names', 'patch', 'matrices'];

/** A cue stack with nothing in it is no stack, for an export. */
export const EMPTY_STACK = (s) => !s || (Array.isArray(s.cues) && s.cues.length === 0 && !s.name);

/**
 * The app's six sections, read from and written to the files directly.
 *
 * What the setup file was first written against, kept for the tests and for
 * anything with a `StackStore` and no plugins. Each export answers undefined
 * for "nothing to write", by the same rules the plugins' sections use.
 */
export function storageSections(storage) {
  const section = (key, exp, imp) => ({ key, ...SECTIONS[key], perDevice: SECTIONS[key].keyed, export: exp, import: imp });
  return [
    section('settings',
      async () => { const v = await storage.loadSettings(); return v && Object.keys(v).length ? v : undefined; },
      /* Merged, not replaced: an older export has fewer keys than this build
         knows, and replacing would silently reset the rest to their defaults. */
      async (value) => storage.saveSettings({ ...(await storage.loadSettings()), ...value })),
    section('matrices',
      async () => { const v = await storage.loadMatrices(); return v && v.length ? v : undefined; },
      (value) => storage.saveMatrices(value)),
    section('stack',
      async (device) => { const v = await storage.load(device); return v && !EMPTY_STACK(v) ? v : undefined; },
      (value, device) => storage.save(device, value)),
    section('groups',
      async (device) => (await storage.loadGroups(device)) || undefined,
      (value, device) => storage.saveGroups(device, value)),
    section('names',
      async (device) => (await storage.loadNames(device)) || undefined,
      (value, device) => storage.saveNames(device, value)),
    section('patch',
      async (device) => { const v = await storage.loadPatch(device); return v && v.length ? v : undefined; },
      (value, device) => storage.savePatch(device, value))
  ].map((sec) => ({ ...sec, byDefault: DEFAULT_IMPORT.includes(sec.key) }));
}

/** What an import applies when it names nothing: every section that is `byDefault`. */
export function defaultImport(sections) {
  return sections.filter((s) => s.byDefault !== false).map((s) => s.key);
}

/**
 * Read everything this app holds for `deviceKey` into one document.
 *
 * Sections with nothing in them are left out rather than written as `null`:
 * an importer can then tell "this export had no patch" from "this export had
 * an empty patch", which is the difference between leaving a cable schedule
 * alone and wiping it.
 *
 * @param {object}  o
 * @param {object[]} [o.sections] the `configSection` contributions to write
 * @param {import('./storage.js').StackStore} [o.storage] or the files, directly
 * @param {string}  o.deviceKey   the device these sections were written against
 * @param {string}  [o.appVersion]
 * @param {object}  [o.deviceInfo] `{platform, model, firmware, serial}` if known
 */
export async function buildConfig({ sections, storage, deviceKey, appVersion = '', deviceInfo = {} }) {
  const list = sections || storageSections(storage);
  const values = await Promise.all(list.map((sec) => sec.export(deviceKey)));

  const doc = {
    format: FORMAT,
    version: VERSION,
    exported: new Date().toISOString(),
    app: { name: 'LivePremier Plus', version: appVersion },
    device: {
      address: deviceKey || '',
      ...pick(deviceInfo, ['platform', 'model', 'firmware', 'serial'])
    },
    installation: {},
    show: {},
    rig: {}
  };

  list.forEach((sec, i) => {
    if (values[i] !== undefined && values[i] !== null) doc[sec.group][sec.key] = values[i];
  });
  return doc;
}

/** True when a document would restore nothing. */
export function isEmpty(doc) {
  return sectionsIn(doc).length === 0;
}

const GROUPS = ['installation', 'show', 'rig'];

/**
 * Which sections a document actually carries — the app's own and any a
 * plugin contributed, in the order the file has them.
 */
export function sectionsIn(doc) {
  if (!doc || typeof doc !== 'object') return [];
  const out = [];
  for (const group of GROUPS) {
    const g = doc[group];
    if (!g || typeof g !== 'object') continue;
    for (const [name, value] of Object.entries(g)) if (value !== undefined) out.push(name);
  }
  return out;
}

/** A section's value, wherever in the document it is filed. */
function sectionValue(doc, name) {
  for (const group of GROUPS) {
    const g = doc && doc[group];
    if (g && typeof g === 'object' && g[name] !== undefined) return g[name];
  }
  return undefined;
}

/**
 * Counts for a dialog, without claiming to understand a cue.
 */
export function summarise(doc) {
  const stack = sectionValue(doc, 'stack');
  const groups = sectionValue(doc, 'groups');
  const names = sectionValue(doc, 'names');
  return {
    device: doc?.device?.address || '',
    appVersion: doc?.app?.version || '',
    exported: doc?.exported || '',
    sections: sectionsIn(doc),
    cues: Array.isArray(stack?.cues) ? stack.cues.length : 0,
    stackName: stack?.name || '',
    groups: countOf(groups?.groups ?? groups),
    names: countOf(names?.names ?? names),
    patchEntries: countOf(sectionValue(doc, 'patch')),
    matrices: countOf(sectionValue(doc, 'matrices')),
    hasSettings: sectionValue(doc, 'settings') !== undefined
  };
}

function countOf(v) {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return 0;
}

/** Reject anything that is not one of ours before it reaches the store. */
export function validate(doc) {
  if (!doc || typeof doc !== 'object') return 'not a JSON object';
  if (doc.format !== FORMAT) return `not a LivePremier Plus configuration (format is ${JSON.stringify(doc.format)})`;
  if (typeof doc.version !== 'number') return 'no version';
  if (doc.version > VERSION) {
    return `written by a newer LivePremier Plus (version ${doc.version}; this one reads up to ${VERSION})`;
  }
  if (isEmpty(doc)) return 'that configuration is empty — it would restore nothing';
  return null;
}

/**
 * Write a document's sections into the store.
 *
 * `deviceKey` is the device to write the device-keyed sections *against*,
 * which is not necessarily the one they were exported from — restoring last
 * night's show onto a backup frame at another address is the whole point of
 * recording `device.address` rather than stripping it. The caller chooses;
 * this reports what it did.
 *
 * A section the file carries that nothing here holds — a plugin that is
 * switched off, or one this installation does not have — is reported as
 * skipped and left alone.
 *
 * @param {object} o
 * @param {object[]} [o.providers] the `configSection` contributions to restore into
 * @param {import('./storage.js').StackStore} [o.storage] or the files, directly
 * @param {string} o.deviceKey
 * @param {object} o.doc
 * @param {string[]} [o.sections] which to apply; defaults to every `byDefault` one
 * @returns {Promise<{applied: string[], skipped: string[], remapped: boolean}>}
 */
export async function applyConfig({ providers, storage, deviceKey, doc, sections }) {
  const problem = validate(doc);
  if (problem) throw new Error(problem);

  const list = providers || storageSections(storage);
  const byKey = new Map(list.map((sec) => [sec.key, sec]));
  const present = sectionsIn(doc);
  const wanted = (sections && sections.length ? sections : defaultImport(list)).filter((s) => byKey.has(s));
  const applied = [];

  for (const name of wanted) {
    if (!present.includes(name)) continue;
    await byKey.get(name).import(sectionValue(doc, name), deviceKey);
    applied.push(name);
  }

  return {
    applied,
    skipped: present.filter((s) => !applied.includes(s)),
    remapped: Boolean(doc.device?.address) && doc.device.address !== deviceKey
  };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k]) out[k] = obj[k];
  return out;
}
