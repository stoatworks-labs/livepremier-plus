/*
 * Surfaces — the plugin's page half.
 *
 * Wires four things to the page: the document (through this plugin's own
 * route, per switcher), the engine (`engine.js`) into the socket hook as its
 * outbound shaper and onto the session's frames as the follower, the
 * outlines on the vendor's screen cards (`overlay.js`), and the tab
 * (`panel.js`).
 *
 * The toolbar's intent is caught here, in the capture phase on `document`:
 * React handles the click at its root container, so a capture listener on
 * `document` runs first, and the writes the vendor's handler then sends are
 * shaped against the surface before the task ends. The button is known by
 * its icon's sprite id (`OPS` in `core.js`) — the same in 6.1.60 and 6.2.73,
 * and no hashed class name involved.
 *
 * Offered to the rest of the page as the **`surfaces` service**, which the
 * Edit page asks for per use: `surfaceFor`, `surfaces`, `constrain` (its
 * drag stops at the edge as it moves) and `shape` (its programmer's writes).
 */

import { dialectFor } from '../../src/core/dialect.js';
import { listDestinations } from '../../src/core/screens.js';
import { fittedLayers } from '../../src/core/properties.js';
import { layerLabel } from '../../src/core/layer-names.js';
import { lockKey } from '../../src/core/layer-lock.js';
import { normalise, fromOutputs, surfacesOf, boundSurface, constrain, OPS } from './core.js';
import { createSurfaceEngine } from './engine.js';
import { installSurfaceOutlines } from './overlay.js';
import { createSurfacesPanel } from './panel.js';

/** The sprite id a `<use>` draws: `#align-screen-left-18` → `align-screen-left-18`. */
function spriteRef(use) {
  const ref = use.getAttribute('xlink:href') || use.getAttribute('href')
    || (use.href && use.href.baseVal) || '';
  return String(ref).replace(/^.*#/, '');
}

/** The toolbar operation a click landed on, if it is one that is about the screen. */
export function opFromEvent(ev) {
  const target = ev && ev.target;
  if (!target || typeof target.closest !== 'function') return null;
  const holder = target.closest('button, [role="button"], [role="menuitem"]') || target.closest('svg');
  const use = holder && (holder.tagName === 'use' ? holder : holder.querySelector('use'));
  return use ? OPS[spriteRef(use)] || null : null;
}

export default function activate(ctx) {
  const store = ctx.session.store;
  const hook = typeof window !== 'undefined' ? window.__WRU_HOOK : null;
  let doc = normalise(null);
  let timer = null;

  async function load() {
    try {
      const res = await fetch(ctx.url('/'), { cache: 'no-store' });
      if (res.ok) doc = normalise((await res.json()).data);
    } catch (err) {
      ctx.log.warn('could not load the surfaces', err);
    }
  }

  async function save() {
    try {
      await fetch(ctx.url('/'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: doc })
      });
    } catch (err) {
      /* The surfaces stand on this page whatever the save did; the next change retries. */
      ctx.log.warn('could not save the surfaces', err);
    }
  }

  const platform = () => { const d = dialectFor(store); return Boolean(d && d.id === 'nlc'); };
  const locked = (id, layer) => {
    const locks = ctx.use('locks');
    return Boolean(locks && locks.list().includes(lockKey(id, layer)));
  };
  const names = () => (ctx.use('names') ? ctx.use('names').get() : {});
  const destinations = () => (store.ready ? listDestinations(store) : []);

  const engine = createSurfaceEngine({
    store,
    send: (cmd) => ctx.session.send(cmd),
    doc: () => doc,
    exempt: locked,
    onActivity: () => ctx.refresh(),
    tellPage: hook && typeof hook.tellPage === 'function' ? hook.tellPage : null
  });

  /** Destination → what to outline, and which surfaces have a bound layer out, per buffer. */
  function plan() {
    const out = new Map();
    if (!doc.visible) return out;
    const off = engine.outside();
    for (const dest of destinations()) {
      const surfaces = surfacesOf(doc, dest.id);
      if (!surfaces.length) continue;
      const outside = { PGM: new Map(), PRW: new Map() };
      for (const w of off.filter((x) => x.id === dest.id)) {
        const was = outside[w.role].get(w.surface.id);
        outside[w.role].set(w.surface.id, [was, `L${w.layer} outside`].filter(Boolean).join(', '));
      }
      out.set(dest.id, { canvas: dest.canvas, surfaces, outside });
    }
    return out;
  }

  const outlines = installSurfaceOutlines({ plan, enabled: () => platform() && Boolean(store.ready) });

  function settle() {
    clearTimeout(timer);
    timer = setTimeout(() => { outlines.sweepNow(); ctx.refresh(); }, 50);
  }

  const view = createSurfacesPanel({
    doc: () => doc,
    change(next) {
      const before = JSON.stringify(doc.bindings);
      doc = normalise(next);
      if (JSON.stringify(doc.bindings) !== before) engine.reset();
      outlines.refresh();
      settle();
      void save();
    },
    destinations,
    layers: (id) => fittedLayers(store, id)
      .filter((l) => /^\d+$/.test(String(l.key)))
      .map((l) => ({ key: String(l.key), label: layerLabel(names(), id, String(l.key), { short: true }) })),
    outputs: (id) => {
      const d = dialectFor(store);
      return d && d.outputFormats ? fromOutputs(d.outputFormats(store), id) : [];
    },
    outside: () => engine.outside(),
    letGo: () => engine.letGo(),
    locked,
    recent: () => engine.recent(),
    describe: () => outlines.describe(),
    ready: () => Boolean(store.ready),
    platform,
    hooked: () => Boolean(hook && typeof hook.setShaper === 'function')
  });

  ctx.session.addEventListener('frame', (ev) => { engine.onFrame(ev.detail); outlines.refresh(); });
  if (store.addEventListener) store.addEventListener('ready', () => { outlines.refresh(); settle(); });
  if (hook && typeof hook.setShaper === 'function') hook.setShaper({ wants: engine.wants, shape: engine.shape });
  if (typeof document !== 'undefined') {
    document.addEventListener('click', (ev) => {
      const op = opFromEvent(ev);
      if (op) engine.setIntent(op);
    }, true);
  }

  ctx.provide('surfaces', Object.freeze({
    surfaceFor: (id, layer) => (platform() ? boundSurface(doc, id, layer) : null),
    surfaces: (id) => (platform() ? surfacesOf(doc, id) : []),
    /** A rectangle a bound layer may have, given where it was asked to go. */
    constrain(id, layer, rect, opts = {}) {
      const s = platform() ? boundSurface(doc, id, layer) : null;
      return s ? constrain(rect, s, { canvas: engine.canvasOf(id), ...opts }) : rect;
    },
    /** A run of writes made safe, read against `read` — the programmer's own buffer. */
    shape: (cmds, read) => (platform() ? engine.shapeCmds(cmds, read) : cmds)
  }));

  ctx.ui.tab({
    id: 'surfaces',
    label: 'Surfaces',
    short: 'Surf',
    icon: ['trap-layer-on-screen-18', 'grid-3-14'],
    order: 55,
    render: () => view.render(),
    busy: () => view.busy()
  });

  void load().then(() => { outlines.refresh(); settle(); });
}
