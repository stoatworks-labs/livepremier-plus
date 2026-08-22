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

## Arithmetic in vendor fields (`ui/math-fields.js`)

Three things here are load-bearing and were each verified on a running Web RCS
rather than reasoned about:

- **The selector is `input[type=text]` with a `step` attribute.** Web RCS's
  numeric fields are *text* inputs carrying `min`/`max`/`step` — geometry
  reports `step="1"`, X spans -960..2880, width 0..8192. Using the vendor's own
  declaration avoids matching a per-build class hash, and excludes labels and
  the `00:01.000` transition field, neither of which has a `step`.
- **`type="number"` fields are excluded on purpose.** A number input discards
  what it cannot parse: after `1080-80` the browser reports `value === ""` with
  `validity.badInput`, and `selectionStart` is `null`. The expression is on
  screen and unreadable from script. Supporting them needs a `type` swap on
  focus plus reimplemented arrow-key stepping — do not add it casually.
- **Capture phase on `document` is the entire timing strategy.** React attaches
  its handlers at the root container, so a capture listener on `document` runs
  before them. We rewrite the value, then let the event continue into the
  vendor's own commit handler.

Writing takes the controlled-input dance: React overrides `value` on the
element, so use the native setter from `HTMLInputElement.prototype` and then
dispatch a bubbling `input` event, or React's state never learns about it.
Verified end to end — `1080-80` in a width produced `sizeH=1000` on the wire,
with the vendor's aspect lock sending `sizeV` alongside it, exactly as if the
number had been typed.

**Never put `eval` or `new Function` in this path.** `core/expr.js` is a
recursive-descent parser over a closed token set and must stay one. It refuses
rather than guesses — division by zero is rejected specifically because
`Infinity` would survive the clamp and land as the field's max, which is a
plausible-looking wrong answer.

## Where our surfaces live, and why

- **Console and Timeline are tabs in the vendor's strip** on Screens / Aux.
  (`ui/tabs.js`), cloned from a real tab exactly as `Shell` clones a sidebar
  entry. The strip's container carries a CSS-modules hash, so it is found by
  **structure** — the parent of `.ui.tabular.menu` — never by name. React
  re-renders that subtree on every selection change; a MutationObserver puts
  the tabs back, and `_mount()` is idempotent because it runs constantly.

  ⚠️ **`.ui.tabular.menu` is not unique to that panel.** Preconfig heads its
  page with a strip built from the same Semantic UI classes, and Console and
  Timeline were appended to it for a release — two words in a row of glyphs, on
  a page they have nothing to do with. A strip only qualifies if it holds a
  **pane switcher**: an anchor with a heading and no `href`. That is the
  difference between "these tabs change what is shown here" and "these links go
  somewhere else", and it needs no class, route or label.
- **Settings are in the Preconfig flyout** (`ui/settings-panel.js`), beneath the
  device's own System page, because Preconfig is where Web RCS files things
  about the installation as a whole. `Shell` takes `submenuOf: '<vendor label>'`
  for this. The flyout's active class **cannot be lifted off a live element** the
  way the sidebar's can — it exists only while the operator is on a page inside
  the flyout, and they may never go to one — so it is read out of the vendor's
  own stylesheet (`classFromStylesheets`). A proxied page is same-origin, so
  `cssRules` is legible.
- **MIDI Mapping is anchored under Virtual RC400T**, not in the PLUS section.
  `Shell` entries take an optional `after: '<vendor label>'` for this. The
  anchor is matched on the visible **label**, because that is the only part of
  the sidebar markup the vendor has not hashed.
- **Only the VPU map stays in PLUS** — it is a whole-device view, and the others
  belong to parts of the app that already exist.

### The popped-out console (`ui/popout.js`, `server/console.html`)

`/__lpp/console` is a document of **ours**, served from this process rather than
proxied, opened by the Pop out button on the Console. It holds the screen and
aux previews, a full-width command line and a Syntax/Macros shelf.

Two things about it are load-bearing:

- **It opens no socket and fetches no store.** It reaches back through
  `window.opener.__WRU` and drives the session already running in the Web RCS
  tab. That is the only reason a second window is allowed at all — see idea 3
  above; a window that connected on its own would show up in the device's own
  client count as a phantom operator. It also means the popout **must** be on
  our origin, and that losing the opener has to be handled out loud: a command
  line that has quietly stopped reaching a switcher is the failure worth a
  banner.
