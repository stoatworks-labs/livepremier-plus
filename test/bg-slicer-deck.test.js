/*
 * The Background Slicer's documents: the page arithmetic (`deck.js`), turning
 * a deck into a PDF on the server (`convert.js`, `server.js`), and the
 * vendored pdf.js those pages are drawn with.
 *
 * The plans and their writes are in `bg-slicer.test.js` (LivePremier) and
 * `bg-slicer-mng.test.js` (Midra 4K), beside the slicer's own. Nothing here
 * starts PowerPoint, Keynote or LibreOffice: the engines run against a
 * stand-in `run` that writes the PDF the real one would. The real ones were
 * run by hand (docs/BACKGROUNDS.md, "Documents").
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import {
  documentKind, refusedWhy, DECK_EXTENSIONS, DOC_ACCEPT, pagePixels, pageDpi, fitInto, placedFit, parsePages, formatPages,
  pageLabel, pageStem, pageNumber, setsForPages, placementUnits
} from '../plugins/bg-slicer/deck.js';
import {
  DECK_TYPES, powerpoint, libreoffice, pickEngine, noEngineWords, sofficeArgs, findSoffice, powerpointWords,
  convertDeck, queue, POWERPOINT_SCRIPT, visibleSlides, readZip, containerWords,
  keynote, keynoteScript, keynoteWords, keynoteRefusal, findKeynote, zipNames, KEYNOTE_IDS, ENGINES
} from '../plugins/bg-slicer/convert.js';
import { zipStore } from '../src/core/zip.js';
import { deflateRawSync } from 'node:zlib';
import activateServer from '../plugins/bg-slicer/server.js';
import { HttpError } from '../server/plugin-host.js';

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------- deck.js */

test('what opens: a PDF in the page, a PowerPoint, Keynote or OpenDocument deck through the server; a macro deck says why not', () => {
  assert.equal(documentKind({ name: 'Talk.PDF' }), 'pdf');
  assert.equal(documentKind({ name: 'scan', type: 'application/pdf' }), 'pdf');
  for (const ext of ['pptx', 'ppt', 'ppsx', 'pps', 'potx', 'key', 'odp']) assert.equal(documentKind({ name: `d.${ext}` }), 'deck', ext);
  assert.equal(refusedWhy({ name: 'd.key' }), null);
  assert.equal(documentKind({ name: 'd.pptm' }), 'refused');
  assert.match(refusedWhy({ name: 'd.pptm' }), /macro/);
  assert.equal(documentKind({ name: 'photo.png' }), null);
  assert.deepEqual([...DECK_EXTENSIONS].sort(), Object.keys(DECK_TYPES).sort(), 'the page offers exactly what the server converts');
  assert.match(DOC_ACCEPT, /\.pdf,.*\.pptx,.*\.key/);
});

test('a page is 96 pixels to the inch when nothing says otherwise: a widescreen slide is 1280 × 720; a Keynote deck’s 72', () => {
  assert.deepEqual(pagePixels({ width: 960, height: 540 }), { width: 1280, height: 720 });
  assert.deepEqual(pagePixels({ width: 612, height: 792 }), { width: 816, height: 1056 }, 'US Letter');
  assert.equal(pageDpi('Show.KEY'), 72, 'Keynote’s pixel is a point');
  assert.deepEqual(pagePixels({ width: 1920, height: 1080 }, pageDpi('Show.key')), { width: 1920, height: 1080 }, 'a 1920 × 1080 Keynote slide is 1920 × 1080');
  assert.equal(pageDpi('Show.pptx'), 96);
  assert.equal(pageDpi('Show.pdf'), 96);
});

test('fit, fill and stretch a page into a box', () => {
  const page = { width: 960, height: 540 };
  assert.deepEqual(fitInto('stretch', page, { width: 1000, height: 1000 }), { x: 0, y: 0, w: 1000, h: 1000 });
  assert.deepEqual(fitInto('fit', page, { width: 1920, height: 1920 }), { x: 0, y: 420, w: 1920, h: 1080 });
  assert.deepEqual(fitInto('fill', page, { width: 1080, height: 1080 }), { x: -420, y: 0, w: 1920, h: 1080 });
  assert.equal(placedFit(page, { width: 1919, height: 1080 }), 'stretch', 'a pixel of rounding is the same shape');
  assert.equal(placedFit({ width: 540, height: 960 }, { width: 1920, height: 1080 }), 'fit', 'a portrait page is fitted, not squashed');
});

