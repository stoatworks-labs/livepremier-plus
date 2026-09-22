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
import { createVpuPanel } from './ui/vpu-panel.js';
import { createMatrixPanel } from './ui/matrix-panel.js';
import { createPitchPanel } from './ui/pitch-panel.js';
import { createTimelinePanel } from './ui/timeline-panel.js';
import { installMathFields } from './ui/math-fields.js';
import { TabHost, watchVendorTabs } from './ui/tabs.js';
import { createConsolePanel } from './ui/console-panel.js';
import { createMidiPanel } from './ui/midi-panel.js';
import { createSettingsPanel } from './ui/settings-panel.js';
import { createMemoriesPanel } from './ui/memories-panel.js';
import { createPropertiesPanel } from './ui/properties-panel.js';
import { createGroupsPanel } from './ui/groups-panel.js';
import { createEditPanel } from './ui/edit-panel.js';
import { createProgrammer, EDIT } from './core/programmer.js';
import { composeMemory, saveViaPreview, applyLook, lookFromMemory } from './core/save-look.js';
import { fromMemory } from './core/preset-file.js';
import { installLayerLabels } from './ui/layer-labels.js';
import { installRouterSurfaces } from './ui/router-box.js';
import { normalise as normaliseNames, withName } from './core/layer-names.js';
import { installSendTo } from './ui/send-to.js';
import { createGang } from './core/groups.js';
import { detectPlatform, supports } from './core/platform.js';
import { isEnabled as pluginOn } from './core/plugins.js';
import { loadPlugins, byOrder } from './ui/plugin-host.js';
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

/**
 * Save a programmed look into a real memory slot.
 *
 * Two routes, and the operator chooses on the page rather than here: the
 * direct one writes the bank itself and touches no bus at all, and the fallback
 * borrows preview and puts it back. `core/save-look.js` sets out both, and
 * `server/memory-import.js` says why the direct one has a condition attached
 * that this process cannot check for itself.
 */
async function saveLook(programmer, session, { id, slot, label, route }) {
  if (route === 'preview') {
    return saveViaPreview({ session, programmer, id, slot, label });
  }

  const memory = composeMemory({ programmer, id, slot, label });
  if (!memory) return { ok: false, message: `${id}: nothing programmed to save` };

  const res = await fetch('/__lpp/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memories: [memory] })
  });
  const body = await res.json().catch(() => ({}));

  if (res.ok && body.ok) {
    return { ok: true, message: `memory ${slot} written from ${id} — no buffer touched` };
  }
  /* The expected failure on a real switcher is that it cannot see this
     machine's disk, and the operator's next move is the other route. Say so
     rather than making them work it out. */
  return {
    ok: false,
    message: `${body.error || 'the save failed'} — try the “Via preview” route`
  };
}

