/*
 * Control API — the plugin's server half: the door Companion knocks on.
 *
 * `core.js` says why an action is run by an open page rather than here. This
 * half checks a request, hands it to the page holding the lease, waits for
 * that page to say what happened, and keeps the last state the page reported
 * for anyone who wants to show it on a button.
 *
 * Routes, under `/__lpp/control`:
 *
 *     POST /do       {action, args}     run one action; answers what the page said
 *     GET  /state                       the page's last report, and the action table
 *     GET  /events                      server-sent `state` events, a snapshot first
 *
 * and four a page uses, which a client has no business calling:
 *
 *     GET  /stream?page=<id>            `lease` and `command` events to the pages
 *     POST /runner   {id, release?}     a page's claim to run actions
 *     POST /result   {id, …}            the page's answer to one command
 *     POST /report   {page, state}      the page's state, from the lease holder only
 *
 * A page holds the lease while its `/stream` is open, as well as while it
 * beats on `/runner`: a hidden tab's timers slow to a crawl, but its stream
 * stays open and its events still arrive. When the holder's stream closes the
 * lease goes straight to the oldest page still listening, so a closed tab
 * hands over at once rather than after the lease runs out.
 *
 * Nothing here writes to a switcher, and nothing here holds a socket to one.
 */

import { ANSWER_MS, CONTROL_VERSION, checkRequest, createLease, describeActions } from './core.js';

/* A page's report is a few kilobytes; a show's worth of variables and groups at most. */
const REPORT_LIMIT = 256 * 1024;

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export default function activate(ctx) {
  /* The pages' streams, by page id, oldest first. Not `ctx.stream`, which
     cannot say which page went away — and that is the one fact the lease
     needs. */
  const pages = new Map();
  const lease = createLease({ alive: (id) => pages.has(id) });
  /* Commands waiting for their page's answer, by id. */
  const waiting = new Map();
  let seq = 0;
  let report = null;
  let reportedBy = null;

  const toPages = (event, data) => {
    const line = frame(event, data);
    for (const [id, res] of pages) {
      try { res.write(line); } catch { pages.delete(id); }
    }
  };

  const snapshot = () => {
    const runner = lease.current();
    return {
      version: CONTROL_VERSION,
      page: Boolean(runner),
      /* A report from a page that has since let go is history, not state. */
      state: runner && reportedBy === runner ? report : null,
      at: Date.now(),
    };
  };
  const events = ctx.stream('/events', { onOpen: (first) => first.send('state', snapshot()) });
  const announce = () => events.send('state', snapshot());

  /* Say who holds the lease, to the pages and to Companion, when it changes. */
  let lastRunner = null;
  const settled = () => {
    const now = lease.current();
    if (now === lastRunner) return;
    lastRunner = now;
    toPages('lease', { runner: now });
    announce();
  };
  /* With nobody holding the lease, the oldest page still listening takes it. */
  const handOver = (skip) => {
    if (lease.current()) return;
    for (const id of pages.keys()) {
      if (id !== skip) { lease.claim(id); return; }
    }
  };

  /* A lapsed beat is only noticed when somebody looks, so look now and then:
     a page that stopped beating should turn Companion's "page open" off
     without a press. */
  const watch = setInterval(() => { handOver(); settled(); }, 2000);
  ctx.onDispose(() => {
    clearInterval(watch);
    for (const w of waiting.values()) { clearTimeout(w.timer); w.resolve({ ok: false, error: 'the Control API was switched off' }); }
    waiting.clear();
    for (const res of pages.values()) { try { res.end(); } catch { /* gone */ } }
    pages.clear();
  });

  ctx.route('GET', '/stream', (req, res, h) => {
    const id = String(h.url?.searchParams?.get('page') ?? '').trim();
    if (!id || id.length > 100) return h.json(400, { error: 'a page stream needs ?page=<id>' });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': control stream open\n\n');
    /* A page that reconnects under the same id replaces its old stream. */
    const old = pages.get(id);
    if (old && old !== res) { try { old.end(); } catch { /* gone */ } }
    pages.set(id, res);
    lease.claim(id);
    res.write(frame('lease', { runner: lease.current() }));
    settled();
    req.on('close', () => {
      if (pages.get(id) !== res) return;
      pages.delete(id);
      lease.claim(id, true);
      handOver();
      settled();
    });
  });

  ctx.route('POST', '/runner', async (req, res, h) => {
    const body = await h.readJson(4 * 1024);
    const release = body.release === true;
    lease.claim(body.id, release);
    /* A page letting go is going away; the next one in line takes over. */
    if (release) handOver(String(body.id ?? '').trim());
    settled();
    h.json(200, { runner: lease.current() });
  });

  ctx.route('POST', '/report', async (req, res, h) => {
    const body = await h.readJson(REPORT_LIMIT);
    const runner = lease.current();
    /* Only the holder speaks for the show; another tab's view is not the one
       that would run the next GO. */
    if (!runner || String(body.page ?? '') !== runner) return h.json(409, { error: 'this page does not hold the lease', runner });
    report = body.state && typeof body.state === 'object' ? body.state : null;
    reportedBy = runner;
    announce();
    h.json(200, { ok: true });
  });

  ctx.route('POST', '/result', async (req, res, h) => {
    const body = await h.readJson(64 * 1024);
    const w = waiting.get(String(body.id ?? ''));
    if (!w) return h.json(404, { error: 'no command is waiting under that id' });
    waiting.delete(w.id);
    clearTimeout(w.timer);
    w.resolve({
      ok: body.ok === true,
      result: body.result ?? null,
      error: body.ok === true ? null : String(body.error || 'the page refused it'),
    });
    h.json(200, { ok: true });
  });

  ctx.route('GET', '/state', (req, res, h) => h.json(200, { ...snapshot(), actions: describeActions() }));

  ctx.route('POST', '/do', async (req, res, h) => {
    const body = await h.readJson(16 * 1024);
    const checked = checkRequest(body);
    if (!checked.ok) return h.json(400, { ok: false, error: checked.error });

    const runner = lease.current();
    if (!runner) {
      return h.json(409, {
        ok: false,
        error: 'no LivePremier Plus page is open to run it — open Web RCS through LivePremier Plus and leave it open',
      });
    }

    const id = `c${Date.now().toString(36)}${(seq++).toString(36)}`;
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve({ ok: false, error: 'the open page did not answer in time', timeout: true });
      }, ANSWER_MS);
      waiting.set(id, { id, resolve, timer });
      /* Every page hears it; only the one named acts. */
      toPages('command', { id, runner, action: checked.action, args: checked.args });
    });

    if (answer.timeout) return h.json(504, { ok: false, error: answer.error });
    h.json(answer.ok ? 200 : 409, { ok: answer.ok, action: checked.action, result: answer.result, error: answer.error });
  });
}
