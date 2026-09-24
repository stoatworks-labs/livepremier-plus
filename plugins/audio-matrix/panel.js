/*
 * Audio Matrix — the panel: the frame's audio channel matrix as a crosspoint
 * grid. Sources down the side, destinations across the top, one lit point per
 * destination channel.
 *
 * ## Blocks first, channels on demand
 *
 * The whole matrix is 576 source channels by 272 destination channels — far
 * past what anyone can read, or a page can repaint once a second. So it opens
 * as blocks: one row per input (and per Dante block of eight), one column per
 * output, Dante block and multiviewer. A block cell says how many of that
 * destination's channels come from that source; clicking it lays the source
 * across the destination channel for channel (1→1 … 8→8), or clears it when
 * that is exactly what is there — the Console's `Set Audio Patch Input 3
 * Channel 1 Thru 8 To Output 1`, as a click. A group's header opens it into
 * its eight channels, and where an open row meets an open column the cells
 * are single crosspoints. A cell with one side open and one shut opens the
 * shut side rather than guessing which channel was meant.
 *
 * ## What it shows is the switcher's word, not ours
 *
 * Matrix Routing's rule holds here too: nothing is drawn as patched until the
 * store says so. A click sends the write and marks the cell pending; the echo
 * lights it. A write the switcher has not echoed after a few seconds is named
 * in the note line rather than quietly forgotten — a page that showed what it
 * asked for would lie in exactly the minute that matters.
 *
 * ## Redrawn in place
 *
 * `render()` hands back the same element every time (PLUGINS.md, "A panel may
 * redraw in place"): the table is rebuilt only when its shape changes — a
 * group opened, a frame picked, the filter flipped — and otherwise each cell
 * recolours itself. That keeps the scroll position and the hover still under
 * an operator's pointer while the store ticks.
 */

import { h, button, fill } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import {
  frames, clock, readMatrix, blockState, fedBy, takesFrom,
  crosspointWrites, blockWrites, destMute, sourceMute,
  describeSource, describeDest, txPath, NONE
} from './model.js';
import { key as pathKey } from '../../src/core/paths.js';

const POPOUT = new URL('./popout.html', import.meta.url).href;
const STYLE_ID = 'lpp-audio-matrix-style';
/** How long a write may go unechoed before the note line says so. */
const ECHO_MS = 3000;

