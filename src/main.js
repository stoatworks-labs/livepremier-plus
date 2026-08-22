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
import { createTimelinePanel } from './ui/timeline-panel.js';
import { installMathFields } from './ui/math-fields.js';
import { TabHost, watchVendorTabs } from './ui/tabs.js';
import { createConsolePanel } from './ui/console-panel.js';
import { createMidiPanel } from './ui/midi-panel.js';
import { createSettingsPanel } from './ui/settings-panel.js';
import { detectPlatform, supports } from './core/platform.js';

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
 * Cue stacks are persisted by the launcher, not by the browser.
 *
 * The extension version of this brokered chrome.storage through a content
 * script over window messages, because the page had no other way to reach it.
 * The launcher is a process with a disk, so the panels just ask it — and it
 * keys the stack by the device it is proxying, which is the right key anyway:
 * a cue list is written against one box's screens and presets.
 *
 * Deliberately not localStorage. That belongs to the vendor's own web app and
 * writing our data into it is not ours to do — a point that survived the move
 * off the extension unchanged.
 */
function makeStorage() {
  const url = '/__lpp/stack';
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

  /*
   * Arithmetic in the vendor's own numeric fields — `1080-80` in a layer width
   * gives 1000. Installed as soon as we know this is Web RCS, and before the
   * panels, because it is useful on its own: it improves the stock UI whether
   * or not anyone ever opens a panel of ours.
   */
  installMathFields();

  const session = new Session(transport);
  const storage = makeStorage();
  const stack = new CueStack({ send: (cmd) => session.send(cmd) });

  const saved = await storage.load();
  if (saved) stack.load(saved);

  /* One repaint per frame, covering whichever of our surfaces is on screen. */
  const refresh = throttleFrame(() => { shell.refresh(); tabs.refresh(); });

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

  const vpu = createVpuPanel({ session, platform, onRefresh: refresh });
  const timeline = createTimelinePanel({ session, stack, storage, onRefresh: refresh });
  const consolePanel = createConsolePanel({ session, onRefresh: refresh });
  const midi = createMidiPanel({ session, onRefresh: refresh });
  const settings = createSettingsPanel({ session, platform, onRefresh: refresh });

  /*
   * Console and Timeline live in the vendor's own tab strip on Screens / Aux.,
   * beside Properties and Memories — the two per-screen tools belong where an
   * operator already looks for per-screen tools, not in a separate corner of
   * the app. The VPU map does not: it is a whole-device view, so it stays a
   * sidebar entry of its own.
   */
  const tabs = new TabHost({
    tabs: [
      /* `short` is what the tab falls back to when the strip runs out of room,
         which it does at any ordinary window size — the panel is about 360px
         and the vendor's own two tabs spend most of it. Both are what the
         panel actually is rather than a truncation, because "Cons" and "Time"
         read as neither one thing nor the other. */
      { id: 'console', label: 'Console', short: 'Cmd', icon: 'mini-list-14', enabled: () => can('console'), render: () => consolePanel.render() },
      { id: 'timeline', label: 'Timeline', short: 'Cues', icon: 'timer-14', enabled: () => can('cueStack'), render: () => timeline.render() }
    ]
  });

  const shell = new Shell({
    title: 'PLUS',
    entries: [
      /* Midra 4K and Alta 4K have no VPU to map — their processing is fixed
         rather than allocated — so on those the entry is simply not there. */
      { id: 'vpu', label: 'VPU Map', icon: 'hardware-18', enabled: () => can('vpuMap'), render: () => vpu.render() },
      /* Not in the PLUS section: MIDI mapping belongs beside the vendor's own
         remote-panel page, because both are about control surfaces. */
      { id: 'midi', label: 'MIDI Mapping', icon: 'gpio-18', after: 'Virtual RC400T', render: () => midi.render() },
      /* Nor is this one: settings for the installation go where the device's
         own installation settings are, inside the Preconfig flyout. */
      { id: 'settings', label: 'LivePremier Plus', submenuOf: 'Preconfig', render: () => settings.render() }
    ]
  });

  session.addEventListener('state', (ev) => {
    console.info(TAG, 'session', ev.detail.state, ev.detail.error || '');
    refresh();
  });
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
  console.info(TAG, 'platform', here.name, here.model || '', here.firmware || '');
  shell.remount();
  tabs.remount();

  console.info(TAG, 'ready on', location.host, '- store', session.store.ready ? 'mirrored' : 'unavailable');
  window.__WRU = { session, stack, shell, tabs, transport, platform };
}

boot().catch((err) => console.error(TAG, 'failed to start', err));
