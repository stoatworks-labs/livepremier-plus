/*
 * The timeline: a theatre cue stack driven onto a broadcast switcher.
 *
 * LivePremier gives you memories and a TAKE button. A lighting or sound desk
 * gives you a numbered list that advances on one GO, where each cue owns its
 * fade time and can follow the one before it. This panel is the second thing,
 * built out of the first.
 *
 * Design notes that are not obvious from the code:
 *
 *  - A cue is *sent*, never *confirmed*. Recall and TAKE return nothing on
 *    this protocol, so the log says how many writes left the browser and the
 *    device status column is shown separately. Conflating those two would be
 *    a lie in exactly the situation where you need the truth.
 *  - GO fires the standby cue, then advances. A cue with a delay arms instead
 *    of firing, and a second GO during that window fires it immediately -
 *    which is what an operator hitting GO twice means.
 *  - BACK moves the pointer only. The device's own STEP BACK is a separate,
 *    clearly-labelled control, because it restores the switcher's previous
 *    state rather than replaying our cue, and those two differ as soon as a
 *    cue does anything beyond recall-and-take.
 */

import { h, button, readout, sectionTitle, fmtClock } from './dom.js';
import { panel } from './shell.js';
import { parseTimecodeString } from '../core/chase.js';
import { formatTimecode } from '../core/timecode.js';
import { ACTION_KINDS } from '../core/cuestack.js';
import { ROOT } from '../core/paths.js';

