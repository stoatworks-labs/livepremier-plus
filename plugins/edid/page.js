/*
 * The EDID builder, on the vendor's own EDID page.
 *
 * Read off a running Web RCS (LivePremier Simulator 6.2.73, 2026-09-23):
 *
 *   route      `/edids`
 *   column     the middle one, `[class*="banks-section__c"]`: a Semantic UI
 *              `.ui.tabular.menu` of two anchors with no `href` — Default EDIDS
 *              and EDID Bank, each an `h3` — over one `.ui.bottom.attached
 *              .segment` pane. The tabs switch React state, not the route.
 *   a card     `[class*="edid-card__c___"]`, headed `ED7` (bank) or `AW3`
 *              (defaults), with its tools — bin, ⋮ — in
 *              `[class*="edid-card__c__tools"]`.
 *
 * What goes there:
 *
 *   From Formats    a third tab. Opening it hides the vendor's pane rather
 *                   than floating over it, so going back leaves the vendor's
 *                   scroll where it was; a click on a vendor tab closes it.
 *   Create EDID…    an item at the end of the strip that opens the editor. It
 *                   is not a tab: it opens a window and changes nothing here.
 *   Edit            a tool on each filled ED card, beside the vendor's bin and
 *                   ⋮, opening the editor on that slot.
 *
 * Same discipline as `ui/tabs.js` and the Router tab: everything is cloned
 * from a live vendor node so this build's hashed classes come with it; React
 * re-renders this column constantly, so a MutationObserver puts ours back; a
 * page this cannot recognise gets nothing.
 *
 * ⚠️ The vendor's own active tab is still React's. While ours is open its
 * `active` class is taken off so only one tab looks selected, and put back
 * when ours closes — React does not re-render a tab whose state did not
 * change, so a class it never knew was gone would stay gone.
 */

import { h, button, icon, spriteId } from '../../src/ui/dom.js';

const MARK = 'data-lpp-edid';
const ROUTE = /^\/edids\/?$/;

