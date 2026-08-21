/*
 * Re-copy the VPU model from an aquilon-vpu-map checkout.
 *
 * The two projects must agree about what a device is doing, so the model is
 * shared by copy — a Chrome extension has to contain every file it loads, and
 * there is no build step here to resolve an import across repos.
 *
 *   npm run sync:vpu-model                  looks in ../aquilon-vpu-map
 *   npm run sync:vpu-model -- /path/to/repo
 *
 * Rewrites the provenance header with the upstream commit and content hash, so
 * `test/vendor.test.js` can tell a deliberate sync from silent drift.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, '..', 'src', 'vendor', 'vpu-model.js');
const upstreamRepo = resolve(process.argv[2] || join(here, '..', '..', 'aquilon-vpu-map'));
const upstreamFile = join(upstreamRepo, 'public', 'vpu.js');

const source = await readFile(upstreamFile, 'utf8');
const hash = createHash('sha256').update(source).digest('hex');

let commit = 'unknown';
let dirty = false;
try {
  commit = execFileSync('git', ['-C', upstreamRepo, 'log', '-1', '--format=%H', '--', 'public/vpu.js'],
    { encoding: 'utf8' }).trim();
  dirty = execFileSync('git', ['-C', upstreamRepo, 'status', '--short', '--', 'public/vpu.js'],
    { encoding: 'utf8' }).trim().length > 0;
} catch {
  console.warn('! upstream is not a git checkout; recording commit as unknown');
}

/* Syncing from a modified working copy records a commit that does not contain
   what was copied. Refuse rather than write a provenance line that lies. */
if (dirty) {
  console.error('! upstream public/vpu.js has uncommitted changes — commit there first');
  process.exit(1);
}

const existing = await readFile(dest, 'utf8');
const headerEnd = existing.indexOf(' * ------------------------------------------------------------------------- */');
if (headerEnd < 0) throw new Error('vendored file has lost its provenance header');
const header = existing.slice(0, headerEnd + 79);

const updated = header
  .replace(/\* Commit:\s+\S+/, `* Commit:    ${commit}`)
  .replace(/\* Synced:\s+\S+/, `* Synced:    ${new Date().toISOString().slice(0, 10)}`);

await writeFile(dest, updated + '\n\n' + source);
console.log(`synced from ${upstreamFile}`);
console.log(`  commit ${commit}`);
console.log(`  sha256 ${hash}`);
