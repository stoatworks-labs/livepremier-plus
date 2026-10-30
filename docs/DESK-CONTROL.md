# Driving the switcher from a lighting desk — **preview**

> ⚠️ **This has never met a real switcher with a real desk in front of it.** It has driven the
> LivePremier 6.2.73 simulator from a pretend desk sending real Art-Net at a desk's 40 frames a
> second, and the status block at the bottom says exactly what else has been run. Try it in
> rehearsal, not in a show.

A lighting desk — grandMA3, ChamSys MagicQ, Avolites Titan, anything that sends **Art-Net** or
**sACN** — drives the switcher the way it drives a media server: fixtures patched on a universe,
one per screen and one per layer, programmed into cues like everything else on the rig. Recall a
memory, set a layer's source and opacity, take, all from a cue stack, with no browser open.

It is off until you turn it on: switch on **Lighting desk control** in **Preconfig ▸ LivePremier
Plus → Plugins**, then tick **Listen for a lighting desk** on its card.

---

## The fixtures

Three fixture types, each with a GDTF file to import (the card has the downloads):

| Fixture | One per | Channels (Cue mode) |
|---|---|---|
| **LPP Master** | switcher | Control, Memory, Take, Cut — for master memories and every screen at once |
| **LPP Screen** | screen or aux you patch | Control, Memory, Take, Cut |
| **LPP Layer** | layer of that screen | Source folder, Source file, Opacity |

### Screen and Master

| Ch | Name | Values |
|---|---|---|
| 1 | **Control** | 0–63 off · 64–127 the desk edits **preview** · 128–255 the desk edits **program** |
| 2 | **Memory** | 0 nothing · 1–255 recall that memory **to preview** |
| 3 | **Take** | fires on a rise past 50% |
| 4 | **Cut** | fires on a rise past 50% |

### Layer

| Ch | Name | Values |
|---|---|---|
| 1 | **Source folder** | 0 hold · 1 live inputs · 2 stills · 3 screens · 4 backgrounds · 5 colour · 6 none (black) · 7+ hold |
| 2 | **Source file** | 0 hold · 1–255 that input, still, screen or background |
| 3 | **Opacity** | 0–255, a Dimmer: it follows the desk's grand master and blackout |

That is **Cue mode**: the layers carry the source and the opacity, and the switcher's own
memories hold everything else — position, size, crop, borders. Sixteen channels for a screen with
four layers, so one universe covers most rigs, and it fits a desk that counts its parameters.
Compact, Standard and Full modes, which put the geometry on the desk as well, come later.

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

**The desk owns source and opacity.** Whenever something replaces the buffer the desk edits — a
memory recalled into preview, a take — the desk's layer values for that screen are written to it
again. A layer at folder 0 (hold) keeps whatever source the memory gave it; opacity has no hold,
because a Dimmer at zero means dark on every desk.

**Mid-transition, the desk waits.** While a take is running neither buffer is honestly preview or
program, so layer changes for that screen wait until it lands, then go to whichever is preview
now. A recall, take or cut that couldn't go within two seconds of the desk asking is dropped and
listed on the card, not sent late: a take three seconds after the cue is a wrong take.

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
| **grandMA3** | Import the three `.gdtf` files into the fixture library and patch them. |
| **MagicQ** | Open each `.gdtf` in MagicQ's File Manager. MagicQ saves a head file from it (its mode name starts `G-`) and goes to the patch window with it selected; any warnings are in `MagicQ/log/gdtf.log`. |
| **Avolites Titan** | Convert the `.gdtf` files to `.d4` in Personality Builder (Windows), then patch the `.d4`. |
| **grandMA2** | Convert with MA's own GDTF converter; MA2 does not read GDTF itself. |
| **Anything else** | Patch generic dimmer channels at the addresses in the table, or build a fixture from the channel tables above. |

The control channels have names of their own (`LPPControl`, `LPPMemory`, `LPPTake`, `LPPCut`);
the source is `MediaFolder1` / `MediaContent1`, the names media-server fixtures use, and opacity is
GDTF's own `Dimmer`. A desk that doesn't recognise a name still patches it as a plain channel.

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

## What reaches the switcher

Writes go over **AWJ on TCP 10606**, which can be switched off in the Web RCS security settings.
While a desk is driving, the app holds **one** AWJ connection — one of the five the switcher
allows — and lets it go after five seconds with nothing to say. At most 30 bursts a second reach
the switcher however fast the desk sends; a fader pulled through 200 values in that time is one
write of where it stopped. Which preset letter is preview is read from the switcher before every
burst, never remembered, because anything else can take that screen between two bursts.

---

## Not here yet

Planned, in roughly this order: the layer modes (Compact, Standard, Full) with geometry on the
desk; MVR and a patch export for each desk; **bidirectional** — a take on the switcher firing the
desk's "VT state" cue, through the Triggers plugin; **CITP/MSEX** so MagicQ and MA2 see the
switcher as a media server with thumbnails; **NDI** of each screen back to the desk (desktop app
only, for the NDI licence's sake); Titan `.d4` and MA2 fixture files ready-made.

## What has been run

| What | How | Result |
|---|---|---|
| Art-Net and sACN parsing, arbitration, the engine, the patch, GDTF, the held AWJ link, the whole supervisor | `test/desk-control.test.js`: real UDP on loopback, a pretend switcher on AWJ | 27 pass |
| The three `.gdtf` files | validated against the official GDTF 1.2 `gdtf.xsd` with `xmllint --schema` | valid |
| Control → preview, memory recall, Take, let go, ports closing, ArtPoll on the LAN | `test/sim/desk-control.sim.test.js`, the 6.2.73 rack simulator, a pretend desk at 40 frames a second | 5 pass, three runs in a row; S1 and the memory put back each time |
| How long it takes | the same, desk frame to the change on the vendor socket | layer source on preview 26–40 ms; memory recall to preview 28–31 ms |
| A desk on the same Mac hearing ArtPollReply | a socket sharing 6454 beside the app, macOS 26.4 | heard, after replies to this machine went to broadcast (unicast went to the app's own socket) |
| A real desk importing the files and driving it | — | **not yet** |
| A real switcher | — | **not yet** |
