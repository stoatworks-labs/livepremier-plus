/*
 * Timer Image — the plugin's server half.
 *
 * Three things, none of which writes to a switcher:
 *
 * - **The per-switcher document** (which screen and Foreground Image, which
 *   source, the look), at `/__lpp/timer-image/` like the UMDs, and in the
 *   setup file.
 * - **The Stagetimer link** (`stagetimer.js`). Its room ID and key are kept in
 *   a document of their own, `timer-image-stagetimer`, which no route reads
 *   back and no setup file carries: the page is told whether a key is set,
 *   never what it is.
 * - **The tick**, `GET /stream?page=<id>`: a server-sent event a little after
 *   every whole second of this machine's clock, carrying that clock and, when
 *   Stagetimer is on, the room's current timer as numbers. A page draws and
 *   uploads on the tick, not on a timer of its own, because a hidden tab's
 *   timers slow to a crawl while its event stream keeps arriving — the
 *   Control API's lesson. **One page runs the timer**: the oldest stream is
 *   the runner and every tick says which, so two open tabs never upload the
 *   same second twice.
 */

import { documentRoute, documentSection } from '../../server/documents.js';
import { StagetimerLink, DEFAULT_BASE } from './stagetimer.js';
import { stagetimerView } from './core.js';

const CREDENTIALS = 'timer-image-stagetimer';
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export default function activate(ctx) {
  documentRoute(ctx, 'timer-image', { limit: 16 * 1024 });
  documentSection(ctx, 'timer-image', { group: 'show', label: 'Timer images', empty: (data) => !data });

  /* ------------------------------------------------------------ Stagetimer */

  /* A fake Stagetimer in tests; the real one otherwise. */
  const base = process.env.LPP_STAGETIMER_BASE || DEFAULT_BASE;
  let creds = { roomId: '', apiKey: '', enabled: false };
  let link = null;

  const loadCreds = async () => {
    if (!ctx.storage) return;
    const d = await ctx.storage.load(CREDENTIALS, { perDevice: false });
    if (d && typeof d === 'object') {
      creds = { roomId: String(d.roomId || ''), apiKey: String(d.apiKey || ''), enabled: d.enabled === true };
    }
  };

  const restart = () => {
    if (link) { link.stop(); link.removeAllListeners(); link = null; }
    if (!creds.enabled) return;
    link = new StagetimerLink({ roomId: creds.roomId, apiKey: creds.apiKey, base, log: (m) => ctx.log(m) });
    link.on('state', (s) => { ctx.log(`Stagetimer: ${s.state}${s.error ? ` — ${s.error}` : ''}`); tickSoon(); });
    link.on('data', () => tickSoon());
    link.start();
  };

  const describe = () => ({
    enabled: creds.enabled,
    roomId: creds.roomId,
    keySet: Boolean(creds.apiKey),
    ...(link ? link.describe() : { state: 'off', error: null, roomName: '', timerName: '', lastData: null, offsetMs: 0 }),
    base: base === DEFAULT_BASE ? null : base
  });

  ctx.route('GET', '/stagetimer', (req, res, h) => h.json(200, describe()));

  ctx.route('PUT', '/stagetimer', async (req, res, h) => {
    if (!ctx.storage) throw new ctx.HttpError(501, 'no storage configured');
    const body = await h.readJson(4 * 1024);
    const next = { ...creds };
    if (typeof body.roomId === 'string') next.roomId = body.roomId.trim().slice(0, 100);
    /* An empty key keeps the one set; `clearKey` is how it goes. */
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) next.apiKey = body.apiKey.trim().slice(0, 400);
    if (body.clearKey === true) next.apiKey = '';
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    await ctx.storage.save(CREDENTIALS, next, { perDevice: false });
    creds = next;
    restart();
    h.json(200, describe());
  });

  ctx.route('POST', '/stagetimer/test', async (req, res, h) => {
    if (!creds.roomId || !creds.apiKey) return h.json(200, { ok: false, error: 'Set a room ID and an API key first.' });
    const probe = new StagetimerLink({ roomId: creds.roomId, apiKey: creds.apiKey, base });
    try {
      await probe.testAuth();
      h.json(200, { ok: true });
    } catch (err) {
      h.json(200, { ok: false, error: err.message });
    }
  });

  /* ------------------------------------------------------------------ tick */

  /** The pages' streams by id, oldest first: the first is the runner. */
  const pages = new Map();
  const runner = () => (pages.size ? pages.keys().next().value : null);
  /* Whether the timer is on, in memory only: one that started itself after a
     restart, on air, would be a surprise. Any page may switch it; the runner
     does the work and says how it went. */
  let running = false;
  let report = null;

  const payload = (now) => {
    const st = link ? { link: link.describe(), view: stagetimerView(link.snapshot(), now) } : null;
    return { now, runner: runner(), running, report, stagetimer: st };
  };

  const tick = () => {
    if (!pages.size) return;
    const line = frame('tick', payload(Date.now()));
    for (const [id, res] of pages) {
      try { res.write(line); } catch { pages.delete(id); }
    }
  };

  let soon = null;
  const tickSoon = () => {
    if (soon) return;
    soon = setTimeout(() => { soon = null; tick(); }, 40);
    soon.unref?.();
  };

  let timer = null;
  const schedule = () => {
    /* A little after each whole second, so a reading made on the tick has
       already turned over. */
    const wait = 1000 - (Date.now() % 1000) + 15;
    timer = setTimeout(() => { tick(); schedule(); }, wait);
    timer.unref?.();
  };
  schedule();

  ctx.route('POST', '/run', async (req, res, h) => {
    const body = await h.readJson(1024);
    running = body.on === true;
    if (running) report = null;
    tickSoon();
    h.json(200, { running });
  });

  ctx.route('POST', '/report', async (req, res, h) => {
    const body = await h.readJson(16 * 1024);
    /* Only the runner speaks for what is on the switcher. */
    if (String(body.page || '') !== runner()) return h.json(409, { error: 'not the runner' });
    report = body.report && typeof body.report === 'object' ? { ...body.report, at: Date.now() } : null;
    if (body.stop === true) { running = false; tickSoon(); }
    h.json(200, { ok: true });
  });

  ctx.route('GET', '/stream', (req, res, h) => {
    const id = String(h.url?.searchParams?.get('page') ?? '').trim();
    if (!id || id.length > 100) return h.json(400, { error: 'a page stream needs ?page=<id>' });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write(': timer-image stream open\n\n');
    const old = pages.get(id);
    if (old && old !== res) { try { old.end(); } catch { /* gone */ } pages.delete(id); }
    pages.set(id, res);
    res.write(frame('tick', payload(Date.now())));
    req.on('close', () => {
      if (pages.get(id) !== res) return;
      pages.delete(id);
      /* The next page in line is the runner from the next tick; say so now. */
      tickSoon();
    });
  });

  ctx.onDispose(() => {
    clearTimeout(timer);
    clearTimeout(soon);
    if (link) { link.stop(); link.removeAllListeners(); link = null; }
    for (const res of pages.values()) { try { res.end(); } catch { /* gone */ } }
    pages.clear();
  });

  void loadCreds().then(restart).catch((err) => ctx.log(`Timer Image: could not read the Stagetimer settings: ${err.message}`));
}
