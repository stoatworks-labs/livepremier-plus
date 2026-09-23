/*
 * Hello, switcher — the server half of an example plugin.
 *
 * Copy this folder into the plugins folder of the app's data directory
 * (`~/.livepremier-plus/plugins/`, or `/config/plugins/` in Docker), restart
 * the app, and switch it on in Preconfig ▸ LivePremier Plus → Plugins.
 * docs/PLUGINS.md is the reference for everything `ctx` offers.
 *
 * Importing this file must do nothing by itself: all of it happens in
 * `activate`, which the app calls when the plugin is switched on — and undoes,
 * route by route, when it is switched off.
 */

/**
 * The plugin's settings. `normalise` is handed whatever is stored — possibly
 * nothing, possibly something a person edited by hand — and returns something
 * valid. Correct a bad field rather than refusing it.
 */
export const settings = {
  normalise: (raw) => ({
    greeting: typeof raw.greeting === 'string' && raw.greeting.trim()
      ? raw.greeting.trim().slice(0, 64)
      : 'Hello',
  }),
};

export default function activate(ctx) {
  /* GET /__lpp/hello-switcher/hello */
  ctx.route('GET', '/hello', (req, res, h) => h.json(200, {
    greeting: ctx.settings.get().greeting,
    /* Read per use: the app can be pointed at another switcher at any time. */
    switcher: ctx.device(),
  }));

  /* GET /__lpp/hello-switcher/ticks — the time, once a second, to every page
     listening. `size` says whether anybody is, so nothing is sent to nobody. */
  const ticks = ctx.stream('/ticks');
  const timer = setInterval(() => {
    if (ticks.size) ticks.send('tick', { at: new Date().toISOString() });
  }, 1000);
  /* Anything the plugin holds that the app cannot see — a timer, a socket —
     is let go here. Routes and streams are taken down by the app itself. */
  ctx.onDispose(() => clearInterval(timer));

  ctx.settings.onChange((next) => ctx.log(`greeting is now “${next.greeting}”`));

  /* OSC addresses under /hello/ — answered over UDP, and from a line typed in
     the Console, by this one handler. Return null for an address you do not
     recognise, and it falls through to the switcher's own grammar. */
  ctx.contribute('oscAddress', {
    prefix: '/hello/',
    describe: '/hello/ping answers with the greeting',
    handle(address) {
      if (address !== '/hello/ping') return null;
      return { ok: true, summary: `${ctx.settings.get().greeting}, ${ctx.device() || 'switcher'}` };
    }
  });

  ctx.log('started');
}
