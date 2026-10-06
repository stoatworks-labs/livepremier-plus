/*
 * Background Slicer on a Midra 4K or Alta 4K — putting a plan onto the
 * switcher, and taking it off. `apply.js` hands a plan here when it says
 * `platform: 'mng'`; `mng.js` is the model and the write lists.
 *
 * Per screen, in this order, each step waiting for the switcher's echo:
 *
 *   1. **The image goes to the library** over the vendor's own route,
 *      `POST /api/device/images/upload`, the file as `FILES` and nothing
 *      else: this platform's server imports it with `AUTO_SLOT_WITH_
 *      DOWNSCALE`, into the first empty slot, and takes no slot from us. The
 *      answer is `{ <file>: STILL_IMPORT_STATUS }`; only `FINISH` is success
 *      — `FINISH_WITH_DOWNSCALE` means the switcher resampled it, which is a
 *      failure here. Which slot it went into is read back, not assumed: the
 *      slot that was empty before and now holds a file of this name. It must
 *      be the one the plan predicted, at the picture's size.
 *   2. **A Background Image shows it 1:1**: `librarySlot`, then the display
 *      mode `1_1`, then the label — and the step waits for the frame's own
 *      `status/pp/{isValid,width,height}` to read the canvas size, the
 *      switcher's word that it shows the picture unscaled.
 *   3. **The set**: Auto Crop with that Background Image (stills), or Custom
 *      with an input per output (live). Immediate — there is no apply step.
 *   4. **The preview loads it**, if asked: the preview buffer's background
 *      layer selects the set. Never program, never a take; skipped mid-take
 *      and on a screen with no background layer.
 *
 * "Waiting for the echo" means the switcher's own inbound frame for each
 * path and value (`wire.sendAndEcho` with `inbound`), not the store: the page
 * mirror applies this page's outbound writes too, and a refused write would
 * read back as if it had landed (see `wire.js`). The status checks — the
 * library slot, the frame's size, the preview's content size — are values
 * only the switcher writes.
 *
 * Every write is journalled with the value it replaced before it is sent, so
 * `revertMng` is the journal run backwards and then the uploaded slots
 * emptied. An EDID request is listed, not undone: there is no previous one
 * to go back to.
 */

import {
  readLibrary, readSets, readFrames, nextSlots, framesOn, frameWrites, autocropWrites, customWrites,
  presetWrites, frameStatusPath, presetBackgroundStatus, libraryDeleteWrites, edidWrites, activePlug
} from './mng.js';
import { MNG } from '../../src/core/dialect.js';
import { until, send, sendAndEcho, sleep, ECHO_MS, IMPORT_MS } from './wire.js';

export const UPLOAD_URL = '/api/device/images/upload';

/**
 * Upload one image and find where the switcher put it. Resolves `{ status,
 * slot, entry }`: the import status the server answered, and the library
 * slot that was empty before and now holds a file of this name (null if
 * none appeared).
 */
export async function uploadToNextSlot({ session, fetchImpl = fetch, blob, name }) {
  const { store } = session;
  const before = new Set(readLibrary(store).slots.filter((s) => !s.free).map((s) => s.slot));
  const form = new FormData();
  form.append('FILES', blob, name);
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetchImpl(UPLOAD_URL, { method: 'POST', body: form });
    /* 503: another upload is running (the server takes one at a time). */
    if (res.status !== 503) break;
    await sleep(1500);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`the switcher refused the upload: ${res.status}${text ? ` ${text.slice(0, 120)}` : ''}`);
  }
  let answer = null;
  try { answer = await res.json(); } catch { answer = null; }
  const status = answer && typeof answer === 'object' ? String(answer[name] ?? Object.values(answer)[0] ?? '') : '';
  const fresh = () => readLibrary(store).slots.find((s) => !s.free && !before.has(s.slot) && s.fileName === name) || null;
  /* A refused import fills nothing, so it is not waited for long. */
  await until(store, () => !!fresh(), /^FINISH/.test(status) ? IMPORT_MS : 1500);
  const entry = fresh();
  return { status, slot: entry ? entry.slot : null, entry };
}

/** A store path as a few words for the progress list: `S2 BKG1 librarySlot`. */
export function describePath(path) {
  const words = [];
  for (let i = 1; i < path.length; i++) {
    const seg = path[i];
    const next = path[i + 2];
    if (path[i + 1] === 'items' && next !== undefined) {
      const label = { screenList: `S${next}`, backFrameList: `BKG${next}`, backgroundSetList: `set ${next}`, outputList: `Out ${next}`, presetList: `preset ${next}`, bankList: `slot ${next}`, inputList: next }[seg];
      words.push(label || `${seg} ${next}`);
      i += 2;
      continue;
    }
    if (['control', 'pp', 'cmd', 'status', 'source'].includes(seg)) continue;
    words.push(seg);
  }
  return words.join(' ');
}

