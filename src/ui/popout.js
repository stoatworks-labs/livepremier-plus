/*
 * The popped-out console: previews, a command line, and a reference shelf.
 *
 * ## It shares the opener's session — it does not make its own
 *
 * This is the whole reason the popout is allowed to exist. The device counts
 * its clients and shows the count in its own header, and AWJ's separate
 * five-client budget is small; a second window that connected on its own would
 * appear to the operator as a phantom colleague on the box. So the popout
 * opens **no socket and fetches no store**. It reaches back through
 * `window.opener.__WRU` and uses the session that is already running in the
 * Web RCS tab — same mirror, same socket, same everything.
 *
 * That works because the popout is served from our own origin, so it is
 * same-origin with the tab that opened it and `opener` is a live reference
 * rather than a stub. It is also why closing the Web RCS tab has to be
 * handled rather than ignored: the moment it goes, this window is holding a
 * reference to a dead document, and a command line that silently stops
 * sending is worse than one that says it has been cut off.
 *
 * ## It borrows the vendor's stylesheet rather than shipping one
 *
 * Same rule as the panels. The `<link>` hrefs and the SVG sprite are copied
 * from the opener at runtime — never hard-coded, because the hashes change
 * every firmware, and the sprite is a node the vendor bundle builds. The root
 * font size comes over too: every `aw-` spacing value is in rem against the
 * vendor's `html { font-size: 12px }`, so a popout on the browser default
 * would be laid out half again too large.
 *
 * ## Layout
 *
 *   ┌──────────────────────────┬──────────────┐
 *   │ previews (filter, size)  │ Syntax|Macros│
 *   ├──────────────────────────┴──────────────┤
 *   │ command line, full width                │
 *   └─────────────────────────────────────────┘
 *
 * The terminal spans the whole window because it is the thing being used; the
 * previews are what it is being used *at*, and the shelf is what it is being
 * used *with*.
 */

import { h, button } from './dom.js';
import { installStyles } from './theme.js';
import { createConsolePanel } from './console-panel.js';
import { createPreviewWall } from './preview.js';
import { createSyntaxPanel, createMacroPanel } from './syntax-panel.js';

const SPRITE_ID = '__SVG_SPRITE_NODE__';

/**
 * Copy everything the vendor's look depends on into this document.
 *
 * Returns false when the opener is not a Web RCS we can read, which is the
 * caller's cue to say so rather than to render an unstyled page.
 */
export function adoptVendorChrome(doc, openerDoc) {
  if (!openerDoc) return false;

  for (const link of openerDoc.querySelectorAll('link[rel="stylesheet"]')) {
    const href = link.getAttribute('href');
    if (!href || doc.querySelector(`link[href="${CSS.escape(href)}"]`)) continue;
    const copy = doc.createElement('link');
    copy.rel = 'stylesheet';
    copy.href = href;
    doc.head.append(copy);
  }

  /* Every icon is a `<use href="#id">` into this one node. Importing it is
     cheaper and far more robust than re-fetching whatever built it. */
  const sprite = openerDoc.getElementById(SPRITE_ID);
  if (sprite && !doc.getElementById(SPRITE_ID)) {
    doc.body.append(doc.importNode(sprite, true));
  }

  /* The rem base. Read rather than assumed — it is 12px today, and every
     spacing utility in the vendor system is relative to it. */
  try {
    const size = openerDoc.defaultView.getComputedStyle(openerDoc.documentElement).fontSize;
    if (size) doc.documentElement.style.fontSize = size;
  } catch { /* a cross-origin opener cannot happen here, but do not die on it */ }

  installStyles(doc);
  return true;
}

/**
 * Build the popout into `doc`, driving the opener's session.
 *
 * @param {{doc: Document, opener: Window}} opts
 */
