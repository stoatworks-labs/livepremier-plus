# Driving the switcher from a lighting desk — **preview**

> ⚠️ **This has never met a real switcher.** It has driven the LivePremier 6.2.73 simulator from
> ChamSys MagicQ PC on the same Mac and from a pretend desk sending real Art-Net at a desk's 40
> frames a second, and MagicQ has imported its patch and found it as a CITP media server. The
> status block at the bottom says exactly what has been run. Try it in rehearsal, not in a show.

A lighting desk — grandMA3, ChamSys MagicQ, Avolites Titan, anything that sends **Art-Net** or
**sACN** — drives the switcher the way it drives a media server: fixtures patched on a universe,
one per screen and one per layer, programmed into cues like everything else on the rig. Recall a
memory, set a layer's source, opacity, position, size and look, take, all from a cue stack, with
no browser open. And the other way: a take on the switcher can fire the desk's "VT state" cue.
The whole patch comes as an **MVR** file for the desk to import, with ready-made fixture files for
Titan and grandMA2 as well, and the switcher can show up on the desk as a **CITP** media server, its
sources listed with thumbnails. In the desktop app it can also send the desk **NDI** pictures of
each screen and its layers, for the desk's video window.
A grandMA3 can also drive the switcher with nothing patched, from its executors through the OSC
it already sends: that is the **grandMA3** plugin, [GRANDMA3.md](GRANDMA3.md).

It is off until you turn it on: switch on **Lighting desk control** in **Preconfig ▸ LivePremier
Plus → Plugins**, then tick **Listen for a lighting desk** on its card.

---

## The fixtures

Three fixture types, each with a GDTF file to import (the card has the downloads), and four modes,
the same four in every file, so a desk patches everything in one of them:

| Fixture | One per | Channels |
|---|---|---|
| **LPP Master** | switcher | Control, Memory, Take, Cut — for master memories and every screen at once; 4 in every mode |
| **LPP Screen** | screen or aux you patch | Control, Memory, Take, Cut; 4 in every mode |
| **LPP Layer** | layer of that screen | 3, 11, 24 or 53, by mode |

| Mode | A layer | What the desk owns |
|---|---|---|
| **Cue** | 3 ch | Source and opacity. The switcher's memories hold everything else. One universe covers most rigs. |
| **Compact** | 11 ch | + position X, Y and size W, H, 16-bit. For grandMA3 onPC and other desks short of parameters. |
| **Standard** | 24 ch | + crop, colour (for the Colour folder), flip, strobe. |
| **Full** | 53 ch | + mask, aspect, effect, border, shadow, key. Every layer property worth a fader. |

A screen with four layers is 16 channels in Cue, 48 in Compact, 100 in Standard, 216 in Full.
MA counts a 16-bit channel as one parameter, so a Compact layer is 7 of them.

### Screen and Master

| Ch | Name | Values |
|---|---|---|
| 1 | **Control** | 0–63 off · 64–127 the desk edits **preview** · 128–255 the desk edits **program** |
| 2 | **Memory** | 0 nothing · 1–255 recall that memory **to preview** |
| 3 | **Take** | fires on a rise past 50% |
| 4 | **Cut** | fires on a rise past 50% |

### Layer

Each mode is the one before it with more on the end, so a cue programmed in Cue mode means the
same thing in Full.

