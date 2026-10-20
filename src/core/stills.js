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
 * - **A library delete empties every still showing it** (`mode` stays IMAGE,
 *   `isValid` goes false and the picture goes) — seen on the 6.2.73
 *   simulator, 2026-10-20. So a delete is a write to whatever those stills
 *   are on, and Image Library tools keeps the ones on a bus. (Twice a still
 *   emptied like this reported its old picture again after a later upload;
 *   it would not happen a third time — `docs/NOTES.md`, 2026-10-20.)
 * - **A still's capacity is preconfig**, staged and checked before it is
 *   applied (`stageCapacities`). The capacity routine was the Background
 *   Slicer's and moved here when Image Library tools needed it too.
 *
 * LivePremier only: a Midra keeps its pictures elsewhere (`bg-slicer/mng.js`).
 * No DOM; the upload's `fetch` and the session are handed in.
 */

import { ROOT } from './paths.js';
import { until, sleep, send, sendAndEcho, ECHO_MS, IMPORT_MS } from './wire.js';

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

/** The image library: `{ slots: [{ slot, free, used, fileName, width, height, size, capability }], sizeKB, maxKB, limits }`. */
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
      size: num(st.fileSize) || 0,
      /* The capacity the picture needs, in the switcher's words. */
      capability: st.capability || null
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
      maxBytes: num(limits.maxFileSize) || 157286400,
      /* The file types it imports, lower case: JPEG, JPG, PNG, GIF, TIFF and
         TIF on the 6.2.73 simulator. */
      types: (Array.isArray(limits.fileTypeValidity) && limits.fileTypeValidity.length
        ? limits.fileTypeValidity : ['PNG', 'JPG', 'JPEG']).map((t) => String(t).toLowerCase())
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
      onProgram: st.isOnProgram === true,
      onPreview: st.isOnPreview === true,
      /* Out of service in the applied preconfig: a larger capacity beside it
         has its memory. Fitted stills only — an unfitted one was never in. */
      outOfService: fitted && pre.global === 'DISABLE',
      outOfCapacity: st.outOfCapability === true,
      free: fitted && enabled && !holding && st.isValid !== true && st.isUsed !== true && !inSets.has(k) && !onOutput
    };
  });
}

/**
 * Which stills show each library slot: `Map(slot → [still])`, the stills as
 * `readStills` gives them. A still shows a slot when its `mode` is IMAGE and
 * its `source` is the slot — whether or not the picture is there now.
 */
export function libraryUsers(store) {
  const users = new Map();
  for (const s of readStills(store)) {
    if (s.mode !== 'IMAGE' || !Number.isInteger(s.source)) continue;
    if (!users.has(s.source)) users.set(s.source, []);
    users.get(s.source).push(s);
  }
  return users;
}

/** How the vendor's Images page names a still: `Image 3`, and its label when it has one. */
export function stillName(still) {
  const label = String((still && still.label) || '').trim();
  return label ? `Image ${still.key} “${label}”` : `Image ${still.key}`;
}

/**
 * The stills on a bus: `Map(key → 'program' | 'preview')`. The still's own
 * tally first, and then any still a background set on program or preview
 * names — the set is what puts it there, whatever the still's tally says.
 */
export function stillsOnBus(store, stills = readStills(store)) {
  const out = new Map();
  for (const s of stills) {
    if (s.onProgram) out.set(s.key, 'program');
    else if (s.onPreview) out.set(s.key, 'preview');
  }
  const screens = store.get([...BG, 'screenList', 'items']) || {};
  for (const sid of Object.keys(screens)) {
    for (const set of readSets(store, sid)) {
      if (!set.onProgram && !set.onPreview) continue;
      for (const c of Object.values(set.contents)) {
        const m = /^STILL_(\d+)$/.exec(c);
        if (!m) continue;
        if (set.onProgram) out.set(m[1], 'program');
        else if (!out.has(m[1])) out.set(m[1], 'preview');
      }
    }
  }
  return out;
}

