/*
 * Multiviewer slicer — the geometry, and what its settings may be. Imported by
 * both halves, so no Node and no DOM in here.
 *
 * ## Where the tiles are
 *
 * The switcher keeps its multiviewer layouts in the device store, to the
 * pixel, so nothing here is calibrated by eye. On a LivePremier:
 *
 *   monitoringList/items/<n>/status/pp/{sizeH,sizeV}      the raster, 1920×1080
 *   monitoringList/items/<n>/layout/widgetList/items/<k>/
 *     control/pp/{enable,source,displayOsd}
 *     status/pp/{isEnabled,isOverlapped,posH,posV,sizeH,sizeV}
 *
 * An Aquilon C read on 2026-09-09 had a 5×4 grid of 384×270 widgets on
 * multiviewer 1, `IN_1`…`IN_20`. The multiviewer spells sources its own way —
 * `IN_n`, `STILL_n`, `PROGRAM_S1`, `PREVIEW_S1`, `A1`, `TIMER_1` — not the
 * layer spelling `LIVE_n`. Midra 4K and Alta 4K have one multiviewer at
 * `multiviewer/widgetList`, same widget shape — see *layouts* below.
 *
 * ## Where the picture is inside a tile
 *
 * A widget is not the picture's shape: 384×270 is 1.42:1, and the switcher
 * letterboxes a 16:9 source inside it, with its on-screen label and tally in
 * the band that leaves. Where exactly that band goes has not been seen on a
 * real output yet, which is why `aspect`, `align` and `insetPct` are settings
 * and the settings card draws every crop over the live capture.
 */

export const DEFAULTS = Object.freeze({
  /* Which of the switcher's multiviewers is on the capture input. */
  multiviewer: 1,
  /* The picture inside a widget: '16:9' fitted into it, or 'tile' for the
     whole widget. */
  aspect: '16:9',
  /* Where a fitted picture sits when the widget is taller than it. */
  align: 'center',
  /* Trimmed off every edge of the picture, in percent of its size — for a
     tally border drawn over the picture itself. */
  insetPct: 0,
  /* How often a thumbnail is redrawn from the capture. */
  fps: 10,
  /* JPEG quality of the frames handed to the page's images, 0.5–0.95. */
  quality: 0.8,
  /* The width a tile is drawn at, at most. A 384-wide tile stays 384. */
  maxWidth: 512,
  /* A WHEP endpoint for a page on another machine — MediaMTX serves one at
     http://<host>:8889/<path>/whep. Empty for none. */
  whepUrl: '',
  /* Midra / Alta: where the switcher's own streamer pushes the multiviewer —
     a MediaMTX, rtmp://<host>:1935/<path>. Empty for none. */
  rtmpUrl: '',
  /* The destination slot the streamer's address is written into. */
  streamSlot: 10
});

export const LIMITS = Object.freeze({
  multiviewer: [1, 8],
  insetPct: [0, 20],
  fps: [1, 25],
  quality: [0.5, 0.95],
  maxWidth: [128, 1920],
  streamSlot: [1, 10]
});

export const ASPECTS = ['16:9', '4:3', 'tile'];
export const ALIGNS = ['center', 'top', 'bottom'];

const clamp = (v, [lo, hi], fallback, round = true) => {
  const n = Number(v);
  if (v === '' || v == null || !Number.isFinite(n)) return fallback;
  const c = Math.min(hi, Math.max(lo, n));
  return round ? Math.round(c) : c;
};

/** Coerce anything into valid settings, correcting a bad field rather than refusing. */
export function normalise(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    multiviewer: clamp(s.multiviewer, LIMITS.multiviewer, DEFAULTS.multiviewer),
    aspect: ASPECTS.includes(s.aspect) ? s.aspect : DEFAULTS.aspect,
    align: ALIGNS.includes(s.align) ? s.align : DEFAULTS.align,
    insetPct: clamp(s.insetPct, LIMITS.insetPct, DEFAULTS.insetPct, false),
    fps: clamp(s.fps, LIMITS.fps, DEFAULTS.fps),
    quality: Math.round(clamp(s.quality, LIMITS.quality, DEFAULTS.quality, false) * 100) / 100,
    maxWidth: clamp(s.maxWidth, LIMITS.maxWidth, DEFAULTS.maxWidth),
    whepUrl: typeof s.whepUrl === 'string' && /^https?:\/\/\S+$/i.test(s.whepUrl.trim()) ? s.whepUrl.trim() : '',
    rtmpUrl: typeof s.rtmpUrl === 'string' && /^rtmps?:\/\/\S+$/i.test(s.rtmpUrl.trim()) ? s.rtmpUrl.trim() : '',
    streamSlot: clamp(s.streamSlot, LIMITS.streamSlot, DEFAULTS.streamSlot)
  };
}