| Ch | Name | Values | Modes |
|---|---|---|---|
| 1 | **Source folder** | 0 hold · 1 live inputs · 2 stills · 3 screens · 4 backgrounds · 5 colour · 6 none (black) · 7+ hold | all |
| 2 | **Source file** | 0 hold · 1–255 that input, still, screen or background | all |
| 3 | **Opacity** | 0–255, a Dimmer: it follows the desk's grand master and blackout | all |
| 4–5 | **Position X** (16-bit) | pixels from the centre of the screen, 32768 the centre | Compact up |
| 6–7 | **Position Y** (16-bit) | the same, down the screen | Compact up |
| 8–9 | **Width** (16-bit) | 0 the memory's look · 1–65535 pixels | Compact up |
| 10–11 | **Height** (16-bit) | 0 the memory's look · 1–65535 pixels | Compact up |
| 12–19 | **Crop** left, right, top, bottom (16-bit each) | pixels | Standard up |
| 20–22 | **Red, Green, Blue** | the colour of a layer whose folder is 5 (colour); ignored otherwise | Standard up |
| 23 | **Flip** | 0–63 none · 64–127 H · 128–191 V · 192–255 H+V | Standard up |
| 24 | **Strobe** | 0 off · 1–255 slow to fast | Standard up |
| 25–32 | **Mask** left, right, top, bottom (16-bit each) | pixels | Full |
| 33 | **Aspect** | 0–50 none · 51–101 1:1 · 102–152 centred · 153–203 full screen · 204–255 cropped | Full |
| 34 | **Effect** | 0–31 none · 32–63 black and white · 64–95 negative · 96–127 sepia · 128–159 solarise · 160–191 posterise · 192–255 none | Full |
| 35–42 | **Border** style, radius, width, height, opacity, red, green, blue | style: 0–31 off, then edge, smooth, rounded and their mixes in steps of 32 | Full |
| 43–52 | **Shadow** style, radius, X (16-bit), Y (16-bit), opacity, red, green, blue | X and Y −512 to 512 px, 32768 none | Full |
| 53 | **Key** | 0 off · 1–50 key slot 1–50 · 51–255 off | Full |

A Midra 4K or Alta 4K has no posterise, strobe or key; those channels do nothing there (and the
Midra side of this has only been run against a pretend switcher).

---

## The rules a show depends on

**A screen ignores the desk until its Control channel says otherwise.** A desk that has just been
patched, sitting at zero, changes nothing at all. Raising Control is the desk taking that screen
over, and at that moment every layer value the desk holds for it is written. Lower it and the
screen is let go; the desk's layer channels then do nothing to it.

**Preview or program is the desk's choice, per screen.** At 64–127 the layer channels edit preview,
and the cue that follows takes it. At 128 and above they edit what is on air, live, as a media
server's layers would. The settings card shows which, and flags program.

**Nothing fires on the first frame.** The first frame from a desk — after this app starts, after
the desk restarts, after a backup desk takes over — only sets where every channel is. A desk
sitting with Take at full when the app restarts doesn't take. Take and Cut fire on a rise past
50% seen after that, and Memory recalls when it changes to something that isn't zero.

**A memory recall goes to preview, always**, as every other recall in this app does. Reaching air
costs a Take.

**One cue, in order.** A cue that recalls a memory, changes a layer and takes, all at once, happens
in that order: the memory loads, the layer goes on top of it, and the take carries both. The app
waits a beat after a recall before anything else on that screen, because a memory is still
loading when its recall has been sent.

**The desk owns what its mode has channels for.** Whenever something replaces the buffer the desk
edits — a memory recalled into preview, a take — the desk's layer values for that screen are
written to it again. A layer at folder 0 (hold) keeps whatever source the memory gave it; opacity
has no hold, because a Dimmer at zero means dark on every desk.

**Size 0 is the memory's look.** While a layer's Width or Height is at zero, everything past
source, opacity and colour — position, size, crop, flip, strobe, mask, effect, border, shadow,
key — is the memory's, and the desk writes none of it. A desk sitting at zero edits nothing a
memory set up. Raise both and the desk owns the lot; drop either back to zero and the memory's look
returns with the next recall or take.

**X and Y are pixels from the centre of the screen**, 32768 being the centre, so a layer at the
defaults sits in the middle at whatever size W and H give it. The app reads the screen's size from
the switcher when it writes a position; a screen whose size it can't read gets no position, and
the card says so.