const CSS = `
.lpp-am-wrap { overflow: auto; max-height: 100%; border: 0.083333rem solid #283239; border-radius: 0.25rem; }
.lpp-am { border-collapse: separate; border-spacing: 0; font-size: 0.833333rem; font-variant-numeric: tabular-nums; }
.lpp-am th, .lpp-am td { padding: 0; text-align: center; white-space: nowrap; }
.lpp-am thead th { position: sticky; background: #0D1D26; z-index: 2; color: rgba(255,255,255,0.7); font-weight: 400; }
.lpp-am thead tr:first-child th { top: 0; height: 1.75rem; }
.lpp-am thead tr:nth-child(2) th { top: 1.75rem; height: 1.5rem; border-bottom: 0.083333rem solid #283239; }
.lpp-am tbody th { position: sticky; left: 0; background: #0D1D26; z-index: 1; text-align: left; color: rgba(255,255,255,0.7); font-weight: 400; }
.lpp-am thead th.lpp-am-corner { left: 0; z-index: 3; text-align: left; padding: 0 0.5rem; }
.lpp-am-gh { cursor: pointer; padding: 0 0.416667rem !important; border-left: 0.083333rem solid #283239; }
.lpp-am-gh:hover { color: #fff; }
.lpp-am-gh--open { color: #fff; background: #13293A !important; }
.lpp-am-gh .lpp-am-name { display: block; font-size: 0.75rem; color: #838B91; max-width: 6rem; overflow: hidden; text-overflow: ellipsis; }
.lpp-am-ch { min-width: 1.75rem; font-size: 0.75rem; }
.lpp-am-ch--first { border-left: 0.083333rem solid #283239; }
.lpp-am-rh { padding: 0 0.5rem !important; min-width: 9rem; height: 1.75rem; }
.lpp-am-rh--group { cursor: pointer; }
.lpp-am-rh--group:hover { color: #fff; }
.lpp-am-rh--open { color: #fff; background: #13293A !important; }
.lpp-am-rh--ch { padding-left: 1.5rem !important; font-size: 0.75rem; }
.lpp-am-row { display: flex; align-items: center; gap: 0.333333rem; }
.lpp-am-rh .lpp-am-name { color: #838B91; font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; max-width: 7rem; }
.lpp-am-caret { display: inline-block; width: 0.75rem; color: #838B91; }
.lpp-am-sig { display: inline-block; width: 0.416667rem; height: 0.416667rem; border-radius: 50%; background: #283239; flex: none; }
.lpp-am-sig--on { background: #00FF7F; }
.lpp-am-mute {
  appearance: none; border: 0.083333rem solid #49535B; background: transparent; color: #838B91;
  font: inherit; font-size: 0.666667rem; line-height: 1; padding: 0.083333rem 0.25rem; border-radius: 0.166667rem; cursor: pointer;
}
.lpp-am-mute:hover { color: #fff; }
.lpp-am-mute--on { background: #F64747; border-color: #F64747; color: #fff; }
.lpp-am-x {
  width: 1.75rem; height: 1.75rem; cursor: pointer; position: relative;
  border-left: 0.083333rem solid rgba(40,50,57,0.5); border-bottom: 0.083333rem solid rgba(40,50,57,0.5);
}
.lpp-am-x--gl { border-left-color: #283239; }
.lpp-am tbody tr.lpp-am-tr--gt td, .lpp-am tbody tr.lpp-am-tr--gt th { border-top: 0.083333rem solid #283239; }
.lpp-am-x:hover, .lpp-am-x.lpp-am-hot { background: rgba(255,255,255,0.06); }
.lpp-am tbody tr:hover th { color: #fff; }
.lpp-am-x::after {
  content: ''; position: absolute; left: 50%; top: 50%; width: 0.583333rem; height: 0.583333rem;
  margin: -0.291667rem 0 0 -0.291667rem; border-radius: 50%;
}
.lpp-am-x--on::after { background: #2185D0; }
.lpp-am-x--on.lpp-am-x--muted::after { background: #F64747; }
.lpp-am-x--pending::after { background: transparent; border: 0.083333rem dashed #2185D0; }
.lpp-am-x--block { font-size: 0.75rem; color: #838B91; }
.lpp-am-x--block::after { display: none; }
.lpp-am-x--part { color: #2185D0; background: rgba(33,133,208,0.10); }
.lpp-am-x--full { color: #fff; background: #2185D0; }
.lpp-am-x--full:hover { background: #3399E6; }
.lpp-am-x--block.lpp-am-x--pending { outline: 0.083333rem dashed #2185D0; outline-offset: -0.166667rem; }
.lpp-am-x--mixed { font-size: 0.75rem; color: #2185D0; }
.lpp-am-x--mixed::after { display: none; }
.lpp-am-x--locked { cursor: default; }
.lpp-am-legend { color: #838B91; font-size: 0.833333rem; }
.lpp-am-legend b { color: rgba(255,255,255,0.85); font-weight: 400; }
.lpp-am-note--warn { color: #F39910; }
.lpp-am-note--ok { color: #838B91; }
`;

/**
 * @param {object} o
 * @param {object} o.session                 the live store mirror + `send`
 * @param {Function} [o.onRefresh]
 * @param {boolean} [o.popoutEnabled]
 * @param {Document} [o.doc]
 */
