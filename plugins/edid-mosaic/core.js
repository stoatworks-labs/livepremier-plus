/*
 * Mosaic inputs — one Mac, several plugs, one frame-synced input.
 *
 * A Mac joins several of its outputs into one display when every plug it is
 * connected to advertises a DisplayID Tiled Display Topology block with the
 * same topology id and its own place in the grid (Otter's Mosaic mode builds
 * the per-plug EDIDs). A LivePremier then has to take those plugs back in as
 * one picture, which is an input group: `preconfig/inputs` sets IN_n to 2X1 or
 * 2X2 and the next inputs in logical order become its members.
 *
 * What the LivePremier simulator 6.2.73 showed, 2026-09-23:
 *
 *   - Grouping stitches the plugs (the group input reports the full width,
 *     each member plug its `imagePlugLeft` / `imagePlugTop`) but writes NO
 *     EDID — the members keep the stock 256-byte one, so a Mac would see
 *     separate displays. The tile EDIDs are the part that makes it bond.
 *   - A plug takes a 384-byte EDID through `edid/cmd` (dataSize, data padded
 *     to 512, then `xStore` false -> true) and serves it back byte for byte,
 *     DisplayID block included, grouped member or not.
 *   - 2X1 places IN_n left and IN_n+1 right. 2X2 reported two members at the
 *     same place on the simulator, so tiles are placed by what the device
 *     reports and a collision is refused rather than guessed around.
 *
 * Nothing here has met an Aquilon yet.
 *
 * Pure apart from the session it is handed: no DOM, so it tests under node.
 */

const ROOT = 'device';
const GROUP_OF = { '2x1': '2X1', '2x2': '2X2' };
const TILE_BYTES = 384;

const pp = (node) => (node && node.pp) || {};
const inputNode = (store, id) => store.get([ROOT, 'inputList', 'items', id]);
const plugNode = (store, id) => store.get([ROOT, 'inputList', 'items', id, 'plugList', 'items', '1']);
const preNew = (id) => [ROOT, 'preconfig', 'inputs', 'new', 'inputList', 'items', id, 'control', 'pp', 'group'];
const preCurrent = (store, id) => pp(store.get([ROOT, 'preconfig', 'inputs', 'current', 'inputList', 'items', id, 'status']));
const edidCmd = (id) => [ROOT, 'inputList', 'items', id, 'plugList', 'items', '1', 'edid', 'cmd', 'pp'];
const NEW_CONTROL = [ROOT, 'preconfig', 'inputs', 'new', 'control', 'pp'];
const newStatus = (store) => pp(store.get([ROOT, 'preconfig', 'inputs', 'new', 'status']));

export const groupFor = (cols, rows) => GROUP_OF[`${cols}x${rows}`] || null;

/** Inputs in logical order — IN_1, IN_2 … — which is the order a group absorbs. */
export function inputIds(store) {
  const items = store.get([ROOT, 'inputList', 'items']) || {};
  return Object.keys(items)
    .filter((k) => /^IN_\d+$/.test(k))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
}

function plugInfo(store, id) {
  const input = inputNode(store, id);
  const plug = plugNode(store, id);
  const mapping = pp(input && input.mapping);
  const edid = pp(plug && plug.edid && plug.edid.status);
  return {
    id,
    fitted: mapping.isValid === true,
    card: mapping.card || null,
    physical: mapping.physical || null,
    type: pp(plug && plug.status).type || null,
    sizes: Array.isArray(edid.dataSizeAvailable) ? edid.dataSizeAvailable.map(String) : [],
    pre: preCurrent(store, id)
  };
}

const typeLabel = (t) => (t === 'DISPLAY_PORT' ? 'DP' : t || '?');

/**
 * Every place a cols x rows mosaic could start, and whether it can. The first
 * input of each run of `cols * rows` consecutive inputs is a candidate; the
 * reasons are the ones the device would otherwise refuse with later, after
 * half the writes had landed.
 */
export function mosaicTargets(store, cols, rows) {
  const group = groupFor(cols, rows);
  const ids = inputIds(store);
  const n = cols * rows;
  const out = [];
  for (let i = 0; i + n <= ids.length; i++) {
    const members = ids.slice(i, i + n).map((id) => plugInfo(store, id));
    const [first] = members;
    if (!first.fitted) continue;
    const why = [];
    if (!group) why.push(`a ${cols} × ${rows} group is not a LivePremier input group`);
    else if (!(first.pre.groupValidity || []).includes(group)) why.push(`${first.id} cannot be grouped ${group}`);
    if (members.some((m) => !m.fitted)) why.push('not every input in the run has a card fitted');
    if (members.some((m) => m.card !== first.card)) why.push('the run crosses onto another card');
    if (members.some((m) => m.type !== first.type)) why.push('the run mixes connector types');
    if (members.some((m) => !m.sizes.includes(String(TILE_BYTES)))) why.push('a plug cannot take a 384-byte EDID');
    const taken = members.slice(1).find((m) => m.pre.global === 'GROUPED' || (m.pre.group && m.pre.group !== '1X1'));
    const regroup = first.pre.group && first.pre.group !== '1X1' && first.pre.group !== group;
    if (regroup) why.push(`${first.id} is already grouped ${first.pre.group}`);
    else if (taken && !(first.pre.group === group)) why.push(`${taken.id} already belongs to another group`);
    out.push({
      id: first.id,
      label: `${members.map((m) => m.id).join(' + ')} (${typeLabel(first.type)}, card ${first.card || '?'})`,
      members: members.map((m) => m.id),
      ok: why.length === 0,
      why: why.join('; ') || undefined
    });
  }
  return out;
}

