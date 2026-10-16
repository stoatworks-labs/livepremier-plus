/*
 * Surfaces — the tab on the Screens / Aux. strip.
 *
 * One section per destination in service: its surfaces (a name and a
 * rectangle in canvas pixels each, typed or made from the outputs feeding
 * it), and which layer is bound to which. Under them, what the engine is
 * doing: a bound layer standing outside its surface, a layer the follower has
 * let go, the last few writes it kept in.
 *
 * ## It redraws in place
 *
 * The app repaints every panel on every frame from the switcher. A rebuilt
 * field loses what is being typed into it and a rebuilt `<select>` closes
 * under the pointer, so `render()` hands back the same element while nothing
 * it shows has changed, and `busy()` holds repaints off while the pointer is
 * down in the panel or the caret is in one of its fields. Not while a
 * `<select>` has focus — it keeps focus after a pick, and Pixel Map learned
 * that holds every repaint off until a click elsewhere. Fields commit on
 * change (Enter or leaving the field), never per keystroke.
 */

import { h, fill, note, button } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import { surfacesOf, boundSurface, addSurface, updateSurface, removeSurface, bind } from './core.js';

const ROLE = { PGM: 'program', PRW: 'preview' };

/**
 * @param {object} o
 * @param {() => object} o.doc                 the document, normalised
 * @param {(next: object) => void} o.change    store a new document
 * @param {() => object[]} o.destinations      in service, `{id, label, canvas}`
 * @param {(id: string) => {key: string, label: string}[]} o.layers  bindable layers
 * @param {(id: string) => object[]} o.outputs surfaces made from the outputs feeding `id`
 * @param {() => object[]} o.outside           bound layers outside, `{id, layer, role, surface}`
 * @param {() => string[]} o.letGo             `S1/2` keys the follower gave up on
 * @param {(id: string, layer: string) => boolean} o.locked
 * @param {() => object[]} o.recent            the engine's last few notes
 * @param {() => object} o.describe            what the outlines last drew
 * @param {() => boolean} o.ready
 * @param {() => boolean} o.platform           a LivePremier: the only platform it acts on
 * @param {() => boolean} o.hooked             the page's hook has a shaper slot
 */
