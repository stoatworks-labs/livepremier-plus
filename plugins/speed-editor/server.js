/*
 * Speed Editor — the plugin's server half: the panel, over USB or Bluetooth,
 * held by this process. `link.js` says why it is here and not in the page.
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
 * ## Without node-hid
 *
 * node-hid is this app's one dependency, and an optional one: a checkout run
 * with no `npm install`, or the Docker image (which has no USB), has none.
 * Then this half still starts — the page is told the panel cannot be reached
 * from this build, and why — and nothing else in the app notices.
 */

import { PanelLink } from './link.js';

const DRIVER_LEASE_MS = 10_000;
/* One report is eleven bytes at most; a batch is a page's lamps changing at once. */
const MAX_REPORTS = 16;
const MAX_REPORT_BYTES = 64;

/** node-hid, or the reason there is none. Exported for the tests to replace. */
export async function loadHid() {
  try {
    const mod = await import('node-hid');
    return { hid: mod.default ?? mod, reason: null };
  } catch (err) {
    return {
      hid: null,
      reason: err?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(err?.message ?? '')
        ? 'This build has no USB access for the panel (node-hid is not installed). Use the desktop app, or run npm install.'
        : `USB access for the panel failed to load: ${err.message}`,
    };
  }
}

export function createSpeedEditorServer(ctx, { hid, reason }) {
  const link = hid ? new PanelLink({ hid, log: ctx.log }) : null;

  let driver = null;
  const driverId = () => (driver && Date.now() - driver.at <= DRIVER_LEASE_MS ? driver.id : null);
  /* The panel is held while a page drives it: opened on a claim, let go when
     the lease lapses (a page closed without saying) or is released. */
  let lapse = null;
  const follow = () => {
    clearTimeout(lapse);
    const id = driverId();
    void link?.want(!!id);
    if (id) {
      lapse = setTimeout(() => { if (!driverId()) { stream.send('state', snapshot()); follow(); } }, DRIVER_LEASE_MS + 100);
      lapse.unref?.();
    }
  };
  const snapshot = () => ({
    available: !!link,
    reason: link ? null : reason,
    ...(link ? link.state : { present: false, connected: false, authed: false, lease: null, product: null, battery: null, error: null, handshakes: 0 }),
    driver: driverId(),
  });

  const stream = ctx.stream('/stream', { onOpen: (first) => first.send('state', snapshot()) });

  if (link) {
    link.on('state', () => stream.send('state', snapshot()));
    /* Base64 keeps a report one short line; the page puts the bytes back. */
    link.on('report', (bytes) => stream.send('report', Buffer.from(bytes).toString('base64')));
    link.start();
    ctx.onDispose(() => { clearTimeout(lapse); return link.stop(); });
  }

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
    if (!link) throw new ctx.HttpError(503, reason);
    if (!body.id || String(body.id) !== driverId()) throw new ctx.HttpError(409, 'another page is driving the panel');
    const reports = Array.isArray(body.reports) ? body.reports : [];
    if (reports.length > MAX_REPORTS) throw new ctx.HttpError(400, `at most ${MAX_REPORTS} reports`);
    let written = 0;
    for (const r of reports) {
      if (!Array.isArray(r) || !r.length || r.length > MAX_REPORT_BYTES || !r.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
        throw new ctx.HttpError(400, 'a report is a list of bytes, id first');
      }
      if (await link.write(Uint8Array.from(r))) written++;
    }
    h.json(200, { written });
  });

  return { link, snapshot };
}

export default async function activate(ctx) {
  createSpeedEditorServer(ctx, await loadHid());
}