test('pages as typed: ranges, open ends, all, and the way back', () => {
  assert.deepEqual(parsePages('', 5).pages, [0, 1, 2, 3, 4]);
  assert.deepEqual(parsePages('all', 3).pages, [0, 1, 2]);
  assert.deepEqual(parsePages('1-3, 5', 8).pages, [0, 1, 2, 4]);
  assert.deepEqual(parsePages('6-', 8).pages, [5, 6, 7]);
  assert.deepEqual(parsePages('4–2 3', 8).pages, [1, 2, 3], 'a backwards range, an en dash, a repeat');
  assert.match(parsePages('9', 8).error, /has pages 1 to 8/);
  assert.match(parsePages('two', 8).error, /not a page or a range/);
  assert.equal(formatPages([0, 1, 2, 4, 6, 7]), '1–3, 5, 7–8');
});

test('a deck with a hidden slide: its pages go by slide number, typed and shown', () => {
  const numbers = [1, 2, 4, 5];
  assert.deepEqual(parsePages('4-5', 4, numbers).pages, [2, 3], 'slides 4 and 5 are the third and fourth pages');
  assert.deepEqual(parsePages('2-4', 4, numbers).pages, [1, 2], 'a range steps over the hidden slide');
  assert.match(parsePages('3', 4, numbers).error, /slide 3 is hidden/);
  assert.match(parsePages('6', 4, numbers).error, /slides 1 to 5/);
  assert.equal(formatPages([0, 1, 2, 3], numbers), '1–2, 4–5');
  assert.equal(pageNumber({ numbers }, 2), 4);
  assert.equal(pageNumber({ numbers: null }, 2), 3);
});

test('names: the page number after the name, inside the switcher’s 16 characters; files say the page', () => {
  assert.equal(pageLabel('Keynote', 3), 'Keynote 3');
  assert.equal(pageLabel('A very long show name', 12), 'A very long s 12');
  assert.equal(pageLabel('A very long show name', 12).length, 16);
  assert.equal(pageLabel('', 4), 'Page 4');
  assert.equal(pageStem('Show deck v2.pptx', 3), 'Show_deck_v2_p03');
  assert.equal(pageStem('Show deck v2.pptx', 4, true), 'Show_deck_v2_s04', 'a deck’s slide 4');
});

test('sets for pages: the first run of free ones, or from the set chosen', () => {
  const sets = [1, 2, 3, 4, 5, 6, 7, 8].map((index) => ({ index, empty: ![1, 3].includes(index), onProgram: false, onPreview: index === 5 }));
  assert.deepEqual(setsForPages(sets, 2), [6, 7], 'sets 1 and 3 hold something and 5 is on preview');
  assert.deepEqual(setsForPages(sets, 1), [2]);
  assert.deepEqual(setsForPages(sets, 4), [2, 3, 4, 5], 'no run of four free: from the first free set');
  assert.deepEqual(setsForPages(sets, 3, 7), [7, 8], 'from set 7 only two are left');
});

test('placement units: one per screen, or one for spanned screens, each drawn at its placement in whole pixels', () => {
  const screens = [{ id: 'S1', canvas: { width: 1920, height: 1080 } }, { id: 'S2', canvas: { width: 3840, height: 1080 } }];
  const each = placementUnits({ screens: ['S1', 'S2'], mode: 'each', place: { S1: { x: 0, y: 0, w: 1920, h: 1080 } }, image: { width: 1280, height: 720 } }, screens);
  assert.deepEqual(each.map((u) => [u.key, u.image]), [['S1', { width: 1920, height: 1080 }], ['S2', { width: 1920, height: 1080 }]]);
  assert.deepEqual(each[1].rect, { x: 960, y: 0, w: 1920, h: 1080 }, 'S2 not placed yet: fitted');
  const span = placementUnits({ screens: ['S1', 'S2'], mode: 'span', span: { offsets: {}, rect: null }, image: { width: 1280, height: 240 } }, screens);
  assert.deepEqual(span.map((u) => [u.key, u.screens, u.image]), [['S1+S2', ['S1', 'S2'], { width: 5760, height: 1080 }]]);
});

