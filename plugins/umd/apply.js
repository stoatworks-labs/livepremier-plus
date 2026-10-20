/*
 * UMD Generator — putting a UMD and a template on the switcher, and taking
 * them off again. Page-side, no DOM: the session and `fetch` are handed in,
 * so the tests drive it against a stand-in switcher.
 *
 * An aux's UMD is a picture on its top layer through a still, which is
 * `src/core/still-layer.js`'s `putStillOnLayer` — the library slot, the still
 * and the layer, each journalled and each waiting for the switcher's echo,
 * and an update that is only an upload. Test Card puts its cards on a layer
 * the same way. What is the UMD's own here: its file name and still label,
 * the whole-canvas rectangle, the experimental aux background, and templates.
 */

import { sendAndEcho } from '../../src/core/wire.js';
import { putStillOnLayer, revertStillLayer } from '../../src/core/still-layer.js';
import { umdLayerWrites, nativeWrites, templateWrites, before, fileName } from './core.js';

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
 * @param {boolean} [o.assignedSlots] may use an empty slot a still points at (`chooseSlot`)
 * @returns {Promise<{ok, journal, placed?, error?}>}
 */
export async function putOnLayer({ session, dest, letter, layer, blob, placed = null, assignedSlots = false, fetchImpl = fetch, onStep = () => {} }) {
  const { store } = session;
  const native = String(layer) === 'NATIVE';
  const res = await putStillOnLayer({
    session, dest, letter, layer, blob, placed, assignedSlots, fetchImpl, onStep,
    name: fileName(dest.id),
    label: `UMD ${dest.id}`,
    size: dest.canvas,
    what: 'the UMD',
    layerWrites: (still) => (native ? nativeWrites(store, dest, letter, still) : umdLayerWrites(store, dest, letter, layer, still))
  });
  if (res.ok) {
    onStep(native
      ? `${dest.id} ${letter} background shows still ${res.placed.still} (experimental: no frame has been seen to draw it)`
      : `${dest.id} ${letter} L${layer} shows still ${res.placed.still} over the whole canvas`, 'done');
  }
  return res;
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
 * properties, the still, and a library slot this app filled from empty
 * (`core/still-layer.js` `revertStillLayer`).
 */
export const revert = revertStillLayer;
