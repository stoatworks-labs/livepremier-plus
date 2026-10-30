/*
 * Triggers — what both halves share, with no I/O: the shapes of the
 * destinations, the triggers and the holds, reading a trigger's lines, and
 * the cue field's text.
 *
 * ## Three layers
 *
 * - A **destination** is a box on the network and how to talk to it: a sound
 *   desk on OSC, an Allen & Heath desk on MIDI over TCP, a node on Art-Net or
 *   sACN. It belongs to the installation, like a HyperDeck or a router.
 * - A **trigger** is a name and two lists of lines, **go** and **back**: what
 *   to send, and what puts it back. `Desk /ch/17/mix/on 1` is a line; so are
 *   `House 1-4 @ 0 fade 3` and `Desk msc go 45 list 1`. A line starts with
 *   the destination's name and the rest is that destination's own language.
 * - A **cue** names triggers to fire, and may say when to send their back
 *   lines: when a deck's clip ends, after a time, at the next cue, or by hand.
 *   That pending restore is a **hold**, and the server keeps it.
 *
 * Lines are kept as typed. They are read against the destinations each time
 * they are sent, so a line naming a destination that has gone is a problem
 * the panel shows, not a line silently dropped.
 *
 * ## `before`
 *
 * A DMX line's level may be `before`: the level that channel had when the go
 * lines last set it. A universe is this app's own, so the "previous state" is
 * known exactly — unlike a sound desk's, which v1 does not read back.
 */

export const ARTNET_PORT = 6454;
export const SACN_PORT = 5568;
/** MIDI over TCP, as Allen & Heath's dLive and SQ answer it. */
export const AH_MIDI_PORT = 51325;

export const KINDS = [
  { id: 'osc', label: 'OSC (UDP)', port: 8000, what: 'A sound desk, QLab, a lighting desk — anything that takes OSC over UDP.' },
  { id: 'midi-tcp', label: 'MIDI over TCP', port: AH_MIDI_PORT, what: 'MIDI bytes on a TCP socket, as Allen & Heath’s dLive and SQ take them.' },
  { id: 'artnet', label: 'Art-Net', port: ARTNET_PORT, what: 'A DMX universe this app sends, to a node.' },
  { id: 'sacn', label: 'sACN (E1.31)', port: SACN_PORT, what: 'A DMX universe this app sends, multicast or to an address, with a priority.' },
];
export const kindOf = (id) => KINDS.find((k) => k.id === id) || KINDS[0];
export const isDmx = (kind) => kind === 'artnet' || kind === 'sacn';

/** MSC command formats: what kind of device the command is for. */
export const MSC_FORMATS = { all: 0x7f, lighting: 0x01, sound: 0x10, video: 0x30, machinery: 0x20 };

/** The MSC commands a line may send, by name, and whether they take a cue number. */
export const MSC_COMMANDS = {
  go: { code: 0x01, cue: true },
  stop: { code: 0x02, cue: 'optional' },
  resume: { code: 0x03, cue: 'optional' },
  load: { code: 0x05, cue: true },
  fire: { code: 0x07, macro: true },
  alloff: { code: 0x08 },
  restore: { code: 0x09 },
  reset: { code: 0x0a },
  gooff: { code: 0x0b, cue: 'optional' },
};

/* ------------------------------------------------------------ universes */

/**
 * A universe as typed: `1`, `0:0:1` (Art-Net Net:Sub-Net:Universe) — answered
 * as one number, the Art-Net Port-Address or the sACN universe.
 */
