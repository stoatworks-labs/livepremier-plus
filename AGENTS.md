# AGENTS.md — LivePremier Plus

Orientation for an LLM or a newcomer picking this up cold. [README.md](README.md)
is the *what*; this is the *why* and the traps.

## The one-paragraph version

A local reverse proxy that puts two new panels inside Analog Way's own
LivePremier Web RCS: a VPU resource map and a theatre-style cue stack. You
point it at a switcher and browse to it instead of to the device. It does not
replace the vendor UI, does not open its own connection to the device, and does
not ship a theme — it borrows the vendor's stylesheet and rides the vendor's
socket.

**It was a Chrome extension until 0.2.0.** The panels, the store mirror and the
cue engine are unchanged; what went away was `manifest.json`, the isolated-world
loader and the `chrome.storage` broker. Read "Why a proxy" below before
proposing to bring any of that back.

## The four ideas everything else follows from

**1. Light DOM, not shadow DOM.** The vendor stylesheet defines about 500 `aw-`
utility classes — a slate-grey scale, spacing, typography, cards, shadows.
Rendering into the page's light DOM means the panels inherit all of it for free
and stay correct when the vendor restyles. A shadow root would have isolated us
from the one thing we want. Reach for an `aw-` class first; `ui/theme.js` is
only for structure the vendor system has no name for.

**2. Nothing about the vendor's markup is stable, so nothing is hard-coded.**
Web RCS is built with CSS modules: every component class carries a per-build
hash (`sidebar-module__c__menu___1sHvq` today, something else next firmware).
The sidebar entries are therefore **cloned from a real one at runtime** and then
rewritten, including the active-state classes, which are lifted off whichever
item is currently active. Icons come from the page's own SVG sprite by id.

**3. Ride the app's socket; never open a second one.** The device counts its
clients and shows the count in the header, and AWJ's separate five-client budget
is small. A passenger connection would show up as a phantom operator. This is
why the hook has to wrap `WebSocket` before the vendor bundle constructs one —
there is no later opportunity. The proxy inlines it into `<head>`, and since
every vendor script tag is `defer`, the parser orders it first. As an extension
this was a `document_start` content script, which usually won that race but was
never promised to.

The browser's own socket is relayed **byte-for-byte** to the device, so this
process never has to understand WebSocket framing, and exactly one connection
reaches the box per tab.

**4. `core/` knows nothing about browsers.** No DOM, no transport. It imports
and runs under plain Node, which is what the tests do. The browser panels are
one front-end; a standalone AWJ client is meant to be another and should need
only a new `transports/` module. Keep device I/O out of `core/`.

## Why a proxy, and the three things that make it work

Do not "simplify" any of these; each is load-bearing and each was verified.

- **Inject into the document, never rewrite URLs.** Every vendor asset path is
  root-absolute, so path-preserving proxying needs no rewriting. The hashes
  change every firmware; a rewriter would be a permanent maintenance tax on a
  bundle nobody controls.
- **Only `text/html` is ever buffered.** Everything else streams.
  `GET /api/stores/device` is over 100 MB — collecting it would be absurd, and
  it is not a document anyway.
- **Framing headers must be rewritten together.** The device serves documents
  **chunked**. Re-sending one whole means dropping both `transfer-encoding` and
  `content-encoding` and setting `content-length`; keeping `transfer-encoding`
  alongside a `content-length` is illegal and strict clients reject it outright.
  This shipped as a bug and was caught by a test, not by looking at it.

**There is deliberately no AWJ path in the server.** It would be easy — this is
a process, it can open TCP 10606 — but the store is already mirrored and stays
current from the socket, so an AWJ reader would be a second source of truth for
the same VPU state. Two sources that can disagree about what is on air is not
worth a faster first paint. If you are about to add one, that is the argument
to beat.

**The switcher is chosen at runtime, not at startup.** That is what lets the
desktop launcher be the fleet's stock shell with no fork: it injects a host and
a port like every other one, and the device is picked on the setup page and
remembered. It also means re-pointing at a backup frame costs a form submission
rather than a restart — and re-pointing **hangs up the existing relays**, so a
page cannot go on driving the box the operator thinks they have left.

## A note on the `wru-` prefix

CSS classes (`wru-cuelist`, `wru-overlay`), the `window.__WRU_HOOK` global and
the `wru:detected` event all still carry the initials of the old name. They were
left alone through the 0.2.0 rename on purpose: they are internal identifiers
with no user-facing surface, they are matched by string in `ui/shell.js` and by
the tests, and renaming ~50 of them would be churn with real breakage risk and
no benefit. Read `wru` as "the panels".

## Load-bearing invariants

- **`node --check` does not check ES modules.** It exits 0 on a file with an
  unbalanced argument list if the file also parses as CommonJS-ambiguous. It did
  exactly that here on a real error in `ui/timeline-panel.js`, which only
  surfaced when Chrome refused to load the panel. `test/modules.test.js` imports
  every module for this reason — that is the check. Do not replace it with
  `--check`.
- **An upgraded socket is invisible to `server.close()`.** Once a connection is
  upgraded the HTTP server stops tracking it, so `close()` neither counts nor
  closes it — it simply waits, and a Web RCS tab holds its socket open
  indefinitely. `server.closeRelays()` exists for this. Without it the
  launcher's Stop button hangs, which is how it was found: a test that timed
  out rather than failed.
- **Take the stream marker before fetching the snapshot**, not after. See
  `core/session.js` and [docs/TRANSPORT.md](docs/TRANSPORT.md). Getting this
  backwards makes the mirror quietly stale in a way nothing reports.
- **Do not update the mirror optimistically on send.** The device echoes every
  accepted write, and taking the echo as truth is what stops a rejected or
  clamped value showing as applied.
