# AGENTS.md — LivePremier Plus

Orientation for an LLM or a newcomer picking this up cold. [README.md](README.md)
is the *what*; this is the *why* and the traps.

## The one-paragraph version

A local reverse proxy that adds panels to Analog Way's own Web RCS — on a
LivePremier, and on a Midra 4K or Alta 4K for the panels that platform can
carry: a programmer that saves memories without touching a bus, a VPU resource
map, a command line, a theatre-style cue stack, the memory banks and layer
properties in windows of their own, layer groups, routing through external
matrices, a Bitfocus Companion mounted on the same origin, and the rest the
README lists. You point it at a switcher and browse to it instead of to the
device. It does not replace the vendor UI and does not ship a theme — it borrows
the vendor's stylesheet — and **everything it shows comes off the vendor's own
socket**. The server opens AWJ itself only for one-shot exchanges (OSC input,
the Pixelhue panel, a typed AWJ line, the memory import) and never to mirror
state; "Why a proxy" below says why that line is the one that matters.

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
only a new `transports/` module. Keep device I/O out of `core/`. A plugin
keeps the same rule inside its own folder: the file both its halves import
(`plugins/companion/core.js`) has no I/O either.

## Plugins: what the app is made of

Every feature is a **plugin**, described once in `src/core/plugins.js`,
switchable in Preconfig ▸ LivePremier Plus → Plugins, and living in
`plugins/<id>/` with a server half and/or a page half, loaded by
`server/plugin-host.js` and `src/ui/plugin-host.js` exactly as a plugin written
elsewhere is ([docs/PLUGINS.md](docs/PLUGINS.md)). **None is wired in by hand
any more**: `src/main.js` is the shell, the tab strip, the settings page and the
plugin loader, and `server/proxy.js` the relay, the setup page, settings,
`/awj`, `/addresses` and the plugin host. A new feature is a new folder in
`plugins/`, not an edit to either.

A built-in may import `src/` directly, and shared engines and components stay
in `src/` where every plugin can reach them (`core/vpu.js`, `core/patch.js`,
`ui/stage.js`, `ui/properties-panel.js` — the Layer tab and the Edit page both
draw it — and the vendored models). **Never import another plugin's folder**:
its files are only served while it is on, and one switched off would take the
importer down with it. Share through a service instead. A plugin's card on the
settings page is `ctx.ui.settingsSection` — Pixelhue's is the example. A panel
that pops out does it into a page in its own folder (`popout.html`, served by
the host) that boots through `ui/popout.js` — Memories' is the whole of one.

**Features extend each other through `core/contributions.js`, never by
name.** The cue engine had Matrix Routing's two actions in its switch, the
Console intercepted `/lp/matrix/` by hand, and the OSC server took a hook only
the router could use — three special cases no other plugin could have. Now the
engine asks for a `cueAction` by kind, the OSC server and the Console for an
`oscAddress` by prefix, the setup file for each `configSection`, and Matrix
Routing contributes all three from its own folder, exactly as anybody's plugin
would. Do not put a feature's name back into
`cuestack.js`, `osc.js` or the Console's `panel.js`: if a feature needs a new kind of
hook, add a point to `POINTS`, with the rules that stop one plugin taking
another's — or the switcher's — over. Shared state goes the same way:
`provide`/`use`, the cue stack being `use('stack')`.

What the hosts own, so a plugin does not have to: routes under
`/__lpp/<id>/…`, server-sent streams, relayed sockets, and disposal of all of
it when the plugin is switched off — live, with no restart, on the server; on
the next load in the page. A plugin that throws while starting is marked failed
and says why on its settings row; nothing else goes down with it.

The things about it that break quietly:

- **Importing a server half must do nothing.** The host imports every hosted
  plugin at startup, switched on or not, to read its settings schema.
  Everything with an effect belongs in `activate(ctx)`.
- **A plugin's settings live in `plugins.<id>.settings`, never at the top
  level.** Companion's three fields used to be top-level, and so did the Edit
  page's and OSC input's; each schema's `legacy` list lifts them wherever they
  still appear (an old `settings.json`, an old setup file, a caller sending
  the old shape), and a lifted value wins. A settings save merges `plugins`
  one level deeper, so a switch never wipes a plugin's settings, and the host
  tells a running plugin about a change only when its own schema's `changed`
  says so — or a Companion address change would rebind the OSC socket.
