# Triggers

A cue that does more than switch. It unmutes the VT channels on the sound desk, takes the house
lights down and fires the lighting desk's VT state. Then, when Mitti says the video is over, it
puts all of that back and GOes the next cue.

**PLUS ▸ Triggers**, and a **Triggers** field in the Timeline's cue editor. The plugin is
`plugins/triggers/`. It is **off by default**: Preconfig ▸ LivePremier Plus → Plugins.

> ⚠️ **Never yet run against real equipment.** Every format is written from its published
> document (OSC 1.0, Art-Net 4, ANSI E1.31, MIDI 1.0 and MIDI Show Control). The tests read the
> bytes back against those documents and against pretend receivers on this machine. No sound
> desk, node or lighting desk has heard any of it. Prove it on the rig before a show; the end
> of this page says how.

## Three layers

| | What | Belongs to |
|---|---|---|
| **Destination** | A box and how to reach it: OSC to a desk, MIDI over TCP to an Allen & Heath, a universe on Art-Net or sACN | The installation, like a HyperDeck. `triggers.json` |
| **Trigger** | A name, its **go** lines and its **back** lines | The installation, beside its destinations |
| **Cue** | Which triggers to fire, and when to send them back | The show: the cue stack |

## Destinations

| Kind | Port | Notes |
|---|---|---|
| OSC (UDP) | 8000 by default; an X32 is 10023, a Wing 2223, QLab 53000 | One message per line |
| MIDI over TCP | 51325 (Allen & Heath dLive and SQ) | MIDI bytes on a socket kept open. MSC device and format are set on the destination |
| Art-Net | 6454 | `ArtDmx` to the node's address. Universe as `0:0:1` or a number |
| sACN (E1.31) | 5568 | To the universe's multicast group, or to an address. Universe 1–63999, priority 0–200 |

A destination can be switched off without being removed. Its lines then fail, saying so.

**MIDI on a USB or DIN port isn't in this version.** A page could use Web MIDI, but only on the
machine the page is open on. The server would need a native MIDI module, and this app keeps
its one native dependency in `devices/`. Allen & Heath desks take MIDI over TCP, so that's the
first way in.

## Lines

A line starts with the destination's name. The rest is in that destination's own words:

```text
Desk /ch/17/mix/on 1
Desk /eos/cue/1/45/fire
Desk /show/title "Act Two" f:0.5 true
AH note 1 60 127
AH cc 1 7 100
AH pc 1 5
AH msc go 45 list 1
AH hex F0 7F 01 02 01 01 34 35 F7
House 1-4 @ 0 fade 3
House 1,3,5-8 @ 50%
House 1 thru 4 @ full
House 1-4 @ before fade 5
House release
```

- **OSC** arguments are `i` or `f` by how they're written (`1`, `0.5`). `"quoted"` is a string,
  as is any other word. `true` and `false` are `T` and `F`. Say it outright with `i:1`, `f:1`
  or `s:1`.
- **MIDI** channels are 1–16, as a person counts them. `msc` takes `go`, `stop`, `resume`,
  `load`, `fire` (a macro number), `alloff`, `restore`, `reset` and `gooff`.
- **DMX** levels are 0–255, a percentage, `full`, `out` or `before`. A fade is seconds or
  `m:ss`. `release` stops sending the universe.

The longest destination name wins, so `Desk 2 cc 1 7 0` goes to *Desk 2*, not to *Desk* with a 2.
A line that doesn't read is kept. The panel lists it under its trigger with the reason, which is
usually a destination that's been renamed or not added yet.

### `before`

A universe is this app's own, so the "previous state" of a channel is known exactly. When a go
line changes a channel, the level it had is recorded with the cue's hold, and a back line's
`before` puts it back. Fire the same cue twice and it still puts back the look from before the
first. A sound desk's previous state is a different matter: v1 doesn't read it back, so the
back line says what to send.

## In a cue

The Timeline's cue editor has a **Triggers** field:

```text
VT audio; House down; restore when Mitti ends or after 5:00 then go
```

Trigger names, `;` between them, and at most one **restore** clause:

| When | |
|---|---|
| `when <deck> ends` | A HyperDeck's clip ends, as the HyperDecks plugin hears it. Needs that plugin on, with the deck added |
| `after <time>` | `90`, `90s`, `1:30`, `2m` |
| `at next cue` | The next cue this page fires |
| `by hand` | Only from the panel |

Join them with `or`: the first one to happen wins. Then optionally:

| Then | |
|---|---|
| `then go` | GO the stack |
| `then cue 13` | Jump to cue 13 and GO it |

When it's time, the back lines go out **in reverse order**: the last trigger fired is put back
first, the way an undo works.

**Two rules for `then`.** It runs only when the show got there by itself, through a clip end or
the time. A restore that comes at the next cue, or from the panel, means somebody has already moved
the stack, so it's left alone. It also runs only if the stack hasn't moved: the standby must still
be the cue after the one that made the hold. If the operator pressed GO through the end of the
VT, `then go` has already happened, and a second GO would skip a cue. Either way the log says why.

