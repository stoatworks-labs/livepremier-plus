# VENDORED — do not edit anything in this directory

A copy of `core/` from [awj-surface](https://github.com/stoatworks-labs/awj-surface),
the control-surface engine. Same reasoning as `../vpu-model.js` and
`../mynah-lang.mjs`: one implementation, copied rather than re-derived, so two
tools cannot reach different conclusions about the same device.

Upstream commit `7baad92e7ed59d0aea0d50bd87ee9d8ca63531d6`, synced 2026-09-23 — 15 core files
and 7 stock controller profiles.

`npm run sync:surface-core` re-copies it and rewrites `MANIFEST.json`;
`test/vendor.test.js` fails when the copy has drifted from an upstream
checkout, and skips when there is not one to compare with.

Edits belong upstream, in awj-surface's `core/`.
