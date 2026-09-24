# Plugins

LivePremier Plus is a set of plugins: every feature is one, any of them can be switched off, and
anyone can drop in their own. This document is the authoring guide, the API as it stands, and how
it got here.

**To write one, start from [`examples/plugins/hello-switcher`](../examples/plugins/hello-switcher)**
and read [Adding your own](#adding-your-own) below.

## Where it stands

| Phase | What | State |
|---|---|---|
| 0 | Every built-in feature described as a plugin and **switchable** | **done** |
| 1 | The plugin host (server and page), and **Companion moved into it** as the pilot | **done** — [checkpoint](#checkpoint-the-api-shape) |
| 2 | The self-contained features moved: VPU Map, Pitch Compensation, the Pixelhue panel, the Console, Memories, MIDI Mapping, Field arithmetic, Layer, Layer names, Layer Groups, Send to and the Edit page | **done** |
| 3 | [Contribution points and services](#extending-each-other), then the entangled features: the Timeline, Timecode, OSC input, Matrix Routing and the setup file | **done** — every feature is a plugin |
| 4 | **User plugins** loaded from the data directory; this guide; an example plugin | **done** — ahead of phase 3, on the phase-1 API |

## Switching features on and off

**Preconfig ▸ LivePremier Plus → Plugins** lists every feature with a switch. The list is generated
from the manifests in [`src/core/plugins.js`](../src/core/plugins.js), so it cannot drift from the
app the way the hand-written one did.

- **Every built-in is on unless you switch it off**, so nobody upgrading loses anything.
- **Off means absent**: no sidebar entry or tab, no page decoration, no routes (they answer 404 and
  name the plugin), no background service (an OSC listener is closed, router and Companion
  connections are hung up).
- **The server half applies at once; the page applies on the next load**, and the card says so. A
  page that grew and lost entries under an operator's pointer would be worse than a reload.
- **Dependencies are honoured.** Send-to needs Layer Groups; switch Groups off and Send-to goes too,
  with "needs Layer Groups" beside it, and comes back when Groups does.
- **Present is not the same as active.** A plugin's switch says whether the feature exists at all. A
  feature's own switch — *Listen for OSC*, *Connect to a Companion* — still says whether it is
  running, and only matters while the plugin is on.

**Not plugins, and not switchable:** the proxy and socket relay, the setup page, the store mirror,
this settings page, and `/__lpp/settings`, `/status`, `/device`, `/awj`, `/plugins` and `/addresses`.
Switching any of those off would leave no way to switch it back on.

## What a plugin is

A folder. The built-ins are all under [`plugins/`](../plugins) — every feature this app has, from
the Console to Matrix Routing — and each is loaded exactly as a plugin of yours is. Companion was the
first to move there, as the pilot; the setup file was the last.

```
plugins/companion/
  server.js    the server half:  export default function activate(ctx) { … }
               and, optionally:  export const settings = { normalise, changed?, legacy? }
  client.js    the page half:    export default function activate(ctx) { … }
  …            anything else both halves import — Companion has core.js (shared, no I/O),
               link.js (server only) and panel.js (page only)
```

A built-in's **manifest** is its entry in `BUILTINS` in `src/core/plugins.js` — id, name, where it
appears, what it needs, and which files are its halves:

```js
{ id: 'companion', name: 'Companion', where: 'Sidebar, under PLUS',
  description: '…', server: 'server.js', client: 'client.js',
  requires: { capabilities: [], plugins: [] } }
```

Every built-in has a `server` or `client` half, or both; a manifest with neither would be a feature
wired into `main.js` or `proxy.js` by hand, which is what this layout exists to stop. A plugin of
your own carries the same fields in a `plugin.json`.

Everything in a plugin's folder with a web file type (`.html`, `.js`, `.mjs`, `.css`, `.json`,
`.svg`, `.png`) is served to the page at `/__lpp/plugins/<id>/…` while the plugin is on — **except
its server entry**. Keep anything private out of a plugin's folder.

**A panel that pops out into a window of its own** does it into a page in its folder. The window
has to be a document on this app's origin, because it drives the Web RCS tab's session through
`window.opener` rather than opening a connection of its own — so it is served from the folder, and
its Pop out button opens `new URL('./popout.html', import.meta.url)`. The page boots through
`bootPopout` in [`src/ui/popout.js`](../src/ui/popout.js), which borrows the vendor's stylesheet
and says so when the tab it came from closes; `buildSolo` fills the window with one panel.
[`plugins/memories/popout.html`](../plugins/memories/popout.html) is the whole of one. A window that
needs more of its plugin than the session — the Timeline's cue editor rewrites the stack — gets it
from `ctx.share(api)` in the page half: `bootPopout({ plugin: '<id>', build })` hands `build` that
object as `own`, and tells the operator the feature is not running if the tab has none.

## The server half

[`server/plugin-host.js`](../server/plugin-host.js) imports every hosted plugin's server half at
startup, switched on or not — a plugin's settings schema has to be known while it is off — and calls
`activate(ctx)` when it is switched on. **Importing the module must do nothing by itself**;
everything with an effect belongs in `activate`.

| `ctx.` | |
|---|---|
| `route(method, path, handler)` | An exact route at `/__lpp/<id><path>`. `handler(req, res, h)`, where `h` has `url`, `json(status, body)`, `readJson(limit)` and `readBody(limit)`. Throw `new ctx.HttpError(status, message)` to answer with that status; anything else thrown is a logged 500. A path the plugin has under another method answers 405. |
| `mount(prefix, handler)` | Every method and path at or below a prefix. `handler(req, res, { url, rest })`, `rest` being the request target below the prefix, query included. Companion's whole web UI is one mount. |
| `upgrade(prefix, handler)` | WebSocket upgrades at or below a prefix. `handler(req, socket, head, { rest })` returns the `{ socket, upstream }` it relayed; the host hangs it up when the plugin stops. |
| `stream(path, { onOpen })` | Server-sent events at `GET <path>`. Returns `{ send(event, data), size, end() }`; `onOpen(first)` may greet a page that has just connected with `first.send(…)`. |
| `settings.get()` / `settings.onChange(fn)` | This plugin's settings, and `fn(next, prev)` after a save that changed them — as the schema's `changed` judges. |
| `onDispose(fn)` | Run when the plugin is switched off or the app stops; last registered, first run. |
| `device()` | The switcher this app points at, `host:port`, or null. Read it per use; it changes. |
| `storage` | Documents of the plugin's own, JSON in and out: `load(name, { perDevice, device? })` and `save(name, data, { perDevice, device? })`. `perDevice` keys one by the switcher the app points at now, the way a cue list is — or by `device`, when that is given, as a setup-file restore onto a backup frame does. A missing or unreadable document loads as null. Null when the app has no data directory — answer 501 then, as the built-ins do. |
| `awj(messages)` | One AWJ exchange with the switcher — opened, used, closed. |
| `selfAddress(req)` | `{ host, port, loopback }`: the address a request arrived on, which is the one address this process is known to be reachable at. `loopback` is the warning that it will not reach across a room. |
| `contribute(point, spec)` / `contributions(point)` | Add to one of the server's [contribution points](#contribution-points) — `oscAddress`, `configSection` — or list what is there. Refused, saying why, for a malformed contribution, a clash, or a point that belongs to the page. |
| `provide(name, api)` / `use(name)` | Offer an object to the other plugins in this process under a name, or find one. [Services](#services). |
| `url(path)`, `log(msg)`, `id`, `manifest`, `apiVersion` | |

**The host owns the lifetime.** Everything a plugin registers is recorded, and switching it off
undoes all of it in reverse order: routes stop answering, streams end, relayed sockets close, and its
disposers run. Switched on again, it starts from nothing. A plugin that throws while it starts is
marked failed — the settings page and the log say why — and the rest of the app carries on;
switching it off and on again retries. A plugin that registers anything after it was switched off
gets an error rather than a route nobody can take down.

There is deliberately no handle on the HTTP server itself: a plugin that could add its own listener
could also leave it behind.

## The page half

[`src/ui/plugin-host.js`](../src/ui/plugin-host.js) reads `/__lpp/plugins` once at boot, imports the
page half of every plugin that is on, and calls `activate(ctx)`.

| `ctx.` | |
|---|---|
| `ui.sidebar(entry)` | A sidebar entry: `{ id, label, icon, render, order?, after?, submenuOf?, enabled?, busy? }` — the same shape as the app's own ([`ui/shell.js`](../src/ui/shell.js)). |
| `ui.tab(entry)` | A tab on the Screens / Aux. strip: `{ id, label, short, icon, render, order?, enabled?, busy? }`. |
| `ui.settingsSection(entry)` | A card on this app's settings page: `{ id, render, order? }`, `render()` returning one element — `kit.card(title, …)` makes it match the page's own. Drawn after the app's feature cards; a card that throws is replaced by a line saying so. The Pixelhue panel's is the example. |
| `settings.get()` / `settings.set(patch)` | This plugin's settings; `set` resolves with them as stored, which may differ if the schema corrected a field. |
| `kit` | The app's DOM helpers — `h`, `button`, `readout`, `sectionTitle`, `fill`, `icon`, `panel`, and the settings page's `card`, `note` and `picker` — so a plugin looks like the rest of the app without importing files by path. What is in the kit is the stable surface; `/__lpp/src/…` is not. |
| `session`, `platform()`, `can(capability)`, `refresh()` | The live store mirror and what this switcher supports. An entry is only offered where every capability in the manifest's `requires` is there. |
| `contribute(point, spec)` / `contributions(point)` | Add to one of the page's [contribution points](#contribution-points) — `cueAction` — or list what is there. |
| `provide(name, api)` / `use(name)` | Offer an object to the other plugins in the page, or find one — the app's cue stack is `use('stack')`. [Services](#services). |
| `share(api)` | Hand this plugin's own popped-out windows what they need — the whole of an object, where a service is the narrow face for everybody else. See the popout note above. |
| `url(path)`, `log`, `id`, `manifest` | |

The page halves start in dependency order: a plugin that lists another in `requires.plugins`
activates after it, so what that one provides is there to `use`.

**They start before the switcher has answered.** `ctx.session.store.ready` is false until the
store arrives, and the store fires `ready` when it does. A panel copes by drawing a waiting state;
anything that needs the screen list to set itself up waits for the event — Send to does, because
its menu has nothing to offer without one.

**`order`** places an entry among the app's own, which are numbered in tens: in PLUS, Edit 10, VPU Map
20, Memories 30, Layer Groups 40, Layer Lock 45, Matrix Routing 50, Audio Matrix 55 — and Companion asks for 60. On the strip,
Console 10, Timeline 20, Layer 30, Groups 40.

**`busy()`** holds every repaint off while it returns true — for a panel with a text field that
somebody is typing in, since a repaint rebuilds the field and takes the caret with it.

**A panel may redraw in place.** The app repaints on every frame the switcher sends, about once a
second. A panel whose `render()` returns **the element already on screen** is left where it is —
`Shell.refresh` and `TabHost.refresh` only swap a panel that hands back a new element. A panel with
anything stateful in it — above all an **iframe**, which reloads the moment it is detached — must
build its frame once and refill the parts that change. Companion's panel is the example; before this
rule its embedded editor reloaded every second it was open.

## A plugin's settings

A plugin keeps its settings in its own entry, beside its switch, never at the top level:

```json
"plugins": {
  "companion": {
    "enabled": true,
    "settings": { "companionEnabled": true, "companionHost": "127.0.0.1", "companionPort": 8000 }
  }
}
```

Its **schema** — `export const settings` from the server half — says what is allowed:

- `normalise(raw)` returns valid settings, filling defaults and correcting bad fields rather than
  refusing the file, like every other setting in this app.
- `changed(a, b)`, optional, says whether a change matters to the running plugin; without it, any
  difference does.
- `legacy`, for built-ins only, names top-level keys the feature used before plugins had a
  namespace. They are lifted into the namespace wherever they appear — an old `settings.json`, an old
  setup file, a caller still sending the old shape — and a lifted value wins, because it can only be
  there because it is newer. Companion's three fields were the first; the Edit page's
  `memoryImportDir` and OSC input's `oscEnabled`, `oscPort` and `oscBind` followed.

A switch never wipes a plugin's settings, and saving its settings never flips its switch: a
settings save is merged one level deeper for `plugins`. A plugin that is not installed keeps its
entry — switch and settings — untouched, so one that is missing for a while comes back as you left
it.

## Extending each other

A plugin can add to the app's features as well as beside them. The app's own features used to reach
into each other by name — the cue engine had Matrix Routing's two actions in its switch, the Console
intercepted `/lp/matrix/` by hand, and the OSC server took a hook only the matrix router could use.
Those were special cases only a built-in could have. Now the engine, the Console and the OSC server
ask a registry, and Matrix Routing contributes to it the way a plugin of yours would.

### Contribution points

A **contribution point** is a place in the app that takes additions from any plugin.
[`src/core/contributions.js`](../src/core/contributions.js) defines them:

| Point | Half | A contribution is |
|---|---|---|
| `cueAction` | page | `{ kind, label, run(action, { cue }), describe?(action), field? }` — a new thing a cue can do |
| `oscAddress` | server | `{ prefix, describe?, handle(address, args) }` — a subtree of OSC addresses |
| `configSection` | server | `{ key, group, label, perDevice?, byDefault?, export(device), import(data, device) }` — a section of the setup file |

**`cueAction`.** `kind` is the name a cue stores its action under — start it with your plugin's id
(`hello-switcher:say`), which also keeps it clear of everybody else's; the cue engine's own kinds are
refused. When the cue fires, `run(action, { cue })` is called in the order the cue lists its actions,
alongside the recalls and **before any take or cut in the same cue** — the take is deferred and yours
is not, which is what lets Matrix Routing put a signal on an input before anything switches to it. It
is not awaited: a throw or a rejected promise becomes a warning on the cue, like a failed write.
`describe(action)` is how the cue sheet says it, in the Timeline and in the editor.

**`field`** is how the cue editors offer your kind: one text field per cue, drawn in the Timeline's
pop-out editor and its *New cue* form under your `label`. `{ label, placeholder?, hint?,
parse(text), format(actions), pick?({ doc, text }) }` — `parse` answers the cue's actions of your
kind for what was typed (an empty list clears them) or throws a sentence the editor shows, having
changed nothing; `format` turns them back into text. What is typed replaces your kind's actions
**where the first of them stood** and leaves every other action alone (`fieldActions` in
`contributions.js`). `pick`, when given, gets a *Choose…* button beside the field: draw your
chooser in `doc` — the editor's own document, which may be a popped-out window's — and resolve with
the field's new text, or null. Companion's *Companion trigger* is the example: `page/row/column`
text, and a chooser that is its button grid.

A cue can hold an action whose plugin is off — a cue file from another machine, or a plugin switched
off since. It stays in the cue, listed by its bare kind, and firing the cue warns *Nothing handles
"…"* rather than dropping it without a word. A kind with no `field` still gets into a cue only from
a cue file (Timeline ▸ Export / Import).

**`oscAddress`.** `prefix` is an address ending in `/` — `/hello/` — and `handle(address, args)` is
called for any address at or below it, whether it arrived over UDP or was typed in the Console. It
answers `{ ok: true, summary?, count? }`, `{ ok: false, error }`, or **null to decline**, in which
case the address goes on to the switcher's own. `describe` is one line for a listing. The longest
prefix wins, so a plugin can answer `/a/` and — itself — `/a/b/` differently.

The rules, each one there to stop a plugin quietly taking something over:

- **No two plugins share a kind or overlap an address space.** A second is refused, naming the first.
- **`/lp/…` is the switcher's address space.** Only a built-in may answer under it — Matrix Routing's
  `/lp/matrix/` predates the rule — so no plugin can take `/lp/screen/…` away from the switcher.
- **Each half has its own points.** A `cueAction` made from a server half is refused, and so is an
  `oscAddress` made from a page half, each saying which file it belongs in.
- **Switching a plugin off takes its contributions with it**, the same moment its routes go.

What is answered on an install, and by whom, is at `GET /__lpp/addresses`; the Console reads it,
and sends a line in one of those subtrees to `POST /__lpp/addresses/run` so a typed line and a UDP packet
take the same path.

**`configSection`.** A section of the setup file, `livepremier-plus.json` — what the Setup file
plugin writes at `GET /__lpp/config` and restores from `POST /__lpp/config`. `key` is its name in the
file and in a restore's `sections`; `group` is where it sits: `installation` for what belongs to this
machine, `show` or `rig` for what belongs to one switcher, which `perDevice` says. `export(device)`
answers the section, or undefined when there is nothing to write — a restore then leaves that
section alone, where an empty one would wipe it. `import(data, device)` puts it back **for the
switcher it is given**, which a restore onto a backup frame makes different from the one the app
points at now; when it is the same, put it into the running feature as well as its file, or the next
save of the stale copy undoes the restore. `byDefault: false` keeps a section out of a restore that
did not name it — the app's own settings are the example, because they carry the OSC port. A
section whose plugin is off is neither written nor restored; the restore reports it as skipped.
`server/documents.js` has `documentSection`, which is all the Timeline, Layer Groups and Layer names
needed; Matrix Routing's two are written out in full.

### Services

A **service** is an object one plugin offers the rest, under a name: `ctx.provide(name, api)` in the
plugin that has it, `ctx.use(name)` in the one that wants it. It is how a plugin gets at another's
state without importing its files.

- **One provider per name.** A second is refused rather than silently replacing the first.
- **`use` answers null** while nobody provides the name or its provider is off — check for it. List
  the provider in `requires.plugins` if you cannot work without it.
- A service goes when its provider is switched off or fails to start.
- Each half has its own services; the page's are not the server's.
- **Ask for a service when you need it, not once when you start.** Plugins start in the order of
  `requires.plugins`; one you do not list may start after you, or not at all. The Layer tab asks
  for `names` each time it draws, which is how it shows a Name field when Layer names is on and
  none when it is off.

**What the app offers on the server:** **`app`** — `settings()`, `applySettings(patch)` (merged and
applied exactly as `PUT /__lpp/settings` would), `version`, `platform()` and `hasStorage`. The Setup
file restores `installation.settings` through it, so a restored setting reaches the running app.
Also `bind` and `port` — where the app listens — `appliance`, true when it was started with
`--appliance`, and `listen(address)`: the same server answering on one more address of this host at
the app's own port, resolving `{ address, port, close() }`. It is the one way to a listener, and the
app closes any door still open when it stops; close yours in `onDispose` when your plugin does.
Remote access opens one per ZeroTier or tailnet address.
**`devices`** — the device host (`devices/README.md`), the process that holds USB and HID panels.
`status()` is `{ installed, running, available, reason, restarts, modules }`, and `onStatus(fn)`
hears it change. `module(id)` is a handle on one device module that outlives the host restarting:
`state` (the driver's own, `present` and `connected` at least), `available`, `want(bool)` to have
the host open the device or let it go, `write(reports)` for output reports, each a list of bytes
with the report id first (resolving how many went), and `on('state' | 'report', fn)`, which
answers its own unsubscribe. Open a device only while your page is using it. The Speed Editor is
the example: its `/driver` lease says when. With no host installed it answers all of this with
`available: false` and a `reason` to show.
**`companion`**, from Companion — `press(locations)`, each `{ pageNumber, row, column }`, pressed
over the link Companion's plugin already holds and answering `{ ok, results, error }`, and
`connected`. The Pixelhue panel sends a console's cue transport keys through it when told to.

**What the app asks for on the server:** **`snapshots`** — `serve(req, res, url)`, answering a
`GET /api/device/snapshots/…` in the proxy's place and resolving `true`, or `false` to have the
proxy relay it to the switcher as it always did. With no provider, or its provider off, the proxy
never asks. The Thumbnail relay is the one there is.

**What the built-ins offer in the page:** **`names`**, from Layer names — `get()` the whole
`{ 'S1/2': 'IMAG' }` map, `rename(id, layer, value)`, `describe()` for what the vendor-page labels
found; **`groups`**, from Layer Groups — `list()`, `recent()`, `remember(target)`, `load()`, and
`expect(cmds)` to tell the gang a whole group was just written so it lets the echoes pass;
**`locks`**, from Layer Lock — `list()` the locked `S1/2` keys and `takeOnly([{ id, layer }])`,
which takes those layers alone and answers `{ ok, message }`;
**`timecode`**, from Timecode — `{ source, chase }`, the clock and the chase the Timeline draws;
**`matrix`**, from Matrix Routing — `describeSurfaces()`, what its Router tabs found on the vendor's
pages; and
**`stack`**, the cue stack, owned by the Timeline —
`go()`, `back()`, `stop()`, `gotoId(id)`, `fire(id)`, `standby`, `cues()` (copies), and
`addEventListener`/`removeEventListener` for its events (`fired`, `took`, `armed`, `changed`,
`stopped`, `end`, `warning`, `sendFailed`). It is narrow
on purpose: moving through a show and hearing it move, not rewriting it.

The example plugin uses all three: a cue action (`hello-switcher:say`), an address (`/hello/ping`,
answered with the greeting — type it in the Console) and the `stack` service (its panel shows the
standby cue).

## Adding your own

A plugin of your own is a folder in the **`plugins` folder of the app's data directory**:

| Running as | Folder |
|---|---|
| the desktop app, or `npm start` | `~/.livepremier-plus/plugins/<id>/` |
| Docker | `/config/plugins/<id>/` (on the volume) |
| `--data <dir>` | `<dir>/plugins/<id>/` |

1. Copy [`examples/plugins/hello-switcher`](../examples/plugins/hello-switcher) there, and rename
   the folder and the `id` together.
2. **Restart the app.** Plugin folders are read at startup.
3. Open **Preconfig ▸ LivePremier Plus → Plugins**. Yours is under *Added by you*, **switched off**.
   Switch it on — you will be asked, in words, whether you trust it — and reload the page.

Its server half starts the moment it is switched on; **nothing in the folder is imported before
that**, so copying a plugin in does not run it. A folder that is not a plugin yet is listed with the
reason — no `plugin.json`, a typo in it, an id that is taken — so the settings page is where to look
when one does not appear.

### `plugin.json`

```json
{
  "id": "hello-switcher",
  "name": "Hello, switcher",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "An example plugin: a page in the sidebar, a card in settings, a route, a live stream, a cue action and an OSC address.",
  "where": "Sidebar, under PLUS, and a card in Settings",
  "server": "server.js",
  "client": "client.js",
  "requires": { "capabilities": [], "plugins": [] }
}
```

- **`id`** — lower-case letters, digits and dashes, and **the same as the folder's name**. It is the
  base of the plugin's routes, `/__lpp/<id>/…`, so the app's own route names and every built-in's id
  are refused.
- **`name`**, **`version`** — shown on the settings page.
- **`apiVersion`** — the plugin API it was written against. This build speaks **1**; a plugin asking
  for more is listed and refused rather than half-loaded.
- **`server`**, **`client`** — its two halves, as paths inside its own folder. At least one.
- **`requires.capabilities`** — platform facts, from `src/core/platform.js` (`vpuMap`,
  `layerProperties`, `cueStack`, `matrixRouting`, …): on a switcher without one, the plugin's entries
  are not offered. **`requires.plugins`** — other plugins' ids it cannot work without.

Whatever the file says, a user plugin **starts switched off**, cannot move its routes off
`/__lpp/<id>`, and has no `legacy` settings — those exist for built-ins' history.

### What you can rely on

The `ctx` tables above are the API, and `kit` is the page's stable surface. Importing the app's own
files by path (`/__lpp/src/…`, `../../src/…`) works — the built-ins do it — but those files are not
an interface and can move in any release.

## Trust

**A plugin is trusted code.** Its server half runs inside this app's process with everything that
process can do — the switcher, the network, the disk — and Node has no sandbox worth the name. That
is the same model as Companion modules and editor extensions, and it was chosen deliberately over a
sandboxed design that could not drive the switcher.

So user plugins are **off until you switch them on**, the card says where each one came from, switching
one on asks first and says that it gives the plugin full control, nothing of a plugin runs before it
is switched on, and nothing is installed from the network.
Remember too that this app is already an unauthenticated route to the switcher (see *On binding
wide* in the README); a plugin's routes share that exposure.

## Checkpoint: the API shape

Phase 1 is where the shape was set, and the shape is the expensive thing to change once plugins
written elsewhere depend on it. These are the calls made, for review before Phase 2 builds on them:

User plugins shipped (phase 4) before this review happened, so these are also what a plugin written
today depends on. Nothing has been released with them yet; changing any of them now costs a rewrite of
the example and the built-ins, not of anybody else's plugin.

1. **Settings live in `plugins.<id>.settings`, with legacy keys lifted.** The alternative was to
   leave built-ins' settings at the top level for ever and namespace only user plugins — two models
   instead of one. Downgrading below the release that ships this loses the Companion address (the old
   build does not read the namespace); an upgrade loses nothing.
2. **Routes are `/__lpp/<id>/…`, and a manifest may move the base** (`routeBase`), so a feature
   keeps the address it had: Layer Groups answers at `/__lpp/groups` and the Edit page at
   `/__lpp/memory`, and Matrix Routing will keep `/__lpp/matrix`.
3. **`kit` is the stable UI surface.** Built-ins still import `src/` freely; a user plugin that does
   is on its own.
4. **The page half applies on reload.** Live page switching is possible but would move sidebar
   entries under an operator's pointer.
5. **A plugin folder is served whole, bar its server entry.** Simpler than a `public/` subfolder;
   the price is that a plugin author must not keep secrets beside their code.
6. **No sandbox.** User plugins are trusted, off by default, and local-only.

Added in Phase 3, for the same review:

7. **Two contribution points, not three.** The plan had a `consoleCommand` point as well; the Console
   already hands anything that looks like an address to the OSC path, so a plugin's `oscAddress` is
   its console command too, and one point means a typed line and a packet cannot drift apart.
8. **`/lp/` is reserved for built-ins, and address spaces may not overlap.** The cost: a plugin that
   wanted to extend the switcher's own grammar cannot. That grammar is mynah's, stated in one place.
9. **A contributed cue action is not awaited, and runs ahead of the take.** Awaiting would let one
   slow router hold a cue's take hostage; running after the take would put the wrong source on air
   for the length of the transition.
10. **Services are one provider per name, found at call time.** No versioning of a service yet — a
    service that changes shape changes its name.
11. **A built-in's documents stay where they always were; a user plugin's go in
    `<data dir>/plugin-data/<id>/`.** Not `<data dir>/plugins/<id>/` as first planned: that is the
    plugin's code folder, and everything web-typed in it is served to the page. The price of the
    first half is that a built-in's document names share a folder with the app's own files, so
    `settings` and `device` are refused.
12. **A plugin's own windows get the whole object; everybody else gets a service.** `ctx.share` is
    for a popout of the same plugin — the Timeline's cue editor needs the stack itself — so the
    narrow `stack` service did not have to grow an editing API to serve one window.
13. **The Console's path to plugins' addresses is the app's own, at `/__lpp/addresses`.** It was
    `/__lpp/osc/…` until OSC input became a plugin with `/__lpp/osc` as its base: under it, switching
    the UDP listener off would have cut the Console off from Matrix Routing too.

14. **The setup file is assembled from `configSection` contributions**, and the app's settings are
    a section like the rest, through the `app` service. The format did not change. What it bought
    is a restore that reaches the running feature: before, the proxy's in-memory routers, patch and
    settings kept their old values after a restore, and the next save wrote them back over it.

Still open:

- **A page open during a restore keeps what it loaded** — a cue stack, the groups, the names — and
  its next save puts that back. The restore's answer carries `reloadPages: true` and the user guide
  says to reload; a page that noticed by itself would need a stream for it, and the page has only
  six connections to share.
- **A contributed cue action is one text field, not a form.** `field` (added after 0.13.0, for
  the Companion trigger) covers a kind whose actions read naturally as a line of text. A kind that
  needs several inputs per action — a router's source *and* destination — still arrives from a cue
  file; a `fields` list is the likely next shape if one needs it.
