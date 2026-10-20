/*
 * ATEM Micro Panel — the plugin's server half.  ** PREVIEW **
 *
 * An ATEM Micro Panel plugged into (or paired with) the machine this app runs
 * on, driving the switcher with no browser open. The panel is held by the
 * device host (`devices/modules/atem-micro-panel/`); `supervisor.js` gives its
 * keys a meaning and argues why that happens here rather than in a page. This
 * file only puts it on the app.
 *
 * Routes, under `/__lpp/atem-micro-panel`:
 *
 *     GET  /state      the panel, the selection, tally and recent presses
 *     GET  /stream     server-sent `panel` events as they happen
 *     POST /hot-cut    {on: bool} — the program row cuts to air, or is tally only
 *
 * ## Present, and active
 *
 * The plugin switch says whether any of this exists; "Drive an ATEM Micro
 * Panel" (`atemMicroEnabled`) says whether it takes the panel. That starts
 * off: it has never been run against a panel and it writes to a switcher.
 * "Program row cuts to air" is not saved at all — see `supervisor.js`.
 */

import { AtemMicroPanelSupervisor } from './supervisor.js';
import { normaliseAtemMicro, atemMicroChanged } from './core.js';

export const settings = {
  normalise: normaliseAtemMicro,
  changed: atemMicroChanged,
};

export default async function activate(ctx) {
  const panel = new AtemMicroPanelSupervisor({
    /* Read per use: the app can be re-pointed under a panel already in use. */
    deviceHost: () => {
      const device = ctx.device();
      return device ? String(device).split(':')[0] : null;
    },
    devices: () => ctx.use('devices'),
    log: ctx.log,
  });

  const live = ctx.stream('/stream', { onOpen: (first) => first.send('panel', panel.describe()) });
  panel.on('activity', () => live.send('panel', panel.describe()));

  ctx.route('GET', '/state', (req, res, h) => h.json(200, panel.describe()));
  ctx.route('POST', '/hot-cut', async (req, res, h) => {
    const body = await h.readJson(1024);
    try {
      h.json(200, panel.setHotCut(body.on === true));
    } catch (err) {
      h.json(409, { error: err.message });
    }
  });

  ctx.settings.onChange((next) => { void panel.apply(next); });
  /* Lets the panel go, dark, so ATEM Software Control can have it. */
  ctx.onDispose(() => panel.stop());

  await panel.apply(ctx.settings.get());
}
