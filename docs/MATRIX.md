# External matrix routing

Patch the switcher's own SDI and HDMI connectors to ports on a **Blackmagic
Videohub**, a **Lightware** or a **Turtle AV** router, then route through it
from the panel, from a cue, from the Console or over OSC.

> ⚠️ **What has been proven, and what has not.** The Videohub driver is a port
> of BlackMatrix's, which was exercised against a working implementation of the
> protocol and against this app end to end — **but no real Videohub has ever
> been in the loop**, there or here. The Lightware and Turtle AV drivers are
> written from their vendors' protocol documentation and **have never spoken to
> the hardware at all**. The patch model and the connector reader *are* checked
> against a real LivePremier's own store. Prove the drivers on your own kit
> before a show; the section at the bottom says exactly how.

---

## The one idea

A router port and a switcher socket are the two ends of one cable, so the
direction inverts:

```text
  switcher INPUT   <--- cable ---   router OUTPUT     (the router feeds us)
  switcher OUTPUT   --- cable --->  router INPUT      (we feed the router)
```

That inversion reads wrong at first glance every time, so the patch form says
which way round it wants as you fill it in. You tell it about the **cable**;
everything else is worked out.

From it, two operations fall out — and they are not symmetrical:

| | What you choose | Crosspoints |
|---|---|---|
| **Feed** a switcher input | one router source | exactly one |
| **Send** a switcher output | any number of router destinations | one per destination |

An input is fed by one router output, so choosing what it sees fully determines
the result. An output arrives at one router input, which can be on any number
of destinations at once.

⚠️ **A send adds and never takes away.** Naming outputs 1-4 routes those four
and leaves output 5 alone, even if it was showing this source a moment ago. A
router output always shows *something*, so "removing" a destination would mean
choosing a different source for it, and there is no answer to which one.

---

## Setting it up

**Matrix Routing** is in the **PLUS** section of the sidebar, beside the VPU
map — both are whole-device views, about the back of the frame rather than
about one screen.

1. **Add a router.** Name, protocol, address. The port follows the protocol's
   own default (9990 / 6107 / 8000) until you type one.
2. **Patch the cables.** Pick a socket, pick the router, give the port number
   at the other end of that cable. The form tells you whether it wants a router
   *input* or *output* number, which depends on which side of the switcher you
   picked.
3. **Route.** An input row gets a source dropdown; an output row gets a
   destination field that takes `3`, `1-4` or `1,2,5-8`.

The **Now** column is what the *router* says, never what was asked for. A click
does not move the grid until the router agrees — see "Nothing is optimistic"
below. It stays live while somebody else is at the router's own front panel.

### On the input and output pages themselves

The same routing is also where you configure the socket, so you do not have to
walk to the Matrix Routing page and back:

| Page | What appears |
|---|---|
| **Inputs** ▸ an input, **Outputs** ▸ an output | a **Router** tab beside Signal / Aspect / Keying |
| **Preconfig** ▸ **Inputs** / **Outputs** ▸ a card | a **Router** box under the vendor's own boxes |

Each shows the cable (and lets you patch or change it right there), then the
router's ports twice — as a **grid of tiles** and as a **list** with the
router's own port names:

- An **input** picks one router source. Click a tile, or a row's radio button,
  and it routes straight away.
- An **output** picks any number of router destinations. Clicking tiles or
  ticking rows builds a selection (dashed outline); **Route** sends it. A tile
  that is solid blue is one the router already reports as carrying this
  output, and the list says what every other destination is showing now —
  which is what a route there would replace.

⚠️ **This is live, not part of Preconfig's Apply.** A router route taken from
the Preconfig box goes to the router immediately, like one taken anywhere
else; Apply only concerns the switcher.

The tab and box are drawn with the vendor's own classes and a header cloned
from the box beside it, so they follow Web RCS's look. On the input and output
pages the vendor's tab strip already overflows at ordinary window sizes, so
adding **Router** lets that strip wrap to a second row rather than hiding a tab
past the edge.

