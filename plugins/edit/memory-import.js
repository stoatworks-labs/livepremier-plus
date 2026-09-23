/*
 * Writing a memory into the bank without going near a preset buffer.
 *
 * The device's own save takes a snapshot of PROGRAM or PREVIEW — those are the
 * only two things it will name — so every ordinary route to a memory goes
 * through a bus. This does not. The bank carries an import beside its save,
 * and the file it eats is plain JSON. `src/core/preset-file.js` has the format
 * and the evidence; this is the three-step conversation that installs one.
 *
 *   1. extract   the device reads the file and stages what is in it
 *   2. dstIndex  we say which slot each staged memory is to land in
 *   3. load      the device writes the bank
 *
 * Proven end to end against a LivePremier Simulator 6.2.73 on 2026-09-22: a
 * hand-authored file went into an empty slot and the device reported it valid
 * with the label, canvas width and duration from the file, with no buffer
 * written and no take fired.
 *
 * ## ⚠️ The path is the device's, not ours
 *
 * `extract/cmd/pp/path` is a path on the machine running the device software.
 * On the simulator that is this machine, so a temporary directory here is a
 * directory the device can read and the whole thing works. **On a real
 * Aquilon it is the switcher's own filesystem**, and how to put a file there
 * has not been established — Web RCS 6.2.73 exposes no memory import at all
 * and no upload route for one. So:
 *
 * - the directory is settable, because the answer on real hardware may well be
 *   "a share both machines can see";
 * - an extract that fails is reported with the device's own status word rather
 *   than swallowed, because `ERROR_INVALID_FILE` from a box that cannot see
 *   our disk is the expected answer and the operator needs to be told to use
 *   the other route;
 * - nothing here retries. A second attempt at a path the device cannot read
 *   fails the same way and only costs a show minute.
 *
 * The two ways to get it wrong, both met while establishing this: the export
 * wants a DIRECTORY and answers `ERROR_INVALID_PATH` for a file name, and the
 * import wants a FILE and answers `ERROR_INVALID_FILE` for a directory.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

import { exchange } from '../../server/awj.js';

/** The device always calls it this. */
const FILE_NAME = 'Preset.json';

const BANK = 'DeviceObject/presetBank';
const EXTRACT = `${BANK}/import/extract`;
const LOAD = `${BANK}/import/load`;

/** How long to wait for each of the device's two slow steps. */
const EXTRACT_TIMEOUT_MS = 15000;
const LOAD_TIMEOUT_MS = 15000;
const POLL_MS = 400;

/** Where the file goes when nothing else has been said. */
export const defaultDir = () => join(os.tmpdir(), 'livepremier-plus', 'memory-import');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * One AWJ exchange: the plugin's own `ctx.awj`, or, given only a host, a
 * connection opened for the purpose — the same conversation either way.
 * Everything below takes the exchange rather than an address, so the Edit
 * plugin never has to know how the app reaches the switcher.
 */
const exchangeFor = ({ host, awj }) => awj || ((messages) => exchange({ host, messages }));

const get = (ex, paths) => ex(paths.map((path) => ({ op: 'get', path })));

const put = (ex, pairs) => ex(pairs.map(([path, value]) => ({ op: 'replace', path, value })));

/**
 * Wait for one property to stop saying what it is saying now.
 *
 * A write is answered with silence on AWJ, so every step here is confirmed by
 * reading rather than by being told. `settled` decides when the answer counts.
 */
async function waitFor(ex, path, settled, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    const [reply] = await get(ex, [path]);
    last = reply ? reply.value : null;
    if (settled(last)) return last;
    await sleep(POLL_MS);
  }
  return last;
}

/**
 * Install memories into the bank.
 *
 * @param {object} opts
 * @param {Function} [opts.awj]    one AWJ exchange, `messages -> replies` — a plugin's `ctx.awj`
 * @param {string} [opts.host]     or the switcher's address, to open one for the purpose
 * @param {Array<object>} opts.memories  entries as `core/preset-file.js` composes them
 * @param {string} [opts.dir]      the directory the DEVICE will read the file from
 * @returns {Promise<{ok:boolean, slots:number[], steps:object[], error?:string}>}
 */