- **It ships no stylesheet.** The `<link>` hrefs, the `#__SVG_SPRITE_NODE__`
  icon sprite and the root `font-size` are copied off the opener at runtime.
  Never hard-code them: the hashes change every firmware, and every `aw-`
  spacing value is in rem against the vendor's `html { font-size: 12px }`, so a
  popout on the browser default lays out half again too large.

⚠️ **There is no screen snapshot endpoint.** `/api/device/snapshots/<type>/<id>`
serves inputs, images, outputs, multiviewers and timers — the screen card is
composed in the browser, and `core/screens.js` does the reading half. The trap
that file exists to close: **a preset carries geometry for every layer slot,
allocated or not.** On the simulator S1's preset A has layer 2 on `LIVE_3` at
full screen, and layer 2 does not exist. The preset says *where*; the screen's
own `layerList/items/<n>/status/pp/capability` says *whether*. Drawing the
preset alone covers every screen in stale full-frame layers.

## There are two platforms, and only one of them is supported

Read off the simulators' own `webapp-bundle/bundle.json` and confirmed against
their running stores on 2026-08-22:

| range | platform | bundle | firmware | identity lives at |
|---|---|---|---|---|
| LivePremier (Aquilon) | `nlc-platform` | 6.2.1 | 6.2.73 | `system/deviceList/items/<1-4>/pp` |
| Midra 4K | `mng-platform` | 3.2.6 | 3.2.29 | `system/pp` |
| Alta 4K | `mng-platform` | 1.3.1 | 1.3.7 | `system/pp` |

**Midra 4K and Alta 4K are the same platform as each other**, on different
version lines, and a different platform from LivePremier.

**What carries over:** the whole proxy, the hook, the store mirror and the
panel-mounting machinery. All three serve the same Web RCS architecture, the
same `GET /api/stores/device`, the same socket and AWJ on 10606.

**What does not:** the object model. `screenAuxGroupList`, `presetBank`,
`masterPresetBank` and `vpuMixerList` do not exist on `mng-platform` at all.
Screens are `1`..`4`, not `S1`..`S24`. Transitions live in a top-level
`transition` node with one `takeTime` rather than the `takeUpTime` /
`takeDownTime` pair. So every path in `core/paths.js`, and every command mynah
compiles, is LivePremier-shaped.

`core/platform.js` therefore **detects the platform and gates every feature**,
and today that means the panels are LivePremier-only. Three rules in it are
worth keeping:

- **Identity is read from two different places** and `platformLabel` is the
  discriminator. `system/pp` is `{ready:true}` on LivePremier and carries the
  whole identity on the other family; getting that the wrong way round
  identifies nothing.
- **Capabilities are probed, not tabulated.** A feature is offered when the
  part of the store it writes to is present — not when the model is on an
  allowlist. An allowlist is a promise about hardware nobody here has, and it
  goes stale the first time Analog Way ships a range this file has not met.
- **Unknown is not the same as unsupported.** Before the store arrives every
  capability is `null` and everything stays on offer, because a panel that
  flickers into existence is a smaller problem than one missing for good
  because a switcher was slow.

### The UI differences, which are smaller than they look

The `mng-platform` Web RCS spells its sidebar module `sidebar__c__…` where
LivePremier spells it `sidebar-module__c__…`. **Every segment after `__c__` is
identical.** `ui/shell.js` matches both, because the settings page has to mount
on a Midra even though nothing else does — it is where an operator finds out
*why* nothing else is there, and an app that silently does nothing is worse
than one that explains itself.

Two more, both fixed structurally rather than by platform-sniffing:

- **The flyout items are not hashed on `mng-platform`** — they are plain
  Semantic UI `<a class="item">`. The template falls back to the first anchor
  in the list, and the active class falls back to Semantic's `active`.
- **`.aw-app` wraps a row on LivePremier and *is* the row on Midra and Alta.**
  Counting children of `.aw-app` therefore picked the main content instead of
  the row and appended the panel inside it at zero width — rendered, correct,
  and invisible. The row is now derived from the sidebar's parent.