export function installEdidPage({ session, enabled, subscribe, slots, formatEdids, save, openEditor, autoFill, setAutoFill, doc = document }) {
  let open = false;
  let dimmed = [];
  let observer = null;
  let rows = null;
  let pane = null;

  /* ------------------------------------------------------------ finding it */

  /** The bank column's strip, its pane and the vendor's tabs — or null. */
  function column() {
    for (const strip of doc.querySelectorAll('[class*="banks-section__c"] > .ui.tabular.menu, .ui.tabular.menu')) {
      const tabs = [...strip.querySelectorAll(':scope > a')].filter((a) => !a.hasAttribute(MARK) && !a.hasAttribute('href'));
      const words = tabs.map((a) => a.textContent.trim());
      if (!words.includes('EDID Bank')) continue;
      const vendorPane = [...strip.parentElement.children].find((c) => c !== strip && !c.hasAttribute(MARK));
      return { strip, tabs, vendorPane };
    }
    return null;
  }

  /* ----------------------------------------------------------- decorating */

  function decorate() {
    if (!enabled() || !ROUTE.test(location.pathname)) { if (open) close(); return; }
    const col = column();
    if (!col) return;
    mountTabs(col);
    mountPane(col);
    mountSlotTools(col);
  }

  function cloneTab(template, text, role) {
    const tab = template.cloneNode(true);
    tab.setAttribute(MARK, role);
    tab.classList.remove('active');
    tab.removeAttribute('aria-current');
    tab.style.cursor = 'pointer';
    const label = tab.querySelector('h3, h4, h5') || tab;
    label.textContent = text;
    return tab;
  }

  function mountTabs({ strip, tabs }) {
    if (strip.querySelector(`[${MARK}="tab"]`)) return;
    const template = tabs.find((a) => !a.classList.contains('active')) || tabs[0];
    if (!template) return;

    const tab = cloneTab(template, 'From Formats', 'tab');
    tab.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); show(); });

    /* Quieter than a tab, and pushed to the far end: it opens a window, it
       does not switch this pane. */
    const create = cloneTab(template, 'Create EDID…', 'create');
    create.style.marginLeft = 'auto';
    create.title = 'Build an EDID in the Otter editor and save it into the bank';
    const label = create.querySelector('h3, h4, h5');
    if (label) label.classList.add('aw-text-secondary');
    create.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); openEditor(null); });

    strip.append(tab, create);
    if (open) show();
  }

  function mountPane({ strip, vendorPane }) {
    const ours = strip.parentElement.querySelector(`:scope > [${MARK}="pane"]`);
    if (!open) { if (ours) ours.remove(); return; }
    if (vendorPane && !vendorPane.dataset.lppEdidHidden) {
      vendorPane.dataset.lppEdidHidden = '1';
      vendorPane.style.display = 'none';
    }
    if (ours) return;
    pane = h('div', {
      class: (vendorPane && vendorPane.className) || 'ui bottom attached segment active tab aw-flex-item',
      [MARK]: 'pane',
      style: { overflowY: 'auto' }
    });
    strip.parentElement.append(pane);
    renderPane();
  }

  function show() {
    const col = column();
    if (!col) return;
    open = true;
    for (const a of col.tabs) if (a.classList.contains('active')) { a.classList.remove('active'); dimmed.push(a); }
    const tab = col.strip.querySelector(`[${MARK}="tab"]`);
    if (tab) tab.classList.add('active');
    mountPane(col);
  }

  function close() {
    open = false;
    for (const a of dimmed) if (a.isConnected) a.classList.add('active');
    dimmed = [];
    for (const node of doc.querySelectorAll(`[${MARK}="pane"]`)) node.remove();
    for (const node of doc.querySelectorAll(`[${MARK}="tab"]`)) node.classList.remove('active');
    for (const p of doc.querySelectorAll('[data-lpp-edid-hidden]')) { p.style.display = ''; delete p.dataset.lppEdidHidden; }
    pane = null;
  }

  /* A click on one of the vendor's tabs closes ours — capture phase, before
     React switches its pane. */
  const onClick = (ev) => {
    const a = ev.target.closest && ev.target.closest('.ui.tabular.menu > a');
    if (a && open && !a.hasAttribute(MARK)) close();
  };
  doc.addEventListener('click', onClick, true);

  /* ------------------------------------------------------ the bank's cards */

  /**
   * An Edit tool on every filled ED card. Cloned from the card's ⋮ so it is
   * the vendor's button to the pixel; the glyph is swapped. Empty slots have
   * no tools — the vendor draws an upload box there — and AW cards are the
   * vendor's defaults, not slots.
   */
  function mountSlotTools() {
    for (const tools of doc.querySelectorAll('[class*="edid-card__c__tools"]')) {
      if (tools.querySelector(`[${MARK}]`)) continue;
      const card = tools.closest('[class*="edid-card__c___"]');
      const head = card && card.querySelector('[class*="edid-card__c__header"]');
      const m = head && /^ED(\d+)$/.exec(head.textContent.trim());
      if (!m) continue;
      const more = tools.querySelector('use[href="#more-vertical-12"]');
      const wrapper = more && more.closest('button');
      if (!wrapper) continue;
      const edit = wrapper.cloneNode(true);
      edit.setAttribute(MARK, `edit-${m[1]}`);
      edit.title = `Edit ED${m[1]} in the EDID builder`;
      const use = edit.querySelector('use');
      const glyph = spriteId(['edit-layout-14', 'cog-12']);
      use.setAttribute('href', `#${glyph}`);
      use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `#${glyph}`);
      edit.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const slot = slots().find((s) => s.id === m[1]);
        if (slot && slot.bytes) openEditor({ bytes: slot.bytes, slotId: slot.id });
      });
      tools.prepend(edit);
    }
  }

  /* ---------------------------------------------------------- From Formats */

  let drawing = null;
  async function renderPane() {
    if (!pane) return;
    const target = pane;
    const run = (drawing = {});
    let list;
    try {
      list = await formatEdids();
    } catch (err) {
      list = err;
    }
    if (run !== drawing || target !== pane) return;
    rows = list;
    fillPane(target, list);
  }

  function fillPane(target, list) {
    const auto = autoFill();
    const bank = slots();
    const free = bank.filter((s) => s.empty && !s.locked);
    const missing = Array.isArray(list) ? list.filter((f) => f.bytes && !f.carried) : [];

    const head = h('div', { class: 'aw-flex-col aw-gap-row-small aw-padding-big' },
      h('div', { class: 'aw-flex-row-center-v-space-between aw-gap-col-medium', style: { flexWrap: 'wrap' } },
        h('div', { class: 'aw-font-subtitle-1', text: 'EDIDs from the custom format library' }),
        h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
          button(missing.length ? `Save ${missing.length} to the bank` : 'All in the bank', {
            disabled: !missing.length || !free.length || auto.busy,
            title: 'Each goes into the next empty slot. No filled slot is touched.',
            onClick: () => saveAll(missing)
          }),
          button('Create EDID…', { onClick: () => openEditor(null) }))),
      h('label', { class: 'aw-flex-row-center-v aw-gap-col-small aw-font-body-2', style: { cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: auto.on,
          onChange: (ev) => setAutoFill(ev.target.checked).catch((err) => { ev.target.checked = !ev.target.checked; say(err.message); })
        }),
        h('span', { text: 'Keep the bank filled — whenever a custom format has no EDID in the bank, add one to the next empty slot' })),
      h('div', {
        class: 'aw-font-caption aw-text-tertiary',
        text: 'Each EDID is built by the Otter EDID editor around the format’s exact timing, every porch kept, '
          + 'with the CTA VIC when the raster is one. A format counts as in the bank when a slot’s EDID has its '
          + 'mode as the preferred one — so an EDID opened from here and edited still counts. '
          + 'Nothing is ever deleted or overwritten here.'
      }),
      auto.last.text ? h('div', { class: 'aw-font-caption aw-text-secondary', text: auto.last.text }) : null,
      h('div', { class: 'aw-font-caption wru-warn', [MARK]: 'said' }));

    let body;
    if (!(Array.isArray(list))) {
      body = h('div', { class: 'aw-padding-big wru-warn', text: `Could not build the EDIDs: ${list && list.message}` });
    } else if (!list.length) {
      body = h('div', { class: 'aw-padding-big aw-text-tertiary',
        text: 'No valid custom formats yet. Make one in Setup ▸ Formats (Create, Check, Save to M1…M16) and its EDID appears here.' });
    } else {
      body = h('div', { class: 'aw-flex-col aw-gap-row-small aw-padding-big' }, list.map((f) => formatCard(f, bank)));
    }
    target.replaceChildren(head, body);
  }

  const say = (text) => { const n = pane && pane.querySelector(`[${MARK}="said"]`); if (n) n.textContent = text; };

  function formatCard(f, bank) {
    const nextFree = bank.find((s) => s.empty && !s.locked);
    const status = f.error
      ? h('span', { class: 'wru-warn', text: f.error })
      : f.inBank
      ? h('span', { class: 'aw-text-success', text: `In the bank as ${f.inBank.label}` })
      : f.carried
      ? h('span', { class: 'aw-text-secondary', text: `${f.carried.label} (${f.carried.name || 'unnamed'}) has this mode, edited` })
      : h('span', { class: 'aw-text-tertiary', text: 'Not in the bank' });

    return h('div', { class: 'aw-flex-row aw-border-radius aw-overflow-hidden', [MARK]: `format-${f.key}`, style: { background: 'var(--lpp-card, rgba(255,255,255,0.04))' } },
      h('div', { class: 'aw-padding aw-font-body-1', style: { minWidth: '3.5rem' }, text: f.label }),
      h('div', { class: 'aw-flex-item aw-padding aw-flex-col aw-gap-row-mini' },
        h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
          h('span', { class: 'aw-font-bold', text: f.edidName || f.name || f.label }),
          f.name && f.edidName !== f.name ? h('span', { class: 'aw-font-italic aw-text-tertiary', text: f.name }) : null),
        h('div', { class: 'aw-font-body-2', text: [f.mode, f.vic ? `CTA VIC ${f.vic}` : 'detailed timing', f.bytes ? `${f.bytes.length} bytes` : ''].filter(Boolean).join(' · ') }),
        h('div', { class: 'aw-font-caption' }, status)),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-padding' },
        f.bytes && !f.inBank
          ? button(nextFree ? `Save to ${nextFree.label}` : 'Bank full', {
              disabled: !nextFree,
              onClick: async (ev) => {
                const btn = ev.currentTarget;
                btn.disabled = true;
                try { await save(nextFree.id, f.bytes); } catch (err) { say(err.message); btn.disabled = false; }
              }
            })
          : null,
        f.bytes ? button('Edit…', { title: 'Open it in the editor to change anything before saving', onClick: () => openEditor({ bytes: f.bytes, slotId: f.inBank ? f.inBank.id : undefined }) }) : null,
        f.bytes ? h('button', {
          class: 'ui button text neutral',
          title: 'Download .bin',
          onClick: () => download(f.bytes, `${(f.edidName || f.label).replace(/[^A-Za-z0-9._-]+/g, '_')}.bin`)
        }, icon('download-12', 'small aw-block-medium')) : null));
  }

  async function saveAll(missing) {
    const skip = new Set();
    const done = [];
    try {
      for (const f of missing) {
        const bank = slots();
        const free = bank.find((s) => s.empty && !s.locked && !skip.has(s.id));
        if (!free) { say('The EDID bank is full.'); break; }
        skip.add(free.id);
        await save(free.id, f.bytes);
        done.push(`${f.label} → ${free.label}`);
      }
      say(done.length ? `Saved ${done.join(', ')}.` : '');
    } catch (err) {
      say(`${done.length ? `Saved ${done.join(', ')}; then ` : ''}${err.message}`);
    }
  }

  function download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = h('a', { href: url, download: name });
    doc.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* -------------------------------------------------------------- running */

  const unsubscribe = subscribe(() => { if (pane) renderPane(); });

  let queued = false;
  observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => { queued = false; decorate(); });
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  decorate();

  return {
    refresh: decorate,
    /* For the console, and for a firmware that moves the page: what this found. */
    describe: () => ({ page: location.pathname, column: !!column(), open, formats: Array.isArray(rows) ? rows.length : null }),
    stop() {
      unsubscribe();
      doc.removeEventListener('click', onClick, true);
      if (observer) observer.disconnect();
      close();
      for (const node of doc.querySelectorAll(`[${MARK}]`)) node.remove();
    }
  };
}
