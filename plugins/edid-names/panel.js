/*
 * Plug names — the Plug Names tab on the vendor's EDID page.
 *
 * One card per input plug with an EDID, drawn as From Formats draws one per
 * format: the input and its label, the name the plug will give, a short-name
 * field for a label too long for an EDID, what the plug says now, and Name and
 * Undo. Redrawn from the store whenever an input changes, through
 * `ui/keep-focus.js`'s `repaint`, so a short name being typed survives the
 * switcher's frames.
 *
 * Every write is a hot-plug for whatever is connected, so nothing here writes
 * by itself: not when a label changes, not when a short name is typed. A card
 * whose plug no longer gives the name it should says so, and waits for Name.
 * Naming more than one plug, or one that is on program, asks first.
 */

import { h, button } from '../../src/ui/dom.js';
import { repaint, trackFields } from '../../src/ui/keep-focus.js';
import { NAME_MAX, nameFor, plugRows, withShortName, namePlugs, undoPlugs, emptyDocument } from './core.js';

const WATCHED = [['device', 'inputList'], ['device', 'preconfig', 'inputs']];
const touches = (path) => Array.isArray(path) && WATCHED.some((w) => w.every((k, i) => path[i] === k));

/* Reasons that are how things are, not something gone wrong. */
const QUIET = /mosaic|no label/;