/**
 * Put a Midra or Alta plan on the switcher. Same contract as
 * `apply.applyPlan`: `images` maps `<screen>/canvas` to `{ blob, name }`
 * (stills), `options` are `label`, `loadPreview`, `edids`, `allowProgram`;
 * resolves `{ ok, journal, error? }`.
 */
export async function applyMngPlan({ session, plan, images = new Map(), options = {}, fetchImpl = fetch, onStep = () => {} }) {
  const { store } = session;
  const journal = { platform: 'mng', uploads: [], writes: [], edids: [] };
  const step = (text, state = 'done') => onStep(text, state);
  /* Journalled before it is sent: a write asked for and not confirmed may
     still have landed, and putting back what was there is harmless if not. */
  const write = async (writes, failure) => {
    if (!writes.length) return;
    journal.writes.push(...writes);
    if (!(await sendAndEcho(session, writes, { inbound: true }))) throw new Error(`${failure} — the switcher did not echo it`);
  };
  try {
    if (!plan.ok) throw new Error(plan.problems[0] || 'the plan is not complete');
    preflight(store, plan, options, images);

    if (plan.source === 'stills') {
      for (const s of plan.screens) {
        const row = s.outputs[0];
        const img = images.get(`${s.id}/${row.key}`);
        if (!img) throw new Error(`no image was generated for ${s.id}`);
        /* Checked again at the moment it matters: an upload goes wherever the
           first empty slot is now, and shows on every frame pointing there. */
        const [expect] = nextSlots(readLibrary(store), 1);
        if (expect !== row.librarySlot) throw new Error(`the first empty library slot is now ${expect ?? 'none'}, not ${row.librarySlot} — plan again`);
        const on = framesOn(store, expect);
        if (on.length) throw new Error(`${on.map((f) => f.name).join(', ')} now point${on.length === 1 ? 's' : ''} at slot ${expect} — refused`);

        step(`Uploading ${img.name} → the first empty library slot (${expect})`, 'running');
        const up = await uploadToNextSlot({ session, fetchImpl, blob: img.blob, name: img.name });
        if (up.slot != null) journal.uploads.push(up.slot);
        if (up.status !== 'FINISH') {
          throw new Error(up.status === 'FINISH_WITH_DOWNSCALE'
            ? `the switcher downscaled ${img.name} on the way in, so it is no longer a pixel copy${up.slot != null ? ` (slot ${up.slot})` : ''}`
            : `the switcher did not import ${img.name}: ${up.status || 'no answer'}`);
        }
        if (up.slot == null) throw new Error(`no library slot reported ${img.name} after the import finished`);
        if (up.slot !== expect) throw new Error(`${img.name} went into library slot ${up.slot}, not ${expect} — another upload ran at the same time`);
        if (up.entry.width !== row.raster.width || up.entry.height !== row.raster.height) {
          throw new Error(`library slot ${up.slot} holds ${up.entry.width} × ${up.entry.height}, not ${row.raster.width} × ${row.raster.height}`);
        }
        step(`${img.name} is in library slot ${up.slot}, ${up.entry.width} × ${up.entry.height}`);

        const label = (options.label || `${s.id} background`).slice(0, 16);
        await write(frameWrites(store, s.id, row.frame, up.slot, label), `${s.id} Background Image ${row.frame} did not take library slot ${up.slot}`);
        const W = row.raster.width;
        const H = row.raster.height;
        const reads = (p) => store.get(frameStatusPath(s.id, row.frame, p));
        const shown = await until(store, () => reads('isValid') === true && reads('width') === W && reads('height') === H, ECHO_MS);
        if (!shown) throw new Error(`${s.id} Background Image ${row.frame} reports ${reads('width')} × ${reads('height')}, not the ${W} × ${H} canvas — it is not shown 1:1`);
        step(`${s.id} Background Image ${row.frame} shows slot ${up.slot} at 1:1 — the switcher reports ${W} × ${H}`);
      }
    } else if (options.edids) {
      for (const s of plan.screens) {
        for (const o of s.outputs) {
          if (!o.edid || !o.edid.kind) continue;
          const plug = activePlug(store, o.input);
          send(session, edidWrites(o.input, o.edid, plug));
          journal.edids.push({ input: o.input, plug, edid: o.edid.key });
          step(`${o.input} plug ${plug} asked for the ${o.edid.label} EDID`);
        }
      }
    }

    for (const s of plan.screens) {
      if (!s.assign) continue;
      if (plan.source === 'stills') {
        const row = s.outputs[0];
        await write(autocropWrites(store, s.id, s.setIndex, row.frame), `${s.id} set ${s.setIndex} did not take ${row.content}`);
        step(`${s.id} background set ${s.setIndex}: Auto Crop ← ${row.content}`);
      } else {
        const inputs = Object.fromEntries(s.outputs.map((o) => [o.key, o.content]));
        await write(customWrites(store, s.id, s.setIndex, inputs), `${s.id} set ${s.setIndex} did not take its inputs`);
        step(`${s.id} background set ${s.setIndex}: Custom ← ${s.outputs.map((o) => `${o.name} ${o.content}`).join(', ')}`);
      }
    }

    if (options.loadPreview) {
      for (const s of plan.screens) {
        if (!s.assign) continue;
        if (!s.display.ok) { step(`${s.id}: not loaded — ${s.display.why}`, 'note'); continue; }
        const banks = MNG.buffers(store, s.id);
        if (!banks.reported || !banks.settled) { step(`${s.id}: not loaded — a take is under way`, 'note'); continue; }
        const writes = presetWrites(store, s.id, banks.preview, s.setIndex);
        await write(writes, `${s.id} preview did not load set ${s.setIndex}`);
        step(`${s.id} preview (${banks.preview}) shows background set ${s.setIndex}`);
        if (plan.source === 'stills') {
          /* The switcher's own account of the layer: an Auto Crop set reports
             the canvas as its content size (seen on the simulator). A note,
             not a failure — what hardware reports here is not yet known. */
          const size = (p) => store.get(presetBackgroundStatus(s.id, banks.preview, p));
          const sized = await until(store, () => size('contentWidth') === s.canvas.width && size('contentHeight') === s.canvas.height, 1500);
          if (!sized) step(`${s.id} preview’s background layer reports ${size('contentWidth')} × ${size('contentHeight')}, not the ${s.canvas.width} × ${s.canvas.height} canvas`, 'note');
        }
      }
    }
    return { ok: true, journal };
  } catch (err) {
    step(err.message, 'failed');
    return { ok: false, journal, error: err.message };
  }
}

