/*
 * Matrix Routing — the plugin's page half.
 *
 * A whole-device view, like the VPU map: it is about the back of the frame
 * rather than one screen, so it is a sidebar entry. It is the only panel that
 * reads something other than the store — an external router is not in the
 * store and never will be — so everything it shows comes from the server half.
 *
 * It also puts a Router tab on the vendor's own input and output pages, and a
 * Router box in Preconfig ▸ Inputs / Outputs: one socket's slice of the panel,
 * where that socket is already being configured (`router-box.js` says what it
 * matches, and why a socket it cannot identify gets no box at all).
 *
 * And it contributes two things a cue can do, `matrixFeed` and `matrixSend`.
 * They do not go on the vendor socket — the switcher has never heard of a
 * router — but to the server half, which holds the router connections. Not
 * awaited, for the reason a take is not: the router acknowledges receipt, not
 * success. A refusal comes back as a warning on the cue.
 */

import { createMatrixPanel } from './panel.js';
import { installRouterSurfaces } from './router-box.js';
import { SIDES, parseConnectorId, logicalIndex } from '../../src/core/connectors.js';

export default function activate(ctx) {
  const matrix = createMatrixPanel({ session: ctx.session, onRefresh: ctx.refresh });
  ctx.ui.sidebar({
    id: 'matrix',
    label: 'Matrix Routing',
    icon: ['connector-gpio-18', 'gpio-18'],
    order: 50,
    render: () => matrix.render()
  });

  const surfaces = installRouterSurfaces({ session: ctx.session, enabled: () => ctx.can('matrixRouting') });
  ctx.provide('matrix', Object.freeze({
    /** What the Router tabs and boxes found on the vendor's pages. */
    describeSurfaces: () => surfaces.describe()
  }));

  const route = (verb, body) => fetch(ctx.url(`/${verb}`), {
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
  ctx.contribute('cueAction', {
    kind: 'matrixFeed',
    label: 'Router to a switcher input',
    run: (a) => route('feed', { connector: a.connector, source: a.source }),
    describe: (a) => `feed ${connector(a.connector)} from router input ${a.source}`
  });
  ctx.contribute('cueAction', {
    kind: 'matrixSend',
    label: 'Switcher output to router outputs',
    run: (a) => route('send', { connector: a.connector, destinations: a.destinations }),
    describe: (a) => `send ${connector(a.connector)} to router outputs ${[].concat(a.destinations ?? []).join(', ')}`
  });
}
