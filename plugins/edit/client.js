/*
 * The Edit page — the plugin's page half.
 *
 * A preset buffer that is not on the device: the **programmer**. It is a
 * session in its own right — the same `{ store, send }` contract, the same
 * buffer-keyed addressing — so the Layer panel drives it unchanged. It gets
 * its OWN properties panel rather than sharing the one on the tab strip,
 * because the two point at different buffers and `view.mode` is one field:
 * sharing would have the strip's Layer tab silently following the Edit page's
 * selection into a buffer the device does not have. See
 * `src/core/programmer.js`.
 *
 * First in the PLUS section, and a page rather than a tab: it is the Screens /
 * Aux. layout with one row instead of two, with a sources column of its own
 * that no 360px strip could hold, and it is the one entry there an operator
 * opens before the show rather than during it.
 */

import { createEditPanel } from './panel.js';
import { createPropertiesPanel } from '../../src/ui/properties-panel.js';
import { createProgrammer, EDIT } from '../../src/core/programmer.js';
import { composeMemory, saveViaPreview, applyLook, lookFromMemory } from '../../src/core/save-look.js';
import { fromMemory } from '../../src/core/preset-file.js';

/**
 * Save a programmed look into a real memory slot.
 *
 * Two routes, and the operator chooses on the page: the direct one writes the
 * bank itself and touches no bus at all; the fallback borrows preview and puts
 * it back. `src/core/save-look.js` sets out both, and `memory-import.js` why
 * the direct one has a condition attached that this app cannot check.
 */
async function saveLook(ctx, programmer, { id, slot, label, route }) {
  if (route === 'preview') {
    return saveViaPreview({ session: ctx.session, programmer, id, slot, label });
  }

  const memory = composeMemory({ programmer, id, slot, label });
  if (!memory) return { ok: false, message: `${id}: nothing programmed to save` };

  const res = await fetch(ctx.url('/'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memories: [memory] })
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.ok) return { ok: true, message: `memory ${slot} written from ${id} — no buffer touched` };
  /* The expected failure on a real switcher is that it cannot see this
     machine's disk, and the operator's next move is the other route. Say so
     rather than making them work it out. */
  return { ok: false, message: `${body.error || 'the save failed'} — try the “Via preview” route` };
}

/** Read a memory back out of the bank and into the programmer. */
async function loadLook(ctx, programmer, { id, slot }) {
  const res = await fetch(`${ctx.url('/')}?slots=${encodeURIComponent(slot)}`, { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) return { ok: false, message: body.error || `could not read memory ${slot}` };

  const first = (body.memories || [])[0];
  if (!first) return { ok: false, message: `memory ${slot} is empty` };

  const memory = fromMemory(first);
  const sent = applyLook({ programmer, id, look: lookFromMemory(memory) });
  if (!sent) return { ok: false, message: `memory ${slot} had nothing this screen could take` };
  return {
    ok: true,
    message: `memory ${slot}${memory.label ? ` “${memory.label}”` : ''} loaded into ${id} (${sent} properties)`
  };
}

/**
 * Where the memory file goes — the one setting on the settings page that
 * names a path on the OTHER machine. `presetBank/import/extract` is resolved
 * by the device: on a simulator this app's temporary directory is also the
 * device's, and on a real switcher it is the switcher's disk.
 */
function memoryCard(ctx) {
  const { h, card, note } = ctx.kit;
  const current = ctx.settings.get().memoryImportDir || '';
  return card('Saving memories from the Edit page',
    h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Shared directory' }),
      h('input', {
        class: 'wru-input', type: 'text', value: current,
        placeholder: '/Volumes/showshare/lpp',
        style: { maxWidth: '20rem' },
        onBlur: (ev) => {
          const value = ev.target.value.trim();
          if (value === current) return;
          ctx.settings.set({ memoryImportDir: value })
            .then(() => ctx.refresh(), (err) => ctx.log.warn('the directory was not saved', err));
        },
        onKeyDown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); } }
      })),
    note(null,
      'The Edit page can write a memory straight into the bank, touching neither preview nor '
      + 'program. It does it by handing the switcher a file — and the path is resolved by the '
      + 'switcher, not by this app. Both are the same machine on a simulator, so leaving this '
      + 'empty works there.'),
    note('warn',
      'On real hardware this has to be an absolute path both machines can see, and it has not '
      + 'been proven on one. The Edit page’s “Via preview” route needs none of this and works '
      + 'on any switcher.'));
}

export default function activate(ctx) {
  const namer = () => ctx.use('names');
  const names = () => (namer() ? namer().get() : {});

  const programmer = createProgrammer({ session: ctx.session });
  const properties = createPropertiesPanel({
    session: programmer,
    onRefresh: ctx.refresh,
    popoutEnabled: false,
    names,
    onRename: (...a) => { const n = namer(); if (n) n.rename(...a); },
    canRename: () => Boolean(namer()),
    /* The programmer's buffer is the only one this panel offers, and the
       roles are off with it: EDIT is on neither bus and never can be. */
    buffers: [EDIT],
    roles: false
  });
  const edit = createEditPanel({
    session: ctx.session,
    programmer,
    properties,
    onRefresh: ctx.refresh,
    names,
    onSave: (req) => saveLook(ctx, programmer, req),
    onLoad: (req) => loadLook(ctx, programmer, req)
  });
  programmer.addEventListener('changed', ctx.refresh);

  ctx.ui.sidebar({
    id: 'edit',
    label: 'Edit',
    icon: ['properties-18', 'layer-stacked-18'],
    order: 10,
    render: () => edit.render(),
    /* Holds repaints off while a property is being typed. */
    busy: () => properties.busy()
  });
  ctx.ui.settingsSection({ id: 'edit', order: 10, render: () => memoryCard(ctx) });

  /*
   * The snapshot clock runs from here rather than from the page being opened:
   * the shell has no per-entry show/hide hook, and the clock costs nothing
   * with nothing on screen — it skips a hidden document outright and drops
   * every `<img>` that is no longer connected.
   */
  edit.start();
}
