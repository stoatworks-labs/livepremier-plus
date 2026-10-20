/*
 * A picture made in the page, put on a destination's layer through a still —
 * and taken off again. Shared by the UMD Generator (an aux's top layer) and
 * Test Card (a screen's or an aux's top layer); moved here from
 * `plugins/umd/` so the two cannot drift apart.
 *
 * It is three things, each the way the Web RCS itself does it
 * (`core/stills.js` has the evidence):
 *
 *   1. **the picture into a library slot** — the vendor's own upload route;
 *   2. **a still showing that slot** — `mode` IMAGE, `source` = the slot,
 *      `rescale` NO_RESCALE, since the picture is made at the size it is shown;
 *   3. **a layer showing the still**, at a rectangle of the canvas, uncropped
 *      and opaque, in the buffer the operator chose.
 *
 * **Updating is only step 1.** Uploading into a slot that holds a file
 * replaces it, and a still showing that slot follows by itself: on the
 * LivePremier Simulator 6.2.73 (2026-10-16) a 1280×720 PNG sent to slot 200
 * over a 1920×1080 one changed the slot's `hashName` and still 48's
 * `imageWidth` within three seconds, with nothing written to the still; and
 * again on 2026-10-20 a still's `newSnaphot` stepped on as its slot was
 * replaced. So a picture already in place is refreshed by uploading again —
 * and if its layer is on program the new one is on air at once.
 *
 * Every write waits for the switcher's own echo (`core/wire.js`): the page
 * mirror takes this page's writes as state, so only an inbound frame proves a
 * write landed. Everything is journalled before it is sent, and
 * `revertStillLayer` takes back exactly what the journal holds.
 */

import { dialectFor } from './dialect.js';
import { topLeftToAnchor } from './screens.js';
import {
  CAPACITY_UNITS, likelyCapability, orderSlots, readLibrary, readStills, stillWrites, stillRestoreWrites,
  libraryDeleteWrites, uploadImage, emptySlots, pointedText
} from './stills.js';
import { same, sendAndEcho, send, until, ECHO_MS, IMPORT_MS } from './wire.js';

const HEARD = { inbound: true };

/* ================================================================ writes */

/**
 * The store path of one layer property, by its catalogue id (`position.posH`).
 * Null when this platform's layers have no such property — a Midra layer has
 * no anchor — and a caller writes nothing there.
 */
export function layerPath(store, id, letter, key, paramId) {
  const dialect = dialectFor(store);
  const spec = dialect && dialect.catalogue.layer.find((p) => p.id === paramId);
  return spec ? dialect.layerParamPath(id, letter, key, spec.path) : null;
}

/**
 * The writes that put one layer of one buffer at a rectangle, through its
 * own anchor — a `BOTTOM_RIGHT` layer sized by its width alone moves its
 * left edge, so position and size are written together.
 */
export function placeWrites(store, id, letter, key, rect) {
  const dialect = dialectFor(store);
  if (!dialect) return [];
  const p = (name) => layerPath(store, id, letter, key, dialect.layerParams[name]);
  const at = p('anchor');
  const anchor = (at && store.get(at)) || 'MIDDLE_CENTER';
  const { posH, posV } = topLeftToAnchor(anchor, rect.left, rect.top, rect.width, rect.height);
  return [
    { path: p('posH'), value: posH },
    { path: p('posV'), value: posV },
    { path: p('sizeH'), value: rect.width },
    { path: p('sizeV'), value: rect.height }
  ].filter((w) => w.path);
}

/**
 * Leave a layer showing its source as it is: no crop, no mask, no effect,
 * fully opaque. Only the properties this layer has — an aux's layers have
 * no border or keyer, a screen's do — so nothing is written to a path the
 * switcher would refuse, and only those not already so.
 */
