/*
 * HyperDecks — what both halves share, with no I/O: the deck list's shape,
 * the rules, and deciding what the rules say to do.
 *
 * ## The rules are Mitti's, from the other side of the cable
 *
 * Mitti's ATEM integration is the reference. There, the *player* watches the
 * switcher: it plays when the ATEM puts its input on program, does something
 * chosen when the input is taken away (nothing, pause, rewind, load the next
 * cue), and at the end of a cue can make the ATEM take — CUT or AUTO. Here the
 * *switcher* side does the watching, so the same four choices work with any
 * deck that speaks HyperDeck, Mitti included:
 *
 *   on program   play, or nothing
 *   on preview   rewind to the top of the clip, ready, or nothing
 *   taken off    nothing, pause, rewind, or load the next clip
 *   clip ends    take, cut, or nothing — on the screens it is on air on,
 *                optionally a set number of seconds before the last frame
 *
 * Mitti only follows the first M/E of an ATEM. A LivePremier has as many
 * screens as it has, so a deck's rules say which screens count; none means
 * every one.
 *
 * ## What "on air" means
 *
 * A deck is on air on a screen when the input it feeds is the source of a
 * visible layer in that screen's program buffer. **During a transition both
 * buffers are on air** — the one leaving and the one arriving — which is what
 * makes a deck start rolling as its take begins rather than when the mix has
 * finished and the first second of the clip has gone by unseen. It is off air
 * once the transition has settled with it in neither.
 */

import { dialectFor } from '../../src/core/dialect.js';
import { listDestinations, readLayers, presetBanks } from '../../src/core/screens.js';
import { parseConnectorId, logicalIndex } from '../../src/core/connectors.js';
import { HYPERDECK_PORT, profileOf, COMMAND_NAMES } from './protocol.js';

export const ROLES = [
  { id: 'player', label: 'Player', what: 'Feeds a switcher input. Its rules can follow what is on air.' },
  { id: 'recorder', label: 'Recorder', what: 'Records a switcher output. Record and stop from the panel, a cue or OSC.' },
  { id: 'both', label: 'Player and recorder', what: 'A deck that does both jobs in the show.' },
];

export const ON_PROGRAM = [
  { id: 'play', label: 'Play' },
  { id: 'none', label: 'Do nothing' },
];
export const ON_PREVIEW = [
  { id: 'none', label: 'Do nothing' },
  { id: 'rewind', label: 'Rewind to the top of the clip' },
];
export const ON_LEAVE = [
  { id: 'none', label: 'Do nothing' },
  { id: 'pause', label: 'Pause' },
  { id: 'rewind', label: 'Stop and rewind' },
  { id: 'next', label: 'Stop and load the next clip' },
];
export const ON_END = [
  { id: 'none', label: 'Do nothing' },
  { id: 'take', label: 'Take (the screen’s transition)' },
  { id: 'cut', label: 'Cut' },
];

const pick = (list, v, fallback = list[0].id) => (list.some((o) => o.id === v) ? v : fallback);

export const DEFAULT_RULES = Object.freeze({
  /* Off until somebody turns it on, exactly as Mitti's ATEM trigger is. A deck
     added to the list must not start rolling the next time its input is cut to. */
  automate: false,
  screens: [],
  onProgram: 'play',
  onPreview: 'none',
  onLeave: 'none',
  onEnd: 'none',
  /* Seconds before the last frame to fire the end action; 0 is on the stop. */
  lead: 0,
});

export function normaliseRules(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const lead = Number(r.lead);
  return {
    automate: r.automate === true,
    screens: Array.isArray(r.screens) ? [...new Set(r.screens.map(String).filter((s) => /^[A-Z]+\d+$/i.test(s)))] : [],
    onProgram: pick(ON_PROGRAM, r.onProgram),
    onPreview: pick(ON_PREVIEW, r.onPreview),
    onLeave: pick(ON_LEAVE, r.onLeave),
    onEnd: pick(ON_END, r.onEnd),
    lead: Number.isFinite(lead) ? Math.min(60, Math.max(0, Math.round(lead * 10) / 10)) : 0,
  };
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

/**
 * The deck list, valid whatever was in the file. A deck with no host is kept —
 * it is somebody halfway through adding one — but is never dialled.
 */
export function normaliseDecks(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.decks) ? raw.decks : []);
  const out = [];
  const taken = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name ?? '').trim().slice(0, 64) || `Deck ${out.length + 1}`;
    let id = slug(item.id) || slug(name) || `deck-${out.length + 1}`;
    for (let n = 2; taken.has(id) || RESERVED.has(id); n += 1) id = `${slug(item.id) || slug(name) || 'deck'}-${n}`;
    taken.add(id);
    const port = Number(item.port);
    const role = pick(ROLES, item.role, 'player');
    out.push({
      id,
      name,
      host: String(item.host ?? '').trim(),
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : HYPERDECK_PORT,
      profile: profileOf(item.profile).id,
      enabled: item.enabled !== false,
      role,
      input: /^input:.+$/.test(String(item.input ?? '')) ? String(item.input) : '',
      output: /^output:.+$/.test(String(item.output ?? '')) ? String(item.output) : '',
      recordName: String(item.recordName ?? '').replace(/[\r\n:]/g, ' ').trim().slice(0, 64),
      rules: normaliseRules(item.rules),
    });
  }
  return out;
}

