/*
 * Preview lock during takes — the page half: the padlock, and the card.
 *
 * `core.js` decides when a destination is mid-take; this presses the
 * vendor's own PRW padlock on that screen's card, and presses it again when
 * the take lands. Everything about what the lock then refuses is Web RCS's:
 * its middleware turns away a memory recalled into a locked preview and puts
 * up its own warning.
 *
 * ## Whose padlock it is
 *
 * The padlock is shared with the operator, so this only ever opens one it
 * shut itself:
 *
 * - already shut when the take starts — the operator's; left shut after;
 * - opened by the operator mid-take — theirs again; not shut a second time,
 *   and not touched when the take lands;
 * - card not drawn when the take starts (another page, or the screen not
 *   selected) — nothing to press. Shut later if the card appears while the
 *   take is still running.
 * - card gone when the take lands — owed: opened the next time the card is
 *   drawn, so a lock is never left behind by a page change. A new take on
 *   that screen before then keeps it shut, still ours.
 *
 * ⚠️ With Web RCS's remote selection on, the padlocks live in a store shared
 * between clients, so two pages running this would both press the same
 * padlock. Each reads it first and leaves a shut one alone, which covers
 * every case but two pages pressing in the same instant. Run it in one page
 * when remote selection is in use.
 */

import { createPreviewGuard, normalise, previewTargetsOf } from './core.js';
import { cardPadlock } from '../../src/ui/preset-lock.js';
import { listDestinations } from '../../src/core/screens.js';

/** How often a frame may trigger a look at the padlocks — they are DOM reads. */
const SWEEP_MS = 200;
/** After our own press, how long before a padlock reading open means the operator opened it. */
const SETTLE_CLICK_MS = 400;
const LOG_MAX = 8;