/**
 * Re-read the switcher just before writing — minutes may have passed: the
 * sets and Background Images the plan chose must still be what they were,
 * the library's next slots the ones predicted, and no frame pointing at
 * them; and every image must be one the library takes.
 */
function preflight(store, plan, options, images) {
  const library = readLibrary(store);
  for (const s of plan.screens) {
    const sets = readSets(store, s.id);
    if (s.assign) {
      const set = sets.find((x) => x.index === s.setIndex);
      if (!set) throw new Error(`${s.id} has no background set ${s.setIndex}`);
      if (set.onProgram && !options.allowProgram) throw new Error(`${s.id} background set ${s.setIndex} is on program`);
    }
    if (plan.source !== 'stills') continue;
    const row = s.outputs[0];
    const frame = readFrames(store, s.id, sets).find((f) => f.index === row.frame);
    if (!frame) throw new Error(`${s.id} has no Background Image ${row.frame}`);
    if (s.frame && s.frame.free && !frame.free) throw new Error(`${s.id} Background Image ${row.frame} is no longer free — plan again`);
    if (frame.onAir && !options.allowProgram) throw new Error(`${s.id} Background Image ${row.frame} is in a set on program`);
    const img = images.get(`${s.id}/${row.key}`);
    if (img && img.blob && img.blob.size > library.limits.maxBytes) {
      throw new Error(`${img.name} is ${Math.round(img.blob.size / 1048576)} MB; the library takes ${Math.round(library.limits.maxBytes / 1048576)} MB a file`);
    }
  }
  if (plan.source === 'stills') {
    const want = plan.screens.map((s) => s.outputs[0].librarySlot);
    const now = nextSlots(library, want.length);
    if (want.some((slot, i) => slot !== now[i])) throw new Error(`the library’s first empty slots are now ${now.join(', ') || 'none'}, not ${want.join(', ')} — plan again`);
    for (const slot of want) {
      const on = framesOn(store, slot);
      if (on.length) throw new Error(`${on.map((f) => f.name).join(', ')} point${on.length === 1 ? 's' : ''} at slot ${slot} — refused`);
    }
  }
}

/**
 * Take back exactly what a journal says was written, newest first, then
 * empty the library slots it uploaded into — after the frames that showed
 * them are pointed back where they were.
 */
export async function revertMng({ session, journal, onStep = () => {} }) {
  const { store } = session;
  const problems = [];
  const step = (text, state = 'done') => onStep(text, state);
  for (const w of [...journal.writes].reverse()) {
    if (w.before === undefined) { problems.push(`${describePath(w.path)}: nothing to put back`); continue; }
    if (!(await sendAndEcho(session, [{ path: w.path, value: w.before }], { inbound: true }))) problems.push(describePath(w.path));
    else step(`${describePath(w.path)} back to ${w.before === '' ? '“”' : w.before}`);
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
  for (const e of journal.edids) step(`${e.input} plug ${e.plug} still asks for the ${e.edid} EDID — reset it from Inputs ▸ EDID if it should not`, 'note');
  return { ok: problems.length === 0, problems };
}
