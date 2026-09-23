/*
 * The setup file — everything this app holds, in one document, and back.
 *
 * `livepremier-plus.json`: the cue stack, the layer groups and names, the
 * routers and the patch to them, and the app's settings — the half of a rig a
 * switcher's own `.awc` does not carry. `server/config-file.js` is the format
 * and argues its three judgements (an absent section is not an empty one;
 * settings are not restored unless asked for; a restore lands on the switcher
 * it is told to, not the one it came from).
 *
 * The sections are not this plugin's. Each belongs to the feature that holds
 * it, contributed as a `configSection` — the Timeline's `stack`, Matrix
 * Routing's `matrices` and `patch`, and any a plugin of somebody else's adds —
 * so a restore goes into the running feature as well as its file. The app's
 * settings come through the `app` service, for the same reason. A section
 * whose plugin is switched off is neither written nor restored: off means
 * absent, and a restore reports it as skipped.
 *
 *   GET  /__lpp/config               the document; ?download=1 to save it
 *   POST /__lpp/config               `{ doc, sections?, device? }` restores one
 *   POST /__lpp/config/inspect       what a restore would do, without doing it
 *
 * ⚠️ A page open while a file is restored still holds what it loaded — a
 * cue stack, the groups — and its next save puts that back. Reload open pages
 * after a restore; the answer to a restore says so.
 */

import {
  buildConfig, applyConfig, summarise, validate, defaultImport, SECTIONS
} from '../../server/config-file.js';

/** A setup file carries a show; eight megabytes is far more than any has needed. */
const LIMIT = 8 * 1024 * 1024;

export default function activate(ctx) {
  /* The app's settings, as a section like the rest. Merged on restore, not
     replaced — an older file has fewer keys than this build knows — and never
     restored unless asked for by name: it carries the OSC port. */
  const settingsSection = (app) => ({
    key: 'settings',
    ...SECTIONS.settings,
    perDevice: false,
    byDefault: false,
    export: async () => {
      const s = app.settings();
      return s && Object.keys(s).length ? s : undefined;
    },
    import: (value) => app.applySettings(value)
  });

  const sections = () => {
    const app = ctx.use('app');
    return [...(app ? [settingsSection(app)] : []), ...ctx.contributions('configSection')];
  };
  const needStorage = () => {
    const app = ctx.use('app');
    if (!app || !app.hasStorage) throw new ctx.HttpError(501, 'no storage configured');
    return app;
  };
  /* Accept the document bare or wrapped: a file dropped on a page and a call
     from our own UI arrive in different shapes. */
  const unwrap = (parsed) => (parsed && parsed.doc !== undefined ? parsed.doc : parsed);

  ctx.route('GET', '/', async (req, res, h) => {
    const app = needStorage();
    const doc = await buildConfig({
      sections: sections(),
      deviceKey: ctx.device(),
      appVersion: app.version,
      deviceInfo: { platform: app.platform() }
    });
    if (h.url.searchParams.get('download')) {
      const buf = Buffer.from(JSON.stringify(doc, null, 2));
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="livepremier-plus.json"',
        'content-length': buf.length,
        'cache-control': 'no-store'
      });
      res.end(buf);
      return;
    }
    h.json(200, { doc, summary: summarise(doc) });
  });

  const restore = async (req, res, h) => {
    needStorage();
    const parsed = await h.readJson(LIMIT);
    try {
      const report = await applyConfig({
        providers: sections(),
        deviceKey: (parsed && parsed.device) || ctx.device(),
        doc: unwrap(parsed),
        sections: parsed && parsed.sections
      });
      h.json(200, {
        ok: true,
        ...report,
        /* Said in the answer, because the person restoring is not always the
           person with a page open. */
        reloadPages: report.applied.some((k) => k !== 'settings')
      });
    } catch (err) {
      throw new ctx.HttpError(400, err.message);
    }
  };
  ctx.route('POST', '/', restore);
  ctx.route('PUT', '/', restore);

  const inspect = async (req, res, h) => {
    const doc = unwrap(await h.readJson(LIMIT));
    const problem = validate(doc);
    if (problem) throw new ctx.HttpError(400, problem);
    h.json(200, { summary: summarise(doc), defaultSections: defaultImport(sections()), device: ctx.device() });
  };
  ctx.route('POST', '/inspect', inspect);
  ctx.route('PUT', '/inspect', inspect);
}
