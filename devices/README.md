# The device host

The program that holds USB and HID devices for LivePremier Plus: control panels
plugged into the machine the app runs on. It is a process of its own, started
and supervised by the app, with one **module** per kind of device.

The first is the DaVinci Resolve Speed Editor.

## Why a program of its own

- **A page cannot do it.** The first Speed Editor build used WebHID, and on a
  real panel Chrome on macOS could not read the handshake's challenge: it reads
  every feature report at the length of the largest one the device declares,
  and the panel refuses a short report read that way. `modules/speed-editor/driver.js`
  has the detail. hidapi, through node-hid, reads at the length it is told.
- **The app keeps no dependencies.** node-hid is a native addon. It is this
  folder's dependency (`package.json`, `package-lock.json`), and the app's own
  `package.json` stays empty. A checkout, a CI run or the Docker image without
  `devices/node_modules` is a whole app with no USB panels, and says so.
- **A device that misbehaves takes down only the host.** The app restarts it,
  with a backoff, and tells the pages it did.

## Running it

It is never run by hand. **The desktop app** carries it installed. Under
**`npm start`**, install it once:

```
npm run setup:devices
```

The app then starts it by itself on every run. `--no-devices` (or
`LPP_DEVICES=0`) stops it from doing so. **Docker** has no USB and does not
carry it.

The state of the host, and of each module's device, is on the settings page
(Preconfig ▸ LivePremier Plus ▸ Device host). Each device's own controls live on
its own page: the Speed Editor's under Virtual RC400T.

## How it talks to the app

Over Node's parent–child IPC channel, so it opens no port and nothing else on
the machine can reach it. The messages are listed in `core.js`. When the
channel closes (the app stopped, or was killed), the host lets its devices go
and exits, so nothing is left holding a panel.

In the app, `server/device-host.js` is the supervisor, and plugins reach it as
the `devices` service (`ctx.use('devices')`, see `docs/PLUGINS.md`):
`module(id)` answers a handle with the device's `state`, `want(bool)` to open or
release it, `write(reports)` for output reports, and `on('state' | 'report')`.
The mapping from a device's controls to the switcher stays in the page, because
that is where the store mirror is. The host and the server have none, on
purpose (`server/awj.js`).

## Adding a module

A folder under `modules/`, named for its id, with a `module.js`:

```js
export default {
  id: 'speed-editor',                 // the folder's name
  name: 'DaVinci Resolve Speed Editor',
  transport: 'hid',
  create: ({ hid, log }) => new Driver({ hid, log }),
};
```

The driver is an EventEmitter with `start()`, `stop()`, `want(bool)`,
`write(bytes) -> Promise<bool>` and a `state` getter (`present`, `connected`,
and whatever else the device has), emitting `state` and `report`. Open the
device only while it is wanted. An open HID handle keeps a process alive, and
another app may want the device while nobody here is using it. Then a plugin
in `plugins/<id>/` gives it a page.
