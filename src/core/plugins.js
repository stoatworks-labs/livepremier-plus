/*
 * Plugins: what this app is made of, and which parts are switched on.
 *
 * Every feature is described here as a **plugin** — an id, what it is, where
 * it lives, and what it needs — and whether it is on is a setting like any
 * other. The list an operator sees in the app is generated from this table
 * rather than written a second time by hand; the in-app list had drifted nine
 * features behind the code before it existed. See docs/PLUGINS.md.
 *
 * ## In place, and hosted
 *
 * A built-in is one of two kinds while the move is under way:
 *
 * - **In place**: still wired into `src/main.js` and `server/proxy.js` by hand,
 *   and gated there by `isEnabled`. Most features, for now.
 * - **Hosted**: moved into `plugins/<id>/` with a `server` and/or `client`
 *   half, and loaded through the plugin hosts (`server/plugin-host.js`,
 *   `src/ui/plugin-host.js`) exactly as a plugin written by somebody else
 *   will be. Its manifest names those halves. Companion was the first;
 *   VPU Map, Pitch Compensation and the Pixelhue panel followed.
 *
 * ## Present, and active
 *
 * Two different switches, and both stay. A plugin being **enabled** means the
 * feature exists at all: its sidebar entry or tab, its routes, its background
 * service. Some features also have their own **active** switch — "Listen for
 * OSC", "Connect to a Companion" — which only means anything while the plugin
 * is enabled. Disabling OSC input removes the listener and its settings card;
 * enabling it brings the card back with the listener still off, as it always
 * starts.
 *
 * ## What is not a plugin
 *
 * The proxy and socket relay, the setup page, the store mirror, the settings
 * page itself, `/__lpp/status`, `/__lpp/device`, `/__lpp/settings` and
 * `/__lpp/awj`. Switching any of those off would leave no way to switch it back
 * on, or no app.
 *
 * `core/` runs in the browser and in Node, so this file has no DOM and no I/O:
 * the server consults it to gate routes and services, and the page consults it
 * to gate panels and page decorations.
 */

/** The plugin API this build speaks. A plugin asking for a newer one is refused. */
export const API_VERSION = 1;

/**
 * The built-in plugins, in the order the app presents them.
 *
 * `requires.capabilities` are platform facts (`core/platform.js`): a feature
 * the switcher cannot support is not offered whatever this says.
 * `requires.plugins` are other plugins this one cannot work without; switch one
 * of those off and this one goes with it, and says why.
 */
