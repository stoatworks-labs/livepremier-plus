/*
 * AoI from a custom format — a section added to the vendor's own AoI panel on
 * Preconfig ▸ Canvas: pick a custom format and where it sits, and the selected
 * output's AoI becomes that size, written the way the vendor's fields write
 * it. `core.js` has the switcher's model and the arithmetic.
 *
 * ## Where it goes
 *
 * `/preconfig/pixelspaces/…` draws, for a selected output, a panel headed AOI
 * whose content holds the vendor's form (Mode, the AoI picture, Overscan or
 * the four values). The panel is found by the AoI picture's CSS-module class
 * (`pixelspaces-output-aoi-content__c…`, the same in 6.1.60 and 6.2.73 — the
 * file name is stable where the hash is not) with the `AOI` heading as the
 * fallback, and this section is appended to the panel's content after the
 * vendor's form, marked `data-lpp-aoi-format`. A MutationObserver puts it back
 * when React redraws.
 *
 * ## Which output
 *
 * The vendor names its selection in a heading — `Screen 1 - Region 1 - Group
 * 2 - Output 3` — with `+ (n)` beside it when more than one is selected. The
 * output is read from that; a selection of several, or of a slice, is not
 * one this section acts on, and it says so.
 */

import { h, button, note } from '../../src/ui/dom.js';
import { dialectFor } from '../../src/core/dialect.js';
import { sendAndEcho, until } from '../../src/core/wire.js';
import { customFormats, outputAoi, matchingFormat, plan, landed, selectedOutput, ANCHORS } from './core.js';

const MARK = 'data-lpp-aoi-format';
const ROUTE = /^\/preconfig\/pixelspaces(\/|$)/;

