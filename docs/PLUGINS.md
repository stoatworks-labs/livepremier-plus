# Plugins

LivePremier Plus is being rebuilt as a set of plugins: every feature is one, any of them can be
switched off, and — once the later phases land — anyone can drop in their own. This document is
the design, and where the work stands. It becomes the authoring guide when user plugins arrive.

## Where it stands

| Phase | What | State |
|---|---|---|
| 0 | Every built-in feature described as a plugin and **switchable** | **done** |
| 1 | The plugin host (server and page), and Companion moved into it as the pilot | next |
| 2 | The self-contained features moved: Pixelhue, Edit page, VPU Map, Pitch, MIDI, Memories, Layer, layer names | planned |
| 3 | Contribution points, then the entangled features: Timeline and timecode, OSC input, Console, Layer Groups and Send-to, Matrix Routing | planned |
| 4 | **User plugins** loaded from the data directory; this guide; an example plugin | planned |

## Switching features on and off (Phase 0)

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

The switches are one setting, `plugins`, stored with the others in `settings.json` as
`{ "<id>": { "enabled": false } }`. Entries for plugins that are not installed are kept, so a user
plugin that is missing for a while comes back with its switch as you left it.

**Not plugins, and not switchable:** the proxy and socket relay, the setup page, the store mirror,
this settings page, and `/__lpp/settings`, `/status`, `/device` and `/awj`. Switching any of those
off would leave no way to switch it back on.

## What a plugin will be (Phases 1–4)

A folder:

```
plugin.json   { "id", "name", "version", "description", "apiVersion": 1,
                "requires": { "platforms", "capabilities", "plugins" },
                "enabledByDefault", "client": "client.js", "server": "server.js" }
client.js     export default function activate(ctx) { … }   // runs in the page
server.js     export default function activate(ctx) { … }   // runs in the app's Node process
```

**The built-in features become plugins through this same API.** That is the test of it: if a
built-in needs a private hook, the API is incomplete.

**In the page**, `ctx` carries the live session, the platform and its capabilities, `refresh()`,
namespaced storage and settings, and the ways to add things: `ui.sidebar`, `ui.tab`,
`ui.settingsSection`, `ui.install` (for decorating the vendor's own page), `provide`/`use` for
services other plugins share (layer names, groups, the cue stack, timecode), and `contribute`.

**On the server**, `ctx` gives `route()` (mounted under `/__lpp/<id>/…`), `stream()` (one live-update
helper in place of the five hand-written copies today), `service({start, stop, apply})` with its
lifecycle owned by the host, a settings schema, storage under the data directory, a section in the
one-file setup, one-shot AWJ exchanges, and `contribute`.

**Contribution points** are how plugins extend each other, and they replace three special cases in
today's code: `cueAction` (a new kind of thing a cue can do — Matrix Routing's feed and send are
hard-coded into the cue stack now), `oscAddress` (an address subtree — `/lp/matrix/…` is hard-coded
into the OSC server), and `consoleCommand` (a line prefix — the Console intercepts `/lp/matrix/` by
hand).

## Trust

**A plugin is trusted code.** Its server half runs inside this app's process with everything that
process can do — the switcher, the network, the disk — and Node has no sandbox worth the name. That
is the same model as Companion modules and editor extensions, and it was chosen deliberately over a
sandboxed design that could not drive the switcher.

So user plugins will be **off until you switch them on**, the card will say where each one came from
and that switching it on gives it full control, and nothing will be installed from the network.
Remember too that this app is already an unauthenticated route to the switcher (see *On binding
wide* in the README); a plugin's routes share that exposure.
