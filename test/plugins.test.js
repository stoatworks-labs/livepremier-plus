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
  BUILTINS, API_VERSION, manifestOf, normalisePlugins, isSwitchedOn, status, isEnabled, routeOwner
} from '../src/core/plugins.js';
import { normalise as normaliseSettings, DEFAULT_SETTINGS } from '../src/core/settings.js';

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
  assert.equal(routeOwner('/timeline'), 'timeline');
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
