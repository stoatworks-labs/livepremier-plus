/*
 * Desk — the plugin's page half.
 *
 * The LivePremier Plus desk is a control surface that has been drawn and not
 * built (stoatworks-labs/lpp-control-surface, prototype one): Stream Decks on
 * the left for Companion, a Mynah keypad, four encoders and three wheels on
 * one USB MIDI controller, and an ASUS PA147CDV strip screen, 1920 × 550,
 * across the back. This is its software: the keypad typing into a Console line
 * of its own (`keypad.js`), the encoders and wheels through awj-surface's
 * engine with the `lpp-surface-p1` profile (`desk.js`), and a page for the
 * strip screen (`screen.html`) showing the line, the wheel pages and a cell
 * over every knob.
 *
 * It runs in this tab because the session does; the screen is a window this
 * tab opens, like the Console's popout, and only draws. See `desk.js`.
 */

import { h } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import { createDesk } from './desk.js';
import { createDeskPanel } from './panel.js';

const SCREEN = new URL('./screen.html', import.meta.url).href;
const ENTRY = { id: 'desk', label: 'Desk', icon: ['remote-18', 'gpio-18', 'connector-gpio-18'], order: 61 };

export default function activate(ctx) {
  /* The manifest needs the Console, so the host switches this off with it;
     a host that started this without one gets a panel that says so rather
     than a plugin that failed to start. */
  if (!ctx.use('console')) {
    ctx.ui.sidebar({
      ...ENTRY,
      render: () => panel({
        toolbar: h('div', { class: 'aw-font-subtitle-1', text: 'Desk' }),
        body: h('div', { class: 'aw-text-secondary', text: 'The desk types into a Console line, and the Console plugin is off. Switch it on in Settings → Plugins.' })
      })
    });
    return;
  }

  const desk = createDesk({
    session: ctx.session,
    consoleService: () => ctx.use('console'),
    onChange: () => ctx.refresh()
  });

  /* The engine starts now, so the screen has values before MIDI is open. */
  desk.ready().catch((err) => ctx.log.warn(`desk: ${err.message}`));

  /* A browser that has already said yes to MIDI on this address is not asked
     again, so a desk that boots straight into this page starts listening by
     itself. One that has not been asked waits for the button: a permission
     prompt nobody asked for, on a screen with no keyboard, is a trap. */
  try {
    navigator.permissions.query({ name: 'midi' }).then((p) => {
      if (p.state === 'granted') desk.connect();
    }).catch(() => {});
  } catch { /* no Permissions API: the button it is */ }

  /* The screen window drives this desk through its opener: `bootPopout`'s `own`. */
  ctx.share(desk);

  const deskPanel = createDeskPanel({ desk, onRefresh: ctx.refresh, screenUrl: SCREEN });
  ctx.ui.sidebar({ ...ENTRY, render: () => deskPanel.render() });
}
