# VENDORED — do not edit anything in this directory

A copy of `core/` from [awj-surface](https://github.com/stoatworks-labs/awj-surface),
the control-surface engine. Same reasoning as `../vpu-model.js` and
`../mynah-lang.mjs`: one implementation, copied rather than re-derived, so two
tools cannot reach different conclusions about the same device.

Upstream commit `a129def16fa0697d63d8a051e408f27fc0fcd1eb`, synced 2026-10-30 — 15 core files
and 8 stock controller profiles.

`npm run sync:surface-core` re-copies it and rewrites `MANIFEST.json`;
`test/vendor.test.js` fails when the copy has drifted from an upstream
checkout, and skips when there is not one to compare with.

Edits belong upstream, in awj-surface's `core/`.
