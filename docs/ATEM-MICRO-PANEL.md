# Driving an ATEM Micro Panel — **preview**

> ⚠️ **This has never been run against a panel.** The protocol is the one Bitfocus Companion drives
> the panel with, from Julian Waller's
> [node-blackmagic-controller](https://github.com/Julusian/node-blackmagic-controller), and its
> handshake is the Speed Editor's, which this app has answered on a real Speed Editor. Here the
> Micro Panel itself has only met a pretend one, with a LivePremier simulator at the far end. That
> is still not a panel on a desk. Turn it on in rehearsal, not in a show.

The Blackmagic **ATEM Micro Panel** is a small desk panel for Blackmagic's ATEM switchers: two
buses of ten, M/E select, CUT, AUTO, a T-bar and the usual transition and key buttons. This makes
one drive an Analog Way LivePremier instead, the way an ATEM operator would expect it to, from the
machine LivePremier Plus runs on, with no browser open. It's off until you turn it on: switch on
**ATEM Micro Panel** in Preconfig ▸ LivePremier Plus → Plugins, then tick **Drive an ATEM Micro
Panel** on its card.

The **ATEM Micro Camera Panel** is a different panel with a different job, and isn't supported.
Nor are the Ethernet panels (the 1 M/E, 2 M/E and 4 M/E Advanced Panels and the Camera Control
Panel): they connect to a switcher over the network, and talking to them means pretending to be an
ATEM, which is a project of its own.

---

## What the panel is, and why this is in the tray app

The Micro Panel has no switcher in it, and nothing like a mind of its own. It's a USB or Bluetooth
HID device (`1edb:bef0`) for whatever computer it's plugged into. On that computer, ATEM Software
Control reads its keys and its T-bar and sets every key's colour itself; the panel just reports
and lights up as told. Here LivePremier Plus stands where ATEM Software Control normally would.

So the panel has to be plugged into, or paired with, **the machine LivePremier Plus runs on**, and
held by its **device host**, the separate program that already holds the Speed Editor
([devices/README.md](../devices/README.md)). The two are one family on the wire, and they share a
driver.

⚠️ **Quit ATEM Software Control on that machine.** It drives the same panel the same way, and the
panel is opened so that both can see it (macOS insists). With both running, every press would
switch your ATEM as well as your LivePremier, which is exciting in all the wrong ways. If you need
ATEM Software Control for the ATEM, run it on a different computer from the panel.

The panel says nothing until the host answers a challenge it sets, and it asks again every few
minutes. LivePremier Plus answers it, and keeps answering it, as it does for the Speed Editor.

### Platforms

| | How the panel is reached | What you need |
|---|---|---|
| **macOS** | hidapi, through node-hid, over USB or Bluetooth | Nothing for USB. For Bluetooth, pair the panel in System Settings first. Neither has been tried with a Micro Panel. |
| **Windows** | hidapi, through node-hid | Nothing, as for the Speed Editor. Untried. |
| **Linux** | hidapi, through node-hid | Probably a udev rule giving your user `1edb:bef0`, as for any HID device. Untried. |
| **Docker** | — | No USB. |

---

## What each key does

The layout follows the panel's engraving and an ATEM operator's habits, mapped onto what a
LivePremier has. SHIFT, held, gives every row its second half: the second ten sources, the next
four screens, the next five layers.

| the panel | what it does here |
|---|---|
| **M/E 1–4** (SHIFT: 5–8) | the screens in service, in order. A press makes that screen the one the panel drives, as an M/E key does on an ATEM. **Hold one M/E key and press another** to add a screen to the selection or take one out, so a take can cover several. With nothing selected, the first screen is driven: there is always an M/E 1. |
| **BKGD**, **KEY 1–4** (the NEXT TRANSITION row; SHIFT: layers 6–10) | the active screen's fitted layers, in order: BKGD is the first. A press selects that layer. |
| **PREVIEW 1–10** (SHIFT: 11–20) | source *n* onto the selected layer of every selected screen, **in preview**. Key *n* is input *n*, as on an ATEM, so an input that isn't in use leaves a gap rather than shuffling the rest along. |
| **PROGRAM 1–10** (SHIFT: 11–20) | **tally only**: red on what's on air. See [The program row](#the-program-row). |
| **KEY 1 ON AIR**, **KEY 2 ON AIR**, **KEY 3 ON AIR** | what the buses hold: **inputs**, **stills** or **screens as sources**. Inputs to start with. |
| **MACRO** | a latch. While it's lit, PREVIEW *n* recalls **memory *n*** to preview on every selected screen (SHIFT: 11–20), and the program row rests. Press it again to go back to sources. |
| **CUT** | cut, on every selected screen |
| **AUTO** | take, on every selected screen |
| **T-bar** | the take, by hand, on the selection. A throw from either end is a take: the second goes back the way the first came, as on an ATEM. |
| **DSK 1 CUT** | freeze what's on air on every fitted layer of the selection, or let it go |
| **DSK 1 AUTO** | program copied to preview |
| **DSK 2 AUTO** | fade to black, or back up. One answer for the selection: if anything selected is up, everything fades. |

**A recall always lands in preview**, and so does a preview-row source change. That's the rule
every other recall path in this app follows.

### The program row

On an ATEM, the program row cuts straight to air. That's the whole point of it, and it's also the
quickest way to put the wrong thing on a forty-metre LED wall.

So here it shows tally and does nothing else until you tick **Program row cuts to air** on the
card. Then a PROGRAM press puts that source on the selected layer of every selected screen **in
program**: on air at once, with no take and no transition. The card says so in red while it's on.

The tick isn't saved. It's forgotten when the panel is switched off and when the app restarts, so
a show never inherits it from the one before.

### Not mapped, and why

Pressing one of these does nothing, and the card's history says why.

| key | why not |
|---|---|
| MIX, DIP, WIPE, DVE, STING, ARM | a LivePremier screen has one transition, set on the switcher; the style keys aren't mapped |
| PREV TRANS | a LivePremier has no transition preview to send |
| KEY 4 ON AIR | no fourth kind of source to put on the buses |
| DSK 1 TIE, DSK 2 TIE, DSK 2 CUT | not mapped |

---

## The lamps

Each key shows one of eight colours, on or off. There's no dimming, so a key with nothing on it is
dark.

| colour | means |
|---|---|
| **red** (program row) | that source is on air on the selected layer of the active screen |
| **green** (preview row) | that source is in preview on that layer |
| **yellow** | what's chosen: the screens driven, the selected layer, what the buses hold, MACRO latched, SHIFT held |
| **blue** | what you could choose: a screen, a fitted layer, a kind of source; under MACRO, a memory slot that holds something |
| **white** | CUT, AUTO and the DSK keys with a job |
| **red** (AUTO, DSK 1 CUT, DSK 2 AUTO) | a T-bar stroke is under way; a selected screen is frozen; a selected screen is faded |
| **cyan** | the key you're holding, so you can see the press land |

The T-bar's meter fills as a stroke goes, and is dark between strokes.

---

## Tally

An ATEM-style bus is mostly tally, so it's read more often than the other consoles read anything.
Like them, this holds nothing open on the switcher (`server/console-switcher.js` says why). Tally,
which is what's on the selected layer of the active screen in program and in preview, is read in
one short burst when the panel connects, after every press that changes something, and **every
five seconds**. Names, memories, layers, FTB and freeze are read every fifteen.

So a take fired from the Web RCS, or from another panel, relights the buses within five seconds,
not at once.

---

## How it's built

```text
  panel ── USB or Bluetooth ──▶ devices/blackmagic-hid.js       finds it, answers its challenge,
                                devices/modules/atem-micro-panel/  renews it; reports in, lamps out
                        │  device host IPC: reports in, one lamp report out
                        ▼
                   plugins/atem-micro-panel/supervisor.js   holds the panel; a press → an intent;
                                                            tally read in bursts
                   plugins/atem-micro-panel/core.js         what each key means; what the panel shows
                   src/core/console-intents.js              what an intent writes — shared with the
                                                            Pixelhue and Barco EC panels
                   server/console-switcher.js               the switcher, read in bursts — shared too
                        │  AWJ
                        ▼
                   the switcher
```

The panel's bytes (its key table, handshake, reports and lamp layout) are in
`src/core/atem-micro-panel.js`. They have no I/O, so the device host and the plugin read the same
table. `devices/blackmagic-hid.js` was the Speed Editor's driver, moved unchanged apart from
taking its ids, handshake and battery from a model.

---

## What's proven, and what isn't

**Proven here (2026-10-20):**

- The key table is node-blackmagic-controller's, code for code and lamp bit for lamp bit.
  `test/atem-micro-panel.test.js` holds it to that table's own shape (fifty keys, codes 1–50, each
  lamp three bits at 13 + 3 × code, clear of the T-bar meter's sixteen).
- The handshake against a pretend panel that checks the answer with the same arithmetic that
  passed on a real Speed Editor, on report 5, at ten bytes.
- The driver against the pretend panel, and beside a pretend Speed Editor: each opens only its own.
- The Speed Editor's driver after the move into `blackmagic-hid.js`: its tests, unchanged, pass.
- The whole chain, live (`test/sim/atem-micro-panel.sim.test.js`): the pretend panel in the real
  device host core, the app's plugin holding it with no page open, against a private copy of the
  LivePremier 6.2.73 simulator (Aquilon C MAX). Tally read and agreeing with AWJ, a preview pick,
  the program row refusing until ticked and then cutting to air, AUTO, a T-bar throw, and the panel
  handed back dark with the tick forgotten. The Barco EC panel's simulator test passed beside it,
  after its T-bar arithmetic moved to `console-intents.js`.

**Not proven:**

- **Any real panel.** The key codes, the lamp bits, the report ids and the handshake's report all
  come from node-blackmagic-controller. Companion drives real panels with it, but this app hasn't.
- **Which end of the T-bar meter is segment 0**, and whether the T-bar's report really runs 0 to
  4096 end to end.
- **Bluetooth.** node-blackmagic-controller says the panel shows the same ids there; nobody here
  has paired one.
- **The battery**: only its level is decoded, as node-blackmagic-controller does, and that library
  marks it as untested.
- **Windows and Linux.**
- **A real frame.** Simulator only. Hardware is ask-first.

### Trying it on a real panel

1. Quit ATEM Software Control on the machine running LivePremier Plus.
2. Plug the panel's USB-C into that machine (or pair it over Bluetooth).
3. Switch on **ATEM Micro Panel** in Plugins and tick **Drive an ATEM Micro Panel**.
4. The card should say *connected*, M/E 1 should be yellow, and PROGRAM and PREVIEW should show the
   switcher's tally. If it says *found, not answered yet*, the panel refused the handshake: the
   card says why.
5. Against a **simulator** first: M/E 1 and 2, a layer key, a PREVIEW key, AUTO, CUT, a T-bar throw
   each way, SHIFT with a PREVIEW key, MACRO with a PREVIEW key, then DSK 2 AUTO twice.
6. Write down what was different. In particular: whether every key lights the colour this page
   says (a key that lights the wrong colour has its bits in the wrong order), which end the T-bar
   meter fills from, whether the T-bar reaches both ends, whether a key ever reports twice, and
   what the battery reads.
