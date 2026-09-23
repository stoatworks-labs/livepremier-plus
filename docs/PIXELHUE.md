# Driving a Pixelhue console — **preview**

> ⚠️ **This has never been run against a console.** Every byte of it was worked
> out from the consoles' own firmware and then proved against the vendor's
> control service — a real UCenter, first from a U5 Pro image in a VM, then the
> one PixelFlow for macOS installs, driven from PixelFlow's own virtual U5 with
> a LivePremier simulator on the other end. Every key below was exercised that
> way on 2026-09-23. That is still not a panel on a desk. Turn it on in
> rehearsal, not in a show.

A Pixelhue U5, U5 Pro or U5 mini is an **event controller**: a console built
for Pixelhue's own switchers. This makes one drive an Analog Way LivePremier
instead. It is off until you turn it on, in Preconfig → Settings → Pixelhue
panel.

---

## The idea, which is not the obvious one

The obvious way to drive a console is to read key ids and decide what each one
means — which is what `src/vendor/surface/` does for a MIDI controller, and it
is the wrong shape here. A U-series console is not a keyboard. It already knows
what a screen, a layer, a source and a memory are, and its control service
speaks a protocol about exactly those things.

So this does not paint keys and has no key map:

```text
  LivePremier Plus                                   the console
        │
        │  {screens, layers, inputs, presets, …}
        ├──────────────────────────────────────────▶  labels its keys,
        │      PUT …/video-station/data-change        lights them, pages
        │                                             them, handles long-press
        │
        │◀──────────────────────────────────────────  [ operator presses a key ]
        │  {command: 300, payload:{id: 2, text:"LIVE_2"}}
        ▼
   a write to the switcher
```

**The identity comes back exactly as published.** A screen goes out as
`uid: "S1"` and comes back as `uid: "S1"`; a memory goes out as `id: 7` and
comes back as `id: 7`. There is no table mapping key 65 to "input 2" to keep in
step with a firmware, because the console is told what its keys mean and
remembers.

---

## What works, and what each key does