export function parseUniverse(text, kind) {
  const s = String(text ?? '').trim();
  let n;
  if (/^\d+:\d+:\d+$/.test(s)) {
    if (kind !== 'artnet') throw new Error('Net:Sub-Net:Universe is Art-Net’s way of writing a universe');
    const [net, sub, uni] = s.split(':').map(Number);
    if (net > 127 || sub > 15 || uni > 15) throw new Error('Net is 0–127, Sub-Net and Universe 0–15');
    n = (net << 8) | (sub << 4) | uni;
  } else if (/^\d+$/.test(s)) {
    n = Number(s);
  } else {
    throw new Error(`“${s}” is not a universe`);
  }
  if (kind === 'sacn' && (n < 1 || n > 63999)) throw new Error('an sACN universe is 1–63999');
  if (kind === 'artnet' && n > 32767) throw new Error('an Art-Net universe is 0–32767');
  return n;
}

/** How a universe is written back: Art-Net as Net:Sub-Net:Universe, sACN as its number. */
export function formatUniverse(n, kind) {
  if (kind !== 'artnet') return String(n);
  return `${n >> 8}:${(n >> 4) & 15}:${n & 15}`;
}

/* ------------------------------------------------------------ the setup */

const slug = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Names that are unique without regard to case: a second "Desk" becomes "Desk 2". */
function uniqueName(name, taken) {
  let out = name;
  for (let n = 2; taken.has(out.toLowerCase()); n += 1) out = `${name} ${n}`;
  taken.add(out.toLowerCase());
  return out;
}

function uniqueId(base, taken, fallback) {
  const root = slug(base) || fallback;
  let id = root;
  for (let n = 2; taken.has(id); n += 1) id = `${root}-${n}`;
  taken.add(id);
  return id;
}

const intIn = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
};

export function normaliseDestinations(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const ids = new Set();
  const names = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const kind = kindOf(item.kind).id;
    /* A name may not hold a `;` (the cue field's separator) or start a line's own words. */
    const typed = String(item.name ?? '').replace(/[;\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    const name = uniqueName(typed || `${kindOf(kind).label.split(' ')[0]} ${out.length + 1}`, names);
    const dest = {
      id: uniqueId(item.id || name, ids, `dest-${out.length + 1}`),
      name,
      kind,
      host: String(item.host ?? '').trim().slice(0, 253),
      port: intIn(item.port, 1, 65535, kindOf(kind).port),
      enabled: item.enabled !== false,
    };
    if (isDmx(kind)) {
      let universe = kind === 'sacn' ? 1 : 0;
      try { universe = parseUniverse(item.universe ?? universe, kind); } catch { /* keep the default */ }
      dest.universe = universe;
      if (kind === 'sacn') dest.priority = intIn(item.priority, 0, 200, 100);
    }
    if (kind === 'midi-tcp') {
      dest.mscDevice = intIn(item.mscDevice, 0, 127, 127);
      dest.mscFormat = Object.hasOwn(MSC_FORMATS, item.mscFormat) ? item.mscFormat : 'all';
    }
    out.push(dest);
  }
  return out;
}

const lines = (v) => (Array.isArray(v) ? v : String(v ?? '').split('\n'))
  .map((l) => String(l ?? '').replace(/\r/g, '').trim())
  .filter(Boolean)
  .slice(0, 64)
  .map((l) => l.slice(0, 512));

export function normaliseTriggers(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const ids = new Set();
  const names = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    /* `;` separates triggers in a cue, and a cue's `restore …` clause is read by its first word. */
    let typed = String(item.name ?? '').replace(/[;\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (/^restore\b/i.test(typed)) typed = `Trigger ${typed}`;
    const name = uniqueName(typed || `Trigger ${out.length + 1}`, names);
    out.push({
      id: uniqueId(item.id || name, ids, `trigger-${out.length + 1}`),
      name,
      go: lines(item.go),
      back: lines(item.back),
    });
  }
  return out;
}

export function normaliseSetup(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return { destinations: normaliseDestinations(src.destinations), triggers: normaliseTriggers(src.triggers) };
}

/* ------------------------------------------------------------ lines */

/** Words, with "double quoted" runs kept whole and \" inside them. */
export function tokenise(text) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(text))) {
    out.push(m[1] != null ? { quoted: true, text: m[1].replace(/\\(.)/g, '$1') } : { quoted: false, text: m[2] });
  }
  return out;
}