/** Deck-list words a cue or OSC address uses for more than one deck, so no deck may be called them. */
export const GROUPS = { all: () => true, players: (d) => d.role !== 'recorder', recorders: (d) => d.role !== 'player' };
const RESERVED = new Set(Object.keys(GROUPS));

export const plays = (deck) => deck.role !== 'recorder';
export const records = (deck) => deck.role !== 'player' && profileOf(deck.profile).record;

/**
 * Which decks a name in a cue or an OSC address means: an id, a name (any
 * case), a 1-based position in the list, or one of the group words.
 */
export function resolveDecks(decks, ref) {
  const key = String(ref ?? '').trim().toLowerCase();
  if (!key) return [];
  if (GROUPS[key]) return decks.filter(GROUPS[key]);
  const byId = decks.find((d) => d.id === key || d.name.toLowerCase() === key || slug(d.name) === slug(key));
  if (byId) return [byId];
  const n = Number(key);
  if (Number.isInteger(n) && n >= 1 && n <= decks.length) return [decks[n - 1]];
  return [];
}

/* ----------------------------------------------------------- OSC address */

/**
 * `/hyperdeck/<deck>/<command> [argument]` read into a deck reference and one
 * step for `run()`. The handler and the test share this, so the dictionary
 * below is checked against what the handler actually accepts.
 *
 * @returns {{ref: string, step: object}|{error: string}}
 */
export function parseDeckOsc(address, args) {
  const m = /^\/hyperdeck\/([^/]+)\/([a-z]+)$/i.exec(String(address ?? ''));
  if (!m) return { error: `use /hyperdeck/<deck>/<${COMMAND_NAMES.join('|')}>` };
  const [, ref, word] = m;
  const command = word.toLowerCase();
  const arg = args && args.length ? args[0] : undefined;
  const step = { command };
  if (command === 'clip') step.clip = Number(arg);
  if (command === 'record' && arg != null) step.name = String(arg);
  if (command === 'play' && arg != null && Number(arg) === 1) step.loop = true;
  return { ref: decodeURIComponent(ref), step };
}

/**
 * The dictionary entries for `/hyperdeck/…`, in mynah's entry shape. `{deck}`
 * is a deck's name (lower case, spaces as `-`), its id, its 1-based position,
 * or `all`, `players` or `recorders`. One per command in `COMMANDS` —
 * `test/osc.test.js` fails when a command has no entry.
 */
export const HYPERDECK_OSC = [
  ['play', 'none, or 1 to loop', 'Play the cued clip. A group plays only its players.'],
  ['stop', 'none', 'Stop. A recorder that is recording stops recording.'],
  ['record', 'none, or a clip name', 'Start recording. Refused on a deck that cannot record; a group starts only its recorders.'],
  ['clip', 'int — a clip number', 'Cue that clip.'],
  ['next', 'none', 'Cue the next clip.'],
  ['prev', 'none', 'Cue the previous clip.'],
  ['rewind', 'none', 'Back to the start of the clip.'],
  ['end', 'none', 'To the end of the clip.'],
  ['preview', 'none', 'Show the deck’s input rather than its disk — what a recorder shows while armed. Refused on a deck that cannot record; a group sends it only to its recorders.'],
].map(([command, args, summary]) => ({ group: 'HyperDecks', address: `/hyperdeck/{deck}/${command}`, args, summary, command }));

/* ------------------------------------------------------------- cue field */

const COMMAND_WORDS = new Map([
  ...COMMAND_NAMES.map((c) => [c, c]),
  ['rec', 'record'], ['pause', 'stop'], ['goto', 'clip'], ['cue', 'clip'], ['previous', 'prev'], ['top', 'rewind'],
]);

/**
 * `Opener play; REC record Act 1; Opener clip 3` — one action per `;`, each
 * `<deck> <command> [argument]`. The deck is everything before the first word
 * that is a command, so deck names may have spaces. Throws a sentence for the
 * cue editor to show.
 */
export function parseCueText(text, decks) {
  const actions = [];
  for (const part of String(text || '').split(';').map((s) => s.trim()).filter(Boolean)) {
    const words = part.split(/\s+/);
    const at = words.findIndex((w, i) => i > 0 && COMMAND_WORDS.has(w.toLowerCase()));
    if (at < 0) throw new Error(`“${part}”: say a deck and then what to do — play, stop, record, clip N, next, prev, rewind`);
    const ref = words.slice(0, at).join(' ');
    const matched = resolveDecks(decks, ref);
    if (!matched.length) throw new Error(`“${ref}” is not a deck here (or all, players, recorders)`);
    const command = COMMAND_WORDS.get(words[at].toLowerCase());
    const rest = words.slice(at + 1).join(' ');
    const action = { kind: 'hyperdeck', deck: GROUPS[ref.toLowerCase()] ? ref.toLowerCase() : matched[0].id, command };
    if (command === 'clip') {
      const n = Number(rest);
      if (!Number.isInteger(n) || n < 1) throw new Error(`“${part}”: clip wants a clip number`);
      action.clip = n;
    } else if (command === 'record' && rest) action.name = rest;
    else if (command === 'play' && /^loop$/i.test(rest)) action.loop = true;
    actions.push(action);
  }
  return actions;
}