/* ---------------------------------------------------------------- sources */

/**
 * The thumbnail a multiviewer source replaces, or null when the Web RCS draws
 * none for it. Inputs and stills only: a screen's program and preview are
 * not source thumbnails, and a timer is not a picture.
 *
 * LivePremier spells the multiviewer's inputs `IN_n` and stills `STILL_n`;
 * Midra 4K / Alta 4K spell them `INPUT_n` and have no still thumbnails.
 */
export function snapshotPathFor(source) {
  const s = String(source || '');
  let m = /^(?:IN|INPUT)_(\d+)$/.exec(s);
  if (m) return `/api/device/snapshots/inputs/${m[1]}`;
  m = /^STILL_(\d+)$/.exec(s);
  return m ? `/api/device/snapshots/images/${m[1]}` : null;
}

/* ---------------------------------------------------------------- layouts */

/*
 * Two object models, one question — where are the tiles:
 *
 *   LivePremier   monitoringList/items/<n>/layout/widgetList   up to 8, raster
 *                 at monitoringList/items/<n>/status/pp
 *   Midra / Alta  multiviewer/widgetList                       exactly one,
 *                 raster at outputList/items/MTVW/status/pp
 *
 * Both widget nodes are the same shape (control + status, posH/posV/sizeH/
 * sizeV), read off an Aquilon C and a Pulse 4K.
 */
const NLC_MV = (n) => ['device', 'monitoringList', 'items', String(n)];
const MNG_MV = ['device', 'multiviewer'];

/** 'nlc', 'mng', or null for a store that has neither (or is not ready). */
export function family(store) {
  if (!store) return null;
  if (store.get(['device', 'monitoringList', 'items'])) return 'nlc';
  if (store.get([...MNG_MV, 'widgetList'])) return 'mng';
  return null;
}

/** Whether this switcher has a multiviewer this plugin can read. */
export const hasMultiviewers = (store) => family(store) !== null;

/** The multiviewers the switcher has, as numbers. A Midra has one. */
export function multiviewers(store) {
  const f = family(store);
  if (f === 'mng') return [1];
  if (f !== 'nlc') return [];
  return store.itemKeys(['device', 'monitoringList']).map(Number).filter(Number.isFinite);
}

/** The multiviewer's raster, `{ width, height }`, or null. */
export function raster(store, n) {
  const f = family(store);
  const at = f === 'nlc' ? [...NLC_MV(n), 'status', 'pp']
    : f === 'mng' ? ['device', 'outputList', 'items', 'MTVW', 'status', 'pp'] : null;
  const pp = at && store.get(at);
  if (!pp || !(pp.sizeH > 0) || !(pp.sizeV > 0)) return null;
  return { width: pp.sizeH, height: pp.sizeV };
}

/**
 * Every widget on a multiviewer that is showing something: enabled, not
 * covered by another, with a source. The switcher's own reading (`status`)
 * wins over what was asked for (`control`), because it is what is on the wire.
 *
 * @returns {Array<{widget: string, source: string, osd: string, rect: {x:number,y:number,w:number,h:number}, path: string|null}>}
 */
export function tilesFromStore(store, n) {
  const f = family(store);
  const list = f === 'nlc' ? [...NLC_MV(n), 'layout', 'widgetList'] : f === 'mng' ? [...MNG_MV, 'widgetList'] : null;
  if (!list || !store.get(list)) return [];
  /* A Pulse 4K lists 27 widget slots and uses the first 16; the rest keep
     stale sizes a layout recall rewrites. `widgetValidity` says which count. */
  const valid = f === 'mng' ? store.get([...MNG_MV, 'status', 'pp', 'widgetValidity']) : null;
  const out = [];
  for (const k of store.itemKeys(list)) {
    if (Array.isArray(valid) && !valid.includes(String(k))) continue;
    const base = [...list, 'items', k];
    const control = store.get([...base, 'control', 'pp']) || {};
    const status = store.get([...base, 'status', 'pp']) || {};
    const enabled = status.isEnabled ?? control.enable;
    if (!enabled || status.isOverlapped) continue;
    const source = control.source;
    if (!source || source === 'NONE') continue;
    const g = status.sizeH > 0 ? status : control;
    if (!(g.sizeH > 0) || !(g.sizeV > 0)) continue;
    out.push({
      widget: String(k),
      source,
      osd: control.displayOsd || 'NONE',
      rect: { x: g.posH || 0, y: g.posV || 0, w: g.sizeH, h: g.sizeV },
      path: snapshotPathFor(source)
    });
  }
  return out;
}