export function createAudioMatrixPanel({ session, onRefresh = () => {}, popoutEnabled = true, doc = document } = {}) {
  const view = {
    frame: null,
    fittedOnly: true,
    locked: false,
    openRows: new Set(),
    openCols: new Set(),
    note: null            // { tone, text }
  };
  /** Writes sent and not yet echoed: path key → { value, at, what }. */
  const pending = new Map();

  let root = null;        // the element render() always returns
  let shapeKey = '';      // the table's shape, last time it was built
  let cells = [];         // () => void, one per live cell, to recolour in place
  let bodyHost = null;
  let toolbarHost = null;
  let noteHost = null;
  let hot = null;         // the column currently under the pointer

  function styles() {
    try {
      if (!doc.head || (doc.getElementById && doc.getElementById(STYLE_ID))) return;
      const el = doc.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      doc.head.append(el);
    } catch { /* a document without a head draws unstyled rather than not at all */ }
  }

  /* ------------------------------------------------------------- writing */

  function send(writes, what) {
    if (!writes.length) return;
    if (view.locked) {
      setNote('warn', 'The matrix is locked — unlock it to patch.');
      return;
    }
    let sent = 0;
    const at = Date.now();
    for (const w of writes) {
      if (session.send({ path: w.path, value: w.value })) {
        sent += 1;
        pending.set(pathKey(w.path), { path: w.path, value: w.value, at, what });
      }
    }
    setNote(sent === writes.length ? 'ok' : 'warn',
      sent === writes.length
        ? `${what} — ${sent} write${sent === 1 ? '' : 's'} sent`
        : `${what} — only ${sent} of ${writes.length} writes left this page; is the switcher connected?`);
    setTimeout(() => onRefresh(), ECHO_MS + 50);
    onRefresh();
  }

  /** Drop what the store has confirmed; name what it has not. */
  function settle() {
    const store = session.store;
    const late = [];
    for (const [k, p] of pending) {
      if (store.get(p.path) === p.value) pending.delete(k);
      else if (Date.now() - p.at > ECHO_MS) { late.push(p); pending.delete(k); }
    }
    if (late.length) {
      setNote('warn', `The switcher did not confirm ${late.length === 1 ? 'a write' : `${late.length} writes`}`
        + ` (${late[0].what}). The grid shows what it reports.`);
    }
  }

  const isPending = (path) => pending.has(pathKey(path));

  function setNote(tone, text) { view.note = { tone, text }; }

  /* ---------------------------------------------------------------- shape */

  function pickFrame(list) {
    if (!view.frame || !list.includes(view.frame)) view.frame = list[0];
    return view.frame;
  }

  function layoutKey(m) {
    return [
      m.frame, view.fittedOnly, view.locked,
      m.sources.map((g) => `${g.id}:${g.name}:${g.channels.length}`).join(','),
      m.destinations.map((g) => `${g.id}:${g.name}:${g.channels.length}`).join(','),
      [...view.openRows].sort().join(','), [...view.openCols].sort().join(',')
    ].join('|');
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    styles();
    const store = session.store;
    if (!root) {
      toolbarHost = h('div', { class: 'aw-flex-col aw-gap-row-small' });
      bodyHost = h('div', { class: 'aw-flex-col aw-gap-row-medium', style: { height: '100%' } });
      root = panel({ toolbar: toolbarHost, body: bodyHost });
    }

    if (!store || !store.ready) return waiting('Waiting for the device store…');
    const list = frames(store);
    if (!list.length) return waiting('This switcher reports no audio channel matrix.');
    const frame = pickFrame(list);
    const m = readMatrix(store, frame, { fittedOnly: view.fittedOnly });
    if (!m) return waiting(`Frame ${frame} has no audio matrix in the store.`);

    settle();
    fill(toolbarHost, toolbar(list, m));

    const next = layoutKey(m);
    if (next !== shapeKey || !noteHost) {
      shapeKey = next;
      cells = [];
      noteHost = h('div', { class: 'aw-font-caption' });
      fill(bodyHost,
        noteHost,
        h('div', { class: 'lpp-am-wrap', onMouseleave: () => setHot(null) }, table(m)),
        legend());
    }
    for (const paint of cells) paint(m);
    paintNote();
    return root;
  }

  function waiting(text) {
    shapeKey = '';
    noteHost = null;
    fill(toolbarHost, h('div', { class: 'aw-font-subtitle-1', text: 'Audio Matrix' }));
    fill(bodyHost, h('div', { class: 'wru-empty', text }));
    return root;
  }

  function paintNote() {
    if (!noteHost) return;
    const n = view.note;
    noteHost.className = 'aw-font-caption ' + (n ? `lpp-am-note--${n.tone}` : 'lpp-am-note--ok');
    noteHost.textContent = n ? n.text
      : 'Click a block to patch a source across a destination channel for channel; click a header to open it into channels.';
  }

  /* --------------------------------------------------------------- toolbar */

  function chip(label, on, onClick, title) {
    return h('button', { class: ['lpp-chip', on ? 'lpp-chip--on' : ''], type: 'button', title, onClick }, label);
  }

  function toolbar(list, m) {
    const c = clock(session.store);
    const patched = m.destinations.reduce((n, d) => n + d.channels.filter((ch) => ch.source !== NONE).length, 0);
    return h('div', { class: 'aw-flex-row-center-v-space-between aw-flex-wrap lpp-controls aw-gap-col-large' },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-large aw-flex-wrap' },
        h('div', { class: 'aw-font-subtitle-1', text: 'Audio Matrix' }),
        list.length > 1
          ? h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
            h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'Frame' }),
            h('select', {
              class: 'wru-select',
              onChange: (ev) => { view.frame = ev.target.value; onRefresh(); }
            }, list.map((f) => h('option', { value: f, selected: f === m.frame ? 'selected' : null }, f))))
          : null,
        h('span', { class: 'aw-font-caption aw-text-tertiary' },
          `${patched} channel${patched === 1 ? '' : 's'} patched`,
          c && c.sampleRate ? ` · ${c.sampleRate.replace(/K$/, ' kHz')}` : '',
          c && c.clockMode ? ` · ${c.clockMode.toLowerCase()} clock` : '')),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        chip(view.fittedOnly ? 'Fitted only' : 'All 64 inputs', view.fittedOnly, () => {
          view.fittedOnly = !view.fittedOnly; onRefresh();
        }, hiddenTitle(m)),
        chip('Collapse all', false, () => { view.openRows.clear(); view.openCols.clear(); onRefresh(); },
          'Close every open source and destination'),
        chip(view.locked ? 'Locked' : 'Lock', view.locked, () => {
          view.locked = !view.locked;
          setNote('ok', view.locked ? 'Locked: clicks open and close groups, and patch nothing.' : 'Unlocked.');
          onRefresh();
        }, 'Stop clicks from patching — for a matrix that is live on a show'),
        popoutEnabled
          ? button('Pop out', {
            iconId: 'set-layer-to-fullscreen-18',
            title: 'Open the audio matrix in its own window',
            onClick: popOut
          })
          : null));
  }

  function hiddenTitle(m) {
    const { sources, destinations } = m.hidden;
    if (!view.fittedOnly) return 'Showing every input and output the matrix addresses; click to show only what is fitted';
    if (!sources && !destinations) return 'Only connectors fitted on this frame (anything patched is always shown)';
    return `Hiding ${sources} unfitted input${sources === 1 ? '' : 's'} and ${destinations} unfitted output${destinations === 1 ? '' : 's'}`
      + ' — anything patched is always shown. Click to show all.';
  }

  let child = null;
  function popOut() {
    if (child && !child.closed) { child.focus(); return; }
    child = window.open(POPOUT, 'lpp-audio-matrix', 'width=1400,height=900,menubar=no,toolbar=no,location=no');
    if (!child) { setNote('warn', 'The browser blocked the window — allow pop-ups for this address.'); onRefresh(); }
  }

  function legend() {
    return h('div', { class: 'lpp-am-legend aw-flex-row-center-v aw-gap-col-large aw-flex-wrap' },
      h('span', {}, h('b', { text: 'Block' }), ' — how many of the destination’s 8 channels come from that source; solid when it is 1→1 … 8→8.'),
      h('span', {}, h('b', { text: 'M' }), ' — mute; a source mute silences it everywhere.'),
      h('span', { class: 'aw-flex-row-center-v aw-gap-col-mini' }, h('span', { class: 'lpp-am-sig lpp-am-sig--on' }), 'signal present'));
  }

  /* ----------------------------------------------------------------- table */

  function setHot(col) {
    if (hot === col) return;
    for (const td of hotCells.get(hot) || []) td.classList.remove('lpp-am-hot');
    hot = col;
    for (const td of hotCells.get(hot) || []) td.classList.add('lpp-am-hot');
  }
  let hotCells = new Map();

  function table(m) {
    hotCells = new Map();
    const frame = m.frame;

    /* Columns: a group shut is one column; open, eight. */
    const cols = [];
    for (const d of m.destinations) {
      if (view.openCols.has(d.id)) d.channels.forEach((c, i) => cols.push({ dst: d, ch: c.ch, first: i === 0 }));
      else cols.push({ dst: d, ch: null, first: true });
    }

    const head1 = h('tr', {}, h('th', { class: 'lpp-am-corner', rowspan: '2' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Sources ↓  Destinations →' })));
    const head2 = h('tr', {});
    for (const d of m.destinations) {
      const open = view.openCols.has(d.id);
      const sig = h('span', { class: 'lpp-am-sig' });
      const th = h('th', {
        class: ['lpp-am-gh', open ? 'lpp-am-gh--open' : ''],
        colspan: open ? String(d.channels.length) : null,
        title: open ? `Close ${d.label}` : `Open ${d.label} into its channels`,
        onClick: () => { toggle(view.openCols, d.id); onRefresh(); }
      }, h('span', { class: 'lpp-am-row', style: { justifyContent: 'center' } },
        h('span', { class: 'lpp-am-caret', text: open ? '▾' : '▸' }), d.label, sig),
      d.name ? h('span', { class: 'lpp-am-name', text: d.name }) : null);
      cells.push((mm) => {
        const now = findDest(mm, d.id);
        sig.className = 'lpp-am-sig' + (now && now.channels.some((c) => c.signal) ? ' lpp-am-sig--on' : '');
      });
      head1.append(th);
      if (open) {
        d.channels.forEach((c, i) => head2.append(destChannelHeader(frame, d, c, i === 0)));
      } else {
        head2.append(h('th', { class: 'lpp-am-ch lpp-am-ch--first' }));
      }
    }

    const body = h('tbody', {});
    for (const s of m.sources) {
      const open = view.openRows.has(s.id);
      body.append(sourceRow(frame, s, null, open, cols));
      if (open) for (const c of s.channels) body.append(sourceRow(frame, s, c, true, cols));
    }
    return h('table', { class: 'lpp-am' }, h('thead', {}, head1, head2), body);
  }

  function destChannelHeader(frame, d, c, first) {
    const sig = h('span', { class: 'lpp-am-sig' });
    const mute = h('button', {
      class: 'lpp-am-mute', type: 'button', text: 'M',
      onClick: (ev) => {
        ev.stopPropagation && ev.stopPropagation();
        const now = findDest(readNow(), d.id);
        const ch = now && now.channels.find((x) => x.ch === c.ch);
        if (ch) send([destMute(frame, d.id, c.ch, !ch.mute)], `${ch.mute ? 'Unmute' : 'Mute'} ${describeDest(d.id, c.ch)}`);
      }
    });
    cells.push((mm) => {
      const now = findDest(mm, d.id);
      const ch = now && now.channels.find((x) => x.ch === c.ch);
      mute.className = 'lpp-am-mute' + (ch && ch.mute ? ' lpp-am-mute--on' : '');
      mute.setAttribute('title', ch ? `${describeDest(d.id, c.ch)} — ${ch.mute ? 'muted; click to unmute' : 'click to mute'}` +
        ` · takes ${describeSource(ch.source)}${ch.sine ? ' (sine test tone on)' : ''}` : '');
      sig.className = 'lpp-am-sig' + (ch && ch.signal ? ' lpp-am-sig--on' : '');
    });
    return h('th', { class: ['lpp-am-ch', first ? 'lpp-am-ch--first' : ''] },
      h('div', { class: 'aw-flex-col', style: { alignItems: 'center', gap: '0.083333rem' } },
        h('span', { class: 'lpp-am-row' }, c.label, sig), mute));
  }

  function sourceRow(frame, s, c, open, cols) {
    const tr = h('tr', { class: c ? '' : 'lpp-am-tr--gt' });
    if (c) {
      const sig = h('span', { class: 'lpp-am-sig' });
      const mute = h('button', {
        class: 'lpp-am-mute', type: 'button', text: 'M',
        onClick: () => {
          const now = findSourceChannel(readNow(), s.id, c.ch);
          if (now) send([sourceMute(frame, now.key, !now.mute)], `${now.mute ? 'Unmute' : 'Mute'} ${describeSource(now.key)} everywhere`);
        }
      });
      cells.push((mm) => {
        const now = findSourceChannel(mm, s.id, c.ch);
        mute.className = 'lpp-am-mute' + (now && now.mute ? ' lpp-am-mute--on' : '');
        mute.setAttribute('title', now && now.mute ? 'Muted into every destination; click to unmute' : 'Mute this source into every destination');
        sig.className = 'lpp-am-sig' + (now && now.signal ? ' lpp-am-sig--on' : '');
      });
      tr.append(h('th', { class: 'lpp-am-rh lpp-am-rh--ch' },
        h('span', { class: 'lpp-am-row' }, sig, h('span', { style: { flex: '1' }, text: s.kind === 'dante' ? `Dante ${c.label}` : `ch ${c.label}` }), mute)));
    } else {
      const sig = h('span', { class: 'lpp-am-sig' });
      cells.push((mm) => {
        const now = findSource(mm, s.id);
        sig.className = 'lpp-am-sig' + (now && now.channels.some((x) => x.signal) ? ' lpp-am-sig--on' : '');
      });
      tr.append(h('th', {
        class: ['lpp-am-rh', 'lpp-am-rh--group', open ? 'lpp-am-rh--open' : ''],
        title: open ? `Close ${s.label}` : `Open ${s.label} into its channels`,
        onClick: () => { toggle(view.openRows, s.id); onRefresh(); }
      }, h('span', { class: 'lpp-am-row' },
        h('span', { class: 'lpp-am-caret', text: open ? '▾' : '▸' }), sig,
        h('span', { text: s.label }),
        s.name ? h('span', { class: 'lpp-am-name', text: s.name }) : null)));
    }
    cols.forEach((col, i) => tr.append(cell(frame, s, c, col, i)));
    return tr;
  }

  function cell(frame, s, sc, col, i) {
    const td = h('td', {
      class: 'lpp-am-x',
      onMouseenter: () => setHot(i)
    });
    (hotCells.get(i) || hotCells.set(i, []).get(i)).push(td);
    const d = col.dst;
    const base = ['lpp-am-x', col.first ? 'lpp-am-x--gl' : '', view.locked ? 'lpp-am-x--locked' : ''];

    if (!sc && col.ch == null) {
      /* A block: source group × destination group. */
      td.addEventListener('click', () => {
        const mm = readNow();
        const src = findSource(mm, s.id);
        const dst = findDest(mm, d.id);
        if (!src || !dst) return;
        const { straight } = blockState(src, dst);
        send(blockWrites(frame, src, dst), straight ? `Clear ${d.label}` : `${s.label} → ${d.label}, channel for channel`);
      });
      cells.push((mm) => {
        const src = findSource(mm, s.id);
        const dst = findDest(mm, d.id);
        if (!src || !dst) return;
        const { count, straight } = blockState(src, dst);
        const wait = dst.channels.some((c) => isPending(txPathOf(frame, d.id, c.ch)));
        td.className = [...base, 'lpp-am-x--block',
          straight ? 'lpp-am-x--full' : count ? 'lpp-am-x--part' : '',
          wait ? 'lpp-am-x--pending' : ''].filter(Boolean).join(' ');
        td.textContent = count ? String(count) : '';
        td.setAttribute('title', `${s.label} → ${d.label}: ${count ? `${count} of ${dst.channels.length} channels` : 'nothing'}`
          + (straight ? ' (1→1 … 8→8). Click to clear.' : '. Click to patch channel for channel.'));
      });
    } else if (sc && col.ch != null) {
      /* A crosspoint: one source channel × one destination channel. */
      td.addEventListener('click', () => {
        const mm = readNow();
        const src = findSourceChannel(mm, s.id, sc.ch);
        const dst = findDest(mm, d.id);
        const dc = dst && dst.channels.find((x) => x.ch === col.ch);
        if (!src || !dc) return;
        const on = dc.source === src.key;
        send(crosspointWrites(frame, dst, dc, src),
          on ? `${describeDest(d.id, col.ch)} → None` : `${describeSource(src.key)} → ${describeDest(d.id, col.ch)}`);
      });
      cells.push((mm) => {
        const src = findSourceChannel(mm, s.id, sc.ch);
        const dst = findDest(mm, d.id);
        const dc = dst && dst.channels.find((x) => x.ch === col.ch);
        if (!src || !dc) return;
        const on = dc.source === src.key;
        const path = txPathOf(frame, d.id, col.ch);
        const wait = isPending(path) && (pending.get(pathKey(path)).value === src.key || on);
        td.className = [...base, on ? 'lpp-am-x--on' : '', on && (dc.mute || src.mute) ? 'lpp-am-x--muted' : '',
          wait ? 'lpp-am-x--pending' : ''].filter(Boolean).join(' ');
        td.setAttribute('title', `${describeSource(src.key)} → ${describeDest(d.id, col.ch)}`
          + (on ? ` — patched${dc.mute ? ', destination muted' : ''}${src.mute ? ', source muted' : ''}. Click to clear.`
            : dc.source !== NONE ? ` — now takes ${describeSource(dc.source)}. Click to replace.` : ' — click to patch.'));
      });
    } else if (sc) {
      /* An open source channel against a shut destination: open the destination. */
      td.addEventListener('click', () => { view.openCols.add(d.id); onRefresh(); });
      cells.push((mm) => {
        const src = findSourceChannel(mm, s.id, sc.ch);
        const dst = findDest(mm, d.id);
        if (!src || !dst) return;
        const n = fedBy(src, dst);
        td.className = [...base, 'lpp-am-x--mixed'].filter(Boolean).join(' ');
        td.textContent = n ? '•'.repeat(Math.min(n, 3)) : '';
        td.setAttribute('title', `${describeSource(src.key)} feeds ${n} channel${n === 1 ? '' : 's'} of ${d.label}. Click to open ${d.label}.`);
      });
    } else {
      /* A shut source against an open destination channel: open the source. */
      td.addEventListener('click', () => { view.openRows.add(s.id); onRefresh(); });
      cells.push((mm) => {
        const src = findSource(mm, s.id);
        const dst = findDest(mm, d.id);
        const dc = dst && dst.channels.find((x) => x.ch === col.ch);
        if (!src || !dc) return;
        const from = takesFrom(dc, src);
        td.className = [...base, 'lpp-am-x--mixed'].filter(Boolean).join(' ');
        td.textContent = from ? from.label : '';
        td.setAttribute('title', from
          ? `${describeDest(d.id, col.ch)} takes ${describeSource(from.key)}. Click to open ${s.label}.`
          : `Click to open ${s.label} into its channels.`);
      });
    }
    return td;
  }

  /* --------------------------------------------------------------- lookups */

  function readNow() {
    return readMatrix(session.store, view.frame, { fittedOnly: view.fittedOnly });
  }
  const findDest = (m, id) => (m ? m.destinations.find((d) => d.id === id) : null);
  const findSource = (m, id) => (m ? m.sources.find((s) => s.id === id) : null);
  const findSourceChannel = (m, id, ch) => {
    const s = findSource(m, id);
    return s ? s.channels.find((c) => c.ch === ch) : null;
  };
  const txPathOf = (frame, dest, ch) => txPath(frame, dest, ch, 'source');

  function toggle(set, id) {
    if (set.has(id)) set.delete(id); else set.add(id);
  }

  return { render };
}
