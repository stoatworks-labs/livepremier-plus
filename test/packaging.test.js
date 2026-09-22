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
