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
  maxAgeMs: 300
});

export const LIMITS = Object.freeze({
  quality: [30, 95],
  maxWidth: [128, 1024],
  maxAgeMs: [0, 2000]
});

const clampInt = (v, [lo, hi], fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
};

/** Coerce anything into valid settings, correcting a bad field rather than refusing. */
export function normalise(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const width = Number(s.maxWidth);
  return {
    quality: clampInt(s.quality, LIMITS.quality, DEFAULTS.quality),
    /* 0 is its own answer — "the switcher's size" — not the bottom of the range. */
    maxWidth: width === 0 || !Number.isFinite(width) ? 0 : clampInt(width, LIMITS.maxWidth, DEFAULTS.maxWidth),
    maxAgeMs: clampInt(s.maxAgeMs, LIMITS.maxAgeMs, DEFAULTS.maxAgeMs)
  };
}

/** The snapshot routes the relay answers: the vendor's own, and nothing else. */
export const SNAPSHOT_PATH = /^\/api\/device\/snapshots\/[a-z_]+(?:\/[A-Za-z0-9_]+){0,3}$/;
