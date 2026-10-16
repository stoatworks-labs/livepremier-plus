/*
 * The image library and the stills: reading them, and the writes that fill
 * a still from the library.
 *
 * Written for the Background Slicer and moved here when the UMD generator
 * needed the same reading and the same writes — a plugin may not import
 * another's folder (AGENTS.md), and two copies of "what makes a still free"
 * would be fixed one at a time. Read off the 6.2.73 Web RCS bundle and proved
 * on the LivePremier Simulator 6.2.73 (2026-10-06); the Background Slicer's
 * docs (`docs/BACKGROUNDS.md`) say how.
 *
 * - **A library slot is a file**, `stillList/library/bankList/<slot>`, 1-based:
 *   the uploaded picture at the size it was uploaded. **A still is a frame
 *   store** a layer can take as a source (`STILL_<n>`), filled from a library
 *   slot by `mode` IMAGE and `source` = the slot.
 * - **A still is free** when it is fitted, enabled in the applied preconfig,
 *   holds nothing, and no background set names it and no output claims it.
 * - **The upload is HTTP**, single-flight: `POST /api/device/images/upload`
 *   answers 503 while another runs, and `FINISH` is the only success.
 *
 * LivePremier only: a Midra keeps its pictures elsewhere (`bg-slicer/mng.js`).
 * No DOM; the upload's `fetch` and the session are handed in.
 */

import { ROOT } from './paths.js';
import { until, sleep, IMPORT_MS } from './wire.js';

const pp = (node) => (node && typeof node === 'object' && node.pp) || {};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Eight background sets per screen (manual p.100; the store has 1..8). */
export const SET_COUNT = 8;

export const BG = [ROOT, 'preconfig', 'backgrounds'];
const STILLS = [ROOT, 'stillList'];
const LIBRARY = [ROOT, 'stillList', 'library'];
export const PRE_STILLS = [ROOT, 'preconfig', 'stills'];

/** The eight background sets of a screen: `{ index, label, onProgram, onPreview, contents: {out: content} }`. */
export function readSets(store, screenId) {
  const list = store.get([...BG, 'screenList', 'items', screenId, 'backgroundSetList']) || {};
  const items = list.items || {};
  const out = [];
  for (let n = 1; n <= SET_COUNT; n++) {
    const set = items[String(n)];
    if (!set) continue;
    const st = pp(set.status);
    const contents = {};
    const outs = (set.outputList && set.outputList.items) || {};
    for (const [k, v] of Object.entries(outs)) {
      const c = pp(v && v.control).content;
      if (c && c !== 'NONE') contents[k] = c;
    }
    out.push({
      index: n,
      label: String(pp(set).label || ''),
      onProgram: st.isOnProgram === true,
      onPreview: st.isOnPreview === true,
      contents,
      empty: Object.keys(contents).length === 0 && !pp(set).label
    });
  }
  return out;
}

/** The first set of a screen with no content, no label and not on air; else null. */
export function firstFreeSet(sets) {
  return sets.find((s) => s.empty && !s.onProgram && !s.onPreview) || null;
}

/** Every `STILL_n` any background set of any screen names. */
export function stillsInSets(store) {
  const used = new Set();
  const screens = store.get([...BG, 'screenList', 'items']) || {};
  for (const sid of Object.keys(screens)) {
    for (const set of readSets(store, sid)) {
      for (const c of Object.values(set.contents)) {
        const m = /^STILL_(\d+)$/.exec(c);
        if (m) used.add(m[1]);
      }
    }
  }
  return used;
}

/** The image library: `{ slots: [{ slot, free, fileName, width, height, size }], sizeKB, maxKB, limits }`. */
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
  }).filter((s) => Number.isInteger(s.slot));
  const status = pp(bank.status);
  const limits = pp(store.get([...LIBRARY, 'import', 'status']));
  return {
    slots,
    /* `maxSize` is 972800 on a 6.2.73 simulator: the manual's "950 MB
       limit" (p.126) in KiB, so both are read as kilobytes. */
    sizeKB: num(status.size) || 0,
    maxKB: num(status.maxSize) || 0,
    limits: {
      maxWidth: num(limits.maxWidth) || 16384,
      maxHeight: num(limits.maxHeight) || 8192,
      maxPixels: num(limits.maxTotalPixel) || 39321600,
      maxBytes: num(limits.maxFileSize) || 157286400
    }
  };
}

/**
 * The stills of this frame, with what makes one free to take: fitted
 * (`isAvailable`), holding nothing (`mode` NONE and no valid image), named by
 * no background set and claimed by no output (`preconfig/backgrounds/
 * stillList/<n>/control/pp/useOnOutput`), and enabled in the applied
 * preconfig. `capability` is the applied capacity (`preconfig/stills/current`).
 */
