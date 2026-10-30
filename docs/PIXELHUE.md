# Driving a Pixelhue console — **preview**

> ⚠️ **This has never worked against a console.** Every byte of it was worked
> out from the consoles' own firmware and then proved against the vendor's
> control service — a real UCenter, first from a U5 Pro image in a VM, then the
> one PixelFlow for macOS installs, driven from PixelFlow's own virtual U5 with
> a LivePremier simulator on the other end. Every key below was exercised that
> way on 2026-09-23. That is still not a panel on a desk. The first real
> console to try it, a U5 mini, refused the connection (2026-10-22, under
> [Rigging one](#rigging-one)); once it connected, its bus keys stayed blank,
> because a mini's keys are not its control service's to label
> ([A U5 mini's key grid](#a-u5-minis-key-grid)). On 2026-10-30 the same rig —
> PixelFlow's UCenter and virtual U5 on a Mac — drove a **real LivePremier**, an
> Aquilon C mini on 6.2.73: the keys labelled from its model, and a source, TAKE,
> TIME, SAVE TO and DEL each reached the frame. Still no panel on a desk. Turn it
> on in rehearsal, not in a show.

A Pixelhue U5, U5 Pro or U5 mini is an **event controller**: a console built
for Pixelhue's own switchers. This makes one drive an Analog Way LivePremier
instead. It is off until you turn it on: tick **Drive a Pixelhue console** on
the Pixelhue panel card in Preconfig ▸ LivePremier Plus.

---

## The idea, which is not the obvious one

The obvious way to drive a console is to read key ids and decide what each one
means — which is what `src/vendor/surface/` does for a MIDI controller, and it
is the wrong shape here. A U-series console is not a keyboard. It already knows
what a screen, a layer, a source and a memory are, and its control service
speaks a protocol about exactly those things.

So this does not paint keys on a U5 or U5 Pro, and the buses have no key map
(a U5 mini is the exception, and has [its own section](#a-u5-minis-key-grid)):

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

What *is* a table is everything off the buses — TAKE, FTB, the cluster, the
faders and encoders — and it is by **function**, not by key: TAKE reports
`531` on a U5, a U5 Pro and a U5 mini alike. See [the mapping page](#the-mapping-page).

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
| MVR | *nothing* — acted on from the raw press | opens the Web RCS's live multiviewer page: `/live/multiviewers` on a LivePremier, `/live/multiviewer` on a Midra 4K or Alta 4K |
| SOURCE BACKUP (cluster page 3) | *nothing* — acted on from the raw press | opens the backup menu of the last input pressed on the panel, on Screens / Aux. — LivePremier only; refused on a Midra 4K or Alta 4K, whose inputs have no backup |
| faders 1–8 | tag `0x0010031c` | opacity of layer *n* on the active screen, in the edited buffer — *a first answer* |
| encoders 1–4 | tag `0x0010031c` | the selected layer's X, Y, width, height, 8 px per detent — *a first answer* |
| page up/down | none | nothing; the console pages itself |

Everything else a console reports — PTZ, media, timecode — is ignored on
purpose. Those are about a Pixelhue show, not this switcher.

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

## The mapping page

**Pixelhue Mapping**, in the sidebar under Virtual RC400T beside MIDI Mapping,
draws the console in the Virtual RC400T's own look — its chassis, key caps,
lamp gradients and section headings, read off that page's stylesheet — with
what each control does written on it.

A Midra 4K or Alta 4K sidebar has no Virtual RC400T, so there the same page
sits at the foot of the PLUS section, after Companion: `client.js` registers
it twice and `controlSurfaces` picks which one is mounted. The look is
restated in `map-page.js` rather than borrowed live, so it draws the same with
no RC400T page to borrow from — seen on the Midra 4K simulator 3.2.29
(2026-10-16), and the mapping it edits is the one the console applies there.

- **The buses** show what the console shows: each key's text and lamp are the
  key states the console pushes (the supervisor mirrors them; `/state`'s
  `keys`), so S1 lit amber there is S1 selected on the panel. Empty positions
  show their number. A bus key is not mapped — see above — and its inspector
  says what sits there and why.
- **Every function key, fader and encoder** carries its action as its legend,
  with a blue dot where it differs from the default. Click one and pick what
  it does; *Back to the default* and *Reset n changes* undo.
- **Press a key on the console** and it flashes here and opens in the
  inspector — the quickest way to find out which key is which.
- The tall **PAGE** key in the lower-left cluster pages the drawing through the
  cluster's four pages (layer tools, cue transport, —, SOURCE BACKUP), as it
  does the console.

What a key can be given: take, cut, program to preview, swap, take time ±,
FTB, freeze, PGM EDIT, signal source, the layer steps, the five cue transport
actions, open Multiviewers, open the last input's backup menu, lock, **recall
memory *n* to preview**, **press Companion button *page/row/column***, or
nothing. A fader: its own layer's opacity (the default), the selected layer's,
or nothing. An encoder: the selected layer's X, Y, width, height (8 px a
detent) or opacity (2 a detent), or nothing.

The table is `plugins/pixelhue/mapping.js` and the drawing
`plugins/pixelhue/layout.js`; the setting is `pixelhueMap`, which stores only
overrides, so a control nobody changed follows whatever its default becomes.
With nothing changed every key does exactly what it did before the table
existed — `test/pixelhue-mapping.test.js` pins each default against
`readIntent`.

⚠️ **A held key repeats, and a hold reports only the repeat.** TIME held sends
`510` about eight times a second and never `509`. So while TIME is mapped to
something that is not a take time, the supervisor acts on the first repeat of a
hold and drops the rest: TIME mapped to TAKE takes once, not eight times a
second.

⚠️ **The drawing is a U5's default layout** (from PixelFlow's virtual U5). A U5
Pro or U5 mini is mapped by the same table — it is by function — but drawn as
a U5 until their layouts are added. Controls a U5's default layout has no key
for (FULL SCREEN, LAYER TOP / BOTTOM, CUTOUT) are listed under the drawing.

---

## Rigging one

| console | control service | port | socket | where this app has to run |
|---|---|---|---|---|
| **U5 mini** | `nvcontroller` | 8088, **on the LAN** | `/unico/v1/ws` | anywhere it already runs |
| U5 / U5 Pro | UCenter (`ucenter_win`) | 19999, **loopback only** | `/unico/v1/ucenter/ws` | on the console itself |

The REST calls are the same on both, under `/unico/v1/ucenter/video-station/`.
The socket is not, and the app takes the path from the model you pick.

⚠️ That difference is the whole rigging story. A U5 mini is driven from the
operator's laptop with nothing installed on the console. A U5 or U5 Pro is a
Windows mini-PC and its control service answers only to itself, so this app has
to be running on it — which it can be: the Pro has a touch screen, and the
proxied Web RCS runs on it perfectly well.

⚠️ **A U5 mini is not running UCenter, and its socket is somewhere else.**
**2026-10-22:** a user's real U5 mini, firmware V1.0.3, reported
`upgrade refused with HTTP 200` as soon as the panel connected. It was the
first time this preview had met a console. The app was asking the mini for the
U5's socket, `/unico/v1/ucenter/ws`, and the mini answered that path with an
ordinary page instead of a WebSocket. The stand-in console the suite tests
against served the same wrong path, which is why nothing failed here. The app
now asks a mini for `/unico/v1/ws`. That comes from the firmware, below. Nobody
has seen it work on a mini: nothing after the refusal has been run on one.

What the mini's firmware shows (U5 mini V1.0.3, read, never run; the root
filesystem is a squashfs at byte offset `0x149bc4a` of the `.img`):

- Its control service is `usr/process/oem/nvcontroller/nvcontroller`, a Go
  (fiber) build from the same NovaStar plugin tree as UCenter
  (`config/ncp.toml`). That is why the REST calls match a U5's.
  `config/runtime.toml` puts both HTTP and the WebSocket on 8088.
- The binary contains `/unico/v1/ws`. It does not contain `ucenter/ws`
  anywhere.
- The mini's own LCD app, `usr/process/oem/LCD/bin/liblcdcommchannelimpl.so`,
  connects to `ws://127.0.0.1:<port>/unico/v1/ws?client-type=11`: on
  loopback, and as client type **11**, not the 5 this app uses. nvcontroller
  does read the type: it logs `client-type is not int` for a bad one.
- The console's mDNS advertisement (`_pixelhue._tcp`) is for the LCD grid's
  TCP 17100 and nothing else. The console's own software reaches 8088 on
  loopback. So nothing in the firmware says 8088 is meant for the LAN, beyond
  the listener's port. The user's mini did answer 8088 from the network,
  though, with that 200.

**Client type 5 on a mini is still a guess.** On a U5's UCenter, a type-5
socket gets both the key states and the commands (under
[The wire](#the-wire-for-whoever-comes-next)). The mini's own app uses 11, and
whether 5 hears keys there is not known. So when the socket opens and no key
report arrives within ten seconds, the panel card shows the link as
**connected, no key reports**, the history and the log say why, and they say
when one does arrive. Changing the type for a model is one field, `clientType`
in `CONSOLE_MODELS` (`plugins/pixelhue/core.js`).

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

## A U5 mini's key grid

**2026-10-22, the second report from the same user's mini:** the panel
connected, page up / down and the area-switch keys reached this app, and
nothing else did. The LCD keys stayed blank, and TAKE, CUT and the bus keys
did nothing. The firmware says why: on a mini, publishing a model is the wrong
shape.

**What the mini's LCD app owns** (firmware V1.0.3, `usr/process/oem/LCD/bin`,
Qt, log tag `[MiniControl]`; read from its symbols, never run):

- It is the controller, not the control service. It reads the hardware keys
  and posts some of them to nvcontroller as `key/action`.
- It binds to a **Pixelhue switcher** on the network (`RemoteDeviceBiz`:
  login, node detail, binding), builds and publishes its own data-change, and
  draws the bus keys from its own cache.
- It runs **TAKE and CUT itself**, against that bound switcher
  (`/unico/v1/screen/take`, `/screen/cut`; "no selected screens, could not
  exec take").
- So a model published to nvcontroller labels nothing, and with the screen
  keys empty there is nothing to select. Only keys that do not depend on what
  the console is showing reached this app: 549 / 550 (page) and 595 (area
  switch).

**What it offers instead is its Companion surface.** The LCD app serves a
4 × 10 grid of 72 × 72 keys on **TCP 17100**, the one the console's built-in
Companion draws on. Each of the four bus rows has a module, changed with the
row's area-switch key (the last key of the row): Screen → Layer → Input →
Preset → **Companion** → Screen. On a row switched to Companion the keys show
what a 17100 client drew, and a press goes to that client, by row and column.

So on a mini this app draws the grid itself, the way the built-in Companion
would, beside the control-service socket (`plugins/pixelhue/grid.js`, what is
drawn and what a press means; `grid-link.js`, the link):

| row | shows | a press |
|---|---|---|
| 0 | the screens in service | selects; on a selected screen, makes it the **active** one; held 1.5 s, drops it |
| 1 | the active screen's layers | selects the layer |
| 2 | inputs (or stills or screens, as SIGNAL SOURCE chose) | puts it on the selected layer of every selected screen, in the buffer the panel edits |
| 3 | memories | recalls to preview; with SAVE TO or DEL armed, stores or deletes |
| columns 8 / 9 | that row's page, as `INPUT 1/2` | page back / page on, eight at a time |

**Switch each row to Companion to see it.** The grid is drawn for all four
rows as soon as the link opens, and the console keeps it, but a row shows it
only once its area-switch key has taken it round to Companion — four presses
for the screen row from where the console starts, one for the memory row. A
row left on its own module is the LCD app's, and its keys do what the LCD app
does with them. The card says so, and the history says when the grid
connects.

**The selection lives here**, as for a Barco EC panel. A grid press becomes the
same intent a U5's bus key reports — select, activate, unselect, select layer,
source, recall, store, delete — and goes through the same code, so what it
writes, and what it refuses, is what a U5 press would. The keys draw that
selection: a selected screen amber, the active one framed in white, FTB and
FRZ as last read; the selected layer amber; on the input row, red for what is
on the selected layer in program and green for what is in preview, read
from the switcher after each change, like every other lamp here.

**SAVE TO and DEL are the console's keys**, and a mini's memory row is this
app's, so this app keeps them armed from the console's own report (520, 521).
If a mini reports them, the memory row is framed red, the next memory key
stores to its slot or deletes it, and an empty key past the last memory saves
to the first free slot as `Memory <n>`. If it does not, the memory row only
recalls.

**TAKE and CUT: nobody knows yet whether a mini reports them.** If it does,
531 and 532 take and cut the screens selected on the grid, exactly as on a U5
— the stand-in proves that much. If it reports TAKE's key but no take, the
history says *TAKE pressed on the console (key 65), but the console reported
no take command (531) to this app, so nothing was sent to the switcher*. If it
reports nothing at all, there is nothing to see, so the card says so up front:
**TAKE / CUT: not seen yet**, with a note in plain words, said once in the
history at the first selection on the grid. Take from the Web RCS until the
card shows them reported. Nothing here guesses at a workaround: the LCD app
takes against the switcher it is bound to, and nothing in the firmware offers
a way round that.

**One client at a time, and who wins.** The LCD app holds one 17100 client
(`TcpServer::acceptThread`, disassembled):

| holding the grid | connecting | result |
|---|---|---|
| nobody | anyone | taken |
| the console itself (localhost) | the console itself | refused |
| the console itself | a machine on the LAN | the old one is dropped; the new one takes it |
| a machine on the LAN | the console itself | refused |
| a machine on the LAN | another machine | the old one is dropped; the new one takes it |
| a machine on the LAN | the same machine again | refused |

Pixelhue's build of the built-in Companion keeps an enabled connection to
`127.0.0.1:17100` and restarts it the moment it drops, so out of the box the
built-in Companion holds the grid. **This app takes it** — anything that was
on the Companion rows is replaced by this app's drawing while it is connected
— and the built-in Companion's retries are refused until this app lets go,
so the two do not fight. Another machine's Companion with the U5 mini surface,
pixelhue-bridge or a second copy of this app would: each takes it back on
every reconnect. So this app lets go after the console has closed its
connection three times in a minute, and says so on the card. The same count
catches the last row of the table: after a connection that dropped without
saying goodbye, the console refuses a new one from the same machine until it
notices the old one has gone, and nothing in its code says how long that is.
Turn **Drive a Pixelhue console** off and on to try again.

**What is unverified** — all of it, on a console. From the firmware but never
under a thumb: that the rows are the four bus rows in this order; that a row
shows the drawing only in Companion; that columns 8 and 9 are each row's page
keys (inferred from the key map, not followed through the code — whichever key
they are, the page is drawn there and turned there); that a press reports the
page its row shows, which is how a press made while a row was being redrawn is
refused rather than acted on; the client rules above. Not known at all:
TAKE and CUT, what 595 carries, and how long a mini takes to notice a dead
connection. The 72 × 72 labels are drawn with the EC panel's 5 × 8 font, at
1.5× or 2× where a name fits; how they read on the mini's LCD is for the first
person with one to say.

---

## Testing it on a console

`test/console/` is a suite for the day a console is on the desk. It boots the
real app, points its Pixelhue panel at the console, and drives a LivePremier
**simulator** at the far end — never a frame, for the same reason `test/sim/`
refuses one. It is three files, run in order:

| file | needs | what it settles |
|---|---|---|
| `1-link` | the console | it answers on its port and socket path, sends its key states, serves its own key map, takes the model and draws it from position 1; on a U5 mini, that its key grid takes the app's connection and all 40 keys go out |
| `2-keys` | the console | every key the app acts on, pressed by injection (`PUT …/key/action`), checked three ways: the console's report on a socket of the suite's own, the app's history, and the switcher over AWJ |
| `3-hands` | a person | what only a thumb proves: that the key pressed is the key the map says, what each display reads, long presses, LOCK PANEL, paging, SHIFT, the area-switch keys and the T-bar; on a U5 mini, the key grid (below) |

```bash
LPP_CONSOLE=192.168.0.50 LPP_SIM=127.0.0.1:3000 npm run test:console
```

```bash
LPP_CONSOLE=192.168.0.50 LPP_CONSOLE_GUIDED=1 LPP_SIM=127.0.0.1:3000 npm run test:console
```

`LPP_CONSOLE` is the console's address with no port. The app takes the port,
the socket path and the client type from the model, so the suite does too. `LPP_CONSOLE_MODEL` is `u5mini`,
`u5pro` or `u5`, and `u5mini` unless told otherwise; a U5 or U5 Pro means
running the suite on the console itself, with `LPP_CONSOLE=127.0.0.1`. With
`LPP_CONSOLE` unset every test skips, and without `LPP_CONSOLE_GUIDED=1` so
does `3-hands`, which needs a person. The hands-on file asks its questions on
the terminal and waits for the console rather than for Enter; `s` and Enter
skips a step.

⚠️ **Nothing else may be listening to the console.** Every client of a UCenter
acts on every press, so an injected TAKE goes to everything connected. Before
it presses anything the suite asks each LivePremier Plus on this machine (ports
8535, 8536 and any in `LPP_CONSOLE_PEERS`) what it drives, and refuses if one
shares the console; then it watches for four seconds for anything republishing
over its model. It cannot ask PixelFlow or another laptop. Close them.

Every run writes what it saw to `test/console/results/` (ignored by git): the
socket it opened, the key map the console served, every press and what it
reported, the T-bar's reports. Some of that has never been seen, and the useful parts belong in
`test/fixtures/` and this page afterwards.

**What the suite expects of a U5 mini**, from its own key_mini.xml (firmware
V1.0.3, kept as `test/fixtures/pixelhue-u5mini-keys.json`) and not yet from one
under a thumb — `1-link` compares what the console serves with it and says what
differs, and a newer firmware's map goes into that file:

- four buses of eight keys, each with its own page keys and an **area-switch**
  key nobody has pressed yet;
- TAKE, CUT, MATCH PGM, PGM EDIT, FTB, FRZ, SWAP, SAVE TO, DEL, LOCK PANEL and
  LOCK T-BAR, as on a U5;
- **no** TIME, MVR, SIGNAL SOURCE, SWITCH DEVICE, CTRL or lower-left cluster,
  so the take-time keys, layer steps, cue transport and SOURCE BACKUP have no
  key on a mini's default layout, and their tests skip;
- **SHIFT**, which turns the function keys into a keypad, and **LOAD TO PGM**
  and **TEST PATTERN**, which report nobody knows what — the app acts on none
  of them, and `2-keys` checks that they write nothing;
- a T-bar, and no faders or encoders;
- its socket at `/unico/v1/ws`, and key states on it at client type 5 — the
  one thing nobody knows. `1-link`'s first test waits five seconds for the
  whole key-state dump; if none comes, it fails saying what did arrive and
  that the mini's own app connects as 11;
- its bus keys belong to its LCD app ([A U5 mini's key grid](#a-u5-minis-key-grid)),
  so `1-link` records what its control service reports for them instead of
  requiring the published names, and checks that the key grid on 17100 takes
  the app's connection and gets all 40 keys.

**On a mini, `3-hands` walks the key grid**, and skips the two steps that are a
U5's (a bus key reading a published name, a held screen key reporting 103). It
asks for each row to be switched to Companion and whether its first key reads
the right name, recording what the area-switch key reported (595, whose
payload nobody has seen). It has a screen picked on the grid, asks whether the
layer row followed, then has TAKE and CUT pressed and records which of the
three things happened: the command came and took, the key was reported with no
command after it, or nothing came at all. That is the open question, so it is
recorded rather than required. It then pages the input row with its own page
key and fails if the press went to the control service as 550 instead of to
the app, since columns 8 and 9 being the page keys is only inferred. The T-bar
step selects S1 on the grid too.

**Without a console**, `LPP_CONSOLE=stand-in` swaps in
`test/helpers/fake-ucenter.js`, a U5 mini's control service in a few hundred
lines, on 127.0.0.1:8088, serving that same key map. Its socket is at the
mini's `/unico/v1/ws` and nowhere else. The U5's path gets the ordinary 200 the
user's mini gave, so the stand-in can no longer agree with a wrong path, as it
did until 2026-10-22. It runs `3-hands` too, doing what each step asks with
nobody at the desk. A pass against it proves the suite runs and nothing about
a console: it is built from what has been seen of UCenter, and where nobody has
seen what a key does, it does nothing.

Its injected and thumbed bus keys still behave as a U5's UCenter does, because
the suite drives them that way and nobody has seen what a mini's control
service does with an injected bus key. The mini's own route is the key grid,
`test/helpers/fake-mini-lcd.js`, which the stand-in serves on 17100 too: one
client by the firmware's rules, drawing only on rows switched to Companion,
`page` as the row's page, and a packet reader of its own rather than the
vendored codec, so the two readings of the format check each other.
`test/pixelhue-grid.test.js` drives it, with TAKE and CUT reported, reported as
a key only, and not reported at all (`functionKeys`), since which a mini does
is the open question.

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

**The WebSocket** is `/unico/v1/ucenter/ws?client-type=5` on a U5 / U5 Pro and
`/unico/v1/ws?client-type=5` on a U5 mini (under [Rigging one](#rigging-one)),
carrying NOVA frames — a 22-byte header, a TLV naming the message, JSON
inside. Tag `0x00101301` is key state, `0x00101307` is the semantic command.
⚠️ On a U5's UCenter, one `client-type=5` connection receives **both**, which
was not obvious: 5 is not in Unico's own `ClientTypeE` (`PCUnico 0, UnicoEC 2,
PCPixelFlow 8, PixelFlowEC 9`) — it is hard-coded in the console's on-screen
keyboard app, and it is the one to use there. A mini's own LCD app connects as
11, and what 5 gets on a mini is unknown.

A refused upgrade is reported with the URL it was refused at
(`upgrade refused with HTTP 200 by ws://…`), so a report from the field says
which path failed.

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

- **Little after the socket has been seen on a U5 mini.** The one real mini
  to try this refused the U5's socket path (2026-10-22); on the corrected path
  it connected, and its page and area-switch keys reached this app. The key
  grid drawn over 17100 is built from the firmware and has not met a mini.
  Whether TAKE and CUT reach this app on one is the next thing to find out
  ([A U5 mini's key grid](#a-u5-minis-key-grid)).

- **FTB and freeze are LivePremier only.** The paths were recovered from the
  Web RCS bundle and proved on the 6.2.73 simulator; Midra 4K / Alta 4K have
  no verified path yet and say so.
- **Noted for later, not acted on** — exactly what each sends, for when it
  gets a meaning:

  | key | sends |
  |---|---|
  | SWITCH DEVICE | `586` deviceSwitch, payload all empty (`{id: 0, uid: "", type: 0, text: ""}`); PixelFlow moves the input bus to the next switcher's sources — *nothing by default; assignable on the mapping page* |
  | MEDIA | no command — tag `0x0030032e` `{"mediaState": 620}`, and the lower-left cluster's lamps change |
  | CTRL alone | nothing; it is a modifier (CTRL + TIME is `512`) |
  | cluster page 0, the rest | `501` full output, `502` copy, `503` mirror (and `500` full screen, `508` cutout on layouts that have them) — *nothing by default; assignable on the mapping page* |
  | cluster pages 2 and 3 | nothing on this layout, bar SOURCE BACKUP |
  | the seven unbound keys | nothing; a key layout can give them any function |
  | DEL, then a screen | `104` screenDelete — deliberately never acted on |
  | (no key on a U5) | `402` deleteAllPreset, `522` switchMutiDel — deliberately never acted on |
- **Swap, time, stills and screens are LivePremier only**; Midra's spellings
  for them are unverified.
- **SOURCE BACKUP is LivePremier's.** A Midra 4K or Alta 4K input has no
  backup: the bundles' input object is plugs, `control`, `snapshot` and
  `status` (Midra 3.2.29, Alta 1.3.7), and the input card's ⋮ on the Midra
  simulator's Screens / Aux. holds the plug, Setup, Freeze and Capture. So
  the key is refused there with that reason (`dialect.inputBackup`), rather
  than opening a menu and calling it the backup. The page half's card
  lookup is LivePremier's too — a Midra card has its number in the footer
  and no `.aw-header` — which no longer matters, since it is never asked.
  MVR finds the live multiviewer page on both platforms: the page clicks the
  first of `/live/multiviewers` (LivePremier 6.2.73) and `/live/multiviewer`
  (Midra 3.2.29, Alta 1.3.7) its sidebar links to, matched whole, so neither
  platform's setup multiviewer page can be taken for it. Proved on the Midra
  4K simulator 3.2.29 on 2026-10-16 by handing the page half the payload the
  supervisor sends, with no console.
- **Layer names are `Layer <n>`.** The console shows the layer bus from the
  model; the names the Layer names plugin keeps live on the page side, not
  where this reads.
- **A U5's and U5 Pro's key displays are the console's own.** This publishes a
  model and the console draws from it; there is no path here that pushes a
  picture. The one the API offers takes a *filesystem path on the console*,
  not image bytes. A U5 mini's grid is the exception: it takes PNGs over 17100.
- **Midra 4K / Alta 4K are untried.** The dialect makes the writes spellable
  and nothing here assumes LivePremier, but no Midra has been in the loop.
