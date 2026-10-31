/*
 * Source thumbnails over a thin link — the proxy's own, always on.
 *
 * ## The cliff
 *
 * The Web RCS asks for every source's thumbnail about once a second, and each
 * time it asks it points the `<img>` at a new URL (`?<epoch-ms>`). A browser
 * handed a new URL for an image that is still loading drops the old load. So a
 * thumbnail that takes longer than a second to arrive is never drawn: not
 * late, never. And when the pictures on a page together need more than the
 * link carries, every load takes longer than a second and none is drawn at
 * all. Measured 2026-10-31 on an Aquilon C mini over a 400 KB/s link: eight
 * inputs at 148 KB, fifteen seconds, every load cut off at 1000 ms and not one
 * new frame drawn, though the link could have carried nearly three a second.
 * On a LAN it never shows. Over a tailnet (a DERP relay, a subnet router, a
 * venue's uplink) it is the first thing that does.
 *
 * ## What this does about it
 *
 * Answers the page in time. Each ask starts a fetch from the switcher, or
 * joins the one already on its way, and waits up to `waitMs` for it. If the
 * switcher has not answered by then, the page gets the last whole frame this
 * kept and the fetch carries on, so the next ask has it. One fetch per source
 * at a time, so a slow link is asked for what it can carry and no more: each
 * source refreshes as often as the link allows, instead of never.
 *
 * On a LAN the switcher answers well inside `waitMs` and every page gets the
 * frame it asked for, as before.
 *
 * Only the four kinds the vendor's poller refreshes are kept: inputs,
 * outputs, multiviewers and timers. Stills and library images are drawn once
 * per version and must never be answered from an older one.
 *
 * ## What it will not do
 *
 * Hand out a picture it cannot vouch for. A frame older than `staleMs`, a
 * fetch that failed, or an answer that is not a picture drops what is kept for
 * that source, and the page waits for the switcher as it always did. A dead
 * link must not leave frozen thumbnails that look live.
 *
 * The Thumbnail relay, when it is on, answers these requests itself and this
 * is not asked (`server/proxy.js`).
 */

import http from 'node:http';

/** The snapshots the vendor's poller refreshes: `/api/device/snapshots/<kind>/<n>`. */
export const KEPT_SNAPSHOT = /^\/api\/device\/snapshots\/(?:inputs|outputs|multiviewers|timers)\/\d{1,4}$/;

export const DEFAULTS = Object.freeze({
  /* Well inside the vendor's one-second swap, with room left for the frame
     to cross to the browser. */
  waitMs: 300,
  /* A frame this young answers a second page, or a card and a layer showing
     the same input, without asking the switcher again. */
  shareMs: 500,
  /* Past this a kept frame is no longer offered. Thirty sources at 148 KB
     over 400 KB/s come round every eleven seconds. */
  staleMs: 30_000,
  /* A source nobody has asked about for this long is forgotten, frame and all. */
  forgetMs: 60_000
});

/* Headers from the page that the switcher may care about: a switcher with a
   password set keys its session on the cookie. */
const FORWARD = ['cookie', 'authorization', 'user-agent', 'accept-language'];
/* No thumbnail is this big. Anything that is gets passed on, not kept. */
const MAX_KEPT = 8 * 1024 * 1024;

/**
 * The bookkeeping, with the fetch handed in, so it can be tested against a
 * scripted switcher.
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now]
 * @param {number} [opts.waitMs]
 * @param {number} [opts.shareMs]
 * @param {number} [opts.staleMs]
 * @param {number} [opts.forgetMs]
 */
