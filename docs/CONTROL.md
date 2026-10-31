# Control API

The **Control API** plugin is how something outside a browser runs the parts of this app that
live in the page: the Timeline, Timecode chase, Layer Lock, Send to (Layer Groups), the Console
and your `@variables`. The [LivePremier Plus Companion module](https://github.com/stoatworks-labs/companion-module-livepremier-plus)
is its first client; anything that speaks HTTP can be another.

It's **off until you switch it on**, in Preconfig ▸ LivePremier Plus → Plugins.

## Why a page runs it

This app keeps no copy of the switcher on the server. `server/awj.js` explains at length why
not, and the short version is that two copies of the truth disagree eventually. The Timeline,
the locks and the groups all work on the store an open Web RCS page holds. So an action from
outside is handed to **one** open page, the one holding the lease, and that page runs it exactly
as its own buttons would. Preview lock, Layer Lock and the padlocks see it the same way.

With no page open there is nobody to run it, and the request says so in those words. Open Web
RCS through this app and leave it open. A tab in the background is fine.

What already has a route of its own isn't repeated here: Matrix Routing, the HyperDecks,
Triggers and the plugin switches have theirs (`/__lpp/matrix/…`, `/__lpp/hyperdeck/…`,
`/__lpp/triggers/…`, `PUT /__lpp/settings`), and they work with no page open at all. So does
`POST /__lpp/addresses/run`, which runs any plugin address as OSC input would.

## For a client

All JSON. Every refusal carries an `error` sentence written for whoever pressed the button:
show it as it is.

### `POST /__lpp/control/do`

```json
{ "action": "timeline.goto", "args": { "cue": "12a" } }
```

| Answer | Means |
|---|---|
| `200 {ok: true, action, result, error: null}` | The page ran it. `result` is what it had to say, often `null`. |
| `409 {ok: false, error}` | The page refused it ("there is no cue 9", "PGM is locked on S1"), or no page is open. |
| `400 {ok: false, error}` | No such action, or its arguments don't make sense. Nothing was sent to a page. |
| `504 {ok: false, error}` | The page didn't answer within 4 seconds. It may still have run it. |
| `404` | The Control API is switched off. |

### The actions

| Action | Args | Does |
|---|---|---|
| `timeline.go` | — | GO: fire the standby cue, then advance. During a pre-wait, fires it at once. |
| `timeline.back` | — | Move the standby back one cue, firing nothing. |
| `timeline.next` | — | Move the standby on one cue, firing nothing. |
| `timeline.first` | — | Make the first cue the standby. |
| `timeline.stop` | — | Cancel a pending pre-wait or follow. A cue already fired stays fired. |
| `timeline.goto` | `cue` | Make that cue the standby. |
| `timeline.fire` | `cue` | Fire that cue now, wherever the standby is. The standby doesn't move. |
| `timecode.chase` | `on` | Arm, disarm or toggle the Timeline's timecode chase. |
| `console.run` | `line` | Run a line exactly as if typed at the Console: Mynah, raw AWJ or a plugin address. |
| `locks.set` | `target`, `on` | Lock, unlock or toggle a layer or every layer of a group. Toggle locks all unless all are locked. |
| `locks.take` | `target` | Take only that layer, or that group on each of its screens. |
| `groups.send` | `source`, `target`, `mode` | Put a source on a layer or group, `PREVIEW` (the default) or `PROGRAM`. |
| `variables.set` | `name`, `value` | Give an `@variable` a new definition, adding it if it's new. |

- **`cue`** is the number the Timeline shows: `3` matches `3.0` and `03` but not `3.5`; `12a`
  is fine. A cue with no number answers to its place in the list.
- **`on`** is `on`, `off` or `toggle` (the default). `true`/`false`, `lock`/`unlock` work too.
- **`target`** is a layer as `S1/2` (screen 1, layer 2), `S1 L2`, `A1/1` for an aux layer or
  `S1/native`, or a layer group by its name, in any case.
- **`source`** is an input number (`3`), `IN3`, `IMG2` for a still, `NONE`, or the switcher's
  own spelling. A send is refused while the padlock it would write past is shut on that screen,
  as the `…` menu would ask first and there's nobody here to ask. Preview lock shuts the preview
  padlock during a take, so with it on, a preview send is refused until the take lands.
- **`value`** for a variable is a number or arithmetic over other variables, `@gap * 2`. It is
  kept as typed even when it doesn't evaluate, as the Variables panel keeps it, and `result`
  says what it came to: `{name, value, error}`.

### `GET /__lpp/control/state` and `GET /__lpp/control/events`

`/state` answers once; `/events` is server-sent events, a `state` event straight away and
another whenever the page reports a change or the lease moves. Both carry:

```json
{
  "version": 1,
  "page": true,
  "at": 1793459190267,
  "state": {
    "timeline": {
      "name": "Main", "count": 4, "running": false,
      "standby":  { "id": "c2", "number": "2", "label": "Opener", "enabled": true },
      "next":     { "id": "c3", "number": "2.5", "label": "Logo sting", "enabled": true },
      "previous": { "id": "c1", "number": "1", "label": "Walk-in", "enabled": true },
      "last":     { "id": "c1", "number": "1", "label": "Walk-in", "at": 1793459188000 },
      "waiting": [],
      "cues": [ … the first 200, as above … ]
    },
    "timecode": { "armed": false, "source": "none", "running": false, "value": null },
    "locks": ["S1/1"],
    "groups": [{ "name": "Side screens", "gang": false, "members": ["S1/1", "S2/1"] }],
    "variables": [{ "name": "gap", "value": 40, "error": null }]
  }
}
```

`/state` adds `actions`, the table above as `{name, plugin, describe}`. `page` is false and
`state` null while no page holds the lease: the last report from a page that has gone is
history, not the show. A part is missing when the plugin behind it is off. `timecode.value` is
`hh:mm:ss`, whole seconds, because a report isn't a timecode feed. `running` is a pre-wait or
follow counting down, and `waiting` lists cues held back by Preview lock until a take lands.

`version` is this contract's. It goes up when something here changes in a way a client would
notice.

## For the page (not a client's business)

| Route | |
|---|---|
| `GET /stream?page=<id>` | Server-sent `lease` and `command` events. Every page gets every command; the one named in `runner` runs it. |
| `POST /runner {id, release?}` | A page's beat, every 4 seconds, or its letting go on the way out. |
| `POST /result {id, ok, result, error}` | A page's answer to one command. |
| `POST /report {page, state}` | The show as the page sees it. Only the lease holder's is kept. |

**The lease is held by the page's open stream**, as well as by its beat. A browser slows the
timers of a tab hidden for a while to about one tick a minute, and a beat alone would then miss
its 12-second lease and lose it to nobody, the moment the Web RCS tab went behind the cue sheet.
An open stream doesn't slow down. When the holder's stream closes, the lease goes at once to the
oldest page still listening.

## Safety

Like everything else under `/__lpp`, it's unauthenticated. Anyone who can reach this app can
GO the stack with it. On the default loopback binding that's only this machine; read *On binding
wide* in the user guide before you change that, which is what Companion on another computer
needs.

## Testing it

`test/control.test.js` covers the action table, the lease and the relay with a stand-in page.
The page half needs a store and a DOM, so it was driven end to end: this app against the rack
simulator, a Web RCS page open through it, and `curl` or Companion on the outside. The module's
`docs/NOTES.md` lists what was run.
