# Notes

Working notes for this repo: status, decisions, and the traps that have actually bitten.
Migrated out of Claude Code's memory on 2026-08-24, so they are written in the first
person and dated by when each thing was learned — that date is usually the useful part.

Cross-cutting notes that are not specific to this repo live in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).

*LivePremier Plus (was webRCS unleashed) — a LOCAL REVERSE PROXY, no longer a Chrome extension, injecting a VPU map and a theatre cue stack into a real LivePremier Web RCS session in the vendor's own CSS; PRIVATE + pushed; verified through the proxy against the simulator; no panel ever driven live on hardware in a browser*

## RENAMED + RE-ARCHITECTED 2026-08-21 — read this first

**It is `livepremier-plus` now, and it is NOT an extension.** Both the repo and
the local dir were renamed (`~/projects/video/livepremier-plus`,
`github.com/stoatworks-labs/livepremier-plus`; GitHub redirects the old name).
`manifest.json` and `src/loader.js` are DELETED. v0.2.0, 54 tests, pushed.

**It is a local reverse proxy**: `npm start`, browse to `127.0.0.1:8534`, give
it a switcher, and the vendor Web RCS comes up with the panels in it. `server/`
holds `proxy.js` / `index.js` / `storage.js` / `setup.html`; `launcher/` is the
fleet's stock Tauri shell, retargeted by `launcher.toml` alone (no Rust
changed, `cargo check` green, bundled chain verified headlessly).

