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
  stillFormatPath, preStillsTrigger, preStillsNew, preStillsCurrent, nativeSourcePath, edidWrites,
  readLibrary, readStills, readSets, nativeLayer
} from './core.js';
import { presetBanks } from '../../src/core/screens.js';
import { until, send, sendAndEcho, sleep, ECHO_MS, IMPORT_MS } from './wire.js';
import { applyMngPlan, revertMng } from './apply-mng.js';

export { until };

export const UPLOAD_URL = '/api/device/images/upload';
const PRECONFIG_MS = 20000;
/** Only the switcher's own echo counts (see the head of this file). */
const HEARD = { inbound: true };

const pp = (n) => (n && n.pp) || {};

/**
 * Upload one PNG into one library slot and wait until the store has it.
 * `blob` is the image; `name` the file name the library shows.
 */
export async function uploadImage({ session, fetchImpl = fetch, blob, name, slot }) {
  const form = new FormData();
  form.append('librarySlot', String(slot));
  form.append('FILES', blob, name);
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetchImpl(UPLOAD_URL, { method: 'POST', body: form });
    /* 503: another upload (ours from another tab, or the vendor page's) is
       running. Wait and try again rather than fail a long run on it. */
    if (res.status !== 503) break;
    await sleep(1500);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`the switcher refused the upload: ${res.status}${text ? ` ${text.slice(0, 120)}` : ''}`);
  }
  let answer = null;
  try { answer = await res.json(); } catch { answer = null; }
  const status = answer && typeof answer === 'object' ? String(Object.values(answer)[0] || '') : '';
  if (status !== 'FINISH') throw new Error(`the switcher did not import ${name}: ${status || 'no answer'}`);
  /* The store, because the slot's `isValid` is only ever the switcher's word. */
  const landed = await until(session.store, () => {
    const s = readLibrary(session.store).slots.find((x) => x.slot === Number(slot));
    return s && !s.free;
  }, IMPORT_MS);
  if (!landed) throw new Error(`library slot ${slot} did not report ${name} after the import finished`);
}

/**
 * The still-capacity changes, through the staged preconfig. Refuses — before
 * applying anything — when another change is already staged, when the
 * switcher's check says error, or when the check would take a still that
 * holds something out of service. Returns the formats it replaced, for undo.
 */
