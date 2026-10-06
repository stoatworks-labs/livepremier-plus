# Variables

Names for numbers, usable wherever a number goes — in the Console, in Web RCS's
own numeric fields, and in an OSC argument.

```
Set Screen 1 Layer 2 Size ($S1.width / 2) $S1.height       the Console
$S1.width/2                                                 a layer's width field
@gap*3                                                      a position field
/lp/screen/1/preset/a/layer/2/position/posH "@gap * 3"      OSC
```

Two kinds, told apart by their first character:

| | | |
|---|---|---|
| `$name` | **system** | Read off the switcher, live. Generated from what it has — the screens in service, each one's allocated layers, the fitted inputs and outputs — so a bigger rig has more of them. Read-only. |
| `@name` | **yours** | A number, or a sum over numbers and other variables: `@gap = 40`, `@half = $S1.width / 2`. Kept per switcher, and in the setup file. |

**PLUS ▸ Variables** lists both: an editor for yours, with what each comes to
right now, over a searchable table of the switcher's with their live values.
Click a system variable's name to copy it.

This plugin **reads only**. It never writes to the switcher; it changes what an
expression you typed evaluates to, and a field or a Console line still goes out
when you commit it and not before. That is why it is on by default, where the
plugins that act on their own ship as previews.

---

## The system namespace

