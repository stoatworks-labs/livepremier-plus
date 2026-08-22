/*
 * The advanced timeline editor: a cue list with an inspector under it.
 *
 * The QLab arrangement, because it is the one every operator who has run a
 * theatre show already knows: a numbered list you drive from the keyboard, and
 * a panel underneath showing everything about whichever cue is selected. The
 * list stays readable because it only carries what you scan — number, time,
 * name, what it does — and everything else lives in the inspector.
 *
 * The Timeline tab in Web RCS is 360 pixels wide. That is enough to see a
 * standby and press GO, and nowhere near enough to write a show in. This is
 * where the writing happens.
 *
 * ## It edits the same stack, live
 *
 * There is no separate document and no import step. The popout drives the
 * opener's `CueStack` directly — the same object the tab's Timeline panel is
 * showing — so a cue added here appears there, and the tab's GO fires what was
 * just written. Persistence is the panel's own `/__lpp/stack` route, called on
 * every edit exactly as the tab does it.
 *
 * ## Keyboard first
 *
 * ↑/↓ move the selection, Space fires the selected cue, ⏎ opens the name for
 * editing, ⌫ deletes. An operator writing a stack has one hand on the keyboard
 * and is not going to reach for a mouse to move between forty cues.
 */

import { h, button } from './dom.js';
import { formatTimecode } from '../core/timecode.js';
import { parseTimecodeString } from '../core/chase.js';
import { ACTION_KINDS } from '../core/cuestack.js';

/** Columns of the list, in the order they are scanned. */
const COLUMNS = [
  { id: 'on', label: '', width: '2rem' },
  { id: 'number', label: 'Cue', width: '4rem' },
  { id: 'timecode', label: 'Timecode', width: '8rem' },
  { id: 'label', label: 'Name', width: 'auto' },
  { id: 'actions', label: 'Does', width: '20rem' },
  { id: 'fade', label: 'Fade', width: '5rem' },
  { id: 'delay', label: 'Pre-wait', width: '6rem' },
  { id: 'follow', label: 'Follow', width: '6rem' }
];

