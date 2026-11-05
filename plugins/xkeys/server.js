/*
 * X-keys — the plugin's server half.  ** PREVIEW **
 *
 * An X-keys panel plugged into the machine this app runs on, its keys given
 * jobs on the card, driving the switcher with no browser open. The panel is
 * held by the device host (`devices/modules/xkeys/`); `supervisor.js` gives
 * its keys their meaning and argues why that happens here rather than in a
 * page. This file only puts it on the app.
 *
 * Routes, under `/__lpp/xkeys`:
 *
 *     GET  /state      the panel, its layout, the selection, tally and recent presses
 *     GET  /stream     server-sent `panel` events as they happen
 *
 * The layouts are settings (`xkeysLayouts`, per model), saved from the card
 * like any other; "Drive an X-keys" (`xkeysEnabled`) says whether this takes
 * the panel, and starts off.
 */

import { XKeysSupervisor } from './supervisor.js';
import { normaliseXkeys, xkeysChanged } from './core.js';

export const settings = {
  normalise: normaliseXkeys,
  changed: xkeysChanged,
};

export default async function activate(ctx) {
  const panel = new XKeysSupervisor({
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
  /* Lets the panel go, dark, for whatever has it next. */
  ctx.onDispose(() => panel.stop());

  await panel.apply(ctx.settings.get());
}
