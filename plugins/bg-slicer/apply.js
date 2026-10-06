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
 * Page-side, but no DOM: the session and `fetch` are handed in, so the tests
 * drive it against a stand-in switcher.
 */

import {
  contentWrites, setLabelWrite, stillWrites, stillRestoreWrites, libraryDeleteWrites, pulse,
  stillFormatPath, preStillsTrigger, preStillsNew, preStillsCurrent, nativeSourcePath, edidWrites,
  readLibrary, readStills, readSets, nativeLayer
} from './core.js';
import { presetBanks } from '../../src/core/screens.js';

export const UPLOAD_URL = '/api/device/images/upload';
const ECHO_MS = 6000;
const IMPORT_MS = 60000;
const PRECONFIG_MS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pp = (n) => (n && n.pp) || {};

/** Resolve once `test()` holds, re-checking on every write to the store; false on timeout. */
export function until(store, test, ms = ECHO_MS) {
  try { if (test()) return Promise.resolve(true); } catch { /* not yet */ }
  return new Promise((resolve) => {
    let done = false;
    const check = () => { try { return test(); } catch { return false; } };
    const finish = (v) => { if (done) return; done = true; unsub(); clearTimeout(timer); resolve(v); };
    const unsub = store.subscribe(['device'], () => { if (check()) finish(true); }, { immediate: false });
    const timer = setTimeout(() => finish(check()), ms);
  });
}

/** Send writes in order; true when every one was handed to the socket. */
function send(session, writes) {
  let ok = true;
  for (const w of writes) ok = session.send({ path: w.path, value: w.value }) !== false && ok;
  return ok;
}