- **`plugins/` must be in every package.** The app runs without a missing
  plugin — right for a user's folder, wrong for a release — so a Dockerfile or
  `launcher/scripts/prepare.sh` without it ships features quietly absent.
  `test/packaging.test.js` reads both.
- **A panel with an iframe renders in place.** See the invariant below.
- **The page loads plugins from `/__lpp/plugins`, not from the manifest
  table**, so what it shows is what the server actually started.
- **A user plugin's code never runs before it is switched on.** User plugins
  (`<data dir>/plugins/<id>/`, validated by `validateManifest`) are found at
  startup but imported only in `startPlugin`. Their settings schema therefore
  arrives late: the proxy re-normalises after every `host.sync`, and the host
  judges "changed" on schema-read settings, so the defaults that fill in are
  not a change. Do not "simplify" discovery into importing — a test counts
  imports.
- **A plugin may ask for a repaint before the sidebar exists.** A page half
  that loads its data as it starts repaints when the data lands, which can be
  while later plugins are still loading — so `main.js` declares `shell` and
  `tabs` before `refresh` and skips a repaint until both are built. With them
  as `const` further down, that repaint was a ReferenceError; found when Layer
  Groups moved.
- **A built-in's `ctx.storage` writes the files the app always wrote.**
  `names-<switcher>.json` beside the stacks, keyed by `safeDeviceKey` from
  `server/storage.js` — the same function `StackStore` uses — so moving a
  feature into a plugin moves nothing on disk, an older build still reads it,
  and `server/config-file.js` finds it where it always did. The per-switcher
  `{ data }` route three features share is `server/documents.js`. A user plugin's
  documents go in `<data dir>/plugin-data/<id>/`, never its code folder, which
  the page is served from.
- **`examples/plugins/hello-switcher` is tested as a user plugin**, unchanged,
  through the host and through a real data directory. If the API moves, the
  example moves with it, or the suite says so.
- **A cue action is not awaited, and runs ahead of the take.** A contributed
  `run` goes out with the recalls; the take is deferred behind them. Awaiting
  it would let one slow router hold a take hostage, and it is the reason
  routing before a take works at all. A cue naming a kind nobody handles
  keeps the action and warns when it fires — never drop it, it is somebody's
  show file.

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

## Arithmetic in vendor fields (`plugins/arithmetic/math-fields.js`)

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

### External matrix routing (`plugins/matrix-routing/routers/`, `core/patch.js`)

The only subsystem here that talks to something other than the switcher, and
the reasoning that makes that allowed is narrow — read it before extending.

**It holds connections open, and `server/awj.js` forbids exactly that.** That
prohibition is about the *store mirror*: an AWJ reader would be a second source
of truth for state the vendor socket already carries. None of it applies to a
router, because a router is not in the store at all. There is no mirror to
contradict, nothing else in this process or the page knows what a Videohub is
routing, and its crosspoints change without us — a poll-on-demand grid would be
right when the panel opened and wrong thereafter. The five-client budget
`awj.js` respects is a limit on the Analog Way frame, not on a Videohub.

Four things are load-bearing:

- **The direction inverts.** A switcher input hangs off a router OUTPUT; a
  switcher output arrives at a router INPUT. An entry stores the switcher side
  only and derives the router side, because a stored direction is a stored
  opportunity to disagree with the side it belongs to.
- ⚠️ **Everything counts from 1 except the Videohub wire, which counts from 0.**
  `plugins/matrix-routing/routers/videohub.js` is the only file that knows this, and the
  conversion is in two marked places — the same containment `core/paths.js`
  gives the AWJ spelling. Getting it wrong routes a real crosspoint one off
  from the one asked for and looks plausible doing it.
- **No driver writes its own state.** `route()` sends and returns; every field
  comes from what the router said. A Videohub answers a refused route with ACK
  and the unchanged routing, so a refusal is indistinguishable from a command
  that never arrived except that the state does not move.
- **A send adds and never takes away.** A router output always shows
  *something*, so "removing" a destination would mean choosing a different
  source for it, and there is no answer to which.
