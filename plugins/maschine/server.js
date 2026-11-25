/*
 * Maschine — the plugin's server half.  ** PREVIEW **
 *
 * A Native Instruments Maschine MK3 plugged into the machine this app runs
 * on, driving the switcher with no browser open: its pads, group keys, knobs
 * and touch strip given a switcher's meaning, its two screens showing what
 * they do. The panel is held by the device host (`devices/modules/maschine-mk3/`);
 * `supervisor.js` gives its controls their meaning and `core.js` draws it.
 * This file only puts it on the app.
 *
 * Routes, under `/__lpp/maschine`:
 *
 *     GET  /state      the panel, the selection, tally, the knobs' values and recent presses
 *     GET  /stream     server-sent `panel` events as they happen
 *
 * "Drive a Maschine" (`maschineEnabled`) says whether this takes the panel,
 * and starts off: it has never been run against a panel and it writes to a
 * switcher.
 */

import { MaschineSupervisor } from './supervisor.js';
import { normaliseMaschine, maschineChanged } from './core.js';

export const settings = {
  normalise: normaliseMaschine,
  changed: maschineChanged,
};

export default async function activate(ctx) {
  const panel = new MaschineSupervisor({
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
  /* Lets the panel go, dark, for Maschine 2 or whatever has it next. */
  ctx.onDispose(() => panel.stop());

  await panel.apply(ctx.settings.get());
}
