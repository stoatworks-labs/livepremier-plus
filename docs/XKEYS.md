# Driving an X-keys — **preview**

> ⚠️ **This has never been run against a panel.** The bytes are the ones Bitfocus Companion drives
> X-keys with, from SuperFly.tv's [xkeys](https://github.com/SuperFlyTV/xkeys) library (MIT), and
> the decoder here reads every report in that library's own recordings of real panels the way the
> library does. Here, though, it has only met a pretend panel, with a LivePremier simulator at the
> far end. That is still not a panel on a desk. Turn it on in rehearsal, not in a show.

P.I. Engineering's **X-keys** are programmable USB keypads: sticks of four to sixteen keys, the
XK-24 and XK-80 grids, the XKE-124 T-bar, foot pedals, jog-shuttles and the X-blox modules. This
makes one drive an Analog Way LivePremier, from the machine LivePremier Plus runs on, with no
browser open. It's off until you turn it on: switch on **X-keys** in Preconfig ▸ LivePremier Plus
→ Plugins, then tick **Drive an X-keys** on its card.

Unlike the ATEM and Barco panels, an X-keys has no engraving to follow: every key is blank, and
every key's job is yours to give it on the card. A model nobody has laid out yet runs a suggested
layout until you change a key.

---

## What the panel is, and why this is in the tray app

An X-keys has no idea what it's for. It's a HID device (vendor `05f3`) that reports which keys are
held and where its T-bar, jog or shuttle is, and lights each key's backlight as it's told. On most
machines MacroWorks or Companion gives the keys their meaning. Here LivePremier Plus does.

So the panel has to be plugged into **the machine LivePremier Plus runs on**, and is held by its
**device host**, the separate program that already holds the Speed Editor and the other USB
panels ([devices/README.md](../devices/README.md)).

⚠️ **Turn the panel off in Companion (and MacroWorks) on that machine.** The panel is opened so
that other programs can see it too, which is how X-keys are meant to be shared, so with both
running every press would act there as well as here. If Companion needs an X-keys, give it a
different one, on a different computer.

### Platforms

| | How the panel is reached | What you need |
|---|---|---|
| **macOS** | hidapi, through node-hid | Nothing, as far as anyone knows: the keys arrive on the panel's own vendor interface, not as a keyboard. Untried with a panel. |
| **Windows** | hidapi, through node-hid | Nothing. The device host loads and looks for one on Windows 11; untried with a panel. |
| **Linux** | hidapi, through node-hid (hidraw) | A udev rule giving your user the panel: [devices/udev/71-xkeys.rules](../devices/udev/71-xkeys.rules). A virtual panel has been driven through the kernel; untried with a real one. |
| **Docker** | — | No USB. |

Only the **first** X-keys found is driven. If you plug in two, the card says so, and the second
one sits there doing nothing.

### Which panels

Every X-keys surface the xkeys library knows, twenty-nine of them, from the XK-4 stick to the
XKE-180 broadcast keyboard and the X-blox modules. The card's **Lay out** picker lists them all,
with how many keys each has and what its backlights can do. The library's interface boards (GPIO,
relays, RS-232, DMX, motor and servo drivers), the trackball and trackpad, the QWERTY keyboard and
the RailDriver aren't keypads and aren't on it.

What a panel can show depends on its backlights:

| backlights | panels | |
|---|---|---|
| **any colour** | XK-24M-RGB, the X-blox modules | every lamp below |
| **blue and red** | XK-24, XK-60, XK-80, XKE-40, XKE-124 T-bar, XKE-128, XKR-32 and the rest | blue, red, both (purple) |
| **blue only** | the XK-4, XK-8 and XK-16 sticks | steady or flashing |
| **none** | the foot pedals, switch interfaces, XK-128 Matrix, XKE-180 broadcast keyboard, XK-433 remote | nothing: keys still work |

---

## Giving the keys their jobs

The card draws the panel, key by key, in its rows and columns. Pick a key (on the card, or by
pressing it on the panel: the key you press becomes the one picked), pick its job, and **Keep this
layout**. Layouts are kept per model, so an XK-24 and an XKE-124 each keep their own.

