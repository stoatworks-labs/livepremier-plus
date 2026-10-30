/*
 * grandMA3 — the plugin's server half.  ** PREVIEW **
 *
 * A grandMA3 desk, or grandMA3 onPC with a command or fader wing, driving the
 * switcher from its own executors. The desk is left doing what it does: its
 * OSC line sends playback feedback (Menu ▸ In & Out ▸ OSC, **Send** on,
 * Prefix `ma3`) to this app's OSC input, and every message under `/ma3/`
 * comes here. `core.js` says what a message means and what a mapping line
 * does with it; `bridge.js` does it.
 *
 * Why not drive the wing itself, as the Barco EC and ATEM panels are driven:
 * an MA onPC wing is what unlocks the desk's parameters, its USB protocol is
 * unpublished, and a wing that answered any host would be a key anyone could
 * copy. The desk already turns the wing into OSC. docs/GRANDMA3.md has the
 * research.
 *
 * Routes, under `/__lpp/grandma3`:
 *
 *     GET  /state    the lines, what has been heard, what was sent
 *     GET  /stream   server-sent `ma3` events as they happen
 *
 * ## It needs OSC input
 *
 * This answers an address subtree of the OSC listener; it has no socket of
 * its own. So OSC input must be on, bound where the desk can reach it — the
 * loopback default only hears an onPC on this machine.
 */

import { createOscDispatcher } from '../../server/osc.js';
import { ConsoleSwitcher } from '../../server/console-switcher.js';
import { Grandma3Bridge } from './bridge.js';
import { PREFIX, GRANDMA3_OSC, normaliseGrandma3 } from './core.js';

export const settings = {
  normalise: normaliseGrandma3,
};

/** What a variable in a written value answers while the Variables plugin is off. */
const VARIABLES_OFF = () => ({ ok: false, error: 'the Variables plugin is switched off' });

export default function activate(ctx) {
  const dispatcher = createOscDispatcher({
    /* Read per message, as the OSC listener does: re-pointing the app at a
       backup frame re-points the desk with it. */
    deviceHost: () => ctx.device(),
    awj: ctx.awj,
    /* Every other plugin's subtree, never this one's: a line cannot send back
       into `/ma3/` (`core.js` refuses it too), and a loop here would be a desk
       feeding itself through a switcher. */
    addresses: () => ctx.contributions('oscAddress').filter((c) => c.owner !== ctx.id),
    variables: async () => {
      const service = ctx.use('variables');
      return service ? service.resolver() : VARIABLES_OFF;
    },
    log: ctx.log,
  });

  const bridge = new Grandma3Bridge({
    dispatch: (msg) => dispatcher.dispatch(msg),
    switcher: new ConsoleSwitcher({
      /* The consoles' way: the host without the web port, AWJ on its own. */
      deviceHost: () => {
        const device = ctx.device();
        return device ? String(device).split(':')[0] : null;
      },
    }),
    log: ctx.log,
  });

  ctx.contribute('oscAddress', {
    prefix: PREFIX,
    describe: 'grandMA3 playback feedback, mapped to this app’s addresses',
    entries: GRANDMA3_OSC,
    handle: (address, args, meta) => bridge.handle(address, args, meta),
  });

  const live = ctx.stream('/stream', { onOpen: (first) => first.send('ma3', bridge.describe()) });
  bridge.on('activity', () => live.send('ma3', bridge.describe()));

  ctx.route('GET', '/state', (req, res, h) => h.json(200, bridge.describe()));

  ctx.settings.onChange((next) => { bridge.apply(next); });
  ctx.onDispose(() => bridge.stop());

  bridge.apply(ctx.settings.get());
}
