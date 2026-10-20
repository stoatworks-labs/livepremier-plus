/*
 * Background Slicer — a deck turned into a PDF on the machine this app runs
 * on, so the page can draw its slides with pdf.js. Server only; nothing here
 * runs in the page, and importing it does nothing.
 *
 * A PDF needs none of this: the page opens one itself. A PowerPoint, Keynote
 * or OpenDocument deck has no renderer a browser can use, so the deck is
 * handed to an application that draws it as its author saw it, and the PDF
 * it exports comes back. Three engines, tried in this order:
 *
 *   1. **Microsoft PowerPoint** (macOS), driven over AppleScript — the
 *      reference renderer for a PowerPoint deck: its fonts, its effects, its
 *      layout. Proved on PowerPoint 16.112.3, macOS 26.4.1 (2026-10-20).
 *   2. **Keynote** (macOS), driven over AppleScript — the only renderer for a
 *      Keynote deck, and a PowerPoint deck's on a Mac with no PowerPoint
 *      (Keynote imports one; its fonts may be substituted). Proved on Keynote
 *      Creator Studio 15.3.1, macOS 26.4.1 (2026-10-20), cold and with a deck
 *      already open in it.
 *   3. **LibreOffice**, headless, anywhere it is installed — the engine for
 *      OpenDocument, and for a PowerPoint deck on a machine with neither
 *      (a Linux box, the Docker image if LibreOffice is added).
 *      The arguments are presentation-converter's (`engines/libreoffice.ts`),
 *      a private profile per run included. Not run here: LibreOffice is not
 *      installed on the machine this was written on.
 *
 * Keynote was left out at first, wrongly: on 2026-10-20 it answered -1700 /
 * -1728 to every question, and the cause turned out to be the script, not
 * Keynote (see Keynote's section below). presentation-converter
 * (`engines/keynote.ts`, main 6adce79) found that out the same day.
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
 *
 * Before that, writing into PowerPoint's container asks whether this app may
 * "access data from other apps" (TCC's App Data). Seen from an unsigned build
 * of the launcher (2026-10-20): App Data, Automation, then App Data again for
 * the read-back. Refused, the copy or the read fails with EPERM, which
 * `containerWords` puts into words; Full Disk Access covers it too (tccd
 * checks that first). Keynote has no container step, so no App Data
 * question: only Automation, once, for Keynote.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, copyFile, readFile, access, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, extname, delimiter, basename } from 'node:path';
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
  key: 'Keynote',
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
  async convert({ input, ext, runImpl = run, home = homedir(), copyImpl = copyFile, readImpl = readFile }) {
    const base = join(home, 'Library', 'Containers', POWERPOINT_ID, 'Data', 'tmp');
    let dir;
    try {
      await mkdir(base, { recursive: true });
      dir = await mkdtemp(join(base, 'lpp-'));
    } catch (err) {
      throw new Error(containerWords(err));
    }
    const name = `lpp-${randomBytes(6).toString('hex')}.${ext}`;
    const deck = join(dir, name);
    const pdf = join(dir, name.replace(/\.[a-z]+$/, '.pdf'));
    try {
      try {
        await copyImpl(input, deck);
      } catch (err) {
        throw new Error(containerWords(err));
      }
      try {
        await runImpl('osascript', ['-e', POWERPOINT_SCRIPT, deck, pdf, name]);
      } catch (err) {
        throw new Error(powerpointWords(err.message));
      }
      try {
        return await readImpl(pdf);
      } catch (err) {
        if (err.code === 'ENOENT') throw new Error('PowerPoint said it exported the deck, and no PDF appeared — it may be password-protected or damaged');
        throw new Error(containerWords(err));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
};

/** A refusal in PowerPoint's container, in words: macOS's App Data question, answered no. */
export function containerWords(err) {
  if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
    return 'macOS has not let LivePremier Plus use PowerPoint’s own folder, where the copy of the deck goes — it asks once whether LivePremier Plus may access data from other apps. Allow that (Full Disk Access for LivePremier Plus in System Settings ▸ Privacy & Security also does), then try again';
  }
  return `could not put the deck where PowerPoint opens it: ${err && err.message ? err.message : err}`;
}

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

