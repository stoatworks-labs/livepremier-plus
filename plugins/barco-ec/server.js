/*
 * Barco EC panel — the plugin's server half.  ** PREVIEW **
 *
 * An EC-30, EC-40 or EC-50 plugged into the machine this app runs on, driving
 * the switcher with no browser open. The panel is held by the device host
 * (`devices/modules/barco-ec/`); `supervisor.js` gives its keys a meaning and
 * argues why that happens here rather than in a page. This file only puts it
 * on the app.
 *
 * Routes, under `/__lpp/barco-ec`:
 *
 *     GET  /state    the panel, the selection, the pages and recent presses
 *     GET  /stream   server-sent `panel` events as they happen
 *
 * ## Present, and active
 *
 * The plugin switch says whether any of this exists; "Drive a Barco EC panel"
 * (`barcoEcEnabled`) says whether it takes the panel. That starts off: it has
 * never been run against a panel, it writes to a switcher, and while it holds
 * the panel the Event Master Toolset cannot have it.
 */

import { BarcoEcSupervisor } from './supervisor.js';
import { normaliseBarcoEc, barcoEcChanged } from './core.js';

export const settings = {
  normalise: normaliseBarcoEc,
  changed: barcoEcChanged,
};

export default async function activate(ctx) {
  const panel = new BarcoEcSupervisor({
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

  ctx.settings.onChange((next) => { void panel.apply(next); });
  /* Lets the panel go, dark, so the Toolset can have it. */
  ctx.onDispose(() => panel.stop());

  await panel.apply(ctx.settings.get());
}
