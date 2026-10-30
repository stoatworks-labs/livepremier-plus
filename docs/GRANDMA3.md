# grandMA3

**Settings ▸ grandMA3** — a grandMA3 desk, or grandMA3 onPC with a command or fader wing, driving
the switcher from its own executors, with no browser open. A Go+ can take a screen, a fader can be
a T-bar or a layer's opacity, a Flash can recall a memory: whatever one of this app's
[OSC addresses](OSC.md) does.

> ⚠️ **Preview. Never run against a wing or a desk.** It was built from the messages grandMA3
> onPC 2.4.2.2 sent on a Mac with no wing attached, and proved with that onPC driving the rack
> simulator (see [Proven, and not](#proven-and-not)). It is **off by default**: Preconfig ▸
> LivePremier Plus → Plugins → grandMA3. Treat the first show with it as a rehearsal.

## How it works

The desk is left doing what it does. grandMA3 can send OSC by itself whenever a playback moves —
an OSC line with **Send** on — and every fader, key and knob that acts on a sequence or a master
goes out as one message about that playback:

```text
  /ma3/14.14.1.6.1 ,sif  FaderMaster 1 63.5          a fader, 0–100 %
  /ma3/14.14.1.6.1 ,sis  Go+ 1 "Take S1 2 Cue"        a key: 1 pressed, 0 released, and the cue it went to
  /ma3/14.14.1.6.1 ,si   Flash 0                      a key with no cue to name
  /ma3/14.14.1.6.1 ,sii  FaderMaster 0 -1             a knob's nudge (not mapped yet)
```

This app's OSC input hears them, and the grandMA3 plugin answers everything under `/ma3/`. Each
message is matched against the plugin's **lines**, which you write:

```text
  14.14.1.6.1 Go+         -> /lp/screen/1/take
  14.14.1.6.2 Go+         -> /lp/screen/1/memory/5/recall
  14.14.1.6.3 FaderMaster -> tbar S1 S2
  14.14.1.6.4 FaderMaster -> /lp/screen/1/preset/a/layer/2/opacity/opacity/norm
  14.14.1.6.5 Flash       -> /hyperdeck/Mitti/play      # anything after # is a note
```

The left side is what the desk sends: the playback's address and the function. The right side is
one of this app's OSC addresses, with at most one value after it, or `tbar` and the screens it
throws. Then:

| What moved | Target | What happens |
|---|---|---|
| A key (Go+, Go−, Flash, Toggle, Temp, Off, …) | an address | sent once when the key goes **down**; the release sends nothing |
| A fader | an address ending `/norm`, with no value | its position, 0–1, follows the fader — one write at a time, the newest position waiting behind it |
| A fader | `tbar S1 …` | a T-bar: the first reading is where it rests; a throw to the other end is a take, and the throw back is the next one |
| A fader | any other address | a button: fires once on the way **up past 50 %**, and not again until it has been back **below 5 %** |
| A knob | anything | nothing yet |

A message the desk sends that has no line is **heard and listed**, never an error: most of a
desk's playbacks have nothing to do with video.

It goes through the same path a packet from QLab takes, so the same rules hold: **recalls go to
preview**, and a layer over OSC is addressed by its buffer letter (`/a`, `/b`, `/c`), never
`preview` or `program`, which are refused because nothing over UDP can see which buffer that is.

## Why not the wing itself

The Barco EC and ATEM Micro panels are driven directly, so why not an MA wing? Because a grandMA3
onPC command or fader wing is what **unlocks** the onPC's parameters, its USB protocol is
unpublished, and a wing that answered any host would be a key anyone could copy. This app does not
go near that. The desk already turns the wing into OSC, so this listens to the desk instead.

Avolites was looked at in the same pass (2026-10-30). Titan runs only on Windows, has no OSC, and
its surfaces (the Titan Mobile, T1, T2, T3 and Mobile Wing) are USB devices that only Titan talks
to. A Titan desk reaches this app the way any lighting desk without OSC does: Art-Net or sACN
channels patched as a dummy fixture.

## Setting up the desk

1. **Menu ▸ In & Out ▸ OSC.** Switch on **Enable Output**.
2. Add a line: **Destination IP** this machine, **Port** this app's OSC input port (**Settings ▸
   OSC input**), **Prefix** `ma3`, **Send** Yes. Leave Receive and Send Command off: this app
   sends nothing back.
3. **Preferred IP**: set it to the network this machine is on. Its default, `10.0.0.0/8`, picks
   whatever interface happens to be in that range. On a Mac with Parallels that is the virtual
   machine bridge, and nothing arrives. For an onPC on the same machine, `127.0.0.1`.
4. Here: **Settings ▸ OSC input** on, bound where the desk can reach it (the loopback default only
   hears an onPC on this machine). **Settings ▸ grandMA3**: move a fader or press a key on the
   desk and it appears under **Heard**; **Add a line** and write the target after the arrow;
   **Save lines**; tick **Drive the switcher from grandMA3**.

With driving off, everything still arrives and is listed, and each mapped press says what it
*would* have sent. That's the way to write the lines without touching the switcher.

### The addresses move between versions

`14.14.1.6.1` is Sequence 1's place in the show's object tree, not a number MA promises. MA's own
2.4 manual gives it as `13.13.1.6.1`; 2.4.2.2 sends `14.14.1.6.1`, and says so itself:

```text
  Lua "Printf(ObjectList('Sequence 1')[1]:Addr())"        →  14.14.1.6.1
```

So nothing here knows what a sequence is. A line names the address the desk was heard sending.
After an MA update that renumbers the tree, the new addresses turn up under **Heard** as unmapped
and the lines want relearning. Check this after every grandMA3 update, before the show.

## Proven, and not

**Proven** (2026-10-30, grandMA3 onPC 2.4.2.2 Release on macOS 26.4.1, Apple Silicon, no wing):

- **What the desk sends**: recorded off the wire. A fader moved by command, Go+, Go−, Flash,
  Toggle, Temp and Off on two executors; `test/fixtures/grandma3-2.4.2.2-feedback.json` keeps the
  bytes, and `test/grandma3.test.js` reads every one of them.
- **The recorded bytes, replayed to the app, drive the rack simulator**
  (`test/sim/grandma3.sim.test.js`, 6.2.73): Go+ takes S1, Go− with no line sends nothing, the
  fader thrown up and back is two T-bar takes, a second executor's Go+ cuts, a line saved mid-show
  puts preview layer 1 at half on a Flash and nothing on its release, and with driving off nothing
  is sent.
- **The real onPC, live, through the app, to the simulator**: `Go+ Page 1.201` took S1;
  `FaderMaster Page 1.201 At 0`, `At 40`, `At 100` took it, and `At 60`, `At 0` took it back;
  `Go+ Page 1.202` cut it. Nine messages arrived, every one heard, nothing refused.

**Not proven:**

- **A physical fader.** Every fader message seen so far was moved on screen or by command (the
  second argument 1). By MA's manual a wing's fader sends 3, and presumably many more messages a second. The
  one-write-at-a-time rule is there for it, but it has never been leaned on.
- **A wing or a desk at all**, or onPC on Windows, or any grandMA3 other than 2.4.2.2.
- **Over a real network**: everything above was on one machine, on loopback.
- **Knobs** are read and listed, and do nothing.

### The first real-desk test

Before a show, with the switcher in rehearsal:

1. Set up the desk as above, driving **off**. Move every fader and press every key you mean to use.
   Each should appear under **Heard** with the right function, and a wing fader should say
   *fader* rather than *on-screen fader or command*. If one doesn't appear, check the Preferred IP
   first.
2. Write the lines, save, and check there are no line errors under the box.
3. Drive **on**. Fire each key once and watch the switcher. Throw each T-bar fader up and back.
   Ride each `/norm` fader quickly, end to end, and check the layer lands where the fader stops.
4. Note anything that disagrees in `docs/NOTES.md`, with the grandMA3 version.
