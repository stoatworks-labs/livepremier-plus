/*
 * Desk — the sidebar panel: the MIDI input, the screen window, the wheel
 * pages, and the desk's own Console line with its log.
 *
 * The line drawn here is the one the keypad types into, so a word from the
 * keypad appears on it exactly as it does on the strip screen; it can be
 * typed at too.
 */

import { h, button } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';

const STATUS = {
  off: ['MIDI off', true],
  asking: ['asking for MIDI…', true],
  choose: ['choose the desk’s input', true],
  listening: ['listening', false],
  elsewhere: ['another tab has the desk', true],
  refused: ['MIDI refused', true],
  unsupported: ['no Web MIDI', true]
};

export function createDeskPanel({ desk, onRefresh = () => {}, screenUrl }) {
  let child = null;

  /** Open the strip screen's window, or bring the open one forward. */
  function openScreen() {
    if (child && !child.closed) { child.focus(); return; }
    child = window.open(screenUrl, 'lpp-desk',
      'width=1920,height=550,menubar=no,toolbar=no,location=no');
    if (!child) {
      desk.state.error = 'The browser blocked the window — allow pop-ups for this address.';
      onRefresh();
    }
  }

  function midiRow() {
    const s = desk.state;
    if (!s.access) {
      return h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium' },
        button('Enable MIDI', { onClick: () => desk.connect(), variant: 'primary' }),
        h('span', { class: 'aw-text-secondary aw-font-caption', text: 'The browser asks once; after that the desk starts listening by itself.' }));
    }
    const list = desk.inputs();
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium' },
      h('label', { class: 'aw-flex-col aw-gap-row-mini' },
        h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'The desk’s MIDI input' }),
        h('select', {
          class: 'wru-input',
          onChange: (ev) => { void desk.choose(ev.target.value); }
        },
        h('option', { value: '', text: list.length ? '— choose —' : 'none found' }),
        list.map((p) => {
          const opt = h('option', { value: p.id, text: p.name });
          if (p.id === s.inputId) opt.selected = true;
          return opt;
        }))),
      s.status === 'listening'
        ? button('Stop', { onClick: () => desk.stop(), variant: 'ghost' })
        : null);
  }

  function pagesRow() {
    const snap = desk.snapshot();
    if (!snap.pages.length) return null;
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: `Wheels — ${snap.wheelsAt}` }),
      h('div', { class: 'aw-flex-row aw-gap-col-small', style: { flexWrap: 'wrap' } },
        snap.pages.map((p) => button(p.label || p.id, {
          variant: p.id === snap.page ? 'primary' : 'ghost',
          onClick: () => desk.showPage(p.id)
        }))));
  }

  function render() {
    const s = desk.state;
    const [label, warn] = STATUS[s.status] || [s.status, true];
    const toolbar = h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium' },
      h('div', { class: 'aw-font-subtitle-1', text: 'Desk' }),
      h('span', { class: ['wru-tag', warn ? 'wru-warn' : ''], text: s.status === 'listening' ? `${label}: ${s.inputName}` : label }),
      h('span', { class: 'wru-tag', text: 'preview' }),
      h('div', { style: { flex: '1' } }),
      button('Open the screen', {
        iconId: 'set-layer-to-fullscreen-18',
        title: 'The strip screen’s page, 1920 × 550, in a window of its own',
        onClick: openScreen
      }));

    const body = h('div', { class: 'aw-flex-col aw-gap-row-large' },
      h('div', { class: 'aw-text-secondary aw-font-caption', text:
        'The LivePremier Plus desk: a Mynah keypad that types into the line below, four encoders and three wheels on the selected layer, and a 1920 × 550 strip screen. No desk has been built yet — this has only met a virtual MIDI port.' }),
      s.error ? h('div', { class: 'wru-tag wru-warn', text: s.error }) : null,
      midiRow(),
      pagesRow(),
      desk.line.render());

    return panel({ toolbar, body });
  }

  return { render, openScreen };
}
