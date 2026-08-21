/*
 * Re-copy the control-surface engine from an awj-surface checkout.
 *
 *   npm run sync:surface-core                  looks in ../awj-surface
 *   npm run sync:surface-core -- /path/to/repo
 *
 * awj-surface already separates a host-agnostic `core/` from its hosts — it
 * ships `hosts/node/` and once carried a `hosts/extension/` intended for this
 * project back when this was a Chrome extension. The extension host is gone;
 * this repo is the browser host now, and it uses the same core rather than a
 * second implementation of it.
 *
 * Unlike the VPU model and the Mynah language this is a whole directory, so
 * the provenance lives in a manifest beside the copy: every file with its
 * hash, plus the upstream commit. `test/vendor.test.js` compares the tree.
 *
 * Nothing here is edited in this repo. The engine's contract is small and it
 * is the same one the node host uses:
 *
 *   surface.handle(bytes)            MIDI in  -> a control event
 *   engine.input(event)              control event -> device intent
 *   engine.on('write')               {writes:[{path,value}]} in STORE form
 *   engine.deviceChanged(path)       tell it the device moved
 *   engine.on('feedback')            -> surface.render(detail)
 */

import { readFile, writeFile, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const destDir = join(here, '..', 'src', 'vendor', 'surface');
const upstreamRepo = resolve(process.argv[2] || join(here, '..', '..', 'awj-surface'));
const upstreamDir = join(upstreamRepo, 'core');
/* The stock controller profiles are data the panel offers directly, so they
   come along. `profiles/saved/` is a user's own working copies upstream and is
   deliberately left behind. */
const profilesDir = join(upstreamRepo, 'profiles');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out.sort();
}

let files;
try {
  files = await walk(upstreamDir);
} catch {
  console.error(`! no ${upstreamDir} — is awj-surface checked out beside this repo?`);
  process.exit(1);
}

let commit = 'unknown';
let dirty = false;
try {
  commit = execFileSync('git', ['-C', upstreamRepo, 'log', '-1', '--format=%H', '--', 'core'],
    { encoding: 'utf8' }).trim();
  dirty = execFileSync('git', ['-C', upstreamRepo, 'status', '--short', '--', 'core'],
    { encoding: 'utf8' }).trim().length > 0;
} catch {
  console.warn('! upstream is not a git checkout; recording commit as unknown');
}
if (dirty) {
  console.error('! upstream core/ has uncommitted changes — commit there first');
  process.exit(1);
}

await rm(destDir, { recursive: true, force: true });
const manifest = { upstream: 'stoatworks-labs/awj-surface', path: 'core', commit,
  synced: new Date().toISOString().slice(0, 10), files: {} };

let profiles = [];
try {
  profiles = (await readdir(profilesDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => join(profilesDir, e.name))
    .sort();
} catch { /* a checkout without profiles is not fatal */ }

for (const file of files) {
  const rel = relative(upstreamDir, file);
  const body = await readFile(file);
  manifest.files[rel] = createHash('sha256').update(body).digest('hex');
  const target = join(destDir, rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}

for (const file of profiles) {
  const rel = join('profiles', relative(profilesDir, file));
  const body = await readFile(file);
  manifest.files[rel] = createHash('sha256').update(body).digest('hex');
  const target = join(destDir, rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}

await writeFile(join(destDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(destDir, 'README.md'), `# VENDORED — do not edit anything in this directory

A copy of \`core/\` from [awj-surface](https://github.com/stoatworks-labs/awj-surface),
the control-surface engine. Same reasoning as \`../vpu-model.js\` and
\`../mynah-lang.mjs\`: one implementation, copied rather than re-derived, so two
tools cannot reach different conclusions about the same device.

Upstream commit \`${commit}\`, synced ${manifest.synced} — ${files.length} core files
and ${profiles.length} stock controller profiles.

\`npm run sync:surface-core\` re-copies it and rewrites \`MANIFEST.json\`;
\`test/vendor.test.js\` fails when the copy has drifted from an upstream
checkout, and skips when there is not one to compare with.

Edits belong upstream, in awj-surface's \`core/\`.
`);

console.log(`synced ${files.length} core files and ${profiles.length} profiles from ${upstreamRepo}`);
console.log(`  commit ${commit}`);