/* ------------------------------------------------------------- Keynote */

/**
 * The Keynotes driven, by bundle id, the one to prefer first. Keynote
 * Creator Studio (`com.apple.Keynote`, 15.x) installs beside the iWork
 * Keynote (`com.apple.iWork.Keynote`, 14.x) rather than replacing it, and
 * with both installed the old one launches to a modal "Use the New Version
 * of Keynote" that answers nothing until someone clicks it. So the old one
 * is driven only where Creator Studio is not installed. Always by id: two
 * apps are called Keynote, and which one a name finds is Launch Services'
 * choice, not this file's.
 */
export const KEYNOTE_IDS = ['com.apple.Keynote', 'com.apple.iWork.Keynote'];

/** The Keynote to drive, `{ id, path, name }` — the first of `KEYNOTE_IDS` installed — found without talking to either. */
export async function findKeynote(runImpl = run) {
  for (const id of KEYNOTE_IDS) {
    const path = await macAppPath(id, runImpl);
    if (path) return { id, path, name: basename(path).replace(/\.app$/i, '') };
  }
  return null;
}

/*
 * Open the deck, note which slides are skipped, export the rest as pages,
 * close the deck unsaved only if this opened it, and quit Keynote only if
 * this started it and nothing else is open in it. Proved line by line on
 * Keynote Creator Studio 15.3.1: cold, and with another deck open in it.
 *
 *   - **The file references are made before the `tell`.** Made inside it,
 *     the sandboxed Keynote is handed a path it may not read: it says the
 *     file "can't be imported", `open` answers missing value, and the next
 *     line fails with -1700 — the failure that kept Keynote out at first.
 *     Made by the script, they carry the sandbox's permission with them, so
 *     the deck and its PDF sit in an ordinary temporary folder and Keynote
 *     needs no container copy (and macOS asks no App Data question).
 *   - **Documents are told apart by id.** Opening a `.key` that is already
 *     open hands back the open one, which is then left open.
 *   - **The first question has a minute.** A Keynote that does not answer it
 *     is sitting on a dialog, and every Apple event queues behind one; better
 *     to say so than wait ten minutes.
 *   - **Nothing is opened in a Keynote playing a slideshow.**
 *
 * Errors 1001 and 1002 are this script's own; `keynoteWords` reads them.
 */
export const keynoteScript = (id) => `on run argv
  set inFile to POSIX file (item 1 of argv)
  set outFile to POSIX file (item 2 of argv)
  set wasRunning to application id "${id}" is running
  try
    tell application id "${id}"
      with timeout of 60 seconds
        set openBefore to id of every document
      end timeout
    end tell
  on error msg number n
    my finish(wasRunning)
    error msg number n
  end try
  if wasRunning then
    set showing to false
    try
      tell application id "${id}" to set showing to playing
    end try
    if showing then error "Keynote is playing a slideshow" number 1001
  end if
  set d to missing value
  try
    tell application id "${id}"
      with timeout of 240 seconds
        set d to open inFile
      end timeout
    end tell
  on error msg number n
    my finish(wasRunning)
    error msg number n
  end try
  if d is missing value then
    my finish(wasRunning)
    error "Keynote could not open the deck" number 1002
  end if
  set mine to false
  try
    tell application id "${id}"
      with timeout of 300 seconds
        set mine to (id of d) is not in openBefore
        set sk to skipped of every slide of d
        export d to outFile as PDF with properties {export style:IndividualSlides, all stages:false, skipped slides:false, PDF image quality:Best}
      end timeout
    end tell
  on error msg number n
    my shut(d, mine)
    my finish(wasRunning)
    error msg number n
  end try
  my shut(d, mine)
  my finish(wasRunning)
  set shown to {}
  repeat with i from 1 to count of sk
    if item i of sk is false then set end of shown to i
  end repeat
  set AppleScript's text item delimiters to ","
  return shown as text
end run

on shut(d, mine)
  if mine then
    try
      tell application id "${id}"
        with timeout of 60 seconds
          close d saving no
        end timeout
      end tell
    end try
  end if
end shut

on finish(wasRunning)
  if wasRunning then return
  try
    tell application id "${id}"
      with timeout of 20 seconds
        if (count of documents) is 0 then quit
      end timeout
    end tell
  end try
end finish`;

