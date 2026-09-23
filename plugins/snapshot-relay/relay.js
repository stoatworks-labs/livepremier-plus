/*
 * The relay's bookkeeping: one entry per snapshot path, shared by every page.
 *
 * No sockets and no codec in here — the fetch and the transcode are handed
 * in — so what it decides can be tested against a scripted switcher.
 *
 * ## What it saves, and what it cannot
 *
 * A thumbnail asked for twice within `maxAgeMs` costs the switcher once. Two
 * Web RCS tabs, or a tab and this app's preview wall, stop being twice the
 * traffic. A frame the switcher has not changed since the last fetch is
 * recognised byte for byte and its JPEG reused, so it is not encoded again.
 *
 * It cannot make the switcher send less. The PNG still crosses from the
 * device to this process at full size every time it is fetched; the saving
 * is between this process and the browsers. On a laptop wired to the frame
 * that is the cheaper half, but a tablet on the show Wi-Fi is exactly where
 * 590 KB against 30 KB matters.
 *
 * ## Hot and idle
 *
 * While a page is editing — drawing some sources in a screen or aux canvas —
 * it names those sources to this relay as **hot** (`createHotSet`). The server
 * then lets every other source's frame age up to `idleMs` before asking the
 * switcher again, and the page refreshes the hot ones itself, faster than the
 * vendor would. The vendor's poller still asks for everything; what changes is
 * how many of those asks reach the switcher. Which frame age is acceptable is
 * the caller's decision, per request — this file only honours it.
 *
 * ## What it measures
 *
 * How often each source's picture actually changes, seen from the fetches
 * that happen. That is the number nobody has yet: if a Pulse rewrites its
 * PNGs at 5 Hz, polling faster than the vendor's 1 Hz is worth doing; if at
 * 1 Hz, it is not. It can only see changes as fast as it is asked, so it is a
 * lower bound on the firmware's rate while the vendor's poller sets the pace.
 */

import { isPng } from './png.js';

/* A source nobody has asked about for this long is forgotten, frame and all. */
const FORGET_MS = 60_000;
/* Intervals between changes kept per source, for the median. */
const INTERVALS = 20;

/**
 * @param {object} opts
 * @param {(path: string, headers: object) => Promise<{status: number, headers: object, body: Buffer}>} opts.fetch
 * @param {(png: Buffer) => Promise<{type: string, body: Buffer}|null>} opts.transcode
 *        null means "serve the original", for any reason
 * @param {() => {maxAgeMs: number}} opts.settings  read per request, for the default share window
 * @param {(path: string) => boolean} [opts.isHot]  only for the stats
 * @param {() => number} [opts.now]
 */
