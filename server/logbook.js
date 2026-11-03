/*
 * The app's log: every line the server, its plugins, its two hosts and the
 * page write, with a time, a level and where it came from — kept in memory for
 * the Settings page and on disk for "send me your logs".
 *
 * ## Why there is one now
 *
 * Before it, a line went to stdout and nowhere else. Under the desktop app
 * that meant the launcher's last 30 lines in memory, gone at Stop; the
 * Pixelhue card showed its last five. A user whose U5 mini dropped its key grid
 * every 15 s (2026-11-03) could send a screenshot of the card and nothing
 * more, and a Windows user whose panels never loaded had no log at all. So:
 * one book, on disk, rotated, that the Settings page can show and export as a
 * single text file.
 *
 * ## The shape of it
 *
 * - **Where.** `logs/` in the data directory (`LPP_DATA`, else
 *   `~/.livepremier-plus`), beside the cue stack and settings: the one folder
 *   this app already knows it may write, on every platform it runs on.
 * - **What.** One line per entry, plain text, so the export reads without a
 *   tool: `2026-11-03T14:05:01.123+00:00 WARN  plugin:pixelhue  message {json}`.
 *   Debug lines are kept in memory only, unless Settings → Logs says
 *   Detailed (`logLevel`) or the server was started with `--log`/`LPP_LOG`,
 *   which then wins over the setting.
 * - **How much.** `lpp.log` rolls to `lpp.1.log` … at 2 MB, and ten files are
 *   kept: 20 MB at most, about a week of a busy show. More than 200 lines in a
 *   second are counted, not written, and the count is written when it calms.
 * - **Synchronously.** A line is on disk when `write` returns, so the last
 *   thing before a crash is in the file. The volume is a few lines a minute.
 * - **Never a secret.** Tailscale keys and `password=…` style pairs are
 *   scrubbed from every line, and settings are exported with secret-named
 *   fields replaced. A log that has to be checked before it is sent will not
 *   be sent.
 * - **Never fatal.** A full disk, a read-only data directory, a file another
 *   process holds open on Windows: the line still goes to memory and stdout,
 *   and the first failure says so once.
 */
import {
  appendFileSync, mkdirSync, statSync, renameSync, rmSync, readFileSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const LABEL = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };
const FILE = 'lpp.log';

/* What a secret looks like inside a line of text, wherever it came from. */
const SECRET_TEXT = [
  [/tskey-[A-Za-z0-9_-]+/g, 'tskey-[redacted]'],
  [/\b(auth[-_]?key|api[-_]?key|password|passwd|secret|token)(["']?\s*[=:]\s*["']?)[^\s"',}]+/gi, '$1$2[redacted]'],
];
/* A settings field whose name says it is a secret. */
const SECRET_NAME = /auth[-_]?key|api[-_]?key|password|passwd|secret|token|credential/i;

/** A line with anything that looks like a key or a password taken out. */
export function scrub(text) {
  let out = String(text);
  for (const [re, to] of SECRET_TEXT) out = out.replace(re, to);
  return out;
}

/** A copy of `value` with every secret-named field replaced, to any depth. */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [
    k, SECRET_NAME.test(k) && v !== '' && v != null ? '[redacted]' : redact(v),
  ]));
}