/** Read a memory back out of the bank and into the programmer. */
async function loadLook(programmer, { id, slot }) {
  const res = await fetch(`/__lpp/memory?slots=${encodeURIComponent(slot)}`, { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) return { ok: false, message: body.error || `could not read memory ${slot}` };

  const first = (body.memories || [])[0];
  if (!first) return { ok: false, message: `memory ${slot} is empty` };

  const memory = fromMemory(first);
  const sent = applyLook({ programmer, id, look: lookFromMemory(memory) });
  if (!sent) return { ok: false, message: `memory ${slot} had nothing this screen could take` };

  return {
    ok: true,
    message: `memory ${slot}${memory.label ? ` “${memory.label}”` : ''} loaded into ${id}`
      + ` (${sent} properties)`
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

  /*
   * Arithmetic in the vendor's own numeric fields — `1080-80` in a layer width
   * gives 1000. Installed as soon as we know this is Web RCS, and before the
   * panels, because it is useful on its own: it improves the stock UI whether
   * or not anyone ever opens a panel of ours.
   */
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

  if (on('arithmetic')) installMathFields();

  const session = new Session(transport);
  const storage = makeStorage();
  /*
   * The cue engine spells its writes for whichever platform the store turns
   * out to be — LivePremier or Midra 4K / Alta 4K — and asks at fire time,
   * because the store is empty when this runs and may be re-pointed at a
   * different frame mid-show. Before the store has said, every command
   * declines to be built and a GO sends nothing. See `core/commands.js`.
   */
  const stack = new CueStack({
    send: (cmd) => session.send(cmd),
    commands: () => commandsFor(dialectFor(session.store)),
    /*
     * Matrix actions do not go on the vendor socket — an external router is
     * not in the device store and the switcher has never heard of it. They go
     * to our own process, which holds the router connections.
     *
     * Not awaited, for the same reason a take is not: the router acknowledges
     * receipt rather than success, so there is nothing to wait for that would
     * mean anything. A failure is logged where an operator will see it.
     */
    routeMatrix: (action) => {
      const path = action.kind === 'matrixFeed' ? 'feed' : 'send';
      const body = action.kind === 'matrixFeed'
        ? { connector: action.connector, source: action.source }
        : { connector: action.connector, destinations: action.destinations };
      fetch(`/__lpp/matrix/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(async (res) => {
        if (res.ok) return;
        const payload = await res.json().catch(() => ({}));
        console.warn(TAG, 'matrix cue refused:', payload.error || res.status);
      }).catch((err) => console.warn(TAG, 'matrix cue failed', err));
    }
  });

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
  let memories = null;
  let properties = null;
  let groups = null;
  let edit = null;
  let editProps = null;
  /* The plugins' page halves, loaded below — see `ui/plugin-host.js`. */
  let hosted = null;
  const editing = () =>
    [memories, properties, groups, edit, editProps].some((p) => p && p.busy && p.busy())
    || Boolean(hosted && hosted.busy());
  const refresh = throttleFrame(() => {
    if (editing()) return;
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

  const vpu = createVpuPanel({ session, platform, onRefresh: refresh });
  const matrix = createMatrixPanel({ session, onRefresh: refresh });
  const timeline = createTimelinePanel({ session, stack, storage, timecode, chase, onRefresh: refresh });
  const consolePanel = createConsolePanel({ session, onRefresh: refresh });
  const pitch = createPitchPanel({ session, onRefresh: refresh });
  const midi = createMidiPanel({ session, onRefresh: refresh });
  const settings = createSettingsPanel({ session, platform, timecode, onRefresh: refresh });
  /*
   * The two panels the vendor already has tabs for, rebuilt so they can leave
   * the window. Web RCS's own Memories and Properties panes are React, and a
   * React pane cannot be relocated — its listeners are delegated to the app's
   * root container, so a copy moved into a second window paints and does
   * nothing. These read the mirror instead. See the heads of
   * `ui/memories-panel.js` and `ui/properties-panel.js`.
   */
  memories = createMemoriesPanel({ session, onRefresh: refresh });
  properties = createPropertiesPanel({
    session, onRefresh: refresh, names: () => names(),
    onRename: on('layer-names') ? (...a) => rename(...a) : null
  });
  /*
   * Layer groups, and the two things that read them.
   *
   * The panel owns the list and its file; the `…` menu on the vendor's source
   * cards aims at it; and the gang follows a change made anywhere. All three
   * are handed the same object rather than a copy, because the panel edits
   * the list while the other two are running and a snapshot would gang the
   * arrangement the page was opened with. See `core/groups.js`.
   */
  groups = createGroupsPanel({ session, storage: makeStorage('/__lpp/groups'), onRefresh: refresh, names: () => names() });

  /*
   * The Edit page: a preset buffer that is not on the device.
   *
   * The programmer is a session in its own right — same `{store, send}`
   * contract, same buffer-keyed addressing — so the Layer panel drives it
   * unchanged. It gets its OWN properties panel rather than sharing the one on
   * the vendor's tab strip, because the two are pointed at different buffers
   * and `view.mode` is one field: sharing would have the tab strip's Layer tab
   * silently following the Edit page's selection into a buffer the device does
   * not have. See `core/programmer.js`.
   */
  const programmer = createProgrammer({ session });
  editProps = createPropertiesPanel({
    session: programmer,
    onRefresh: refresh,
    popoutEnabled: false,
    names: () => names(),
    onRename: on('layer-names') ? (...a) => rename(...a) : null,
    /* The programmer's buffer is the only one this panel offers, and the
       roles are off with it: EDIT is on neither bus and never can be. */
    buffers: [EDIT],
    roles: false
  });
  edit = createEditPanel({
    session,
    programmer,
    properties: editProps,
    onRefresh: refresh,
    names: () => names(),
    onSave: (req) => saveLook(programmer, session, req),
    onLoad: (req) => loadLook(programmer, req)
  });
  programmer.addEventListener('changed', refresh);

  /*
   * Layer names.
   *
   * A flat `{ 'S1/2': 'IMAG' }` map held here rather than inside a panel,
   * because four surfaces read it — the Layer panel that edits it, the groups
   * panel, the `…` menu, and `ui/layer-labels.js` writing into the vendor's
   * own lists — and a copy per surface is a copy that goes stale the moment
   * somebody renames. See `core/layer-names.js` for why the device cannot
   * hold these itself.
   */
  const namesStorage = makeStorage('/__lpp/layer-names');
  let layerNames = {};
  const names = () => layerNames;
  const rename = (id, layer, value) => {
    layerNames = withName(layerNames, id, layer, value);
    namesStorage.save({ version: 1, names: layerNames });
    labels.refresh();
    refresh();
  };

  /*
   * The plugins' page halves.
   *
   * Loaded now, after the app's own panels and before the strip and the
   * sidebar are built, so what they register lands in both lists beside the
   * app's own entries — ordered by `order`, like everything else there. Only
   * the plugins the server says are on are loaded at all; one that fails is
   * logged and left out, and the rest of the page comes up regardless.
   */
  hosted = await loadPlugins({ session, platform, can, refresh, settings: bootSettings });

  /*
   * Console and Timeline live in the vendor's own tab strip on Screens / Aux.,
   * beside Properties and Memories — the two per-screen tools belong where an
   * operator already looks for per-screen tools, not in a separate corner of
   * the app. The VPU map does not: it is a whole-device view, so it stays a
   * sidebar entry of its own.
   */
  const tabs = new TabHost({
    tabs: byOrder([
      /* `short` is what the tab falls back to when the strip runs out of room,
         which it does at any ordinary window size — the panel is about 360px
         and the vendor's own two tabs spend most of it. Both are what the
         panel actually is rather than a truncation, because "Cons" and "Time"
         read as neither one thing nor the other. */
      /* `mini-list-14` is LivePremier's sprite; Midra's has no list glyph and
         `bars-14` is the nearest it draws. `icon()` takes the first the page has. */
      { id: 'console', label: 'Console', short: 'Cmd', icon: ['mini-list-14', 'bars-14'], order: 10, enabled: () => can('console') && on('console'), render: () => consolePanel.render() },
      { id: 'timeline', label: 'Timeline', short: 'Cues', icon: 'timer-14', order: 20, enabled: () => can('cueStack') && on('timeline'), render: () => timeline.render() },
      /*
       * "Layer" and not "Properties": the vendor's own Properties tab is two
       * along in the same strip, and two tabs with one name is a worse problem
       * than a name that is only most of the truth. It is also the honest
       * difference between them — theirs follows the layer you have clicked,
       * which is React state we cannot read, so ours makes you name one.
       *
       * There is deliberately no tab for the memory banks. They are a
       * whole-device view — 1000 screen slots and 500 master ones are not
       * per-screen — so they sit in the sidebar beside the VPU map instead.
       */
      { id: 'layer', label: 'Layer', short: 'Layer', icon: 'properties-14', order: 30, enabled: () => can('layerProperties') && on('layer'), render: () => properties.render() },
      /*
       * Layer Groups is on the strip *as well as* in the sidebar, which no
       * other panel is.
       *
       * The sidebar entry is still the right home — a group crosses screens,
       * so it is a whole-device view. But it is also the thing you reach for
       * while you are looking at the screens, and walking to the sidebar and
       * back to check which layers a group holds is the kind of trip that
       * stops an operator using a feature at all. Both, deliberately.
       *
       * ⚠️ This is the fourth of ours on a strip about 360px wide, beside the
       * vendor's own Properties and Memories. The fit ladder in `ui/tabs.js`
       * measures and drops a rung rather than overflowing, so nothing breaks
       * — but the whole strip now reaches icon-only at a wider window than it
       * did. That is the cost, and it is why a fifth would need a better
       * argument than this one had.
       */
      { id: 'groups', label: 'Groups', short: 'Grps', icon: ['group-14', 'layer-stacked-14'], order: 40, enabled: () => can('layerGroups') && on('layer-groups'), render: () => groups.render() },
      ...hosted.tabs
    ])
  });

  const shell = new Shell({
    title: 'PLUS',
    /* Ordered by `order`, in tens so a plugin can put itself between two of
       these. Companion, a plugin, asks for 60: after Matrix Routing. */
    entries: byOrder([
      /* Midra 4K and Alta 4K have no VPU to map — their processing is fixed
         rather than allocated — so on those the entry is simply not there. */
      /*
       * The Edit page is first, and it is a page rather than a tab.
       *
       * It is the Screens / Aux. layout with one row instead of two, so it is
       * the same shape as a whole vendor page and not a panel beside one — and
       * it has its own sources column, which no tab strip 360px wide could
       * hold. It leads the section because it is the only entry here an
       * operator will open before the show rather than during it.
       */
      { id: 'edit', label: 'Edit', icon: ['properties-18', 'layer-stacked-18'], order: 10, enabled: () => can('layerProperties') && on('edit'), render: () => edit.render() },
      { id: 'vpu', label: 'VPU Map', icon: 'hardware-18', order: 20, enabled: () => can('vpuMap') && on('vpu-map'), render: () => vpu.render() },
      /* The three memory banks, which are a whole-device view like the VPU map
         and unlike everything on the Screens / Aux. strip: master memories
         cover every screen at once, and the screen bank is one flat list of
         1000 slots that any screen can recall from. */
      { id: 'memories', label: 'Memories', icon: 'shotbox-18', order: 30, enabled: () => can('cueStack') && on('memories'), render: () => memories.render() },
      /* Also a whole-device view, and for the sharpest version of the reason:
         a group exists precisely because it crosses screens, so it could not
         live on a per-screen tab strip even if that strip had room. */
      { id: 'groups', label: 'Layer Groups', icon: ['group-18', 'layer-stacked-18'], order: 40, enabled: () => can('layerGroups') && on('layer-groups'), render: () => groups.render() },
      /* Also a whole-device view, and for the same reason as the VPU map: it
         is about the back of the frame rather than about one screen. It is
         the only panel here that reads something other than the store — an
         external router is not in the store and never will be. */
      { id: 'matrix', label: 'Matrix Routing', icon: ['connector-gpio-18', 'gpio-18'], order: 50, enabled: () => can('matrixRouting') && on('matrix-routing'), render: () => matrix.render() },
      /* Companion comes here, at 60 — from its plugin, `plugins/companion/`. */
      /* Not in the PLUS section: MIDI mapping belongs beside the vendor's own
         remote-panel page, because both are about control surfaces. */
      { id: 'midi', label: 'MIDI Mapping', icon: ['gpio-18', 'connector-gpio-18'], after: 'Virtual RC400T', order: 70, enabled: () => on('midi'), render: () => midi.render() },
      /* Under Preconfig because that is literally where the two fields it
         fills in live — Preconfig > Canvas > Pitch. A panel that computes a
         number you then type in one flyout over belongs in the same flyout. */
      { id: 'pitch', label: 'Pitch Compensation', submenuOf: 'Preconfig', order: 80, enabled: () => can('pitchCompensation') && on('pitch'), render: () => pitch.render() },
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
   * Names into the vendor's own layer lists.
   *
   * ⚠️ The most fragile thing in the app — it writes into the middle of Web
   * RCS's own markup rather than owning its own — and the only way a layer
   * name appears anywhere an operator is already looking. `ui/layer-labels.js`
   * says what it matches and why, and reports what it is managing to label so
   * a firmware that moves a list shows up as a number rather than as silence.
   */
  const labels = installLayerLabels({ names, enabled: () => can('layerGroups') && on('layer-names') });
  /*
   * A Router tab on the vendor's own input and output pages, and a Router box
   * in Preconfig ▸ Inputs / Outputs: one socket's slice of the matrix panel,
   * where that socket is already being configured. `ui/router-box.js` says
   * what it matches, and why a socket it cannot identify gets no box at all.
   */
  const routerBoxes = installRouterSurfaces({ session, enabled: () => can('matrixRouting') && on('matrix-routing') });

  session.addEventListener('frame', refresh);
  stack.addEventListener('changed', refresh);

  /*
   * The gang: a ganged group follows whichever of its members was changed.
   *
   * Wired to `frame` rather than to anything of ours on purpose — the point
   * is that it follows a change made by *any* route, including the vendor's
   * own drag-and-drop and a memory recall. `Session` does not dispatch the
   * frames it replays during hydration, so opening a page onto a desk that is
   * already out of step does not rewrite it; the gang only ever acts on a
   * change someone just made. `core/groups.js` has the rest of the rules,
   * including why this cannot loop.
   */
  const gang = createGang({
    store: session.store,
    groups: () => (groups ? groups.list() : []),
    send: (cmd) => session.send(cmd),
    onActivity: (report) => { groups.reportActivity(report); }
  });
  /* A switched-off Layer Groups plugin must not go on ganging in the background. */
  if (on('layer-groups')) session.addEventListener('frame', (ev) => gang.onFrame(ev.detail));

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

  /*
   * The Edit page's snapshot clock runs from boot rather than from the page
   * being opened: the shell has no per-entry show/hide hook, and the clock
   * already costs nothing when nothing is on screen — it skips a hidden
   * document outright and drops every `<img>` that is no longer connected, so
   * a closed page leaves it iterating an empty set.
   */
  if (on('edit')) edit.start();

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

  /*
   * The groups, and the `…` on the vendor's source cards.
   *
   * Both wait for the store: the menu has nothing to offer without a screen
   * list, and a card cannot be named for a source without a dialect to ask.
   * The installer declines on a platform that has no layers to group, which
   * is the same answer the sidebar entry gives.
   */
  await groups.load();
  layerNames = normaliseNames(await namesStorage.load()).names;
  labels.refresh();
  const sendTo = installSendTo({
    session,
    groups,
    names,
    enabled: () => can('layerGroups') && on('send-to'),
    /*
     * A send aimed at a whole group has already written every member, so the
     * echoes are that send landing — not one member drifting for the rest to
     * chase. Telling the gang stops it writing the same values a second time
     * and reporting that as work it did. A send to a single layer is NOT
     * announced, even when that layer is in a group: following it is the
     * whole point of ganging. See `core/groups.js`.
     */
    onWrote: ({ target, cmds }) => { if (target.kind === 'group') gang.expect(cmds); },
    onSent: (r) => console.info(TAG, 'send to', r.source, r.mode, '->', r.sent, 'layer(s)')
  });

  console.info(TAG, 'ready on', location.host, '- store', session.store.ready ? 'mirrored' : 'unavailable');
  window.__WRU = { session, stack, shell, tabs, transport, platform, timecode, chase, groups, gang, sendTo, names, rename, labels, routerBoxes, plugins: hosted };
}

boot().catch((err) => console.error(TAG, 'failed to start', err));
