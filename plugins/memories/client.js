/*
 * Memories — the plugin's page half.
 *
 * The three memory banks, a whole-device view like the VPU map and unlike
 * everything on the Screens / Aux. strip: master memories cover every screen
 * at once, and the screen bank is one flat list of 1000 slots any screen can
 * recall from. So it is a sidebar entry, and there is deliberately no tab.
 *
 * Web RCS has a Memories pane of its own, but it is React, and a React pane
 * cannot be relocated into a second window — its listeners are delegated to
 * the app's root. This one reads the mirror instead, which is what lets it pop
 * out (`popout.html`).
 */

import { createMemoriesPanel } from './panel.js';

export default function activate(ctx) {
  const memories = createMemoriesPanel({ session: ctx.session, onRefresh: ctx.refresh });
  ctx.ui.sidebar({
    id: 'memories',
    label: 'Memories',
    icon: 'shotbox-18',
    order: 30,
    render: () => memories.render(),
    /* Holds repaints off while a label is being typed. */
    busy: () => memories.busy()
  });
}
