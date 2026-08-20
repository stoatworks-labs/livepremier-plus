/*
 * Every module must actually parse as an ES module.
 *
 * This test exists because `node --check` does not do that job. It exits 0 on
 * a file with an unbalanced argument list if the file also parses as
 * CommonJS-ambiguous, and it did exactly that on a real error here that only
 * surfaced when the browser refused to load the panel. Importing is the check;
 * --check is not.
 *
 * main.js and the hook are excluded deliberately: one boots the app on import
 * and the other is a classic script that expects a page.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SKIP = new Set(['main.js', 'loader.js', 'ws-hook.js']);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.name.endsWith('.js') && !SKIP.has(entry.name)) out.push(full);
  }
  return out;
}

test('every module parses and links', async () => {
  const files = await walk(src);
  assert.ok(files.length >= 8, 'expected to find the module tree');
  for (const file of files) {
    await assert.doesNotReject(
      () => import(pathToFileURL(file).href),
      'failed to import ' + relative(src, file));
  }
});
