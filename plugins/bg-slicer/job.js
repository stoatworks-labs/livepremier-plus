/*
 * Background Slicer — the job being built: the picture, the screens, where
 * the picture sits on them, and what has been generated and written.
 *
 * One per page, made by the page half and handed to a popped-out window
 * through `ctx.share`, so the sidebar panel and the window are two views of
 * the same job — a picture chosen in one is placed in the other. Nothing here
 * is device state and none of it is saved: a job is a few minutes' work
 * between choosing a picture and writing a background set, and the switcher
 * is where the result lives.
 *
 * No DOM: plain data and a change bell.
 */

import { presetPlacement, spanLayout } from './core.js';
import { modelFor } from './model.js';

export function createJob() {
  const listeners = new Set();
  const job = {
    /** `stills` cuts images; `live` maps inputs and exports a media-server map. */
    source: 'stills',
    /**
     * The picture: `{ name, width, height, url, bitmap, bytes }`, or null. For
     * a document it stands for the pages — `width × height` the first page's
     * size at 96 dpi, `url` the shown page's thumbnail — and `deck` is set.
     */
    picture: null,
    /**
     * A document's pages (`deck.js`, `document.js`), or null for a picture:
     * `{ doc, name, kind, engine, current, chosen, make, size, fit, library,
     * stills, startSet, thumbs }`. `make` is `sets` (a background set per
     * page) or `size` (each page as a still at `size`).
     */
    deck: null,
    /** Where the server turns a deck into a PDF — the page half's `ctx.url('/convert')`. */
    convertUrl: '/__lpp/bg-slicer/convert',
    /** What a long job (opening a deck, drawing pages) is doing now, for the panel. */
    busy: null,
    /** The content size the live mode works in when there is no picture. */
    content: null,
    screens: [],
    /** `each`: a placement per screen; `span`: one placement across them all. */
    mode: 'each',
    place: {},
    span: { offsets: {}, rect: null },
    sets: {},
    /** Midra / Alta: the Background Image per screen, when the operator chose one. */
    frames: {},
    live: {},
    edid: {},
    options: { label: '', assignSet: true, loadPreview: false, allowProgram: false, edids: true, fill: '#000000', assignedSlots: false },
    /** `{ key, images: Map('<screen>/<out>' → { blob, url, name, width, height }) }` once generated. */
    generated: null,
    progress: [],
    journal: null,
    running: false,
    confirming: false,
    note: null,

    /** Ask every view to redraw. */
    changed() { for (const fn of [...listeners]) { try { fn(); } catch { /* a closed window */ } } },
    /** A view's redraw; answers its own unsubscribe. */
    listen(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** The size the plan cuts from: the picture's, else the content size. */
    size() {
      if (job.picture) return { width: job.picture.width, height: job.picture.height };
      return job.content && job.content.width > 0 && job.content.height > 0 ? { ...job.content } : null;
    },

    /** Throw away what was generated — anything that moves a cut makes it stale. */
    stale() {
      if (job.generated) {
        for (const img of job.generated.images.values()) { try { URL.revokeObjectURL(img.url); } catch { /* not in a browser */ } }
      }
      job.generated = null;
    }
  };
  return job;
}

/** A fresh document state for a just-opened document. */
export function newDeck(doc) {
  return {
    doc,
    name: doc.name,
    kind: doc.kind,
    engine: doc.engine,
    /** Each page's slide number, when it is not its place (hidden slides), else null. */
    numbers: doc.numbers || null,
    current: 0,
    chosen: doc.pages.map((_, i) => i),
    make: 'sets',
    size: null,
    fit: 'fit',
    library: true,
    stills: false,
    startSet: {},
    thumbs: new Map(),
    /** The shown page drawn larger, for the placement view. */
    preview: null
  };
}

/**
 * Bring the job in line with the switcher: forget screens that are no
 * longer in service, and give a newly chosen screen a placement.
 */
export function reconcile(job, store) {
  const screens = modelFor(store).readScreens(store);
  const ids = new Set(screens.map((s) => s.id));
  job.screens = job.screens.filter((id) => ids.has(id));
  const size = job.size();
  if (!size) return screens;
  for (const s of screens) {
    if (!job.screens.includes(s.id) || job.place[s.id]) continue;
    job.place[s.id] = presetPlacement('fit', size, { x: 0, y: 0, w: s.canvas.width, h: s.canvas.height });
  }
  if (job.mode === 'span' && !job.span.rect) {
    const lay = spanLayout(screens.filter((s) => job.screens.includes(s.id)), job.span.offsets);
    job.span.rect = presetPlacement('fit', size, lay.bounds);
  }
  return screens;
}
