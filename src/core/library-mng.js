/*
 * The image library on a Midra 4K or an Alta 4K — reading it, predicting
 * where an upload lands, and the upload itself.
 *
 * Shared by the Background Slicer and the Timer Image plugin, which is why it
 * lives here rather than in either plugin's folder (a plugin never imports
 * another's). LivePremier's library is `core/stills.js`: it is a different
 * tree, and its upload takes a slot where this one does not.
 *
 * Read off the Midra 4K simulator 3.2.29's Web RCS bundle and its store,
 * checked against Alta 4K 1.3.7's bundle and the real Pulse 4K's store
 * (2026-09-12):
 *
 *   - **Fifty slots**, `stillLibrary/bankList/items/1..50`. A slot holds a
 *     file when `status/pp/isValid` is true; `fileName`, `width`, `height`
 *     and `fileSize` describe it.
 *   - ⚠️ **The upload takes no slot.** `POST /api/device/images/upload` with
 *     the file as `FILES` and nothing else imports it with
 *     `AUTO_SLOT_WITH_DOWNSCALE`: into the lowest slot with `isValid` false,
 *     even one a Background or Foreground Image points at — which then shows
 *     the upload at once. So a writer predicts the slot (`nextSlots`), checks
 *     who points at it (`framesOn`), and reads back where it really went.
 *   - **A slot is emptied by pulsing `control/pp/xDelete`**, the bin on the
 *     vendor's card.
 *   - ⚠️ Never `GET /api/device/images/download/<slot>` for an empty slot on a
 *     Midra simulator: the export never finishes and the route answers 503
 *     until the web server restarts.
 */

import { ROOT } from './paths.js';
import { until, sleep, IMPORT_MS } from './wire.js';

export const LIBRARY = [ROOT, 'stillLibrary'];
export const UPLOAD_URL = '/api/device/images/upload';

const pp = (node) => (node && typeof node === 'object' && node.pp) || {};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The image library: `{ slots: [{ slot, free, used, fileName, width, height,
 * size }], limits }`. There is no size budget in this store, only the
 * per-file limits the import states (`stillLibrary/import/status/pp`).
 */
export function readLibrary(store) {
  const bank = store.get([...LIBRARY, 'bankList']) || {};
  const items = bank.items || {};
  const keys = Array.isArray(bank.itemKeys) ? bank.itemKeys : Object.keys(items);
  const slots = keys.map((k) => {
    const st = pp(items[k] && items[k].status);
    return {
      slot: Number(k),
      free: st.isValid !== true,
      used: st.isUsed === true,
      fileName: String(st.fileName || ''),
      width: num(st.width) || 0,
      height: num(st.height) || 0,
      size: num(st.fileSize) || 0
    };
  }).filter((s) => Number.isInteger(s.slot)).sort((a, b) => a.slot - b.slot);
  const limits = pp(store.get([...LIBRARY, 'import', 'status']));
  return {
    slots,
    sizeKB: 0,
    maxKB: 0,
    limits: {
      maxWidth: num(limits.maxWidth) || 18000,
      maxHeight: num(limits.maxHeight) || 18000,
      maxPixels: num(limits.maxTotalPixel) || 35389440,
      maxBytes: num(limits.maxFileSize) || 26214400
    }
  };
}

/** The slots the next `count` uploads will land in: the first empty ones, in order. */
export function nextSlots(library, count = 1) {
  return library.slots.filter((s) => s.free).slice(0, count).map((s) => s.slot);
}

/**
 * Every frame on the switcher that points at a library slot — Background and
 * Foreground Images of every screen. An upload into that slot shows on each
 * of them at once.
 */
export function framesOn(store, slot) {
  const out = [];
  const screens = store.get([ROOT, 'screenList', 'items']) || {};
  for (const [key, node] of Object.entries(screens)) {
    for (const [list, abbr] of [['backFrameList', 'BKG'], ['topFrameList', 'FRG']]) {
      for (const [k, f] of Object.entries((node && node[list] && node[list].items) || {})) {
        if (String(pp(f && f.control).librarySlot) === String(slot)) out.push({ screen: `S${key}`, list, index: k, name: `S${key} ${abbr}${k}` });
      }
    }
  }
  return out;
}

/** A library slot's status. */
export const librarySlotPath = (slot, prop) => [...LIBRARY, 'bankList', 'items', String(slot), 'status', 'pp', prop];

/** Empty a library slot — the bin on the vendor's card, pulsed. */
export const libraryDeleteWrites = (slot) => {
  const path = [...LIBRARY, 'bankList', 'items', String(slot), 'control', 'pp', 'xDelete'];
  return [{ path, value: false }, { path, value: true }];
};

/**
 * Upload one image and find where the switcher put it. Resolves `{ status,
 * slot, entry }`: the import status the server answered (only `FINISH` is a
 * clean import; `FINISH_WITH_DOWNSCALE` means it was resampled), and the
 * library slot that was empty before and now holds a file of this name (null
 * if none appeared within `importMs`).
 */
export async function uploadToNextSlot({ session, fetchImpl = fetch, blob, name, importMs = IMPORT_MS }) {
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
  await until(store, () => !!fresh(), /^FINISH/.test(status) ? importMs : 1500);
  const entry = fresh();
  return { status, slot: entry ? entry.slot : null, entry };
}
