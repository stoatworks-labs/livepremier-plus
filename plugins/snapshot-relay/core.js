/*
 * Thumbnail relay — what its settings may be. Imported by both halves, so no
 * Node and no DOM in here.
 */

export const DEFAULTS = Object.freeze({
  /* IJG quality. 70 keeps a 512×288 camera frame near 30 KB against the
     ~590 KB the switcher sends, and the difference is not visible on a card. */
  quality: 70,
  /* 0 leaves the switcher's own size alone. Anything else caps the width —
     the Web RCS draws its source cards at about 180 px. */
  maxWidth: 0,
  /* How old a transcoded frame may be and still be handed to the next page
     that asks, instead of asking the switcher again. The vendor's poller asks
     for each source once a second; this is what lets a second tab, or this
     app's own preview wall, ride on the first one's fetch. */
  maxAgeMs: 300,
  /* How often a page refreshes the thumbnails it is drawing in a screen or
     aux canvas — the sources somebody is editing. 0 leaves them to the
     vendor's own clock. Worth raising only as far as the firmware really
     redraws; `tools/snapshot-probe.mjs` measures that. */
  hotHz: 2,
  /* How old a frame of any other source may be, while somebody is editing,
     before the switcher is asked again. 0 treats every source alike. */
  idleMs: 4000
});

export const LIMITS = Object.freeze({
  quality: [30, 95],
  maxWidth: [128, 1024],
  maxAgeMs: [0, 2000],
  hotHz: [0.5, 10],
  idleMs: [1000, 15000]
});

const clampInt = (v, [lo, hi], fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
};

/** 0 stays 0; a number is brought into range; anything else is the default. */
const offOr = (raw, fit, fallback) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n === 0 ? 0 : fit(n);
};

/** Coerce anything into valid settings, correcting a bad field rather than refusing. */
export function normalise(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const width = Number(s.maxWidth);
  return {
    quality: clampInt(s.quality, LIMITS.quality, DEFAULTS.quality),
    /* 0 is its own answer — "the switcher's size" — not the bottom of the range. */
    maxWidth: width === 0 || !Number.isFinite(width) ? 0 : clampInt(width, LIMITS.maxWidth, DEFAULTS.maxWidth),
    maxAgeMs: clampInt(s.maxAgeMs, LIMITS.maxAgeMs, DEFAULTS.maxAgeMs),
    /* 0 is "off" for both, not the bottom of the range. */
    hotHz: offOr(s.hotHz, (v) => Math.round(Math.min(LIMITS.hotHz[1], Math.max(LIMITS.hotHz[0], v)) * 2) / 2, DEFAULTS.hotHz),
    idleMs: offOr(s.idleMs, (v) => clampInt(v, LIMITS.idleMs, DEFAULTS.idleMs), DEFAULTS.idleMs)
  };
}

/**
 * How old a kept frame may be and still answer a request, by tier.
 *
 * - **Hot** — a source some page is editing. Every refresh the page asks for
 *   should reach the switcher, so the window shrinks to half a refresh period;
 *   it stays wide enough for two tabs, or a card and a layer showing the same
 *   input, to share one fetch.
 * - **Idle** — any other source, *while somebody is editing*. Its frame may
 *   age to `idleMs`: the vendor still asks for it every second or so, and is
 *   answered from what the relay already has.
 * - Otherwise — nobody editing, or the tiers switched off — the share window,
 *   exactly as before there were tiers. A page of source cards alone (Inputs,
 *   the Sources panel with no screen drawn) is never slowed down.
 *
 * @param {{hot: boolean, editing: boolean, settings: {maxAgeMs: number, hotHz: number, idleMs: number}}} opts
 */
export function ageLimit({ hot, editing, settings: s }) {
  if (hot && s.hotHz) return Math.min(s.maxAgeMs, Math.floor(500 / s.hotHz));
  if (!hot && editing && s.idleMs) return Math.max(s.maxAgeMs, s.idleMs);
  return s.maxAgeMs;
}

/** Hot sources one page may name. More than any switcher has inputs and outputs together. */
export const MAX_HOT = 64;

/** The snapshot routes the relay answers: the vendor's own, and nothing else. */
export const SNAPSHOT_PATH = /^\/api\/device\/snapshots\/[a-z_]+(?:\/[A-Za-z0-9_]+){0,3}$/;
