/*
 * Getting a look out of the programmer and into a real memory slot.
 *
 * Two routes, because the good one has a condition attached that cannot be
 * checked from here.
 *
 * **Direct.** Compose the bank's own file and hand it to the device's import.
 * Nothing is written to a preset buffer, nothing is taken, and neither bus
 * moves. This is the route the Edit page exists to make possible and it is the
 * default. Its catch is not in this file: `plugins/edit/memory-import.js` explains
 * that the path the device reads is the *device's* filesystem, which is this
 * machine on a simulator and an open question on a real Aquilon.
 *
 * **Via preview.** Write the look into the preview buffer, fire the device's
 * ordinary save, then put preview back exactly as it was. Program never moves;
 * preview is disturbed for about as long as it takes to send sixty-six
 * properties and read one flag. This is the route that works on any switcher,
 * including a Midra 4K or Alta 4K, whose banks have no import at all.
 *
 * ## What "put preview back" means, and why it is honest
 *
 * The whole preset buffer is deep-copied out of the mirror before anything is
 * written, and written back property-for-property afterwards. That is a
 * complete restoration rather than a best effort, because the mirror holds
 * every one of the sixty-six writable layer properties — the same set the
 * Layer panel edits and the same set a memory carries.
 *
 * What it does NOT restore is the bank's opinion of the buffer.
 * `presetBank/status/presetId/.../isNotModified` goes false the moment
 * anything is written, and putting the values back does not put that flag
 * back: the device is right that the buffer was modified. So an operator whose
 * preview was holding memory 44 unmodified will afterwards see "memory 44,
 * modified" against identical content. Saying so is the point of this
 * paragraph; hiding it would be worse.
 *
 * ⚠️ **Refused mid-take.** PREVIEW does not name a letter honestly while a
 * transition is in flight — the device is showing a mix of both buffers — so
 * this refuses rather than guessing, for the same reason `core/properties.js`
 * refuses a write. Guessing here would write a look onto the output.
 */

import { ROOT } from './paths.js';
import { dialectFor } from './dialect.js';
import { listDestinations, presetBanks } from './screens.js';
import { catalogueFor } from './properties.js';
import { saveCmd, labelCmd } from './memories.js';
import { toMemory, layersFrom } from './preset-file.js';

/** How long to wait for the bank to admit the memory arrived. */
const SAVE_TIMEOUT_MS = 6000;
const POLL_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The memory file entry for one destination's programmer buffer.
 *
 * The canvas and the layer capabilities come from the device, not from the
 * look: a memory records the screen it was saved from, and the programmer has
 * no opinion about how the screen is fitted.
 */
export function composeMemory({ programmer, id, slot, label = '', duration = null }) {
  const store = programmer.store;
  const dialect = dialectFor(store);
  if (!dialect) return null;

  const dest = listDestinations(store, { includeUnused: true }).find((d) => d.id === id);
  const look = programmer.look(id);
  if (!dest || !look) return null;

  const fitted = dialect.fittedLayers(store, id);
  const listName = dialect.id === 'mng' ? 'liveLayerList' : 'layerList';
  const layers = layersFrom(look, fitted, { listName });
  if (!layers.length) return null;

  return toMemory({
    slot,
    label,
    /* The device's own default when nothing else is said — a one-second fade,
       in the tenths it counts in. */
    duration: duration == null ? 10 : duration,
    canvas: dest.canvas,
    layers
  }, catalogueFor(store));
}

/**
 * Every write that puts a look into one buffer of one destination.
 *
 * Built rather than sent, so a caller can count them, show them, or refuse.
 * A property the look does not carry produces no write: it is not that the
 * operator chose the device's current value, it is that they chose nothing.
 */
export function bufferWrites({ store, id, buffer, look }) {
  const dialect = dialectFor(store);
  if (!dialect || !look) return [];
  const listName = dialect.id === 'mng' ? 'liveLayerList' : 'layerList';
  const items = (look[listName] && look[listName].items) || {};
  const specs = catalogueFor(store).layer.filter((s) => !s.readOnly);

  const out = [];
  for (const fitted of dialect.fittedLayers(store, id)) {
    const node = items[String(fitted.key)];
    if (!node) continue;
    for (const spec of specs) {
      const value = spec.path.reduce((n, seg) => (n == null ? undefined : n[seg]), node);
      if (value === undefined) continue;
      const path = dialect.layerParamPath(id, buffer, fitted.key, spec.path);
      if (path) out.push({ path, value });
    }
  }
  return out;
}

