# VENDORED — do not edit anything in this directory

Part of `core/` from **pixelhue-bridge**, the Pixelhue U-series console driver.
Same reasoning as `../surface/` and `../vpu-model.js`: one implementation of
the console's wire format, copied rather than re-derived.

Upstream commit `c7614ac7d2e302c9b588947decce4a8d07239f8f`, synced 2026-09-22 — 3 files.

⚠️ **pixelhue-bridge is not published yet**, so that commit is local. The
evidence for every byte of this format lives in its `docs/protocols.md`, and
the frame codec has been decoded against a live UCenter (see
pixelhue-re's `docs/console-rig.md`).

`npm run sync:pixelhue-core` re-copies it and rewrites `MANIFEST.json`;
`test/vendor.test.js` fails when the copy has drifted from a checkout, and
skips when there is not one to compare with.

Edits belong upstream, in pixelhue-bridge's `core/`.