export const CLEAN = [
  ['opacity.opacity', 256],
  ['cropping.classic.top', 0], ['cropping.classic.bottom', 0], ['cropping.classic.left', 0], ['cropping.classic.right', 0],
  ['cropping.mask.top', 0], ['cropping.mask.bottom', 0], ['cropping.mask.left', 0], ['cropping.mask.right', 0],
  ['effects.flags', []],
  ['border.edge.style', []], ['border.shadow.style', []],
  ['keying.enable', false]
];

export function cleanWrites(store, id, letter, key) {
  return CLEAN
    .map(([param, value]) => ({ path: layerPath(store, id, letter, key, param), value }))
    .filter((w) => w.path && store.get(w.path) !== undefined && !same(store.get(w.path), w.value));
}

/** A layer showing a still at a rectangle of the canvas, clean. */
export function stillLayerWrites(store, id, letter, key, still, rect) {
  const dialect = dialectFor(store);
  const source = dialect && layerPath(store, id, letter, key, dialect.sourceParam);
  if (!source) return [];
  return [
    { path: source, value: `STILL_${still}` },
    ...placeWrites(store, id, letter, key, rect),
    ...cleanWrites(store, id, letter, key)
  ];
}

/** What each path in `writes` holds now — the journal of a write, taken before it. */
export function before(store, writes) {
  const seen = new Map();
  for (const w of writes) {
    const k = w.path.join('/');
    if (!seen.has(k)) seen.set(k, { path: w.path, value: store.get(w.path) });
  }
  return [...seen.values()].filter((w) => w.value !== undefined);
}

/* ============================================================ the library */

/**
 * A still that can hold the picture: free, and with the capacity for its
 * size — a still's capacity is how large a picture it holds, DUAL up to
 * 1920 × 1200. Ours first, if it is still showing our slot; else the
 * highest-numbered free one, out of the way of the operator's own, who
 * fill from the top of the list. `skip` are stills another placement of
 * this app's already holds.
 */
export function chooseStill(stills, size, placed = null, { skip = [] } = {}) {
  const need = CAPACITY_UNITS[likelyCapability(size)];
  const holds = (s) => (CAPACITY_UNITS[s.capability] || 0) >= need;
  const taken = new Set(skip.map(String));
  if (placed) {
    const ours = stills.find((s) => s.key === String(placed.still));
    if (ours && ours.mode === 'IMAGE' && Number(ours.source) === placed.slot && holds(ours) && !ours.inSet && !ours.onOutput) return { still: ours, reused: true };
  }
  const free = stills.filter((s) => s.free && holds(s) && !taken.has(s.key));
  if (free.length) return { still: free[free.length - 1], reused: false };
  const small = stills.filter((s) => s.free && !taken.has(s.key));
  return {
    still: null,
    reason: small.length
      ? `Every free still is too small for a ${size.width}×${size.height} picture. Give one ${likelyCapability(size)} capacity in Preconfig ▸ Images.`
      : 'No still is free. Empty one, or give the switcher more in Preconfig ▸ Images.'
  };
}

/**
 * A library slot for the picture: ours if it still holds our file (`name`),
 * else the highest clean empty one. `empty` is `core/stills.js`
 * `emptySlots(store)`: an empty slot a still points at shows on that still
 * the moment the picture lands in it, so one is only taken with `assigned`
 * (the panels' "Use an empty slot a still points at"), and only once no
 * clean slot is left. Our own slot, emptied since, is ours again unless some
 * other still has come to point at it. `stills` in the answer names whoever
 * will show the picture besides our own still. Without `empty` every empty
 * slot counts as clean. `what` is the picture's name in the refusal; `skip`
 * are slots another placement of this app's already holds.
 */
