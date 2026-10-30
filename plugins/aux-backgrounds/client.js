/*
 * Aux backgrounds — experimental: a still or a live input on an aux's
 * background, from a section added to the vendor's Preconfig ▸ Backgrounds page.
 *
 * ## What is known, and what is not
 *
 * Web RCS closes an aux's background in its client, not in the switcher: the
 * vendor's picker allows an aux's NATIVE layer only NONE, and
 * `preconfig/backgrounds` lists screens only. But a write of the NATIVE
 * layer's source is taken and reported — `STILL_<n>`, `LIVE_<n>`, `COLOR`,
 * `NATIVE_<n>` — on the 6.2.73 and 6.1.60 simulators and on an Aquilon RS4 on
 * 6.1.60 (2026-10-17), and a still or input used that way gets its own
 * `isOnPreview` / `isOnProgram`, so it tallies as on air. A whole-store diff on
 * the 6.1.60 simulator shows nothing else move: no capacity, no preconfig, no
 * error word. **Whether a frame's output draws it is unknown**: no aux's NATIVE
 * is ever given capacity, a simulator has no video, and the RS4 was reset
 * before anyone looked. Hence experimental, behind the Experimental features
 * switch, and said on the section itself.
 *
 * ## What it writes
 *
 * One property per action: `auxiliaryList/items/<A>/presetList/items/<letter>/
 * layerList/items/NATIVE/source/pp/inputNum`, the letter worked out from the
 * aux's transition as it is at that moment (a take moves program to the other
 * letter), and waited for until the switcher's own echo comes back. Program
 * asks first. Nothing is written mid-take.
 *
 * ## Where it goes
 *
 * `/preconfig/backgrounds` is a Preconfig panel (`.aw-panel--huge`) whose
 * content holds the tab row and one `.aw-panel--large` column for the screens.
 * This adds a column of its own after it, marked `data-lpp-aux-bg`, rather than
 * reaching inside the vendor's, whose inner layout is not the same on every
 * firmware (6.1.60 shows an info box when no screen is in service). A
 * MutationObserver puts it back when React redraws the page.
 */

import { h, button, note } from '../../src/ui/dom.js';
import { dialectFor } from '../../src/core/dialect.js';
import { listDestinations, presetBanks } from '../../src/core/screens.js';
import { readStills } from '../../src/core/stills.js';
import { sendAndEcho, until } from '../../src/core/wire.js';

const MARK = 'data-lpp-aux-bg';
const ROUTE = /^\/preconfig\/backgrounds\/?$/;

/** The NATIVE layer's source in one buffer of one aux. */
export const nativePath = (id, letter, status = false) => [
  'device', 'auxiliaryList', 'items', id, 'presetList', 'items', letter,
  'layerList', 'items', 'NATIVE', 'source', ...(status ? ['status'] : []), 'pp', 'inputNum'
];

/**
 * What an aux's background can be given here: none, the stills that hold an
 * image, and the inputs the vendor's own pickers would offer a layer — plus
 * whatever either buffer holds now, so a value set elsewhere is never hidden.
 */
export function choices(store, holding = []) {
  const dialect = dialectFor(store);
  const offered = dialect && dialect.sourceOffered ? dialect.sourceOffered(store) : () => true;
  const stills = new Map(readStills(store).map((s) => [`STILL_${s.key}`, s]));
  const out = [{ value: 'NONE', label: 'None' }];
  for (const src of (dialect && dialect.sources ? dialect.sources(store) : [])) {
    if (src.kind === 'still') {
      const s = stills.get(src.value);
      if (s && s.mode !== 'NONE') out.push({ value: src.value, label: `Still ${src.value.slice(6)}${s.label ? ` — ${s.label}` : ''}` });
    } else if (src.kind === 'input' && offered(src.value)) {
      out.push({ value: src.value, label: src.label && src.label !== src.value ? `${src.value.replace('_', ' ')} — ${src.label}` : src.value.replace('_', ' ') });
    }
  }
  for (const v of holding) {
    if (v && !out.some((c) => c.value === v)) out.push({ value: v, label: `${v.replace('_', ' ')} (set elsewhere)` });
  }
  return out;
}