/* ----------------------------------------------------------- convert.js */

test('engines: PowerPoint first for a PowerPoint deck, then Keynote, then LibreOffice; Keynote for Keynote; a sentence when there is none', () => {
  assert.deepEqual(ENGINES.map((e) => e.id), ['powerpoint', 'keynote', 'libreoffice']);
  const probes = [
    { id: 'powerpoint', label: 'Microsoft PowerPoint', formats: powerpoint.formats, available: true },
    { id: 'keynote', label: 'Keynote Creator Studio', formats: keynote.formats, available: true },
    { id: 'libreoffice', label: 'LibreOffice', formats: libreoffice.formats, available: true }
  ];
  assert.equal(pickEngine(probes, 'pptx').id, 'powerpoint');
  assert.equal(pickEngine(probes, 'pptx', 'libreoffice').id, 'libreoffice');
  assert.equal(pickEngine(probes, 'odp').id, 'libreoffice');
  assert.equal(pickEngine(probes, 'key').id, 'keynote');
  const noPowerPoint = probes.map((p) => (p.id === 'powerpoint' ? { ...p, available: false } : p));
  assert.equal(pickEngine(noPowerPoint, 'pptx').id, 'keynote', 'Keynote imports a PowerPoint deck on a Mac without PowerPoint');
  assert.equal(pickEngine(noPowerPoint, 'odp').id, 'libreoffice', 'Keynote does not take OpenDocument');
  const none = probes.map((p) => ({ ...p, available: false, reason: `${p.label} is not installed` }));
  assert.equal(pickEngine(none, 'pptx'), null);
  assert.match(noEngineWords(none, 'pptx'), /Nothing on the machine .* PowerPoint deck .* Microsoft PowerPoint \(Microsoft PowerPoint is not installed\); Keynote .*; LibreOffice .* Export a PDF/);
  assert.match(noEngineWords(none, 'key'), /a Keynote deck into a PDF: Keynote Creator Studio \(.*\)\. Export a PDF/);
  for (const e of [powerpoint, keynote]) assert.equal(e.formats.includes('pptm'), false, `${e.id}: never a macro-enabled deck`);
});

test('PowerPoint: the deck is copied into its sandbox under a name of its own, found by that name, and only it is closed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'lpp-home-'));
  const src = join(home, 'in.pptx');
  await writeFile(src, 'deck');
  const calls = [];
  const runImpl = async (cmd, args) => {
    calls.push([cmd, args]);
    const [, , deck, pdf, name] = args;
    assert.equal(await readFile(deck, 'utf8'), 'deck', 'the copy is the deck');
    assert.ok(deck.startsWith(join(home, 'Library', 'Containers', 'com.microsoft.Powerpoint', 'Data', 'tmp')), deck);
    assert.match(name, /^lpp-[0-9a-f]{12}\.pptx$/);
    assert.equal(deck.endsWith(name), true);
    await writeFile(pdf, '%PDF-1.7');
    return { stdout: 'ok', stderr: '' };
  };
  const pdf = await powerpoint.convert({ input: src, ext: 'pptx', runImpl, home });
  assert.equal(pdf.toString(), '%PDF-1.7');
  assert.equal(calls[0][0], 'osascript');
  assert.equal(calls[0][1][1], POWERPOINT_SCRIPT);
  assert.match(POWERPOINT_SCRIPT, /set thePres to presentation docName/);
  assert.doesNotMatch(POWERPOINT_SCRIPT, /active presentation/, 'never whatever the operator last clicked');
  assert.match(POWERPOINT_SCRIPT, /if not wasRunning then quit/);
  const left = await readdir(join(home, 'Library', 'Containers', 'com.microsoft.Powerpoint', 'Data', 'tmp'));
  assert.deepEqual(left, [], 'the copy and the PDF are cleaned up');
  await rm(home, { recursive: true, force: true });
});

