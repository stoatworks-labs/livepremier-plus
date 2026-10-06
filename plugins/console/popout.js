/*
 * The popped-out Console: previews, a command line, and a reference shelf.
 *
 * Booted by `popout.html` beside it, through the machinery every popout shares
 * (`src/ui/popout.js`): it drives the Web RCS tab's own session and opens no
 * connection of its own.
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

import { h } from '../../src/ui/dom.js';
import { repaint, trackFields } from '../../src/ui/keep-focus.js';
import { bootPopout } from '../../src/ui/popout.js';
import { createConsolePanel } from './panel.js';
import { createPreviewWall } from './preview.js';
import { createSyntaxPanel, createMacroPanel } from './syntax-panel.js';
import { createVariablesShelf } from './variables-shelf.js';

/**
 * Build the console popout into `doc`, driving the opener's session.
 *
 * @param {{doc: Document, opener: Window}} opts
 */
export function mountConsolePopout({ doc = document, opener = window.opener } = {}) {
  return bootPopout({ doc, opener, build: ({ bridge }) => buildConsole(doc, bridge) });
}

function buildConsole(doc, bridge) {
  const { session } = bridge;
  /* The Variables plugin's service, through the opener's plugins — asked per
     use, so switching it off in the main tab reaches this window too. */
  const variables = () => {
    try { return bridge.plugins && bridge.plugins.use ? bridge.plugins.use('variables') : null; } catch { return null; }
  };

  /* No Pop out button in here — this is where it pops out to. */
  /* Preview lock lives in the Web RCS tab; a line typed here asks it the same way. */
  const hold = (cmds) => {
    const lock = bridge.services && bridge.services.use ? bridge.services.use('preview-lock') : null;
    return lock ? lock.holdWrites(cmds) : null;
  };
  const consolePanel = createConsolePanel({ session, onRefresh: () => paintConsole(), popoutEnabled: false, variables, hold });
  const wall = createPreviewWall({ session, onRefresh: () => paintWall(), doc });
  const syntax = createSyntaxPanel();
  const macros = createMacroPanel();
  const shelf = createVariablesShelf({
    variables,
    onPick: (name) => consolePanel.insert(name),
    onRefresh: () => repaint(sideBody, () => shelf.render())
  });

  const tabs = [
    { id: 'syntax', label: 'Syntax', panel: syntax },
    { id: 'variables', label: 'Variables', panel: shelf },
    { id: 'macros', label: 'Macros', panel: macros }
  ];
  let activeTab = 'syntax';

  /* --------------------------------------------------------------- frame */

  const wallControls = h('div');
  const wallBody = h('div', { class: 'lpp-wall-body' });
  const sideTabs = h('div', { class: 'lpp-side-tabs aw-flex-row-center-v aw-gap-col-mini' });
  const sideBody = h('div', { class: 'lpp-side-pane' });
  const consoleHost = h('div', { class: 'lpp-console' });

  const root = h('div', { class: 'lpp-popout' },
    h('div', { class: 'lpp-top' },
      h('section', { class: 'lpp-previews' },
        h('div', { class: 'lpp-pane-head' },
          h('span', { class: 'aw-font-subtitle-1', text: 'Screens / Aux.' }),
          wallControls),
        wallBody),
      h('section', { class: 'lpp-side' }, sideTabs, sideBody)),
    consoleHost);

  doc.body.append(root);
  trackFields(doc);

  /* --------------------------------------------------------------- paint */

  function paintWall() {
    repaint(wallControls, () => wall.controls());
    /* Scroll position is the operator's, not ours — the device store is
       chatty and a repaint that jumped the wall back to the top mid-show
       would be its own bug. The caret is theirs too; see `keep-focus.js`. */
    const top = wallBody.scrollTop;
    if (repaint(wallBody, () => wall.render())) wallBody.scrollTop = top;
  }

  function paintConsole() {
    repaint(consoleHost, () => consolePanel.render());
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
    const tab = tabs.find((t) => t.id === activeTab) || tabs[0];
    repaint(sideBody, () => tab.panel.render());
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
    (doc.defaultView || window).requestAnimationFrame(() => {
      queued = false;
      paintWall();
      /* The variables read live, so their tab follows the switcher too. */
      if (activeTab === 'variables') repaint(sideBody, () => shelf.render());
    });
  };
  session.addEventListener('frame', onFrame);
  session.addEventListener('state', onFrame);

  return {
    paintWall, paintConsole, paintSide, wall,
    stop() {
      wall.stop();
      session.removeEventListener('frame', onFrame);
      session.removeEventListener('state', onFrame);
    }
  };
}
