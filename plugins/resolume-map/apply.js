/*
 * Resolume Mapping — putting the inputs into a background set, and taking
 * them back off.
 *
 * The same writes, in the same order, as the Background Slicer's live-input
 * mode (`plugins/bg-slicer/apply.js`), which proved each one on a LivePremier
 * Simulator 6.2.73 and its Web RCS bundle:
 *
 *   - **An EDID** is the switcher's own: `fromTemplate/<w_h_rate>` (or
 *     `fromCustom/<n>`) pulsed on the input's plug, the vendor's "load from
 *     template". The switcher keeps no previous EDID, so Undo cannot take one
 *     back; it says so.
 *   - **A set's content** goes through `contentWrites`: the replaced input or
 *     still's claim handed on, the new input's claim, then the content.
 *     Writes under `preconfig/backgrounds` are immediate — no apply step.
 *   - **The label**, on the set's own `pp`.
 *   - **Loading it** is the preview buffer's NATIVE layer source, never
 *     program and never a take.
 *
 * Every write waits for the switcher's own echo (`sendAndEcho` with
 * `inbound`); the page mirror takes this page's writes as state, so it is
 * no witness. A step that fails stops the run; the journal says what was
 * written up to there and `revert` takes exactly that back off.
 *
 * Page-side, but no DOM: the session is handed in, so the tests drive it
 * against a stand-in switcher.
 */

import {
  contentWrites, setLabelWrite, nativeSourcePath, nativeLayer, edidWrites
} from '../../src/core/backgrounds.js';
import { readSets } from '../../src/core/stills.js';
import { presetBanks } from '../../src/core/screens.js';
import { send, sendAndEcho } from '../../src/core/wire.js';
import { inputWord } from './core.js';

/** Only the switcher's own echo counts. */
const HEARD = { inbound: true };

/**
 * Write a plan's sets. Options: `label` for the sets, `edids` to load each
 * chosen input's EDID, `preview` to load each set into its screen's preview,
 * `allowProgram` for a set already on program.
 *
 * Resolves `{ ok, journal, error? }`; `onStep(text, state)` hears progress.
 */
export async function applyPlan({ session, plan, options = {}, onStep = () => {} }) {
  const { store } = session;
  const journal = { sets: [], labels: [], natives: [], edids: [] };
  const step = (text, state = 'done') => onStep(text, state);
  try {
    if (!plan.write.ok) throw new Error(plan.write.problems[0] || 'the plan is not complete');
    /* Minutes may have passed since the plan: a set can have gone to air. */
    for (const s of plan.screens) {
      if (!s.assign) continue;
      const set = readSets(store, s.id).find((x) => x.index === s.setIndex);
      if (!set) throw new Error(`${s.id} has no background set ${s.setIndex}`);
      if (set.onProgram && !options.allowProgram) throw new Error(`${s.id} background set ${s.setIndex} is on program`);
    }

    if (options.edids) {
      for (const s of plan.screens) {
        if (!s.assign) continue;
        for (const o of s.outputs) {
          if (!o.input || !o.edid || !o.edid.kind) continue;
          send(session, edidWrites(o.input, o.edid));
          journal.edids.push({ input: o.input, edid: o.edid.key });
          step(`${inputWord(o.input)} plug 1 loaded with the switcher’s ${o.edid.label} EDID`);
        }
      }
    }

    for (const s of plan.screens) {
      if (!s.assign) continue;
      const before = readSets(store, s.id).find((x) => x.index === s.setIndex) || { label: '', contents: {} };
      for (const o of s.outputs) {
        if (!o.content) continue;
        const writes = contentWrites(store, s.id, s.setIndex, o.key, o.content);
        /* Journalled before the echo: a write asked for and not confirmed may
           still have landed, and putting back what was there is harmless if
           it did not. */
        journal.sets.push({ screen: s.id, set: s.setIndex, out: o.key, before: before.contents[o.key] || 'NONE' });
        if (!(await sendAndEcho(session, writes, HEARD))) throw new Error(`${s.id} set ${s.setIndex} did not take ${o.content} on ${o.name} — the switcher did not echo it`);
        step(`${s.id} background set ${s.setIndex}: ${o.name} ← ${inputWord(o.input)}`);
      }
      if (options.label) {
        const w = setLabelWrite(s.id, s.setIndex, options.label);
        journal.labels.push({ screen: s.id, set: s.setIndex, before: before.label });
        if (!(await sendAndEcho(session, [w], HEARD))) throw new Error(`${s.id} set ${s.setIndex} did not take the name “${w.value}” — the switcher did not echo it`);
        step(`${s.id} background set ${s.setIndex} named “${w.value}”`);
      }
    }

    if (options.preview) {
      for (const s of plan.screens) {
        if (!s.assign) continue;
        if (!nativeLayer(store, s.id).fitted) { step(`${s.id}: not loaded — its NATIVE layer is not allocated (Preconfig ▸ Resources), so no background set can show`, 'note'); continue; }
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
 * Take back exactly what a journal says was written, newest first. EDIDs are
 * listed, not undone: the switcher has no "previous EDID" to go back to.
 */
export async function revert({ session, journal, onStep = () => {} }) {
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
  for (const e of journal.edids) step(`${inputWord(e.input)} still serves the ${e.edid} EDID — reset its plug from the EDID page if it should not`, 'note');
  return { ok: problems.length === 0, problems };
}
