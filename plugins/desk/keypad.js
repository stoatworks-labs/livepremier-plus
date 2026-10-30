/*
 * The desk's Mynah keypad: MIDI notes in, words on a Console line out.
 *
 * Each key puts one word on the line exactly as if it had been typed, and
 * Please runs it. The table below is the contract with the controller, and it
 * is the desk's own: the keymap block of `docs/KEYPAD.md` in
 * stoatworks-labs/lpp-control-surface, which `mechanical/layout.py` writes. A
 * key's note is 24 + row × 10 + col; a big key (TAKE, 0, Please) sits on two
 * or four switches and answers on its first switch's note only. The others
 * (55, 64, 65, 71, 73) are swallowed here on purpose: a firmware that sent two
 * notes for one press of TAKE would take, and then take back.
 * `test/desk.test.js` checks this table against that file when a checkout of
 * it is there.
 *
 * Pure: no DOM, no MIDI, no device. It drives anything shaped like a Console
 * line (`plugins/console/panel.js`, made through the `console` service):
 * `state.line`, `setLine`, `execute`, `runCommand` and `clear`.
 *
 * ## What the keys do, and why
 *
 * - **Whole words only.** No short forms: mynah works its abbreviations out
 *   from the whole vocabulary, so a short form changes when a keyword is added.
 * - **Digits make numbers.** 1 then 2 is `12`, and `%` joins the number before
 *   it (`50%`; mynah reads `50 %` as an error).
 * - **TAKE is not a word.** It runs `Take` at once, for the sticky scope,
 *   whatever is half-typed on the line, and leaves the line alone. Shift+TAKE
 *   types the word instead, for a one-off scope (`Take Screen 1 Thru 4`).
 * - **Oops takes back a word, not a letter** — `12` is one word, and so is a
 *   quoted label.
 * - **Clear** is mynah's: the line, then on an empty line the scope.
 * - **The attribute keys page the wheels** on an empty line (Source, Size,
 *   Position, Opacity, Category); with anything on the line they type their
 *   word, which is where the grammar wants them.
 * - **Nothing here types Program.** Only the Program key does. A Recall with
 *   no buffer named goes to preview — mynah's default, kept so that an
 *   under-specified command can never reach air.
 */

/** Every key, by its note. `act` is what it does; `word` what it types. */
export const KEYS = Object.freeze([
  { note: 24, key: 'Screen', act: 'word', word: 'Screen' },
  { note: 25, key: 'Master', act: 'word', word: 'Master' },
  { note: 26, key: 'Source', act: 'attribute', word: 'Source', page: 'source' },
  { note: 27, key: 'Recall', act: 'word', word: 'Recall' },
  { note: 28, key: 'Store', act: 'word', word: 'Store' },
  { note: 29, key: 'Clear', act: 'clear' },
  { note: 30, key: '−', act: 'word', word: '-' },
  { note: 31, key: 'Thru', act: 'word', word: 'Thru' },
  { note: 32, key: '+', act: 'word', word: '+' },
  { note: 33, key: 'At', act: 'word', word: 'At' },
  { note: 34, key: 'Aux', act: 'word', word: 'Aux' },
  { note: 35, key: 'Memory', act: 'word', word: 'Memory' },
  { note: 36, key: 'Size', act: 'attribute', word: 'Size', page: 'size' },
  { note: 37, key: 'Select', act: 'word', word: 'Select' },
  { note: 38, key: 'Delete', act: 'word', word: 'Delete' },
  { note: 39, key: 'Oops', act: 'oops' },
  { note: 40, key: '7', act: 'digit', word: '7' },
  { note: 41, key: '8', act: 'digit', word: '8' },
  { note: 42, key: '9', act: 'digit', word: '9' },
  { note: 43, key: 'If', act: 'word', word: 'If' },
  { note: 44, key: 'Layer', act: 'word', word: 'Layer' },
  { note: 45, key: 'Multiviewer', act: 'word', word: 'Multiviewer' },
  { note: 46, key: 'Position', act: 'attribute', word: 'Position', page: 'position' },
  { note: 47, key: 'Set', act: 'word', word: 'Set' },
  { note: 48, key: 'Label', act: 'word', word: 'Label' },
  { note: 49, key: 'Shift', act: 'shift' },
  { note: 50, key: '4', act: 'digit', word: '4' },
  { note: 51, key: '5', act: 'digit', word: '5' },
  { note: 52, key: '6', act: 'digit', word: '6' },
  { note: 53, key: '%', act: 'percent', word: '%' },
  { note: 54, key: 'TAKE', act: 'take', switches: 4 },
  { note: 56, key: 'Opacity', act: 'attribute', word: 'Opacity', page: 'opacity' },
  { note: 57, key: 'Preview', act: 'word', word: 'Preview' },
  { note: 58, key: 'Program', act: 'word', word: 'Program' },
  { note: 59, key: 'Still', act: 'word', word: 'Still' },
  { note: 60, key: '1', act: 'digit', word: '1' },
  { note: 61, key: '2', act: 'digit', word: '2' },
  { note: 62, key: '3', act: 'digit', word: '3' },
  { note: 63, key: 'Please', act: 'enter', switches: 2 },
  { note: 66, key: 'Category', act: 'attribute', word: 'Category', page: 'category' },
  { note: 67, key: 'Colour', act: 'word', word: 'Colour' },
  { note: 68, key: 'None', act: 'word', word: 'None' },
  { note: 69, key: 'Audio', act: 'word', word: 'Audio' },
  { note: 70, key: '0', act: 'digit', word: '0', switches: 2 },
  { note: 72, key: 'U1', act: 'user' }
]);

