/*
 * Plug names — each input plug's EDID under the input's own label.
 *
 * A computer names a display from its EDID: the Display Product Name
 * descriptor (tag 0xFC) in the base block. Every stock LivePremier plug says
 * the same thing — maker ANW, product 8002, serial 0, "AQL_HDMI" — so a
 * laptop on In3 and In4 sees two identical displays and the operator guesses
 * which is which. This puts the input's label in the name ("PPT MAIN") and
 * the input's number in the serial, and changes nothing else: the EDID the
 * plug already serves, whatever loaded it (a default, a bank slot, a
 * template), keeps every mode, block and byte but those.
 *
 * ## What an EDID can say
 *
 * The name is at most 13 characters of plain ASCII, and that is the field
 * macOS, Windows and Linux all read (Linux: `drm_edid_get_monitor_name`, the
 * first 0xFC only). A longer label is cut, which is why a short name can be
 * typed per plug. It replaces the EDID's own 0xFC descriptor or, with none,
 * a dummy (0x10); a further 0xFC becomes a dummy so no stale half-name is
 * left behind. An EDID whose four descriptors are all in use has no room and
 * is refused — a timing is never dropped to make some. The serial is the
 * 32-bit ID Serial Number at bytes 12–15, which with the maker and product
 * is how an operating system tells two displays apart and remembers each
 * one's arrangement; an existing 0xFF serial string is left as it is.
 *
 * ## What is left alone
 *
 * A plug in a mosaic group, leader or member, or serving a DisplayID tile:
 * its EDID has to match its partners', and a Mac shows the group as one
 * display anyway. A plug the switcher reports busy or invalid. An input with
 * no label and no short name — nothing to call it.
 *
 * ## Undo
 *
 * The switcher keeps no previous EDID, so the bytes a plug served before its
 * first rename are kept (`original`) beside the bytes written (`written`),
 * recorded before the write goes out. Undo is offered only while the plug
 * still serves `written`: an EDID loaded since on the vendor's page is the
 * operator's newer choice, and putting an older one back over it would undo
 * that instead. Renaming a renamed plug again keeps the first `original`.
 *
 * Pure apart from the session it is handed: no DOM, so it tests under node.
 */

import { ROOT } from '../../src/core/paths.js';
import { plugEdidStatus, servedEdid, readTile, sameBytes, writePlugEdid } from '../../src/core/plug-edid.js';

export const NAME_MAX = 13;

const HEADER = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
const DESCRIPTORS = [54, 72, 90, 108];
const NAME_TAG = 0xfc;
const DUMMY_TAG = 0x10;

const pp = (node) => (node && node.pp) || {};

// ------------------------------------------------------------------ the name

/**
 * A label as the name descriptor can carry it: accents folded off, curly
 * quotes and dashes made plain, anything else outside printable ASCII
 * dropped, runs of space closed up. `clipped` says it was cut to fit.
 */
export function nameFor(label) {
  const plain = String(label ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, '-')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return { text: plain.slice(0, NAME_MAX).trimEnd(), clipped: plain.length > NAME_MAX };
}

const isDisplayDescriptor = (b, o) => b[o] === 0 && b[o + 1] === 0 && b[o + 2] === 0;

/** The EDID's Display Product Name, or '' with none. */
export function readName(bytes) {
  if (!bytes || bytes.length < 128) return '';
  for (const o of DESCRIPTORS) {
    if (!isDisplayDescriptor(bytes, o) || bytes[o + 3] !== NAME_TAG) continue;
    let text = '';
    for (let i = o + 5; i < o + 18 && bytes[i] !== 0x0a; i++) text += String.fromCharCode(bytes[i]);
    return text.trimEnd();
  }
  return '';
}

/** The 32-bit ID Serial Number, bytes 12–15, little-endian. */
export function readSerial(bytes) {
  if (!bytes || bytes.length < 16) return 0;
  return (bytes[12] | (bytes[13] << 8) | (bytes[14] << 16) | (bytes[15] << 24)) >>> 0;
}