/**
 * The names in a zip on disk, from its central directory alone (a deck can
 * be a gigabyte). Null when that cannot be read: not a zip, or zip64.
 */
export async function zipNames(path) {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const tail = Buffer.alloc(Math.min(size, 65557));
    await fh.read(tail, 0, tail.length, size - tail.length);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdStart = tail.readUInt32LE(eocd + 16);
    if (cdStart + cdSize > size) return null;
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdStart);
    const names = [];
    for (let p = 0, n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) return null;
      const nameLen = cd.readUInt16LE(p + 28);
      names.push(cd.toString('utf8', p + 46, p + 46 + nameLen));
      p += 46 + nameLen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
    }
    return names;
  } finally {
    await fh.close();
  }
}

/**
 * Why Keynote is not handed a file, or null. Each of these would put a
 * dialog up in Keynote — a password to type, "the file format is invalid" —
 * that stays on the operator's screen and holds every conversion after it.
 * A password-protected `.key` carries `.iwpv2` (seen 2026-10-20, Keynote
 * 15.3.1); a password-protected PowerPoint deck is not a zip at all.
 */
export async function keynoteRefusal(input, ext) {
  const fh = await open(input, 'r');
  const head = Buffer.alloc(4);
  try { await fh.read(head, 0, 4, 0); } finally { await fh.close(); }
  const zip = head.readUInt32LE(0) === 0x04034b50;
  if (ext === 'key') {
    if (!zip) return 'This .key is not a Keynote file that can be sent on — it may be damaged, or saved as a package (a folder). Save it as a single file in Keynote, or export a PDF, and open that.';
    if ((await zipNames(input) || []).some((n) => /^\.iwpv/.test(n))) {
      return 'This Keynote deck is password-protected, and Keynote would stop to ask for the password with nobody there. Remove the password in Keynote (or export a PDF) and open that.';
    }
  } else if (['pptx', 'ppsx', 'potx'].includes(ext) && !zip) {
    return 'This deck is password-protected or damaged, and Keynote would stop to ask about it with nobody there. Remove the password (or export a PDF) and open that.';
  }
  return null;
}

/** Keynote's errors and the script's own, in words an operator can act on. */
export function keynoteWords(message, app = { id: KEYNOTE_IDS[0], name: 'Keynote' }) {
  const m = String(message || '').replace(/^.*execution error:\s*/s, '').trim();
  const { name } = app;
  if (/-1743|Not authori[sz]ed to send Apple events/i.test(m)) {
    return `macOS has not let LivePremier Plus control ${name} — allow it in System Settings ▸ Privacy & Security ▸ Automation, then try again`;
  }
  if (/\(1001\)/.test(m)) return `${name} is playing a slideshow, and opening a deck in it could interrupt the show — try again when the show has stopped`;
  if (/\(1002\)/.test(m)) return `${name} could not open the deck — it may be damaged, or made by a newer Keynote. Export a PDF from Keynote and open that.`;
  const old = app.id === 'com.apple.iWork.Keynote' ? ' (Keynote 14 waits on “Use the New Version of Keynote” while a newer Keynote is installed.)' : '';
  if (/-1712|timed out/i.test(m)) return `${name} did not answer in time — is a dialog open in it?${old}`;
  if (/did not finish in/.test(m)) return `${m} — is a dialog open in ${name}?${old}`;
  if (/\((-609|-600)\)/.test(m)) return `${name} quit, or stopped answering, part-way through — try again`;
  return `${name} could not export the deck: ${m}`;
}

