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
import { CueStack } from './core/cuestack.js';
import { PageSocketTransport } from './transports/page-socket.js';
import { Shell, SIDEBAR_SELECTOR } from './ui/shell.js';
import { createMatrixPanel } from './ui/matrix-panel.js';
import { createTimelinePanel } from './ui/timeline-panel.js';
import { TabHost, watchVendorTabs } from './ui/tabs.js';
import { createSettingsPanel } from './ui/settings-panel.js';
import { installRouterSurfaces } from './ui/router-box.js';
import { detectPlatform, supports } from './core/platform.js';
import { isEnabled as pluginOn } from './core/plugins.js';
import { loadPlugins, byOrder } from './ui/plugin-host.js';
import { createContributions, createServices } from './core/contributions.js';
import { SIDES, parseConnectorId, logicalIndex } from './core/connectors.js';
import { dialectFor } from './core/dialect.js';
import { commandsFor } from './core/commands.js';
import { createTimecodeSource } from './ui/timecode-source.js';
import { TimecodeChase } from './core/chase.js';

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

/**
 * Cue stacks and layer groups are persisted by the launcher, not by the browser.
 *
 * The extension version of this brokered chrome.storage through a content
 * script over window messages, because the page had no other way to reach it.
 * The launcher is a process with a disk, so the panels just ask it — and it
 * keys the stack by the device it is proxying, which is the right key anyway:
 * a cue list is written against one box's screens and presets.
 *
 * Layer groups take the same route for the same reason. `S1/2` names a layer
 * slot on one box's preconfig; pointed at another frame the same words mean
 * something else or nothing, so the groups are keyed by device too and live
 * in a file of their own beside the stacks.
 *
 * Deliberately not localStorage. That belongs to the vendor's own web app and
 * writing our data into it is not ours to do — a point that survived the move
 * off the extension unchanged.
 */
