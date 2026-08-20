# The Web RCS transport

What the extension rides on, and why it is shaped the way it is. Every claim
here was confirmed on the wire against a running LivePremier simulator 6.2.73,
not taken from the protocol guide — the guide is a firmware behind in places
that matter.

## One socket, one envelope

The Web RCS front-end opens exactly one WebSocket, to its own origin at the
root path:

```
ws://<host>/          (wss:// when the page is https)
```

Every frame is a single JSON object:

```json
{"channel": "DEVICE" | "REMOTE" | "LOG", "data": ...}
```

plus a keep-alive pair sent as bare strings: **`0x9`** is ping, **`0xA`** is
pong — the literal three-character strings, not control bytes. The client only
pings after three seconds of silence, so on a live device (which sends timer
updates every second) you will rarely see one.

### DEVICE

The device object model, as path/value writes, in both directions:

```json
{"channel":"DEVICE","data":{"path":["device","screenAuxGroupList","items","S1","control","pp","xTake"],"value":true}}
```

`path` is an array rooted at `"device"`. `value` must be defined; the vendor
client discards frames failing either check. **Writing a property is the
command** — there is no verb channel, and a write is what a button press
becomes.

Writes are broadcast to every connected client, so a second tab, the extension
and the vendor UI all see each other's changes.

### REMOTE

The vendor UI's *own* view state — a mobx-state-tree snapshot followed by JSON
patches (`{"channel":"INIT", snapshot, socketId}`, then `{"channel":"PATCH",
patch}`). Selected screens, panel layout, connected clients. Not the device.
The extension ignores it.

### LOG

Client telemetry, sent once at startup. Ignored.

## The snapshot is HTTP, not WebSocket

The socket carries changes, not state. The full object model comes from:

```
GET /api/stores/device        Cache-Control: no-cache
```

It is large — a real device answers with something over 100 MB — and the vendor
client allows itself two minutes for it.

**The ordering trap:** frames keep arriving while that fetch is in flight.
Frames from before the fetch was issued are already folded into the snapshot and
must be discarded, or state walks backwards. Frames from the moment the fetch
was issued onwards are replayed, which is safe because a write is idempotent.
`core/session.js` takes its stream marker *before* issuing the fetch for exactly
this reason.

## Store paths and AWJ paths

The same tree, two spellings. `core/paths.js` holds the mapping and the test
suite asserts it against the documented AWJ paths.

| store | AWJ |
|---|---|
| `device` | `DeviceObject` |
| `pp` | `@props` |
| `items` | `@items` |
| `xxxList` | `$xxx` |

```
store  ["device","screenAuxGroupList","items","S1","control","pp","xTake"]
AWJ    DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake
```

## The paths the timeline uses

Read off a live device store, not transcribed:

```
TAKE / CUT / STEP BACK
  device/screenAuxGroupList/items/<S1..S24|A1..A96>/control/pp/{xTake,xCut,xStepBack}

Transition times, in TENTHS of a second
  device/screenAuxGroupList/items/<id>/control/pp/{takeUpTime,takeDownTime}

Screen preset recall - note screens and auxiliaries split here
  device/presetBank/control/load/slotList/items/<n>/screenList/items/<S..>/presetList/items/<PROGRAM|PREVIEW>/pp/xRequest
  device/presetBank/control/load/slotList/items/<n>/auxiliaryList/items/<A..>/presetList/items/<PROGRAM|PREVIEW>/pp/xRequest

Master preset recall
  device/masterPresetBank/control/load/slotList/items/<n>/presetList/items/<PROGRAM|PREVIEW>/pp/xRequest

Feedback
  device/screenAuxGroupList/items/<id>/status/pp/{isUsed,transition,take,tbarPosition}
```

`screenAuxGroupList` holds screens *and* auxiliaries in one list of 120. The
screen/auxiliary split exists only under `presetBank`, which is easy to get
wrong and silent when wrong — an aux recall addressed through `screenList`
simply does nothing.

`isUsed` is how the timeline knows which screens are actually configured. There
is no other way: the list always contains all 120.

## Transition times are a screen property, not a take argument

A cue with its own fade has to write `takeUpTime`/`takeDownTime` and then
trigger. Any other client that changes those between the two writes wins. The
cue engine writes the time immediately before the trigger to keep the window
small, and does not pretend the race is closed.

## Nothing acknowledges anything

Recalls and takes return no reply. Success is silent and so is failure. The
only way to learn what happened is to watch the status properties, which is why
the cue log says "sent" and the status strip is a separate reading.