export function createRelay({ fetch, transcode, settings, isHot = () => false, now = Date.now }) {
  const entries = new Map();
  const totals = {
    requests: 0,        /* pages that asked */
    fetches: 0,         /* times the switcher was asked */
    shared: 0,          /* answered from a frame another request fetched */
    idle: 0,            /* answered from an older frame, the source being idle */
    unchanged: 0,       /* fetched, and byte-identical to the frame before */
    encoded: 0,         /* transcodes run */
    encodeMs: 0,
    passthrough: 0,     /* served as the switcher sent it */
    errors: 0,
    bytesIn: 0,         /* from the switcher */
    bytesOut: 0         /* to the pages */
  };
  const started = now();

  function entryFor(path) {
    let e = entries.get(path);
    if (!e) {
      e = { path, raw: null, out: null, at: 0, seq: 0, inflight: null, lastAsked: 0, lastChange: 0, intervals: [] };
      entries.set(path, e);
    }
    return e;
  }

  function forget(t) {
    for (const [path, e] of entries) if (!e.inflight && t - e.lastAsked > FORGET_MS) entries.delete(path);
  }

  async function refresh(e, headers) {
    totals.fetches++;
    const res = await fetch(e.path, headers);
    totals.bytesIn += res.body.length;
    if (res.status !== 200 || !isPng(res.body)) {
      /* Not a picture this knows: a 404 for an input that is not fitted, an
         error page, a format a new firmware chose. Handed on as it came, and
         not kept — the next request asks again, as the vendor's would. */
      totals.passthrough++;
      return { status: res.status, type: res.headers['content-type'] || 'application/octet-stream', body: res.body, kept: false };
    }
    const t = now();
    if (e.raw && e.raw.equals(res.body)) {
      totals.unchanged++;
      e.at = t;
      return { ...e.out, kept: true };
    }
    if (e.raw) {
      e.intervals.push(t - e.lastChange);
      if (e.intervals.length > INTERVALS) e.intervals.shift();
    }
    e.lastChange = t;
    e.raw = res.body;
    e.seq++;

    let out = null;
    const began = now();
    try { out = await transcode(res.body); }
    catch { out = null; }
    if (out) { totals.encoded++; totals.encodeMs += now() - began; }
    /* A transcode that did not help — the simulators' 400-byte placeholders
       come out bigger as JPEG — is not worth serving. */
    if (!out || out.body.length >= res.body.length) {
      if (!out) totals.passthrough++;
      out = { type: 'image/png', body: res.body };
    }
    e.out = { status: 200, type: out.type, body: out.body, etag: `"lpp-${e.seq}"` };
    e.at = t;
    return { ...e.out, kept: true };
  }

  /**
   * A snapshot for a page: `{ status, type, body, etag?, via }`, `via` saying
   * where it came from — `fresh`, `shared`, `idle`, `unchanged` or
   * `passthrough`. Throws only when the switcher could not be reached at all.
   *
   * @param {string} path     the vendor's path, no query
   * @param {object} headers  the page's request headers, for the switcher
   * @param {{maxAgeMs?: number}} [opts]  how old a kept frame may be and still
   *        answer; the share window from the settings when not given. Past the
   *        share window, an answer from the kept frame counts as `idle`.
   */
  async function get(path, headers = {}, { maxAgeMs } = {}) {
    totals.requests++;
    const t = now();
    forget(t);
    const e = entryFor(path);
    e.lastAsked = t;
    const share = settings().maxAgeMs;
    const limit = maxAgeMs ?? share;

    if (e.out && t - e.at <= limit) {
      const idle = t - e.at > share;
      if (idle) totals.idle++; else totals.shared++;
      return count({ ...e.out, via: idle ? 'idle' : 'shared' });
    }
    if (e.inflight) {
      totals.shared++;
      const r = await e.inflight;
      return count({ ...r, via: 'shared' });
    }
    const before = e.seq;
    e.inflight = refresh(e, headers);
    try {
      const r = await e.inflight;
      const via = !r.kept ? 'passthrough' : (e.seq === before ? 'unchanged' : 'fresh');
      return count({ ...r, via });
    } catch (err) {
      totals.errors++;
      throw err;
    } finally {
      e.inflight = null;
    }
  }

  function count(r) {
    totals.bytesOut += r.body.length;
    const { kept, ...out } = r;
    return out;
  }

  const median = (list) => {
    if (!list.length) return null;
    const s = [...list].sort((a, b) => a - b);
    return s[s.length >> 1];
  };

  /** What the settings card shows. */
  function stats() {
    const t = now();
    return {
      since: started,
      seconds: Math.max(0.001, (t - started) / 1000),
      ...totals,
      sources: [...entries.values()]
        .filter((e) => e.out)
        .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
        .map((e) => ({
          path: e.path.replace('/api/device/snapshots/', ''),
          frames: e.seq,
          changeMs: median(e.intervals),
          bytesIn: e.raw ? e.raw.length : 0,
          bytesOut: e.out.body.length,
          type: e.out.type,
          ageMs: t - e.at,
          hot: isHot(e.path)
        }))
    };
  }

  return { get, stats, size: () => entries.size };
}

/**
 * The sources pages are editing, each page's list held on a lease.
 *
 * A page names its hot sources every couple of seconds; a page that stops —
 * closed, crashed, put to sleep — drops out when its lease runs out, and its
 * sources go idle with it. Several pages are a union: a source one tab is
 * editing stays hot whatever another tab is showing.
 *
 * @param {{leaseMs?: number, now?: () => number}} [opts]
 */
export function createHotSet({ leaseMs = 5000, now = Date.now } = {}) {
  const pages = new Map();

  function live() {
    const t = now();
    for (const [id, p] of pages) if (t - p.at > leaseMs) pages.delete(id);
    return pages;
  }

  return {
    /** Replace one page's list. An empty list keeps the page but makes nothing hot. */
    set(page, paths) { pages.set(page, { at: now(), paths: new Set(paths) }); },
    has(path) {
      for (const p of live().values()) if (p.paths.has(path)) return true;
      return false;
    },
    /** Whether anybody is editing at all: some page has at least one hot source. */
    editing() {
      for (const p of live().values()) if (p.paths.size) return true;
      return false;
    },
    list() {
      const out = new Set();
      for (const p of live().values()) for (const path of p.paths) out.add(path);
      return [...out].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    },
    pages: () => live().size
  };
}
