/*
 * Aux follow — the plugin's page half.
 *
 * Wires three things to the page: the document (per switcher, through this
 * plugin's own route), the follower (`core.js`) onto the session's frames, and
 * the tab (`panel.js`). `core.js` has the rules — two modes, role not letter,
 * owed writes mid-take — and why it cannot loop.
 *
 * The follower is primed whenever the list changes and when the store
 * arrives: it tells a take landing from noise by the take state it saw last,
 * and the session applies a frame to the mirror before dispatching it.
 */

import { dialectFor } from '../../src/core/dialect.js';
import { listDestinations, sourceLabel } from '../../src/core/screens.js';
import { fittedLayers } from '../../src/core/properties.js';
import { layerLabel } from '../../src/core/layer-names.js';
import { normalise, setFollow, followOf, describe, createFollower } from './core.js';
import { createAuxFollowPanel } from './panel.js';

export default function activate(ctx) {
  const store = ctx.session.store;
  let doc = normalise(null);

  async function load() {
    try {
      const res = await fetch(ctx.url('/'), { cache: 'no-store' });
      if (res.ok) doc = normalise((await res.json()).data);
    } catch (err) {
      ctx.log.warn('could not load the aux follows', err);
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
      /* The follows stand on this page whatever the save did; the next change retries. */
      ctx.log.warn('could not save the aux follows', err);
    }
  }

  const platform = () => { const d = dialectFor(store); return Boolean(d && d.id === 'nlc'); };
  const names = () => (ctx.use('names') ? ctx.use('names').get() : {});
  const layersOf = (id) => fittedLayers(store, id)
    .map((l) => ({ key: String(l.key), label: layerLabel(names(), id, String(l.key), { short: true }) }));

  const follower = createFollower({
    store,
    follows: () => (platform() ? doc.follows : []),
    send: (cmd) => ctx.session.send(cmd),
    onActivity: () => ctx.refresh()
  });

  const view = createAuxFollowPanel({
    doc: () => doc,
    set(aux, layer, from, mode) {
      doc = setFollow(doc, aux, layer, from, mode);
      follower.prime();
      const f = followOf(doc, aux, layer);
      /* Setting one is the operator asking: bring it into line now. */
      if (f) follower.sync(f);
      ctx.refresh();
      void save();
    },
    auxes: () => listDestinations(store).filter((d) => d.kind === 'aux').map((d) => ({ id: d.id, label: d.label || '' })),
    layers: layersOf,
    leaders: () => listDestinations(store).filter((d) => d.kind === 'screen')
      .flatMap((d) => layersOf(d.id).map((l) => ({ id: d.id, layer: l.key, label: `${d.id} · ${l.label}${d.label ? ` (${d.label})` : ''}` }))),
    describe: (f) => describe(store, f),
    sourceName: (v) => (v === 'NONE' ? 'nothing' : sourceLabel(v, store) || v),
    recent: () => follower.recent(),
    owed: () => follower.owed(),
    ready: () => Boolean(store.ready),
    platform
  });

  ctx.session.addEventListener('frame', (ev) => follower.onFrame(ev.detail));
  if (store.addEventListener) store.addEventListener('ready', () => follower.prime());

  ctx.ui.tab({
    id: 'aux-follow',
    label: 'Aux follow',
    short: 'Follow',
    icon: ['linked-h-18', 'auxiliary-14', 'layer-stacked-14'],
    order: 65,
    render: () => view.render(),
    busy: () => view.busy()
  });

  void load().then(() => { follower.prime(); ctx.refresh(); });
}