| the panel | the console reports | this app does |
|---|---|---|
| screen bus, press | `101` screenSelect | adds the screen to the selection |
| a selected screen, press | `102` screenActive | makes it the **active** one — its layers take the layer bus |
| a selected screen, **long** press | `103` unselect | drops it |
| layer bus | `201` layerSelect | holds the selected layer (the active screen's layers are shown) |
| input bus | `300` inputSwitch | writes `source.inputNum` on the selected layer |
| preset bus | `401` playPreset | recalls that memory **to preview** on every selected screen |
| SAVE TO, then a preset | `520`, then `400` | stores the active screen's edited buffer in that slot |
| SAVE TO, then an **empty** preset key | `520`, then `400` with `id: 0` | the same, into the first free slot, named `Memory <n>` |
| TAKE | `531` | `xTake` on every selected destination |
| CUT | `532` | `xCut` |
| MATCH PGM | `529` | `xCopyProgramToPreview` |
| PGM EDIT | `530` | moves which buffer a *source change* (and a store) edits |
| FTB | `518` | fades the selection to black, or back up once all of it is black |
| FRZ | `517` | freezes what is on air on every fitted layer, or unfreezes |
| T-bar | tag `0x00101358` | `tbarPosition` on every selected destination |
| TIME / CTRL + TIME | `509`/`510` (held: repeats) / `512` | take time ±0.1 s on the selected screens, inside PixelFlow's own 0.1–10 s |
| SWAP | `533` | flips the take group's `copyMode`: swap on, a take swaps; off, preview keeps a copy of program |
| SIGNAL SOURCE | `587` | the input bus cycles live inputs → stills → screens (whichever exist); an input key then routes `STILL_n` / `SCREEN_n` |
| LOCK PANEL, **long** press | `523` | the panel changes nothing but the lock until the next long press |
| DEL, then a preset | `521`, then `403 {id, text}` | deletes that memory (DEL disarms itself) |
| LAYER UP / DOWN (cluster page 0) | `505` / `507` (`504` / `506` top / bottom) | steps the selected layer through the active screen's fitted layers, clamped at the ends — a LivePremier layer's stacking is its number, so the keys move the selection instead |
| cue transport (cluster page 1) | `569`–`573` | play, restart, stop, previous, next — to this app's cue stack, or to five Companion buttons, or nowhere (**Settings → Pixelhue panel → Cue transport keys**) |
| MVR | *nothing* — acted on from the raw press | opens the Web RCS's live Multiviewers page |
| SOURCE BACKUP (cluster page 3) | *nothing* — acted on from the raw press | opens the backup menu of the last input pressed on the panel, on Screens / Aux. |
| faders 1–8 | tag `0x0010031c` | opacity of layer *n* on the active screen, in the edited buffer — *a first answer* |
| encoders 1–4 | tag `0x0010031c` | the selected layer's X, Y, width, height, 8 px per detent — *a first answer* |
| page up/down | none | nothing; the console pages itself |

Everything else a console reports — PTZ, media, timecode, cue transport — is
ignored on purpose. Those are about a Pixelhue show, not this switcher.

⚠️ **A recall always lands in preview**, whatever PGM EDIT is doing. The panel
has a modifier that would make "recall to program" easy to offer; a memory
landing on air because a key was held two minutes ago is not worth the
convenience, and every other recall path in this app makes the same choice.

⚠️ **A source change is refused when the preset letter is not known.** Which
letter is preview changes on every take, it is device state, and it is read
from the switcher at the moment of the write. If that read fails, nothing is
sent — the same refusal `server/osc.js` makes, for the same reason. FTB and FRZ
make the same refusal: both are toggles, and which way to toggle is read from
the switcher first.

⚠️ **A store saves ONE screen — the active one.** A LivePremier memory slot
holds one preset: one layer set, one screen size. Saving a slot from every
selected screen keeps only the last and recalls it on all of them, which is
what the simulator did the first time this was tried.

**The T-bar follows the switcher, not the lever.** The console reports how far
through a stroke the lever is; a LivePremier's `tbarPosition` is absolute, 0 at
one end and 65535 at the other, and whichever end a screen rests at is where a
throw starts. So each stroke reads where every selected screen rests, and maps
from there — which is why a take fired from the TAKE key, leaving the lever and
the switcher at opposite ends, is still finished by the next throw either way.
LOCK T-BAR is the console's own and silences the reports.

## Page-side actions: one page answers

The cue stack runs in the pages of this app, not in its server, and so do
opening the Multiviewers page and an input's backup menu. Every open page
claims them every four seconds at `POST /__lpp/pixelhue/runner`; the first
claimant keeps them while it keeps claiming, the server names it on each event
(`page` on `/__lpp/pixelhue/stream`), and only it acts — two open tabs never
fire GO twice. With no page open, those keys are refused and the history says
why.

MVR and SOURCE BACKUP report no command at all, so they are read from the
**raw key press**. Which key code they are comes from the console's own key map
(`GET ucenter/video-station/key/active-custom?deviceModel=` — 29701 U5, 29703
U5 Pro, 29711 U5 mini), by `keyMode` (112 MVR, 181 SOURCE BACKUP), so it holds
for every model and layout. SOURCE BACKUP shares its key with functions on the
cluster's other pages that *do* report a command, so a press counts only when
no command follows it within 0.4 s.

The Companion transport presses buttons *page / row / 0–4* — play, restart,
stop, previous, next — through the Companion plugin's server (its `companion`
service), on the socket it already holds.

## Faders and encoders: bound, or silent

