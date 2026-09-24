/*
 * Speed Editor — the plugin's server half: this page's way to the panel.
 *
 * The panel itself is held by the device host, a process of its own
 * (`devices/README.md`; the driver is `devices/modules/speed-editor/`). This
 * half reaches it through the app's `devices` service and does two things
 * the host cannot know about: which page drives the panel, and when it is
 * wanted at all.
 *
 * ## One page drives it
 *
 * Every page that has the Speed Editor started hears every report on
 * `/stream`, so something has to say which of them acts on it — two tabs on
 * the same switcher would otherwise both cut on every CUT. It is the lease
 * HyperDecks runs its rules by: a started page claims `/driver` every few
 * seconds, the holder keeps it until it lets go or stops renewing, and only
 * the holder's output reports (its lamps) reach the panel. **Take over** in
 * another page moves it there, which is what an operator who walked to a
 * different machine wants.
 *
 * ## Held only while driven
 *
 * The host opens the panel when a page claims it and lets it go when the
 * lease lapses or is released, so nothing holds it while nobody here is using
 * it — DaVinci Resolve can have it then.
 */

const DRIVER_LEASE_MS = 10_000;
const MODULE = 'speed-editor';

const IDLE = { present: false, connected: false, authed: false, lease: null, product: null, battery: null, error: null, handshakes: 0 };

export function createSpeedEditorServer(ctx) {
  const devices = () => ctx.use('devices');
  const panel = () => devices()?.module(MODULE) ?? null;

  let driver = null;
  const driverId = () => (driver && Date.now() - driver.at <= DRIVER_LEASE_MS ? driver.id : null);

  function snapshot() {
    const status = devices()?.status() ?? { running: false, installed: false, reason: 'No device host.' };
    const handle = panel();
    const available = !!handle?.available;
    return {
      available,
      reason: available ? null : (status.reason || (status.running ? 'The device host has no Speed Editor module.' : 'The device host is not running.')),
      host: { installed: status.installed, running: status.running, restarts: status.restarts },
      ...IDLE,
      ...(handle?.state ?? {}),
      driver: driverId(),
    };
  }

  const stream = ctx.stream('/stream', { onOpen: (first) => first.send('state', snapshot()) });

  /* The panel is held while a page drives it: opened on a claim, let go when
     the lease lapses (a page closed without saying) or is released. */
  let lapse = null;
  let wanted = false;
  const follow = () => {
    clearTimeout(lapse);
    const id = driverId();
    if (!!id !== wanted) { wanted = !!id; void panel()?.want(wanted); }
    if (id) {
      lapse = setTimeout(() => { if (!driverId()) { stream.send('state', snapshot()); follow(); } }, DRIVER_LEASE_MS + 100);
      lapse.unref?.();
    }
  };

  const handle = panel();
  const offs = [];
  if (handle) {
    offs.push(handle.on('state', () => stream.send('state', snapshot())));
    /* Base64 keeps a report one short line; the page puts the bytes back. */
    offs.push(handle.on('report', (bytes) => stream.send('report', Buffer.from(bytes).toString('base64'))));
  }
  const offStatus = devices()?.onStatus?.(() => stream.send('state', snapshot()));
  ctx.onDispose(() => {
    clearTimeout(lapse);
    for (const off of offs) off();
    offStatus?.();
    if (wanted) void panel()?.want(false);
  });

  ctx.route('GET', '/', (req, res, h) => h.json(200, snapshot()));

  /* A started page's claim to drive the panel. `take` moves it from another page. */
  ctx.route('POST', '/driver', async (req, res, h) => {
    const body = await h.readJson(4 * 1024);
    const id = body.id ? String(body.id).slice(0, 80) : null;
    const had = driverId();
    if (id && (!had || had === id || body.take)) driver = { id, at: Date.now() };
    if (body.release && driver?.id === id) driver = null;
    follow();
    if (driverId() !== had) stream.send('state', snapshot());
    h.json(200, { driver: driverId() });
  });

  /* Output reports — the lamps and the wheel's mode — from the page driving it. */
  ctx.route('POST', '/output', async (req, res, h) => {
    const body = await h.readJson(16 * 1024);
    const p = panel();
    if (!p?.available) throw new ctx.HttpError(503, snapshot().reason);
    if (!body.id || String(body.id) !== driverId()) throw new ctx.HttpError(409, 'another page is driving the panel');
    const reports = Array.isArray(body.reports) ? body.reports : [];
    try {
      h.json(200, { written: await p.write(reports) });
    } catch (err) {
      throw new ctx.HttpError(400, err.message);
    }
  });

  return { snapshot };
}

export default function activate(ctx) {
  createSpeedEditorServer(ctx);
}