export const BUILTINS = [
  {
    id: 'edit',
    name: 'Edit',
    where: 'Sidebar, under PLUS',
    description: 'The Screens / Aux. layout with one row, on neither bus. Programme a look, then save it into a real memory.',
    requires: { capabilities: ['layerProperties'] },
    /* Its one route is where it always was. */
    routeBase: '/memory',
    server: 'server.js',
    client: 'client.js'
  },
  {
    id: 'companion',
    name: 'Companion',
    where: 'Sidebar, under PLUS',
    description: 'A Bitfocus Companion on this address — its buttons, web buttons and emulator — and the connections that belong in the show for this switcher.',
    /* Hosted: plugins/companion/, loaded through the plugin hosts. */
    server: 'server.js',
    client: 'client.js'
  },
  {
    id: 'vpu-map',
    name: 'VPU Map',
    where: 'Sidebar, under PLUS',
    description: 'Which mixers each screen is using, running against staged.',
    requires: { capabilities: ['vpuMap'] },
    client: 'client.js'
  },
  {
    id: 'console',
    name: 'Console',
    where: 'Screens / Aux., beside Properties',
    description: 'A command line over the device — takes, preset recalls, layer moves.',
    requires: { capabilities: ['console'] },
    client: 'client.js'
  },
  {
    id: 'timeline',
    name: 'Timeline',
    where: 'Screens / Aux., beside Properties',
    description: 'A theatre cue stack with GO, fades and a standby cue.',
    requires: { capabilities: ['cueStack'] },
    /* Its stack is where it always was. */
    routeBase: '/stack',
    server: 'server.js',
    client: 'client.js'
  },
  {
    id: 'timecode',
    name: 'Timecode',
    where: 'Settings, and the Timeline',
    description: 'Fire cues from MIDI Time Code, LTC on an audio input, or a timecode pushed to this app.',
    requires: { capabilities: ['cueStack'], plugins: ['timeline'] },
    server: 'server.js',
    client: 'client.js'
  },
  {
    id: 'memories',
    name: 'Memories',
    where: 'Sidebar, under PLUS',
    description: 'Every memory bank in one list, with recall, save, rename and erase — and a window of its own.',
    requires: { capabilities: ['cueStack'] },
    client: 'client.js'
  },
  {
    id: 'layer',
    name: 'Layer',
    where: 'Screens / Aux., beside Properties',
    description: 'Every property of a named layer, generated from the device’s own parameter catalogue.',
    requires: { capabilities: ['layerProperties'] },
    client: 'client.js'
  },
  {
    id: 'layer-names',
    name: 'Layer names',
    where: 'The Layer tab, and every layer list',
    description: 'Name a layer and the name shows in the vendor’s own lists — the switcher has nowhere to keep one.',
    requires: { capabilities: ['layerGroups'] },
    server: 'server.js',
    client: 'client.js'
  },
  {
    id: 'layer-groups',
    name: 'Layer Groups',
    where: 'Sidebar, under PLUS, and a Groups tab',
    description: 'Several layers, across screens, driven as one — and a gang that follows a change to any of them.',
    requires: { capabilities: ['layerGroups'] },
    /* Where the groups always were: a route base moved rather than a URL. */
    routeBase: '/groups',
    server: 'server.js',
    client: 'client.js'
  },
  {
    id: 'send-to',
    name: 'Send to',
    where: 'The … on every source card',
    description: 'Route an input to a layer or a whole group, in preview or program, without a drag.',
    requires: { capabilities: ['layerGroups'], plugins: ['layer-groups'] },
    client: 'client.js'
  },
  {
    id: 'matrix-routing',
    name: 'Matrix Routing',
    where: 'Sidebar, under PLUS, and the vendor’s input and output pages',
    description: 'Patch the frame to a Videohub, Lightware or Turtle AV router and route through it.',
    requires: { capabilities: ['matrixRouting'] }
  },
  {
    id: 'pitch',
    name: 'Pitch Compensation',
    where: 'Preconfig flyout',
    description: 'The H and V ratios for a screen spanning LED walls of different pitches.',
    requires: { capabilities: ['pitchCompensation'] },
    client: 'client.js'
  },
  {
    id: 'osc-input',
    name: 'OSC input',
    where: 'Settings',
    description: 'QLab, TouchOSC or a lighting desk driving the switcher over UDP, with no browser open.'
  },
  {
    id: 'midi',
    name: 'MIDI Mapping',
    where: 'Sidebar, under Virtual RC400T',
    description: 'A MIDI control surface driving the switcher from this page.',
    requires: { capabilities: ['console'] },
    client: 'client.js'
  },
  {
    id: 'pixelhue',
    name: 'Pixelhue panel',
    where: 'Settings (preview)',
    description: 'A Pixelhue U5, U5 Pro or U5 mini driving the switcher. Never yet run against a console.',
    server: 'server.js',
    client: 'client.js'
  },
  {
    id: 'setup-file',
    name: 'Setup file',
    where: '/__lpp/config',
    description: 'Cue stack, groups, layer names, router patch and settings as one JSON file, and back.'
  },
  {
    id: 'arithmetic',
    name: 'Field arithmetic',
    where: 'Every numeric field in Web RCS',
    description: 'Type 1080-80 in a layer width and get 1000.',
    client: 'client.js'
  }
].map((p) => withDefaults(p));

/**
 * A manifest with every optional field filled in, so nothing downstream has to
 * guard against a missing `requires` or an absent default. Used for the
 * built-ins above and, later, for a user plugin's `plugin.json`.
 */
export function withDefaults(p) {
  return {
    apiVersion: API_VERSION,
    builtIn: true,
    enabledByDefault: true,
    ...p,
    /* A plugin with a server or page half of its own is loaded through the
       plugin hosts; one without is still wired in by hand. */
    hosted: Boolean(p.server || p.client),
    requires: { capabilities: [], plugins: [], ...(p.requires || {}) }
  };
}

/** The path a plugin's routes sit under, below `/__lpp`: its id, unless it says otherwise. */
export const routeBase = (manifest) => manifest.routeBase || `/${manifest.id}`;