/** A name descriptor as EDID Editor writes one: 0x0A after the text only when there is room. */
function nameDescriptor(text) {
  const out = [0, 0, 0, NAME_TAG, 0];
  for (const ch of text.slice(0, NAME_MAX)) out.push(ch.charCodeAt(0));
  if (out.length < 18) out.push(0x0a);
  while (out.length < 18) out.push(0x20);
  return out;
}

/**
 * The same EDID with this name and serial: `{ bytes }`, or `{ error }` saying
 * why it cannot carry them. Only the base block changes, and its checksum.
 */
export function renameEdid(bytes, { name, serial = null }) {
  if (!bytes || bytes.length < 128 || bytes.length % 128) return { error: 'it is not a whole EDID' };
  const b = Array.from(bytes);
  if (HEADER.some((x, i) => b[i] !== x)) return { error: 'it has no EDID header' };
  const text = nameFor(name).text;
  if (!text) return { error: 'there is no name to give it' };

  const names = DESCRIPTORS.filter((o) => isDisplayDescriptor(b, o) && b[o + 3] === NAME_TAG);
  const slot = names.length ? names[0] : DESCRIPTORS.find((o) => isDisplayDescriptor(b, o) && b[o + 3] === DUMMY_TAG);
  if (slot === undefined) return { error: 'its four descriptors are all in use, so there is no room for a name' };
  b.splice(slot, 18, ...nameDescriptor(text));
  for (const o of names.slice(1)) b.splice(o, 18, 0, 0, 0, DUMMY_TAG, ...new Array(14).fill(0));

  if (serial !== null) {
    const n = serial >>> 0;
    b[12] = n & 0xff; b[13] = (n >>> 8) & 0xff; b[14] = (n >>> 16) & 0xff; b[15] = (n >>> 24) & 0xff;
  }
  let sum = 0;
  for (let i = 0; i < 127; i++) sum += b[i];
  b[127] = (256 - (sum % 256)) % 256;
  return { bytes: Uint8Array.from(b) };
}

// ------------------------------------------------------------------ the plugs

/** The plugs' own document, as kept per switcher: `{ plugs: { IN_n: {...} } }`. */
export const emptyDocument = () => ({ plugs: {} });
const entryOf = (doc, id) => (doc && doc.plugs && doc.plugs[id]) || {};

/** The input number a serial is made from: 5 for IN_5. */
export const inputNumber = (id) => { const m = /^IN_(\d+)$/.exec(id); return m ? Number(m[1]) : null; };

/**
 * Every fitted input whose plug has an EDID, in input order, with what it
 * serves, what it should be called, the bytes that would do it (`bytes`,
 * null when `why` says it cannot) and whether that is already so (`done`).
 * `undo` is the EDID to put back, while the plug still serves what was written.
 */
export function plugRows(store, doc) {
  const items = store.get([ROOT, 'inputList', 'items']) || {};
  const ids = Object.keys(items).filter((k) => inputNumber(k) !== null).sort((a, b) => inputNumber(a) - inputNumber(b));
  const rows = [];
  for (const id of ids) {
    const node = items[id] || {};
    if (pp(node.mapping).isValid !== true) continue;
    const st = plugEdidStatus(store, id);
    if (st.isAvailable !== true) continue;

    const number = inputNumber(id);
    const label = String(pp(node.control).label || '');
    const own = entryOf(doc, id);
    /* A short name is for the label it was typed against; rename the input
       and the new label's own name takes over again. */
    const short = own.short && own.forLabel === label ? own.short : '';
    const auto = nameFor(label);
    const name = short ? nameFor(short).text : auto.text;
    const served = servedEdid(store, id);
    const pre = pp(store.get([ROOT, 'preconfig', 'inputs', 'current', 'inputList', 'items', id, 'status']));
    const grouped = (pre.group && pre.group !== '1X1') || pre.global === 'GROUPED' || !!readTile(served.bytes);

    let why = null;
    let bytes = null;
    if (grouped) why = 'in a mosaic group — its tile EDID is left alone';
    else if (st.isBusy) why = 'the switcher reports the plug busy';
    else if (served.isValid !== true || !served.bytes.length) why = 'the plug’s EDID is not valid';
    else if (!name) why = 'no label — give the input one, or type a name';
    else {
      const r = renameEdid(served.bytes, { name, serial: number });
      if (r.error) why = r.error;
      else bytes = r.bytes;
    }
    const ours = !!own.written && sameBytes(own.written, served.bytes);
    const status = pp(node.status);
    rows.push({
      id,
      number,
      title: `In${number}`,
      label,
      name,
      auto: auto.text,
      clipped: !short && auto.clipped,
      short,
      served: served.bytes,
      current: { name: readName(served.bytes) || served.name, serial: readSerial(served.bytes) },
      bytes,
      done: !!bytes && sameBytes(bytes, served.bytes),
      why,
      undo: ours && Array.isArray(own.original) ? Uint8Array.from(own.original) : null,
      /* Written here once, but the plug serves something else now. */
      replaced: !!own.written && !ours,
      /* A write blanks the source for a moment, on screen if it is on air. */
      onAir: status.isOnProgram ? 'program' : status.isOnPreview ? 'preview' : null
    });
  }
  return rows;
}