function makeStorage(url = '/__lpp/stack') {
  return {
    async load() {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return null;
        return (await res.json()).data ?? null;
      } catch (err) {
        console.warn(TAG, 'could not load cue stack', err);
        return null;
      }
    },
    async save(data) {
      try {
        await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data })
        });
      } catch (err) {
        /* A failed save must not interrupt an operator mid-cue. It is logged
           and the in-memory stack carries on; the next edit retries. */
        console.warn(TAG, 'could not save cue stack', err);
      }
    }
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
  const storage = makeStorage();
  /*
   * The cue engine spells its writes for whichever platform the store turns
   * out to be — LivePremier or Midra 4K / Alta 4K — and asks at fire time,
   * because the store is empty when this runs and may be re-pointed at a
   * different frame mid-show. Before the store has said, every command
   * declines to be built and a GO sends nothing. See `core/commands.js`.
   */
  /*
   * How plugins extend each other, and how the features still wired in here
   * extend them too — see `core/contributions.js`. One registry of each for
   * the page, shared with the plugin host, so a consumer cannot tell a
   * built-in's contribution from a plugin's.
   */
  const contributions = createContributions();
  const services = createServices();
  /* Set once the plugins have loaded; until then only the app's own count. */
  let listContributions = (point) => contributions.list(point, on);

  const stack = new CueStack({
    send: (cmd) => session.send(cmd),
    commands: () => commandsFor(dialectFor(session.store)),
    /* Any kind the engine does not do itself is a plugin's `cueAction` —
       Matrix Routing's two among them, contributed below. Asked at fire time,
       because the plugins load after this is built. */
    actions: (kind) => listContributions('cueAction').find((a) => a.kind === kind) || null
  });

  /*
   * Matrix Routing's two cue actions, contributed as a plugin would.
   *
   * They do not go on the vendor socket — an external router is not in the
   * device store and the switcher has never heard of it. They go to our own
   * process, which holds the router connections. Not awaited, for the same
   * reason a take is not: the router acknowledges receipt rather than success.
   * A refusal comes back as a warning on the cue.
   */
  if (on('matrix-routing')) {
    const route = (verb, body) => fetch(`/__lpp/matrix/${verb}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(async (res) => {
      if (res.ok) return;
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || `the router answered ${res.status}`);
    });
    /* `input:IN_1` is how a cue stores it; `Input 1` is how a cue sheet says it. */
    const connector = (id) => {
      const c = parseConnectorId(id);
      return c ? `${SIDES[c.side].label} ${logicalIndex(c.key) ?? c.key}` : String(id ?? '?');
    };
    contributions.add('cueAction', {
      kind: 'matrixFeed',
      label: 'Router to a switcher input',
      run: (a) => route('feed', { connector: a.connector, source: a.source }),
      describe: (a) => `feed ${connector(a.connector)} from router input ${a.source}`
    }, 'matrix-routing');
    contributions.add('cueAction', {
      kind: 'matrixSend',
      label: 'Switcher output to router outputs',
      run: (a) => route('send', { connector: a.connector, destinations: a.destinations }),
      describe: (a) => `send ${connector(a.connector)} to router outputs ${[].concat(a.destinations ?? []).join(', ')}`
    }, 'matrix-routing');
  }

  /*
   * The cue stack, offered to plugins as a service — `ctx.use('stack')`. The
   * Timeline owns it, so switching the Timeline off withdraws it. A narrow
   * face on purpose: what a show needs from outside the stack is to move
   * through it and to hear it move, not to rewrite it.
   */
  services.provide('stack', Object.freeze({
    go: () => stack.go(),
    back: () => stack.back(),
    stop: () => stack.stop(),
    gotoId: (id) => stack.gotoId(id),
    get standby() { return stack.standby ? { ...stack.standby } : null; },
    cues: () => stack.cues.map((c) => ({ ...c, actions: c.actions.map((a) => ({ ...a })) })),
    addEventListener: (...a) => stack.addEventListener(...a),
    removeEventListener: (...a) => stack.removeEventListener(...a)
  }), 'timeline');

  const saved = await storage.load();
  if (saved) stack.load(saved);

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

  /*
   * Timecode, and the chase that fires cues off it.
   *
   * Both exist from boot even with no source chosen: the chase costs a timer
   * that returns immediately while nothing is armed, and having them here
   * rather than inside a panel means the clock keeps running when the operator
   * navigates away from the Timeline tab — which, mid-show, they will.
   */
  const timecode = createTimecodeSource();
  const chase = new TimecodeChase({ stack, clock: timecode.clock, rate: 25 });
  /*
   * The chase fires on each reading, not on a timer — see `core/chase.js`. All
   * that is left here is noticing that the feed has *gone*, which no reading
   * will ever announce, and being late to that costs nothing.
   */
  if (on('timecode')) setInterval(() => timecode.clock.poll(), 250);
  chase.addEventListener('fired', (ev) => {
    console.info(TAG, 'timecode fired cue', ev.detail.cue.number || ev.detail.cue.id);
    refresh();
  });

  const matrix = createMatrixPanel({ session, onRefresh: refresh });
  const timeline = createTimelinePanel({
    session, stack, storage, timecode, chase, onRefresh: refresh,
    cueActions: () => listContributions('cueAction')
  });
  /* The plugins' own settings cards are read at every render: the plugins
     load further down, after this is built. */
  const settings = createSettingsPanel({
    session, platform, timecode, onRefresh: refresh,
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
   * Timeline lives in the vendor's own tab strip on Screens / Aux., beside
   * Properties and Memories, as the Console does (at 10, from
   * `plugins/console/`) — per-screen tools belong where an operator already
   * looks for per-screen tools, not in a separate corner of the app. The VPU
   * map does not: it is a whole-device view, so it stays a sidebar entry.
   */
  tabs = new TabHost({
    tabs: byOrder([
      /* `short` is what the tab falls back to when the strip runs out of room,
         which it does at any ordinary window size — the panel is about 360px
         and the vendor's own two tabs spend most of it. It is what the panel
         actually is rather than a truncation, because "Time" reads as neither
         one thing nor the other. */
      { id: 'timeline', label: 'Timeline', short: 'Cues', icon: 'timer-14', order: 20, enabled: () => can('cueStack') && on('timeline'), render: () => timeline.render() },
      /* Layer comes here, at 30 — from its plugin, `plugins/layer/`. */
      /* Layer Groups comes here, at 40 — from its plugin, `plugins/layer-groups/`,
         which is on the strip as well as in the sidebar. */
      ...hosted.tabs
    ])
  });

  shell = new Shell({
    title: 'PLUS',
    /* Ordered by `order`, in tens so a plugin can put itself between two of
       these. The hosted ones already do: VPU Map asks for 20, Companion for
       60 and Pitch Compensation for 80 — see `plugins/`. */
    entries: byOrder([
      /* The Edit page comes first, at 10 — from its plugin, `plugins/edit/`. */
      /* VPU Map comes here, at 20 — from its plugin, `plugins/vpu-map/` —
         Memories at 30, from `plugins/memories/`, and Layer Groups at 40,
         from `plugins/layer-groups/`. */
      /* Also a whole-device view, and for the same reason as the VPU map: it
         is about the back of the frame rather than about one screen. It is
         the only panel here that reads something other than the store — an
         external router is not in the store and never will be. */
      { id: 'matrix', label: 'Matrix Routing', icon: ['connector-gpio-18', 'gpio-18'], order: 50, enabled: () => can('matrixRouting') && on('matrix-routing'), render: () => matrix.render() },
      /* Companion comes here, at 60 — from its plugin, `plugins/companion/` —
         and MIDI Mapping at 70, under Virtual RC400T, from `plugins/midi/`. */
      /* Pitch Compensation comes here, at 80 in the Preconfig flyout — from
         its plugin, `plugins/pitch/`. */
      /* Nor is this one: settings for the installation go where the device's
         own installation settings are, inside the Preconfig flyout. */
      { id: 'settings', label: 'LivePremier Plus', submenuOf: 'Preconfig', order: 90, render: () => settings.render() },
      ...hosted.sidebar
    ])
  });

  session.addEventListener('state', (ev) => {
    console.info(TAG, 'session', ev.detail.state, ev.detail.error || '');
    refresh();
  });
  /*
   * A Router tab on the vendor's own input and output pages, and a Router box
   * in Preconfig ▸ Inputs / Outputs: one socket's slice of the matrix panel,
   * where that socket is already being configured. `ui/router-box.js` says
   * what it matches, and why a socket it cannot identify gets no box at all.
   */
  const routerBoxes = installRouterSurfaces({ session, enabled: () => can('matrixRouting') && on('matrix-routing') });

  session.addEventListener('frame', refresh);
  stack.addEventListener('changed', refresh);


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
  window.__WRU = { session, stack, shell, tabs, transport, platform, timecode, chase, groups: hosted.use('groups'), names, rename, labels: { describe: () => (namer() ? namer().describe() : null) }, routerBoxes, plugins: hosted, contributions: listContributions, services };
}

boot().catch((err) => console.error(TAG, 'failed to start', err));
