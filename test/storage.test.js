/*
 * The files the app keeps: cue stacks, settings, groups, names, the patch, and
 * every plugin's per-switcher document through `writeJsonAtomic`.
 *
 * What is pinned is the one thing that went wrong: two saves of the same file
 * at once. Every write used the temporary name `<file>.<pid>.tmp`, so two
 * saves in one process shared it — the first rename took it, the second
 * failed with ENOENT, and which document ended up on disk depended on timing.
 * Found 2026-10-16 when three layer renames in a row lost one PUT each time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeJsonAtomic, StackStore } from '../server/storage.js';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'lpp-storage-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('saves of one file at the same moment all succeed, and the last one is what is kept', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'names.json');
    const writes = [];
    for (let i = 0; i < 20; i++) writes.push(writeJsonAtomic(file, { n: i }));
    await Promise.all(writes);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { n: 19 });
  });
});

test('no temporary file is left behind', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'stack.json');
    await Promise.all([1, 2, 3].map((n) => writeJsonAtomic(file, { n })));
    assert.deepEqual(await readdir(dir), ['stack.json']);
  });
});

test('a write that fails does not stop the next one', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'doc.json');
    const cyclic = {};
    cyclic.self = cyclic;
    await assert.rejects(writeJsonAtomic(file, cyclic));
    await writeJsonAtomic(file, { ok: true });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ok: true });
    assert.deepEqual(await readdir(dir), ['doc.json']);
  });
});

test('every StackStore save goes through it: concurrent saves of each kind keep the last', async () => {
  await withDir(async (dir) => {
    const store = new StackStore(dir);
    const key = '127.0.0.1:3000';
    const many = (fn) => Promise.all([1, 2, 3, 4, 5].map(fn));
    await many((n) => store.save(key, { n }));
    await many((n) => store.saveNames(key, { version: 1, names: { 'S1/1': `name ${n}` } }));
    await many((n) => store.saveGroups(key, { version: 1, groups: [], n }));
    await many((n) => store.saveSettings({ n }));
    await many((n) => store.saveMatrices([{ id: `r${n}` }]));
    await many((n) => store.savePatch(key, [{ n }]));
    await many((n) => store.saveDevice(`10.0.0.${n}`));

    assert.deepEqual(await store.load(key), { n: 5 });
    assert.equal((await store.loadNames(key)).names['S1/1'], 'name 5');
    assert.equal((await store.loadGroups(key)).n, 5);
    assert.deepEqual(await store.loadSettings(), { n: 5 });
    assert.deepEqual(await store.loadMatrices(), [{ id: 'r5' }]);
    assert.deepEqual(await store.loadPatch(key), [{ n: 5 }]);
    assert.equal(await store.loadDevice(), '10.0.0.5');
    assert.equal((await readdir(dir)).filter((f) => f.endsWith('.tmp')).length, 0);
  });
});
