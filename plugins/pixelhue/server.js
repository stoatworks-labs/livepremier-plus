/*
 * Pixelhue panel — the plugin's server half.  ** PREVIEW **
 *
 * A Pixelhue U-series console driven as a peer rather than as a keyboard.
 * `supervisor.js` argues at the top why it may hold a socket to the console
 * while holding nothing open on the switcher; this file only puts it on the
 * app. It is installation state like the OSC listener and the matrices — a
 * panel on the desk does not move when the app is re-pointed at a backup frame
 * — so it follows its settings and survives a change of switcher.
 *
 * Routes, under `/__lpp/pixelhue`:
 *
 *     GET  /state    the console link, the selection and recent commands
 *     GET  /stream   server-sent `panel` events as the console reports them
 *
 * ## Present, and active
 *
 * The plugin switch says whether any of this exists; the plugin's own setting,
 * "Drive a Pixelhue console" (`pixelhueEnabled`), says whether it dials the
 * console while it does. The second starts off: this has never been run against
 * a console, and it writes to a switcher.
 */

import { PixelhueSupervisor } from './supervisor.js';
import { normalisePixelhue, pixelhueChanged } from './core.js';

/**
 * The settings schema. `legacy` names where these fields were kept before
 * plugins had a namespace — at the top level of `settings.json` — so an older
 * file, an older setup file or a caller still sending the old shape keeps
 * working. See `core/settings.js`.
 */
export const settings = {
  normalise: normalisePixelhue,
  changed: pixelhueChanged,
  legacy: ['pixelhueEnabled', 'pixelhueHost', 'pixelhueModel'],
};

export default async function activate(ctx) {
  const panel = new PixelhueSupervisor({
    /* Read per use: the switcher can be re-pointed under a panel that is
       already talking. Host only — the supervisor dials AWJ's own port. */
    deviceHost: () => {
      const device = ctx.device();
      return device ? String(device).split(':')[0] : null;
    },
    log: ctx.log,
  });

  /* Every report from the console, to whichever settings page is open. The
     page used to learn about the link only when it next saved a setting. */
  const live = ctx.stream('/stream', { onOpen: (first) => first.send('panel', panel.describe()) });
  panel.on('activity', () => live.send('panel', panel.describe()));

  ctx.route('GET', '/state', (req, res, h) => h.json(200, panel.describe()));

  /* Only on a change `pixelhueChanged` cares about — `apply` is diff-based as
     well, but a save of an unrelated setting should not even ask. */
  ctx.settings.onChange((next) => panel.apply(next));
  /* The console holds an upgraded socket and a reconnect timer; a Stop button
     that went on dialling a panel would be the bug `proxy.js` already paid for. */
  ctx.onDispose(() => panel.stop());

  await panel.apply(ctx.settings.get());
}