### The example from the top

| Cue | Does |
|---|---|
| 12 *Sizzle reel* | Recalls the VT look and takes; HyperDeck: `Mitti clip 3; Mitti play`; Triggers: `VT audio; House down; LX VT; restore when Mitti ends or after 4:00 then go` |
| 13 *Back to slides* | Recalls the slides look and takes |

Mitti plays. When its cue ends (Mitti's **Pause at end** is what makes the transport stop),
`LX VT`, `House down` and `VT audio` are sent back, in that order, and the stack GOes cue 13.
The `after 4:00` is there because a Mitti cue set to loop never ends.

**Don't also use the deck's own end rule.** HyperDecks' *When a clip ends: Take* and a cue's
`then go` would both switch.

## Where it runs

- **The server sends everything, and keeps the holds.** There's no UDP in a browser. A DMX universe
  is a stream that has to be resent every second, and a background tab's timers get slowed down.
  A clip's end is heard on the server's own link to the deck. So the house lights come back
  up and the desk mutes again **even if the tab that fired the cue was closed mid-VT**.
- **`then` needs the page that fired the cue**, because its cue stack is that page's. Each page gets
  a new id every time it loads. A reloaded or closed page can't take it, and the log says *no page
  did its "then"*.
- **A hold is saved before the go lines are sent**, so the before-levels survive a crash.
- **A hold found at startup is offered, never fired.** It was waiting when the app stopped. The panel
  shows it as *from before the restart*, with **Restore now** and **Discard**. House lights coming
  up on a relaunch mid-show would be worse than waiting for a click.
- **Switching the plugin off releases every universe**, and sACN receivers go back to the desk.

## DMX: whose universe is it?

- **Art-Net from two sources is merged by the node**, HTP or LTP as it's set. If the lighting desk
  sends the same universe, this app and the desk fight over it. Use a universe nobody else sends,
  or fire the desk's own cue over OSC or MSC and let the LD keep control.
- **sACN priority is per universe, not per channel.** A source at 150 wins *every* channel of the
  universe over a desk at 100, not just the ones a line set. For house lights on their own
  universe that's exactly right. `release` sends the stream-terminated packets E1.31 asks for, and
  receivers go straight back to the desk: the most honest "restore" DMX has. Per-channel
  priority (ETC's `0xDD` start code) would let a universe be shared, and isn't in this version.
- **An sACN destination with no address multicasts** to `239.255.<hi>.<lo>`, on the interface the
  operating system routes that through. On a machine with two networks, give it the receiver's
  address instead.

## The panel

- **Waiting to restore**, first, because it's the part that matters mid-show: each hold's cue, what
  it fired, when it ends and a countdown, with **Restore now** and **Discard**. **Restore all** in
  the toolbar puts back everything, newest first.
- **Destinations**, edited in place. A DMX destination that is sending shows how many channels are
  lit, and has **Release**.
- **Triggers**: go and back as text, a line per line, saved when the field loses focus. **Test go**
  and **Test back** send them now.
- **What was sent**: the last few dozen sends and restores, with anything that failed.

## Proving it on the rig

`tools/trigger-sink.mjs` prints whatever arrives, to watch a show's triggers without the gear:

```
node tools/trigger-sink.mjs --osc 9000 --sacn 5568 --artnet 6454 --midi 51326
```

Then, before a show, once per desk and node:

1. **OSC:** Test go on a trigger aimed at a channel nobody is using. Watch it move on the desk.
   Test back.
2. **MIDI over TCP:** the same, with a `cc` or `note` the desk is set to listen to. For MSC, check
   the desk's device id and command format match the destination's.
3. **DMX:** a channel on a universe nobody else sends. `@ full`, then `@ before fade 3`, then
   `release`. On sACN, check the receiver lets go at once.
4. **The hold:** a cue with `restore after 0:10 then go` and a harmless next cue. GO it, then watch
   it come back and GO.
5. **Mitti:** a short cue with **Pause at end**, `restore when Mitti ends then go`. Let it run out.

Note what each box reported, and its firmware, beside the result.

## Files

| | |
|---|---|
| `plugins/triggers/protocol.js` | The wire formats: OSC, ArtDmx, E1.31, MIDI and MSC. No I/O |
| `plugins/triggers/core.js` | Shared by both halves: the shapes, reading lines and the cue field |
| `plugins/triggers/outputs.js` | The sending: one UDP socket, the universes kept, MIDI-over-TCP links |
| `plugins/triggers/server.js` | Routes at `/__lpp/triggers`, the holds, the deck watch, the setup-file section |
| `plugins/triggers/client.js` | The page half: the cue action, `at next cue`, and `then` |
| `plugins/triggers/panel.js` | The panel |
| `tools/trigger-sink.mjs` | A pretend receiver that prints what arrives |
| `test/triggers.test.js` | Formats, lines, the cue field, sending to pretend receivers, holds, a clip end on the emulated deck |
