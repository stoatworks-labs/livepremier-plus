> Built with AI assistance ([Claude Code](https://claude.com/claude-code)).

# LivePremier Plus

A local app that puts two things inside an Analog Way **LivePremier** Web RCS
session, drawn in Web RCS's own design language so they read as part of the
product rather than as a bolt-on:

- **VPU Map** — the device's mixing-resource allocation, drawn as a budget.
  Which units are fitted, who holds them, what is spare, and what a staged
  preconfig would change.
- **Console** — Mynah's command line, a lighting-desk grammar for a video
  switcher. `Recall Screen 1 Memory 5`, `R Sc 1 Th 4 Me 5 Pre`, `Take Screen 1`.
- **Timeline** — a theatre-style cue stack. A numbered list that advances on
  one GO, with per-cue fade, delay and follow times, driving the switcher's
  preset recalls and TAKE.
- **MIDI Mapping** — a control surface driving the switcher, from the page
  itself. Faders to opacity, encoders to size and position, buttons to select.
- **Arithmetic in the vendor's own numeric fields** — type `1080-80` into a
  layer width and get 1000, the way you can in every other tool on the desk.

Point it at a switcher, open the address it prints, and you get the vendor's
own Web RCS with the extra panels already in it. It rides the vendor app's own
WebSocket — no second connection to the device, no replacement UI, and nothing
to install in the browser.

> **Status: v0.3.0, the first public release.** The panels render inside a real Web RCS
> session and the device store mirrors live — both verified through this proxy
> against LivePremier Simulator 6.2.73, along with cue-stack persistence and
> the whole setup flow. The VPU map has been **read from a live Aquilon C** and
> is tested against that capture, including Optimized mode, interleaved output
> links, and a staged preconfig that differs from the running one.
> **Nothing has ever been written to that device**, the timeline has only ever
> fired at a simulator, and **no panel has been driven live against physical
> hardware in a browser.** That is the first thing to try.

**[Watch it work (50s)](https://www.youtube.com/watch?v=mGjGiNO_tSo)** — the real
application, driven through its own controls: the VPU map off a real Aquilon C
capture, a command typed into the Console, and `1080-80` becoming 1000 in a
layer width.

---

## Running it

Needs **Node 20 or newer** and has no dependencies to install.

```bash
npm start
```

Then open `http://127.0.0.1:8535/` and give it the switcher's address. That
address is remembered, so subsequent runs go straight to the Web RCS.

You can also name the device up front, which skips the setup page:

```bash
npm start -- --device 192.168.2.142
```

| flag | meaning |
| --- | --- |
| `--device <host[:port]>` | the switcher. Port defaults to 80 (a simulator is usually `:3000`). |
| `--port <n>` | local port to listen on (default 8535) |
| `--host <addr>` | local address to bind (default `127.0.0.1`) |
| `--data <dir>` | where cue stacks are kept (default `~/.livepremier-plus`) |

There is a desktop app too — a tray launcher with an interface and port picker,
in the fleet's usual shape. See [launcher/](launcher/).

## Download

Nothing below this line is hand-written: `gen-downloads.py` owns everything
between the markers and rewrites it wholesale at each release.

> **There is also a preview build.**
> [**v0.4.0-preview.1**](https://github.com/stoatworks-labs/livepremier-plus/releases/tag/v0.4.0-preview.1)
> adds Midra 4K / Alta 4K detection, audio patching on the command line,
> timecode input with a cue chase, and two pop-out windows — a console and a
> QLab-style cue editor. It is marked as a pre-release on GitHub, so it stays
> out of "Latest release" and the table below keeps pointing at the stable
> version. Try it on a rehearsal, not on a show.

<!-- downloads:start -->

## Download

**[v0.3.1](https://github.com/stoatworks-labs/livepremier-plus/releases/tag/v0.3.1)** — prebuilt for macOS, Windows and Linux. Pick your platform:

<details>
<summary><b>macOS</b> — Apple Silicon, Intel</summary>

| Build | Download | Size |
| --- | --- | --- |
| Apple Silicon · .dmg disk image | [`livepremier-plus-0.3.1-macos-aarch64.dmg`](https://github.com/stoatworks-labs/livepremier-plus/releases/download/v0.3.1/livepremier-plus-0.3.1-macos-aarch64.dmg) | 40 MB |
| Intel · .dmg disk image | [`livepremier-plus-0.3.1-macos-x86_64.dmg`](https://github.com/stoatworks-labs/livepremier-plus/releases/download/v0.3.1/livepremier-plus-0.3.1-macos-x86_64.dmg) | 42 MB |
| Apple Silicon · .pkg installer | [`livepremier-plus-0.3.1-macos-aarch64.pkg`](https://github.com/stoatworks-labs/livepremier-plus/releases/download/v0.3.1/livepremier-plus-0.3.1-macos-aarch64.pkg) | 40 MB |
| Intel · .pkg installer | [`livepremier-plus-0.3.1-macos-x86_64.pkg`](https://github.com/stoatworks-labs/livepremier-plus/releases/download/v0.3.1/livepremier-plus-0.3.1-macos-x86_64.pkg) | 42 MB |

</details>

<details>
<summary><b>Windows</b> — x64</summary>

| Build | Download | Size |
| --- | --- | --- |
| x64 · .exe installer | [`LivePremier.Plus_0.3.1_x64-setup.exe`](https://github.com/stoatworks-labs/livepremier-plus/releases/download/v0.3.1/LivePremier.Plus_0.3.1_x64-setup.exe) | 25 MB |

</details>

<details>
<summary><b>Linux</b> — x64</summary>

| Build | Download | Size |
| --- | --- | --- |
| x64 · .deb package (Debian/Ubuntu) | [`LivePremier.Plus_0.3.1_amd64.deb`](https://github.com/stoatworks-labs/livepremier-plus/releases/download/v0.3.1/LivePremier.Plus_0.3.1_amd64.deb) | 50 MB |
| x64 · .rpm package (Fedora/RHEL) | [`LivePremier.Plus-0.3.1-1.x86_64.rpm`](https://github.com/stoatworks-labs/livepremier-plus/releases/download/v0.3.1/LivePremier.Plus-0.3.1-1.x86_64.rpm) | 50 MB |

</details>

All builds, checksums and release notes: [github.com/stoatworks-labs/livepremier-plus/releases](https://github.com/stoatworks-labs/livepremier-plus/releases).

macOS builds are signed and notarised and open normally. The Windows builds are unsigned, so SmartScreen warns once.

<!-- downloads:end -->

> **On binding wide.** The default is loopback for a reason: this proxy is an
> unauthenticated route to a switcher's entire control surface. `--host 0.0.0.0`
> hands that to everyone on the network. Do it deliberately, not by habit.

## Console

Mynah's command language, inside Web RCS. Verb first, then objects, innermost
scope last; every keyword abbreviates to any unambiguous prefix; Enter executes
and nothing is sent before it.

```
Recall Screen 1 Memory 5
R Sc 1 Th 4 Me 5 Pre          the same command
Store Master 12
Take Screen 1
```

The line parses as you type and shows what it will do — `Recall 3 → Screen 1
Preview` — before anything reaches the device. Tab completes, ↑ recalls
history.

**This panel owns no grammar.** Every token, rule and device path comes from
`src/vendor/mynah-lang.mjs`, which is [mynah](https://github.com/stoatworks-labs/mynah)'s
own `npm run build:lang` output — the same artefact its Companion module
vendors. If a command means the wrong thing, the fix is in mynah.

That is worth more than tidiness. Mynah's compiler and this repo's `CMD`
builder were arrived at independently — and they emit **byte-identical** store
paths for the commands both know. Two independent derivations agreeing is the strongest evidence either is
right, and it stays true only while nobody re-types the grammar here. A test
pins it.

### Four languages, one line

The same command line also takes raw AWJ, raw Web RCS store JSON, and OSC.
These are all the same write:

```
Take Screen 1
AWJ DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake = true
{"path":["device","screenAuxGroupList","items","S1","control","pp","xTake"],"value":true}
/lp/screen/1/take
```

Mynah is the language for driving a show. The other three are for the times a
show is not going well: a path out of a packet capture, a frame out of a
browser's network panel, an address a lighting desk is already sending. Each is
something you already have in front of you, and translating it by hand costs a
typo on a live frame.

Each line is read as whichever language it looks like, and the verdict is shown
beside the feedback before you press Enter — a line read as the wrong language
complains about a character rather than about a command, which reads like your
own typo. A leading `MYNAH`, `AWJ`, `JSON` or `OSC` says which outright, and
**Settings → Console language** can turn detection off altogether.

### Reading a value back

`AWJ get DeviceObject/system/$device/@items/1/@props/dev` answers. Nothing else
here does — the vendor's socket carries a stream of changes rather than a
request and its answer — so a `get` goes out on a **real TCP 10606 socket**
opened by this process, and the reply lands in the console log.

Everything else rides the vendor's own connection, whichever language it was
typed in: one path is held once and rendered for either transport, so an AWJ
message converts to a store write and lands at the same node. **Settings → AWJ
via** switches that, for when you want the message on the wire exactly as
typed; the device allows five AWJ clients and this spends one of them for the
length of each exchange.

## OSC input

Off by default. Turn it on in **Settings → OSC input** and this process listens
on a UDP port, so QLab, TouchOSC, Companion or a lighting desk can drive the
switcher directly.

```
/lp/screen/1/take
/lp/screen/1/memory/5/recall/preview
/lp/master/memory/12/store
/lp/screen/1/preset/a/layer/2/opacity/opacity/norm 0.5
```

**[The full dictionary is in docs/OSC.md](docs/OSC.md)** — every address, its
argument and its range. It is the same address space the MIDI mapping binds to:
a fader is bound to a screen, a preset, a layer and a parameter, and that
four-part address is the same thing whether it arrives as a control change or
as a packet. The document is generated from the resolver's own tables, so it
cannot describe an address that does not work.

Four things worth knowing before you wire a surface to it:

- **The address is the target; the argument is only the value.** A button with
  a fixed address and no argument still means something specific, which is what
  lets a TouchOSC layout be drawn once with no logic behind it.
- **A trigger fires on a non-zero argument and on none at all.** Surfaces send
  `1` on press and `0` on release; firing on both would take the screen twice.
- **A recall never defaults to program.** `/lp/screen/1/memory/5/recall` goes to
  preview. Reaching air costs the explicit word, here as everywhere else.
- **`/norm` takes 0–1 and scales; without it the value is in the device's own
  units.** Opacity is 0–256, not 0–100. Which one `0.5` meant cannot be worked
  out from the value, so it is said in the address instead.

It binds to loopback unless you choose otherwise, and the other option says in
as many words that the network will be able to fire takes. Messages are written
to the switcher over AWJ, so it works with no browser open — which is the
point — and that port can be switched off in the Web RCS security settings.

> **Over UDP, live layer parameters must name a buffer** — `/a`, `/b` or `/c`.
> `preview` and `program` name whichever buffer is pending or live right now,
> and resolving that needs the device's take state, which this listener does
> not hold. It refuses those addresses with that reason rather than guessing.
> The Console *can* resolve them, because the page has the device store.

## MIDI Mapping

Under Virtual RC400T. Pick an input, an output for feedback, and a controller
profile; Start. Faders, encoders and buttons then drive the selected layer.

**The engine is [awj-surface](https://github.com/stoatworks-labs/awj-surface)'s,
vendored whole** into `src/vendor/surface/` along with its stock profiles
(X-Touch/Mackie, APC40, MIDIcon 2 and Pro, plus a generic learn profile).
Decoding, soft pickup, encoder acceleration, MCU feedback and the parameter
catalogue are all upstream's. This repo contributes a front-end and nothing
else.

Soft pickup is the behaviour worth knowing: a non-motorised fader will not move
a live value until it has swept through that value, so picking up a fader
mid-show cannot jump a layer's opacity. The panel shows the hold-off rather
than looking broken.

### Why this needs no offscreen document

`navigator.requestMIDIAccess()` is a **secure-context** API. When this project
was a Chrome extension the page was a Web RCS on a plain-HTTP LAN address —
not a secure context — and a content script inherits the page's context, so
neither world could use it. The answer then was an offscreen document on the
`chrome-extension://` origin relaying MIDI through a service worker.

None of that is needed here. The proxy serves the vendor UI from
`http://127.0.0.1:<port>`, loopback **is** a potentially-trustworthy origin, so
the page is a secure context and Web MIDI is simply available. It also fixes
the SysEx problem: an invisible offscreen document cannot show a permission
prompt, so Mackie scribble strips needed granting from a separate page. A
normal page just asks.

The corollary: **open the switcher's own address directly and MIDI will not
work**, because that origin is not secure. The panel says so rather than
failing silently.

## The demo environment

```bash
npm run demo
```

Brings the whole thing up against a **LivePremier Simulator**, with a real
Aquilon C's resource map folded in and an example cue stack already loaded, so
every panel has something real to show without a switcher in the room. It
prints a short list of things worth trying and the URL to open.

It needs a simulator running, and that is not a shortcut — the panels mount
into Web RCS's own sidebar, are drawn with its own utility classes and ride its
own socket, so a demo that stubbed all of that would be a demo of something
that is not the product. The simulator is Analog Way's, runs locally, and is
the honest way to have the genuine vendor UI with no device and no vendor asset
copied into this repo.

What the simulator cannot provide is a **VPU** — it has no `vpuMixerList` at
all, so the panel against a bare one correctly reports there is nothing to
draw. `tools/demo/seed.js` supplies that from the recorded capture: 32 of 64
mixers fitted, 26 allocated, S1 in Optimized mode, and a staged preconfig
differing from the running one in 26 mixers. Everything outside
`preconfig/resources` stays the simulator's own live state, so cues fired from
the timeline really do go on the wire.

It **refuses to run against anything that is not loopback.** The demo splices a
store subtree and seeds a cue stack, and "I thought it was the simulator" is
exactly the mistake worth making impossible. To drive a real switcher, use
`npm start -- --device <address>`.

If the simulator is on another port:

```bash
LPP_DEMO_DEVICE=127.0.0.1:3001 npm run demo
```

The demo's cue stack lives in a temporary directory and is deleted on exit —
`~/.livepremier-plus` is never touched.

## Arithmetic in numeric fields

Type an expression into any of Web RCS's own numeric fields and it is evaluated
when you commit — on Enter, or on leaving the field:

| typed | becomes |
| --- | --- |
| `1080-80` | `1000` |
| `1920/2` | `960` |
| `(1920-40)/2` | `940` |
| `1920*2` | `3840` |

`+ - * / ( )` and decimals, with the usual precedence. The result is clamped to
the field's own declared range and rounded to its `step`, so a width of
`9000+1000` lands on 8192 rather than being refused.

Nothing else about the field changes. The vendor still validates it, still
decides what to send, and still drags the other axis along if the aspect lock
is on — all this does is substitute the number you meant, an instant before
Web RCS reads it.

**Where it applies, and why that is narrow on purpose.** Only fields the vendor
itself marks as numeric, which it does by putting `min`, `max` and `step` on
them — its geometry fields report `step="1"` with real ranges. That is a
steadier signal than any class name in a CSS-modules build, and it excludes
everything that must not be touched: labels have no `step`, and neither does
the transition-time field, whose `00:01.000` would be mangled by anything
treating `:` as arithmetic.

**Opacity and zoom are deliberately excluded.** Those are real
`input[type="number"]` fields, and a number input *discards* anything it cannot
parse — after typing `1080-80` the browser reports `value === ""`, and the
expression is visible on screen but unreadable from script. Supporting them
would mean swapping `type` to `text` on focus and reimplementing the native
up/down stepping operators use. Mutating a vendor element's `type` on every
focus, in a UI driving a live show, to win arithmetic on an opacity field is
not a good trade.

There is **no `eval`** anywhere in this path. `src/core/expr.js` is a
hand-written recursive-descent parser over a closed token set; anything it does
not fully understand is refused rather than guessed at, and the field is left
exactly as typed for the vendor to reject as it would today.

## What it looks like

Both panels are built from the vendor stylesheet's own utility classes — the
slate-grey scale, the spacing scale, the typography — and the sidebar entries
are cloned from real ones at runtime, so they inherit whatever per-build class
hashes the firmware happens to use. The result is not a skin that approximates
Web RCS; it is Web RCS's own CSS.

Console and Timeline are **tabs in the vendor's own strip** on Screens / Aux.,
beside Properties and Memories, because two per-screen tools belong where an
operator already looks for per-screen tools:

```
Properties | Memories | Console | Timeline
```

MIDI Mapping sits **under Virtual RC400T** in the vendor's own LIVE section —
both are about control surfaces, and filing it in a section of ours would file
it by who wrote it rather than by what it does. Only the VPU map, a
whole-device view, gets a section of its own:

```
LIVE
  Screens / Aux.
  Multiviewers
  Virtual RC400T
  MIDI Mapping       <- ours
SETUP
  …
PLUS                 <- ours
  VPU Map
```

## How it works

Everything the browser asks for goes through this process to the switcher and
back. On the way past, the document picks up two script tags:

```
GET /                    the device's own index.html, plus:
  <script>…hook…</script>          inline, in <head>
  <script type="module" src="/__lpp/src/main.js">
GET /styles/app.<hash>.css         proxied, untouched
GET /api/stores/device             proxied, streamed — it is over 100 MB
ws://localhost:8535                relayed byte-for-byte to the device
```

Three properties of that arrangement are load-bearing:

**The hook cannot lose its race, because there is no race.** It has to wrap
`WebSocket` before the vendor bundle constructs one, or it misses the
connection and every frame up to it. As a Chrome extension this meant a
`document_start` content script, which usually won but was never promised to.
Here every vendor script tag is `defer` and the hook is an inline classic
script, so the HTML parser orders it first by definition.

**No URL is rewritten.** Every asset the Web RCS references is root-absolute,
so a path-preserving proxy needs no rewriting at all. Resist adding any: the
vendor's hashes change every firmware, and a rewriter would be one more thing
to keep in step with a bundle nobody controls.

**One connection reaches the device.** The upgrade is relayed at the byte
level, so the device's client count stays honest and this process never needs
to understand WebSocket framing.

The device itself is one large JSON object. The Web RCS front-end hydrates it
from `GET /api/stores/device` and then applies a stream of `{path, value}`
writes off the socket; writing a property *is* the command. The panels do the
same thing, over the same connection. See [docs/TRANSPORT.md](docs/TRANSPORT.md).

### Why a proxy and not a browser extension

This started as one, and the extension worked. The proxy replaces it because
it is strictly better on four counts, at the cost of a process to run:

- It works in **any browser**, not only a Chrome with a sideloaded extension —
  which matters on a locked-down show laptop.
- The hook's ordering becomes a guarantee rather than a race.
- Cue stacks persist to a file, and are keyed by device. The extension brokered
  `chrome.storage` through a content script; that code never once executed.
- There is no MV3 packaging step to get wrong, and no unpacked-extension
  install for an operator to redo after a browser update.

What did **not** change is the important part: the panels, the store mirror and
the cue engine are the same code, and they still ride the vendor's own socket.

### Layout

```
server/
  index.js       CLI entry: flags, data dir, shutdown
  proxy.js       the reverse proxy, the injection, the socket relay
  storage.js     cue stacks and the remembered device, on disk
  setup.html     shown until a switcher is chosen
src/
  core/          no DOM, no transport - importable anywhere
    paths.js       store paths, the AWJ spelling of them, and the command set
    device-store.js  the local mirror of the device object model
    vpu.js         the VPU allocation map, adapted from the device store
    cuestack.js    the cue engine: GO, follow chains, delays, fade times
    session.js     snapshot + stream, folded into a store
  transports/
    page-socket.js the vendor page's own WebSocket
  ui/            panels, built out of the host's `aw-` utility classes
  hook/          the WebSocket hook, inlined into the document by the proxy
launcher/        the desktop app - the fleet's standard Tauri tray shell
```

`core/` is deliberately free of anything browser-shaped — it imports and runs
under plain Node, which is what the test suite does. The browser panels are one
front-end over it; a standalone client talking AWJ over TCP 10606 is meant to
be another, and only needs a second `transports/` module.

## Three things are vendored, not reimplemented

| in `src/vendor/` | from | what it is |
| --- | --- | --- |
| `vpu-model.js` | aquilon-vpu-map | the VPU mixer model |
| `mynah-lang.mjs` | mynah | the command language |
| `surface/` | awj-surface | the control-surface engine and profiles |

Each is copied rather than re-derived for the same reason, and it is not
convenience: two implementations of one grammar, one device model or one decode
table will eventually disagree, and both will look right. `npm run sync:*`
re-copies each and rewrites its provenance; `test/vendor.test.js` fails on
drift and skips when there is no upstream checkout to compare against. Edits
belong upstream.

## The VPU model is shared, not reimplemented

`src/vendor/vpu-model.js` is a **copy** of `public/vpu.js` from
[aquilon-vpu-map](https://github.com/stoatworks-labs/aquilon-vpu-map), the
standalone tool that reads the same allocation over AWJ. Deliberately the same
model in both places: if two tools derived their own answers from one device
they would eventually disagree about what the box is doing, and both would look
right. `npm run sync:vpu-model` re-copies it and rewrites the recorded commit,
and `test/vendor.test.js` fails if the copy has drifted from an upstream
checkout.

`src/core/vpu.js` is the only part that differs between the two projects. That
tool assembles mixer records from a few hundred AWJ reads; this one lifts them
straight out of the device store the page already has, which also gets the
per-screen resource status — the device's own "does this fit" figures — for
free, where the standalone reader spends 24 round trips on it.

**There is deliberately no AWJ path here.** It would be easy to add — this is a
process, it can open TCP 10606 — but the store is already mirrored and stays
current from the socket, so an AWJ reader would be a *second source of truth
for the same VPU state*. Two sources that can disagree about what is on air is
not a trade worth making for a faster first paint.

**A simulator has no VPU at all.** It carries a `vpuLayerList` that is present
and permanently empty and no `vpuMixerList`; `$vpuLayer` answers `E12` on real
hardware. That is an artefact of the simulator, not a second firmware
generation, and the panel says so plainly rather than drawing an empty chassis
or claiming the firmware is unsupported.

## Safety

- **The VPU panel never writes.** Every property it reads is `readOnly` in the
  device's own model.
- **The timeline writes only what a cue says.** Preset recalls, transition
  times, TAKE, CUT and STEP BACK — nothing else, and only on GO.
- **A TAKE waits 150 ms behind a recall in the same cue**, so it cannot
  overtake its own preset load and put the previous preview on air.
- **A cue is reported as *sent*, never as *confirmed*.** Recalls and takes
  return nothing on this protocol. The log counts writes that left the browser;
  device status is shown separately, from the device's own status properties.
- **No second connection to the Web RCS.** The device counts its clients and
  shows them in the header; an extra socket would appear there as a phantom
  operator. The AWJ socket is a different budget — five clients — and is opened
  per exchange and closed, never held.
- **The OSC listener is off until you turn it on**, binds to loopback unless
  you choose otherwise, and never answers a packet. It listens; it does not
  reply, because replying to a spoofable datagram tells an unknown host that
  something here is worth sending to.
- **An OSC address that cannot be resolved is refused, not approximated.** An
  enum value the device does not have, a parameter that is read-only, a preset
  that needs a take state this process does not hold — each is turned away with
  the reason, and counted in Settings.
- **Re-pointing drops the old relay.** Moving to a backup frame hangs up the
  sockets aimed at the previous one, so a page cannot go on driving a device
  the operator believes they have left.

## Testing

```bash
npm test
```

199 tests, no browser. The socket tests bind real ports on loopback.

Twenty-three cover OSC and AWJ. The framing ones run against a stand-in device
on a real TCP socket rather than a mock, deliberately: everything worth catching
there lives in the plumbing — the `0x04` terminator, a reply that straddles a
read boundary, a write discarded because the socket was destroyed before it
flushed — and a mocked `net.connect` would simply agree with whatever the code
did. Two of those three were real bugs the tests found.

One test asserts that `docs/OSC.md` is exactly what its generator produces, and
another runs every address the document lists through the resolver. A published
address space that describes something which does not work is worse than none,
because the reader believes it.

Twenty cover the expression evaluator, weighted towards what it must **refuse**
— `1/0`, `2+`, `1920x1080`, `00:01.000`, and anything resembling code — because
the failure mode that matters is a plausible wrong value on air, not a parse
error someone notices.

Twenty-two cover the proxy against a stand-in Web RCS on a real socket rather
than a mock — injection ordering against deferred scripts, chunked and gzipped
documents, CSP stripping, path traversal, the byte-level socket relay, runtime
device changes, and the shutdown path. That last one pins a hang rather than a
wrong value: an upgraded socket is invisible to the HTTP server's own
connection tracking, so without hanging up the relays explicitly, the
launcher's Stop button never completes.

Seven run against `aquilon-c-live-resources.json` — the resource subtree of a
real Aquilon C, read from the device on 2026-08-21 — and cover ground no
simulator can reach: fitted mixers, interleaved output links, Optimized mode,
and a staged preconfig whose every difference is a link move.

There is also a bench for the panels on their own:

```bash
DEVICE=192.168.2.142 npm run serve
# then open http://127.0.0.1:8765/tools/harness.html
```

It renders a panel against a recorded store, and proxies the vendor's real
stylesheet, fonts and icon sprite from the named device — the panels are built
from the vendor's utility classes, so a bench with a stylesheet of its own
would prove nothing about how they look. No vendor asset is copied into this
repo.

## Related

[`webrcs-timeline`](../webrcs-timeline) is a Rust workspace with the same cue
model, both transports and no UI — the headless path. Its engine and this one
are independent implementations and will drift; converging them is an open
decision.

[`aquilon-vpu-map`](../aquilon-vpu-map) is a standalone server-side reader of
the same VPU mapping over AWJ. It and this app solve the same problem from
opposite ends — that one reaches the device directly and can run headless, this
one has the whole device store for free but only inside a browser tab.
`core/vpu.js` exposes `toMixerRecords()`, which emits the exact record shape
that tool reads, so a map from either can be opened in the other.