**Why the user's premise was half-right.** They said the VPU map "appears to be
limited to a desktop app, not a Chrome extension". The real axis is **origin,
not browser**: [livepremier vpu visualizer](https://github.com/stoatworks-labs/aquilon-vpu-map/blob/main/docs/NOTES.md) (`aquilon-vpu-map`) needs a process because it
uses **AWJ over TCP 10606**, which no tab can open. This project never used AWJ
— it reads `GET /api/stores/device` **same-origin**, which the extension got by
running in the device's page. The proxy makes `localhost:8534` *be* that origin,
so the proven store path carries over untouched.

**The AWJ bridge was CONSIDERED AND REJECTED** — the argument to beat if it ever
comes up again: `session.start()` hydrates the 118 MB store unconditionally for
the cue stack, and deltas keep it current, so an AWJ reader would be a **second
source of truth for the same VPU state**. Two sources that can disagree about
what is on air is worse than a slow first paint. It would also burn one of the
5 AWJ client slots and add a second vendoring/drift path.

### Four things the proxy buys that the extension could not
1. **Any browser**, not just a Chrome with a sideloaded extension — matters on a
   locked-down show laptop.
2. **The hook's ordering stops being a race.** Every vendor script tag is
   `defer`, so an inline `<head>` script is ordered first *by the parser*. MV3
   `document_start` usually won but was never promised to.
3. **Cue persistence actually works** — file per device in `~/.livepremier-plus`.
   The `chrome.storage` broker had NEVER ONCE EXECUTED.
4. No MV3 packaging, nothing to reinstall after a browser update.

### ⚠️ Two bugs the proxy tests caught — both had shipped in the working spike
- **The device serves documents CHUNKED.** Re-sending one whole must delete
  `transfer-encoding` AND `content-encoding` before setting `content-length`.
  That pair is illegal and undici rejects it outright. Every document would
  have failed.
- **An upgraded socket is INVISIBLE to `server.close()`** — neither counted nor
  closed, just waited on, and a Web RCS tab never disconnects. Hence
  `server.closeRelays()`. Without it **the launcher's Stop button hangs**. It
  surfaced as a test that TIMED OUT rather than one that failed — worth
  remembering as a failure mode, not just a bug.

### Design points that are load-bearing
- **Never rewrite URLs.** Every vendor asset path is root-absolute, so
  path-preserving proxying needs none. Hashes change every firmware.
- **Only `text/html` is buffered**; everything else streams (the store is 118 MB).
- **CSP is stripped defensively** — none is served today, on sim or hardware.
- **The switcher is chosen at RUNTIME**, not a startup flag. That is what lets
  `launcher/` be the stock shell (it injects host+port like every other fleet
  app), and re-pointing at a backup frame costs a form submit, not a restart.
  Re-pointing **hangs up the old relays** so a page cannot keep driving the box
  the operator thinks they left.
- **The `wru-` prefix stays** (CSS classes, `__WRU_HOOK`, `wru:detected`) —
  internal identifiers, matched by string in `ui/shell.js` and the tests.
  Renaming ~50 of them is churn with breakage risk. Read `wru` as "the panels".
- Sidebar section is now **`PLUS`**, was `UNLEASHED`.
- **The research repo KEPT its old name** — `webrcs-unleashed-research` is a
  research log; renaming it is not worth the history churn.

## Field arithmetic — `1080-80` in a layer width gives 1000 (2026-08-21)

Third panel-less feature, `src/ui/math-fields.js` + `src/core/expr.js`, 74 tests
total. **Verified on the sim: `1080-80` in a width put `sizeH=1000` on the wire**,
with `sizeV` alongside from the vendor's own aspect lock, via BOTH commit paths.

**⚠️ THE KEY DOM FACT, and it inverts the obvious guess: Web RCS's numeric
fields are `input[type=TEXT]` carrying `min`/`max`/`step`** — geometry reports
`step="1"`, X spans -960..2880, width 0..8192. So `.value` keeps a typed
expression and **the `step` attribute is the selector**. That is the vendor's own
declaration that a field is numeric, needs no per-build class hash, and excludes
what must never be touched — labels have NO step, and neither does the
`00:01.000` transition field.

**⚠️ `input[type=number]` DISCARDS what it cannot parse.** After typing
`1080-80` the browser reports `value === ""` + `validity.badInput`, and
`selectionStart` is `null` — the expression is ON SCREEN and UNREADABLE from
script. VERIFIED with real keystrokes, not assumed. So opacity/zoom (the `%`
fields, which ARE type=number) are **deliberately excluded**; supporting them
needs a `type` swap on focus PLUS reimplemented native arrow stepping. Do not
add it casually.

**Getting in front of React:** it attaches handlers at the root container, so a
**capture-phase listener on `document`** runs first. Rewrite the value there,
let the event continue, and the vendor's commit handler reads it as typed.
Writing needs **the native setter off `HTMLInputElement.prototype` + a bubbling
`input` event** — React overrides `value` on the element, so a direct set is
invisible to its state. (`focus → setter → input → blur` is the full commit
recipe; a `blur()` on a NON-focused element does nothing, which cost a debugging
round.)

**NEVER put `eval`/`new Function` in this path** — `core/expr.js` is a
recursive-descent parser over a closed token set. Division by zero is rejected
*specifically* because `Infinity` would survive the clamp and land as the
field's max: a plausible-looking wrong value on air, which is the whole failure
mode being defended against.

## FIRST PUBLIC RELEASE v0.3.1 (2026-08-21)

**PUBLIC**: `stoatworks-labs/livepremier-plus` MIT, and **awj-surface was made
PUBLIC too** (the user's call) so the vendored `src/vendor/surface/` has a real
upstream. Both got the disclaimer + ATTRIBUTIONS; awj-surface lost its dead
`hosts/extension/`. Release v0.3.1 with **7 assets**: macOS .dmg+.pkg for BOTH
arches, Linux .deb+.rpm, Windows .exe, plus GHCR (anonymous pull = HTTP 200, so
the public-before-first-workflow-push ordering held). Website entry live at
`/software/livepremier-plus/`. **Port moved 8534 → 8535** (8534 is mynah's).

**⚠️ NO HOSTED DEMO, EVER** — and it is in ATTRIBUTIONS, the README, the release
notes and the website copy. The interface is Analog Way's, served by the
customer's own switcher; we proxy it and ship none of it. Nothing to host.

### Release traps hit, all fixed
- **CI's first run found the app never supported Node 18** — `CustomEvent` is
  global only from 19, and core/ + the surface engine are EventTarget-based. 28
  failures. Floor is now **Node 20** (`engines` + README + CI matrix).
- **Tauri's own dmg bundler fails on the cross-compiled x86_64** — build
  `--bundles app` and package with `rl_pkg`/`rl_dmg` from `scripts/release-lib.sh`
  (vendored from av-launcher, hash `1b0bde498157`).
- **Then hdiutil hit "No space left on device"** on x86_64 only: cross-compile
  target dir + the ~111 MB embedded Node copied into .app → stage → dmg. Fixed
  by deleting cargo intermediates before packaging.
- `gen-downloads.py` needs the **projects.json entry to exist first** — it
  discovers from there. `--repo livepremier-plus` scopes it; a bare run sweeps
  the whole fleet (which once ate prose from six repos).

### ⚠️ CO-SESSION collision — real, and instructive
A parallel session pushed `Info.plist` (**NSLocalNetworkUsageDescription** —
without it the macOS app cannot reach a switcher when double-clicked) and bumped
to **0.3.1** while I was mid-release. My dispatched build then attached
0.3.1-named assets to a v0.3.0 release. Resolved by **deleting the incomplete
v0.3.0 and cutting v0.3.1** from main, keeping their fix. Also: **my
uncommitted `projects.json` website edit was silently lost** to the same
session — re-done and committed immediately with `git commit -- <path>`.
See **cosession shared checkout** (working-practice note, kept in Claude memory); the rule earned its keep twice.

### Video — PUBLISHED to both
- **YouTube `mGjGiNO_tSo`** — currently **UNLISTED**, awaiting the user flipping
  it public. Thumbnail set, `changes: []`.
- **Instagram Reel `DcUlgPdDYAD`** on `stoatworkslabs`, `changes: []` (no
  padding — the 9:16 and the muxed silence were both correct).
- Both **embeds done**: README link + `projects.json` `youtube`/`videoDate`;
  site rebuilt and deployed.
**⚠️ I WAS WRONG that YouTube could not be automated.** The read-only limit in
[youtube mcp](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_youtube_mcp.md) is about the **YouTube MCP** and about **editing an
already-published** video in Studio. **Upload-Post has the YouTube account
connected** (`@stoatworks-labs`, no reauth) and `upload_video` takes title,
description, tags, thumbnail and `youtubePrivacyStatus` — a NEW upload works
fine. This fleet had never used that path (every ledger entry was Instagram).

Take traps: the clap must be **300ms** (a 120ms flash falls between frames of
the 10fps sampler — one whole take lost); beats must use key **`t`** not `at`;
`selectLayer` must click the **`.ui.selection.list .item`**, not the chip inside
it. Added driver-warning surfacing to `lib/webtake.py` so a step that operates
nothing is printed instead of silently producing a caption over nothing.

## Four languages, real settings, and OSC IN (2026-08-22) — 199 tests

**Pushed to `main`, `687c09d`.** The console takes all four of mynah's languages
(re-synced vendored bundle). Settings stops being a placeholder.

- **`server/osc.js`** — a UDP listener. OFF by default, binds **loopback** unless
  told otherwise, writes to the switcher **over AWJ**, so it works with no
  browser open. That is the point of a show-control input. Its address space is
  `docs/OSC.md`, **generated** by `tools/gen-osc-docs.mjs` from the resolver's
  own tables; a test fails when the checked-in file stops matching. 173
  addresses — mynah's 7 layer params widened to the surface catalogue's 67 by
  `src/core/osc-dictionary.js`.
- **`server/awj.js`** — ⚠️ **the AWJ path AGENTS.md said there deliberately was
  not.** The old argument (a second source of truth for the VPU state) still
  stands and is restated at the top of that file. This is not that: it never
  touches the store mirror, holds no connection, subscribes to nothing. Both
  callers need what the mirror cannot give.
- **Settings are SERVER-SIDE** (`src/core/settings.js`, `PUT /__lpp/settings`,
  one file in `~/.livepremier-plus`), not localStorage and **not keyed by
  device**: the OSC socket is invisible to a browser, and the console exists in
  two windows at once. Re-pointing at a backup frame must not change the command
  language or close a port a lighting desk is sending to.
- `presetBanks()` exported from `core/screens.js` — the one place that decides
  which buffer is program.
- Website: **`/reference/livepremier-osc/`**, table synced by the site's
  `scripts/sync-osc-dictionary.mjs`. ⚠️ **NOT deployed** — the site needs
  `npm run build && cf-run npx wrangler deploy`; `scripts/deploy.sh` is dead and
  says so.

⚠️ Traps: [command language dialects](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_command_language_dialects.md).

## Mynah + MIDI integrated (2026-08-21) — 88 tests

**Placement, as the user specified it:**
- **Console (mynah) + Timeline are TABS** in the vendor's own strip on
  Screens/Aux, beside Properties/Memories (`src/ui/tabs.js`).
- **MIDI Mapping is ANCHORED under Virtual RC400T** in the vendor's LIVE
  section — `Shell` entries gained `after: '<vendor label>'`, matched on the
  **visible label** (the only un-hashed part of that markup).
- **Only VPU Map stays in PLUS** (whole-device view).
- Tab strip container has a CSS-modules hash → find by **structure** (parent of
  `.ui.tabular.menu`), never by name. `_mount()` must be idempotent; React
  re-renders that subtree on every selection change.

**TWO more vendored trees** (+ sync scripts + drift tests), same rule as the VPU
model — one implementation, copied not re-derived:
- `src/vendor/mynah-lang.mjs` ← mynah's own **`npm run build:lang`** output
  (`dist-lang/mynah-lang.mjs`, 40KB, zero deps, built FOR outside consumers;
  the Companion module vendors the same file). Don't hand-port the TS.
- `src/vendor/surface/` ← awj-surface `core/` + stock profiles, **by MANIFEST**
  (per-file sha256) since it's a directory.
- `src/vendor/pitch-engine.js` ← aquilon-pitch's own **`npm run build:lib`**
  output (`dist-lib/aquilon-pitch-engine.js`, zero deps, built FOR outside
  consumers). Same arrangement as mynah — don't hand-port the TS.

**⚠️ The pitch ratio is easy to get backwards.** It **multiplies** a group's
raster to give its canvas footprint, so a *coarser* wall (bigger mm pitch) takes
a ratio *above* 1.000 and downsamples. Verified upstream by writing
`pitchRatioH = 2000` to a running simulator and watching `pitchedWidth` go
1920 → 3840. Three more things the manual does not say, all pinned by
`test/vendor.test.js` so they cannot quietly drift here: the field is int
thousandths 100–10000; an **out-of-range write is DISCARDED, not clamped**, and
silently; and the footprint **floors** (1080 × 1.234 = 1332, not 1333). Full
evidence in aquilon-pitch's `docs/NOTES.md` and in
[livepremier pitch compensation](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_livepremier_pitch_compensation.md).

**`xUpdate` or nothing happens.** Writing a pitch ratio moves `canvas/cmd/pp`
and leaves `canvas/status/pp/pitchedWidth` exactly where it was until
`xUpdate` is written true on the same node. `core/pitch.js` emits it after every
pair; a hand-rolled script that forgets it looks like it worked and changed
nothing.

**`usedInScreenAux` is the literal string `"NONE"`** when an output is on no
screen, not an absent key. `if (!status.usedInScreenAux)` looks like it filters
unassigned outputs and does not. A test pins it.

**⚠️ STRONG CORROBORATION worth keeping:** mynah's compiler and this repo's
`core/paths.js` `CMD` builder were derived INDEPENDENTLY (bundle vs live
captures) and emit **byte-identical** store paths for `Take Screen 1` and
`Recall Screen 1 Memory 5`. A test pins it. Only true while nobody re-types the
grammar here. Mynah's `Path.prototype.toWs()` gives store form directly
(`toAwj()` gives the other).

**⚠️ MIDI needed NO offscreen document — the extension-era architecture is
DEAD.** `requestMIDIAccess` is secure-context-only, which on an http:// LAN
address forced the service-worker + offscreen relay described in
[web midi secure context](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_web_midi_secure_context.md). **Serving from loopback makes the page a
secure context** — VERIFIED: `isSecureContext === true` and the API present on
`http://127.0.0.1:8534`. Also fixes the SysEx prompt problem (an invisible
offscreen doc can't prompt; a normal page can). **Corollary now surfaced in the
UI: open the switcher's OWN address and MIDI cannot work.**
awj-surface's `hosts/extension/` is now **DEAD** — it patches a `manifest.json`
this repo deleted, and its README still points at `../webrcs-unleashed`.
**OSC is still impossible in-page** (no UDP in any browser); this process is
already the local host for it if ever wanted.

**Engine contract** (awj-surface core, unchanged): `surface.handle(bytes)` →
event; `engine.input(event)`; `engine.on('write')` → `{writes:[{path,value}]}`
**already in STORE form** (the node host converts to AWJ, we don't);
`engine.deviceChanged(path)`; `engine.on('feedback')` → `surface.render()`.
**Soft pickup holds off** until a fader sweeps through the live value — a
`holdoff` event, not a bug; that's what "no write" on first move means.

Verified on the sim: Console `Recall Screen 1 Memory 3` → correct presetBank
frame; APC40 CC sweep → layer-opacity write at the right path after pickup.
**Still NO physical controller ever attached.**

## Demo environment + launcher shell refresh (2026-08-21)

**`npm run demo`** (`tools/demo.mjs`) — app + simulator + the real Aquilon C
resource subtree spliced in + 4 seeded cues, prints a "things to try" list.
**REFUSES any non-loopback address** (it seeds a stack and rewrites a store).
Needs a simulator: the panels mount into Web RCS's own sidebar and ride its
socket, so a stubbed demo demos the wrong thing; the sim gives the genuine
vendor UI, and the capture gives the VPU the sim does not have. Uses a new,
general proxy extension point — `extraModules` (injected AFTER main.js so
`window.__WRU` exists) + `extraFiles` (EXACT-MATCH table, no path building).

**⚠️ BROWSER PANE TRAP, cost a debugging round:** `requestAnimationFrame` does
NOT fire while the pane is hidden, and panel repaints go through
`throttleFrame`. Two views then hash IDENTICALLY and it reads exactly like a
broken toggle. **Call `window.__WRU.shell.refresh()` to force a synchronous
render before comparing.** The CURRENT/STAGED toggle was fine all along
(`664e6945` vs `cc652f36`). See [browser pane verification traps](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_browser_pane_verification_traps.md).

**⚠️ CORRECTION to the note below:** running-vs-staged is **NOT** "visibly
different in the grid", and that is CORRECT. Both sides drive the same *output
links*, so `buildLinkGrid` rightly yields identical geometry; what moves is the
**pipe SLOT inside each mixer** (current 1,3,5,7 → staged 1,2,3,4, same values
1-4). The panel shows it as the `26 staged changes` badge and `CHANGED in the
staged configuration` in DETAIL. **Do not "fix" the grid to move blocks.**

**Launcher shell re-synced from av-launcher** — it had gained a `diag` crate
(rotating log + crash report + diagnostics bundle) and **`**field**` custom
panel inputs**, which NO per-repo launcher had adopted (7 checked). Held
`if-addrs` at **0.15** (per-repo shells moved up; canonical still says 0.13).
`crates/diag` lives at **`src-tauri/crates/diag`**, not repo-root `crates/`.
cargo check + its 7 tests green, bundled chain re-verified.
**This invalidated the earlier "a device field would mean forking the shell"
argument** — added as an OPTIONAL field instead: blank injects an empty
`LPP_DEVICE`, which falls through to remembered, then to the setup page (both
verified). openrcs already used `**field**` for a "Switcher IP" — precedent.

**Vendored VPU model was already current** — upstream `public/vpu.js` last
touched by the commit the provenance header records; the drift test does a real
content comparison and passed.

## Verified 2026-08-21 through the proxy, against Simulator 6.2.73
Vendor app boots, hook lands ahead of the bundle, **session `live` + store
mirrored**, both panels render, setup flow works, **cue stack survives a
reload**. `--help`, remembered device, bundled-Node chain all exercised.
**STILL NEVER DONE: any panel driven live against physical hardware in a
browser, and the launcher as a real native tray window.**

---

## Original build notes (2026-08-20) — the extension era

Built 2026-08-20 in one session. **Two repos, both PRIVATE on GitHub, pushed,
`main`** — the openrcs split, as the user chose:

- `~/projects/video/livepremier-plus` — WAS the extension (MV3, no build step);
  now the proxy. `github.com/stoatworks-labs/livepremier-plus`
- `~/reverse-engineering/video/webrcs-unleashed-research` — derivation, the raw
  Aquilon C VPU captures, the vendor modules the transport was read from, and
  `tools/extract-modules.py`.
  `github.com/stoatworks-labs/webrcs-unleashed-research`

Private, so **no AI disclaimer yet** (**disclaimer scope** (working-practice note, kept in Claude memory) is a
public-repo rule) — add one to the product repo before it ever goes public.
**No Dependabot and no PR CI**, deliberately: CI minutes are billed on private
repos (**ci actions quota restored** (working-practice note, kept in Claude memory)) and it was not asked for. `gh repo
create --push` lands on **`master`**; both had to be renamed to `main`.

## Scope, as the user decided it

Asked for "a chrome extension which can inject our livepremier VPU visualiser
and timeline into a real webRCS browser session, using webRCS native theming".
Three decisions taken up front, and they **reverse the earlier standalone-only
call** recorded in [webrcs timeline](https://github.com/stoatworks-labs/webrcs-timeline/blob/main/docs/NOTES.md) (`webrcs-timeline`):

- **Shared core, extension as one front-end** ("extension is a shell only") —
  `src/core/` has no DOM, no `chrome.*`, no transport, and imports under plain
  Node. A direct-AWJ front-end should need only a new `transports/` module.
- **Read + GO from v1** — the timeline really writes (preset recalls, transition
  times, TAKE/CUT/STEP BACK). Confirmed on the wire against the simulator.
- **Private, openrcs-style split.**

## The four load-bearing ideas

1. **Light DOM, never shadow DOM.** The vendor stylesheet defines ~500 `aw-`
   utility classes (slate-grey 50-900, spacing, typography, cards, shadows).
   Rendering into the page's light DOM inherits all of it. *That is the entire
   theming strategy* — there is no theme file beyond ~120 lines for a VPU grid
   and a cue table.
2. **Nothing about the vendor markup is hard-coded.** Web RCS uses CSS modules,
   so every class carries a per-build hash (`sidebar-module__c__menu___1sHvq`).
   Sidebar entries are **cloned from a real one at runtime** and rewritten,
   active-state classes lifted off whichever item is currently active. Icons
   come from the page's own SVG sprite (378 symbols) by id.
3. **Ride the app's own socket; never open a second one.** The device counts
   clients in its header and AWJ's 5-client cap is separate. Hence a MAIN-world
   content script at `document_start` — the only point in front of the vendor
   bundle's own `new WebSocket`.
4. The panel is a flex sibling of the main content, shown by hiding that content
   rather than floating over it. Verified it hands back cleanly.

## Verified, and NOT verified

**Verified against AW LivePremier Simulator 6.2.73**, panels rendering inside
the real Web RCS: sidebar entries indistinguishable from the vendor's, device
store mirrored live, VPU panel correct on both firmware models, and a fired cue
producing exactly the right DEVICE frames on the wire — including the
screen-vs-auxiliary split. 22 tests, no network.

**Never run against physical hardware. Never loaded as a packed extension** —
the panels were exercised by injecting the same content scripts into a live
session via `npm run serve` (a CORS static server; `python -m http.server`
cannot do it). So **MV3 packaging, `src/loader.js` and `chrome.storage`
persistence have never actually executed.** That is the first thing to try.

## Traps banked here

- **A simulator has NO VPU**, so the VPU panel cannot be developed against one.
  Use `tools/harness.html`: it renders a panel from a recorded store and
  **proxies the vendor stylesheet, fonts and sprite from a named device**
  (`DEVICE=<ip> npm run serve`), so the panels are judged in the real design
  system with no vendor asset committed.
- **The Browser pane blocks ALL cross-origin fetches once the tab is on a LAN
  address** — `ERR_BLOCKED_BY_CLIENT`, request never reaches the server. So the
  console-injection trick works against a localhost page and **cannot** work
  against a real device. That is why the harness exists.
- **The keep-alive ping only fires after 3 s of silence**, and a live device
  chatters every second — so a late-installed hook waiting for a ping waits
  forever. Adopt on the first Analog Way frame instead.
- **The sidebar separator's padding is on an inner title element**, not the
  wrapper. `textContent` on the wrapper loses the indent.
- `node --check` false pass: see [node check esm false pass](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_node_check_esm_false_pass.md).

## VPU: the model is VENDORED from aquilon-vpu-map — 2026-08-21

The user's call: "the vpu visualiser project is more or less done, build that
into the extension." Done by **copying** [livepremier vpu visualizer](https://github.com/stoatworks-labs/aquilon-vpu-map/blob/main/docs/NOTES.md) (`aquilon-vpu-map`)'s
`public/vpu.js` to `src/vendor/vpu-model.js`, not by reimplementing:

- `npm run sync:vpu-model` re-copies and rewrites the recorded upstream commit;
  `test/vendor.test.js` fails on drift and **skips** when there is no checkout
  beside the repo. A Chrome extension must contain every file it loads, so a
  copy is unavoidable — the drift test is what makes it safe.
- `src/core/vpu.js` is now only the **store adapter**, the one thing that
  genuinely differs: that tool builds mixer records from hundreds of AWJ reads,
  this lifts them from the device store, and gets `preconfig/resources/<side>/
  screenList/items/S<n>/status/pp` (the device's own "does it fit" figures)
  free where the standalone reader spends 24 round trips.
- The panel now draws **the manual's link grid** (8x8 links, reported columns,
  packed rows, the 4-link boundary hidden on an Optimized VPU).

**Three things this repo had WRONG, all fixed by adopting the shared model:**
1. `NATIVE` was labelled "Background" — it is a **layer slot that consumes
   mixers**; backgrounds are a different subtree and cost nothing. Test pins it.
2. Mixers were read as having 2 out-pipes. They have **8**.
3. It claimed two firmware models were in the field. **There is one.**
   `$vpuLayer` answers E12 on hardware, so `vpuLayerList` is a **simulator
   artefact** — a simulator has NO VPU, and the panel now says exactly that.

## Verified on the LIVE Aquilon C, read-only — 2026-08-21

Read `GET /api/stores/device` (118 MB, ~5.5 s) off 192.168.2.142. Nothing
written. `test/fixtures/aquilon-c-live-resources.json` is the trimmed resource
subtree; **7 tests run on it** and cover what no simulator can:
- 32 of 64 mixers fitted (PROC_1+2), 26 allocated, 6 spare; devices 2-4 empty.
- S1 spends **6 output capabilities across two mixers per slice, split 4 links
  and 2** — one mixer cannot span more than four (§5.5.4). Links are
  **interleaved** (1,3,5,7 / 2,4), not contiguous.
- `isOptimized: true` on S1, resolving onto the whole VPU.
- **The staged preconfig differs from running in 26 mixers, and EVERY change is
  a link move with no property changed** — the exact case a properties-only
  diff calls "no change". Running interleaves, staged packs; the two are
  visibly different in the grid.

## The other sibling — still UNRESOLVED

**[webrcs timeline](https://github.com/stoatworks-labs/webrcs-timeline/blob/main/docs/NOTES.md) (`webrcs-timeline`)** `~/projects/video/webrcs-timeline` — a Rust
workspace with `awj-cue`, both transports, 58 tests. **Its cue engine and this
one remain independent implementations that will drift.** The VPU half is now
converged; the cue half is not. One fix crossed over already: a TAKE can
overtake its own preset recall and put the *previous* preview on air, so both
hold the trigger **150 ms** behind a recall in the same cue. Its
**integer-thousandths cue numbering** is the other idea worth taking, if cue
numbers ever become keys here rather than labels.

Transport detail: [webrcs websocket transport](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_webrcs_websocket_transport.md) and the repo's
`docs/TRANSPORT.md`. Protocol generation: [awj protocol](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_awj_protocol.md).

## Settings page + popped-out console — 2026-08-22, 116 tests

Two features and one bug fix, both local commits (`ca5dfd9`, `729f14c`);
**`ca5dfd9` reached `origin/main` anyway** because a co-session committed a
README change on top of it and pushed — **cosession shared checkout** (working-practice note, kept in Claude memory)
earning its keep a third time.

### Settings, in the **Preconfig flyout** (`ui/settings-panel.js`)
The user's ask, and a deliberate placeholder: it reads model/firmware/proxy
state and lists the four coming settings marked "not yet" rather than faking
controls. `Shell` gained a third placement, **`submenuOf`**.

⚠️ **The flyout's active class cannot be lifted off a live element** the way the
sidebar's can — it exists only while the operator is on a page *inside* the
flyout, and they may never go to one. Read it out of the vendor's own stylesheet
instead (`classFromStylesheets`, exported from `ui/shell.js`); a proxied page is
same-origin so `cssRules` is legible. Every link we create now carries
`data-lpp-nav`, because a submenu entry sits inside vendor markup and the
"operator navigated away" listener had no ancestor of ours to test for.

### ⚠️ `.ui.tabular.menu` IS NOT UNIQUE — shipped bug, now fixed
**Preconfig heads its page with a strip built from the same Semantic UI
classes**, and Console + Timeline were being appended to it — two words in a row
of glyphs, on a page they have nothing to do with. A strip now qualifies only if
it holds a **pane switcher: an anchor with a heading and no `href`**. Their tabs
switch panes; Preconfig's are route links. Needs no class, route or label.

### `core/identity.js` — and the four-slot trap
Model/family/firmware/simulated, so model gating can ask once. It learned that
**`system/deviceList` is ALWAYS four slots long**, and the empty ones carry a
placeholder (`dev: 'NLC_DBG'`, empty `label`, empty `updater`) rather than being
absent. A single Aquilon was about to be reported as "4 linked frames". Test for
present-ness on **empty label or empty firmware**, never on the string NLC_DBG.

### Popped-out console (`ui/popout.js`, `server/console.html`, `/__lpp/console`)
Previews top-left, Syntax/Macros shelf right, command line full width beneath.

**It opens NO socket and fetches NO store** — it reaches through
`window.opener.__WRU` and drives the Web RCS tab's own session. That is the only
reason a second window is allowed at all, and it forces the page onto our origin.
Losing the opener disables the inputs and shows a banner. It ships **no
stylesheet**: link hrefs, the `#__SVG_SPRITE_NODE__` sprite and the root
`font-size` are copied off the opener at runtime (rem base is 12px; a popout on
the browser default lays out half again too large).

⚠️ **THERE IS NO SCREEN SNAPSHOT ENDPOINT.** `/api/device/snapshots/<type>/<id>`
serves only `inputs`, `images`, `images-library`, `outputs`, `multiviewers`,
`timers` — read out of the sim's own server bundle. Web RCS **composes the screen
card in the browser**, so `core/screens.js` does the reading half.

Two facts that file exists to hold, neither guessable:
1. **A preset carries geometry for EVERY layer slot, allocated or not.** S1's
   preset A has layer 2 on `LIVE_3` at full screen and layer 2 does not exist.
   The preset says *where*; `screenList/items/<id>/layerList/items/<n>/status/pp/
   capability !== 'OFF'` says *whether*. Drawing the preset alone covers every
   screen in stale full-frame layers, all plausible, none on air.
2. **Which bank is live comes from the transition end, not a flag.**
   `screenAuxGroupList/…/status/pp/transition === 'AT_UP'` ⇒ `control/pp/presetUp`
   is PGM and `presetDown` is PRW; `AT_DOWN` is the reverse.

Other store facts banked: canvas size is
`screenList/items/<id>/status/size/pp/{sizeH,sizeV}`; layer geometry is
`position/pp/{anchor,posH,posV,sizeH,sizeV}` where anchor names read
`<VERTICAL>_<HORIZONTAL>`; opacity is **0-256**, not 0-255. Snapshots come off
**one clock** for the whole window (cache-busted `?<epoch-ms>`, the vendor's own
trick) and stop while `document.hidden`.

Verified on Simulator 6.2.73: PGM full-frame, PRW the 960x960 centred layer at
exactly 25%/5.5556%/50%/88.8889%, and `Recall Screen 1 Memory 3` typed in the
popout went out over the opener's socket, 1/1 write sent.

⚠️ **The Browser pane cannot open a real popup** — `window.open` navigates the
same tab, so the orphan page is what you get. Verify the popout by mounting it
into a same-origin iframe with `opener: window`, or use real Chrome.

### Still to do, in the user's order
Midra 4K / Alta 4K compatibility (see
[aw platform split nlc mng](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_aw_platform_split_nlc_mng.md) — harder than it looks), audio patching
in the console **and in mynah** (`Set Audio Patch HDMI1, ch1 to Dante 1`,
`Set Audio Mute Dante 1 thru 6`), then timeline timecode input and a QLab-style
pop-out cue editor. Macros are coming and the shelf is already there.

## Roadmap stages 2-4 built — 2026-08-22, 176 tests

All four of the user's items now exist. Commits `b769090` (platform), `fd99038`
(audio), `0209755` (timecode), `b8c8f8e` (timeline editor), plus `5dfd626`
(tab-strip fit). **Local only** beyond `ca5dfd9`, which a co-session pushed.

### Platform detection (`core/platform.js`)
See [aw platform split nlc mng](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_aw_platform_split_nlc_mng.md) for the split itself. In this repo:
capabilities are **probed, not tabulated** — a feature is offered when the part
of the store it writes to is present, so an unmet range gets the right answer
for the right reason. **Unknown ≠ unsupported**: everything is on offer until
the store lands, then `shell.remount()`/`tabs.remount()` take back what does
not apply. Verified live on all three sims.

⚠️ **Three UI facts about `mng-platform`, all fixed structurally:**
1. Sidebar module is `sidebar__c__…` vs `sidebar-module__c__…`; **every segment
   after `__c__` is identical**, so both are matched.
2. Its Preconfig flyout items are plain Semantic `<a class="item">` with
   **nothing hashed** — template falls back to the first anchor, active class
   to Semantic's `active`.
3. **`.aw-app` WRAPS a row on LivePremier and IS the row on Midra/Alta.**
   Counting its children picked the main content and the panel rendered at zero
   width — correct, and invisible. The row now comes from the sidebar's parent.
4. Still un-ported: the tab strip's pane-switcher test needs an `h5`, and
   mng puts the label straight in the anchor. Gated off there, so it does not
   bite yet.

### Audio patching — grammar is MYNAH's (`be4cf9e`), re-vendored here
`device/audio/control/deviceList/items/<frame>/`:
- **`rxList`** = SOURCES: `INPUT_<1-64>_CHANNEL_<1-8>` (**64 inputs, not 32**),
  `DANTE_<1-8>_CHANNEL_<1-8>`, `NONE`. One writable prop: `mute`.
- **`txList`** = DESTINATIONS: `OUTPUT_<1-24>`, `DANTE_<1-8>`, `MVW_<1-2>`,
  each `channelList` 1-8, props `source` / `mute` / `sine`.
- **A patch is ONE write**: the source's key into the destination's `source`.
  No crosspoint object.
- **Dante is a flat 1-64** in the grammar; the model divides into 8x8.
- ⚠️ Adding `Audio` lengthened **`Aux` from `Au` to `Aux`** — prefix
  abbreviation is a property of the whole table. Test pins it.
- ⚠️ **Fixed: a failed compile NEVER showed its reason.** The console read
  `compiled.error`; a failure is `{ok:false, errors:[{message}]}`.

### Timecode (`core/timecode.js`, `core/chase.js`, `ui/timecode-source.js`)
MTC over Web MIDI, LTC off an audio input (worklet taps samples, decoding on
the main thread — a worklet cannot import modules), and `POST /__lpp/timecode`
on the proxy with an SSE stream out.
- **MTC quarter-frames span TWO frames** — the reader adds 2 back or every cue
  lags permanently.
- **LTC transmits no rate**, only the drop-frame flag. Reader returns `null`.
- ⚠️ Three LTC bugs, all found by an encode→decode round trip: the short/long
  threshold must be **0.75** of a bit period (1.5 makes every bit a one and the
  decoder returns *silence*, not nonsense); frame extraction must keep looking
  after discarding a partial frame; frames must be drained **as they complete**
  or a big block loses whatever the ring buffer evicted.
- **The chase**: fires on the reading that CROSSES a cue; going back re-arms;
  **locating forward fires NOTHING it jumped over** (verified: 44 cues jumped,
  none fired); arming mid-show catches up.
- ⚠️ **The chase fires on ARRIVAL, not on a timer** — see
  [browser pane verification traps](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_browser_pane_verification_traps.md) for why (timers are throttled
  in background tabs, not just in the pane).

### Timeline editor popout (`/__lpp/timeline`)
QLab layout: list on top, inspector under. Drives the opener's CueStack live.
`bootPopout` in `ui/popout.js` is now shared by both popouts.
- ⚠️ **`Element.append(null)` writes the text "null"** — `h()` skips it, the
  DOM's own `append` does not.
- ⚠️ **It is `stack.toJSON()`, not `stack.save()`.** Getting it wrong threw
  after the model updated and before the repaint: right model, stale screen,
  silence.
- The inspector is NOT repainted on device traffic (caret); only its heading is
  patched in place.

### Running all three simulators at once
Edit `PORT` + the four `*_PORT` values in
`~/Library/Application Support/ANALOG WAY/<sim>/<session>/settings.ini`, copy to
`settings_0.ini`, then `cd <session dir> && <App>/…/AW_APP_SIMULATOR <ini>`.
**cwd MUST be the session dir** or it exits with two Qt warnings. Ports used
here: LivePremier 3000, Midra 3010, Alta 3020. Backups left as
`settings.ini.lpp-backup`.
