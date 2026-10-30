# Notes

Working notes for this repo: status, decisions, and the traps that have actually bitten.
Migrated out of Claude Code's memory on 2026-08-24, so they are written in the first
person and dated by when each thing was learned — that date is usually the useful part.

Cross-cutting notes that are not specific to this repo live in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).

*LivePremier Plus (was webRCS unleashed) — a LOCAL REVERSE PROXY, no longer a Chrome extension, adding 46 built-in plugins to a real LivePremier (and, for most of them, Midra 4K / Alta 4K) Web RCS session in the vendor's own CSS; PUBLIC; verified through the proxy against simulators; the panels have written to real hardware twice (below)*

## Where it stands (2026-10-16, v0.17.7)

The dated entries below are a log, newest mostly at the top and the 10-16 ones at the end. This is
the summary, kept current by hand.

**Releases since the last summary:** 0.17.2 (10-13, the live suite's three fixes), 0.17.3 (10-16,
the RS4 fixes: tabs behind ⋯, arithmetic in 6.1.x number fields, the Layer tab's source list, the
VPU map on 6.1.60, the save race), 0.17.4 (the VPU map's pool said once), 0.17.5 (**Pixel Map**),
0.17.6 (**Surfaces**), 0.17.7 (**UMD Generator**, and the Pixelhue console suite in
`test/console/`).

**Off by default:** Preview lock, Surfaces, Aux follow, AoI from a custom format, Image Library
tools, and the UMD Generator, Dante, Thumbnail relay, Multiviewer thumbnails and Background Slicer
previews. Surfaces, the UMD Generator, Aux follow, AoI from a custom format and Image Library tools
are in `OFF_UNTIL_TESTED` (`test/plugins.test.js`) until a real frame has seen them. Aux follow,
AoI from a custom format and Image Library tools (2026-10-20, unreleased) are at the end of this
file. So are the **Barco EC panel** and the **ATEM Micro Panel** (both 2026-10-20, unreleased, in
`OFF_UNTIL_TESTED`): neither has met a panel, only a pretend one and the 6.2.73 simulator.
**Plug names** (2026-10-24, unreleased, in `OFF_UNTIL_TESTED`) is the newest entry below.
**grandMA3** (2026-10-30, unreleased, in `OFF_UNTIL_TESTED`) is at the very end: a desk driving the
switcher through its own OSC feedback, proven with grandMA3 onPC and the simulator, no wing.

**What real hardware has seen**, all of it:

- **Aquilon C** (`NLC_C`, 6.2.73, 2026-09-09/10/15): every path the app sends resolved, the store
  pulled whole, the VPU map read, and the panels opened and navigated in a browser. Read only.
- **Pulse 4K** (3.3.10, 2026-09-12/13): the Midra port's whole write vocabulary by a harness, 39
  checks, then the **Console's own lines typed by the operator**, the first panel writes to a real
  device.
- **Speed Editor** (2026-09-25): a real panel over USB through the device host.
- **Aquilon RS4** (`NLC_RS4`, 6.1.60, 2026-10-16): read-only pulls of the store, and **one preview
  opacity written by the Layer tab** and put back, both read over AWJ. Hardware is ask-first.
- **Aquilon C mini** (`NLC_CMINI`, 6.2.73, 2026-10-30): the Layer tab, Memories (save, rename,
  erase), the Console (a take, a store and raw AWJ lines), **the timeline's GO** (recall, fade,
  take), then Preview lock, Layer Groups and Send-to, Surfaces and Pixel Map, then Audio Matrix,
  OSC input, arithmetic and Variables in a vendor field, and the UMD Generator's screen path
  through the Background Slicer (written and undone), each read back over AWJ and the store
  diffed afterwards. "Aquilon C mini" at the end has the rest.

Everything else, Dante and both thumbnail previews included, has run on simulators only; the
UMD Generator's aux path and a Background Slicer set on a real output have not been seen. The
Pixelhue panel has never met a console; the console suite has only run against its stand-in
(`LPP_CONSOLE=stand-in`, 31 pass, 3 skip).

**Background Slicer slides (2026-10-20, unreleased):** a PDF or a PowerPoint deck as a background
set per page, or every page as a still at any size. Simulators only: both kinds written, read back
and undone on the LivePremier 6.2.73 and Midra 4K 3.2.29 simulators; pages drawn in the pop-out;
an unsigned build of the desktop app converted a deck after macOS asked for App Data and
Automation. Keynote decks too, since later the same day, through Keynote Creator Studio.
"Slides in the Background Slicer", "Slides: the Midra, the pop-out and the desktop app" and
"Keynote after all" below.

