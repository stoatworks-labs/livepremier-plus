/*
 * The desk's strip screen: 1920 × 550, under the wheels.
 *
 * Booted by `screen.html` through the machinery every popout shares
 * (`src/ui/popout.js`), with the desk that the plugin's page half shared as
 * `own`. It holds nothing: every paint is `own.snapshot()`, and everything it
 * does — a tab tapped, a line typed at a USB keyboard — is a call back into
 * the desk in the Web RCS tab. Close it and the keypad still types.
 *
 * ## Layout, in the screen's own pixels (docs/screen.svg)
 *
 *   ┌──────────┬──────────────────────────────────────────┬──────────────┐
 *   │ scope    │ the command line                         │ device       │
 *   │ SHIFT    │ → what Enter would do                    │ session/MIDI │
 *   ├──────────┴───────────────────┬──────────────────────┴──────────────┤
 *   │ the last few lines run       │ wheel pages                         │
 *   │ ENCODERS                     │                                     │
 *   │ E1   E2   E3   E4            │ Wheel A     Wheel B     Wheel C     │
 *   └──────────────────────────────┴─────────────────────────────────────┘
 *
 * Each cell is over its knob, so the stage is never reflowed to fit a window:
 * it is scaled whole. On the PA147CDV at 1920 × 550 the scale is one.
 */

import { h } from '../../src/ui/dom.js';
import { bootPopout } from '../../src/ui/popout.js';
import { SCREEN } from './core.js';

const TABS = Object.freeze({ left: 888.7, right: 1908, gap: 8 });
const MIDI = {
  off: 'MIDI off — Enable MIDI in the Desk panel',
  asking: 'asking for MIDI…',
  choose: 'MIDI on — choose the desk’s input in the Desk panel',
  elsewhere: 'another tab has the desk',
  refused: 'MIDI refused',
  unsupported: 'no Web MIDI in this browser'
};

/**
 * Build the strip screen into `doc`, driving the opener's desk.
 *
 * @param {{doc: Document, opener: Window}} opts
 */
export function mountDeskScreen({ doc = document, opener = window.opener } = {}) {
  return bootPopout({ doc, opener, plugin: 'desk', vendorChrome: false, build: ({ own }) => buildScreen(doc, own) });
}

function abs(cls, style = {}, ...children) {
  return h('div', { class: ['abs', ...[].concat(cls)], style: px(style) }, ...children);
}

/** `{left: 24}` → `{left: '24px'}`: the stage is laid out in screen pixels. */
function px(style) {
  const out = {};
  for (const [k, v] of Object.entries(style)) out[k] = typeof v === 'number' ? `${v}px` : v;
  return out;
}