export default function activate(ctx) {
  const store = ctx.session.store;
  const doc = typeof document !== 'undefined' ? document : null;
  const picked = new Map();      // aux id -> chosen value
  const said = new Map();        // aux id -> { tone, text }
  let armed = null;              // aux id whose PGM is waiting for a second click
  let busy = false;
  let observer = null;
  let queued = false;

  const livePremier = () => {
    const d = dialectFor(store);
    return !!d && d.id === 'nlc';
  };
  const onPage = () => typeof location !== 'undefined' && ROUTE.test(location.pathname);

  /** The Preconfig panel's content, which holds the tab row and the vendor's column. */
  function host() {
    if (!doc) return null;
    for (const panel of doc.querySelectorAll('.aw-panel.aw-panel--huge')) {
      const content = panel.querySelector(':scope > .aw-panel__content');
      if (content && content.querySelector(':scope > .tabular')) return content;
    }
    return null;
  }

  function auxRow(dest) {
    const banks = presetBanks(store, dest.id);
    const get = (letter, status) => store.get(nativePath(dest.id, letter, status));
    const pgm = get(banks.program), pgmSaid = get(banks.program, true);
    const prw = get(banks.preview), prwSaid = get(banks.preview, true);
    const options = choices(store, [pgm, prw]);
    const value = picked.has(dest.id) ? picked.get(dest.id) : (prw || 'NONE');
    /* Read again at the press, not taken from this drawing: a pick does not
       redraw the row while its picker has focus (below), so the buttons drawn
       before it would send the old value — NONE, on an Aquilon C mini on
       2026-10-30, with LIVE_2 showing in the picker. */
    const chosen = () => (picked.has(dest.id) ? picked.get(dest.id) : (get(presetBanks(store, dest.id).preview) || 'NONE'));
    const label = (v) => (options.find((c) => c.value === v) || { label: v || '—' }).label;
    const shows = (set, reported) => `${label(set)}${reported !== undefined && reported !== set ? ` (switcher reports ${reported})` : ''}`;
    const blocked = busy || !banks.reported || !banks.settled;
    const message = said.get(dest.id);
    const isArmed = armed === dest.id;
    return h('div', { class: 'aw-flex-col aw-gap-row-small', dataset: { lppAuxBgRow: dest.id } },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium aw-flex-wrap' },
        h('div', { class: 'aw-font-body-1-bold', style: { minWidth: '7rem' }, text: `${dest.id}${dest.label ? ` ${dest.label}` : ''}` }),
        h('div', { class: 'aw-font-caption aw-text-tertiary', text: `PGM ${banks.program}: ${shows(pgm, pgmSaid)} · PRW ${banks.preview}: ${shows(prw, prwSaid)}` })),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        h('select', {
          class: 'wru-input', 'aria-label': `${dest.id} background`, style: { flex: '1 1 14rem', minWidth: '0' },
          onChange: (ev) => { picked.set(dest.id, ev.target.value); armed = null; paint(); }
        }, options.map((c) => h('option', { value: c.value, selected: c.value === value ? 'selected' : null, text: c.label }))),
        button('To PRW', {
          disabled: blocked, title: `Put it on ${dest.id}’s preview (${banks.preview})`,
          onClick: () => write(dest, 'preview', chosen())
        }),
        button(isArmed ? 'Confirm — on air' : 'To PGM', {
          variant: 'danger', disabled: blocked,
          title: `Put it on ${dest.id}’s program (${banks.program}) — straight to the output`,
          onClick: () => {
            if (!isArmed) { armed = dest.id; paint(); return; }
            armed = null;
            write(dest, 'program', chosen());
          }
        })),
      !banks.settled ? note('', `${dest.id} is mid-take; this waits for it to land.`) : null,
      message ? note(message.tone, message.text) : null);
  }

  async function write(dest, role, value) {
    if (busy) return;
    const banks = presetBanks(store, dest.id);
    if (!banks.reported || !banks.settled) return;
    const letter = role === 'program' ? banks.program : banks.preview;
    busy = true;
    said.set(dest.id, { tone: '', text: `Writing ${value} to ${dest.id}’s ${role} background (${letter})…` });
    paint();
    let heard = false;
    try {
      heard = await sendAndEcho(ctx.session, [{ path: nativePath(dest.id, letter), value }], { inbound: true });
      /* The source is confirmed twice, the value and then its status, not
         always together (AGENTS.md, Testing): wait for the second as well. */
      if (heard) await until(store, () => store.get(nativePath(dest.id, letter, true)) === value, 2000);
    } catch (err) {
      ctx.log.warn(`aux background ${dest.id}: ${err.message}`);
    }
    const reported = store.get(nativePath(dest.id, letter, true));
    said.set(dest.id, heard
      ? { tone: '', text: `${dest.id}’s ${role} background (${letter}) is ${value}; the switcher reports ${reported ?? 'nothing yet'}. Whether its output draws it is the unproven part.` }
      : { tone: 'warn', text: `${dest.id}’s ${role} background did not echo ${value}: the switcher may have refused it.` });
    busy = false;
    paint();
  }

  function section() {
    const auxes = store.ready ? listDestinations(store).filter((d) => d.kind === 'aux') : [];
    return h('div', { class: 'aw-panel aw-panel--large', [MARK]: '', style: { marginTop: '1rem' } },
      h('div', { class: 'aw-panel__header' },
        h('h3', { text: 'Aux. screens — backgrounds (experimental)' })),
      h('div', { class: 'aw-panel__content aw-flex-col aw-gap-row-medium', style: { padding: '1rem' } },
        note('warn', 'Web RCS offers an aux no background, but the switcher takes one: a still or an input on its NATIVE layer, reported back like any other source. No frame has been seen to draw it yet, so try it on a spare output, not in a show.'),
        !store.ready ? note('', 'Waiting for the switcher…')
          : !livePremier() ? note('', 'LivePremier only.')
            : auxes.length ? auxes.map(auxRow) : note('', 'No aux screen is in service — Preconfig ▸ Aux. Screens.')));
  }

  /** Mount, refresh or remove the section, as the page and the store say. */
  function paint() {
    if (!doc) return;
    const existing = doc.querySelector(`[${MARK}]`);
    if (!onPage()) { if (existing) existing.remove(); return; }
    const where = host();
    if (!where) return;
    /* Never rebuild under an open picker. */
    if (existing && existing.contains(doc.activeElement) && doc.activeElement.tagName === 'SELECT') return;
    const fresh = section();
    if (existing && existing.parentElement === where) existing.replaceWith(fresh);
    else { if (existing) existing.remove(); where.append(fresh); }
  }

  const schedule = () => {
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => { queued = false; paint(); });
  };

  if (doc && typeof MutationObserver === 'function') {
    observer = new MutationObserver(() => {
      /* Our own repaint is a mutation too; only react when ours is missing or the page moved. */
      const present = !!doc.querySelector(`[${MARK}]`);
      if (onPage() !== present) schedule();
    });
    observer.observe(doc.body, { childList: true, subtree: true });
  }
  for (const prefix of [['device', 'auxiliaryList'], ['device', 'screenAuxGroupList'], ['device', 'stillList']]) {
    store.subscribe(prefix, () => { if (onPage()) schedule(); }, { immediate: false });
  }
  schedule();
}