export function createSurfacesPanel(o) {
  let root = null;
  let shown = null;
  let pressed = false;

  const d = () => o.doc();
  const set = (next) => o.change(next);

  const field = (label, value, onCommit, attrs = {}) =>
    h('label', { class: 'aw-flex-col aw-gap-row-mini', style: { flex: attrs.flex || '1 1 3.5rem', minWidth: '0' } },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: label }),
      h('input', {
        class: 'wru-input', type: attrs.type || 'number', value: String(value),
        step: attrs.type === 'text' ? null : '1',
        'aria-label': attrs.aria || label,
        style: { width: '100%' },
        onChange: (ev) => onCommit(ev.target.value),
        onKeyDown: (ev) => { if (ev.key === 'Enter') ev.target.blur(); }
      }));

  function surfaceRow(id, s) {
    const patch = (k) => (v) => {
      const value = k === 'name' ? v : Number(v);
      if (k !== 'name' && !Number.isFinite(value)) return;
      set(updateSurface(d(), id, s.id, { [k]: value }));
    };
    return h('div', { class: 'aw-flex-col aw-gap-row-mini', dataset: { lppSurfaceRow: `${id}/${s.id}` } },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        field('Name', s.name, patch('name'), { type: 'text', flex: '1 1 auto', aria: `${id} surface ${s.id} name` }),
        h('div', { style: { alignSelf: 'flex-end' } },
          button('Remove', { onClick: () => set(removeSurface(d(), id, s.id)), title: `Remove ${s.name} and unbind its layers` }))),
      h('div', { class: 'aw-flex-row aw-gap-col-small' },
        field('X', s.x, patch('x'), { aria: `${id} ${s.name} x` }),
        field('Y', s.y, patch('y'), { aria: `${id} ${s.name} y` }),
        field('W', s.width, patch('width'), { aria: `${id} ${s.name} width` }),
        field('H', s.height, patch('height'), { aria: `${id} ${s.name} height` })));
  }

  function bindingRow(id, layer, list) {
    const current = boundSurface(d(), id, layer.key);
    const locked = o.locked(id, layer.key);
    const choices = [{ id: '', label: 'Not bound' }, ...list.map((s) => ({ id: s.id, label: s.name }))];
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-small', dataset: { lppBinding: `${id}/${layer.key}` } },
      h('div', { class: 'aw-font-body-2', style: { flex: '0 0 6rem' }, text: layer.label }),
      h('select', {
        class: 'wru-input', style: { flex: '1 1 auto', minWidth: '0' },
        'aria-label': `${id} ${layer.label} surface`,
        onChange: (ev) => set(bind(d(), id, layer.key, ev.target.value || null))
      }, choices.map((c) => h('option', {
        value: c.id, selected: (current ? current.id : '') === c.id ? 'selected' : null, text: c.label
      }))),
      locked && current
        ? h('span', { class: 'aw-font-caption aw-text-tertiary', title: 'Layer Lock keeps this layer equal to program, so Surfaces leaves it alone.', text: 'locked' })
        : null);
  }

  function section(dest) {
    const list = surfacesOf(d(), dest.id);
    const size = dest.canvas && dest.canvas.width ? `${dest.canvas.width}×${dest.canvas.height}` : '';
    const fromOutputs = o.outputs(dest.id);
    const layers = o.layers(dest.id);
    return h('div', { class: 'aw-flex-col aw-gap-row-small', dataset: { lppSurfaceDest: dest.id } },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        h('div', { class: 'aw-font-body-1-bold', text: dest.id }),
        h('div', { class: 'aw-font-caption aw-text-tertiary', text: [dest.label, size].filter(Boolean).join(' · ') }),
        h('div', { class: 'aw-margin-left-auto' }),
        button('Add', {
          title: `Add a surface to ${dest.id}`,
          onClick: () => {
            const c = dest.canvas || {};
            set(addSurface(d(), dest.id, { x: 0, y: 0, width: c.width || 1920, height: c.height || 1080 }).doc);
          }
        }),
        button('From outputs', {
          disabled: !fromOutputs.length,
          title: fromOutputs.length
            ? `One surface per output feeding ${dest.id}, where each sits on its canvas`
            : `No output reports a place on ${dest.id}’s canvas`,
          onClick: () => {
            let next = d();
            for (const s of fromOutputs) next = addSurface(next, dest.id, s).doc;
            set(next);
          }
        })),
      list.map((s) => surfaceRow(dest.id, s)),
      list.length && layers.length
        ? h('div', { class: 'aw-flex-col aw-gap-row-mini' },
          h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Layers' }),
          layers.map((layer) => bindingRow(dest.id, layer, list)))
        : null);
  }

  function warnings() {
    const out = [];
    for (const w of o.outside()) {
      const where = `${w.id} L${w.layer} is outside ${w.surface.name} on ${ROLE[w.role]}`;
      out.push(w.role === 'PGM'
        ? note('warn', `${where}. Nothing here moves program — fix it in preview and take, or recall a look that fits.`)
        : note('warn', `${where}.`));
    }
    for (const k of o.letGo()) {
      const [id, layer] = k.split('/');
      const s = boundSurface(d(), id, layer);
      out.push(note('warn', `Something keeps moving ${id} L${layer} out of ${s ? s.name : 'its surface'}, so it has been let go rather than fought over. Change its binding to try again.`));
    }
    return out;
  }

  function activity() {
    const lines = o.recent().filter((r) => r.kind === 'kept' || r.kind === 'pulled').slice(0, 3).map((r) => {
      const what = r.kind === 'kept'
        ? (r.op ? 'redid an alignment for' : 'kept')
        : 'pulled back';
      return `${what} ${r.id} L${r.layer} inside ${r.surface}`;
    });
    return lines.length ? h('div', { class: 'aw-font-caption aw-text-tertiary', text: `Last: ${lines.join('; ')}.` }) : null;
  }

  function status(seen) {
    const any = Object.keys(d().surfaces).length > 0;
    if (!any) {
      return note('', 'Add a surface for each LED element a screen lands on, then bind layers to them. A bound layer stays inside its surface however it is moved, and full screen fills the surface.');
    }
    if (!d().visible) return note('', 'Outlines hidden. Bound layers are still kept inside their surfaces.');
    if (!seen.cards) return note('', 'The outlines are drawn on the Screens / Aux. cards, so they show once those are on the page.');
    if (seen.blocks && !seen.rasters) return note('warn', 'The screen cards are here but their canvases could not be found — a firmware that draws them differently. No outlines are drawn; layers are still kept in.');
    return note(seen.top ? 'warn' : '', `Outlined on ${seen.drawn} buffer${seen.drawn === 1 ? '' : 's'}.`
      + (seen.top ? ' Some cards are laid out differently from the ones this was built against, so the outlines are over the selection handles there.' : ''));
  }

  function toolbar() {
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium aw-flex-wrap' },
      h('div', { class: 'aw-font-subtitle-1', text: 'Surfaces' }),
      h('label', { class: 'aw-flex-row-center-v aw-gap-col-small aw-margin-left-auto', title: 'Draw the surfaces over the screen cards' },
        h('input', {
          type: 'checkbox', checked: d().visible ? 'checked' : null,
          onChange: (ev) => set({ ...d(), visible: ev.target.checked })
        }),
        h('span', { class: 'aw-font-caption', text: 'Outlines' })));
  }

  function body(dests, seen) {
    if (!o.ready()) return h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'Waiting for the switcher…' });
    if (!o.platform()) return note('warn', 'Surfaces works on a LivePremier for now. Nothing is kept in on this switcher.');
    return h('div', { class: 'aw-flex-col aw-gap-row-big' },
      o.hooked() ? null : note('warn', 'This page’s socket hook is older than this feature, so writes leaving the page are not kept in. Reload the page.'),
      warnings(),
      dests.length ? dests.map(section) : note('', 'No screens or auxiliaries in service.'),
      activity(),
      status(seen));
  }

  function signature(dests, seen) {
    return JSON.stringify([
      o.ready(), o.platform(), o.hooked(), d(),
      dests.map((x) => [x.id, x.label, x.canvas && x.canvas.width, x.canvas && x.canvas.height,
        o.layers(x.id).map((l) => [l.key, l.label]), o.outputs(x.id).length,
        o.layers(x.id).map((l) => o.locked(x.id, l.key))]),
      o.outside().map((w) => [w.id, w.layer, w.role]),
      o.letGo(),
      o.recent().map((r) => [r.at, r.kind]),
      seen
    ]);
  }

  /** Pressed, or typing in one of our fields — the two states a repaint breaks. */
  function busy() {
    if (pressed) return true;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    return Boolean(root && active && active.tagName === 'INPUT' && active.type !== 'checkbox' && root.contains(active));
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

  function render() {
    const dests = o.ready() ? o.destinations() : [];
    const seen = o.describe();
    const sig = signature(dests, seen);
    if (root && sig === shown) return root;
    if (root && busy()) return root;
    const fresh = panel({ toolbar: toolbar(), body: body(dests, seen) });
    if (root) fill(root, ...fresh.childNodes);
    else { root = fresh; watch(root); }
    shown = sig;
    return root;
  }

  return { render, busy };
}
