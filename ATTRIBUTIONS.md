# Attributions

LivePremier Plus is built on other people's work. This file lists what that work is, who did
it, and what it is doing here.

It is generated — the master lists live in the `stoatworks-backend` repo and are
pushed out by `scripts/sync-attributions.py`. Edit it there, not here.

## Code we derived from other people's work

Someone else solved this first, and this project would not exist in its current form without their work.

### blackmagic-misc — Sylvain "tnt" Munaut

<https://github.com/smunaut/blackmagic-misc>  
Licence: Apache-2.0 (SPDX header in bmd.py; the repo has no LICENSE file, so GitHub does not detect it)  
Copyright: 2021 Sylvain Munaut

Blackmagic has never published the DaVinci Resolve Speed Editor's HID protocol, and the panel reports nothing until a challenge-response handshake completes. The handshake, the report formats and the jog modes in src/vendor/surface/hid/speed-editor.js (vendored from awj-surface) come from Munaut's reverse engineering in bmd.py.

### node-blackmagic-controller — Julian Waller

<https://github.com/Julusian/node-blackmagic-controller>  
Licence: MIT  
Copyright: 2024 Julian Waller

The Speed Editor's key and LED tables in src/vendor/surface/hid/speed-editor.js follow node-blackmagic-controller, the library Bitfocus Companion drives the panel with.

### VPU mixer model — Stoatworks aquilon-vpu-map

<https://github.com/stoatworks-labs/aquilon-vpu-map>  
Licence: MIT  
Copyright: Stoatworks Labs

Same fleet, copied rather than shared: src/vendor/vpu-model.js. Two implementations of one model eventually disagree and both look right, so there is one, and test/vendor.test.js fails if the copy drifts.

### Console command language — Stoatworks mynah

<https://github.com/stoatworks-labs/mynah>  
Licence: MIT  
Copyright: Stoatworks Labs

Same fleet, copied rather than shared: src/vendor/mynah-lang.mjs.

### Control-surface engine and profiles — Stoatworks awj-surface

<https://github.com/stoatworks-labs/awj-surface>  
Licence: MIT  
Copyright: Stoatworks Labs

Same fleet, copied rather than shared: src/vendor/surface/, the MIDI and HID control-surface engine and its profiles.

### Pitch-compensation engine — Stoatworks aquilon-pitch

<https://github.com/stoatworks-labs/aquilon-pitch>  
Licence: MIT  
Copyright: Stoatworks Labs

Same fleet, copied rather than shared: src/vendor/pitch-engine.js.

### Otter EDID editor — Stoatworks otter-edid-editor

<https://github.com/stoatworks-labs/otter-edid-editor>  
Licence: MIT  
Copyright: Stoatworks Labs

Same fleet, copied rather than shared: src/vendor/otter-edid-embed.js is otter-edid-editor's embed build, vendored unchanged. It bundles React, React DOM and Scheduler, credited below.

## Third-party code this project uses

Libraries, SDKs and frameworks the project is built on or bundles.

### Tauri

<https://tauri.app>  
Licence: MIT or Apache-2.0  
Copyright: The Tauri Programme within The Commons Conservancy

A Cargo and npm dependency — of the app itself under src-tauri/, or of the desktop launcher under launcher/src-tauri/.

Wraps a web front end in a native desktop app using the platform's own webview rather than a bundled browser, so the binary stays small.

### React, React DOM and Scheduler

<https://react.dev>  
Licence: MIT  
Copyright: Meta Platforms, Inc. and affiliates

Compiled into the vendored Otter EDID editor build, otter-edid-embed.js, with each package's MIT header kept in place (React 19.3.0 at the pinned build).

The UI layer of the embedded EDID editor. The repo does not depend on React itself; it arrives only inside that one vendored file.

### The Rust crate ecosystem

<https://crates.io>  
Licence: predominantly MIT or Apache-2.0  
Copyright: the individual crate authors

Cargo dependencies, resolved and pinned in Cargo.lock.

Async runtimes, protocol codecs, serialisation and GUI toolkits. The exact set and versions for any build are in that repo's Cargo.lock, which is the authoritative list.

### The npm ecosystem

<https://www.npmjs.com>  
Licence: predominantly MIT  
Copyright: the individual package authors

npm dependencies, resolved and pinned in the lockfile.

Build tooling, test runners and the libraries the front ends are assembled from. The exact set and versions for any build are in that repo's lockfile, which is the authoritative list.

The full transitive dependency set for any build is pinned in this repo's lockfile,
which is the authoritative list. What is named above is the layers a reader would
want to know about, not every package that has ever been resolved.

## Work we checked ourselves against

No code was taken from these — but they were how we knew we had it right, and that is worth saying out loud.

### Analog Way AWJ Protocol Programmer's Guide — Analog Way

LivePremier Plus works with Analog Way LivePremier (Aquilon) processors. It is not affiliated with or endorsed by Analog Way, and redistributes no part of their software, firmware or documentation. It puts its panels inside Analog Way's own Web RCS as a proxy: every byte of the vendor interface — markup, scripts, stylesheets, fonts and icons — is fetched from the switcher you point it at, at the moment you ask for it, and passed through. Nothing of Analog Way's is contained in this repository, in the container image, or in the desktop app, which is why there is no hosted demo. The panels use the vendor stylesheet's own utility classes, served by your device, in your browser. The protocol is documented openly in the guide, and every device path this project relies on was verified by reading it back off a running device.

## Inspirations

What this set out to be. No code, assets or binaries from any of these were used or examined — the debt is to the idea.

### Lighting-desk command lines, grandMA3's in particular — MA Lighting

The Console's syntax follows the rules of lighting-desk command lines — verb first, unambiguous keyword abbreviation, Thru / + / - ranges. No code, data or text from any lighting console vendor is used or reproduced; the vocabulary is the switcher's own throughout. See mynah's attributions for the fuller statement.

## Standards and published specifications

What the implementation is measured against.

- **Mackie Control (MCU), Akai APC40, JLCooper MIDIcon** — Controller profiles describe these publicly documented surfaces by their message numbers. No manufacturer firmware or software is included.

## Getting this wrong

If your work is here and the description is inaccurate, the licence is wrong, or you would rather not be listed — open an issue and it will be fixed.
