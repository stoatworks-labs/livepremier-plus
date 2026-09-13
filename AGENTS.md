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

**There is now an AWJ path in the server, and the old argument still stands.**
`server/awj.js` opens TCP 10606. Read this before touching it, because the
reason it is allowed is narrow.

The original argument was: the store is already mirrored and stays current from
the vendor socket, so **an AWJ reader would be a second source of truth for the
same VPU state**, and two sources that can disagree about what is on air is not
worth a faster first paint. Every word of that is about *reading state into the
mirror*, and it is still correct.

What was added is not that:

- **Nothing in it ever touches the store mirror.** A reply goes back to whoever
  asked and is then forgotten. The mirror still has exactly one source.
- **It holds no connection and subscribes to nothing.** One socket per
  exchange, opened and closed — the device allows five clients and counts them.
- **Both callers need something the mirror cannot give.** A typed
  `{"op":"get",…}` wants what the *device* says right now, in the protocol's own
  spelling; answering from the mirror would be answering a question about the
  device with our own opinion of it. And the OSC listener has to work with no
  browser open at all, which is the entire point of a show-control input.

If you are about to make it hold a connection open, subscribe to anything, or
write into the store mirror, the original argument applies to you and you have
to beat it.

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

### Four command languages, one command line

The Console takes Mynah, raw AWJ, raw Web RCS store JSON and OSC. All four come
out of `src/vendor/mynah-lang.mjs` — the same vendored build that has always
supplied the grammar — so this repo still states no grammar of its own. The
panel picks a route and nothing else.

Three things about it are load-bearing:

- **Detection is by shape, and the verdict is shown as you type.** A line read
  as the wrong language produces an error about a *character* rather than about
  a command, and an operator reads that as their own typo. The chip beside the
  feedback says what the line is being read as, before Enter, and the log keeps
  it on every row — the question "why did that not do what I meant" is usually
  asked about a line several commands back.
- **A language prefix must never collide with a Mynah keyword.** `STORE` was an
  alias for `JSON` upstream for one commit and turned every `Store Master 12`
  into a JSON parse error, silently. Mynah's `dialects.test.ts` pins it; the
  fix belongs there, not here.
- **Almost everything still rides the vendor's socket.** `Path` holds both
  spellings of one address, so a typed AWJ message converts to a store write
  and lands at the identical node. Only two cases take `POST /__lpp/awj`: the
  operator chose the real-socket transport, or the line contains a `get`, which
  the vendor socket cannot answer because it carries changes rather than
  answers.

⚠️ **`preview` and `program` need the device's take state.** The Console can
resolve them — the page has the store mirror, through `presetBanks()` in
`core/screens.js`. The OSC listener cannot, and refuses those addresses with
that reason rather than guessing. A layer move landing in whichever buffer
happened to be live is the exact failure being defended against. That asymmetry
is intended and is documented in `docs/OSC.md`.

### `docs/OSC.md` is generated — `npm run gen:osc-docs`

A published address space is a promise to somebody building a TouchOSC layout,
and they cannot check it short of trying every address at a switcher. So the
tables come from `oscDictionary(PARAMS)` — the same call the resolver uses —
and `test/osc.test.js` fails when the checked-in file stops matching. Edit the
prose in `tools/gen-osc-docs.mjs`; never edit the tables.

`src/core/osc-dictionary.js` is what widens the space: mynah ships the seven
layer parameters it can vouch for, and the control surface's `catalogue.json`
adds sixty-seven read off a real device. Regenerating that catalogue against
different firmware changes the document with nobody editing prose, which is the
point of the ids being structural.

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
  **pane switcher**: at least two anchors that carry words and have no `href`.
  That is the difference between "these tabs change what is shown here" and
  "these links go somewhere else", and it needs no class, route or label. The
  label is an `h5` on LivePremier and a bare text node on Midra — see the
  platform section.
