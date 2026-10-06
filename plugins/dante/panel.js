/*
 * Dante — the panel: the network's routing as a crosspoint grid, the device
 * list, Dante Controller presets in and out, and routing snapshots.
 * ** PREVIEW — never yet run against a real Dante device. **
 *
 * ## The grid
 *
 * Receivers down the side, transmitters across the top, because in Dante a
 * subscription belongs to the receiving channel: each row lights at most one
 * cell. It opens as device blocks — one row per receiving device, one column
 * per transmitting one — and a header opens into channels, the Audio Matrix's
 * pattern. A block cell says how many of that receiver's channels take from
 * that transmitter, and is solid when it is channel for channel (1→1, 2→2 …);
 * clicking it lays the transmitter across the receiver that way, or clears
 * exactly that when it is already so. Where an open row meets an open column
 * the cells are single subscriptions.
 *
 * ## Locked when it opens
 *
 * The Audio Matrix starts unlocked; this does not. Its grid reaches every
 * device on the Dante network — the console, the amplifiers, a broadcast
 * truck's interface — and a stray click on the wrong row takes a feed away
 * from somebody else's show. So a page opens locked, clicks open and close
 * groups only, and unlocking is a deliberate click. A cue, an OSC address, a
 * snapshot recall and a preset apply are deliberate already and are not held
 * by the lock.
 *
 * ## What it shows is what the devices said
 *
 * A click sends the routes and marks those cells pending; they light only
 * when the server has read the receivers back and they report it. A cell is
 * coloured by the subscription's status as the device reports it — connected,
 * in progress, unresolved, failed — with the device's own reason on hover.
 *
 * ## The switcher
 *
 * The switcher's own Dante card is marked where it appears, matched by the
 * name in its store (`switcher.js`), and its channels carry what the
 * switcher's Audio Matrix does with them: a receive channel lists the outputs
 * it feeds, a transmit channel the input it carries.
 */

import { h, button, fill } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import {
  blockState, blockRoutes, cellRoute, isSubscribedTo, subscriptionOf, matches, formatLatency, formatRate, formatRef, formatLocal
} from './core.js';
import { switcherCards, matchSwitcher, audioPatches } from './switcher.js';

const POPOUT = new URL('./popout.html', import.meta.url).href;
const STYLE_ID = 'lpp-dante-style';

