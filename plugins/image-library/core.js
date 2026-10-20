/*
 * Image Library tools — what a delete takes and keeps, what a zip holds and
 * where each picture goes, and what the capacity dropdown offers.
 *
 * No DOM and no I/O: the store mirror in, plans and sentences out. `run.js`
 * carries a plan out against the switcher, `decorate.js` puts the controls in
 * the vendor's own Image Library and Images pages, `client.js` joins them.
 *
 * Three facts decide the shape of it, all seen on the LivePremier Simulator
 * 6.2.73 (Aquilon Cmax) on 2026-10-20:
 *
 * - **Deleting a library image empties every still showing it**, at once:
 *   the still keeps `mode` IMAGE and its `source`, and its picture goes
 *   (`isValid` false, 0 × 0). A still on program or preview is a picture on a
 *   bus, so a bulk delete never takes an image one of those is showing; the
 *   rest go, and the confirmation names the stills that will go empty.
 * - **A capacity is asked for by format.** Preconfig ▸ Images has no
 *   capacity control, only an "expected image resolution" per still that the
 *   switcher turns into one. `CAPACITY_FORMAT` (core/stills.js) holds a
 *   format per capacity that the switcher's own check agreed with.
 * - **A capacity change can take neighbours out of service**: 4K at Image 1
 *   took Image 2, 5K took 2, 3 and 4. Lowering one below what its picture
 *   needs leaves the still `outOfCapability`. Both are said before applying.
 */

import { ROOT } from '../../src/core/paths.js';
import {
  BG, readLibrary, readStills, readSets, libraryUsers, capacityChoices, CAPACITY_FORMAT, CAPACITY_UNITS
} from '../../src/core/stills.js';

const pp = (node) => (node && typeof node === 'object' && node.pp) || {};

/** Names and paths sort the way a person numbers files: `slide 2` before `slide 10`. */
export const naturalCompare = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

/** How the vendor's Images page names a still: `Image 3`, and its label when it has one. */
export function stillName(still) {
  const label = String((still && still.label) || '').trim();
  return label ? `Image ${still.key} “${label}”` : `Image ${still.key}`;
}

