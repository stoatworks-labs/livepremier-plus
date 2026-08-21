# LivePremier Plus

A local app that puts two things inside an Analog Way **LivePremier** Web RCS
session, drawn in Web RCS's own design language so they read as part of the
product rather than as a bolt-on:

- **VPU Map** — the device's mixing-resource allocation, drawn as a budget.
  Which units are fitted, who holds them, what is spare, and what a staged
  preconfig would change.
- **Timeline** — a theatre-style cue stack. A numbered list that advances on
  one GO, with per-cue fade, delay and follow times, driving the switcher's
  preset recalls and TAKE.

Point it at a switcher, open the address it prints, and you get the vendor's
own Web RCS with the extra panels already in it. It rides the vendor app's own
WebSocket — no second connection to the device, no replacement UI, and nothing
to install in the browser.

> **Status: 0.2.0, unreleased.** The panels render inside a real Web RCS
> session and the device store mirrors live — both verified through this proxy
> against LivePremier Simulator 6.2.73, along with cue-stack persistence and
> the whole setup flow. The VPU map has been **read from a live Aquilon C** and
> is tested against that capture, including Optimized mode, interleaved output
> links, and a staged preconfig that differs from the running one.
> **Nothing has ever been written to that device**, the timeline has only ever
> fired at a simulator, and **no panel has been driven live against physical
> hardware in a browser.** That is the first thing to try.

---

## Running it

```bash
npm start
```

Then open `http://127.0.0.1:8534/` and give it the switcher's address. That
address is remembered, so subsequent runs go straight to the Web RCS.

You can also name the device up front, which skips the setup page:

```bash
npm start -- --device 192.168.2.142
```

| flag | meaning |
| --- | --- |
| `--device <host[:port]>` | the switcher. Port defaults to 80 (a simulator is usually `:3000`). |
| `--port <n>` | local port to listen on (default 8534) |
| `--host <addr>` | local address to bind (default `127.0.0.1`) |
| `--data <dir>` | where cue stacks are kept (default `~/.livepremier-plus`) |

There is a desktop app too — a tray launcher with an interface and port picker,
in the fleet's usual shape. See [launcher/](launcher/).

> **On binding wide.** The default is loopback for a reason: this proxy is an
> unauthenticated route to a switcher's entire control surface. `--host 0.0.0.0`
> hands that to everyone on the network. Do it deliberately, not by habit.

## What it looks like

Both panels are built from the vendor stylesheet's own utility classes — the
slate-grey scale, the spacing scale, the typography — and the sidebar entries
are cloned from real ones at runtime, so they inherit whatever per-build class
hashes the firmware happens to use. The result is not a skin that approximates
Web RCS; it is Web RCS's own CSS.

```
PLUS               <- our section, styled like LIVE and SETUP
  VPU Map
  Timeline
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
ws://localhost:8534                relayed byte-for-byte to the device
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
- **No second connection.** The device counts its clients and shows them in the
  header; an extra socket would appear there as a phantom operator.
- **Re-pointing drops the old relay.** Moving to a backup frame hangs up the
  sockets aimed at the previous one, so a page cannot go on driving a device
  the operator believes they have left.

## Testing

```bash
npm test
```

54 tests, no network and no browser.

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