/** Send writes and wait for the last value of each path to come back. */
async function sendAndEcho(session, writes, ms = ECHO_MS) {
  if (!send(session, writes)) return false;
  const last = new Map();
  for (const w of writes) last.set(w.path.join('/'), w);
  return until(session.store, () => [...last.values()].every((w) => session.store.get(w.path) === w.value), ms);
}

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
export async function applyCapacities({ session, changes, log }) {
  const { store } = session;
  if (!changes.length) return [];
  const status = () => pp(store.get(preStillsNew('status')));
  if (status().hasChanged === true) {
    throw new Error('Preconfig ▸ Images has changes staged and not applied — apply or reset them there first');
  }
  const before = changes.map((c) => ({ still: c.still, format: c.before, capability: c.from }));
  send(session, pulse(preStillsTrigger('xCopyFromCurrent')));
  await sleep(400);
  for (const c of changes) send(session, [{ path: stillFormatPath(c.still), value: c.format }]);
  send(session, pulse(preStillsTrigger('xCheck')));
  await until(store, () => status().hasChanged === true || status().error === true, ECHO_MS);
  const discard = () => send(session, pulse(preStillsTrigger('xCopyFromCurrent')));
  if (status().error === true) { discard(); throw new Error('the switcher’s check refused the still capacities'); }

  /* What the change would do, in the switcher's own words. */
  const stills = readStills(store);
  const staged = store.get(preStillsNew('stillList', 'items')) || {};
  const lost = stills.filter((s) => s.enabled && pp(staged[s.key] && staged[s.key].status).global === 'DISABLE');
  const busy = lost.filter((s) => !s.free);
  if (busy.length) {
    discard();
    throw new Error(`raising the capacity would take ${busy.map((s) => `still ${s.key}`).join(', ')} out of service, and ${busy.length === 1 ? 'it holds' : 'they hold'} something — refused`);
  }
  for (const c of changes) {
    const cap = pp(staged[c.still] && staged[c.still].status).capability;
    if (cap !== c.to) { discard(); throw new Error(`still ${c.still} would become ${cap || 'nothing'}, not ${c.to} — refused`); }
  }
  if (lost.length) log(`the switcher takes ${lost.map((s) => s.key).join(', ')} out of service for the larger capacity (all empty)`);
  send(session, pulse(preStillsTrigger('xApply')));
  const ok = await until(store, () => changes.every((c) => pp(store.get(preStillsCurrent('stillList', 'items', String(c.still), 'status'))).capability === c.to), PRECONFIG_MS);
  if (!ok) {
    /* Applied or not, it was asked for: the journal keeps what to put back. */
    const err = new Error('the switcher did not apply the still capacities');
    err.before = before;
    throw err;
  }
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
          journal.capacities = await applyCapacities({ session, changes, log: (t) => step(t, 'note') });
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
          if (!(await sendAndEcho(session, stillWrites(o.still, o.librarySlot, label)))) {
            throw new Error(`still ${o.still} did not take library slot ${o.librarySlot}`);
          }
          journal.stills.push({ still: o.still, before: o.stillBefore });
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
      const before = readSets(store, s.id).find((x) => x.index === s.setIndex) || { label: '', contents: {} };
      for (const o of s.outputs) {
        if (!o.content) continue;
        const writes = contentWrites(store, s.id, s.setIndex, o.key, o.content);
        if (!(await sendAndEcho(session, writes))) throw new Error(`${s.id} set ${s.setIndex} did not take ${o.content} on ${o.name}`);
        journal.sets.push({ screen: s.id, set: s.setIndex, out: o.key, before: before.contents[o.key] || 'NONE' });
        step(`${s.id} background set ${s.setIndex}: ${o.name} ← ${o.content}`);
      }
      if (options.label) {
        const w = setLabelWrite(s.id, s.setIndex, options.label);
        await sendAndEcho(session, [w]);
        journal.labels.push({ screen: s.id, set: s.setIndex, before: before.label });
        step(`${s.id} background set ${s.setIndex} named “${w.value}”`);
      }
    }

    if (options.loadPreview) {
      for (const s of plan.screens) {
        const n = nativeLayer(store, s.id);
        if (!n.fitted) { step(`${s.id}: not loaded — its NATIVE layer is not allocated (Preconfig ▸ Resources), so no background set can show`, 'note'); continue; }
        const banks = presetBanks(store, s.id);
        if (!banks.reported || !banks.settled) { step(`${s.id}: not loaded — a take is under way`, 'note'); continue; }
        const path = nativeSourcePath(s.id, banks.preview);
        const before = store.get(path) || 'NONE';
        if (!(await sendAndEcho(session, [{ path, value: `NATIVE_${s.setIndex}` }]))) throw new Error(`${s.id} preview did not load set ${s.setIndex}`);
        journal.natives.push({ screen: s.id, letter: banks.preview, before });
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
    const set = readSets(store, s.id).find((x) => x.index === s.setIndex);
    if (!set) throw new Error(`${s.id} has no background set ${s.setIndex}`);
    if (set.onProgram && !options.allowProgram) throw new Error(`${s.id} background set ${s.setIndex} is on program`);
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
  const { store } = session;
  const problems = [];
  const step = (text, state = 'done') => onStep(text, state);
  for (const n of [...journal.natives].reverse()) {
    if (!(await sendAndEcho(session, [{ path: nativeSourcePath(n.screen, n.letter), value: n.before }]))) problems.push(`${n.screen} ${n.letter} NATIVE`);
    else step(`${n.screen} preset ${n.letter} NATIVE back to ${n.before}`);
  }
  for (const l of [...journal.labels].reverse()) {
    if (!(await sendAndEcho(session, [setLabelWrite(l.screen, l.set, l.before)]))) problems.push(`${l.screen} set ${l.set} label`);
    else step(`${l.screen} set ${l.set} label back to “${l.before}”`);
  }
  for (const c of [...journal.sets].reverse()) {
    if (!(await sendAndEcho(session, contentWrites(store, c.screen, c.set, c.out, c.before)))) problems.push(`${c.screen} set ${c.set} out ${c.out}`);
    else step(`${c.screen} set ${c.set} Out ${c.out} back to ${c.before}`);
  }
  for (const s of [...journal.stills].reverse()) {
    if (!(await sendAndEcho(session, stillRestoreWrites(s.still, s.before)))) problems.push(`still ${s.still}`);
    else step(`still ${s.still} back to ${(s.before && s.before.mode) || 'NONE'}`);
  }
  for (const slot of [...journal.uploads].reverse()) {
    send(session, libraryDeleteWrites(slot));
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
