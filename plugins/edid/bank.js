/*
 * The EDID bank and the custom format library, as the store has them — and
 * what a write to the bank looks like. No DOM, no I/O: both halves of the
 * plugin and the tests import it.
 *
 * Everything here was read off a LivePremier Simulator 6.2.73 (2026-09-23) by
 * driving the vendor's own EDID and Formats pages and recording what they sent.
 *
 * ## The bank
 *
 * `device/system/edid/bankList/items/<1..100>` — a hundred slots, shown as ED1
 * to ED100. Each `status/pp` carries `isAvailable` (holds an EDID),
 * `isProtected`, `productName` (the EDID's own name descriptor, which is what
 * the card shows), `dataSize` ("128" … "512") and `data`: always 512 numbers,
 * the EDID and then 0xFF padding. The same list also has `DEFAULT_*` keys —
 * the vendor's Default EDIDS — which are not slots.
 *
 * ## Writing a slot is HTTP, not the socket
 *
 * The vendor's upload does not go over the socket. It is
 *
 *   POST /api/device/edid/save
 *   { data: [512 numbers], dataSize: "256",
 *     edidId: { type: "EDID_BANK_SLOT", keys: { bankxEdidBankSlotKey: "7" } } }
 *
 * answered `200 OK`, and the slot's new status then arrives on the socket like
 * any other change. `dataSize` is the EDID's own length as a string; the
 * simulator took 128, 256, 384 and 512. Padding is 0xFF, as the vendor pads.
 * The proxy relays `/api/…` to the switcher untouched, so the page posts it
 * exactly as Web RCS does, and there is no second client on the box.
 *
 * Emptying a slot IS the socket: `…/bankList/items/<n>/control/pp/xDelete`
 * true — the bin on the vendor's card.
 *
 * ## The custom format library
 *
 * `device/customFormats/bankList/items/<1..16>` — the Formats page's M1..M16.
 * `status/pp` is the format as the device resolved it: `hUtil`/`vUtil` (active),
 * `hFrontPorch`, `hSync`, `hBackPorch`, `vFrontPorch`, `vSync`, **`vBackporch`**
 * (lower-case p, unlike its neighbours), `hSyncPol`/`vSyncPol` (true is
 * positive — the 1080p60 template loads as true/true, and CTA 1080p60 is +/+),
 * `rate` in **millihertz** (60000, 59940), `baseName` and `isValid`; the
 * label typed on the Formats page is `control/pp/userName`. There is no pixel
 * clock in a bank entry, so it is worked out from the totals and the rate —
 * exactly how the Formats page's own help defines it.
 */

export const SLOTS = 100;
export const SAVE_URL = '/api/device/edid/save';
const SIZES = [128, 256, 384, 512];

const BANK = ['device', 'system', 'edid', 'bankList', 'items'];
const FORMATS = ['device', 'customFormats', 'bankList', 'items'];

const pp = (node) => (node && node.status && node.status.pp) || null;

/**
 * The hundred slots in bank order: `{ id, label, name, empty, locked, bytes }`.
 * `bytes` is the EDID without its padding, or null for an empty slot. This is
 * also the shape the Otter editor's host panel asks for (`HostSlot`).
 */
export function readSlots(store) {
  const items = (store && store.get(BANK)) || {};
  const out = [];
  for (let n = 1; n <= SLOTS; n++) {
    const s = pp(items[String(n)]);
    if (!s) continue;
    const empty = !s.isAvailable;
    const size = Number(s.dataSize) || 0;
    out.push({
      id: String(n),
      label: `ED${n}`,
      name: empty ? '' : String(s.productName || ''),
      empty,
      locked: !!s.isProtected,
      mode: empty ? '' : String(s.prefFormatName || ''),
      bytes: empty || !Array.isArray(s.data) ? null : Uint8Array.from(s.data.slice(0, size || s.data.length))
    });
  }
  return out;
}

/**
 * The valid custom formats, M1..M16: `{ index, key, label, name, timing }`,
 * `timing` in the shape Otter's `Timing` is.
 */