**Mid-transition, the desk waits.** While a take is running neither buffer is honestly preview or
program, so layer changes for that screen wait until it lands, then go to whichever is preview
now. A take of the desk's own isn't believed to have started until the switcher says it has
landed: the simulator goes on reporting the state the take left for the whole of the take, so
after a take or cut the screen's layer values wait until that changes, or until the take has had
its own time and a second and a half more (a take the switcher refused never changes it). A
recall, take or cut that couldn't go within two seconds of the desk asking is dropped and listed
on the card, not sent late: a take three seconds after the cue is a wrong take.

---

## Patching

The card shows the patch, and **Patch .csv** downloads it. From the first universe you set: the
Master (if ticked), then each screen you list followed by its layers. A screen and its layers
never straddle two universes, so a cue that changes a layer and takes the screen arrives in one
packet. The patch only changes when you change the settings — the switcher's own preconfig never
moves it under a show.

Universes are numbered as a desk numbers them, from 1: Art-Net 0:0:0 is universe 1, and sACN
universe 1 is universe 1. Check your desk's own setting for that; MagicQ, for one, can be told to
count Art-Net from 0 or 1.

## Getting the fixtures into the desk

| Desk | What to do |
|---|---|
| **grandMA3** | Import **Patch .mvr**, the patch and its fixture types in one file, or import the three `.gdtf` files into the fixture library and patch them by hand. The MVR hasn't been tried on an MA3 yet. |
| **MagicQ** | **Patch .mvr** patches the lot in one go (below). By hand: open each `.gdtf` in MagicQ's File Manager (**Setup → File Manager**). It asks which mode; pick the one you set on the card. MagicQ saves a head file from it (its mode name starts `G-`) and goes to the patch window with it selected. MagicQ 1.9.6.5 warns that the files are GDTF 1.2 and it reads 1.1, shows Control as **Lamp**, reads X and Y as its own position, and doesn't recognise the other names below; every channel still patches and works. The warnings are in `MagicQ/log/gdtf.log`. Its **Locate** sets Flip to 255 (H+V) and the colour to white: harmless while Width or Height is 0, but set Flip back to 0 before giving a layer a size. |
| **Avolites Titan** | **Titan .d4** is the three personalities, ready-made. Put them in `Documents\Titan\Personalities` on Titan PC (`D:\Personalities` on a console), where Titan looks for its users' own, and patch them at the addresses in **Patch .csv**. Titan has no MVR import. Not yet tried in a real Titan. |
| **grandMA2** | **grandMA2 .xml** is every fixture type ready-made: MA2 has one mode per fixture type, so it's twelve files, `stoatworks@lpp_layer@cue.xml` and so on. Put the ones for your mode in the user library (`C:\ProgramData\MA Lighting Technologies\grandma\gma2_V_<version>\library` on onPC) and import them as fixture types from there. Not yet tried in a real MA2. |
| **Anything else** | Patch generic dimmer channels at the addresses in the table, or build a fixture from the channel tables above. |

The control channels have names of their own (`LPPControl`, `LPPMemory`, `LPPTake`, `LPPCut`);
the source is `MediaFolder1` / `MediaContent1`, the names media-server fixtures use, and opacity is
GDTF's own `Dimmer`. A desk that doesn't recognise a name still patches it as a plain channel.

The Titan and MA2 files use each desk's own names in the same places. In the `.d4`, opacity is
Titan's `Dimmer`, red, green and blue are its `Red`, `Green` and `Blue`, so its colour picker
drives them, and the rest are `LPP_…` in the attribute group a Titan operator would look in: source
under Gobo, position and size under Position, crop and mask under Beam, the look under Effects,
control under Special. In the MA2 files opacity is `DIM`, the source is MA's media server pair
`MEDIASERVERINPUTDIRECTORY` / `MEDIASERVERINPUT`, colour is `COLORRGB1` to `3`, and the rest are
`LPP_…` under Position, Shapers, Beam or the Video preset, with the names MA gives an attribute it
doesn't have yet. **Locate** never touches Control, so locating a fixture can't take a screen.

### The patch as MVR

