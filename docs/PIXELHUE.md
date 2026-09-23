# Driving a Pixelhue console — **preview**

> ⚠️ **This has never been run against a console.** Every byte of it was worked
> out from the consoles' own firmware and then proved against the vendor's
> control service — a real UCenter from a U5 Pro image — running headless in a
> VM with no panel attached. That is a long way from a panel on a desk. Turn it
> on in rehearsal, not in a show.

A Pixelhue U5, U5 Pro or U5 mini is an **event controller**: a console built
for Pixelhue's own switchers. This makes one drive an Analog Way LivePremier
instead. It is off until you turn it on, in Preconfig → Settings → Pixelhue
panel.

---

## The idea, which is not the obvious one

The obvious way to drive a console is to read key ids and decide what each one
means — which is what `src/vendor/surface/` does for a MIDI controller, and it
is the wrong shape here. A U-series console is not a keyboard. It already knows
what a screen, a layer, a source and a memory are, and its control service
speaks a protocol about exactly those things.

So this does not paint keys and has no key map:

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

---

## What works, and what each key does

| the panel | the console reports | this app does |
|---|---|---|
| screen bus | `101` screenSelect / `103` unselect | holds the selection |
| layer bus | `201` layerSelect | holds the selected layer |
| input bus | `300` inputSwitch | writes `source.inputNum` on the selected layer |
| preset bus | `401` playPreset | recalls that memory **to preview** |
| TAKE | `531` | `xTake` on every selected destination |
| CUT | `532` | `xCut` |
| MATCH PGM | `529` | `xCopyProgramToPreview` |
| PGM EDIT | `530` | moves which buffer a *source change* edits |
| FTB / FRZ | `518` / `517` | **reported and not sent** — see below |
| page up/down | `549` / `550` | nothing; the console pages itself |

Everything else a console reports — PTZ, media, timecode, cue transport — is
ignored on purpose. Those are about a Pixelhue show, not this switcher.

⚠️ **A recall always lands in preview**, whatever PGM EDIT is doing. The panel
has a modifier that would make "recall to program" easy to offer; a memory
landing on air because a key was held two minutes ago is not worth the
convenience, and every other recall path in this app makes the same choice.

⚠️ **A source change is refused when the preset letter is not known.** Which
letter is preview changes on every take, it is device state, and it is read
from the switcher at the moment of the write. If that read fails, nothing is
sent — the same refusal `server/osc.js` makes, for the same reason.

---

## Rigging one

| console | control port | where this app has to run |
|---|---|---|
| **U5 mini** | 8088, **on the LAN** | anywhere it already runs |
| U5 / U5 Pro | 19999, **loopback only** | on the console itself |

⚠️ That difference is the whole rigging story. A U5 mini is driven from the
operator's laptop with nothing installed on the console. A U5 or U5 Pro is a
Windows mini-PC and its control service answers only to itself, so this app has
to be running on it — which it can be: the Pro has a touch screen, and the
proxied Web RCS runs on it perfectly well.

Settings are installation-level, like the OSC listener and the matrices: a
panel on the desk does not move when you re-point at a backup frame.

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

**The WebSocket** is `…/ucenter/ws?client-type=5`, carrying NOVA frames — a
22-byte header, a TLV naming the message, JSON inside. Tag `0x00101301` is key
state, `0x00101307` is the semantic command. ⚠️ One `client-type=5` connection
receives **both**, which was not obvious: 5 is not in Unico's own `ClientTypeE`
(`PCUnico 0, UnicoEC 2, PCPixelFlow 8, PixelFlowEC 9`) — it is hard-coded in
the console's on-screen keyboard app, and it is the one to use.

**The model** is `{screens, layers, inputs, presets, cues, medias, funcs,
additionInfos, newProtocol}`, replaced whole; there is no partial update.

⚠️ **`index` is the key position and it is 1-based.** Publishing from zero
silently drops the first object of every bus — no error, no complaint, just a
panel that is one short. This cost an afternoon; `test/pixelhue.test.js` pins
it.

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

- **FTB and freeze are reported and not sent.** The console asks for them
  (`518`, `517`); no verified LivePremier path for either is in hand yet. The
  Web RCS bundle's own Virtual RC400T is where to recover them.
- **Layers are published but do not bind.** The console leaves the layer bus
  empty, so a layer key produces no command and the selected layer stays
  whatever a `201` last said. Probably a field the layer model is missing.
- **The T-bar, faders and encoders are not read.** They come from the console's
  panel hardware, which the rig does not have, so their report shapes are still
  unverified.
- **The key displays are the console's own.** This publishes a model and the
  console draws from it; there is no path here that pushes a picture. The one
  the API offers takes a *filesystem path on the console*, not image bytes.
- **Midra 4K / Alta 4K are untried.** The dialect makes the writes spellable
  and nothing here assumes LivePremier, but no Midra has been in the loop.