test('PowerPoint’s refusals in words: Automation not allowed, a dialog in the way', async () => {
  assert.match(powerpointWords('execution error: Not authorized to send Apple events to Microsoft PowerPoint. (-1743)'), /Privacy & Security ▸ Automation/);
  assert.match(powerpointWords('osascript did not finish in 600 s'), /is a dialog open in PowerPoint/);
  const home = await mkdtemp(join(tmpdir(), 'lpp-home-'));
  const src = join(home, 'in.pptx');
  await writeFile(src, 'deck');
  await assert.rejects(powerpoint.convert({ input: src, ext: 'pptx', home, runImpl: async () => ({ stdout: 'ok' }) }), /no PDF appeared/);
  await rm(home, { recursive: true, force: true });
});

test('PowerPoint’s container refused (macOS App Data said no): the copy or the read-back says so, and nothing is left', async () => {
  const eperm = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  assert.match(containerWords(eperm()), /access data from other apps/);
  assert.match(containerWords(Object.assign(new Error('disk full'), { code: 'ENOSPC' })), /could not put the deck .*disk full/);
  const home = await mkdtemp(join(tmpdir(), 'lpp-home-'));
  const src = join(home, 'in.pptx');
  await writeFile(src, 'deck');
  let ran = false;
  await assert.rejects(powerpoint.convert({
    input: src, ext: 'pptx', home, copyImpl: async () => { throw eperm(); }, runImpl: async () => { ran = true; return { stdout: 'ok' }; }
  }), /access data from other apps/);
  assert.equal(ran, false, 'PowerPoint is not asked to open a copy that is not there');
  await assert.rejects(powerpoint.convert({
    input: src, ext: 'pptx', home, readImpl: async () => { throw eperm(); }, runImpl: async () => ({ stdout: 'ok' })
  }), /access data from other apps/);
  const left = await readdir(join(home, 'Library', 'Containers', 'com.microsoft.Powerpoint', 'Data', 'tmp'));
  assert.deepEqual(left, [], 'cleaned up either way');
  await rm(home, { recursive: true, force: true });
});

/**
 * A stand-in `run` for a Mac with the given Keynotes installed: it answers
 * the bundle-id lookups (`osascript -l JavaScript …`) from `installed`, and
 * for the conversion writes the PDF where the script was told to and says
 * the slide numbers, as the real script does.
 */
function keynoteMac(installed, { said = '1,2,4,5', calls = [] } = {}) {
  return async (cmd, args) => {
    calls.push([cmd, args]);
    if (args[0] === '-l') return { stdout: `${installed[args[args.length - 1]] || ''}\n`, stderr: '' };
    await writeFile(args[3], '%PDF-1.7 keynote');
    return { stdout: `${said}\n`, stderr: '' };
  };
}
const BOTH_KEYNOTES = { 'com.apple.Keynote': '/Applications/Keynote Creator Studio.app', 'com.apple.iWork.Keynote': '/Applications/Keynote.app' };
/** A single-file Keynote deck's outline: a zip with an Index. */
const keyFile = (extra = []) => Buffer.from(zipStore([{ name: 'Index/Document.iwa', data: new Uint8Array([1, 2, 3]) }, ...extra]));

test('Keynote: Creator Studio by bundle id when it is installed, the iWork Keynote only when it is alone, found without an Apple event', async () => {
  assert.deepEqual(KEYNOTE_IDS, ['com.apple.Keynote', 'com.apple.iWork.Keynote']);
  const calls = [];
  assert.deepEqual(await findKeynote(keynoteMac(BOTH_KEYNOTES, { calls })), { id: 'com.apple.Keynote', path: '/Applications/Keynote Creator Studio.app', name: 'Keynote Creator Studio' });
  assert.ok(calls.length && calls.every(([cmd, args]) => cmd === 'osascript' && args[0] === '-l' && /URLForApplicationWithBundleIdentifier/.test(args[3])), 'a Launch Services lookup, nothing sent to Keynote');
  assert.equal((await findKeynote(keynoteMac({ 'com.apple.iWork.Keynote': '/Applications/Keynote.app' }))).id, 'com.apple.iWork.Keynote');
  assert.equal(await findKeynote(keynoteMac({})), null);
  assert.deepEqual(await keynote.probe({ platform: 'darwin', runImpl: keynoteMac(BOTH_KEYNOTES) }), { available: true, where: '/Applications/Keynote Creator Studio.app', label: 'Keynote Creator Studio' });
  assert.match((await keynote.probe({ platform: 'darwin', runImpl: keynoteMac({}) })).reason, /not installed/);
  assert.match((await keynote.probe({ platform: 'linux' })).reason, /Mac only/);
});