/** What a plugin id may look like: the same rule as an npm package name, minus scopes. */
export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Coerce the stored `plugins` setting into `{ [id]: { enabled?, settings? } }`.
 *
 * Unknown ids are KEPT, not dropped. An entry for a user plugin that is not
 * installed right now — a folder moved, a disk not mounted — must survive a
 * settings save, or reinstalling it silently resets it to off. Anything that is
 * not a boolean is dropped, so a hand-edited file cannot enable something by
 * accident with `"enabled": "no"`.
 *
 * A plugin's own `settings` are kept as an object and nothing more here: the
 * plugin's schema is what knows what is allowed in them, and `core/settings.js`
 * applies it where the plugin is installed. Where it is not, they are carried
 * untouched for the same reason the switch is.
 */
export function normalisePlugins(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [id, entry] of Object.entries(raw)) {
    if (!PLUGIN_ID.test(id) || !isPlainObject(entry)) continue;
    const kept = {};
    if (typeof entry.enabled === 'boolean') kept.enabled = entry.enabled;
    if (isPlainObject(entry.settings)) kept.settings = entry.settings;
    if (Object.keys(kept).length) out[id] = kept;
  }
  return out;
}

/**
 * The switch-and-dependency questions, over one set of manifests.
 *
 * The page and the settings card ask them of the built-ins, through the
 * functions exported below. The server's plugin host asks them of whatever it
 * actually loaded — which will include plugins nobody shipped — so it builds
 * its own registry rather than consulting a table that has never heard of them.
 */
export function createRegistry(manifests) {
  const byId = new Map(manifests.map((p) => [p.id, p]));
  const manifestOf = (id) => byId.get(id) || null;

  /**
   * Whether a plugin is switched on, before its dependencies are considered.
   * A plugin nobody has touched takes its manifest's default.
   */
  function isSwitchedOn(plugins, id) {
    const entry = plugins && plugins[id];
    if (entry && typeof entry.enabled === 'boolean') return entry.enabled;
    const manifest = manifestOf(id);
    return manifest ? manifest.enabledByDefault : false;
  }

  /**
   * Whether a plugin is on, all things considered, and if not, why.
   *
   * `can` answers platform capabilities; leave it out and capabilities are not
   * checked (the server gates on the switch and the dependencies alone — the
   * device store it would need to answer capabilities lives in the page).
   *
   * @returns {{on: boolean, reason: string|null}}
   */
  function status(plugins, id, can = null, seen = new Set()) {
    const manifest = manifestOf(id);
    if (!manifest) return { on: false, reason: 'not installed' };
    if (!isSwitchedOn(plugins, id)) return { on: false, reason: 'switched off' };
    if (can) {
      const missing = manifest.requires.capabilities.find((cap) => !can(cap));
      if (missing) return { on: false, reason: 'not on this switcher' };
    }
    /* A cycle would be a mistake in a manifest; treat it as "off" rather than
       recursing until the stack gives out. */
    if (seen.has(id)) return { on: false, reason: 'depends on itself' };
    seen.add(id);
    for (const dep of manifest.requires.plugins) {
      if (!status(plugins, dep, can, seen).on) {
        return { on: false, reason: `needs ${manifestOf(dep)?.name || dep}` };
      }
    }
    return { on: true, reason: null };
  }

  return {
    manifestOf,
    isSwitchedOn,
    status,
    /** Shorthand for the common question. */
    isEnabled: (plugins, id, can = null) => status(plugins, id, can).on
  };
}

const builtins = createRegistry(BUILTINS);

/** The manifest for a built-in plugin id, or null. */
export const manifestOf = builtins.manifestOf;
export const isSwitchedOn = builtins.isSwitchedOn;
export const status = builtins.status;
export const isEnabled = builtins.isEnabled;

/**
 * Which plugin owns an `/__lpp/…` route, or null for the core's own.
 *
 * Longest prefix first, so `/timecode/stream` is timecode's and not a
 * shorter match's. Kept here rather than in the proxy so that the table of
 * what a plugin owns lives in one place. A hosted plugin's base comes off its
 * manifest rather than being written here a second time.
 */
