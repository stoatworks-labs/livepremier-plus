/*
 * Entry point, loaded as a module by the proxy's injected script tag.
 *
 * By the time this runs, the inline hook the proxy wrote into <head> has
 * already wrapped WebSocket and has been recording frames since before the
 * vendor bundle booted — the parser guarantees that ordering, because every
 * vendor script is `defer` and the hook is not. All that is left is to
 * confirm this really is a Web RCS page, mirror the device store, and put two
 * entries in the sidebar.
 *
 * If the page turns out not to be Web RCS, nothing is mounted and nothing is
 * fetched. The hook stays inert.
 */

import { Session } from './core/session.js';
import { PageSocketTransport } from './transports/page-socket.js';
import { Shell, SIDEBAR_SELECTOR } from './ui/shell.js';
import { TabHost, watchVendorTabs } from './ui/tabs.js';
import { createSettingsPanel } from './ui/settings-panel.js';
import { detectPlatform, supports } from './core/platform.js';
import { isEnabled as pluginOn } from './core/plugins.js';
import { loadPlugins, byOrder } from './ui/plugin-host.js';
import { createContributions, createServices } from './core/contributions.js';
import { dialectFor } from './core/dialect.js';

const TAG = '[LivePremier Plus]';

/* Redraws are cheap but the device store is chatty - timers alone produce a
   frame every second. Coalesce to one repaint per animation frame, and only
   while one of our panels is actually on screen. */
function throttleFrame(fn) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(); });
  };
}

