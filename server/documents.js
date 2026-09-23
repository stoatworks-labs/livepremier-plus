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

/**
 * The same document as a section of the one-file setup — `configSection` in
 * `src/core/contributions.js`. Restored against the switcher the file is
 * restored onto, which need not be the one the app points at now.
 *
 * ⚠️ A page that is open while a file is restored still holds what it loaded;
 * its next save would put that back. The setup file says to reload open pages
 * after a restore, and that is the whole of the defence for now.
 *
 * @param {object} ctx
 * @param {string} name   the document, as `ctx.storage` names it
 * @param {{key?: string, group: string, label: string, empty?: (data) => boolean}} spec
 *        `key` is the section's name in the file, `name` by default; `empty`
 *        says when there is nothing worth writing.
 */
export function documentSection(ctx, name, { key = name, group, label, empty = (data) => !data } = {}) {
  ctx.contribute('configSection', {
    key,
    group,
    label,
    perDevice: true,
    async export(device) {
      if (!ctx.storage) return undefined;
      const data = await ctx.storage.load(name, { perDevice: true, device });
      return empty(data) ? undefined : data;
    },
    async import(data, device) {
      if (!ctx.storage) throw new Error('no storage configured');
      await ctx.storage.save(name, data, { perDevice: true, device });
    }
  });
}