/**
 * The empty library slots, each with the stills that point at it:
 * `[{ slot, stills: [{ key, label, name, bus }] }]` in slot order, `bus`
 * `'program'`, `'preview'` or null. A clean slot has no stills.
 *
 * ⚠️ **An empty slot is not always unclaimed.** A still keeps pointing at a
 * slot after its picture is deleted, and a picture uploaded into that slot
 * shows on the still at once — seen on the 6.2.73 simulator, 2026-10-20,
 * when a zip refilled slot 3 and Image 1 took the new picture up. So an
 * upload only uses such a slot when the operator has said it may
 * (`uploadSlots`), and says which stills will show the picture.
 */
export function emptySlots(store) {
  const stills = readStills(store);
  const users = libraryUsers(store);
  const bus = stillsOnBus(store, stills);
  return readLibrary(store).slots
    .filter((s) => s.free)
    .sort((a, b) => a.slot - b.slot)
    .map((s) => ({
      slot: s.slot,
      stills: (users.get(s.slot) || []).map((x) => ({ key: x.key, label: x.label, name: stillName(x), bus: bus.get(x.key) || null }))
    }));
}

const BUS_RANK = { null: 0, preview: 1, program: 2 };
const busOf = (entry) => entry.stills.reduce((worst, s) => (BUS_RANK[s.bus] > BUS_RANK[worst] ? s.bus : worst), null);

/**
 * The order an upload takes empty slots in (`emptySlots` entries): every
 * clean slot first; then, only with `assigned`, the slots a still points at
 * — those whose stills are on no bus first, then preview, then program.
 * Without `assigned` a slot a still points at is never offered.
 */
export function orderSlots(empty, { assigned = false } = {}) {
  const clean = empty.filter((e) => !e.stills.length);
  if (!assigned) return clean;
  const pointed = empty.filter((e) => e.stills.length)
    .sort((a, b) => BUS_RANK[busOf(a)] - BUS_RANK[busOf(b)] || a.slot - b.slot);
  return [...clean, ...pointed];
}

/** The empty slots an upload may use, in order: `orderSlots(emptySlots(store), opts)`. */
export const uploadSlots = (store, opts = {}) => orderSlots(emptySlots(store), opts);

/**
 * What putting a picture into a slot stills point at does, in a sentence's
 * tail: `Image 1 points at it and will show the picture`, louder for a still
 * on a bus. Empty for a clean slot.
 */
export function pointedText(stills) {
  if (!stills || !stills.length) return '';
  const names = stills.map((s) => s.name || stillName(s));
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const verb = names.length === 1 ? 'points' : 'point';
  const onProgram = stills.filter((s) => s.bus === 'program').map((s) => s.name || stillName(s));
  const onPreview = stills.filter((s) => s.bus === 'preview').map((s) => s.name || stillName(s));
  if (onProgram.length) return `${who} ${verb} at it, and ${onProgram.join(', ')} ${onProgram.length === 1 ? 'is' : 'are'} ON PROGRAM: the picture goes on air the moment it lands`;
  if (onPreview.length) return `${who} ${verb} at it, and ${onPreview.join(', ')} ${onPreview.length === 1 ? 'is' : 'are'} on preview: the picture shows there the moment it lands`;
  return `${who} ${verb} at it and will show the picture`;
}

/** Units of still capacity, as the manual counts them (p.99/p.100): DUAL is one slot. */
export const CAPACITY_UNITS = { OFF: 0, DUAL: 1, '4K': 2, 3: 3, '5K': 4, 5: 5, 6: 6, 7: 7, '8K': 8 };

/**
 * The format that is each capacity beyond doubt: what to give a still's
 * capacity helper to ask for that capacity. Each was put through the
 * switcher's own check on the LivePremier Simulator 6.2.73 (Aquilon Cmax,
 * 2026-10-20): 1080p is Dual, UHD 2160p is 4K and takes the next still out of
 * service, 5120 × 2880 is 5K and takes the next three. 8K is missing because
 * not even the largest formats the helper offers came back as 8K there —
 * 16384 × 1080 and 8192 × 2160 both checked as 5K (custom formats untried).
 */