export function createNamesPanel({ target, session, storage, log, win = window }) {
  let saved = null;
  let loadError = null;
  let busy = false;
  let said = '';
  let stopped = false;

  trackFields(target.ownerDocument);
  const rows = () => (session.store.ready ? plugRows(session.store, saved || emptyDocument()) : null);

  /* ---------------------------------------------------------------- state */

  async function load() {
    try {
      saved = (await storage.load()) || emptyDocument();
      if (!saved.plugs) saved = { ...saved, plugs: {} };
      loadError = null;
    } catch (err) {
      saved = null;
      loadError = err;
      log.warn('plug names', err);
    }
    draw();
  }

  async function keep(next) {
    await storage.save(next);
    saved = next;
  }

  async function setShort(row, text) {
    if (!saved) return;
    try {
      await keep(withShortName(saved, row.id, row.label, text));
    } catch (err) {
      said = err.message;
    }
    draw();
  }

  /**
   * Name or undo `list`, after asking when it is more than one plug or one on
   * program. One at a time, each waited for; the panel stays drawn meanwhile.
   */
  async function run(kind, drawn) {
    if (!saved || busy) return;
    /* As the plugs are now, not as they were when the card was drawn. */
    const ids = new Set(drawn.map((r) => r.id));
    const list = (rows() || []).filter((r) => ids.has(r.id) && (kind === 'name' ? r.bytes && !r.done : r.undo));
    if (!list.length) return;
    const onProgram = list.filter((r) => r.onAir === 'program').map((r) => r.title);
    if (list.length > 1 || onProgram.length) {
      const what = kind === 'name'
        ? list.map((r) => `${r.title} → ${r.name}`).join(', ')
        : list.map((r) => r.title).join(', ');
      const air = onProgram.length ? `\n\n${onProgram.join(', ')} ${onProgram.length === 1 ? 'is' : 'are'} on program: the picture drops out on screen while the source comes back.` : '';
      const text = `${kind === 'name' ? 'Name' : 'Undo'} ${what}?\n\nEach plug is unplugged and replugged for whatever is connected to it: a second or two of black from that source, and a computer may rearrange its displays.${air}`;
      if (!win.confirm(text)) return;
    }
    busy = true;
    said = kind === 'name' ? 'Naming…' : 'Putting back…';
    draw();
    try {
      const act = kind === 'name' ? namePlugs : undoPlugs;
      const res = await act(session, list, { doc: saved, save: keep });
      saved = res.doc;
      said = [...res.steps, ...res.problems].join('; ') || 'Nothing needed doing.';
      (res.ok ? log.info : log.warn)(`plug names ${kind}: ${said}`);
    } catch (err) {
      said = `Stopped before writing: ${err.message}`;
      log.warn('plug names', err);
    } finally {
      busy = false;
      draw();
    }
  }

  /* -------------------------------------------------------------- drawing */

  function draw() {
    if (stopped) return;
    repaint(target, build);
  }

  function build() {
    const list = rows();
    const blocked = !saved || busy;
    const todo = (list || []).filter((r) => r.bytes && !r.done);
    const undoable = (list || []).filter((r) => r.undo);

    const head = h('div', { class: 'aw-flex-col aw-gap-row-small aw-padding-big' },
      h('div', { class: 'aw-flex-row-center-v-space-between aw-gap-col-medium', style: { flexWrap: 'wrap' } },
        h('div', { class: 'aw-font-subtitle-1', text: 'What a computer plugged into each input sees' }),
        h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
          button(todo.length ? `Name ${todo.length} ${todo.length === 1 ? 'plug' : 'plugs'}` : 'All named', {
            disabled: blocked || !todo.length,
            title: 'Give every plug that is out of date its name and serial, one at a time',
            onClick: () => run('name', todo)
          }),
          button(undoable.length ? `Undo ${undoable.length}` : 'Nothing to undo', {
            disabled: blocked || !undoable.length,
            title: 'Put back the EDID each plug served before it was named here',
            onClick: () => run('undo', undoable)
          }))),
      h('div', {
        class: 'aw-font-caption aw-text-tertiary',
        text: 'The input’s label goes into its plug’s EDID as the display name, and the input’s number as its '
          + `serial, so two plugs are two displays. An EDID has room for ${NAME_MAX} plain characters, so a longer `
          + 'label is cut: type a short name instead. Everything else in the EDID the plug already has stays as it is. '
          + 'Each rename unplugs and replugs the source for a second or two, and a computer may rearrange its displays, '
          + 'so name plugs before the show. An EDID loaded onto a plug later brings its own name back.'
      }),
      loadError ? h('div', {
        class: 'aw-font-caption wru-warn',
        text: `${loadError.message}. Nothing is written until it can be read, or Undo would have nothing to go back to. Reload the page to try again.`
      }) : null,
      said ? h('div', { class: 'aw-font-caption aw-text-secondary', text: said }) : null);

    let body;
    if (!list) body = h('div', { class: 'aw-padding-big aw-text-tertiary', text: 'Waiting for the switcher’s inputs.' });
    else if (!list.length) body = h('div', { class: 'aw-padding-big aw-text-tertiary', text: 'No input on this switcher has a plug with an EDID.' });
    else body = h('div', { class: 'aw-flex-col aw-gap-row-small aw-padding-big' }, list.map((r) => plugCard(r, blocked)));
    return h('div', {}, head, body);
  }

  function plugCard(r, blocked) {
    const status = r.why
      ? h('span', { class: QUIET.test(r.why) ? 'aw-text-tertiary' : 'wru-warn', text: r.why })
      : r.done
      ? h('span', { class: 'aw-text-success', text: `Named, serial ${r.number}` })
      : h('span', {
        class: 'aw-text-secondary',
        text: `Shows ${r.current.name || 'no name'}, serial ${r.current.serial}`
          + (r.replaced ? ' — an EDID loaded since took the place of the one named here' : '')
      });
    const air = r.onAir
      ? h('span', { class: r.onAir === 'program' ? 'wru-warn' : 'aw-text-secondary', text: ` · on ${r.onAir}` })
      : null;

    const count = h('span', { class: 'aw-font-caption aw-text-tertiary', style: { flex: 'none' } });
    const counted = (typed) => {
      const own = nameFor(typed).text;
      const shown = own || r.auto;
      count.textContent = shown ? `${shown.length}/${NAME_MAX}${!own && r.clipped ? ', cut from the label' : ''}` : '';
    };
    counted(r.short);
    const field = h('input', {
      type: 'text', class: 'wru-input', value: r.short || '', placeholder: r.auto || 'Short name',
      maxlength: String(NAME_MAX), spellcheck: 'false', 'aria-label': `${r.title} short name`,
      title: `At most ${NAME_MAX} plain characters. Blank uses the label.`,
      dataset: { lppKey: `plug-name-${r.id}` },
      disabled: !saved || /mosaic/.test(r.why || '') ? 'disabled' : null,
      style: { flex: '0 1 11rem', minWidth: '0' },
      onInput: (ev) => counted(ev.target.value),
      onChange: (ev) => setShort(r, ev.target.value)
    });

    return h('div', {
      class: 'aw-flex-row aw-border-radius aw-overflow-hidden',
      dataset: { lppPlugName: r.id },
      style: { background: 'var(--lpp-card, rgba(255,255,255,0.04))' }
    },
      h('div', { class: 'aw-padding aw-font-body-1', style: { minWidth: '3.5rem' }, text: r.title }),
      h('div', { class: 'aw-flex-item aw-padding aw-flex-col aw-gap-row-mini' },
        h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
          h('span', { class: 'aw-font-bold', text: r.name || '—' }),
          r.label && r.label !== r.name ? h('span', { class: 'aw-font-italic aw-text-tertiary', text: r.label }) : null),
        h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' }, field, count),
        h('div', { class: 'aw-font-caption' }, status, air)),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-padding' },
        r.bytes && !r.done
          ? button('Name', {
            variant: r.onAir === 'program' ? 'danger' : 'default',
            disabled: blocked,
            title: `Give ${r.title}’s EDID the name ${r.name} and the serial ${r.number}`,
            onClick: () => run('name', [r])
          })
          : null,
        r.undo
          ? button('Undo', {
            disabled: blocked,
            title: `Put back the EDID ${r.title} served before it was named here`,
            onClick: () => run('undo', [r])
          })
          : null));
  }

  /* -------------------------------------------------------------- running */

  let queued = false;
  const schedule = () => {
    if (queued || stopped) return;
    queued = true;
    setTimeout(() => { queued = false; draw(); }, 150);
  };
  const onFrame = (ev) => { if (touches(ev.detail && ev.detail.path)) schedule(); };
  session.addEventListener('frame', onFrame);
  session.addEventListener('state', schedule);
  const store = session.store;
  if (store.addEventListener) store.addEventListener('ready', schedule);

  draw();
  load();

  return {
    stop() {
      stopped = true;
      session.removeEventListener('frame', onFrame);
      session.removeEventListener('state', schedule);
      if (store.removeEventListener) store.removeEventListener('ready', schedule);
    }
  };
}