**Patch .mvr** on the card is the whole patch as one file: MVR 1.6, the format grandMA3, MagicQ,
Vectorworks and Capture import, with the fixture files inside, so a desk that has never seen these
fixture types needs nothing else.

- **Fixture IDs follow the switcher, not the patch order.** The Master is 1, screen S*n* is *n*00
  and its layers *n*01, *n*02 and so on, aux A*n* is 5000 + *n*00. Adding a layer or a screen
  renumbers nothing already patched. MagicQ takes the fixture ID as the head number.
- **Importing it again updates rather than doubles**: each fixture's UUID in the file is the same
  every time, for the same fixture on the same switcher.
- **One MVR layer per screen**, holding its Screen fixture and its layers; the Master has its own.
- Positions are a tidy row so a 3D view doesn't stack them all in one spot. A video layer has no
  place on a stage, so don't read anything into them.

**In MagicQ** (1.9.6.5): put the `.mvr` in `Documents/MagicQ/show`, open **Setup → File Manager**
and select it. Import into a show with those addresses free. Into the demo show, which already has
dimmers where the layers go, it patched nothing; a second try hung MagicQ, which had to be
force-quit. Into an empty show it patched every fixture at the card's addresses, numbered as above.
MagicQ names each head after its fixture type, not the screen or layer it is.

---

## Art-Net and sACN

**Both are on by default.** Art-Net on UDP 6454, sACN on UDP 5568 (multicast groups joined for
each patched universe, unicast too). The **Network** picker chooses which interface the app
answers on; left on automatic, it answers on whichever is on the desk's own subnet.

**This listens on the network**, whatever address the app itself is bound to — nothing else in
this app does that by default. **Only these desks** is the lock: list the desks' addresses and
nothing else can drive the switcher. Discovery (ArtPoll) is still answered, so a desk on the
wrong address can see why nothing happens.

**One desk is in control of each universe.** A video switcher can't merge two desks the way a
dimmer can, so:

- **Highest sACN priority wins.** Art-Net has no priority and counts as 100, sACN's default.
- **A backup desk at a lower priority is a tracking backup**: it takes over when the main desk
  stops (2.5 seconds without sACN, or the desk saying it has stopped; 10 seconds for Art-Net).
  Its first frame is a baseline, as above, so a takeover never fires a take.
- **Equal priority: the same desk every time** (the lowest address), not whoever booted first.
- **sACN preview data never drives anything.** A fifth desk on one universe is ignored and the
  card says so.

**ArtPoll** is answered as a media server (Art-Net style `StMedia`), listing the patched universes,
so the desk's node list shows the app. A desk on the same machine as the app is answered by
broadcast, because two programs sharing port 6454 can't both have a unicast reply.

**ArtTimeCode** from the desk goes to the **Timecode** plugin, as if it had been pushed there, so a
Timeline can chase the desk's clock.

### A desk on the same Mac

Desk software on the machine running this app (MagicQ PC, grandMA3 onPC) works, with four things
to know:

- **The desk's own address has to be one of the Mac's.** MagicQ's **Setup → Network → IP
  address** starts at a 2.x.x.x address no Mac has, and then sends nothing at all.
- **Whoever opened UDP 6454 first gets what is sent to one address.** Both programs listen on
  6454, and macOS hands a unicast packet to one of them only. A desk sending to 127.0.0.1 reaches
  this app only if the app was listening first: start the app, then the desk. After restarting the
  app, make the desk open its Art-Net again (in MagicQ, change the network IP address and change
  it back). Broadcast reaches both, whatever the order.
- **To keep it off the LAN**, set MagicQ's **Art-Net type** to *V4 Unicast only* and unicast the
  universe to 127.0.0.1. In *Normal* it broadcasts every universe to the LAN as well.
- **MagicQ's own node list stays empty** (**Net Manager → View Art-Net**): it shows nothing from
  its own address, not even itself. It drives the switcher all the same.

## What reaches the switcher

