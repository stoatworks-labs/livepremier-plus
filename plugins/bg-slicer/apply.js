/*
 * Background Slicer — putting a plan onto the switcher, and taking it off.
 *
 * Everything here goes the way the Web RCS itself sends it, read off its
 * bundle (6.2.73) and proved on a simulator:
 *
 *   - **An image** goes to the library over the vendor's own HTTP route,
 *     `POST /api/device/images/upload` — multipart, the file as `FILES` and
 *     the 1-based slot as `librarySlot` (the server then imports with
 *     `SPECIFIC_SLOT`). One upload at a time: a second one while the first
 *     runs is answered 503. The answer is `{ <file>: STILL_IMPORT_STATUS }`,
 *     and only `FINISH` is success. The proxy streams it like everything that
 *     is not a document, so this is the page's request, through the page's
 *     own origin, and no second client on the box.
 *   - **A still** shows it with `mode` IMAGE then `source` = the slot.
 *   - **A capacity** is the staged preconfig: `preconfig/stills/new` — the
 *     helper format per still, an `xCheck` pulse, the switcher's verdict in
 *     `new/…/status`, then an `xApply` pulse; `current` is the truth after.
 *   - **A background set** is written directly — there is no apply step
 *     anywhere under `preconfig/backgrounds` — with the claim bookkeeping
 *     `core.contentWrites` reproduces.
 *   - **Loading it** is the preview buffer's NATIVE layer source, `NATIVE_<n>`.
 *
 * Every write waits for the switcher's echo before the next step, because the
 * echo is the only evidence it landed (AGENTS.md: never update the mirror
 * optimistically). A step that fails stops the run, and the journal says what
 * was written up to there — `revert(journal)` takes exactly that back off.
 *
 * "The echo" is the switcher's own inbound frame with the path and the value
 * (`wire.sendAndEcho` with `inbound`), never the store: the page mirror takes
 * this page's outbound writes as state, so a refused write would read back
 * as landed (`wire.js`). Proved on the LivePremier Simulator 6.2.73
 * (2026-10-06): every write below — and its Undo — came back inbound with
 * the exact value and type, a refused enum value never did. Two waits are
 * still on the store, and each says why where it is:
 *   - a write of the value the switcher already holds, which it never echoes
 *     (`wire.changedPaths`) — a still's `source` usually, slot 1 on stills
 *     that all hold 1;
 *   - the status the switcher reports after an upload, a library delete, a
 *     capacity check and its apply — values the page never writes, so the
 *     mirror only ever has them from the switcher.
 *
 * Page-side, but no DOM: the session and `fetch` are handed in, so the tests
 * drive it against a stand-in switcher.
 *
 * A Midra 4K or Alta 4K plan (`plan.platform === 'mng'`) goes to
 * `apply-mng.js` instead, and so does its journal on the way back.
 */

import {
  contentWrites, setLabelWrite, stillWrites, stillRestoreWrites, libraryDeleteWrites, pulse,
  nativeSourcePath, edidWrites,
  readLibrary, readStills, readSets, nativeLayer
} from './core.js';
import { presetBanks } from '../../src/core/screens.js';
import { until, send, sendAndEcho, IMPORT_MS } from '../../src/core/wire.js';
import { uploadImage, UPLOAD_URL, applyCapacities, uploadSlots } from '../../src/core/stills.js';
import { applyMngPlan, revertMng } from './apply-mng.js';

export { until, uploadImage, UPLOAD_URL, applyCapacities };

/** Only the switcher's own echo counts (see the head of this file). */
const HEARD = { inbound: true };

/**
 * Put a plan on the switcher. `images` maps `<screen>/<out>` to `{ blob, name }`
 * (stills only). Options: `label` for the sets and stills, `loadPreview` to
 * load each set into its screen's preview, `edids` to load the plugs' EDIDs
 * (live only), `allowProgram` for a set already on program.
 *
 * A document's plan (`deck.js`) is the same shape with a screen once per
 * page: each entry carries `entry` (its images are `<entry>/<out>`), its own
 * `setLabel`, each output its `stillLabel` (and `rescale`), and `preview:
 * false` on every page but the first. A still-less output (`still: null`)
 * is an image for the library and nothing else.
 *
 * Resolves `{ ok, journal, error? }`; `onStep(text, state)` hears progress.
 */