export const CAPACITY_FORMAT = { DUAL: 'HDTV_1080P', '4K': 'UHDTV_2160P', '5K': 'COMPUTER_5120_2880_RB' };

/**
 * The capacities a still can be asked for: those whose format its helper
 * offers (`formats`, from `readStills`), smallest first —
 * `[{ capability, units, format }]`.
 */
export function capacityChoices(formats) {
  const offered = new Set(Array.isArray(formats) ? formats : []);
  return Object.entries(CAPACITY_FORMAT)
    .filter(([, format]) => offered.has(format))
    .map(([capability, format]) => ({ capability, units: CAPACITY_UNITS[capability], format }));
}

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
 * pixel-exact) and the label. `rescale` is SCALE_TO_CAPABILITY only for a
 * picture made at a size of the operator's choosing that may be larger than
 * the still holds (`deck.js`).
 */
export function stillWrites(still, slot, label, rescale = 'NO_RESCALE') {
  return [
    { path: stillPath(still, 'mode'), value: 'IMAGE' },
    { path: stillPath(still, 'source'), value: Number(slot) },
    { path: stillPath(still, 'rescale'), value: rescale },
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

/** The staged still-capacity preconfig, and the applied one. */
export const preStillsNew = (...tail) => [...PRE_STILLS, 'new', ...tail];
export const preStillsCurrent = (...tail) => [...PRE_STILLS, 'current', ...tail];
/** A still's capacity helper format, staged in `preconfig/stills/new`. */
export const stillFormatPath = (still) => preStillsNew('stillList', 'items', String(still), 'control', 'helper', 'pp', 'format');
/** The staged side's own triggers: `xCopyFromCurrent`, `xCheck`, `xApply`. */
export const preStillsTrigger = (name) => preStillsNew('control', 'pp', name);

/* ------------------------------------------------------ the capacities */

const PRECONFIG_MS = 20000;
/** Only the switcher's own echo counts (`wire.js`). */
const HEARD = { inbound: true };

/**
 * Stage still-capacity changes and have the switcher check them, as
 * Preconfig ▸ Images does — the helper format per still, an `xCheck` pulse,
 * the verdict in `new/…/status` — and stop there, so the caller can show the
 * verdict before anything is applied. `changes` is `[{ still, format, to,
 * from?, before? }]`.
 *
 * Refuses (throws, with the staged side put back) when Preconfig ▸ Images
 * already has changes staged — somebody is half way through editing it —
 * when the check says error, when a still would come out a capacity other
 * than `to`, or when the change would take a still out of service that holds
 * something (or is in `reserved`, about to).
 *
 * Resolves `{ before, lost, regained, commit, discard }`: `lost` and
 * `regained` are the still keys the change takes out of service and gives
 * back, in the switcher's own words; `commit()` applies and resolves `before`
 * (the formats it replaced, for undo); `discard()` puts the staged side back.
 */
export async function stageCapacities({ session, changes, reserved = new Set() }) {
  const { store } = session;
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
  const stagedGlobal = (key) => pp(staged[key] && staged[key].status).global;
  const lost = stills.filter((s) => s.enabled && stagedGlobal(s.key) === 'DISABLE');
  const regained = stills.filter((s) => s.fitted && !s.enabled && stagedGlobal(s.key) === 'USED');
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

  async function commit() {
    /* Applied when `current` says so — a status only the switcher writes,
       and a stronger word than the trigger's echo. */
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

  return { before, lost: lost.map((s) => s.key), regained: regained.map((s) => s.key), commit, discard };
}

/**
 * The still-capacity changes, staged, checked and applied in one go — the
 * Background Slicer's way, which has already shown its plan. Refuses as
 * `stageCapacities` does, before applying anything. Returns the formats it
 * replaced, for undo.
 */
export async function applyCapacities({ session, changes, log = () => {}, reserved = new Set() }) {
  if (!changes.length) return [];
  const staged = await stageCapacities({ session, changes, reserved });
  if (staged.lost.length) log(`the switcher takes ${staged.lost.join(', ')} out of service for the larger capacity (all empty)`);
  return staged.commit();
}

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
