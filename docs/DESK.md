# The desk: a keypad, seven knobs and a strip screen (**preview**)

> ⚠️ **No desk has been built.** There's no controller, no keypad and no strip screen. This has
> only been driven from a pretend controller (a CoreMIDI virtual source on the same Mac) against
> the LivePremier 6.2.73 rack simulator, and the table at the bottom says what has been run. When
> the first desk exists, test it in rehearsal before it goes anywhere near a show.

The LivePremier Plus desk is a control surface drawn in `stoatworks-labs/lpp-control-surface`
(private, prototype one). Left to right: two Stream Deck modules for Companion, a 10 × 5 Mynah
keypad, four small encoders and three big wheels, all on one USB MIDI controller, plus an ASUS
PA147CDV touch screen (1920 × 550) along the back. The Stream Decks are Companion's job. This
plugin, **Desk (control surface)**, handles everything else:

- **The keypad types Mynah.** Each key puts one whole word on a Console line, exactly as if you'd
  typed it, and **Please** runs the line.
- **The knobs move the selected layer.** That goes through MIDI Mapping's engine (awj-surface)
  with the `lpp-surface-p1` profile, and the wheels have pages.
- **The strip screen shows the lot:** the scope, the line, what Enter would do, the wheel pages,
  and a cell over every knob.

## Switching it on

1. Switch on **Desk (control surface)** in **Preconfig ▸ LivePremier Plus → Plugins**. It needs
   the **Console** plugin, which is on unless you've turned it off.
2. Open **Desk**, under PLUS in the sidebar, and press **Enable MIDI**. The browser asks once.
   After that the desk starts listening on its own every time the page loads.
3. It opens the one MIDI input whose name contains **LPP Surface**. If there isn't exactly one,
   it lets you pick, and remembers the pick by name.
4. **Open the screen** puts the strip screen's page in a window of its own. Drag it onto the
   PA147CDV and press ⤢ for full screen.

Web MIDI needs Chrome or another Chromium browser, on this app's own address (`127.0.0.1` is
fine; a LAN address isn't, unless it's served over HTTPS).

**One browser, one desk.** The desk holds a Web Lock while it listens. A second tab finds it
taken, says so and stays deaf, because two tabs would type every word twice, and a TAKE pressed
once would take twice: the take, then the take back.

**Don't** start MIDI Mapping on the desk's port as well. It has no such lock, and with this
profile every knob would move everything twice. That's why the profile isn't on MIDI Mapping's
list.

## The keypad