test('Keynote: the deck goes to Creator Studio, never the 14.x beside it, and comes back as a PDF and the slides its pages are', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lpp-kn-'));
  const src = join(dir, 'deck.key');
  await writeFile(src, keyFile());
  const calls = [];
  const out = await keynote.convert({ input: src, ext: 'key', runImpl: keynoteMac(BOTH_KEYNOTES, { calls }) });
  assert.equal(out.pdf.toString(), '%PDF-1.7 keynote');
  assert.deepEqual(out.slides, [1, 2, 4, 5], 'slide 3 skipped');
  const sent = calls.filter(([, args]) => args[0] === '-e');
  assert.equal(sent.length, 1);
  const [, script, input, pdf] = sent[0][1];
  assert.equal(script, keynoteScript('com.apple.Keynote'));
  assert.doesNotMatch(script, /iWork/, 'the old Keynote is never addressed');
  assert.equal(input, src, 'the deck where it arrived: no container copy, so no App Data question');
  await assert.rejects(readFile(pdf), /ENOENT/, 'the PDF is cleaned up');
  const silent = await keynote.convert({ input: src, ext: 'key', runImpl: keynoteMac(BOTH_KEYNOTES, { said: '' }) });
  assert.equal(silent.slides, null, 'nothing said: pages go by place');
  await rm(dir, { recursive: true, force: true });
});

test('Keynote’s script: file references before the tell, documents told apart by id, a minute for the first answer, quit only what it started', () => {
  const s = keynoteScript('com.apple.Keynote');
  const tell = s.indexOf('tell application id "com.apple.Keynote"');
  assert.ok(s.indexOf('set inFile to POSIX file') < tell && s.indexOf('set outFile to POSIX file') < tell, 'made by the script, so the sandboxed app may read and write them');
  assert.doesNotMatch(s, /open \(POSIX file/);
  assert.doesNotMatch(s, /front document|document 1\b/, 'never whatever the operator last clicked');
  assert.match(s, /with timeout of 60 seconds\s+set openBefore to id of every document/, 'a Keynote on a dialog is said, not waited on');
  assert.match(s, /set mine to \(id of d\) is not in openBefore/);
  assert.match(s, /if mine then\s+try\s+tell application id "com\.apple\.Keynote"\s+with timeout of 60 seconds\s+close d saving no/, 'only a deck this opened is closed');
  assert.match(s, /if wasRunning then return/);
  assert.match(s, /if \(count of documents\) is 0 then quit/, 'and Keynote quit only if nothing else is open in it');
  assert.match(s, /set showing to playing/);
  assert.match(s, /set sk to skipped of every slide of d/);
  assert.match(s, /skipped slides:false/);
});

test('Keynote is not handed a deck that would put a dialog up: a password, a package, a damaged file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lpp-kn-'));
  const put = async (name, data) => { const p = join(dir, name); await writeFile(p, data); return p; };
  const plain = await put('a.key', keyFile());
  const locked = await put('b.key', keyFile([{ name: '.iwpv2', data: new Uint8Array([0]) }]));
  const junk = await put('c.key', Buffer.from('not a zip, nor a Keynote deck'));
  const ole = await put('d.pptx', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  assert.deepEqual(await zipNames(locked), ['Index/Document.iwa', '.iwpv2']);
  assert.equal(await zipNames(junk), null);
  assert.equal(await keynoteRefusal(plain, 'key'), null);
  assert.match(await keynoteRefusal(locked, 'key'), /password-protected/);
  assert.match(await keynoteRefusal(junk, 'key'), /package/);
  assert.match(await keynoteRefusal(ole, 'pptx'), /password-protected/, 'an encrypted .pptx is not a zip');
  assert.equal(await keynoteRefusal(ole, 'ppt'), null, 'a 97–2003 deck never is');
  let ran = false;
  await assert.rejects(keynote.convert({ input: locked, ext: 'key', runImpl: async () => { ran = true; return { stdout: '' }; } }),
    (err) => err.status === 422 && /password-protected/.test(err.message), 'the file is the trouble, not the machine: a 422');
  assert.equal(ran, false, 'Keynote is not even looked for');
  await rm(dir, { recursive: true, force: true });
});