export function readFormats(store) {
  const items = (store && store.get(FORMATS)) || {};
  const out = [];
  for (const key of Object.keys(items)) {
    const s = pp(items[key]);
    const timing = s && s.isValid ? formatTiming(s) : null;
    if (!timing) continue;
    const control = (items[key].control && items[key].control.pp) || {};
    out.push({
      index: Number(key),
      key,
      label: `M${key}`,
      /* The label somebody typed is on `control`; the status only has the
         device's own description, "1920x1080 60Hz". */
      name: String(control.userName || s.baseName || ''),
      timing
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** One custom format's resolved timing, or null when it does not add up. */
export function formatTiming(s) {
  const t = {
    hActive: s.hUtil, hFront: s.hFrontPorch, hSync: s.hSync, hBack: s.hBackPorch,
    vActive: s.vUtil, vFront: s.vFrontPorch, vSync: s.vSync, vBack: s.vBackporch,
    interlaced: false,
    hSyncPositive: !!s.hSyncPol,
    vSyncPositive: !!s.vSyncPol
  };
  const numbers = ['hActive', 'hFront', 'hSync', 'hBack', 'vActive', 'vFront', 'vSync', 'vBack'];
  if (!numbers.every((k) => Number.isInteger(t[k]) && t[k] >= 0) || !(s.rate > 0)) return null;
  if (!t.hActive || !t.vActive || !t.hSync || !t.vSync) return null;
  const hTotal = t.hActive + t.hFront + t.hSync + t.hBack;
  const vTotal = t.vActive + t.vFront + t.vSync + t.vBack;
  /* 59940 mHz is the device's rounding of 60000/1001; the clock follows the
     rate the device states, and Otter's VIC match allows for the difference. */
  t.pixelClockHz = Math.round((hTotal * vTotal * s.rate) / 1000);
  return t;
}

/**
 * The name an EDID built from a custom format carries: the format's own label
 * when it fits the 13-character name descriptor, else M<n> and the mode.
 * It is what the bank card will show, so it should say where it came from.
 */
export function formatEdidName(format, modeLabel) {
  const own = format.name.trim();
  if (own && own.length <= 13) return own;
  const short = `${format.label} ${modeLabel}`;
  return short.length <= 13 ? short : format.label;
}

/** The body of `POST /api/device/edid/save` for one slot. Throws on an EDID the bank cannot hold. */
export function savePayload(slotId, bytes) {
  const n = Number(slotId);
  if (!Number.isInteger(n) || n < 1 || n > SLOTS) throw new Error(`there is no EDID bank slot ${slotId}`);
  const len = bytes ? bytes.length : 0;
  if (!SIZES.includes(len)) {
    throw new Error(`an EDID of ${len} bytes will not fit a bank slot — it takes 128, 256, 384 or 512`);
  }
  const data = new Array(512).fill(0xff);
  for (let i = 0; i < len; i++) data[i] = bytes[i];
  return {
    data,
    dataSize: String(len),
    edidId: { type: 'EDID_BANK_SLOT', keys: { bankxEdidBankSlotKey: String(n) } }
  };
}

/** The socket write that empties a slot — the vendor card's bin. */
export function deleteCommand(slotId) {
  return { path: [...BANK, String(slotId), 'control', 'pp', 'xDelete'], value: true };
}

/** The slot already holding exactly these bytes, or null. */
export function slotHolding(slots, bytes) {
  if (!bytes) return null;
  return slots.find((s) => s.bytes && s.bytes.length === bytes.length && s.bytes.every((b, i) => b === bytes[i])) || null;
}

/**
 * Whether two timings are the same mode, to what an EDID can say: every
 * active and blanking count and both polarities equal, and the clocks within
 * one 10 kHz step — a detailed timing states its clock in those, so 162.424
 * MHz goes in as 162.42 and must still count as the format it came from.
 */
export function sameTiming(a, b) {
  if (!a || !b) return false;
  const keys = ['hActive', 'hFront', 'hSync', 'hBack', 'vActive', 'vFront', 'vSync', 'vBack',
    'interlaced', 'hSyncPositive', 'vSyncPositive'];
  return keys.every((k) => a[k] === b[k]) && Math.abs(a.pixelClockHz - b.pixelClockHz) <= 10000;
}

/**
 * The slot whose EDID's preferred mode is this timing, or null — the test for
 * "this format already has an EDID in the bank" once an operator has edited
 * the one built for it (renamed it, added audio). `describe` reads a slot's
 * bytes; the caller passes Otter's so this file stays free of it.
 */
export function slotCarrying(slots, timing, describe) {
  for (const s of slots) {
    if (!s.bytes) continue;
    let t = null;
    try { t = describe(s.bytes).timing; } catch { t = null; }
    if (sameTiming(t, timing)) return s;
  }
  return null;
}

/** The first empty slot that is not protected, or null when the bank is full. */
export function firstFree(slots, skip = new Set()) {
  return slots.find((s) => s.empty && !s.locked && !skip.has(s.id)) || null;
}
