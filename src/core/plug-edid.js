/*
 * An input plug's EDID: what it serves, and writing one onto it.
 *
 * Two plugins load plug EDIDs by hand — Mosaic inputs (a tile per plug) and
 * Plug names (the same EDID under the input's label) — and a plugin may not
 * import another's folder, so the plumbing both need lives here.
 *
 * ## Writing is the vendor's own load
 *
 * Read out of the LivePremier Web RCS 6.2.73 bundle (`input-card.tsx`,
 * 2026-10-24): dropping a bank slot onto an input on the EDID page sends the
 * slot's `data` and `dataSize` to the plug's `edid/cmd/pp`, then `xStore`
 * false, then true. Every bank-to-input load on a real frame goes that way,
 * so the write below is the one an Aquilon already takes from its own page.
 * `xReset` false then true is the vendor's "back to default" on the same card.
 *
 * The plug serves what it stored at `edid/status/pp/data`, always 512
 * numbers, the EDID and then 0xFF; `dataSize` says how much is EDID. The
 * same card has a `label` in `edid/cmd/pp` — a note the vendor's card shows
 * beside the EDID's own name. It is not in the EDID, and nothing here
 * touches it.
 *
 * Pure apart from the session it is handed: no DOM, so it runs under node.
 */

import { ROOT } from './paths.js';

const pp = (node) => (node && node.pp) || {};

/** The plug's EDID command node, where data, dataSize, xStore and xReset are. */
export const plugEdidCmd = (id, plug = '1') => [ROOT, 'inputList', 'items', id, 'plugList', 'items', String(plug), 'edid', 'cmd', 'pp'];

const plugNode = (store, id, plug = '1') => store.get([ROOT, 'inputList', 'items', id, 'plugList', 'items', String(plug)]);

/** The plug's EDID status: `isAvailable`, `isValid`, `isBusy`, `dataSizeAvailable`, `productName`… */
export function plugEdidStatus(store, id, plug = '1') {
  const node = plugNode(store, id, plug);
  return pp(node && node.edid && node.edid.status);
}

/** What a plug is serving now: its bytes, trimmed to the size it declares. */
export function servedEdid(store, id, plug = '1') {
  const st = plugEdidStatus(store, id, plug);
  const data = Array.isArray(st.data) ? st.data : [];
  return { bytes: data.slice(0, Number(st.dataSize) || data.length), isValid: st.isValid, name: st.productName || '' };
}

/** Whether two byte lists are the same EDID. */
export const sameBytes = (a, b) => !!a && !!b && a.length === b.length && Array.prototype.every.call(a, (x, i) => x === b[i]);

/**
 * The tile a DisplayID Tiled Display Topology block describes, from a whole
 * EDID. Tag 0x12 in a DisplayID 1.3 section, 0x28 in a 2.0 one; the 22-byte
 * payload is the same (drm_parse_tiled_block). Null when there is none.
 */
export function readTile(bytes) {
  for (let off = 128; off + 128 <= bytes.length; off += 128) {
    if (bytes[off] !== 0x70) continue;
    const v2 = bytes[off + 1] >= 0x20;
    const end = off + 5 + Math.min(bytes[off + 2], 121);
    for (let i = off + 5; i + 3 <= end;) {
      const tag = bytes[i];
      const len = bytes[i + 2];
      if (tag === 0 && len === 0) break;
      if (tag === (v2 ? 0x28 : 0x12) && len >= 22) {
        const p = bytes.slice(i + 3, i + 3 + 22);
        const hi = p[3];
        return {
          cols: ((p[1] >> 4) | (((hi >> 6) & 3) << 4)) + 1,
          rows: ((p[1] & 0x0f) | (((hi >> 4) & 3) << 4)) + 1,
          col: (p[2] >> 4) | (((hi >> 2) & 3) << 4),
          row: (p[2] & 0x0f) | ((hi & 3) << 4),
          width: (p[4] | (p[5] << 8)) + 1,
          height: (p[6] | (p[7] << 8)) + 1,
          topologyId: Array.from(p.slice(13, 22), (b) => b.toString(16).padStart(2, '0')).join(' ')
        };
      }
      i += 3 + len;
    }
  }
  return null;
}

// ------------------------------------------------------------------ writing

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until `test()` holds, re-checking on every write to the store. */
export function until(store, test, ms) {
  if (test()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; unsub(); clearTimeout(timer); resolve(v); } };
    const unsub = store.subscribe([ROOT], () => { if (test()) finish(true); }, { immediate: false });
    const timer = setTimeout(() => finish(test()), ms);
  });
}

/**
 * Write one plug's EDID the way the Web RCS does, and wait for it to be served.
 * Padded with 0xFF, as a bank slot is and as the vendor's drop sends it: the
 * plug serves the padding back, so a zero-padded undo left a plug's 512
 * numbers different from before though its EDID was the same (simulator,
 * 2026-10-24).
 */
export async function writePlugEdid(session, id, bytes, { timeout = 8000 } = {}) {
  const data = Array.from(bytes);
  while (data.length < 512) data.push(0xff);
  const base = plugEdidCmd(id);
  session.send({ path: [...base, 'dataSize'], value: String(bytes.length) });
  session.send({ path: [...base, 'data'], value: data });
  session.send({ path: [...base, 'xStore'], value: false });
  await sleep(150);
  session.send({ path: [...base, 'xStore'], value: true });
  return until(session.store, () => sameBytes(servedEdid(session.store, id).bytes, bytes), timeout);
}

/** The vendor card's reset: the plug back to the switcher's own EDID. Does not wait. */
export async function resetPlugEdid(session, id) {
  const base = plugEdidCmd(id);
  session.send({ path: [...base, 'xReset'], value: false });
  await sleep(150);
  session.send({ path: [...base, 'xReset'], value: true });
}