/** ISO time in the machine's own offset: a user reads "14:05", not "13:05Z". */
export function localTime(date) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:`
    + `${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
    + `${off < 0 ? '-' : '+'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

/** One entry as the line the file and the export hold. */
export function formatEntry(e) {
  const data = e.data === undefined ? '' : ` ${JSON.stringify(e.data)}`;
  return `${localTime(new Date(e.t))} ${LABEL[e.level]} ${e.source}  ${e.msg}${data}`;
}

export class Logbook {
  #seq = 0;
  #ring = [];
  #second = 0;
  #inSecond = 0;
  #held = 0;
  #diskFailed = null;
  #listeners = new Set();

  /**
   * @param {object} o
   * @param {string|null} o.dir          where the files go; null keeps it in memory
   * @param {keyof LEVELS} [o.level]      the least a line needs to reach the disk
   * @param {boolean} [o.fixed]           the level was given on the command line: `setLevel` leaves it
   * @param {number} [o.maxBytes]         roll the file past this
   * @param {number} [o.keep]             files kept, the live one included
   * @param {number} [o.ring]             entries kept in memory for the page
   * @param {number} [o.perSecond]        lines a second written before the rest are counted
   * @param {(line: string, e: object) => void} [o.echo]  where a line also goes; stdout by default
   * @param {() => number} [o.now]
   */
  constructor({
    dir = null, level = 'info', fixed = false, maxBytes = 2 * 1024 * 1024, keep = 10, ring = 2000, perSecond = 200,
    echo = (line, e) => (e.level === 'error' ? console.error : console.log)(`[lpp] ${e.source === 'server' ? '' : `${e.source}: `}${e.msg}`),
    now = () => Date.now(),
  } = {}) {
    this.dir = dir;
    this.level = LEVELS[level] ? level : 'info';
    this.fixed = fixed;
    this.maxBytes = maxBytes;
    this.keep = Math.max(1, keep);
    this.ringSize = ring;
    this.perSecond = perSecond;
    this.echo = echo;
    this.now = now;
    this.counts = { debug: 0, info: 0, warn: 0, error: 0 };
    this.started = now();
    if (dir) {
      try { mkdirSync(dir, { recursive: true }); } catch (err) { this.#diskFailed = err.message; }
    }
  }

  /** The level from the settings page; a level given on the command line is kept. */
  setLevel(level) {
    if (this.fixed || !LEVELS[level] || level === this.level) return;
    this.level = level;
    this.write('info', 'logbook', `log level ${level}`);
  }

  /** The file being written now, or null when there is none. */
  get file() { return this.dir ? join(this.dir, FILE) : null; }

  /** Why the disk is not being written, or null when it is. */
  get diskError() { return this.#diskFailed; }

  /**
   * Write one entry. `data` is anything JSON can hold: a reason, a count, an
   * address — kept apart from `msg` so the page can show it small.
   */
  write(level, source, msg, data) {
    if (!LEVELS[level]) level = 'info';
    const e = {
      seq: ++this.#seq, t: this.now(), level, source: String(source || 'server'),
      msg: scrub(msg instanceof Error ? msg.message : msg),
    };
    if (data !== undefined) {
      try { e.data = JSON.parse(scrub(JSON.stringify(data))); } catch { e.data = scrub(String(data)); }
    }
    this.counts[level]++;
    this.#ring.push(e);
    if (this.#ring.length > this.ringSize) this.#ring.splice(0, this.#ring.length - this.ringSize);
    try { this.echo(formatEntry(e), e); } catch { /* a closed stdout is not a reason to lose the line */ }
    if (LEVELS[level] >= LEVELS[this.level]) this.#toDisk(e);
    for (const fn of this.#listeners) { try { fn(e); } catch { /* a listener's fault is its own */ } }
    return e;
  }

  /** `{debug, info, warn, error}` for one source; `info` is also the function itself, as `log(msg)` was. */
  for(source) {
    const info = (msg, data) => this.write('info', source, msg, data);
    info.debug = (msg, data) => this.write('debug', source, msg, data);
    info.info = info;
    info.warn = (msg, data) => this.write('warn', source, msg, data);
    info.error = (msg, data) => this.write('error', source, msg, data);
    return info;
  }

  /** Called with each entry as it is written; returns the unsubscribe. */
  subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /**
   * Entries from memory, oldest first: those after `since` (a `seq`), at
   * `level` or above, from sources starting `source`, the last `limit`.
   */
  recent({ since = 0, level = 'debug', source = '', limit = 500 } = {}) {
    const min = LEVELS[level] || 0;
    const out = this.#ring.filter((e) => e.seq > since && LEVELS[e.level] >= min && e.source.startsWith(source));
    return out.slice(-Math.max(0, limit));
  }

  /** The newest `seq` written, for a page asking "anything since?". */
  get seq() { return this.#seq; }

  /** The files on disk, oldest first, with their sizes. */
  files() {
    if (!this.dir) return [];
    const out = [];
    for (let i = this.keep - 1; i >= 0; i--) {
      const path = join(this.dir, i ? `lpp.${i}.log` : FILE);
      try { out.push({ path, bytes: statSync(path).size }); } catch { /* not there yet */ }
    }
    return out;
  }

  /**
   * Everything, as one text file: `header` (already-redacted facts about the
   * machine and the app) and then every line on disk, oldest first. With no
   * disk, the lines in memory.
   */
  exportText(header = {}) {
    const lines = [
      'LivePremier Plus log export',
      `exported ${localTime(new Date(this.now()))}`,
      ...Object.entries(header).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`),
      `counts since start: ${JSON.stringify(this.counts)}`,
      this.#diskFailed ? `log files: not written (${this.#diskFailed})` : `log files: ${this.dir}`,
      '',
    ];
    const files = this.files();
    if (files.length) {
      for (const f of files) {
        lines.push(`----- ${f.path} (${f.bytes} bytes)`);
        try { lines.push(readFileSync(f.path, 'utf8').replace(/\n$/, '')); } catch (err) { lines.push(`(could not read: ${err.message})`); }
      }
    } else {
      lines.push('----- in memory');
      for (const e of this.#ring) lines.push(formatEntry(e));
    }
    return `${lines.join('\n')}\n`;
  }

  /* ------------------------------------------------------------------ disk */

  #toDisk(e) {
    if (!this.dir || this.#diskFailed) return;
    const second = Math.floor(e.t / 1000);
    if (second !== this.#second) {
      const held = this.#held;
      this.#second = second;
      this.#inSecond = 0;
      this.#held = 0;
      if (held) this.#append(`${localTime(new Date(e.t))} WARN  logbook  ${held} lines in the second before were not written to disk (more than ${this.perSecond} a second)`);
    }
    if (++this.#inSecond > this.perSecond) { this.#held++; return; }
    this.#append(formatEntry(e));
  }

  #append(line) {
    try {
      this.#roll();
      appendFileSync(this.file, `${line}\n`);
    } catch (err) {
      this.#diskFailed = err.message;
      try { this.echo(`log file ${this.file} cannot be written (${err.message}); lines are kept in memory only`, { level: 'error', source: 'logbook', msg: err.message }); } catch { /* nothing left to tell */ }
    }
  }

  #roll() {
    let size = 0;
    try { size = statSync(this.file).size; } catch { return; }
    if (size < this.maxBytes) return;
    const at = (i) => join(this.dir, i ? `lpp.${i}.log` : FILE);
    if (existsSync(at(this.keep - 1))) rmSync(at(this.keep - 1), { force: true });
    for (let i = this.keep - 2; i >= 0; i--) {
      if (existsSync(at(i))) renameSync(at(i), at(i + 1));
    }
  }
}

/** The facts an export starts with that do not depend on the app's state. */
export function machineFacts() {
  return {
    os: `${os.type()} ${os.release()} (${process.platform} ${process.arch})`,
    node: process.version,
    host: os.hostname(),
    'process uptime': `${Math.round(process.uptime())} s`,
  };
}