- **A placeholder is the one driver that writes its own state** — there is no
  router to ask, so it *is* the router. It is a size and a table, never a
  protocol emulator. Its **plan** is only the crosspoints taken on it (never the
  factory N-from-N table, which would overwrite every output on the real
  frame). Going live keeps the router id, so the patch carries over; nothing is
  sent on connect, and Push plan sends only what differs and names what does
  not fit. A save that omits `model`/`inputs`/`outputs`/`plan` keeps the held
  ones (`keepPlanning` in the plugin's server) — the panel saves from
  `describe()`, which does not carry them.

⚠️ **The OSC addresses are ours, not mynah's** — the one exception to "this repo
states no grammar of its own". Mynah is the single statement of the
*switcher's* grammar; a router in front of it is not the switcher. They live in
`core/patch.js`, and the Console posts them to the launcher rather than
resolving them in the page, so the typed and the UDP paths cannot drift.

⚠️ **The Lightware and Turtle AV drivers have never spoken to hardware.** They
are written from vendor documentation, their command strings are collected in
one table per file so a correction is one edit, and they parse defensively
because that is an admission of uncertainty rather than belt and braces. The
LW3 half is polled *as well as* subscribed for the same reason. `docs/MATRIX.md`
has a procedure for proving each on real kit.

**The Router tab and box (`plugins/matrix-routing/router-box.js`) write into vendor pages**, so
they carry the same fragility as `plugins/layer-names/labels.js`: Setup ▸ Inputs/Outputs
detail pages get a tab on their **routed** strip (every anchor has an `href`,
which is why `ui/tabs.js` never claims it), and Preconfig ▸ Inputs/Outputs get
a box in the column headed `In5` / `Out5`. Which socket a page is about comes
from the URL or that heading only — `connectorForPage` is the one place, and a
page it cannot place gets nothing. The port model both the grid and the list
draw from is `choicesFor` in `core/patch.js`, so the two cannot disagree.
`routerBoxes.describe()` on `window.__WRU` reports what was found.

⚠️ **Inputs and outputs are keyed differently in the same store** — `IN_5` and
`5`, with `physical` spelled `IN_9` and `5` — and `IN_1` names both logical
input 1 and the first input card depending on the field. `core/connectors.js`
absorbs it; nothing above it should learn it. `slot` repeats within a card, so
(card, slot) is never an identity — `physical` is.

### HyperDecks (`plugins/hyperdeck/`) — never met a real deck

Blackmagic HyperDecks and anything that answers their TCP 9993 protocol; Mitti is the reference,
both as a deck (its HyperDeck emulation: plays, never records — a *profile*, not a special case)
and as the rule set (its ATEM integration: play on program; pause, rewind or next when taken off;
take or cut at a clip's end). `docs/HYPERDECK.md` is the design and the proving procedure.

- **The rules run in the page, not the server**, because the page has the store and the server
  must not grow a mirror. One page holds a lease (`POST /__lpp/hyperdeck/runner`, the Pixelhue
  panel's pattern); a page that takes the lease primes `prev` and acts only on later changes, so a
  reload never plays a deck already on air. Do not "fix" this by subscribing on the server
  without beating `awj.js`'s argument in writing.
- **On air includes the arriving buffer while a transition is unsettled** (`airState` in
  `core.js`), so a deck rolls as the take starts.
- **A clip end is inferred**: the transport stopping by itself, or the clip id moving on while
  playing — unless we sent a stop or goto in the last 1.5 s (`lastOurs` in `link.js`). The lead
  time is the page's, off the streamed countdown; both paths fire once per `run`.
- `tools/hyperdeck-sim.mjs` is the only deck anything here has spoken to.

### A Pixelhue console (`plugins/pixelhue/`) — **preview**

A U-series event controller driving the switcher. The whole subsystem turns on
one observation, and everything else follows from it: **a console is not a
keyboard.** It is a peer that already knows what a screen, a layer, a source
and a memory are, and its control service speaks a protocol about those things.
So this publishes a *model* and answers *intents*, and has no key map at all.

```text
  data-change  →  {screens, layers, inputs, presets}   the console labels,
                                                       lights and pages itself
  tag 0x00101307  ←  {command: 300, payload:{id: 2}}   what the operator meant
```

The identity round-trips: a screen published as `uid: "S1"` comes back as
`uid: "S1"`. That is why there is nothing here to keep in step with a firmware,
and why `vendor/surface/`'s binding engine — right for a MIDI controller — is
the wrong shape for this.

⚠️ **It has never been run against a console.** It was built from the firmware
and proved against a real UCenter running headless in a VM, which is enough to
pin the protocol and not enough to pin the hardware. It is off by default, the
settings page says preview in as many words, and `docs/PIXELHUE.md` lists what
is unverified.

Four things are load-bearing:

- ⚠️ **`index` is the key position and it is 1-based.** Publishing from zero
  silently drops the first object of every bus — no error, no complaint, a
  panel one short. `test/pixelhue.test.js` pins it.
- **It holds a socket to the console and nothing open on the switcher.**
  `plugins/pixelhue/ucenter.js` argues the first half (a console is not in the
  store; there is no mirror to contradict and no tab to depend on);
  `plugins/pixelhue/supervisor.js` argues the second (a burst of `exchange()` gets,
  closed, because `awj.js`'s rule does not need beating for this). The price is
  no live tally, and it is written down rather than hidden.
- ⚠️ **A recall lands in preview, always**, whatever the panel's PGM EDIT is
  doing — the same choice every other recall path here makes. And a source
  change is **refused** when the preset letter cannot be read, exactly as
  `server/osc.js` refuses `preview`/`program`.
- **The codec is vendored, not written here.** `src/vendor/pixelhue/` is
  pixelhue-bridge's `core/`, and its `tags.js` still describes tag
  `0x00101307` as business data — it is the *command* report, and the
  correction belongs upstream rather than in a vendored file.

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

### Memories and layer properties (`plugins/memories/panel.js`, `ui/properties-panel.js`)

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

### Layer groups and the send-to menu (`core/groups.js`, `plugins/layer-groups/`, `plugins/send-to/`, `ui/preset-lock.js`)

A group is several layers — one screen or many — driven as one, kept per
device beside the cue stack. Two halves, and only one of them writes on its
own: `sourceCommands()` fans a source out when a caller asks, and
`createGang()` *follows*, writing the rest of a group into line when any
member changes by any route. The gang is **the only thing in this app that
puts a write on the wire without an operator having asked for that write
specifically**, so read `core/groups.js`'s head before changing it.

⚠️ **You gang a ROLE, not a letter.** Two screens are routinely on opposite
letters — S1 at `AT_UP` has program B while S2 at `AT_DOWN` has program A — so
a change seen in one screen's letter is turned back into program-or-preview
through `presetBanks()` and re-resolved per target. Copying letter to letter
puts a preview edit on air on half the screens. LivePremier's third buffer
(`presetPrevious`, C) is neither role and propagates nothing.

⚠️ **Three separate things stop it looping**, and they are not
interchangeable — the comment in `core/groups.js` says which case each closes.
The echo-suppression map is the one that is easy to think redundant: a fan-out
to three members produces a *second* round off its own first echo without it,
because that echo lands while the other members are still stale in the mirror.
`the echo of a fan-out produces no second round` failed before it existed.

⚠️ **The gang never fires on state it merely found.** `Session` replays the
frames buffered during hydration without dispatching them, so a page opening
onto a desk already out of step does not rewrite it. Opening a browser tab is
not an instruction to the switcher.

⚠️ **A layer belongs to at most one group**, imposed by `normalise()` on the
way in and out. Two ganged groups sharing a member is the one shape that could
still ping-pong, so it cannot be stored even by editing the file by hand.

**The `…` on a source card is cloned from the vendor's own `⋮`**, wrapper and
all — same reasoning as `ui/shell.js`'s sidebar entries, and the wrapper is
what makes it appear on hover. The glyph is swapped to `more-horizontal-12` so
the two are distinguishable. ⚠️ **A card does not say which source it is**: no
data attribute, no id, and the visible number is a position. What it has is a
picture, and `/api/device/snapshots/inputs/3` *is* `LIVE_3` — `dialect.
sourceFromSnapshot()` is that mapping read backwards, and a card it cannot
name gets no button, which is why the background-sets tab has none.

⚠️ **The PGM padlock is not device state.** The whole store was searched on
2026-09-21: the only `lock` keys are `frontPanel/pp/lock` and the ST2110 PTP
`isLocked`. `localStorage` is empty too. It is React state in the vendor
bundle, which means a socket write ignores it and that respecting it is a
choice — and that it can only be read where it is drawn. `ui/preset-lock.js`
falls back card → master pair → **locked**, because a screen whose card is not
on screen is the one case that cannot be checked and so must be the one that
asks.

### Layer Lock and partial takes (`core/layer-lock.js`, `plugins/layer-lock/`, the hook's gate)

The switcher has **no per-layer take and no layer lock** — searched for in
the 6.2.73 store and the vendor bundle on 2026-09-23. A take swaps whole
buffers. Each preset layer has a `transition` node (opening/closing effect,
flags `FORCE_TRANSITION` "avoid cross transition", `FORCE_CROSS`,
`DEPTH_CUT_*`), which chooses *how* a layer changes, never *whether*.
`xCopyProgramToPreview` exists but is whole-screen.

Both features stand on one fact: **a layer identical in program and preview
has nothing to transition.** Lock = keep preview equal to program; take only
= make every other layer equal, take, put their preview looks back.

The device's own verdict is `…/layerList/items/<k>/status/pp/up|down` —
`OFF`/`OPEN`/`CLOSE`/`CROSS`/`FLYING`/… ("Layer will do a … transition", the
vendor's comment). A real Aquilon C capture read `CROSS` for LIVE_2 vs LIVE_8
at the same geometry and `OFF` for NONE in both. ⚠️ **The simulator reports
`OFF` for every layer always**, so it cannot confirm a lock; and **no real frame
has been asked about a locked layer with a live source.** Which of up/down is
"next" is inferred (AT_DOWN → up) and unconfirmed.

Four things are load-bearing:

- ⚠️ **The hook now has an outbound gate, and it is the only thing in this app
  between the vendor's UI and its socket.** `hook.setGate(fn)`: `fn(raw,
  release)` returning true holds the frame; the hook sends it itself after
  750 ms whatever the gate does, sends at most once, and a throwing gate lets
  the frame straight through. That cap lives in `ws-hook.js`, not the plugin,
  on purpose — a plugin bug may delay a TAKE, never swallow one. The lock
  engine holds only a take on a destination whose locked layers are out of
  line; an in-line take is untouched. There is one gate, not a list; a second
  user needs a design, not a second `setGate`.
- ⚠️ **Echoes are matched on path AND value.** Found on the simulator: a
  recall writes preview L1, the lock writes the same path back, and the
  recall's echo arrives first — path-only matching released the TAKE before
  the lock's write was acknowledged. The switcher echoes a write in ~3.5 ms.
- **A second TAKE while one is held queues behind it** — with the fix already
  mirrored it would find nothing to hold, go first, and the held one would
  take twice.
- **The follower is the gang's cousin and keeps its rules**: role not letter,
  nothing mid-take, only on live frames (never on found state — except when a
  lock is *set*, which is the operator asking), and convergent because only
  differing properties are written.

⚠️ **Only takes leaving this page are gated.** Front panel, T-bar (a stream
of positions — there is no honest moment to hold one), `server/osc.js`'s AWJ
take, Companion speaking AWJ, another browser. The panel says so on every
render. Proven on the simulator only (2026-09-23): lock + follower, a
recall-and-vendor-TAKE in one tick, take-only on one and on two screens.

### The popped-out panels (`ui/popout.js`, each plugin's `popout.html`)

There are four — the Console's, the Timeline's cue editor, Memories' and
Layer's — each `popout.html` in its plugin's folder
(`/__lpp/plugins/<id>/popout.html`, served by the plugin host while the plugin
is on). A popout that needs more of its plugin than a service offers gets it
through `ctx.share`: the cue editor rewrites the stack, so the Timeline shares
the stack itself, and `bootPopout({ plugin: 'timeline' })` hands it over as
`own` — or says the feature is not running, if the tab it came from has no
such plugin. Each is a document of **ours**, served from this process rather
than proxied, opened by a
Pop out button on the panel it belongs to — which opens
`new URL('./popout.html', import.meta.url)`, so the page and the button cannot
disagree about where it is. A missing page fails as a blank window rather than
as anything anyone would notice, so `test/proxy.test.js` pins the list.

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

### The Edit page (`plugins/edit/`), and the two things that decide its whole shape

The Edit page is the Screens / Aux. layout with one row instead of two: a
programmer buffer per destination that is on neither bus. Two device facts
decide everything about how it is built, and both were measured on a
LivePremier Simulator 6.2.73 on 2026-09-22 rather than reasoned about.

**A screen really does have three preset buffers, and C is not the answer.**
`presetList` carries `A`, `B` and `C`, each a full 129-slot layer tree, and
only two of them are program and preview at any moment. C is `presetPrevious`.
It fails on two independent counts:

- **You cannot save a memory from it.** `presetBank/control/save/screenList/
  items/S1/presetList/items/` has exactly `PROGRAM` and `PREVIEW`. An AWJ `get`
  of the same path spelled with `C` returns **no reply at all** — the same
  answer a deliberately bogus path gives, against `false` for the two real
  ones. A look built in C could never become a memory.
- **Every TAKE clobbers it**, because that is what step-back steps back to.

So the programmer is ours: `core/programmer.js`, a session-shaped overlay whose
buffer key is `EDIT`. It is small only because two things were already true —
every panel drives a session through exactly `{store, send}`, and a layer
property is addressed by an **opaque buffer key** that `bankLetter()` already
passed literals through. The Layer panel, the stage composer and the send-to
machinery therefore drive it with no changes to any of them. Reads inside the
buffer are answered locally; everything else falls through to the live mirror,
so the programmer is never stale about the desk it is programming.

**The memory bank has an export and an import, and the file is plain JSON.**
This is the part nothing else in the ecosystem seems to know about: Web RCS
6.2.73 exposes no memory import in its UI at all, and the protocol guide does
not mention the facility.

```text
presetBank/export/cmd/pp/{selection[1000], path, xRequest}   path is a DIRECTORY
presetBank/export/status/pp/{fileName, status}               fileName is Preset.json
presetBank/import/extract/cmd/pp/{path, xRequest}            path is a FILE
presetBank/import/load/$bank/@items/<n>/pp/{isValid, label, orgIndex, dstIndex}
presetBank/import/load/cmd/pp/xRequest
```

A memory is `{BankSlot, Layer: {"0": {...}}, xPEMEM_BANK_*}`, **NATIVE is layer
`0`**, and the two filters say what the memory *contains* — one saved with
`["SOURCE","POS"]` carries twelve fields per layer where all fourteen
categories carry seventy-two. Sixty-six of those seventy-two are the
catalogue's own writable parameters under different names;
`core/preset-file.js` holds the table and `test/preset-file.test.js` proves it
against a memory exported beside the live preset node it was saved from —
198 pairs, 95 on a non-default value, none disagreeing.

⚠️ **Only `presetBank` has it.** `masterPresetBank`, `layerBank`, `keyerBank`
and `monitoringBank` carry only `control` and `bankList`, and no bank on
Midra 4K or Alta 4K has it either.

⚠️ **And the path is the device's, not ours.** `extract/cmd/pp/path` is
resolved on the machine running the device software. On a simulator that is
this machine, which is the whole reason the direct save works there; on a real
Aquilon it is the switcher's own disk and **how to put a file there is not
established**. That is why `core/save-look.js` builds the preview route as
well — write the look into preview, fire the ordinary save, put preview back
property-for-property — and why the directory is a setting. If you are about
to delete the preview route as redundant, it is the only route on Midra and
Alta and the only one proven to work on a box.

### Companion, mounted inside us, and the five things that make it honest

A Bitfocus Companion is served at `/__lpp/companion/ui` on our own origin, and a
PLUS ▸ Companion panel manages the show beside it, draws its buttons natively,
and holds the memory triggers. It is a hosted plugin, `plugins/companion/`:
`server.js` wires it into the host (and owns `/press` and `/triggers`), `link.js`
is the supervised link and the mount, `core.js` the no-I/O half both sides share,
`surface.js` the page's own tRPC socket and the button grid, `client.js` the
cue action and the recall watcher, and `panel.js` the page. The reasoning is in
the heads of `link.js`, `core.js` and `surface.js`; these are the parts that
break quietly if "simplified".

- **The prefix is stripped, not forwarded.** Companion (4.1+) serves under a
  sub-path by rewriting a `/ROOT_URL_HERE` token according to a
  `companion-custom-prefix` request header — but its own routes match the
  *unprefixed* path and its WebSocket server matches `/trpc` exactly. Forward
  the mounted path verbatim and the socket opens and then says nothing, with no
  error at either end.
- **The cross-origin check is moved, never removed.** Companion refuses a
  cross-origin upgrade to stop Cross-Site WebSocket Hijacking, and a WebSocket
  gets no CORS preflight, so that check is the only thing between a loopback
  Companion and any page the operator has open. Mounted under us, Origin is us
  and Host is Companion, so everything is refused. **Do not overwrite Origin in
  the relay** — it works, and it hands every page on the internet a laundered
  route to the operator's Companion. We make the comparison ourselves (Origin
  must match the Host the browser used to reach us) and only then restate
  Origin as Companion's own. Verified live: 101 for our page and for no Origin,
  403 for a forged origin and for a sandboxed iframe's `null`.
- **Answer Companion's text `PING`.** Its tRPC server runs a keep-alive of its
  own — the bare text `PING` after 30 s of silence, then a terminate unless
  anything arrives within 5 s — which is not the WebSocket ping frame
  `ws-client.js` answers. Unanswered, the link was closed every 35 seconds and
  redialled with no error at either end (found 2026-09-23, in every release
  since Companion support). `link.js` replies `PONG`, as tRPC's client does.
- **The panel builds its frame once.** Rebuilt whole on every repaint — about
  once a second from the switcher's timers — it took the (then) iframe with it,
  and Companion's editor reloaded every second it was open (found 2026-09-22, on
  0.12.0). The iframe is gone — the grid is ours now and the editor opens in a
  window of its own — but the rule stays: the grid swaps a button's image in
  place and the trigger editor is redrawn only by its own events, so neither
  flickers nor loses a half-typed slot to a frame from the switcher.
- **Buttons are drawn from Companion's renders, over the page's own socket.**
  `preview.graphics.location` (`{ location: { pageNumber, row, column } }`)
  yields `{ image, isUsed }`, a PNG data URL, first at once and then on every
  repaint — the emulator's own feed. `pages.watch` and
  `userConfig.watchConfig` (for `gridSize`) are doorbells past their first
  frame. **`gridSize` may start below 0/0** — a grid grown upwards has row −1 —
  so never loop from 0. The grid pauses its subscriptions when it is off screen.
  This socket goes through `ws-hook.js`'s patched constructor like any other on
  the page; the hook only adopts a socket carrying Analog Way envelopes, so it
  ignores this one.
- **A press is `controls.hotPressControl` over the server's link, not the HTTP
  API.** `/api/location/…/press` answers only while Companion's *HTTP API*
  setting is on, and a cue that silently pressed nothing would be the worst
  failure a show can have. Down, then up 60 ms later, as surface
  `livepremier-plus`. Cues and memory triggers go through `POST
  /__lpp/companion/press` because the page that fires a cue may never have
  opened the panel; the grid presses on its own socket so that a held button
  stays held.
- **Memory triggers fire on this page's own outbound writes.** `recallOf` in
  `core.js` reads any `…/control/load/slotList/items/<slot>/…/xRequest = true`
  write — ours or the vendor's, both are `dir: 'out'` frames — against the
  dialect's banks. A recall from the front panel, from Companion, or from a
  browser not going through us is never seen; that is also what keeps two open
  pages from pressing twice. A recall to several screens in one breath is one
  press (250 ms per bank:slot).
- **`server/ws-client.js` exists because there can be no dependency.** This repo
  has none, and CI runs Node 20, where there is no global WebSocket. It is the
  smallest thing RFC 6455 allows; its tests drive it from a server written in
  the test file so fragmentation, interleaved pings and both extended-length
  forms can each be produced on purpose.
- **Listing uses the documented HTTP API; only writes use tRPC.** `GET
  /api/connections` is the one supported answer here, so a Companion whose
  internals have moved can still draw the panel. The tRPC
  `instances.connections.watch` subscription is used as a **doorbell only** —
  every frame means "re-read", and its deltas are never parsed, because they are
  a second reader of the same facts in the less stable of the two dialects.
- **Three Companion behaviours that read as success and are not**, each found
  against a live 5.0.5: `instances.connections.add` declares `versionId:
  z.string()` (not nullable) in front of code that accepts null, so a null comes
  back as a generic "malformed input" naming the procedure rather than the
  field — a version is resolved first, from `instances.modules.watch`, where
  modules are keyed `connection:<id>`; `setConfig` **resolves** with a string
  when it refuses and with null on success; and `makeLabelUnique` renames a
  colliding "AWJ" to "AWJ 2" on the way in, so the adds happen first, the show is
  read back, and each connection is configured under the label it actually got.

This link holds a socket open, which `server/awj.js` refuses to do. That
argument is about the store mirror and does not reach here: nothing in the store
has heard of a Companion show, the show changes without us, and the five-client
budget is the switcher's, not Companion's. `plugins/companion/link.js` says so
at length — read it before "fixing" the open socket.

⚠️ **The LivePremier Plus connection has no module to add.** The panel offers
both AWJ and a `livepremier-plus` Companion module, and the second does not
exist anywhere yet; the panel reports it as not installed, in a sentence. That is
the expected answer until someone writes the module.

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
banks), **Pitch Compensation** and, at the Console, **audio routing** — mynah's
`platform.audio` is `'routing'` there, and `Set Audio Patch Input 3 To Screen
1` writes the preview preset's audio layer (`$preset/@items/UP/audio/control/
@props/source`), `Follow …` the mode of a point, mutes where the device keeps
them; the vendored mynah's `docs/PATHS.md` has the table. Withheld, with its
reason in the table: **VPU Map** (no VPU). The MIDI Mapping entry anchors after a `Virtual RC400T`
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
upstream — and `plugins/console/panel.js` passes the one `core/dialect.js` names
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
  exactly that here on a real error in the Timeline's panel, which only
  surfaced when Chrome refused to load the panel. `test/modules.test.js` imports
  every module for this reason — that is the check. Do not replace it with
  `--check`.
- **An upgraded socket is invisible to `server.close()`.** Once a connection is
  upgraded the HTTP server stops tracking it, so `close()` neither counts nor
  closes it — it simply waits, and a Web RCS tab holds its socket open
  indefinitely. `server.closeRelays()` exists for this. Without it the
  launcher's Stop button hangs, which is how it was found: a test that timed
  out rather than failed.
- **`closeRelays()` stops everything; re-pointing hangs up the vendor relays
  only.** `closeRelays` grew to stop the OSC listener, the routers, the Pixelhue
  panel and the plugins as well — right for Stop, and wrong for `PUT /device`,
  which called it: pointing the app at a backup frame silently switched all of
  them off until a restart (found 2026-09-22). `/device` calls
  `hangUpVendorRelays()`. Keep it that way; a test re-points and checks the OSC
  listener and Companion are still running.
- **A panel's `render()` may hand back the element already on screen**, and
  then `Shell.refresh` / `TabHost.refresh` leave it mounted. Anything with state
  in its DOM — an iframe above all, which reloads when detached — must use this:
  build the frame once, refill the parts that change.
- **The operator's place survives every repaint — `ui/keep-focus.js`.** Panels
  are immediate-mode and repaint on every switcher frame, about once a second,
  so every swap of a panel's DOM (`Shell.refresh`, `TabHost.refresh`, the
  pop-outs' `repaint`) notes the focused field first and gives the caret,
  selection and typed text back to its counterpart after; an open `<select>`
  holds the swap instead, since a replaced dropdown closes. Typed text is kept
  only **until it is committed** — Enter, a `change`, leaving the field —
  which `trackFields` follows at the capture phase: after that the panel's
  value is the truth, or the Console's line never clears and a value the
  switcher clamped shows as typed (both happened; the first version kept typed
  text for as long as the field had focus). Measured
  2026-09-23: before it, every text field and dropdown in the Edit page,
  Memories, Matrix Routing, Pitch, Companion, Timeline and Layer was replaced
  within 2.6 s of being focused. "Counterpart" is the field's `data-lpp-key`
  if it has one, else its shape and position — give a field in a list whose
  rows can move under the caret a key. Do not add another per-panel "busy
  while focused" flag for this; and never focus a field on every render, the
  way the Console used to — it stole the caret from the vendor's own fields
  once a second.
- **Every panel is drawn by a test — `test/panel-render.test.js`.** Against
  an empty store and the simulator's, twice each (a render and a repaint), with
  the dependencies `main.js` gives it, over a small stand-in DOM
  (`test/helpers/fake-dom.js`). It exists because the Timeline took an option
  called `actions` that a function of its own shadowed: the first cue holding a
  plugin's action threw on every render and left an empty tab, and nothing
  noticed, because nothing rendered the panel. Moving panels into plugins is
  exactly the change that breaks a render without breaking an import — a new
  panel, or a plugin's page half, goes in that test.
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
- **The Console must hand mynah `facts`, not only `osc.buffer`.** mynah's
  `Set` — a layer parameter, a Midra audio layer — asks `facts.buffer` and
  `facts.canvas`; the OSC resolver asks `osc.buffer`. Until 0.7.0 the Console
  supplied only the second, so every mynah `Set` typed at it was refused with
  "needs a live connection" beside a live connection. `runContext()` now
  supplies both from the store mirror.
- **"Not a secure context" has two causes, and the second is us.** Web MIDI
  and `getUserMedia` exist only on https and loopback. The launcher can bind
  the server to a LAN interface and then opens `http://<lan-ip>:<port>/` —
  served by this app, on this machine, insecure. `server/local-client.js`
  answers it: a LAN-bound server also listens on `127.0.0.1` (not on a
  wildcard bind, which already includes it — a second bind there fails on
  Linux), and a top-level navigation whose TCP source address equals its
  destination address is 302'd to loopback. Same-address-at-both-ends is the
  test, not "one of our addresses": a NAT'd VM's traffic arrives from a
  gateway address we own and would be sent to its own 127.0.0.1. Never
  redirect a fetch or an upgrade; the Web RCS's own requests must land where
  they were sent. `src/core/secure-context.js` is the one sentence the three
  panels show, and it names the page that is open, not the switcher.
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