⚠️ Still un-ported, and known: the tab strip's pane-switcher test looks for an
`h5` inside the anchor, and `mng-platform` puts the label straight in the
anchor. It does not matter yet because the tabs are gated off there, but it is
the next thing to trip over if the paths are ever ported.

⚠️ Running the simulators: all three default to `PORT=3000` **and**
`AWJ_EXT_PORT=10606`, so only one runs at a time out of the box. Edit the port
block in `~/Library/Application Support/ANALOG WAY/<sim>/<session>/settings.ini`,
copy it to `settings_0.ini`, and launch the inner binary directly —
`cd <session dir> && <App>.app/Contents/MacOS/<RANGE>/bin/AW_APP_SIMULATOR.app/Contents/MacOS/AW_APP_SIMULATOR <session>/settings_0.ini`.
**The working directory has to be the session directory**; without it the
process starts and exits with only a couple of Qt warnings to show for it.

## MIDI: the constraint that used to decide the architecture, and does not now

`navigator.requestMIDIAccess()` is secure-context-only. As an extension on an
http:// LAN address that forced an offscreen document on the
`chrome-extension://` origin relaying through a service worker — awj-surface
still carries a `hosts/extension/` implementing exactly that, and it is now
**dead**: it patches a `manifest.json` this repo no longer has.

Serving from loopback makes the page a secure context, so Web MIDI is directly
available. **Verified, not assumed**: `window.isSecureContext === true` and
`navigator.requestMIDIAccess` present on the served origin. It also means an
operator who opens the switcher's own address gets no MIDI — the panel says so
explicitly, because that failure is not guessable.

OSC is still not possible in the page (no UDP anywhere in a browser). If it is
ever wanted, this process is already the local host awj-surface's node host
assumes — that is the place for it, not the panel.

## The demo environment, and one thing it revealed

`npm run demo` (`tools/demo.mjs`) runs the app against a simulator and splices
the recorded Aquilon C resource subtree into the store after hydration, because
**a simulator has no VPU** and the VPU map is the headline panel. It refuses any
non-loopback address — it seeds a cue stack and rewrites part of the store, and
neither belongs near a production frame.

It leans on a small, general extension point in `proxy.js`: `extraModules`
(module URLs injected *after* `main.js`, so `window.__WRU` exists) and
`extraFiles` (an **exact-match** table of NS path to file, so nothing about a
request builds a filesystem path). Both default empty; production injects
nothing extra.

`tools/demo/seed.js` writes into `store.root` directly rather than via
`store.set()`. That is deliberate: `startsWith(path, prefix)` only notifies
subscribers whose prefix is a prefix of the written path, so a single write at
`preconfig/resources` would reach nobody watching deeper — and the panels all
subscribe well below it. It splices, then calls `shell.refresh()` explicitly.

**⚠️ Verifying panels in the Browser pane: `requestAnimationFrame` does not fire
while the pane is hidden**, and `onRefresh` is `throttleFrame`-wrapped. A panel
will look frozen and two views will hash identically, which reads exactly like a
broken toggle. Call `window.__WRU.shell.refresh()` to force a synchronous
render before comparing. This cost a real debugging round; the CURRENT/STAGED
toggle was fine all along (hashes `664e6945` vs `cc652f36`).

**A related correction.** The project memory said running-vs-staged was
"visibly different in the grid". It is not, and that is correct behaviour: both
sides drive the same *output links*, so `buildLinkGrid` rightly produces the
same geometry. What differs is which **pipe slot** inside each mixer carries
the link. The panel surfaces that in the header badge (`26 staged changes`) and
as `CHANGED in the staged configuration` on the affected blocks in DETAIL — not
as moved blocks. Do not "fix" the grid to move them.

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

`npm test` — 88 tests, no network, no browser. Seven run against a real Aquilon
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

Derivation notes and the raw device captures live in a separate private
research repo, not here, and that separation is deliberate now that this one is
public. Keep it: nothing describing how the device model was arrived at belongs
in this repository.

`launcher/` is the fleet's standard Tauri shell (see `~/projects/tooling/av-launcher`),
retargeted via `src-tauri/launcher.toml` alone. No Rust was changed and none
should need to be.