export function buildScreen(doc, own) {
  const win = doc.defaultView || window;

  /* ------------------------------------------------------------ the bar */

  const scope = abs('scope');
  const shift = abs('shift');
  const text = h('span');
  const caret = h('span', { class: 'caret', text: '▍' });
  const placeholder = h('span', { class: 'placeholder' });
  const cmd = abs('cmd', {}, text, placeholder, caret);
  /* A USB keyboard plugged into the desk types here — Label needs letters,
     and the keypad has none. Invisible over the line it edits; the line
     shown is always the desk's, so the keypad and the keyboard can take
     turns on the same command. */
  const typing = h('input', {
    class: ['abs', 'typing'],
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'The desk’s command line',
    onInput: (ev) => own.setLine(ev.target.value),
    onKeydown: (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); own.execute(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); own.clear(); }
    }
  });
  const will = abs('will');
  const device = abs('device');
  const status = abs('status');

  /* ------------------------------------------------------- the strip */

  const recent = abs('recent');
  const bankLabel = abs('label', { left: 884.7, top: 138 }, 'WHEEL BANK — tap, or press an attribute key on an empty line');
  const encLabel = abs('label', { left: 12, top: 268 });
  const tabs = h('div');
  const cellEls = [];
  const cellHost = h('div');

  const full = h('button', {
    class: ['abs', 'full'],
    type: 'button',
    title: 'Full screen',
    text: '⤢',
    onClick: () => {
      if (doc.fullscreenElement) doc.exitFullscreen().catch(() => {});
      else doc.documentElement.requestFullscreen().catch(() => {});
    }
  });

  const stage = h('div', { class: 'stage' },
    abs('bar'), scope, shift, cmd, typing, will, device, status,
    recent, bankLabel, encLabel, tabs, cellHost, full);
  doc.body.append(stage);

  /* Scaled whole, never reflowed: a cell that moved to fit a window would no
     longer be over its knob. Centred, with the room left over in black. */
  function fit() {
    const k = Math.min(win.innerWidth / SCREEN.width, win.innerHeight / SCREEN.height) || 1;
    const x = Math.max(0, (win.innerWidth - SCREEN.width * k) / 2);
    const y = Math.max(0, (win.innerHeight - SCREEN.height * k) / 2);
    stage.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  }
  win.addEventListener('resize', fit);
  fit();

  /* ------------------------------------------------------------- paint */

  let tabKey = '';
  function paintTabs(snap) {
    const key = JSON.stringify([snap.pages.map((p) => [p.id, p.label]), snap.page]);
    if (key === tabKey) return;
    tabKey = key;
    tabs.textContent = '';
    const n = snap.pages.length;
    if (!n) return;
    const width = (TABS.right - TABS.left - (n - 1) * TABS.gap) / n;
    snap.pages.forEach((p, i) => {
      tabs.append(h('div', {
        class: ['abs', 'tab', p.id === snap.page ? 'on' : ''],
        style: px({ left: TABS.left + i * (width + TABS.gap), width }),
        text: p.label || p.id,
        onClick: () => own.showPage(p.id)
      }));
    });
  }

  function paintCells(snap) {
    if (!cellEls.length) {
      for (const c of snap.cells) {
        const wheel = c.kind === 'wheel';
        const name = abs('name', { left: 0, top: wheel ? 28 : 22, width: '100%' });
        const val = abs(['val', wheel ? 'wheel-val' : ''], { left: 0, top: wheel ? 86 : 70, width: '100%' });
        const sub = abs('sub', { left: 0, top: wheel ? 168 : 132, width: '100%' });
        const box = abs(['cell', wheel ? 'wheel' : ''], { left: c.left, top: c.top, width: c.width, height: c.height }, name, val, sub);
        const tick = abs('tick', { left: c.tick - 2 });
        cellHost.append(box, tick);
        cellEls.push({ box, name, val, sub });
      }
    }
    snap.cells.forEach((c, i) => {
      const el = cellEls[i];
      if (!el) return;
      el.box.classList.toggle('unbound', !c.bound);
      el.name.textContent = c.label;
      el.val.textContent = c.bound ? c.value : '';
      el.sub.textContent = c.bound ? c.name : '';
    });
  }

  function paint() {
    let snap;
    try { snap = own.snapshot(); } catch { return; }

    scope.textContent = snap.scope || 'no scope';
    scope.classList.toggle('none', !snap.scope);
    shift.textContent = snap.shift ? 'SHIFT' : '';

    text.textContent = snap.line;
    placeholder.textContent = snap.line ? '' : 'type on the keypad';
    cmd.classList.toggle('empty', !snap.line);
    /* The field follows the desk's line unless it is the one being typed
       in and already says the same — rewriting it then would jump the caret. */
    if (typing.value !== snap.line) typing.value = snap.line;

    const fb = snap.notice ? { tone: 'warn', text: snap.notice } : snap.feedback;
    will.textContent = fb.text;
    will.className = ['abs', 'will', fb.tone].join(' ');

    device.textContent = snap.device || 'no switcher';
    const m = snap.midi;
    const midiText = m.status === 'listening' ? `MIDI: ${m.name}` : (MIDI[m.status] || m.status);
    status.textContent = [snap.session === 'live' ? '' : snap.session, midiText].filter(Boolean).join(' · ');
    status.classList.toggle('warn', m.status !== 'listening' || snap.session !== 'live');

    recent.textContent = '';
    for (const r of snap.log) {
      recent.append(h('div', { class: ['row', r.kind] },
        h('code', { text: r.text }), r.detail || ''));
    }

    encLabel.textContent = snap.wheelsAt
      ? `ENCODERS AND WHEELS — ${snap.wheelsAt}`
      : 'ENCODERS AND WHEELS — no layer yet';
    paintTabs(snap);
    paintCells(snap);
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    win.requestAnimationFrame(() => { queued = false; paint(); });
  }

  const unsubscribe = own.subscribe(schedule);
  paint();

  return {
    paint,
    stop() {
      unsubscribe();
      win.removeEventListener('resize', fit);
    }
  };
}