export function createKeeper({ now = Date.now, ...opts } = {}) {
  const { waitMs, shareMs, staleMs, forgetMs } = { ...DEFAULTS, ...opts };
  const entries = new Map();

  function forget(t) {
    for (const [key, e] of entries) if (!e.inflight && t - e.asked > forgetMs) entries.delete(key);
  }

  function refresh(e, fetchFrame) {
    let started;
    try { started = Promise.resolve(fetchFrame()); }
    catch (err) { started = Promise.reject(err); }
    const p = started
      .then((r) => {
        const keep = r.status === 200 && /^image\//.test(r.type || '') && r.body.length <= MAX_KEPT;
        e.kept = keep ? { ...r, at: now() } : null;
        return r;
      }, (err) => {
        e.kept = null;
        throw err;
      })
      .finally(() => { e.inflight = null; });
    /* Whoever was waiting may have been answered from the kept frame already. */
    p.catch(() => {});
    return p;
  }

  /**
   * A thumbnail for one page: `{ status, type, lastModified, body, via }`,
   * `via` saying where it came from — `fresh` (the switcher, in time),
   * `shared` (a frame younger than `shareMs`) or `kept` (the last whole frame,
   * the switcher being slower than `waitMs`). Throws when the switcher could
   * not be reached and there is nothing to offer instead.
   *
   * @param {string} key  one source as one client sees it: switcher, path, credentials
   * @param {() => Promise<{status: number, type: string, lastModified?: string, body: Buffer}>} fetchFrame
   */
  async function get(key, fetchFrame) {
    const t = now();
    forget(t);
    let e = entries.get(key);
    if (!e) { e = { kept: null, inflight: null, asked: t }; entries.set(key, e); }
    e.asked = t;

    const kept = e.kept && t - e.kept.at <= staleMs ? e.kept : null;
    if (kept && t - kept.at <= shareMs) return answer(kept, 'shared');

    const fetching = e.inflight || (e.inflight = refresh(e, fetchFrame));
    if (!kept) return answer(await fetching, 'fresh');

    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(resolve, waitMs, null); });
    try {
      const r = await Promise.race([fetching, late]);
      return r ? answer(r, 'fresh') : answer(kept, 'kept');
    } finally {
      clearTimeout(timer);
    }
  }

  function answer(r, via) {
    const { at, ...out } = r;
    return { ...out, via };
  }

  return {
    get,
    /** Forget everything: the app has been pointed at another switcher. */
    clear: () => entries.clear(),
    size: () => entries.size
  };
}

/** The part of a request that decides whose frame it is: one browser's session. */
export function keyOf(device, path, headers = {}) {
  return [device, path, headers.cookie || '', headers.authorization || ''].join('\n');
}

/**
 * One thumbnail off the switcher, whole.
 *
 * @param {object} opts
 * @param {{host: string, port: number}} opts.target
 * @param {string} opts.hostHeader  what the switcher is told it is called
 * @param {string} opts.path        the page's own path and query
 * @param {object} opts.headers     the page's request headers
 * @param {http.Agent} opts.agent
 * @param {number} [opts.idleMs]    how long the link may go quiet mid-frame
 */
export function fetchFrame(opts) {
  return fetchOnce(opts).catch((err) => {
    /*
     * The switcher closes a kept-alive socket five idle seconds after it has
     * sent the last byte, and over a slow link that byte reaches this end
     * seconds later — so the agent can hand out a socket the switcher has
     * already closed. Seen 2026-10-31 through a 400 KB/s link to a C mini:
     * about one fetch in two hundred. Once more on a socket of its own; a
     * reset there is the link, not the race.
     */
    if (err.staleSocket) return fetchOnce({ ...opts, agent: false });
    throw err;
  });
}

function fetchOnce({ target, hostHeader, path, headers, agent, idleMs = 20_000 }) {
  const out = { host: hostHeader };
  for (const k of FORWARD) if (headers[k]) out[k] = headers[k];
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = http.get({ host: target.host, port: target.port, path, agent, headers: out, timeout: idleMs }, (res) => {
      answered = true;
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        type: res.headers['content-type'] || 'application/octet-stream',
        lastModified: res.headers['last-modified'],
        body: Buffer.concat(chunks)
      }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`nothing from the switcher for ${idleMs / 1000} s`)));
    req.on('error', (err) => {
      if (req.reusedSocket && !answered && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) err.staleSocket = true;
      reject(err);
    });
  });
}