/** A list of things in a sentence: `a`, `a and b`, `a, b and c`. */
export function listed(items) {
  const xs = items.map(String);
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Bytes as the vendor's size counter writes them. */
export function sizeText(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

/* ------------------------------------------------------------- on a bus */

/**
 * The stills on a bus: `Map(key → 'program' | 'preview')`. The still's own
 * tally first, and then any still a background set on program or preview
 * names — the set is what puts it there, whatever the still's tally says.
 */
export function stillsOnBus(store, stills = readStills(store)) {
  const out = new Map();
  for (const s of stills) {
    if (s.onProgram) out.set(s.key, 'program');
    else if (s.onPreview) out.set(s.key, 'preview');
  }
  const screens = store.get([...BG, 'screenList', 'items']) || {};
  for (const sid of Object.keys(screens)) {
    for (const set of readSets(store, sid)) {
      if (!set.onProgram && !set.onPreview) continue;
      for (const c of Object.values(set.contents)) {
        const m = /^STILL_(\d+)$/.exec(c);
        if (!m) continue;
        if (set.onProgram) out.set(m[1], 'program');
        else if (!out.has(m[1])) out.set(m[1], 'preview');
      }
    }
  }
  return out;
}

/* --------------------------------------------------------------- delete */

/**
 * What deleting `slots` would do: `{ remove, kept, emptied, missing }`.
 *
 * - `remove`: the slots that hold a picture and go, in slot order;
 * - `kept`: `[{ slot, fileName, why }]`, a picture a still on a bus shows;
 * - `emptied`: `[{ still, name, slot }]`, the stills that go empty with them;
 * - `missing`: slots asked for that hold nothing (already empty).
 */
export function planDelete(store, slots) {
  const lib = readLibrary(store);
  const bySlot = new Map(lib.slots.map((s) => [s.slot, s]));
  const stills = readStills(store);
  const users = libraryUsers(store);
  const bus = stillsOnBus(store, stills);
  const out = { remove: [], kept: [], emptied: [], missing: [] };
  const wanted = [...new Set(slots.map(Number))].filter(Number.isInteger).sort((a, b) => a - b);
  for (const n of wanted) {
    const slot = bySlot.get(n);
    if (!slot || slot.free) { out.missing.push(n); continue; }
    const showing = users.get(n) || [];
    const onBus = showing.filter((s) => bus.has(s.key));
    if (onBus.length) {
      const where = onBus.some((s) => bus.get(s.key) === 'program') ? 'program' : 'preview';
      out.kept.push({ slot: n, fileName: slot.fileName, why: `${listed(onBus.map(stillName))} ${onBus.length === 1 ? 'shows' : 'show'} it on ${where}` });
      continue;
    }
    out.remove.push(n);
    for (const s of showing) out.emptied.push({ still: s.key, name: stillName(s), slot: n });
  }
  return out;
}

/** Every slot that holds a picture. */
export function filledSlots(store) {
  return readLibrary(store).slots.filter((s) => !s.free).map((s) => s.slot);
}

/**
 * The question asked before a delete, or null when there is nothing to
 * delete — with `why` saying so. `all` words it as the whole library.
 */
export function deleteQuestion(plan, { all = false } = {}) {
  if (!plan.remove.length) {
    const why = plan.kept.length
      ? `Nothing deleted: ${plural(plan.kept.length, 'picture')} ${plan.kept.length === 1 ? 'is' : 'are'} on a bus — ${plan.kept.map((k) => `slot ${k.slot} (${k.why})`).join('; ')}.`
      : 'Nothing to delete: the library is empty.';
    return { text: null, why };
  }
  const n = plan.remove.length;
  const lines = [all
    ? `Delete ${n === 1 ? 'the only image' : `all ${n} images`} in the switcher’s image library?`
    : `Delete ${plural(n, 'image')} from the switcher’s image library (${slotList(plan.remove)})?`];
  if (plan.emptied.length) {
    const names = [...new Set(plan.emptied.map((e) => e.name))];
    lines.push(`${listed(names)} ${names.length === 1 ? 'shows' : 'show'} ${n === 1 ? 'it' : 'some of them'} and will go empty.`);
  }
  if (plan.kept.length) {
    lines.push(`Kept, because a still on a bus shows ${plan.kept.length === 1 ? 'it' : 'them'}: ${plan.kept.map((k) => `slot ${k.slot} (${k.why})`).join('; ')}.`);
  }
  lines.push('There is no undo: the files are gone from the switcher.');
  return { text: lines.join('\n\n'), why: null };
}

/** `1–4, 7, 9–10`: slots as ranges. */
export function slotList(slots) {
  const xs = [...slots].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < xs.length; i++) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    parts.push(j > i ? `${xs[i]}–${xs[j]}` : String(xs[i]));
    i = j;
  }
  return parts.join(', ');
}

/** The slots from `a` to `b` that hold a picture — a shift-click's range. */
export function rangeOf(store, a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return filledSlots(store).filter((s) => s >= lo && s <= hi);
}

/* --------------------------------------------------------------- upload */

const extOf = (name) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name));
  return m ? m[1].toLowerCase() : '';
};
const baseOf = (name) => String(name).split('/').pop();

/**
 * Of a zip's entries (`core/zip.js` `listZip`), the pictures the switcher
 * takes, in natural order of their path, and the rest with a reason:
 * `{ take: [{ entry, name, path, size }], skipped: [{ name, why }] }`.
 *
 * Folders, and what macOS and Windows leave in a zip that nobody put there
 * (`__MACOSX/`, `._` forks, `.DS_Store`, `Thumbs.db`), are passed over
 * without a word; anything else that is not taken says why.
 */
