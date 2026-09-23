/*
 * Layer Groups — the plugin's page half.
 *
 * Several layers, across screens, driven as one — and the **gang**, which
 * makes a ganged group follow whichever of its members was changed. The panel
 * owns the list and its file; the gang reads the same list, live, because the
 * panel edits it while the gang is running and a snapshot would gang the
 * arrangement the page was opened with. `src/core/groups.js` has the rules,
 * including why the gang cannot loop.
 *
 * Offered to the rest of the page as the **`groups` service**: the list, the
 * recently used targets, and `expect(cmds)` — Send-to's way of saying a whole
 * group has already been written, so the gang does not chase the echoes.
 *
 * On the strip *as well as* in the sidebar, which no other panel is. The
 * sidebar is the right home — a group crosses screens, so it is a
 * whole-device view — but it is also the thing you reach for while looking at
 * the screens, and walking to the sidebar and back to check which layers a
 * group holds is the kind of trip that stops an operator using a feature at
 * all. ⚠️ It is the fourth of ours on a strip about 360px wide; the fit ladder
 * in `ui/tabs.js` drops a rung rather than overflowing, but the strip reaches
 * icon-only at a wider window than it did, which is why a fifth would need a
 * better argument than this one had.
 */

import { createGroupsPanel } from './panel.js';
import { createGang } from '../../src/core/groups.js';

/** The groups file, through this plugin's own route. */
function documentAt(url, log) {
  return {
    async load() {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        return res.ok ? (await res.json()).data ?? null : null;
      } catch (err) {
        log.warn('could not load the layer groups', err);
        return null;
      }
    },
    async save(data) {
      try {
        await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
      } catch (err) {
        /* A failed save must not interrupt an operator mid-show; the next
           edit retries. */
        log.warn('could not save the layer groups', err);
      }
    }
  };
}

export default function activate(ctx) {
  const namer = () => ctx.use('names');
  const groups = createGroupsPanel({
    session: ctx.session,
    storage: documentAt(ctx.url('/'), ctx.log),
    onRefresh: ctx.refresh,
    names: () => (namer() ? namer().get() : {})
  });

  /*
   * Wired to `frame` rather than to anything of ours on purpose — the point is
   * that a ganged group follows a change made by *any* route, the vendor's own
   * drag-and-drop and a memory recall included. `Session` does not dispatch
   * the frames it replays while hydrating, so opening a page onto a desk that
   * is already out of step does not rewrite it.
   */
  const gang = createGang({
    store: ctx.session.store,
    groups: () => groups.list(),
    send: (cmd) => ctx.session.send(cmd),
    onActivity: (report) => groups.reportActivity(report)
  });
  ctx.session.addEventListener('frame', (ev) => gang.onFrame(ev.detail));

  ctx.provide('groups', Object.freeze({
    /** The groups as they stand. Read per use; the panel edits them live. */
    list: () => groups.list(),
    recent: () => groups.recent(),
    remember: (target) => groups.remember(target),
    load: () => groups.load(),
    /** Commands a write to a whole group already sent: the gang lets their echoes pass. */
    expect: (cmds) => gang.expect(cmds)
  }));

  const entry = { id: 'groups', render: () => groups.render(), busy: () => groups.busy(), order: 40 };
  ctx.ui.tab({ ...entry, label: 'Groups', short: 'Grps', icon: ['group-14', 'layer-stacked-14'] });
  ctx.ui.sidebar({ ...entry, label: 'Layer Groups', icon: ['group-18', 'layer-stacked-18'] });

  void groups.load();
}
