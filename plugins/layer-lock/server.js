/*
 * Layer Lock — the plugin's server half: where the locks are kept.
 *
 * Per switcher, like the layer groups and for the same reason: `S1/2` is a
 * slot in one box's preconfig. A lock is a standing instruction an operator
 * set on purpose, so it survives a reload — a lock that quietly vanished when
 * the page was refreshed would be found out by a layer moving on air.
 */

import { documentRoute, documentSection } from '../../server/documents.js';

export default function activate(ctx) {
  /* A lock list is at most a few hundred short strings. */
  documentRoute(ctx, 'locks', { limit: 64 * 1024 });
  documentSection(ctx, 'locks', {
    group: 'show',
    label: 'Layer locks',
    empty: (data) => !data || !Array.isArray(data.locks) || data.locks.length === 0
  });
}