export async function applyCapacities({ session, changes, log, reserved = new Set() }) {
  const { store } = session;
  if (!changes.length) return [];
  const status = () => pp(store.get(preStillsNew('status')));
  if (status().hasChanged === true) {
    throw new Error('Preconfig ▸ Images has changes staged and not applied — apply or reset them there first');
  }
  const before = changes.map((c) => ({ still: c.still, format: c.before, capability: c.from }));
  const discard = () => send(session, pulse(preStillsTrigger('xCopyFromCurrent')));
  /* The triggers and the formats wait for their inbound echo — the simulator
     echoed both edges of every pulse. The echo says the reset arrived, not
     that the copy is done, so the settle after it stays. */
  if (!(await sendAndEcho(session, pulse(preStillsTrigger('xCopyFromCurrent')), HEARD))) {
    throw new Error('the switcher did not take the reset of Preconfig ▸ Images — nothing was staged');
  }
  await sleep(400);
  const formats = changes.map((c) => ({ path: stillFormatPath(c.still), value: c.format }));
  if (!(await sendAndEcho(session, formats, HEARD))) { discard(); throw new Error('the switcher did not stage the still formats'); }
  if (!(await sendAndEcho(session, pulse(preStillsTrigger('xCheck')), HEARD))) { discard(); throw new Error('the switcher did not take the capacity check'); }
  /* The verdict is read off the store: `new/status` is only the switcher's. */
  await until(store, () => status().hasChanged === true || status().error === true, ECHO_MS);
  if (status().error === true) { discard(); throw new Error('the switcher’s check refused the still capacities'); }

  /* What the change would do, in the switcher's own words. */
  const stills = readStills(store);
  const staged = store.get(preStillsNew('stillList', 'items')) || {};
  const lost = stills.filter((s) => s.enabled && pp(staged[s.key] && staged[s.key].status).global === 'DISABLE');
  /* In use, or about to be: a still this same plan gives another output. */
  const busy = lost.filter((s) => !s.free || reserved.has(s.key));
  if (busy.length) {
    discard();
    throw new Error(`raising the capacity would take ${busy.map((s) => `still ${s.key}`).join(', ')} out of service, and ${busy.length === 1 ? 'it holds' : 'they hold'} something — refused`);
  }
  for (const c of changes) {
    const cap = pp(staged[c.still] && staged[c.still].status).capability;
    if (cap !== c.to) { discard(); throw new Error(`still ${c.still} would become ${cap || 'nothing'}, not ${c.to} — refused`); }
  }
  if (lost.length) log(`the switcher takes ${lost.map((s) => s.key).join(', ')} out of service for the larger capacity (all empty)`);
  /* Applied when `current` says so — a status only the switcher writes, and
     a stronger word than the trigger's echo. */
  send(session, pulse(preStillsTrigger('xApply')));
  const ok = await until(store, () => changes.every((c) => pp(store.get(preStillsCurrent('stillList', 'items', String(c.still), 'status'))).capability === c.to), PRECONFIG_MS);
  if (!ok) {
    /* Applied or not, it was asked for: the journal keeps what to put back. */
    const err = new Error('the switcher did not apply the still capacities');
    err.before = before;
    throw err;
  }
  /* The switcher reports `current` a moment before it clears the staged
     side's `hasChanged` (simulator, 2026-10-06): returned any sooner, an
     Undo pressed at once would refuse it as "changes staged". */
  await until(store, () => status().hasChanged !== true, ECHO_MS);
  return before;
}

/**
 * Put a plan on the switcher. `images` maps `<screen>/<out>` to `{ blob, name }`
 * (stills only). Options: `label` for the sets and stills, `loadPreview` to
 * load each set into its screen's preview, `edids` to load the plugs' EDIDs
 * (live only), `allowProgram` for a set already on program.
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
          const img = images.get(`${s.id}/${o.key}`);
          if (!img) throw new Error(`no image was generated for ${s.id} ${o.name}`);
          step(`Uploading ${img.name} → library slot ${o.librarySlot}`, 'running');
          await uploadImage({ session, fetchImpl, blob: img.blob, name: img.name, slot: o.librarySlot });
          journal.uploads.push(o.librarySlot);
          step(`${img.name} is in library slot ${o.librarySlot}`);

          const label = (options.label || `${s.id} ${o.name}`).slice(0, 16);
          /* Journalled before the echo: a write asked for and not confirmed
             may still have landed, and putting back what was there is
             harmless if it did not. */
          journal.stills.push({ still: o.still, before: o.stillBefore });
          /* `source` is often the slot already (every still on the simulator
             holds 1): unechoed, so not waited for — `wire.changedPaths`. */
          if (!(await sendAndEcho(session, stillWrites(o.still, o.librarySlot, label), HEARD))) {
            throw new Error(`still ${o.still} did not take library slot ${o.librarySlot} — the switcher did not echo it`);
          }
          step(`Still ${o.still} shows slot ${o.librarySlot}, no rescale`);
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
      if (options.label) {
        const w = setLabelWrite(s.id, s.setIndex, options.label);
        journal.labels.push({ screen: s.id, set: s.setIndex, before: before.label });
        if (!(await sendAndEcho(session, [w], HEARD))) throw new Error(`${s.id} set ${s.setIndex} did not take the name “${w.value}” — the switcher did not echo it`);
        step(`${s.id} background set ${s.setIndex} named “${w.value}”`);
      }
    }

    if (options.loadPreview) {
      for (const s of plan.screens) {
        if (!s.assign) continue;
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