| Key | What it does |
|---|---|
| A word (Screen, Recall, Thru, Preview…) | Adds that word to the line, with a space. Whole words only. There are no short forms, because mynah works its abbreviations out from the whole vocabulary and they change when a keyword is added. |
| **0–9** | Digits run on into a number: `1` then `2` is `12`. |
| **%** | Joins the number before it (`50%`; mynah won't read `50 %`). With no number before it, it does nothing. |
| **Please** | Runs the line, then empties it. |
| **TAKE** | Runs `Take` **at once** for the sticky scope, whatever is half-typed, and leaves the line alone. It's the GO button. |
| **Shift + TAKE** | Types the word `Take` instead, for a one-off scope: `Take Screen 1 Thru 4`. |
| **Shift** | Held, not latched. |
| **Oops** | Takes back the last word. `12` counts as one word, and so does a quoted label. |
| **Clear** | Mynah's Clear: the line first, then on an empty line the scope. A mistyped command is never one key away from losing the scope it was going to act on. |
| **Source, Size, Position, Opacity, Category** | On an empty line they choose what the wheels drive. With anything on the line they type their word, which is where the grammar wants them (`Set Screen 3 Layer 2 Position 100 200`). |
| **U1** | Nothing yet. The screen says so. |
| **Label** | Types `Label`. The name needs letters, so plug a USB keyboard in: it types into the screen's line. There's no on-screen keyboard yet. |

### The sticky scope

`Select Screen 1 + 3` and Please sets the desk's **scope**, shown in the amber badge. After that,
a line with no target of its own (`Recall Memory 5`, `Take`) acts on it. Clear on an empty line
clears it. Only the desk's line keeps a scope; the Console tab and its pop-out still don't.

### Program

Nothing reaches program unless you say so. **Program** is the only key that types `Program`, and a
`Recall` with no buffer named goes to preview, as it always has in mynah. While you type, the line
under the command line says what Enter would do and ends with one of these:

- **nothing reaches program**, in green;
- **REACHES PROGRAM**, in white: a Take, an audio command, or a Recall or Set that names Program;
- **can't tell whether this reaches program**, in amber, for raw AWJ or OSC, which this doesn't
  try to second-guess.

TAKE is a take, so it reaches program by definition.

## The knobs

The encoders and wheels move **the selected layer on preview**. The selection follows the scope's
first screen and first layer, so `Select Screen 2 Layer 3` points them at S2 layer 3. A scope with
no screen in it (an aux on its own), or no scope at all, leaves them where they were. The screen
shows where they are: `ENCODERS AND WHEELS — S2 L3 preview`.

| Knob | MIDI | Drives | Push |
|---|---|---|---|
| E1 | CC 16 | Opacity | back to its default |
| E2 | CC 17 | Crop left, 4 px a click | back to its default |
| E3 | CC 18 | Border width | back to its default |
| E4 | CC 19 | Take time, both ways, 0.1 s a click | back to its default |
| Wheel A, B, C | CC 20, 21, 22 | depends on the page, below | — |

| Page | Wheel A | Wheel B | Wheel C |
|---|---|---|---|
| **Position** | X | Y | — |
| **Size** | Width | Height | Both, in 16:9 steps (16 px by 9 px a click) |
| **Opacity** | Opacity | — | — |
| **Crop** | Left | Right | Top and bottom together |
| **Source** | Input number | — | — |
| **Border** | Width | Height | Opacity |

Choose a page by tapping its tab on the strip screen, or with an attribute key on an empty line.
Category has no page of its own, so it steps through the pages no key names: Crop, then Border.
The wheels don't accelerate: a click is one step however fast you spin, and for position, width,
height and crop a step is one pixel. The small encoders do accelerate.

## The strip screen

It's 1920 × 550 and drawn to the desk's own mock-up (`docs/screen.svg` in the hardware repo). It
doesn't borrow the vendor's stylesheet, because a vendor restyle mustn't move a cell off its knob.
The whole page scales to fit the window, and it is never reflowed.

- **Top bar:** the scope badge, the command line, what Enter would do, the switcher, and the MIDI
  input or what's wrong with it. `SHIFT` shows while Shift is held.
- **Left:** the last four lines run and what each did.
- **Right:** the wheel-page tabs.
- **Bottom:** a cell over each knob, at the pixel KEYPAD.md gives it, with a tick pointing straight
  down at it. E1 sits 39 px in, so its cell is cut back at the edge rather than slid inwards.

The screen only draws. The desk itself runs in the Web RCS tab, so the keypad keeps typing and
TAKE keeps taking with the screen window closed. Close the Web RCS tab, though, and the screen
says it has lost the switcher.

## What it expects from the controller

A class-compliant USB MIDI device on **channel 1**, named so that **LPP Surface** appears in it
(the firmware is expected to call itself `LPP Surface P1`).

- **Keypad:** note on = 24 + row × 10 + column, from the keymap in the hardware repo's
  `docs/KEYPAD.md`. A big key answers on its first switch's note and ignores the others: TAKE on
  54 (55, 64 and 65 ignored), Please on 63 (73 ignored), 0 on 70 (71 ignored). A firmware that
  sends all four of TAKE's notes still takes once, which matters, because a second take is the
  take back. A note on at velocity 0 counts as a note off.
- **Encoders:** relative CCs 16–22 in two's complement (1–63 clockwise, 127–65 anticlockwise).
  Pushes are notes 96–99.

`test/desk.test.js` checks the key table against `KEYPAD.md` when a checkout of the hardware repo
sits at `~/hardware/video/lpp-control-surface`, or wherever `LPP_DESK_KEYPAD` points. With neither,
that one test is skipped.

## Decided without the hardware

These were judgment calls, made with nothing to press. Look at them first when there's a desk:

- **Category steps through Crop and Border**, the pages no key names.
- **Size on Wheel C moves both in 16:9 steps.** Crop on Wheel C is top and bottom together.
- **E4 sets both take times**, up and down, at 0.1 s a click. Crop on E2 is 4 px a click.
- **The port is found by the name `LPP Surface`.** The firmware hasn't been written yet, so that's
  a promise it will have to keep.
- **The wheel ranges** in the profile assume a canvas up to 3840 × 2160.
- **U1 does nothing**, and **Label has no on-screen keyboard**, though KEYPAD.md promises one.

## Testing it without a desk

The pretend controller is a CoreMIDI virtual source called `LPP Surface P1`. It needs no IAC
Driver and no change to Audio MIDI Setup. About thirty lines of Swift will do it:
`MIDISourceCreateWithProtocol`, then `MIDIReceivedEventList` with a MIDI 1.0 word per message.
Read commands from stdin (`press 27`, `cc 20 5`) so a script can drive it.

Driving a browser with Playwright: Chromium 149 refuses `requestMIDIAccess`, even without sysex,
unless **both** `midi` and `midi-sysex` are granted for the origin. In a real browser it's one
prompt.

## What has been run

| What | How | When | Result |
|---|---|---|---|
| Key → word, digits, `%`, Oops, Clear, Shift+TAKE, paging, second switches, channel filter | `test/desk.test.js`, against a real Console line on a 6.2.73 capture | 2026-10-30 | pass |
| Key table and knob pixels against `KEYPAD.md` | the same file, reading the hardware repo | 2026-10-30 | pass |
| Recall + Please goes to `PREVIEW`; only Program reaches program | the same file | 2026-10-30 | pass |
| The whole desk from MIDI bytes (port choice, Web Lock, wheels to preview) | the same file, fake Web MIDI | 2026-10-30 | pass |
| Words on the strip screen, scope badge, the line under the line | Chromium 149 + the virtual source, rack simulator 6.2.73 | 2026-10-30 | pass |
| `Recall Memory 1` + Please lands in preview, program untouched | the same, witnessed over AWJ | 2026-10-30 | pass |
| Wheel A moves Position X, E1 moves Opacity, and both cells follow | the same | 2026-10-30 | pass |
| TAKE with all four switches takes S1 once; with no scope it takes nothing | the same | 2026-10-30 | pass |
| Size and Category page the wheels | the same | 2026-10-30 | pass |
| A real controller, a real keypad, the PA147CDV, a real switcher | — | — | **not run: none of them exists, except the switcher** |
| A touch on the strip screen's tabs | — | — | **not run**: clicked, not touched |
