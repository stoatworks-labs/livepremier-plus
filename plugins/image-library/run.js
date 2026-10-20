/*
 * Image Library tools — carrying a plan out against the switcher.
 *
 * Page-side and no DOM: the session, `fetch` and the question are handed in,
 * so the tests drive all of it against a stand-in switcher.
 *
 * - **A delete is the vendor card's bin**, pulsed, one slot at a time, each
 *   waited for until the switcher reports the slot empty (`isValid` is a
 *   status the page never writes, so the mirror only has it from the
 *   switcher). The plan is asked again just before each slot: a take between
 *   the question and the delete can put a still showing it on a bus, and then
 *   it is kept.
 * - **An upload is the vendor's own route** into one named slot
 *   (`core/stills.js` `uploadImage`), one file at a time, because the route
 *   answers 503 to a second while one runs. A file the switcher refuses is
 *   recorded and the rest carry on.
 * - **A capacity is staged, checked, asked about, then applied**
 *   (`stageCapacities`): the question carries the switcher's own verdict on
 *   what goes out of service, and Cancel puts the staged side back.
 *
 * Each long run can be stopped between items: `stopped()` is asked before
 * each one, and what was done up to there is reported.
 */

import { readLibrary, libraryDeleteWrites, uploadImage, stageCapacities } from '../../src/core/stills.js';
import { send, until, ECHO_MS } from '../../src/core/wire.js';
import { planDelete, planCapacity, capacityQuestion, uploadSlots } from './core.js';

const isFree = (store, slot) => {
  const s = readLibrary(store).slots.find((x) => x.slot === Number(slot));
  return !s || s.free;
};

/**
 * Delete library slots. Resolves `{ deleted, kept, failed, stopped }`;
 * `onStep(done, total, slot)` hears progress.
 */
export async function deleteSlots({ session, slots, onStep = () => {}, stopped = () => false, ms = ECHO_MS }) {
  const { store } = session;
  const out = { deleted: [], kept: [], failed: [], stopped: false };
  let done = 0;
  for (const slot of slots) {
    if (stopped()) { out.stopped = true; break; }
    onStep(done, slots.length, slot);
    /* Asked again now, not trusted from when the operator was asked. */
    const now = planDelete(store, [slot]);
    if (now.kept.length) { out.kept.push(...now.kept); done++; continue; }
    if (!now.remove.length) { done++; continue; }
    send(session, libraryDeleteWrites(slot));
    if (await until(store, () => isFree(store, slot), ms)) out.deleted.push(slot);
    else out.failed.push({ slot, why: 'the switcher did not report it empty' });
    done++;
  }
  onStep(done, slots.length, null);
  return out;
}

/**
 * Upload pictures into the slots planned for them (`core.placeUploads`).
 * `items` is `[{ slot, name, blob }]`, or `[{ slot, name, read }]` where
 * `read()` resolves the blob — a zip's entry is only unpacked when its turn
 * comes, so a 200-picture zip is never all in memory twice.
 *
 * A slot that is no longer one `uploadSlots` offers — filled since the plan
 * by another tab or the vendor's own upload, or pointed at by a still that
 * has gone on a bus since — is swapped for one it does offer that nobody in
 * the plan is waiting for. Resolves
 * `{ uploaded: [{ slot, name }], failed: [{ name, why }], stopped }`.
 */
export async function uploadPictures({ session, items, fetchImpl = fetch, onStep = () => {}, stopped = () => false }) {
  const { store } = session;
  const out = { uploaded: [], failed: [], stopped: false };
  const planned = new Set(items.map((i) => i.slot));
  let done = 0;
  for (const item of items) {
    if (stopped()) { out.stopped = true; break; }
    onStep(done, items.length, item.name);
    planned.delete(item.slot);
    let slot = item.slot;
    const usable = uploadSlots(store);
    if (!usable.some((s) => s.slot === slot)) {
      const other = usable.find((s) => !planned.has(s.slot));
      if (!other) { out.failed.push({ name: item.name, why: 'no free slot left' }); done++; continue; }
      slot = other.slot;
    }
    try {
      const blob = item.blob || await item.read();
      await uploadImage({ session, fetchImpl, blob, name: item.name, slot });
      out.uploaded.push({ slot, name: item.name });
    } catch (err) {
      out.failed.push({ name: item.name, why: err && err.message ? err.message : String(err) });
    }
    done++;
  }
  onStep(done, items.length, null);
  return out;
}

/**
 * Change one still's capacity. `ask(text)` is the question — `window.confirm`
 * in the page — and is only put once the switcher has checked the change.
 * Resolves `{ ok, changed, cancelled?, error? }`.
 */
export async function changeCapacity({ session, still, to, ask }) {
  const plan = planCapacity(session.store, still, to);
  if (plan.error) return { ok: false, changed: false, error: plan.error };
  if (!plan.change) return { ok: true, changed: false };
  let staged;
  try {
    staged = await stageCapacities({ session, changes: [plan.change] });
  } catch (err) {
    return { ok: false, changed: false, error: err.message };
  }
  let yes = false;
  try { yes = await ask(capacityQuestion(plan, staged)); } catch { yes = false; }
  if (!yes) {
    staged.discard();
    return { ok: true, changed: false, cancelled: true };
  }
  try {
    await staged.commit();
  } catch (err) {
    return { ok: false, changed: false, error: err.message };
  }
  return { ok: true, changed: true };
}
