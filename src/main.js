/*
 * Entry point, running in the page's own world.
 *
 * By the time this module executes, the document_start hook has already
 * wrapped WebSocket and has been recording frames since before the vendor
 * bundle booted. All that is left is to confirm this really is a Web RCS
 * page, mirror the device store, and put two entries in the sidebar.
 *
 * If the page turns out not to be Web RCS, nothing is mounted and nothing is
 * fetched. The hook stays inert, and the only cost to an unrelated site is a
 * wrapped constructor.
 */

import { Session } from './core/session.js';
import { CueStack } from './core/cuestack.js';
import { PageSocketTransport } from './transports/page-socket.js';
import { Shell } from './ui/shell.js';
import { createVpuPanel } from './ui/vpu-panel.js';
import { createTimelinePanel } from './ui/timeline-panel.js';

const TAG = '[webRCS unleashed]';

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
 * Cue stacks are stored per device, keyed by origin.
 *
 * The page cannot see chrome.storage from the MAIN world, so persistence goes
 * through the isolated-world loader over window messages. localStorage would
 * have been simpler but it belongs to the device's own web app, and writing
 * our data into the vendor's storage is not ours to do.
 */
function makeStorage() {
  const key = 'wru:stack:' + location.host;
  const pending = new Map();
  let seq = 0;

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__wru !== 'storage:result') return;
    const resolve = pending.get(ev.data.id);
    if (resolve) { pending.delete(ev.data.id); resolve(ev.data.value); }
  });

  const call = (op, value) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    window.postMessage({ __wru: 'storage', id, op, key, value }, '*');
    setTimeout(() => { if (pending.delete(id)) resolve(null); }, 2000);
  });

  return { save: (data) => call('set', data), load: () => call('get') };
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

  const session = new Session(transport);
  const storage = makeStorage();
  const stack = new CueStack({ send: (cmd) => session.send(cmd) });

  const saved = await storage.load();
  if (saved) stack.load(saved);

  const refresh = throttleFrame(() => shell.refresh());

  const vpu = createVpuPanel({ session, onRefresh: refresh });
  const timeline = createTimelinePanel({ session, stack, storage, onRefresh: refresh });

  const shell = new Shell({
    title: 'UNLEASHED',
    entries: [
      { id: 'vpu', label: 'VPU Map', icon: 'hardware-18', render: () => vpu.render() },
      { id: 'timeline', label: 'Timeline', icon: 'timer-18', render: () => timeline.render() }
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
  if (document.querySelector('[class*="sidebar-module__c___"]')) mount();
  else {
    const obs = new MutationObserver(() => {
      if (document.querySelector('[class*="sidebar-module__c___"]')) { obs.disconnect(); mount(); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 60000);
  }

  await session.start();
  console.info(TAG, 'ready on', location.host, '- store', session.store.ready ? 'mirrored' : 'unavailable');
  window.__WRU = { session, stack, shell, transport };
}

boot().catch((err) => console.error(TAG, 'failed to start', err));
