/*
 * Background Slicer — a deck turned into a PDF on the machine this app runs
 * on, so the page can draw its slides with pdf.js. Server only; nothing here
 * runs in the page, and importing it does nothing.
 *
 * A PDF needs none of this: the page opens one itself. A PowerPoint or
 * OpenDocument deck has no renderer a browser can use, so the deck is handed
 * to an application that draws it as its author saw it, and the PDF it
 * exports comes back. Two engines, tried in this order:
 *
 *   1. **Microsoft PowerPoint** (macOS), driven over AppleScript — the
 *      reference renderer for a PowerPoint deck: its fonts, its effects, its
 *      layout. Proved on PowerPoint 16.112.3, macOS 26.4.1 (2026-10-20).
 *   2. **LibreOffice**, headless, anywhere it is installed — the engine for
 *      OpenDocument, and for a PowerPoint deck on a machine with no
 *      PowerPoint (a Linux box, the Docker image if LibreOffice is added).
 *      The arguments are presentation-converter's (`engines/libreoffice.ts`),
 *      a private profile per run included. Not run here: LibreOffice is not
 *      installed on the machine this was written on.
 *
 * **Not Keynote.** presentation-converter drives Keynote over JXA, and on
 * this Mac (macOS 26.4.1, 2026-10-20) neither Keynote would do it: Keynote
 * 14.5 opens to a modal "Use the New Version of Keynote" and waits there,
 * and Keynote Creator Studio 15.3.1 (`com.apple.Keynote`) opens the deck and
 * then answers every scripting question about it with -1728 / -1700 ("Can't
 * get every document", "Can't make unmerge id … into type specifier"). A
 * Keynote deck is exported to PDF from Keynote by hand and opened as a PDF.
 *
 * ## PowerPoint, and the four things that make it work unattended
 *
 *   - **The deck is copied into PowerPoint's own sandbox container**
 *     (`~/Library/Containers/com.microsoft.Powerpoint/Data/tmp/`) and the
 *     PDF exported beside it. A sandboxed PowerPoint asked to save anywhere
 *     else stops to ask for the folder ("Grant File Access"), which nobody
 *     is there to answer.
 *   - **The copy has a name nothing else has** (`lpp-<random>.pptx`), and the
 *     script finds the presentation by it — never `active presentation`,
 *     which is whatever the operator last clicked if PowerPoint is open.
 *   - **Only that presentation is closed**, unsaved; PowerPoint is quit only
 *     if it was not running before. The operator's own decks are not touched.
 *   - **One at a time.** Two conversions would be two documents in one app,
 *     and the second waits for the first (`queue`).
 *
 * The first conversion asks macOS whether this app may control PowerPoint
 * (Privacy & Security ▸ Automation). The packaged launcher declares why
 * (`NSAppleEventsUsageDescription`) and is entitled to ask
 * (`com.apple.security.automation.apple-events`); refused, AppleScript
 * answers -1743 and the panel says where to allow it.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, copyFile, readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, extname, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

/** The deck types the server takes, by extension, and what to call them. */
export const DECK_TYPES = {
  pptx: 'PowerPoint',
  ppt: 'PowerPoint 97–2003',
  ppsx: 'PowerPoint show',
  pps: 'PowerPoint 97–2003 show',
  potx: 'PowerPoint template',
  odp: 'OpenDocument presentation'
};

/** The biggest deck taken: a deck with video in it is large, and it goes to a temporary file, not memory. */
export const MAX_BYTES = 1024 * 1024 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;

export const extOf = (name) => extname(String(name || '')).slice(1).toLowerCase();

/* ------------------------------------------------------------- running */

/**
 * Run a program and collect what it says. Rejects with its own words on a
 * non-zero exit or the timeout, which kills it.
 */
