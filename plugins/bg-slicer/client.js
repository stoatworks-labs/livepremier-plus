/*
 * Background Slicer — the plugin's page half.
 *
 * PLUS ▸ Background Slicer: one picture cut into a background per output across
 * one or more screens, put into the image library and a background set — or,
 * in the live-input mode, each output's background fed from an input and the
 * map a media server needs to feed it, as files Resolume, disguise, Pixera,
 * Hippotizer, Millumin and TouchDesigner can load and a pixel-map pack for
 * the rest. `docs/BACKGROUNDS.md` is the design and what is proven.
 *
 * A sidebar entry under PLUS, like the VPU map and the memory banks: a
 * background set spans a screen's outputs and a picture may span screens, so
 * it belongs to no one screen's tab. It pops out (`popout.html`) because a
 * placement view wants the room; the job — the picture, the placement, what
 * was generated — is shared with that window (`ctx.share`), so both are views
 * of one job.
 *
 * Everything happens here in the page: the cuts are drawn in a canvas, the
 * images go to the switcher over its own upload route through this page's
 * origin, and every other write rides the page's socket — so there is no
 * server half: the server keeps no mirror (AGENTS.md, "Ride the app's
 * socket"), and nothing here needs one.
 *
 * ⚠️ Preview, off by default: the switcher's side was proved on a LivePremier
 * Simulator 6.2.73, never on a frame (see `test/plugins.test.js`'s
 * OFF_UNTIL_TESTED).
 */

import { createBgSlicerPanel } from './panel.js';
import { createJob } from './job.js';

export default function activate(ctx) {
  const job = createJob();
  const view = createBgSlicerPanel({ session: ctx.session, job, onRefresh: ctx.refresh });
  ctx.ui.sidebar({
    id: 'bg-slicer',
    /* Not "Backgrounds": Web RCS has a Preconfig ▸ Backgrounds page of its
       own, and two entries with one name is one too many. */
    label: 'Background Slicer',
    icon: ['background-18', 'layer-background-18', 'stills-18'],
    order: 57,
    render: () => view.render(),
    /* Holds repaints off while the picture is being dragged. */
    busy: () => view.busy()
  });
  ctx.share({ job });
}