/* --------------------------------------------------------------- streamer */

/*
 * Midra 4K and Alta 4K carry an H.264 streamer: 720p30 by default, RTMP out
 * to one of ten destinations, and — on a real Pulse 4K, 2026-09-12 — willing
 * to take `OUTPUT_MTVW`, the multiviewer, as its picture. Pointed at a
 * MediaMTX on this network it becomes the capture: MediaMTX takes the RTMP
 * push and serves the same stream as WHEP, which the page plays.
 *
 * It is the unit's only streamer, so nothing here starts it, stops it or
 * re-points it without a button press — and not at all while it is carrying
 * something else.
 */
const STREAM = ['device', 'streaming'];
export const STREAM_LABEL = 'LPP multiviewer';
const RUNNING = new Set(['RUNNING', 'IN_PROGRESS', 'CONNECTING', 'STARTING']);

/** What the streamer is doing, or null on a switcher without one. */
export function streamerState(store) {
  if (!store || !store.get([...STREAM, 'control'])) return null;
  const st = store.get([...STREAM, 'status', 'pp']) || {};
  const video = store.get([...STREAM, 'status', 'video', 'pp']) || {};
  const control = store.get([...STREAM, 'control', 'pp']) || {};
  const target = store.get([...STREAM, 'control', 'destination', 'pp', 'target']);
  const slot = (n) => store.get([...STREAM, 'destinationBank', 'slotList', 'items', String(n), 'pp']) || {};
  const status = st.status || 'NO_REQUEST';
  return {
    status,
    running: RUNNING.has(status) || control.start === true,
    source: video.source || store.get([...STREAM, 'control', 'video', 'pp', 'source']) || null,
    canMultiviewer: Array.isArray(video.sourceValidity) ? video.sourceValidity.includes('OUTPUT_MTVW') : null,
    profile: video.profile || null,
    bitrate: video.bitrate ?? null,
    hdcpWarning: video.hdcpWarning === true,
    target: target ?? null,
    slot
  };
}

/** Whether the streamer is carrying our multiviewer to `rtmpUrl`. */
export function isOurs(state, rtmpUrl) {
  if (!state || !rtmpUrl) return false;
  const dest = state.target != null ? state.slot(state.target) : {};
  return state.source === 'OUTPUT_MTVW' && sameRtmp(dest.url, rtmpUrl);
}

const sameRtmp = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');

/**
 * The writes that point the streamer at our MediaMTX and start it, or a
 * sentence saying why not. Destination `slot` is overwritten — 10 by
 * default, the last of the ten, since the first four come from the factory.
 *
 * @returns {{ok: true, cmds: Array<{path: string[], value: unknown}>} | {ok: false, why: string}}
 */
export function streamerStart(state, { rtmpUrl, slot }) {
  if (!state) return { ok: false, why: 'This switcher has no streamer.' };
  if (!/^rtmps?:\/\/\S+$/i.test(String(rtmpUrl || ''))) return { ok: false, why: 'Set the RTMP address MediaMTX listens on first.' };
  if (state.canMultiviewer === false) return { ok: false, why: 'This streamer does not offer the multiviewer as a source.' };
  if (state.running && !isOurs(state, rtmpUrl)) {
    return { ok: false, why: `The streamer is already carrying ${state.source || 'something'} (${state.status}). It is the unit's only one — stop that first, on purpose.` };
  }
  const n = String(slot);
  const bank = [...STREAM, 'destinationBank', 'slotList', 'items', n, 'pp'];
  return {
    ok: true,
    cmds: [
      { path: [...bank, 'label'], value: STREAM_LABEL },
      { path: [...bank, 'url'], value: rtmpUrl },
      { path: [...bank, 'key'], value: '' },
      { path: [...STREAM, 'control', 'destination', 'pp', 'target'], value: Number(slot) },
      { path: [...STREAM, 'control', 'video', 'pp', 'source'], value: 'OUTPUT_MTVW' },
      { path: [...STREAM, 'control', 'pp', 'start'], value: true }
    ]
  };
}

