/*
 * grandMA3 — what a desk's playback feedback means.  ** PREVIEW **
 *
 * grandMA3 sends OSC by itself when a playback moves: set **Send** on an OSC
 * line in Menu ▸ In & Out ▸ OSC and every fader, key and knob that acts on a
 * sequence or master goes out as one message about that *object*:
 *
 * ```text
 *   /ma3/14.14.1.6.1 ,sif  FaderMaster 1 63.5          a fader, 0–100 %
 *   /ma3/14.14.1.6.1 ,sis  Go+ 1 "Take S1 2 Cue"        a key, 1 pressed / 0 released
 *   /ma3/14.14.1.6.1 ,si   Flash 0                      a key with no cue to name
 *   /ma3/14.14.1.6.1 ,sii  FaderMaster 0 -1             a knob's nudge, relative
 * ```
 *
 * Recorded from grandMA3 onPC 2.4.2.2 on macOS (2026-10-30), with the line's
 * Prefix set to `ma3`; `test/fixtures/grandma3-2.4.2.2-feedback.json` is that
 * recording. The second argument says what moved it: 1 on-screen or a command,
 * 3 a physical fader, 0 a physical knob.
 *
 * ⚠️ **The address is the object's place in the show, and it moves between
 * versions.** MA's 2.4 manual gives Sequence 1 as `/13.13.1.6.1`; 2.4.2.2
 * sends `/14.14.1.6.1`, and says so itself (`ObjectList('Sequence 1')[1]:Addr()`).
 * So nothing here knows what `14.14.1.6` is. A mapping line names the address
 * the desk was heard sending — the card lists them as they arrive — and an MA
 * update that renumbers the show means relearning the lines, which the card
 * makes obvious by listing the new addresses as unmapped.
 *
 * Same rule as everything in a plugin's core: no I/O.
 */

/** The address subtree this plugin answers. MA's OSC line takes the prefix without slashes: `ma3`. */
export const PREFIX = '/ma3/';

/** The subtree's dictionary, for `GET /__lpp/addresses` and docs/OSC.md. */
export const GRANDMA3_OSC = [
  {
    group: 'grandMA3',
    address: `${PREFIX}{object}`,
    args: 'function, handle, value — as grandMA3 sends it',
    summary: 'Playback feedback from a grandMA3 OSC line with Send on and Prefix "ma3". What it does is the line in the grandMA3 card that names this object and function.',
  },
];

export const GRANDMA3_DEFAULTS = Object.freeze({
  /* Off: it writes to a switcher, and it has never met a desk on a show. While
     off it still lists what it hears, which is how the lines get written. */
  grandma3Drive: false,
  grandma3Map: '',
});

/* Long enough for a few hundred lines; short enough that a pasted show file is refused. */
const MAP_LIMIT = 20_000;

export function normaliseGrandma3(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const map = typeof input.grandma3Map === 'string' ? input.grandma3Map.replace(/\r\n?/g, '\n') : '';
  return {
    grandma3Drive: input.grandma3Drive === true,
    grandma3Map: map.length > MAP_LIMIT ? map.slice(0, MAP_LIMIT) : map,
  };
}

/* ------------------------------------------------------------- feedback */

/**
 * One message of playback feedback, read — or null when it is not one.
 *
 * `types` is the message's OSC type tags (`'sif'`), which only a UDP packet
 * has. A line typed at the Console has none, and then a third argument that
 * is a number is read as a fader's position: a knob's nudge cannot be told
 * from one without the tags, and a position is what somebody testing a
 * mapping by hand means.
 *
 * @returns {null | {object: string, fn: string, kind: 'fader'|'knob'|'key',
 *   via: number, value: number, cue: string|null}}
 */
export function readFeedback(address, args, types) {
  if (typeof address !== 'string' || !address.startsWith(PREFIX)) return null;
  const object = address.slice(PREFIX.length);
  if (!/^\d+(\.\d+)+$/.test(object)) return null;
  if (!Array.isArray(args) || typeof args[0] !== 'string' || !args[0] || typeof args[1] !== 'number') return null;
  const [fn, via, third] = args;
  const tags = typeof types === 'string' ? types : null;

  if (typeof third === 'number' && Number.isFinite(third)) {
    const knob = tags ? tags === 'sii' : false;
    return { object, fn, kind: knob ? 'knob' : 'fader', via, value: third, cue: null };
  }
  if (tags && tags !== 'si' && tags !== 'sis') return null;
  if (third !== undefined && typeof third !== 'string') return null;
  /* A key's second argument is not what moved it but whether it is down. */
  return { object, fn, kind: 'key', via: null, value: via ? 1 : 0, cue: third || null };
}

/** What moved it, in words, from the second argument. */
export function viaName(r) {
  if (r.kind === 'knob') return r.via === 0 ? 'knob' : 'on-screen knob';
  if (r.kind === 'fader') return r.via === 3 ? 'fader' : 'on-screen fader or command';
  return 'key';
}

/** MA's fader functions all start `Fader` (FaderMaster, FaderX, FaderTemp…); every other function is a key's. */
export const isFaderFunction = (fn) => /^Fader/.test(fn);

/* -------------------------------------------------------------- the map */