async function boot() {
  const transport = new PageSocketTransport();

  /* Wait for evidence rather than assuming. The hook flags the page as soon
     as it sees an Analog Way frame; without one we are on some other site. */
  if (!transport.detected) {
    const seen = await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(true); };
      window.addEventListener('wru:detected', done, { once: true });
      const timer = setTimeout(() => { window.removeEventListener('wru:detected', done); resolve(false); }, 20000);
    });
    if (!seen) return;
  }

  const bootSettings = await fetch('/__lpp/settings', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : {}))
    .then((body) => (body && body.settings) || {})
    .catch(() => ({}));
  const pluginState = bootSettings.plugins || {};
  /*
   * Whether a plugin is switched on, with its dependencies — see
   * `core/plugins.js`. The platform half stays where it was, in each entry's
   * own `can(...)`, so the two questions compose rather than one replacing the
   * other. A change to a switch applies on the next load; the settings page
   * says so beside the switch.
   */
  const on = (id) => pluginOn(pluginState, id);

  const session = new Session(transport);
  /*
   * How plugins extend each other — see `core/contributions.js`. One registry
   * of each for the page, handed to the plugin host.
   */
  const contributions = createContributions();
  const services = createServices();
  /* Set once the plugins have loaded; until then only the app's own count. */
  let listContributions = (point) => contributions.list(point, on);

  /*
   * One repaint per frame, covering whichever of our surfaces is on screen.
   *
   * Held off while a panel has an uncommitted edit in a text field. Our panes
   * are rebuilt wholesale, so a device frame arriving mid-keystroke would take
   * the field, its contents and the caret with it — and the device store is
   * chatty enough that timers alone produce a frame a second. Nothing is lost
   * by waiting: the panel calls `refresh` itself the moment the edit commits.
   */
  /* Declared here rather than at their construction so `refresh` can close
     over them: the panels are built further down, and a `const` referenced
     before its declaration runs is a ReferenceError, not an undefined. */
  /* The plugins' page halves, loaded below — see `ui/plugin-host.js`. */
  let hosted = null;
  let settingsPage = null;
  /*
   * The sidebar and the tab strip, built once the plugins have said what goes
   * in them. Until then a repaint has nothing to paint — and one is asked for
   * early: a plugin that loads its data as it starts repaints when the data
   * arrives, which can be while the plugins after it are still loading. With
   * `const` further down, that repaint was a ReferenceError (found when Layer
   * Groups moved, 2026-09-23).
   */
  let shell = null;
  let tabs = null;
  const editing = () =>
    [settingsPage].some((p) => p && p.busy && p.busy())
    || Boolean(hosted && hosted.busy());
  const refresh = throttleFrame(() => {
    if (!shell || !tabs || editing()) return;
    shell.refresh();
    tabs.refresh();
  });

  /*
   * What kind of switcher is this, and what does it support?
   *
   * Re-read on every call rather than cached, because the answer changes once:
   * the store is empty when the panels mount and hydrated a moment later, and
   * `detectPlatform` deliberately returns "everything is on offer" until it
   * has something to look at. See `core/platform.js`.
   */
  const platform = () => detectPlatform(session.store);
  const can = (capability) => supports(platform(), capability);

  /* The plugins' own settings cards are read at every render: the plugins
     load further down, after this is built. */
  const settings = createSettingsPanel({
    session, platform, onRefresh: refresh,
    sections: () => (hosted ? hosted.settings : [])
  });
  settingsPage = settings;
  /*
   * Layer names come from their plugin, `plugins/layer-names/`, as the
   * `names` service — asked for per use, because the plugins load further
   * down. Kept here only for `window.__WRU`, which scripts and the demo read.
   */
  const namer = () => (hosted ? hosted.use('names') : null);
  const names = () => { const n = namer(); return n ? n.get() : {}; };
  const rename = (...a) => { const n = namer(); if (n) n.rename(...a); };

  /*
   * The plugins' page halves.
   *
   * Loaded now, after the app's own panels and before the strip and the
   * sidebar are built, so what they register lands in both lists beside the
   * app's own entries — ordered by `order`, like everything else there. Only
   * the plugins the server says are on are loaded at all; one that fails is
   * logged and left out, and the rest of the page comes up regardless.
   */
  hosted = await loadPlugins({
    session, platform, can, refresh, settings: bootSettings, contributions, services, isOn: on
  });
  listContributions = hosted.contributions;

  /*
   * The vendor's own tab strip on Screens / Aux.: every entry on it is a
   * plugin's now — Console 10, Timeline 20, Layer 30, Groups 40 — because
   * per-screen tools belong where an operator already looks for per-screen
   * tools. A whole-device view, like the VPU map, is a sidebar entry instead.
   */
  tabs = new TabHost({ tabs: byOrder(hosted.tabs) });

  shell = new Shell({
    title: 'PLUS',
    /*
     * Ordered by `order`, in tens so a plugin can put itself between two
     * entries. Every entry is a plugin's — Edit 10, VPU Map 20, Memories 30,
     * Layer Groups 40, Matrix Routing 50, Companion 60, MIDI Mapping 70 under
     * Virtual RC400T, Pitch Compensation 80 in the Preconfig flyout — except
     * this app's own settings, which close that flyout: settings for the
     * installation go where the device's own installation settings are, and
     * they are how a broken plugin gets switched off, so no plugin owns them.
     */
    entries: byOrder([
      { id: 'settings', label: 'LivePremier Plus', submenuOf: 'Preconfig', order: 90, render: () => settings.render() },
      ...hosted.sidebar
    ])
  });

  session.addEventListener('state', (ev) => {
    console.info(TAG, 'session', ev.detail.state, ev.detail.error || '');
    refresh();
  });

  session.addEventListener('frame', refresh);

  /* The sidebar may not exist yet - the vendor app mounts React after its own
     bundle runs. Retry briefly rather than racing it. */
  const mount = () => { if (!shell.start.called) { shell.start(); shell.start.called = true; } };
  if (document.querySelector(SIDEBAR_SELECTOR)) mount();
  else {
    const obs = new MutationObserver(() => {
      if (document.querySelector(SIDEBAR_SELECTOR)) { obs.disconnect(); mount(); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 60000);
  }

  tabs.start();
  watchVendorTabs(tabs);

  await session.start();

  /*
   * The store has arrived, so `enabled()` can finally answer honestly. Put the
   * surfaces up again, dropping whatever this switcher turns out not to
   * support. Until this moment everything is offered — a panel that flickers
   * into existence is a smaller problem than one missing for good because a
   * device was slow to answer.
   */
  const here = platform();
  console.info(TAG, 'platform', here.name, here.modelName || here.model || '', here.firmware || '',
    '- dialect', (dialectFor(session.store) || {}).id || 'none');
  shell.remount();
  tabs.remount();

  console.info(TAG, 'ready on', location.host, '- store', session.store.ready ? 'mirrored' : 'unavailable');
  const clock = hosted.use('timecode');
  window.__WRU = { session, stack: hosted.use('stack'), shell, tabs, transport, platform, timecode: clock && clock.source, chase: clock && clock.chase, groups: hosted.use('groups'), names, rename, labels: { describe: () => (namer() ? namer().describe() : null) }, routerBoxes: { describe: () => { const m = hosted.use('matrix'); return m ? m.describeSurfaces() : null; } }, plugins: hosted, contributions: listContributions, services, shared: hosted.shared };
}

boot().catch((err) => console.error(TAG, 'failed to start', err));
