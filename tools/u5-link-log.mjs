#!/usr/bin/env node
/*
 * A logbook for a Pixelhue U5 mini whose key grid keeps dropping, kept beside
 * a running LivePremier Plus.
 *
 * Start it while the problem is happening, leave it a few minutes, stop it with
 * Ctrl-C and send back the file it names. It writes a line whenever the
 * Pixelhue panel's links change — the control link (8088 on a mini) and the key
 * grid (17100) connecting and dropping, how long each stayed up or down, the
 * errors LPP gives for them — and every new line of the panel's own history,
 * the one the settings card shows the last five of. Every 2 s it pings the
 * console, so a grid that drops while the pings carry on can be told apart from
 * Wi-Fi that is dropping everything. Every minute it writes a summary.
 *
 * ## It only listens to LPP
 *
 * It never opens a connection to the console. The mini's key grid serves one
 * client, and a second one takes the grid from whoever held it — LPP, here,
 * which would dial straight back and take it again (`plugins/pixelhue/
 * grid-link.js` says how that ends). The control port is LPP's socket too. So
 * everything is read from LPP's own routes on this machine, the ones the
 * settings card reads:
 *
 *     GET /__lpp/status           LPP's version, the switcher, the settings
 *     GET /__lpp/pixelhue/state   the panel: `link`, `grid`, `history`
 *
 * Both are served as they were in 0.18.9, and every field is read as optional:
 * a newer LPP adds some (`grid.pongs`) and an older one lacks them. The pings
 * are the operating system's own `ping`, one ICMP echo every 2 s, which the
 * console's network stack answers and none of its applications sees.
 *
 * ## Running it
 *
 * macOS: double-click `u5-link-log.command` beside this file. It uses the Node
 * inside LivePremier Plus.app, so there is nothing to install. If macOS will
 * not open a downloaded .command, right-click it and choose Open, or in
 * Terminal, from the folder this file is in:
 *
 *     "/Applications/LivePremier Plus.app/Contents/Resources/node" u5-link-log.mjs
 *
 * Windows: double-click `u5-link-log.cmd`, or in a Command Prompt:
 *
 *     "%LOCALAPPDATA%\LivePremier Plus\node.exe" u5-link-log.mjs
 *
 * Linux, or a checkout: `node tools/u5-link-log.mjs` (Node 20 or later).
 *
 *     --lpp <url>        where LPP answers (default http://127.0.0.1:8535)
 *     --console <ip>     ping this address, not the console LPP is set to
 *     --out <file>       the log file (default lpp-u5-log-<date>-<time>.txt on the Desktop)
 *
 * ## What to send back
 *
 * The .txt file, with a word on what the console was doing. It holds times, the
 * console's and the switcher's addresses, this machine's address on the
 * console's network, the LPP and Node versions and the operating system's —
 * nothing else about the machine. A few minutes of the problem is plenty.
 */

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOOL_VERSION = '1.0.0';
const POLL_MS = 500;
const PING_MS = 2000;
const SUMMARY_MS = 60_000;
/* A reply slower than this gets a line of its own: a wired network answers in
   a millisecond or two, and Wi-Fi on its way out starts about here. */
const SLOW_MS = 100;
/* LPP answers these routes from memory; one that takes this long is not answering. */
const ANSWER_MS = 2000;
/* How much history `describe()` hands out (`plugins/pixelhue/supervisor.js`). */
const HISTORY_SHOWN = 12;
/* Closes in a minute after which LPP stops dialling the grid (`grid-link.js`, TAKEOVERS). */
const LET_GO_AT = 3;

const MODELS = { u5mini: 'Pixelhue U5 mini', u5pro: 'Pixelhue U5 Pro', u5: 'Pixelhue U5' };

const USAGE = `usage: node u5-link-log.mjs [--lpp <url>] [--console <ip>] [--out <file>]

  --lpp <url>      where LivePremier Plus answers  (default http://127.0.0.1:8535)
  --console <ip>   ping this address, not the console LPP is set to
  --out <file>     the log file  (default lpp-u5-log-<date>-<time>.txt on the Desktop)

It only reads LPP's own state and pings the console; it never connects to the
console. Stop it with Ctrl-C and send back the file it names.`;