test('Keynote’s refusals in words: Automation, a dialog (the old Keynote’s modal named), a slideshow playing, a deck it could not open', async () => {
  const cs = { id: 'com.apple.Keynote', name: 'Keynote Creator Studio' };
  const old = { id: 'com.apple.iWork.Keynote', name: 'Keynote' };
  assert.match(keynoteWords('execution error: Not authorized to send Apple events to Keynote Creator Studio. (-1743)', cs), /control Keynote Creator Studio .*Automation/);
  assert.match(keynoteWords('execution error: Keynote got an error: AppleEvent timed out. (-1712)', cs), /did not answer in time — is a dialog open in it\?$/);
  assert.match(keynoteWords('execution error: Keynote got an error: AppleEvent timed out. (-1712)', old), /Use the New Version of Keynote/);
  assert.match(keynoteWords('x: execution error: Keynote is playing a slideshow (1001)', cs), /playing a slideshow.*when the show has stopped/);
  assert.match(keynoteWords('x: execution error: Keynote could not open the deck (1002)', cs), /could not open the deck .*Export a PDF/);
  assert.match(keynoteWords('execution error: Connection is invalid. (-609)', cs), /quit, or stopped answering/);
  assert.match(keynoteWords('osascript did not finish in 600 s', cs), /is a dialog open in Keynote Creator Studio\?/);
  const dir = await mkdtemp(join(tmpdir(), 'lpp-kn-'));
  const src = join(dir, 'deck.key');
  await writeFile(src, keyFile());
  const lookup = (args) => ({ stdout: BOTH_KEYNOTES[args[args.length - 1]] || '' });
  await assert.rejects(keynote.convert({ input: src, ext: 'key', runImpl: async (c, a) => { if (a[0] === '-l') return lookup(a); throw new Error('x: execution error: Keynote is playing a slideshow (1001)'); } }),
    /Keynote Creator Studio is playing a slideshow/);
  await assert.rejects(keynote.convert({ input: src, ext: 'key', runImpl: async (c, a) => (a[0] === '-l' ? lookup(a) : { stdout: '1' }) }), /no PDF appeared/);
  await rm(dir, { recursive: true, force: true });
});

test('convertDeck: the slides an engine reports of its own PDF are the ones sent', async () => {
  const kn = { id: 'kn', label: 'kn', formats: ['key'], probe: async () => ({ available: true }), convert: async () => ({ pdf: Buffer.from('%PDF'), slides: [1, 3] }) };
  const out = await convertDeck({ input: '/nowhere.key', ext: 'key', engines: [kn] });
  assert.deepEqual([out.pdf.toString(), out.slides, out.engine], ['%PDF', [1, 3], 'kn']);
  const bare = { ...kn, convert: async () => Buffer.from('%PDF') };
  assert.equal((await convertDeck({ input: '/nowhere.key', ext: 'key', engines: [bare] })).slides, null);
});

test('LibreOffice: found by the override, then PATH; headless with a profile of its own', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lpp-so-'));
  const bin = join(dir, 'soffice');
  await writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(await findSoffice({ env: { LPP_SOFFICE: bin }, platform: 'linux' }), bin);
  assert.equal(await findSoffice({ env: { LPP_SOFFICE: join(dir, 'nope') }, platform: 'linux' }), null);
  assert.equal(await findSoffice({ env: { PATH: dir }, platform: 'linux' }), bin);
  const args = sofficeArgs('/tmp/p', '/tmp/o', '/tmp/d.pptx');
  assert.equal(args[0], '-env:UserInstallation=file:///tmp/p');
  assert.deepEqual(args.slice(-5), ['--convert-to', 'pdf', '--outdir', '/tmp/o', '/tmp/d.pptx']);
  assert.ok(args.includes('--headless'));
  const runImpl = async (cmd, a) => { await writeFile(join(a[a.length - 2], 'deck.pdf'), '%PDF'); return { stdout: '' }; };
  const src = join(dir, 'x.odp');
  await writeFile(src, 'odp');
  const pdf = await libreoffice.convert({ input: src, ext: 'odp', runImpl, env: { LPP_SOFFICE: bin }, platform: 'linux' });
  assert.equal(pdf.toString(), '%PDF');
  await rm(dir, { recursive: true, force: true });
});