### What the sockets are called

The panel uses the device's own vocabulary and invents no numbering:

```text
  Input 13 · card IN_2 · connector IN_25 · sdi
  Output 5 · card OUT_2 · hdmi
```

"Card 2, port 1" is how people talk, but which connector that is depends on a
legend this app cannot see, so it shows what the device says and lets you match
it to the silkscreen.

> ⚠️ **Inputs and outputs are not keyed the same way**, and both spellings are
> in the same store: logical input 5 is `IN_5` and its connector is `IN_9`,
> while logical output 5 is `5` and its connector is `5`. `IN_1` even names two
> different things depending on the field — logical input 1 as a key, the first
> input *card* under `mapping.card`. `src/core/connectors.js` absorbs all of
> this; nothing above it has to know.

---

## What is per device and what is not

| | Where it lives | Why |
|---|---|---|
| **The routers** | `~/.livepremier-plus/matrices.json` | A Videohub does not move when you fail over to a backup frame. Re-pointing the app must not drop it off the network. |
| **The patch** | `~/.livepremier-plus/patch-<device>.json` | It describes *this* frame's sockets. A different frame is a different set of cables. |

Same split, and the same reasoning, as the OSC port versus the cue stack.

The patch is filed beside the cue stack rather than inside it: a stack is a
show and a patch is the rig it runs on, so importing somebody else's cue list
must not import their cabling with it.

---

## Firing a route from a cue

A cue can carry a matrix action alongside its recalls and takes. Two kinds,
because feeding and sending are different operations:

- `matrixFeed` — `{ connector, source }`
- `matrixSend` — `{ connector, destinations }`

They are sent **immediately**, alongside the recalls and ahead of the take
whatever order the cue lists them in, because the take is deferred by the
settle. That is the ordering that matters: a signal has to be present on an
input before anything switches to it, or the old source is on air for the
length of the transition.

They are **outside the settle**, because the settle exists to stop a TAKE
overtaking its own preset recall and a crosspoint is not a recall.

> ⚠️ **A cue does not wait for the signal to lock.** An SDI reclock is fast; an
> HDMI or HDCP handshake through a router can take a second or more, and no
> protocol here reports when it is done. A cue that routes and takes in the same
> breath can take to black. Put the route in an earlier cue when the format may
> change.

---

## From OSC and the Console

Three addresses, listed in full in **[OSC.md](OSC.md)**:

```text
  /lp/matrix/input/5/source        7        switcher input 5 now sees router input 7
  /lp/matrix/output/2/destinations "1-4"    switcher output 2 out of router outputs 1-4
  /lp/matrix/hub/route/3           9        router "hub": output 3 takes input 9
```

The same lines work typed at the Console, and they take the **same code path** —
the Console posts them to the launcher rather than resolving them in the page,
so an address that works from QLab cannot stop working from the keyboard.

These addresses are deliberately **not** in mynah, unlike every other address
this app answers. Mynah is the one statement of the *switcher's* grammar, and a
router in front of the switcher is not the switcher — it is not in the device
store and mynah has never heard of it. They live in `src/core/patch.js` instead.

A matrix route needs no switcher: it does not touch the device, so it is not
refused when no frame is configured or the frame is unreachable.

---

## Nothing is optimistic

**A driver never writes its own state.** `route()` sends and returns; every
field of a router's reported state is only ever set from what that router said.

This is not fastidiousness. A request can be refused by a lock, clamped,
ignored by a frame in a mode that forbids it, or overridden a moment later by
somebody at the front panel — and a Videohub answers a refused route with ACK
followed by the *unchanged* routing, so a refusal is indistinguishable from a
command that never arrived except that the state does not move.

The visible consequence is that a click does not move the grid until the router
agrees. That is the feature.

---

## The three protocols