export function run(cmd, args, { timeoutMs = TIMEOUT_MS, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let done = false;
    const child = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      reject(new Error(`${cmd} did not finish in ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(Object.assign(new Error((err || out).trim() || `${cmd} exited ${code}`), { code }));
    });
  });
}

/** One conversion at a time, whichever engine: see the head of the file. */
let tail = Promise.resolve();
export function queue(fn) {
  const next = tail.then(fn, fn);
  tail = next.catch(() => {});
  return next;
}

const exists = async (p, mode = constants.R_OK) => { try { await access(p, mode); return true; } catch { return false; } };

/* ---------------------------------------------------------- PowerPoint */

const POWERPOINT_ID = 'com.microsoft.Powerpoint';

/** Whether an application is installed, by bundle id, without talking to it (no Automation prompt). */
async function macAppPath(bundleId, runImpl) {
  try {
    const { stdout } = await runImpl('osascript', ['-l', 'JavaScript', '-e',
      'ObjC.import("AppKit"); function run(a) { var u = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier($(a[0])); return u ? ObjC.unwrap(u.path) : ""; }',
      bundleId], { timeoutMs: 15000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/*
 * Open the copy, find it by its own name, export it, close it unsaved, and
 * quit PowerPoint only if this started it. Proved line by line on
 * PowerPoint 16.112.3 with PowerPoint already open on another deck.
 */
export const POWERPOINT_SCRIPT = `on run argv
  set inPath to item 1 of argv
  set outPath to item 2 of argv
  set docName to item 3 of argv
  set wasRunning to application id "${POWERPOINT_ID}" is running
  tell application id "${POWERPOINT_ID}"
    open (POSIX file inPath)
    set thePres to presentation docName
    try
      save thePres in (POSIX file outPath) as save as PDF
    on error msg number n
      close thePres saving no
      if not wasRunning then quit
      error msg number n
    end try
    close thePres saving no
    if not wasRunning then quit
  end tell
  return "ok"
end run`;

export const powerpoint = {
  id: 'powerpoint',
  label: 'Microsoft PowerPoint',
  formats: ['pptx', 'ppt', 'ppsx', 'pps', 'potx'],
  async probe({ platform = process.platform, runImpl = run } = {}) {
    if (platform !== 'darwin') return { available: false, reason: 'PowerPoint is driven on a Mac only' };
    const path = await macAppPath(POWERPOINT_ID, runImpl);
    return path ? { available: true, where: path } : { available: false, reason: 'PowerPoint is not installed' };
  },
  async convert({ input, ext, runImpl = run, home = homedir() }) {
    const base = join(home, 'Library', 'Containers', POWERPOINT_ID, 'Data', 'tmp');
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(join(base, 'lpp-'));
    const name = `lpp-${randomBytes(6).toString('hex')}.${ext}`;
    const deck = join(dir, name);
    const pdf = join(dir, name.replace(/\.[a-z]+$/, '.pdf'));
    try {
      await copyFile(input, deck);
      try {
        await runImpl('osascript', ['-e', POWERPOINT_SCRIPT, deck, pdf, name]);
      } catch (err) {
        throw new Error(powerpointWords(err.message));
      }
      if (!(await exists(pdf))) throw new Error('PowerPoint said it exported the deck, and no PDF appeared — it may be password-protected or damaged');
      return await readFile(pdf);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
};

/** AppleScript's errors, in words an operator can act on. */
export function powerpointWords(message) {
  const m = String(message || '');
  if (/-1743|Not authori[sz]ed to send Apple events/i.test(m)) {
    return 'macOS has not let LivePremier Plus control PowerPoint — allow it in System Settings ▸ Privacy & Security ▸ Automation, then try again';
  }
  if (/-1712|timed out/i.test(m)) return 'PowerPoint did not answer in time — is a dialog open in it?';
  if (/did not finish in/.test(m)) return `${m} — is a dialog open in PowerPoint?`;
  return `PowerPoint could not export the deck: ${m.replace(/^.*execution error:\s*/s, '')}`;
}

/* ---------------------------------------------------------- LibreOffice */

/** Overrides discovery, as presentation-converter's `PRESENTATION_CONVERTER_SOFFICE` does. */
export const SOFFICE_ENV = 'LPP_SOFFICE';

export function sofficeCandidates(platform = process.platform) {
  if (platform === 'darwin') return ['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/opt/homebrew/bin/soffice', '/usr/local/bin/soffice'];
  if (platform === 'win32') return ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'];
  return ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/lib/libreoffice/program/soffice', '/snap/bin/libreoffice', '/opt/libreoffice/program/soffice'];
}

/** `soffice`: the override, else on PATH, else where installers put it. */
export async function findSoffice({ env = process.env, platform = process.platform } = {}) {
  if (env[SOFFICE_ENV]) return (await exists(env[SOFFICE_ENV], constants.X_OK)) ? env[SOFFICE_ENV] : null;
  const names = platform === 'win32' ? ['soffice.exe'] : ['soffice', 'libreoffice'];
  for (const dir of String(env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const n of names) if (await exists(join(dir, n), constants.X_OK)) return join(dir, n);
  }
  for (const p of sofficeCandidates(platform)) if (await exists(p, constants.X_OK)) return p;
  return null;
}

/** The arguments of one headless conversion, with a profile of its own — LibreOffice will not share one. */
export function sofficeArgs(profileDir, outDir, input) {
  return [
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    '--headless', '--norestore', '--invisible', '--nolockcheck', '--nodefault', '--nologo',
    '--convert-to', 'pdf', '--outdir', outDir, input
  ];
}

export const libreoffice = {
  id: 'libreoffice',
  label: 'LibreOffice',
  formats: ['pptx', 'ppt', 'ppsx', 'pps', 'potx', 'odp'],
  async probe({ env, platform } = {}) {
    const bin = await findSoffice({ env, platform });
    return bin ? { available: true, where: bin } : { available: false, reason: `LibreOffice is not installed (or set ${SOFFICE_ENV} to its soffice)` };
  },
  async convert({ input, ext, runImpl = run, env, platform }) {
    const bin = await findSoffice({ env, platform });
    if (!bin) throw new Error('LibreOffice is not installed');
    const dir = await mkdtemp(join(tmpdir(), 'lpp-soffice-'));
    const deck = join(dir, `deck.${ext}`);
    const out = join(dir, 'out');
    try {
      await mkdir(out, { recursive: true });
      await copyFile(input, deck);
      await runImpl(bin, sofficeArgs(join(dir, 'profile'), out, deck));
      const pdf = join(out, 'deck.pdf');
      if (!(await exists(pdf))) throw new Error('LibreOffice reported success and produced no PDF — the deck may be password-protected or damaged');
      return await readFile(pdf);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
};

/* ------------------------------------------------- which slides showed */

/**
 * The files of a zip, by name → bytes: the central directory, then each
 * entry stored or deflated. Enough for an Office package; no zip64.
 */
export function readZip(buf) {
  const out = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('a damaged zip');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out.set(name, () => (method === 0 ? raw : inflateRawSync(raw)));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

/**
 * A PowerPoint deck's slide numbers that will be pages in its PDF, in order:
 * every slide in the presentation's own list but the hidden ones
 * (`<p:sld show="0">`). PowerPoint leaves a hidden slide out of the PDF —
 * seen 2026-10-20: five slides with the third hidden came back as four
 * pages, the third being slide 4 — so page n is not slide n, and a still
 * named after the page would not be the slide the operator knows. Null when
 * it cannot be read (not OOXML, or damaged): pages are numbered as pages.
 */
export function visibleSlides(buf) {
  try {
    const zip = readZip(buf);
    const text = (name) => { const f = zip.get(name); return f ? f().toString('utf8') : null; };
    const pres = text('ppt/presentation.xml');
    const rels = text('ppt/_rels/presentation.xml.rels');
    if (!pres || !rels) return null;
    const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => [
      (/\bId="([^"]+)"/.exec(tag) || [])[1], (/\bTarget="([^"]+)"/.exec(tag) || [])[1]]));
    const list = (/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(pres) || [])[1] || '';
    const ids = [...list.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((m) => m[1]);
    const shown = [];
    ids.forEach((rid, i) => {
      const t = target.get(rid);
      const xml = t ? text(`ppt/${t.replace(/^\/?ppt\//, '').replace(/^\.\//, '')}`) : null;
      const head = xml ? (/<p:sld\b[^>]*>/.exec(xml) || [''])[0] : '';
      if (!/\bshow="(0|false)"/.test(head)) shown.push(i + 1);
    });
    return shown;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ choosing */

export const ENGINES = [powerpoint, libreoffice];

/** Every engine and whether it is here: `[{ id, label, formats, available, reason }]`. */
export async function probeAll(opts = {}, engines = ENGINES) {
  return Promise.all(engines.map(async (e) => ({ id: e.id, label: e.label, formats: e.formats, ...(await e.probe(opts)) })));
}

/** The engine for a file type: the asked-for one if it takes it and is here, else the first that does. */
export function pickEngine(probes, ext, wanted = null) {
  const ok = probes.filter((p) => p.available && p.formats.includes(ext));
  return ok.find((p) => p.id === wanted) || ok[0] || null;
}

/**
 * Why nothing can convert a type, in a sentence the panel shows as it is:
 * what would, and the way round it that always works.
 */
export function noEngineWords(probes, ext) {
  const kind = DECK_TYPES[ext];
  if (!kind) return `A .${ext} file is not a deck this can open — open a PDF, or a PowerPoint or OpenDocument deck.`;
  const could = probes.filter((p) => p.formats.includes(ext)).map((p) => `${p.label} (${p.reason || 'not here'})`);
  return `Nothing on the machine LivePremier Plus runs on can turn a ${kind} deck into a PDF: ${could.join('; ')}. Export a PDF from the presentation app and open that instead.`;
}

/**
 * Convert one deck file: `{ input, ext, engine? }`, the file already on
 * disk. Resolves `{ pdf: Buffer, engine }`. Queued behind any other.
 */
export async function convertDeck({ input, ext, engine = null, engines = ENGINES, probeOpts = {}, runImpl } = {}) {
  const probes = await probeAll(probeOpts, engines);
  const pick = pickEngine(probes, ext, engine);
  if (!pick) throw Object.assign(new Error(noEngineWords(probes, ext)), { status: 422 });
  const impl = engines.find((e) => e.id === pick.id);
  const pdf = await queue(() => impl.convert({ input, ext, ...(runImpl ? { runImpl } : {}), ...probeOpts }));
  const slides = ['pptx', 'ppsx', 'potx'].includes(ext) ? visibleSlides(await readFile(input).catch(() => null)) : null;
  return { pdf, engine: pick.id, label: pick.label, slides };
}
