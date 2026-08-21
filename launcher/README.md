# LivePremier Plus — desktop app

A small menu-bar app for LivePremier Plus: pick a network interface + port,
Start/Stop the proxy, and open it in a browser. Lives in the system tray.

Download the `.dmg` / `.msi` / `.deb` / `.rpm` from the repo's
[Releases](https://github.com/stoatworks-labs/livepremier-plus/releases).

> **Fully self-contained.** The bundle embeds a Node runtime and the app itself,
> so nothing needs to be installed on the machine.

## The one way this launcher differs from the fleet's others

Every other launcher injects a host and a port and is finished. This app also
needs a **switcher** to point at — and that is deliberately *not* injected here.
The target device is chosen on the app's own setup page in the browser, and
remembered between runs.

The reason is operational rather than technical: during a show an operator
re-points at a backup frame far more often than they restart a launcher, and a
device baked in at process start would mean stopping and restarting the app to
move. Keeping the launcher's contract to "interface and port" also means this
shell is the stock one, with no fork to maintain.

## Building

```
./scripts/prepare.sh      # stage the app + fetch a Node runtime
npm install
npm run tauri build
```

`prepare.sh` is the simplest in the fleet — LivePremier Plus has no
dependencies and no build step, so staging it is a copy of `server/` and
`src/`. The embedded runtime and app tree (`src-tauri/livepremier-plus-app/`,
`src-tauri/node`) are produced by `prepare.sh` and git-ignored; they ship inside
the bundle, not in the repo.

Signing and notarization are optional — see [SIGNING.md](SIGNING.md).
