/*
 * Layer Lock — the plugin's page half.
 *
 * Wires three things to the page: the lock list (through this plugin's own
 * route), the engine that keeps locked layers in line and holds takes
 * (`engine.js`), and the panel. The engine is fed from `frame`, like the
 * layer groups' gang, so a change made by any route is seen — and `Session`
 * does not dispatch the frames it replays while hydrating, so opening a page
 * onto a desk that is out of step does not rewrite it.
 *
 * The take gate goes into the page hook (`src/hook/ws-hook.js`), which is the
 * only place a TAKE from the vendor's own button can be seen before it
 * leaves. A page whose hook predates the gate has no `setGate`, and the panel
 * says so rather than pretending the lock holds.
 *
 * Offered to the rest of the page as the **`locks` service**: the list, and
 * `takeOnly(targets)`.
 */

import { createLockPanel } from './panel.js';
import { createLockEngine } from './engine.js';

function documentAt(url, log) {
  return {
    async load() {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        return res.ok ? (await res.json()).data ?? null : null;
      } catch (err) {
        log.warn('could not load the layer locks', err);
        return null;
      }
    },
    async save(data) {
      try {
        await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
      } catch (err) {
        log.warn('could not save the layer locks', err);
      }
    }
  };
}

export default function activate(ctx) {
  const hook = typeof window !== 'undefined' ? window.__WRU_HOOK : null;
  let engine = null;

  const lockPanel = createLockPanel({
    session: ctx.session,
    storage: documentAt(ctx.url('/'), ctx.log),
    engine: () => engine,
    names: () => (ctx.use('names') ? ctx.use('names').get() : {}),
    groups: () => (ctx.use('groups') ? ctx.use('groups').list() : null),
    gated: () => !hook || typeof hook.setGate === 'function',
    onRefresh: ctx.refresh
  });

  engine = createLockEngine({
    store: ctx.session.store,
    send: (cmd) => ctx.session.send(cmd),
    locks: () => lockPanel.list(),
    onActivity: (r) => lockPanel.reportActivity(r)
  });
  ctx.session.addEventListener('frame', (ev) => engine.onFrame(ev.detail));
  if (hook && typeof hook.setGate === 'function') hook.setGate(engine.gate);

  ctx.provide('locks', Object.freeze({
    list: () => lockPanel.list(),
    takeOnly: (targets, opts) => engine.takeOnly(targets, opts)
  }));

  ctx.ui.sidebar({
    id: 'layer-lock',
    label: 'Layer Lock',
    icon: ['locked-18', 'locked-12'],
    order: 45,
    render: () => lockPanel.render(),
    busy: () => lockPanel.busy()
  });

  void lockPanel.load();
}