Writes go over **AWJ on TCP 10606**, which can be switched off in the Web RCS security settings.
While a desk is driving, the app holds **one** AWJ connection — one of the five the switcher
allows — and lets it go after five seconds with nothing to say. At most 30 bursts a second reach
the switcher however fast the desk sends; a fader pulled through 200 values in that time is one
write of where it stopped. Which preset letter is preview is read from the switcher before every
burst, never remembered, because anything else can take that screen between two bursts.

---

## The switcher back to the desk

A take on the switcher — from its front panel, the Web RCS, a T-bar, another console — can fire
a cue on the desk: the VT goes to air and the desk goes to its "VT state". This side sends nothing
itself; it fires triggers in the **Triggers** plugin ([TRIGGERS.md](TRIGGERS.md)), which already
speaks OSC, MIDI, MIDI Show Control, Art-Net and sACN to whatever the desk listens to. So switch the
Triggers plugin on, make a trigger whose **Go** lines send the desk what its cue needs, then on the
desk control card tick **Fire triggers when the switcher takes** and add a rule:

| Screen | Memory | Fires |
|---|---|---|
| a screen, or blank for any | a memory number, or blank for any | a trigger from the Triggers plugin |

"When S1 takes memory 12, fire VT state". Rules are checked in order, every one that matches fires,
each trigger once per take, and a rule fires at most once in half a second, so a take seen twice
can't fire twice. It works with **Listen for a lighting desk** off: a desk that takes no orders
from Art-Net can still be told when the switcher takes.

**What counts as a take.** The switcher pushes nothing, so the app reads each watched screen's
transition and the memory in each preset buffer ten times a second, over the same held AWJ
connection as the desk's writes (a rule for any screen watches the screens patched on the card).

- **A transition starting** fires at once, with the memory going to air, so the desk's cue runs
  alongside the switcher's transition. A real switcher reports the transition in progress; the
  6.2.73 simulator doesn't (it reports the old resting state for the whole take).
- **A transition that is just over**, with no start seen — a cut, a take faster than a read, or
  the simulator — fires on landing, with the memory now on program. About a second late after a
  one-second take, on the simulator.
- **A take and its landing are one take**, fired once. A T-bar pulled part way and back has fired
  already; nothing takes that back.
- **A memory recalled straight to program** fires like a take.

**Never an echo.** A take the desk itself asked for through desk control isn't fired back to it:
the app knows which screens it has just taken, and the next take it sees on one of those is that
one. Otherwise a desk cue that takes the switcher and is also fired by the take is a loop. The card
counts the takes it saw, the triggers it fired and the echoes it didn't.

If the Triggers plugin is off, a matching take says so on the card instead of firing.

---

## The switcher as a media server (CITP)

Tick **Be a media server for the desk (CITP)** on the card, and a desk that speaks CITP finds the
switcher the way it finds a media server. That's MagicQ, grandMA2 and Titan; not grandMA3, which
has no CITP. What the desk gets:

- **Libraries, which are the Layer fixture's source folders**: Live inputs, Stills, Screens,
  Backgrounds, Colour, None, in Folder order. A library's DMX value is its Folder value and
  element *e* is File value *e* + 1, so whatever the desk shows against a number is what that
  number selects. A gap in the numbering is listed as one, by name.
- **Thumbnails**, which are the switcher's own snapshots of its inputs and stills, fitted inside
  the size the desk asks for. A screen, a background, colour and black have no snapshot and get a
  plain card of one colour.
- **What each layer has in program** (MSEX layer status), as library, element and name, four
  times a second. The layers are read from the switcher once a second while a desk is connected,
  and not at all while none is.
- **A preview of each live input**: its snapshot, about once a second. That's all the switcher
  offers: it streams no video of its own.
- **Where each layer is patched**, with the Layer fixture type's id, for a desk that patches from
  CITP.

**It only reports.** The desk still drives the layers over Art-Net or sACN; nothing that arrives
over CITP writes to the switcher.