export function mountPopout({ doc = document, opener = window.opener } = {}) {
  const bridge = opener && !opener.closed ? opener.__WRU : null;
  if (!bridge || !bridge.session) return mountOrphan(doc, 'no session');

  if (!adoptVendorChrome(doc, opener.document)) return mountOrphan(doc, 'no vendor page');

  const { session } = bridge;

  /* No Pop out button in here — this is where it pops out to. */
  const consolePanel = createConsolePanel({ session, onRefresh: () => paintConsole(), popoutEnabled: false });
  const wall = createPreviewWall({ session, onRefresh: () => paintWall(), doc });
  const syntax = createSyntaxPanel();
  const macros = createMacroPanel();

  const tabs = [
    { id: 'syntax', label: 'Syntax', panel: syntax },
    { id: 'macros', label: 'Macros', panel: macros }
  ];
  let activeTab = 'syntax';

  /* --------------------------------------------------------------- frame */

  const wallControls = h('div');
  const wallBody = h('div', { class: 'lpp-wall-body' });
  const sideTabs = h('div', { class: 'lpp-side-tabs aw-flex-row-center-v aw-gap-col-mini' });
  const sideBody = h('div', { class: 'lpp-side-pane' });
  const consoleHost = h('div', { class: 'lpp-console' });
  const banner = h('div');

  const root = h('div', { class: 'lpp-popout' },
    banner,
    h('div', { class: 'lpp-top' },
      h('section', { class: 'lpp-previews' },
        h('div', { class: 'lpp-pane-head' },
          h('span', { class: 'aw-font-subtitle-1', text: 'Screens / Aux.' }),
          wallControls),
        wallBody),
      h('section', { class: 'lpp-side' }, sideTabs, sideBody)),
    consoleHost);

  doc.body.append(root);

  /* --------------------------------------------------------------- paint */

  function paintWall() {
    wallControls.textContent = '';
    wallControls.append(wall.controls());
    /* Scroll position is the operator's, not ours — the device store is
       chatty and a repaint that jumped the wall back to the top mid-show
       would be its own bug. */
    const top = wallBody.scrollTop;
    wallBody.textContent = '';
    wallBody.append(wall.render());
    wallBody.scrollTop = top;
  }

  function paintConsole() {
    consoleHost.textContent = '';
    consoleHost.append(consolePanel.render());
  }

  function paintSide() {
    sideTabs.textContent = '';
    for (const tab of tabs) {
      sideTabs.append(h('button', {
        class: ['lpp-tab', activeTab === tab.id ? 'lpp-tab--on' : ''],
        type: 'button',
        onClick: () => { activeTab = tab.id; paintSide(); }
      }, tab.label));
    }
    sideBody.textContent = '';
    const tab = tabs.find((t) => t.id === activeTab) || tabs[0];
    sideBody.append(tab.panel.render());
  }

  paintWall();
  paintConsole();
  paintSide();
  wall.start();

  /* ------------------------------------------------------- staying alive */

  /*
   * Device traffic repaints the wall, never the console: a repaint would wipe
   * whatever the operator is halfway through typing, and the console redraws
   * itself when it has something to say.
   */
  let queued = false;
  const onFrame = () => {
    if (queued) return;
    queued = true;
    (doc.defaultView || window).requestAnimationFrame(() => { queued = false; paintWall(); });
  };
  session.addEventListener('frame', onFrame);
  session.addEventListener('state', onFrame);

  /*
   * The opener is this window's only route to the device. Watch for it going
   * and say so loudly — a command line that has quietly stopped reaching a
   * switcher is the failure mode worth spending a banner on.
   */
  const watch = setInterval(() => {
    if (opener && !opener.closed && opener.__WRU) return;
    clearInterval(watch);
    wall.stop();
    session.removeEventListener('frame', onFrame);
    session.removeEventListener('state', onFrame);
    banner.textContent = '';
    banner.append(h('div', { class: 'lpp-banner' },
      'The Web RCS window this came from has closed, so there is no connection to the switcher. ',
      'Nothing typed here will be sent. Open the console again from Web RCS.'));
    for (const field of doc.querySelectorAll('input')) field.disabled = true;
  }, 1000);

  (doc.defaultView || window).addEventListener('pagehide', () => { wall.stop(); clearInterval(watch); });

  return { paintWall, paintConsole, paintSide, wall };
}

/** Nothing to attach to: say why, in plain words, and stop. */
function mountOrphan(doc, reason) {
  installStyles(doc);
  doc.body.append(h('div', { class: 'lpp-orphan' },
    h('h1', { class: 'aw-font-subtitle-1', text: 'No Web RCS session' }),
    h('p', { text: reason === 'no vendor page'
      ? 'This window was opened from a page that is not a LivePremier Plus session.'
      : 'This window has to be opened from the Console inside Web RCS — it borrows that tab’s connection to the switcher rather than making one of its own.' })));
  return null;
}