// ------------------------------------------------------------------ EDID reading

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

/** What a plug is serving now: its bytes, trimmed to the size it declares. */
export function servedEdid(store, id) {
  const st = pp(plugNode(store, id) && plugNode(store, id).edid && plugNode(store, id).edid.status);
  const data = Array.isArray(st.data) ? st.data : [];
  return { bytes: data.slice(0, Number(st.dataSize) || data.length), isValid: st.isValid, name: st.productName || '' };
}

/** A member plug's place in the stitched picture, in pixels, as the device reports it. */
function reportedPlace(store, id) {
  const sig = pp(plugNode(store, id) && plugNode(store, id).status && plugNode(store, id).status.signal);
  return { left: Number(sig.imagePlugLeft) || 0, top: Number(sig.imagePlugTop) || 0 };
}

/**
 * Which tile goes to which member. 2X1 is logical order — IN_n left, IN_n+1
 * right — which is what the simulator reported. 2X2 uses the device's own
 * placement, ranked into columns and rows, and returns an error when two
 * members report the same place (the simulator does exactly that).
 */
export function placeMembers(store, members, cols, rows) {
  if (rows === 1) return { ok: true, places: members.map((id, i) => ({ id, col: i, row: 0 })) };
  const reported = members.map((id) => ({ id, ...reportedPlace(store, id) }));
  const keys = new Set(reported.map((r) => `${r.left},${r.top}`));
  if (keys.size !== members.length) {
    return {
      ok: false,
      error: `the switcher reports ${reported.map((r) => `${r.id} at ${r.left},${r.top}`).join(', ')} — two plugs in the same place, so which tile goes where cannot be read off it`
    };
  }
  const lefts = [...new Set(reported.map((r) => r.left))].sort((a, b) => a - b);
  const tops = [...new Set(reported.map((r) => r.top))].sort((a, b) => a - b);
  if (lefts.length !== cols || tops.length !== rows) {
    return { ok: false, error: `the switcher's placement is not a ${cols} × ${rows} grid` };
  }
  return { ok: true, places: reported.map((r) => ({ id: r.id, col: lefts.indexOf(r.left), row: tops.indexOf(r.top) })) };
}

/**
 * Check a grouped input's plugs the way a Mac will read them: every member
 * serving a tile, one topology id, the grid the group has, every place
 * different, and each tile where the switcher put that plug.
 */
export function inspectMosaic(store, firstId) {
  const pre = preCurrent(store, firstId);
  const m = /^(\d)X(\d)$/.exec(pre.group || '');
  const cols = m ? Number(m[1]) : 1;
  const rows = m ? Number(m[2]) : 1;
  const ids = inputIds(store);
  const start = ids.indexOf(firstId);
  const members = start >= 0 ? ids.slice(start, start + cols * rows) : [firstId];
  const problems = [];
  if (cols * rows === 1) problems.push(`${firstId} is not grouped`);

  const plugs = members.map((id) => {
    const served = servedEdid(store, id);
    const tile = readTile(served.bytes);
    return { id, name: served.name, size: served.bytes.length, tile };
  });
  for (const p of plugs) {
    if (!p.tile) problems.push(`${p.id} serves ${p.size} bytes with no tiled block — a Mac sees it as a separate display`);
    else if (p.tile.cols !== cols || p.tile.rows !== rows) problems.push(`${p.id} declares a ${p.tile.cols} × ${p.tile.rows} grid; the group is ${cols} × ${rows}`);
  }
  const tiled = plugs.filter((p) => p.tile);
  if (new Set(tiled.map((p) => p.tile.topologyId)).size > 1) problems.push('the plugs carry different topology ids — a Mac groups plugs by that id, so they will not join');
  const at = tiled.map((p) => `${p.tile.col},${p.tile.row}`);
  if (new Set(at).size < at.length) problems.push('two plugs claim the same tile');
  if (cols * rows > 1 && tiled.length === plugs.length) {
    const placed = placeMembers(store, members, cols, rows);
    if (placed.ok) {
      for (const pl of placed.places) {
        const t = plugs.find((p) => p.id === pl.id).tile;
        if (t.col !== pl.col || t.row !== pl.row) problems.push(`${pl.id} is tile ${t.col},${t.row} but the switcher places it at ${pl.col},${pl.row} — the picture will come out scrambled`);
      }
    }
  }
  return { group: pre.group || '1X1', cols, rows, members: plugs, ok: problems.length === 0, problems };
}

