# Dante

**PLUS ▸ Dante** — the Dante audio network's routing, as a crosspoint grid, beside the switcher it
feeds. Find the devices, read their channels and subscriptions, change them, save and recall
routing snapshots, and trade presets with Dante Controller.

> ⚠️ **Preview. It has never spoken to a real Dante device.** Everything below was proved against
> `tools/dante-sim.mjs`, a simulated network built from the same tables as the code, and the
> protocol codec is held to packets Dante Controller itself sent (see [Proven, and not](#proven-and-not)).
> It is **off by default**: Preconfig ▸ LivePremier Plus → Plugins → Dante. Before a show, run
> [the first real-device test](#the-first-real-device-test).

## Why two halves, and not one

Dante Controller has no remote-control interface: nothing outside it can ask it to make a
subscription. So this is not "Dante Controller integration" in the sense of driving Dante
Controller. It is the two things that can honestly be done:

1. **Our own Dante routing control.** Dante's control protocol is unpublished, but the open-source
   **netaudio** project ([network-audio-controller](https://github.com/chris-ritsen/network-audio-controller),
   Unlicense) has reverse-engineered the parts that matter, and `plugins/dante/protocol.js` is a
   faithful port of them: device names, channel counts, sample rate and latency, transmit and
   receive channels, every subscription and its status, and adding and removing subscriptions.
2. **Dante Controller's own file format.** Dante Controller saves and loads **presets** — plain XML
   that its user guide says may be edited by hand. This app writes a preset of what it reads off
   the network, which Dante Controller loads with File ▸ Load Preset, and reads a preset Dante
   Controller saved, showing exactly what applying it would change before anything is sent.

The two run beside each other: Dante Controller can stay open, and a change made in either shows
in the other.

## The one idea

**In Dante, routing belongs to the receiver.** Each receive channel carries at most one
subscription, naming a transmit channel by its label and a device by its name — `Mix L@Desk` in
Dante's own notation. Nothing at the transmitter records who is listening. So every route here is

```text
{ rx: { device, channel }, tx: { device, channel } | null }      null clears the receive channel
```

and every way of asking for one — a click, a cue, an OSC address, a snapshot recall, a preset — is
reduced to a list of them and goes through one path:

```text
  routes ──plan()──▶ only what differs ──write──▶ the devices ──read back──▶ confirm() ──▶ what they say
```

`plan()` (`core.js`) drops everything already so and names everything that cannot be done
(`missing`: no such device or channel; `refused`: a device that cannot be written, or a name Dante
will not take). The supervisor sends the rest in each device's own encoding and **reads its receive
channels again**; `confirm()` reports, per channel, what the device says now — `confirmed`,
`unconfirmed` (it accepted the write and reports something else) or `refused` (it said no, or never
answered). Nothing anywhere reports what was asked for as if it had happened: Matrix Routing's
rule, for the same reason.

`confirmed` means the receiver now holds that subscription. Whether audio is flowing yet is its
**status**, reported beside it — a new subscription reads *Establishing flow* for a moment, and one
to a device that is not on the network reads *Unresolved*, which is legitimate: it connects when the
device appears.

## Setting it up

1. Switch it on: **Preconfig ▸ LivePremier Plus → Plugins → Dante (preview)**, then reload.
2. **Settings ▸ Dante**:
   - **Find Dante devices on the network** — on by default. Asks over mDNS every 30 seconds.
   - **Interface** — every interface, or one. A laptop with Wi-Fi and a Dante NIC asks on both
     unless told which.
   - **Devices by address** — `192.168.1.20`, or `192.168.1.20:4440` for a control port other than
     4440. For a network where multicast does not reach this machine; such a device is asked
     directly.
   - **Read every** — how often each device's receive channels are read again (5 s by default),
     which is how a change made in Dante Controller shows here.
   - **This switcher's Dante card** — normally found on its own; see below.
   - **Discovery target** — for testing only: `127.0.0.1:<port>` sends every question to the
     simulator instead of the network.

## The panel

Receivers down the side, transmitters across the top, as **device blocks**: a block says how many
of the receiver's channels take from that transmitter, and is solid when it is channel for channel
(1→1, 2→2 …). Click a device's name to **open it into channels**; where an open row meets an open
column, each cell is one subscription, coloured by its status — connected, in progress, unresolved
or failed, with the device's own reason on hover.

- **It opens locked.** Clicks open and close devices and change nothing until **Unlocked**. The
  grid reaches every device on the audio network — the console, the amplifiers, somebody else's
  interface — and a stray click there takes a feed away from somebody's show. Cues, OSC, snapshot
  recalls and preset applies are deliberate already and are not held by the lock.
- **A click on a cell** subscribes that receive channel to that transmit channel, or clears it when
  it is already so. **A click on a block** lays the transmitter across the receiver channel for
  channel, or clears exactly that when it is already so — asking first when that is more than eight
  subscriptions.
- **Nothing lights until the device says so.** A clicked cell waits (dashed) until the receiver has
  been read back. The result of the last change is listed under the grid, channel by channel.
- **Filter** narrows devices and channels by name; **Routed only** hides empty receive channels and
  the transmitters nobody takes from.
- **Devices** lists each one: model, address, ARC revision and which inventory dialect it answers,
  sample rate, latency, channel counts, and why it cannot be written if it cannot.
- **It pops out**, sharing the tab's devices and its one stream.

### The switcher's own card

A LivePremier with a Dante card describes it in its store (`switcher.js` has the paths): a Dante
name, its addresses, and a label and a `connectedTo` for each of its 64 channels. The panel finds
that device on the network — by the name, then an address, then a MAC, then the setting — marks it
**this switcher**, and shows beside each of its channels what the switcher's **Audio Matrix** does
with it: a receive channel lists the outputs it feeds (`→ Output 7 ch 1`), a transmit channel the
input it carries.

> ⚠️ Two of those readings are inferences the simulator cannot confirm: that the store's `id` *is*
> the card's Dante name, and that `DANTE_<b>_CHANNEL_<c>` is Dante channel (b − 1) × 8 + c (the
> Audio Matrix numbers it so too). The first real-card test checks both.

## Dante Controller presets

**Export preset** downloads a preset of every device read: names, transmit labels, receive channel
names and their subscriptions, and the sample rate, latency and device id where the device
reported them. Load it in Dante Controller with **File ▸ Load Preset**; it is a version 2.1.0
preset, written the way Dante Controller writes one. Nothing is invented to fill a field Dante
Controller would have filled — a device's default name, for one, is not written because nothing
here can read it.

**Import preset…** reads a preset Dante Controller saved and shows the difference against the
network as it reads now:

- Each **role** (Dante Controller's word for one device's saved configuration) is matched to a
  device the way Dante Controller matches it — the device it was saved from, by device id, then a
  device with its name — and each can be pointed at another device, or at none. Dante Controller's
  third rule, any free device of the same make and model, is left to you: a guess there routes
  somebody else's amplifier.
- The difference lists every receive channel that would change, what it carries now and what it
  would carry after. **As Dante Controller does, a receive channel the preset leaves empty is
  cleared — and so is one the device has and the preset does not list** ("Any existing
  subscriptions on the target system that do not exist in the preset will be removed" — its user
  guide). Those are marked.
- **Apply** sends exactly the difference that was shown. If the network changed in between, it is
  refused and the difference is shown again.

Only subscriptions are applied from a preset. Its device names, channel names, sample rates,
latencies, clocking and network settings are never written: Dante Controller is the tool for
those.

## Snapshots

**Save current routing** keeps every receiving device's subscriptions under a name. **Recall**
puts back only what differs, after saying how many subscriptions that is, and lists what it could
not do. Snapshots belong to the installation, not to one switcher — the Dante network does not move
when the app is pointed at a backup frame — and travel in the setup file as `danteSnapshots`.

## Cues and OSC

The Timeline's **Dante** field:

```text
snapshot Show A                    recall a snapshot
1@Amp-1 <- Mix L@Desk              subscribe receive channel 1 of Amp-1
Front L@Amp-1 <- none              clear a receive channel, named by its label
```

`;` between several. Like every contributed action it runs with the recalls, ahead of the take,
and is not awaited: a route that did not take comes back as a warning on the cue, naming what the
device reports.

Over OSC and at the Console, under `/lp/dante/` — the table is in [OSC.md](OSC.md#dante--preview):
`/lp/dante/snapshot/Show-A/recall`, `/lp/dante/route/Amp-1/2 "Mix R@Desk"`,
`/lp/dante/clear/Amp-1/2`. A trigger's release (`0`) sends nothing.

## How it talks to the network

### Finding devices: questions from a port of our own

Dante devices advertise with DNS-SD: a `_netaudio-arc._udp` instance per device, named after it,
whose SRV record is the control port and whose TXT record carries `arcp_vers` — the control
protocol revision — and the maker and model; a `_netaudio-cmc._udp` instance whose TXT `id` is the
device id (its MAC and four zeros).

The operating system already runs an mDNS responder on UDP 5353, and Dante Controller and Dante
Virtual Soundcard depend on it. **This never binds port 5353.** Every question goes out from a port
the OS picked, which makes it a *legacy unicast* query (RFC 6762 §6.7): each responder answers it
directly, by unicast, so nothing shares the port and nothing joins the group. The cost is that
nothing is pushed — the network is asked again every 30 seconds, and a device silent for three of
those is dropped. A device configured by address is asked by a unicast question to its port 5353
(RFC 6762 §5.5), which crosses a router where multicast does not.

### Reading and writing a device

One UDP socket per device (`link.js`), one request in flight, a short gap between requests, a 700 ms
timeout and two retries, and an answer accepted only from the device's own address with the
transaction id that was sent. Each device is read in full when found and every sixth poll, and its
receive channels on every poll. A device that misses two polls in a row is **unreachable**, asked
less often, and never written to.

Two generations of the protocol are spoken, chosen by the revision the device advertised:

| advertised | inventory | a write goes as | evidence for the write |
|---|---|---|---|
| `2.8.9`, `2.8.12`, `2.8.15` ("modern") | channel-status pages `0x3400` / `0x2400`, falling back to classic on `0x0030` | the subscription page `0x3410` under the device's own revision | the bytes Dante Controller sent a 2.8.9 device |
| `2.7.41` | classic pages | the 32-record page `0x3010` under `0x2729` | the bytes Dante Controller sent a 2.7.41 device |
| `2.8.1`, or none (a device by address that read cleanly) | classic pages | netaudio's add `0x3010` and remove `0x3014` under `0x27FF` | netaudio's own encoder only |
| anything netaudio has no observation of (e.g. `2.7.40`) | classic pages | **never written** | — |

There is no subscription to change notifications: Dante devices multicast them on a group this
would have to join, and polling keeps the "never touch the OS's sockets" rule simple. A change made
elsewhere shows at the next poll.

### Why holding sockets to Dante devices is allowed

`server/awj.js` refuses to hold a connection to the switcher, because the switcher's state already
has one source — the vendor socket — and a second reader could disagree with it about what is on
air. None of that reaches a Dante device: its subscriptions are held by the receiving device and
nowhere else (not in the switcher's store, not in the page), so there is no mirror to contradict;
they change without us; and ARC is datagrams with a transaction id, with no client budget like the
frame's five AWJ clients. `plugins/dante/link.js` says so at its head. What is kept from `awj.js`
and from Matrix Routing is the rule that matters: nothing here writes its own state.

## The protocol, and where each table came from

Every table is a port of netaudio's Rust core at commit
[`a3323a3`](https://github.com/chris-ritsen/network-audio-controller/tree/a3323a3f57830550bdc9c8ccf6e6ce358a518f43)
(2026-10-02), `packages/netaudio-core/src/`; `protocol.js` names the file and function beside each.
All numbers are big-endian; a request is `protocol u16, length u16, transaction u16, opcode u16,
payload`; an answer adds a `result u16` after the opcode; strings are reached by pointers counted
from the start of the packet.

| operation | protocol / opcode | netaudio | how this codec is checked |
|---|---|---|---|
| device name | `27FF` / `1002` | `commands/device.rs` `build_device_name`; `responses/device.rs` `parse_device_name` | captured answer (historical) |
| channel counts | `27FF` / `1000` | `build_channel_count`; `parser.rs` `parse_channel_count` | captured answer (historical) |
| sample rate, latency | `27FF` / `1100` | `build_device_settings`; `responses/device.rs` `parse_device_settings` | captured answers (historical) |
| receive channels, classic | `27FF` / `3000`, 16 a page | `build_receivers`; `parser.rs` `parse_rx_page` | captured answers, including two under `2729` |
| transmit channels, classic | `27FF` / `2000`, 32 a page | `build_transmitters`; `parse_tx_info_page` | netaudio's encoder; the simulator |
| transmit labels | `27FF` / `2010` | `build_transmitter_names`; `parse_tx_friendly_page` | a user's device (netaudio issue #59) |
| subscription status | — | `subscription_status.rs` `decode` | netaudio's table, incl. the code-1 ambiguity |
| add subscriptions, classic | `27FF` / `3010` | `commands/subscriptions.rs` `build_add_subscriptions` | netaudio's encoder only |
| remove subscriptions, classic | `27FF` / `3014` | `build_remove_subscriptions` | netaudio's encoder only |
| subscription page, 2.7.41 | `2729` / `3010` | `build_subscription_page_2729` | **Dante Controller's own requests** (4) |
| channel status, modern | `28xx` / `3400`, `2400` | `commands/flows.rs` `build_channel_status_query`; `responses/channel_status.rs` | **Dante Controller's own requests** to two Shure devices, their answers, and its page continuation |
| subscription page, modern | `28xx` / `3410` | `build_modern_arc_subscription_page` | **Dante Controller's own requests** (4) and the devices' answers |
| revision from `arcp_vers` | — | `protocol.rs` `arc_protocol` | netaudio's rule |

`test/fixtures/dante/netaudio-vectors.json` carries those bytes, each group with netaudio's own
account of where it came from.

## Proven, and not

**Independent evidence** — not made by this codec, and it agrees with them byte for byte:

- The subscription pages **Dante Controller sent** an ARC 2.8.9 device (four, captured with tshark
  during a preset load) and an ARC 2.7.41 device (four), and the 2.8.9 devices' acknowledgements.
- The channel-status queries Dante Controller sent two Shure devices (ARC 2.8.12), and those
  devices' answers (names sanitised by the contributor; every numeric field intact).
- Dante Controller's own continuation of a paged channel inventory (ARC 2.8.15) — the next request
  it chose after a "more pages" answer. The answer it was continuing from was synthetic.
- Answers from real devices: modern status pages, classic receive pages with live subscriptions,
  transmit labels (a user's device, netaudio issue #59), device settings. netaudio marks its
  oldest captures as regression inputs whose capture records were not kept.
- **A preset Dante Controller saved** (published as an example by DanteArchitect, MIT) reads into
  its nine roles and seventeen subscriptions.

**Proved only against the simulator** — so it shows the pieces fit, and nothing about a real
device: discovery end to end, the link, polling, a change made behind our back appearing, all
three write forms followed by read-back, refusal and silent-acceptance and unreachable devices,
snapshots, preset export → difference → apply, the cue action, the OSC addresses, the setup-file
section, and the panel in a browser (LivePremier Simulator 6.2.73's store, with the switcher's card
matched by name and its Audio Matrix shown beside its channels).

**Not proven at all:**

- That any real device answers these requests as the captures did. No request from this code has
  ever reached one.
- The classic add and remove (`27FF` / `3010`, `3014`) — there is no Dante Controller capture of
  them; they are what netaudio has sent for years.
- Discovery against real responders: the questions follow RFC 6762, and the simulator answers them;
  no real responder has.
- The switcher's card: that its store `id` is its Dante name, and the channel numbering.
- The pop-out, which the in-app browser cannot open as a second window.

## The first real-device test

Two rigs, either of them on the Mac this runs on. Capture UDP 4440 and 5353 with Wireshark or
`tshark` throughout: the bytes are the evidence, and they are what the next fixtures should be cut
from.

**A. Dante Virtual Soundcard (no hardware).** Start DVS with a small channel count and Dante
Controller beside it. Switch the plugin on, leave discovery on, pick the interface DVS uses.

1. DVS appears in the device list with its name, `arcp_vers`, model, channel counts, sample rate
   and latency — check each against Dante Controller's Device View. *Proves discovery against a
   real responder and the read path in whichever dialect DVS speaks.*
2. In **Dante Controller**, subscribe one of DVS's receive channels to anything. It appears here
   within a poll. *Proves the receive-channel read and the subscription fields.*
3. Here, unlocked, subscribe another DVS receive channel to one of its own transmit channels — a
   self-subscription. Dante Controller shows it, and this panel's result reads `confirmed` with a
   status of *Subscribed (self)*, or the device's refusal (*Self-subscription not allowed*) — either
   is an answer. Then clear it here, and see it clear there. *Proves the write in DVS's form and the
   read-back.*
4. **Export preset** here and load it in Dante Controller: its Load Preset dialog should list the
   role with no issues. Save a preset in Dante Controller and **Import** it here: the difference
   should be empty. *Proves the file both ways for the version installed.*

**B. The switcher's Dante card.** The same four steps against the LivePremier's card, plus: the
card is marked **this switcher** (proving the store's `id` is its Dante name — or not), and a
receive channel patched in the Audio Matrix to an output shows that output beside the same Dante
channel number here (proving the numbering).

Until one of those has been run and recorded in `docs/NOTES.md`, treat the first show with it as a
rehearsal — and keep Dante Controller open.

## The simulator

```sh
node tools/dante-sim.mjs --mdns-port 5399
```

Five devices on loopback — the switcher's card as the LivePremier Simulator names it
(`AQL-Simulator`), a 2.8.9 desk, a 2.7.41 stage box, a 2.8.15 amplifier and a 2.8.1 wall plate —
answering mDNS on the port given and ARC on ports of their own. Set **Discovery target** to
`127.0.0.1:5399`. It binds loopback only, by design. It models subscriptions settling, a source
that is not on the network, and on request a device that refuses writes, one that ignores them, one
that is silent, and one that will not answer the modern queries. **It is built from
`protocol.js`'s own tables, so it is not evidence about a real device.**

## Files

| file | what it is |
|---|---|
| `plugins/dante/protocol.js` | the ARC codec: builders, parsers, status table — no I/O |
| `plugins/dante/mdns.js` | DNS messages for discovery — no I/O |
| `plugins/dante/core.js` | settings, the route model, `plan` / `confirm`, snapshots, cue and OSC grammar — no I/O |
| `plugins/dante/preset.js` | Dante Controller presets, read and written; the small XML reader — no I/O |
| `plugins/dante/switcher.js` | the switcher's card and its Audio Matrix, from the store — no I/O |
| `plugins/dante/discovery.js` | mDNS questions from an ephemeral port |
| `plugins/dante/link.js` | one device's UDP link |
| `plugins/dante/supervisor.js` | the readers, polling, writes and read-back |
| `plugins/dante/server.js` | routes, stream, OSC, setup-file section |
| `plugins/dante/model.js`, `panel.js`, `client.js`, `popout.html` | the page half |
| `tools/dante-sim.mjs` | the simulated network |
| `test/dante.test.js` | all of the above |
