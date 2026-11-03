# VENDORED — do not edit anything in this directory

Part of `core/` from **pixelhue-bridge**, the Pixelhue U-series console driver.
Same reasoning as `../surface/` and `../vpu-model.js`: one implementation of
the console's wire format, copied rather than re-derived.

Upstream commit `dbd3ad9c4f3526753e302146f9f8c7fd6d119660`, synced 2026-11-03 — 5 files.

⚠️ **pixelhue-bridge is not published yet**, so that commit is local. The
evidence for every byte of this format lives in its `docs/protocols.md`, and
the frame codec has been decoded against a live UCenter (see
pixelhue-re's `docs/console-rig.md`).

`npm run sync:pixelhue-core` re-copies it and rewrites `MANIFEST.json`;
`test/vendor.test.js` fails when the copy has drifted from a checkout, and
skips when there is not one to compare with.

Edits belong upstream, in pixelhue-bridge's `core/`.