/** The destination a line starts with: the longest name that is a whole-word prefix, ignoring case. */
export function destinationFor(line, destinations) {
  const lower = line.toLowerCase();
  let best = null;
  for (const d of destinations || []) {
    for (const word of [d.name, d.id]) {
      const w = word.toLowerCase();
      if (lower === w || (lower.startsWith(w) && /\s/.test(lower[w.length]))) {
        if (!best || w.length > best.at) best = { dest: d, at: w.length };
      }
    }
  }
  return best;
}

const int = (text, lo, hi, what) => {
  if (!/^-?\d+$/.test(String(text ?? ''))) throw new Error(`${what} is a whole number, ${lo}–${hi}`);
  const n = Number(text);
  if (n < lo || n > hi) throw new Error(`${what} is ${lo}–${hi}`);
  return n;
};

/**
 * A length of time as typed: `3`, `2.5s`, `90s`, `2m`, `1:30`, `1:02:03`.
 * Answered in seconds.
 */
export function parseDuration(text) {
  const s = String(text ?? '').trim().toLowerCase();
  let m;
  if ((m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?)?$/.exec(s))) return Number(m[1]);
  if ((m = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?)$/.exec(s))) return Number(m[1]) * 60;
  if ((m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s))) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  throw new Error(`“${text}” is not a length of time — try 3, 2.5s, 90s or 1:30`);
}

