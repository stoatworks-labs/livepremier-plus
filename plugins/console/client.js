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
  /* The Variables plugin's service, asked per run: it may start after this
     plugin, or be switched off, and a Console must work either way. Preview
     lock's hold likewise. */
  const variables = () => ctx.use('variables');
  const hold = (cmds) => { const lock = ctx.use('preview-lock'); return lock ? lock.holdWrites(cmds) : null; };
  const consolePanel = createConsolePanel({
    session: ctx.session, onRefresh: ctx.refresh, variables, hold
  });

  /*
   * A Console line of another plugin's own: the desk's keypad types into one.
   * The same compile, the same routes out, Preview lock and Variables the same
   * way, and a log of its own. Unlike the tab's, it keeps mynah's sticky scope
   * (`Select` / `Clear`), which a keypad's TAKE is built on; pass
   * `stickyScope: false` for a line that should not.
   */
  ctx.provide('console', Object.freeze({
    line: (opts = {}) => createConsolePanel({
      session: ctx.session, variables, hold, popoutEnabled: false, stickyScope: true, ...opts
    })
  }));
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