export const keynote = {
  id: 'keynote',
  label: 'Keynote',
  /* Keynote's own, and the PowerPoint types it imports (its Info.plist), never a macro-enabled one. */
  formats: ['key', 'pptx', 'ppt', 'ppsx', 'pps', 'potx'],
  async probe({ platform = process.platform, runImpl = run } = {}) {
    if (platform !== 'darwin') return { available: false, reason: 'Keynote is driven on a Mac only' };
    const app = await findKeynote(runImpl);
    return app ? { available: true, where: app.path, label: app.name } : { available: false, reason: 'Keynote is not installed' };
  },
  /* Resolves `{ pdf, slides }`: the slide number of each page, Keynote's own skipped slides left out. */
  async convert({ input, ext, runImpl = run }) {
    const refused = await keynoteRefusal(input, ext);
    if (refused) throw Object.assign(new Error(refused), { status: 422 });
    const app = await findKeynote(runImpl);
    if (!app) throw new Error('Keynote is not installed');
    const dir = await mkdtemp(join(tmpdir(), 'lpp-keynote-'));
    const pdf = join(dir, 'deck.pdf');
    try {
      let said;
      try {
        ({ stdout: said } = await runImpl('osascript', ['-e', keynoteScript(app.id), input, pdf]));
      } catch (err) {
        throw new Error(keynoteWords(err.message, app));
      }
      let bytes;
      try {
        bytes = await readFile(pdf);
      } catch {
        throw new Error(`${app.name} said it exported the deck, and no PDF appeared — it may be damaged`);
      }
      const slides = String(said || '').trim().split(',').filter(Boolean).map(Number);
      return { pdf: bytes, slides: slides.length && slides.every((n) => n > 0) ? slides : null };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
};

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

/* PowerPoint draws its own decks best; Keynote's import beats LibreOffice's on a Mac with no PowerPoint. */
export const ENGINES = [powerpoint, keynote, libreoffice];

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
  if (!kind) return `A .${ext} file is not a deck this can open — open a PDF, or a PowerPoint, Keynote or OpenDocument deck.`;
  const could = probes.filter((p) => p.formats.includes(ext)).map((p) => `${p.label} (${p.reason || 'not here'})`);
  return `Nothing on the machine LivePremier Plus runs on can turn a ${kind} deck into a PDF: ${could.join('; ')}. Export a PDF from the presentation app and open that instead.`;
}

/**
 * Convert one deck file: `{ input, ext, engine? }`, the file already on
 * disk. Resolves `{ pdf: Buffer, engine, label, slides }`. Queued behind
 * any other. `slides` is the slide number of each page: what the engine
 * says of its own PDF (Keynote reads its skipped slides), else what a
 * PowerPoint package says, else null.
 */
export async function convertDeck({ input, ext, engine = null, engines = ENGINES, probeOpts = {}, runImpl } = {}) {
  const probes = await probeAll(probeOpts, engines);
  const pick = pickEngine(probes, ext, engine);
  if (!pick) throw Object.assign(new Error(noEngineWords(probes, ext)), { status: 422 });
  const impl = engines.find((e) => e.id === pick.id);
  const out = await queue(() => impl.convert({ input, ext, ...(runImpl ? { runImpl } : {}), ...probeOpts }));
  const pdf = Buffer.isBuffer(out) ? out : out.pdf;
  const slides = (!Buffer.isBuffer(out) && out.slides)
    || (['pptx', 'ppsx', 'potx'].includes(ext) ? visibleSlides(await readFile(input).catch(() => null)) : null);
  return { pdf, engine: pick.id, label: pick.label, slides };
}