| job | what it does |
|---|---|
| **Take** | takes every selected screen: preview goes to air |
| **Cut** | cuts every selected screen, with no transition |
| **Program to preview** | copies what's on air into preview, on every selected screen |
| **Fade to black** | fades every selected screen to black, or back up when all of them are black |
| **Freeze** | freezes what's on air on every selected screen, or lets it go |
| **Take time + 0.1 s**, **− 0.1 s** | nudges the take time of every selected screen, between 0.1 s and 10 s |
| **Recall memory** *n* | recalls memory *n* **to preview** on every selected screen, never to air |
| **Input to preview** *n* | input *n* onto the selected layer of every selected screen, in preview |
| **Still to preview** *n* | still *n*, the same way |
| **Screen to preview** *n* | screen *n*, as a source, the same way |
| **Drive this screen** | makes that screen the only one the panel drives, on its first layer |
| **Add or drop this screen** | adds that screen to the ones the panel drives, or takes it out, so a take can cover several |
| **Select layer** *n* | makes layer *n* the one source keys put their source on |
| **Next layer**, **Previous layer** | steps through the active screen's fitted layers |
| **Nothing** | nothing, and the card's history says so when it's pressed |

With nothing selected the first screen is driven: there's always one.

**Every source and every recall lands in preview.** There's no job that puts a source straight on
air, and that's on purpose: a key with no label on it is the easiest thing in the world to press
by mistake.

The **program switch** (the small PS button on the back of most X-keys) is left alone.

### The suggested layout

A model with nothing saved runs this, in reading order, until you change a key:

- the **last** key is **Take**, the one before it **Cut**;
- on a panel of twelve keys or more, the three before those are **Fade to black**, **Freeze** and
  **Program to preview**;
- the first row is **inputs 1, 2, 3…**; on a panel of eight keys or more, the second row is
  **memories 1, 2, 3…**, the third the **screens** (S1, S2…) and the fourth the **layers**.

**Start from the suggestion** on the card puts it back; **Clear every key** gives you a blank one.
A cleared layout is a saved layout, so the suggestion won't creep back.

### The T-bar

On the XKE-124 T-bar, the XKE-64 Jog T-bar and the X-blox T-bar module, the T-bar is the take by
hand, on the selection. A throw from either end is a take; the next goes back the way the first
came. The first reading after the panel connects is only where the lever rests, never a stroke.

The **jog** and **shuttle** have no job yet. Turning one does nothing, and the card's history says
so once.

---

## The lamps

| on an RGB panel | blue and red | blue only | means |
|---|---|---|---|
| **red** | **red** | steady | that source is on air on the selected layer of the screen driven |
| **green** | **blue** | flashing | that source is in preview there |
| **yellow** | **blue** | steady | what's chosen: the screens driven, the selected layer |
| **blue** | dark | dark | what you could choose: a source that exists, a memory that holds something, a key with a job |
| **red** | **red** | flashing | a T-bar stroke is under way (Take); the screens are frozen (Freeze) |
| **red, flashing** | **red, flashing** | flashing | the screens are faded to black (Fade to black) |
| **white** | **purple** | steady | the key you're holding, so you can see the press land |

The panel's own two lamps (the green and red LEDs by the program switch) say how the switcher is:
**green steady** while it answers and **green flashing** while it doesn't; **red** flashes for a
moment when a press was refused, and the card's history says why.

When the panel is let go, by unticking the card, switching the plugin off or quitting the app, it
is left dark.

---

## Tally

Like the other consoles, this holds nothing open on the switcher (`server/console-switcher.js`
says why). Tally, what's on the selected layer of the screen driven in program and in preview, is
read when the panel connects, after every press that changes something, and **every five
seconds**. Names, memories, layers, fade to black and freeze are read every fifteen.

So a take fired from the Web RCS, or from Companion, relights the panel within five seconds, not
at once.

---

## How it's built

```text
  panel ── USB ──▶ devices/modules/xkeys/            finds it, asks for its keys; reports in,
                                                     backlights out
                        │  device host IPC: reports in, lamp reports out
                        ▼
                   plugins/xkeys/supervisor.js       holds the panel; a press → an intent;
                                                     tally read in bursts
                   plugins/xkeys/core.js             the jobs, the suggested layout, the lamps
                   src/core/console-intents.js       what an intent writes, shared with the
                                                     ATEM, Barco EC and Pixelhue panels
                   server/console-switcher.js        the switcher, read in bursts, shared too
                        │  AWJ
                        ▼
                   the switcher
```

