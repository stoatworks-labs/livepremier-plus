/*
 * Slow-link thumbnails — the plugin's page half.
 *
 * A source thumbnail keeps its last picture until the next one has finished
 * arriving, so a page a thin link away from this app (a tablet over Remote
 * access) draws them instead of none. `hold.js` says how, and why it holds
 * the write back rather than undoing it.
 *
 * It is a page decoration and registers nothing with the host: installed the
 * moment the plugin starts, on every page, whether or not a panel of ours is
 * ever opened. On a LAN it never holds anything back, which is why it is on
 * by default; it writes nothing to the switcher and asks it for nothing.
 */

import { installThumbnailHold } from './hold.js';

export default function activate(ctx) {
  if (typeof HTMLImageElement === 'undefined') return;
  const hold = installThumbnailHold({ proto: HTMLImageElement.prototype, doc: document });
  /* What it has done, for `window.__WRU.shared('thumbnail-hold')` on a day with a slow link. */
  ctx.share({ stats: hold.stats, pending: hold.pending });
}
