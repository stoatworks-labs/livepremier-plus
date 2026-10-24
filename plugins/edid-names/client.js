/*
 * Plug names — the plugin's page half.
 *
 * No tab of its own to find: the EDID builder (plugin `edid`) owns the EDID
 * page's strip and asks for this service when it draws it, as it asks for
 * Mosaic's. Switched off, the service is absent and the Plug Names tab is not
 * drawn.
 *
 * The document — short names and the EDIDs to undo to — is this plugin's
 * own route (`server.js`). Unlike the layer locks', a failed load or save is
 * not shrugged off: the original EDID is the only way back, so the panel
 * writes nothing to a plug until it has been read, and nothing before it has
 * been kept.
 */

import { createNamesPanel } from './panel.js';

function documentAt(url) {
  return {
    async load() {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`could not read the saved plug names (${res.status})`);
      return (await res.json()).data ?? null;
    },
    async save(data) {
      const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
      if (!res.ok) throw new Error(`could not keep the plug names (${res.status})`);
    }
  };
}

export default function activate(ctx) {
  const storage = documentAt(ctx.url('/'));
  ctx.provide('edid-names', {
    title: 'Plug Names',
    /** Draw the panel into the EDID page's pane: `{ stop }`. */
    mount: (target) => createNamesPanel({ target, session: ctx.session, storage, log: ctx.log })
  });
}
