# Driving a Barco EC panel — **preview**

> ⚠️ **This has never been run against a panel.** The protocol is the one
> [qubered/ec50-panel](https://github.com/qubered/ec50-panel) worked out from USB captures of
> Barco's Event Master Toolset and proved on a real EC-50 under Windows. Here it has only met a
> pretend panel that keeps that protocol's rules down to the bytes, and a LivePremier simulator at
> the far end. That is still not a panel on a desk. Turn it on in rehearsal, not in a show.

A Barco **EC-30**, **EC-40** or **EC-50** is the desk panel for Barco's Event Master processors.
This makes one drive an Analog Way LivePremier instead, from the machine LivePremier Plus runs on,
with no browser open. It is off until you turn it on: switch on **Barco EC panel** in Preconfig ▸
LivePremier Plus → Plugins, then tick **Drive a Barco EC panel** on its card.

The **EC-200 and EC-210 are not supported**, and can't be from here. They are Linux machines that
boot straight into Barco's own build of the Toolset, and nothing documents a way to get their keys
out. They can carry EC-50s plugged into their USB ports, and an EC-50 unplugged from one and plugged
in here works like any other.

---

## What the panel is, and why this is in the tray app

The EC-30, EC-40 and EC-50 have no computer inside. Each is a USB device (`0600:0336`, "Show
Console Board") for whatever machine runs the Toolset: an FTDI FT232H clocking SPI into a CPLD. The
CPLD does nothing on its own. The host reads one register for the key queue and the T-bar, and
writes every key label (64 × 32 pixels, one bit each, on an RGB backlight) and every lamp (red or
green; there is no amber).

So the panel has to be plugged into **the machine LivePremier Plus runs on**, and held by its
**device host**, the separate program that already holds the Speed Editor
([devices/README.md](../devices/README.md)). A browser can't hold it usefully, and nobody wants a
desk panel that only works while a particular tab is open.

**The panel takes one program at a time.** While LivePremier Plus holds it, the Toolset can't, and
the other way round. If the card says *in use by another program*, quit the Toolset; LivePremier
Plus takes the panel within a couple of seconds. Untick the box and it hands the panel back, dark.

### Platforms

| | How the panel is reached | What you need |
|---|---|---|
| **macOS** | libusb, through the `usb` package | Nothing. Nothing on a Mac claims vendor 0x0600. Barco's Mac Toolset reaches the panel the same way. |
| **Windows** | FTDI's own D2XX driver, `ftd2xx.dll`, through `koffi` | The driver the Event Master Toolset installs, or FTDI's from ftdichip.com. ⚠️ **Never replace it with WinUSB (Zadig)**: the Toolset would stop seeing the panel. |
| **Linux** | libusb | A udev rule, [devices/udev/71-barco-ec.rules](../devices/udev/71-barco-ec.rules), then unplug and replug. |
| **Docker** | — | No USB. |

`LPP_FTD2XX` names a different `ftd2xx.dll` if yours isn't on the DLL search path.

---

## What each key does

A Pixelhue console knows what a screen is and only needs telling what this switcher has
([PIXELHUE.md](PIXELHUE.md)). An EC panel knows nothing, so LivePremier Plus does the Toolset's job:
it decides what each key means, draws every label and lights every lamp. The layout follows the
panel's own engraving and an Event Master operator's habits, mapped onto what a LivePremier has.

| the panel | what it does here |
|---|---|
| **DESTINATION** keys (12, paged with the row's up and down keys) | the screens in service, in order. A press adds the screen to the selection; a press on a selected one drops it. The last one picked is the **active** screen. Lamp: green while selected. |
| **LAYER** keys (8, paged with the row's up and down keys) | the active screen's fitted layers. A press selects that layer. Lamp: red for a fitted layer, green for the selected one. |
| **ASSIGN** rows (12 each, each paged with its own up and down keys) | what each row holds — **inputs**, **stills**, **screens as sources** or **memories**, chosen on the card. A source key puts that source on the selected layer of every selected screen, **in preview**. A memory key recalls that memory **to preview** on every selected screen. Labels are the switcher's names; an unnamed input shows as *IN 3*. |
| a row's **LABEL** key | shows what the row holds and which page (*INPUTS 1–12*). A press cycles what the row holds until the card says otherwise. |
| **ALL TRANS** | take, on every selected screen |
| **CUT** | cut |
| **MATCH** | program copied to preview |
| **FREEZE** (program side) | freezes what's on air on every fitted layer of the selection, or lets it go. Red while a selected screen has a frozen layer. |
| **T-bar** | the take, by hand, on the selection. A throw from either end is a take, as on the Toolset: the second goes back the way the first came. |

Any key you're holding lights green, so you can see the press land.

**A recall always lands in preview**, and so does a source change. That's the rule every other
recall path in this app follows.

### Not mapped, and why

Pressing one of these does nothing, and the card's history says why.

| key | why not |
|---|---|
| the background key (9th LAYER key) | a LivePremier background is a background set, not a layer source |
| LAYER TRANS, LAYER CUT, ARM | a LivePremier takes a screen, not a layer |
| FREEZE (preview side) | not mapped yet |
| SHOW CONFIG keys (EC-30 and EC-50) | not mapped |

### Models

All three share one USB id, one button map and one firmware image in Barco's own files. A model
leaves keys out rather than renumbering anything. Pick yours on the card:

- **EC-50**: everything above. The model the protocol was proved on.
- **EC-40**: no SHOW CONFIG keys. Its spec sheet says it has no key displays; Barco's map gives it
  41. Untried either way.
- **EC-30**: no top ASSIGN row, so the card offers the middle and bottom rows only.

---

## Tally

Like the Pixelhue panel, this reads the switcher in short bursts and holds nothing open on it
(`server/console-switcher.js` says why). So the lamps and labels follow the switcher when the panel
connects, after each press that changes it, and every fifteen seconds. A take fired from the Web
RCS does not relight anything here until then.

---

## How it's built

```text
  panel ── USB ──▶ devices/transports/ftdi.js      libusb, or FTDI's D2XX on Windows
                   devices/modules/barco-ec/        the driver: polls keys and the T-bar,
                                                    pushes labels and lamps, latched
                        │  device host IPC: reports in, `command` out
                        ▼
                   plugins/barco-ec/supervisor.js   holds the panel; a press → an intent
                   plugins/barco-ec/core.js         what each key means; what the panel shows
                   src/core/console-intents.js      what an intent writes — shared with Pixelhue
                   server/console-switcher.js       the switcher, read in bursts — shared too
                        │  AWJ
                        ▼
                   the switcher
```

The panel's bytes and its key font are in `src/core/ec-panel.js` and `src/core/ec-font.js`. They
have no I/O, so the device host and the plugin read the same table.

---

## What's proven, and what isn't

**Proven here (2026-10-20):**

- The button table is Barco's own `showConsoleMap.csv`, row for row, as Event Master 9.2 and 10.0.3
  ship it. `test/barco-ec.test.js` compares the two on any machine with a Toolset installed.
- The register framing, the blank framebuffer and the lamp bits match ec50-panel's captures.
- The driver against the pretend panel: MPSSE setup, the LCD controller setup, the reply that lags
  one transaction (its first answer thrown away), keys and the T-bar, labels pixel for pixel, the
  framebuffer sent twice so neither bank is stale, lamps latched, a panel the Toolset holds, an
  unplug and a replug.
- The libusb road against a pretend `usb` package: libftdi's requests, and every packet's two
  status bytes dropped.
- The D2XX road through koffi against a stand-in `ftd2xx` compiled on a Mac: the prototypes,
  out-parameters and async calls.
- The whole chain, live (`test/sim/barco-ec.sim.test.js`): the pretend panel in the real device
  host core, the app's plugin holding it with no page open, against a LivePremier 6.2.73
  simulator. A screen picked, an input onto its preview, ALL TRANS, the T-bar both ways, and the
  panel handed back dark.

**Not proven:**

- **Any real panel.** The MPSSE setup, the latency, the 5 ms poll and the T-bar's travel all come
  from ec50-panel's EC-50 under Windows.
- **libusb on macOS against VID 0x0600.** Nothing should claim it, and Barco's Mac Toolset uses
  libusb, but nobody has said so from a desk.
- **D2XX on Windows.** The binding runs against a stand-in, never against FTDI's real library.
- **The EC-30 and EC-40**, beyond Barco's map.
- **A real frame.** Simulator only. Hardware is ask-first.

### Trying it on a real panel

1. Quit the Event Master Toolset. On Windows, leave its driver alone.
2. Plug the panel's USB into the machine running LivePremier Plus, and power it.
3. Switch on **Barco EC panel** in Plugins, tick **Drive a Barco EC panel**, pick the model.
4. The card should say *connected*, and the ASSIGN keys should show the switcher's names. If it
   says *found, not held*, the device host can see it but couldn't open it: the card says why.
5. Against a **simulator** first: a destination key, a layer key, an input, ALL TRANS, a T-bar
   throw each way. Then FREEZE, MATCH, a memory, and the paging keys.
6. Write down what was different. In particular, whether every label reads the right way up and
   unbroken across the middle of the key (the right half's one-row skew), whether the T-bar reaches
   both ends, and whether a key ever reports twice.
