# HyperDecks

Play, cue and record Blackmagic HyperDecks, and anything that answers their protocol, from the
switcher's own UI. Rules make the decks follow the show: a deck plays when its input goes on air,
pauses or loads its next clip when it is taken off, and the switcher takes when a clip ends.

**PLUS ▸ HyperDecks.** The plugin is `plugins/hyperdeck/`.

> ⚠️ **Never run against a real HyperDeck or a real Mitti.** The protocol is written from
> Blackmagic's published *HyperDeck Ethernet Protocol* (1.11 and later) and proven against
> `tools/hyperdeck-sim.mjs`, an emulation of it in this repo, and against the LivePremier
> simulator's store. The procedure at the end proves it on your own deck; do it before a show.

## Mitti is the reference

[Mitti](https://imimot.com/mitti) set the shape of this feature twice over.

- **It speaks HyperDeck.** Switch HyperDeck control on in Mitti's preferences and it answers the
  protocol on TCP 9993, with its cues as the clips — which is how ATEM Software Control drives it.
  It cannot play backwards, so it has no shuttle or jog, and it records nothing. Here that is a
  **profile**, *Mitti (HyperDeck emulation)*: Record is not offered, and a record sent to it by a
  cue or OSC is refused before it reaches the wire, saying why.
- **Its ATEM integration is the rule set.** Mitti watches an ATEM and plays when its input is put
  on program, does one of four things when the input is taken away (nothing, pause, rewind, load
  the next cue), and at the end of a cue can make the ATEM CUT or AUTO. Here the switcher does the
  watching, so the same choices work for any deck, Mitti included — and where Mitti follows only
  the first M/E of an ATEM, a deck here can follow any set of LivePremier screens.

## Adding a deck

The **Add a deck** row at the foot of the panel: a name, the deck's address, its port (9993), its
kind, and its role.

| Kind | Plays | Records |
|---|---|---|
| Blackmagic HyperDeck | ✓ | ✓ |
| Mitti (HyperDeck emulation) | ✓ | — |
| Other HyperDeck-compatible | ✓ | offered; the deck says if it cannot |

| Role | |
|---|---|
| **Player** | Feeds a switcher input. Its rules can follow what is on air. |
| **Recorder** | Records a switcher output. Record and stop from the panel, a cue or OSC. |
| **Player and recorder** | Both. |

Under **Settings and rules** on its card:

- **Plays into** — the plug on the back of the frame the deck's output is cabled to, as the
  switcher names it (`Input 1 · card IN_1 · hdmi`). This is what the rules watch; a deck with no
  input linked has no rules to run.
- **Records** — the switcher output cabled to a recorder's input. For the record: nothing switches
  it, and it makes the patch readable on the card.
- **Default clip name** — what a recording is called when nobody typed one.
- **Connected** — off hangs the link up and keeps every setting.

The deck list belongs to the installation, like Matrix Routing's routers: a deck does not move when
the app is re-pointed at a backup frame. It is `hyperdecks.json` in the data directory, and the
setup file carries it as the `hyperdecks` section.

## The card

What each deck is doing, as the deck said it — the transport, the clip and its name, elapsed and
remaining time, the video format and the disk — and its buttons: **Prev**, **Top** (back to the
start of the clip), **Play**, **Stop**, **Next**, a clip list to cue from, and on a recorder a clip
name and **Record**. **ON AIR S1** and **PVW S2** tags say where the deck's input is right now.

A button does not light because it was pressed; it lights when the deck reports the state. A deck
that refuses play — no disk, remote control off — does not show as playing.

**Record all** and **Stop recorders** in the toolbar send to every deck that records.

A deck that answers *remote control disabled* is told to allow it and asked once more. That is the
one setting this app changes on a deck, and only because an operator just pressed a button on it.

## Rules

Off until **Follow the switcher** is ticked, the way Mitti's ATEM trigger is off until enabled — a
deck added to the list must not start rolling the next time somebody cuts to its input.

| When the deck's input is… | Choices |
|---|---|
| **put on program** | Play · Do nothing |
| **put in preview** | Rewind to the top of the clip · Do nothing |
| **taken off program** | Do nothing · Pause · Stop and rewind · Stop and load the next clip |
| **its clip ends** | Take · Cut · Do nothing |

- **On air** means the input is the source of a visible layer in a screen's program buffer.
  **During a transition both buffers count**, so a deck starts rolling as its take begins, not
  once the mix has finished and the first second has gone by unseen.
- **Screens** — none ticked means every screen and aux; tick some to narrow it. A deck on air on
  a screen outside its set is, for its rules, not on air.
- **When a clip ends** takes (or cuts) the screens the deck is on air on at that moment — the
  screen's own transition, so whatever is in preview comes up. A deck that is not on air ends its
  clip with no transition.
- **Seconds early** fires the end action that long before the last frame. Set it to the length
  of the mix and the transition finishes on the end of the clip rather than starting there.
  Needs a deck that lists where its clips start (protocol 1.11 and later); on an older one the end
  is still caught when the transport stops, just without the lead.

**A clip has ended** when the deck's transport stops by itself, or plays on into the next clip.
A stop or a clip change this app sent is not an end, and nor is a stop with plenty of the clip
left — somebody pressed Stop on the deck. Each play of a clip fires its end action once.

### Where the rules run, and what that costs

The rules need to know what is on air, and **the server holds no store mirror** — that is the
app's founding rule, `server/awj.js` argues why. The page has the live store, so the rules run
in the page, and the server carries them out.

- **One page runs them at a time.** Every open page asks for the lease every few seconds; only
  the holder acts, so two tabs do not both press play. The panel says which: *This page is running
  the rules*, or that another page is.
- **A page that starts running them acts only on what changes after.** Loading the page, or
  taking over from one that closed, never plays a deck already on air.
- **The price is the Timeline's:** automation needs a Web RCS page with this app in it open
  somewhere. With none open, the decks still answer the panel's buttons, cues and OSC, but
  nothing follows the switcher, and the panel says so.
- What the rules did is listed at the foot of the panel.

## Cues

A cue can drive decks: in the Timeline's editor, the **HyperDeck** field takes

```text
VT 1 clip 3; VT 1 play; recorders record Act 1
```

— one action per `;`, each a deck and then what to do: `play` (`play loop`), `stop` (`pause`),
`record [name]` (`rec`), `clip N` (`cue N`, `goto N`), `next`, `prev`, `rewind` (`top`). A deck is
named by its name (spaces allowed), its position in the list, or a group word: `all`, `players`,
`recorders`. A group is sent only what each member can do, so `all stop` stops everything and
`all record` starts only the recorders.

Like every contributed cue action, these run as the cue fires, before its take.

## OSC

`/hyperdeck/<deck>/<command> [argument]`, over UDP and typed at the Console alike —
[docs/OSC.md](OSC.md#hyperdecks) lists them.

## Proving it on your own deck

Once per deck model and firmware, before a show:

1. Add the deck, confirm the card reads its model, clip list and format, and that the countdown
   runs while it plays.
2. Play, Stop, Next, Prev, Top and a clip from the list, each from the card.
3. A recorder: record ten seconds and check the new clip arrives in the list after Stop.
4. Stop the deck from its own front panel mid-clip: nothing should fire.
5. Tick **Follow the switcher** on a player with *Play / Rewind / Stop and load the next clip /
   Take* on a screen that is not on air anywhere, and run it: preview (rewinds), take (plays), let
   the clip end (takes), take away (loads the next clip). Try a lead of the take time and watch the
   mix land on the last frame.
6. For Mitti: its cue list is the clip list, *Pause at end* on a cue is what makes its transport
   stop at the end, and Record should be absent.

Record what the deck reported in its **model** and protocol version beside the result.

## Files

| | |
|---|---|
| `plugins/hyperdeck/protocol.js` | The protocol's words: the reply parser, the readers, the command lines, the profiles. No I/O. |
| `plugins/hyperdeck/link.js` | One deck's TCP link, kept up; noticing a clip end. |
| `plugins/hyperdeck/core.js` | The deck list's shape, the rules, what is on air, the cue text. Shared by both halves. |
| `plugins/hyperdeck/server.js` | The supervisor, the routes at `/__lpp/hyperdeck`, the rules lease, the setup-file section, `/hyperdeck/` OSC. |
| `plugins/hyperdeck/client.js` | The page half: running the rules, the cue action. |
| `plugins/hyperdeck/panel.js` | The panel. |
| `tools/hyperdeck-sim.mjs` | An emulated deck: `node tools/hyperdeck-sim.mjs [--port 9993] [--mitti]`. |
| `test/hyperdeck.test.js` | Parser, link against the emulation, rules against simulator store fixtures, the plugin's routes. |
