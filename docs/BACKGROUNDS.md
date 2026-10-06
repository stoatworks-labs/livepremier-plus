# Background Slicer

One picture, cut into a background for every output of one or more screens, pixel for pixel — and
put into the image library, the stills and a background set. Or, in the live-input mode, each
output's background fed from an input, with the output map the media server behind those inputs
needs to feed them, as files it can import.

**PLUS ▸ Background Slicer** (it pops out). The plugin is `plugins/bg-slicer/`.

> ⚠️ **Preview, off by default: never run against a real frame.** Every write it makes was proved
> on a LivePremier Simulator 6.2.73, and the geometry is tested pixel by pixel — but a simulator's
> outputs are a static picture, so a background written there cannot be seen, and nothing about a
> rotated, grouped, sliced or pitched output has been seen on hardware. The panel marks every
> output whose cut rests on an assumption. The procedure at the end proves it on a frame.

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
6. **Write.** A name for the sets and stills (16 characters, the switcher's limit), whether to load
   each set into its screen's preview afterwards, and — live mode — whether to load each input's
   EDID. It says what it will do and asks; then each step waits for the switcher's echo. A failure
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
| Load into preview | the preview buffer's (`presetBanks()`) `presetList/items/<letter>/layerList/items/NATIVE/source/pp/inputNum` = `NATIVE_<set>` | bundle; refused on the simulator (below) |
| Input EDID (live) | `inputList/items/<IN_n>/plugList/items/1/edid/cmd/fromTemplate/bankList/items/<1920_1080_60HZ>/pp/xApply` false, then true — or `fromCustom/…/<n>` for a custom output format | bundle |

Every `x…` trigger is pulsed false then true, as Web RCS pulses them. A library image is deleted by
pulsing `stillList/library/bankList/items/<slot>/control/pp/xDelete`.

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
| **Proven** — simulator | every write above in the stills mode, end to end, and its undo (the run below) |
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

## Writing to a simulator

Not yet run against the shared simulator: it is only written to when no other client is
connected. The write path is proved against a stand-in switcher in `test/bg-slicer.test.js`
(every write echoed, the order checked, the undo checked).

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