/* ------------------------------------------------------------------ options */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    const m = /^--(lpp|console|out)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`not an option: ${a}`);
    const value = m[2] ?? argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`--${m[1]} needs a value`);
    out[m[1]] = value;
  }
  return out;
}

function lppBase(raw) {
  const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`--lpp must be an http address, not ${raw}`);
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/* Starting with a letter or digit, so it can never be taken for one of ping's own options. */
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

let args;
let lpp;
try {
  args = parseArgs(process.argv.slice(2));
  lpp = lppBase(args.lpp || 'http://127.0.0.1:8535');
  if (args.console && !ADDRESS.test(args.console)) throw new Error(`--console: not an address: ${args.console}`);
} catch (err) {
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

/* ------------------------------------------------------------------- output */

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** ISO 8601 in local time, with milliseconds and the offset: what a reader in another time zone needs. */
function stamp(t) {
  const d = new Date(t);
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    + `:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

const clock = (t) => stamp(t).slice(11, 23);

function duration(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 59.5) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const whole = Math.round(s);
  const m = Math.floor(whole / 60);
  if (m < 60) return `${m} min ${pad(whole % 60)} s`;
  return `${Math.floor(m / 60)} h ${pad(m % 60)} min`;
}

/* Windows says "time<1ms" for anything quicker, which is kept as half a millisecond. */
const rtt = (ms) => (ms < 1 && process.platform === 'win32' ? '<1 ms' : `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`);

let fd = null;
/* A Terminal window closed under it takes stdout away; the file is what matters. */
process.stdout.on('error', () => {});

function write(line) {
  try { process.stdout.write(`${line}\n`); } catch { /* the file still has it */ }
  if (fd !== null) {
    try { fs.writeSync(fd, line + os.EOL); } catch { /* nothing better to do with it */ }
  }
}

function say(tag, text, t = Date.now()) {
  write(`${stamp(Number.isFinite(t) ? t : Date.now())}  ${tag.padEnd(7)}  ${text}`);
}

/* ---------------------------------------------------------------------- LPP */

async function getJson(route) {
  const res = await fetch(`${lpp}${route}`, { signal: AbortSignal.timeout(ANSWER_MS), cache: 'no-store' });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

function reasonOf(err) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return `no answer in ${ANSWER_MS / 1000} s`;
  const code = err && err.cause && err.cause.code;
  if (code === 'ECONNREFUSED') return 'connection refused — is LivePremier Plus running?';
  return (err && err.cause && err.cause.message) || (err && err.message) || String(err);
}

async function readStatus() {
  try {
    const { status, body } = await getJson('/__lpp/status');
    return status === 200 && body && typeof body === 'object' ? { ok: true, body } : { ok: false, why: `HTTP ${status}` };
  } catch (err) {
    return { ok: false, why: reasonOf(err) };
  }
}

/** The console the settings name, for when the panel is not driving one (or is switched off). */
function settingsConsole(status) {
  const s = (status && status.settings) || {};
  const own = (s.plugins && s.plugins.pixelhue && s.plugins.pixelhue.settings) || {};
  return {
    host: own.pixelhueHost || s.pixelhueHost || null,
    model: own.pixelhueModel || s.pixelhueModel || null,
    enabled: own.pixelhueEnabled ?? s.pixelhueEnabled ?? null,
  };
}

/* ------------------------------------------------------------- this machine */

function machine() {
  const arch = os.arch();
  if (process.platform === 'darwin') {
    try {
      return `macOS ${execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 3000 }).trim()} (${arch})`;
    } catch { /* fall through to the kernel's name */ }
  }
  if (process.platform === 'win32') return `${os.version ? os.version() : 'Windows'} ${os.release()} (${arch})`;
  return `${os.type()} ${os.release()} (${arch})`;
}

/** macOS names its interfaces en0, en1…; which of them is the Wi-Fi is the question being asked. */
function hardwarePorts() {
  if (process.platform !== 'darwin') return {};
  try {
    const out = execFileSync('networksetup', ['-listallhardwareports'], { encoding: 'utf8', timeout: 3000 });
    const ports = {};
    let port = null;
    for (const line of out.split('\n')) {
      const p = /^Hardware Port: (.+)$/.exec(line);
      if (p) port = p[1].trim();
      const d = /^Device: (.+)$/.exec(line);
      if (d && port) ports[d[1].trim()] = port;
    }
    return ports;
  } catch {
    return {};
  }
}

/** This machine's interfaces on the console's subnet: how the pings, and LPP, reach it. */
function routeTo(address) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address || '')) return null;
  if (address.startsWith('127.')) return 'this machine (loopback)';
  const int = (a) => a.split('.').reduce((n, o) => (n * 256) + Number(o), 0);
  const target = int(address);
  const names = hardwarePorts();
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || !a.netmask) continue;
      const mask = int(a.netmask);
      if (((int(a.address) & mask) >>> 0) !== ((target & mask) >>> 0)) continue;
      found.push(`${name}${names[name] ? ` (${names[name]})` : ''} ${a.cidr || a.address}`);
    }
  }
  return found.length ? found.join(', ') : 'no interface on the console\'s subnet: it is reached through a router';
}

/* --------------------------------------------------------------------- ping */

function pingCommand(host) {
  if (process.platform === 'win32') return ['ping', ['-n', '1', '-w', '2000', host]];
  if (process.platform === 'darwin') return ['ping', ['-c', '1', '-t', '2', host]];
  return ['ping', ['-c', '1', '-W', '2', host]];
}

/**
 * The round trip from one ping's output, or null when there was no reply.
 * Only a line with a TTL counts: Windows prints "Destination host unreachable"
 * as a reply from the router, with exit code 0. The number is read off the
 * `=`/`<` before "ms", so a Windows in another language parses the same.
 */
function parseRtt(out) {
  for (const line of String(out).split(/\r?\n/)) {
    if (!/\bttl[=\s]/i.test(line)) continue;
    const m = /([=<])\s*(\d+(?:[.,]\d+)?)\s*ms\b/i.exec(line);
    if (!m) continue;
    const ms = Number(m[2].replace(',', '.'));
    return m[1] === '<' ? ms / 2 : ms;
  }
  return null;
}

function pingOnce(host) {
  return new Promise((resolve) => {
    const [cmd, argv] = pingCommand(host);
    execFile(cmd, argv, { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout || ''}\n${stderr || ''}`;
      const ms = parseRtt(out);
      if (ms !== null) return resolve({ ok: true, ms });
      if (err && err.code === 'ENOENT') return resolve({ broken: true, why: 'there is no ping command on this machine' });
      if (err && err.killed) return resolve({ ok: false, why: 'ping did not finish' });
      if (/unknown host|could not find host|cannot resolve|not known|failure in name resolution/i.test(out)) {
        return resolve({ ok: false, why: `cannot resolve ${host}` });
      }
      if (/unreachable/i.test(out)) return resolve({ ok: false, why: 'unreachable' });
      if (/not permitted|permission denied/i.test(out)) return resolve({ broken: true, why: out.trim().split(/\r?\n/)[0] });
      return resolve({ ok: false, why: 'no reply in 2 s' });
    });
  });
}

