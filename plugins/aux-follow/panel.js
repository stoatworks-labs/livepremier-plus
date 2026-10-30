/*
 * Aux follow — the tab on the Screens / Aux. strip.
 *
 * One section per aux in service, one row per layer it has: which screen
 * layer it follows, in which mode, and whether the two agree right now. A
 * choice is staged in the row and made with its button, never by the picker
 * alone — setting a follow writes the aux at once, and in program that is a
 * cut on air, so the button says so and asks a second time.
 *
 * Redraws in place, as the Surfaces tab does: `render()` hands back the same
 * element while nothing it shows has changed, and `busy()` holds repaints off
 * while the pointer is down in it.
 */

import { h, fill, note, button } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import { followOf, followKey } from './core.js';

const MODE_LABEL = { program: 'Program', both: 'Program and preview' };
const ROLE_SHORT = { PROGRAM: 'PGM', PREVIEW: 'PRW' };

/**
 * @param {object} o
 * @param {() => object} o.doc                       the document, normalised
 * @param {(aux: string, layer: string, from: object|null, mode: string) => void} o.set
 * @param {() => {id: string, label: string}[]} o.auxes
 * @param {(id: string) => {key: string, label: string}[]} o.layers
 * @param {() => {id: string, layer: string, label: string}[]} o.leaders
 * @param {(f: object) => object} o.describe          core `describe`
 * @param {(value: string) => string} o.sourceName
 * @param {() => object[]} o.recent
 * @param {() => object[]} o.owed
 * @param {() => boolean} o.ready
 * @param {() => boolean} o.platform
 */