export function zipPictures(entries, { types, maxBytes }) {
  const accepted = new Set((types || []).map((t) => String(t).toLowerCase()));
  const take = [];
  const skipped = [];
  for (const e of entries) {
    if (e.dir) continue;
    const base = baseOf(e.name);
    if (!base || /(^|\/)__MACOSX\//.test(e.name) || base.startsWith('.') || /^thumbs\.db$/i.test(base) || /^desktop\.ini$/i.test(base)) continue;
    const ext = extOf(base);
    if (!accepted.has(ext)) { skipped.push({ name: e.name, why: ext ? `the switcher does not take .${ext} files` : 'not a picture file' }); continue; }
    if (e.encrypted) { skipped.push({ name: e.name, why: 'it is encrypted' }); continue; }
    if (e.method !== 0 && e.method !== 8) { skipped.push({ name: e.name, why: `it is compressed a way this cannot undo (method ${e.method})` }); continue; }
    if (!e.size) { skipped.push({ name: e.name, why: 'it is empty' }); continue; }
    if (maxBytes && e.size > maxBytes) { skipped.push({ name: e.name, why: `it is ${sizeText(e.size)}, over the switcher’s ${sizeText(maxBytes)} a file` }); continue; }
    take.push({ entry: e, name: base, path: e.name, size: e.size });
  }
  take.sort((a, b) => naturalCompare(a.path, b.path));
  return { take, skipped };
}

/** Loose files dropped beside a zip: the pictures the switcher takes, the rest with a reason. */
export function loosePictures(files, { types, maxBytes }) {
  const accepted = new Set((types || []).map((t) => String(t).toLowerCase()));
  const take = [];
  const skipped = [];
  for (const f of files) {
    const ext = extOf(f.name);
    if (!accepted.has(ext)) { skipped.push({ name: f.name, why: ext ? `the switcher does not take .${ext} files` : 'not a picture file' }); continue; }
    if (maxBytes && f.size > maxBytes) { skipped.push({ name: f.name, why: `it is ${sizeText(f.size)}, over the switcher’s ${sizeText(maxBytes)} a file` }); continue; }
    take.push(f);
  }
  return { take, skipped };
}

/**
 * The empty slots an upload may use, in the order to use them:
 * `[{ slot, stills }]`, `stills` naming any still that points at it.
 *
 * ⚠️ **An empty slot is not always unclaimed.** A still keeps pointing at a
 * slot after its picture is deleted, and a picture uploaded into that slot
 * shows on the still at once — seen on the 6.2.73 simulator, 2026-10-20,
 * when a zip refilled slot 3 and Image 1, emptied by the delete before, took
 * the new picture up. So a slot a still on program or preview points at is
 * never used (that would be a new picture on a bus), and one another still
 * points at is used only after every clean slot, and said in the question.
 */
export function uploadSlots(store) {
  const users = libraryUsers(store);
  const bus = stillsOnBus(store);
  const clean = [];
  const claimed = [];
  for (const s of readLibrary(store).slots) {
    if (!s.free) continue;
    const showing = users.get(s.slot) || [];
    if (showing.some((x) => bus.has(x.key))) continue;
    (showing.length ? claimed : clean).push({ slot: s.slot, stills: showing.map(stillName) });
  }
  const bySlot = (a, b) => a.slot - b.slot;
  return [...clean.sort(bySlot), ...claimed.sort(bySlot)];
}

/**
 * Where each picture goes: the slots `uploadSlots` offers, in its order,
 * while there is a slot and the library has room. `files` is
 * `[{ name, size }]` in the order wanted; the answer
 * `{ placed: [{ file, slot, stills }], noRoom: [{ name, why }] }`.
 */
export function placeUploads(store, files) {
  const lib = readLibrary(store);
  const free = uploadSlots(store);
  /* `size` and `maxSize` are kilobytes (`readLibrary`); no budget read is no limit. */
  let room = lib.maxKB ? Math.max(0, (lib.maxKB - lib.sizeKB) * 1024) : Infinity;
  const placed = [];
  const noRoom = [];
  for (const file of files) {
    if (!free.length) { noRoom.push({ name: file.name, why: 'no free slot left' }); continue; }
    if (file.size > room) { noRoom.push({ name: file.name, why: `the library has ${sizeText(room)} left` }); continue; }
    const { slot, stills } = free.shift();
    placed.push({ file, slot, stills });
    room -= file.size;
  }
  return { placed, noRoom };
}

/**
 * The question asked before an upload, or null when everything fits and
 * nothing was passed over — an upload into empty slots takes nothing away,
 * and the vendor's own upload does not ask either.
 */
export function uploadQuestion({ placed, noRoom, skipped }) {
  const pointed = placed.filter((p) => p.stills && p.stills.length);
  if (!noRoom.length && !skipped.length && !pointed.length) return null;
  const lines = [placed.length
    ? `Upload ${plural(placed.length, 'picture')} into slots ${slotList(placed.map((p) => p.slot))}?`
    : 'Nothing can be uploaded.'];
  if (pointed.length) {
    lines.push(`Every other free slot is used first, but ${pointed.map((p) => `${listed(p.stills)} ${p.stills.length === 1 ? 'points' : 'point'} at empty slot ${p.slot}`).join('; ')}: ${pointed.length === 1 ? 'that still shows the picture' : 'those stills show the pictures'} put there.`);
  }
  if (noRoom.length) lines.push(`No room for ${plural(noRoom.length, 'more')}: ${listed(noRoom.slice(0, 5).map((x) => x.name))}${noRoom.length > 5 ? ' …' : ''} (${noRoom[0].why}).`);
  if (skipped.length) lines.push(`Passed over: ${skipped.slice(0, 8).map((x) => `${x.name} — ${x.why}`).join('; ')}${skipped.length > 8 ? ` … and ${skipped.length - 8} more` : ''}.`);
  return lines.join('\n\n');
}

/* ------------------------------------------------------------- capacity */

/** What the switcher calls each capacity, for the dropdown and the question. */
export const CAPACITY_NAMES = { OFF: 'Off', DUAL: 'Dual', '4K': '4K', '5K': '5K', '8K': '8K' };
export const capacityName = (c) => CAPACITY_NAMES[c] || String(c || '—');
/** An option's text: the vendor's badge number, then the name — `2 · 4K`. */
export const capacityLabel = (c) => (CAPACITY_UNITS[c] != null ? `${CAPACITY_UNITS[c]} · ${capacityName(c)}` : capacityName(c));

/** Whether Preconfig ▸ Images has a change staged — somebody is half way through editing it. */
export const stillsStaged = (store) => pp(store.get([ROOT, 'preconfig', 'stills', 'new', 'status'])).hasChanged === true;

/**
 * The capacity dropdown for one still: `{ key, current, choices, disabled }`
 * with `disabled` a sentence, or null when it can be changed. Null for a
 * still this frame does not have.
 */
export function capacityView(store, key, { stills = readStills(store), bus = stillsOnBus(store, stills) } = {}) {
  const still = stills.find((s) => s.key === String(key));
  if (!still || !still.fitted) return null;
  if (still.outOfService) {
    return { key: still.key, current: 'OFF', choices: [], disabled: 'Out of service: a larger capacity beside it is using its memory. Lower that one to bring this back.' };
  }
  const choices = capacityChoices(still.formats);
  const current = still.capability || null;
  let disabled = null;
  if (!choices.length) disabled = 'The switcher offers no format this can ask for a capacity with.';
  else if (bus.get(still.key) === 'program') disabled = 'On program. Take it off program to change its capacity.';
  else if (stillsStaged(store)) disabled = 'Preconfig ▸ Images has changes waiting. Apply or reset them there first.';
  return { key: still.key, current, choices, disabled };
}

/**
 * One still's capacity change, ready for `stageCapacities`, and what it does
 * to the picture in it: `{ change, still, warnings }`, or `{ error }`.
 */
export function planCapacity(store, key, to) {
  const stills = readStills(store);
  const bus = stillsOnBus(store, stills);
  const view = capacityView(store, key, { stills, bus });
  if (!view) return { error: `Image ${key} is not fitted in this frame.` };
  if (view.disabled) return { error: view.disabled };
  const still = stills.find((s) => s.key === String(key));
  if (to === view.current) return { error: null, change: null, still, warnings: [] };
  const format = CAPACITY_FORMAT[to];
  if (!format || !view.choices.some((c) => c.capability === to)) return { error: `${capacityName(to)} is not a capacity this still can be asked for.` };
  const warnings = [];
  if (bus.get(still.key) === 'preview') warnings.push(`${stillName(still)} is on preview.`);
  /* The picture in it, and the capacity the switcher says it needs. */
  if (still.mode === 'IMAGE' && Number.isInteger(still.source)) {
    const pic = readLibrary(store).slots.find((s) => s.slot === still.source && !s.free);
    if (pic && pic.capability && (CAPACITY_UNITS[pic.capability] || 0) > (CAPACITY_UNITS[to] || 0)) {
      warnings.push(`Its picture (${pic.fileName}, ${pic.width} × ${pic.height}) needs ${capacityName(pic.capability)}: at ${capacityName(to)} the switcher will mark it out of capacity.`);
    }
  }
  return {
    error: null,
    still,
    warnings,
    change: { still: still.key, format, to, from: view.current, before: still.format }
  };
}

/** The question asked before applying, once the switcher's check has answered. */
export function capacityQuestion(plan, staged) {
  const { still, change } = plan;
  const lines = [`${stillName(still)}: ${capacityName(change.from)} → ${capacityName(change.to)}?`];
  if (staged.lost.length) {
    lines.push(`The switcher takes ${listed(staged.lost.map((k) => `Image ${k}`))} out of service for it (${staged.lost.length === 1 ? 'it is' : 'they are'} empty).`);
  }
  if (staged.regained.length) {
    lines.push(`${listed(staged.regained.map((k) => `Image ${k}`))} ${staged.regained.length === 1 ? 'comes' : 'come'} back into service.`);
  }
  lines.push(...plan.warnings);
  lines.push('This applies Preconfig ▸ Images now.');
  return lines.join('\n\n');
}