- **Screens and auxiliaries share `screenAuxGroupList` for takes but split into
  `screenList` / `auxiliaryList` under `presetBank`.** An aux recall addressed
  through `screenList` is accepted and does nothing.
- **Transition times are in tenths of a second**, and they are a property of the
  screen rather than an argument to the take.
- **A TAKE in the same cue as a recall waits `SETTLE_MS` (150 ms).** Recalls are
  silent and take time to land; a TAKE that overtakes its own preset load
  transitions the *previous* preview contents to air. Wrong picture, on air, no
  error anywhere. The gap is a floor, not a guarantee, and it is skipped for a
  cue with nothing in flight. The standalone `webrcs-timeline` engine hit this
  independently against the simulator and landed on the same figure.
- **The VPU panel never writes.** Every property it reads is `readOnly` in the
  device's own model. Keep it that way; the tool's value on a show floor
  depends on being provably harmless.
- **The VPU model is vendored, not written here.** `src/vendor/vpu-model.js` is
  a copy of aquilon-vpu-map's `public/vpu.js`; edits belong upstream, and
  `npm run sync:vpu-model` brings them back. Anything this extension needs that
  the model lacks goes in `core/vpu.js`, which only adapts the device store into
  the record shape the model expects.
- **`NATIVE` is a layer, not a background.** It is the first entry of the
  device's `PRECONFIG_SCREEN_LAYER` enum, a layer slot that consumes mixers and
  is counted by `layerCount`. Backgrounds live in `preconfig/backgrounds/` and
  cost no mixer at all. Calling `NATIVE` a background in the UI was wrong and is
  the confusion to avoid — there is a test pinning the wording.
- **Auxiliaries do not use the VPU.** `usedInScreen` draws on an S1–S24 enum
  with no `A*` entries, and `preconfig/resources` has no aux module. Do not add
  an aux column to the VPU panel.
- **Optimized mode belongs to the whole VPU**, not to the screen that triggered
  it, and it removes the four-link scaling-engine boundary. Drawing that
  boundary on an optimized VPU shows a constraint the device is not applying.

## Traps that cost time here

- **A simulator has no VPU at all**, so the VPU panel cannot be developed
  against one. It reports a `vpuLayerList` that is present and permanently empty
  and no `vpuMixerList` (`$vpuLayer` answers `E12` on hardware). Use
  `tools/harness.html` with the live capture instead. The panel names this case
  explicitly rather than drawing an empty chassis.
- **The Browser pane blocks cross-origin requests when the tab is on the LAN.**
  Injecting the modules from a local dev server works against a page on
  localhost and fails with `ERR_BLOCKED_BY_CLIENT` against a real device, with
  the request never reaching the server. That is the harness's reason to exist.
- **The sidebar separator's padding lives on an inner title element**, not on
  the separator itself. Writing `textContent` to the wrapper loses the indent
  and the heading sits flush to the edge while the vendor's are inset.
- **The keep-alive only fires after three seconds of silence.** A live device
  chatters every second, so waiting for a ping to identify the socket will wait
  forever. Adoption happens on the first Analog Way frame instead.
- **React owns the sidebar and re-renders it.** A MutationObserver puts the
  section back rather than fighting reconciliation.

## Testing

`npm test` — 54 tests, no network, no browser. Seven run against a real Aquilon
C capture (`aquilon-c-live-resources.json`, read 2026-08-21) and are the only
coverage of fitted mixers, output links and Optimized mode, none of which a
simulator produces.

Twenty-two cover the proxy, against a stand-in Web RCS on a **real socket**
rather than a mock — deliberately, because every bug worth catching there lives
in the plumbing (headers, encodings, streaming, the upgrade handshake) and a
mocked `http.request` would simply agree with whatever the code did. Both
framing bugs above were found this way.

For the panels themselves, `tools/harness.html` — see the README. It proxies the
vendor stylesheet from a named device so the panels are judged in the real
design system, and no vendor asset is committed here.
Verified through the proxy against LivePremier Simulator 6.2.73 on 2026-08-21:
the vendor app boots, the hook lands ahead of the bundle, the store mirrors
live, both panels render, the setup flow works, and a cue stack survives a
reload. **Cue persistence had never once executed before that** — the
extension's `chrome.storage` broker was never exercised.

Still not covered: **no panel has been driven live against physical hardware in
a browser**, and the launcher has never been run as a real native tray window
(its bundled chain was verified headlessly — embedded Node, staged app, proxying
with injection).

## Related work

`~/projects/video/aquilon-vpu-map` reads the same VPU mapping over AWJ from a
server. Same problem, opposite end: it reaches the device directly and runs
headless; this has the whole device store for free but only inside a tab.
`core/vpu.js :: toMixerRecords()` emits that tool's record shape so captures
cross over. Deliberately an adapter rather than a shared import — see the
no-AWJ-path argument above.

`~/projects/video/webrcs-timeline` is a Rust workspace covering the same cue
ground — `awj-proto`, `awj-link` (both transports) and `awj-cue`, 58 tests,
verified against the simulator. It is the headless, show-critical path; this is
the in-browser one. **The two cue engines are currently independent
implementations of the same model and will drift.** Converging them is an open
decision, not an oversight — see the note in the project memory. Its
integer-thousandths cue numbering is worth adopting here if cue numbers ever
become keys rather than labels.

Reverse-engineering notes, the bundle-extraction recipe and the raw device
captures live in the private `webrcs-unleashed-research` repo, not here. That
repo kept its name through the 0.2.0 rename — it is a research log, and
rewriting its history to match a product name would cost more than it is worth.

`launcher/` is the fleet's standard Tauri shell (see `~/projects/tooling/av-launcher`),
retargeted via `src-tauri/launcher.toml` alone. No Rust was changed and none
should need to be.
