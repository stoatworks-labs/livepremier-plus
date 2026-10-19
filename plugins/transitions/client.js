/*
 * Transitions — the plugin's page half (experimental).
 *
 * A tab on Screens / Aux. for one destination at a time: every fitted layer's
 * opening and closing effect and direction, and its timing windows shown in
 * seconds against the screen's take time instead of the switcher's 0–65535.
 * Effects applied to several layers at once, kept as named styles, and the
 * moves the switcher does not have — a wipe across the whole screen, a
 * cascade, a dip through the background — worked out from where the layers
 * sit (`src/core/transitions.js`).
 *
 * Every write is a click. Nothing here follows a recall or holds a take, so
 * there is no gate and no follower: what is written sits in the buffer until
 * the next take reads it, from whichever button that take comes — the front
 * panel's and a T-bar's included, which Layer Lock's "take only" cannot say.
 *
 * Experimental, and a plugin of its own: the switcher takes and reports all
 * of it, and no frame has been seen to show any of it. `docs/NOTES.md`
 * (2026-10-19) has what has been run and what only a frame can answer.
 */

import { normaliseStyles } from '../../src/core/transitions.js';
import { createTransitionsPanel } from './panel.js';

export default function activate(ctx) {
  let doc = normaliseStyles(null);

  async function load() {
    try {
      const res = await fetch(ctx.url('/'), { cache: 'no-store' });
      if (res.ok) doc = normaliseStyles((await res.json()).data);
    } catch (err) {
      ctx.log.warn('could not load the transition styles', err);
    }
    ctx.refresh();
  }

  async function save() {
    try {
      await fetch(ctx.url('/'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: doc })
      });
    } catch (err) {
      /* The styles stand on this page whatever the save did; the next change retries. */
      ctx.log.warn('could not save the transition styles', err);
    }
  }

  const view = createTransitionsPanel({
    session: ctx.session,
    styles: () => doc,
    setStyles(next) { doc = normaliseStyles(next); void save(); ctx.refresh(); },
    names: () => (ctx.use('names') ? ctx.use('names').get() : {}),
    onRefresh: ctx.refresh
  });

  ctx.ui.tab({
    id: 'transitions',
    label: 'Transitions',
    short: 'Trans',
    /* Not `rc400t-transition`: that id is a 160×21 drawing of the RC400T's
       panel, and draws as a blank sliver at icon size. */
    icon: ['fade-out-18', 'fade-to-black-18', 'fade-in-12'],
    order: 35,
    render: () => view.render(),
    busy: () => view.busy()
  });

  void load();
}