export function createAuxFollowPanel(o) {
  let root = null;
  let shown = null;
  let pressed = false;
  /* `A1/1` -> { from: 'S1/2' | '', mode } as picked and not yet made. */
  const staged = new Map();
  /* The row whose button is waiting for its second click. */
  let armed = null;

  const keyOf = (from) => (from ? `${from.id}/${from.layer}` : '');
  const fromKey = (k) => {
    if (!k) return null;
    const [id, layer] = k.split('/');
    return { id, layer };
  };
  const name = (v) => (v == null ? '—' : o.sourceName(v));

  function stage(aux, layer, patch) {
    const k = `${aux}/${layer}`;
    const now = followOf(o.doc(), aux, layer);
    const was = staged.get(k) || { from: keyOf(now && now.from), mode: (now && now.mode) || 'program' };
    staged.set(k, { ...was, ...patch });
    if (armed === k) armed = null;
    repaint();
  }

  function row(aux, layer, leaders) {
    const k = `${aux.id}/${layer.key}`;
    const now = followOf(o.doc(), aux.id, layer.key);
    const pick = staged.get(k) || { from: keyOf(now && now.from), mode: (now && now.mode) || 'program' };
    const changed = pick.from !== keyOf(now && now.from) || (pick.from && pick.mode !== (now && now.mode));
    const wanted = pick.from ? { aux: aux.id, layer: layer.key, from: fromKey(pick.from), mode: pick.mode } : null;

    /* What making it would write now: a program that differs is a cut on air. */
    const cutOf = (w) => {
      const preview = w ? o.describe(w) : null;
      return preview && preview.roles.find((r) => r.role === 'PROGRAM' && !r.same && r.leader != null);
    };
    const cut = cutOf(wanted);
    const isArmed = armed === k;

    const choices = [{ value: '', label: 'Not following' }, ...leaders.map((l) => ({ value: `${l.id}/${l.layer}`, label: l.label }))];
    if (pick.from && !choices.some((c) => c.value === pick.from)) choices.push({ value: pick.from, label: `${pick.from.replace('/', ' L')} (not in service)` });

    let action = null;
    if (changed) {
      if (!wanted) {
        action = button('Stop following', {
          title: `${aux.id} ${layer.label} keeps what it has and follows nothing`,
          onClick: () => { staged.delete(k); o.set(aux.id, layer.key, null); }
        });
      } else if (cut && !isArmed) {
        action = button('Follow', {
          title: `Start following — ${aux.id}’s program cuts to ${name(cut.leader)}`,
          onClick: () => { armed = k; repaint(); }
        });
      } else {
        action = button(cut ? `Confirm — cuts to ${name(cut.leader)}` : 'Follow', {
          variant: cut ? 'danger' : 'default',
          title: cut ? `${aux.id}’s program changes on air now` : `Start following ${pick.from.replace('/', ' L')}`,
          onClick: () => {
            /* Decided again at the click: a program that changed since this
               was drawn is still a cut on air, and still takes two clicks. A
               stale one-click Follow cut an aux's program unasked on an
               Aquilon C mini (2026-10-30). */
            if (!cut && cutOf(wanted)) { armed = k; repaint(); return; }
            armed = null; staged.delete(k); o.set(aux.id, layer.key, wanted.from, wanted.mode);
          }
        });
      }
    }

    let state = null;
    if (now && !changed) {
      const d = o.describe(now);
      if (d.why) state = note('warn', `${d.why}; nothing follows until it does.`);
      else {
        const parts = d.roles.map((r) => (r.same
          ? `${ROLE_SHORT[r.role]} ${name(r.aux)}`
          : `${ROLE_SHORT[r.role]} ${name(r.aux)} (${now.from.id} has ${name(r.leader)})`));
        const owing = o.owed().find((x) => x.key === followKey(now));
        state = note(d.roles.every((r) => r.same) ? '' : 'warn',
          `${parts.join(' · ')}${owing ? ' — waiting for a take to land' : d.roles.every((r) => r.same) ? '' : ' — the next change on it brings this in line'}`);
      }
    }

    return h('div', { class: 'aw-flex-col aw-gap-row-mini', dataset: { lppAuxFollow: k } },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        h('div', { class: 'aw-font-body-2', style: { flex: '0 0 6rem' }, text: layer.label }),
        h('select', {
          class: 'wru-input', style: { flex: '1 1 9rem', minWidth: '0' },
          'aria-label': `${aux.id} ${layer.label} follows`,
          onChange: (ev) => stage(aux.id, layer.key, { from: ev.target.value })
        }, choices.map((c) => h('option', { value: c.value, selected: c.value === pick.from ? 'selected' : null, text: c.label }))),
        h('select', {
          class: 'wru-input', style: { flex: '0 1 11rem', minWidth: '0' },
          'aria-label': `${aux.id} ${layer.label} mode`,
          disabled: pick.from ? null : 'disabled',
          onChange: (ev) => stage(aux.id, layer.key, { mode: ev.target.value })
        }, Object.entries(MODE_LABEL).map(([value, label]) => h('option', { value, selected: value === pick.mode ? 'selected' : null, text: label }))),
        action),
      state);
  }

  function section(aux, leaders) {
    const layers = o.layers(aux.id);
    return h('div', { class: 'aw-flex-col aw-gap-row-small', dataset: { lppAuxFollowDest: aux.id } },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        h('div', { class: 'aw-font-body-1-bold', text: aux.id }),
        aux.label ? h('div', { class: 'aw-font-caption aw-text-tertiary', text: aux.label }) : null),
      layers.length ? layers.map((l) => row(aux, l, leaders)) : note('', `${aux.id} has no layer.`));
  }

  function activity() {
    const lines = o.recent().slice(0, 3).map((r) => {
      const who = `${r.follow.aux} L${r.follow.layer}`;
      const role = ROLE_SHORT[r.role] || '';
      if (r.kind === 'sent') return `${who} ${role} → ${name(r.value)}${r.cause === 'take' ? ' (take landed)' : ''}`;
      if (r.kind === 'owed') return `${who} ${role}: ${r.why}`;
      return `${who} ${role}: not written — ${r.why}`;
    });
    return lines.length ? h('div', { class: 'aw-font-caption aw-text-tertiary', text: `Last: ${lines.join('; ')}.` }) : null;
  }

  function body() {
    if (!o.ready()) return h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'Waiting for the switcher…' });
    if (!o.platform()) return note('warn', 'Aux follow works on a LivePremier. Nothing follows on this switcher.');
    const auxes = o.auxes();
    const leaders = o.leaders();
    return h('div', { class: 'aw-flex-col aw-gap-row-big' },
      auxes.length ? auxes.map((a) => section(a, leaders)) : note('', 'No aux screen is in service — Preconfig ▸ Aux. Screens.'),
      activity(),
      note('', 'Program: the aux’s program cuts to the layer’s program source when a take on the screen lands, or when its program is changed directly. Program and preview: role for role — take the aux with the screen and it transitions with it; left out of the take, it is put back in line when the take lands.'),
      note('', 'The switcher has no link like this. It is kept by this page, and by any other LivePremier Plus page open on this switcher: with none open, nothing follows. Changes from anywhere are followed while one is — the front panel, Companion, another browser.'));
  }

  function signature() {
    const ready = o.ready() && o.platform();
    const auxes = ready ? o.auxes() : [];
    return JSON.stringify([
      o.ready(), o.platform(), o.doc(), [...staged], armed,
      auxes.map((a) => [a.id, a.label, o.layers(a.id)]),
      ready ? o.leaders() : [],
      ready ? o.doc().follows.map((f) => o.describe(f)) : [],
      /* A staged pick too: its button is one click or two by what it would
         cut, and that moves with the programs, not with anything above. */
      ready ? [...staged].map(([k, s]) => {
        const [aux, layer] = k.split('/');
        return s.from ? o.describe({ aux, layer, from: fromKey(s.from), mode: s.mode }) : null;
      }) : [],
      o.recent().map((r) => [r.at, r.kind]),
      o.owed()
    ]);
  }

  function busy() {
    return pressed;
  }

  function watch(el) {
    el.addEventListener('pointerdown', () => { pressed = true; });
    el.addEventListener('change', () => { pressed = false; });
    if (typeof document !== 'undefined') {
      const release = () => { pressed = false; };
      document.addEventListener('pointerup', release, true);
      document.addEventListener('pointercancel', release, true);
    }
  }

  function draw() {
    const fresh = panel({
      toolbar: h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium' }, h('div', { class: 'aw-font-subtitle-1', text: 'Aux follow' })),
      body: body()
    });
    if (root) fill(root, ...fresh.childNodes);
    else { root = fresh; watch(root); }
  }

  function repaint() {
    if (!root) return;
    shown = signature();
    draw();
  }

  function render() {
    const sig = signature();
    if (root && sig === shown) return root;
    if (root && busy()) return root;
    draw();
    shown = sig;
    return root;
  }

  return { render, busy };
}
