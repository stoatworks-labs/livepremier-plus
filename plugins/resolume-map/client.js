/*
 * Resolume Mapping — the plugin's page half.
 *
 * Preconfig ▸ Resolume Mapping, directly beneath Canvas: the composition it
 * builds is the canvases, and an operator setting up a canvas is the one who
 * then has to tell the media server about it. From the screens chosen it
 * writes Resolume Arena's Advanced Output preset — one Arena output per
 * switcher output, each slice reading that output's rectangle of the
 * composition — and, if asked, puts the inputs those Arena outputs are
 * cabled into into a background set, with each plug's EDID loaded for its
 * output's format. `core.js` is the model; `apply.js` the writes.
 *
 * ⚠️ Preview, off by default: the preset has not been opened in Arena, and
 * the set writes have met a simulator only (see `test/plugins.test.js`'s
 * OFF_UNTIL_TESTED).
 */

import { createResolumePanel } from './panel.js';

export default function activate(ctx) {
  const view = createResolumePanel({ session: ctx.session, onRefresh: ctx.refresh });
  ctx.ui.sidebar({
    id: 'resolume-map',
    label: 'Resolume Mapping',
    submenuOf: 'Preconfig',
    /* Beneath the vendor's own Canvas page; at the flyout's end where a
       build has none, before Pitch Compensation (80) and this app's
       settings (90). */
    after: 'Canvas',
    order: 70,
    render: () => view.render()
  });
}