export function formatDuration(seconds) {
  if (seconds < 60) return `${Number(seconds.toFixed(2))}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function oscArg(tok) {
  if (tok.quoted) return { type: 's', value: tok.text };
  const t = tok.text;
  let m;
  if ((m = /^([ifs]):(.*)$/.exec(t))) {
    if (m[1] === 's') return { type: 's', value: m[2] };
    const n = Number(m[2]);
    if (m[2] === '' || !Number.isFinite(n)) throw new Error(`“${t}” is not a number`);
    if (m[1] === 'i' && !Number.isInteger(n)) throw new Error(`“${t}” is not a whole number`);
    return { type: m[1], value: n };
  }
  if (/^true$/i.test(t)) return { type: 'T', value: true };
  if (/^false$/i.test(t)) return { type: 'F', value: false };
  if (/^-?\d+$/.test(t) && Math.abs(Number(t)) <= 2147483647) return { type: 'i', value: Number(t) };
  if (/^-?(\d+\.\d*|\.\d+|\d+(\.\d*)?e[-+]?\d+)$/i.test(t)) return { type: 'f', value: Number(t) };
  return { type: 's', value: t };
}

function parseOsc(rest) {
  const toks = tokenise(rest);
  if (!toks.length || toks[0].quoted || !toks[0].text.startsWith('/')) {
    throw new Error('an OSC line is an address, then its arguments: /ch/01/mix/on 1');
  }
  if (/[\s#*,?[\]{}]/.test(toks[0].text)) throw new Error(`“${toks[0].text}” has a character an OSC address may not`);
  return { type: 'osc', address: toks[0].text, args: toks.slice(1).map(oscArg) };
}

function parseMidi(rest) {
  const toks = tokenise(rest).map((t) => t.text);
  const word = (toks[0] || '').toLowerCase();
  const ch = () => int(toks[1], 1, 16, 'a MIDI channel');
  switch (word) {
    case 'note':
    case 'on':
      if (toks.length !== 4) throw new Error('note <channel> <note> <velocity>');
      return { type: 'midi', msg: 'note', channel: ch(), note: int(toks[2], 0, 127, 'a note'), velocity: int(toks[3], 0, 127, 'a velocity') };
    case 'off':
      if (toks.length < 3 || toks.length > 4) throw new Error('off <channel> <note> [velocity]');
      return { type: 'midi', msg: 'off', channel: ch(), note: int(toks[2], 0, 127, 'a note'), velocity: toks[3] == null ? 0 : int(toks[3], 0, 127, 'a velocity') };
    case 'cc':
      if (toks.length !== 4) throw new Error('cc <channel> <controller> <value>');
      return { type: 'midi', msg: 'cc', channel: ch(), controller: int(toks[2], 0, 127, 'a controller'), value: int(toks[3], 0, 127, 'a value') };
    case 'pc':
      if (toks.length !== 3) throw new Error('pc <channel> <program>');
      return { type: 'midi', msg: 'pc', channel: ch(), program: int(toks[2], 0, 127, 'a program') };
    case 'msc': {
      const command = (toks[1] || '').toLowerCase().replace(/[^a-z]/g, '');
      const spec = MSC_COMMANDS[command];
      if (!spec) throw new Error(`msc ${Object.keys(MSC_COMMANDS).join(' | ')}`);
      const out = { type: 'midi', msg: 'msc', command };
      const args = toks.slice(2);
      if (spec.macro) {
        if (args.length !== 1) throw new Error('msc fire <macro number>');
        out.macro = int(args[0], 0, 127, 'a macro number');
        return out;
      }
      if (!spec.cue && args.length) throw new Error(`msc ${command} takes no cue number`);
      if (args.length) {
        if (!/^\d+(\.\d+)?$/.test(args[0])) throw new Error(`“${args[0]}” is not a cue number`);
        out.cue = args[0];
        if (args.length > 1) {
          if (args.length !== 3 || args[1].toLowerCase() !== 'list' || !/^\d+(\.\d+)?$/.test(args[2])) {
            throw new Error(`msc ${command} <cue> [list <list>]`);
          }
          out.list = args[2];
        }
      } else if (spec.cue === true) {
        throw new Error(`msc ${command} needs a cue number`);
      }
      return out;
    }
    case 'hex': {
      const hex = toks.slice(1).join('');
      if (!hex || hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new Error('hex <bytes>, two hex digits each: hex F0 7F 01 F7');
      if (hex.length > 512) throw new Error('at most 256 bytes on a line');
      return { type: 'midi', msg: 'hex', hex: hex.toUpperCase() };
    }
    default:
      throw new Error('a MIDI line is note, off, cc, pc, msc or hex');
  }
}

/** `1`, `1-4`, `1,3,5-8`, `1 thru 4`. Channels are 1–512. */
export function parseChannels(text) {
  const s = String(text).toLowerCase().replace(/\s*thru\s*/g, '-').replace(/\s+/g, '');
  if (!s) throw new Error('which channels?');
  const out = new Set();
  for (const part of s.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`“${part}” is not a channel or a range`);
    const a = Number(m[1]);
    const b = m[2] == null ? a : Number(m[2]);
    if (a < 1 || b > 512 || b < a) throw new Error(`channels are 1–512, low to high: “${part}”`);
    for (let c = a; c <= b; c++) out.add(c);
  }
  return [...out];
}

function parseLevel(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (t === 'before') return { before: true, level: null };
  if (t === 'full' || t === 'fl') return { before: false, level: 255 };
  if (t === 'out') return { before: false, level: 0 };
  let m;
  if ((m = /^(\d+(?:\.\d+)?)%$/.exec(t))) {
    const p = Number(m[1]);
    if (p > 100) throw new Error('a level is at most 100%');
    return { before: false, level: Math.round((p * 255) / 100) };
  }
  if (/^\d+$/.test(t) && Number(t) <= 255) return { before: false, level: Number(t) };
  throw new Error(`“${text}” is not a level — 0–255, a percentage, full, out or before`);
}

function parseDmx(rest) {
  const s = rest.trim();
  if (/^release$/i.test(s)) return { type: 'dmx', release: true };
  const m = /^(.+?)\s*(?:@|\bat\b)\s*(\S+)(?:\s+fade\s+(\S+))?$/i.exec(s);
  if (!m) throw new Error('a DMX line is <channels> @ <level> [fade <time>], or release: 1-4 @ 0 fade 3');
  const { level, before } = parseLevel(m[2]);
  const fade = m[3] == null ? 0 : parseDuration(m[3]);
  if (fade > 600) throw new Error('a fade is at most ten minutes');
  return { type: 'dmx', channels: parseChannels(m[1]), level, before, fade };
}

/**
 * Read one line against the destinations: `{ dest, type, … }`, or a throw
 * that says what is wrong in a sentence the panel can show.
 */
export function parseLine(text, destinations) {
  const line = String(text ?? '').trim();
  if (!line) throw new Error('the line is empty');
  const found = destinationFor(line, destinations);
  if (!found) {
    const names = (destinations || []).map((d) => d.name);
    throw new Error(names.length
      ? `a line starts with a destination — ${names.join(', ')}`
      : 'add a destination first: a line starts with its name');
  }
  const { dest } = found;
  const rest = line.slice(found.at).trim();
  let msg;
  if (dest.kind === 'osc') msg = parseOsc(rest);
  else if (dest.kind === 'midi-tcp') msg = parseMidi(rest);
  else msg = parseDmx(rest);
  return { dest: dest.id, ...msg };
}

/** Every line of every trigger that does not read, for the panel and the save's reply. */
export function lineProblems(setup) {
  const out = [];
  for (const t of setup.triggers || []) {
    for (const side of ['go', 'back']) {
      t[side].forEach((line, index) => {
        try { parseLine(line, setup.destinations); } catch (err) {
          out.push({ trigger: t.id, side, index, line, error: err.message });
        }
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------ the cue field */

const findBy = (list, word) => {
  const w = String(word).trim().toLowerCase();
  return (list || []).find((x) => x.name.toLowerCase() === w) || (list || []).find((x) => x.id === w) || null;
};

function parseRestore(text, decks) {
  let body = text.trim();
  let then = null;
  const thenAt = body.search(/\s+then\s+/i);
  if (thenAt >= 0) {
    const what = body.slice(thenAt).replace(/^\s+then\s+/i, '').trim();
    body = body.slice(0, thenAt).trim();
    let m;
    if (/^go$/i.test(what)) then = 'go';
    else if ((m = /^cue\s+(\S+)$/i.exec(what))) then = { cue: m[1] };
    else throw new Error(`after “then”: go, or cue <number> — not “${what}”`);
  }
  const restore = { deck: null, after: null, next: false, manual: false, then };
  if (!body) throw new Error('restore when <deck> ends, after <time>, at next cue, or by hand');
  for (const cond of body.split(/\s+or\s+/i).map((c) => c.trim())) {
    let m;
    if ((m = /^when\s+(.+?)\s+ends$/i.exec(cond))) {
      const deck = findBy(decks, m[1]);
      if (!deck) {
        throw new Error((decks || []).length
          ? `no HyperDeck called “${m[1]}” — ${decks.map((d) => d.name).join(', ')}`
          : `no HyperDeck called “${m[1]}”: is the HyperDecks plugin on, with the deck added?`);
      }
      if (restore.deck) throw new Error('one deck per cue');
      restore.deck = deck.id;
    } else if ((m = /^after\s+(.+)$/i.exec(cond))) {
      const s = parseDuration(m[1]);
      if (s <= 0 || s > 24 * 3600) throw new Error('after a time between a second and a day');
      restore.after = s;
    } else if (/^(at|on)\s+(the\s+)?next(\s+(cue|go))?$/i.test(cond)) {
      restore.next = true;
    } else if (/^by\s+hand$/i.test(cond)) {
      restore.manual = true;
    } else {
      throw new Error(`“${cond}”: restore when <deck> ends, after <time>, at next cue, or by hand`);
    }
  }
  return restore;
}

/**
 * The cue field: trigger names and at most one `restore …` clause, `;`
 * between them — `VT audio; House down; restore when Mitti ends or after 5:00
 * then go`. Answered as one action (or none, for an empty field).
 */
export function parseCueText(text, { triggers = [], decks = [] } = {}) {
  const items = String(text ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  if (!items.length) return [];
  const fire = [];
  let restore = null;
  for (const item of items) {
    if (/^restore\b/i.test(item)) {
      if (restore) throw new Error('one restore clause per cue');
      restore = parseRestore(item.replace(/^restore\b/i, ''), decks);
      continue;
    }
    const t = findBy(triggers, item);
    if (!t) {
      throw new Error(triggers.length
        ? `no trigger called “${item}” — ${triggers.map((x) => x.name).join(', ')}`
        : `no trigger called “${item}”: add it in PLUS ▸ Triggers first`);
    }
    if (!fire.includes(t.id)) fire.push(t.id);
  }
  return [{ fire, restore }];
}

export function formatRestore(restore, decks = []) {
  if (!restore) return '';
  const conds = [];
  if (restore.deck) conds.push(`when ${findBy(decks, restore.deck)?.name ?? restore.deck} ends`);
  if (restore.after) conds.push(`after ${formatDuration(restore.after)}`);
  if (restore.next) conds.push('at next cue');
  if (restore.manual) conds.push('by hand');
  const then = restore.then === 'go' ? ' then go' : restore.then && restore.then.cue ? ` then cue ${restore.then.cue}` : '';
  return `restore ${conds.join(' or ')}${then}`;
}

/** The field's text for a cue's actions — what `parseCueText` reads back. */
export function formatCueText(actions, { triggers = [], decks = [] } = {}) {
  const parts = [];
  for (const a of actions || []) {
    for (const id of a.fire || []) parts.push(findBy(triggers, id)?.name ?? id);
    if (a.restore) parts.push(formatRestore(a.restore, decks));
  }
  return parts.join('; ');
}

export function describeCueAction(action, names) {
  const fire = (action.fire || []).map((id) => findBy(names.triggers, id)?.name ?? id);
  const restore = action.restore ? formatRestore(action.restore, names.decks) : '';
  return [fire.length ? `Triggers ${fire.join(', ')}` : 'Triggers', restore].filter(Boolean).join(' · ');
}

/* ------------------------------------------------------------ holds */

/**
 * A hold as kept on disk. `stale` marks one found at startup: it was waiting
 * when the app stopped, and it is offered — Restore now, or Discard — never
 * fired by itself, because house lights coming up on a relaunch mid-show is
 * worse than waiting for a click.
 */
export function normaliseHolds(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.holds) ? raw.holds : []);
  return list.filter((h) => h && typeof h === 'object' && typeof h.id === 'string').map((h) => ({
    id: h.id,
    page: String(h.page ?? ''),
    cue: { id: String(h.cue?.id ?? ''), number: String(h.cue?.number ?? ''), label: String(h.cue?.label ?? '') },
    fire: Array.isArray(h.fire) ? h.fire.map(String) : [],
    restore: h.restore && typeof h.restore === 'object' ? {
      deck: h.restore.deck ? String(h.restore.deck) : null,
      after: Number.isFinite(h.restore.after) ? h.restore.after : null,
      next: h.restore.next === true,
      manual: h.restore.manual === true,
      then: h.restore.then === 'go' ? 'go' : h.restore.then?.cue ? { cue: String(h.restore.then.cue) } : null,
    } : { deck: null, after: null, next: false, manual: true, then: null },
    before: h.before && typeof h.before === 'object' ? h.before : {},
    at: Number(h.at) || 0,
    stale: h.stale === true,
  }));
}

export const cueName = (cue) => (cue.number ? `cue ${cue.number}` : 'a cue') + (cue.label ? ` (${cue.label})` : '');