export function describeCueAction(a, decks = []) {
  const deck = decks.find((d) => d.id === a.deck);
  const who = deck ? deck.name : a.deck;
  const arg = a.command === 'clip' ? ` ${a.clip}` : a.command === 'record' && a.name ? ` ${a.name}` : a.loop ? ' loop' : '';
  return `${who} ${a.command}${arg}`;
}

/* ------------------------------------------------------------- on air */

/**
 * The layer source a deck's input is, on this switcher: `LIVE_3` on a
 * LivePremier, `INPUT_3` on a Midra. Asked of the dialect's own source list so
 * the spelling is never built here, and null for an input that is not fitted.
 */
export function sourceForInput(store, connector) {
  const c = parseConnectorId(connector);
  if (!c || c.side !== 'input') return null;
  const dialect = dialectFor(store);
  if (!dialect || !dialect.sources) return null;
  const n = logicalIndex(c.key);
  const found = dialect.sources(store).find((s) => s.kind === 'input' && Number(/(\d+)$/.exec(s.value)?.[1]) === n);
  return found ? found.value : null;
}

/**
 * Every screen each source is on, split into program and preview.
 *
 * @returns {Map<string, {program:Set<string>, preview:Set<string>}>}
 */
export function airState(store, sources) {
  const out = new Map([...sources].map((s) => [s, { program: new Set(), preview: new Set() }]));
  if (!sources.size) return out;
  for (const dest of listDestinations(store)) {
    const banks = presetBanks(store, dest.id);
    const inBank = (bank) => new Set(readLayers(store, dest, bank)
      .filter((l) => l.hasSource && l.opacity > 0 && sources.has(l.source))
      .map((l) => l.source));
    const program = inBank(banks.program);
    const preview = inBank(banks.preview);
    for (const s of program) out.get(s).program.add(dest.id);
    for (const s of preview) {
      /* In flight, the arriving buffer is on air too. */
      if (!banks.settled) out.get(s).program.add(dest.id);
      else if (!program.has(s)) out.get(s).preview.add(dest.id);
    }
  }
  return out;
}

/** The screens a deck's rules care about, out of a set. */
const scoped = (rules, set) => (rules.screens.length ? [...set].filter((s) => rules.screens.includes(s)) : [...set]);

/**
 * What the rules say to do, given where each deck was and where it is now.
 * Pure, so the tests can walk a show through it.
 *
 * @param {Array} decks                        normalised decks
 * @param {Map<string,{program,preview}>} prev by deck id — where each deck was
 * @param {Map<string,{program,preview}>} next by deck id — where it is now
 * @returns {Array<{deck:string, sequence:Array<{command:string}>, why:string}>}
 */
export function decide(decks, prev, next) {
  const out = [];
  for (const deck of decks) {
    const rules = deck.rules;
    if (!rules.automate || !plays(deck) || !deck.input) continue;
    const was = prev.get(deck.id);
    const now = next.get(deck.id);
    if (!was || !now) continue;
    const onBefore = scoped(rules, was.program).length > 0;
    const onNow = scoped(rules, now.program).length > 0;
    const previewNow = scoped(rules, now.preview).length > 0;
    const previewBefore = scoped(rules, was.preview).length > 0;

    if (!onBefore && onNow && rules.onProgram === 'play') {
      out.push({ deck: deck.id, sequence: [{ command: 'play' }], why: `on air on ${scoped(rules, now.program).join(', ')}` });
    } else if (onBefore && !onNow) {
      const seq = { pause: ['stop'], rewind: ['stop', 'rewind'], next: ['stop', 'next'] }[rules.onLeave];
      if (seq) out.push({ deck: deck.id, sequence: seq.map((command) => ({ command })), why: 'taken off air' });
    } else if (!onNow && !previewBefore && previewNow && rules.onPreview === 'rewind') {
      out.push({ deck: deck.id, sequence: [{ command: 'rewind' }], why: `in preview on ${scoped(rules, now.preview).join(', ')}` });
    }
  }
  return out;
}

/**
 * The end-of-clip action for one deck, or null: which screens to take or cut,
 * which are the ones in its scope that it is on air on right now. A deck that
 * is not on air ends its clip without anybody needing to see a transition.
 */
export function endAction(deck, air) {
  const rules = deck.rules;
  if (!rules.automate || rules.onEnd === 'none' || !air) return null;
  const screens = scoped(rules, air.program);
  return screens.length ? { type: rules.onEnd, screens } : null;
}