/**
 * The mapping, one line per playback handle:
 *
 * ```text
 *   14.14.1.6.1 Go+         -> /lp/screen/1/take
 *   14.14.1.6.2 Go+         -> /lp/screen/1/memory/5/recall
 *   14.14.1.6.3 FaderMaster -> tbar S1 S2
 *   14.14.1.6.4 FaderMaster -> /lp/screen/1/preset/a/layer/2/opacity/opacity/norm
 *   14.14.1.6.5 Flash       -> /hyperdeck/Mitti/play      # anything after # is a note
 * ```
 *
 * A target is one of this app's OSC addresses, with at most one value after
 * it, or `tbar` and the screens it throws. What each does is `actionFor`.
 *
 * @returns {{rules: Array<{line: number, object: string, fn: string, key: string,
 *   target: {type: 'osc', address: string, args: unknown[]} | {type: 'tbar', screens: string[]},
 *   note: string}>, errors: Array<{line: number, message: string}>}}
 */
export function parseMap(text) {
  const rules = [];
  const errors = [];
  const seen = new Map();
  const lines = String(text || '').split('\n');
  lines.forEach((raw, i) => {
    const line = i + 1;
    const hash = raw.indexOf('#');
    const note = hash >= 0 ? raw.slice(hash + 1).trim() : '';
    const body = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (!body) return;
    const fail = (message) => errors.push({ line, message });

    const arrow = body.match(/\s*(?:->|→)\s*/);
    if (!arrow) return fail('a line is "<address> <function> -> <target>"');
    const left = body.slice(0, arrow.index).trim().split(/\s+/);
    const right = body.slice(arrow.index + arrow[0].length).trim();
    if (left.length !== 2) return fail('the left side is the address the desk sends and the function, like "14.14.1.6.1 Go+"');
    const [object, fn] = left;
    if (!/^\d+(\.\d+)+$/.test(object)) return fail(`"${object}" is not an address grandMA3 sends — copy it from the list of what was heard`);
    const key = `${object} ${fn}`;
    if (seen.has(key)) return fail(`${key} is already mapped on line ${seen.get(key)}`);

    const target = parseTarget(right, fn);
    if (target.error) return fail(target.error);
    seen.set(key, line);
    rules.push({ line, object, fn, key, target, note });
  });
  return { rules, errors };
}

function parseTarget(text, fn) {
  if (!text) return { error: 'nothing after the arrow' };
  const words = text.split(/\s+/);
  if (words[0].toLowerCase() === 'tbar') {
    if (!isFaderFunction(fn)) return { error: `${fn} is a key; only a fader can be a T-bar` };
    const screens = words.slice(1).map((w) => w.toUpperCase());
    if (!screens.length) return { error: 'tbar needs the screens it throws, like "tbar S1 S2"' };
    const bad = screens.find((s) => !/^S\d{1,2}$/.test(s));
    if (bad) return { error: `"${bad}" is not a screen — S1 to S24` };
    return { type: 'tbar', screens: [...new Set(screens)] };
  }
  const [address, ...rest] = words;
  if (!address.startsWith('/')) return { error: `"${address}" is not an address — they start with /, like /lp/screen/1/take` };
  if (address.startsWith(PREFIX) || address === PREFIX.slice(0, -1)) return { error: `${PREFIX}… is grandMA3's own subtree; a line cannot send back into it` };
  if (rest.length > 1) return { error: 'at most one value after the address' };
  const args = rest.length ? [valueOf(rest[0])] : [];
  return { type: 'osc', address, args };
}

/** A written value: a number when it reads as one, else the word. */
function valueOf(word) {
  const n = Number(word);
  return word !== '' && Number.isFinite(n) ? n : word;
}

/* ------------------------------------------------------------ the action */

/* A fader used as a button fires on its way up past FIRE, and only after it
   has been at or below ARM since it last fired — and since it was first
   heard, so a desk that comes up with a fader already high fires nothing. */
export const ARM_AT = 5;
export const FIRE_AT = 50;

/** A fader-as-button's next state, and whether this reading fires it. */
export function faderEdge(armed, percent) {
  if (percent <= ARM_AT) return { armed: true, fire: false };
  if (armed && percent >= FIRE_AT) return { armed: false, fire: true };
  return { armed, fire: false };
}

/**
 * What a reading does under a rule, before anything is sent:
 *
 * - a **key** press sends the target as written; its release sends nothing;
 * - a **fader** on `tbar` is a T-bar;
 * - a **fader** on an address ending `/norm`, with no value written, sends
 *   its position, 0–1;
 * - a **fader** on anything else is a button (`faderEdge`).
 *
 * @returns {{do: 'send'|'value'|'tbar'|'edge'|'nothing', why?: string}}
 */
export function actionFor(rule, reading) {
  const t = rule.target;
  if (reading.kind === 'knob') return { do: 'nothing', why: 'knob turns are not mapped yet' };
  if (reading.kind === 'key') {
    if (t.type === 'tbar') return { do: 'nothing', why: 'a key cannot throw a T-bar' };
    return reading.value ? { do: 'send' } : { do: 'nothing', why: 'released' };
  }
  if (t.type === 'tbar') return { do: 'tbar' };
  if (t.address.endsWith('/norm') && !t.args.length) return { do: 'value' };
  return { do: 'edge' };
}

/** A line for the map, from what was heard: the address, the function, an arrow left for the target. */
export function lineFor(heard) {
  const note = heard.cue ? `   # ${heard.cue}` : '';
  return `${heard.object} ${heard.fn} -> ${note}`;
}
