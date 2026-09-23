/*
 * Popped-out windows: the machinery every one of them shares.
 *
 * A panel pops out into a document of its own — the Console's is previews, a
 * command line and a reference shelf; Memories' and Layer's are the panel
 * alone — but the awkward parts are the same for all of them, so they are
 * here once. A plugin's popout is a page in its own folder that imports
 * `bootPopout` (and `buildSolo`, for a single panel) from this file:
 * `plugins/memories/popout.html` is the whole of one.
 *
 * ## It shares the opener's session — it does not make its own
 *
 * This is the whole reason a popout is allowed to exist. The device counts
 * its clients and shows the count in its own header, and AWJ's separate
 * five-client budget is small; a second window that connected on its own would
 * appear to the operator as a phantom colleague on the box. So a popout
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
 */

import { h, button } from './dom.js';
import { installStyles } from './theme.js';
import { repaint, trackFields } from './keep-focus.js';

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
 * Everything a popped-out window needs before it can draw anything.
 *
 * Shared by every popout — the console and the timeline editor both — because
 * the awkward parts are identical and are the parts worth getting right once:
 * finding the opener's session, borrowing the vendor's stylesheet, and saying
 * so out loud when the window it came from goes away.
 *
 * `build` is called with the live bridge and returns whatever it likes; it is
 * only reached when there is genuinely a session to drive.
 *
 * @param {{doc: Document, opener: Window, build: Function}} opts
 */
export function bootPopout({ doc = document, opener = window.opener, plugin = null, build }) {
  const bridge = opener && !opener.closed ? opener.__WRU : null;
  if (!bridge || !bridge.session) return mountOrphan(doc, 'no session');
  /* What the plugin that owns this window shared with it (`ctx.share`). A
     plugin switched off since the tab loaded shares nothing, and a window
     that half-works is worse than one that says why. */
  const own = plugin ? (bridge.shared ? bridge.shared(plugin) : null) : null;
  if (plugin && !own) return mountOrphan(doc, 'plugin off');
  if (!adoptVendorChrome(doc, opener.document)) return mountOrphan(doc, 'no vendor page');

  const banner = h('div');
  doc.body.append(banner);
  const built = build({ doc, bridge, banner, own }) || {};

  /*
   * The opener is this window's only route to the device. Watch for it going
   * and say so loudly — a panel that has quietly stopped reaching a switcher
   * is the failure mode worth spending a banner on.
   */
  const watch = setInterval(() => {
    if (opener && !opener.closed && opener.__WRU) return;
    clearInterval(watch);
    try { built.stop && built.stop(); } catch { /* tearing down is best effort */ }
    banner.textContent = '';
    banner.append(h('div', { class: 'lpp-banner' },
      'The Web RCS window this came from has closed, so there is no connection to the switcher. ',
      'Nothing done here will be sent. Open it again from Web RCS.'));
    for (const field of doc.querySelectorAll('input, select, button')) field.disabled = true;
  }, 1000);

  (doc.defaultView || window).addEventListener('pagehide', () => {
    clearInterval(watch);
    try { built.stop && built.stop(); } catch { /* going away anyway */ }
  });

  return built;
}

/**
 * One panel, filling its own window, repainting on device traffic.
 *
 * Shared by the memories and properties popouts because neither has anything
 * beside it — unlike the console, which is a wall and a shelf and a terminal.
 * The interesting part is the repaint guard.
 *
 * ## Why device frames sometimes must not repaint
 *
 * The panels are rebuilt wholesale on every frame, which is the right thing
 * for a table of numbers and destroys a field that is being typed into. The
 * console solves this by never repainting on device traffic at all; these two
 * have to repaint, so instead they say when they must not. `busy()` is true
 * exactly while a text field holds an uncommitted edit, and the repaint is not
 * dropped but deferred — the next frame after the edit lands redraws it, so
 * the panel never sits stale.
 */
export function buildSolo(doc, bridge, create) {
  const { session } = bridge;
  const host = h('div', { class: 'lpp-popout lpp-solo' });
  doc.body.append(host);
  trackFields(doc);

  /* No Pop out button in here — this is where it pops out to. */
  const view = create({ session, onRefresh: () => paint(), popoutEnabled: false, doc });

  function paint() {
    /*
     * Scroll position is the operator's, not ours. The device store is chatty
     * and a repaint that jumped a 67-field property list back to the top
     * mid-show would be its own bug.
     */
    const scroller = host.querySelector('.wru-body');
    const top = scroller ? scroller.scrollTop : 0;
    /* And the caret is the operator's too — see `keep-focus.js`. */
    if (!repaint(host, () => view.render())) return;
    const again = host.querySelector('.wru-body');
    if (again) again.scrollTop = top;
  }

  let queued = false;
  let missed = false;
  const onFrame = () => {
    if (view.busy && view.busy()) { missed = true; return; }
    if (queued) return;
    queued = true;
    (doc.defaultView || window).requestAnimationFrame(() => {
      queued = false;
      if (view.busy && view.busy()) { missed = true; return; }
      missed = false;
      paint();
    });
  };

  /* The edit that suppressed a repaint ends without a device frame to
     announce it, so a short clock catches up rather than leaving the panel
     stale until the switcher next says something. */
  const catchUp = setInterval(() => {
    if (missed && !(view.busy && view.busy())) onFrame();
  }, 500);

  session.addEventListener('frame', onFrame);
  session.addEventListener('state', onFrame);
  paint();

  return {
    paint,
    stop() {
      clearInterval(catchUp);
      session.removeEventListener('frame', onFrame);
      session.removeEventListener('state', onFrame);
    }
  };
}

/** Nothing to attach to: say why, in plain words, and stop. */
function mountOrphan(doc, reason) {
  installStyles(doc);
  doc.body.append(h('div', { class: 'lpp-orphan' },
    h('h1', { class: 'aw-font-subtitle-1', text: reason === 'plugin off' ? 'Not running in Web RCS' : 'No Web RCS session' }),
    /* Four different panels arrive here now, so the message names the rule
       rather than the panel: it used to say "opened from the Console", which
       was already only a quarter true and sent anyone who reached it from the
       cue list looking in the wrong place. */
    h('p', { text: reason === 'no vendor page'
      ? 'This window was opened from a page that is not a LivePremier Plus session.'
      : reason === 'plugin off'
      ? 'The feature this window belongs to is not running in the Web RCS tab it came from — it may have been switched off. Reload that tab and open it again.'
      : 'A popped-out panel has to be opened by its Pop out button inside Web RCS — it borrows that tab’s connection to the switcher rather than making one of its own, so it cannot be opened from a bookmark or reloaded on its own.' })));
  return null;
}