const ROUTES = [
  ['/matrix', 'matrix-routing'],
  ['/osc/stream', 'osc-input'],
  ['/config', 'setup-file'],
  ...BUILTINS.filter((p) => p.hosted).map((p) => [routeBase(p), p.id])
].sort((a, b) => b[0].length - a[0].length);

export function routeOwner(rest) {
  for (const [prefix, id] of ROUTES) {
    if (rest === prefix || rest.startsWith(prefix + '/')) return id;
  }
  return null;
}

/* ------------------------------------------------------------- user plugins */

/**
 * The first path segments under `/__lpp` that are the app's own. A plugin's
 * routes live at `/__lpp/<id>`, so a plugin called `settings` would sit on top
 * of the settings route — and the settings route is how a broken plugin gets
 * switched off. Every built-in's id and route base is reserved too.
 */
const CORE_SEGMENTS = [
  'awj', 'config', 'console', 'demo', 'device', 'groups', 'layer-names', 'matrix',
  'memory', 'memories', 'osc', 'plugins', 'properties', 'settings', 'src', 'stack',
  'status', 'timecode', 'timeline'
];
export const RESERVED_IDS = new Set([
  ...CORE_SEGMENTS,
  ...BUILTINS.map((p) => p.id),
  ...BUILTINS.map((p) => routeBase(p).slice(1).split('/')[0])
]);

/** A path inside a plugin's folder: relative, forward slashes, no way out. */
const insideFolder = (p) => typeof p === 'string' && /^[A-Za-z0-9._-][A-Za-z0-9._/-]*$/.test(p)
  && !p.split('/').some((seg) => seg === '..' || seg === '');

/**
 * Check a user plugin's `plugin.json` and turn it into a manifest.
 *
 * Refused rather than repaired, unlike a settings file: a manifest is written
 * by the plugin's author once, and a plugin whose manifest is wrong should say
 * so plainly on the settings page rather than load half-understood. The folder
 * name must be the id, so what is on disk and what is on the page cannot
 * disagree about which plugin is which.
 *
 * Whatever the file says, a user plugin is **off until switched on**
 * (`enabledByDefault` is forced false) and **not built in**, and it may not
 * move its routes off `/__lpp/<id>` or lift settings from the top level — both
 * of those exist for built-ins' history, and nothing else has any.
 *
 * @returns {{manifest: object} | {error: string}}
 */
export function validateManifest(raw, folder) {
  if (!isPlainObject(raw)) return { error: 'plugin.json is not a JSON object' };
  const { id, name, version, apiVersion, description = '', where = '', server, client } = raw;

  if (typeof id !== 'string' || !PLUGIN_ID.test(id)) return { error: 'its id must be lower-case letters, digits and dashes' };
  if (id !== folder) return { error: `its id is "${id}" but its folder is "${folder}" — they must match` };
  if (RESERVED_IDS.has(id)) return { error: `"${id}" is taken by this app or one of its built-in plugins` };
  if (typeof name !== 'string' || !name.trim()) return { error: 'it has no name' };
  if (typeof version !== 'string' || !version.trim()) return { error: 'it has no version' };
  if (!Number.isInteger(apiVersion) || apiVersion < 1) return { error: 'its apiVersion must be a whole number, 1 or more' };
  if (typeof description !== 'string' || typeof where !== 'string') return { error: 'its description and where must be text' };
  if (server === undefined && client === undefined) return { error: 'it names neither a server nor a client file' };
  for (const [key, file] of [['server', server], ['client', client]]) {
    if (file !== undefined && !insideFolder(file)) return { error: `its ${key} file must be a path inside its own folder` };
  }

  const requires = raw.requires === undefined ? {} : raw.requires;
  if (!isPlainObject(requires)) return { error: 'its requires must be an object' };
  const list = (v) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
  if (!list(requires.capabilities) || !list(requires.plugins)) {
    return { error: 'requires.capabilities and requires.plugins must be lists of names' };
  }

  return {
    manifest: withDefaults({
      id,
      name: name.trim(),
      version: version.trim(),
      apiVersion,
      description,
      where,
      ...(server !== undefined ? { server } : {}),
      ...(client !== undefined ? { client } : {}),
      requires: { capabilities: requires.capabilities || [], plugins: requires.plugins || [] },
      builtIn: false,
      enabledByDefault: false
    })
  };
}
