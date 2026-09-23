/*
 * The plugin registry: what the app is made of, and what is switched on.
 *
 * Two properties matter more than the rest, because each one failing is a
 * quiet way to lose a feature: an untouched plugin must be ON (nobody who
 * upgrades should find their tools gone), and a setting for a plugin that is
 * not installed right now must SURVIVE a save (or reinstalling it resets it).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTINS, API_VERSION, manifestOf, normalisePlugins, isSwitchedOn, status, isEnabled, routeOwner,
  createRegistry, withDefaults
} from '../src/core/plugins.js';
import {
  normalise as normaliseSettings, DEFAULT_SETTINGS, liftLegacy, mergeSettings, changedPluginSettings
} from '../src/core/settings.js';

test('every built-in is described once, on the current API, and on by default', () => {
  const ids = BUILTINS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'no id twice');
  for (const p of BUILTINS) {
    assert.equal(p.apiVersion, API_VERSION);
    assert.equal(p.builtIn, true);
    assert.equal(p.enabledByDefault, true, `${p.id} must be on for anyone upgrading`);
    assert.ok(p.name && p.description && p.where, `${p.id} says what and where`);
    assert.ok(Array.isArray(p.requires.capabilities) && Array.isArray(p.requires.plugins));
  }
});

test('every plugin a manifest depends on exists', () => {
  for (const p of BUILTINS) {
    for (const dep of p.requires.plugins) assert.ok(manifestOf(dep), `${p.id} needs ${dep}, which is not a plugin`);
  }
});

test('an untouched plugin is on; a switch is honoured', () => {
  assert.equal(isEnabled({}, 'companion'), true);
  assert.equal(isEnabled({ companion: { enabled: false } }, 'companion'), false);
  assert.equal(isSwitchedOn({ companion: { enabled: true } }, 'companion'), true);
});

test('a plugin nobody has heard of is off', () => {
  assert.equal(isEnabled({}, 'not-a-plugin'), false);
  assert.equal(status({}, 'not-a-plugin').reason, 'not installed');
});

test('switching off a dependency takes its dependents with it, and says why', () => {
  const plugins = { 'layer-groups': { enabled: false } };
  const sendTo = status(plugins, 'send-to');
  assert.equal(sendTo.on, false);
  assert.match(sendTo.reason, /needs Layer Groups/);
  /* …while its own switch is untouched, so switching Groups back on restores it. */
  assert.equal(isSwitchedOn(plugins, 'send-to'), true);
  assert.equal(isEnabled({}, 'send-to'), true);
});

test('the platform half is only asked when a capability check is given', () => {
  const noVpu = (cap) => cap !== 'vpuMap';
  assert.equal(status({}, 'vpu-map', noVpu).reason, 'not on this switcher');
  assert.equal(isEnabled({}, 'vpu-map'), true, 'the server has no store to ask, and does not');
  assert.equal(isEnabled({}, 'companion', noVpu), true, 'a plugin with no capability needs none');
});

test('the stored setting keeps unknown plugins and drops anything malformed', () => {
  const out = normalisePlugins({
    companion: { enabled: false },
    'someones-plugin': { enabled: true },
    typo: { enabled: 'no' },
    'Not An Id': { enabled: true },
    junk: 'yes'
  });
  assert.deepEqual(out, { companion: { enabled: false }, 'someones-plugin': { enabled: true } });
  assert.deepEqual(normalisePlugins(null), {});
  assert.deepEqual(normalisePlugins(['companion']), {});
});

test('settings carry the switches through their own normalise', () => {
  assert.deepEqual(DEFAULT_SETTINGS.plugins, {});
  const s = normaliseSettings({ plugins: { edit: { enabled: false } } });
  assert.deepEqual(s.plugins, { edit: { enabled: false } });
  assert.deepEqual(normaliseSettings({}).plugins, {});
});

test('every route a plugin owns is found, longest prefix first', () => {
  assert.equal(routeOwner('/companion'), 'companion');
  assert.equal(routeOwner('/companion/ui/buttons'), 'companion');
  assert.equal(routeOwner('/memory'), 'edit');
  assert.equal(routeOwner('/memories'), 'memories', 'not the Edit page’s /memory');
  assert.equal(routeOwner('/matrix/patch'), 'matrix-routing');
  assert.equal(routeOwner('/timecode/stream'), 'timecode');
  assert.equal(routeOwner('/groups'), 'layer-groups', 'a base moved to keep its address');
  assert.equal(routeOwner('/stack'), 'timeline');
  assert.equal(routeOwner('/osc/stream'), 'osc-input');
  assert.equal(routeOwner('/config/inspect'), 'setup-file');
});

test('the core’s own routes belong to no plugin, so none can switch them off', () => {
  for (const rest of ['/settings', '/status', '/device', '/awj', '/', '/src/main.js']) {
    assert.equal(routeOwner(rest), null, rest);
  }
  /* A prefix must match a whole segment: /matrixfoo is nobody's. */
  assert.equal(routeOwner('/matrixfoo'), null);
});

/* ------------------------------------------------------------ hosted, phase 1 */