export async function applyPlan({ session, plan, images = new Map(), options = {}, fetchImpl = fetch, onStep = () => {} }) {
  if (plan && plan.platform === 'mng') return applyMngPlan({ session, plan, images, options, fetchImpl, onStep });
  const { store } = session;
  const journal = { uploads: [], stills: [], sets: [], labels: [], capacities: [], natives: [], edids: [] };
  const step = (text, state = 'done') => onStep(text, state);
  try {
    if (!plan.ok) throw new Error(plan.problems[0] || 'the plan is not complete');
    preflight(store, plan, options);

    if (plan.source === 'stills') {
      const changes = plan.capacityChanges.filter((c) => c.format);
      if (changes.length) {
        step(`Still capacities: ${changes.map((c) => `still ${c.still} ${c.from} → ${c.to}`).join(', ')}`, 'running');
        try {
          const reserved = new Set(plan.screens.flatMap((x) => x.outputs.map((o) => o.still)).filter(Boolean));
          journal.capacities = await applyCapacities({ session, changes, reserved, log: (t) => step(t, 'note') });
        } catch (err) {
          if (err.before) journal.capacities = err.before;
          throw err;
        }
        step(`Still capacities applied (${changes.length})`);
      }
      for (const s of plan.screens) {
        for (const o of s.outputs) {
          const img = images.get(`${s.entry || s.id}/${o.key}`);
          if (!img) throw new Error(`no image was generated for ${s.entry || s.id} ${o.name}`);
          step(`Uploading ${img.name} → library slot ${o.librarySlot}`, 'running');
          await uploadImage({ session, fetchImpl, blob: img.blob, name: img.name, slot: o.librarySlot });
          journal.uploads.push(o.librarySlot);
          step(`${img.name} is in library slot ${o.librarySlot}`);

          if (!o.still) continue;
          const label = (o.stillLabel || options.label || `${s.id} ${o.name}`).slice(0, 16);
          const rescale = o.rescale || 'NO_RESCALE';
          /* Journalled before the echo: a write asked for and not confirmed
             may still have landed, and putting back what was there is
             harmless if it did not. */
          journal.stills.push({ still: o.still, before: o.stillBefore });
          /* `source` is often the slot already (every still on the simulator
             holds 1): unechoed, so not waited for — `wire.changedPaths`. */
          if (!(await sendAndEcho(session, stillWrites(o.still, o.librarySlot, label, rescale), HEARD))) {
            throw new Error(`still ${o.still} did not take library slot ${o.librarySlot} — the switcher did not echo it`);
          }
          step(`Still ${o.still} shows slot ${o.librarySlot}, ${rescale === 'NO_RESCALE' ? 'no rescale' : 'downscaled to its capacity'}`);
        }
      }
    } else if (options.edids) {
      for (const s of plan.screens) {
        for (const o of s.outputs) {
          if (!o.edid || !o.edid.kind) continue;
          send(session, edidWrites(o.input, o.edid));
          journal.edids.push({ input: o.input, edid: o.edid.key });
          step(`${o.input} plug 1 loaded with the switcher’s ${o.edid.label} EDID`);
        }
      }
    }

    for (const s of plan.screens) {
      if (!s.assign) continue;
      const before = readSets(store, s.id).find((x) => x.index === s.setIndex) || { label: '', contents: {} };
      for (const o of s.outputs) {
        if (!o.content) continue;
        const writes = contentWrites(store, s.id, s.setIndex, o.key, o.content);
        journal.sets.push({ screen: s.id, set: s.setIndex, out: o.key, before: before.contents[o.key] || 'NONE' });
        if (!(await sendAndEcho(session, writes, HEARD))) throw new Error(`${s.id} set ${s.setIndex} did not take ${o.content} on ${o.name} — the switcher did not echo it`);
        step(`${s.id} background set ${s.setIndex}: ${o.name} ← ${o.content}`);
      }
      const setLabel = s.setLabel != null ? s.setLabel : options.label;
      if (setLabel) {
        const w = setLabelWrite(s.id, s.setIndex, setLabel);
        journal.labels.push({ screen: s.id, set: s.setIndex, before: before.label });
        if (!(await sendAndEcho(session, [w], HEARD))) throw new Error(`${s.id} set ${s.setIndex} did not take the name “${w.value}” — the switcher did not echo it`);
        step(`${s.id} background set ${s.setIndex} named “${w.value}”`);
      }
    }

    if (options.loadPreview) {
      for (const s of plan.screens) {
        if (!s.assign || s.preview === false) continue;
        const n = nativeLayer(store, s.id);
        if (!n.fitted) { step(`${s.id}: not loaded — its NATIVE layer is not allocated (Preconfig ▸ Resources), so no background set can show`, 'note'); continue; }
        const banks = presetBanks(store, s.id);
        if (!banks.reported || !banks.settled) { step(`${s.id}: not loaded — a take is under way`, 'note'); continue; }
        const path = nativeSourcePath(s.id, banks.preview);
        const before = store.get(path) || 'NONE';
        journal.natives.push({ screen: s.id, letter: banks.preview, before });
        if (!(await sendAndEcho(session, [{ path, value: `NATIVE_${s.setIndex}` }], HEARD))) throw new Error(`${s.id} preview did not load set ${s.setIndex} — the switcher did not echo it`);
        step(`${s.id} preview (${banks.preview}) shows background set ${s.setIndex}`);
      }
    }
    return { ok: true, journal };
  } catch (err) {
    step(err.message, 'failed');
    return { ok: false, journal, error: err.message };
  }
}

