/*
 * Send to — the plugin's page half.
 *
 * A `…` on every source card in Web RCS: route that input to a layer, or to a
 * whole layer group, in preview or program, without a drag. It writes into
 * the vendor's own cards, so `send-to.js` says what it matches and why a card
 * it cannot name a source for gets no button.
 *
 * Needs Layer Groups (the manifest says so, so it starts after it), and waits
 * for the store before it installs: the menu has nothing to offer without a
 * screen list, and a card cannot be named for a source without a dialect to
 * ask.
 */

import { installSendTo } from './send-to.js';

/** Resolves once the device store has arrived — at once if it already has. */
const storeReady = (session) => (session.store.ready
  ? Promise.resolve()
  : new Promise((resolve) => session.store.addEventListener('ready', () => resolve(), { once: true })));

/* Standing in for Layer Groups if it failed to start: single layers only. */
const NO_GROUPS = Object.freeze({ list: () => [], recent: () => [], remember() {}, expect() {} });

export default function activate(ctx) {
  const groups = () => ctx.use('groups') || NO_GROUPS;
  const namer = () => ctx.use('names');
  void storeReady(ctx.session).then(() => {
    installSendTo({
      session: ctx.session,
      groups: {
        list: () => groups().list(),
        recent: () => groups().recent(),
        remember: (target) => groups().remember(target)
      },
      names: () => (namer() ? namer().get() : {}),
      enabled: () => ctx.can('layerGroups'),
      /*
       * A send aimed at a whole group has already written every member, so
       * the echoes are that send landing — not one member drifting for the
       * rest to chase. Telling the gang stops it writing the same values a
       * second time and reporting that as work it did. A send to a single
       * layer is NOT announced, even when that layer is in a group: following
       * it is the whole point of ganging. See `src/core/groups.js`.
       */
      onWrote: ({ target, cmds }) => { if (target.kind === 'group') groups().expect(cmds); },
      onSent: (r) => ctx.log.info('send to', r.source, r.mode, '->', r.sent, 'layer(s)')
    });
  });
}
