/*
 * Timer Image — putting a picture on the switcher, and taking it off.
 *
 * One push, in this order, each step confirmed by the switcher:
 *
 *   1. **Upload** into the empty slot `planPush` predicted (the switcher
 *      chooses; `uploadToNextSlot` reads back where it really went).
 *   2. **Point the Foreground Image at it**, 1:1, and wait for the switcher's
 *      own echo of `librarySlot` — the page mirror applies this page's
 *      writes too, so the store alone would say yes to a refused write.
 *   3. **Empty the slot it showed before**, and any other of ours no frame
 *      points at, now that nothing shows them.
 *
 * Each step is timed, because the time a Pulse takes from upload to picture
 * is the one number nobody has measured; the panel shows it.
 */

import { uploadToNextSlot, readLibrary, framesOn } from '../../src/core/library-mng.js';
import { sendAndEcho, send, until, ECHO_MS } from '../../src/core/wire.js';
import { planPush, pointWrites, deleteWrites, topFramePath, ownedBy } from './core.js';

const clock = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/** Empty `slots` and wait until the switcher says each is free. */
async function empty(session, slots, ms = ECHO_MS) {
  const store = session.store;
  const sent = [];
  for (const slot of slots) {
    const writes = deleteWrites(store, slot);
    if (!writes.length) continue;
    send(session, writes);
    sent.push(Number(slot));
  }
  if (!sent.length) return true;
  return until(store, () => {
    const lib = readLibrary(store);
    return sent.every((n) => { const s = lib.slots.find((x) => x.slot === n); return !s || s.free; });
  }, ms);
}

/**
 * Put one picture on `screen`'s Foreground Image `frame`. Resolves
 * `{ ok, error?, slot, status, upload, point, remove, total }` (ms).
 */
export async function pushPicture({ session, screen, frame, blob, fetchImpl = fetch, importMs }) {
  const store = session.store;
  const t0 = clock();
  const plan = planPush(store, { screen, frame });
  if (!plan.ok) return { ok: false, error: plan.problems[0], total: 0 };

  const up = await uploadToNextSlot({ session, fetchImpl, blob, name: plan.name, importMs });
  const t1 = clock();
  if (up.slot == null) return { ok: false, error: `the switcher answered ${up.status || 'nothing'} and no library slot took ${plan.name}`, upload: t1 - t0, total: t1 - t0 };
  /* Another upload got there first, and ours went elsewhere. Showing it there
     is still right, unless some other frame points at that slot too. */
  const others = framesOn(store, up.slot).filter((x) => !(x.list === 'topFrameList' && x.screen === screen && Number(x.index) === frame));
  if (others.length) {
    await empty(session, [up.slot]);
    return { ok: false, error: `${plan.name} went into slot ${up.slot}, which ${others.map((o) => o.name).join(', ')} points at; emptied it again`, upload: t1 - t0, total: clock() - t0 };
  }

  const pointed = await sendAndEcho(session, pointWrites(store, screen, frame, up.slot), { inbound: true });
  const t2 = clock();
  if (!pointed) {
    await empty(session, [up.slot]);
    return { ok: false, error: `the switcher did not take ${screen} FRG${frame} → slot ${up.slot}`, upload: t1 - t0, point: t2 - t1, total: clock() - t0 };
  }

  const old = [plan.current, ...plan.tidy].filter((s) => s != null && s !== up.slot);
  const removed = await empty(session, old);
  const t3 = clock();
  return {
    ok: true,
    slot: up.slot,
    predicted: plan.predicted,
    status: up.status,
    resampled: up.status !== 'FINISH',
    removed,
    upload: Math.round(t1 - t0),
    point: Math.round(t2 - t1),
    remove: Math.round(t3 - t2),
    total: Math.round(t3 - t0)
  };
}

/**
 * Take the timer off: point the Foreground Image at no slot, and empty every
 * slot of ours for it. A preset whose top layer showed the frame then shows
 * nothing there. Resolves `{ ok, error? }`.
 */
export async function removePicture({ session, screen, frame }) {
  const store = session.store;
  const path = topFramePath(screen, frame, 'librarySlot');
  if (store.get(path) !== undefined && store.get(path) !== 'NONE') {
    const shown = readLibrary(store).slots.find((s) => String(s.slot) === String(store.get(path)));
    const own = shown && ownedBy(shown.fileName);
    if (shown && !shown.free && !(own && own.screen === screen && own.frame === frame)) {
      return { ok: false, error: `${screen} FRG${frame} shows ${shown.fileName || `slot ${shown.slot}`}, which this app did not put there; left as it is` };
    }
    const ok = await sendAndEcho(session, [{ path, value: 'NONE' }], { inbound: true });
    if (!ok) return { ok: false, error: `the switcher did not take ${screen} FRG${frame} → none` };
  }
  const ours = readLibrary(store).slots
    .filter((s) => !s.free)
    .filter((s) => { const o = ownedBy(s.fileName); return o && o.screen === screen && o.frame === frame; })
    .map((s) => s.slot);
  const emptied = await empty(session, ours);
  return emptied ? { ok: true, emptied: ours } : { ok: false, error: `library slot${ours.length === 1 ? '' : 's'} ${ours.join(', ')} did not empty` };
}
