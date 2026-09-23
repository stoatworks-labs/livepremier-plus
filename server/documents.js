/*
 * One JSON document, read and written over a plugin's own route.
 *
 * The shape three features had written out by hand in `proxy.js` — the cue
 * stack, the layer groups and the layer names: `GET` answers `{ data }`, `PUT`
 * (or `POST`) takes `{ data }` or the bare document, and the document is kept
 * per switcher, because each of them names one box's screens and layers and
 * means nothing pointed at another. The shape is an interface — a Companion
 * module reads the names this way — so it is written once, here, for the
 * built-ins that moved into plugins to share.
 */

/**
 * Serve one of a plugin's documents at `path` under its route base.
 *
 * @param {object} ctx  the plugin's server `ctx`
 * @param {string} name the document, as `ctx.storage` names it — `names`
 * @param {{perDevice?: boolean, limit?: number, path?: string}} [opts]
 *        `limit` is the largest body accepted, sized to what the document
 *        could plausibly hold.
 */
export function documentRoute(ctx, name, { perDevice = true, limit = 256 * 1024, path = '/' } = {}) {
  const store = () => {
    if (!ctx.storage) throw new ctx.HttpError(501, 'no storage configured');
    return ctx.storage;
  };

  ctx.route('GET', path, async (req, res, h) => {
    h.json(200, { data: await store().load(name, { perDevice }) });
  });

  const save = async (req, res, h) => {
    const storage = store();
    /* An empty body is refused rather than saved: it would wipe the document. */
    const raw = await h.readBody(limit);
    let parsed;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new ctx.HttpError(400, 'invalid JSON'); }
    await storage.save(name, parsed && parsed.data !== undefined ? parsed.data : parsed, { perDevice });
    h.json(200, { ok: true });
  };
  ctx.route('PUT', path, save);
  ctx.route('POST', path, save);
}