/* ------------------------------------------------------------------- counts */

function freshCounts(from = Date.now()) {
  return {
    from, drops: 0, up: 0, down: 0, sent: 0, lost: 0, rtts: [], missed: 0, pongs: null, presses: null, drawn: null,
  };
}
let minute = freshCounts();
const total = freshCounts();

function count(field, n = 1) {
  if (!n) return;
  minute[field] = (minute[field] ?? 0) + n;
  total[field] = (total[field] ?? 0) + n;
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function summary(c, span, label) {
  const parts = [];
  if (c.up + c.down > 0 || c.drops > 0) {
    parts.push(`key grid dropped ${c.drops}×, up ${duration(c.up)}, down ${duration(c.down)}`);
  } else {
    parts.push('no key grid seen');
  }
  if (c.sent) {
    const lostPct = ((c.lost / c.sent) * 100).toFixed(c.lost && c.lost < c.sent ? 1 : 0);
    let ping = `ping ${c.sent} sent, ${c.lost} lost (${lostPct}%)`;
    if (c.rtts.length) ping += `, median ${rtt(median(c.rtts))}, max ${rtt(Math.max(...c.rtts))}`;
    parts.push(ping);
  } else {
    parts.push('no pings');
  }
  const counters = [['pongs', c.pongs], ['presses', c.presses], ['keys drawn', c.drawn]]
    .filter(([, n]) => n !== null).map(([name, n]) => `${name} +${n}`);
  if (counters.length) parts.push(counters.join(', '));
  if (c.missed) parts.push(`LPP did not answer ${c.missed} of the looks (every ${POLL_MS} ms)`);
  return `${label} ${duration(span)}: ${parts.join('; ')}`;
}

/* -------------------------------------------------------- what has been seen */

const seen = {
  lpp: null, /* true answering, false not, null not asked yet */
  lppSince: Date.now(),
  everAnswered: false,
  version: null,
  lastOk: null, /* time of the last answered look, for the up and down sums */
  panel: null,
  link: null,
  linkSince: null,
  grid: null,
  gridSince: null,
  history: null,
  printed: new Set(),
};

const pinger = { host: null, from: null, busy: false, lostRun: 0, broken: false, saidNone: false };

function setConsole(host, from) {
  if (args.console || !host || host === pinger.host) return;
  if (!ADDRESS.test(host)) return;
  const had = pinger.host;
  pinger.host = host;
  pinger.from = from;
  pinger.lostRun = 0;
  if (had) say('ping', `the console is now ${host} (${from}); pinging that`);
}

const isGridUp = (e) => e.kind === 'connected' && /key grid/.test(e.note || '');
const isGridDown = (e) => e.kind === 'disconnected' && /key grid/.test(e.note || '');
const isLinkUp = (e) => e.kind === 'connected' && !e.note;
const isLinkDown = (e) => e.kind === 'disconnected' && !e.note;
const isStart = (e) => e.kind === 'starting';

function lastAt(entries, test) {
  let at = null;
  for (const e of entries) if (test(e) && Number.isFinite(e.at) && (at === null || e.at > at)) at = e.at;
  return at;
}

/**
 * The history lines not seen yet, oldest first. LPP's list is newest first and
 * capped, so what was seen before is the tail of what is shown now: find where
 * it starts. Identical lines in a row are kept apart by position, not merged.
 */
function newHistory(list) {
  if (!Array.isArray(list)) return { entries: [], earlier: false, gap: false };
  const keys = list.map((e) => JSON.stringify(e));
  const prev = seen.history;
  seen.history = keys;
  if (prev === null) return { entries: list.slice().reverse(), earlier: true, gap: false };
  let cut = list.length;
  if (prev.length) {
    for (let i = 0; i < list.length; i++) {
      let lined = true;
      for (let k = 0; i + k < list.length && k < prev.length; k++) {
        if (keys[i + k] !== prev[k]) { lined = false; break; }
      }
      if (lined) { cut = i; break; }
    }
  }
  const gap = cut === list.length && prev.length > 0 && list.length >= HISTORY_SHOWN;
  return { entries: list.slice(0, cut).reverse(), earlier: false, gap };
}

/* The card's own words for a line (`client.js`), led by its kind. A long line is written in full once. */
function historyText(e) {
  const words = [e.command, e.note || e.error].filter(Boolean).join(' — ');
  let text = words ? `${e.kind || 'note'}: ${words}` : String(e.kind || 'note');
  if (e.kind === 'starting' && e.url) text += ` (${e.url})`;
  if (!words && (e.kind === 'connected' || e.kind === 'disconnected')) text += ' (the control link)';
  if (text.length > 110 && seen.printed.has(text)) return `${text.slice(0, 100)}… (in full above)`;
  if (seen.printed.size > 500) seen.printed.clear();
  seen.printed.add(text);
  return text;
}

function onHistory({ entries, earlier, gap }) {
  if (gap) say('history', `more than ${HISTORY_SHOWN} new lines since the last look; some are missing here`);
  for (const e of entries) say('history', `${earlier ? '(before this log) ' : ''}${historyText(e)}`, e.at);
}

function panelIs(text) {
  if (text === seen.panel) return;
  seen.panel = text;
  say('panel', text);
}

const upFor = (since, at) => (since ? `${duration(at - since)} up` : 'being up since before this log');
const downFor = (since, at) => (since ? `${duration(at - since)} down` : 'being down since before this log');

/* The control link: 8088 on a mini, 19999 on a U5. */
function onLink(t, link, fresh, silentText) {
  const prev = seen.link;
  seen.link = link;
  if (!link) {
    if (prev) say('link', 'control link gone: the panel was stopped or re-dialled');
    return;
  }
  const name = `control link${link.port ? ` ${link.port}` : ''}`;
  if (!prev) {
    if (link.connected) {
      seen.linkSince = lastAt(fresh.entries, isLinkUp) ?? (fresh.earlier ? null : t);
      say('link', `${name} connected${seen.linkSince ? ` (since ${clock(seen.linkSince)})` : ''}`);
    } else {
      seen.linkSince = lastAt(fresh.entries, isLinkDown) ?? lastAt(fresh.entries, isStart) ?? (fresh.earlier ? null : t);
      say('link', `${name} not connected${link.lastError ? `: ${link.lastError}` : ''}`);
    }
    if (link.connected && link.silent) say('link', silentText || `${name} is open, but no key report has come in`);
    return;
  }
  const dropped = prev.connected && !link.connected;
  if (dropped) {
    const at = lastAt(fresh.entries, isLinkDown) || t;
    say('link', `${name} dropped after ${upFor(seen.linkSince, at)}${link.lastError ? ` — ${link.lastError}` : ''}`);
    seen.linkSince = at;
  } else if (!prev.connected && link.connected) {
    const at = lastAt(fresh.entries, isLinkUp) || t;
    say('link', `${name} connected after ${downFor(seen.linkSince, at)}`);
    seen.linkSince = at;
  }
  if (link.lastError && link.lastError !== prev.lastError && !dropped) say('link', `${name} error: ${link.lastError}`);
  if (Boolean(link.silent) !== Boolean(prev.silent)) {
    say('link', link.silent ? (silentText || `${name} is open, but no key report has come in`) : `${name}: key reports arriving`);
  }
}

/* A counter LPP keeps (`drawn`, `presses`, and `pongs` after 0.18.9): what it moved by since the last look. */
function counted(field, prev, grid) {
  if (!grid || typeof grid[field] !== 'number') return;
  const was = prev && typeof prev[field] === 'number' ? prev[field] : null;
  /* A smaller number is a new link object, counting from nothing again. */
  const delta = was === null ? 0 : grid[field] >= was ? grid[field] - was : grid[field];
  if (minute[field] === null) minute[field] = 0;
  if (total[field] === null) total[field] = 0;
  count(field, delta);
}

/* The mini's key grid, 17100. */
function onGrid(t, grid, fresh, dt) {
  const prev = seen.grid;
  seen.grid = grid;
  if (prev && grid && dt > 0) count(prev.connected ? 'up' : 'down', dt);
  /* Drops LPP wrote down since the last look. A drop and a reconnect inside one
     look show only here, which is why the count takes these as well as what
     was seen change. Lines from before this log are not counted. */
  const written = fresh.earlier ? 0 : fresh.entries.filter(isGridDown).length;
  for (const field of ['pongs', 'presses', 'drawn']) counted(field, prev, grid);

  if (!grid) {
    if (prev) say('grid', 'key grid link gone: the panel was stopped or re-dialled');
    count('drops', written);
    return;
  }
  const name = `key grid${grid.port ? ` ${grid.port}` : ''}`;
  if (!prev) {
    if (grid.connected) {
      seen.gridSince = lastAt(fresh.entries, isGridUp) ?? (fresh.earlier ? null : t);
      say('grid', `${name} connected${seen.gridSince ? ` (since ${clock(seen.gridSince)})` : ''}`);
    } else {
      seen.gridSince = lastAt(fresh.entries, isGridDown) ?? lastAt(fresh.entries, isStart) ?? (fresh.earlier ? null : t);
      say('grid', `${name} not connected${grid.lastError ? `: ${grid.lastError}` : ''}`);
    }
    if (grid.takenBack) say('grid', `the console has closed the ${name} connection ${grid.takenBack}× in the last minute (LPP lets go at ${LET_GO_AT})`);
    if (grid.letGo) say('grid', `LPP has let go of the ${name}: ${grid.letGo.note || `the console closed it ${grid.letGo.count}×`}`);
    return;
  }

  const dropped = prev.connected && !grid.connected;
  const came = !prev.connected && grid.connected;
  count('drops', Math.max(dropped ? 1 : 0, written));
  if (dropped) {
    const at = lastAt(fresh.entries, isGridDown) || t;
    say('grid', `${name} dropped after ${upFor(seen.gridSince, at)}${grid.lastError ? ` — ${grid.lastError}` : ''}`);
    seen.gridSince = at;
  } else if (came) {
    const at = lastAt(fresh.entries, isGridUp) || t;
    say('grid', `${name} connected after ${downFor(seen.gridSince, at)}`);
    seen.gridSince = at;
  } else if (written) {
    const downAt = lastAt(fresh.entries, isGridDown) || t;
    const upAt = lastAt(fresh.entries, isGridUp);
    if (grid.connected && upAt) {
      say('grid', `${name} dropped after ${upFor(seen.gridSince, downAt)} and was back ${duration(upAt - downAt)} later, between two looks`);
      seen.gridSince = upAt;
    } else {
      say('grid', `${name} came up and dropped again between two looks`);
      seen.gridSince = downAt;
    }
  }
  if (grid.lastError && grid.lastError !== prev.lastError && !dropped) say('grid', `${name} error: ${grid.lastError}`);
  if ((grid.takenBack || 0) !== (prev.takenBack || 0) && grid.takenBack) {
    say('grid', `the console has closed the ${name} connection ${grid.takenBack}× in the last minute (LPP lets go at ${LET_GO_AT})`);
  }
  if (Boolean(grid.letGo) !== Boolean(prev.letGo)) {
    say('grid', grid.letGo
      ? `LPP has let go of the ${name}: ${grid.letGo.note || `the console closed it ${grid.letGo.count}×`}`
      : `LPP is dialling the ${name} again`);
  }
}

function onPanel(t, s, dt) {
  const fresh = newHistory(s.history);
  onHistory(fresh);
  const model = s.model ? MODELS[s.model] || s.model : 'console';
  panelIs(s.configured
    ? `the Pixelhue panel is driving a ${model} at ${s.host}${s.port ? `, control port ${s.port}` : ''}`
    + (s.grid ? '' : s.model === 'u5mini' ? ', with no key grid link' : ' (no key grid on this model)')
    : 'the Pixelhue panel is on, but not driving a console: "Drive a Pixelhue console" is off, or it has no address');
  if (s.host) setConsole(s.host, 'from LPP');
  onLink(t, s.configured ? s.link || null : null, fresh, s.silent);
  onGrid(t, s.configured ? s.grid || null : null, fresh, dt);
}

/* --------------------------------------------------------------------- loop */

async function lppAnswering(t) {
  if (seen.lpp === true) return;
  const was = seen.lpp;
  seen.lpp = true;
  if (was === false) {
    const status = await readStatus();
    const version = status.ok ? status.body.version || null : null;
    const changed = version && version !== seen.version ? `, version ${version}` : '';
    say('lpp', seen.everAnswered
      ? `LPP answering again after ${duration(t - seen.lppSince)}${changed}`
      : `LPP answering at ${lpp}${changed}`);
    if (version) seen.version = version;
    if (status.ok) setConsole(settingsConsole(status.body).host, 'from LPP\'s settings');
  }
  seen.everAnswered = true;
  seen.lppSince = t;
}

function lppSilent(t, reason) {
  count('missed');
  seen.lastOk = null;
  if (seen.lpp === false) return;
  say('lpp', seen.lpp === null
    ? `LPP is not answering at ${lpp} (${reason}); waiting for it`
    : `LPP stopped answering (${reason})`);
  seen.lpp = false;
  seen.lppSince = t;
}

async function poll() {
  const t = Date.now();
  let answer;
  try {
    answer = await getJson('/__lpp/pixelhue/state');
  } catch (err) {
    lppSilent(t, reasonOf(err));
    return;
  }
  await lppAnswering(t);
  const dt = seen.lastOk !== null ? t - seen.lastOk : 0;
  seen.lastOk = t;
  const { status, body } = answer;
  if (status !== 200 || !body || typeof body !== 'object') {
    panelIs(`LPP answers, but not for the Pixelhue panel: ${(body && body.error) || `HTTP ${status}`}`);
    onLink(t, null, { entries: [] }, null);
    onGrid(t, null, { entries: [], earlier: true }, 0);
    return;
  }
  onPanel(t, body, dt);
}

async function pingTick() {
  if (pinger.busy || pinger.broken || stopping) return;
  if (!pinger.host) {
    if (!pinger.saidNone) say('ping', 'no console address yet, so no pings: give one with --console <ip>');
    pinger.saidNone = true;
    return;
  }
  pinger.busy = true;
  const host = pinger.host;
  let r;
  try { r = await pingOnce(host); } finally { pinger.busy = false; }
  if (stopping || host !== pinger.host) return;
  if (r.broken) {
    pinger.broken = true;
    say('ping', `cannot ping: ${r.why}; carrying on without pings`);
    return;
  }
  count('sent');
  if (!r.ok) {
    count('lost');
    pinger.lostRun++;
    say('ping', `${host} lost (${r.why})${pinger.lostRun > 1 ? `, ${pinger.lostRun} in a row` : ''}`);
    return;
  }
  if (pinger.lostRun) say('ping', `${host} answering again after ${pinger.lostRun} lost: ${rtt(r.ms)}`);
  else if (r.ms > SLOW_MS) say('ping', `${host} slow: ${rtt(r.ms)}`);
  pinger.lostRun = 0;
  minute.rtts.push(r.ms);
  total.rtts.push(r.ms);
}

/* ------------------------------------------------------------------- start */

const started = Date.now();
const fileStamp = (t) => stamp(t).slice(0, 19).replace(/-|:/g, '').replace('T', '-');

function defaultOut() {
  const home = os.homedir();
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const dir = [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop')].find(isDir) || home;
  return path.join(dir, `lpp-u5-log-${fileStamp(started)}.txt`);
}

const out = path.resolve(args.out || defaultOut());
try {
  fd = fs.openSync(out, 'a');
} catch (err) {
  console.error(`cannot write the log to ${out}: ${err.message}\nGive another place with --out <file>.`);
  process.exit(1);
}

let stopping = false;
const timers = [];

async function main() {
  const status = await readStatus();
  let panel = null;
  try {
    const r = await getJson('/__lpp/pixelhue/state');
    if (r.status === 200 && r.body && typeof r.body === 'object') panel = r.body;
  } catch { /* the first look says so */ }
  const configured = status.ok ? settingsConsole(status.body) : {};
  if (status.ok) seen.version = status.body.version || null;

  if (args.console) {
    pinger.host = args.console;
    pinger.from = 'given with --console';
  } else if (panel && panel.host) {
    pinger.host = panel.host;
    pinger.from = 'the console LPP is driving';
  } else if (configured.host) {
    pinger.host = configured.host;
    pinger.from = 'from LPP\'s settings';
  }

  const node = process.execPath.includes('LivePremier Plus') ? 'LivePremier Plus\'s own' : 'not LivePremier Plus\'s own';
  let consoleLine;
  if (panel && panel.configured) {
    consoleLine = `${MODELS[panel.model] || panel.model || 'a console'} at ${panel.host}`
      + `${panel.port ? `, control port ${panel.port}` : ''}${panel.grid && panel.grid.port ? `, key grid ${panel.grid.port}` : ''}`;
  } else if (configured.host) {
    consoleLine = `${MODELS[configured.model] || configured.model || 'a console'} at ${configured.host} in LPP's settings, `
      + `not being driven ("Drive a Pixelhue console" is ${configured.enabled ? 'on, but the panel plugin is not running' : 'off'})`;
  } else {
    consoleLine = status.ok ? 'none set in LPP' : 'not known: LPP is not answering';
  }

  const header = [
    `LivePremier Plus U5 link log (u5-link-log.mjs ${TOOL_VERSION})`,
    `started     ${stamp(started)}`,
    `machine     ${machine()}, Node ${process.version} (${node})`,
    status.ok
      ? `LPP         ${status.body.version || 'version not given'} at ${lpp}${status.body.device ? `, switcher ${status.body.device}` : ', no switcher set'}`
      : `LPP         not answering at ${lpp} (${status.why})`,
    `console     ${consoleLine}`,
    `pinging     ${pinger.host ? `${pinger.host} every ${PING_MS / 1000} s, ${pinger.from}` : 'nothing yet: no console address'}`,
    `network     ${(pinger.host && routeTo(pinger.host)) || 'not worked out (no IPv4 console address)'}`,
    `looking     at LPP every ${POLL_MS} ms; a summary every ${SUMMARY_MS / 1000} s; a ping slower than ${SLOW_MS} ms or lost gets a line`,
    '',
  ];
  for (const line of header) write(line);
  try { process.stdout.write(`(writing to ${out} — Ctrl-C stops it)\n\n`); } catch { /* fine */ }

  timers.push(setInterval(() => { void pingTick().catch((err) => say('error', `ping: ${err.message}`)); }, PING_MS));
  timers.push(setInterval(() => {
    const t = Date.now();
    say('summary', summary(minute, t - minute.from, 'last'));
    minute = freshCounts(t);
  }, SUMMARY_MS));
  void pingTick().catch((err) => say('error', `ping: ${err.message}`));

  while (!stopping) {
    const t0 = Date.now();
    try { await poll(); } catch (err) { say('error', `reading LPP: ${err.stack || err.message}`); }
    await new Promise((resolve) => { setTimeout(resolve, Math.max(0, POLL_MS - (Date.now() - t0))); });
  }
}

function finish(signal) {
  if (stopping) return;
  stopping = true;
  for (const timer of timers) clearInterval(timer);
  const t = Date.now();
  if (t - minute.from >= 1000) say('summary', summary(minute, t - minute.from, 'last'));
  say('total', summary(total, t - total.from, 'whole run,'));
  say('end', `stopped (${signal})`);
  try { fs.closeSync(fd); } catch { /* already gone */ }
  fd = null;
  try {
    process.stdout.write(`\nThe log is in:\n  ${out}\nPlease send that file back, with a word on what the console was doing.\n`);
  } catch { /* the window has gone */ }
  process.exit(0);
}

/* SIGHUP is a Terminal window closed on a Mac, and the console window closed on
   Windows; SIGBREAK is Ctrl-Break there. Each still gets the summary written. */
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => finish(sig)); } catch { /* not a signal on this platform */ }
}

main().catch((err) => {
  say('error', err.stack || err.message);
  finish('error');
});
