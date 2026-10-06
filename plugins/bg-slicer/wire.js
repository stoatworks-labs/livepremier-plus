/*
 * Background Slicer — sending writes and waiting for the switcher's echo.
 * Shared by both platforms' apply steps (`apply.js`, `apply-mng.js`).
 *
 * The echo is the only evidence a write landed (AGENTS.md: never update the
 * mirror optimistically), so every step sends and then waits.
 *
 * ⚠️ **In the page, the mirror is not the evidence.** The page transport
 * treats this page's own outbound writes as state (`transports/page-socket.js`
 * — so the panels follow the vendor UI in the same tab), which means a value
 * written here reads back from the store within a millisecond whether the
 * switcher took it or not. Seen on the Midra 4K simulator (2026-10-06): an
 * accepted write is echoed back to the page inbound in about a millisecond;
 * a refused one (`mode` = an enum value that does not exist) is echoed not at
 * all, and the mirror shows the refused value anyway. So `inbound: true`
 * waits for the switcher's own frame — `dir: 'in'`, path and value — off the
 * session's `frame` events. Both applies ask for it: the LivePremier
 * Simulator 6.2.73 echoed every write the LivePremier apply and Undo send —
 * stills, set contents and claims, set labels, the NATIVE source, the
 * capacity triggers — inbound with the exact value and type in 0.3–20 ms, and
 * a refused enum value not at all (2026-10-06).
 *
 * ⚠️ **A write of the value the switcher already holds is never echoed** —
 * seen on that LivePremier simulator, for every path above. So a path whose
 * writes change nothing, walked in order from what the mirror holds before
 * sending, is not waited for: its evidence is the store, as it always was.
 * The commonest case is a still's `source`: every still on that simulator
 * holds 1, and the first free library slot is 1. A path whose mirror holds a
 * write this page sent and the switcher refused misleads both ways: the same
 * value sent again reads as unchanged and passes, and the value the switcher
 * really holds is waited for and never echoed — an Undo after a refusal
 * reports that path after the timeout.
 */

export const ECHO_MS = 6000;
export const IMPORT_MS = 60000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve once `test()` holds, re-checking on every write to the store; false on timeout. */
export function until(store, test, ms = ECHO_MS) {
  try { if (test()) return Promise.resolve(true); } catch { /* not yet */ }
  return new Promise((resolve) => {
    let done = false;
    const check = () => { try { return test(); } catch { return false; } };
    const finish = (v) => { if (done) return; done = true; unsub(); clearTimeout(timer); resolve(v); };
    const unsub = store.subscribe(['device'], () => { if (check()) finish(true); }, { immediate: false });
    const timer = setTimeout(() => finish(check()), ms);
  });
}

/** Send writes in order; true when every one was handed to the socket. */
export function send(session, writes) {
  let ok = true;
  for (const w of writes) ok = session.send({ path: w.path, value: w.value }) !== false && ok;
  return ok;
}

/**
 * Send writes and wait for the last value of each path to come back. `opts`
 * is a timeout in ms, or `{ ms, inbound }`: with `inbound`, and a session
 * that reports frames, only the switcher's own echo counts, and only for
 * the paths the writes change.
 */
export async function sendAndEcho(session, writes, opts = ECHO_MS) {
  const { ms = ECHO_MS, inbound = false } = typeof opts === 'number' ? { ms: opts } : opts;
  if (inbound && session && typeof session.addEventListener === 'function') return sendAndHear(session, writes, ms);
  if (!send(session, writes)) return false;
  const last = new Map();
  for (const w of writes) last.set(w.path.join('/'), w);
  return until(session.store, () => [...last.values()].every((w) => session.store.get(w.path) === w.value), ms);
}

/**
 * Which paths `writes` change, each with the last value sent to it, walking
 * the list in order from what the store holds now — a pulse from `true`
 * (false, then true) changes its path; a write of the value already there
 * does not.
 */
export function changedPaths(store, writes) {
  const held = new Map();
  const want = new Map();
  for (const w of writes) {
    const k = w.path.join('/');
    const prev = held.has(k) ? held.get(k) : store.get(w.path);
    if (!Object.is(prev, w.value) || want.has(k)) want.set(k, w.value);
    held.set(k, w.value);
  }
  return want;
}

/**
 * Send writes and resolve true once the switcher has echoed each path they
 * change with the last value sent to it — an inbound frame on the session,
 * never this page's own outbound one. False on timeout: a write the switcher
 * refused. A path they do not change is sent and not waited for (see above).
 */
function sendAndHear(session, writes, ms) {
  const want = changedPaths(session.store, writes);
  return new Promise((resolve) => {
    const heard = new Set();
    let timer = null;
    let done = false;
    const finish = (v) => { if (done) return; done = true; session.removeEventListener('frame', on); clearTimeout(timer); resolve(v); };
    function on(ev) {
      const f = ev && ev.detail;
      if (!f || f.dir !== 'in' || !Array.isArray(f.path)) return;
      const k = f.path.join('/');
      if (!want.has(k) || !Object.is(want.get(k), f.value)) return;
      heard.add(k);
      if (heard.size === want.size) finish(true);
    }
    /* Listening before sending: the echo can be back within a millisecond. */
    session.addEventListener('frame', on);
    if (!send(session, writes)) { finish(false); return; }
    if (want.size === 0) { finish(true); return; }
    if (!done) timer = setTimeout(() => finish(false), ms);
  });
}