⚠️ **A U5's faders and encoders report nothing until something is bound to
them** — UCenter takes the moves and drops them. Binding is
`POST ucenter/video-station/midi/binding` with
`{attributes: [{unique, type, index}]}` (type 2 fader, 1 encoder; indexes
1–8 and 1–4), and from then on every move of a bound control reaches **every**
client on tag `0x0010031c`: `{unique, value, type, frameValue}` — a fader's
`value` is its position in percent, an encoder's `frameValue` is ±1 per
detent. This app binds `lpp.fader.1–8` and `lpp.encoder.1–4` on every publish,
because the table is UCenter's and shared: PixelFlow binding its own controls
takes them back. ⚠️ The binding request must **not** carry `ip`/`port`
headers, or a UCenter that proxies to devices forwards it instead of answering.

What each one does is the part most likely to change: today fader *n* is the
opacity of layer *n* on the active screen and the encoders move and size the
selected layer, all on the buffer the panel edits (preview, unless PGM EDIT is
on). Each control keeps one write in flight — a fader's newest position wins,
an encoder's detents add up — and the history gets one line per gesture.

**Deleting and creating are never acted on.** A screen key pressed with DEL
armed reports `104` (delete that screen); an empty layer key reports `200`
(create a layer). Neither is something this app offers from a panel.

---

## Rigging one

| console | control port | where this app has to run |
|---|---|---|
| **U5 mini** | 8088, **on the LAN** | anywhere it already runs |
| U5 / U5 Pro | 19999, **loopback only** | on the console itself |

⚠️ That difference is the whole rigging story. A U5 mini is driven from the
operator's laptop with nothing installed on the console. A U5 or U5 Pro is a
Windows mini-PC and its control service answers only to itself, so this app has
to be running on it — which it can be: the Pro has a touch screen, and the
proxied Web RCS runs on it perfectly well.

Settings are installation-level, like the OSC listener and the matrices: a
panel on the desk does not move when you re-point at a backup frame.

⚠️ **The console's control service is shared, and the vendor's software
publishes to it too.** With PixelFlow open, the panel shows *its* project's
buses and every press is acted on by both apps; the last model published wins.
A select of a screen this app did not publish is refused and says so in the
panel's history, and the selection is cleared whenever the link is rebuilt —
but the panel itself will still be showing someone else's keys. Close the
vendor software.

**The console can drop the model.** When another PixelFlow client connects to
the same UCenter, every key loses its label, and nobody tells the publisher.
This app watches for a whole-panel redraw carrying none of its labels and
publishes again, at most once every three seconds.

**Trying it with no console.** PixelFlow for macOS installs the same control
service locally (`/Library/Ucenter`, port 19999), and its Event Controller page
— a full virtual U5 — can be served on its own, without PixelFlow's main window
publishing over this app. Pick **U5** or **U5 Pro** with host `127.0.0.1`. The
serving script lives with the reverse-engineering notes, in
`pixelhue-re/tools/rig/virtual-panel.mjs`.

---

## What it reads from the switcher, and what it does not

The panel needs more than OSC does — screen names, input names, memory names,
and the preset letters. All of it is read with `server/awj.js`'s `exchange()`:
a burst of `get`s on one connection, which is then closed.

**Nothing is held open on the switcher, and nothing is subscribed to.** The
rule at the top of `server/awj.js` stands, and a refresh-on-demand panel does
not need to beat it. What that costs is **live tally**: a take fired from the
Web RCS, or a memory recalled at the front panel, does not relight the
console's keys until the next refresh. The panel refreshes when it connects and
after each change it makes.

Closing that gap is what a scoped AWJ subscription would be *for*, and it is
the one piece of this that would need `awj.js`'s argument beaten properly, in
writing, the way `plugins/matrix-routing/routers/` did.

Bounded on purpose: 24 screens, 24 inputs, 32 memory slots. A LivePremier has a
thousand memory slots and a console bus is eight keys wide.

---

## The wire, for whoever comes next

Base `http://<console>:<port>/unico/v1/`. The frame codec is vendored from
pixelhue-bridge and is unmodified; `src/vendor/pixelhue/README.md` says where
it came from.