/**
 * Re-read the switcher just before writing: everything the plan chose must
 * still be free, because minutes may have passed and another operator may
 * have taken a slot or a still in them.
 */
function preflight(store, plan, options) {
  const lib = readLibrary(store);
  const stills = readStills(store);
  /* An empty slot a still has come to point at since the plan is not free
     for this upload, unless the plan was made allowing that. */
  const usable = new Set(uploadSlots(store, { assigned: plan.assignedSlots === true }).map((s) => s.slot));
  for (const s of plan.screens) {
    if (s.assign) {
      const set = readSets(store, s.id).find((x) => x.index === s.setIndex);
      if (!set) throw new Error(`${s.id} has no background set ${s.setIndex}`);
      if (set.onProgram && !options.allowProgram) throw new Error(`${s.id} background set ${s.setIndex} is on program`);
    }
    for (const o of s.outputs) {
      if (plan.source !== 'stills') continue;
      const slot = lib.slots.find((x) => x.slot === o.librarySlot);
      if (!slot || !slot.free) throw new Error(`library slot ${o.librarySlot} is no longer free — plan again`);
      if (!usable.has(o.librarySlot)) throw new Error(`library slot ${o.librarySlot} is empty, but a still points at it now — plan again`);
      if (!o.still) continue;
      const still = stills.find((x) => x.key === o.still);
      if (!still || !still.free) throw new Error(`still ${o.still} is no longer free — plan again`);
    }
  }
}

/**
 * Take back exactly what a journal says was written, newest first: the
 * preview's NATIVE source, the sets' labels and contents, the stills, the
 * library images, and the still capacities. EDIDs loaded into plugs are
 * listed, not undone — the switcher has no "previous EDID" to go back to;
 * an input's plug goes back to its default EDID from the vendor's EDID page.
 */
export async function revert({ session, journal, onStep = () => {} }) {
  if (journal && journal.platform === 'mng') return revertMng({ session, journal, onStep });
  const { store } = session;
  const problems = [];
  const step = (text, state = 'done') => onStep(text, state);
  for (const n of [...journal.natives].reverse()) {
    if (!(await sendAndEcho(session, [{ path: nativeSourcePath(n.screen, n.letter), value: n.before }], HEARD))) problems.push(`${n.screen} ${n.letter} NATIVE`);
    else step(`${n.screen} preset ${n.letter} NATIVE back to ${n.before}`);
  }
  for (const l of [...journal.labels].reverse()) {
    if (!(await sendAndEcho(session, [setLabelWrite(l.screen, l.set, l.before)], HEARD))) problems.push(`${l.screen} set ${l.set} label`);
    else step(`${l.screen} set ${l.set} label back to “${l.before}”`);
  }
  for (const c of [...journal.sets].reverse()) {
    if (!(await sendAndEcho(session, contentWrites(store, c.screen, c.set, c.out, c.before), HEARD))) problems.push(`${c.screen} set ${c.set} out ${c.out}`);
    else step(`${c.screen} set ${c.set} Out ${c.out} back to ${c.before}`);
  }
  for (const s of [...journal.stills].reverse()) {
    if (!(await sendAndEcho(session, stillRestoreWrites(s.still, s.before), HEARD))) problems.push(`still ${s.still}`);
    else step(`still ${s.still} back to ${(s.before && s.before.mode) || 'NONE'}`);
  }
  for (const slot of [...journal.uploads].reverse()) {
    send(session, libraryDeleteWrites(slot));
    /* Emptied when the slot's `isValid` says so — the switcher's word only. */
    const gone = await until(store, () => {
      const s = readLibrary(store).slots.find((x) => x.slot === Number(slot));
      return s && s.free;
    }, IMPORT_MS);
    if (!gone) problems.push(`library slot ${slot}`);
    else step(`library slot ${slot} emptied`);
  }
  if (journal.capacities.length) {
    try {
      await applyCapacities({
        session,
        changes: journal.capacities.map((c) => ({ still: c.still, format: c.format, to: c.capability })),
        log: (t) => step(t, 'note')
      });
      step(`still capacities back: ${journal.capacities.map((c) => `${c.still} ${c.format}`).join(', ')}`);
    } catch (err) {
      problems.push(`still capacities: ${err.message}`);
    }
  }
  for (const e of journal.edids) step(`${e.input} still serves the ${e.edid} EDID — reset its plug from the EDID page if it should not`, 'note');
  return { ok: problems.length === 0, problems };
}