/** The write that stops it — only ever offered while it is carrying ours. */
export const streamerStop = () => ({ path: [...STREAM, 'control', 'pp', 'start'], value: false });

/**
 * MediaMTX's WHEP address for the path an RTMP push lands on: the same host
 * and path, port 8889 — its defaults.
 */
export function whepFromRtmp(rtmpUrl) {
  const m = /^rtmps?:\/\/([^/:\s]+)(?::\d+)?\/(\S+?)\/*$/i.exec(String(rtmpUrl || ''));
  return m ? `http://${m[1]}:8889/${m[2]}/whep` : '';
}

/* --------------------------------------------------------------- geometry */

const RATIO = { '16:9': 16 / 9, '4:3': 4 / 3 };

/**
 * The picture inside a widget, in multiviewer pixels.
 *
 * @param {{x:number,y:number,w:number,h:number}} rect  the widget
 * @param {{aspect:string, align:string, insetPct:number}} s
 */
export function pictureRect(rect, s) {
  let { x, y, w, h } = rect;
  const ratio = RATIO[s.aspect];
  if (ratio) {
    if (w / h > ratio) {
      /* Wider than the picture: pillarbox, always centred. */
      const pw = h * ratio;
      x += (w - pw) / 2; w = pw;
    } else {
      const ph = w / ratio;
      const spare = h - ph;
      y += s.align === 'top' ? 0 : s.align === 'bottom' ? spare : spare / 2;
      h = ph;
    }
  }
  const ix = (w * (s.insetPct || 0)) / 100;
  const iy = (h * (s.insetPct || 0)) / 100;
  return { x: x + ix, y: y + iy, w: w - 2 * ix, h: h - 2 * iy };
}

/** A rectangle in one raster, in another's pixels — the capture's, say. */
export function scaleRect(rect, from, to) {
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  return { x: rect.x * sx, y: rect.y * sy, w: rect.w * sx, h: rect.h * sy };
}

/**
 * What to cut from the capture for each thumbnail: snapshot path → the crop
 * in capture pixels and the size to draw it at. A source on two widgets is
 * cut from the larger.
 *
 * @param {ReturnType<typeof tilesFromStore>} tiles
 * @param {{width:number,height:number}} mv       the multiviewer raster
 * @param {{width:number,height:number}} capture  what arrived
 * @param {ReturnType<typeof normalise>} s
 * @returns {Map<string, {source:string, widget:string, crop:{x:number,y:number,w:number,h:number}, width:number, height:number}>}
 */
export function planCrops(tiles, mv, capture, s) {
  const out = new Map();
  if (!mv || !capture || !(capture.width > 0) || !(capture.height > 0)) return out;
  for (const t of tiles) {
    if (!t.path) continue;
    const crop = roundRect(scaleRect(pictureRect(t.rect, s), mv, capture), capture);
    if (crop.w < 2 || crop.h < 2) continue;
    const prev = out.get(t.path);
    if (prev && prev.crop.w * prev.crop.h >= crop.w * crop.h) continue;
    const width = Math.min(s.maxWidth, crop.w);
    out.set(t.path, {
      source: t.source, widget: t.widget, crop,
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round((width * crop.h) / crop.w))
    });
  }
  return out;
}

/** Whole pixels, kept inside the frame. */
function roundRect(r, frame) {
  const x = Math.max(0, Math.round(r.x));
  const y = Math.max(0, Math.round(r.y));
  return {
    x, y,
    w: Math.max(0, Math.min(frame.width, Math.round(r.x + r.w)) - x),
    h: Math.max(0, Math.min(frame.height, Math.round(r.y + r.h)) - y)
  };
}

/** The snapshot path in an `<img src>`, query and origin dropped, or null. */
export function pathOfSrc(src) {
  if (!src) return null;
  let path;
  try { path = new URL(src, 'http://page.invalid').pathname; } catch { return null; }
  return /^\/api\/device\/snapshots\/(inputs|images)\/\d+$/.test(path) ? path : null;
}
