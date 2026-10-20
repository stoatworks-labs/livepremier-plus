/*
 * Copy pdf.js into `src/vendor/pdfjs/` from an installed `pdfjs-dist`.
 *
 *   npm run sync:pdfjs -- /path/to/pdfjs-dist     an installed or unpacked package
 *
 * 6.3.289 was synced from `npm pack pdfjs-dist@6.3.289`, the version PDF
 * Presenter's lockfile pins (its sha512 matched the lockfile's integrity).
 *
 * The Background Slicer opens a PDF — or a deck the server has turned into
 * one — and draws its pages in the page at whatever size they are placed. That
 * is pdf.js, Mozilla's, and it is the renderer PDF Presenter and Presentation
 * Commander already ship, so this copies the build they install rather than
 * choosing a second one. This repo has no dependencies and keeps none: the
 * files are copied, not installed.
 *
 * What comes across, and why each:
 *
 *   - `pdf.min.mjs` and `pdf.worker.min.mjs` — the library and its worker.
 *   - `wasm/` — the JPEG 2000, JBIG2 and ICC decoders. pdf.js fetches them
 *     at run time from `wasmUrl` and draws nothing for an image it cannot
 *     decode (Presentation Commander 74a0e35 found it the hard way).
 *   - `standard_fonts/`, `cmaps/`, `iccs/` — for PDFs that do not embed
 *     their fonts, CJK text and CMYK pictures.
 *
 * Left out: the scripting sandbox and QuickJS — a still has no use for a
 * PDF's JavaScript — and the viewer.
 *
 * `MANIFEST.json` records the version and the SHA-256 of every file, so
 * `test/vendor.test.js` can tell a deliberate sync from an edit in place.
 */

import { readFile, writeFile, mkdir, rm, readdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const destDir = join(here, '..', 'src', 'vendor', 'pdfjs');
if (!process.argv[2]) {
  console.error('usage: npm run sync:pdfjs -- /path/to/pdfjs-dist');
  process.exit(1);
}
const source = resolve(process.argv[2]);

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const FILES = ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'LICENSE'];
/* QuickJS (`quickjs-eval.wasm`) runs a PDF's own JavaScript: not wanted. */
const DIRS = { wasm: /^(openjpeg|jbig2|qcms_bg)\.wasm$|^LICENSE/, standard_fonts: /./, cmaps: /./, iccs: /./ };

let pkg;
try {
  pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
} catch {
  console.error(`! no pdfjs-dist at ${source}`);
  process.exit(1);
}
if (pkg.name !== 'pdfjs-dist') {
  console.error(`! ${source} is ${pkg.name}, not pdfjs-dist`);
  process.exit(1);
}

await rm(destDir, { recursive: true, force: true });
await mkdir(destDir, { recursive: true });
const files = {};
const put = async (from, to) => {
  await mkdir(dirname(join(destDir, to)), { recursive: true });
  await copyFile(join(source, from), join(destDir, to));
  files[to] = sha(await readFile(join(destDir, to)));
};
for (const f of FILES) await put(f, f.replace(/^build\//, ''));
for (const [dir, keep] of Object.entries(DIRS)) {
  for (const name of (await readdir(join(source, dir))).sort()) {
    if (keep.test(name)) await put(join(dir, name), join(dir, name));
  }
}

const manifest = {
  upstream: 'pdfjs-dist (Mozilla pdf.js)',
  version: pkg.version,
  license: pkg.license,
  homepage: pkg.homepage,
  synced: new Date().toISOString().slice(0, 10),
  files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
};
await writeFile(join(destDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`pdf.js ${pkg.version}: ${Object.keys(files).length} files into src/vendor/pdfjs/`);