**On the wire:** UDP 4809, announcing itself every second to CITP's multicast groups
(239.224.0.180 and the older 224.0.0.180) on every interface, or only the one the **Network**
picker names; TCP 4811 for desks to connect to, or another port if 4811 is taken (the card says
which). MSEX 1.0, 1.1 and 1.2, whichever the desk asks in; up to eight desks at once. **Only these
desks** applies here too: a desk not on the list is hung up on before it is told anything.

### MagicQ

1. Patch the layers: the MVR is the quick way.
2. **Setup → View System → Media**, on a free server line: **Type** *CITP MSEX* (Return steps
   through the list), **IP** the machine this app runs on, the first Layer head's number and how
   many layers, **Thumb con** *Enabled*, **Live prev** *Yes*.
3. **GET THUMBS**.

MagicQ 1.9.6.5 ignores the announcement and connects straight to TCP 4811 at that IP, so if the
card says the app got another port, free 4811. It speaks MSEX 1.0, asks for every library, takes
their thumbnails as small JPEGs and keeps them in `Documents/MagicQ/thumbs/<ip>/`. Its preview asks
for frames in 1.0, and it has no socket on UDP 4809 to hear a multicast frame with, so a 1.0 desk
gets its frames down its own TCP connection.

**What it did:** listed all six libraries with their names and DMX values, and showed a live
preview in its Media window at about a frame a second, colours right. That was with the Layer
head edited in MagicQ's head editor: **Media → Server Type** set to *CITP MSEX*, and channels 1
and 2 moved from FX1 and FX2 (where its GDTF import puts `MediaFolder1` and `MediaContent1`) to
Gobo1 and Gobo2, as MagicQ's own media-server heads have them. Whether the preview needs those two
edits wasn't checked.

**What it didn't:** the Media window's grid of thumbnails to pick a source from never appeared,
with or without those edits, and nothing in MagicQ showed what each layer has in program. So pick
sources by Folder and File number, as without CITP.

---

## Pictures back to the desk (NDI)

Tick **Send pictures to the desk over NDI**, and the app puts NDI feeds on the network for a desk's
video window, the way a media server shows its outputs:

- **LivePremier Plus S1**, one for each patched screen: its program as the switcher has it, each
  patched layer drawn where it sits, bottom first at its opacity, with its source's snapshot (or a
  card of one colour where there's no snapshot) and an outline and label, "L2 IN3 Camera 3 50%".
  A band across the top names the screen and its size.
- **LivePremier Plus layers**: every patched layer as a tile, "S1 L1" over its source's picture and
  name, so the programmer can see what each Layer fixture has on air.
- **LivePremier Plus S1 L1** and so on, one per layer, with **A feed per layer too** ticked.

**Size** is 720p or 1080p for the screens and the tiles; a layer's own feed is 640 × 360.

**It's a drawing, not video.** The switcher streams nothing of its outputs, so each picture is
drawn from what it does offer: the layers' sources, sizes, positions and opacities, read once a
second, and its snapshots of the inputs and stills. About a frame a second, and only while somebody
is receiving: with nobody watching, the switcher isn't read at all. Effects, crops, masks, borders
and transitions aren't drawn.

**The desktop app only.** NDI goes out through the media host (`devices/README.md`), which loads
the NDI runtime from the machine, so install [NDI Tools](https://ndi.video/tools) (or set
`NDI_RUNTIME_DIR_V6`). The card says which runtime it found, and how many are receiving each feed.
The Docker image has no NDI, as NDI's licence has it.

**Which desks take it in:** grandMA3, and MagicQ from 1.9.8. Titan dropped NDI in v19 and takes
RTSP instead (below). None has received these feeds yet; only the tests' own NDI receiver has.

NDI® is a registered trademark of Vizrt NDI AB.

## Not here yet

**RTSP** for Titan 19.2, which takes video over RTSP rather than NDI: waiting for a Titan user to
ask for it.

## What has been run

