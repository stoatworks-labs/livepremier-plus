/*
 * UMD Generator — putting a UMD and a template on the switcher, and taking
 * them off again. Page-side, no DOM: the session and `fetch` are handed in,
 * so the tests drive it against a stand-in switcher.
 *
 * An aux's UMD is three things, each the way the Web RCS itself does it
 * (`src/core/stills.js` has the evidence):
 *
 *   1. **the picture into a library slot** — the vendor's own upload route;
 *   2. **a still showing that slot** — `mode` IMAGE, `source` = the slot,
 *      `rescale` NO_RESCALE, since the picture is made at the canvas's size;
 *   3. **the aux's top layer showing the still**, over the whole canvas,
 *      uncropped and opaque, in the buffer the operator chose.
 *
 * **Updating is only step 1.** Uploading into a slot that holds a file
 * replaces it, and a still showing that slot follows by itself: on the
 * LivePremier Simulator 6.2.73 (2026-10-16) a 1280×720 PNG sent to slot 200
 * over a 1920×1080 one changed the slot's `hashName` and still 48's
 * `imageWidth` within three seconds, with nothing written to the still. So a
 * UMD already in place is refreshed by uploading again, and if its layer is
 * on program the new one is on air at once — the panel says so first.
 *
 * Every write waits for the switcher's own echo (`src/core/wire.js`): the page
 * mirror takes this page's writes as state, so only an inbound frame proves a
 * write landed. Everything is journalled before it is sent, and `revert`
 * takes back exactly what the journal holds.
 */

import { readLibrary, readStills, stillWrites, stillRestoreWrites, libraryDeleteWrites, uploadImage } from '../../src/core/stills.js';
import { sendAndEcho, send, until, ECHO_MS, IMPORT_MS } from '../../src/core/wire.js';
import { chooseSlot, chooseStill, umdLayerWrites, nativeWrites, templateWrites, before, fileName } from './core.js';

const HEARD = { inbound: true };

/**
 * The UMD onto an aux's layer.
 *
 * @param {object} o
 * @param {object} o.session    the page session (store, send, frame events)
 * @param {object} o.dest       `{ id, canvas }`
 * @param {string} o.letter     the buffer's letter, resolved and settled
 * @param {string} o.layer      the layer key that carries the UMD — `NATIVE` for an aux's
 *                             background (experimental: the still as its source, no placing)
 * @param {Blob} o.blob         the PNG
 * @param {object|null} o.placed what this app put there last time
 * @returns {Promise<{ok, journal, placed?, error?}>}
 */
export async function putOnLayer({ session, dest, letter, layer, blob, placed = null, fetchImpl = fetch, onStep = () => {} }) {
  const { store } = session;
  const journal = { id: dest.id, uploads: [], stills: [], writes: [] };
  const step = (text, state = 'done') => onStep(text, state);
  try {
    const lib = readLibrary(store);
    const slotChoice = chooseSlot(lib, dest.id, placed);
    if (!slotChoice.slot) throw new Error(slotChoice.reason);
    const stillChoice = chooseStill(readStills(store), dest.canvas, placed && placed.slot === slotChoice.slot ? placed : null);
    if (!stillChoice.still) throw new Error(stillChoice.reason);
    const still = stillChoice.still;

    const name = fileName(dest.id);
    const slotNow = () => readLibrary(store).slots.find((s) => s.slot === slotChoice.slot) || {};
    const hashBefore = slotChoice.reused ? libraryHash(store, slotChoice.slot) : null;
    step(`Uploading ${name} → library slot ${slotChoice.slot}${slotChoice.reused ? ' (replacing the last one)' : ''}`, 'running');
    if (slotChoice.wasFree) journal.uploads.push(slotChoice.slot);
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
      if (!(await sendAndEcho(session, stillWrites(still.key, slotChoice.slot, `UMD ${dest.id}`), HEARD))) {
        throw new Error(`still ${still.key} did not take library slot ${slotChoice.slot} — the switcher did not echo it`);
      }
      step(`Still ${still.key} shows slot ${slotChoice.slot}, no rescale`);
    } else {
      step(`Still ${still.key} already shows slot ${slotChoice.slot}, and follows the new file`);
    }

    const native = String(layer) === 'NATIVE';
    const where = native ? 'background' : `L${layer}`;
    const writes = native ? nativeWrites(store, dest, letter, still.key) : umdLayerWrites(store, dest, letter, layer, still.key);
    if (!writes.length) throw new Error(`${dest.id} has no ${where} path this app can spell`);
    journal.writes.push(...before(store, writes));
    if (!(await sendAndEcho(session, writes, HEARD))) {
      throw new Error(`${dest.id} ${where} did not take still ${still.key} — the switcher did not echo it`);
    }
    step(native
      ? `${dest.id} ${letter} background shows still ${still.key} (experimental: no frame has been seen to draw it)`
      : `${dest.id} ${letter} L${layer} shows still ${still.key} over the whole canvas`);
    return {
      ok: true,
      journal,
      placed: { slot: slotChoice.slot, still: Number(still.key), layer: String(layer), letter }
    };
  } catch (err) {
    step(err.message, 'failed');
    return { ok: false, journal, error: err.message };
  }
}

function libraryHash(store, slot) {
  const st = store.get(['device', 'stillList', 'library', 'bankList', 'items', String(slot), 'status', 'pp']) || {};
  return st.hashName || st.newSnaphot || null;
}

/** A template onto a buffer's layers. Resolves `{ ok, journal, error? }`. */
export async function applyTemplate({ session, dest, letter, template, boxLayers, gap = 0, onStep = () => {} }) {
  const { store } = session;
  const writes = templateWrites(store, dest, letter, template, boxLayers, gap);
  const journal = { id: dest.id, uploads: [], stills: [], writes: before(store, writes) };
  if (!(await sendAndEcho(session, writes, HEARD))) {
    onStep(`${dest.id} did not take the ${template.label} layout — the switcher did not echo it`, 'failed');
    return { ok: false, journal, error: 'the switcher did not echo the layout' };
  }
  onStep(`${dest.id} ${letter}: ${template.label} on L${boxLayers.slice(0, template.boxes).join(', L')}`);
  return { ok: true, journal };
}

/**
 * Take back what a journal says was written, newest first: the layer
 * properties, the still, and a library slot this app filled from empty. A
 * slot it only replaced keeps the new file — the old one was not kept.
 */
export async function revert({ session, journal, onStep = () => {} }) {
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