**The WebSocket** is `…/ucenter/ws?client-type=5`, carrying NOVA frames — a
22-byte header, a TLV naming the message, JSON inside. Tag `0x00101301` is key
state, `0x00101307` is the semantic command. ⚠️ One `client-type=5` connection
receives **both**, which was not obvious: 5 is not in Unico's own `ClientTypeE`
(`PCUnico 0, UnicoEC 2, PCPixelFlow 8, PixelFlowEC 9`) — it is hard-coded in
the console's on-screen keyboard app, and it is the one to use.

**The model** is `{screens, layers, inputs, presets, cues, medias, funcs,
additionInfos, newProtocol}`, replaced whole; there is no partial update.

⚠️ **`index` is the key position and it is 1-based.** Publishing from zero
silently drops the first object of every bus — no error, no complaint, just a
panel that is one short. This cost an afternoon; `test/pixelhue.test.js` pins
it.

⚠️ **A layer binds only when three things line up**, found by publishing
variants at a live UCenter: its `type` is one the console knows (2, a normal
layer — this app sent 0 for months and the layer bus sat empty); its
`attachScreenId` / `attachScreenUid` name a published screen; and that screen
is published **active on preview**, `activeRegion: 4`, matching the layer's
`region: 4`. The console shows the active screen's layers and nobody else's.
Program on both sides binds nothing.

⚠️ **A rejected field comes back as a Go unmarshal error naming the struct and
field** — `{"Struct":"RInput","Field":"inputs.hasBackup"}` — which is by far
the most useful thing this API says, so `ucenter.js` passes it through whole.
Empty arrays always validate, so an `ok` on `{}` proves nothing about a
payload.

There is also `PUT …/key/action` with `[{key, state}]`, which injects a press.
It is how the whole chain was exercised without a panel and it is not used in
service. And `PUT …/key/response-state` with `{state: 1}` stops UCenter acting
on keys itself — deliberately never called, because blocking its own logic
would also take away the labelling and paging that make publishing a model
worth doing.

---

## Known gaps

- **FTB and freeze are LivePremier only.** The paths were recovered from the
  Web RCS bundle and proved on the 6.2.73 simulator; Midra 4K / Alta 4K have
  no verified path yet and say so.
- **Noted for later, not acted on** — exactly what each sends, for when it
  gets a meaning:

  | key | sends |
  |---|---|
  | SWITCH DEVICE | `586` deviceSwitch, payload all empty (`{id: 0, uid: "", type: 0, text: ""}`); PixelFlow moves the input bus to the next switcher's sources |
  | MEDIA | no command — tag `0x0030032e` `{"mediaState": 620}`, and the lower-left cluster's lamps change |
  | CTRL alone | nothing; it is a modifier (CTRL + TIME is `512`) |
  | cluster page 0, the rest | `501` full output, `502` copy, `503` mirror (and `500` full screen, `508` cutout on layouts that have them) |
  | cluster pages 2 and 3 | nothing on this layout, bar SOURCE BACKUP |
  | the seven unbound keys | nothing; a key layout can give them any function |
  | DEL, then a screen | `104` screenDelete — deliberately never acted on |
  | (no key on a U5) | `402` deleteAllPreset, `522` switchMutiDel — deliberately never acted on |
- **Swap, time, stills and screens are LivePremier only**; Midra's spellings
  for them are unverified.
- **Layer names are `Layer <n>`.** The console shows the layer bus from the
  model; the names the Layer names plugin keeps live on the page side, not
  where this reads.
- **The key displays are the console's own.** This publishes a model and the
  console draws from it; there is no path here that pushes a picture. The one
  the API offers takes a *filesystem path on the console*, not image bytes.
- **Midra 4K / Alta 4K are untried.** The dialect makes the writes spellable
  and nothing here assumes LivePremier, but no Midra has been in the loop.
