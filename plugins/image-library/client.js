/*
 * Image Library tools — the plugin's page half.
 *
 * Three things the vendor's pages make slow, done where the operator already
 * is: delete every image in the library, or a selection of them, from the
 * Image Library page; upload a zip of pictures into the free slots, from the
 * same page; and set a still's capacity from its card on the Images page
 * rather than in Preconfig ▸ Images. `core.js` plans, `run.js` writes,
 * `decorate.js` draws; this file holds the one run in hand and its result.
 *
 * Every write asks first, in words, and the questions use the switcher's own
 * answers: what a delete would empty, what a capacity would take out of
 * service. Nothing is written while a page is merely open.
 */

import { readLibrary } from '../../src/core/stills.js';
import { listZip, readEntry } from '../../src/core/zip.js';
import {
  planDelete, deleteQuestion, filledSlots, zipPictures, loosePictures, placeUploads, uploadQuestion,
  capacityView
} from './core.js';
import { deleteSlots, uploadPictures, changeCapacity } from './run.js';
import { installLibraryTools, isZip } from './decorate.js';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', tif: 'image/tiff', tiff: 'image/tiff' };
const mimeOf = (name) => MIME[(/\.([a-z0-9]+)$/i.exec(name) || [])[1]?.toLowerCase()] || 'application/octet-stream';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function activate(ctx, {
  ask = (text) => Promise.resolve(typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(text) : false),
  tell = (text) => { if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(text); },
  fetchImpl = (...a) => fetch(...a),
  doc,
  loc
} = {}) {
  const session = ctx.session;
  const store = session.store;

  /** The run in hand: `{ kind, text, stop }`, or null. */
  let busy = null;
  /** The last run's outcome, until the next: `{ text, tone }`. */
  let result = null;
  /** The still whose capacity is being changed, or null. */
  let capBusy = null;

  const enabled = () => Boolean(store.ready) && ctx.can('imageLibrary');
  const status = () => (busy ? { busy: true, text: busy.text, tone: null } : { busy: false, text: result ? result.text : '', tone: result ? result.tone : null });

  function progress(text) {
    if (busy) busy.text = text;
    tools.refresh();
  }

  function finish(text, tone, details) {
    busy = null;
    result = { text, tone };
    tools.refresh();
    if (details) tell(details);
  }

  /* --------------------------------------------------------------- delete */

  async function del(slots, { all }) {
    if (busy) return false;
    const plan = planDelete(store, slots);
    const q = deleteQuestion(plan, { all });
    if (!q.text) { finish(q.why, 'warn'); return false; }
    if (!(await ask(q.text))) return false;
    busy = { kind: 'delete', text: 'Deleting…', stop: false };
    tools.refresh();
    const res = await deleteSlots({
      session,
      slots: plan.remove,
      stopped: () => busy && busy.stop,
      onStep: (done, total) => progress(`Deleting ${Math.min(done + 1, total)} of ${total}…`)
    });
    const parts = [`Deleted ${plural(res.deleted.length, 'image')}`];
    const kept = [...plan.kept, ...res.kept];
    if (kept.length) parts.push(`kept ${kept.length} on a bus`);
    if (res.failed.length) parts.push(`${res.failed.length} not deleted`);
    if (res.stopped) parts.push('stopped');
    const tone = res.failed.length || res.stopped ? 'warn' : 'ok';
    const details = res.failed.length
      ? `Not deleted: ${res.failed.map((f) => `slot ${f.slot} — ${f.why}`).join('; ')}.`
      : null;
    finish(`${parts.join(', ')}.`, tone, details);
    return true;
  }

  /* --------------------------------------------------------------- upload */

  async function upload(files) {
    if (busy) return false;
    busy = { kind: 'upload', text: 'Reading…', stop: false };
    tools.refresh();
    const lib = readLibrary(store);
    const limits = { types: lib.limits.types, maxBytes: lib.limits.maxBytes };
    const items = [];
    const skipped = [];
    const loose = [];
    for (const file of files) {
      if (!isZip(file)) { loose.push(file); continue; }
      let bytes;
      let entries;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
        entries = listZip(bytes);
      } catch (err) {
        skipped.push({ name: file.name, why: `not a zip this can read (${err.message})` });
        continue;
      }
      const { take, skipped: passed } = zipPictures(entries, limits);
      skipped.push(...passed);
      for (const t of take) {
        items.push({
          name: t.name,
          size: t.size,
          read: async () => new Blob([await readEntry(bytes, t.entry)], { type: mimeOf(t.name) })
        });
      }
    }
    const looseTaken = loosePictures(loose, limits);
    skipped.push(...looseTaken.skipped);
    for (const f of looseTaken.take) items.push({ name: f.name, size: f.size, blob: f });

    const { placed, noRoom } = placeUploads(store, items);
    const q = uploadQuestion({ placed, noRoom, skipped });
    if (!placed.length) {
      finish(items.length ? 'Nothing uploaded: the library is full.' : 'Nothing uploaded: no pictures the switcher takes.', 'warn', q);
      return false;
    }
    if (q && !(await ask(q))) { busy = null; tools.refresh(); return false; }
    const res = await uploadPictures({
      session,
      fetchImpl,
      items: placed.map((p) => ({ slot: p.slot, name: p.file.name, blob: p.file.blob, read: p.file.read })),
      stopped: () => busy && busy.stop,
      onStep: (done, total, name) => progress(name ? `Uploading ${done + 1} of ${total}: ${name}` : `Uploaded ${done} of ${total}`)
    });
    const parts = [`Uploaded ${plural(res.uploaded.length, 'picture')}`];
    if (res.failed.length) parts.push(`${res.failed.length} refused`);
    if (skipped.length + noRoom.length) parts.push(`${skipped.length + noRoom.length} passed over`);
    if (res.stopped) parts.push('stopped');
    const tone = res.failed.length || res.stopped ? 'warn' : 'ok';
    const details = res.failed.length
      ? `Not uploaded: ${res.failed.slice(0, 10).map((f) => `${f.name} — ${f.why}`).join('; ')}${res.failed.length > 10 ? ` … and ${res.failed.length - 10} more` : ''}.`
      : null;
    finish(`${parts.join(', ')}.`, tone, details);
    return true;
  }

  /* ------------------------------------------------------------- capacity */

  async function setCapacity(key, to) {
    if (capBusy) return;
    capBusy = key;
    tools.refresh();
    try {
      const res = await changeCapacity({ session, still: key, to, ask });
      /* The shared capacity routine says "still 2"; this page says "Image 2". */
      if (!res.ok) tell(`Image ${key}: ${String(res.error).replace(/\bstills? (\d+)/g, 'Image $1')}`);
    } finally {
      capBusy = null;
      tools.refresh();
    }
  }

  const tools = installLibraryTools({
    enabled,
    doc: doc || (typeof document !== 'undefined' ? document : undefined),
    loc: loc || (typeof location !== 'undefined' ? location : { pathname: '/' }),
    actions: {
      filled: () => (store.ready ? filledSlots(store) : []),
      status,
      deleteSlots: del,
      upload,
      stop: () => { if (busy) { busy.stop = true; busy.text = `${busy.text} stopping…`; tools.refresh(); } },
      capacity: (key) => (store.ready ? capacityView(store, key) : null),
      capacityBusy: () => capBusy,
      setCapacity
    }
  });

  /* The switcher's own changes — a slot filled from another tab, a still
     put on air, a capacity applied elsewhere — repaint what is drawn. */
  ctx.session.addEventListener('frame', () => tools.refresh());
  if (store.addEventListener) store.addEventListener('ready', () => tools.refresh());

  return { tools };
}
