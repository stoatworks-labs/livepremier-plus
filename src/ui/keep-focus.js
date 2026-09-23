/*
 * Keeping the operator's place across a repaint.
 *
 * The panels are drawn immediate-mode: every repaint throws the panel's DOM
 * away and builds it again from state, and the app repaints on every frame the
 * switcher sends — about once a second from its timers alone. That is simple
 * and it is right for everything except the one element the operator is
 * holding. Measured on 0.12.0 in the browser, 2026-09-23: with a field focused
 * in the Edit page, Memories, Matrix Routing, Pitch or Companion, every control
 * in the panel was replaced within 2.6 s and the caret went with it; a dropdown
 * opened in any of them closed before it could be used. Typing a router's
 * address or a pitch in millimetres meant typing a character or two between
 * repaints.
 *
 * Fixing it panel by panel had already been tried twice — a `busy()` per panel,
 * each remembering to set a flag on focus — and it had been forgotten in more
 * panels than it had been remembered in. So it is done once, here, at the three
 * places that swap a panel's DOM (`Shell.refresh`, `TabHost.refresh`, and the
 * pop-out windows):
 *
 * - **A text field keeps the caret, the selection and what was typed.** Before
 *   the swap the focused field is noted; after it, the same field in the new
 *   DOM gets them back. "The same field" is its `data-lpp-key` if it has one,
 *   and otherwise its shape — tag, type, name, placeholder, title, class — and
 *   its position among fields of that shape. Text typed and **not yet
 *   committed** wins over the value the panel redrew from, so a field whose
 *   panel keeps no draft is not reset. Once it is committed — Enter, a change,
 *   or leaving the field — the panel's value is the truth again: a line the
 *   Console has just run must clear, and a value the switcher clamped must show
 *   clamped, not as typed. (The first version kept typed text for as long as
 *   the field held focus, and the Console's line never cleared.)
 * - **An open dropdown holds the repaint.** A `<select>` whose list is open
 *   cannot be carried across — replacing it closes the list under the pointer —
 *   so while one of ours is being picked from, the repaint waits. It is let go
 *   by the change it was opened for, by Escape or Tab, or by leaving it.
 *
 * A panel that knows better can still say so: `busy()` holds repaints outright,
 * and a panel that redraws in place is left alone (see `Shell.refresh`).
 */

const FIELD = 'input, textarea, select';
const NOT_TEXT = /^(checkbox|radio|button|submit|reset|file|range|color|image|hidden)$/i;

/** Can the operator type into it, and so hold a caret in it? */
const textLike = (el) => el.tagName === 'TEXTAREA'
  || (el.tagName === 'INPUT' && !NOT_TEXT.test(el.getAttribute('type') || el.type || 'text'));

/** What makes two fields in successive repaints "the same field". */
function shape(el) {
  const key = el.getAttribute && el.getAttribute('data-lpp-key');
  if (key) return `key:${key}`;
  return [el.tagName, el.getAttribute('type') || '', el.getAttribute('name') || '',
    el.getAttribute('placeholder') || '', el.getAttribute('title') || '', el.className || ''].join('|');
}

const fieldsIn = (root) => [...root.querySelectorAll(FIELD)];

/* ------------------------------------------------- open dropdowns, typed text */

/** The `<select>` whose list is (probably) open right now, or null. */
let picking = null;
/* Text fields typed into since they were last committed. */
const uncommitted = new WeakSet();
/* Documents already followed — the page, and each pop-out window's own. */
const tracked = new WeakSet();

/**
 * Follow which dropdown is being picked from, and which text field holds
 * typing nobody has committed yet.
 *
 * There is no event for "the list opened" or "the list closed", so this goes by
 * what opens and closes one: a press on it opens it, and the change it was
 * opened for, Escape, Tab or the caret leaving it closes it. Typing is simpler:
 * an `input` makes a field uncommitted, and Enter, a `change` or leaving it
 * commits it. Installed once per document, at the capture phase, so no
 * panel's own handler can hide any of it — and so Enter is seen as a commit
 * before the panel acts on it.
 */