| | Port | Counts from | Pushes changes | Proven against hardware |
|---|---|---|---|---|
| **Videohub** | 9990 | **0 on the wire** | yes | no |
| **Lightware LW3** | 6107 | 1 | yes (polled anyway) | no |
| **Lightware LW2** | 10001 | 1 | no — polled | no |
| **Turtle AV** | 8000 | 1 | no — polled | no |

⚠️ **The Videohub wire counts from 0 and everything else in this app counts
from 1.** Output 1 on the front panel is `0` in a `VIDEO OUTPUT ROUTING` block.
`server/matrix/videohub.js` is the only file allowed to know that, and the
conversion happens in exactly two marked places — the same containment
`core/paths.js` gives the AWJ spelling. An off-by-one here routes a real
crosspoint next to the one asked for, and looks entirely plausible doing it.

**Lightware speaks two unrelated protocols** and the driver asks which rather
than trusting the port: it sends an LW3 read, and falls back to LW2's product
query if nothing LW3-shaped answers. A frame that answers neither is reported
as connected but unidentified, and **refuses to route** — sending LW2 braces at
an LW3 parser is how you find out what it does with garbage on a show day.

**Turtle AV volunteers nothing**, so it is polled every four seconds. A route
taken at its front panel is invisible until the next tick. Its `0` means "all
outputs" on both the read and the write, so `s output 0 in source 1!` would put
one input on every output at once — `route()` refuses output 0 for that reason.

### Polling is a compromise, not a design

Where a driver polls, it says so, and the right period is a property of the
protocol rather than a setting. LW3 is polled *as well as* subscribed because
the exact framing of an unsolicited change differs across the LW3 families and
this author cannot prove which one a given frame sends. Take the polling out
once a real frame has shown you its push format — not before.

---

## Proving it on real kit

Nothing below needs a switcher; a router and this app are enough.

1. **Add the router and watch the Link column.** `connected`, plus a size and a
   model it reported, means the protocol handshake worked. `connecting` that
   never settles is usually the wrong port; for Lightware, check the Protocol
   column names LW2 or LW3 rather than staying blank.
2. **Route one crosspoint from the panel and watch the router's own front
   panel.** If the grid moves and the router does not, the command is being
   refused silently — a lock, or a port out of range.
3. **Move a crosspoint at the router** and watch the Now column. It should
   follow within a second on a Videohub or LW3, and within the poll period on
   LW2 or Turtle AV. If it never follows, the subscription is not working and
   the driver is running blind between polls.
4. **Check the off-by-one deliberately.** Route the router's output 1 and
   confirm that output 1 — not 2, and not 12 — is what moved. This is the
   failure that survives every other test.

If a driver needs correcting, the command strings are collected in one table at
the top of each file for exactly that reason.

---

## Where the code is

| | |
|---|---|
| `src/core/connectors.js` | Reading the frame's sockets out of the device store. Pure. |
| `src/core/patch.js` | The cable schedule, the two operations, the OSC address space. Pure. |
| `server/matrix/driver.js` | What a driver is, and the TCP plumbing all three share. |
| `server/matrix/{videohub,lightware,turtle}.js` | One protocol each. |
| `server/matrix/index.js` | The supervisor: one connection per router, kept up. |
| `src/ui/matrix-panel.js` | The panel. |
| `src/ui/router-box.js` | The Router tab and box on the vendor's own input and output pages. |
| `test/matrix.test.js` | 51 tests. What they can and cannot prove is in their header. |

`core/` knows nothing about browsers or sockets and runs under plain Node,
which is how the patch arithmetic is testable without a rack.

### Why this holds connections open when `server/awj.js` refuses to

`awj.js` argues at length that it must never hold a socket or subscribe to
anything. That argument is about the **store mirror** — about not becoming a
second source of truth for state the vendor socket already carries. None of it
applies here, because an external router is not in the store at all: there is
no mirror to contradict, its crosspoints change without us, and the five-client
budget `awj.js` respects is a limit on the Analog Way frame, not on a Videohub.
