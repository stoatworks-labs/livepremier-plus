/*
 * Variables — the plugin's page half.
 *
 * `$S1.width`, `$IN3.rate`, `$S1.PGM.L2.x` — names for what the switcher
 * reports, generated from the store mirror — and `@gap`, `@half` — names an
 * operator defines. Offered to the rest of the page as the **`variables`
 * service** (`service.js`), which the Console hands to mynah and Field
 * arithmetic hands to `core/expr.js`, and drawn as a sidebar entry under PLUS:
 * a whole-device list, like Memories, not a per-screen tab.
 *
 * On by default, unlike the plugins that ship as previews: it **never writes
 * to the switcher**. It reads the mirror, keeps its own definitions in this
 * app's data directory, and changes nothing about when a write happens — a
 * field still commits when the operator commits it, a Console line when they
 * press Enter. What it adds is that `$S1.width/2` is a number there.
 *
 * Switched off, nobody provides `variables`: the Console refuses a line with a
 * variable in it saying so, and a numeric field with one in it is left exactly
 * as typed — what both did before this plugin existed.
 */

import { createVariables } from './service.js';
import { createVariablesPanel } from './panel.js';

export default function activate(ctx) {
  const variables = createVariables({
    store: () => ctx.session.store,
    async load() {
      const res = await fetch(ctx.url('/'), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).data;
    },
    async save(doc) {
      const res = await fetch(ctx.url('/'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: doc })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    log: ctx.log
  });

  ctx.provide('variables', variables.service);

  const panel = createVariablesPanel({ variables, session: ctx.session, onRefresh: ctx.refresh });
  ctx.ui.sidebar({
    id: 'variables',
    label: 'Variables',
    /* `library-18` is LivePremier's sprite; the rest are fallbacks a Midra's
       sprite may have instead. `icon()` takes the first the page defines. */
    icon: ['library-18', 'formats-18', 'bars-18'],
    order: 57,
    render: () => panel.render()
  });

  variables.onChange(() => ctx.refresh());
  void variables.start();
}
