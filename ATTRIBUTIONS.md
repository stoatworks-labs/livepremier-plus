# Attributions

## The switcher

LivePremier Plus works with Analog Way **LivePremier** (Aquilon) processors. It
is **not affiliated with or endorsed by Analog Way**, and it redistributes no
part of their software, firmware or documentation.

This point matters more here than in most projects, because LivePremier Plus
puts its panels *inside* Analog Way's own Web RCS. It does that as a **proxy**:
every byte of the vendor interface — markup, scripts, stylesheets, fonts and
icons — is fetched from the switcher you point it at, at the moment you ask for
it, and passed through. **Nothing of Analog Way's is contained in this
repository, in the container image, or in the desktop app.** Without a device
of your own there is nothing to look at, which is exactly why there is no
hosted demo of this project.

The panels are drawn using the vendor stylesheet's own utility classes, served
by your device, in your browser. No vendor stylesheet, sprite or font is copied
here.

The control protocol is documented openly by Analog Way in the **AWJ Protocol
Programmer's Guide**. Every device path this project relies on was verified by
reading it back off a running device.

## Vendored code

Three components are copied in rather than reimplemented, because two
implementations of one model eventually disagree and both look right. All three
are the author's own, MIT licensed, and carry their provenance in-tree:

| Path | From | What |
| --- | --- | --- |
| `src/vendor/vpu-model.js` | [aquilon-vpu-map](https://github.com/stoatworks-labs/aquilon-vpu-map) | the VPU mixer model |
| `src/vendor/mynah-lang.mjs` | [mynah](https://github.com/stoatworks-labs/mynah) | the Console command language |
| `src/vendor/surface/` | [awj-surface](https://github.com/stoatworks-labs/awj-surface) | the MIDI control-surface engine and profiles |

`npm run sync:*` re-copies each from an upstream checkout; `test/vendor.test.js`
fails if a copy has drifted.

## The command grammar

The Console's syntax follows the *rules* of lighting-desk command lines, and
grandMA3's in particular — verb first, unambiguous keyword abbreviation,
`Thru` / `+` / `-` ranges. No code, data or text from any lighting console
vendor is used or reproduced; the vocabulary is the switcher's own throughout.
See mynah's own attributions for the fuller statement.

## MIDI

Controller profiles describe publicly documented control surfaces (Mackie
Control, Akai APC40, JLCooper MIDIcon) by their message numbers, which are
published by their manufacturers. No manufacturer firmware or software is
included.

## Runtime

- **Node.js** — the server, and the runtime embedded in the desktop app (MIT).
- **Tauri** — the desktop shell (MIT / Apache-2.0).

The application itself has **no runtime npm dependencies**.
