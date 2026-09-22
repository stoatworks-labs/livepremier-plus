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
 */

export const FORMAT = 'livepremier-plus/config';
export const VERSION = 1;

/** Every section an export can carry, and which file each comes from. */
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

const EMPTY_STACK = (s) => !s || (Array.isArray(s.cues) && s.cues.length === 0 && !s.name);

/**
 * Read everything this app holds for `deviceKey` into one document.
 *
 * Sections with nothing in them are left out rather than written as `null`:
 * an importer can then tell "this export had no patch" from "this export had
 * an empty patch", which is the difference between leaving a cable schedule
 * alone and wiping it.
 *
 * @param {object}  o
 * @param {import('./storage.js').StackStore} o.storage
 * @param {string}  o.deviceKey   the device these sections were written against
 * @param {string}  [o.appVersion]
 * @param {object}  [o.deviceInfo] `{platform, model, firmware, serial}` if known
 */
export async function buildConfig({ storage, deviceKey, appVersion = '', deviceInfo = {} }) {
  const [settings, matrices, stack, groups, names, patch] = await Promise.all([
    storage.loadSettings(),
    storage.loadMatrices(),
    storage.load(deviceKey),
    storage.loadGroups(deviceKey),
    storage.loadNames(deviceKey),
    storage.loadPatch(deviceKey)
  ]);

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

  if (settings && Object.keys(settings).length) doc.installation.settings = settings;
  if (matrices && matrices.length) doc.installation.matrices = matrices;
  if (stack && !EMPTY_STACK(stack)) doc.show.stack = stack;
  if (groups) doc.show.groups = groups;
  if (names) doc.show.names = names;
  if (patch && patch.length) doc.rig.patch = patch;

  return doc;
}

/** True when a document would restore nothing. */
export function isEmpty(doc) {
  return sectionsIn(doc).length === 0;
}

/** Which of [`SECTIONS`] a document actually carries. */
export function sectionsIn(doc) {
  if (!doc || typeof doc !== 'object') return [];
  return Object.keys(SECTIONS).filter((name) => sectionValue(doc, name) !== undefined);
}

function sectionValue(doc, name) {
  const spec = SECTIONS[name];
  if (!spec) return undefined;
  const group = doc[spec.group];
  return group && typeof group === 'object' ? group[name] : undefined;
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
 * @param {object} o
 * @param {import('./storage.js').StackStore} o.storage
 * @param {string} o.deviceKey
 * @param {object} o.doc
 * @param {string[]} [o.sections] defaults to [`DEFAULT_IMPORT`]
 * @returns {Promise<{applied: string[], skipped: string[], remapped: boolean}>}
 */
export async function applyConfig({ storage, deviceKey, doc, sections }) {
  const problem = validate(doc);
  if (problem) throw new Error(problem);

  const present = sectionsIn(doc);
  const wanted = (sections && sections.length ? sections : DEFAULT_IMPORT).filter((s) => SECTIONS[s]);
  const applied = [];

  for (const name of wanted) {
    if (!present.includes(name)) continue;
    const value = sectionValue(doc, name);
    switch (name) {
      case 'settings': {
        /* Merged, not replaced: an older export has fewer keys than this
           build knows, and replacing would silently reset the rest to their
           defaults rather than leaving them as the operator set them. */
        const current = await storage.loadSettings();
        await storage.saveSettings({ ...current, ...value });
        break;
      }
      case 'matrices': await storage.saveMatrices(value); break;
      case 'stack': await storage.save(deviceKey, value); break;
      case 'groups': await storage.saveGroups(deviceKey, value); break;
      case 'names': await storage.saveNames(deviceKey, value); break;
      case 'patch': await storage.savePatch(deviceKey, value); break;
      default: continue;
    }
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
