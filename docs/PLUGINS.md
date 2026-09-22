# Plugins

LivePremier Plus is being rebuilt as a set of plugins: every feature is one, any of them can be
switched off, and — once the last phase lands — anyone can drop in their own. This document is the
design, the API as it stands, and where the work is. It becomes the authoring guide when user
plugins arrive.

## Where it stands

| Phase | What | State |
|---|---|---|
| 0 | Every built-in feature described as a plugin and **switchable** | **done** |
| 1 | The plugin host (server and page), and **Companion moved into it** as the pilot | **done** — [checkpoint](#checkpoint-the-api-shape) |
| 2 | The self-contained features moved: VPU Map and Pitch Compensation (**done**), Pixelhue, Edit page | in progress |
| 3 | Contribution points, then the entangled features: Timeline and timecode, OSC input, Console, Layer Groups and Send-to, Matrix Routing — and MIDI, Memories, Layer and layer names, which turned out to share more than they looked (MIDI's port feeds the timecode source; Memories and Layer ride the pop-out machinery; layer names are read by five surfaces) | planned |
| 4 | **User plugins** loaded from the data directory; this guide finished; an example plugin | planned |

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
this settings page, and `/__lpp/settings`, `/status`, `/device`, `/awj` and `/plugins`. Switching any
of those off would leave no way to switch it back on.

## What a plugin is

A folder. The built-ins are under [`plugins/`](../plugins): Companion was the first to move there, then VPU Map and Pitch Compensation.

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

A built-in with a `server` or `client` is **hosted** — loaded by the plugin hosts exactly as a
plugin written by somebody else will be. One without is still wired into `main.js` and `proxy.js`
by hand, and moves in a later phase. A user plugin will carry the same fields in a `plugin.json`.

Everything in a plugin's folder with a web file type (`.js`, `.mjs`, `.css`, `.json`, `.svg`,
`.png`) is served to the page at `/__lpp/plugins/<id>/…` while the plugin is on — **except its
server entry**. Keep anything private out of a plugin's folder.

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
| `awj(messages)` | One AWJ exchange with the switcher — opened, used, closed. |
| `selfAddress(req)` | `{ host, port, loopback }`: the address a request arrived on, which is the one address this process is known to be reachable at. `loopback` is the warning that it will not reach across a room. |
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
| `settings.get()` / `settings.set(patch)` | This plugin's settings; `set` resolves with them as stored, which may differ if the schema corrected a field. |
| `kit` | The app's DOM helpers — `h`, `button`, `readout`, `sectionTitle`, `fill`, `icon`, `panel` — so a plugin looks like the rest of the app without importing files by path. What is in the kit is the stable surface; `/__lpp/src/…` is not. |
| `session`, `platform()`, `can(capability)`, `refresh()` | The live store mirror and what this switcher supports. An entry is only offered where every capability in the manifest's `requires` is there. |
| `url(path)`, `log`, `id`, `manifest` | |

**`order`** places an entry among the app's own, which are numbered in tens: in PLUS, Edit 10, VPU Map
20, Memories 30, Layer Groups 40, Matrix Routing 50 — and Companion asks for 60. On the strip,
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
  there because it is newer. Companion's three fields were the first.

A switch never wipes a plugin's settings, and saving its settings never flips its switch: a
settings save is merged one level deeper for `plugins`. A plugin that is not installed keeps its
entry — switch and settings — untouched, so one that is missing for a while comes back as you left
it.

## Trust

**A plugin is trusted code.** Its server half runs inside this app's process with everything that
process can do — the switcher, the network, the disk — and Node has no sandbox worth the name. That
is the same model as Companion modules and editor extensions, and it was chosen deliberately over a
sandboxed design that could not drive the switcher.

So user plugins will be **off until you switch them on**, the card will say where each one came from
and that switching it on gives it full control, and nothing will be installed from the network.
Remember too that this app is already an unauthenticated route to the switcher (see *On binding
wide* in the README); a plugin's routes share that exposure.

## Checkpoint: the API shape

Phase 1 is where the shape was set, and the shape is the expensive thing to change once plugins
written elsewhere depend on it. These are the calls made, for review before Phase 2 builds on them:

1. **Settings live in `plugins.<id>.settings`, with legacy keys lifted.** The alternative was to
   leave built-ins' settings at the top level for ever and namespace only user plugins — two models
   instead of one. Downgrading below the release that ships this loses the Companion address (the old
   build does not read the namespace); an upgrade loses nothing.
2. **Routes are `/__lpp/<id>/…`, and a manifest may move the base** (`routeBase`), so Matrix Routing
   can keep `/__lpp/matrix` when it moves in Phase 3.
3. **`kit` is the stable UI surface.** Built-ins still import `src/` freely; a user plugin that does
   is on its own.
4. **The page half applies on reload.** Live page switching is possible but would move sidebar
   entries under an operator's pointer.
5. **A plugin folder is served whole, bar its server entry.** Simpler than a `public/` subfolder;
   the price is that a plugin author must not keep secrets beside their code.
6. **No sandbox.** User plugins are trusted, off by default, and local-only.

Still open, and decided in the phase that needs them: contribution points (`cueAction`,
`oscAddress`, `consoleCommand` — Phase 3); storage under `<dataDir>/plugins/<id>/` and a section in
the one-file setup (Phase 2, when the first plugin with data of its own moves); and `provide`/`use`
for services one plugin offers another (Phase 3).