export default function activate(ctx) {
  const settings = () => normalise(ctx.settings.get() || {});
  const doc = () => (typeof document !== 'undefined' ? document : null);
  const padlock = (id) => (doc() ? cardPadlock(id, 'PRW', doc()) : null);

  /** id -> {state: 'ours'|'theirs'|'absent'|'overridden', pressed: ms} while guarded */
  const held = new Map();
  /** Padlocks we shut whose take has landed but whose card was not drawn to open. */
  const owed = new Set();
  const log = [];
  let problem = null;

  function note(id, what) {
    log.unshift({ at: Date.now(), id, what });
    if (log.length > LOG_MAX) log.length = LOG_MAX;
    ctx.refresh();
  }

  function press(pad) {
    pad.button.click();
    return Date.now();
  }

  function lock(id, why) {
    if (owed.delete(id)) {
      held.set(id, { state: 'ours', pressed: 0 });
      note(id, 'take started — PRW still shut from the last one');
      return;
    }
    const pad = padlock(id);
    if (!pad) {
      held.set(id, { state: 'absent', pressed: 0 });
      note(id, 'take started — card not on screen, nothing to lock yet');
      return;
    }
    if (pad.shut) {
      held.set(id, { state: 'theirs', pressed: 0 });
      note(id, 'take started — PRW was already locked, left as it is');
      return;
    }
    held.set(id, { state: 'ours', pressed: press(pad) });
    note(id, why === 'take' ? 'PRW locked: take sent' : 'PRW locked: transition in flight');
  }

  function unlock(id, why) {
    const h = held.get(id);
    held.delete(id);
    if (!h || h.state !== 'ours') {
      if (h && h.state === 'overridden') note(id, 'take landed — PRW left as the operator set it');
      return;
    }
    const pad = padlock(id);
    if (!pad) {
      owed.add(id);
      note(id, 'take landed — card not on screen; PRW opens when it is');
      return;
    }
    if (pad.shut) press(pad);
    note(id, why === 'never started' ? 'PRW unlocked: the take never started' : 'PRW unlocked: take landed');
  }

  /**
   * Catch up with the page: shut a padlock whose card has appeared mid-take,
   * notice one the operator opened, and pay what is owed.
   */
  let swept = 0;
  function sweep(force = false) {
    if (!force && Date.now() - swept < SWEEP_MS) return;
    swept = Date.now();
    for (const [id, h] of held) {
      if (h.state === 'absent') {
        const pad = padlock(id);
        if (pad && !pad.shut) {
          held.set(id, { state: 'ours', pressed: press(pad) });
          note(id, 'PRW locked: card appeared mid-take');
        } else if (pad) {
          held.set(id, { state: 'theirs', pressed: 0 });
        }
      } else if (h.state === 'ours' && Date.now() - h.pressed > SETTLE_CLICK_MS) {
        const pad = padlock(id);
        if (pad && !pad.shut) {
          held.set(id, { state: 'overridden', pressed: 0 });
          note(id, 'PRW opened by the operator mid-take — left open');
        }
      }
    }
    for (const id of [...owed]) {
      const pad = padlock(id);
      if (!pad) continue;
      owed.delete(id);
      if (pad.shut) {
        press(pad);
        note(id, 'PRW unlocked: card back on screen after the take');
      }
    }
  }

  const guard = createPreviewGuard({ store: ctx.session.store, lock, unlock, settings });

  ctx.session.addEventListener('frame', (ev) => {
    guard.onFrame(ev.detail);
    if (held.size || owed.size) sweep();
  });

  /** Note a held recall in the card's history, and pass the outcome on. */
  function noted(wait, ids) {
    if (!wait) return null;
    const what = ids.includes('*') ? 'a master memory' : `a recall into ${ids.join(', ')} preview`;
    note(ids.join(', '), `${what} held until the take lands`);
    return wait.then((r) => {
      note(ids.join(', '), r.ok
        ? `${what} sent after ${(r.waitedMs / 1000).toFixed(1)} s`
        : `${what} NOT sent — ${r.message}`);
      return r;
    });
  }

  ctx.provide('preview-lock', Object.freeze({
    /** Destinations mid-take right now, whether or not a padlock could be pressed. */
    guarded: () => guard.guarded().map((g) => g.id),
    isGuarded: (id) => guard.isGuarded(id),
    /**
     * Hold a recall into these destinations' preview until their takes land:
     * null means send now; a promise resolves `{ok, message?}`, and `ok:
     * false` means do not send. `['*']` is a master memory.
     */
    holdFor: (ids) => noted(guard.whenSettled(ids), ids),
    /** The same, worked out from the writes a caller is about to send. */
    holdWrites(cmds) {
      const ids = previewTargetsOf(cmds);
      return ids ? noted(guard.whenSettled(ids), ids) : null;
    }
  }));

  /* What happened, for `window.__WRU.shared('preview-lock')` on a day with hardware. */
  ctx.share({
    guarded: () => guard.guarded(),
    held: () => Object.fromEntries(held),
    owed: () => [...owed],
    log: () => log.slice()
  });

  const save = (patch) => ctx.settings.set(patch).then(
    () => { problem = null; ctx.refresh(); },
    (err) => { problem = err.message; ctx.refresh(); });

  function render() {
    const { h, card, note: say, readout } = ctx.kit;
    const s = settings();
    const store = ctx.session.store;
    const dests = store && store.ready ? listDestinations(store) : [];

    const boxes = dests.length
      ? h('div', { class: 'aw-flex-row-center-v aw-gap-col-large aw-flex-wrap' },
        ...dests.map((d) => h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', style: { cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: s.skip.includes(d.id) ? null : 'checked',
            onChange: (ev) => {
              const skip = new Set(s.skip);
              if (ev.target.checked) skip.delete(d.id);
              else skip.add(d.id);
              void save({ skip: [...skip] });
            }
          }),
          h('span', { class: 'aw-font-body-1', text: d.label ? `${d.id} ${d.label}` : d.id }))))
      : say('info', 'The screens appear here once the switcher has answered.');

    const now = guard.guarded();
    const status = h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
      readout('Mid-take now', now.length ? now.map((g) => {
        const st = held.get(g.id);
        return st && st.state === 'ours' ? `${g.id} (PRW locked)` : `${g.id} (${st ? st.state : 'waiting'})`;
      }).join(', ') : 'nothing', { tone: now.length ? null : 'tertiary' }),
      owed.size ? readout('To unlock when drawn', [...owed].join(', '), { tone: 'warn' }) : null);

    const history = log.length
      ? h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        ...log.map((e) => h('div', { class: 'aw-font-caption aw-text-secondary',
          text: `${new Date(e.at).toLocaleTimeString()} · ${e.id} · ${e.what}` })))
      : null;

    return card('Preview lock during takes',
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Lock PRW while these transition' }),
      boxes,
      status,
      history,
      problem ? say('warn', `Could not save: ${problem}`) : null,
      say('info', 'When a take starts on a ticked screen — TAKE from this page, or a transition reported from anywhere — '
        + 'its PRW padlock on the Screens / Aux. card is shut, and opened again when the take lands. Web RCS then refuses a '
        + 'memory recalled into that preview mid-take, with its own warning, instead of loading it into the picture fading up. '
        + 'A padlock you shut yourself is never opened by this, and one you open mid-take is left open.'),
      say('info', 'This app’s own recalls wait instead of being refused: a Timeline cue, a Recall in the Memories panel or a '
        + 'line at the Console that loads a preview mid-take is sent the moment the take lands, and cues fire in the order GO '
        + 'was pressed. If the take has not landed by its take time plus 3 s (a T-bar parked half way), the recall is not sent, '
        + 'and says so.'),
      say('warn', 'Companion, OSC, the front panel and other browsers are not held back. Only cards drawn on the page can be locked.'));
  }

  ctx.ui.settingsSection({ id: 'preview-lock', order: 12, render });
}
