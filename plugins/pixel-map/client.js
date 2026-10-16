/*
 * Pixel Map — the plugin's page half.
 *
 * An image from the switcher's own library laid over a screen's canvas on the
 * Screens / Aux. page, so the operator programming preview sees what of each
 * layer the LED wall will actually show. No layer is spent on it and nothing
 * is written to the switcher; the map lives in this tab and in a per-switcher
 * document on this app (`server.js`). See `core.js` for the modes and fits,
 * and `overlay.js` for where in the vendor's card it goes and why it never
 * takes a click.
 *
 * The plan is worked out from the mirror on every frame — a new upload into
 * the library, a canvas resized in the preconfig — and from the document
 * whenever the panel changes it.
 */

import { dialectFor } from '../../src/core/dialect.js';
import { listDestinations } from '../../src/core/screens.js';
import { normalise, plan, rolesFor } from './core.js';
import { installPixelMaps } from './overlay.js';
import { createPixelMapPanel } from './panel.js';

export default function activate(ctx) {
  const store = ctx.session.store;
  let doc = normalise(null);
  let timer = null;

  async function load() {
    try {
      const res = await fetch(ctx.url('/'), { cache: 'no-store' });
      if (res.ok) doc = normalise((await res.json()).data);
    } catch (err) {
      ctx.log.warn('could not load the pixel maps', err);
    }
  }

  async function save() {
    try {
      await fetch(ctx.url('/'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: doc })
      });
    } catch (err) {
      /* The map stands on this page whatever the save did; the next change retries. */
      ctx.log.warn('could not save the pixel maps', err);
    }
  }

  const images = () => {
    const dialect = dialectFor(store);
    return dialect && dialect.libraryImages ? dialect.libraryImages(store) : [];
  };
  const destinations = () => (store.ready ? listDestinations(store) : []);
  const current = () => (doc.visible ? plan(doc, destinations(), images()) : new Map());

  const overlay = installPixelMaps({
    plan: current,
    roles: () => rolesFor(doc.buffers),
    enabled: () => ctx.can('imageLibrary')
  });

  /* The panel's status line reads what the overlay drew, which is only known
     after its sweep — so the panel is repainted once more, shortly after. */
  function settle() {
    clearTimeout(timer);
    timer = setTimeout(() => { overlay.sweepNow(); ctx.refresh(); }, 50);
  }

  const view = createPixelMapPanel({
    doc: () => doc,
    change(next, { save: persist = true } = {}) {
      doc = normalise(next);
      overlay.refresh();
      settle();
      if (persist) void save();
    },
    destinations,
    images,
    plan: current,
    describe: () => overlay.describe(),
    ready: () => Boolean(store.ready)
  });

  ctx.session.addEventListener('frame', () => overlay.refresh());
  if (store.addEventListener) store.addEventListener('ready', () => { overlay.refresh(); settle(); });

  ctx.ui.tab({
    id: 'pixel-map',
    label: 'Pixel Map',
    short: 'Map',
    icon: ['mask-14', 'grid-3-14'],
    order: 50,
    render: () => view.render(),
    busy: () => view.busy()
  });

  void load().then(() => { overlay.refresh(); settle(); });
}