export function chooseSlot(library, name, placed = null, { empty = null, assigned = false, what = 'the picture', skip = [] } = {}) {
  const taken = new Set(skip.map(Number));
  const slots = (empty || library.slots.filter((s) => s.free).map((s) => ({ slot: s.slot, stills: [] })))
    .filter((e) => !taken.has(e.slot));
  const pointing = (slot) => (slots.find((e) => e.slot === slot) || { stills: [] }).stills;
  if (placed) {
    const ours = library.slots.find((s) => s.slot === placed.slot);
    if (ours && !ours.free && ours.fileName === name) return { slot: ours.slot, reused: true, wasFree: false, stills: [] };
    if (ours && ours.free) {
      const others = pointing(ours.slot).filter((s) => s.key !== String(placed.still));
      if (!others.length || assigned) return { slot: ours.slot, reused: false, wasFree: true, stills: others };
    }
  }
  const clean = slots.filter((e) => !e.stills.length);
  if (clean.length) return { slot: clean[clean.length - 1].slot, reused: false, wasFree: true, stills: [] };
  const pick = assigned ? orderSlots(slots, { assigned: true })[0] : null;
  if (pick) return { slot: pick.slot, reused: false, wasFree: true, stills: pick.stills };
  return {
    slot: null,
    reason: slots.length
      ? `Every empty library slot has a still pointing at it, which would show ${what} as well. Tick “Use an empty slot a still points at”, or delete an image on the Image Library page.`
      : 'The image library is full. Delete an image on the Image Library page.'
  };
}

export function libraryHash(store, slot) {
  const st = store.get(['device', 'stillList', 'library', 'bankList', 'items', String(slot), 'status', 'pp']) || {};
  return st.hashName || st.newSnaphot || null;
}

/* ================================================================== put */

/**
 * A picture onto a destination's layer, through a still.
 *
 * @param {object} o
 * @param {object} o.session    the page session (store, send, frame events)
 * @param {object} o.dest       `{ id, canvas }`
 * @param {string|(() => string)} o.letter  the buffer's letter, resolved and settled — or a
 *                             function that resolves it at the moment of the layer write, so a
 *                             take that lands during the upload is not written past
 * @param {string} o.layer      the layer key
 * @param {Blob} o.blob         the PNG
 * @param {string} o.name       its file name, as the library will list it — how our slot is known again
 * @param {string} o.label      the still's label (16 characters at most)
 * @param {{width:number,height:number}} o.size  the picture's size, for the still's capacity
 * @param {(still: string, letter: string) => Array} o.layerWrites  the writes that show the still on the layer
 * @param {object|null} o.placed what this app put there last time: `{ slot, still }`
 * @param {boolean} [o.assignedSlots] may use an empty slot a still points at (`chooseSlot`)
 * @param {{slots?: number[], stills?: Array}} [o.skip] slots and stills held by this app's other placements
 * @param {string} [o.what]     the picture's name in messages
 * @param {(journal) => Promise} [o.persist]  called with the journal so far, and awaited, before
 *                             each group of writes goes out — so a page closed half way still
 *                             has on disk what Off needs to put back
 * @returns {Promise<{ok, journal, placed?, error?}>}
 */