**Open:** whether a frame draws a still on an aux's background. The RS4 (6.1.60) took and
reported one on 2026-10-17 but was factory reset before anyone looked at the output ("The
UMD Generator" below has the run); the next free frame needs someone watching the aux. MIDI Mapping and the Speed Editor still have no home
on a Midra: no Virtual RC400T to hang under, and the surface engine spells LivePremier. Since
2026-10-16 that is said rather than silent: they require `controlSurfaces` (no mng probe), so
their Plugins rows read *not on this switcher* with the capability's sentence. Giving them a
place on the mng sidebar waits for the engine to speak the dialect. Pixelhue Mapping has one
already: the same day it moved to the foot of PLUS on a Midra or Alta, and drew and edited the
mapping on the Midra 4K simulator 3.2.29. Its MVR key now names the live multiviewer page in both
spellings (`/live/multiviewers` on LivePremier, `/live/multiviewer` on Midra and Alta, read off the
bundles' route tables) and the page clicks whichever its sidebar has; handed the supervisor's
payload, the page half on the Midra simulator went from Screens / Aux. to LIVE ▸ Multiviewer.
SOURCE BACKUP is refused on Midra and Alta with the reason: their inputs have no backup (no
`backup` node in either bundle's input object; the card's ⋮ is plug, Setup, Freeze, Capture).
Neither key has been pressed on a console.

## Plug names — an input's label as its plug's EDID name (2026-10-24)

Asked for by Allan: In1 labelled "powerpoint main" should show up on the laptop as that, not
AQL_HDMI. Built as plugin `edid-names` (off by default, in `OFF_UNTIL_TESTED`), a Plug Names tab
the EDID builder draws on its strip while the plugin's service is there.

- **The vendor's own load is a raw write.** Read out of the 6.2.73 bundle (`input-card.tsx`):
  dropping a bank slot on an input sends the slot's `data` and `dataSize` to the plug's
  `edid/cmd/pp`, then `xStore` false, true. The same as Mosaic's write, so every bank load on a
  real Aquilon already goes this way. The card's `edid/cmd/pp/label` (max 16) is only a note the
  card shows; it is not in the EDID and nothing touches it.
- **The switcher parses what it is given.** After a write, `edid/status/pp` reports the new
  `productName` and `serialNumber` and keeps `hid` (ANW8002) and `prefFormatName`: the sim test
  uses those as its witness, not this app's reading of the bytes.
- **Stock plugs:** ANW, product 0x8002, serial 0, AQL_HDMI / AQL_DP in the fourth descriptor,
  a 0x00 (manufacturer) descriptor at 72. SDI plugs have `isAvailable` false.
- ⚠️ **Padding comes back.** A plug serves the 512 numbers it was sent. Mosaic padded with 0, the
  vendor (and the bank) with 0xFF, so an undo left the EDID right and the padding different.
  `writePlugEdid` (now `src/core/plug-edid.js`, shared with Mosaic) pads with 0xFF, and the sim
  test compares all 512.
- Only block 0 changes: the name (first 0xFC, else a 0x10 dummy; a second 0xFC becomes a dummy),
  the ID serial at 12–15, the checksum. An EDID with no free descriptor is refused. EDID Editor's
  `describeEdid` reads a renamed EDID as the same mode, timing and errors.
- The original is kept per switcher (`plug-names-<device>.json`) **before** the write goes out,
  and Undo is offered only while the plug still serves what was written.

Verified on the rack simulator: `test/sim/io.sim.test.js` (18/18, twice), and by hand in the
browser pane (In3 named PPT MAIN, the vendor's Inputs column showed it, Undo survived a reload).
The simulator was left matching a store snapshot taken before any of it. Not run on an Aquilon:
whether a written plug EDID survives a power cycle is still unknown.

## Slides in the Background Slicer (2026-10-20)

Allan asked for stills from PowerPoint and PDF files: open one, save a still of each slide, at a
resolution of the operator's choosing or as native background sets per screen, probably inside the
frame cutter. The frame cutter is the Background Slicer, so it went there: step 1 takes a document,
and **Make** is *A background set per page* or *Stills at a size*. Design and the run are in
docs/BACKGROUNDS.md "Documents"; the invariants in AGENTS.md under the Background Slicer.

What I found on the way, each one tried rather than assumed:

- **PowerPoint exports unattended over AppleScript** (16.112.3), as long as the deck sits in its
  own sandbox container (`~/Library/Containers/com.microsoft.Powerpoint/Data/tmp/`) and the script
  finds it by its own unique name. A save to anywhere else would stop on "Grant File Access". With
  one of Allan's decks open the whole time, nothing of his was touched. ~1–2 s a small deck.
- **Saving as .pptx renames the open presentation**, so a reference held from before the save
  stops resolving (-1728). Saving as PDF doesn't. Found making the test deck, whose close failed
  and left it open until closed by name.
- **PowerPoint's PDF drops hidden slides**: five slides, third hidden, four pages. The server now
  reads which slides show from the package and the panel names pages by slide number.
- **Keynote is a dead end here.** The first `Application('com.apple.iWork.Keynote')` lost its
  connection (-609), and Keynote Creator Studio (15.3.1, `com.apple.Keynote`) was running after
  it; the second launched the old Keynote 14.5, which sat on a "Use the New Version of Keynote" modal until the
  script was killed. Creator Studio addressed by its own id opened the deck twice and then answered
  -1728 / -1700 to every question. presentation-converter's Keynote engine (`engines/keynote.ts`)
  will meet the same on this Mac; worth telling it. Both Keynotes were quit afterwards.
  *(Correction, later on 2026-10-20: wrong about Creator Studio. The -1700 was my script handing
  the sandboxed app a `POSIX file` it couldn't read; Keynote drives fine. See "Keynote after all".
  The 14.5 modal stands.)*
- **pdf.js needs `wasmUrl`** or JPEG 2000 / JBIG2 images draw as nothing (Presentation Commander
  74a0e35), and `instantiateStreaming` needs `application/wasm`, which the proxy did not serve
  until now.

**Run on the local LivePremier Simulator** (Session 1, Aquilon Cmax 6.2.73) through the demo on
:8547: a deck PowerPoint made (five slides, slide 3 hidden) to stills at 2560 × 1440 in slots 1–4
and stills 1–4, and to S1 + S2 sets 1–4 with stills 1–12; each read back over AWJ and undone. The
same PDF opened directly and spanned across both screens, continuous at the seam. The Midra side is
unit-tested on the Midra 4K simulator's store only: the Midra simulator on :5000 was another
session's at the time. Another session's demo also had :8545, so mine moved to :8547.

**Not done:** a frame; LibreOffice; Windows; a packaged launcher build with the Apple-events
entitlement; README / guide screenshots and the
guide PDF; pdf.js in ATTRIBUTIONS.md (generated from stoatworks-backend, so it goes in there).
No Automation prompt has been seen at all: every conversion ran from a terminal that already had
permission to control PowerPoint. *(Later that day: the Midra, the pop-out, an unsigned launcher
build, screenshots and the guide PDF were done; the next entry.)*

## Slides: the Midra, the pop-out and the desktop app (2026-10-20)

The gaps the slides left, closed on simulators. No real switcher was touched: a show was running
on the Pulse 4K that day, and everything here used private copies of the simulators.

- **Midra 4K simulator 3.2.29**, a private copy of the session (web 3090, AWJ 10690, under
  `~/dev/sim-copies`, not `/tmp`), through `npm run demo` on :8547. Both kinds written, each write
  read back over AWJ, and undone; BACKGROUNDS.md "What was run" has the values. No code changed for
  it: the plan refused while S1's BKG1 pointed at the slot the first upload would take, and once
  that was cleared everything landed where the plan said.
- **The Midra simulator's download route wedges** on an emptied slot: `GET
  /api/device/images/download/<slot>` sets a module-level busy flag, starts an export and waits for
  a status that never comes, so every later download answers 503 until the web server restarts.
  Uploads have their own flag. Read out of `server.app.js` (`Zd` for downloads, `jd` for uploads).
- **The pop-out** draws a document's pages, generated in its own window from the opener's deck:
  checked in headless Chromium with Playwright, since the Browser pane opens a pop-up in the same
  tab. The generated images' long names overlapped under their tiles; `overflow-wrap: anywhere`.
- **The desktop app**, built locally (`prepare.sh`, `npm install`, `npx tauri build --bundles
  app`, with `--config '{"identifier":"…slidestest"}'` and a temporary `LPP_DATA` in
  launcher.toml so it shared neither TCC entries, settings nor a remembered switcher with the
  installed app). Bound to loopback on :8549, no switcher. A four-slide deck, slide 3 hidden, sent
  to its convert route came back in 7.5 s as three pages, slides 1, 2 and 4. On the way, macOS
  asked three questions, all answered Allow at the Mac (not by me): **App Data**, for writing the
  copy into PowerPoint's container, which nobody had noticed before; **Automation**, the one this
  was for (PowerPoint's own TCC request waited 3.3 s for it); and App Data again for the read-back,
  keyed this time by bundle id instead of the executable path. Refused, App Data would have
  surfaced as a bare EPERM; it now says which question to answer (`containerWords`, tested).
- **That build doesn't exercise the entitlement.** `tauri build` with no signing identity leaves
  the app linker-signed ad hoc: no hardened runtime, no entitlements, Info.plist not bound. The
  installed release is signed (team 3G7USP8N73) with the hardened runtime, the case the
  entitlement is for. Not run: a hardened-runtime build. It would ask the same questions again,
  and with a show on, nobody was asked to answer more prompts.
- **Killing the launcher with SIGTERM orphans its server.** `pkill` on `av-launcher` left the
  embedded node (and its child) running on :8549 with parent 1; Quit stops them. A launcher killed
  any other way than its own Quit leaves the port taken.
- **Screenshots** (`background-slicer-slides.png`, `background-slicer-stills.png`): headless
  Chromium at 1440 × 900 and 1.5×, 8-bit palette PNGs, from `npm run demo` on :8548 against a
  private copy of the LivePremier Simulator 6.2.73 Session 1 (Aquilon Cmax, web 3076, AWJ 10676),
  the Background Slicer switched on in the demo's temporary settings only. A six-page "Gala
  evening" PDF made for the shot; stills at 1920 × 1080, because a DUAL still holds up to
  1920 × 1200 and 4K would have shown the downscale warning instead.

Still not done: a frame, LibreOffice, Windows, a hardened-runtime build of the launcher. (pdf.js
went into ATTRIBUTIONS.md the same day, 8d9ec07.)

## Keynote after all (2026-10-20)

The morning's entry above says Keynote is a dead end. It isn't, or not the half that matters. That
afternoon presentation-converter (main 6adce79) drove Keynote Creator Studio 15.3.1 from JXA and
AppleScript without trouble, and worked out what had gone wrong here: `open (POSIX file p)` written
inside the `tell` hands the sandboxed app a path it may not read, so it says the file "can't be
imported", `open` answers missing value and the next line is -1700. Make the reference before the
`tell` and the same script works. The -1728 is Creator Studio mid-save or mid-rename. So Keynote is
an engine in `convert.js` now, after PowerPoint and ahead of LibreOffice, and a `.key` opens in the
slicer. Design in docs/BACKGROUNDS.md "Keynote"; invariants in AGENTS.md.

What I found doing it, each tried rather than assumed:

- **No container needed.** With the references made before the `tell`, Keynote read a deck from
  `/var/folders/…/T/` and exported the PDF beside it, cold and warm. PowerPoint's container copy is
  why macOS asks PowerPoint users about App Data; Keynote users get only the Automation question.
- **Keynote's own `skipped` is reliable** and cheaper than parsing a `.key` (snappy-compressed
  protobuf, no thanks): `skipped of every slide of d` before the export gives the slide numbers the
  pages are. A five-slide deck with slide 3 skipped: `1,2,4,5`, four pages. The same for a `.pptx`
  imported into Keynote.
- **A password-protected `.key` has `.iwpv2` at the root of its zip.** Found by giving a copy a
  password (`set password … to d`) and diffing the file lists. Keynote would otherwise sit on a
  password prompt on the operator's screen, so the server refuses it before Keynote starts.
- **Keynote's pixel is the PDF's point.** A 1920 × 1080 Keynote slide exports as a 1920 × 1080
  point page, which the 96 dpi rule called 2560 × 1440. A `.key` is now called at 72 dpi. A
  PowerPoint deck converted by Keynote keeps its size in inches, so it stays at 96.
- **`before` is an AppleScript reserved word.** `set before to …` fails to compile with "Expected
  expression but found “to”" (-2741). It's `openBefore`.
- **Opening a copy of a deck that's already open** gives a second document; opening the same file
  gives the open one back with the same id, which is then left open. Allan's decks weren't
  touched: Keynote wasn't running when I started, and my own test deck stood in for one.
- **Never launched Keynote 14.5.** Compiling a script that names `com.apple.iWork.Keynote` reads
  its dictionary without starting it (checked: still not running afterwards).

**Run** through this worktree's demo on :8577 against a private copy of the 6.2.73 simulator's
Session 1 (3077 / 10677, in a scratchpad, deleted after), never the installed app on :8536 or any
frame (a show was on the Pulse 4K): the route cold 6.9 s and warm 1.6 s, a `.pptx` through Keynote
4.3 s, the password-protected and junk decks refused without Keynote starting, and the `.key`
dropped on the panel in the browser opening as pages 1, 2, 4, 5 at 1920 × 1080. Keynote quit after
every run that started it.

**Not done:** Keynote 14 on a Mac without Creator Studio; a slideshow playing (would have taken
over a screen during a show); the packaged app's Automation prompt for Keynote; `.ppt`, `.ppsx`,
`.pps`, `.potx` through Keynote. ATTRIBUTIONS.md's pdf.js line (generated from
stoatworks-backend) still says a deck is exported by PowerPoint.

## The live suite, against the rack simulator (2026-10-13)

`test/sim/`, run with `LPP_SIM=<host>:<port> npm run test:sim`: 168 tests in 12 files, about 95 s,
against the rack's LivePremier Simulator 6.2.73 (Aquilon C MAX, under Wine). The real app boots
on loopback and is driven through the proxied socket, OSC over UDP, the Console panel typed at,
the cue engine with timecode pushed over HTTP, every plugin route, a MIDI profile and a Speed
Editor (a fake panel in the real device host); each effect is checked over AWJ. AGENTS.md
"Testing" has the rules it keeps. The simulator came back matching a full store snapshot taken
before the first run, but for three status words nothing can write (below).

What the simulator showed that the notes did not say, or said wrongly:

- **The rack simulator has a VPU.** 64 mixers, all available, two enabled for S1/NATIVE, and
  `readSide`, the panel and AWJ agree mixer for mixer. The "a simulator has no VPU" rule came
  from the simulator the fixtures were cut from; it is a property of that one, not of simulators.
- **No state while a take is in flight.** `transition` holds its old value and then lands, and
  `tbarPosition` jumps straight to the end, so anything gated on "mid-take" (save via preview's
  refusal, a variable read mid-take) cannot be reached. Preview lock still works, because it
  arms on the outbound `xTake`. `xStepBack` produces no frame at all. Echoes take about 5 ms.
- **All 66 writable layer properties round-trip** — written to preview layer 1, echoed, read
  back over AWJ. The `map` ones are sets of flag names (`[]`, `["FORCE_TRANSITION"]`).
- **Triggers latch.** An `x…` property reads true once it has fired, for good. Writing false is
  the arm half of a pulse and does nothing else, so the suite writes every trigger it fired back
  to false (`Link.rearm`).
- **A recall marks the buffer unmodified** (`presetBank/status/presetId/…/isNotModified`), and it
  stays so once every property is back. Changing anything clears it; `guardScreen` nudges one
  property and puts it straight back.
- **The vendor's EDID save goes through the switcher's EDID editor** (`system/edid/edit`) and
  leaves the EDID there. The editor's extension fields are only worked out when a *valid* EDID is
  checked — checking the empty buffer leaves them as the last valid one had them — so restoring
  it means checking a valid EDID with the original's block count first, then the original. Its
  `isValid` reads UNKNOWN until the first check ever, and cannot be got back to that.
- **The bank import and export answer a remote simulator in its own words**: the path is on the
  device's filesystem, so `ERROR_NO_FILE` and `ERROR_INVALID_PATH`, and those status words stay
  on the device afterwards. With the editor's `isValid` above, they are all a run leaves.
- **No input thumbnails.** `inputs/<n>` and the rest answer 404 on this simulator; only
  `timers/1–4` serve PNGs, 256 × 144 and a kilobyte or two, so at default settings the relay
  rightly hands the PNG on.
- **Pitch:** a ratio does nothing until `xUpdate`; the pitched size rounds down (1234 → 2369 ×
  1332); an out-of-range ratio is discarded, not clamped.
- **OSC refusals go to the activity stream**, with their reason; `lastError` is the socket's.

Found, left as `todo` tests on the day, and fixed the same day. Each has an offline test now,
and the two `todo`s are ordinary tests: the live suite's next run was 166 passed and 2 skipped
(mid-take state, no Companion), with nothing `todo`.

- `plugins/snapshot-relay/relay.js` added a frame to `bytesOut` in `get()`, before `server.js`
  decided to answer 304 with no body, so a revalidated frame counted as sent in full. `server.js`
  now counts a body as it sends one (`relay.sent`).
- `plugins/edid-mosaic/core.js` `mosaicTargets` offered a grouped input as the start of another
  mosaic: with IN_17 + IN_18 grouped 2×1 it offered IN_18 + IN_19. It checked the rest of a run
  for grouped inputs, never the first; a GROUPED first input is refused now. Never applied, so
  what the switcher would have made of it is still unknown.
- With Timeline off, `/__lpp/timecode` answered "the timecode plugin is switched off" although
  its own switch was on; `/plugins` said "needs Timeline", correctly. A route now gives the same
  reason (`offError` in `src/core/plugins.js`): "the timecode plugin is switched on, but it needs
  Timeline". The host says the same of a user plugin whose dependency is off.

## The Edit page on Midra 4K / Alta 4K — it had never worked there (2026-10-06)

The page is offered wherever `layerProperties` is, which includes mng-platform, and it spoke
LivePremier throughout. The source click was the visible failure (`source.inputNum` looked up in a
catalogue that calls it `source.input`, so every click — None included — said "not one this layer
accepts"), but it was the last of five:

- **The programmer could not be seeded.** Its buffer path was `screenList/items/S1/…`; a Midra keys
  the screen `1`. `seed()` read nothing and returned false, so From PGM, From PRW and Empty all
  failed, and a source write landed under `1` where `has('S1')` never looked.
- **Empty wrote size under `position` and an anchor** a Midra layer does not have.
- **A drag-resize wrote only the position**: `position.sizeH` is `size.sizeH` there, so the size
  write was dropped and the box moved instead of resizing.
- ⚠️ **Save via preview snapshotted preview from the same wrong key**, so `before` was `{}` and the
  restore wrote nothing — preview would have been left holding the experiment on a real Midra.
- **Direct and Load were offered** although no mng bank has an import or export.

The fix is in the dialect, not the page: `bufferPath(id, buffer)`, `layerParams` (anchor, posH,
posV, sizeH, sizeV, opacity by meaning; `anchor: null` on mng) and `memoryFile`, read through
`layerSpec()` in `core/properties.js`. The LivePremier paths are byte-for-byte what they were — a
before/after capture of the programmer tree, the writes and the rendered page against the 6.2.73
simulator slices diffed identical — and `test/edit.test.js` drives the page against the Pulse 4K
fixture.

**Then driven in the Browser pane on the Midra 4K 3.2.29 simulator as a Pulse 4K**, the same day.
Read-only against the shared one on 3010, with the page socket's `send` and the raw socket both
wrapped: From PRW, IN3 / COLOR / None by mouse, a right-edge drag (Size H 1920 → 1578, Pos H
480 → 309, left edge held at −480), a move, a bottom-edge resize (Size V 1080 → 890, top held),
Empty (both layers 1920×1080 at 960/540), and a Memory rail offering only Via preview — **zero
frames sent**, and the sim's screens, banks, transitions and preconfig identical afterwards. The
save was run on a private copy (3030, thrown away after): From PGM, L1 to IN9, Via preview into
slot 5 — 108 writes into UP, the save naming PREVIEW on screen 1, the label, 108 writes putting UP
back; nothing to DOWN, nothing spelled `S1`/`inputNum`/`layerList`. Read off the device: DOWN
identical, every UP layer property identical, slot 5 valid and labelled, and recalling it gave
exactly the programmed look. One bookkeeping change: UP's `memoryId` went 0 → 5 with `isModified`
true — the same "the bank's opinion is not restored" caveat `save-look.js` gives for LivePremier.

⚠️ **The shared Midra sim on 3010 answered 404 to everything** — not a dead engine (it and AWJ on
10610 were fine) but its session directory living in a Claude scratchpad under `/private/tmp`.
macOS's daily `/tmp` cleaner deletes files untouched for three days, so `AW_APPS/webapp-bundle`'s
server and client went, and so did `AW_INTERNAL/SaveVarFileBank`, the engine's saved state. Fixed
in place, with no restart and the in-memory state kept, by symlinking the missing entries to the
app's own read-only copy under `MIDRA_3_2_29/ressources/AW_APPS/webapp-bundle` — the cleaner deletes
regular files only. A restart of that engine would still come up without its saved state; the Alta
sim on 3021 lives in the same directory tree and was 404 for the same reason (left alone).

## Dante: our own routing control, and Dante Controller's preset files (2026-10-06)

Built `plugins/dante/` — preview, off by default — as two halves, because Dante Controller has no
remote-control interface: a port of netaudio's reverse-engineered ARC protocol (discovery, channels,
subscriptions, writes read back) and Dante Controller's preset XML, written and read as a
difference. `docs/DANTE.md` is the design.

What was learned on the way, all from reading rather than from a device:

- **netaudio's protocol now lives in a Rust core** (`packages/netaudio-core/src/`), not the Python
  of 2021–2024, and it distinguishes three subscription writes by the ARC revision the device
  advertises (`arcp_vers` *is* the protocol id: 2.7.41 is `0x2729`). Its fixtures label their own
  evidence carefully; the Dante Controller captures (2.8.9 and 2.7.41 subscription pages, 2.8.12
  status queries, 2.8.15 continuation) are the independent ones, and our codec matches every one.
- **Dante Controller clears what a preset does not list.** Its user guide: applying Rx
  subscriptions removes "any existing subscriptions on the target system that do not exist in the
  preset". The import difference follows that rule and marks those rows.
- **The simulator store describes the Dante card** at `device/system/deviceList/items/<n>/dante`:
  `status/pp/id` (`AQL-Simulator`), `type` `BK2_64X64`, MACs, and per channel `source/status/pp/
  {label, connectedTo}` and `transmitter/status/pp/label`. Frames 2–4 read `UNKNOWN` /
  `NOT_INITIALIZED`. That `id` is the Dante name, and the channel numbering, are inferences.
- **The in-app Browser pane opens a pop-out in the same tab**, so the opener is gone and the pop-out
  says "No Web RCS session". The Dante pop-out is unverified for that reason only.

Proven against `tools/dante-sim.mjs` and in the Browser pane against LivePremier Simulator 6.2.73
(grid, switcher card matched by name with its Audio Matrix beside it, a click confirmed by
read-back, preset export → edit → import difference → apply, a snapshot saved). **No packet has
gone to a real Dante device.** The first real test (DVS, then the switcher's card) is in DANTE.md.

## Background Slicer — built against the 6.2.73 simulator (2026-10-06)

`plugins/bg-slicer/`, off by default, `docs/BACKGROUNDS.md` the design. What was learned on the way,
in the order it would bite:

- **Slices are connectors.** I first read `canvas/status/slices/sliceList/items/<k>` as "a canvas
  position plus an area of the raster". The bundle (`getGroupedOutputs`,
  `getGroupedOutputStatus`) says slice k is connector k of the output's group: `pp.left/top` its
  place in the group's raster, `aoi/pp` its size, and its canvas place is `output.left/top +
  (slice − boundingBox) × pitch`. Both readings agree for the simulator's one full slice and
  disagree for every group, so no simulator would have caught it. Also: `sliceList` lives under
  `canvas/status/slices`, not beside it.
- **A set's content write is three writes.** `axSetBackgroundSetOutputSource` releases the old
  content's `useOnOutput` claim (to the next output using it, or NONE), claims the output for the
  new input or still, then writes `content`. Stills have a claim too
  (`preconfig/backgrounds/stillList`). No apply step under `preconfig/backgrounds`.
- **The upload answer is keyed by multer's file name** (`s[i.filename]` in the server), which need
  not be the name sent, so it is read as "the one value".
- **Both simulator screens have NATIVE `OFF`**: a background set can be built and never shown there.
- **The browser pane opens `window.open` in the same tab**, replacing Web RCS — so no popout can be
  tested there. The Background Slicer's popout was checked in an iframe whose `opener` was set to
  the Web RCS window: it booted, and showed the tab's job (picture, screens, span).
- **`test/panel-render.test.js`'s simulator store was empty** until main fixed the merge (the memory
  capture's `device` is a string); found here independently, fixed on main by the Variables work.
- **The write path ran on the simulator** (docs/BACKGROUNDS.md has the run): three images, three
  stills, two sets, a live-input set, a capacity raise (still 45 to 4K took still 46 out of
  service) and a refused one (it would have taken a still holding an image), all undone. The
  library gave back the uploaded PNGs byte for byte. Three things the simulator does that are worth
  knowing: a deleted library slot keeps its last image's name and size with `isValid` false; the
  claim's `status/pp/usedOnOutput` stays `NONE` while `control/pp/useOnOutput` is set; and the
  library's `fileName` is the name the file was uploaded with.
- **A trap in my own checking:** `store.get()` hands back the live node, so a value read before an
  await and serialised after it shows the later state. It had me chasing a claim that "reset
  itself" — it had not.

## Background Slicer on Midra 4K / Alta 4K (2026-10-06)

`plugins/bg-slicer/mng.js` + `apply-mng.js`, chosen by `model.js`; docs/BACKGROUNDS.md has the
model and the run. In the order it would bite:

- **The upload takes no slot.** The Midra server (`server.app.js`) imports every file with
  `AUTO_SLOT_WITH_DOWNSCALE`; only `FILES` is read. The first empty slot (`isValid` false) wins
  even when a frame points at it — S1's BKG1 pointed at empty slot 1 on the simulator, an upload
  landed there, and S1's frame showed it. Hence the plan's refusal, and the re-check before each
  upload. The shared simulator is in exactly that state, so the plugin refuses there.
- **The page mirror is not an echo.** `page-socket.js` applies this page's outbound DEVICE frames
  to the store; a refused write (an enum value that does not exist) shows in the mirror and is never
  echoed inbound. The Midra apply waits on `dir: 'in'` frames (`wire.js`, `inbound`). LivePremier's
  apply still waits on the store — the same exposure, not re-proved. *(Re-proved and switched the
  same day — the next section.)*
- **A frame's `status/pp/{width,height}` is the size it is shown at**, by mode — the proof of 1:1.
- **The import command moves its file** (`stillLibrary/import/cmd/pp/path` — the source is gone).
- **A simulator session in a scratchpad gets reaped.** The shared Midra simulator's session dir had
  lost `AW_FRAME_LIB` (and `AW_INTERNAL` saves fail), so every import answers
  `ERROR_NO_FREE_SPACE`. A private copy of the session on other ports (AGENTS.md has the recipe)
  was where the upload was proved.



## Background Slicer: LivePremier on the switcher's own echo (2026-10-06)

The LivePremier apply now waits on `dir: 'in'` frames too. Probed on the LivePremier Simulator 6.2.73
from Node over the device socket, with nothing else connected; docs/BACKGROUNDS.md has the run.

- **A write of the value a path already holds is never echoed**, on every path the apply writes. A
  naive inbound wait therefore fails the commonest apply there is: every still on the simulator holds
  `source` 1 and the first free library slot is 1. `wire.changedPaths` leaves such paths unwaited.
  (The Midra lists never hit it: `withBefore` drops them before sending.)
- **Each pulse edge is echoed twice** (false, true, false, true for one pulse) — harmless to a wait
  that matches path and value, confusing in a frame log.
- **`current` lands before `hasChanged` clears** after `xApply`, so a second `applyCapacities`
  started at once refused "changes staged". It cost me a run that stopped with still 45 at 4K and
  46 out of service on the shared simulator; my `finally` exited before printing the error, and
  I put it back by hand. Print the error before anything in `finally` that can exit.

## HyperDecks: Mitti refuses CR-ended commands (2026-09-29)

The link (`plugins/hyperdeck/link.js`, `pump()`) wrote every command as `line\r\n`.
Testing automitti against a **real Mitti 2.8.18** showed Mitti's HyperDeck emulation
answers `103 unsupported` to any command ending in `\r` — only `device info` gets
through. So against Mitti the plugin connected, showed a model, and never got a clip
list or transport state. With plain `\n`, `transport info`, `clips get` (durations
included) and `clips count` all answer properly. A real HyperDeck takes LF too, so the
link now ends commands with `\n` only.

Two more Mitti spellings, both already read correctly because `ReplyParser` trims keys
and values: `device info` says `protocol version:1.11` (no space), and transport info
says `loop : false` (a space before the colon).

`tools/hyperdeck-sim.mjs --mitti` now does all three, and `test/hyperdeck.test.js` has
a Mitti link test that fails if the link goes back to CRLF (checked). automitti's
`tools/mitti-sim.mjs` carries the same change (automitti c856dd7).

Still true: no real HyperDeck has been driven by this plugin; Mitti only through
automitti's copy of the link.

## The portable configuration file (2026-09-22)

`server/config-file.js` writes everything this app holds for one device into a single
JSON document, and reads one back. `GET /__lpp/config` (add `?download=1` for a
filename), `POST /__lpp/config`, and `POST /__lpp/config/inspect` to see what an import
would do without doing it.

**Why:** a rig is two halves. The `.awc` restores the processor and holds nothing about
the surface driving it; we hold the cue stack, layer groups, layer names and the patch.
Restore the `.awc` alone and the show comes back with no cue list. Showbook now carries
both — in a `.showbook` bundle, or with this file embedded inside the `.awc` itself
(a LivePremier accepts that; see showbook's `docs/NOTES.md` for the measurements).

**The three sections are `storage.js`'s own split and must stay apart:**

| section | files | keyed by device |
| --- | --- | --- |
| `installation` | `settings`, `matrices` | no |
| `show` | `stack`, `groups`, `names` | yes |
| `rig` | `patch` | yes |

Two judgements worth not undoing:

- **`DEFAULT_IMPORT` deliberately omits `settings`.** It carries the OSC port and bind, so
  applying it can close a port a lighting desk is sending to. Someone tidying it into "all
  of them" fails `test/config-file.test.js`.
- **An absent section is not an empty one.** `buildConfig` leaves a section out rather than
  writing `null`, so an importer can tell "this export had no patch" from "this export had
  an empty patch" — the difference between leaving a cable schedule alone and wiping it.

`applyConfig` writes the device-keyed sections under whatever `deviceKey` it is given, not
the one in the file, which is what makes a restore onto a backup frame work; the file
records `device.address` so the importer knows what it is remapping from, and the report
says `remapped: true` when they differ. `settings` is merged rather than replaced, so a key
this build knows and an older export predates is not reset to its default.

12 tests in `test/config-file.test.js`.

## RENAMED + RE-ARCHITECTED 2026-08-21 (history; AGENTS.md "Why a proxy" is the current account)

**It is `livepremier-plus` now, and it is NOT an extension.** Both the repo and
the local dir were renamed (`~/projects/video/livepremier-plus`,
`github.com/stoatworks-labs/livepremier-plus`; GitHub redirects the old name).
`manifest.json` and `src/loader.js` are DELETED. v0.2.0, 54 tests, pushed.

**It is a local reverse proxy**: `npm start`, browse to `127.0.0.1:8534`, give
it a switcher, and the vendor Web RCS comes up with the panels in it. `server/`
holds `proxy.js` / `index.js` / `storage.js` / `setup.html`; `launcher/` is the
fleet's stock Tauri shell, retargeted by `launcher.toml` alone (no Rust
changed, `cargo check` green, bundled chain verified headlessly).

**Why the user's premise was half-right.** They said the VPU map "appears to be
limited to a desktop app, not a Chrome extension". The real axis is **origin,
not browser**: [livepremier vpu visualizer](https://github.com/stoatworks-labs/aquilon-vpu-map/blob/main/docs/NOTES.md) (`aquilon-vpu-map`) needs a process because it
uses **AWJ over TCP 10606**, which no tab can open. This project never used AWJ
— it reads `GET /api/stores/device` **same-origin**, which the extension got by
running in the device's page. The proxy makes `localhost:8534` *be* that origin,
so the proven store path carries over untouched.

**The AWJ bridge was CONSIDERED AND REJECTED** — the argument to beat if it ever
comes up again: `session.start()` hydrates the 118 MB store unconditionally for
the cue stack, and deltas keep it current, so an AWJ reader would be a **second
source of truth for the same VPU state**. Two sources that can disagree about
what is on air is worse than a slow first paint. It would also burn one of the
5 AWJ client slots and add a second vendoring/drift path.

### Four things the proxy buys that the extension could not
1. **Any browser**, not just a Chrome with a sideloaded extension — matters on a
   locked-down show laptop.
2. **The hook's ordering stops being a race.** Every vendor script tag is
   `defer`, so an inline `<head>` script is ordered first *by the parser*. MV3
   `document_start` usually won but was never promised to.
3. **Cue persistence actually works** — file per device in `~/.livepremier-plus`.
   The `chrome.storage` broker had NEVER ONCE EXECUTED.
4. No MV3 packaging, nothing to reinstall after a browser update.

### ⚠️ Two bugs the proxy tests caught — both had shipped in the working spike
- **The device serves documents CHUNKED.** Re-sending one whole must delete
  `transfer-encoding` AND `content-encoding` before setting `content-length`.
  That pair is illegal and undici rejects it outright. Every document would
  have failed.
- **An upgraded socket is INVISIBLE to `server.close()`** — neither counted nor
  closed, just waited on, and a Web RCS tab never disconnects. Hence
  `server.closeRelays()`. Without it **the launcher's Stop button hangs**. It
  surfaced as a test that TIMED OUT rather than one that failed — worth
  remembering as a failure mode, not just a bug.

### Design points that are load-bearing
- **Never rewrite URLs.** Every vendor asset path is root-absolute, so
  path-preserving proxying needs none. Hashes change every firmware.
- **Only `text/html` is buffered**; everything else streams (the store is 118 MB).
- **CSP is stripped defensively** — none is served today, on sim or hardware.
- **The switcher is chosen at RUNTIME**, not a startup flag. That is what lets
  `launcher/` be the stock shell (it injects host+port like every other fleet
  app), and re-pointing at a backup frame costs a form submit, not a restart.
  Re-pointing **hangs up the old relays** so a page cannot keep driving the box
  the operator thinks they left.
- **The `wru-` prefix stays** (CSS classes, `__WRU_HOOK`, `wru:detected`) —
  internal identifiers, matched by string in `ui/shell.js` and the tests.
  Renaming ~50 of them is churn with breakage risk. Read `wru` as "the panels".
- Sidebar section is now **`PLUS`**, was `UNLEASHED`.
- **The research repo KEPT its old name** — `webrcs-unleashed-research` is a
  research log; renaming it is not worth the history churn.

## Field arithmetic — `1080-80` in a layer width gives 1000 (2026-08-21)

Third panel-less feature, `src/ui/math-fields.js` + `src/core/expr.js`, 74 tests
total. **Verified on the sim: `1080-80` in a width put `sizeH=1000` on the wire**,
with `sizeV` alongside from the vendor's own aspect lock, via BOTH commit paths.

**⚠️ THE KEY DOM FACT, and it inverts the obvious guess: Web RCS's numeric
fields are `input[type=TEXT]` carrying `min`/`max`/`step`** — geometry reports
`step="1"`, X spans -960..2880, width 0..8192. So `.value` keeps a typed
expression and **the `step` attribute is the selector**. That is the vendor's own
declaration that a field is numeric, needs no per-build class hash, and excludes
what must never be touched — labels have NO step, and neither does the
`00:01.000` transition field.

**⚠️ `input[type=number]` DISCARDS what it cannot parse.** After typing
`1080-80` the browser reports `value === ""` + `validity.badInput`, and
`selectionStart` is `null` — the expression is ON SCREEN and UNREADABLE from
script. VERIFIED with real keystrokes, not assumed. So opacity/zoom (the `%`
fields, which ARE type=number) are **deliberately excluded**; supporting them
needs a `type` swap on focus PLUS reimplemented native arrow stepping. Do not
add it casually.

**Getting in front of React:** it attaches handlers at the root container, so a
**capture-phase listener on `document`** runs first. Rewrite the value there,
let the event continue, and the vendor's commit handler reads it as typed.
Writing needs **the native setter off `HTMLInputElement.prototype` + a bubbling
`input` event** — React overrides `value` on the element, so a direct set is
invisible to its state. (`focus → setter → input → blur` is the full commit
recipe; a `blur()` on a NON-focused element does nothing, which cost a debugging
round.)

**NEVER put `eval`/`new Function` in this path** — `core/expr.js` is a
recursive-descent parser over a closed token set. Division by zero is rejected
*specifically* because `Infinity` would survive the clamp and land as the
field's max: a plausible-looking wrong value on air, which is the whole failure
mode being defended against.

## FIRST PUBLIC RELEASE v0.3.1 (2026-08-21)

**PUBLIC**: `stoatworks-labs/livepremier-plus` MIT, and **awj-surface was made
PUBLIC too** (the user's call) so the vendored `src/vendor/surface/` has a real
upstream. Both got the disclaimer + ATTRIBUTIONS; awj-surface lost its dead
`hosts/extension/`. Release v0.3.1 with **7 assets**: macOS .dmg+.pkg for BOTH
arches, Linux .deb+.rpm, Windows .exe, plus GHCR (anonymous pull = HTTP 200, so
the public-before-first-workflow-push ordering held). Website entry live at
`/software/livepremier-plus/`. **Port moved 8534 → 8535** (8534 is mynah's).

**⚠️ NO HOSTED DEMO, EVER** — and it is in ATTRIBUTIONS, the README, the release
notes and the website copy. The interface is Analog Way's, served by the
customer's own switcher; we proxy it and ship none of it. Nothing to host.

### Release traps hit, all fixed
- **CI's first run found the app never supported Node 18** — `CustomEvent` is
  global only from 19, and core/ + the surface engine are EventTarget-based. 28
  failures. Floor is now **Node 20** (`engines` + README + CI matrix).
- **Tauri's own dmg bundler fails on the cross-compiled x86_64** — build
  `--bundles app` and package with `rl_pkg`/`rl_dmg` from `scripts/release-lib.sh`
  (vendored from av-launcher, hash `1b0bde498157`).
- **Then hdiutil hit "No space left on device"** on x86_64 only: cross-compile
  target dir + the ~111 MB embedded Node copied into .app → stage → dmg. Fixed
  by deleting cargo intermediates before packaging.
- `gen-downloads.py` needs the **projects.json entry to exist first** — it
  discovers from there. `--repo livepremier-plus` scopes it; a bare run sweeps
  the whole fleet (which once ate prose from six repos).

### ⚠️ CO-SESSION collision — real, and instructive
A parallel session pushed `Info.plist` (**NSLocalNetworkUsageDescription** —
without it the macOS app cannot reach a switcher when double-clicked) and bumped
to **0.3.1** while I was mid-release. My dispatched build then attached
0.3.1-named assets to a v0.3.0 release. Resolved by **deleting the incomplete
v0.3.0 and cutting v0.3.1** from main, keeping their fix. Also: **my
uncommitted `projects.json` website edit was silently lost** to the same
session — re-done and committed immediately with `git commit -- <path>`.
See **cosession shared checkout** (working-practice note, kept in Claude memory); the rule earned its keep twice.

### Video — PUBLISHED to both
- **YouTube `mGjGiNO_tSo`** — currently **UNLISTED**, awaiting the user flipping
  it public. Thumbnail set, `changes: []`.
- **Instagram Reel `DcUlgPdDYAD`** on `stoatworkslabs`, `changes: []` (no
  padding — the 9:16 and the muxed silence were both correct).
- Both **embeds done**: README link + `projects.json` `youtube`/`videoDate`;
  site rebuilt and deployed.
**⚠️ I WAS WRONG that YouTube could not be automated.** The read-only limit in
[youtube mcp](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_youtube_mcp.md) is about the **YouTube MCP** and about **editing an
already-published** video in Studio. **Upload-Post has the YouTube account
connected** (`@stoatworks-labs`, no reauth) and `upload_video` takes title,
description, tags, thumbnail and `youtubePrivacyStatus` — a NEW upload works
fine. This fleet had never used that path (every ledger entry was Instagram).

Take traps: the clap must be **300ms** (a 120ms flash falls between frames of
the 10fps sampler — one whole take lost); beats must use key **`t`** not `at`;
`selectLayer` must click the **`.ui.selection.list .item`**, not the chip inside
it. Added driver-warning surfacing to `lib/webtake.py` so a step that operates
nothing is printed instead of silently producing a caption over nothing.

## Four languages, real settings, and OSC IN (2026-08-22) — 199 tests

**Pushed to `main`, `687c09d`.** The console takes all four of mynah's languages
(re-synced vendored bundle). Settings stops being a placeholder.

- **`server/osc.js`** — a UDP listener. OFF by default, binds **loopback** unless
  told otherwise, writes to the switcher **over AWJ**, so it works with no
  browser open. That is the point of a show-control input. Its address space is
  `docs/OSC.md`, **generated** by `tools/gen-osc-docs.mjs` from the resolver's
  own tables; a test fails when the checked-in file stops matching. 173
  addresses — mynah's 7 layer params widened to the surface catalogue's 67 by
  `src/core/osc-dictionary.js`.
- **`server/awj.js`** — ⚠️ **the AWJ path AGENTS.md said there deliberately was
  not.** The old argument (a second source of truth for the VPU state) still
  stands and is restated at the top of that file. This is not that: it never
  touches the store mirror, holds no connection, subscribes to nothing. Both
  callers need what the mirror cannot give.
- **Settings are SERVER-SIDE** (`src/core/settings.js`, `PUT /__lpp/settings`,
  one file in `~/.livepremier-plus`), not localStorage and **not keyed by
  device**: the OSC socket is invisible to a browser, and the console exists in
  two windows at once. Re-pointing at a backup frame must not change the command
  language or close a port a lighting desk is sending to.
- `presetBanks()` exported from `core/screens.js` — the one place that decides
  which buffer is program.
- Website: **`/reference/livepremier-osc/`**, table synced by the site's
  `scripts/sync-osc-dictionary.mjs`. ⚠️ **NOT deployed** — the site needs
  `npm run build && cf-run npx wrangler deploy`; `scripts/deploy.sh` is dead and
  says so.

⚠️ Traps: [command language dialects](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_command_language_dialects.md).

## Mynah + MIDI integrated (2026-08-21) — 88 tests

**Placement, as the user specified it:**
- **Console (mynah) + Timeline are TABS** in the vendor's own strip on
  Screens/Aux, beside Properties/Memories (`src/ui/tabs.js`).
- **MIDI Mapping is ANCHORED under Virtual RC400T** in the vendor's LIVE
  section — `Shell` entries gained `after: '<vendor label>'`, matched on the
  **visible label** (the only un-hashed part of that markup).
- **Only VPU Map stays in PLUS** (whole-device view).
- Tab strip container has a CSS-modules hash → find by **structure** (parent of
  `.ui.tabular.menu`), never by name. `_mount()` must be idempotent; React
  re-renders that subtree on every selection change.

**TWO more vendored trees** (+ sync scripts + drift tests), same rule as the VPU
model — one implementation, copied not re-derived:
- `src/vendor/mynah-lang.mjs` ← mynah's own **`npm run build:lang`** output
  (`dist-lang/mynah-lang.mjs`, 40KB, zero deps, built FOR outside consumers;
  the Companion module vendors the same file). Don't hand-port the TS.
- `src/vendor/surface/` ← awj-surface `core/` + stock profiles, **by MANIFEST**
  (per-file sha256) since it's a directory.
- `src/vendor/pitch-engine.js` ← aquilon-pitch's own **`npm run build:lib`**
  output (`dist-lib/aquilon-pitch-engine.js`, zero deps, built FOR outside
  consumers). Same arrangement as mynah — don't hand-port the TS.

**⚠️ The pitch ratio is easy to get backwards.** It **multiplies** a group's
raster to give its canvas footprint, so a *coarser* wall (bigger mm pitch) takes
a ratio *above* 1.000 and downsamples. Verified upstream by writing
`pitchRatioH = 2000` to a running simulator and watching `pitchedWidth` go
1920 → 3840. Three more things the manual does not say, all pinned by
`test/vendor.test.js` so they cannot quietly drift here: the field is int
thousandths 100–10000; an **out-of-range write is DISCARDED, not clamped**, and
silently; and the footprint **floors** (1080 × 1.234 = 1332, not 1333). Full
evidence in aquilon-pitch's `docs/NOTES.md` and in
[livepremier pitch compensation](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_livepremier_pitch_compensation.md).

**`xUpdate` or nothing happens.** Writing a pitch ratio moves `canvas/cmd/pp`
and leaves `canvas/status/pp/pitchedWidth` exactly where it was until
`xUpdate` is written true on the same node. `core/pitch.js` emits it after every
pair; a hand-rolled script that forgets it looks like it worked and changed
nothing.

**`usedInScreenAux` is the literal string `"NONE"`** when an output is on no
screen, not an absent key. `if (!status.usedInScreenAux)` looks like it filters
unassigned outputs and does not. A test pins it.

**⚠️ STRONG CORROBORATION worth keeping:** mynah's compiler and this repo's
`core/paths.js` `CMD` builder were derived INDEPENDENTLY (bundle vs live
captures) and emit **byte-identical** store paths for `Take Screen 1` and
`Recall Screen 1 Memory 5`. A test pins it. Only true while nobody re-types the
grammar here. Mynah's `Path.prototype.toWs()` gives store form directly
(`toAwj()` gives the other).

**⚠️ MIDI needed NO offscreen document — the extension-era architecture is
DEAD.** `requestMIDIAccess` is secure-context-only, which on an http:// LAN
address forced the service-worker + offscreen relay described in
[web midi secure context](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_web_midi_secure_context.md). **Serving from loopback makes the page a
secure context** — VERIFIED: `isSecureContext === true` and the API present on
`http://127.0.0.1:8534`. Also fixes the SysEx prompt problem (an invisible
offscreen doc can't prompt; a normal page can). **Corollary now surfaced in the
UI: open the switcher's OWN address and MIDI cannot work.**
awj-surface's `hosts/extension/` is now **DEAD** — it patches a `manifest.json`
this repo deleted, and its README still points at `../webrcs-unleashed`.
**OSC is still impossible in-page** (no UDP in any browser); this process is
already the local host for it if ever wanted.

**Engine contract** (awj-surface core, unchanged): `surface.handle(bytes)` →
event; `engine.input(event)`; `engine.on('write')` → `{writes:[{path,value}]}`
**already in STORE form** (the node host converts to AWJ, we don't);
`engine.deviceChanged(path)`; `engine.on('feedback')` → `surface.render()`.
**Soft pickup holds off** until a fader sweeps through the live value — a
`holdoff` event, not a bug; that's what "no write" on first move means.

Verified on the sim: Console `Recall Screen 1 Memory 3` → correct presetBank
frame; APC40 CC sweep → layer-opacity write at the right path after pickup.
**Still NO physical controller ever attached.**

## Demo environment + launcher shell refresh (2026-08-21)

**`npm run demo`** (`tools/demo.mjs`) — app + simulator + the real Aquilon C
resource subtree spliced in + 4 seeded cues, prints a "things to try" list.
**REFUSES any non-loopback address** (it seeds a stack and rewrites a store).
Needs a simulator: the panels mount into Web RCS's own sidebar and ride its
socket, so a stubbed demo demos the wrong thing; the sim gives the genuine
vendor UI, and the capture gives the VPU the sim does not have. Uses a new,
general proxy extension point — `extraModules` (injected AFTER main.js so
`window.__WRU` exists) + `extraFiles` (EXACT-MATCH table, no path building).

**⚠️ BROWSER PANE TRAP, cost a debugging round:** `requestAnimationFrame` does
NOT fire while the pane is hidden, and panel repaints go through
`throttleFrame`. Two views then hash IDENTICALLY and it reads exactly like a
broken toggle. **Call `window.__WRU.shell.refresh()` to force a synchronous
render before comparing.** The CURRENT/STAGED toggle was fine all along
(`664e6945` vs `cc652f36`). See [browser pane verification traps](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_browser_pane_verification_traps.md).

**⚠️ CORRECTION to the note below:** running-vs-staged is **NOT** "visibly
different in the grid", and that is CORRECT. Both sides drive the same *output
links*, so `buildLinkGrid` rightly yields identical geometry; what moves is the
**pipe SLOT inside each mixer** (current 1,3,5,7 → staged 1,2,3,4, same values
1-4). The panel shows it as the `26 staged changes` badge and `CHANGED in the
staged configuration` in DETAIL. **Do not "fix" the grid to move blocks.**

**Launcher shell re-synced from av-launcher** — it had gained a `diag` crate
(rotating log + crash report + diagnostics bundle) and **`**field**` custom
panel inputs**, which NO per-repo launcher had adopted (7 checked). Held
`if-addrs` at **0.15** (per-repo shells moved up; canonical still says 0.13).
`crates/diag` lives at **`src-tauri/crates/diag`**, not repo-root `crates/`.
cargo check + its 7 tests green, bundled chain re-verified.
**This invalidated the earlier "a device field would mean forking the shell"
argument** — added as an OPTIONAL field instead: blank injects an empty
`LPP_DEVICE`, which falls through to remembered, then to the setup page (both
verified). openrcs already used `**field**` for a "Switcher IP" — precedent.

**Vendored VPU model was already current** — upstream `public/vpu.js` last
touched by the commit the provenance header records; the drift test does a real
content comparison and passed.

## Verified 2026-08-21 through the proxy, against Simulator 6.2.73
Vendor app boots, hook lands ahead of the bundle, **session `live` + store
mirrored**, both panels render, setup flow works, **cue stack survives a
reload**. `--help`, remembered device, bundled-Node chain all exercised.
**STILL NEVER DONE: any panel driven live against physical hardware in a
browser, and the launcher as a real native tray window.**

---

## Original build notes (2026-08-20) — the extension era

Built 2026-08-20 in one session. **Two repos, both PRIVATE on GitHub, pushed,
`main`** — the openrcs split, as the user chose:

- `~/projects/video/livepremier-plus` — WAS the extension (MV3, no build step);
  now the proxy. `github.com/stoatworks-labs/livepremier-plus`
- `~/reverse-engineering/video/webrcs-unleashed-research` — derivation, the raw
  Aquilon C VPU captures, the vendor modules the transport was read from, and
  `tools/extract-modules.py`.
  `github.com/stoatworks-labs/webrcs-unleashed-research`

Private, so **no AI disclaimer yet** (**disclaimer scope** (working-practice note, kept in Claude memory) is a
public-repo rule) — add one to the product repo before it ever goes public.
**No Dependabot and no PR CI**, deliberately: CI minutes are billed on private
repos (**ci actions quota restored** (working-practice note, kept in Claude memory)) and it was not asked for. `gh repo
create --push` lands on **`master`**; both had to be renamed to `main`.

## Scope, as the user decided it

Asked for "a chrome extension which can inject our livepremier VPU visualiser
and timeline into a real webRCS browser session, using webRCS native theming".
Three decisions taken up front, and they **reverse the earlier standalone-only
call** recorded in [webrcs timeline](https://github.com/stoatworks-labs/webrcs-timeline/blob/main/docs/NOTES.md) (`webrcs-timeline`):

- **Shared core, extension as one front-end** ("extension is a shell only") —
  `src/core/` has no DOM, no `chrome.*`, no transport, and imports under plain
  Node. A direct-AWJ front-end should need only a new `transports/` module.
- **Read + GO from v1** — the timeline really writes (preset recalls, transition
  times, TAKE/CUT/STEP BACK). Confirmed on the wire against the simulator.
- **Private, openrcs-style split.**

## The four load-bearing ideas

1. **Light DOM, never shadow DOM.** The vendor stylesheet defines ~500 `aw-`
   utility classes (slate-grey 50-900, spacing, typography, cards, shadows).
   Rendering into the page's light DOM inherits all of it. *That is the entire
   theming strategy* — there is no theme file beyond ~120 lines for a VPU grid
   and a cue table.
2. **Nothing about the vendor markup is hard-coded.** Web RCS uses CSS modules,
   so every class carries a per-build hash (`sidebar-module__c__menu___1sHvq`).
   Sidebar entries are **cloned from a real one at runtime** and rewritten,
   active-state classes lifted off whichever item is currently active. Icons
   come from the page's own SVG sprite (378 symbols) by id.
3. **Ride the app's own socket; never open a second one.** The device counts
   clients in its header and AWJ's 5-client cap is separate. Hence a MAIN-world
   content script at `document_start` — the only point in front of the vendor
   bundle's own `new WebSocket`.
4. The panel is a flex sibling of the main content, shown by hiding that content
   rather than floating over it. Verified it hands back cleanly.

## Verified, and NOT verified

**Verified against AW LivePremier Simulator 6.2.73**, panels rendering inside
the real Web RCS: sidebar entries indistinguishable from the vendor's, device
store mirrored live, VPU panel correct on both firmware models, and a fired cue
producing exactly the right DEVICE frames on the wire — including the
screen-vs-auxiliary split. 22 tests, no network.

**Never run against physical hardware. Never loaded as a packed extension** —
the panels were exercised by injecting the same content scripts into a live
session via `npm run serve` (a CORS static server; `python -m http.server`
cannot do it). So **MV3 packaging, `src/loader.js` and `chrome.storage`
persistence have never actually executed.** That is the first thing to try.

## Traps banked here

- **A simulator has NO VPU**, so the VPU panel cannot be developed against one.
  Use `tools/harness.html`: it renders a panel from a recorded store and
  **proxies the vendor stylesheet, fonts and sprite from a named device**
  (`DEVICE=<ip> npm run serve`), so the panels are judged in the real design
  system with no vendor asset committed.
- **The Browser pane blocks ALL cross-origin fetches once the tab is on a LAN
  address** — `ERR_BLOCKED_BY_CLIENT`, request never reaches the server. So the
  console-injection trick works against a localhost page and **cannot** work
  against a real device. That is why the harness exists.
- **The keep-alive ping only fires after 3 s of silence**, and a live device
  chatters every second — so a late-installed hook waiting for a ping waits
  forever. Adopt on the first Analog Way frame instead.
- **The sidebar separator's padding is on an inner title element**, not the
  wrapper. `textContent` on the wrapper loses the indent.
- `node --check` false pass: see [node check esm false pass](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_node_check_esm_false_pass.md).

## VPU: the model is VENDORED from aquilon-vpu-map — 2026-08-21

The user's call: "the vpu visualiser project is more or less done, build that
into the extension." Done by **copying** [livepremier vpu visualizer](https://github.com/stoatworks-labs/aquilon-vpu-map/blob/main/docs/NOTES.md) (`aquilon-vpu-map`)'s
`public/vpu.js` to `src/vendor/vpu-model.js`, not by reimplementing:

- `npm run sync:vpu-model` re-copies and rewrites the recorded upstream commit;
  `test/vendor.test.js` fails on drift and **skips** when there is no checkout
  beside the repo. A Chrome extension must contain every file it loads, so a
  copy is unavoidable — the drift test is what makes it safe.
- `src/core/vpu.js` is now only the **store adapter**, the one thing that
  genuinely differs: that tool builds mixer records from hundreds of AWJ reads,
  this lifts them from the device store, and gets `preconfig/resources/<side>/
  screenList/items/S<n>/status/pp` (the device's own "does it fit" figures)
  free where the standalone reader spends 24 round trips.
- The panel now draws **the manual's link grid** (8x8 links, reported columns,
  packed rows, the 4-link boundary hidden on an Optimized VPU).

**Three things this repo had WRONG, all fixed by adopting the shared model:**
1. `NATIVE` was labelled "Background" — it is a **layer slot that consumes
   mixers**; backgrounds are a different subtree and cost nothing. Test pins it.
2. Mixers were read as having 2 out-pipes. They have **8**.
3. It claimed two firmware models were in the field. **There is one.**
   `$vpuLayer` answers E12 on hardware, so `vpuLayerList` is a **simulator
   artefact** — a simulator has NO VPU, and the panel now says exactly that.

## Verified on the LIVE Aquilon C, read-only — 2026-08-21

Read `GET /api/stores/device` (118 MB, ~5.5 s) off 192.168.2.142. Nothing
written. `test/fixtures/aquilon-c-live-resources.json` is the trimmed resource
subtree; **7 tests run on it** and cover what no simulator can:
- 32 of 64 mixers fitted (PROC_1+2), 26 allocated, 6 spare; devices 2-4 empty.
- S1 spends **6 output capabilities across two mixers per slice, split 4 links
  and 2** — one mixer cannot span more than four (§5.5.4). Links are
  **interleaved** (1,3,5,7 / 2,4), not contiguous.
- `isOptimized: true` on S1, resolving onto the whole VPU.
- **The staged preconfig differs from running in 26 mixers, and EVERY change is
  a link move with no property changed** — the exact case a properties-only
  diff calls "no change". Running interleaves, staged packs; the two are
  visibly different in the grid.

## The other sibling — still UNRESOLVED

**[webrcs timeline](https://github.com/stoatworks-labs/webrcs-timeline/blob/main/docs/NOTES.md) (`webrcs-timeline`)** `~/projects/video/webrcs-timeline` — a Rust
workspace with `awj-cue`, both transports, 58 tests. **Its cue engine and this
one remain independent implementations that will drift.** The VPU half is now
converged; the cue half is not. One fix crossed over already: a TAKE can
overtake its own preset recall and put the *previous* preview on air, so both
hold the trigger **150 ms** behind a recall in the same cue. Its
**integer-thousandths cue numbering** is the other idea worth taking, if cue
numbers ever become keys here rather than labels.

Transport detail: [webrcs websocket transport](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_webrcs_websocket_transport.md) and the repo's
`docs/TRANSPORT.md`. Protocol generation: [awj protocol](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_awj_protocol.md).

## Settings page + popped-out console — 2026-08-22, 116 tests

Two features and one bug fix, both local commits (`ca5dfd9`, `729f14c`);
**`ca5dfd9` reached `origin/main` anyway** because a co-session committed a
README change on top of it and pushed — **cosession shared checkout** (working-practice note, kept in Claude memory)
earning its keep a third time.

### Settings, in the **Preconfig flyout** (`ui/settings-panel.js`)
The user's ask, and a deliberate placeholder: it reads model/firmware/proxy
state and lists the four coming settings marked "not yet" rather than faking
controls. `Shell` gained a third placement, **`submenuOf`**.

⚠️ **The flyout's active class cannot be lifted off a live element** the way the
sidebar's can — it exists only while the operator is on a page *inside* the
flyout, and they may never go to one. Read it out of the vendor's own stylesheet
instead (`classFromStylesheets`, exported from `ui/shell.js`); a proxied page is
same-origin so `cssRules` is legible. Every link we create now carries
`data-lpp-nav`, because a submenu entry sits inside vendor markup and the
"operator navigated away" listener had no ancestor of ours to test for.

### ⚠️ `.ui.tabular.menu` IS NOT UNIQUE — shipped bug, now fixed
**Preconfig heads its page with a strip built from the same Semantic UI
classes**, and Console + Timeline were being appended to it — two words in a row
of glyphs, on a page they have nothing to do with. A strip now qualifies only if
it holds a **pane switcher: an anchor with a heading and no `href`**. Their tabs
switch panes; Preconfig's are route links. Needs no class, route or label.

### `core/identity.js` — and the four-slot trap
Model/family/firmware/simulated, so model gating can ask once. It learned that
**`system/deviceList` is ALWAYS four slots long**, and the empty ones carry a
placeholder (`dev: 'NLC_DBG'`, empty `label`, empty `updater`) rather than being
absent. A single Aquilon was about to be reported as "4 linked frames". Test for
present-ness on **empty label or empty firmware**, never on the string NLC_DBG.

### Popped-out console (`ui/popout.js`, `server/console.html`, `/__lpp/console`)
Previews top-left, Syntax/Macros shelf right, command line full width beneath.

**It opens NO socket and fetches NO store** — it reaches through
`window.opener.__WRU` and drives the Web RCS tab's own session. That is the only
reason a second window is allowed at all, and it forces the page onto our origin.
Losing the opener disables the inputs and shows a banner. It ships **no
stylesheet**: link hrefs, the `#__SVG_SPRITE_NODE__` sprite and the root
`font-size` are copied off the opener at runtime (rem base is 12px; a popout on
the browser default lays out half again too large).

⚠️ **THERE IS NO SCREEN SNAPSHOT ENDPOINT.** `/api/device/snapshots/<type>/<id>`
serves only `inputs`, `images`, `images-library`, `outputs`, `multiviewers`,
`timers` — read out of the sim's own server bundle. Web RCS **composes the screen
card in the browser**, so `core/screens.js` does the reading half.

Two facts that file exists to hold, neither guessable:
1. **A preset carries geometry for EVERY layer slot, allocated or not.** S1's
   preset A has layer 2 on `LIVE_3` at full screen and layer 2 does not exist.
   The preset says *where*; `screenList/items/<id>/layerList/items/<n>/status/pp/
   capability !== 'OFF'` says *whether*. Drawing the preset alone covers every
   screen in stale full-frame layers, all plausible, none on air.
2. **Which bank is live comes from the transition end, not a flag.**
   `screenAuxGroupList/…/status/pp/transition === 'AT_UP'` ⇒ `control/pp/presetUp`
   is PGM and `presetDown` is PRW; `AT_DOWN` is the reverse.

Other store facts banked: canvas size is
`screenList/items/<id>/status/size/pp/{sizeH,sizeV}`; layer geometry is
`position/pp/{anchor,posH,posV,sizeH,sizeV}` where anchor names read
`<VERTICAL>_<HORIZONTAL>`; opacity is **0-256**, not 0-255. Snapshots come off
**one clock** for the whole window (cache-busted `?<epoch-ms>`, the vendor's own
trick) and stop while `document.hidden`.

Verified on Simulator 6.2.73: PGM full-frame, PRW the 960x960 centred layer at
exactly 25%/5.5556%/50%/88.8889%, and `Recall Screen 1 Memory 3` typed in the
popout went out over the opener's socket, 1/1 write sent.

⚠️ **The Browser pane cannot open a real popup** — `window.open` navigates the
same tab, so the orphan page is what you get. Verify the popout by mounting it
into a same-origin iframe with `opener: window`, or use real Chrome.

### Still to do, in the user's order
Midra 4K / Alta 4K compatibility (see
[aw platform split nlc mng](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_aw_platform_split_nlc_mng.md) — harder than it looks), audio patching
in the console **and in mynah** (`Set Audio Patch HDMI1, ch1 to Dante 1`,
`Set Audio Mute Dante 1 thru 6`), then timeline timecode input and a QLab-style
pop-out cue editor. Macros are coming and the shelf is already there.

## Roadmap stages 2-4 built — 2026-08-22, 176 tests

All four of the user's items now exist. Commits `b769090` (platform), `fd99038`
(audio), `0209755` (timecode), `b8c8f8e` (timeline editor), plus `5dfd626`
(tab-strip fit). **Local only** beyond `ca5dfd9`, which a co-session pushed.

### Platform detection (`core/platform.js`)
See [aw platform split nlc mng](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_aw_platform_split_nlc_mng.md) for the split itself. In this repo:
capabilities are **probed, not tabulated** — a feature is offered when the part
of the store it writes to is present, so an unmet range gets the right answer
for the right reason. **Unknown ≠ unsupported**: everything is on offer until
the store lands, then `shell.remount()`/`tabs.remount()` take back what does
not apply. Verified live on all three sims.

⚠️ **Three UI facts about `mng-platform`, all fixed structurally:**
1. Sidebar module is `sidebar__c__…` vs `sidebar-module__c__…`; **every segment
   after `__c__` is identical**, so both are matched.
2. Its Preconfig flyout items are plain Semantic `<a class="item">` with
   **nothing hashed** — template falls back to the first anchor, active class
   to Semantic's `active`.
3. **`.aw-app` WRAPS a row on LivePremier and IS the row on Midra/Alta.**
   Counting its children picked the main content and the panel rendered at zero
   width — correct, and invisible. The row now comes from the sidebar's parent.
4. ~~Still un-ported: the tab strip's pane-switcher test needs an `h5`, and
   mng puts the label straight in the anchor.~~ Ported 2026-09-12 — see below.

### Audio patching — grammar is MYNAH's (`be4cf9e`), re-vendored here
`device/audio/control/deviceList/items/<frame>/`:
- **`rxList`** = SOURCES: `INPUT_<1-64>_CHANNEL_<1-8>` (**64 inputs, not 32**),
  `DANTE_<1-8>_CHANNEL_<1-8>`, `NONE`. One writable prop: `mute`.
- **`txList`** = DESTINATIONS: `OUTPUT_<1-24>`, `DANTE_<1-8>`, `MVW_<1-2>`,
  each `channelList` 1-8, props `source` / `mute` / `sine`.
- **A patch is ONE write**: the source's key into the destination's `source`.
  No crosspoint object.
- **Dante is a flat 1-64** in the grammar; the model divides into 8x8.
- ⚠️ Adding `Audio` lengthened **`Aux` from `Au` to `Aux`** — prefix
  abbreviation is a property of the whole table. Test pins it.
- ⚠️ **Fixed: a failed compile NEVER showed its reason.** The console read
  `compiled.error`; a failure is `{ok:false, errors:[{message}]}`.

### Timecode (`core/timecode.js`, `core/chase.js`, `ui/timecode-source.js`)
MTC over Web MIDI, LTC off an audio input (worklet taps samples, decoding on
the main thread — a worklet cannot import modules), and `POST /__lpp/timecode`
on the proxy with an SSE stream out.
- **MTC quarter-frames span TWO frames** — the reader adds 2 back or every cue
  lags permanently.
- **LTC transmits no rate**, only the drop-frame flag. Reader returns `null`.
- ⚠️ Three LTC bugs, all found by an encode→decode round trip: the short/long
  threshold must be **0.75** of a bit period (1.5 makes every bit a one and the
  decoder returns *silence*, not nonsense); frame extraction must keep looking
  after discarding a partial frame; frames must be drained **as they complete**
  or a big block loses whatever the ring buffer evicted.
- **The chase**: fires on the reading that CROSSES a cue; going back re-arms;
  **locating forward fires NOTHING it jumped over** (verified: 44 cues jumped,
  none fired); arming mid-show catches up.
- ⚠️ **The chase fires on ARRIVAL, not on a timer** — see
  [browser pane verification traps](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_browser_pane_verification_traps.md) for why (timers are throttled
  in background tabs, not just in the pane).

### Timeline editor popout (`/__lpp/timeline`)
QLab layout: list on top, inspector under. Drives the opener's CueStack live.
`bootPopout` in `ui/popout.js` is now shared by both popouts.
- ⚠️ **`Element.append(null)` writes the text "null"** — `h()` skips it, the
  DOM's own `append` does not.
- ⚠️ **It is `stack.toJSON()`, not `stack.save()`.** Getting it wrong threw
  after the model updated and before the repaint: right model, stale screen,
  silence.
- The inspector is NOT repainted on device traffic (caret); only its heading is
  patched in place.

### Running all three simulators at once
Edit `PORT` + the four `*_PORT` values in
`~/Library/Application Support/ANALOG WAY/<sim>/<session>/settings.ini`, copy to
`settings_0.ini`, then `cd <session dir> && <App>/…/AW_APP_SIMULATOR <ini>`.
**cwd MUST be the session dir** or it exits with two Qt warnings. Ports used
here: LivePremier 3000, Midra 3010, Alta 3020. Backups left as
`settings.ini.lpp-backup`.

## Memories and Layer properties, and why they had to be rebuilt (2026-09-10)

Asked for the vendor's Memories and Properties tabs to pop out to their own
windows "like the command line and cue list". They can't be moved, so they had
to be rebuilt.

⚠️ **A vendor React pane cannot be relocated into a second window.** `#root`
carries `__reactContainer$…` and `__reactEvents$…` — React 17+ delegation, every
listener bound to that one container. Adopt the pane's DOM into a popout and
React keeps *updating* it (it holds node references and does not care about the
document) but every click dies: the native event bubbles to the popout's
document and never reaches `#root`. Their `AwTab` is `renderActiveOnly` as well,
so switching tabs unmounts the pane under you. I checked this on the live
Aquilon before writing anything; there is no way round it short of patching
React internals, which this project will not do.

The vendor's two tabs are **Properties** and **Memories** — there is no tab
called Settings, though the vendor's own i18n key for Properties is literally
`aw.Settings.Properties`, which is presumably where the name came from.

### What the banks actually look like (read off a live Aquilon C, 6.2.73)
- `presetBank` 1000 slots, `masterPresetBank` 500, `layerBank` 50. On this box
  85 / 13 / 0 were in use.
- Screen memories are **one flat global bank**, not per-screen. Slot 2 is
  "Keynote 1_S1" and slot 3 "Keynote 1_S2" — the `_S1` suffix is a naming habit
  of whoever saved it, not structure. Any screen may recall any slot.
- ⚠️ **Save is not the mirror image of recall.** Recall puts the slot first
  (`…/load/slotList/items/<n>/screenList/items/S1/…`); save puts it **last**
  (`…/save/screenList/items/S1/presetList/items/PROGRAM/slotList/items/<n>/…`).
  Assuming symmetry gives a path the device accepts into nowhere — a write that
  succeeds and saves nothing. Master is the exception and takes a slot directly,
  having no single source to name.
- Which slot is in a buffer: `presetBank/status/presetId/screenList/items/<S>/
  presetList/items/<A|B|C>/pp/id`, keyed by **letter**, with `isNotModified`
  beside it — the difference between "showing memory 44" and "showing something
  that started as memory 44".
- Save filters (`categoryFilter`, `layerFilter`, master's `mode`) are read and
  displayed, never written. They belong to the vendor's tab; widening them from
  here would make Save do more than the operator's last visible choice said.

### Layer properties
- `vendor/surface/catalogue.json` already had all of it: 67 layer parameters in
  twelve groups with paths, types, ranges, enums and read-only flags, generated
  for the MIDI mapper. The panel renders the catalogue and knows no parameter
  names of its own.
- ⚠️ **Layer selection is not device state.** No `isSelected` anywhere in the
  123 MB store, nothing in the catalogue. The vendor's tab follows a React
  selection, so a second window cannot track it; ours names the layer instead.
- ⚠️ **NATIVE reported `capability: "OFF"` on this Aquilon**, so the fitted-layer
  gate correctly excludes it. My first test expected it in the list and failed —
  the code was right. NATIVE is a layer slot that costs mixers, not the
  background plane.
- Writes address a **letter**; `bankLetter()` refuses mid-take rather than
  guessing, and a buffer that is on air gets a red banner.

### Verified on the live Aquilon (192.168.2.140, via a worktree server on 8537)
Session live, store mirrored, platform AQUILON NLC_C 6.2.73. 85 rows in the
screen bank with real names. PROGRAM/PREVIEW resolution checked against
`presetUp=B / presetDown=A / transition=AT_DOWN` → program A (live), preview B.
Writes were exercised with `session.send` **stubbed** and restored in a
`finally`, so nothing reached the switcher: opacity wrote
`…/presetList/items/A/layerList/items/1/opacity/pp/opacity = 200`, and 99999
clamped to 256 with the note shown. Recall produced the right `xRequest` path
and defaulted to preview; Erase armed on the first press and only fired on the
second. **This app still has not written to a device.**

### Traps met
- ⚠️ **A backtick inside the CSS comment block in `ui/theme.js` terminates the
  template literal**, and the rest of the stylesheet is then parsed as JS. It
  cost two rounds: the first failure was caught by `node --check`, the second
  reached the browser as `ReferenceError: button is not defined` at theme.js and
  took *all* of main.js down with it — no sidebar, no tabs, no panels.
  `test/modules.test.js` catches it, because importing is the check. Never put a
  backtick in that file's CSS.
- The Browser pane opens `window.open` **in the same tab**, so `window.opener`
  is null and you get the orphan page. The popout build path was verified
  instead by importing `ui/popout.js` in the Web RCS page and mounting with
  `opener: window` — same code, real live session.
- ⚠️ **`rAF` never fires while the pane is hidden**, so a `javascript_tool` call
  that awaits one times out at 45s. Read synchronously.

## Midra 4K / Alta 4K: the Timeline and the Memories panel (2026-09-12)

Asked, from a live event with a **Pulse 4K** on the desk, why the extra tabs on
Screens / Aux. did not appear the way they do on the Aquilon. They were gated
off on purpose (see 2026-08-22 above) because every path was LivePremier-shaped.
The work was strictly read-only against the live box: `GET /` , the bundle and
one `GET /api/stores/device` (1.9 MB — this platform's store is tiny). All
writes went to the simulators. **This app has still never written to physical
hardware; it has now written to two simulators through its own panels.**

### What the box said
- `system/pp = { dev: 'PULSE', platformId: 1536, platformLabel: 'Midra 4K' }`,
  firmware 3.3.10, bundle built 2025-07-04 — the same build date as the Alta
  1.3.1 bundle in the Alta simulator. Midra 3.3.x and Alta 1.3.x are one
  generation of `mng-platform`.
- Takes: `transition/screenList/items/<1-4>/control/pp/{xTake,xCut,xStepBack,
  xTakeAbort,xCopyProgramToPreview,takeTime,tbarPosition,enablePresetToggle}`,
  `status/pp/{transition,tbarPosition,isTbarPositionValid}`; auxes the same
  under `transition/auxiliaryScreenList`. One `takeTime`, tenths. No `take`
  field (TO_UP/TO_DOWN) — the in-flight transition states are the only signal.
- Banks: `preset/bank` (200, screens), `preset/auxBank` (200, auxes),
  `preset/masterBank` (50). Slot metadata under `<bank>/slotList/items/<n>/
  {control/pp/label, control/pp/xDelete, status/pp/isValid}`; screen slots
  carry `screenWidth/screenHeight/transitionDuration`, master slots
  `isShadow/screenFilter/auxFilter`. Load: `<bank>/control/load/slotList/
  items/<n>/screenList/items/<s>/presetList/items/<PROGRAM|PREVIEW>/pp/xRequest`
  (+ `isLoading`). Save: slot LAST, as on LivePremier. Master load/save take
  the slot directly.
- Buffers are `presetList/items/{UP,DOWN}`; which memory each holds is on the
  screen — `.../presetList/items/UP/status/pp/{memoryId,isModified}` (0 = none).
- **Which is program** (read out of the vendor's minified bundle, function
  `SS(mode, takeStatus)`): PROGRAM → UP for `AT_UP|EFFECT_FROM_UP|COPY_FROM_UP`,
  else DOWN; PREVIEW the opposite. Same suffix rule as the nlc letters. Then
  **confirmed by behaviour** on the sim: recall→PROGRAM on an `AT_DOWN` screen
  landed in DOWN, recall→PREVIEW in UP.
- Layers: `presetList/items/<b>/liveLayerList/items/<1-8>/{source/pp/input,
  position/pp/{posH,posV}, size/pp/{sizeH,sizeV}, opacity, crop, mask, border,
  transition, flying, timing, speed, effects, color, status/pp/state}`. Eight
  slots on every screen; the fitted ones are `preconfig/status/stateList/items/
  CURRENT/screenList/items/<n>/liveLayerList/items/<k>/pp/mode !== 'DISABLE'`.
  No anchor — position is the centre. Inputs are `INPUT_<n>`.
- In service: `.../CURRENT/screenList/items/<n>/pp/{enable,layerCount,
  outputList}` and `.../auxiliaryScreenList/items/<n>/pp/mode` (`DISABLE` /
  `ENABLE`). `preconfig/status/pp/{screenValidity,auxValidity,templateValidity}`
  is what the *model* allows — QVU `['1']`, Pulse/Eikos/QMX `['1','2']`,
  ZEN100 three, ZEN200 four; QMX no auxes at all, `templateValidity ['MATRIX']`.
- Pitch exists here too: `outputList/items/<n>/canvas/pitch/pp/{pitchRatioH,
  pitchRatioV,xUpdate}` (nlc: `canvas/cmd`), and screen membership is
  `.../CURRENT/outputList/items/<n>/pp/usedOnScreen`, not on the output. Not
  ported; the probe is now honest so the entry is withheld rather than offered
  and dead.

### What was built
`src/core/dialect.js` (both spellings, chosen by tree), `src/core/commands.js`
(`CMD` over a dialect; the cue stack takes `commands: () => …` and asks at fire
time), `core/screens.js` / `core/memories.js` / `core/properties.fittedLayers`
routed through it, `core/platform.js` probes per family with `layerProperties`
split out of `screens`, `ui/tabs.js` pane-switcher rule + span labels,
`dom.icon()` candidate lists. Identifiers stay `S<n>`/`A<n>` on both platforms.
`test/dialect.test.js` (21) against `test/fixtures/midra-3.2.29-pulse4k.json`,
cut from the sim after the asserted writes had been made — 270 tests.

### Verified live, on the simulators, through the panels
- Midra sim as Pulse 4K (3.2.29 — store shape diffed identical to the live
  3.3.10 box for every subtree touched): Cues tab on the strip, Memories in
  PLUS, VPU/Console/Layer absent with reasons. A cue built in the tab and fired
  with its GO: `…/load/slotList/items/2/screenList/items/1/…/PREVIEW/pp/xRequest`,
  +152 ms `takeTime = 20`, `xTake`; the box echoed `DOWN.memoryId = 2` then
  `AT_DOWN`. Memories panel: rename, save into an empty slot, recall (landed in
  UP = preview while AT_DOWN), the Aux chip refusing with "pick a destination
  first" when no aux is in service.
- Alta sim as Zenith 200 (1.3.7): S1–S4 and A1–A2 listed, a take on `A1 + S4`
  with a 0.5 s fade flipped both to `AT_UP`; aux bank save → `UP.memoryId = 7`
  (program while AT_UP), recall → DOWN.
- QVU, EIKOS, QMX (Midra sim) and ZEN100 (Alta sim) stores captured: **zero
  structural difference** between the six; only the applied preconfig differs.

### Traps met
- ⚠️ **A master save writes every screen's memory into `bankSlot`**, which
  defaults to 1 for all four screens and all four auxes
  (`preset/masterBank/control/save/screenList/items/<n>/pp/bankSlot`). My seed
  saved screen memory 1 and then a master memory; the master save re-wrote
  slot 1 four times, last from disabled screen 4, leaving a memory with
  `screenWidth 0` whose every recall sits at `isLoading: true` forever. Not a
  dialect bug — the vendor UI would do the same — but pick master slots away
  from screen slots you care about, and read `screenWidth` before trusting one.
- **A recall overwrites `takeTime`** with the memory's `transitionDuration`:
  wrote 25, recalled two memories, read 10. Same as LivePremier's
  `takeUpTime`; the cue engine's ordering already handles it.
- The simulators read the port block from **both** `settings.ini` and
  `settings_0.ini` (the engine one, its web child the other): editing only
  `settings_0.ini` boots on the old ports. `DEVICE_TYPE` 1–6 = QVU, PULSE,
  EIKOS, QMX, ZEN100, ZEN200 in both simulators; run copies of the session dir.
- The Browser pane's hidden-tab rAF freeze again: `view.armed` expires after
  4 s, so arm-and-fire has to happen in one `javascript_tool` call, with
  `__WRU.shell.refresh()` between the clicks.
- Midra's Sources strip is four **icon-only anchors with no href** — a shape
  the old href-only Preconfig rule would have accepted. Words are now required.

### Still to do
- **Console on mng** — a Midra target in mynah (`src/lang/paths.ts` is
  LivePremier-only; a `target` per family, plus the OSC dictionary). Until
  then the tab is withheld with that reason.
- **Layer tab on mng** — teach `awj-surface/tools/gen-catalogue.mjs` the
  minified bundle (`n.d(t,"OUTPUT_ATTRIBUTES",…)` instead of `const
  X_ATTRIBUTES = {`, enums as `{key,items,order}`), generate a second
  catalogue, and give `core/properties.js` a per-dialect layer root.
- **Pitch on mng** — `canvas/pitch` + preconfig membership; small.
- **MIDI Mapping** anchors after `Virtual RC400T`, which the mng sidebar does
  not have; it is also catalogue-driven, so it belongs with the Layer work.
- Drive it against a physical Midra / Alta when one is not mid-show.

### The Console followed, the same day

mynah `6272e77` (v1.4.0) gained `src/lang/platforms.ts` — `LIVEPREMIER` and
`MIDRA` — and a `platform` in the run/compile/parse context; re-vendored here
by `npm run sync:mynah-lang`. `ui/console-panel.js` passes
`mynahPlatform(dialectFor(store))`; `server/osc.js` asks the switcher over AWJ
(the nlc per-frame `dev` path vs the mng `platformLabel` path — a missing path
answers `{path:"", value:null}` on both simulators) and caches per host.
Driven at the Pulse 4K simulator's Console: `Recall Screen 2 Memory 2 Program`
landed `DOWN.memoryId = 2`, `Take Screen 2` flipped it to `AT_UP`,
`/lp/screen/2/group/control/takeTime 15` wrote 15, `Take Screen 7` was refused
with "1 to 4". `docs/OSC.md` now carries the Midra tables (44 addresses).

⚠️ **`SAVE_FROM_PVW` never existed.** mynah had written it for every
`Store Master … Preview` since day one; the enum is `SAVE_FROM_PRW` on both
platforms and the device keeps the previous mode when sent the wrong word.
Proved on the LivePremier simulator by writing both and reading back. Fixed
upstream; this vendored copy has the fix.

- The Browser pane's `key: "Return"` sends an empty keydown; `"Enter"` is the
  one that carries `key: 'Enter'`. Cost a round of "the console does not
  submit".
- The mng sprite has no `mini-list-14`; the Console tab falls back to `bars-14`.

### Layer and Pitch followed too

awj-surface `171ed53` taught `tools/gen-catalogue.mjs` the minified mng bundle
(`n.d(t,"X_ATTRIBUTES",…)`, `readOnly:!0`, scattered `NAME:{key:"NAME",…}` enums,
`3e3`) and both store layouts, plus `--bundle`/`--store` for captures. The Midra
catalogue was cut from this morning's read-only capture of the live Pulse 4K:
57 layer parameters, 11 take-group ones, zero inferred; the LivePremier one
regenerates byte-identically. Vendored as `vendor/surface/catalogue-mng.json`;
`core/dialect.js` carries the catalogue, the layer root and the pitch node per
platform. Driven on the Pulse sim through the Layer tab: source → `INPUT_3`
echoed, opacity 999 clamped to 256 and echoed; pitch 1004/998 written under
`canvas/pitch` and read back, output 1 on S1 and 2 on S2. The MIDI mapper stays
LivePremier's (engine paths, RC400T anchor).

### Still to do
- Drive it against the physical Pulse 4K when the show is over — a field test
  suite for that is the next thing.
- MIDI Mapping on mng: the vendored surface engine's `paths.js`/`preset.js`.


## Proven on the live Pulse 4K (2026-09-12 evening, 2026-09-13 morning)

The suite in `~/dev/pulse-field-test` (sibling of the Aquilon one) ran against
the box itself, `192.168.2.140`, firmware 3.3.10, serial IB0174. Read-only
phases mid-show in the morning; the write phase in the evening once the
operator had **frozen both screens** (`screenList/items/<n>/control/pp/freeze`
— this platform freezes screens, backgrounds, layers and inputs, and has no
output-level freeze); the Console lines the next morning, typed by the
operator, before the show went live again. **Nothing this app or its harness
sent unfroze anything; 0 of 60 freeze flags moved.**

### The write phase: 39 PASS, 0 FAIL, 0 CHANGED (S2, slot 190/191, multiviewer 20, output 2)
- `takeTime` round-trips in ~40 ms and is broadcast on the WebSocket in the
  same breath; an AWJ `Subscriptions` on a second socket receives the push in
  ~37 ms. The dialect's fade is the single `takeTime` write, as designed.
- Store from PROGRAM validates a slot in ~185 ms; `transitionDuration` captures
  the screen's `takeTime`; the buffer it came from then says `memoryId = 190`.
  A label write echoes as a string. A recall into PREVIEW lands in the buffer
  the `UP`/`DOWN` suffix rule names (`AT_UP` → preview is `DOWN`), with
  `isLoading` true for **~32 ms** (the simulator says 0). A recall of an
  **empty** slot is total silence — no `isLoading`, no error, the buffer keeps
  what it had — exactly the trap documented on 2026-09-12.
- **Takes, with preset toggle off.** Both screens on this show run
  `enablePresetToggle = false`, and the transition then passes through
  `EFFECT_FROM_UP` *and* `COPY_FROM_UP` before `AT_DOWN`: fire → `AT_x` took
  1242–1260 ms on a 1.0 s take. The simulator (toggle on) sends only the
  `EFFECT_` state and lands in ~1035 ms. Anything that waits for a take to
  settle should allow takeTime + ~300 ms, and should key on the `AT_` state,
  never on elapsed time. Program and preview still swap ends; the suffix rule
  held on every step.
- Layer opacity on the preview buffer: 30 ms round trip, broadcast, program
  untouched, and mynah's `Set Screen 2 Layer 1 Opacity` for MIDRA names the
  same leaf.
- Multiviewer: `Store Multiviewer 1 Memory 20` validates, labels, recalls and
  deletes through the paths mynah spells. **One finding:** the recall re-synced
  `widgetList/items/17..27/control/pp/{sizeH,sizeV}` from 480×270 to 320×180.
  Those eleven widgets are outside this model's `widgetValidity` (1–16),
  disabled, sourced `NONE`, and their *status* already read 320×180 — so the
  device was reconciling control with status, invisibly. Widgets 1–16 were
  byte-identical. Recorded, not "fixed".
- Pitch: `pitchRatioH 1000 → 1001`, `xUpdate`, read back, restored — on output
  2, the operator's nominated display. `pitchedWidth` still read 1920 straight
  after the commit; the status may lag the ratio.
- Residue after the whole run, from a leaf-by-leaf diff of the store: the
  platform's `x…` triggers stay `true` after firing; S2's two buffers' `memoryId`
  went 1 → 0 (the Web RCS header reads `M --`), because the store/delete of
  slot 190 re-labelled the program buffer and deleting the slot cleared it. The
  operator's *modified* preview was kept by restoring from the backup slot
  rather than re-recalling memory 1 — a recall would have discarded the
  changes for the sake of a header label, and the harness now refuses to.

### The Console at the real box (operator-typed, S2)
`Take Screen 7`, `Recall Screen 1 Layer 1 Memory 3`, `Set Audio Mute Output 1`
and `Store Master 1 If Category Keyer` were all refused offline with the
platform's reasons; `Store Screen 2 Memory 191 Preview`, `Recall Screen 2
Memory 1` (header `M 1`, log `1/1 write sent`), `Set Screen 2 Layer 1 Opacity
50%` and back, `/lp/screen/2/group/control/takeTime 15` and back (the vendor's
Transition field followed), then `Recall Screen 2 Memory 191` and `Delete
Screen 2 Memory 191` — the box read back restored afterwards. These are the
first writes any panel of this app has made to physical hardware. The
Timeline's GO, the Layer tab and the Memories panel's own buttons remain
simulator-proven only on this platform.

### Two facts about the box worth keeping
- `SAVE_FROM_PRW` is the master save-from-preview value on this platform too
  (mynah 1.4.0 corrected it from the never-existed `SAVE_FROM_PVW`).
- A missing AWJ path answers `{"path":"","value":null}`; the seven LivePremier
  spellings the suite probes (e.g. `screenAuxGroupList`) all answered that, and
  all 439 paths the port emits — dialect, mynah, catalogue — answered a value.

## Audio on Midra 4K / Alta 4K, and a Console bug it exposed (2026-09-13)

mynah d51392a routes audio on `MIDRA` — no matrix there; thirty-four
eight-channel sources and a set of points that carry one or follow something,
the preset's **audio layer** being the part an operator programs (it takes with
the preset, like the layers). Re-vendored here; the `audioPatch` capability now
probes `audio/sourceList` on mng and reads "Audio routing — yes" on the
Pulse. The Pulse fixture gained the audio subtrees from the same simulator
store so the paths the Console names are proven to exist in a real shape.

Driving it at the Console against the Pulse simulator found that **no mynah
`Set` had ever compiled at the Console**: `runContext()` passed `osc.buffer`
for the OSC dialect and nothing under `facts`, which is what mynah's `Set`
reads — so `Set Screen 1 Layer 1 Opacity 128` was refused with "Set needs a
live connection" while the store was live beside it. Fixed: `facts.buffer`
and `facts.canvas` come from the mirror. (The ledger of 2026-09-13 records the
operator's `Set Screen 2 Layer 1 Opacity 50%` at the real box as "as
expected"; on this code that line can only have been refused, so treat that
row as the operator's recollection rather than a proof — the AWJ-level
opacity write was proven the evening before by the harness.) After the fix,
eight lines through the Console on the simulator — the opacity, a patch to the
audio layer (the vendor's own header dropdown changed to "Input 3"), a patch
to output 1, a mute, and their undoing — all `n/n writes sent`.

## VPU map: natives above, continuing screens stacked, a header per link (2026-09-15)

Synced the model from aquilon-vpu-map `5936339` (see that repo's NOTES for the
account) and ported its three changes to `vpu-panel.js`: the native band is drawn
ABOVE the field because an output link runs down through a VPU and the native is
the bottom of the stack; a screen whose next layer landed on another VPU on the same
links (`screens[].from`/`to`, `stackVpus`) has the two cards stacked in a
`.wru-vpu-stack` with the arrows at both ends in the screen's colour and "↓ VPU 2"
under the leaving ones; and two header rows under the screen bar name each link's
region and output plug. `core/vpu.js` gained `readOutputs`, lifting
`outputList/items/<n>/{canvas/status,control,mapping,plugList}` into the flat
`{screen, region, capability, label, card, physical, type}` record
`screenOutputLinks` reads, and `readSide` carries it as `outputs` — the RUNNING
assignment, so on the staged side a screen the staging changes fails the
outputCount / usedOutputCapabilities check and gets no header, by design.

The live-resources capture (S2 NAT+L1 on VPU 1, L2 on VPU 2) is the cascade in
this repo's fixtures; `test/core.test.js` pins its stack and the sim outputs'
adapter shape. **`tools/preview.html` had been building an EMPTY store for that
capture** — it only knew the `{current, new}` shape, so the live-resources option
hydrated nothing and reported "No VPU fitted" — fixed to hydrate a store-shaped
capture as it is, and given a "synthesise outputs" box that invents an outputList
from each screen's figures, since no capture carries real ones. The vendor test
skips here (no sibling checkout in a worktree); it bites in the shared checkouts
once both are pulled, and they agree.

**Later the same day — the header is part-verified after all.** The 09-09 field
test's whole-store pull (`~/dev/aquilon-field-test/results/store-device-2026-09-09T19-56-34.json`)
holds `outputList` with every field `readOutputs` reads — 96 slots, 1-12 fitted,
unfitted ones answering `NONE` with `isAvailable:false`. Trimmed into
`test/fixtures/aquilon-c-dual-outputs.json` (S1 on Out 7, S2 on 8, S3 on 5, one DUAL
output each under 4K layers; auxes A1-A4 on the SDI card; labels dropped) and pinned
in core.test.js: the adapter's record shape, each screen adding up, `[4, 2]` rows, no
stack. The preview harness offers it — real outputs, no need to synthesise. **Still
open on a box: the order of a screen's links over several outputs**, and the `mapping`
/ `control` / `$plug` AWJ spellings (the store objects exist; only the
`canvas/status/@props` prefix was asked over AWJ that day). The note for the next
box lives in aquilon-vpu-map: `docs/CAPTURE-GUIDE.md` → "Validate on real hardware",
`scripts/probe-hardware.mjs` step 6.


## The Edit page, and a way into the memory bank that misses both buses (2026-09-22)

An operator building a look has only program and preview to build it in, and
preview is where the next cue is parked. The Edit page is the third place: the
Screens / Aux. layout with one EDIT row per destination instead of the PGM/PRW
pair, and that row lives in this process.

### What was asked of the device first, and what it answered

Everything below was measured over AWJ against a **LivePremier Simulator
6.2.73**, with every probe calibrated against a deliberately bogus path (which
gets no reply) so that "no reply" could be read as "no such node".

**A screen has three preset buffers.** `screenList/items/S1/presetList` carries
`A`, `B` and `C`, each with 129 layer slots. `C` is `presetPrevious`.

**You cannot save from C, so it is not a programmer.**

```text
presetBank/control/save/screenList/items/S1/presetList/items/   -> PROGRAM, PREVIEW
  .../items/PROGRAM/slotList/items/1/pp/xRequest   -> false   (exists)
  .../items/C/slotList/items/1/pp/xRequest         -> no reply (does not)
presetBank/control/load/slotList/items/1/screenList/items/S1/presetList/items/
                                                   -> PROGRAM, PREVIEW
```

And the device overwrites C on every take, which is what step-back steps back
to. Two independent reasons, either one fatal.

**A memory's contents are not in the store.** A bank slot publishes `isValid`,
`label`, `categoryFilter`, `layerFilter`, `screenAuxWidth`, `screenAuxHeight`
and `transitionDuration`. `presetBank/bankList/items/1/screenList/...` is not a
node. So "load memory 44 into the programmer" cannot be answered from the
mirror, however long you look.

### But the bank has an export and an import, and the file is JSON

Not in Web RCS 6.2.73's UI — the bundle has no source file for it and no
upload route for one — and not in the protocol guide. It is in the object
model:

```text
presetBank/export/cmd/pp/{selection[1000], path, xRequest}
presetBank/export/status/pp/{fileName, status}
presetBank/import/extract/cmd/pp/{path, xRequest}
presetBank/import/extract/status/pp/status
presetBank/import/load/$bank/@items/<n>/pp/{isValid, label, orgIndex, dstIndex}
presetBank/import/load/cmd/pp/xRequest
```

**Export wants a DIRECTORY and import wants a FILE**, and both say so badly:
a file name on export is `ERROR_INVALID_PATH`, a directory on import is
`ERROR_INVALID_FILE`, and `/tmp` without the slash is `ERROR_COPY`. The file is
always called `Preset.json`, reported back in `export/status/pp/fileName`.

One memory, all filters open:

```json
[{ "BankSlot": 990,
   "Layer": { "0": { "xPEMEM_BANK_INPUTNUM": "LIVE_5", "xPEMEM_BANK_POSH": 960, … } },
   "xPEMEM_BANK_LABEL": "", "xPEMEM_BANK_DURATION": 10,
   "xPEMEM_BANK_FILTER_CATEGORY": [ …14… ], "xPEMEM_BANK_FILTER_LAYER": [ …129… ],
   "xPEMEM_BANK_SCREEN_WIDTH": 1920, "xPEMEM_BANK_SCREEN_HEIGHT": 1080 }]
```

- **NATIVE is layer `0`**; the rest are `1`..`128` under their own numbers.
- **The filters say what the memory contains, not what it may do.** Slot 1 on
  the simulator was saved with `["SOURCE","POS"]` and carries twelve fields per
  layer; the same screen saved with all fourteen carries **72**. A memory this
  app composes declares all fourteen, because it supplies all of them.
- **66 of those 72 are the catalogue's writable parameters** under other names
  — `POSH`, `SIZEH`, `BORDER_SHADOW_POS_H` for `border.shadow.sizeH`, the whole
  cut-and-fill subtree spelled `MASK_*` while `cropping.mask.*` is `CROP_MASK_*`.
  The table is in `core/preset-file.js` and it was **checked, not guessed**: a
  memory saved with every filter open, compared field-for-field against the live
  preset node for the same three layers — 198 pairs, 95 on a non-default value,
  **none disagreeing**. The fixture is that comparison, trimmed to three layers.
- **The six with no catalogue parameter** are `LAYER_CAPABILITY` (the screen's
  own `layerList/items/<k>/status/pp/capability`, not a preset property at all)
  and `ROTH`, `ROTV`, `ROTZ`, `BEZIER_PT1_POSZ`, `BEZIER_PT2_POSZ`, which have
  no node anywhere in the live preset tree on this firmware. Carried verbatim
  on the way in, emitted at the device's own values on the way out.
- The catalogue's one read-only parameter, `source.status.inputNum`, is
  correctly absent from every memory.

**The round trip was proven before a line of the page was written**: export
slot 1, hand-edit `BankSlot`, label, duration and a position, extract, set
`dstIndex`, load — and the device reported slot 900 valid with exactly what was
typed into the file. No buffer written, no take fired. Then deleted.

### ⚠️ The path is the device's filesystem

This is the one thing not answered. `extract/cmd/pp/path` is resolved by the
machine running the device software. On a simulator that is this machine, which
is why the direct save works here. **On a real Aquilon it is the switcher's own
disk**, and nothing yet establishes how to put a file there — Web RCS's only
upload routes are `/device/hardware/config/upload`, `/device/images/upload` and
`/device/lut-libraries/upload`, none of them presets. Hence
`settings.memoryImportDir`, and hence the second route.

### The second route, and what it costs

`core/save-look.js` also saves by borrowing preview: write the look into the
preview buffer, fire the ordinary save, then write the whole buffer back
property-for-property from a deep copy taken before anything was sent. Program
never moves. It is refused mid-take, for the reason `core/properties.js` gives.
It is the only route on Midra 4K and Alta 4K, whose banks have no import.

What it does **not** restore is the bank's opinion: `isNotModified` goes false
on the first write and putting the values back does not put the flag back. The
device is right that the buffer was modified, so the page says so rather than
hiding it.

A visible difference between the two, seen on the simulator: the direct route's
`layerFilter` is exactly the layers the look carried (`["1","2"]`), while the
preview route's is whatever the device's own save filters say (all 129) —
because those filters are the vendor UI's to set and this app deliberately does
not touch them.

### Driven end to end (simulator, through the proxy)

All three of S1's preset buffers — every layer's source, position, size and
opacity, plus the transition — read over AWJ before and after a full editing
session (seed from program, a source onto a layer, a drag), and **identical**.
Slot 900 saved by the direct route with the buffers still identical; that memory
read back into an emptied programmer, 132 properties, the dragged geometry
exactly where it was left; slot 901 by the preview route, preview restored.
Both slots deleted afterwards and the simulator left as found.

### Two traps met while building the page

- **`view.dest`/`view.layer` are null until somebody picks, and null means "the
  first one".** Reading them raw is how the page came to say "pick a layer
  first" with a layer visibly selected in the rail beside it.
- **The device's read-only echoes have no meaning in a programmer.** A seeded
  buffer carried `source/status/pp/inputNum` from wherever it was copied, so the
  Layer panel reported a look as "(showing IN5)" while it plainly held IN2.
  `core/programmer.js` strips every read-only parameter on seed; absent is the
  honest value and the panel already draws nothing for it.

## Companion, mounted inside our origin (built 2026-09-22 morning, merged for 0.11.0)

Built on its own branch in the morning and left unmerged when that session
ended; merged the same evening after the Edit page, and released as 0.11.0. The
commit messages carry the full account and are worth reading in order —
`cde96fe`, `771c699`, `00aaaa9`, `1ef9bf1` — so this is the short version.

### What Companion does that makes the mount possible

Companion 4.1+ serves under a sub-path by rewriting a `/ROOT_URL_HERE` token
through every HTML, CSS and JS response, driven by a `companion-custom-prefix`
request header. Checked on 5.0.5, not taken from the docs: assets come back as
`/__lpp/companion/ui/assets/…` and the bundle's socket helper dials
`/__lpp/companion/ui/trpc`.

- **Strip the prefix from the request line; announce it only in the header.**
  Companion's Express routes match the unprefixed path and `isTrpcUpgradeRequest`
  matches the pathname `/trpc` exactly. The failure for getting it wrong is a
  socket that opens and says nothing.
- **Its CSWSH check has to be re-made, not bypassed.** See AGENTS.md. Live
  results: `101` for our page and for no Origin; `403` for a forged origin and for
  the `null` a sandboxed iframe sends.

### Companion facts found against a live 5.0.5

| What | What it looks like | What is true |
|---|---|---|
| `instances.connections.add` with `versionId: null` | "Invalid or malformed input provided for instances.connections.add/mutation" | the tRPC schema is `z.string()`; the null-handling code behind it is unreachable |
| a module lookup by bare id | "not installed" | modules are keyed `connection:<id>` in `instances.modules.watch` |
| `instances.modules.watch` | — | a subscription with no one-shot form; take `init` and hang up |
| `setConfig` refusing | a resolved promise | it resolves with a *string* on refusal and `null` on success |
| adding a second "AWJ" | the label you sent | `makeLabelUnique` makes it "AWJ 2", and `setConfig` requires the real one |
| `installModuleTar` | refused | only for a client on Companion's own machine — *this process*, not the browser |

`pickVersion` prefers `stableVersion` (Companion's own `getLatestVersionOfModule`
order), then beta, then the last installed, with `dev` last.

### What was proven, and when

On the branch, against Companion 5.0.5 and a LivePremier simulator: the
mounted Buttons page loaded same-origin (`contentDocument` readable, grid drawn,
one socket relayed); the panel listed the show's three real connections with live
status and raised the loopback warning; the feed produced events when a
connection was disabled and re-enabled through Companion's own HTTP API; and AWJ
was added at `2.5.1-customfix-jt`, configured, and reported status good.

**The LivePremier Plus half is expected to fail**, and does, with a sentence:
there is no `livepremier-plus` Companion module yet.

### The merge (2026-09-22 evening)

Replayed onto main by cherry-pick, keeping the linear history. Three conflicts,
every one of them the Pixelhue console (landed on main after the branch was
cut) and Companion adding to the same place — the settings defaults and
`normalise`, the proxy's imports, `/settings` responses and `closeRelays`, and
the test list. One needed care: main's side of the settings conflict ran past
the `};` closing `DEFAULT_SETTINGS` and into `hostOrNothing`, so a plain
keep-both would have put `...DEFAULT_COMPANION` inside a function.

The six Companion-only files are byte-identical to the branch. The suite passed
at the first replayed commit and at the last (522 tests, 0 failures).

**Re-checked through the merged proxy, not against a live Companion.** The
Companion that had been used was still running but bound to `192.168.12.85:8000`,
a bench interface this Mac no longer had, so it was unreachable. A second,
throwaway instance was ruled out: Companion has no flag to disable USB, and a
second one would contend with the first for the operator's Stream Deck. What was
checked instead: `/__lpp/settings` reports both the Pixelhue and Companion links
and still carries the Edit page's `memoryImportDir`; `/__lpp/companion/state`
answers with the unconfigured facts; the mount answers `503 no Companion
configured`; enabling the link at a dead loopback port redials and reports
`ECONNREFUSED`, and switching it off restores the defaults (whether a change to
some *other* setting leaves the link alone is decided by `companionChanged`,
which its own test pins); and both the Edit page and the Companion panel mount
and work side by side.

## Layer Lock and partial takes (2026-09-23)

Asked for: "only transition a specified layer, or lock a specified layer from
transitioning with everything else." The switcher has neither.

### What the device has, and what it does not

Searched in the whole 6.2.73 simulator store (124 MB) and the vendor bundle:

- **No per-layer take, no layer lock.** `screenAuxGroupList/items/<S>/control`
  carries `xTake`, `xCut`, `xTakeUp`, `xTakeDown`, `xTakeAbort`, `xStepBack`,
  `copyMode` and `xCopyProgramToPreview` — all whole-screen.
- **A per-preset, per-layer `transition` node**:
  `presetList/items/<A|B>/layerList/items/<k>/transition/{pp/flags, opening/pp, closing/pp}`.
  `flags` is a map of `PE_TRANSITION_FLAGS` — `FORCE_TRANSITION` (vendor
  comment: "Avoid cross transition", the default on every layer),
  `FORCE_CROSS`, `DEPTH_CUT_START`, `DEPTH_CUT_MIDDLE`. How a layer changes,
  not whether. `system/userPref` has `layerForceTransition` /
  `layerForceCross` defaults.
- **The device's verdict per layer**: `screenList/items/<S>/layerList/items/<k>/status/pp/up|down`,
  enum `LAYER_STATUS` — OFF, OPEN, CLOSE, CROSS, FLYING, FLYING_DEPTH,
  PREEMPTED, MASK, OUT_OF_CAPACITY, UNAVAILABLE_SOURCE ("Layer will do a …
  transition"). The Aquilon C capture (`aquilon-6.2.73-memories.json`) has
  `CROSS` for LIVE_2 vs LIVE_8 at identical geometry and `OFF` for NONE in
  both. **The simulator answers `OFF` for every layer, always** — changing
  both buffers over AWJ never moved it.
- The simulator's output snapshot is a static "OUT1" placeholder PNG, so
  nothing on a simulator can show a layer standing still.

### What was built

Lock = keep preview equal to program (a follower, plus a gate in the hook that
holds a TAKE/CUT for as long as it takes to line up an out-of-step locked
layer); take only = hold every other layer, take, restore their preview looks.
AGENTS.md has the rules.

### Driven on the simulator through the proxy

- The switcher echoes a page write in **~3.5 ms**, same path, to the sender.
- **Lock** S1 L1: preview L1 went NONE → LIVE_2 to match program in one
  write; the lock survived a reload (`/__lpp/layer-lock`).
- **Follower**: a preview edit to L1 (source + posH) was written straight
  back, preview letter only.
- **Recall + vendor TAKE in one tick**, the take sent on the app socket through
  `WebSocket.prototype.send` as the vendor's button does: L1's fix went out,
  was echoed, THEN the take — new program L1 unchanged, L2 took the new
  source. First run exposed the path-only echo match (the take left before the
  lock's echo); fixed to path + value, re-run clean.
- **Take only** S1 L2 with L1 unlocked and a pending look in preview: three
  writes — hold L1, TAKE, restore L1 into the new preview. Program L1 stayed,
  L2 changed, preview L1 had its pending look back.
- **Take only across two screens** (S1 L2 + S2 L1) through the `locks`
  service: both took, S1 L1 held and restored.

⚠️ Another client on the shared simulator was taking S1 during the session;
twice the letters flipped between a read and a write. The engine resolves
letters at the moment it writes, which is why it was right; a hand-written
test that cached "preview is A" was not.

### Not proven

- Any real frame. In particular: that a locked layer with a *live* source is
  truly still through a take (the verdict should read `OFF` there), and which
  of `up`/`down` is "next".
- Midra 4K / Alta 4K: the code is dialect-generic (takes are recognised
  through `dialect.takeControl`, layers through `layerParamPath`), no
  simulator was run and there is no verdict field there.

## Connectors on Midra 4K / Alta 4K (2026-10-06)

`readConnectors` applied the LivePremier reading everywhere — a
`mapping/pp/isValid` gate, `IN_`/bare keys — and a Midra has neither, so it
reported no inputs. The visible cost: HyperDecks' **Plays into** offered nothing
on a Midra, no deck could be linked, and its on-air rules never ran
(`sourceForInput` could not number `INPUT_7` either). Same bug as
`MNG.sources()` earlier that day.

Read off the Midra 4K simulator as a Pulse 4K (GET only) and checked against
the rear panel the Midra 3.2.29 and Alta 1.3.7 bundles draw:

- Inputs `INPUT_1..16`, ten `isAvailable`. Plugs 1–4 are **alternatives**
  (INPUT_1: HDMI or SDI), `status/pp/plug` the one read; the label is on it.
- Outputs `1..6` and `MTVW`; 1, 2 and `MTVW` available. Plugs are **copies**:
  output 1 drives HDMI and SDI at once (`plugStatus` ACTIVE on both). Only
  `NOT_AVAILABLE` means no socket — `DISABLE_NO_DISPLAY` is a socket with no
  monitor on it. The rear panel draws `MTVW` as output connector `MON_1`.

Each dialect now has `connector(side, node)`; `connectors.js` walks and knows
neither spelling. `logicalIndex` reads `INPUT_<n>`, and `core/patch.js` uses it
instead of its private copy (which would have missed `INPUT_3` on OSC).

Decided per caller: HyperDecks — fixed, on both platforms. Variables — already
right (it reads `dialect.inputFormats`/`outputFormats`). Audio Matrix — nlc
only by design. Matrix Routing — **still not offered on mng**: the probe lost
its mng half on purpose, because `connectorForPage` turns LivePremier URLs and
headings into LivePremier keys (`In3` → `IN_3`) and Midra's pages have not been
read for it. Lighting it is a separate job: read those pages on the simulator,
teach `connectorForPage` the dialect, then add the probe back.

## The tab strip behind ⋯, and an Aquilon RS4 on 6.1.60 (2026-10-16)

**The strip.** Web RCS 6.2.73 lifts the per-screen strip into the setup panel's
header — `position: absolute`, `left: 50%`, `translateX(-50%)` — over a panel
that is a fixed 360px at any window width, with the panel's collapse button
(`arrows-right-10`, 24px) at the header's right. Properties and Memories take
244px of the ~312 that leaves, so four plugin tabs never fitted: the old
ladder bottomed out at icon-only, 426px wide, spilling 33px off *both* sides
and under the `»`. It measured `scrollWidth` against the parent's
`clientWidth`, which saw neither the centring nor the button. `ui/tabs.js` now
measures the strip's rect against the panel, short of any header button level
with the tabs, and its last rung keeps as many icons as fit and puts the rest
behind ⋯ (a fixed menu on `<body>`). On LivePremier that is ⋯ alone. Same
numbers on the simulator at 1280 and 1920, and on the RS4 below.

**The box.** 192.168.2.140 now answers as `NLC_RS4`, label `AQUILON`, serial
GB0709, firmware **6.1.60** (it was an Aquilon C on 2026-09-09). The field kit's
read-only phases ran clean bar the VPU (below); its record and the 124 MB store
are in `~/dev/aquilon-field-test/results/` under 2026-10-16. It is set up as a
show (LED 1, LED 2, Prompt; six auxes; six named memories) and was being
operated while I looked — S1 went from memory 3 to 5 between two reads — so
writes stopped at one.

- **The Layer tab's first write to LivePremier hardware.** S3 Prompt, PRW
  (buffer B), layer 1, opacity 256 → 240 → 256 through the tab's own field;
  AWJ read 240 with program (A) untouched, then 256, and the buffer's
  `presetId` status (0, modified) unchanged.
- **The VPU map is wrong about what it is looking at.** 6.1.60 has the
  simulator's shape — `pipeList` (64) and `vpuLayerList` (32
  `PROC_<1-4>_SCALER_<1-8>`, every one `capability: OFF`, nothing enabled), no
  `vpuMixerList` — while its screens are plainly on air. Nothing to draw is
  right; "the simulator simply has no VPU" is not. Firmware, not simulator,
  needs saying. **Fixed the same day:** `inspectMapping` calls the shape
  `unreported` (and only while every scaler is off), and the panel picks
  its words from `isSimulated`: the simulator's own, "this firmware does not
  report its VPU allocation" naming the model and firmware, or a neutral
  sentence when there is no identity. The fixture
  `aquilon-rs4-6.1.60-resources.json` is cut from that store read.
- **Arithmetic does nothing on 6.1.60.** The geometry fields are
  `input[type=number]` with `step`/`min`/`max` (X -960..2880, width 0..8192);
  `isNumericField` wants `type=text`, so it never engages. Not typed into on
  the box: a number input discards an expression, and what the vendor commits
  for an empty value on a live preview was not worth finding out. Fixed the
  same day — the next entry.
- **The Layer tab offers every source the catalogue knows** (LIVE 1 to 256)
  on a box with 24 inputs available. `valuesFor` returns the enum whole.
  *Fixed the same day* — see "The source list" below.
- Not run, deliberately: anything that takes, writes program, outputs, EDIDs
  or audio. The Console step was refused by the session's own guard.

**The source list.** The Layer tab's and the Edit page's source dropdown now
offers what the vendor's own picker offers, read off the 6.2.73 client bundle
(`allAvailableLayerSourcesSelector`): NONE and COLOR; an input or still whose
device-list status is `isAvailable` and `isEnabled` and whose `global` in the
*applied preconfig* is `USED`; a screen whose `mode` is `FREESTYLE`; and the
eight background sets. `NLC.sourceOffered` / `MNG.sourceOffered` in
`core/dialect.js`; `offeredValues` in `core/properties.js`.

- RS4 store (from the field kit, not committed): 24 of 256 inputs, 48 of 192
  stills (allocated; one holds a picture), 3 of 24 screens — 85 entries where
  there were 482.
- The 6.2.73 simulator through the app: 92 entries (32 inputs, 48 stills, 2
  screens, 8 sets, NONE, COLOR), and the vendor's Sources panel's four tabs
  hold 32, 48, 8 and 2 cards. Read only; nothing written.
- ⚠️ The still list's own `global` is not the preconfig's: the simulator reads
  `DISABLE` on the device list for five allocated, empty stills that the
  preconfig calls `USED`, and the vendor offers them. On the RS4 the two agreed.
- What the layer holds is always in the list, marked "(not available)" when
  it is not on offer, so the field never shows NONE for a layer on an input
  that has gone.
- Writes are not narrowed: `valuesFor` is still the whole enum, so a cue, a
  group's fan-out or the Console can still send a source that is not on offer.
  Send-to takes its source off the vendor's own cards (already this rule) and
  a ganged group copies what a member was set to, so neither offers a list.
- **And by the kind of layer**, as the vendor's own dropdown does
  (`getAllowedLayerSourceTypes`, read by `useAcceptableLayerSources`): a
  screen's NATIVE layer takes NONE and the eight background sets only, an aux's
  NATIVE layer only NONE, an aux layer no COLOR, and a screen layer other
  screens only in split mode — the vendor's `!isMixerModeEnabled` on the
  screen's own `layerList/items/<k>/status/pp`. `LAYER_SOURCE_TYPES` in
  `core/dialect.js`; the panel passes its layer. Not the cut-and-fill source,
  which keeps availability only. Midra has nothing to narrow: its only layers
  are a screen's live layers, and each takes the whole list.
- On the simulator through the app (read only; the vendor socket's `send` was
  swapped for a recorder that swallowed everything, and recorded nothing):
  S1 L1 in mixer mode, 82 entries and no screens; S1 L2 and S2 L1 in split
  mode, 84 with SCREEN_1 and SCREEN_2; no background sets on any. S1's preview
  L2 held LIVE_44 on a 32-input frame, and showed as "LIVE 44 (not available)",
  selected. The vendor's own Properties tab draws a layer's source as a picture
  card, not a list, so the two lists were not compared side by side. No NATIVE
  or aux layer is fitted on that simulator, so those two are fixture-tested only.

**A second pass, the same day, read-only on the box.** The Console's
`AWJ {"op":"get",…}` answered `NLC_RS4` through the server's own AWJ path.
**Variables** generated 685 `$` names off the RS4 (`$device.firmware` 6.1.60,
`$S1.width` 2880, every layer value matching the store). **Audio Matrix**
drew the real frame: 112 channels patched, 48 kHz on a Dante clock, outputs
named by the screens they drive. Every write after that (a Console recall of
an empty slot, switching the Thumbnail relay on in a throwaway instance) was
refused by the session's guard before it left; the AWJ witness confirmed
nothing reached the box. So the panels' LivePremier writes are still the
Layer tab's one opacity.

**How to run the rest without leaving a trace**, worked out on LivePremier
Simulator 6.2.73 and checked against the RS4's store (11:32 dump):

- **A6 "My Screen" is the place for it.** Its program and preview are
  identical, whole buffer, and so is their bookkeeping (memory 0, modified).
  A1–A4 are identical too, both on memory 1 unmodified, but they are the back
  walls. S1/S2 match in content but not in bookkeeping, S3 and A5 differ.
- **6.1.60 calls preset toggle off `copyMode: true`**, on every destination,
  and `xTake` reads false at rest. Two takes on a destination whose preview
  equals program, `copyMode` on, then `xTake` written back to false: **0
  leaves differ** across the group, both buffers and the preset ids (simulator
  S2, 1005 ms and 999 ms). Every take-based test (Timeline GO, OSC, Layer Lock,
  Preview lock) belongs on A6 for that reason.
- **A save leaves one trace a delete does not undo.** Saving a preview into an
  empty slot sets its preset id to the slot and `isNotModified` true; deleting
  the slot puts the id back to 0 and clears its label, but `isNotModified`
  stays true. Nudging one layer property and putting it back clears it, as
  `guardScreen` does. On A6, already "modified", save → label → recall the copy
  → delete → nudge leaves nothing.
- **The direct save route is the one that can't be undone.** The RS4's
  `presetBank/import/extract/status` reads `NO_REQUEST`; a path its disk cannot
  read would leave it on an error word, and status words are not writable.
  Leave it until there is a share the box can see.

## Arithmetic in 6.1.x number fields (2026-10-16)

The RS4 above left the plugin doing nothing: `isNumericField` wanted
`type=text`, and 6.1.60's geometry fields are `type=number` with `step`,
`min` and `max`. A number input reports `""` for `1080-80`, so there is
nothing to read after the fact — the field has to be text while it is typed
into. `math-fields.js`'s header had argued against exactly that swap, because
it seemed to mean reimplementing native stepping. The 6.2.73 bundle settles
it:

- **The fields are aw-ui's `AwNumberInput`, and the vendor swaps it itself.**
  It renders `type: arithmeticModeEnabled ? 'text' : 'number'`; in 6.2.73
  only `AwSliderInput` (the geometry fields) turns that mode on, which is why
  they are text there. 6.1.60 drawing them as number inputs says its slider
  input did not.
- **Its stepping is script.** ArrowUp/Down with `preventDefault`, the wheel
  while focused, its own spinner; native stepping is never used. Text loses
  none of it.
- **It keeps the typed string in state** (`handleInputChange` stores
  `data.value`), commits on blur (Enter is `event.target.blur()`), and its
  blur parses with `tryParseNumber` — `+value`, with `""` mapped to NaN — and
  puts its old value back on NaN or on no change. So what it commits for an
  empty value, the question the RS4 entry left open, is nothing.

So a bounded number input (`step` + `min` + `max`, not a `wru-input` of ours)
is made `type=text` on `focusin` and put back on `focusout`. Enter in such a
field goes no further unless the field holds a number or an expression that
evaluated — it keeps its text and flashes amber — and on blur anything else is
emptied first, which is what the number input would have reported. Typed text
reaches React whole: held back, the component's state would be stale and
React's controlled update would write it over the typing.

Not a separate switch: on 6.1.60 the number fields are all the plugin touches,
so its own switch is the way out. On 6.2.73 the swap also reaches the
number-typed bounded `AwNumberInput`s — the bank-slot pickers, colour params,
ST2110 network numbers, backup thresholds — the same component with the same
script stepping. The canvas zoom box has no bounds and is left alone.

Proven in a real Chromium on the 6.2.73 simulator, on the Save Master Memory
popup's Memory box (`type=number`, step 1, 1..500 — the RS4's shape, and a
commit there only picks the slot the popup would save to; SAVE was never
pressed): a click left it focused, text and selected; `2*3` held through
store repaints and Enter gave "Save to MM6" with the box back to `number`;
`6-` and Enter stayed focused with "Not applied: unexpected end" and nothing
committed, and Tab then left it at 6; ArrowUp while text stepped to 7;
`400+200` clamped to 500. `test/math-fields.test.js` models the component
with the RS4's attributes. **Not run on 6.1.x** — 6.1.60's own copy of the
component is unread, and nothing was typed into the RS4. If arrows stop
stepping there with the plugin on, it steps natively after all.

## Saves of one file at once (2026-10-16)

Every save — cue stacks, settings, groups, names, the patch, the routers and
each plugin's per-switcher document — wrote `<file>.<pid>.tmp` and renamed it
into place. Two saves of one file in this process shared that name: the first
rename took it, the second failed with ENOENT, and the file kept whichever
document happened to be in it. Found retaking the README screenshots: three
`__WRU.rename` calls in a row lost one PUT every run (`layer-names: PUT /:
ENOENT … rename`). An operator renaming quickly, or a cue edit and a group
edit landing together, would do the same.

`writeJsonAtomic` now queues writes per file, gives each its own temporary
name, and removes it if the write fails; every `StackStore` save and the
plugin host's documents go through it. The queue is joined the moment a save
is called, so nothing may be awaited before it — a `mkdir` in front let later
saves overtake earlier ones (caught by its own test), which is why
`createDir` is an option rather than a step. `test/storage.test.js` saves
each kind five times at once and expects the last; through the demo, three
renames in a row now all land.

## The 6.1.60 simulator (2026-10-16)

Analog Way's LivePremier Simulator installs older firmware from its package
manager (the version button on a session). 6.1.60 went in beside 6.2.73 as a
new session, Aquilon C+ (`NLC_CPLUS`, `DEVICE_TYPE=6`; the combo's RS4 entry
could not be reached from a background click, and the numbering is not the
list order, so it was not hand-edited). Its web client is
`app.80837794a672b9e2107f.js` — the bundle the RS4 at 192.168.2.140 served
that morning, so the vendor page is the hardware's, byte for byte.

- **`AwNumberInput` on 6.1.60, read from that bundle:** `type: "number"` hard
  coded, no `arithmeticModeEnabled` anywhere (6.2.73 has nine); ArrowUp/Down
  and the wheel `preventDefault` and step `state.value` in script; Enter blurs;
  blur runs `checkValue(tryParseNumber(state.value))` and `resetValue()` on
  NaN. Exactly what 55e02e2 assumed from 6.2.73.
- **Typed into it, real keystrokes, the Save Master Memory slot box**
  (`type=number`, 1..500; SAVE never pressed): focus made it `text`; `2*3` +
  Enter committed 6 ("Save to MM6") and it went back to `number`; ArrowUp
  while text stepped to 7 and Tab committed it; `6-` + Enter was held (still
  text, still focused, MM7) and Tab put 7 back; `400+200` clamped to 500. Left
  on 1. A fresh session has no screens in service, so no geometry field was
  tried — the slot box is the same component.
- **The VPU shape is 6.1.60's, not the RS4's alone:** `pipeList` 64 and
  `vpuLayerList` 32, all `OFF`, no `vpuMixerList`. The panel took the
  simulator branch — "No VPU on this simulator … 32 scalers in a
  vpuLayerList, every one switched off, and no vpuMixerList", captioned
  `AQUILON · NLC_CPLUS · 6.1.60 · simulator` — the wording ae6aa87 could only
  test offline, because the 6.2.73 simulator reports a fitted C MAX.

## The VPU Map on 6.1.60: what the RS4 does say (2026-10-16)

Allan: "no VPU" on the live Aquilon. Two things. His installed app is 0.17.2,
which predates ae6aa87, so it still told the RS4 the simulator sentence ("the
simulator simply has no VPU"). And ae6aa87's sentence, though no longer wrong,
left the panel empty on a box with three screens on air. Read-only throughout:
AWJ `get` through the field kit's `AwjClient` and one `GET /api/stores/device`.

- **The mixer map is absent on the wire too, not only in the page's store.**
  AWJ at 17:54: `$vpuMixer` answers E12; all 32 `PROC_<1-4>_SCALER_<1-8>` on
  both sides read `isAvailable`/`isEnabled` false, `capability` OFF,
  `usedInScreen` S1, `usedInLayer` NATIVE, every `usedOnOutPipe` NONE — the
  enums' first values, never set; all 64 pipes `isUsed` false. The 6.1.60
  bundle mentions `vpuLayerList` and `pipeList` only in its generated
  reducers: no component of the vendor's own page reads them.
- **What 6.1.x does report is per screen.** `preconfig/resources/<side>/
  screenList/items/S<n>/layerList/items/<k>/status/pp/capability` (`4K`,
  `DUAL`, `OFF`) and, staged only, `layerCapabilityList/items/<capa>/status/
  pp/{remainingLayerCapabilities,remainingLayerWithMaskCapabilities}`. Every
  screen in service reported the same room — 15 DUAL · 7 4K · 3 5K on S1-S3
  at 11:33, 19 · 9 · 4 on S1 and S3 at 17:59 — so it is the box's pool seen
  from each screen, not a share held for it. A capability called `3` is
  listed and always 0: a capacity-3 layer (the model's LAYER_CAPABILITIES —
  the position is the capacity), which 6.1.60 does not offer
  (`layerCapabilityValidity` is DUAL, 4K, 5K). Dropped, as any 0 is.
- **The box changed between reads:** at 17:59 S2 was DISABLED and S1 spent
  two output capabilities rather than one. The fixture keeps the 11:32 read
  it was cut from, now with each side's `screenList` (statuses for all 24
  screens, layers only where switched on, the staged room).
- **Change:** `readScreenLayers` in `core/vpu.js`; the panel shows the Screens
  table under its explanation whenever there is no mixer map and a screen is
  in service, with **Sizes** ("4K ×2") and, staged, **Room for**. Each column
  only where some screen has the figure, so the trimmed Aquilon C capture
  draws as before. Rendered against the 17:59 live store (S1 4K ×2, S3 DUAL,
  room 19 DUAL · 9 4K · 4 5K) and in the panel bench with the RS4's own
  stylesheet. Released in 0.17.3 the same evening.
- **Room is said once** (released in 0.17.4; 0.17.3 had shipped): a Room for
  column repeating the same figure on every row invited adding it up.
  `sharedRoom` returns the room every screen in service agrees on, and the
  panel puts it under the table as the box's, mask figures included. The
  pooling is observed, not documented, so screens that disagree keep a
  per-screen column. `room` is now `null` where a screen reports none, so a
  trimmed capture or the running side never reads as a full box.

## Surfaces on the 6.2.73 simulator (2026-10-16)

The local LivePremier Simulator 6.2.73 (session 1, Aquilon Cmax, `npm run demo` on :8545),
S1 with two surfaces — *LED left* 0,0 960×1080 and *LED right* 960,0 960×1080 — and layers 1
and 2 bound to them. Preview was B throughout. Put back as found afterwards (both layers full
screen on A and B).

- **The vendor's full screen, on a layer already full screen, sends no geometry** — only the
  `xUpdate` pulses. Its store diff sends only what changed. Shrunk first (by our own writes, which
  the shaper took as one run and added the position to), then full screen: `posH 480, sizeH 960,
  sizeV 1080` went out, LED left exactly. It is two runs (centre, then resize), and the click was
  read as intent on the first.
- **Align to screen middle**: the vendor asked for 960,540; 480,540 went out.
- **A drag past the edge**: posH held at 760 (right edge of LED left) step after step.
- **The vendor's card lied until `tellPage`.** With the vendor's Redux store subscribed
  (found through the root fiber's `memoizedProps.store`, read only): the outbound frames left at
  t, the vendor's store took its own optimistic value at t+4 ms, and on a step where posH did not
  change on the switcher no echo ever came — so the card drew the layer at the pointer (centre
  1794) with the switcher at 760. An echo told inside the flush landed before the vendor's own
  update and was overwritten. Told at +60 ms, the store went back to 760 and the card agreed.
  Re-tells check the mirror first, so a newer value is never talked over.
- **The vendor's `AwPresetLayers` ignores new props while `isChanging`** (its
  `getDerivedStateFromProps`), so mid-drag the box always follows the pointer; it re-reads the
  store when the drag ends.
- **Follower**: an AWJ `replace` of B L1 posH 1500 (the server's one-shot route, so not through the
  page) arrived inbound and was written back to 760 40 ms later. An AWJ sizeH 1600 on program A was
  left alone and flagged; the page sent nothing to A.
- **Edit page**: L1 dragged past the stage's left edge stopped at 0% while the pointer went on;
  nothing reached the switcher. L2, full screen and stacked on top, was what the first press
  caught — dragged, it was pulled into LED right and fitted keeping its shape (960×540).
- **Found while testing**: the Surfaces tab drew its warnings but none of its sections, because
  each section carried `data-lpp-surfaces` — the outlines' own mark — and every sweep removed them
  as stray outlines. Sections renamed, and sweeps now require `data-lpp-overlay` as well.


## The UMD Generator, and whether an aux can have a picture for a background (2026-10-16)

Built `plugins/umd/` against the local 6.2.73 simulator (Session 1, Cmax), with output 5 made aux
A1 for the afternoon (8K advanced, 8 layers) and put back after; a full store diff against a
snapshot from before showed only status words the switcher owns (deleted library slots keep their
old `fileName`/size, the disabled A1 reports size 0 and `isAuxAdvanced` false, outputs 14/15 report
`dpBoxMode` NONE after the resources re-apply) and the triggers, which I re-armed.

**Aux layers come in pairs with the capability.** Staging output 5 as an aux and reading
`preconfig/resources/new/outputList/items/5/status` after `xCheck`: advanced 4K → 2 DUAL layers,
5K → 4, `6` → 6, 8K → 8; not advanced → 1 layer of the whole capability. NATIVE's `auxCapability`
was OFF in all eight. Hence templates of 1, 3, 5 and 7 boxes with the top layer for the UMD.

**Can an aux's background show a still?** Allan asked whether the "background sets for screens
only" rule is the hardware or the UI. What I can say from a simulator:

- The **UI** closes it: `allowedAuxBackgroundLayerSourceTypes = [NONE]` in the 6.2.73 bundle, the
  inspector shows NONE with Source Setup greyed, and Preconfig ▸ Backgrounds has screens only
  (`preconfig/backgrounds` has `screenList`, `outputList`, `inputList`, `stillList`, no aux list).
- The **preconfig** never gives an aux's NATIVE any capacity (above), where a screen's NATIVE gets a
  mixer.
- The **control software does not refuse it.** Over AWJ, `auxiliaryList/items/A1/presetList/items/
  B/layerList/items/NATIVE/source/pp/inputNum` took `STILL_48`, `NATIVE_1`, `LIVE_1` and `COLOR`,
  and `…/source/status/pp/inputNum` reported each one. Still 48 read `isOnPreview: true`, as it does
  on a real layer. The vendor's own card then drew it as A1's BKG and the inspector showed the
  still's thumbnail. For contrast, a screen's NATIVE given `STILL_48` or `LIVE_1` kept reporting
  NONE (only `NATIVE_1` was reported), so screens *are* enforced below the UI.
- Whether the **output card renders** a still on a plane with nothing allocated is the bit a
  simulator can't answer. My guess is that it doesn't (the aux background on the vendor's page is a
  colour at most, and there's no capacity behind it), but a guess isn't worth a show.

The test on a frame, when one is free and someone can see an aux's output: with an aux in service
and a loaded still `N`, write its **preview** NATIVE source and take it.

```
{"op":"replace","path":"DeviceObject/$auxiliary/@items/A1/$preset/@items/<preview letter>/$layer/@items/NATIVE/source/@props/inputNum","value":"STILL_<N>"}
```

(Spell the path with `toAwj` from `src/core/paths.js` rather than trusting my hand.) Then read
`…/source/status/@props/inputNum` and look at the output. Put it back to `NONE` after. If a frame
shows it, the UMD Generator can offer the aux's background as a target and give the aux its top
layer back; the label rule for screens (labels under the boxes) would apply there too.

**Run on the RS4, 2026-10-17, and still no answer to the one question.** Allan allowed the test on
the live Aquilon RS4 (6.1.60) after its show, on auxes only. On A6 "My Screen" (output 15, a 4K aux,
one layer, `copyMode` true), with still 1 (the show's slate graphic, already loaded):

- **The frame takes it, as the simulator did.** Preview NATIVE = `STILL_1` over AWJ, and
  `source/status` reported `STILL_1`. With L1 cleared and A6 taken, program reported `STILL_1` on
  NATIVE and nothing on L1. So the control software on 6.1.60 hardware does not refuse an aux a
  background still either. In copy mode the take also copied NATIVE into the new preview; the
  6.1.60 simulator, given the same take, did not.
- **Nobody saw the output.** `/api/device/snapshots/outputs/<n>` answers a 128×128 placeholder on
  the RS4, not a picture, and no multiviewer widget showed A6, so it can't be read remotely; the
  person who could look didn't get to before the box was factory reset. Whether a frame *draws* a
  still on an aux background is as unknown as it was.
- ⚠️ **A take moves program to the other letter.** Taken from AT_DOWN, A6 landed AT_UP with B as
  program, and my first restore, which assumed A was still program, wrote program directly and
  then took the still back on. Read the letters before every write (`resolve` in
  `src/vendor/surface/preset.js` is the rule) and restore by writing both buffers back to a
  recorded "before", with no take. That version, rehearsed on a private copy of the 6.1.60
  simulator session (an aux staged like A6, `copyMode` on, test, an extra take, restore), left no
  leaf of the aux, its preset ids or still 1 different. It's `aux-bg.mjs` in Allan's field kit.

**What the switcher does when you force one, on the 6.1.60 simulator (same session copy, an aux
staged like A6, a 1920×1080 card in library slot 1 loaded into still 1):** a whole-store diff
around the write and around the take, leaving out what ticks on its own, shows only the layer and
the source's own tally. Preview NATIVE = `STILL_1` changed three leaves: the NATIVE source, its
status, and still 1's `isOnPreview`; the take moved that to `isOnProgram` and flipped the
transition. `LIVE_2` did the same to `IN_2`'s `isOnPreview`/`isOnProgram`, so an input used as an
aux background tallies as on air. No capacity, preconfig, output or error word moved, and
`LIVE_1`, `COLOR`, `NATIVE_1` and an empty `STILL_2` were all taken and reported too. The engine's
error log (`AW_TRACES/AW_APP_SIMULATOR_0`) gains eight `GetVarSigned() Index error` lines per take
(`xSCREEN_STATUS_SCREENGROUP` got 24, out of 0–23: the aux looked up as a screen), but a control
take with no background logs the same eight, so that is the simulator's aux take, not the
background. The 6.1.60 vendor card draws no BKG for the aux (6.2.73's drew one); with L1 full
screen there was nothing of it to see anyway.

Next frame: an aux someone can see, or one shown on a multiviewer whose snapshot is a picture.

**Built behind a switch the same night (Allan: not in the main program until a frame shows it).**
An **Experimental features** plugin, off by default, gates two things: **Aux backgrounds**, a
column added to the vendor's Preconfig ▸ Backgrounds with a still or input picker and To PRW /
To PGM per aux, and a **UMD on** choice in the UMD tab for an aux (top layer, or background,
where every layer is a box and the even templates appear). Both driven on the 6.1.60
simulator copy through the app: To PRW put still 1 on A1's preview background, the UMD went to
library slot 200 and still 48 and onto A1's preview background, each confirmed over AWJ.
Neither is in the README or the guide. The first frame they meet should have someone watching
the aux's output.

**Two things I tripped over.** The layer path builders take the catalogue spec's `path` array, not
its id; `dialect.layerParams` are ids, so `layerParamPath(id, buf, key, 'position.posH')` builds
a path of single characters and every write goes nowhere quietly. And `wire.js` compared echoes
with `Object.is`, so a write of an array (`effects.flags: []`) could never be heard; it compares
lists by value now.

## Stray TAKEs on the simulator came from `npm test`, not the demo (2026-10-17)

While the docs screenshots were being taken against the 6.2.73 simulator on 10-16 (`npm run
demo` on :8545, headless pages), the engine trace (`AW_TRACES/AW_APP_SIMULATOR_0/*.log.001`)
logged eight `xSCREENAUXGROUP_TAKE;S1;EXTERN;true` nobody had sent: a plain `xTake` (the vendor's
TAKE button logs `TAKE_UP`/`TAKE_DOWN`), S1 only, never after a recall. A `WebSocket.send` patch in
every page saw none of them, and lsof sampling of :3000/:10606 saw no other client.

**It was `test/osc.test.js`**, run by whichever session happened to start `npm test`. `a UDP take
reaches the switcher as an AWJ write` stood a pretend AWJ device up on a spare port and never
passed `awjPort`, so the OSC listener asked the real port, 127.0.0.1:10606. Its comment said
the port was "fixed at 10606 in `awj.js`". That stopped being true on 09-12, when `awjPort`
arrived for the platform-probe tests beside it. Its assertion accepted "it reached the device"
as well as "it failed trying". With nothing on 10606 it failed and passed. With a simulator on
this Mac, the simulator answered the platform question (LivePremier) and then took S1. That has
happened about a second after every `npm test` run while a simulator was up, from 2026-08-22
until today, and on a Midra simulator it would have taken screen 1.

The evidence: the trace's `[T]` line gives the engine's epoch, so every take has a wall-clock
time, and every session's transcript has the time its `npm test` started:

| stray take (UTC) | `npm test` started (session) |
|---|---|
| 10-16 22:20:27.3 | 22:20:26.1 (exciting-napier) |
| 22:24:44.3 | 22:24:43.5 (exciting-napier) |
| 22:36:48.9 | 22:36:47.9 (the UMD-wording session) |
| 22:39:26.0 | 22:39:24.4 (zen-napier) |
| 22:40:52.4 | 22:40:51.5 (awesome-lamport) |
| 22:41:10.6 | 22:41:09.8 (zen-napier) |
| 22:41:41.2 | 22:41:40.2 (awesome-lamport) |
| 22:42:16.9 | 22:42:16.1 (awesome-lamport) |
| 10-17 01:53:56.2 | 01:53:55.5 (stoic-jackson) |
| 10-17 02:02:32.5 | 02:02:30.0 (gracious-heyrovsky) |

Then the suite was run with a preload that refused, and logged with a stack, any connection to a
switcher's ports. Exactly one connection in the whole suite: `osc.test.js` → `osc.js`
`platformFor` → `awj.exchange` → 127.0.0.1:10606. The demo, the pages and every plugin are clear.
The page patch saw nothing because there was nothing in a page to see, and lsof missed a socket
that lives for a few milliseconds.

**Fixed, and made impossible to repeat quietly:**

- `osc.test.js` passes `awjPort: device.port`, and the take test now asserts that the pretend
  device received exactly `DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake = true`.
  The button-release test is pointed at a pretend device too, and asserts nothing reached it.
- `test/helpers/offline.js` is preloaded into every file `npm test` runs (`node --import
  ./test/helpers/offline.js --test …`). A TCP connection to a port that real kit this app drives
  listens on is refused before it is made, on any host (AWJ 10606, Web RCS 80/3000, HyperDeck 9993,
  Companion 8000, UCenter 8088/19999, Videohub 9990, Lightware 6107/10001), and the file fails
  with the stack that dialled. It denies ports, not non-loopback hosts, because
  `local-client.test.js` dials this Mac's own LAN address on purpose. The old `osc.test.js` under
  it passes all 33 of its assertions and fails the file. `test/offline.test.js` holds the guard
  to that: it is in the script, it refuses `exchange` at 10606 on loopback and elsewhere, it leaves
  a pretend device on port 0 alone, and it fails a file that dials.

The live suites (`test/sim/`, `test/console/`) reach a simulator on purpose and don't load it.

**Trap, for anyone chasing a "phantom" TAKE:** a `WebSocket.prototype.send` patch installed after
the page loads is blind to this app's own sends, because `ws-hook.js` keeps the native `send` it
found at boot and `hook.send` calls that. One installed with `context.addInitScript` runs first
and does see them. Either way, check the session transcripts for an `npm test` before suspecting
the app.

## Preview lock and the vendor's own TAKE button (2026-10-17)

Found while taking the docs pictures on 10-16: with Preview lock on, a TAKE from Web RCS's own
button logged "PRW locked: take sent", the padlock never read shut, and a second later the plugin
blamed the operator ("opened by the operator mid-take"). A TAKE sent through `__WRU.session.send`
worked, and so did a plain `.click()` on the padlock at rest.

**Cause: Web RCS sends from inside its Redux reducer.** In the 6.2.73 bundle the root reducer is
wrapped by `awStore`, which diffs the device state and calls
`deviceStoreManager.notifyChange` → `AppManager._sendToServer` → the socket while Redux's
`isDispatching` is still true. The hook relays that frame synchronously, the guard arms, and the
plugin's `.click()` on the padlock runs the vendor's `TOGGLE_LOCK` dispatch mid-reduce. Redux
throws error #9 ("Reducers may not dispatch actions") inside the click's listener, the browser
reports it as an uncaught error, and `.click()` returns normally. The console had one per screen
per take all along. A TAKE from `session.send` never goes through the vendor's Redux, which is
why that path worked. Midra 4K 3.2.29's bundle has the same wrapper (minified: a reducer that
calls `deviceStoreManager.notifyChange`), read from the code and not re-tried there.

**Fix:** every press is a microtask (`setPadlock` in `plugins/preview-lock/client.js`). That runs
once the vendor's handler has unwound and before any further task, so before the switcher's
first echo is processed and before any input the operator could make. It presses only if the
padlock still reads the other way, and a press that never shows shut is logged as "PRW did NOT
lock", not as the operator opening it. `test/preview-lock-page.test.js` has a stand-in vendor
page whose store refuses a nested dispatch and sends the TAKE from inside its reducer; the old
client fails it exactly as the simulator did.

**Proven on the 6.2.73 simulator (Session 1, Cmax) through the demo, vendor TAKE button:**

- S1 + S2, 1 s takes: both PRW padlocks shut at 67 ms (the vendor's own re-render after the TAKE
  takes about 60 ms, and the first echo is read at 68 ms), open at 983 / 996 ms as each landed.
- S1 + S2, 6 s takes, with a catcher on `WebSocket.prototype.send` dropping any outbound memory
  load: Memories ▸ Screen ▸ Load "House open" clicked 1.5 s in. Nothing was sent, and Web RCS
  raised "The screen memory 1 could not be loaded to PRW - S1 because PRW - S1 is locked" (and
  S2) in its notifications bell. The same click at rest sent both recalls (caught, not
  delivered).
- S1 alone, 6 s take, the same load at 1.5 s: refused, with the warning; padlock 67 ms → 6.25 s.

Put back afterwards: take times 10/10 on S1 and S2, both screens `AT_DOWN` as the simulator
booted (read off its trace), and no memory reached the simulator. Not tried: remote selection
(the lock in the MST remote store), the vendor TAKE on a Midra, and anything on a frame.

Two bare `xTake`s on S1 that none of this sent landed in the trace during the run (01:53:56 and
02:02:32 UTC). Both were `test/osc.test.js` dialling the real AWJ port during somebody's `npm
test`, the second during this session's own run; see "Stray TAKEs on the simulator came from `npm
test`" (2026-10-17). They are why the screens' parity had to be read off the trace rather than
counted.

## Transitions per layer and per screen: three options (2026-10-19)

Asked for: "the possibility of adding per layer/screen transitions". Nothing is built; this is
what the switcher has and three ways to go, for a choice. Read from the code, both vendored
catalogues, and the 6.2.73 Web RCS bundle inside the simulator app
(`…/LIVEPREMIER_6_2_73/ressources/AW_APPS/webapp-bundle/dist/client/`). Nothing was run against
a simulator or a frame.

### What the switcher already has

- **Every layer in every preset has its own transition**, at
  `presetList/items/<A|B>/layerList/items/<k>/` on LivePremier and
  `presetList/items/<UP|DOWN>/liveLayerList/items/<k>/` on Midra 4K. The two catalogues agree
  on all of it but the flag names and a few enum spellings:
  - `transition/opening/pp/{type,way}` and `transition/closing/pp/{type,way}`. Type is CUT, FADE,
    SLIDE, WIPE, CIRCLE or STRETCH (the `ELEMENT_TRANSITION` enum also has `WIPE_ADVANCED`,
    which the layer property does not offer). Way is one of eleven directions, `LEFT_TO_RIGHT`
    to `NE_TO_SW`, three of them from or to the centre.
  - `transition/pp/flags`: `FORCE_TRANSITION` ("Avoid cross transition", on by default),
    `FORCE_CROSS` and `DEPTH_CUT_START/MIDDLE/END` on LivePremier; `DISABLE_CROSS_EFFECT` and
    `DISABLE_CROSS_DEPTH` on Midra. `system/userPref` `layerForceTransition` (true) and
    `layerForceCross` (false) are the defaults for new layers.
  - `timing/opening/pp/{start,end}` and `timing/closing/pp/{start,end}`, 0–65535, defaults 0 and
    65535: when in the take this layer opens and closes, as a fraction of the take.
    `timing/pp/ratio` (default 32768) is `OPENING_CLOSING_RATIO` in a memory file. What it does
    is not known.
  - `flying/pp/type` (linear, two Béziers, two deviants) and two control points: the path a layer
    takes when its position changes. `speed/pp/type` (linear or smooth), `point1`/`point2`
    0–255: the easing.
- **The vendor's Properties tab edits all of it.** Its en-US labels are `aw.LayerTransition.*`
  (Opening, Closing, Type, Way, Force, Force Cross), `aw.LayerFlyingCurve.*` and
  `aw.LayerTiming.Timeline`. Our Layer tab draws the same groups from the catalogue, raw numbers
  and all.
- **Memories carry them.** `TRANSITIONS`, `FLYING_CURVE`, `TIMING` and `SPEED` are save
  categories (`core/preset-file.js`), so a memory saved with them overwrites them on recall.
- **Only the duration belongs to the screen**: `takeUpTime`/`takeDownTime` under
  `screenAuxGroupList/items/<S|A>/control/pp/` on LivePremier, one `takeTime` under
  `transition/screenList/items/<n>/control/pp/` on Midra, tenths, 0–3000. A recall overwrites
  it with the memory's `transitionDuration` (Aquilon C, 2026-08-21). A layer's timing window is a
  fraction of it, so no layer can run longer than its screen's take.
- **No per-layer take** ("Layer Lock and partial takes", 2026-09-23). Take only fakes one.

### Option 1: a time and an effect on Take only

Layer Lock's Take only, given a time and, if wanted, an effect. To take S1 L2 alone in 2 s with a
wipe from the left:

1. write the effect to L2 in the preview buffer;
2. hold every other layer equal to program, as Take only already does;
3. write the screen's take time (`dialect.fadeTimePath`), then the take;
4. once it lands, put the other layers' preview looks back, and the screen's time.

Every other layer is the same on both sides of the take, so the screen's time only governs the
layers being taken. That makes it per layer in effect, not just in name. Two layers in one Take
only with different times: the screen gets the longest, and each shorter one gets a timing window
(`end = time / screenTime × 65535`).

Where it goes: `takeOnly()` in `plugins/layer-lock/engine.js` already snapshots, holds, takes,
waits for `landed()` and restores. The time write goes just before the trigger, after any recall
has settled, as the timeline does it (`core/cuestack.js` header). The panel gets a time field and
an effect picker on each row. A Timeline `cueAction` ("take only S1 L2, 2 s, wipe") is the
natural second step.

Small. The simulator can prove the writes, their order, and that the screen's time is put back.
Only a frame can show the effect, and that a held layer really stands still.

The cost: the screen's time is changed for the length of the take, so a take from the front panel
at that moment gets it too. Only takes from this page see the effect at all.

### Option 2: a Transitions tab per screen

A Screens / Aux. tab (behind ⋯ with the others). For one screen it shows every layer's opening
and closing effect and direction, and its timing window drawn as a bar in seconds against the
screen's take time: a small timeline, one row per layer. Plus:

- **Apply to all layers** on the screen, or to a group from Layer Groups.
- **Styles**: named sets ("Wipe L→R", "Cascade") kept in a doc (`transition-styles-<dev>.json`)
  and applied in one click.
- Writes the preview buffer by default, the letter resolved with `bankLetter()` at the moment of
  writing and refused mid-take, as the Layer tab does.

Every write is a click, so there is no gate and no follower. That is the point of the design:
anything that rewrites on every take needs the hook's gate, which Layer Lock holds and
`ws-hook.js` allows one of, or the shaper, which Surfaces has. And because the settings are in
the preset buffers before the take, **they apply to a take from anywhere**: front panel, T-bar,
OSC, Companion. Option 1 cannot say that.

The trap is the seconds. They are fractions of a take time that a recall replaces, so "1 s" on a
2 s take is 0–32767, and after a recall to a 4 s memory the same window is 2 s. The tab has to
draw against the current time and say when a recall has changed it. Keeping the seconds across
recalls would need a follower that re-applies a screen's style to preview after each recall:
opt-in, preview only, with Layer Lock's follower rules. That is a possible later half, not part
of this.

Medium: a new plugin, mostly UI; the writes reuse `writeCmd`. The simulator proves every write
and read-back. Midra goes through the dialect: the same parameters with different flag names and
layer root.

### Option 3: screen-wide moves the switcher doesn't have

Option 2's writes, worked out from where the layers sit:

- **A wipe across the whole screen.** A layer's WIPE almost certainly runs inside its own box, so
  two PIPs side by side wipe at the same moment instead of one edge crossing the screen.
  Staggering each layer's opening window by its position (`start = left / width`,
  `end = right / width`, × 65535) makes the edge travel. The same for top to bottom and from the
  centre.
- **Cascade**: the layers open one after another, by layer order or by position, each in its own
  slice of the take.
- **Dip through the background in one take**: the outgoing layers close in the first half and the
  incoming ones open in the second. Whether that works for a layer that only changes source
  depends on what `FORCE_TRANSITION` and `timing.ratio` actually do. The two-take version (a black
  look, then the target) is a Timeline cue list already.

The maths is small. Whether it looks right needs a frame, every bit of it: the simulator's output
snapshot is a static "OUT1" placeholder.

### What holds for all three

- **One take per screen at a time.** L3 cannot start while L2's take is running, so overlapping
  layer moves have to be one take with staggered windows.
- **Simulators prove the writes, not the picture.** Besides the placeholder output, the 6.2.73
  simulator's per-layer verdict (`screenList/items/<S>/layerList/items/<k>/status/pp/up|down`)
  reads `OFF` for every layer, whatever the buffers hold.
- **Hardware is ask-first**, and nothing here has met a frame.

### What only a frame can answer

1. Which copy of a layer a closing effect comes from: the outgoing (program) buffer or the
   incoming one. If it is the outgoing one, setting how a layer leaves means a write to the buffer
   on air. That write shouldn't change the picture, but it is still a write to program.
2. What `timing.ratio` does.
3. Whether a WIPE or SLIDE runs inside the layer's own box or across the screen.
4. What `FORCE_TRANSITION` and `FORCE_CROSS` do to a layer that only changes source. The Aquilon
   C reported `CROSS` for LIVE_2 against LIVE_8 at the same geometry; its flags weren't recorded.
5. Whether timing windows behave the same on the T-bar as on an auto take.

### Recommendation

Option 1 first: it's small, it builds on code already proven on the simulator, and it's the only
one that gives a single layer a transition of its own. Option 2 next if a quicker way to set
effects across a screen is wanted; it is also the only one that front-panel takes would see.
Option 3 after a frame has answered 1–4.

Allan asked for all three, in sequence, the same day. They are built, behind the Experimental
features switch: see the next entry.

## Transitions per layer and per screen: built, and run on the 6.2.73 simulator (2026-10-19)

All three options from the entry above, behind the Experimental features switch, so nothing
changes for anyone who has not switched it on, and nothing goes in the README or the guide until a
frame has shown it. AGENTS.md "Transitions per layer and across a screen" has the rules.

- **Option 1**, Layer Lock ▸ "Take only with": a time (seconds; blank is the screen's own) and an
  effect (an opening and closing type and, for a slide, wipe, circle or stretch, a way). The
  engine change is `takeOnly(targets, { tenths, effect })` in `plugins/layer-lock/engine.js`.
- **Options 2 and 3**, a new `transitions` plugin: Screens / Aux. ▸ ⋯ ▸ Transitions. One card per
  fitted layer (effect and way in and out, windows in seconds with a bar each), then "The same on
  every ticked layer", "Across the screen" (wipe across, cascade, dip through the background, whole
  take) and "Styles" (kept per switcher in `transition-styles-<dev>.json`, in the setup file).
- `src/core/transitions.js` holds what both share: reading and writing a look, the take-time
  writes, seconds against the take time, styles, and the moves.

### What was run, on the simulator app's Session 1 (6.2.73 Cmax, engine started from the shell)

`LPP_SIM=127.0.0.1:3000 node --test test/sim/transitions.sim.test.js`, six tests, all pass:

- A whole look (slide in from the bottom, circle out from the centre, both windows, a linear
  speed) written to preview and read back over AWJ; program unchanged.
- Every effect the layer offers (six) and every way (eleven) accepted.
- Two layers laid out side by side in preview, then each move's writes accepted and read back as
  planned: right to left, the right-hand layer's window is the first half of the take.
- Take only on S1 L1 at 1.5 s with the screen at 0.3 s up and 0.4 s down: the take took about
  1.5 s (the simulator does run a take for its time), and the screen read 0.3 and 0.4 s afterwards.
- Take only with a wipe from the top: the copy that went to air carries it in and out; the copy
  that was program (preview afterwards) was never written.

Then through the demo (`LPP_DEMO_PORT=8545`) in a browser, with Experimental features and
Transitions switched on: the tab and the Layer Lock card both draw in the vendor's own CSS; picking
an effect, a way and a window edge on a card each sent one write, read back over AWJ in preview (B)
with program (A) untouched; 0.4 s typed into a 1.0 s take was written as 26214; a style was saved
from L1, kept on the server, and applied to L2; "Take only with" 1.2 s and a slide from the page
took S1 L1 in 1.2 s, the screen's 1.0 s put back, the slide on the copy that moved.

**Found and fixed in the browser:** the move had been changed to "Whole take", but the click landed
on the button drawn before the change (the panel repaints about once a second), and its closure
ran a wipe. Every handler in the tab now reads the view when it runs; a test clicks a stale
button. And the icon first chosen, `rc400t-transition`, is a 160×21 drawing of the RC400T panel,
blank at icon size; the tab uses the fade icons.

Put back afterwards: S1's 54 transition values (two layers, three buffers) saved over AWJ before
the browser run and written back after it (nothing differing), S1 taken back to `AT_DOWN`, its
latched `xTake` re-armed. The live suite's own run restores through `guardScreen`.

`test/sim/locks.sim.test.js` "a source sent to a group…" fails on this simulator (3 fitted members
where it expects 1). That test was written for the rack's simulator, with one fitted layer on S1;
Session 1 has two layers on S1 and one on S2. Not touched by this work.

### Still only a frame can answer

The five questions in the entry above, unchanged. The first is the one that decides how the
closings are written: if a closing is read from the outgoing copy, the tab's PGM switch is the
way to set it, and Take only's effect only takes hold of a layer's next exit.

## Frame test plan: transitions (2026-10-19, nothing run yet)

A plan, written before any hardware was touched. It needs Allan's go-ahead for the box, the day
and every write, and nothing here is a standing permission. It answers the five questions above
and checks the three features on a real output.

### Found while planning: the seconds now follow the next take's direction

Web RCS's own Timing panel shows windows in seconds as well (`useTimingConverter`, 6.2.73 and
6.1.60 alike) and measures them against the time of the take that comes next:
`getScreenAuxGroupTakeDuration` reads `takeUpTime` at `AT_DOWN`, `EFFECT_FROM_DOWN` or
`COPY_FROM_DOWN`, and `takeDownTime` otherwise. `takeTenths` in `src/core/transitions.js` read
`takeUpTime` always, so a screen with different up and down times showed wrong seconds at
`AT_UP`. It now applies the vendor's rule. The vendor's Timing panel has no control for
`timing.ratio` at all; the speed panel calls its curve "Acceleration".

The 6.1.60 bundle (the RS4's) has the same transition model as 6.2.73: the same effects, ways,
flags, `LAYER_STATUS` verdicts, timing fields and speed fields. So the RS4 tests the same thing as
an Aquilon C.

### Which box

In order of preference. Each needs a screen with **at least three fitted layers**, a black
background, nothing on it anybody else needs, and an output that can be both watched and
recorded:

1. **The Aquilon RS4 (192.168.2.140, 6.1.60)**, if it is free now that the show is over and it was
   factory reset on 2026-10-17. Ask first: the 2026-10-16 rule (no hardware, simulators only,
   ask before any access) still stands.
2. **An Aquilon C on the bench** (.141/.142 on 2026-08-21, 6.2.73).
3. **A Midra 4K / Pulse 4K** only as a second pass, for the mng spellings
   (`DISABLE_CROSS_EFFECT`/`DISABLE_CROSS_DEPTH`, one `takeTime`, `liveLayerList`). Tests T1, T2, T4
   and T6 are enough there.

Identify the frame by IP and by `deviceList/items/1/pp/{type,label,serial}`, not by its label.

### What to have before the day

- **The runner and `measure.py`: built and rehearsed (2026-10-19)**, in
  `~/dev/aquilon-field-test/transitions/` (not a git repository; its README has the commands in
  order). `transitions.mjs` has `read`, `record`, `setup`, one subcommand per test below, `clear`,
  `take`, `restore` and `diff`; a destination guard; letters worked out before every step; every
  step's writes printed and a typed `YES` before they go; `--i-have-permission` to write at all;
  `--yes` refused unless the switcher says it is a simulator; a wall-clock log of every write and
  take. It borrows this repo's `transitions.js`, so it needs a checkout at ea18bb5 or later
  (`LPP_DIR`). Every test writes a **baseline** under its own changes, on both copies of the three
  layers (fades, whole windows, linear, the recorded flags and ratio): without it, t2's closings on
  program's copy were still there when t5 took. `measure.py` finds each region's change from the
  frames where it crosses 20 % and 80 % of the way, extended to 0 and 100 % (exact for a linear
  change; 10 and 90 % read two frames early on a full red through 4:2:0), and passes seven
  synthetic-clip tests, including a wipe inside each box failing the across-the-screen check.
- **Rehearsed on both simulators**: 6.2.73 (Session 1, a third layer fitted on S1 by the kit's
  `sim-layers.mjs`) and 6.1.60 (a copy of Session 2, ports +1000, S1 put in service with three
  layers). Every subcommand ran; every write read back over AWJ (215 writes and 31 takes on 6.2.73,
  201 and 28 on 6.1.60); `t8` against this app's own Take only engine and `t9` against its own
  cascade both checked out (a first stand-in for t8 that hung up the moment Take only returned
  lost its put-back writes: the screen kept 2.0 s and preview L2 stayed as held. The page stays
  connected, but a page closed in that instant would do the same); `restore` and `diff` found
  nothing different. A whole-store diff of
  6.2.73 afterwards showed only status the switcher owns. Not seen, because a simulator cannot show
  it: the picture, a verdict other than `OFF`, the T-bar's position between its ends, take timing
  to the frame (its 4 s takes landed at 3.85–4.2 s by AWJ polling).
- **The app from main**, not the installed one: the installed app predates all of this. Run
  `node server/index.js` from a clean checkout of main on a free port (not :8535/:8536, where the
  tray app lives), point it at the frame, and switch Experimental features and Transitions on.

### The setup on the day

- **Allan runs every writing command himself**, in his own terminal. The auto-mode classifier
  refused device writes from a session on 2026-10-16 even after "carry on", and the runner's `YES`
  prompts need a terminal. The session prepares the commands and reads the results.
- **AWJ budget**: five clients. Close the VPU map, mynah and anything else holding one.
- **Recording**: the test screen's output into a capture device on the Mac (a UVC dongle or a
  Blackmagic card), recorded at the output's own rate, e.g.
  `ffmpeg -f avfoundation -framerate 50 -video_size 1920x1080 -i "<device>" -c:v libx264 -crf 16 tNN.mkv`.
  Start it before each take and stop it after. Without a capture device, a phone's slow motion
  pointed at a monitor still answers the yes/no questions (T2, T3, T4, T6), but not the timed
  ones (T1, T5, T7, T8).
- **The test screen**: take time **4.0 s** both ways (200 frames at 50 Hz), every layer's speed
  **linear** for the measured tests (smooth easing hides where a window starts), every source a
  plain colour (`COLOR` and red/green/blue): no uploads. T5 and T6 also need one live input or still
  with a picture (`--other`), and T8 is better with a moving live input (`--live`).
  - L1: the left half, red. L2: the right half, green. Both 960×960 on a 1920×1080 canvas, above
    the strip, so nothing overlaps and the stacking order does not matter.
  - L3: a full-width strip, 1920×120 along the bottom, white, FADE, window the whole take. It is
    the **reference**: where it starts and ends in the recording is where the take starts and
    ends, so nothing depends on clocks.
- **`record` first**, before anything is written. **`restore` and `diff` last**, whatever happened
  in between. If the number of takes is odd, take once more before `restore` so the same letter is
  program as at the start, then diff every leaf against the record.

### The tests

Each says what to write, what to do, and what to watch. "PGM copy" and "PRW copy" mean the
buffer that is program or preview at the moment of writing.

**T1. Windows open when their numbers say (every feature rests on this).** PGM: L1, L2 and L3
NONE. PRW: the layout above, FADE in. Windows: L1 0–25 %, L2 50–100 %, L3 0–100 %. Take.
*Watch*: L1 fades in over the first second, L2 stays black until 2 s and fades in by 4 s, the
strip fades over all 4 s. *Pass*: each start and end within 2 frames of 0, 1, 2 and 4 s
measured from the strip. If windows are ignored, the tab's timings and every move are moot.

**T2. Which copy a closing is read from (question 1).** Start from T1's end: L1 and L2 on
program, NONE in preview. Write the **PGM copy** of L1's closing as WIPE left to right, window
0–50 %, and the **PRW copy** of L1's closing as SLIDE bottom to top, window 50–100 %. Mirror it on
L2 (PGM copy SLIDE, PRW copy WIPE) so neither answer depends on the layer. *Watch first, before
the take*: does writing the PGM copy change anything on the output at all? It should not. Then
take. *Watch*: L1 wipes away in the first half → the closing is read from the **outgoing** copy;
it slides away in the second half → from the **incoming** copy. L2 should say the same. *What it
decides*: outgoing means Take only's effect only governs a layer's next exit and the tab's PGM
switch is how a closing gets set; incoming means the tab's default (PRW) is right for both.

**T3. Which copy an opening is read from.** The symmetric case, to be sure: PGM copy of L1 NONE
with opening SLIDE, PRW copy of L1 red with opening WIPE left to right. Take. Expected: a wipe
(the incoming copy). Anything else turns the whole design round, so it is worth the take.

**T4. Does a wipe run inside its own box (question 3), and the wipe across the screen (option
3).** From NONE: L1 and L2 side by side, both opening WIPE left to right, both windows the whole
take, linear. Take. *Watch*: two edges moving at once, each across its own half → inside the
box; one edge crossing the whole screen → across it (and the move is not needed). Then from the
Transitions tab, "Wipe across the screen", left to right, and take again from NONE. *Pass*: one
edge travels from x = 0 to x = 1920 over the 4 s without a jump or a pause at x = 960 (the
measured edge position against time is one straight line). Also once each, on L1 alone: SLIDE
and STRETCH with a way, and CIRCLE with `HV_FROM_TO_CENTER`, to see which of them honour a way
(the code offers a way for all but CUT and FADE, which is a guess).

**T5. What `timing.ratio` does (question 2).** L1 red on program, L1 showing a different source
in preview (a live input, or a still; not another colour, see T6), same geometry, FADE, both
windows the whole take, flags as the box has them (`FORCE_TRANSITION`, the default). Take five
times, with the PRW copy's ratio at 0, 16384, 32768, 49151 and 65535, putting the sources back
between takes. *Watch*: when the old picture is gone and when the new one starts. The guess:
ratio is where, in a layer that closes and reopens, the closing ends and the opening begins.
*Pass*: whatever it is, written down; it decides whether the dip move should set it.

**T6. The force flags on a layer that only changes source (question 4).** As T5, ratio at its
default, with the PRW copy's flags set in turn to `[]`, `["FORCE_TRANSITION"]`,
`["FORCE_CROSS"]` and both. Before each take, read the verdict
`screenList/items/<S>/layerList/items/1/status/pp/up|down` (read only, and it is the first time a
frame's verdict gets compared with the picture). *Watch*: a cross-dissolve, or out to black and
back in. While it is set up, once more with the *same* source (COLOR) and only the colour
changed: does a colour change transition at all?

**T7. Windows on a T-bar (question 5).** T1's setup again (L1 0–25 %, L2 50–100 %), taken with
the T-bar (Web RCS's own, or an RC400T's), moved slowly and stopped at about 25 %, 50 % and
100 %, with `status/pp/tbarPosition` logged. *Pass*: at 25 % L1 is fully in and L2 has not
started; L2 only moves past half way. Once more with SMOOTH speeds, to see whether easing follows
the bar.

**T8. Take only with a time and an effect (option 1).** Program: L1 red, L2 a **live input with
movement** if there is one, else green. Preview: L1 blue, L2 something else. From the Layer Lock
page, "Take only with" 2.0 s and SLIDE left to right, then Take only on L1, with the screen at
4.0 s. *Watch*: L1 slides from red to blue over 2.0 s (measured: 100 frames ± 2); L2 does not
move, flicker or re-cut at any point. That last part is Layer Lock's own open question too: no
frame has yet been seen holding a layer with a live source still through a take. *Read
afterwards*: both take times back at 4.0 s, preview L2 back to its look.

**T9. The Transitions tab end to end (options 2 and 3).** From the tab, PRW, all three layers
ticked, with T1's layout: "Cascade", bottom layer first, overlap 0, then take; "Dip through the
background" at 50 %, then take from a different look; then "Whole take" and check the windows
read 0.00 to 4.00 s on the cards. *Watch*: the cascade opens L1, L2, L3 one after another in
thirds of the take; the dip goes fully black (the background) at 2 s.

### Afterwards

- `restore`, then `diff`: nothing may differ from the record. Re-arm `xTake`.
- Write down in this file what each test showed, frame numbers included, and keep the
  recordings beside the runner's log.
- Whatever T2 and T3 say, change the code to match before anything else, and say it in AGENTS.md.
- Only when T1, T4 and T8 pass on a frame: take Transitions and "Take only with" out from behind
  Experimental features, into `OFF_UNTIL_TESTED` (off by default, but listed), then the README and
  the guide.


## AoI from a custom format, and Aux follow (2026-10-20, simulator only)

Allan asked for two things: an option on Preconfig ▸ Canvas to give an output an AoI based on a
custom format (an LED wall defined as a custom format, sent down SDI as a standard format with an
AoI), and a setting for an aux to follow a given layer's source. Both built, both off by default,
both proven on a **private copy** of the 6.2.73 simulator session (HTTP 5000, AWJ 12606, in a
scratchpad) through the demo proxy, so the shared simulator and every frame stayed untouched.

**The vendor already has per-output AoI**, which is most of the answer to "is it possible". Canvas
is the vendor's `pixelspaces` page; a selected output gets an AOI panel with Mode (Fit Output
Format / Custom) and, in Custom, H/V size and position in pixels. What it lacks is *from a custom
format*: the sizes are typed by hand. The model (AGENTS.md "AoI from a custom format" has it all)
is per slice, in thousandths of a percent, applied with an `xUpdate` pulse. Written over AWJ first:
1728×576 in a 1080p raster at 0,0 and centred (96, 252) both reported exactly, and the output's
`clampedWidth`/`pitchedWidth` became 1728×576, so the canvas is laid out in the wall's pixels.
An overrun (8000 + 92001) came back clamped to 153 + 1766 with no error, which is why the plugin
refuses rather than sends.

Through the page: the section sits under the vendor's AoI fields. The sim's own custom format 1
(`LEDwall`, 3000×1000, 49.998 Hz) was refused on output 3 at 1080p with the sentence; with output 3
made 3840×1080 (`format/control` mode INTERNAL, `COMPUTER_3840_1080`, xUpdate), **Set AoI**
centred reported 3000×1000 at 420, 40, the vendor's own fields went to Custom 3000 / 1000 / 420 /
40, and the canvas card read 3000x1000.

**Aux follow** needed an aux: output 5 staged as A1 (`preconfig/resources/new/outputList/items/5/
control/pp` mode AUX, `useInScreenAux` A1, `auxCapability` 4K, `auxAdvanced` true; xCheck, xApply)
gave two DUAL layers. A1 L1 set to follow S1 L1 from the tab, then S1 driven from *outside* the
page over AWJ (the page's follower did the work):

| step | S1 | A1 |
|---|---|---|
| preview edit, `program` mode | B ← LIVE_2 (preview) | untouched |
| take S1 | AT_UP, program B = LIVE_2 | program **A** ← LIVE_2 (A1 was AT_DOWN) |
| direct program edit | B ← LIVE_4 | A ← LIVE_4 |
| switched to `both` | preview A = LIVE_6 | preview B ← LIVE_6 |
| preview edit | A ← LIVE_7 | B ← LIVE_7 |
| take A1 alone | — | AT_UP; not fought |
| take S1 (both now agree) | AT_DOWN | nothing written |
| take S1 alone | AT_UP | put back: B ← LIVE_4, A ← LIVE_7 |

Then A1 L2 → S1 L1 in `program`: the button read **Follow**, then **Confirm — cuts to IN4** (red),
and the second click wrote A1 L2's program only.

**Found while building:** the follower tells a take landing from noise by the take state it saw
last, and the session applies a frame to the mirror before dispatching it — so indexing lazily on
the first frame after the list changed read the landed state and missed the landing. Two unit
tests failed on it; `prime()` on list change and store `ready` fixed it. Also: in the Browser pane
a panel's repaint can lag while the pane is in the background (AGENTS.md's `requestAnimationFrame`
note) — the confirm button looked stuck until `__WRU.shell.refresh()`.

**Frame-only questions:**
- AoI: does a real SDI output carry the AoI with the rest black, and does an LED processor fed
  12G-SDI at 3840×2160 see the wall's pixels 1:1 at the corner? Whether the AoI survives an output
  format change (the vendor resets nothing that I saw, but the sim's outputs are HDMI only).
- AoI on 6.1.60 (the RS4's page): same bundle model, not driven.
- Aux follow: the cut lands at the end of the screen's take, as `status/transition` reaches
  `AT_*`. On a frame that is take time + the echo (~60 ms on the Aquilon C); whether that reads as
  late on an IMAG aux is a judgement for someone watching.
- Both: nothing has been run with a real operator on the vendor's own buttons at the same time.

**Not done:** README section screenshots, the user guide and its PDF, a release. README's feature
list, Safety and Platforms rows, PLUGINS.md and AGENTS.md are current.

## Resolume Mapping (2026-10-20, simulator, then Resolume Arena 7.28.1)

Allan asked for a tab in the Preconfig menu, after Canvas, that generates a Resolume Advanced
Output XML for selected screens, and optionally maps the input plugs they'll use to a background
set. Built as `plugins/resolume-map/`, off by default.

**Most of it already existed** in the Background Slicer's live-input mode, which exports an Arena
preset and fills a set from inputs, but behind a picture and a placement. So the output model
(topology, slices, rotation, pitch, groups, set writes, live inputs, EDID choice) moved out of
`plugins/bg-slicer/core.js` into `src/core/backgrounds.js`, unchanged, with the Slicer re-exporting
every name. Its 123 tests passed before and after the move.

**Run** through this worktree's app on :8563 against a private copy of the 6.2.73 simulator's
Session 1 (Cmax, web 3063, AWJ 10663, under `~/dev/sim-copies`, deleted after), never the shared
one:

- The Preconfig flyout read System, Multiviewers, Outputs, Screens, Aux. Screens, Canvas,
  **Resolume Mapping**, Inputs, Images, …
- S1 and S2 (both 1920 × 1080) side by side: composition 3840 × 1080; S1's Out 1 and Out 3 both
  read 0,0 · 1920 × 1080 (the sim has them overlapping), S2's Out 2 reads 1920,0. Stacked:
  1920 × 2160, S2 at 0,1080. Suggest inputs gave IN 1, 2, 3, all receiving 1080p60.
- The Download button's file (the anchor's click intercepted, so nothing was saved): 8,132 bytes,
  `LivePremier S1 S2.xml`, parsed by the browser's DOMParser, three `<Screen>`s named
  `IN 1 → S1 Out 1`, `IN 2 → S1 Out 3`, `IN 3 → S2 Out 2`, texture size 3840 × 1080.
- Write, set name "Resolume", EDIDs on: three EDIDs loaded, then over AWJ S1 set 1 Out 1 = LIVE_1,
  Out 3 = LIVE_2, S2 set 1 Out 2 = LIVE_3, both labels "Resolume", IN_1/2/3 `useOnOutput` 1/3/2.
  Undo: all six back to NONE / "" / NONE; the EDID notes named the three plugs.
- Found on the way: a tall (stacked) composition's diagram was squashed by its height cap; it is
  narrowed now. The Browser pane, hidden, kept serving stale screenshots — read the DOM instead.

**Open:** a frame; 6.1.60; README screenshots, the user guide and its PDF. (Opening a preset in
Arena, the gap this left, is below.)

### Opened in Resolume Arena 7.28.1 (2026-10-20, later)

Arena 7.28.1 rev 26535 on this Mac, which had not been running. The presets came from
`buildPlan` + `arenaPreset` on the test's synthetic store (S1 3840 × 1080 on a 2X1 group, two
connectors; S2 1080 × 1920 on an output turned 90°), inputs IN 5 → S1 Out 1 and IN 6 → S2 Out 5:
`LPP proof row.xml` (composition 4920 × 1920) and `LPP proof column.xml` (3840 × 3000), copied
into `Presets/Advanced Output/` with `Preferences/`, the presets and the compositions backed up.

- **Both loaded from the Presets list without a word**: two Virtual screens, `IN 5 → S1 Out 1`
  3840 × 1080 with slices `S1 Out 1 s1` and `s2`, `IN 6 → S2 Out 5` 1920 × 1080 with `S2 Out 5`.
  Arena lists a screen's slices topmost first, so s2 shows above s1.
- **Input Rects, as Arena's panel reads them** (centre, left/top, size): s1 0,0 1920 × 1080; s2
  1920,0; S2 Out 5 3840,0 1080 × 1920 side by side and 0,1080 stacked — the plan, to the pixel.
- **Output Rects:** s1 at 0,0 and s2 at 1920,0 on the 3840 raster, rotation 0. The turned slice
  reads rotation −90, centre 960,540, Left −0.03, Top 1080, Width 1080.05, Height 1920.03. That
  slop is Arena's: typing 1080 into its own Width field gives 1080.05 back (and Height 1920.06),
  and writing the angle at full precision instead of 6 decimals changed nothing.
- **Arena's own read-back.** Save as… under a scratch name, then the geometry diffed against ours:
  every screen name, device, size, Input Rect, warp lattice and unturned Output Rect identical;
  the turned Output Rect re-derived in float32 (angle −1.5707960128784179688, corners off by under
  0.001 px). Edited by hand in Arena, the same slice drifts 0.05 px, so the file is the more exact.
- **Played through:** a labelled picture (each region its own colour, a yellow block at its
  top-left, an arrow up) at the composition's size, the composition set to match over REST. Each
  screen's Output Transformation view showed s1 and s2 upright, left and right, and S2 turned with
  its yellow block at the raster's bottom-left and its arrow pointing left — content's top-left
  where the plan says, both arrangements.
- **Not taken from the preset: the composition size.** It stayed 1920 × 1080, and Arena writes its
  own size back as `CurrentCompositionTextureSize`. Slices beyond it are kept, not clipped. Set by
  hand, 4920 × 1920 or 3840 × 3000, the slices tile it exactly. `HOW` already said to.
- **`→` draws as a stand-in glyph** (like ǂ) in Arena's interface font. The bytes are kept: the
  read-back has `e2 86 92`. Cosmetic; the Background Slicer names its outputs the same way.
- **Traps:** the Advanced Output window is a floating panel that hides while Arena is in the
  background, so this needs the screen; its preset list is read once, so a file copied in while
  it is open needs Load…; its **Save <name>** item names the preset before the last load or save,
  so pressing it would overwrite that file; quitting dropped config.xml's SMPTE lines, as before,
  and the backup put them back. A picture opened over another clip's slot kept the old clip's
  size (3840 × 3000) — open a new one into an empty slot.

Afterwards the six files it touched were removed and `Preferences/`, the presets and the
compositions compared identical to the backup; Arena was quit, unsaved. Not covered: the
Background Slicer's own Arena preset (same writer, same names), a screen bound to a real output,
Arena on Windows, and a switcher fed by it.

## Image Library tools (2026-10-20, simulator only)

Allan asked for a **Delete all** on the image library, a way to **select several images and delete
them**, **uploading a .zip** of pictures that are unpacked into the library one per slot, and **a
dropdown on each image slot for its capacity**, so it isn't a trip to Preconfig ▸ Images every time.
Built as one plugin, `plugins/image-library/`, off by default. "Image slot" read as the stills on
the Images page (`Image 1` … `Image 48`): that's what Preconfig ▸ Images sets a capacity for. A
library slot's own capacity badge is only what its picture needs, and nothing sets it.

Run on a private copy of the LivePremier Simulator 6.2.73 session (Aquilon Cmax), ports moved to
3070 / 17606 under my scratchpad, with this worktree's proxy on 8571 and its own data directory, so
nobody else's demo or simulator was touched.

**Found on the simulator** (the bundle says nothing about any of it):

- **A library delete empties every still showing that slot**, at once: `mode` stays IMAGE and
  `source` stays the slot, `isValid` goes false, `imageWidth`/`imageHeight` 0. Single deletes and
  a run of four in a row both did it. So a bulk delete keeps any picture a still on program or
  preview shows, and names the stills it will leave empty.
- **Uploading into an empty slot a still points at puts the picture on that still**: slot 3,
  emptied by a delete with Image 1 still pointing at it, was refilled by a zip, and Image 1 showed
  the new 192 × 108 picture. Hence `uploadSlots`: never a slot a still on a bus points at, and one
  another still points at only after every clean slot. The Background Slicer and the UMD
  Generator took "the first free library slot" without this check; fixed the same day, below.
- **Unexplained, twice:** after a Delete all and then a 13-picture zip, Image 1 (pointing at empty
  slot 3) and Image 3 (empty slot 6) reported their *old* pictures as valid again (AWJ agreed:
  `isValid` true, 192 and 3840 wide). Later, Images 5 and 6 did the same after another zip. I
  couldn't make it happen again: a single delete followed by an unrelated upload, a byte-identical
  copy uploaded with curl, two uploads through `uploadPictures`, and the full zip again all left
  the emptied still empty. Whatever brings a still back, nothing in the plugin relies on it either
  way.
- **Capacities, put through the switcher's own check on still 1:** `HDTV_1080P`, `PROJ_1200P`,
  WUXGA, 1920×1440, 2K and even 2560×1440 checked as **Dual**; `UHDTV_2160P`, `CINEMA_4K`,
  3840×2400 and 4096×2160, and also 5760×1200, 7680×1080 and 7680×1200, as **4K** (taking still 2
  out of service); 5120×2160, `COMPUTER_5120_2880_RB`, 8192×2160, 8640×1600, 12000×1200 and
  16384×1080 as **5K** (taking 2, 3 and 4). Nothing checked as 8K, and the last two are the
  largest formats on offer (custom formats aside), so the dropdown offers Dual, 4K and 5K. `likelyCapability`'s area guess is wrong at the edges (it calls 8192×2160 8K and
  2560×1440 4K). The Background Slicer only uses it to pick what to ask for, and the switcher's
  check is still the judge.
- **Raising a still's capacity keeps its picture**, and **lowering it below the picture's need
  keeps the picture with `outOfCapability` true**, which is how the vendor's card flags it.
- A multi-file `POST /api/device/images/upload` (the vendor's own way) answers `{ name: status }`,
  so two files of the same name come back as one key although both imported. The plugin uploads
  one file per request into a named slot, which also keeps the order.
- The 6.2.73 import takes JPEG, JPG, PNG, GIF, TIFF and TIF (`import/status/pp/fileTypeValidity`).
  BMP isn't on the list, though Capture offers BMP as a file type.

**Driven in the browser pane** (all on the sim): Select with click and shift-click (a real
shift-click; the pane's own shift modifier didn't carry `shiftKey`); Delete selected over 2–5 with
Image 2 on preview showing slot 4 and Image 1 showing slot 3 (3 deleted, 4 kept, Image 1 emptied,
as the question said); Delete all (14 deleted, slot 4 kept); a Finder zip dropped on the vendor's
own drop zone (13 pictures into 1–3, 5, 7–15 in name order, `notes.txt` and `old.bmp` passed over,
`__MACOSX` in silence, 1.3 s); Image 3 Dual → 4K and back with a 3840 × 2160 picture in it; Image 1
→ 4K refused because Image 2 held a picture, with nothing left staged.

**Frame-only questions:**
- Does a real frame empty a still the moment its library picture is deleted, as the sim does? And
  what does a still on a bus show at that moment: black, or its last frame?
- Does applying Preconfig ▸ Images disturb a still that's on air elsewhere, or anything else on
  the frame? The sim can't say; the dropdown refuses a still on program, but not one on preview.
- Are the capacities the same on an RS4, a C or a 6.1.x box? The formats came from a Cmax.

**Not done:** README section screenshots, the user guide and its PDF, a release. README's feature
list, Safety and Platforms rows, and AGENTS.md are current.

### Empty slots a still points at, as a choice (2026-10-20, later)

The Background Slicer and the UMD Generator took the first free library slot (the UMD the last),
so either could have put a picture on a still that was pointing at an empty slot, on air included.
I'd made that a hard rule in Image Library tools; Allan wanted it to be the operator's call
("give the user the option to upload to an empty slot that is assigned somewhere if they want to"),
since refilling a still's own slot is sometimes exactly what's wanted.

Now all three choose through `core/stills.js`: `emptySlots` (each empty slot with the stills that
point at it, and their bus), `orderSlots` (clean only; with the option, then the pointed ones, those
on no bus first, program last) and `pointedText` (the sentence). A tick in each place, off at every
page load: **Use assigned slots** on the Image Library bar, **Use empty library slots a still points
at** in the slicer's Write options (LivePremier stills only; a Midra's own check already refuses a
slot a Background Image points at), **Use an empty slot a still points at** beside the UMD's first
Put. Each pointed slot used is named: in the upload question, as a plan warning, as a step. Without
the tick, running short says how many were passed over. The UMD keeps reusing its own slot when only
its own still points at it.

On the private sim: every clean slot filled, leaving 3, 6, 9 and 11 (Images 1, 3, 5, 6 pointing).
The zip with the tick off uploaded nothing and said why; ticked, it asked, naming all four stills,
filled the four slots, and Image 1 showed the new 160 × 90 picture. Slicer and UMD by offline tests
only (their panels render the tick; their plan, preflight and slot choice are tested).

## Barco EC-30, EC-40 and EC-50 panels (2026-10-20, pretend panel and simulator only)

Allan asked for the Barco EC controllers, through the tray app rather than the browser. What I
found, and what I built:

- **The EC-30/40/50 have no PC.** They're one USB device, `0600:0336`, an FT232H in MPSSE mode
  clocking SPI into a CPLD. qubered/ec50-panel (MIT, 2026) had already worked the protocol out from
  USB captures and proved it on an EC-50 under Windows; I ported it. The Event Master Toolsets
  installed here (9.2.68800, 9.2.68334, 10.0.3.3021) agree: their unstripped binaries name
  `libipconsole/ShowConsole.cpp` and `FtdiIoLinux.cpp`, bundle libftdi and libusb on the Mac, and
  ship the button map as `showConsoleMap.csv`, the same file in every version. 10.x's release
  notes say the EC-200/210 aren't supported there; those two are Linux kiosks and out of reach.
- **Where it runs:** the device host gained an FTDI transport (libusb via `usb` 2.18.0 on macOS and
  Linux, D2XX via `koffi` 3.3.2 on Windows) and a `command` op; the meaning is a server-side plugin
  on the Pixelhue supervisor's terms, so it works with no page open.
- **Shared with Pixelhue now:** `src/core/console-intents.js` (what a press writes) and
  `server/console-switcher.js` (the switcher read in bursts). Pixelhue's console suite on the
  6.2.73 simulator after the move: 31 pass, 3 skip, as recorded on 10-16. The move found
  `labelPath` throwing on a Midra (`split()` answers an object, it was read as a pair).
- **Tested:** `test/barco-ec.test.js` (25 offline tests: the table against the installed Toolsets'
  CSV, the captured blank framebuffer, the driver against a pretend panel that enforces latching,
  double buffering, the header and the one-late reply, libusb against a pretend `usb`, D2XX through
  koffi against a stand-in `ftd2xx` compiled with the system `cc`) and `test/sim/barco-ec.sim.test.js`
  (3 live tests, passed three runs in a row on a private copy of the 6.2.73 session).
- **Trap:** in this Mac's zsh, `cc` is a shell function that starts Claude Code, not the compiler.
  The test runs the compiler with `execFile`, which never sees the function; by hand, use
  `/usr/bin/cc`.
- **Trap:** the simulator shows no in-between T-bar position, so a live test can only witness the
  takes a throw makes, not the throw.
- **The live suite had three failures before this change**, on clean origin/main against the same
  private simulator: `locks.sim` (three layers fitted on S1 in that session), `panels.sim`
  (`aoi-format registered nothing`) and `screen.sim` (something staged in the VPU). Not this work's;
  noted so nobody chases them as mine.

## The ATEM Micro Panel (2026-10-20, pretend panel and simulator only)

Allan asked how fixed-function Blackmagic's ATEM panels are, with a view to using them as
LivePremier surfaces, then for the Micro Panel first ("we can loop back to the other panels down
the line"). What I found, and what I built:

- **The panels, from the ATEM Setup 10.2.1 bundle.** Its `data-<USB PID>.bin` packages are an
  integrity checksum, `0xBDBD` resource headers and zlib — no encryption at that layer. Inside: the
  old Broadcast Panels are AVR32 firmware, the 1 M/E Advanced Panel and Camera Control Panel are
  Zynq images with encrypted parts, the D2 Advanced Panels (20/30/40) are opaque ~62 MB images,
  and the Micro Panels' are signed and encrypted. So replacing any panel's firmware is out. I
  stopped at the encrypted parts.
- **The Micro Panel is host-driven.** ATEM Software Control carries its driver (`PanelDevice`,
  `MicroPanelModel`: scan codes in, LED colours out), and node-blackmagic-controller (MIT, Julian
  Waller) already drives it for Companion: `1edb:bef0` over USB or Bluetooth, the Speed Editor's
  handshake on feature report 5, keys on input report 3, the T-bar on 8 (0–4096), the battery on
  6, and one 32-byte lamp report (id 2) with three RGB bits a key and a sixteen-segment meter.
  That is the Barco EC panel's situation on the Speed Editor's wire.
- **The Ethernet panels** (Advanced, Camera Control, Broadcast) connect to a switcher as clients on
  UDP 9910, so reaching them means emulating an ATEM. Prior art exists for the server end
  (OpenSwitcher, Swift-Atem, LibAtem's AtemProxy) but none has been shown working with a hardware
  panel, and panels refuse a mismatched firmware version. Parked: the next step is a capture of a
  real panel and switcher talking, through a proxy.
- **Built:** `src/core/atem-micro-panel.js` (the bytes), `devices/blackmagic-hid.js` (the Speed
  Editor's driver, moved and given a model; its module is a subclass now), the
  `atem-micro-panel` device module, and a server-side plugin on the Barco EC panel's terms.
  `console-intents.js` gained `strokeProgress`/`STROKE_END` (moved from the EC plugin),
  `layerSourcePath` and `readSource`; `console-switcher.js` gained `tallyFor`.
- **Decisions:** key *n* is source *n*, as on an ATEM; MACRO's memories are by slot; M/E and layer
  keys are positional; with nothing selected, the first screen is driven. The program row is tally
  only unless ticked, and the tick is never saved (it goes when the panel is switched off or the
  app restarts) — per Allan's opt-in-over-refusal preference, since an ATEM program row cuts to
  air and that is sometimes exactly what an operator wants. Tally is read every 5 s and after each
  press (a burst of a dozen `get`s), not followed.
- **Tested:** `test/atem-micro-panel.test.js` (16 offline: the key table against
  node-blackmagic-controller's shape, the lamp report's bits, decoding, the handshake, the driver
  alone and beside a Speed Editor, the host, every key's meaning, the paint, and the supervisor end
  to end against a pretend switcher), and `test/sim/atem-micro-panel.sim.test.js` (3 live tests on
  a private copy of Session 1, 6.2.73 C MAX, web 3079, AWJ 10606, deleted after; the Barco EC sim
  tests passed beside it, 3/3, after the stroke move). `npm test`: 1316 tests, 1307 pass, 9 skip.
- **Found by the test:** letting go could leave the panel lit, because a tally read in flight
  repainted after the dark report. `#letGo` now stops painting first.
- **Not done:** `ATTRIBUTIONS.md` is generated from stoatworks-backend; its node-blackmagic-controller
  and blackmagic-misc entries still describe only the Speed Editor's use.

## HyperDecks: Mitti never answers a bare `slot info` (2026-10-20)

On every connect the link (`hello()` in `plugins/hyperdeck/link.js`) asked a bare `slot info`.
openRCS, porting the LF fix, found that a **real Mitti 2.8.19** never answers it: no `202`, no
`103`, nothing. The link keeps one command in flight, so the `transport info` queued behind it
waited out `REPLY_TIMEOUT_MS` (3 s). Nothing broke. The first transport state was 3 s late on
every connect, and the disk never showed.

What the real Mitti said, asked by hand on this Mac (read-only queries, LF-ended, an empty
playlist):

| Sent | Mitti 2.8.19 |
|---|---|
| `slot info` | nothing in 8 s; the next command was answered as normal |
| `slot info: slot id: 0` | nothing |
| `slot info: slot id: 1` | `202`, `status: mounted`, `volume name: MITTI_DISK`, `recording time: 0`, `blocked: false` |
| `slot info: slot id: 2` | `202`, `status: empty` |
| `transport info` | `slot id: 1`, `clip id: none` |
| `device info` | `slot count: 1` |

Blackmagic's *HyperDeck Ethernet Protocol* (December 2024) has both forms. Bare `slot info`
means "the currently selected slot", `slot info: slot id: {n}` means slot n, and transport
info's `slot id` is the active slot or `none`. So the link now asks for the transport first,
then `slot info: slot id: <the transport's slot id>` (`slotQuery` in `protocol.js`, which uses 1
when the deck said `none` or didn't answer). On a two-slot HyperDeck that's the same slot the
bare form would have meant. On Mitti it gets an answer.

How far it's proven:

- **In this repo, against the simulator only.** `tools/hyperdeck-sim.mjs --mitti` now has one
  slot and says nothing to a bare `slot info` or to slot 0. In HyperDeck mode it has two slots,
  `state.slot` is the active one, and `slot info` answers for the slot asked about.
  `test/hyperdeck.test.js` has three new tests: the sim's silence; a Mitti link whose transport
  and slot both arrive inside 1.5 s (fails on the old link, checked); and a two-slot deck on slot
  2 that gets asked about slot 2. This repo's own link hasn't been connected to the real Mitti.
- **On the real Mitti, through the copies** of this link that automitti and openRCS carry, with
  the same change made the same day. automitti's read transport and slot from Mitti 2.8.19 in
  4 ms; its old copy got the first transport at 3003 ms and never got the slot. openRCS's had all
  six replies (`500`, `209`, `204`, `205`, `208`, `202`) in 11 ms. Both were read-only, with an
  empty playlist, and Mitti was quit afterwards.
- **No real HyperDeck** has seen either form from any of the three.

Unchanged: the slot is still asked about once per connect. Nothing asks again when the
transport's `slot id` changes, which was true before too.

## Test Card on the outputs and Canvas pages (2026-10-20, simulator only)

Allan asked for the Test Card pattern generator inside this app, "integrated into the outputs and
preconfig - canvas pages in new tabs alongside the built in test patterns", with stills on the
switcher if that's what it takes, and rendering on the fly if it can be done.

**It can't be drawn by the switcher.** Read off the 6.2.73 bundle (`webapp-bundle/dist/client`,
`nlc-platform` 6.2.1), the patterns are enums of generators: `OPATTERN_TYPE` on an output
(NO_PATTERN, COLOR, the greyscales and colour bars, GRID_16_16, GRID_32_32, GRID_CUSTOM, SMPTE,
the bursts and gradients, CROSSHATCH, CHECKERBOARD, MOVING, ID, SOFTEDGE, STEREOSCOPY),
`SCREEN_PATTERN_TYPE` on a screen (NONE, GEOMETRIC, … THIRTY_BPP_1/2) and `IPATTERN_TYPE` on an
input. Their parameters are sizes, colours and thicknesses. None takes a picture. So a Test Card
goes up as a still on the top layer, through the UMD Generator's path (now `core/still-layer.js`).

**What "on the fly" became.** Two things measured on a private copy of the 6.2.73 Cmax session
(ports 3040 and 10646, `~/dev/sim-copies/testcard-6.2.73`, the AGENTS.md recipe):

- an upload into a library slot that already holds a file is `FINISH` and changes its `hashName`
  (slot 1: `d064c258…` → `23c77de4…`), as the UMD Generator found on 2026-10-16;
- a still showing that slot reloads by itself: still 1's `status/pp/newSnaphot` went 4 → 5 when
  its slot was replaced, with nothing written to the still. The simulator's still snapshot is a
  256×256 black square either way, so the picture itself was not seen.

So a card that is on follows: every couple of seconds the page compares a fingerprint of the
settings and the switcher's output geometry with the one it last drew, and if they differ draws
again and uploads into the same slot.

**Run through the app against that copy, every write on the switcher's echo:**

- Out 1 (Setup ▸ Outputs ▸ Output 1 ▸ Test Card ▸ Enable): `testcard-S1.png` 1920×1080 into slot
  200, still 48 `IMAGE` / source 200 / `NO_RESCALE` / label `Test card S1`, S1 preview (B) L2
  `STILL_48` at 960,540 1920×1080 (its MIDDLE_CENTER anchor), opacity 256. Program (A) untouched.
- A pattern pick (SMPTE → Grid): one upload, slot 200's hash changed, still 48 `newSnaphot` 5 → 6,
  the still not written; the layer writes went again with their unchanged values, which the
  switcher doesn't echo and the send doesn't wait for.
- Off: L2 back to `NONE` at the same place, still 48 back to `NONE` / `SCALE_TO_CAPABILITY` /
  source 1, slot 200 emptied, the document's entry gone.
- Preconfig ▸ Canvas ▸ S1 ▸ Test Card, *Across the canvas*, Enable; then Out 1 renamed `LEFT` on
  the switcher: within the follower's two seconds a redraw and an upload (hash changed), nothing
  else written. Renamed back, Off.
- S2 with **On program** ticked: L1 of A (program) `STILL_48`, B untouched; Off put it back.
- Out 3 on, then Out 1 on the same screen: one picture, outputs `['1', '3']`, the journal still
  holding the values from before the first write; Out 1 off, Out 3 off, everything back.
- The Router tab and the Test Card tab on the same strip close each other, and a vendor tab closes
  both (Router used to close only for routed anchors, so it stayed open under ours).

This session's two outputs on S1 both sit at 0,0 1920×1080 (the vendor shows its "outputs overlap
too much" warning), so the bounding box of two different footprints was not seen on the
simulator; it, a turned output and a pitched one are covered by `test/test-card.test.js` only.

Found on the way:

- **The library's size counter** never dropped a replaced file on the simulator (found by the
  still-sequence frame-test kit in `~/dev/aquilon-field-test/still-sequence`, 2026-10-20: eight
  replaces left 168 KB with every slot empty). A card that follows many changes may use more of
  the library than its one slot suggests; check on a frame.
- **Thumbnails can't be the real raster.** Test Card's pixel check at 1 px is one `fillRect` per
  cell, about a million at 1080p; the tiles draw a small raster of their own.
- **The Canvas page's pane is a Semantic `segment`** holding a panel, where an output page's pane
  is the panel; the tab's host needs a panel inside, and a `min-height: 0` scroller, or it grows
  past the page.

**An independent review before landing found eight bugs**, each fixed and held by
`test/test-card-client.test.js` (the page half against a stand-in switcher) or
`test/test-card.test.js`:

1. A failed Off saved the card as off with its journal, so it couldn't be retried, and a click
   on the switch then redrew it onto program unasked. Now a failed Off stays on; a put that fails
   half way shows as on too; **Take everything off** covers what no switch stands for.
2. Off judged a still ours only by the placed slot: after a put tried twice it left the first
   try's still pointing at an emptied slot, and with no placement it dropped every still. Now any
   slot the journal filled counts, and a still half put back by a failed Off counts too.
3. Settings edits saved the page's own copy of the document unread, and saves weren't awaited,
   so one page could wipe another's journal. Now one queue, read first, saves awaited.
4. The fight limit counted the operator's own edits, and "change anything to start again"
   didn't reset it.
5. React keeps an output page's tab strip from one output to the next, and the tab kept the
   first output's key, so it closed itself on the second.
6. A top-layer change re-put the card in the buffer the page's tick said, not the one it was in.
7. The journal reached disk only after the whole put; now before each group of writes.
8. The buffer was resolved before the render and upload; a take landing in between sent a
   preview card to program. Now it is resolved again at the layer write.

The restructured page half was run again on the simulator afterwards: Enable, a pattern change
followed (one upload), Off, and program asking first and writing nothing until confirmed.

Not done: a frame (hardware is ask-first), 6.1.60, a Midra (the tab says LivePremier only),
screenshots of a real output. The engine is synced from test-card main; `npm run sync:test-card`
again when Test Card's painters change, and `test/vendor.test.js` fails when they have.

## The first real U5 mini: the wrong socket path (2026-10-22, firmware and offline tests only)

A user with a real Pixelhue U5 mini on firmware V1.0.3 got `upgrade refused with HTTP 200` the
moment the Pixelhue panel connected. It was the first real console this preview had met. The
panel opened `ws://<mini>:8088/unico/v1/ucenter/ws?client-type=5`, which is the U5 / U5 Pro
UCenter's path. The mini runs a different service, `nvcontroller`, which answered that path as an
ordinary page.

- **From the firmware** (`U5MINI V1.0.3.zip`; the `.img` has its root squashfs at byte offset
  `0x149bc4a`; read, never run): `usr/process/oem/nvcontroller/nvcontroller` contains
  `/unico/v1/ws` and no `ucenter/ws` at all. `config/runtime.toml` puts HTTP and the socket on 8088.
  The mini's LCD app (`usr/process/oem/LCD/bin/liblcdcommchannelimpl.so`) connects to
  `ws://127.0.0.1:<port>/unico/v1/ws?client-type=11`. The REST segments the plugin uses are under
  `/unico/v1/ucenter/video-station/…` there as on a U5, so only the socket was wrong. The mDNS
  advertisement is the LCD grid's 17100 only, so pixelhue-bridge's protocols.md was wrong to say
  the advertiser used 8088.
- **Why no test caught it:** `test/helpers/fake-ucenter.js` served the mini at the U5's path too.
  It is the GUID typo in `ws-client.js` again. A stand-in that shares the code's mistake proves
  nothing.
- **Fixed:** `CONSOLE_MODELS` has a `wsPath` and a `clientType` per model (the mini is
  `/unico/v1/ws`), threaded through `linkFor` into `UCenterLink` and the console suite. The
  stand-in serves only the mini's path and answers the U5's with a 200. `test/pixelhue.test.js`
  pins the mini's URL to the firmware. A refused upgrade now names the URL it tried. Upstream in
  pixelhue-bridge 838984c, re-vendored.
- **Still a guess: client type 5 on a mini.** Its own LCD app uses 11. A socket that opens and
  hears no key report in 10 s now says so on the card, in the history and in the log, and says when
  one does arrive.
- **Found by the full run, not by me:** `ws-client.js` delivered any frame that came in the same
  packet as the 101 *before* emitting `open`. The new silence watch reset itself on `open`, so a
  console that sent its key state with the handshake was reported silent. `open` comes first now,
  and the link resets per dial. A real U5 could have tripped it just as well.
- **Tested:** `npm test` 1370 tests, 1359 pass, 11 skip (other repos' vendor checkouts and koffi),
  with the Pixelhue drift check run against the bridge commit. Each new test was checked against the
  old code and fails there. The console suite's harness was opened against the stand-in, and its
  witness got all 66 keys at `/unico/v1/ws`.
- **Not done:** `npm run test:console` was not run on a simulator this time, because none could be
  started without the simulator app's own Start Session button. Nothing has been run on a mini since.
  Whether a type-5 socket hears its keys is the next thing one has to answer. A point release so the
  user can try it is Allan's call.

## The U5 mini's key grid (2026-10-22, firmware and offline tests only)

The same user's mini, on 0.18.1, connected. Page up / down and the area-switch keys reached the
app; the LCD keys stayed blank and TAKE, CUT and the bus keys did nothing. The firmware says the
mini's LCD app, not its control service, owns the bus keys: it binds to a Pixelhue switcher, draws
from its own cache and runs TAKE / CUT against that switcher. Publishing a model to nvcontroller
labels nothing on a mini.

- **From the firmware** (V1.0.3, read from the LCD libraries' symbols; never run): the 17100
  Companion surface draws only on rows switched to Companion with the area-switch key; `page` is
  the row's page (a draw moves the row, a press reports it); one client, where a LAN client takes
  the grid from localhost and from another LAN address, and a second connection from the holder's
  address or from localhost is closed; Pixelhue's built-in Companion keeps an enabled connection
  to 127.0.0.1:17100 and restarts it when dropped. `docs/PIXELHUE.md` ("A U5 mini's key grid") and
  pixelhue-bridge's `docs/protocols.md` have the detail and the function names.
- **Built:** on a mini the plugin opens the grid beside the control-service socket
  (`grid-link.js`) and draws four rows from the same facts it publishes (`grid.js`): screens, the
  active screen's layers, inputs with tally, memories; columns 8 / 9 page the row. A press becomes
  the U5's bus intent and goes through `#perform`, so the selection lives in the app. SAVE TO / DEL
  arm from 520 / 521 if a mini reports them. The link lets go after the console closes it three
  times in a minute (another LAN client, or the console refusing this machine while it still holds
  an older connection) and says why. Labels use the EC panel's font, with a 1.5× step added for
  72-pixel keys.
- **TAKE / CUT:** if 531 / 532 arrive they take the grid's selection (proved against the stand-in).
  A key report for TAKE with no 531 after it is said in the history; with nothing at all, the card
  shows **TAKE / CUT: not seen yet** and a plain-words note. No workaround is guessed at.
- **The stand-in:** `test/helpers/fake-mini-lcd.js` follows the firmware's rules, not this code's,
  and reads the wire with its own codec. `functionKeys` makes it report TAKE / CUT as a U5 does, as
  a key only, or not at all, since which a mini does is the open question.
- **Found on the way:** PixelFlow for macOS runs a real UCenter as root on 127.0.0.1:19999 on the
  Mac this was built on, and `lsof` without sudo does not show it. A first draft of the "a U5 has no grid"
  test dialled it; the test now uses a closed port.
- **Tested:** `npm test` 1391 tests, 1381 pass, 10 skip (other repos' vendor checkouts), with the
  Pixelhue drift check run against the bridge commit. pixelhue-bridge `npm test` 28 pass.
- **Not done:** nothing on a mini, nothing on a simulator. The first person with one will say
  whether the rows, columns 8 / 9, the page rule and the labels are what the firmware suggests,
  and whether TAKE and CUT arrive. A point release is Allan's call.

## Aquilon C mini (2026-10-30)

**The box.** `NLC_CMINI`, label `AQUILON`, firmware **6.2.73**, `isSimulated`
false. Its Web RCS bundle (`app.9f659f2d9c349cd5962a.js`) is the one the Aquilon C served on
2026-09-09, so this is the same build on smaller hardware. It was blank: S1 and S2 on one output
and four 4K layers each, S3 with no outputs, no auxes, every bank empty, every layer NONE, no
input signal, nobody operating it. Reached remotely, with AWJ at about 95 ms a round trip. The
app ran in a container on the far side of the link and the browser came in over a tunnel. The
field kit's read-only phases passed first (30 pass), and a copy of the whole store (124 MB) was
taken before any write, to diff against at the end.

**What was written, all read back over AWJ:**

- **Layer tab:** S1 preview layer 1 opacity 256 → 240 → 256, program untouched. A typed `256240`
  was clamped to 256 and said so (`S1 B L1 Opacity = 256 (clamped to 256)`), as it should be.
- **Memories:** S1's preview saved into empty slot 990 (`isValid` true, the buffer's `presetId`
  990 unmodified, program's untouched), renamed `LPP hw test`, then erased (two clicks) —
  `isValid` false, label cleared, `presetId` back to 0.
- **Timeline:** one cue, recall 990 → S1 preview, take, fade 2 s. GO wrote `takeUpTime` and
  `takeDownTime` 20, recalled (preview unmodified again) and took: `AT_UP`, `tbarPosition` 65535.
  The panel logged `4 writes sent`.
- **Console:** `Take Screen 1` (1/1 write sent) ran `EFFECT_FROM_UP` and landed `AT_DOWN` 2.3 s
  after firing, which is the 2 s fade and the ~250 ms AGENTS.md records for real hardware. Raw
  `AWJ … = …` lines put both take times back to 10 and re-armed the triggers below.

The store diff at the end: **0 leaves**. No Edit direct save (still waiting for a share the box
can see), and no master memory.

**The timeline's New cue form forgot what was typed — the bug this box was for.** The form was
drawn afresh with every repaint and kept its fields only in the DOM. `keep-focus.js` carries over
the field that has focus, so the one being typed in survived and every one the operator had
moved on from went back to its default. The panel repaints on every frame, and this box's four
running timers send one a second, so a cue typed as slot 990, take, 2 s was slot 1, no take, no
fade a second later. The simulator's timers don't run, which is why it never showed there. The
row editor (Edit on a cue) had the same fault. Both now keep a draft in `view`, as the form's
Companion and HyperDeck fields already did (`test/timeline-form.test.js`); on the box, the
fields then held through repaints and the cue arrived as typed.

**Things worth knowing next time:**

- **The header's client count includes AWJ connections.** It read `2 Clients` while an AWJ get
  loop was connected and went back to 1 when it closed. The REMOTE state lists them apart
  (`system/network/websocketServer/clients`, `…/awjServer/clients`, each with an IP), which is
  the way to tell a second operator from your own probe.
- **Triggers latch on hardware as on the simulator.** The save's and the load's `xRequest`,
  `xDelete` and `xTake` all read true after use and stay true until written false; the store diff
  shows each one. After a recall or save, write them back.
- **A delete leaves `isNotModified` true**, as the RS4 recipe predicted from the simulator.
  Nudging one property and putting it back clears it.
- **Arrow keys belong to the vendor.** With a layer selected on the vendor's canvas, an ArrowDown
  meant for one of our dropdowns moved the layer a pixel (`posV` 540 → 541, put back). Deselect
  on the canvas, or keep arrow keys off the page, when testing.
- **The constant repaint makes a browser tool's element references go stale** within a second,
  everywhere. Hold the repaint the way an operator does: a press on a `<select>` holds it
  (`keep-focus.js`), and a click on a field keeps its place.

**The second pass, the same afternoon.** Preview lock, Layer Groups and Surfaces switched on in
the app's settings first (they're off by default); the store diffed against the same baseline at
the end.

- **Preview lock:** S1's take times set to 5 s (Console `AWJ` lines), the memory stored from the
  Console (`Store Screen 1 Memory 990 Preview` — the Console's store defaults to *program*, so say
  Preview), then `Take Screen 1` and, a second later, `Recall Screen 1 Memory 990`. The PRW
  padlock on S1's card shut for the take and opened when it landed; the Console said `1/1 write
  sent (after the take)`, and AWJ had the take start at 12.4 s, the recall's trigger at 17.5 s and
  `AT_UP` by 17.9 s, with the memory in **A**, the new preview, not B as it faded up.
- **Layer Groups:** a ganged group of S1 L1 and S2 L1 with S1 at `AT_UP` (program B) and S2 at
  `AT_DOWN` (program A). A source change in S1's preview (A) followed onto S2's preview (B);
  a Send-to of IN2 to the group in preview wrote S1 A and S2 B; programs stayed NONE throughout.
  A program send of IN3 with both PGM padlocks shut stopped at `PGM — ON AIR · PGM is locked on
  S1, S2` and, cancelled, sent nothing. The Layer tab's source list offered what this box has:
  LIVE 1–8, STILL 1–24, SCREEN 1–2, COLOR.
- **Surfaces:** a 960×1080 surface on S1's left half, L1 bound. Binding moved nothing and flagged
  both buffers, program with *Nothing here moves program*. An AWJ write from outside (sizeH 800 on
  preview, overhanging the edge) was pulled back to posH 560; the vendor's full screen was
  reshaped to the surface (480 / 960 sent, the hook's record shows it); program B was left alone.
  ⚠️ **Full screen does nothing to a layer that already fills the canvas** — the vendor sends no
  write when nothing changes (the hook recorded none), so a fresh layer bound to a surface stays
  outside it until it's moved some other way. Probably wants a "pull in now" on binding; not done.
- **Pixel Map:** library slot 1 picked for S1 and checked from the DOM, not by eye (the library
  held the owner's own pictures): loaded from `/api/device/images/download/1` at its own 960×540,
  drawn over S1/PRW, `pointer-events: none`, then set back to None. **That download runs the
  box's library export** (`stillList/library/export`, `EXPORT_RENAME` into `tmp_disk`, status
  `FINISH`, the file's name), and those four leaves are all the store diff found at the end. The
  vendor's own Download button does the same; status words aren't writable, so they were left.
- **A memory recall sets the take time.** Recalling 990 into S1's preview with S1 at `AT_UP` set
  `takeDownTime` back to the 10 the memory was stored with — the box did it, mid-load, with no
  write from this page. A screen memory's TIMING category carries the time for the take into that
  buffer. It's why a cue must write its fade after its recall, which the timeline does.
- **Someone else joined.** Partway through, a second Web RCS client connected through the same
  route (same NAT address, a port that wasn't ours: the REMOTE INIT and `netstat` in the app's
  container settle which is yours). It sent nothing. Testing stopped there and the box was put
  back; Audio Matrix, OSC, Variables and the image-upload panels wait for the next pass.

**The third pass, the same evening** (Allan: carry on with the second client connected; it left
partway through without having sent anything).

- **Audio Matrix:** the box's matrix as the panel drew it (112 channels patched, 48 kHz, Dante
  clock). A block click patched Input 8 across Multiviewer 2 (`txList/MVW_2`, all NONE before),
  the panel saying `8 of 8 channels (1→1 … 8→8)` and the count going to 120; M muted and unmuted
  MVW 2 channel 1 (AWJ `mute` true, then false); a second click cleared the block. Diff: nothing.
- **OSC input** (listening on 127.0.0.1:8000 inside the app's container, sent from there):
  `/lp/screen/1/preset/b/layer/1/opacity/opacity 200` wrote 200 to S1 B and left A; `/take` took
  S1, `/take 0` did nothing, `/take 1` took it back; `…/preset/preview/…` was refused with *cannot
  tell which buffer is preview … Address the buffer directly with /a, /b or /c*. The take trigger
  latches as from anywhere else and was re-armed.
- **Arithmetic and Variables in a vendor field:** 6.2.73's geometry fields on real hardware are
  `type=text` with `min`/`max`/`step` (X −960…2880, Y −540…1620, W/H 0…8192). `1920/2` in the
  vendor's own width committed 960 and `$S1.width` put back 1920; the aspect lock dragged the
  height along both times.
- **UMD Generator → Background Slicer:** S1's L1 named (an empty layer is drawn only when named;
  a full-screen box gets *no room under this box, so its label is inside it*), handed to the
  Slicer, generated (one 1920×1080 PNG, 35 KB, a pixel copy) and written: library slot 4, still 3
  (`mode` IMAGE, `source` 4, label), and S1 background set 1 Out 1 ← STILL_3 under
  `preconfig/backgrounds/…`. No capacity change was needed, and S1's missing NATIVE layer meant the
  set couldn't be loaded, as the plan said. **Undo what was written** put the set, its label and
  still 3 back — still 3's `source` back to 1, where it pointed before, not to 0 — and emptied the
  slot. Left behind, none of it writable or worth writing: still 3's image size and snapshot
  counter, the deleted slot's old file name and size in its status, the import command's last
  request, and every output's `contentValidity` now reading `["NONE","COLOR"]` where the first pull
  had `[]`. **Undo leaves two triggers latched** — the still's `settings/xUpdate` and the slot's
  `control/xDelete` — which were written back false by hand; the undo could re-arm them itself.
  The confirmation said *Upload 1 images … set 1 free stills*; fixed.

**Edge cases, the same night** (Allan: "keep poking around and see what breaks"). Each read
back over AWJ or the store and put back; the store diffed clean against the third pass's.

- **The settings page put Listen for OSC back off.** Its plugin switch sent the page's copy of
  every plugin's entry, read when the page opened, so the OSC card's own save from since was
  overwritten when UMD Generator was switched on. Reproduced against `/__lpp/settings` from the
  app's container; fixed to send the one switch (`test/settings-toggle.test.js`).
- **Output thumbnails are not a picture of the output here.** `/api/device/snapshots/outputs/1`
  answers a fresh 256×144 PNG (RGBA, uncompressed, so 147,925 bytes) that stayed solid black
  with a full-red COLOR layer on S1's program, with `snapshot/highPriority` raised and with S1's
  test-pattern `inhibit` lifted (`type` refused `GRID`). The vendor's card draws the red from the
  store, not from the output. So this box can't answer the aux-background render question either.
- **The Console sends to screens that aren't in service, and the switcher takes them.** `Take
  Screen 3` (S3 `DISABLED`, no outputs) and `Take Screen 9` (not in use) each said `1/1 write sent`
  and each screen went `AT_UP`. `Recall Screen 1 Memory 999` (an empty slot) was sent and only
  latched its trigger. An `AWJ` line to a path that doesn't exist reports `1/1 write sent`, as it
  must over the vendor's socket, which answers nothing. Worth a word on the feedback line before
  Enter for the first three; not changed.
- **What it refuses, it refuses before sending:** `Set Screen 1 Layer 1 Opacity 999` (*out of range
  — the device's scale is 0 to 256*), an unknown keyword, and `$S1.PGM.L1.x` mid-take (*S1 is
  mid-take — program is changing hands*), which read 960 once the take landed.
- **A T-bar parked half way** (control `tbarPosition` 32768 from outside) reports `EFFECT_FROM_DOWN`
  with the *status* `tbarPosition` still 0. Preview lock held a Console recall and gave up with
  *not sent — S1 still mid-take after 3.0 s*; the guide says take time plus three seconds, so one of
  them wants a look. Moving the T-bar leaves `isTbarPositionValid` false until the next take.
- **Layer Lock:** S1 L1 locked; its preview opacity set to 200 from outside was back at 256, its
  program value, within 0.3 s; *Next take* read *stays*.

**Not run on this box:** Pitch (every screen is one output, its own reference at 1.000, so there
is nothing to compute), anything needing an aux (the UMD's aux path, the aux-background test),
input signal (signal dots, Layer Lock on a live source, thumbnails) or a screen over several
outputs (the VPU header's link order, rotated or grouped Background Slicer cuts), and the 6.1.x
arithmetic. Output thumbnails can't stand in for looking at an output on it (above).

**The fourth pass, and the U5 on a real frame (2026-10-30, evening).**

- **The VPU map misreads this box's layout.** The resource mapping (`preconfig/resources/current/
  …/vpuMixerList`) names S1's four mixer pairs `NATIVE`, `1`, `2`, `3`, but the screen's own layer
  status says NATIVE `capability: OFF` and layers 1–4 at 4K (`layerCount` 4), and the vendor's
  Preconfig ▸ Screens shows Layer 1–4 and no background layer. The map follows the mapping, so its
  rows read NAT / L1–L3 where the screen has L1–L4, and it calls VPU 1 `12/8 layer links …
  overflows 8 links` on a layout the box is running. It also lists **8 staged changes** (mixers
  9–16 `usedOnOutPipe3` → `usedOnOutPipe2`, already in the first store pull) where the vendor's
  Summary says *Pending Modifications* is empty. The model is aquilon-vpu-map's; the fix belongs
  there, with this store. The Background Slicer reads the layer status and was right.
- **Timeline, GO pressed twice half a second apart** (two cues, recall 990 / 991 → S1 PRW, take,
  2 s; Preview lock on): cue 1 recalled into B and took; cue 2 said *waiting for take: 2 → S1*,
  recalled into **A** as cue 1 landed, and took back. Right on the hardware.
- **Timecode chase, pushed to `/__lpp/timecode`.** Single POSTs a few seconds apart fire nothing:
  `TimecodeClock` calls a feed stopped 250 ms after its last reading, and the chase ignores a
  stopped clock (`lastPosition` stays null). The guide now says to stream. Streamed at 25 fps:
  01:00 → 04:00 then a jump to 09:00 → 10:00 fired neither cue (05:00, 08:00), as a jump should;
  back to 02:00 and straight through to 10:00 fired cue 1 at 05:00 and cue 2 at 08:00, once each,
  each recall and take seen on the box.
- **The U5 integration against the frame.** The app ran on this Mac (`--device 127.0.0.1:18080`)
  so it could reach PixelFlow's UCenter on 127.0.0.1:19999, with the C mini's :80 and :10606
  carried to it over ssh from a relay beside the remote link; the virtual U5 was
  `pixelhue-re/tools/rig/virtual-panel.mjs`, PixelFlow itself closed. The panel connected,
  published 3 screens, 8 layers, 8 inputs, and the U5's buses showed S1–S3, Layer 1–4 (no phantom
  NATIVE) and LIVE_1–8. Then, each read back over AWJ: S1 select → Layer 1 → LIVE_2 wrote LIVE_2 to
  S1's preview layer 1 and left program; TAKE took S1 only; TIME made the take 1.1 s; SAVE TO on an
  empty preset key stored S1's preview as *Memory 1* in slot 1 and republished (the key appeared);
  DEL and that key deleted it. ⚠️ A relay that tears down both sides when one closes drops an AWJ
  write — the app sends a write and closes at once — so the first press "sent" and nothing landed;
  the relay has to pass half-close.
- **Faders on the virtual U5 report indices 4, 5, … from the left** (the press inspector: the
  first two were `fader 4` and `fader 5`). The app binds `lpp.fader.1`–`8` and reads index *n* as
  layer *n*, so there the leftmost fader drives layer 4, the next layer 5 (not allocated on S1),
  and the last three are never bound. Whether a physical U5 numbers them the same is not known;
  PixelFlow's virtual panel is the vendor's own drawing of one. Not changed.
- **A fader gesture's history line can name the wrong value.** It is written 500 ms after the last
  *report* (`GESTURE_IDLE_MS`), but each move here took about 650 ms (a `lettersFor` read and the
  write, ~320 ms each over this link), so the timer fired mid-write and logged the move before
  last (`= 74`) while the frame ended where the fader did (154, 60 %). The switcher is right, the
  history is not. The timer wants restarting when a write lands; not changed (no test rig for it
  yet).
- Put back after, the store diffed clean against the third pass's.

**The fifth pass: the last five panels (2026-10-30, night).** Every write read back over AWJ, each
test put back and the store diffed before the next.

- **Layer Lock's Take only.** S1 preview (B) staged L1 LIVE_1 and L2 LIVE_2; Take only on L1 said
  *took S1 L1, preview put back (1 property)*. The box landed AT_UP with program L1 LIVE_1, L2 NONE,
  and LIVE_2 still waiting on L2 of the new preview. Right.
- **Edit page, save via preview.** S1 programmed off the buses (L1 IN2, L2 IN3; nothing on the wire
  while programming), saved into 990: preview got LIVE_2 / LIVE_3, the save fired, the slot came
  back valid with its label, and preview was NONE / NONE again about 1.7 s later. Program and the
  transition never moved. A second save into the now-valid slot, a different look and the save
  trigger still latched, landed too: recalling 990 into preview gave LIVE_4 / LIVE_5.
  (`waitForValid` returns at once for a slot that is already valid; the look, the save and the
  put-back go down one socket in order, and the box kept that order.) Slot and label survive the
  1 s repaint and losing focus.
- **Direct was the default route on a real switcher**, where it can't work without a shared
  directory, so the first save of the day would fail. Fixed: the rail starts on Via preview unless
  a Shared directory is set or the device says it is a simulator; Direct is still offered
  (`test/edit.test.js`). Seen on the box after the fix. The Direct save itself was not tried here.
- **Load can't work on real hardware without that directory either**: the bank export answers
  `ERROR_INVALID_PATH` (the path is on the switcher's disk), and the page said only that. It now
  says why and where to set it. Load leaves `presetBank/export/cmd` latched (`xRequest` true, the
  path, the slot selected), as the import leaves its own; put back by hand. Not changed: the
  vendor's own pages leave their triggers latched too (`xStore` false, true).
- **The Edit page lists S3**, DISABLED on this box, as a destination with 0 layers. Noted.
- **A recall into preview left a stale layer status.** After recalling 990 into S1's preview and
  putting both layers back to NONE, S1 layers 1–2 report `status/pp/up` OPEN while every writable
  leaf matches the earlier snapshot. Source nudges and two takes there and back didn't clear it.
  Layer Lock's *Next take* reads this field. Status only.
- **EDID builder.** The Claude browser pane opens `window.open` in the same tab, so the popout had
  no opener (*No Web RCS session*). It ran instead in an iframe over the Web RCS tab, booted with
  `bootPopout({ opener: parent })`: the same page. An EDID named LPP TEST (3840×2160 60, 256 bytes)
  saved to ED100 through `POST /api/device/edid/save`: the slot came back with the name and the
  vendor's EDID Bank showed it. As the simulator notes say, that route also loads the EDID into the
  switcher's editor and checks it: `edit/control/xCheck` and `save/…/100/xRequest` latched, and the
  editor's `isValid` went UNKNOWN → VALID. Undo: `xDelete`; the editor back to 512 zeros at "256";
  a valid one-block EDID (DEFAULT_DP_1080P's block 0, extension count 0, checksum redone) checked
  first so the extension lists went back to `[]`, then the zeros checked. `isValid` INVALID is all
  that differs; UNKNOWN can't come back. The name was set by script and only reached the bytes
  after Calculate; not checked by hand.
- **Test Card on Out 1.** On: S1 L4 (4K, the top layer) in preview as STILL_24 from library slot
  200, the *last* free still and slot, not the first. Program and the owner's three pictures in
  slots 1–3 untouched. It follows on the hardware: a pattern change uploaded into slot 200 again
  and the still's `newSnaphot` went 6 → 7, with no layer write. Off put L4 back to NONE, still 24
  back to NONE (source 1), and emptied slot 200. Left behind: still 24 `settings/xUpdate` and slot
  200 `control/xDelete` latched (re-armed by hand), the library import `cmd` path and slot (put
  back), and **the library's size counter, 91 → 354 kB, which the vendor's Image Library header
  shows**. It didn't drop when the slot was emptied: the guide's simulator note holds on a real
  frame, and every replaced upload stays counted. Whether a reboot gives it back is not known.
- **Image Library tools.** The header bar arrives once the store is in (about 20 s here). A zip
  built in the page (`lpp test 1/9/10.png`, a `__MACOSX/._` entry, `.DS_Store`, `notes.txt`) asked
  *Upload 3 pictures into slots 4–6?* and named `notes.txt` with its reason; the litter went
  unmentioned and the owner's slots weren't offered. Answered no: nothing written. **Not run:** the
  upload itself and Select-and-delete of it (Claude Code's auto-mode classifier refused the
  scripted yes as a write to a shared device; Allan's call), Delete all (never on this box), and a
  capacity change (Preconfig). The 24 capacity dropdowns render, one per still, reading Dual as the
  box does.
- **Put back after:** against the original baseline, 50 leaves differ. 48 are status: the earlier
  passes', plus the bank export's `ERROR_INVALID_PATH`, S1 L1–L2 `up` OPEN, still 24's and slot
  200's leftover sizes and names, the library size counter, and the EDID editor's `isValid`. (Of
  the earlier 34, the library's export path and its import path and slot are now put back, so 31
  remain.) Two are writable enums, left alone because writing one could fire it: the library's
  `export/cmd/xRequest` EXPORT_RENAME (from the second pass's image download) and
  `import/cmd/xRequest` SPECIFIC_SLOT.

## Triggers: OSC, MIDI over TCP, Art-Net and sACN out of a cue (2026-10-30, pretend receivers only)

Allan asked for a cue to drive the rest of the rig: unmute the desk, house lights down, Mitti
playing through the HyperDeck plugin, and everything put back when the deck says the video is over.
Timeline first; deeper integration later. Built as plugin `triggers`, off by default and in
`OFF_UNTIL_TESTED`. `docs/TRIGGERS.md` has the whole of it.

- **The hold lives on the server, not the page.** The cue fires in a page, but the back lines
  need no store, and the clip end is heard on the server's own deck link. So HyperDecks now
  provides a `decks` service (`list()`, `onEnded(fn)` → unsubscribe), and Triggers asks for it
  every second, so either plugin can be switched off and on in any order. Only `then go` needs the
  page that fired the cue, matched by a per-load id.
- **`then` runs only for an end the show reached by itself**, and only while the standby is still
  the cue after the hold's. Restoring `at next cue` or by hand leaves it, because the operator has
  already moved the stack. A GO pressed through a VT's end would otherwise skip a cue.
- **A hold is journalled before its go lines go out**, with each DMX channel's level from before.
  A hold found at startup is offered, never fired.
- **sACN priority is per universe.** 150 over a desk's 100 takes every channel, not only the ones
  set. `release` sends the three stream-terminated packets, which is the real hand-back. Art-Net
  has no equivalent; the node merges.
- **The offline guard now refuses UDP** to 6454, 5568, 10023, 2223, 53000 and 239.255.x.x, and TCP to
  51325. A datagram needs no answer to land, so an Art-Net test aimed at the LAN would set real
  lights without failing.

Verified: `test/triggers.test.js` (20): bytes against OSC 1.0 (read back through `server/osc.js`),
Art-Net 4, E1.31's fixed flags and lengths, MIDI and MSC. Sends go to pretend receivers on port 0,
keep-alive and fade steps are timed, and sACN termination is checked. Holds are ended by a timer,
the next cue, by hand, Restore all, and a clip ending on `tools/hyperdeck-sim.mjs --mitti` through
the real HyperDecks server half. The page half runs with a real `CueStack`: one POST per cue, then
GO only for its own hold and not once the stack has moved, and `/next` on the following cue.

In the browser, against the rack sim, the panel drew, a destination was added through its form,
a broken line was listed with its reason, and Test go reached `tools/trigger-sink.mjs`. The deck
list arrived through the service. The rack sim then stopped answering on :3000 and :10606 for about
40 minutes: `aw-livepremier-web` exited 1 with nothing but deprecation warnings on every restart,
while the Wine half stayed up, and came back by itself on its 26th restart.

Then, against it again, in the Timeline (main 5967c6c, the emulated Mitti, the pretend receiver):
the New cue form carries a Triggers field beside HyperDeck's, and the Actions column read the
typed text back (`Triggers VT audio, House down · restore when Mitti ends or after 30s then go`).
GO sent both unmutes. The 8 s clip ended 8.0 s later, the unmutes went back, the page GOed, and
cue 2's line went out, in the same millisecond. GO, then GO again by hand before the clip ended:
the restore still ran at the end, the log said *GO not done: the stack has moved on since*, and
cue 2's line went out once. With the house at full first, `@ 0 fade 2` stepped down every 40 ms
for 2 s, and on the clip end `@ before fade 2` stepped back up to 255.

While the rack sim was down, the live Aquilon C mini was tried first, with Allan's OK, from a
throwaway container. It was dropped before anything was added: the New cue form
always carries a preset recall, and the rack sim came back. Nothing was fired there. A cue holding
only plugin actions sends nothing to the switcher (`_fireNow` writes only recalls and takes), so a
Triggers-only cue would be safe on a live box. The form just can't make one.

**Not done:** no real desk, node, lighting desk or Mitti. Hardware MIDI ports (it would need a
native module in `devices/`), OSC over TCP, sACN per-address priority (`0xDD`), reading a desk's
state back for a real "previous", and firing triggers from anywhere but a cue are not built.

## grandMA3 through its own OSC feedback (2026-10-30, grandMA3 onPC and the simulator, no wing)

Started as a research question: could an Avolites Titan Mobile or T3, or an MA onPC wing, be a
control surface here, as the Barco EC and ATEM panels are? Both are USB peripherals that only their
own software talks to. The Avolites surfaces (VID 0x0AD9) have no public protocol and Titan has no
OSC. MA's onPC wings unlock parameters, so driving one would be impersonating a licence key. Not
done, and not to be. What MA does have is OSC playback feedback, so the plugin listens to the desk
instead. Avolites stays an Art-Net/sACN dummy-fixture job.

Found on this Mac, grandMA3 onPC 2.4.2.2 (Release), macOS 26.4.1:

- **Sequence 1 is `/14.14.1.6.1`**, not the manual's `/13.13.1.6.1`. `ObjectList('Sequence
  1')[1]:Addr()` agrees with the wire. Grand master is `14.13.2.1`.
- **Nothing arrived at first**: the OSC line's `PreferredIP` default `10.0.0.0/8` chose the
  Parallels bridge (10.211.55.2) as its interface. Setting `Interface` directly didn't stick;
  `PreferredIP` `127.0.0.1` did (interface 1.1), and packets came.
- **Shapes**: fader `,sif FaderMaster <via> <0–100>`, via 1 on screen or by command, 3 a physical
  fader (MA's manual; not seen). Knob `,sii`. Go+/Go−/Toggle `,sis <fn> 1 "<seq> <cue> <name>"`,
  sent only on press when fired by command. Flash and Temp `,si <fn> 1` then `0`.
- **app_terminal never exits at end of input.** Each `bin/ma3` call ran to its 60 s alarm, so the
  end-to-end run took five minutes for five calls.

End to end, onPC → OSC input on 127.0.0.1:9000 → grandma3 → the rack simulator (6.2.73): `Go+ Page
1.201` took S1; the executor fader 0 → 40 → 100 took it, 60 → 0 took it back; `Go+ Page 1.202`
cut. Nine messages received, two writes from the keys, two T-bar takes, nothing refused. The
replayed bytes do the same in `test/sim/grandma3.sim.test.js`.

**Not seen:** a wing (its faders' via 3 and their message rate), a desk, Windows onPC, any other
grandMA3 version, a real network.
