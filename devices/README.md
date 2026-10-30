# The device host

The program that holds USB and HID devices for LivePremier Plus: control panels
plugged into the machine the app runs on. It is a process of its own, started
and supervised by the app, with one **module** per kind of device.

The first was the DaVinci Resolve Speed Editor; the second is the Barco EC-30 /
EC-40 / EC-50 desk panel (*preview*, never yet run against a panel —
`docs/BARCO-EC.md`); the third is the ATEM Micro Panel (*preview*, never yet run
against a panel — `docs/ATEM-MICRO-PANEL.md`).

## Why a program of its own

- **A page cannot do it.** The first Speed Editor build used WebHID, and on a
  real panel Chrome on macOS could not read the handshake's challenge: it reads
  every feature report at the length of the largest one the device declares,
  and the panel refuses a short report read that way. `modules/speed-editor/driver.js`
  has the detail. hidapi, through node-hid, reads at the length it is told.
- **The app keeps no dependencies.** node-hid, usb and koffi are native addons.
  They are this folder's dependencies (`package.json`, `package-lock.json`), and
  the app's own `package.json` stays empty. A checkout, a CI run or the Docker image without
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

## Transports

A module says which library it needs as `transport`:

- **`hid`**: node-hid. The Speed Editor and the ATEM Micro Panel, which are one
  family on the wire and share one driver, `blackmagic-hid.js`: found by vendor
  and product id over USB or Bluetooth, silent until a challenge on a feature
  report is answered, and answered again at half the lease it grants. A module
  gives it a model — `{ vendorId, productId, authenticate, battery }` — and
  nothing else differs.
- **`ftdi`**: `transports/ftdi.js`, an FTDI chip in MPSSE mode. The Barco EC
  panels are an FT232H behind a CPLD. On **macOS and Linux** it goes through
  libusb (the `usb` package, v2 — the libusb binding; v3 is a rewrite on another
  USB stack), which is also how Barco's own Mac Toolset reaches the panel. On
  **Windows** it goes through FTDI's D2XX (`ftd2xx.dll`, via `koffi`), because the
  Event Master Toolset binds FTDI's driver to the panel. Never replace that driver
  with WinUSB to use libusb there: the Toolset would stop seeing the panel. Linux
  needs `udev/71-barco-ec.rules`.

A module whose library did not load is not started, and the host's `hello` says
why for that module alone, so a missing node-hid does not take the EC panel with
it. The tests load stand-ins with `--hid <module>` and `--ftdi <module>`.

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
and whatever else the device has), emitting `state` and `report`. A panel whose
output is more than a few report bytes — the EC panel's labels — also has
`command(object) -> Promise<result>`, reached through the `devices` service's
`handle.command()`. Open the
device only while it is wanted. An open HID handle keeps a process alive, and
another app may want the device while nobody here is using it. Then a plugin
in `plugins/<id>/` gives it a page.

## The media host

A second program in this folder, `media-host.js`, sends pictures out as
[NDI](https://ndi.video): what desk control's NDI feeds are made by
(`docs/DESK-CONTROL.md`, "Pictures back to the desk"). It lives here for the
koffi it borrows, and is kept apart from the device host for two reasons:

- **Its channel carries pictures.** It is forked with
  `serialization: 'advanced'`, so a frame crosses as bytes rather than as JSON.
  The device host's channel carries a few bytes at a time, and stays that way.
- **NDI is loaded from the machine, not shipped.** `media/ndi.js` looks for the
  NDI runtime that NDI Tools installs (`NDI_RUNTIME_DIR_V6`, or the usual
  places on each platform) and opens it with koffi. Nothing of NDI's is in this
  repo or the app. A runtime that falls over takes down only this host, never
  the USB panels.

The app starts it beside the device host (`server/media-host.js` is its
supervisor) and offers it to plugins as the `media` service (`docs/PLUGINS.md`).
A plugin names the feeds it wants and hands over a picture for one as a scene:
fills, outlines, images and text that `src/core/raster.js` draws here, into RGBX,
before `NDIlib_send_send_video_v2` sends it. A frame that arrives while the last
one for the same feed is still on its way is dropped, not queued.
`--no-media` (or `LPP_MEDIA=0`) stops the app from starting it. **Docker**
never carries it: the image has no `devices/`, and NDI's licence keeps it to the
desktop app anyway. The tests load a stand-in runtime with `--ndi <module>`.