export default function activate(ctx) {
  const store = ctx.session.store;
  const doc = typeof document !== 'undefined' ? document : null;
  const picked = new Map();   // output -> { format, anchor }
  const said = new Map();     // output -> { tone, text }
  let busy = false;
  let queued = false;
  let shown = null;

  const livePremier = () => { const d = dialectFor(store); return !!d && d.id === 'nlc'; };
  const onPage = () => typeof location !== 'undefined' && ROUTE.test(location.pathname);

  /** The vendor's AoI panel's content, or null when no output is selected. */
  function host() {
    if (!doc) return null;
    const picture = doc.querySelector('[class*="pixelspaces-output-aoi-content__c"]');
    let panel = picture && picture.closest('form') && picture.closest('form').closest('.aw-panel');
    if (!panel) {
      const heading = [...doc.querySelectorAll('.aw-panel__header h4')].find((x) => x.textContent.trim() === 'AOI');
      panel = heading && heading.closest('.aw-panel');
    }
    return (panel && panel.querySelector(':scope > .aw-panel__content')) || null;
  }

  /** The selected output and whether more than one is selected, from the vendor's heading. */
  function selection() {
    if (!doc) return { output: null, several: false };
    for (const h3 of doc.querySelectorAll('h3')) {
      const output = selectedOutput(h3.textContent);
      if (!output) continue;
      const row = h3.parentElement;
      const several = !!row && [...row.querySelectorAll('h3')].some((x) => /^\+\s*\(\d+\)$/.test(x.textContent.trim()));
      return { output, several };
    }
    return { output: null, several: false };
  }

  const px = (r) => `${r.width}×${r.height} at ${r.left}, ${r.top}`;

  function section() {
    const { output: key, several } = selection();
    const formats = store.ready ? customFormats(store) : [];
    const out = key && store.ready ? outputAoi(store, key) : null;
    const pick = picked.get(key) || {};
    const current = matchingFormat(out, formats);
    const formatKey = pick.format != null ? pick.format : (current ? current.key : (formats[0] && formats[0].key) || '');
    const anchor = pick.anchor || 'top-left';
    const format = formats.find((f) => f.key === formatKey) || null;
    const p = out ? plan(out, format, anchor) : null;
    const message = said.get(key);

    let body;
    if (!store.ready) body = [note('', 'Waiting for the switcher…')];
    else if (!livePremier()) body = [note('', 'LivePremier only.')];
    else if (several) body = [note('', 'Several outputs are selected. Select one to give it the AoI of a custom format.')];
    else if (!out) body = [note('', 'Select one output in the tree to give it the AoI of a custom format.')];
    else if (!formats.length) body = [note('', 'The switcher has no custom format yet — make one in Formats, then come back.')];
    else {
      const now = out.mode === 'CUSTOM'
        ? `Custom ${px(out.reported)}${current ? ` — M${current.key}${current.name ? ` ${current.name}` : ''}’s size` : ''}`
        : `Fit Output Format (${out.raster.width}×${out.raster.height})`;
      body = [
        h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
          h('select', {
            class: 'wru-input', 'aria-label': 'Custom format', style: { flex: '1 1 14rem', minWidth: '0' },
            onChange: (ev) => { picked.set(key, { ...pick, format: ev.target.value }); said.delete(key); paint(true); }
          }, formats.map((f) => h('option', { value: f.key, selected: f.key === formatKey ? 'selected' : null, text: f.label }))),
          h('select', {
            class: 'wru-input', 'aria-label': 'Where the AoI sits', style: { flex: '0 1 8rem', minWidth: '0' },
            onChange: (ev) => { picked.set(key, { ...pick, anchor: ev.target.value }); said.delete(key); paint(true); }
          }, Object.entries(ANCHORS).map(([value, label]) => h('option', { value, selected: value === anchor ? 'selected' : null, text: label })))),
        h('div', { class: 'aw-font-caption aw-text-tertiary', text: `Output ${out.key} · ${out.raster.width}×${out.raster.height} active · now ${now}` }),
        p && p.ok
          ? h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
            h('div', { class: 'aw-font-body-2', style: { flex: '1 1 auto' }, text: `Custom ${px(p.px)}` }),
            button(busy ? 'Setting…' : 'Set AoI', {
              disabled: busy, title: `Make Output ${out.key}’s AoI ${p.px.width}×${p.px.height} — at once, as the fields above do`,
              onClick: () => apply(out.key, p)
            }))
          : note('warn', p ? p.why : ''),
        note('', 'Applies at once, like the fields above: an output on air changes on air. The output’s footprint on the canvas becomes the AoI.'),
        message ? note(message.tone, message.text) : null
      ];
    }

    return h('div', { class: 'aw-panel aw-panel--medium', [MARK]: '' },
      h('div', { class: 'aw-panel__header' }, h('h5', { text: 'From a custom format', style: { padding: '0.5rem 1rem 0' } })),
      h('div', { class: 'aw-panel__content aw-flex-col aw-gap-row-small', style: { padding: '0.5rem 1rem 1rem' } }, ...body));
  }

  async function apply(out, p) {
    if (busy || !p || !p.ok) return;
    busy = true;
    said.set(out, { tone: '', text: `Setting Output ${out}’s AoI to ${px(p.px)}…` });
    paint(true);
    let heard = false;
    try {
      heard = await sendAndEcho(ctx.session, p.writes, { inbound: true });
      await until(store, () => landed(store, p, out), 2000);
    } catch (err) {
      ctx.log.warn(`aoi from format, output ${out}: ${err.message}`);
    }
    const now = outputAoi(store, out);
    said.set(out, landed(store, p, out)
      ? { tone: '', text: `Output ${out}’s AoI is ${px(p.px)}; the switcher reports it.` }
      : { tone: 'warn', text: `The switcher reports ${now ? px(now.reported) : 'nothing'} for Output ${out}, not ${px(p.px)}${heard ? '' : ' — it did not echo every write'}.` });
    busy = false;
    paint(true);
  }

  /** Mount or refresh the section where the vendor's AoI panel is. */
  function paint(force = false) {
    if (!doc) return;
    const existing = doc.querySelector(`[${MARK}]`);
    const where = onPage() ? host() : null;
    if (!where) { if (existing) existing.remove(); shown = null; return; }
    /* Never rebuild under an open picker. */
    if (existing && existing.contains(doc.activeElement) && doc.activeElement.tagName === 'SELECT' && !force) return;
    const { output, several } = selection();
    const sig = JSON.stringify([output, several, store.ready, busy, [...picked], [...said],
      store.ready ? customFormats(store) : null, output && store.ready ? outputAoi(store, output) : null]);
    if (existing && existing.parentElement === where && sig === shown && !force) return;
    const fresh = section();
    if (existing && existing.parentElement === where) existing.replaceWith(fresh);
    else { if (existing) existing.remove(); where.append(fresh); }
    shown = sig;
  }

  const schedule = () => {
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => { queued = false; paint(); });
  };

  if (doc && typeof MutationObserver === 'function') {
    const observer = new MutationObserver(() => { if (onPage() || doc.querySelector(`[${MARK}]`)) schedule(); });
    observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
  }
  for (const prefix of [['device', 'outputList'], ['device', 'customFormats']]) {
    store.subscribe(prefix, () => { if (onPage()) schedule(); }, { immediate: false });
  }
  schedule();
}