/** The MIDI channel the desk speaks on: channel 1, which is 0 on the wire. */
export const CHANNEL = 0;

const BY_NOTE = new Map(KEYS.map((k) => [k.note, k]));

/** The big keys' other switches: TAKE's 55, 64 and 65, Please's 73, 0's 71. */
export const SECOND_SWITCHES = Object.freeze([55, 64, 65, 71, 73]);
const SECOND = new Set(SECOND_SWITCHES);

/** The key a note belongs to, or undefined — for a second switch of a big key too. */
export const keyFor = (note) => BY_NOTE.get(note);

/* A token at the end of the line: a quoted label (closed or still open), or a word. */
const LAST_TOKEN = /\s*("[^"]*"?|\S+)\s*$/;
const NUMBER_AT_END = /(^|\s)\d+$/;

/**
 * Add one key's text to a line, by the rules above. Pure, for the tests.
 *
 * @param {string} line what is on the line now
 * @param {{act: string, word: string}} key
 * @returns {string} the line afterwards
 */
export function typeKey(line, key) {
  const now = line.replace(/\s+$/, '');
  if (!now) return key.act === 'percent' ? line : key.word;
  /* A digit after a number carries on the number; % closes it. */
  if ((key.act === 'digit' || key.act === 'percent') && NUMBER_AT_END.test(now)) return now + key.word;
  /* % with no number before it has nothing to be a percentage of: say nothing
     rather than type a character mynah will refuse. */
  if (key.act === 'percent') return now;
  return `${now} ${key.word}`;
}

/** Take the last word off a line: `12`, `Memory`, `"Walk in"`. */
export function oops(line) {
  return line.replace(LAST_TOKEN, '');
}

/**
 * The keypad, bound to a Console line.
 *
 * @param {object} opts
 * @param {object} opts.line a Console line (`console` service's `line()`)
 * @param {(page: string) => void} [opts.onPage] an attribute key on an empty
 *   line: `source`, `size`, `position`, `opacity` or `category`
 * @param {(key: object) => void} [opts.onUser] U1, which has no job of its own yet
 * @param {(key: object, what: string) => void} [opts.onKey] every key, for a log
 */
export function createKeypad({ line, onPage = () => {}, onUser = () => {}, onKey = () => {} }) {
  let shift = false;
  const text = () => String(line.state.line || '');

  function press(key) {
    switch (key.act) {
      case 'shift':
        shift = true;
        return 'shift';
      case 'take':
        if (shift) { line.setLine(typeKey(text(), { act: 'word', word: 'Take' })); return 'typed Take'; }
        line.runCommand('Take');
        return 'take';
      case 'enter':
        line.execute();
        return 'enter';
      case 'clear':
        line.clear();
        return 'clear';
      case 'oops':
        line.setLine(oops(text()));
        return 'oops';
      case 'user':
        onUser(key);
        return 'user';
      case 'attribute':
        if (!text().trim()) { onPage(key.page); return `page ${key.page}`; }
        line.setLine(typeKey(text(), key));
        return `typed ${key.word}`;
      default:
        line.setLine(typeKey(text(), key));
        return `typed ${key.word}`;
    }
  }

  /** A note on. Returns true when the note is the keypad's. */
  function noteOn(note) {
    if (SECOND.has(note)) return true;
    const key = keyFor(note);
    if (!key) return false;
    onKey(key, press(key));
    return true;
  }

  /** A note off. Only Shift cares: it is held, not toggled. */
  function noteOff(note) {
    if (SECOND.has(note)) return true;
    const key = keyFor(note);
    if (!key) return false;
    if (key.act === 'shift') shift = false;
    return true;
  }

  /**
   * Raw MIDI bytes. Notes on channel 1 that are the keypad's are handled and
   * answer true; anything else — the encoders, another channel — answers
   * false and is somebody else's. A note on at velocity 0 is a note off.
   */
  function handle(bytes) {
    if (!bytes || bytes.length < 3) return false;
    const status = bytes[0] & 0xf0;
    if ((bytes[0] & 0x0f) !== CHANNEL) return false;
    if (status === 0x90 && bytes[2] > 0) return noteOn(bytes[1]);
    if (status === 0x80 || status === 0x90) return noteOff(bytes[1]);
    return false;
  }

  return { noteOn, noteOff, handle, get shift() { return shift; } };
}