test('one conversion at a time, whatever the engine', async () => {
  const order = [];
  const slow = (id, ms) => queue(async () => { order.push(`${id}+`); await new Promise((r) => setTimeout(r, ms)); order.push(`${id}-`); });
  await Promise.all([slow('a', 30), slow('b', 1), queue(async () => { throw new Error('c fails'); }).catch(() => order.push('c!')), slow('d', 1)]);
  assert.deepEqual(order, ['a+', 'a-', 'b+', 'b-', 'c!', 'd+', 'd-']);
});

test('convertDeck: picks the engine, or refuses with the sentence and a 422', async () => {
  const fake = (id, formats, available = true) => ({
    id, label: id, formats,
    probe: async () => (available ? { available: true } : { available: false, reason: `${id} is not here` }),
    convert: async ({ ext }) => Buffer.from(`${id}:${ext}`)
  });
  const out = await convertDeck({ input: '/x', ext: 'pptx', engines: [fake('pp', ['pptx']), fake('lo', ['pptx', 'odp'])] });
  assert.deepEqual([out.engine, out.pdf.toString()], ['pp', 'pp:pptx']);
  await assert.rejects(convertDeck({ input: '/x', ext: 'pptx', engines: [fake('pp', ['pptx'], false)] }), (err) => err.status === 422 && /pp is not here/.test(err.message));
});

/**
 * A PowerPoint package's skeleton: the presentation's slide list, its
 * relationships, and each slide's root element — the three things
 * `visibleSlides` reads. In the order PowerPoint writes them: the list's
 * order is the deck's, not the file names'.
 */
