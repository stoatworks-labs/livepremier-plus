/*
 * Re-copy the Pixelhue console core from a pixelhue-bridge checkout.
 *
 *   npm run sync:pixelhue-core                  looks in ../pixelhue-bridge
 *   npm run sync:pixelhue-core -- /path/to/repo
 *
 * Same reasoning as `sync-surface-core.mjs` and the VPU model: one
 * implementation of the console's wire format, copied rather than re-derived,
 * so two tools in this fleet cannot reach different conclusions about the same
 * hardware. pixelhue-bridge is where that format was worked out, its
 * `docs/protocols.md` is where the evidence is written down, and its
 * `core/apollo.js` has now been decoded against a live UCenter.
 *
 * ⚠️ pixelhue-bridge has **no public remote yet**, so the manifest records a
 * local commit. When it is published this file needs nothing changed but the
 * `upstream` string.
 *
 * What comes across:
 *
 *   apollo.js    the NOVA frame codec — 22-byte header, two TLVs, CRC-16/X-25
 *   crc16.js     the CRC the header carries twice
 *   tags.js      message tags and the key-state constants
 *
 * Only what is used. Upstream also has the per-console key tables, a PNG
 * encoder and the mini's TCP 17100 protocol, and all three are 17,000 lines of
 * data and code this preview never imports: publishing a model means the
 * console labels its own keys, so nothing here needs to know where key 65 is
 * or how to draw on it. They come across the day the raw-key route or the
 * mini's LCD grid needs them — add them to `WANTED` and re-run.
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const destDir = join(here, '..', 'src', 'vendor', 'pixelhue');
const upstreamRepo = resolve(process.argv[2] || join(here, '..', '..', 'pixelhue-bridge'));
const upstreamDir = join(upstreamRepo, 'core');

const WANTED = ['apollo.js', 'crc16.js', 'tags.js'];

let commit = 'unknown';
let dirty = false;
try {
  commit = execFileSync('git', ['-C', upstreamRepo, 'log', '-1', '--format=%H', '--', 'core'],
    { encoding: 'utf8' }).trim();
  dirty = execFileSync('git', ['-C', upstreamRepo, 'status', '--short', '--', 'core'],
    { encoding: 'utf8' }).trim().length > 0;
} catch {
  console.error(`! no git checkout at ${upstreamRepo} — is pixelhue-bridge beside this repo?`);
  process.exit(1);
}
if (dirty) {
  console.error('! upstream core/ has uncommitted changes — commit there first');
  process.exit(1);
}

await rm(destDir, { recursive: true, force: true });
const manifest = {
  upstream: 'stoatworks-labs/pixelhue-bridge',
  published: false,
  path: 'core',
  commit,
  synced: new Date().toISOString().slice(0, 10),
  files: {},
};

for (const rel of WANTED) {
  let body;
  try {
    body = await readFile(join(upstreamDir, rel));
  } catch {
    console.error(`! ${rel} is missing upstream`);
    process.exit(1);
  }
  manifest.files[rel] = createHash('sha256').update(body).digest('hex');
  const target = join(destDir, rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}

await writeFile(join(destDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(destDir, 'README.md'), `# VENDORED — do not edit anything in this directory

Part of \`core/\` from **pixelhue-bridge**, the Pixelhue U-series console driver.
Same reasoning as \`../surface/\` and \`../vpu-model.js\`: one implementation of
the console's wire format, copied rather than re-derived.

Upstream commit \`${commit}\`, synced ${manifest.synced} — ${WANTED.length} files.

⚠️ **pixelhue-bridge is not published yet**, so that commit is local. The
evidence for every byte of this format lives in its \`docs/protocols.md\`, and
the frame codec has been decoded against a live UCenter (see
pixelhue-re's \`docs/console-rig.md\`).

\`npm run sync:pixelhue-core\` re-copies it and rewrites \`MANIFEST.json\`;
\`test/vendor.test.js\` fails when the copy has drifted from a checkout, and
skips when there is not one to compare with.

Edits belong upstream, in pixelhue-bridge's \`core/\`.
`);

console.log(`synced ${WANTED.length} files from ${upstreamRepo}`);
console.log(`  commit ${commit}`);