const CSS = `
.lpp-dn-wrap { overflow: auto; max-height: 62vh; border: 0.083333rem solid #283239; border-radius: 0.25rem; }
.lpp-dn { border-collapse: separate; border-spacing: 0; font-size: 0.833333rem; font-variant-numeric: tabular-nums; }
.lpp-dn th, .lpp-dn td { padding: 0; text-align: center; white-space: nowrap; }
.lpp-dn thead th { position: sticky; background: #0D1D26; z-index: 2; color: rgba(255,255,255,0.7); font-weight: 400; }
.lpp-dn thead tr:first-child th { top: 0; height: 1.75rem; }
.lpp-dn thead tr:nth-child(2) th { top: 1.75rem; border-bottom: 0.083333rem solid #283239; }
.lpp-dn tbody th { position: sticky; left: 0; background: #0D1D26; z-index: 1; text-align: left; color: rgba(255,255,255,0.7); font-weight: 400; }
.lpp-dn thead th.lpp-dn-corner { left: 0; z-index: 3; text-align: left; padding: 0 0.5rem; }
.lpp-dn-gh { cursor: pointer; padding: 0 0.416667rem !important; border-left: 0.083333rem solid #283239; }
.lpp-dn-gh:hover, .lpp-dn-rh--group:hover { color: #fff; }
.lpp-dn-gh--open, .lpp-dn-rh--open { color: #fff; background: #13293A !important; }
.lpp-dn-ch { min-width: 1.75rem; max-width: 4.5rem; font-size: 0.75rem; padding: 0.166667rem 0.166667rem !important; }
.lpp-dn-ch span { display: block; overflow: hidden; text-overflow: ellipsis; writing-mode: vertical-rl; transform: rotate(180deg); max-height: 6rem; margin: 0 auto; }
.lpp-dn-ch--first { border-left: 0.083333rem solid #283239; }
.lpp-dn-rh { padding: 0 0.5rem !important; min-width: 11rem; height: 1.75rem; }
.lpp-dn-rh--group { cursor: pointer; }
.lpp-dn-rh--ch { padding-left: 1.5rem !important; font-size: 0.75rem; }
.lpp-dn-row { display: flex; align-items: center; gap: 0.333333rem; }
.lpp-dn-sub { color: #838B91; font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; max-width: 9rem; }
.lpp-dn-caret { display: inline-block; width: 0.75rem; color: #838B91; }
.lpp-dn-dot { display: inline-block; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: #283239; flex: none; }
.lpp-dn-dot--connected, .lpp-dn-dot--ok { background: #00FF7F; }
.lpp-dn-dot--progress, .lpp-dn-dot--warning, .lpp-dn-dot--reading { background: #F39910; }
.lpp-dn-dot--error, .lpp-dn-dot--unreachable, .lpp-dn-dot--unknown { background: #F64747; }
.lpp-dn-badge { font-size: 0.666667rem; padding: 0 0.25rem; border-radius: 0.166667rem; background: #2185D0; color: #fff; }
.lpp-dn-badge--preview { background: #F39910; color: #08141B; }
.lpp-dn-x { width: 1.75rem; height: 1.75rem; cursor: pointer; position: relative;
  border-left: 0.083333rem solid rgba(40,50,57,0.5); border-bottom: 0.083333rem solid rgba(40,50,57,0.5); }
.lpp-dn-x--gl { border-left-color: #283239; }
.lpp-dn tbody tr.lpp-dn-tr--gt td, .lpp-dn tbody tr.lpp-dn-tr--gt th { border-top: 0.083333rem solid #283239; }
.lpp-dn-x:hover { background: rgba(255,255,255,0.06); }
.lpp-dn-x::after { content: ''; position: absolute; left: 50%; top: 50%; width: 0.583333rem; height: 0.583333rem;
  margin: -0.291667rem 0 0 -0.291667rem; border-radius: 50%; }
.lpp-dn-x--connected::after { background: #2185D0; }
.lpp-dn-x--progress::after, .lpp-dn-x--warning::after { background: #F39910; }
.lpp-dn-x--error::after, .lpp-dn-x--unknown::after { background: #F64747; }
.lpp-dn-x--none::after { background: #838B91; }
.lpp-dn-x--pending::after { background: transparent; border: 0.083333rem dashed #2185D0; }
.lpp-dn-x--block { font-size: 0.75rem; color: #838B91; }
.lpp-dn-x--block::after { display: none; }
.lpp-dn-x--part { color: #2185D0; background: rgba(33,133,208,0.10); }
.lpp-dn-x--full { color: #fff; background: #2185D0; }
.lpp-dn-x--mixed { font-size: 0.75rem; color: #2185D0; }
.lpp-dn-x--mixed::after { display: none; }
.lpp-dn-x--locked { cursor: default; }
.lpp-dn-legend { color: #838B91; font-size: 0.833333rem; }
.lpp-dn-legend b { color: rgba(255,255,255,0.85); font-weight: 400; }
.lpp-dn-note--warn { color: #F39910; }
.lpp-dn-note--ok { color: #838B91; }
.lpp-dn-list { width: 100%; border-collapse: collapse; font-size: 0.833333rem; }
.lpp-dn-list th { text-align: left; color: #838B91; font-weight: 400; padding: 0.25rem 0.5rem; border-bottom: 0.083333rem solid #283239; }
.lpp-dn-list td { padding: 0.25rem 0.5rem; border-bottom: 0.083333rem solid rgba(40,50,57,0.5); vertical-align: top; }
.lpp-dn-changes { max-height: 18rem; overflow: auto; }
.lpp-dn-strike { color: #838B91; text-decoration: line-through; }
`;

/**
 * @param {object} o
 * @param {object} o.session        the store mirror, for the switcher's card
 * @param {object} o.model          `model.js` — shared with a popped-out window
 * @param {() => object} [o.settings]  the plugin's settings (switcherDevice)
 * @param {Function} [o.onRefresh]
 * @param {boolean} [o.popoutEnabled]
 * @param {Document} [o.doc]
 */