export function buildTimelineEditor(doc, bridge) {
  const { session, stack } = bridge;
  const chase = bridge.chase || null;
  const timecode = bridge.timecode || null;

  const view = { selected: stack.cues[0] ? stack.cues[0].id : null };

  /*
   * Saving is the tab's own route, called the way the tab calls it — one stack
   * per device, and this popout is looking at the same device.
   *
   * Wrapped in a try, and not because the fetch might reject: `stack.toJSON()`
   * is called synchronously, and getting that name wrong once meant every edit
   * threw *after* updating the model and *before* repainting the list. The
   * model was right, the screen was a version behind, and nothing anywhere
   * said so. A save must never be able to stop the panel redrawing.
   */
  const save = () => {
    try {
      fetch('/__lpp/stack', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: stack.toJSON() })
      }).catch(() => { /* an operator mid-cue must not be interrupted by a save */ });
    } catch (err) {
      console.warn('[LivePremier Plus] could not save the cue stack', err);
    }
  };

  const selected = () => stack.cues.find((c) => c.id === view.selected) || null;
  const selectedIndex = () => stack.cues.findIndex((c) => c.id === view.selected);

  /* ---------------------------------------------------------------- frame */

  const listHost = h('div', { class: 'lpp-cuelist-host' });
  const inspectorHost = h('div', { class: 'lpp-inspector' });
  const headerHost = h('div', { class: 'lpp-pane-head' });

  const root = h('div', { class: 'lpp-popout lpp-editor' }, headerHost, listHost, inspectorHost);
  doc.body.append(root);

  /* ----------------------------------------------------------------- head */

  function paintHeader() {
    headerHost.textContent = '';
    const running = timecode && timecode.clock.running;
    const next = chase && chase.enabled ? chase.next() : null;

    /*
     * `.filter(Boolean)` matters here: this is the DOM's own `append`, not the
     * `h()` helper, and `Element.append(null)` puts the *text* "null" on the
     * page rather than skipping it. Every conditional child below can be null.
     */
    headerHost.append(...[
      h('span', { class: 'aw-font-subtitle-1', text: 'Timeline' }),
      h('input', {
        class: 'wru-input', style: { width: '16rem' }, value: stack.name,
        onInput: (ev) => { stack.name = ev.target.value; save(); }
      }),
      h('div', { style: { flex: '1' } }),
      timecode ? h('span', {
        class: ['lpp-clock', running ? 'lpp-clock--live' : ''],
        title: running ? `Timecode from ${timecode.state.kind}` : 'No timecode running',
        text: formatTimecode(timecode.clock.reading)
      }) : null,
      /* What is due next, which is the thing an operator glances at while the
         show runs — and it is only meaningful while something is chasing. */
      next ? h('span', { class: 'wru-tag', text:
        `next ${next.cue.number || '?'} in ${next.inSeconds.toFixed(1)}s` }) : null,
      chase ? button(chase.enabled ? 'Chasing' : 'Chase', {
        active: chase.enabled,
        onClick: () => { chase.enabled ? chase.disarm() : chase.arm(); paint(); },
        title: 'Fire cues that carry a timecode when the clock reaches them'
      }) : null,
      button('Go', {
        variant: 'go', disabled: !stack.standby,
        onClick: () => { stack.go(); paint(); }
      })
    ].filter(Boolean));
  }

  /* ----------------------------------------------------------------- list */

  function paintList() {
    const scroll = listHost.scrollTop;
    listHost.textContent = '';

    const table = h('table', { class: 'wru-cuelist lpp-cuelist' },
      h('colgroup', {}, COLUMNS.map((c) => h('col', { style: { width: c.width } }))),
      h('thead', {}, h('tr', {}, COLUMNS.map((c) => h('th', { text: c.label })))),
      h('tbody', {}, stack.cues.length
        ? stack.cues.map(row)
        : h('tr', {}, h('td', { colspan: String(COLUMNS.length) },
          h('div', { class: 'wru-empty', text: 'No cues yet. Add one below.' })))));

    listHost.append(table);
    listHost.scrollTop = scroll;
  }

  function row(cue, i) {
    const isStandby = i === stack.pointer;
    const cls = ['wru-cue'];
    if (cue.id === view.selected) cls.push('lpp-cue--selected');
    if (isStandby) cls.push('wru-cue--standby');
    else if (i < stack.pointer) cls.push('wru-cue--fired');
    if (!cue.enabled) cls.push('wru-cue--disabled');

    return h('tr', {
      class: cls,
      onClick: () => { view.selected = cue.id; paint(); },
      onDblclick: () => { stack.gotoId(cue.id); paint(); }
    },
    h('td', {}, h('input', {
      type: 'checkbox', checked: cue.enabled ? 'checked' : null,
      title: 'Enable this cue',
      onChange: (ev) => { stack.update(cue.id, { enabled: ev.target.checked }); save(); paint(); }
    })),
    h('td', { class: 'wru-cue-number', text: cue.number || String(i + 1) }),
    /* A cue with a timecode is fired by the clock; one without waits for GO.
       Showing which at a glance is most of what this column is for. */
    h('td', { class: ['wru-cue-number', cue.timecode ? 'lpp-tc' : 'aw-text-tertiary'],
      text: cue.timecode || 'GO' }),
    h('td', { class: 'aw-text-ellipsis', text: cue.label || '—' }),
    h('td', { class: 'wru-cue-actions aw-text-ellipsis', text: describe(cue) }),
    h('td', { text: cue.fade == null ? '—' : cue.fade + 's' }),
    h('td', { text: cue.delay ? cue.delay + 's' : '—' }),
    h('td', { text: cue.follow ? '+' + (cue.followTime || 0) + 's' : '—' }));
  }

  const describe = (cue) => {
    if (!cue.actions || !cue.actions.length) return 'no actions';
    return cue.actions.map(describeAction).join(', ');
  };

  function describeAction(a) {
    switch (a.kind) {
      case ACTION_KINDS.SCREEN_PRESET: return `Recall ${a.slot} → ${a.screen}`;
      case ACTION_KINDS.MASTER_PRESET: return `Master ${a.slot}`;
      case ACTION_KINDS.TAKE: return `Take ${a.screen}`;
      case ACTION_KINDS.CUT: return `Cut ${a.screen}`;
      default: return a.kind;
    }
  }

  /* ------------------------------------------------------------ inspector */

  /*
   * Everything about one cue, in one place.
   *
   * Rebuilt on selection rather than on every device frame: these are text
   * fields an operator is typing into, and a repaint mid-word would take the
   * caret with it. `paint()` therefore leaves the inspector alone unless the
   * selection actually changed.
   */
  let inspectorFor = null;

  function paintInspector(force = false) {
    const cue = selected();
    const key = cue ? cue.id : null;
    if (!force && key === inspectorFor) return;
    inspectorFor = key;
    inspectorHost.textContent = '';

    if (!cue) {
      inspectorHost.append(h('div', { class: 'wru-empty', text: 'Select a cue to edit it.' }));
      return;
    }

    const heading = h('span', { class: 'aw-font-subtitle-1',
      text: `Cue ${cue.number || ''} ${cue.label || ''}`.trim() });

    const field = (label, input, hint) => h('label', { class: 'lpp-field' },
      h('span', { class: 'aw-font-overline aw-text-tertiary', text: label }),
      input,
      hint ? h('span', { class: 'aw-font-caption aw-text-tertiary', text: hint }) : null);

    /*
     * Apply an edit: model, disk, list, header — but never the inspector
     * itself, because the operator's caret is in it. The heading is the one
     * exception, patched in place rather than rebuilt, so renaming a cue does
     * not leave the panel titled with the old name.
     */
    const set = (patch) => {
      stack.update(cue.id, patch);
      Object.assign(cue, patch);
      save();
      paintList();
      paintHeader();
      if ('number' in patch || 'label' in patch) {
        heading.textContent = `Cue ${cue.number || ''} ${cue.label || ''}`.trim();
      }
    };

    const number = h('input', { class: 'wru-input', value: cue.number || '',
      onChange: (ev) => set({ number: ev.target.value }) });
    const label = h('input', { class: 'wru-input', value: cue.label || '',
      onChange: (ev) => set({ label: ev.target.value }) });
    const notes = h('textarea', { class: 'wru-input', rows: '3',
      onChange: (ev) => set({ notes: ev.target.value }) });
    notes.value = cue.notes || '';

    /*
     * The timecode field validates as you leave it and says so. A half-typed
     * timecode saved as a trigger is a cue that fires at some other moment
     * entirely, so an unreadable one is refused and the field says why rather
     * than silently keeping the old value.
     */
    const tcWarning = h('span', { class: 'aw-font-caption wru-warn' });
    const tc = h('input', {
      class: 'wru-input', value: cue.timecode || '', placeholder: '––:––:––:––',
      spellcheck: 'false',
      onChange: (ev) => {
        const typed = ev.target.value.trim();
        if (!typed) { tcWarning.textContent = ''; return set({ timecode: null }); }
        if (!parseTimecodeString(typed)) {
          tcWarning.textContent = 'Not a timecode — hh:mm:ss:ff, or ; before the frames for drop-frame';
          ev.target.value = cue.timecode || '';
          return;
        }
        tcWarning.textContent = '';
        set({ timecode: typed });
      }
    });

    const fade = h('input', { class: 'wru-input', type: 'number', step: '0.1', min: '0',
      value: cue.fade ?? '', placeholder: 'leave alone',
      onChange: (ev) => set({ fade: ev.target.value === '' ? null : Number(ev.target.value) }) });
    const delay = h('input', { class: 'wru-input', type: 'number', step: '0.1', min: '0',
      value: cue.delay ?? 0, onChange: (ev) => set({ delay: Number(ev.target.value) || 0 }) });
    const follow = h('input', { type: 'checkbox', checked: cue.follow ? 'checked' : null,
      onChange: (ev) => set({ follow: ev.target.checked }) });
    const followTime = h('input', { class: 'wru-input', type: 'number', step: '0.1', min: '0',
      value: cue.followTime ?? 0, onChange: (ev) => set({ followTime: Number(ev.target.value) || 0 }) });

    inspectorHost.append(
      h('div', { class: 'lpp-inspector-head aw-flex-row-center-v aw-gap-col-medium' },
        heading,
        h('div', { style: { flex: '1' } }),
        button('Fire now', { onClick: () => { stack.fire(cue); paint(); }, variant: 'go' }),
        button('Delete', { onClick: () => {
          const at = selectedIndex();
          stack.remove(cue.id);
          view.selected = (stack.cues[at] || stack.cues[at - 1] || {}).id || null;
          save(); paint(true);
        }, variant: 'danger' })),
      h('div', { class: 'lpp-inspector-grid' },
        field('Number', number),
        field('Timecode', tc, 'Empty means this cue waits for GO'),
        field('Name', label),
        field('Fade', fade, 'Seconds; empty leaves the screen as it is'),
        field('Pre-wait', delay, 'Seconds after GO before it fires'),
        field('Follow', h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' }, follow, followTime),
          'Fire the next cue automatically, this many seconds later'),
        field('Notes', notes)),
      tcWarning,
      actionsBlock(cue, set));
  }

  /*
   * Actions are listed and removable but not yet composable here.
   *
   * Building a cue action needs a screen picker, a preset picker and a live
   * list of what this device actually has — the tab's own panel already does
   * that against the store, and doing it twice, differently, is how the two
   * come to disagree. Adding actions stays where it already works until this
   * window can share that code rather than copy it.
   */
  function actionsBlock(cue, set) {
    return h('div', { class: 'aw-flex-col aw-gap-row-mini lpp-actions' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Actions' }),
      (cue.actions && cue.actions.length)
        ? h('div', { class: 'aw-flex-col aw-gap-row-mini' },
          cue.actions.map((a, i) => h('div', { class: 'lpp-action aw-flex-row-center-v aw-gap-col-small' },
            h('span', { class: 'aw-font-body-1', text: describeAction(a) }),
            h('div', { style: { flex: '1' } }),
            button('×', {
              variant: 'ghost', title: 'Remove this action',
              onClick: () => set({ actions: cue.actions.filter((_, j) => j !== i) })
            }))))
        : h('div', { class: 'aw-font-caption aw-text-tertiary',
          text: 'Nothing yet. Actions are added from the Timeline tab in Web RCS, which can see the device’s screens and memories.' }));
  }

  /* ------------------------------------------------------------- keyboard */

  function move(delta) {
    if (!stack.cues.length) return;
    const at = selectedIndex();
    const next = Math.max(0, Math.min(stack.cues.length - 1, (at < 0 ? 0 : at) + delta));
    view.selected = stack.cues[next].id;
    paint(true);
    const row = listHost.querySelector('.lpp-cue--selected');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  const onKey = (ev) => {
    /* Never steal a keystroke from a field the operator is typing in. */
    const tag = ev.target && ev.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); move(+1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
    else if (ev.key === ' ') {
      ev.preventDefault();
      const cue = selected();
      if (cue) { stack.fire(cue); paint(); }
    }
  };
  doc.addEventListener('keydown', onKey);

  /* --------------------------------------------------------------- paint */

  function paint(withInspector = false) {
    paintHeader();
    paintList();
    paintInspector(withInspector);
  }

  const addCue = () => {
    const cue = stack.add({ number: String(stack.cues.length + 1), label: '' });
    view.selected = cue.id;
    save();
    paint(true);
  };

  root.append(h('div', { class: 'lpp-editor-foot aw-flex-row-center-v aw-gap-col-small' },
    button('Add cue', { onClick: addCue, iconId: 'add-12' }),
    h('span', { class: 'aw-font-caption aw-text-tertiary',
      text: '↑ ↓ select · Space fires the selected cue · double-click sets standby' })));

  paint(true);

  /*
   * Repaint on device traffic, but never the inspector — the operator may be
   * typing in it. The header and list carry the live state; the inspector is
   * an editing surface and belongs to whoever has the caret.
   */
  let queued = false;
  const onFrame = () => {
    if (queued) return;
    queued = true;
    (doc.defaultView || window).requestAnimationFrame(() => {
      queued = false;
      paintHeader();
      paintList();
    });
  };
  session.addEventListener('frame', onFrame);
  stack.addEventListener('changed', onFrame);
  if (chase) chase.addEventListener('fired', onFrame);

  return {
    paint,
    stop() {
      doc.removeEventListener('keydown', onKey);
      session.removeEventListener('frame', onFrame);
      stack.removeEventListener('changed', onFrame);
    }
  };
}
