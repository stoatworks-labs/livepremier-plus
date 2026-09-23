/*
 * Layer — the plugin's page half.
 *
 * Every property of a named layer, generated from the device's own parameter
 * catalogue, on the Screens / Aux. strip. "Layer" and not "Properties": the
 * vendor's own Properties tab is two along in the same strip, and two tabs
 * with one name is a worse problem than a name that is only most of the
 * truth. It is also the honest difference between them — theirs follows the
 * layer you have clicked, which is React state we cannot read, so ours makes
 * you name one.
 *
 * The panel itself, `src/ui/properties-panel.js`, is shared with the Edit
 * page, which drives it against its own buffer — so it stays in `src/` where
 * both can reach it. Web RCS's Properties pane is React and cannot be moved
 * into a second window; this one reads the mirror, so it pops out
 * (`popout.html`).
 *
 * Layer names come from the `names` service when Layer names is on. Looked up
 * as it is needed, not once here: nothing says that plugin starts first.
 */

import { createPropertiesPanel } from '../../src/ui/properties-panel.js';

export default function activate(ctx) {
  const namer = () => ctx.use('names');
  const properties = createPropertiesPanel({
    session: ctx.session,
    onRefresh: ctx.refresh,
    names: () => (namer() ? namer().get() : {}),
    onRename: (...a) => { const n = namer(); if (n) n.rename(...a); },
    canRename: () => Boolean(namer()),
    popoutUrl: new URL('./popout.html', import.meta.url).href
  });
  ctx.ui.tab({
    id: 'layer',
    label: 'Layer',
    short: 'Layer',
    icon: 'properties-14',
    order: 30,
    render: () => properties.render(),
    /* Holds repaints off while a value is being typed. */
    busy: () => properties.busy()
  });
}