- **Settings are in the Preconfig flyout** (`ui/settings-panel.js`), beneath the
  device's own System page, because Preconfig is where Web RCS files things
  about the installation as a whole. Two groups of them are real settings now —
  the console language pair and the OSC listener — and they are **server-side**
  (`src/core/settings.js`, `PUT /__lpp/settings`, one file in `~/.livepremier-plus`).
  Not `localStorage`, for two reasons that are not preferences: the OSC listener
  is a UDP socket in the server process, and the Console exists in two windows
  at once, so a per-page setting would have the tab and the popout disagreeing
  about which language the operator chose. They are also **not keyed by device**
  — re-pointing at a backup frame mid-show must not change the command language
  or close a port a lighting desk is sending to. `Shell` takes `submenuOf: '<vendor label>'`
  for this. The flyout's active class **cannot be lifted off a live element** the
  way the sidebar's can — it exists only while the operator is on a page inside
  the flyout, and they may never go to one — so it is read out of the vendor's
  own stylesheet (`classFromStylesheets`). A proxied page is same-origin, so
  `cssRules` is legible.
- **MIDI Mapping is anchored under Virtual RC400T**, not in the PLUS section.
  `Shell` entries take an optional `after: '<vendor label>'` for this. The
  anchor is matched on the visible **label**, because that is the only part of
  the sidebar markup the vendor has not hashed.
- **The VPU map and the memory banks stay in PLUS** — both are whole-device
  views, and everything else belongs to a part of the app that already exists.
  The banks earn it: master memories cover every screen at once, and the screen
  bank is one flat list of 1000 slots that any screen may recall from, so
  filing them per-screen would be filing them wrongly.

### Memories and layer properties (`ui/memories-panel.js`, `ui/properties-panel.js`)

Web RCS has a Memories tab and a Properties tab already, and these do not
replace them. They exist because **a vendor pane cannot be popped out.** `#root`
carries `__reactContainer$…` / `__reactEvents$…`: React 17+ delegation, with
every listener bound to that one container. Move the pane's DOM into a second
window and React keeps *updating* it — it holds node references and does not
care which document they are in — but every click dies, because the native
event bubbles to the popout's document and never reaches `#root`. Their `AwTab`
is `renderActiveOnly` too, so the pane is unmounted the moment you switch tabs.
Do not spend another afternoon looking for a way round this; there isn't one
that does not mean patching React internals.

So the banks and the properties are read from the mirror instead:

- **`core/memories.js`** covers all the banks — three on either platform, not
  the same three (Midra has an aux bank and no layer bank). They are not
  variations on one idea — what separates them is what a recall has to *name*:
  master names only a slot, screen names a destination too, layer names a
  destination and a layer. The set and the spellings come from `core/dialect.js`.
  ⚠️ **A save is not the mirror image of a recall.** On recall the slot comes
  first (`…/load/slotList/items/<n>/screenList/…`); on save it comes **last**
  (`…/save/screenList/items/S1/presetList/items/PROGRAM/slotList/items/<n>/…`).
  Assuming symmetry produces a path the device accepts into nowhere: a write
  that reports success and saves nothing.
- **`core/properties.js`** renders nothing by hand. The sections, types, ranges
  and enum members all come out of `vendor/surface/catalogue.json`, which the
  MIDI mapper already generated from a device's own bundle — 67 layer
  parameters in twelve groups. Regenerate the catalogue and the panel grows the
  new properties on its own.

⚠️ **Layer selection is not device state.** There is no `isSelected` anywhere in
the store and nothing in the catalogue; the vendor's Properties tab follows a
React selection we cannot read. So ours makes you name a destination, a buffer
and a layer. That is also why the tab is called **Layer** and not Properties —
two tabs with one name in the same strip is worse than a name that is only most
of the truth.

⚠️ **You address a LETTER, never PROGRAM or PREVIEW**, and which letter is on
air changes on every take. `bankLetter()` is the only sanctioned conversion; it
reports `settled: false` mid-take and the panel **refuses the write** rather
than guessing, because the wrong choice during a transition lands on the
output. A buffer that is on air gets a red banner saying so.

### The popped-out panels (`ui/popout.js`, `server/*.html`)