The panel's bytes (its reports, its backlight commands and its model table) are in
`src/core/xkeys.js`, with no I/O, so the device host and the plugin read the same thing. The model
table, `src/core/xkeys-products.js`, is generated from the xkeys library's own
(`scripts/gen-xkeys-products.mjs`), so a panel that library learns can be added by running it
again rather than by copying numbers off a datasheet.

---

## What's proven, and what isn't

**Proven here (2026-11-05):**

- The model table is the xkeys library's (3.3.0, commit 3016c1bfec96), generated, not typed.
- The decoder against the xkeys library's own recordings of real panels: every key press, release,
  T-bar, jog and shuttle report in them (2,284 events, from nineteen panels) is read to the key, row,
  column and value the library recorded.
- The backlight and lamp bytes: all 192 recorded commands in those recordings, byte for byte.
- The driver against a pretend panel: found by vendor, product and interface, opened shared,
  asked for its version and its keys, reports through the real device host core, a panel that
  never answers taken as ready after three asks, and an unplug.
- The plugin against a LivePremier store: every job's writes, the suggested layout, the lamps on
  each kind of backlight, a held key, the T-bar stroke, and the panel left dark when let go.
- The whole chain, live (`test/sim/xkeys.sim.test.js`): the pretend panel in the real device host
  core and the app's plugin holding it with no page open, against the LivePremier 6.2.73
  simulator (Aquilon C MAX). Tally read and agreeing with AWJ, an input to preview lit, TAKE, a
  T-bar throw, a key with no job writing nothing, and the panel handed back dark. The ATEM, Barco
  EC and console simulator tests passed beside it, after the helpers they share moved into
  `console-intents.js`.
- **Through a kernel** (`test/sim/xkeys-uhid.sim.test.js`, Ubuntu 24.04): a virtual XKE-124
  T-bar made with Linux uhid, found by the real device host, forked as the app forks it, through
  node-hid on hidraw. Its version and keys asked for and read, the same presses and T-bar throw
  against the simulator, an unplug and a replug while held (seen to go, opened again, relit),
  and hidraw closed and the panel dark when switched off.
- **The device host on Windows 11** with the app's own Node: node-hid loads, the X-keys module
  starts and reports no panel, without an error.
- **The card** in Chrome, Edge and Firefox on Windows 11 and Chromium and Firefox on Ubuntu 24.04,
  against the simulator: drawn, a model picked, a key picked, given a job and saved, and the
  saved layout read back from the server. On Ubuntu, with the virtual panel plugged in, the card
  named it on its first draw and each key pressed on it became the one picked. The Mac's look was
  the desktop app's own browser pane; Safari hasn't been tried.

**Not proven:**

- **Any real panel.** Everything here comes from the xkeys library and its recordings. Companion
  drives real panels with that library, but this app hasn't.
- **Windows, macOS and Linux with a real panel.** Linux's virtual one only behaves as the xkeys
  library says a panel does.
- **The XK-24M-RGB and X-blox colours.** Their bytes match the recordings; nobody has looked at
  what colour comes out.
- **A real frame.** Simulator only. Hardware is ask-first.

### Trying it on a real panel

1. Turn the panel off in Companion and quit MacroWorks on the machine running LivePremier Plus.
2. Plug the panel into that machine. On Linux, install
   [71-xkeys.rules](../devices/udev/71-xkeys.rules) first.
3. Switch on **X-keys** in Plugins and tick **Drive an X-keys**.
4. The card should say *connected* with the model's name, the panel's green lamp should come on,
   and the suggested layout's keys should light. *Found, not answered yet* should last a moment:
   a panel that hasn't answered the request for its keys after three seconds is taken as it is,
   and the app log says so. Write that down if you see it.
5. Against a **simulator** first: press each key and watch the card pick it, give a few keys
   jobs and keep them, then an input, Take, Cut, a screen key, a layer key, Fade to black twice,
   and the T-bar each way if it has one.
6. Write down what was different. In particular: whether the key the card picks is the key you
   pressed (a wrong one means the key table is wrong for that model), whether each lamp lights the
   colour this page says, whether the T-bar reaches both ends, and whether a key ever reports
   twice.
