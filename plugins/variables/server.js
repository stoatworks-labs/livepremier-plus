/*
 * Variables — the plugin's server half: where the user variables are kept,
 * and the resolver the OSC listener asks.
 *
 * `@gap = 40` is written against one switcher's rig — a gap between two walls,
 * the width of a column on that screen — so the definitions are kept per
 * switcher, in `variables-<switcher>.json` beside the cue stack and the layer
 * names, and travel in the setup file under `show`. The `{ data }` shape at
 * `/__lpp/variables` is the one `server/documents.js` serves for the others;
 * it is written out here only so a save can be normalised on the way in and
 * the resolver below can drop what it had cached.
 *
 * ## Over OSC: user variables yes, system variables no
 *
 * This process holds no store mirror — `server/awj.js` says why it must not —
 * so it cannot know a canvas width or which buffer is program. The `variables`
 * service it provides therefore answers `@` names whose definitions reach only
 * numbers and other `@` names, and refuses every `$` name with that reason:
 * the same asymmetry as `preview` and `program` in `server/osc.js`, and for
 * the same reason. `@gap` in a QLab cue follows the panel; `$S1.width` in one
 * is refused rather than guessed. See `docs/VARIABLES.md`.
 *
 * Reads only. Nothing here writes to a switcher.
 */

import { normalise, storelessResolver } from './core.js';

/** A few hundred short definitions at most. */
const LIMIT = 128 * 1024;
const DOC = 'variables';

export default function activate(ctx) {
  const store = () => {
    if (!ctx.storage) throw new ctx.HttpError(501, 'no storage configured');
    return ctx.storage;
  };

  /* The OSC listener asks per message, so the document is held — for the
     switcher it was read for, and dropped the moment a save or a restore
     changes it. */
  let cached = null;   // { device, doc }
  const forget = () => { cached = null; };

  async function current() {
    const device = ctx.device();
    if (cached && cached.device === device) return cached.doc;
    const doc = ctx.storage ? normalise(await ctx.storage.load(DOC, { perDevice: true })) : normalise(null);
    cached = { device, doc };
    return doc;
  }

  ctx.route('GET', '/', async (req, res, h) => {
    h.json(200, { data: await store().load(DOC, { perDevice: true }) });
  });

  const save = async (req, res, h) => {
    const storage = store();
    /* An empty body is refused rather than saved: it would wipe the document. */
    const raw = await h.readBody(LIMIT);
    let parsed;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new ctx.HttpError(400, 'invalid JSON'); }
    const doc = normalise(parsed && parsed.data !== undefined ? parsed.data : parsed);
    await storage.save(DOC, doc, { perDevice: true });
    forget();
    h.json(200, { ok: true, data: doc });
  };
  ctx.route('PUT', '/', save);
  ctx.route('POST', '/', save);

  /* The setup file: a section under `show`, restored onto whichever switcher
     the file is restored for. Written out rather than `documentSection`, so a
     restore drops the cached copy the OSC listener reads. */
  ctx.contribute('configSection', {
    key: DOC,
    group: 'show',
    label: 'Variables',
    perDevice: true,
    async export(device) {
      if (!ctx.storage) return undefined;
      const data = await ctx.storage.load(DOC, { perDevice: true, device });
      const doc = data ? normalise(data) : null;
      return doc && doc.variables.length ? doc : undefined;
    },
    async import(data, device) {
      if (!ctx.storage) throw new Error('no storage configured');
      await ctx.storage.save(DOC, normalise(data), { perDevice: true, device });
      forget();
    }
  });

  ctx.provide('variables', Object.freeze({
    /**
     * A resolver over the user variables of the switcher the app points at
     * now, in the shape mynah's `vars` takes. `$` names are refused with the
     * reason — this process has no store. Async because the definitions may
     * have to be read; the resolver it hands back is not.
     */
    async resolver() {
      const doc = await current();
      return storelessResolver(doc.variables);
    }
  }));

  ctx.onDispose(forget);
}
