# Driving a Maschine MK3 — **preview**

> ⚠️ **This has never been run against a Maschine.** Its bytes are rewritten from OpenAV Ctlra's
> MK3 driver ([openAV-Ctlra](https://github.com/openAVproductions/openAV-Ctlra), BSD-3-Clause), with
> a few facts checked against other people's MK3 drivers, and here it has only met a pretend panel.
> That is not a panel on a desk. Turn it on in rehearsal, not in a show.

Native Instruments' **Maschine MK3** is a drum machine's controller: sixteen RGB pads, eight group
keys, eight endless knobs under two colour screens, a touch strip and a transport row. This makes
one drive an Analog Way LivePremier from the machine LivePremier Plus runs on, with no browser
open, and uses the two screens to say what every key and knob does. It's off until you turn it on:
switch on **Maschine MK3** in Preconfig ▸ LivePremier Plus → Plugins, then tick **Drive a Maschine
MK3** on its card.

Only the MK3. The Maschine Mikro, Maschine+, Maschine MK2 and the newer Maschine models are
different panels on the wire, and aren't supported.

---

## What the panel is, and why this is in the tray app

A Maschine has no switcher in it and nothing like a mind of its own. It's a USB device
(`17cc:1600`) with two halves: a HID interface for its keys, knobs, pads, strip and lamps, and a
vendor interface that takes the pixels for its two 480 × 272 screens. On a normal machine,
Native Instruments' **NIHostIntegrationAgent** holds both for Maschine 2 and Komplete Kontrol.
Here LivePremier Plus stands where that agent would.

So the panel has to be plugged into **the machine LivePremier Plus runs on**, and held by its
**device host**, the separate program that already holds the Speed Editor, the ATEM Micro Panel
and the X-keys ([devices/README.md](../devices/README.md)). The keys and lamps go through node-hid;
the screens go through libusb, which the host already carries for the Barco EC panel.

⚠️ **Quit NIHostIntegrationAgent while this drives the panel.** It hears every press too, and it
holds the screens, so with it running the card says *connected, no screens*. It's a login item, not
something in the Dock: quit it in Activity Monitor (search *NIHost*), or untick it in System
Settings ▸ General ▸ Login Items. It comes back at the next login, and when Maschine 2 or Komplete
Kontrol opens, so quit those too.

### Platforms

| | Keys and lamps | Screens |
|---|---|---|
| **macOS** | hidapi, through node-hid. Untried. | libusb. Untried; works only with NIHostIntegrationAgent quit. |
| **Windows** | hidapi, through node-hid. Untried. | Probably not: Native Instruments' driver owns the panel, and libusb needs WinUSB on the screen interface. Replacing NI's driver would stop Maschine 2 seeing the panel, so don't. The keys, pads and lamps still work. |
| **Linux** | hidapi, through node-hid (hidraw). Needs [devices/udev/71-maschine-mk3.rules](../devices/udev/71-maschine-mk3.rules). Untried. | libusb, with the same rule. Untried. |
| **Docker** | — | No USB. |

---

## What each control does

The two screens label the eight buttons above them (the **soft keys**) along their top edge, and
the eight knobs below them along their bottom edge. Pad numbers are Maschine's own: pad 1 at the
bottom left, pad 16 at the top right. SHIFT, held, gives the group keys and pads their second
bank and makes the knobs fine.

| Control | Does |
|---|---|
| **GROUP A–H** | The screens in service, in order (SHIFT: the next eight). A press makes that screen the one the panel drives. Hold one and press another to add it or take it out, for several at once. |
| **Pads 1–16** | Pad *n* puts input *n* on the selected layer, **in preview**, on every selected screen (SHIFT: 17–32). Pad *n* is input *n*, not the *n*th input there is, so an unused input leaves a dark pad. |
| **Soft keys 1–4** | What the pads hold: **INPUTS**, **STILLS**, **SCREENS**, or **MEMORIES** (pad *n* recalls memory *n* to preview). |
| **Soft key 5** | **MATCH**: program to preview. |
| **Soft key 6** | **FREEZE** what's on air, or unfreeze. |
| **Soft key 7** | **FTB**: fade to black, or back up. |
| **PLAY** | **Take**, on the selection. |
| **RESTART** | **Cut**, on the selection. |
| **Touch strip** | A T-bar. See below. |
| **Encoder** (turn, or push left and right) | The selected layer: the previous or next fitted layer of the screen driven. |
| **Knobs 1–5** | The selected layer **in preview**, on every selected screen: **OPACITY**, **POS X**, **POS Y**, **WIDTH**, **HEIGHT**. SHIFT moves them a tenth as far. |

STOP, REC, soft key 8, knobs 6–8 and every other key have no job yet. Pressing one says so on the
right-hand screen and in the card's history.

**Everything lands in preview**: sources, memories and the knobs. Only a take, a cut, the strip and
fade to black change what's on air.

### The touch strip

A touch strip has no lever, so the panel keeps one: the **lit dot** on the strip is where it is.
Touch the strip at the dot and slide, and the transition follows your finger; slide all the way to
the other end and the take is made, and the dot is then at that end, so the next take slides back.
Lift your finger half way and the transition stays half way, as a T-bar left mid-throw would: touch
the dot where you left it to carry on.

A touch anywhere else on the strip does nothing (and the screen says to touch the dot), so a hand
resting on it can't jump a transition half way.

### The knobs

Turning a knob reads where that value is on each selected screen, then moves each by the same step
as you turn: a layer at different places on two screens moves the same distance on both. The
screen shows the value in yellow while it's being turned. Opacity crosses its whole range in a
thousand counts of the knob; position and size move a pixel a count. How many counts a turn is
hasn't been measured on a real panel.

---

## The lamps and screens

| | Lamp |
|---|---|
| Group key | Yellow: driven. Blue: a screen in service. Dark: none. |
| Pad | Red: on air on the selected layer. Green: in preview there. White: an input there is. Blue: a memory (MEMORIES). Dark: nothing. Cyan while held. |
| Soft keys 1–4 | Bright: what the pads hold. Dim: available. Dark: the switcher has none. |
| FREEZE, FTB | Bright while a selected screen is frozen or faded. |
| PLAY | Bright during a strip stroke. |
| Strip | One white dot: the lever. Red, from the end it started at to your finger, during a stroke. |

**The left screen** shows what the pads hold, the screen driven and its selected layer, and what's on
that layer in program (**PGM**, red) and preview (**PVW**, green), by input name.

**The right screen** shows MATCH, FREEZE and FTB (red while frozen or faded), every screen being
driven, the pads' bank, the strip's progress during a stroke, and the last thing the panel said:
a refusal, a take, why a key did nothing.

Along the bottom of both, the five knobs' names and values, as last read.

### Tally

Nothing here follows the switcher live (`plugins/pixelhue/supervisor.js` says why), so tally and the
knobs' values are **read**: a small burst of `get`s for the selected layer of the screen driven,
after every press that changes it, when the panel connects, and every five seconds. Names,
memories, layers, FTB and freeze are read every fifteen. A take fired from the Web RCS relights the
pads within five seconds, not at once.

---

## How it's built

```text
  panel ── USB ──▶ devices/modules/maschine-mk3/   HID: reports in, lamp reports out
                                                   libusb: screens drawn here from a scene
                        │  device host IPC: reports in; lamps and scenes out
                        ▼
                   plugins/maschine/supervisor.js  holds the panel; a press → an intent;
                                                   knob edits; the strip; reads in bursts
                   plugins/maschine/core.js        what each control means; the lamps; the screens
                   src/core/console-intents.js     what an intent writes, shared with every console
                   server/console-switcher.js      the switcher, read in bursts, shared too
                        │  AWJ
                        ▼
                   the switcher
```

The panel's bytes (its reports, button table, lamp slots and the screens' command set) are in
`src/core/maschine-mk3.js`, with no I/O, so the device host and the plugin read the same table.

A screen is 261 KB of pixels and a command to the device host is at most 64 KB, so the plugin sends
each screen as a **scene**: a short list of fills and labels (`src/core/raster.js`), a few
kilobytes. The device host draws it, turns it into the panel's RGB565, and sends only the rows that
changed since that screen's last frame. A screen with a frame on its way keeps only the newest one
waiting. The plugin sends a screen only when its scene differs from the last one sent.

---

## What's proven, and what isn't

**Proven here (2026-11-25), against a pretend panel only:**

- The bytes against the layout Ctlra documents: the button table (every bit and lamp once, the knob
  touches backwards), the controls and pads reports, the lamp slots and the screen packets, which
  read back to the pixels they were cut from (`test/maschine.test.js`).
- The driver against a pretend panel and pretend libusb: found, opened shared only while wanted,
  screens claimed, only changed rows sent; without libusb, or with the screens held by someone
  else, the keys and lamps still work and the card says why.
- The real device-host process with stand-ins for node-hid and libusb: a press crosses the IPC
  channel, both lamp reports fit the host's 64-byte limit, and both screens' scenes fit a command.
- The plugin end to end against a pretend switcher: tally on the pads and screens, a pad to
  preview, memories, take, cut, fade to black, a knob edit written in preview, a strip touch
  refused away from the dot, a strip throw to a take, and the panel handed back dark and blank.

**Not proven:**

- **Any real panel.** In particular: whether libusb can claim the screens while node-hid has the
  keys, on any platform; the mono lamps' brightness range; which way round the strip's lamps and
  values run; the pad order (Ctlra's says pad 0 is top left); how many knob counts a turn is; the
  colours the palette entries really show; and how fast the screens repaint.
- **The simulator.** The plugin hasn't run against a LivePremier simulator yet, only a pretend
  switcher. Its writes are the same `console-intents.js` writes the ATEM Micro Panel and X-keys
  make, which have.
- **Windows and Linux.**
- **A real frame.**

### Trying it on a real panel

1. Quit Maschine 2, Komplete Kontrol and NIHostIntegrationAgent on the machine running LivePremier
   Plus.
2. Plug the Maschine's USB into that machine, and its power supply if the port can't power it.
3. Switch on **Maschine MK3** in Plugins and tick **Drive a Maschine MK3**.
4. The card should say *connected, screens on*, GROUP A should be yellow, and the pads should show
   tally. *connected, no screens* means the keys work but libusb couldn't claim the screens: the
   card says why.
5. Against a **simulator** first: GROUP A and B, a pad, soft keys 2 and 4 with a pad each, PLAY,
   RESTART, the encoder, each knob both ways with and without SHIFT, a strip throw each way, a
   touch away from the dot, and soft key 7 twice.
6. Write down what was different, in NOTES.md: whether every lamp lights the colour this page
   says, which end the strip's dot starts at, whether the pads light under the finger that hit
   them, how far a knob turn moves a value, and whether the screens keep up with a knob.