/**
 * Put a look into the programmer, over whatever is there.
 *
 * Used for a memory read back off the device, and this is why it applies
 * writes rather than replacing the buffer wholesale: **a memory carries only
 * the categories it was saved with.** One saved with `["SOURCE","POS"]` has
 * twelve fields per layer, not seventy-two, so installing it as the buffer
 * would leave a look with no size — and `core/screens.js` draws nothing for a
 * layer with no size, so the card would come up empty and look broken.
 *
 * Seeding first gives every property a real device-provided value; the
 * memory's own values then land on top of it.
 */
export function applyLook({ programmer, id, look, seedFrom = 'PREVIEW' }) {
  if (!programmer.has(id) && !programmer.seed(id, seedFrom)) return 0;
  const writes = bufferWrites({
    store: programmer.store, id, buffer: programmer.buffer, look
  });
  let sent = 0;
  for (const cmd of writes) { if (programmer.send(cmd)) sent++; }
  return sent;
}

/**
 * A memory's layers as a preset node, ready for `applyLook`.
 *
 * LivePremier spelling, because the bank's import and export are LivePremier's
 * and no Midra or Alta bank has them — see `core/preset-file.js`.
 */
export function lookFromMemory(memory) {
  const items = {};
  for (const layer of (memory && memory.layers) || []) items[layer.key] = layer.node;
  return { layerList: { items } };
}

/**
 * Save a look by borrowing the preview buffer.
 *
 * @param {object} opts
 * @param {{store:object, send:Function}} opts.session   the LIVE session
 * @param {object} opts.programmer
 * @param {string} opts.id
 * @param {number} opts.slot
 * @param {string} [opts.label]
 * @param {boolean} [opts.restore]  put preview back afterwards; only ever false
 *                                  when a caller has asked for the look to stay
 * @returns {Promise<{ok:boolean, message:string, wrote?:number, restored?:boolean}>}
 */
export async function saveViaPreview({
  session, programmer, id, slot, label = '', restore = true, timeoutMs = SAVE_TIMEOUT_MS
}) {
  const store = session.store;
  const dialect = dialectFor(store);
  if (!dialect) return { ok: false, message: 'the device store has not arrived' };

  const banks = presetBanks(store, id);
  if (!banks.reported) return { ok: false, message: `${id}: the device has not said which buffer is preview` };
  if (!banks.settled) return { ok: false, message: `${id}: a take is in flight — preview does not name a buffer until it lands` };

  const dest = listDestinations(store, { includeUnused: true }).find((d) => d.id === id);
  const look = programmer.look(id);
  if (!dest || !look) return { ok: false, message: `${id}: nothing programmed` };

  /* Everything preview is holding, before a single write. */
  const previewPath = [ROOT, dest.listName, 'items', id, 'presetList', 'items', banks.preview];
  const before = structuredClone(store.get(previewPath) || {});

  const writes = bufferWrites({ store, id, buffer: banks.preview, look });
  if (!writes.length) return { ok: false, message: `${id}: the look has nothing to write` };

  let wrote = 0;
  try {
    for (const cmd of writes) { if (session.send(cmd)) wrote++; }

    const save = saveCmd('screen', slot, { mode: 'PREVIEW', id }, dialect);
    if (!save) return { ok: false, message: 'this platform has no screen memory bank' };
    session.send(save);

    const landed = await waitForValid(store, dialect, slot, timeoutMs);
    if (label) session.send(labelCmd('screen', slot, label, dialect));

    return landed
      ? { ok: true, message: `memory ${slot} saved from ${id} via preview`, wrote, restored: restore }
      : { ok: false, message: `memory ${slot} did not come back valid`, wrote, restored: restore };
  } finally {
    /* In a `finally` deliberately: a save that fails must not leave the
       operator's preview holding the experiment. */
    if (restore) {
      for (const cmd of bufferWrites({ store, id, buffer: banks.preview, look: before })) {
        session.send(cmd);
      }
    }
  }
}

/**
 * Wait for the bank to say the slot is valid.
 *
 * A write is answered with silence and the save is no exception, so the only
 * confirmation is the flag turning over on a later frame. Polling the mirror
 * rather than subscribing because the mirror is already being fed by the
 * socket; there is nothing to subscribe to that a read would not see.
 */
async function waitForValid(store, dialect, slot, timeoutMs = SAVE_TIMEOUT_MS) {
  const bank = dialect.bankFor ? dialect.bankFor('screen') : null;
  if (!bank) return false;
  const path = [...dialect.slotList(bank), 'items', String(slot), 'status', 'pp', 'isValid'];
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (store.get(path) === true) return true;
    await sleep(POLL_MS);
  }
  return store.get(path) === true;
}
