/*
 * The Console — the plugin's page half.
 *
 * A tab in the vendor's own strip on Screens / Aux., beside Properties and
 * Memories: a per-screen tool belongs where an operator already looks for
 * per-screen tools, not in a separate corner of the app. It pops out into a
 * window of its own, `popout.html`, with previews and a reference shelf.
 *
 * A line in an address space a plugin answers — `/lp/matrix/…`, a user
 * plugin's `/hello/…` — goes to that plugin, through the same path the OSC
 * listener uses (see `core/contributions.js`); everything else is the
 * switcher's own command language.
 */

import { createConsolePanel } from './panel.js';

export default function activate(ctx) {
  const consolePanel = createConsolePanel({ session: ctx.session, onRefresh: ctx.refresh });
  ctx.ui.tab({
    id: 'console',
    label: 'Console',
    /* What the tab falls back to when the strip runs out of room, which it
       does at any ordinary window size. "Cons" would read as neither one
       thing nor the other. */
    short: 'Cmd',
    /* `mini-list-14` is LivePremier's sprite; Midra's has no list glyph and
       `bars-14` is the nearest it draws. `icon()` takes the first the page has. */
    icon: ['mini-list-14', 'bars-14'],
    order: 10,
    render: () => consolePanel.render()
  });
}