export function readStills(store) {
  const list = store.get(STILLS) || {};
  const items = list.items || {};
  const keys = Array.isArray(list.itemKeys) ? list.itemKeys : Object.keys(items);
  const current = (store.get([...PRE_STILLS, 'current', 'stillList', 'items'])) || {};
  const staged = (store.get([...PRE_STILLS, 'new', 'stillList', 'items'])) || {};
  const bgStills = (store.get([...BG, 'stillList', 'items'])) || {};
  const inSets = stillsInSets(store);
  return keys.filter((k) => /^\d+$/.test(k)).map((k) => {
    const node = items[k] || {};
    const st = pp(node.status);
    const ctl = pp(node.control);
    const pre = pp(current[k] && current[k].status);
    const helper = staged[k] && staged[k].control && staged[k].control.helper;
    const validity = staged[k] && staged[k].status && staged[k].status.helper;
    const claimed = pp(bgStills[k] && bgStills[k].control).useOnOutput;
    const fitted = st.isAvailable === true && pp(node.mapping).isValid !== false;
    const enabled = pre.global ? pre.global === 'USED' : fitted;
    const holding = ctl.mode && ctl.mode !== 'NONE';
    const onOutput = claimed && claimed !== 'NONE' ? String(claimed) : null;
    return {
      key: k,
      label: String(ctl.label || ''),
      device: pp(node.mapping).device ?? null,
      fitted,
      enabled,
      capability: pre.capability || st.capability || null,
      format: pp(helper).format || null,
      formats: Array.isArray(pp(validity).formatValidity) ? pp(validity).formatValidity : [],
      mode: ctl.mode || 'NONE',
      source: ctl.source,
      rescale: ctl.rescale || null,
      inSet: inSets.has(k),
      onOutput,
      onAir: st.isOnProgram === true || st.isOnPreview === true,
      free: fitted && enabled && !holding && st.isValid !== true && st.isUsed !== true && !inSets.has(k) && !onOutput
    };
  });
}

/** Units of still capacity, as the manual counts them (p.99/p.100): DUAL is one slot. */
export const CAPACITY_UNITS = { OFF: 0, DUAL: 1, '4K': 2, 3: 3, '5K': 4, 5: 5, 6: 6, 7: 7, '8K': 8 };

/**
 * The capacity a format probably gives a still, by its size — DUAL up to
 * 1920 × 1200, 4K up to 4096 × 2160, 5K up to 5120 × 2880, else 8K. A guess
 * used only to choose what to ask for: the switcher's own `xCheck` says what
 * the capacity really is, and a change that comes back different is refused
 * (`apply.js`). The odd capacities (3, 5, 6, 7) are never guessed at.
 */
export function likelyCapability(size) {
  const area = size.width * size.height;
  if (area <= 1920 * 1200) return 'DUAL';
  if (area <= 4096 * 2160) return '4K';
  if (area <= 5120 * 2880) return '5K';
  return '8K';
}

/* -------------------------------------------------------- write commands */

/** One property of a still. */
export const stillPath = (still, prop) => [...STILLS, 'items', String(still), 'control', 'pp', prop];
/** Empty a library slot — the bin on the vendor's card. */
export const libraryDeletePath = (slot) => [...LIBRARY, 'bankList', 'items', String(slot), 'control', 'pp', 'xDelete'];

/** A trigger, as Web RCS pulses every `x…` property: false, then true. */
export const pulse = (path) => [{ path, value: false }, { path, value: true }];

/** The longest label a still and a background set take (`label: {max: 16}` in the bundle). */
export const LABEL_MAX = 16;

/**
 * The writes that make a still show a library image at its own size, in the
 * order the Web RCS's image picker sends them — `mode` IMAGE, then `source`
 * (the library slot, 1-based) — then `rescale` NO_RESCALE ("No rescale"; the
 * other choice, "Downscale to capacity", would resample a picture cut to be
 * pixel-exact) and the label.
 */
export function stillWrites(still, slot, label) {
  return [
    { path: stillPath(still, 'mode'), value: 'IMAGE' },
    { path: stillPath(still, 'source'), value: Number(slot) },
    { path: stillPath(still, 'rescale'), value: 'NO_RESCALE' },
    { path: stillPath(still, 'label'), value: String(label || '').slice(0, LABEL_MAX) }
  ];
}

/**
 * Put a still back as it was. Leaving IMAGE, `mode` goes first, so the still
 * never shows the slot it is being pointed back at; returning to IMAGE, the
 * source goes first for the same reason.
 */
export function stillRestoreWrites(still, before) {
  const b = before || {};
  const mode = { path: stillPath(still, 'mode'), value: b.mode || 'NONE' };
  const writes = [];
  if (mode.value !== 'IMAGE') writes.push(mode);
  if (Number.isInteger(b.source)) writes.push({ path: stillPath(still, 'source'), value: b.source });
  if (mode.value === 'IMAGE') writes.push(mode);
  writes.push({ path: stillPath(still, 'rescale'), value: b.rescale || 'SCALE_TO_CAPABILITY' });
  writes.push({ path: stillPath(still, 'label'), value: String(b.label || '') });
  return writes;
}

/** Empty a library slot: the vendor card's bin, pulsed. */
export const libraryDeleteWrites = (slot) => pulse(libraryDeletePath(slot));

/* ------------------------------------------------------------ the upload */

export const UPLOAD_URL = '/api/device/images/upload';

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
