/*
 * Companion — the plugin's page half.
 *
 * One sidebar entry, and the panel behind it (`panel.js`). Everything the
 * panel asks of this app goes through `ctx` — its routes by `ctx.url`, its
 * settings by `ctx.settings`, the look of the rest of the app by `ctx.kit` —
 * so nothing here depends on where the app keeps its own files.
 */

import { createCompanionPanel } from './panel.js';

export default function activate(ctx) {
  const panel = createCompanionPanel({
    kit: ctx.kit,
    url: ctx.url,
    settings: ctx.settings,
    onRefresh: ctx.refresh,
  });

  ctx.ui.sidebar({
    id: 'companion',
    label: 'Companion',
    icon: ['gpio-18', 'connector-gpio-18'],
    /*
     * In PLUS, after Matrix Routing — and the call was close enough to be
     * worth writing down. MIDI Mapping is anchored to the vendor's Virtual
     * RC400T because both are control surfaces, and a Companion is a control
     * surface too; by that argument this belongs there.
     *
     * Two things beat it. An anchored entry needs its vendor item to exist,
     * and Virtual RC400T is not on every platform, so anchoring would make
     * this quietly absent on a Midra 4K — which has just as much use for a
     * Companion. And half of this panel is not a surface at all: it is what is
     * in the show and what this app would add to it, which is a whole-rig
     * configuration view of exactly the kind the rest of that section holds.
     */
    order: 60,
    render: panel.render,
    busy: panel.busy,
  });
}