export function createTimelinePanel({ session, stack, storage, timecode = null, chase = null, onRefresh }) {
  const view = { editing: null, adding: false, armedUntil: null, lastFired: null };

  stack.addEventListener('fired', (ev) => { view.lastFired = ev.detail; onRefresh(); });
  stack.addEventListener('armed', (ev) => {
    view.armedUntil = Date.now() + ev.detail.inSeconds * 1000;
    onRefresh();
  });
  stack.addEventListener('stopped', () => { view.armedUntil = null; onRefresh(); });
  stack.addEventListener('end', () => { view.armedUntil = null; onRefresh(); });

  /** Screens and auxiliaries the device says are actually in use. */
  function targets() {
    const store = session.store;
    const base = [ROOT, 'screenAuxGroupList'];
    const keys = store.itemKeys(base);
    return keys.filter((k) => store.get([...base, 'items', k, 'status', 'pp', 'isUsed']) === true);
  }

  function screenStatus(id) {
    const store = session.store;
    return {
      transition: store.get([ROOT, 'screenAuxGroupList', 'items', id, 'status', 'pp', 'transition']),
      take: store.get([ROOT, 'screenAuxGroupList', 'items', id, 'status', 'pp', 'take'])
    };
  }

  function render() {
    return panel({ toolbar: toolbar(), body: body() });
  }

  function toolbar() {
    const standby = stack.standby;
    const armed = view.armedUntil && view.armedUntil > Date.now();
    return [
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-large' },
        h('div', { class: 'aw-font-subtitle-1', text: 'Timeline' }),
        h('input', {
          class: 'wru-input', style: { width: '14rem' }, value: stack.name,
          onInput: (ev) => { stack.name = ev.target.value; save(); }
        }),
        standby
          ? h('span', { class: 'wru-tag', text: `standby ${standby.number || '#' + (stack.pointer + 1)} ${standby.label}`.trim() })
          : h('span', { class: 'wru-tag', text: 'end of stack' }),
        armed ? h('span', { class: 'wru-tag wru-warn', text: 'armed' }) : null,
        timecodeTag()),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        chase ? button(chase.enabled ? 'Chasing' : 'Chase', {
          onClick: () => { chase.enabled ? chase.disarm() : chase.arm(); onRefresh(); },
          active: chase.enabled,
          title: 'Fire cues that carry a timecode when the clock reaches them'
        }) : null,
        button('Back', { onClick: () => { stack.back(); onRefresh(); }, iconId: 'arrows-left-10' }),
        button('Stop', { onClick: () => { stack.stop(); onRefresh(); }, variant: 'danger', disabled: !stack.running }),
        button(armed ? 'Go now' : 'Go', { onClick: () => { stack.go(); onRefresh(); }, variant: 'go', disabled: !standby }))
    ];
  }

  function body() {
    if (!session.store.ready) return h('div', { class: 'wru-empty', text: 'Waiting for the device store…' });
    return h('div', {},
      statusStrip(),
      cueTable(),
      view.adding ? addForm() : h('div', { class: 'aw-margin-top-medium' },
        button('Add cue', { onClick: () => { view.adding = true; onRefresh(); }, iconId: 'add-18' }),
        ' ',
        button('Export', { onClick: exportStack, variant: 'ghost' }),
        ' ',
        button('Import', { onClick: importStack, variant: 'ghost' })),
      log());
  }

  function statusStrip() {
    const used = targets();
    return h('div', { class: 'aw-flex-row aw-gap-col-massive aw-margin-bottom-large aw-flex-wrap' },
      readout('Cues', stack.cues.length),
      readout('Standby', stack.standby ? (stack.standby.number || '#' + (stack.pointer + 1)) : '—'),
      readout('Screens in use', used.length ? used.join(', ') : 'none'),
      ...used.slice(0, 6).map((id) => {
        const st = screenStatus(id);
        return readout(id, st.take === 'OFF' ? (st.transition || 'idle') : st.take,
          { tone: st.take !== 'OFF' ? 'green' : undefined });
      }));
  }

  function cueTable() {
    if (!stack.cues.length) {
      return h('div', { class: 'wru-empty' },
        h('div', { class: 'aw-font-subtitle-1 aw-margin-bottom-medium', text: 'No cues yet' }),
        h('div', { text: 'A cue is one or more preset recalls plus an optional take, with its own fade and follow times.' }));
    }
    const rows = stack.cues.map((cue, i) => cueRow(cue, i));
    return h('table', { class: 'wru-cuelist' },
      h('thead', {}, h('tr', {},
        ...['', 'Cue', 'Timecode', 'Label', 'Actions', 'Fade', 'Delay', 'Follow', ''].map((t) => h('th', { text: t })))),
      h('tbody', {}, ...rows));
  }

  /**
   * The clock, and whether it is running.
   *
   * A stale feed shows the last reading dimmed rather than disappearing: an
   * operator wants to see *where it stopped*, and a blank readout says only
   * that something is wrong without saying what.
   */
  function timecodeTag() {
    if (!timecode) return null;
    const clock = timecode.clock;
    const running = clock.running;
    const text = formatTimecode(clock.reading);
    if (!clock.reading) {
      return timecode.state.kind === 'none'
        ? null
        : h('span', { class: 'wru-tag', text: 'waiting for timecode' });
    }
    return h('span', {
      class: ['wru-tag', running ? 'wru-tag--good' : 'wru-warn'],
      title: running ? `Timecode from ${timecode.state.kind}` : 'The timecode feed has stopped',
      text: running ? text : text + ' stopped'
    });
  }

  function cueRow(cue, i) {
    const isStandby = i === stack.pointer;
    const armed = isStandby && view.armedUntil && view.armedUntil > Date.now();
    const cls = ['wru-cue'];
    if (armed) cls.push('wru-cue--armed');
    else if (isStandby) cls.push('wru-cue--standby');
    else if (i < stack.pointer) cls.push('wru-cue--fired');
    if (!cue.enabled) cls.push('wru-cue--disabled');

    if (view.editing === cue.id) return editRow(cue, cls);

    return h('tr', { class: cls, onDblclick: () => { view.editing = cue.id; onRefresh(); } },
      h('td', {}, h('input', {
        type: 'checkbox', checked: cue.enabled ? 'checked' : null, title: 'Enable this cue',
        onChange: (ev) => { stack.update(cue.id, { enabled: ev.target.checked }); save(); onRefresh(); }
      })),
      h('td', { class: 'wru-cue-number', text: cue.number || String(i + 1) }),
      /* A cue with a timecode is fired by the clock rather than by GO, so it
         is worth being able to see which at a glance down the column. */
      h('td', { class: 'wru-cue-number', text: cue.timecode || '—' }),
      h('td', { text: cue.label || '—' }),
      h('td', { class: 'wru-cue-actions', text: describe(cue) }),
      h('td', { text: cue.fade == null ? '—' : cue.fade + 's' }),
      h('td', { text: cue.delay ? cue.delay + 's' : '—' }),
      h('td', { text: cue.follow ? '+' + (cue.followTime || 0) + 's' : '—' }),
      h('td', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
        button('Go', { onClick: () => { stack.gotoId(cue.id); stack.go(); onRefresh(); }, variant: 'ghost', title: 'Fire this cue now' }),
        button('Edit', { onClick: () => { view.editing = cue.id; onRefresh(); }, variant: 'ghost' }),
        button('×', { onClick: () => { stack.remove(cue.id); save(); onRefresh(); }, variant: 'ghost', title: 'Delete cue' })));
  }

  function editRow(cue, cls) {
    const num = h('input', { class: 'wru-input wru-input--narrow', value: cue.number });
    /* Free text rather than four spinners: an operator reads a timecode off a
       screen and types it, and `parseTimecodeString` refuses anything that is
       not one rather than half-accepting it. */
    const tc = h('input', {
      class: 'wru-input wru-input--narrow', value: cue.timecode || '',
      placeholder: '––:––:––:––', spellcheck: 'false',
      title: 'Fire this cue when timecode reaches here. Leave empty for a GO cue.'
    });
    const label = h('input', { class: 'wru-input', value: cue.label });
    const fade = h('input', { class: 'wru-input wru-input--narrow', type: 'number', step: '0.1', min: '0', value: cue.fade ?? '' });
    const delay = h('input', { class: 'wru-input wru-input--narrow', type: 'number', step: '0.1', min: '0', value: cue.delay ?? 0 });
    const follow = h('input', { type: 'checkbox', checked: cue.follow ? 'checked' : null });
    const followTime = h('input', { class: 'wru-input wru-input--narrow', type: 'number', step: '0.1', min: '0', value: cue.followTime ?? 0 });

    const commit = () => {
      const typed = tc.value.trim();
      stack.update(cue.id, {
        number: num.value,
        /* Kept as the operator typed it, and only if it is readable — a
           half-typed timecode saved as a cue trigger is a cue that fires at
           some other moment entirely. */
        timecode: typed && parseTimecodeString(typed) ? typed : null,
        label: label.value,
        fade: fade.value === '' ? null : Number(fade.value),
        delay: Number(delay.value) || 0,
        follow: follow.checked,
        followTime: Number(followTime.value) || 0
      });
      view.editing = null;
      save();
      onRefresh();
    };

    return h('tr', { class: cls },
      h('td', {}),
      h('td', {}, num),
      h('td', {}, tc),
      h('td', {}, label),
      h('td', { class: 'wru-cue-actions', text: describe(cue) }),
      h('td', {}, fade),
      h('td', {}, delay),
      h('td', { class: 'aw-flex-row-center-v aw-gap-col-mini' }, follow, followTime),
      h('td', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
        button('Save', { onClick: commit }),
        button('Cancel', { onClick: () => { view.editing = null; onRefresh(); }, variant: 'ghost' })));
  }

  function describe(cue) {
    if (!cue.actions.length) return 'no actions';
    return cue.actions.map((a) => {
      switch (a.kind) {
        case ACTION_KINDS.SCREEN_PRESET:
          return `preset ${a.slot} → ${(a.targets || []).join(' ')} ${a.mode === 'PROGRAM' ? '(PGM)' : '(PRW)'}`;
        case ACTION_KINDS.MASTER_PRESET:
          return `master preset ${a.slot} ${a.mode === 'PROGRAM' ? '(PGM)' : '(PRW)'}`;
        case ACTION_KINDS.TAKE: return `take ${(a.targets || []).join(' ')}`;
        case ACTION_KINDS.CUT: return `cut ${(a.targets || []).join(' ')}`;
        default: return a.kind;
      }
    }).join(' · ');
  }

  function addForm() {
    const used = targets();
    const kind = h('select', { class: 'wru-input' },
      h('option', { value: ACTION_KINDS.SCREEN_PRESET, text: 'Screen preset' }),
      h('option', { value: ACTION_KINDS.MASTER_PRESET, text: 'Master preset' }));
    const slot = h('input', { class: 'wru-input wru-input--narrow', type: 'number', min: '1', value: '1' });
    const mode = h('select', { class: 'wru-input' },
      h('option', { value: 'PREVIEW', text: 'to Preview' }),
      h('option', { value: 'PROGRAM', text: 'to Program' }));
    const takeKind = h('select', { class: 'wru-input' },
      h('option', { value: '', text: 'no take' }),
      h('option', { value: ACTION_KINDS.TAKE, text: 'take (fade)' }),
      h('option', { value: ACTION_KINDS.CUT, text: 'cut' }));
    const label = h('input', { class: 'wru-input', placeholder: 'Cue label' });
    const fade = h('input', { class: 'wru-input wru-input--narrow', type: 'number', step: '0.1', min: '0', placeholder: 's' });

    const boxes = used.map((id) => {
      const cb = h('input', { type: 'checkbox', value: id, checked: 'checked' });
      return { id, cb, node: h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini' }, cb, h('span', { text: id })) };
    });

    const commit = () => {
      const chosen = boxes.filter((b) => b.cb.checked).map((b) => b.id);
      const actions = [];
      if (kind.value === ACTION_KINDS.SCREEN_PRESET) {
        actions.push({ kind: ACTION_KINDS.SCREEN_PRESET, slot: Number(slot.value), targets: chosen, mode: mode.value });
      } else {
        actions.push({ kind: ACTION_KINDS.MASTER_PRESET, slot: Number(slot.value), mode: mode.value });
      }
      if (takeKind.value) actions.push({ kind: takeKind.value, targets: chosen });
      stack.add({
        number: String(stack.cues.length + 1),
        label: label.value,
        fade: fade.value === '' ? null : Number(fade.value),
        actions
      });
      view.adding = false;
      save();
      onRefresh();
    };

    return h('div', { class: 'aw-margin-top-large aw-padding-large aw-background-slate-grey-900 aw-border-radius' },
      sectionTitle('New cue'),
      h('div', { class: 'aw-flex-row aw-flex-wrap aw-gap-col-large aw-gap-row-medium aw-margin-bottom-medium' },
        field('Recall', kind), field('Slot', slot), field('Into', mode),
        field('Then', takeKind), field('Fade', fade), field('Label', label)),
      h('div', { class: 'aw-margin-bottom-medium' },
        h('div', { class: 'aw-font-overline aw-text-tertiary aw-margin-bottom-mini', text: 'Targets' }),
        boxes.length
          ? h('div', { class: 'aw-flex-row aw-flex-wrap aw-gap-col-large' }, ...boxes.map((b) => b.node))
          : h('div', { class: 'aw-text-tertiary', text: 'The device reports no screens or auxiliaries in use.' })),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        button('Add', { onClick: commit }),
        button('Cancel', { onClick: () => { view.adding = false; onRefresh(); }, variant: 'ghost' })));
  }

  const field = (label, control) =>
    h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: label }), control);

  function log() {
    const entries = stack.log.slice(-8).reverse();
    if (!entries.length) return null;
    return h('div', { class: 'aw-margin-top-massive' },
      sectionTitle('Sent'),
      h('div', { class: 'aw-flex-col aw-gap-row-mini aw-font-body-2' },
        ...entries.map((e) => h('div', { class: 'aw-flex-row aw-gap-col-large' },
          h('span', { class: 'aw-text-tertiary', text: new Date(e.at).toLocaleTimeString() }),
          h('span', { class: 'aw-font-body-1-bold', text: (e.number || '') + ' ' + (e.label || '') }),
          h('span', { class: 'aw-text-secondary', text: `${e.sent} write${e.sent === 1 ? '' : 's'} sent` }))),
        h('div', { class: 'aw-text-tertiary aw-margin-top-small', text: 'Sent, not confirmed: recalls and takes are silent on this protocol.' })));
  }

  function save() { if (storage) storage.save(stack.toJSON()); }

  function exportStack() {
    const blob = new Blob([JSON.stringify(stack.toJSON(), null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: (stack.name || 'cuestack') + '.json' });
    document.body.append(a); a.click(); a.remove();
  }

  function importStack() {
    const input = h('input', { type: 'file', accept: 'application/json' });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        stack.load(JSON.parse(await file.text()));
        save();
        onRefresh();
      } catch (err) { console.error('[wru] import failed', err); }
    });
    input.click();
  }

  return { render, view, fmtClock };
}