// ------------------------------------------------------------- the document

/** The document with this plug's short name set, or cleared with ''. */
export function withShortName(doc, id, label, short) {
  const plugs = { ...((doc && doc.plugs) || {}) };
  const entry = { ...(plugs[id] || {}) };
  const text = nameFor(short).text;
  if (text) { entry.short = text; entry.forLabel = label; } else { delete entry.short; delete entry.forLabel; }
  if (Object.keys(entry).length) plugs[id] = entry; else delete plugs[id];
  return { ...doc, plugs };
}

/**
 * The document with a write recorded, before it goes out: `written` becomes
 * the new bytes, and `original` the bytes served before — unless the plug is
 * serving what was written here last, when the first `original` stands.
 */
export function withWrite(doc, id, before, after) {
  const plugs = { ...((doc && doc.plugs) || {}) };
  const entry = { ...(plugs[id] || {}) };
  const ours = !!entry.written && sameBytes(entry.written, before) && Array.isArray(entry.original);
  if (!ours) entry.original = Array.from(before);
  entry.written = Array.from(after);
  plugs[id] = entry;
  return { ...doc, plugs };
}

/** The document with a plug's write forgotten — after an undo has landed. */
export function withoutWrite(doc, id) {
  const plugs = { ...((doc && doc.plugs) || {}) };
  const entry = { ...(plugs[id] || {}) };
  delete entry.original;
  delete entry.written;
  if (Object.keys(entry).length) plugs[id] = entry; else delete plugs[id];
  return { ...doc, plugs };
}

// ------------------------------------------------------------------ writing

/**
 * Name the plugs, one at a time: record each write in the document (`save`
 * resolves once it is kept), write it, and wait for the plug to serve it.
 * Each write is a hot-plug for whatever is connected, so nothing is retried.
 * Resolves `{ ok, doc, steps, problems }`.
 */
export async function namePlugs(session, rows, { doc, save, timeout } = {}) {
  let current = doc || emptyDocument();
  const steps = [];
  const problems = [];
  for (const row of rows) {
    if (!row.bytes || row.done) continue;
    current = withWrite(current, row.id, row.served, row.bytes);
    await save(current);
    const ok = await writePlugEdid(session, row.id, row.bytes, { timeout });
    if (ok) steps.push(`${row.title} → ${row.name}`);
    else problems.push(`${row.title} did not take the new EDID — the switcher has not reported it`);
  }
  return { ok: problems.length === 0, doc: current, steps, problems };
}

/** Put back what the plugs served before they were named. Resolves `{ ok, doc, steps, problems }`. */
export async function undoPlugs(session, rows, { doc, save, timeout } = {}) {
  let current = doc || emptyDocument();
  const steps = [];
  const problems = [];
  for (const row of rows) {
    if (!row.undo) continue;
    const ok = await writePlugEdid(session, row.id, row.undo, { timeout });
    if (ok) {
      current = withoutWrite(current, row.id);
      await save(current);
      steps.push(`${row.title} back to ${readName(row.undo) || 'its EDID'}`);
    } else {
      problems.push(`${row.title} did not take its old EDID back — the switcher has not reported it`);
    }
  }
  return { ok: problems.length === 0, doc: current, steps, problems };
}