export function createDantePanel({ session, model, settings = () => ({}), onRefresh = () => {}, popoutEnabled = true, doc = document }) {
  const view = {
    locked: true,
    routedOnly: false,
    filter: '',
    openRows: new Set(),
    openCols: new Set(),
    preset: null           // { xml, fileName, diff, assign, busy, error }
  };
  let root = null;
  let filterInput = null;
  let snapName = null;
  let fileInput = null;
  /* Persistent toolbar parts, updated in place. */
  const bar = {};
  /*
   * The body is a column of sections, each refilled only when what it shows
   * has changed — never the whole panel on every switcher frame. That keeps
   * the operator's place: an open dropdown in the preset difference, a caret
   * in the snapshot name and the grid's scroll position all survive the
   * stream telling us a status changed somewhere else. The two text fields
   * and the file picker live outside every refilled section, because a
   * focused field taken out of the document loses its focus.
   */
  const hosts = {};
  const keys = {};

  if (model && model.onChange) model.onChange(() => onRefresh());

  function styles() {
    try {
      if (!doc.head || (doc.getElementById && doc.getElementById(STYLE_ID))) return;
      const el = doc.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      doc.head.append(el);
    } catch { /* unstyled rather than not at all */ }
  }

  const rerender = () => { for (const k of Object.keys(keys)) keys[k] = null; onRefresh(); };

  /** Refill one section when its key has moved. */
  function section(name, key, make) {
    if (keys[name] === key) return;
    keys[name] = key;
    const content = make();
    fill(hosts[name], ...(Array.isArray(content) ? content : [content]));
  }

  /* ------------------------------------------------------------- render */

  function render() {
    styles();
    if (model && model.want) model.want();
    if (!root) build();
    const st = model ? model.state : { data: null, version: 0 };
    const store = session && session.store;
    const cards = switcherCards(store);
    const devices = (st.data && st.data.devices) || [];
    const matched = matchSwitcher(devices, cards, (settings() || {}).switcherDevice || '');
    const patches = new Map();
    for (const [name, m] of matched) patches.set(name, audioPatches(store, m.frame));
    const sig = JSON.stringify([cards.map((c) => [c.frame, c.name, c.addresses, [...c.rx.values()].map((x) => x.label + x.connectedTo).join()]),
      [...matched].map(([n, m]) => [n, m.frame, m.by, [...patches.get(n).rx].join(), [...patches.get(n).tx].join()])]);
    const viewKey = JSON.stringify([view.locked, view.routedOnly, view.filter, [...view.openRows], [...view.openCols]]);

    updateToolbar(st, devices);
    section('note', `${st.version}|${viewKey}|${st.error}`, () => noteLine(st));
    /* The grid is replaced when anything in it changes; where the operator
       had scrolled it to is put back. */
    const wrapBefore = hosts.grid.querySelector && hosts.grid.querySelector('.lpp-dn-wrap');
    const scroll = wrapBefore ? { top: wrapBefore.scrollTop || 0, left: wrapBefore.scrollLeft || 0 } : null;
    section('grid', `${st.version}|${viewKey}|${sig}`, () => gridSection(st, devices, matched, patches));
    const wrapAfter = hosts.grid.querySelector && hosts.grid.querySelector('.lpp-dn-wrap');
    if (scroll && wrapAfter && wrapAfter !== wrapBefore) { wrapAfter.scrollTop = scroll.top; wrapAfter.scrollLeft = scroll.left; }
    section('result', `${st.result ? st.version : 0}`, () => (st.result ? resultList(st.result) : null));
    section('switcher', `${sig}|${devices.map((d) => d.name).join()}`, () => switcherSection(cards, matched, devices));
    section('devices', `${st.version}|${sig}`, () => deviceList(devices, matched));
    section('preset', `${view.preset ? view.preset.v : 0}|${devices.filter((d) => d.status === 'ok').map((d) => d.name).join()}`, () => presetSection(devices));
    section('snapshots', JSON.stringify(st.data ? st.data.snapshots : null), () => snapshotList(st.data ? st.data.snapshots || [] : []));
    snapSave.disabled = !devices.length;
    return root;
  }

  function build() {
    filterInput = h('input', {
      class: 'wru-input', type: 'text', placeholder: 'Filter devices and channels', 'data-lpp-key': 'dante-filter',
      style: { maxWidth: '14rem' },
      onInput: (ev) => { view.filter = ev.target.value; rerender(); }
    });
    snapName = h('input', { class: 'wru-input', type: 'text', placeholder: 'Snapshot name', 'data-lpp-key': 'dante-snapshot', style: { maxWidth: '14rem' } });
    fileInput = h('input', { type: 'file', accept: '.xml,application/xml,text/xml', style: { display: 'none' }, onChange: onFile });
    bar.summary = h('span', { class: 'aw-font-caption aw-text-tertiary' });
    bar.routed = chip('', false, () => { view.routedOnly = !view.routedOnly; rerender(); },
      'Show only receiving channels that are subscribed, and the transmitters they take from');
    bar.lock = chip('', false, () => {
      view.locked = !view.locked;
      if (model) model.note('ok', view.locked ? 'Locked: clicks open and close devices and change nothing.' : 'Unlocked: a click on the grid changes a Dante subscription on the network.');
      rerender();
    }, 'The grid opens locked. Unlock it to change subscriptions by clicking.');
    const toolbarHost = h('div', { class: 'aw-flex-row-center-v-space-between aw-flex-wrap lpp-controls aw-gap-col-large' },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-large aw-flex-wrap' },
        h('div', { class: 'aw-font-subtitle-1', text: 'Dante' }),
        h('span', { class: 'lpp-dn-badge lpp-dn-badge--preview', text: 'PREVIEW', title: 'Never yet run against a real Dante device — docs/DANTE.md' }),
        bar.summary),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        filterInput, bar.routed,
        chip('Collapse all', false, () => { view.openRows.clear(); view.openCols.clear(); rerender(); }, 'Close every open device'),
        bar.lock,
        button('Refresh', { iconId: ['refresh-14', 'refresh-18'], title: 'Read every device again now', onClick: () => model && model.refresh() }),
        popoutEnabled ? button('Pop out', { iconId: 'set-layer-to-fullscreen-18', title: 'Open the Dante panel in its own window', onClick: popOut }) : null));
    snapSave = button('Save current routing', {
      title: 'Every receiving device’s subscriptions as they read now; recall puts back only what differs',
      onClick: () => { const name = snapName.value.trim(); if (name && model) { model.saveSnapshot(name); snapName.value = ''; } }
    });
    for (const name of ['note', 'grid', 'result', 'switcher', 'devices', 'preset', 'snapshots']) hosts[name] = h('div', { class: 'aw-flex-col aw-gap-row-small' });
    const snapshotsBlock = h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Routing snapshots' }),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        snapName, snapSave,
        h('span', { class: 'aw-font-caption aw-text-tertiary', text: 'Recall from here, from a cue (Dante: snapshot <name>) or over OSC (/lp/dante/snapshot/<name>/recall).' })),
      hosts.snapshots);
    const presetBlock = h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Dante Controller presets' }),
      fileInput, hosts.preset);
    const bodyHost = h('div', { class: 'aw-flex-col aw-gap-row-large' },
      hosts.note, hosts.grid, hosts.result, hosts.switcher, hosts.devices, presetBlock, snapshotsBlock);
    root = panel({ toolbar: toolbarHost, body: bodyHost });
  }
  let snapSave = null;

  function chip(label, on, onClick, title) {
    return h('button', { class: ['lpp-chip', on ? 'lpp-chip--on' : ''], type: 'button', title, onClick }, label);
  }

  function updateToolbar(st, devices) {
    const routed = devices.reduce((n, d) => n + (d.rx || []).filter((c) => c.sub).length, 0);
    const disc = st.data && st.data.discovery;
    const where = !st.data ? 'loading…'
      : disc && disc.error ? disc.error
        : disc && disc.running ? `asking ${disc.multicast === false ? 'configured devices only' : (disc.asking || []).join(', ') || 'the network'}`
          : 'discovery off';
    bar.summary.textContent = `${devices.length} device${devices.length === 1 ? '' : 's'} · ${routed} subscription${routed === 1 ? '' : 's'} · ${where}`;
    bar.routed.textContent = view.routedOnly ? 'Routed only' : 'All channels';
    bar.routed.className = ['lpp-chip', view.routedOnly ? 'lpp-chip--on' : ''].filter(Boolean).join(' ');
    bar.lock.textContent = view.locked ? 'Locked' : 'Unlocked';
    bar.lock.className = ['lpp-chip', view.locked ? '' : 'lpp-chip--on'].filter(Boolean).join(' ');
  }

  let child = null;
  function popOut() {
    if (child && !child.closed) { child.focus(); return; }
    child = window.open(POPOUT, 'lpp-dante', 'width=1400,height=900,menubar=no,toolbar=no,location=no');
    if (!child && model) model.note('warn', 'The browser blocked the window — allow pop-ups for this address.');
  }

  /* --------------------------------------------------------------- body */

  function noteLine(st) {
    const n = st.note;
    return h('div', {
      class: ['aw-font-caption', st.error || (n && n.tone === 'warn') ? 'lpp-dn-note--warn' : 'lpp-dn-note--ok'],
      text: st.error || (n ? n.text : view.locked
        ? 'Locked. Click a device to open it into channels; unlock to change subscriptions.'
        : 'Click a block to lay a transmitter across a receiver channel for channel; click a single cell to subscribe or clear it.')
    });
  }

  function gridSection(st, devices, matched, patches) {
    if (!st.data) return h('div', { class: 'wru-empty', text: st.error ? 'The Dante plugin is not answering.' : 'Reading the Dante network…' });
    if (!devices.length) {
      return h('div', { class: 'wru-empty' },
        h('div', { class: 'wru-empty-copy', text: 'No Dante device has been found yet. The network is asked every 30 seconds by default; one where multicast does not reach this machine needs its devices listed by address under Settings ▸ Dante.' }));
    }
    return [grid(devices, matched, patches), legend()];
  }

  function legend() {
    return h('div', { class: 'lpp-dn-legend aw-flex-row-center-v aw-gap-col-large aw-flex-wrap' },
      h('span', {}, h('b', { text: 'Block' }), ' — how many of the receiver’s channels take from that transmitter; solid when it is 1→1, 2→2 …'),
      h('span', { class: 'aw-flex-row-center-v aw-gap-col-mini' }, h('span', { class: 'lpp-dn-dot lpp-dn-dot--connected' }), 'connected'),
      h('span', { class: 'aw-flex-row-center-v aw-gap-col-mini' }, h('span', { class: 'lpp-dn-dot lpp-dn-dot--progress' }), 'in progress'),
      h('span', { class: 'aw-flex-row-center-v aw-gap-col-mini' }, h('span', { class: 'lpp-dn-dot lpp-dn-dot--error' }), 'unresolved or failed — hover for the device’s reason'));
  }

  const toggle = (set, id) => { if (set.has(id)) set.delete(id); else set.add(id); rerender(); };

  function send(routes, what) {
    if (view.locked) { if (model) model.note('warn', 'The grid is locked — unlock it to change subscriptions.'); return; }
    if (!routes.length || !model) return;
    model.apply(routes, what).catch(() => {});
  }

  function grid(devices, matched, patches) {
    const f = view.filter;
    const routedTo = new Set();
    for (const d of devices) for (const c of d.rx || []) { const s = subscriptionOf(d, c); if (s) routedTo.add(s.device.toLowerCase()); }
    const rxDevices = devices.filter((d) => (d.rx || []).length)
      .filter((d) => !view.routedOnly || d.rx.some((c) => c.sub))
      .filter((d) => matches(f, d.name, ...(d.rx.map((c) => c.label))));
    const txDevices = devices.filter((d) => (d.tx || []).length)
      .filter((d) => !view.routedOnly || routedTo.has(String(d.name).toLowerCase()))
      .filter((d) => matches(f, d.name, ...(d.tx.map((c) => c.label))) || rxDevices.some((r) => r.rx.some((c) => isFrom(r, c, d))));

    const cols = [];
    for (const d of txDevices) {
      if (view.openCols.has(d.name)) d.tx.forEach((c, i) => cols.push({ dev: d, ch: c, first: i === 0 }));
      else cols.push({ dev: d, ch: null, first: true });
    }
    const head1 = h('tr', {}, h('th', { class: 'lpp-dn-corner', rowspan: '2' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Receivers ↓  Transmitters →' })));
    const head2 = h('tr', {});
    for (const d of txDevices) {
      const open = view.openCols.has(d.name);
      const mine = matched.get(d.name);
      head1.append(h('th', {
        class: ['lpp-dn-gh', open ? 'lpp-dn-gh--open' : ''],
        colspan: open ? String(d.tx.length) : null,
        title: `${d.name} — ${d.tx.length} transmit channel${d.tx.length === 1 ? '' : 's'}. ${open ? 'Close' : 'Open into channels'}.`,
        onClick: () => toggle(view.openCols, d.name)
      }, h('span', { class: 'lpp-dn-row', style: { justifyContent: 'center' } },
        h('span', { class: 'lpp-dn-caret', text: open ? '▾' : '▸' }),
        h('span', { class: `lpp-dn-dot lpp-dn-dot--${d.status}` }), d.name,
        mine ? h('span', { class: 'lpp-dn-badge', text: 'this switcher' }) : null)));
      if (open) {
        const pt = mine ? patches.get(d.name) : null;
        d.tx.forEach((c, i) => head2.append(h('th', {
          class: ['lpp-dn-ch', i === 0 ? 'lpp-dn-ch--first' : ''],
          title: `${c.label}@${d.name} — transmit channel ${c.number}${c.factory && c.factory !== c.label ? ` (factory name ${c.factory})` : ''}`
            + (pt ? ` · Audio Matrix: Dante ${c.number} carries ${pt.tx.get(c.number) || 'nothing'}` : '')
        }, h('span', { text: c.label }))));
      } else head2.append(h('th', { class: 'lpp-dn-ch lpp-dn-ch--first' }));
    }

    const tbody = h('tbody', {});
    for (const d of rxDevices) {
      const open = view.openRows.has(d.name);
      tbody.append(row(d, null, open, cols, matched, patches));
      if (open) {
        for (const c of d.rx) {
          if (view.routedOnly && !c.sub) continue;
          tbody.append(row(d, c, true, cols, matched, patches));
        }
      }
    }
    return h('div', { class: 'lpp-dn-wrap' }, h('table', { class: 'lpp-dn' }, h('thead', {}, head1, head2), tbody));
  }

  const isFrom = (rxDev, ch, txDev) => {
    const s = subscriptionOf(rxDev, ch);
    return Boolean(s && s.device.toLowerCase() === String(txDev.name).toLowerCase());
  };

  function row(d, c, open, cols, matched, patches) {
    const tr = h('tr', { class: c ? '' : 'lpp-dn-tr--gt' });
    const mine = matched.get(d.name);
    if (c) {
      const sub = subscriptionOf(d, c);
      const pt = mine ? patches.get(d.name) : null;
      const feeds = pt ? pt.rx.get(c.number) : null;
      const card = mine && mine.card ? mine.card.rx.get(c.number) : null;
      tr.append(h('th', {
        class: 'lpp-dn-rh lpp-dn-rh--ch',
        title: `${c.label}@${d.name} — receive channel ${c.number}. ${c.status ? c.status.label : ''}`
          + (sub ? ` · from ${formatRef(sub)}` : '')
          + (pt ? ` · Audio Matrix: Dante ${c.number} feeds ${feeds && feeds.length ? feeds.join(', ') : 'nothing'}` : '')
          + (card && card.connectedTo ? ` · the switcher’s store says ${card.connectedTo}` : '')
      }, h('span', { class: 'lpp-dn-row' },
        h('span', { class: `lpp-dn-dot lpp-dn-dot--${sub && c.status ? c.status.state : 'none'}` }),
        h('span', { text: `${c.number} ${c.label}` }),
        sub ? h('span', { class: 'lpp-dn-sub', text: `← ${formatRef(sub)}` }) : null,
        pt && feeds && feeds.length ? h('span', { class: 'lpp-dn-sub', text: `→ ${feeds.join(', ')}` }) : null)));
    } else {
      const routed = d.rx.filter((x) => x.sub).length;
      tr.append(h('th', {
        class: ['lpp-dn-rh', 'lpp-dn-rh--group', open ? 'lpp-dn-rh--open' : ''],
        title: `${d.name} — ${d.rx.length} receive channels, ${routed} subscribed. ${d.writable ? '' : d.why || ''} ${open ? 'Close' : 'Open into channels'}.`,
        onClick: () => toggle(view.openRows, d.name)
      }, h('span', { class: 'lpp-dn-row' },
        h('span', { class: 'lpp-dn-caret', text: open ? '▾' : '▸' }),
        h('span', { class: `lpp-dn-dot lpp-dn-dot--${d.status}` }),
        h('span', { text: d.name }),
        mine ? h('span', { class: 'lpp-dn-badge', text: 'this switcher' }) : null,
        h('span', { class: 'lpp-dn-sub', text: `${routed}/${d.rx.length}` }))));
    }
    cols.forEach((col) => tr.append(cell(d, c, col)));
    return tr;
  }

  function cell(rxDev, rxCh, col) {
    const td = h('td', { class: ['lpp-dn-x', col.first ? 'lpp-dn-x--gl' : '', view.locked ? 'lpp-dn-x--locked' : ''] });
    const txDev = col.dev;
    if (!rxCh && !col.ch) {
      const { count, straight, span } = blockState(rxDev, txDev);
      td.className += ' lpp-dn-x--block' + (straight ? ' lpp-dn-x--full' : count ? ' lpp-dn-x--part' : '');
      td.textContent = count ? String(count) : '';
      td.setAttribute('title', `${rxDev.name} ← ${txDev.name}: ${count} channel${count === 1 ? '' : 's'}`
        + (straight ? ` (1→1 … ${span}→${span}). Click to clear.` : span ? `. Click to subscribe ${span} channel${span === 1 ? '' : 's'} 1→1.` : '.'));
      td.addEventListener('click', () => {
        const routes = blockRoutes(rxDev, txDev);
        if (!routes.length) return;
        send(routes, straight ? `Clear ${rxDev.name} from ${txDev.name}` : `${txDev.name} → ${rxDev.name}, channel for channel`);
      });
    } else if (rxCh && col.ch) {
      const on = isSubscribedTo(rxDev, rxCh, txDev, col.ch);
      /* Only the cell the click was about waits: the one asked for, or the lit one being cleared. */
      const asked = model && model.pendingFor ? model.pendingFor(rxDev.name, rxCh.number) : undefined;
      const waiting = asked !== undefined && (asked ? asked.device.toLowerCase() === String(txDev.name).toLowerCase() && asked.channel === col.ch.label
        : isSubscribedTo(rxDev, rxCh, txDev, col.ch));
      const state = on ? (rxCh.status && rxCh.status.state === 'connected' ? 'connected' : rxCh.status ? rxCh.status.state : 'none') : null;
      td.className += (on ? ` lpp-dn-x--${state}` : '') + (waiting ? ' lpp-dn-x--pending' : '');
      td.setAttribute('title', `${col.ch.label}@${txDev.name} → ${rxCh.label}@${rxDev.name}`
        + (on ? ` — subscribed. ${rxCh.status ? rxCh.status.label : ''} Click to clear.` : rxCh.sub ? ` — now takes ${formatRef(subscriptionOf(rxDev, rxCh))}. Click to replace.` : ' — click to subscribe.'));
      td.addEventListener('click', () => {
        const route = cellRoute(rxDev, rxCh, txDev, col.ch);
        send([route], route.tx ? `${col.ch.label}@${txDev.name} → ${rxCh.label}@${rxDev.name}` : `Clear ${rxCh.label}@${rxDev.name}`);
      });
    } else if (rxCh) {
      const from = isFrom(rxDev, rxCh, txDev);
      const sub = subscriptionOf(rxDev, rxCh);
      td.className += ' lpp-dn-x--mixed';
      td.textContent = from ? (txDev.tx.find((t) => t.label === sub.channel) || { number: '•' }).number : '';
      td.setAttribute('title', from ? `${rxCh.label} takes ${formatRef(sub)}. Click to open ${txDev.name}.` : `Click to open ${txDev.name} into channels.`);
      td.addEventListener('click', () => toggle(view.openCols, txDev.name));
    } else {
      const n = rxDev.rx.filter((c) => isSubscribedTo(rxDev, c, txDev, col.ch)).length;
      td.className += ' lpp-dn-x--mixed';
      td.textContent = n ? '•'.repeat(Math.min(n, 3)) : '';
      td.setAttribute('title', `${col.ch.label}@${txDev.name} feeds ${n} of ${rxDev.name}’s channels. Click to open ${rxDev.name}.`);
      td.addEventListener('click', () => toggle(view.openRows, rxDev.name));
    }
    return td;
  }

  /* ------------------------------------------------------- results list */

  function resultList(result) {
    const rows = (result.results || []).filter((r) => r.outcome !== 'same');
    if (!rows.length) return null;
    const bad = rows.filter((r) => ['unconfirmed', 'refused', 'missing'].includes(r.outcome));
    return h('details', { open: bad.length ? 'open' : null },
      h('summary', { class: 'aw-font-caption aw-text-tertiary', text: `Last change: ${result.summary}` }),
      h('table', { class: 'lpp-dn-list' },
        h('thead', {}, h('tr', {}, ['Receiver', 'Asked for', 'The device says', 'Outcome'].map((t) => h('th', { text: t })))),
        h('tbody', {}, rows.slice(0, 200).map((r) => h('tr', {},
          h('td', { text: `${r.rx.label || r.rx.channel}@${r.rx.device}` }),
          h('td', { text: formatRef(r.tx) }),
          h('td', { text: 'now' in r ? `${formatRef(r.now)}${r.status ? ` — ${r.status.label}` : ''}` : '—' }),
          h('td', { class: bad.includes(r) ? 'wru-warn' : '', text: r.error ? `${r.outcome}: ${r.error}` : r.outcome }))))));
  }

  /* ---------------------------------------------------------- switcher */

  function switcherSection(cards, matched, devices) {
    if (!cards.length) {
      return h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'This switcher’s store reports no Dante card.' });
    }
    const lines = cards.map((card) => {
      const hit = [...matched].find(([, m]) => m.card === card);
      const ident = card.name ? `“${card.name}”` : 'with no name in the store';
      return h('div', { class: 'aw-font-caption aw-text-tertiary', text:
        `Frame ${card.frame}’s Dante card ${ident} (${card.type || 'type unknown'}${card.addresses.length ? `, ${card.addresses.join(' / ')}` : ''}) — `
        + (hit ? `found on the network as ${hit[0]}, matched by ${hit[1].by}. Its channels show what the Audio Matrix does with them.`
          : devices.length ? 'not found among the Dante devices read. If its Dante name differs from the store’s, choose it under Settings ▸ Dante.'
            : 'not found yet.') });
    });
    return h('div', { class: 'aw-flex-col aw-gap-row-mini' }, h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'This switcher' }), lines);
  }

  /* ------------------------------------------------------- device list */

  function deviceList(devices, matched) {
    if (!devices.length) return null;
    return h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Devices' }),
      h('table', { class: 'lpp-dn-list' },
        h('thead', {}, h('tr', {}, ['Device', 'Model', 'Address', 'ARC', 'Sample rate', 'Latency', 'Tx / Rx', 'Status'].map((t) => h('th', { text: t })))),
        h('tbody', {}, devices.map((d) => h('tr', {},
          h('td', {}, h('span', { class: 'lpp-dn-row' }, h('span', { class: `lpp-dn-dot lpp-dn-dot--${d.status}` }), d.name,
            matched.get(d.name) ? h('span', { class: 'lpp-dn-badge', text: 'this switcher' }) : null)),
          h('td', { text: [d.manufacturer, d.model].filter(Boolean).join(' ') || '—' }),
          h('td', { text: `${d.address}:${d.port}${d.source === 'manual' ? ' (configured)' : ''}` }),
          h('td', { text: `${d.arcp || d.protocol || '?'}${d.inventory ? ` · ${d.inventory}` : ''}` }),
          h('td', { text: formatRate(d.sampleRate) }),
          h('td', { text: formatLatency(d.latencyNs) }),
          h('td', { text: `${d.txCount ?? '?'} / ${d.rxCount ?? '?'}` }),
          h('td', { class: d.status === 'ok' && d.writable ? '' : 'wru-warn', text: d.status === 'ok' ? (d.writable ? `read ${ago(d.lastRead)}` : d.why) : d.error || d.status }))))));
  }

  const ago = (t) => {
    if (!t) return '—';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 2 ? 'just now' : `${s} s ago`;
  };

  /* ------------------------------------------------------------ presets */

  function presetSection(devices) {
    const p = view.preset;
    const readable = devices.filter((d) => d.status === 'ok');
    const exportLink = model && readable.length
      ? h('a', { class: 'wru-button aw-font-button aw-border-radius aw-flex-row-center wru-button--default', href: model.exportUrl([], ''), download: 'dante-routing.xml', title: 'A Dante Controller preset of every device read: names, labels, subscriptions, sample rate and latency' }, h('span', { text: 'Export preset' }))
      : null;
    const parts = [
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        exportLink,
        button('Import preset…', { title: 'Read a preset Dante Controller saved and show what applying its subscriptions would change', onClick: () => fileInput.click() }),
        h('span', { class: 'aw-font-caption aw-text-tertiary', text: 'Load the export in Dante Controller with File ▸ Load Preset. An imported preset is shown as a difference first; nothing is sent until you apply it.' }))
    ];
    if (p) parts.push(presetDiff(p, devices));
    return parts;
  }

  async function onFile(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file || !model) return;
    view.preset = { fileName: file.name, xml: null, diff: null, assign: {}, busy: true, error: null, v: Date.now() };
    rerender();
    try {
      view.preset.xml = await file.text();
      await diffPreset();
    } catch (err) {
      view.preset.error = err.message;
      view.preset.busy = false;
      view.preset.v = Date.now();
      rerender();
    }
  }

  async function diffPreset() {
    const p = view.preset;
    p.busy = true; p.error = null; p.v = Date.now(); rerender();
    try { p.diff = await model.presetDiff(p.xml, p.assign); } catch (err) { p.error = err.message; p.diff = null; }
    p.busy = false; p.v = Date.now(); rerender();
  }

  function presetDiff(p, devices) {
    if (p.busy) return h('div', { class: 'aw-font-caption aw-text-tertiary', text: `Reading ${p.fileName}…` });
    if (p.error) return h('div', { class: 'aw-font-caption wru-warn', text: `${p.fileName}: ${p.error}` });
    const d = p.diff;
    if (!d) return null;
    const changes = d.results.filter((r) => r.outcome === 'change');
    const problems = d.results.filter((r) => r.outcome === 'refused' || r.outcome === 'missing');
    const same = d.results.filter((r) => r.outcome === 'same').length;
    const roleRows = d.assignments.map((a) => h('tr', {},
      h('td', { text: a.role }),
      h('td', {}, h('select', {
        class: 'wru-select', 'data-lpp-key': `dante-role-${a.role}`,
        onChange: (ev) => { p.assign = { ...p.assign, [a.role]: ev.target.value }; void diffPreset(); }
      }, [h('option', { value: '', selected: a.device ? null : 'selected', text: '— not applied —' }),
        ...devices.map((dev) => h('option', { value: dev.name, selected: a.device === dev.name ? 'selected' : null, text: dev.name }))])),
      h('td', { class: 'aw-text-tertiary', text: a.device ? `by ${a.by}` : a.by })));
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-body-1', text: `${d.preset.name || p.fileName} — ${d.preset.roles.length} role${d.preset.roles.length === 1 ? '' : 's'}, preset version ${d.preset.version || '?'}` }),
      h('table', { class: 'lpp-dn-list' }, h('thead', {}, h('tr', {}, ['Role in the preset', 'Applies to', ''].map((t) => h('th', { text: t })))), h('tbody', {}, roleRows)),
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: `${changes.length} subscription${changes.length === 1 ? '' : 's'} would change, ${same} already match${problems.length ? `, ${problems.length} cannot be applied` : ''}. As Dante Controller does, a receive channel the preset leaves empty — or does not list — is cleared.` }),
      changes.length || problems.length ? h('div', { class: 'lpp-dn-changes' }, h('table', { class: 'lpp-dn-list' },
        h('thead', {}, h('tr', {}, ['Receiver', 'Now', 'After', ''].map((t) => h('th', { text: t })))),
        h('tbody', {}, [...changes, ...problems].slice(0, 500).map((r) => h('tr', {},
          h('td', { text: `${r.rx.label || r.rx.channel}@${r.rx.device}` }),
          h('td', { class: r.outcome === 'change' ? 'lpp-dn-strike' : '', text: formatRef(r.from) }),
          h('td', { text: formatRef(r.tx) }),
          h('td', { class: r.outcome === 'change' ? 'aw-text-tertiary' : 'wru-warn', text: r.outcome === 'change' ? (r.implied ? 'not in the preset — cleared' : '') : `${r.outcome}: ${r.error}` })))))) : null,
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        button(`Apply ${changes.length} change${changes.length === 1 ? '' : 's'}`, {
          variant: 'primary', disabled: !changes.length,
          onClick: async () => {
            p.busy = true; p.v = Date.now(); rerender();
            try { await model.presetApply(p.xml, p.assign, d.digest); view.preset = null; } catch (err) { p.error = err.message; p.busy = false; }
            if (view.preset) view.preset.v = Date.now();
            rerender();
          }
        }),
        button('Discard', { onClick: () => { view.preset = null; rerender(); } })));
  }

  /* ---------------------------------------------------------- snapshots */

  function snapshotList(snapshots) {
    if (!snapshots.length) return null;
    return h('table', { class: 'lpp-dn-list' }, h('tbody', {}, snapshots.map((s) => h('tr', {},
      h('td', { text: s.name }),
      h('td', { class: 'aw-text-tertiary', text: `${s.devices.length} device${s.devices.length === 1 ? '' : 's'}, ${s.routes} subscription${s.routes === 1 ? '' : 's'}` }),
      h('td', { class: 'aw-text-tertiary', text: s.savedAt ? formatLocal(s.savedAt) : '' }),
      h('td', {}, h('span', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        button('Recall', { title: 'Apply only what differs; the result is listed above', onClick: () => recall(s.name) }),
        button('Delete', { onClick: () => { if (confirmAsk(`Delete the snapshot “${s.name}”?`)) model.deleteSnapshot(s.name); } })))))));
  }

  async function recall(name) {
    if (!model) return;
    let preview = null;
    try { preview = await model.recallPlan(name); } catch (err) { model.note('warn', `Could not read “${name}”: ${err.message}`); return; }
    const n = (preview.results || []).filter((r) => r.outcome === 'change').length;
    if (!n) { model.note('ok', `“${name}” — ${preview.summary}`); return; }
    if (!confirmAsk(`Recall “${name}”? ${n} subscription${n === 1 ? '' : 's'} on the Dante network will change.`)) return;
    model.recall(name).catch(() => {});
  }

  function confirmAsk(text) {
    const w = doc.defaultView || globalThis;
    return typeof w.confirm === 'function' ? w.confirm(text) : true;
  }

  return { render, view };
}