export function trackFields(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || tracked.has(doc)) return;
  tracked.add(doc);
  doc.addEventListener('mousedown', (ev) => {
    const select = ev.target && ev.target.closest ? ev.target.closest('select') : null;
    picking = select || null;
  }, true);
  doc.addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (!t) return;
    /* Enter commits a line; in a textarea it is only a new line. */
    if (ev.key === 'Enter' && t.tagName === 'INPUT') uncommitted.delete(t);
    if (t.tagName !== 'SELECT') return;
    if (ev.key === 'Escape' || ev.key === 'Tab') picking = null;
    else if (ev.key === ' ' || ev.key === 'Enter' || ev.key === 'F4' || (ev.altKey && /Arrow/.test(ev.key))) picking = t;
  }, true);
  doc.addEventListener('input', (ev) => {
    if (ev.target && ev.target.matches && ev.target.matches(FIELD) && textLike(ev.target)) uncommitted.add(ev.target);
  }, true);
  doc.addEventListener('change', (ev) => {
    uncommitted.delete(ev.target);
    if (ev.target === picking) picking = null;
  }, true);
  doc.addEventListener('focusout', (ev) => {
    uncommitted.delete(ev.target);
    if (ev.target === picking) picking = null;
  }, true);
}

/* ------------------------------------------------------------ capture, restore */

/**
 * Replace `host`'s contents with what `build()` returns, keeping the operator's
 * place — for the places that repaint a whole container rather than a panel
 * through `Shell`. Returns false, having built nothing, when a dropdown in it
 * is open.
 */
export function repaint(host, build) {
  const place = captureFocus(host);
  if (place && place.hold) return false;
  const node = build();
  host.textContent = '';
  host.append(node);
  restoreFocus(host, place);
  return true;
}

/**
 * Note where the operator is inside `root`, before it is redrawn.
 *
 * @returns {null | {hold: boolean, el: Element, shape: string, index: number,
 *                   value?: string, dirty?: boolean, start?: number, end?: number, direction?: string}}
 *          null when nothing of ours has focus. `hold` means do not redraw now.
 */
export function captureFocus(root) {
  const doc = root && root.ownerDocument;
  const el = doc ? doc.activeElement : null;
  if (!el || !root.contains(el) || !el.matches || !el.matches(FIELD)) return null;

  const s = shape(el);
  const token = {
    hold: el.tagName === 'SELECT' && picking === el,
    el,
    shape: s,
    index: fieldsIn(root).filter((f) => shape(f) === s).indexOf(el)
  };
  if (textLike(el)) {
    token.value = el.value;
    /* Typed and not yet committed: the value the panel draws from would undo
       it. In a document nobody is following, the nearest guess is whether it
       differs from what it was drawn with. */
    token.dirty = tracked.has(doc) ? uncommitted.has(el) : el.value !== el.defaultValue;
    /* Number and some other inputs throw on reading a selection. */
    try {
      token.start = el.selectionStart;
      token.end = el.selectionEnd;
      token.direction = el.selectionDirection;
    } catch { /* no selection to keep */ }
  }
  return token;
}

/**
 * Give the operator their place back after `root` was redrawn.
 *
 * A no-op when the field that had focus survived the redraw — a panel that
 * redraws in place may not have touched it — or when its counterpart cannot be
 * found, which is a panel whose shape changed under the caret: better nothing
 * focused than the wrong field.
 */
export function restoreFocus(root, token) {
  if (!token || !root) return;
  if (token.el.isConnected && root.ownerDocument.activeElement === token.el) return;

  const match = fieldsIn(root).filter((f) => shape(f) === token.shape)[token.index];
  if (!match) return;

  if (token.dirty && textLike(match)) {
    if (match.value !== token.value) match.value = token.value;
    /* Still not committed, in its new element: the next repaint keeps it too. */
    uncommitted.add(match);
  }
  try { match.focus({ preventScroll: true }); } catch { return; }
  if (token.start != null && textLike(match)) {
    try { match.setSelectionRange(token.start, token.end, token.direction || 'none'); } catch { /* not a text control after all */ }
  }
}
