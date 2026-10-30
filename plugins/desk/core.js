/*
 * The desk screen's model: where the cells go, which page a key means, and
 * what to say about the line. Pure — the page half and the screen window both
 * import it, and so do the tests.
 *
 * The geometry is the desk's, not ours. The ASUS PA147CDV is 1920 × 550, and
 * each cell sits over its knob: the screen pixel of every encoder and wheel is
 * in the keymap table of `docs/KEYPAD.md` (stoatworks-labs/lpp-control-surface),
 * which `mechanical/layout.py` writes from the same numbers as the case, at
 * 5.58 px/mm. Move a knob there and these move with it — by hand, here, until
 * this file is generated too. The cell sizes and rows are `docs/screen.svg`'s.
 */

/** The profile the desk's encoders and wheels are mapped by (vendored awj-surface). */
export const PROFILE = 'lpp-surface-p1.json';

export const SCREEN = Object.freeze({ width: 1920, height: 550, margin: 12 });

/** Every knob, left to right, with its screen pixel from the keymap. */
export const KNOBS = Object.freeze([
  { control: 'cc:0:16', name: 'E1', x: 39, kind: 'small' },
  { control: 'cc:0:17', name: 'E2', x: 260, kind: 'small' },
  { control: 'cc:0:18', name: 'E3', x: 481, kind: 'small' },
  { control: 'cc:0:19', name: 'E4', x: 703, kind: 'small' },
  { control: 'cc:0:20', name: 'Wheel A', x: 1063, kind: 'wheel' },
  { control: 'cc:0:21', name: 'Wheel B', x: 1420, kind: 'wheel' },
  { control: 'cc:0:22', name: 'Wheel C', x: 1777, kind: 'wheel' }
]);

const CELL = Object.freeze({
  small: { width: 207.3, top: 300, height: 230 },
  wheel: { width: 340.98, top: 260, height: 270 }
});

/**
 * One cell per knob, centred on it and kept on the screen.
 *
 * A cell near an edge is cut back to the margin rather than slid inwards, so
 * its tick still points straight down at the knob — E1, 39 px in, has a
 * narrow cell, as the mock-up does.
 */
export function cells() {
  const { width, margin } = SCREEN;
  return KNOBS.map((k) => {
    const c = CELL[k.kind];
    const left = Math.max(margin, k.x - c.width / 2);
    const right = Math.min(width - margin, k.x + c.width / 2);
    return { ...k, left, width: right - left, top: c.top, height: c.height, tick: k.x };
  });
}

/** The pages an attribute key on the keypad names directly. */
const KEYED = new Set(['position', 'size', 'opacity', 'source']);

/**
 * The page an attribute key means.
 *
 * Source, Size, Position and Opacity each name their own. Category has no
 * page of that name — it is mynah's word for a record-mask category — so it
 * steps through the pages no key names (Crop, Border), from whichever is
 * showing. Null when the profile has no such page.
 */
export function pageFor(attribute, current, pages) {
  const ids = (pages || []).map((p) => p.id);
  if (attribute !== 'category') return ids.includes(attribute) ? attribute : null;
  const rest = ids.filter((id) => !KEYED.has(id));
  if (!rest.length) return null;
  const at = rest.indexOf(current);
  return rest[(at + 1) % rest.length];
}

/**
 * What Enter would do, in words, for the line under the command line.
 *
 * `outcome` is the Console line's own (`plugins/console/panel.js`): the
 * compiler's summary and the count, and whether it reaches program. The
 * question an operator is asking of this line is the last part, so it is
 * always answered — and "can't tell" is said as such, never as "no".
 */
export function outcomeText(outcome, { error = null } = {}) {
  if (error) return { tone: 'error', text: error };
  if (!outcome) return { tone: 'dim', text: '' };
  if (outcome.fn === 'Select') return { tone: 'ok', text: `→ the scope becomes what this selects — ${outcome.summary.replace(/^Select /, '')}` };
  if (outcome.fn === 'Clear') return { tone: 'ok', text: '→ clears the scope' };
  const n = outcome.ops + outcome.reads;
  if (!n) return { tone: 'dim', text: `→ ${outcome.summary || 'nothing to send'}` };
  const count = `${n} ${outcome.reads && !outcome.ops ? 'read' : 'op'}${n === 1 ? '' : 's'}`;
  const air = outcome.program === true ? 'REACHES PROGRAM'
    : outcome.program === false ? 'nothing reaches program'
      : 'can’t tell whether this reaches program';
  return {
    tone: outcome.program === true ? 'air' : outcome.program === false ? 'ok' : 'warn',
    text: `→ ${count}: ${outcome.summary} — ${air}`
  };
}

/**
 * A parameter's value as the cell shows it.
 *
 * Positions, sizes, crops and borders are pixels; an opacity is the device's
 * own number (0–256 for a layer, 0–255 for a border); take times are tenths
 * of a second. Undefined is no value, and shows
 * as a dash rather than a zero — an unread parameter is not at zero.
 */
export function formatValue(path, value) {
  if (value === undefined || value === null) return '—';
  const leaf = Array.isArray(path) ? String(path[path.length - 1]) : '';
  if (/^take(Up|Down)Time$/.test(leaf) && typeof value === 'number') return `${(value / 10).toFixed(1)} s`;
  if (typeof value === 'number') {
    const n = Number.isInteger(value) ? value : Math.round(value);
    return leaf === 'opacity' ? String(n) : `${n} px`;
  }
  if (typeof value === 'string') return value.replace(/_/g, ' ');
  return String(value);
}

/**
 * The values of one cell: every binding of that control on the page in view,
 * deduplicated. Size's "both" wheel shows `1920 px · 1080 px`; Speed, whose
 * two bindings hold one value, shows it once.
 */
export function cellValue(values) {
  const out = [];
  for (const v of values) if (!out.includes(v)) out.push(v);
  return out.length ? out.join(' · ') : '—';
}
