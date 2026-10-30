/*
 * Desk control — the plugin's server half.  ** PREVIEW **
 *
 * A lighting desk driving the switcher over Art-Net or sACN, with no browser
 * open. `supervisor.js` does it and argues how; this puts it on the app.
 *
 * Routes, under `/__lpp/desk-control`:
 *
 *     GET  /state            the patch, the sockets, who is in control, recent events
 *     GET  /stream           server-sent `desk` events as they happen
 *     GET  /gdtf/<kind>      the fixture file for master, screen or layer
 *     GET  /patch.csv        the patch, for a desk's import or a printout
 *
 * ## Present, and active
 *
 * The plugin switch says whether any of this exists; "Listen for a lighting
 * desk" (`deskEnabled`) says whether it opens the ports. That starts off: it
 * listens on the network, which nothing else in this app does by default, and
 * it writes to a switcher.
 */

import { DeskSupervisor } from './supervisor.js';
import { normaliseDesk, deskChanged } from './core.js';
import { patchCsv } from '../../src/core/dmx-personality.js';
import { gdtfFile, gdtfName, FIXTURE_KINDS } from '../../src/core/desk-gdtf.js';

export const settings = {
  normalise: normaliseDesk,
  changed: deskChanged,
};

/* The fixture files' revision. Bumped whenever a channel moves, so a desk's
   library keeps both and an old show file still finds its own. */
export const GDTF_VERSION = '1';

export default async function activate(ctx) {
  const desk = new DeskSupervisor({
    deviceHost: () => {
      const device = ctx.device();
      return device ? String(device).split(':')[0] : null;
    },
    timecode: () => ctx.use('timecode'),
    log: ctx.log,
  });

  const live = ctx.stream('/stream', { onOpen: (first) => first.send('desk', desk.describe()) });
  /* A desk sends 44 frames a second; the card does not need to hear of each. */
  let pending = null;
  desk.on('activity', () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; live.send('desk', desk.describe()); }, 200);
    pending.unref?.();
  });

  ctx.route('GET', '/state', (req, res, h) => h.json(200, desk.describe()));

  for (const kind of FIXTURE_KINDS) {
    ctx.route('GET', `/gdtf/${kind}`, (req, res) => {
      const buf = Buffer.from(gdtfFile(kind, { version: GDTF_VERSION }));
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${gdtfName(kind, GDTF_VERSION)}"`,
        'content-length': buf.length,
        'cache-control': 'no-store',
      });
      res.end(buf);
    });
  }

  ctx.route('GET', '/patch.csv', (req, res) => {
    const buf = Buffer.from(patchCsv(desk.patch.fixtures), 'utf8');
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="livepremier-plus-patch.csv"',
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    res.end(buf);
  });

  ctx.settings.onChange((next) => { void desk.apply(next); });
  ctx.onDispose(() => {
    clearTimeout(pending);
    desk.stop();
  });

  await desk.apply(ctx.settings.get());
}
