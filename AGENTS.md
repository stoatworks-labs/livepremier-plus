# AGENTS.md — webRCS unleashed

Orientation for an LLM or a newcomer picking this up cold. [README.md](README.md)
is the *what*; this is the *why* and the traps.

## The one-paragraph version

A Chrome extension that puts two new panels inside Analog Way's own LivePremier
Web RCS: a VPU resource map and a theatre-style cue stack. It does not replace
the vendor UI, does not open its own connection to the device, and does not
ship a theme — it borrows the vendor's stylesheet and rides the vendor's socket.

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
why the hook runs as a MAIN-world content script at `document_start` — it has to
wrap `WebSocket` before the vendor bundle constructs one, and there is no later
opportunity.

**4. `core/` knows nothing about browsers.** No DOM, no `chrome.*`, no
transport. It imports and runs under plain Node, which is what the tests do.
The extension is one front-end; a standalone AWJ client is meant to be another
and should need only a new `transports/` module. Keep device I/O out of `core/`.

## Load-bearing invariants

- **`node --check` does not check ES modules.** It exits 0 on a file with an
  unbalanced argument list if the file also parses as CommonJS-ambiguous. It did
  exactly that here on a real error in `ui/timeline-panel.js`, which only
  surfaced when Chrome refused to load the panel. `test/modules.test.js` imports
  every module for this reason — that is the check. Do not replace it with
  `--check`.
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
- **Two firmware models for the VPU mapping** (`vpuMixerList` vs
  `vpuLayerList`) and both are in the field. `core/vpu.js` normalises them.
  `slice` is `null` where not reported — that is "not reported", not slice 0.

## Traps that cost time here

- **The simulator reports no fitted VPU units at all.** A simulated Cmax answers
  the resource mapping with 128 units, every one `isAvailable: false`. That is
  correct and the panel says "not fitted" — it is not a bug, and it means the
  populated rendering cannot be seen against the simulator without pushing a
  recorded mapping into the local mirror.
- **The sidebar separator's padding lives on an inner title element**, not on
  the separator itself. Writing `textContent` to the wrapper loses the indent
  and the heading sits flush to the edge while the vendor's are inset.
- **The keep-alive only fires after three seconds of silence.** A live device
  chatters every second, so waiting for a ping to identify the socket will wait
  forever. Adoption happens on the first Analog Way frame instead.
- **React owns the sidebar and re-renders it.** A MutationObserver puts the
  section back rather than fighting reconciliation.

## Testing

`npm test` — 22 tests, no network, no browser. Two fixtures are real captures
from a running simulator; `mixer-model.json` is hand-authored to the older
firmware's shape, which a simulator cannot produce.

For the panels themselves, `npm run serve` and the console recipe in the README.
Note what that does *not* cover: MV3 packaging, the isolated-world loader, and
`chrome.storage` persistence have never been exercised in a packed extension.

## Related work

`~/projects/video/aquilon-vpu-map` reads the same VPU mapping over AWJ from a
server. Same problem, opposite end: it reaches the device directly and runs
headless; this has the whole device store for free but only inside a tab.
`core/vpu.js :: toMixerRecords()` emits that tool's record shape so captures
cross over. Deliberately an adapter rather than a shared import — a browser
extension cannot speak TCP 10606, and a vendored copy would drift.

`~/projects/video/webrcs-timeline` is a Rust workspace covering the same cue
ground — `awj-proto`, `awj-link` (both transports) and `awj-cue`, 58 tests,
verified against the simulator. It is the headless, show-critical path; this is
the in-browser one. **The two cue engines are currently independent
implementations of the same model and will drift.** Converging them is an open
decision, not an oversight — see the note in the project memory. Its
integer-thousandths cue numbering is worth adopting here if cue numbers ever
become keys rather than labels.

Reverse-engineering notes, the bundle-extraction recipe and the raw device
captures live in the private `webrcs-unleashed-research` repo, not here.