There are four: `/__lpp/console`, `/__lpp/timeline`, `/__lpp/memories` and
`/__lpp/properties`. Each is a document of **ours**, served from this process
rather than proxied, opened by a Pop out button on the panel it belongs to.
Adding one is four edits — the document, a `mount…Popout` export, the proxy
route and the button — and forgetting the route fails as a blank window rather
than as anything anyone would notice, so `test/proxy.test.js` pins the list.

Two things about all of them are load-bearing:

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

## There are two platforms, and the panels now speak both

Read off the simulators' own `webapp-bundle/bundle.json` and confirmed against
their running stores on 2026-08-22, then against a live Pulse 4K and all six
mng-platform models on 2026-09-12 — and, on the evening of the 12th, **written
to that Pulse 4K** by the field-test harness (39 checks, none failed) and, the
next morning, by the Console panel itself at the operator's keyboard. The
mng-platform port is hardware-proven for takes, memories, layer properties,
the multiviewer bank and pitch; `docs/NOTES.md` (2026-09-12/13) has the run.

| range | platform | bundle | firmware | identity lives at |
|---|---|---|---|---|
| LivePremier (Aquilon) | `nlc-platform` | 6.2.1 | 6.2.73 | `system/deviceList/items/<1-4>/pp` |
| Midra 4K (QuickVu, Pulse, Eikos, QuickMatrix) | `mng-platform` | 3.2.6 / 3.3.x | 3.2.29 / 3.3.10 | `system/pp` |
| Alta 4K (Zenith 100, Zenith 200) | `mng-platform` | 1.3.1 | 1.3.7 | `system/pp` |