export async function putStillOnLayer({
  session, dest, letter, layer, blob, name, label, size, layerWrites, placed = null, assignedSlots = false,
  skip = {}, what = 'the picture', persist = async () => {}, fetchImpl = fetch, onStep = () => {}
}) {
  const { store } = session;
  const journal = { id: dest.id, uploads: [], stills: [], writes: [] };
  const step = (text, state = 'done') => onStep(text, state);
  try {
    const lib = readLibrary(store);
    const slotChoice = chooseSlot(lib, name, placed, { empty: emptySlots(store), assigned: assignedSlots, what, skip: skip.slots || [] });
    if (!slotChoice.slot) throw new Error(slotChoice.reason);
    if (slotChoice.stills && slotChoice.stills.length) step(`Library slot ${slotChoice.slot} is empty, but ${pointedText(slotChoice.stills)}`, 'note');
    const stillChoice = chooseStill(readStills(store), size, placed && placed.slot === slotChoice.slot ? placed : null, { skip: skip.stills || [] });
    if (!stillChoice.still) throw new Error(stillChoice.reason);
    const still = stillChoice.still;

    const slotNow = () => readLibrary(store).slots.find((s) => s.slot === slotChoice.slot) || {};
    const hashBefore = slotChoice.reused ? libraryHash(store, slotChoice.slot) : null;
    step(`Uploading ${name} → library slot ${slotChoice.slot}${slotChoice.reused ? ' (replacing the last one)' : ''}`, 'running');
    if (slotChoice.wasFree) {
      journal.uploads.push(slotChoice.slot);
      await persist(journal);
    }
    await uploadImage({ session, fetchImpl, blob, name, slot: slotChoice.slot });
    if (slotChoice.reused) {
      /* The slot was already valid, so `uploadImage`'s own wait passed at
         once: the new file is the one with a new hash. */
      const fresh = await until(store, () => libraryHash(store, slotChoice.slot) !== hashBefore, IMPORT_MS);
      if (!fresh) throw new Error(`library slot ${slotChoice.slot} still reports the old file after the upload`);
    }
    if (slotNow().fileName && slotNow().fileName !== name) step(`The library calls it ${slotNow().fileName}`, 'note');
    step(`${name} is in library slot ${slotChoice.slot}`);

    if (!stillChoice.reused) {
      journal.stills.push({ still: still.key, before: { mode: still.mode, source: still.source, rescale: still.rescale, label: still.label } });
      await persist(journal);
      if (!(await sendAndEcho(session, stillWrites(still.key, slotChoice.slot, label), HEARD))) {
        throw new Error(`still ${still.key} did not take library slot ${slotChoice.slot} — the switcher did not echo it`);
      }
      step(`Still ${still.key} shows slot ${slotChoice.slot}, no rescale`);
    } else {
      step(`Still ${still.key} already shows slot ${slotChoice.slot}, and follows the new file`);
    }

    const at = typeof letter === 'function' ? letter() : letter;
    const where = String(layer) === 'NATIVE' ? 'background' : `L${layer}`;
    const writes = layerWrites(still.key, at);
    if (!writes.length) throw new Error(`${dest.id} has no ${where} path this app can spell`);
    journal.writes.push(...before(store, writes));
    await persist(journal);
    if (!(await sendAndEcho(session, writes, HEARD))) {
      throw new Error(`${dest.id} ${where} did not take still ${still.key} — the switcher did not echo it`);
    }
    return {
      ok: true,
      journal,
      placed: { slot: slotChoice.slot, still: Number(still.key), layer: String(layer), letter: at }
    };
  } catch (err) {
    step(err.message, 'failed');
    return { ok: false, journal, error: err.message };
  }
}

/**
 * Take back what a journal says was written, newest first: the layer
 * properties, the still, and a library slot this app filled from empty. A
 * slot it only replaced keeps the new file — the old one was not kept.
 */
export async function revertStillLayer({ session, journal, onStep = () => {} }) {
  const { store } = session;
  const problems = [];
  const step = (text, state = 'done') => onStep(text, state);
  if (journal.writes.length) {
    if (!(await sendAndEcho(session, journal.writes.map((w) => ({ path: w.path, value: w.value })), HEARD))) problems.push('the layers');
    else step(`${journal.id}: the layers are as they were`);
  }
  for (const s of [...journal.stills].reverse()) {
    if (!(await sendAndEcho(session, stillRestoreWrites(s.still, s.before), HEARD))) problems.push(`still ${s.still}`);
    else step(`still ${s.still} back to ${(s.before && s.before.mode) || 'NONE'}`);
  }
  for (const slot of [...journal.uploads].reverse()) {
    send(session, libraryDeleteWrites(slot));
    const gone = await until(store, () => {
      const s = readLibrary(store).slots.find((x) => x.slot === Number(slot));
      return s && s.free;
    }, ECHO_MS);
    if (!gone) problems.push(`library slot ${slot}`);
    else step(`library slot ${slot} emptied`);
  }
  return { ok: problems.length === 0, problems };
}
