# webRCS unleashed

A Chrome extension that adds two things to an Analog Way **LivePremier** Web RCS
session, drawn in Web RCS's own design language so they read as part of the
product rather than as a bolt-on:

- **VPU Map** — the device's mixing-resource allocation, drawn as a budget.
  Which units are fitted, who holds them, what is spare, and what a staged
  preconfig would change.
- **Timeline** — a theatre-style cue stack. A numbered list that advances on
  one GO, with per-cue fade, delay and follow times, driving the switcher's
  preset recalls and TAKE.

It rides the vendor app's own WebSocket. No second connection to the device, no
replacement UI, and nothing to configure.

> **Status: 0.1.0, unreleased.** Verified end to end against the AW LivePremier
> Simulator 6.2.73 — panels render inside the real Web RCS, the device store
> mirrors live, and cue writes were confirmed on the wire. **It has never run
> against a physical Aquilon**, and it has never been loaded as a packed
> extension in Chrome; the panels were exercised by injecting the same content
> scripts into a live session (see [Testing](#testing)).

---

## What it looks like

Both panels are built from the vendor stylesheet's own utility classes — the
slate-grey scale, the spacing scale, the typography — and the sidebar entries
are cloned from real ones at runtime, so they inherit whatever per-build class
hashes the firmware happens to use. The result is not a skin that approximates
Web RCS; it is Web RCS's own CSS.

```
UNLEASHED          <- our section, styled like LIVE and SETUP
  VPU Map
  Timeline
```

## Install

Not packed for the Chrome Web Store. Load it unpacked:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → choose this directory
3. Open your Web RCS session and reload the tab

The content scripts match `http://*/*` and `https://*/*` because a Web RCS can
live at any address. They stay inert until an Analog Way frame is seen on a
WebSocket, so the cost on an unrelated page is one wrapped constructor. If you
would rather narrow that, edit the two `matches` arrays in `manifest.json` to
your devices.

**Reload the tab after installing.** The hook has to be in place before the
vendor app opens its socket, which means it only takes effect on a fresh load.

## How it works

```
document_start   src/hook/ws-hook.js     MAIN world. Wraps WebSocket before the
                                         vendor bundle runs, records frames.
document_idle    src/loader.js           ISOLATED world. Injects the module
                                         entry point and brokers chrome.storage.
                 src/main.js             MAIN world, ES modules. Mirrors the
                                         device store, mounts the panels.
```

The device is one large JSON object. The Web RCS front-end hydrates it from
`GET /api/stores/device` and then applies a stream of `{path, value}` writes off
the socket; writing a property *is* the command. This extension does the same
thing with the same connection. See [docs/TRANSPORT.md](docs/TRANSPORT.md).

### Layout

```
src/
  core/          no DOM, no chrome.*, no transport - importable anywhere
    paths.js       store paths, the AWJ spelling of them, and the command set
    device-store.js  the local mirror of the device object model
    vpu.js         the VPU allocation map, normalised across two firmware models
    cuestack.js    the cue engine: GO, follow chains, delays, fade times
    session.js     snapshot + stream, folded into a store
  transports/
    page-socket.js the vendor page's own WebSocket
  ui/            panels, built out of the host's `aw-` utility classes
  hook/          the document_start WebSocket hook
```

`core/` is deliberately free of anything browser-extension shaped — it imports
and runs under plain Node, which is what the test suite does. The extension is
one front-end over it; a standalone client talking AWJ over TCP 10606 is meant
to be another, and only needs a second `transports/` module.

## Two firmware models

The VPU mapping is reported under two different names depending on firmware,
and both are handled:

| | collection | per device | out-pipes | slice index |
|---|---|---|---|---|
| mixer model | `vpuMixerList`, `PROC_n_MIXER_m` | 64 | 2 | yes |
| scaler model | `vpuLayerList`, `PROC_n_SCALER_m` | 32 | 8 | no |

`slice` is `null` where the firmware does not report it, and the panel shows
that as absent rather than as slice zero. A firmware reporting neither is
reported as unknown, not drawn as an empty chassis.

## Safety

- **The VPU panel never writes.** Every property it reads is `readOnly` in the
  device's own model.
- **The timeline writes only what a cue says.** Preset recalls, transition
  times, TAKE, CUT and STEP BACK — nothing else, and only on GO.
- **A cue is reported as *sent*, never as *confirmed*.** Recalls and takes
  return nothing on this protocol. The log counts writes that left the browser;
  device status is shown separately, from the device's own status properties.
- **No second connection.** The device counts its clients and shows them in the
  header; an extra socket would appear there as a phantom operator.

## Testing

```bash
npm test
```

20 tests over the path table, the store, both VPU models and the cue engine.
Two fixtures are real captures from a running simulator.

To exercise the panels inside a live Web RCS session without packing the
extension:

```bash
npm run serve
```

then, in the Web RCS tab's console:

```js
await import('http://127.0.0.1:8765/src/hook/ws-hook.js');
await import('http://127.0.0.1:8765/src/main.js');
```

Loading late that way, the hook misses the socket the app opened at boot. It
will adopt an existing connection once it recognises one, but in a console
session the simplest thing is to open one yourself first — see the note in
`tools/serve.mjs`. Cue persistence does not work in this mode; `chrome.storage`
is brokered by the isolated-world loader, which is not present.

## Related

[`aquilon-vpu-map`](../aquilon-vpu-map) is a standalone server-side reader of
the same VPU mapping over AWJ. It and this extension solve the same problem
from opposite ends — that one reaches the device directly and can run headless,
this one has the whole device store for free but only inside a browser tab.
`core/vpu.js` exposes `toMixerRecords()`, which emits the exact record shape
that tool reads, so a map from either can be opened in the other.