| What | How | Result |
|---|---|---|
| Art-Net and sACN parsing, arbitration, the engine, the four modes and their 16-bit channels, the patch, GDTF, the MVR, the held AWJ link, the whole supervisor, the layer look on the NLC and Midra paths, a take the switcher reports late or never, takes seen and fired, the echo guard, the card | `test/desk-control.test.js`: real UDP on loopback, a pretend switcher on AWJ; `test/triggers.test.js` for the service another plugin fires | 48 + 21 pass |
| CITP: the messages in MSEX 1.0, 1.1 and 1.2, libraries and layers from the patch, thumbnails fitted and encoded, and the server end to end — announcement, versions, libraries, thumbnails, layer status, previews multicast for 1.1 and over TCP for 1.0, a library changing, the desk list | `test/desk-citp.test.js`: a pretend desk on loopback | 21 pass |
| The three `.gdtf` files, version 2 | validated against the official GDTF 1.2 `gdtf.xsd` with `xmllint --schema` | valid |
| Control → preview, memory recall, Take with the desk's level arriving on the new preview, let go, Compact geometry from the screen's centre at the size the switcher reports, a take on the switcher firing a trigger heard over OSC, the desk's own take not fired back, ports closing, ArtPoll on the LAN | `test/sim/desk-control.sim.test.js`, the 6.2.73 rack simulator, a pretend desk at 40 frames a second | 7 pass, three runs in a row; S1 and the memory put back each time. With the take guard switched off the Take test fails, as it should |
| How long it takes | the same, desk frame to the change on the vendor socket | layer source on preview 26–40 ms; memory recall to preview 28–32 ms; Compact position on preview 36–41 ms; after a 1.0 s take, the desk's level on the new preview 1.04–1.17 s after the cue; a take written by someone else to the trigger heard over OSC 1.02–1.14 s (the simulator only shows the landing) |
| NDI: the drawing (fills, outlines, pictures stretched, text), the screen, tiles and per-layer scenes, labels kept apart, the runtime found or said missing on each platform, the media host's feeds, frames, connection counts, and a host killed mid-show restarted with its feeds made again | `test/desk-ndi.test.js`: a pretend NDI runtime in a real forked host | 18 pass |
| The Titan `.d4` and grandMA2 files | `test/desk-control.test.js`: every mode's channels once and in order, 16-bit coarse then fine, an encoder each, MA's 24-bit ranges without gaps, the same bytes every time; `xmllint` on all 15 files | well-formed. Not checked against MA's schema, and Avolites publishes none |
| The NDI runtime itself | the media host's code sending to a receiver in another process, NDI 6.3.2 on macOS 26.4 | 13 frames of 1280 × 720 received, colours within 3 levels of what was sent after NDI's compression |
| NDI from the running app, live: both feeds found by NDI discovery under their names, S1's picture matching the simulator's program layer by layer, the tiles, a change on the switcher reaching the picture, the feeds gone when switched off | `test/sim/desk-ndi.sim.test.js`, the 6.2.73 rack simulator, a receiver in the test standing in for the desk; one write (S1 layer 1 opacity, put back) | 5 pass, four runs (three in a row with the CITP and desk-control simulator tests). First S1 frame 1.1–1.3 s after connecting; an opacity change in the picture 0.25–0.6 s after it was written; S1 gone from discovery within 15 s of switching off. The simulator has no snapshots, so every source was drawn as its card |
| The app itself with NDI on | `node server/index.js` with the media host, the settings put through the API | "media: host up — NDI 6.3.2.0"; both feeds on the network; SIGTERM stopped the app and the host |
| CITP and the MVR from the running app, live: a desk connecting over TCP, the 1.2 session, the layers where they are patched, the simulator's inputs as the live library, layer status matching S1's program, a thumbnail, the announcement on the LAN, the `.mvr`, Titan and grandMA2 downloads | `test/sim/desk-citp.sim.test.js`, the 6.2.73 rack simulator, a pretend MSEX 1.2 desk; read-only | 7 pass, six runs in a row; 8 with the Titan and grandMA2 downloads, three runs in a row. It failed four runs in five first: a desk connecting during the app's first read of the switcher cut that read short (fixed). The simulator has no snapshots, so every thumbnail it served was a card |
| A desk on the same Mac hearing ArtPollReply | a socket sharing 6454 beside the app, macOS 26.4 | heard, after replies to this machine went to broadcast |
| **ChamSys MagicQ PC 1.9.6.5** (demo mode) on the same Mac, macOS 26.4, Cue mode | the three `.gdtf` files imported through File Manager and patched at 1.1, 1.5, 1.9, 1.12; Control, a layer's source, Take and Control set by hand in MagicQ's programmer, Art-Net over loopback | Imported with warnings only. Control raised: the layer went to preview, program untouched. Take took S1. Control lowered let the screen go, and a layer change after it wrote nothing (MagicQ's packet checked on the wire). The first takes found the desk's layers re-written to the letter going to air instead of the new preview; fixed, and the take re-run from MagicQ put them on the new preview |
| **MagicQ again, Standard mode**, the version 2 files | Screen and Layer imported (MagicQ offered all four modes) and patched at 1.5 and 1.9; X, Y, W, H, Flip and Crop set in MagicQ's programmer; then switcher-to-desk on, with a rule firing an OSC trigger at a listener standing in for the desk | Imported with warnings only. With Control at preview: W 960 and H 512 put a 960 × 512 layer on the simulator's preview, X 486 px left of centre put it at 474, program untouched; X back to 32768 centred it (85 ms from MagicQ's packet to the simulator), Flip 100 flipped it horizontally (19 ms), Crop left 256 cropped it (111 ms). A take written to the simulator by another client fired the trigger, heard 1.09 s after the take was written and 52 ms after its landing was seen. A take MagicQ asked for (Take channel to 255) landed 1.04 s later and was counted as the desk's own: nothing fired |
| **MagicQ, the MVR** | `livepremier-plus-patch.mvr` (Standard mode, Master, S1 and two layers) imported through File Manager | Into the demo show, whose dimmers sit where the layers go: patched nothing, and a second try hung MagicQ (force-quit). Into an empty show: Master at 1-001 head 1, Screen 1-005 head 100, layers 1-009 head 101 and 1-033 head 102. Heads named after their type |
| **MagicQ, CITP** | media server type *CITP MSEX* at this Mac's address, thumbnails and live preview on, the app on the simulator; frames from a test pattern, since the simulator has no snapshots | Connected to TCP 4811 directly, MSEX 1.0, no CInf, nothing on UDP 4809. All six libraries listed with names and DMX values, thumbnails fetched (JPEG 64 × 46). No preview until frames went down its TCP connection; then the Media window showed it, about once a second, colours right. The thumbnail grid and layer status: **never seen** |
| A real desk receiving the switcher's take | MagicQ PC in demo mode locks its OSC, MIDI, timecode and remote-trigger inputs | **not yet** |
| From a real desk: Memory, Cut, the Master fixture, a cue stack rather than the programmer, sACN, Full mode | — | **not yet** |
| grandMA3, Titan | — | **not yet** |
| The `.d4` files in Titan, the MA2 files in grandMA2 | — | **not yet** |
| A desk receiving the NDI feeds | MagicQ here is 1.9.6.5, which has no NDI; grandMA3 onPC wasn't used | **not yet** |
| The MVR in grandMA3 or Vectorworks; CITP from grandMA2 or Titan; a desk patching layers from CITP, which is what would check the Art-Net net and universe in each layer's DMX source string | — | **not yet** |
| Thumbnails and previews of real pictures | the simulator has no snapshots; it needs a real switcher | **not yet** |
| A real switcher, which reports a transition in progress: the take firing at its start | — | **not yet** |
| A Midra 4K or Alta 4K | the paths, against a pretend switcher only | **not yet** |