test('a hosted built-in names its halves, and an in-place one has none', () => {
  const companion = manifestOf('companion');
  assert.equal(companion.hosted, true);
  assert.equal(companion.server, 'server.js');
  assert.equal(companion.client, 'client.js');
  /* Hosted means having a half of its own, for every built-in, whichever
     phase has moved it. */
  for (const b of BUILTINS) assert.equal(b.hosted, Boolean(b.server || b.client), b.id);
  /* Its routes are still owned — the table reads the base off the manifest. */
  assert.equal(routeOwner('/companion/stream'), 'companion');
});

test('every built-in is a plugin with a half of its own: nothing is wired in by hand', () => {
  /* The end of the move. A manifest with neither half would be a feature
     edited into main.js or proxy.js again — the shotgun surgery the plugin
     layout exists to stop. A new feature is a new folder in plugins/. */
  const inPlace = BUILTINS.filter((b) => !b.hosted).map((b) => b.id);
  assert.deepEqual(inPlace, []);
});

test('a registry answers for exactly the manifests it was given', () => {
  const reg = createRegistry([
    withDefaults({ id: 'a', name: 'A' }),
    withDefaults({ id: 'b', name: 'B', requires: { plugins: ['a'] } }),
    withDefaults({ id: 'c', name: 'C', enabledByDefault: false, builtIn: false })
  ]);
  assert.equal(reg.isEnabled({}, 'b'), true);
  assert.equal(reg.status({ a: { enabled: false } }, 'b').reason, 'needs A');
  /* A plugin that is not built in starts off until somebody switches it on. */
  assert.equal(reg.isEnabled({}, 'c'), false);
  assert.equal(reg.isEnabled({ c: { enabled: true } }, 'c'), true);
  /* The built-ins are not in it, and it is not in the built-ins. */
  assert.equal(reg.status({}, 'companion').reason, 'not installed');
  assert.equal(status({}, 'a').reason, 'not installed');
});

test('a plugin’s settings ride beside its switch, and survive when nothing can read them', () => {
  const out = normalisePlugins({
    theirs: { enabled: true, settings: { colour: 'teal' } },
    listless: { settings: ['not', 'an', 'object'] },
    bare: { settings: { x: 1 } }
  });
  assert.deepEqual(out, {
    theirs: { enabled: true, settings: { colour: 'teal' } },
    bare: { settings: { x: 1 } }
  });
});

const SCHEMAS = {
  companion: {
    normalise: (raw) => ({ companionHost: typeof raw.companionHost === 'string' ? raw.companionHost : '', companionPort: raw.companionPort || 8000 }),
    legacy: ['companionHost', 'companionPort']
  }
};

test('settings from before the namespace are lifted into their plugin, and win', () => {
  const lifted = liftLegacy({
    companionHost: 'new.local',
    consoleLanguage: 'awj',
    plugins: { companion: { enabled: false, settings: { companionHost: 'old.local', companionPort: 9000 } } }
  }, SCHEMAS);
  assert.equal(lifted.companionHost, undefined, 'gone from the top level');
  assert.equal(lifted.consoleLanguage, 'awj', 'the app’s own fields are not touched');
  assert.deepEqual(lifted.plugins.companion, {
    enabled: false,
    settings: { companionHost: 'new.local', companionPort: 9000 }
  });
  /* Nothing to lift is no change at all. */
  const plain = { consoleLanguage: 'all' };
  assert.equal(liftLegacy(plain, SCHEMAS), plain);
});

test('normalise fills in an installed plugin’s settings, and leaves an absent one’s alone', () => {
  const s = normaliseSettings({
    companionHost: 'companion.local',
    plugins: { gone: { enabled: true, settings: { anything: [1, 2] } } }
  }, SCHEMAS);
  assert.deepEqual(s.plugins.companion, { settings: { companionHost: 'companion.local', companionPort: 8000 } });
  assert.deepEqual(s.plugins.gone, { enabled: true, settings: { anything: [1, 2] } });
  assert.equal('companionHost' in s, false);
});

test('a switch never wipes a plugin’s settings, and saving settings never flips its switch', () => {
  const current = { consoleLanguage: 'all', plugins: { companion: { enabled: true, settings: { companionHost: 'a', companionPort: 1 } } } };
  const off = mergeSettings(current, { plugins: { companion: { enabled: false } } });
  assert.deepEqual(off.plugins.companion, { enabled: false, settings: { companionHost: 'a', companionPort: 1 } });
  const moved = mergeSettings(current, { plugins: { companion: { settings: { companionPort: 2 } } } });
  assert.deepEqual(moved.plugins.companion, { enabled: true, settings: { companionHost: 'a', companionPort: 2 } });
  assert.equal(mergeSettings(current, { consoleLanguage: 'awj' }).plugins, current.plugins, 'untouched when not sent');
});

test('only a change the schema cares about counts as a change', () => {
  const schemas = { ...SCHEMAS, companion: { ...SCHEMAS.companion, changed: (a, b) => a.companionHost !== b.companionHost } };
  const at = (host, port) => ({ plugins: { companion: { settings: { companionHost: host, companionPort: port } } } });
  assert.deepEqual(changedPluginSettings(at('a', 1), at('a', 2), schemas), []);
  assert.deepEqual(changedPluginSettings(at('a', 1), at('b', 1), schemas), ['companion']);
  /* With no `changed` of its own, any difference is one. */
  assert.deepEqual(changedPluginSettings(at('a', 1), at('a', 2), SCHEMAS), ['companion']);
});