export async function importMemories({ host, awj, memories, dir = defaultDir() }) {
  const ex = exchangeFor({ host, awj });
  const steps = [];
  const record = (step, detail) => { steps.push({ step, ...detail }); };

  if (!Array.isArray(memories) || memories.length === 0) {
    return { ok: false, slots: [], steps, error: 'no memories to install' };
  }

  const slots = memories.map((m) => Number(m.BankSlot)).filter((n) => Number.isFinite(n) && n > 0);
  if (slots.length !== memories.length) {
    return { ok: false, slots: [], steps, error: 'every memory needs a BankSlot' };
  }

  /* 0. The file. */
  const path = join(dir, FILE_NAME);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify(memories, null, 4) + '\n', 'utf8');
    record('write', { path, bytes: JSON.stringify(memories).length });
  } catch (err) {
    return { ok: false, slots: [], steps, error: `could not write ${path}: ${err.message}` };
  }

  /* 1. Extract. */
  await put(ex, [[`${EXTRACT}/cmd/@props/path`, path], [`${EXTRACT}/cmd/@props/xRequest`, true]]);
  const extracted = await waitFor(
    ex, `${EXTRACT}/status/@props/status`,
    (v) => typeof v === 'string' && v !== 'IN_PROGRESS' && v !== 'NO_REQUEST',
    EXTRACT_TIMEOUT_MS
  );
  record('extract', { status: extracted });
  if (extracted !== 'DONE') {
    return {
      ok: false, slots: [], steps,
      error: `the device would not read ${path} (${extracted || 'no answer'})`
        + ' — that path is on the switcher\'s own filesystem, not on this machine'
    };
  }

  /* 2. Where each staged memory is to land.
     `orgIndex` is the BankSlot the file asked for, so the staged entries are
     matched by it rather than by position — the device is free to stage them
     in whatever order it likes and has never promised ours. */
  const staged = [];
  for (let n = 1; n <= memories.length; n++) {
    const [valid, org] = (await get(ex, [
      `${LOAD}/$bank/@items/${n}/@props/isValid`,
      `${LOAD}/$bank/@items/${n}/@props/orgIndex`
    ])).map((r) => (r ? r.value : null));
    if (valid) staged.push({ n, orgIndex: Number(org) });
  }
  record('staged', { entries: staged });

  if (staged.length !== memories.length) {
    return {
      ok: false, slots: [], steps,
      error: `the device staged ${staged.length} of ${memories.length} memories`
    };
  }

  const writes = [];
  for (const entry of staged) {
    const wanted = slots.includes(entry.orgIndex) ? entry.orgIndex : slots[staged.indexOf(entry)];
    writes.push([`${LOAD}/$bank/@items/${entry.n}/@props/dstIndex`, wanted]);
  }
  await put(ex, writes);
  record('destinations', { writes: writes.length });

  /* 3. Load, then confirm from the bank itself — the only honest confirmation
     there is, since the write that does it is answered with silence. */
  await put(ex, [[`${LOAD}/cmd/@props/xRequest`, true]]);

  const landed = [];
  for (const slot of slots) {
    const valid = await waitFor(
      ex, `${BANK}/$bank/@items/${slot}/status/@props/isValid`,
      (v) => v === true, LOAD_TIMEOUT_MS
    );
    if (valid === true) landed.push(slot);
  }
  record('load', { landed });

  if (landed.length !== slots.length) {
    const missing = slots.filter((s) => !landed.includes(s));
    return { ok: false, slots: landed, steps, error: `slot ${missing.join(', ')} did not come back valid` };
  }

  return { ok: true, slots: landed, steps };
}

/**
 * Read memories back out of the bank.
 *
 * The other half, and the only way to see inside a slot: a bank slot publishes
 * `isValid`, `label`, the two filters, its canvas and its duration, and nothing
 * whatever about its layers. Exporting is how a real memory is loaded into the
 * programmer.
 *
 * ⚠️ The same path warning applies, from the other end — the device writes the
 * file onto its own disk, and reading it back here only works where the two
 * are the same machine or share a directory.
 */
export async function exportMemories({ host, awj, slots, dir = defaultDir(), slotCount = 1000 }) {
  const ex = exchangeFor({ host, awj });
  const wanted = (Array.isArray(slots) ? slots : [slots]).map(Number).filter(Boolean);
  if (!wanted.length) return { ok: false, path: null, error: 'no slots named' };

  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    return { ok: false, path: null, error: `could not make ${dir}: ${err.message}` };
  }

  const selection = Array.from({ length: slotCount }, (_, i) => wanted.includes(i + 1));
  /* A trailing separator, because this end wants a DIRECTORY and answers
     ERROR_INVALID_PATH for anything that looks like a file. */
  await put(ex, [
    [`${BANK}/export/cmd/@props/selection`, selection],
    [`${BANK}/export/cmd/@props/path`, dir.endsWith('/') ? dir : dir + '/'],
    [`${BANK}/export/cmd/@props/xRequest`, true]
  ]);

  const status = await waitFor(
    ex, `${BANK}/export/status/@props/status`,
    (v) => typeof v === 'string' && v !== 'IN_PROGRESS' && v !== 'NO_REQUEST',
    EXTRACT_TIMEOUT_MS
  );
  if (status !== 'DONE') return { ok: false, path: null, error: `export said ${status || 'nothing'}` };

  return { ok: true, path: join(dir, FILE_NAME) };
}