**Midra 4K and Alta 4K are the same platform as each other**, on different
version lines, and a different platform from LivePremier. `platformId` 1536 is
Midra 4K and 1552 is Alta 4K; `dev` names the box (`PULSE`, `QVU`, `EIKOS`,
`QMX`, `ZEN100`, `ZEN200` — the simulators' own enum, in that order).

**What carries over:** the whole proxy, the hook, the store mirror and the
panel-mounting machinery. All three serve the same Web RCS architecture, the
same `GET /api/stores/device`, the same socket and AWJ on 10606.

**What does not:** the object model. `screenAuxGroupList`, `presetBank`,
`masterPresetBank` and `vpuMixerList` do not exist on `mng-platform` at all.
Screens are `1`..`4`, not `S1`..`S24`. Transitions live in a top-level
`transition` node with one `takeTime` rather than the `takeUpTime` /
`takeDownTime` pair. Memories live under `preset/bank` (screens, 200),
`preset/auxBank` (auxes, 200 — a bank of its own) and `preset/masterBank`
(50); there is no layer bank. The preset buffers are literally `UP` and
`DOWN`, not lettered.

### `core/dialect.js` — one interface, two spellings

Every path a panel reads or writes goes through the store's **dialect**, chosen
by which tree the store contains (`screenAuxGroupList` → `NLC`,
`transition/screenList` → `MNG`, neither → `null`, and `null` builds no
command). The `nlc` half reproduces `core/paths.js` and the old memory paths
byte for byte — the tests pin it — so nothing verified on the Aquilon moved.
`core/commands.js` is the `CMD` table over a dialect; the cue stack asks for it
at fire time, because the store is empty at boot and can be re-pointed mid-show.

**The identifiers do not change; only the paths do.** A destination is `S1` /
`A1` everywhere above the dialect, on both families. `S1` on a Midra means
"screen 1" and never appears on the wire — screen 1 and aux 1 are both keyed
`1` in their own lists there, which is exactly why the kind lives in the
identifier. Cue stacks, pickers and the console keep one spelling.

Four things about the mng half are load-bearing, each read off a device or the
vendor's own bundle rather than inferred:

- **Which of `UP`/`DOWN` is program is the transition suffix.** The vendor's
  bundle resolves `PROGRAM` to `UP` for `AT_UP` / `EFFECT_FROM_UP` /
  `COPY_FROM_UP` and `DOWN` otherwise; `PREVIEW` is the opposite. Confirmed by
  behaviour on the simulator: a recall to PROGRAM on an `AT_DOWN` screen landed
  in `DOWN`, one to PREVIEW landed in `UP`. Same suffix rule as the nlc letters.
- **"In service" is the applied preconfig**,
  `preconfig/status/stateList/items/CURRENT/screenList/items/<n>/pp/enable`
  and `.../auxiliaryScreenList/items/<n>/pp/mode !== 'DISABLE'` — never
  `preconfig/control`, which is what the operator has *staged*. Every Midra
  and Alta reports four screens and four auxes whether or not any has an
  output; a QuickVu has one screen valid, a Zenith 200 four screens and four
  auxes, and the difference between the models is entirely in this state.
- **Fitted layers are gated the same way**: eight slots on every screen, and
  `.../CURRENT/screenList/items/<n>/liveLayerList/items/<k>/pp/mode` reads
  `DISABLE` for the ones with no scaler. The preset carries geometry for all
  eight regardless — the same trap `core/screens.js` describes for nlc.
- **A recall overwrites `takeTime`** with the memory's `transitionDuration`,
  exactly as a LivePremier recall overwrites `takeUpTime`. The cue engine's
  recall → settle → fade → trigger order is therefore right on both.

### What is offered on `mng-platform`, and what is not

Probed per family in `core/platform.js`. On a Midra or Alta: the **Timeline**,
**Console** and **Layer** tabs, the **Memories** entry (screen, aux and master
banks) and **Pitch Compensation**. Withheld, each with its reason in the
table: **VPU Map** (no VPU) and **Audio patching** (no matrix of the
LivePremier shape). The MIDI Mapping entry anchors after a `Virtual RC400T`
label the mng sidebar does not have, so it does not mount there either — and
its engine (`vendor/surface/`) is still LivePremier's, so that is right for now.

**The Layer tab renders a second catalogue.** `vendor/surface/catalogue-mng.json`
was generated by awj-surface's `tools/gen-catalogue.mjs` from the live Pulse
4K's own bundle and store (3.3.10): 57 parameters in fourteen groups, none
inferred. The dialect carries the catalogue, the layer root (`liveLayerList`
under the buffer, screens only — an aux has no layers there) and the names of
the source properties; `core/properties.js` asks and renders. Nothing in the
panel names a parameter.

**Pitch on Midra** is the same trio under `canvas/pitch` instead of
`canvas/cmd`, and an output's screen is `usedOnScreen` in the applied
preconfig — for an output whose mode there is `SCREEN_FORMAT`, because a
disabled output still says `usedOnScreen: 1`. `dialect.pitch` holds both.

**The Console speaks Midra because mynah does.** mynah's language core has a
`platform` context — `LIVEPREMIER` or `MIDRA`, `src/lang/platforms.ts`
upstream — and `ui/console-panel.js` passes the one `core/dialect.js` names
(`mynahPlatform()` in `core/osc-dictionary.js` is the only place the two
namings meet). `test/vendor.test.js` pins that mynah's `MIDRA` and this repo's
`MNG` agree path for path, the same corroboration the LivePremier pair has.
The OSC listener in `server/osc.js` has no store, so it **asks the switcher**
which platform it is on the first packet — one AWJ exchange for the two
identity paths, remembered per host — and refuses to send until it has an
answer rather than assuming one. Midra's OSC parameter table is mynah's
vouched-for built-ins (`paramsFor()`), not the catalogue, which is
LivePremier's.

### The UI differences, which are smaller than they look

The `mng-platform` Web RCS spells its sidebar module `sidebar__c__…` where
LivePremier spells it `sidebar-module__c__…`. **Every segment after `__c__` is
identical.** `ui/shell.js` matches both.

Fixed structurally rather than by platform-sniffing:

- **The flyout items are not hashed on `mng-platform`** — they are plain
  Semantic UI `<a class="item">`. The template falls back to the first anchor
  in the list, and the active class falls back to Semantic's `active`.
- **`.aw-app` wraps a row on LivePremier and *is* the row on Midra and Alta.**
  Counting children of `.aw-app` therefore picked the main content instead of
  the row and appended the panel inside it at zero width — rendered, correct,
  and invisible. The row is now derived from the sidebar's parent.
- **The tab strip's labels are bare text nodes on mng**, not an `h5`: the same
  Semantic `Menu.Item`, given `content` as a string. A pane switcher is now
  "at least two anchors with words and no `href`" — two, because a one-tab
  strip is a heading (Midra's Preconfig page is a column of them), and words,
  because Midra's Sources strip is four icon-only anchors with no `href`
  either. Our label goes into an inline `span` there; an `h5` would render as
  a heading, larger than the vendor's and on its own line.
- **The sprites differ.** `gpio-18`, `hardware-18` and `mini-list-14` do not
  exist on mng; `icon()` takes a list of candidates and uses the first the
  page's sprite defines.

⚠️ Running the simulators: all three default to `PORT=3000` **and**
`AWJ_EXT_PORT=10606`, so only one runs at a time out of the box. Edit the port
block in **both** `settings.ini` and `settings_0.ini` (the engine reads one and
its web child the other), and launch the inner binary directly —
`cd <session dir> && <App>.app/Contents/MacOS/<RANGE>/bin/AW_APP_SIMULATOR.app/Contents/MacOS/AW_APP_SIMULATOR <session>/settings_0.ini`.
**The working directory has to be the session directory**; without it the
process starts and exits with only a couple of Qt warnings to show for it.
`DEVICE_TYPE` in the same file picks the model: `1` QVU, `2` PULSE, `3` EIKOS,
`4` QMX, `5` ZEN100, `6` ZEN200, in both the Midra and the Alta simulator. Run
a **copy** of the session directory per model; the engine writes into it.

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

OSC is still not possible **in the page** — there is no UDP anywhere in a
browser, by any route, and serving from loopback does nothing about that. So it
went where it always had to: `server/osc.js`, in this process. It is off by
default, binds loopback unless told otherwise, and writes to the switcher over
AWJ rather than through a tab, because a cue fires at 20:03 whether or not
anybody has a Web RCS open.

Its address space is the dictionary the MIDI mapping already needed — a fader
is bound to a screen, a preset, a layer and a parameter, and that four-part
address is the same thing whether it arrives as a control change or as a
packet. `docs/OSC.md` publishes it and is **generated**; see below.

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
- **A Midra take with *preset toggle* off settles late.** The device passes
  `EFFECT_FROM_x` and then `COPY_FROM_x` before `AT_y`, so fire → settled is
  takeTime + ~250 ms on real hardware (the simulator, toggle on, sends only
  `EFFECT_` and lands on time). Wait for the `AT_` state, never for the clock.
- **A Midra multiviewer recall touches widgets the model does not have.**
  Recalling a layout re-syncs `widgetList/items/17..27/control/pp/size*` to
  their status on a Pulse 4K (`widgetValidity` is 1–16). Invisible, and not a
  fault of ours — but a store diff after a recall will show it.
- **Never re-recall an operator's modified preview to tidy a header.** A buffer
  whose `isModified` is true holds unsaved work; restoring it means saving it
  to a spare slot and recalling that, not recalling its `memoryId`. The header
  then reads `M --`, which is the honest price.

## Testing

`npm test` — 270 tests, no network, no browser. Seven run against a real Aquilon
C capture (`aquilon-c-live-resources.json`, read 2026-08-21) and are the only
coverage of fitted mixers, output links and Optimized mode, none of which a
simulator produces. `test/dialect.test.js` runs both object models against real
stores — the Aquilon's memories capture and `midra-3.2.29-pulse4k.json`, cut
from the Midra 4K simulator after the writes it asserts had been made through
the mng dialect's own paths, so every mng path in it is one a switcher accepted.

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

## Notes

`docs/NOTES.md` carries this repo's working notes — current status, decisions
already made, and the traps that have actually bitten. Read it before changing
anything non-obvious. Cross-cutting fleet knowledge lives in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).
