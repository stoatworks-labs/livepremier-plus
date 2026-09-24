/*
 * Every place the app is packaged carries every tree it runs from.
 *
 * The app starts without a missing plugin — the host logs it and carries on,
 * which is right for a user's plugin folder and wrong for a release: a Docker
 * image or desktop bundle built without `plugins/` would ship with features
 * quietly absent and nothing failing. This reads the two packaging scripts and
 * checks each copies all three trees.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TREES = ['server', 'src', 'plugins'];

test('the Docker image copies every tree the app runs from', async () => {
  const dockerfile = await readFile(join(ROOT, 'Dockerfile'), 'utf8');
  for (const tree of TREES) {
    assert.match(dockerfile, new RegExp(`^COPY ${tree}/ \\./${tree}/$`, 'm'), `Dockerfile copies ${tree}/`);
  }
});

test('the desktop bundle stages every tree the app runs from', async () => {
  const prepare = await readFile(join(ROOT, 'launcher/scripts/prepare.sh'), 'utf8');
  for (const tree of TREES) {
    assert.ok(prepare.includes(`cp -R "$REPO/${tree}" "$APP/${tree}"`), `prepare.sh stages ${tree}/`);
  }
});

/*
 * node-hid is optional to the app — a checkout without it runs, the Speed
 * Editor says it has no USB — so nothing else fails when the desktop bundle
 * leaves it out. This is the check that it does not.
 */
test('the desktop bundle stages node-hid from the lockfile, and signs its addon', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/node-hid']?.version, pkg.optionalDependencies['node-hid'], 'the lockfile pins what package.json asks for');
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'node-hid stays optional; nothing else is a dependency');

  const prepare = await readFile(join(ROOT, 'launcher/scripts/prepare.sh'), 'utf8');
  assert.ok(prepare.includes('cp "$REPO/package-lock.json" "$APP/package-lock.json"'), 'prepare.sh copies the lockfile');
  assert.match(prepare, /npm ci --omit=dev --ignore-scripts/, 'prepare.sh installs node-hid from it');

  const sign = await readFile(join(ROOT, 'launcher/scripts/sign-embedded.sh'), 'utf8');
  assert.match(sign, /-name '\*\.node'/, 'sign-embedded.sh signs the addon');
});