Names are matched without regard to case — `$s1.WIDTH` is `$S1.width`. A value
is a number, or text (a label, a format's name), which is listed and shown but
refused inside arithmetic. Every reading is the switcher's word: nothing is
filled in with a default it did not report.

| Name | What it is | Unit |
|---|---|---|
| `$device.name` | the range as the switcher names itself — `AQUILON`, `Midra 4K` | text |
| `$device.model` | model code — `NLC_CMAX`, `PULSE` | text |
| `$device.firmware`, `$device.serial` | | text |
| `$device.screens`, `$device.auxes` | how many are in service | |
| **Screens and auxes** — `S1`…, `A1`…, in service only | | |
| `$S1.width`, `$S1.height` | the applied canvas — only while the switcher reports one | px |
| `$S1.label` | its label | text |
| `$S1.layers`, `$S1.outputs` | layers it has been given, outputs it drives | |
| `$S1.takeTime` | its take time (tenths on the wire) | s |
| `$S1.PGM.memory`, `$S1.PVW.memory` | the memory program / preview was recalled from | |
| **Layers, per role** — allocated layers only | | |
| `$S1.PGM.L2.x`, `.y` | the anchor point, as the X and Y fields show it | px |
| `$S1.PGM.L2.w`, `.h` | its size | px |
| `$S1.PGM.L2.opacity` | in the switcher's 0–256 | |
| `$S1.PGM.L2.source` | `LIVE_3`, `INPUT_2`, `NONE` | text |
| `$S1.PVW.L2.…` | the same in preview; `NATIVE` in place of `L2` where it is allocated | |
| **Inputs** — `IN1`…, fitted only | | |
| `$IN3.width`, `$IN3.height` | the format it is receiving | px |
| `$IN3.rate` | its field rate | Hz |
| `$IN3.valid` | 1 while a valid signal is present, 0 otherwise | |
| `$IN3.format`, `$IN3.label` | | text |
| **Outputs** — `OUT1`…, fitted only | | |
| `$OUT1.width`, `$OUT1.height` | the raster it drives | px |
| `$OUT1.rate` | its frame rate | Hz |
| `$OUT1.x`, `$OUT1.y` | where its footprint sits on its screen's canvas | px |
| `$OUT1.cw`, `$OUT1.ch` | the footprint — the raster with pitch applied | px |
| `$OUT1.screen`, `$OUT1.label` | the screen it shows, as the switcher names it | text |
| **Stills** — `STILL4`…, loaded only | | |
| `$STILL4.width`, `.height`, `.label` | | px / text |
| **Timers** — `TIMER1`… | | |
| `$TIMER1.state`, `.type`, `.label` | | text |
| `$TIMER1.value` | the switcher's own number, unconverted — LivePremier only | |

Both platforms speak the same names. A Midra 4K or Alta 4K has no NATIVE layer,
no layers on an aux and no timer value, so those variables do not exist there;
its rates are read in Hz where LivePremier's store has thousandths, and the
names come out the same.

### Three rules that are not negotiable

**A role is read, never assumed.** `PGM` and `PVW` name whichever buffer is on
air or pending *now*, and a take swaps them. They go through the one sanctioned
conversion (`presetBanks()` in `core/screens.js`), and **while a screen is
mid-take its role variables are refused** — "S1 is mid-take" — rather than read
from the buffer that was program a moment ago. A layer moved to the wrong place
on air is the failure this exists to prevent; the Layer panel and the gang keep
the same rule.

**Only allocated layers have variables.** A preset carries geometry for every
layer slot, allocated or not — on the simulator, S1's preset holds layer 2 at
full screen and layer 2 does not exist. A variable for it would read a
plausible stale rectangle with complete confidence. `$S1.PGM.L2.x` on a screen
without layer 2 says so.

**An unreported value is an error, not a default.** Web RCS draws a screen
whose canvas it has not been told as 1920×1080; a variable must not put that
into a field. A screen not in service, a canvas not reported, a buffer not
loaded from a memory — each is refused with that sentence.

---

## Your own

Add one in the panel, give it a name and a definition:

| Name | Definition | Value |
|---|---|---|
| `gap` | `40` | 40 |
| `half` | `$S1.width / 2` | 960 |
| `inset` | `@half - @gap * 2` | 880 |

- **A name** is letters, digits and `_`, starting with a letter, with dots
  between parts if you like (`wall.left`). At most 40 characters; unique, in
  any case.
- **A definition** is a number or a sum — `+ - * /`, brackets, numbers, `$` and
  `@` variables — evaluated live, so `@half` follows the canvas. One that does
  not evaluate is kept and says why in its Value column, the way a spreadsheet
  cell does.
- **Renaming** carries the name with it: every `@gap` in your other
  definitions becomes the new name. Typed Console lines and cues are not
  rewritten.
- **A cycle** — `@a` naming `@b` naming `@a` — is found before anything is
  evaluated, spelled out above the table, and every member says it is part of
  one. None of them has a value until it is broken.

They are kept **per switcher**, in `variables-<switcher>.json` beside the cue
stack, served at `/__lpp/variables` as `{ data }`, and written to the setup file
under `show`. A restore onto a backup frame puts them on that frame. As with the
cue stack, reload an open page after a restore.

---

## Where they work

### The Console

Anywhere a number goes in a Mynah line — a screen, a range end, a memory, a
source, an amount — with a `%` after it where a number would take one:

```
Set Screen 1 Layer 2 Size ($S1.width / 2) $S1.height
Recall Screen 1 Thru @screens Memory @opener
Set Screen 1 Layer 2 Size @third% 100%
Take Screen (@n - 1)
```

**Arithmetic goes in brackets.** Outside them `+` and `-` already mean a list
(`Screen 1 Thru 8 - 5`) or a sign, so `Take Screen 4 - 1` is still screens 4
without 1, and `Take Screen (4 - 1)` is screen 3. A fraction where something is
counted — `Screen (5 / 2)` — is refused rather than rounded.

The line resolves at **Enter**, against the store as it is then. Before Enter,
the feedback line names what each variable reads — `$S1.width = 1920`, or why
it reads nothing. The grammar is mynah's; see its
[SYNTAX.md](https://github.com/stoatworks-labs/mynah/blob/main/docs/SYNTAX.md#13-variables-and-arithmetic).
The popped-out Console has a **Variables** shelf beside Syntax: click a name to
put it on the line.

OSC typed at the Console takes variables in its argument, both kinds — the page
has the store.

### Numeric fields

The same fields [arithmetic](../README.md#arithmetic-in-numeric-fields) works
in: `$S1.width/2`, `@gap*3`, `($S1.PGM.L2.x + 100)`. The result is clamped to the
field's range and rounded to its step like any other. A variable that cannot be
read now is not applied: the field flashes amber and its tooltip says why for a
few seconds — "Not applied: S1 is mid-take".

Opacity and zoom are still excluded, for the reason the README gives.

### OSC over UDP — `@` only, and only without `$`

A numeric argument may be a string of arithmetic: `"@gap * 3"`, `"1080-80"`.
The OSC listener runs in the server process, which **holds no store mirror**,
so it cannot read `$S1.width` or which buffer is program. A system variable
over UDP is therefore refused with that reason, and so is an `@` variable whose
definition reaches one — `@half = $S1.width / 2` cannot be answered there.
User variables that reach only numbers and other user variables work, and
follow the panel: change `@gap` and the next packet uses it. This is the same
asymmetry, for the same reason, as `preview` and `program` in
[OSC.md](OSC.md). Variables never go in an address — the address is the target.

### Not yet

- **Cues.** A cue carries structured actions — a recall of slot 5, a take of
  S1 — not command lines, so there is nothing in one for a variable to stand in.
  A cue action that runs a Mynah line, resolved when the cue fires, is the
  natural next step and is not built.
- **Opacity and zoom fields**, as above.
- **Mynah's own app** supplies no variables; it says so when a line uses one.

---

## For a plugin

The page half provides the **`variables`** service. Ask for it when you need it
— `ctx.use('variables')` is null while the plugin is off.

| | |
|---|---|
| `list()` | every variable, `$` then `@`: `{ kind, name, group?, type?, unit?, description?, definition?, answer }` |
| `resolve('$S1.width')` | one variable by its written name: `{ ok: true, value }`, `{ ok: false, error }`, or undefined for a name nobody knows |
| `resolver()` | `(name, kind) => answer` — the shape mynah's `vars` and `core/expr.js` take. Fresh per call; hold it for one evaluation, not for ever |
| `evaluate(text)` | arithmetic over numbers and variables, as a field would: `{ ok, value }` or `{ ok: false, error }` |
| `onChange(fn)` | hear your own variables change; answers its own unsubscribe |

The server half provides **`variables`** too, with one method: `resolver()`
(async), the storeless resolver the OSC listener uses — `@` answered, `$`
refused.