function pptx(slides) {
  const enc = (t) => new TextEncoder().encode(t);
  const files = [
    { name: 'ppt/presentation.xml', data: enc(`<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 7}"/>`).join('')}</p:sldIdLst></p:presentation>`) },
    { name: 'ppt/_rels/presentation.xml.rels', data: enc(`<Relationships>${slides.map((s, i) => `<Relationship Id="rId${i + 7}" Type="slide" Target="slides/${s.file}"/>`).join('')}</Relationships>`) },
    ...slides.map((s) => ({ name: `ppt/slides/${s.file}`, data: enc(`<?xml version="1.0"?><p:sld xmlns:p="p"${s.hidden ? ' show="0"' : ''}><p:cSld/></p:sld>`) }))
  ];
  return Buffer.from(zipStore(files));
}

test('which slides are pages: the deck’s own order, hidden ones left out — as PowerPoint’s PDF leaves them out', () => {
  const deck = pptx([{ file: 'slide1.xml' }, { file: 'slide2.xml' }, { file: 'slide3.xml', hidden: true }, { file: 'slide5.xml' }, { file: 'slide4.xml' }]);
  assert.deepEqual(visibleSlides(deck), [1, 2, 4, 5], 'numbered by place in the deck, not by file name');
  assert.deepEqual(visibleSlides(pptx([{ file: 'a.xml' }])), [1]);
  assert.equal(visibleSlides(Buffer.from('not a zip at all')), null);
  /* Deflated entries, as Office writes them. */
  const raw = Buffer.from('<p:sld show="0"/>');
  const z = readZip(Buffer.from(zipStore([{ name: 'x', data: new Uint8Array(raw) }])));
  assert.equal(z.get('x')().toString(), '<p:sld show="0"/>');
  assert.equal(deflateRawSync(raw).length > 0, true);
});

/* ------------------------------------------------------------ server.js */

/** The plugin's routes on a real socket, as the host would mount them. */
async function serve(fakes) {
  const routes = new Map();
  const ctx = { HttpError, log: () => {}, route: (m, p, fn) => routes.set(`${m} ${p}`, fn) };
  activateServer(ctx, fakes);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const fn = routes.get(`${req.method} ${url.pathname}`);
    if (!fn) { res.writeHead(routes.has(`GET ${url.pathname}`) || routes.has(`POST ${url.pathname}`) ? 405 : 404); res.end(); return; }
    const h = { url, json: (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
    try { await fn(req, res, h); } catch (err) { res.writeHead(err.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('the convert route: a deck in, a PDF out, the engine named; the deck on disk only while it converts', async () => {
  let seen = null;
  const s = await serve({
    probe: async () => [{ id: 'powerpoint', label: 'Microsoft PowerPoint', formats: ['pptx'], available: true }],
    convert: async ({ input, ext }) => { seen = { input, ext, body: await readFile(input, 'utf8') }; return { pdf: Buffer.from('%PDF-x'), engine: 'powerpoint', label: 'Microsoft PowerPoint', slides: [1, 2, 4] }; }
  });
  try {
    const res = await fetch(`${s.base}/convert?name=${encodeURIComponent('My deck.pptx')}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'the deck' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(res.headers.get('x-lpp-engine'), 'powerpoint');
    assert.equal(res.headers.get('x-lpp-slides'), '1,2,4', 'the slide each page is');
    assert.equal(await res.text(), '%PDF-x');
    assert.deepEqual([seen.ext, seen.body], ['pptx', 'the deck']);
    const key = await fetch(`${s.base}/convert?name=${encodeURIComponent('Show.key')}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'a keynote' });
    assert.equal(key.status, 200, 'a Keynote deck is taken now');
    assert.equal(seen.ext, 'key');
    await assert.rejects(readFile(seen.input), /ENOENT/, 'the temporary copy is gone');
    const engines = await (await fetch(`${s.base}/engines`)).json();
    assert.equal(engines.engines[0].id, 'powerpoint');
    assert.equal(engines.types.odp, 'OpenDocument presentation');
  } finally { await s.close(); }
});

test('the convert route refuses: a simple (cross-site) content type, a type it does not take, nothing at all, an engine’s failure in its words', async () => {
  const s = await serve({
    probe: async () => [],
    convert: async () => { throw Object.assign(new Error('Nothing on the machine can turn it into a PDF. Export a PDF.'), { status: 422 }); }
  });
  try {
    const post = (name, body, type = 'application/octet-stream') => fetch(`${s.base}/convert?name=${name}`, { method: 'POST', headers: { 'content-type': type }, body });
    assert.equal((await post('d.pptx', 'x', 'text/plain')).status, 415, 'text/plain is what a page on another site may send without asking');
    const docx = await post('d.docx', 'x');
    assert.equal(docx.status, 415);
    assert.match((await docx.json()).error, /not a deck this can convert — open a PDF, or a PowerPoint, Keynote or OpenDocument deck/);
    assert.equal((await post('d.pptm', 'x')).status, 415, 'no macro-enabled decks');
    assert.equal((await post('d.pptx', '')).status, 400);
    const failed = await post('d.pptx', 'x');
    assert.equal(failed.status, 422);
    assert.match((await failed.json()).error, /Export a PDF/);
  } finally { await s.close(); }
});

/* ------------------------------------------------------------- pdf.js */

test('the vendored pdf.js is the version and the files its manifest says, and nothing that runs a PDF’s scripts', async () => {
  const dir = join(here, '..', 'src', 'vendor', 'pdfjs');
  const manifest = JSON.parse(await readFile(join(dir, 'MANIFEST.json'), 'utf8'));
  assert.equal(manifest.upstream, 'pdfjs-dist (Mozilla pdf.js)');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  for (const [file, sum] of Object.entries(manifest.files)) {
    const got = createHash('sha256').update(await readFile(join(dir, file))).digest('hex');
    assert.equal(got, sum, `${file} has been edited in place — run: npm run sync:pdfjs -- <pdfjs-dist>`);
  }
  for (const needed of ['pdf.min.mjs', 'pdf.worker.min.mjs', 'wasm/openjpeg.wasm', 'wasm/jbig2.wasm', 'wasm/qcms_bg.wasm', 'LICENSE']) {
    assert.ok(manifest.files[needed], `${needed} is vendored`);
  }
  assert.ok(!Object.keys(manifest.files).some((f) => /quickjs|sandbox/.test(f)), 'no scripting engine');
  assert.ok(Object.keys(manifest.files).some((f) => f.startsWith('standard_fonts/')));
  const head = (await readFile(join(dir, 'pdf.min.mjs'), 'utf8')).slice(0, 4000);
  assert.ok(head.includes(manifest.version), 'the build says its own version');
});