// ------------------------------------------------------------------ writing

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until `test()` holds, re-checking on every write to the store. */
function until(store, test, ms) {
  if (test()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; unsub(); clearTimeout(timer); resolve(v); } };
    const unsub = store.subscribe([ROOT], () => { if (test()) finish(true); }, { immediate: false });
    const timer = setTimeout(() => finish(test()), ms);
  });
}

/**
 * Set an input's group through the preconfig: copy current, change one
 * field, check, apply — the sequence the Web RCS itself sends.
 */
export async function setGroup(session, firstId, group, { timeout = 15000, steps = [] } = {}) {
  const { store } = session;
  if (preCurrent(store, firstId).group === group) { steps.push(`${firstId} is already ${group}`); return true; }
  session.send({ path: [...NEW_CONTROL, 'xCopyFromCurrent'], value: true });
  await sleep(400);
  session.send({ path: preNew(firstId), value: group });
  await sleep(300);
  session.send({ path: [...NEW_CONTROL, 'xCheck'], value: true });
  await until(store, () => newStatus(store).hasChanged === true || newStatus(store).error === true, 5000);
  if (newStatus(store).error) { steps.push('the switcher refused the preconfig check'); return false; }
  session.send({ path: [...NEW_CONTROL, 'xApply'], value: true });
  const ok = await until(store, () => preCurrent(store, firstId).group === group, timeout);
  steps.push(ok ? `${firstId} grouped ${group}` : `${firstId} did not become ${group}`);
  return ok;
}

/** Write one plug's EDID the way the Web RCS does, and wait for it to be served. */
export async function writePlugEdid(session, id, bytes, { timeout = 8000 } = {}) {
  const data = Array.from(bytes);
  while (data.length < 512) data.push(0);
  const base = edidCmd(id);
  session.send({ path: [...base, 'dataSize'], value: String(bytes.length) });
  session.send({ path: [...base, 'data'], value: data });
  session.send({ path: [...base, 'xStore'], value: false });
  await sleep(150);
  session.send({ path: [...base, 'xStore'], value: true });
  const same = () => {
    const served = servedEdid(session.store, id).bytes;
    return served.length === bytes.length && served.every((b, i) => b === bytes[i]);
  };
  return until(session.store, same, timeout);
}

/**
 * The whole job: group the run starting at `firstId`, put each tile on the
 * plug the switcher places at that tile's position, and read it all back.
 * `tiles` are Otter's: `{ col, row, label, bytes }`, 384 bytes each.
 */
export async function applyMosaic(session, firstId, tiles, opts = {}) {
  const { store } = session;
  const steps = [];
  const problems = [];
  const cols = Math.max(...tiles.map((t) => t.col)) + 1;
  const rows = Math.max(...tiles.map((t) => t.row)) + 1;
  const group = groupFor(cols, rows);
  const target = mosaicTargets(store, cols, rows).find((t) => t.id === firstId);
  if (!target) return { ok: false, steps, problems: [`${firstId} cannot start a ${cols} × ${rows} group`] };
  if (!target.ok) return { ok: false, steps, problems: [target.why] };
  if (tiles.some((t) => t.bytes.length !== TILE_BYTES || !readTile(t.bytes))) {
    return { ok: false, steps, problems: ['these are not tile EDIDs — build them in Mosaic mode'] };
  }

  if (!(await setGroup(session, firstId, group, { ...opts, steps }))) {
    return { ok: false, steps, problems: [`the switcher did not group ${firstId} ${group}`] };
  }
  const placed = placeMembers(store, target.members, cols, rows);
  if (!placed.ok) return { ok: false, steps, problems: [placed.error, 'grouped, but no EDIDs written'] };

  for (const pl of placed.places) {
    const tile = tiles.find((t) => t.col === pl.col && t.row === pl.row);
    const ok = await writePlugEdid(session, pl.id, tile.bytes, opts);
    steps.push(ok ? `${tile.label} → ${pl.id}` : `${pl.id} did not take ${tile.label}`);
    if (!ok) problems.push(`${pl.id} is not serving ${tile.label}`);
  }
  const check = inspectMosaic(store, firstId);
  problems.push(...check.problems);
  return { ok: problems.length === 0, steps, problems };
}

/** Undo: back to 1X1 and every member plug back to the switcher's own EDID. */
export async function clearMosaic(session, firstId, opts = {}) {
  const steps = [];
  const { members } = inspectMosaic(session.store, firstId);
  await setGroup(session, firstId, '1X1', { ...opts, steps });
  for (const { id } of members) {
    const base = edidCmd(id);
    session.send({ path: [...base, 'xReset'], value: false });
    await sleep(150);
    session.send({ path: [...base, 'xReset'], value: true });
    steps.push(`${id} back to its default EDID`);
  }
  return { ok: true, steps, problems: [] };
}
