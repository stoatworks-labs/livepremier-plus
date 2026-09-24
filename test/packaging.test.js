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
 * The device host is optional to the app — without it the app runs and each
 * device page says why it has no panel — so nothing else fails when the
 * desktop bundle leaves it out. This is the check that it does not, and that
 * its dependency stays its own.
 */
test('the desktop bundle stages the device host, installs it from its lockfile, and signs its addon', async () => {
  const app = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual([...Object.keys(app.dependencies ?? {}), ...Object.keys(app.optionalDependencies ?? {})], [],
    'the app itself has no dependencies; the device host has its own');
  const pkg = JSON.parse(await readFile(join(ROOT, 'devices/package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(ROOT, 'devices/package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/node-hid']?.version, pkg.dependencies['node-hid'], 'the lockfile pins what devices/package.json asks for');

  const prepare = await readFile(join(ROOT, 'launcher/scripts/prepare.sh'), 'utf8');
  assert.match(prepare, /--exclude \.\/node_modules \. \) \| \( cd "\$APP\/devices"/, 'prepare.sh stages devices/, without a checkout\'s node_modules');
  assert.match(prepare, /cd "\$APP\/devices" && npm ci --omit=dev --ignore-scripts/, 'prepare.sh installs the host from its lockfile');

  const dockerfile = await readFile(join(ROOT, 'Dockerfile'), 'utf8');
  assert.doesNotMatch(dockerfile, /^COPY devices/m, 'a container has no USB, so no device host');

  const sign = await readFile(join(ROOT, 'launcher/scripts/sign-embedded.sh'), 'utf8');
  assert.match(sign, /-name '\*\.node'/, 'sign-embedded.sh signs the addon');
});
