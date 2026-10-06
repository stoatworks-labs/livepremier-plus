# Background Slicer

One picture, cut into a background for every output of one or more screens, pixel for pixel — and
put into the image library, the stills and a background set. Or, in the live-input mode, each
output's background fed from an input, with the output map the media server behind those inputs
needs to feed them, as files it can import.

**PLUS ▸ Background Slicer** (it pops out). The plugin is `plugins/bg-slicer/`.

> ⚠️ **Preview, off by default: never run against a real frame.** Every write it makes was proved
> on a LivePremier Simulator 6.2.73 — and, for a Midra 4K or Alta 4K, on the Midra 4K simulator
> 3.2.29 ([below](#midra-4k-and-alta-4k)) — and the geometry is tested pixel by pixel; but a
> simulator's outputs are a static picture, so a background written there cannot be seen, and
> nothing about a rotated, grouped, sliced or pitched output has been seen on hardware. The panel
> marks every output whose cut rests on an assumption. The procedures at the end prove it on a frame.

## Doing it

1. **Picture.** Choose an image or drop one; its pixel size is shown. In the live mode a content
   size stands in when there is none (the media server's canvas).
2. **Screens.** Any in-service screens. With more than one, **On each screen** places the picture
   on each separately; **Span selected screens** lays them side by side in order under one picture
   (each screen's place in the strip is editable — a gap, a step down).
3. **Placement.** Each screen's canvas, drawn as the Screens / Aux. page draws one, with its outputs
   on it — `Out 1 · 1920×1080 · HDMI`, the group and slice when there is one, `⟲90°` when rotated —
   and the picture over them. Drag it, type X / Y / W / H in canvas pixels, or **Fit**, **Fill**,
   **Stretch**, **1:1**, **Centre**. The fields are the same kind as Web RCS's own numeric fields, so
   sums work, and with the Variables plugin on so do `$S1.width/2` and your own `@gap`
   ([VARIABLES.md](VARIABLES.md)). An output drawn dashed
   in orange rests on an assumption (below).
4. **Plan — nothing is written yet.** Per screen, the background set it goes into (the first free
   one; any of the eight can be chosen, and one holding content says so). Per output: the raster, the
   connector, the free library slot and free still it will take, the still's capacity and what the
   output needs, the content (`STILL_n` / `LIVE_n`), what it replaces, and **pixel copy** or
   **resampled**. Problems stop it; warnings do not.
5. **Generate** (stills). One PNG per output, cut in the page; thumbnails; a zip of them. A colour
   for where the picture does not reach.
6. **Write.** A name for the sets and stills (16 characters, the switcher's limit), whether to put
   them into a background set at all (on by default; off leaves the images in the library and the
   stills, and touches no set), whether to load each set into its screen's preview afterwards, and —
   live mode — whether to load each input's EDID. It says what it will do and asks; then each step waits for the switcher's echo. A failure
   stops the run and lists what was written; **Undo what was written** takes exactly that back off.
7. **Media server.** The same map as files: see [Exports](#exports).

## What it writes, and in what order

Every path and sequence was read off the Web RCS 6.2.73 bundle (the code its own pages run) and
proved against the simulator. Nothing is written until **Write** is confirmed, and only free things
are taken: a library slot whose `isValid` is false, and a still that is fitted, enabled in the
applied preconfig, holds nothing (`mode` NONE, no valid image), is named by no background set and
claimed by no output. Re-checked just before writing — minutes may have passed.

| Step | How | Proven |
|---|---|---|
| Image into the library | `POST /api/device/images/upload`, multipart: `librarySlot` (1-based) and the file as `FILES`. The answer is `{ <file>: STILL_IMPORT_STATUS }`; only `FINISH` is success. One upload at a time — a second is answered 503, and is retried. | bundle + simulator |
| Still shows it | `stillList/items/<n>/control/pp/mode` = `IMAGE`, then `source` = the slot (the image picker's order), `rescale` = `NO_RESCALE`, `label` | bundle + simulator |
| Still capacity, if needed | `preconfig/stills/new`: `xCopyFromCurrent` pulse, each still's `control/helper/pp/format`, `xCheck` pulse; the switcher's verdict in `new/…/status/pp/{capability, global}`; then `xApply` pulse; `current` is the truth | bundle; simulator for the plain case |
| Set content | per output, as `axSetBackgroundSetOutputSource` does it: the replaced input or still's claim (`preconfig/backgrounds/inputList|stillList/<n>/control/pp/useOnOutput`) handed to the next output still using it or NONE, the new one's claim = the output key, then `…/backgroundSetList/items/<set>/outputList/items/<out>/control/pp/content`. **Immediate** — there is no apply step anywhere under `preconfig/backgrounds`. | bundle + simulator |
| Set label | `…/backgroundSetList/items/<set>/pp/label` (on `pp` itself, not a `control` node), 16 characters | bundle + simulator |
| Load into preview | the preview buffer's (`presetBanks()`) `presetList/items/<letter>/layerList/items/NATIVE/source/pp/inputNum` = `NATIVE_<set>` | bundle; the write echoes on the simulator, but its NATIVE layers are `OFF`, so the apply skips it there (below) |
| Input EDID (live) | `inputList/items/<IN_n>/plugList/items/1/edid/cmd/fromTemplate/bankList/items/<1920_1080_60HZ>/pp/xApply` false, then true — or `fromCustom/…/<n>` for a custom output format | bundle |

Every `x…` trigger is pulsed false then true, as Web RCS pulses them. A library image is deleted by
pulsing `stillList/library/bankList/items/<slot>/control/pp/xDelete`.

⚠️ **Each step waits for the switcher's own echo, not the mirror.** The page transport applies this
page's outbound writes to the store (`transports/page-socket.js`, so the panels follow the vendor UI
in the same tab), so a value written from the page reads back at once whether the switcher took it
or not. So every write above waits for the inbound frame with its path and its value (`wire.js`,
`inbound`) — on the simulator each came back exact in value and type (`source` a number, labels
with accents and a trailing space as sent) in 0.3–20 ms, and a refused one (a `mode` not in the
enum) never, while the mirror showed it. Two kinds of wait stay on the store, each for a reason:

- **A write of the value the switcher already holds is never echoed.** Such a path — judged from the
  mirror before sending, walking the write list in order, so a pulse from `true` still counts — is
  sent and not waited for (`wire.changedPaths`). The usual one is a still's `source`: every still
  on the simulator holds 1, and the first free library slot is 1.
- **What the switcher reports back** — a library slot's `isValid` after an upload or a delete, the
  capacity check's verdict in `new/status` and `new/…/status`, `current` after `xApply` — are values
  the page never writes, so the mirror only has them from the switcher.

After `xApply` the switcher reports `current` a moment before it clears `new/status/pp/hasChanged`;
the capacity step waits for both, or an Undo pressed straight away would refuse it as "changes
staged".

**Capacity is a shared budget, so the plan refuses rather than takes.** A still is chosen at the
output's own capacity when one is free; only when none is does a capacity change. The switcher's
`xCheck` decides what a bigger capacity displaces (the manual: capacity 2 takes the next slot; it
contradicts itself about 4), and if anything it would take out of service holds something, the
staged change is discarded with `xCopyFromCurrent` and nothing is applied. A capacity change is also
refused while Preconfig ▸ Images has changes staged by someone else (`new/status/pp/hasChanged`).
The format given to the helper is the output's own (`HDTV_1080P` gives a capacity that matches a
1080p output by construction), else an offered format of exactly the raster's size.

**A set on program is refused** unless the operator ticks that it may be written live: a set's
content is immediate, so the new background goes to air the moment it lands.

**The NATIVE layer.** A background set reaches a screen only through its NATIVE layer, and NATIVE is
a layer that costs mixers (AGENTS.md). On the simulator both screens' NATIVE is `OFF`, so a set can
be built there but not loaded; the panel says so, and the write skips the preview load for that
screen rather than writing a layer that does not exist.

## The geometry

Pure, in `plugins/bg-slicer/core.js`; the reasoning is at its head.

- **A background is 1:1 in the output's raster.** The manual calls the background layer
  "unscalable" (Aquilon User Manual v6.2, p.86) and the content's capacity must match the
  output's (p.101); the vendor's own thumbnail draws a background at its own size from the top-left.
  So each image is exactly `canvas/status/pp/{maxWidth, maxHeight}`.
- **An output is a group of connectors; its slices are those connectors.** `maxWidth × maxHeight`
  is the group's raster — one picture across them all ("does not need to be divided beforehand",
  p.80). Slice k (`canvas/status/slices/sliceList/items/<k>`, the first `slices/pp/count`) is
  connector k: `pp.left/top` its place in that raster, `aoi/pp.width/height` its size. On the
  screen canvas the output's rectangle starts at `canvas/status/pp/{left, top}`, and slice k sits at
  `(slice − boundingBox) × pitch`, `aoi × pitch` in size — the bundle's own arithmetic
  (`getGroupedOutputStatus`). Pitch is `canvas/cmd/pp/pitchRatioH/V` in thousandths, and a
  footprint is floored, as aquilon-pitch found.
- **Rotation is counter-clockwise** (`OUTPUT_ROTATION`; "if the physical displays are rotated at 90°
  clockwise, set 90°", p.88). The picture is turned in the raster so it reads upright on the
  turned display — the way the switcher turns its layers.
- **A cut is a list of blits** — picture rectangle → raster rectangle, with the rotation as an
  integer 2D transform (`blitTransform`). The page draws them into a canvas with smoothing off for an
  exact blit, after decoding the picture with no colour conversion
  (`createImageBitmap(file, { colorSpaceConversion: 'none' })`) — an ICC profile would otherwise
  change every "copied" pixel. `renderRGBA` draws the same blits on a raw buffer by nearest sampling;
  it is the reference.

**Exact means exact.** At a pitch of 1.000 and the picture at its own size on whole pixels, every
number is an integer and a cut is a copy. `test/bg-slicer.test.js` pushes a pattern whose every
pixel encodes its own coordinates through the plan and checks **every pixel** of every output: a
span of two screens, a placement off the corner (the background either side of the edge), a
two-slice output group on an offset canvas (no seam at the join), and each rotation. In a browser
(the Browser pane's Chromium, 2026-10-06) the panel's own PNGs of a 3840 × 1080 pattern spanned
over the simulator's S1 and S2 decoded back with zero differing pixels, and the canvas renderer
matched `renderRGBA` byte for byte at 90°, 180°, 270° with an offset placement and for a two-slice
group. Anything scaled — Fit, Stretch, a pitch ratio, a fractional placement — is resampled, and
the plan says **resampled**.

### Proven and assumed

| | |
|---|---|
| **Proven** — manual and bundle | 1:1 in the raster; one background per output group, at its leader; NATIVE_n is set n; set writes immediate; the claim bookkeeping; stills `mode` then `source`; `rescale` NO_RESCALE is "No rescale" (the other is "Downscale to capacity"); library sizes in KiB (950 MB = 972800); the upload route |
| **Proven** — simulator | every write above in the stills mode, end to end, and its undo (the run below); each one's inbound echo, exact in value and type, and silence for a refused write and for a write of the value already held |
| **Assumed** — shown on the output | more than one slice (only one full slice has been seen on a device); a pitch other than 1.000; **rotation — whether the switcher turns a background as well as its layers is not established: if it does, a rotated output's image comes out turned twice**; an output group's raster as its leader reports it |
| **Not handled** | DPH104 (DP box) slicing beyond what the slices report; clones and duplicates (skipped: they show their reference's picture); auxiliaries (a background set is a screen's) |

## The live-input mode

Each output's background is an input instead of a still: the plan names one per output (free and
fitted ones are suggested — on the output's own frame, not on air, and one already receiving the
output's raster and rate first, read through the dialect's `inputFormats`; one input per output), and the write sets each set's content to
`LIVE_n` with the same claim bookkeeping — the input's `useOnOutput` becomes that output. The
switcher's rule is that a live background must match the output's format ("same format
(resolution, rate and blanking)", p.101), so:

- **Load each input's EDID** (on by default) gives each input plug the switcher's own EDID for that
  output's raster and rate — `fromTemplate` keys are `<w>_<h>_<rate>`, `_RB` for reduced blanking,
  and `fromCustom` for a custom output format. No EDID is built here: the switcher builds it, as
  Inputs ▸ EDID's load-from-template does, so the media server is offered exactly the mode. Blanking
  is not compared; the plan shows the output's total for checking. An EDID load is not undone by
  Undo — the switcher keeps no "previous EDID"; reset the plug on the EDID page.
- **The media server plays the cut.** Each of its outputs is one switcher input, the size of the
  switcher output it backs, and what it plays there is exactly the image the stills mode would have
  cut. The plan's blits are its output map.

## Exports

One media-server output per switcher input (named `IN 5 → S1 Out 1`, after the cable), one region
per blit: a rectangle of the content to a rectangle of that output, with a rotation. Everything is in
pixels. **Everything (.zip)** carries all of it; each server's button downloads its own files.

| Server | What it gets | Imports? | Not verified |
|---|---|---|---|
| **Resolume Arena** | Advanced Output preset `.xml`: a Screen per media output (Virtual), a Slice per region, InputRect = content, OutputRect = output, a turned region as a turned quad | **yes** — Presets/Advanced Output | written by output-map, held to files a real Arena 7.27 wrote; no generated file opened in Arena yet |
| **disguise** | Feed Mapping table `.csv` (columns from disguise's help) | **yes** — `objects/Table/`, Feed Mapping ▸ Import from table | rotation units (written in degrees; the API's index is 0–3) |
| **Pixera** | feed-rect `.csv` in the layout of AV Stumpfl's example file | partly | whether the corner columns are pixels or normalised |
| **Hippotizer V4** | Video Mapper `.csv` (no header) | **yes** | rotation sense |
| **Millumin 5** | one `.svg` per media output (polygons), for Video Routing ▸ Import as SVG | partly — places the slices; the canvas crop of each is set by hand | the SVG shape was read off Millumin's own exporter |
| **TouchDesigner** | a tab-separated table for a Table DAT, with bottom-left `y` columns | no native import — a Crop TOP and an Over TOP per row | — |
| **QLab 5**, **Mitti**, **MadMapper**, **Watchout 7** | the universal pack and a recipe | **no** importable mapping (QLab's `.qlabsettings` and MadMapper's `.mad` are undocumented archives; Mitti's outputs are an equal grid; Watchout's show schema lives on a running system) | — |

The universal pack: `pixel-map.csv` and `pixel-map.json` (every region), `template-content.svg/.png`
(the content with every region outlined and labelled with its size and where it goes), and
`template-<output>.svg/.png` per media output, plus a README with each server's recipe. The PNG
templates are painted from the same shapes the SVG is written from.

The Arena writer is vendored from output-map (`src/vendor/output-map/`, `npm run sync:output-map`,
which bundles its TypeScript with output-map's own rolldown and adds no dependency here). Which
formats are real imports is the research written into `TARGETS` in `plugins/bg-slicer/exports.js`;
nothing there invents a format a server has not been seen to read.

## Writing to a simulator: what was done to prove it

2026-10-06, LivePremier Simulator 6.2.73 on 127.0.0.1:3000, with no other client connected (the
device's own header read "1 Client"), through the panel itself:

- **Stills.** A 3840 × 1080 pattern (every pixel encoding its own coordinates) spanned over S1
  (outputs 1 and 3) and S2 (output 2). Write: three PNGs into library slots 1–3, stills 1–3 set
  (`IMAGE`, slot, `NO_RESCALE`, label), the stills' claims, S1 and S2 set 1 filled and named, every
  write echoed — 0.5 s in all. The switcher reported every set output `isContentValid: true`, and
  `GET /api/device/images/download/<slot>` gave back **the same bytes** that were uploaded. Undo
  emptied the slots (a download then answers `ERROR_NO_STILL`; the library's size went back to 0),
  put the stills' mode, source, rescale and label back, cleared the content and labels and released
  the claims.
- **Live inputs** (EDIDs off — an EDID load cannot be undone): S1 Out 1 ← `LIVE_1`, Out 3 ←
  `LIVE_2`, S2 Out 2 ← `LIVE_4` (IN_3 was passed over: it is on air), each input claiming its
  output, `isContentValid` true; undone.
- **Capacity**, by `applyCapacities` directly: still 45 to `UHDTV_2160P` — the check said 4K and
  took still 46 out of service (`global: DISABLE`, empty), applied, `current` read 4K; put back to
  `HDTV_1080P`, and 46 came back. Then still 2 to 4K, which would take still 3 while it held an
  image: **refused**, the staged change discarded, nothing applied.

After it all, every value read before was read again and matched, with two exceptions that are the
simulator's: a deleted library slot keeps its last image's name and size in `status` (with
`isValid` false), and the `newSnaphot` counters had moved on. The `xDelete` triggers were set back
to false. The preview load was refused for both screens, correctly: their NATIVE layers are `OFF`.
A simulator's outputs are a static picture, so none of it could be *seen*.

**Re-proved on the switcher's own echo, later the same day** — the run above had waited on the
store, which the page's own outbound writes fill (see [What it writes](#what-it-writes-and-in-what-order)).
Same simulator, no other client connected (`lsof` on 3000 and 10606), over the device socket from
Node with the worktree's own write builders:

- **Each write on its own**, timed to its first inbound frame: still `mode` / `rescale` / `label`,
  set content and both kinds of claim, set label, the NATIVE source (on S1's preview, NATIVE `OFF`),
  `xDelete`, and both edges of every `xCopyFromCurrent` / `xCheck` / `xApply` pulse came back with
  exactly the value and type sent, in 0.3–20 ms (each pulse edge arrives twice). Silent: a `mode`
  not in the enum, and **every write of a value the path already held** — `source` = 1 to a still
  holding 1, an empty label to an empty label, `NONE` to an unclaimed claim.
- **The apply itself**: the real `Session` over a transport that folds outbound writes into the
  mirror as `page-socket.js` does, then `applyPlan` → `revert` for stills over S1 and S2 (three
  uploads, three stills, two sets named — 20 writes, 19 echoed, the twentieth still 1's unchanged
  `source`; 0.2 s; `isContentValid` true), the same for live inputs (IN_1, IN_2), and
  `applyCapacities` still 45 → 4K and back (46 out of service and back). Then the refused `mode`:
  the inbound wait answered false after 6 s, the store wait answered true, and the switcher's own
  store still said `NONE`.

A fresh snapshot then matched the first on every path touched (200 of them). The first apply run
found the `hasChanged` lag — its second `applyCapacities`, started at once, refused — and was put
back by hand before the fix.

## Midra 4K and Alta 4K

The same panel, and a different model underneath. A LivePremier cuts a background **per output**,
1:1 in that output's raster, into a still sized to it. A Midra or Alta has no stills and no
per-output images: it takes **one picture per screen** — the screen's canvas — through one of the
screen's four **Background Images**, and an **Auto Crop** background set lets the switcher cut it
for each output. `plugins/bg-slicer/mng.js` is the model and the plan, `apply-mng.js` the writes,
and `model.js` hands the panel whichever the store's dialect says. Everything was read off the
Midra 4K simulator 3.2.29's Web RCS bundle — the client its own Images and Background Sets pages
run, and the server behind its upload route — and its store; Alta 4K 1.3.7's bundle has the same
enums, attributes and upload handler, and its simulator the same store shape.

| | |
|---|---|
| **Background Image** | `screenList/items/<n>/backFrameList/items/1..4/control/pp/{librarySlot, mode, sizeH, sizeV, label}` — BKG1..BKG4. `librarySlot` is `"NONE"` or `"1"`..`"50"`; `mode` is `CENTERED`, `FULLSCREEN`, `CROPPED`, `1_1` ("1:1"), `CUSTOM` (`sizeH/V` apply only to `CUSTOM`). The switcher reports the size it shows the image at in `status/pp/{isValid, width, height}`. |
| **Background set** | `screenList/items/<n>/backgroundSetList/items/1..8/control/pp/{mode, singleContent}`. `SINGLE_AUTOCROP` ("Auto Crop"): `singleContent` is one input or one Background Image (`PRESET_FRAME_<k>`) for the whole screen. `MULTI_CUSTOM` ("Custom"): each output its own input, `…/outputList/items/<o>/control/pp/{multiContent, multiAlign}` — inputs only, the attribute stops at `INPUT_16`; `multiAlign` is one of nine positions, `TOP_LEFT` first. No label, no claims, no apply step. |
| **Loading a set** | `screenList/items/<n>/presetList/items/<UP\|DOWN>/background/source/pp/set` = `"NONE"` or `"1"`..`"8"`; the layer's `status/pp/{state, contentWidth, contentHeight}` beside it. |
| **Whether a screen can** | `preconfig/status/stateList/items/CURRENT/screenList/items/<n>/pp/backgroundLayerType`: `DISABLE`, `ONLY_FRAME`, `ONLY_LIVE`, `LIVE_OR_FRAME`. The vendor offers a Background Image only on the frame-capable two and an input — and so Custom at all — only on the live-capable two; the plan refuses the same. |
| **The image library** | `stillLibrary/bankList/items/1..50/status/pp/{isValid, isUsed, fileName, width, height, fileSize}`; per-file limits in `stillLibrary/import/status/pp` (18000 × 18000, 35 389 440 pixels, 25 MiB). No size budget is published. |
| **Geometry** | the canvas, `screenList/items/<n>/canvas/status/size/pp/{sizeH, sizeV}`; each output's place on it, `outputList/items/<o>/canvas/status/pp/{left, top, pitchedWidth, pitchedHeight}`, and the area of its raster that shows it, `{formatLeft, formatTop, aoiWidth, aoiHeight}` of `{maxWidth, maxHeight}`; pitch in `canvas/pitch/pp`. No rotation, slices or groups. |

### What it writes, and in what order

Per screen, each step waiting for the switcher before the next:

| Step | How | Proven |
|---|---|---|
| Image into the library | `POST /api/device/images/upload`, multipart, the file as `FILES` **and nothing else** — this platform's server imports every file with `AUTO_SLOT_WITH_DOWNSCALE` ("First Empty Library Slot with Downscale") and takes no slot. The answer is `{ <file>: STILL_IMPORT_STATUS }`: only `FINISH` is success; `FINISH_WITH_DOWNSCALE` (the switcher resampled it) is a failure here. The slot is read back, not assumed: the one empty before that now holds a file of this name — and it must be the slot predicted, at the canvas's size. | bundle (client and server) + simulator |
| A Background Image shows it 1:1 | `…/backFrameList/items/<k>/control/pp/librarySlot` = `"<slot>"` (the vendor's library picker sends just this), then `mode` = `1_1`, then `label`; then the frame's own `status/pp/{isValid, width, height}` must read the canvas size — the switcher's word that nothing is scaled | bundle + simulator |
| The set (stills) | `…/backgroundSetList/items/<set>/control/pp/mode` = `SINGLE_AUTOCROP` if it is not already, then `singleContent` = `PRESET_FRAME_<k>` — the vendor offers the drop only in Auto Crop, and its own reset puts content back before mode, which is Undo's order | bundle + simulator |
| The set (live) | `mode` = `MULTI_CUSTOM`, then per output `multiContent` = `INPUT_<n>` and `multiAlign` = `TOP_LEFT` | bundle + simulator |
| Load into preview | the preview buffer's (`MNG.buffers()`) `…/presetList/items/<UP\|DOWN>/background/source/pp/set` = `"<set>"`; for an Auto Crop set the layer then reports the canvas as `contentWidth/Height` (a note if not — what hardware reports there is not known). Skipped mid-take and on a screen with no background layer. | bundle + simulator |
| Input EDID (live) | `inputList/items/INPUT_<n>/plugList/items/<plug>/edid/cmd/pp/xRequestPrefFormat` = `NONE`, then the format (`1920_1080_50HZ`, `…_RB`, `CUSTOM_<n>` for a custom output format) — offered only when the plug's `edid/status/pp/prefFormatAvailable` lists it | bundle only — the simulator's plugs list none |
| Undo | each write put back to the value journalled beside it, newest first; then each uploaded slot emptied, `stillLibrary/bankList/items/<slot>/control/pp/xDelete` pulsed false then true, once no frame of ours shows it | simulator |

⚠️ **The library slot is the switcher's choice, and it does not look where it puts it.** An upload
goes into the lowest-numbered slot with `isValid` false — and a slot a Background or Foreground
Image still points at counts as empty. Seen on a simulator: S1's BKG1 pointed at empty slot 1; an
upload landed in slot 1 and S1's frame reported the picture at once. So the plan predicts the slot
(the first empty ones, in plan order — two screens, two uploads), **refuses** when any frame of any
screen points at it (Images: clear that frame, or fill the slot first), and the write checks the
prediction again just before each upload. `isUsed` follows a frame's reference only loosely (it
stayed true on an empty slot and cleared on an upload), so the plan reads the frames themselves.

⚠️ **Waiting for the switcher means its own echo, not the mirror.** The page transport applies this
page's outbound writes to the store (`transports/page-socket.js`, so the panels follow the vendor UI
in the same tab), so a value written from the page reads back at once whether the switcher took it
or not. On the simulator an accepted write came back inbound in about a millisecond, and a refused
one (a `mode` that is not in the enum) came back not at all while the mirror showed it. So every
Midra write waits for the inbound frame with its path and value (`wire.js`, `inbound`), and the
status checks — the library slot, the frame's size, the preview's content size — are values only
the switcher writes. The LivePremier apply now does the same, proved on its own simulator (above).
The Midra write lists already leave out a write of the value a path holds (`withBefore` in
`mng.js`) — which the LivePremier simulator never echoes; not tried on the Midra.

### What "pixel-exact" means here

This side of it is exact, and the switcher says so. The image is the canvas: cut from the picture
pixel for pixel when it is placed at its own size on whole pixels (`test/bg-slicer-mng.test.js`
checks every pixel of each canvas image, a span of two screens, a corner placement, and — done the
way the Web RCS draws Auto Crop — each output's crop of the image, including two outputs meeting at
a column with no seam), uploaded as PNG, shown `1_1`, and the frame must report exactly the canvas
size before the set is touched. In a browser the panel's own PNGs of a 2944 × 1080 pattern spanned
over S1 and S2 decoded back with zero differing pixels, and the library gave them back byte for byte.

The other side is the switcher's arithmetic and has not been seen. That Auto Crop lays the picture
over the canvas and gives each output its own rectangle is how the vendor's page draws a set, not
an observation; at a pitch of 1.000 that rectangle is the output's area of interest pixel for
pixel, and at any other pitch the switcher scales it — the plan says **1:1** or **scaled by the
switcher** on every output, in a table of the switcher's own rectangles. An output with an area of
interest smaller than its raster (the simulator's Out 2 shows 1024 × 640 of a 1920 × 1080 raster)
shows the canvas there and black around it, as drawn. In **Custom** the input is placed by
`multiAlign`; the slicer sizes the media server's output to the switcher output's own format, so
nothing should scale, and the region inside it is the area of interest — whether the alignment is
taken against the raster or that area is not established, and the plan marks it.

### What was done on the simulators (2026-10-06)

- **A private Midra 4K simulator 3.2.29** (Pulse 4K — a copy of the session, on its own ports),
  through the panel itself in the Browser pane: with S1's BKG1 pointing at empty slot 1, as on the
  shared simulator, the plan refused and **Write** stayed disabled. With that cleared, a 2944 × 1080
  pattern spanned over S1 (1920 × 1080) and S2 (1024 × 640): two uploads into slots 1 and 2, BKG1 of
  each at 1:1 (the switcher reported 1920 × 1080 and 1024 × 640), S1 set 2 (set 1 was on program, so
  passed over) and S2 set 1 in Auto Crop, both previews loaded (`contentWidth/Height` the canvases)
  — 0.7 s in all, each write waited on its inbound echo. `GET /api/device/images/download/<slot>`
  gave back the generated PNGs byte for byte. Undo put every value back and emptied both slots; a
  before/after read matched except `stillLibrary/import/cmd/pp/path`, which the vendor's server
  writes on every upload. Live: S2 set 1 Custom ← `INPUT_1`, preview, undone.
- **The shared simulator** (in use by another session; screen 2 only): the plan refused for the
  same reason and wrote nothing. Its library could not take an image by any route — its session
  directory had lost `AW_FRAME_LIB` to the system's temp cleaner, and every import answered
  `ERROR_NO_FREE_SPACE` — so the plugin's own write lists for S2 (BKG1 → a slot at 1:1 with a
  label, set 1 Auto Crop ← `PRESET_FRAME_1`, preview `UP` ← set 1) were sent through the page,
  read back off the device's store over HTTP, and `revertMng` put every one back. A before/after
  read of S1's and S2's frames, sets and preset backgrounds and of the library matched, except the
  import's read-only `status`.
- Simulator facts worth knowing: the import command (`stillLibrary/import/cmd/pp/{path, slot,
  xRequest}`) **moves** its file — the source is gone afterwards; a frame's reported size follows its
  mode (a 1024 × 640 image read 1728 × 1080 `CENTERED` on a 1920 × 1080 canvas, the canvas in
  `FULLSCREEN` and `CROPPED`, `sizeH × sizeV` in `CUSTOM`, its own size in `1_1`); an Auto Crop set
  reports the canvas as a preset's `contentWidth/Height` even when empty, a Custom one 0; the
  layer's `state` reads `OFF` throughout; and `/api/device/snapshots/screens/<n>/back/<k>` answers a
  256 × 160 placeholder on a simulator, not the image.

### Proven and assumed — Midra 4K / Alta 4K

| | |
|---|---|
| **Proven** — bundle | the upload route and its `AUTO_SLOT_WITH_DOWNSCALE` import; the frame, set and preset paths and enums; Auto Crop's content up to `PRESET_FRAME_4`, Custom's up to `INPUT_16`; the background layer types and what each allows; the EDID preferred-format request |
| **Proven** — simulator | every write above but the EDID, end to end, and its Undo; the auto slot landing on a slot a frame points at; the frame reporting 1:1 at the canvas; inbound echo of accepted writes and silence for a refused one |
| **Assumed** — shown on the output | Auto Crop gives each output its own rectangle of the canvas, as drawn; a pitch other than 1.000 (scaled by the switcher); an area of interest smaller than the raster; Custom's alignment against an area of interest |
| **Not handled** | auxiliaries (an aux has no background set); Foreground Images; one input across a whole screen in Auto Crop (the vendor offers it; the live mode here is an input per output) |

## Proving it on a frame

On a LivePremier with a screen whose NATIVE layer is allocated, out of a show:

1. Put a test pattern with a one-pixel grid (a crosshatch with labelled edges) into the slicer, 1:1,
   spanning two outputs that meet edge to edge. Write it, load the set into preview, and look at the
   join on the displays: no seam, no doubled or missing column.
2. A rotated output (Preconfig ▸ Outputs: enable rotation; Canvas: 90°): write the same pattern; the
   labels should read upright on the turned display. If they read turned by a further 90°, the
   switcher turns backgrounds itself — `ROTATION` in `core.js` must then not be applied to the cut.
3. A 2X1 output group: the picture should cross the two connectors without a seam.
4. A pitch ratio other than 1.000: the picture's scale on that wall should match the layers'.
5. Live: a media server loaded with the Arena preset into two inputs; the same joins.

On a Midra 4K or Alta 4K with a screen whose background layer takes stills, out of a show, and no
frame pointing at the library's first empty slot:

1. Two outputs edge to edge on one screen at pitch 1.000: a crosshatch with labelled edges, 1:1,
   Auto Crop, load the set into preview and take it. No seam, no doubled or missing column — that
   is Auto Crop cutting the way the Web RCS draws it.
2. An output with an area of interest smaller than its raster: the picture sits in that area, at
   `formatLeft/formatTop`, black around it.
3. A pitch ratio other than 1.000: the output's part is scaled to match the layers.
4. Custom: a media server loaded with the Arena preset into two inputs in the outputs' own format;
   the same joins, and nothing offset (the alignment is top left).
5. Read an input plug's `edid/status/pp/prefFormatAvailable`: if it lists formats, the live mode
   offers the EDID request, and the source should then offer exactly the output's mode.
