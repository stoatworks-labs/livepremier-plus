/*
 * DOM helpers, and the rule that keeps this looking like Web RCS.
 *
 * The panels are built in the page's light DOM, not in a shadow root. That is
 * the whole theming strategy: the vendor stylesheet defines 500-odd `aw-`
 * utility classes - a slate-grey scale, a spacing scale, typography, cards,
 * shadows - and light DOM means our markup inherits every one of them for
 * free. A shadow root would have isolated us from exactly the thing we want.
 *
 * So: reach for an `aw-` class first, and only fall back to the small
 * stylesheet in theme.js for structure the vendor system has no name for.
 * Icons come from the page's own SVG sprite by id.
 */

/** Build an element. Children may be nodes, strings, or nested arrays. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** An icon from the host page's sprite, e.g. icon('timer-18'). */
export function icon(id, cls = 'aw-block-huge') {
  const i = h('i', { class: 'icon ' + cls, 'aria-hidden': 'true' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 1800 1800');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id);
  use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + id);
  svg.append(use);
  i.append(svg);
  return i;
}

/** Clear and refill an element in one step. */
export function fill(el, ...children) {
  el.textContent = '';
  append(el, children);
  return el;
}

/**
 * A button in the host's idiom.
 *
 * The vendor's own buttons are React components with per-build hashed class
 * names, so they cannot be reused by name. These reproduce the same visual
 * language out of stable utility classes instead.
 */
export function button(label, { onClick, variant = 'default', iconId, disabled, title, active } = {}) {
  const cls = ['wru-button', 'aw-font-button', 'aw-border-radius', 'aw-flex-row-center',
    'aw-gap-col-small', 'wru-button--' + variant];
  if (active) cls.push('wru-button--active');
  return h('button', { class: cls, onClick, disabled: disabled ? 'disabled' : null, title: title || label, type: 'button' },
    iconId ? icon(iconId, 'aw-block-medium') : null,
    h('span', { text: label }));
}

/** Label above a value, the pattern the vendor uses for read-only readouts. */
export function readout(label, value, { tone } = {}) {
  return h('div', { class: 'aw-flex-col aw-gap-row-mini' },
    h('div', { class: 'aw-font-overline aw-text-tertiary', text: label }),
    h('div', { class: ['aw-font-body-1-bold', tone ? 'aw-text-' + tone : ''], text: String(value) }));
}

/** Section heading matching the sidebar's separator styling. */
export function sectionTitle(text, ...right) {
  return h('div', { class: 'aw-flex-row-center-v-space-between aw-margin-bottom-medium' },
    h('div', { class: 'aw-font-subtitle-1', text }),
    right.length ? h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' }, right) : null);
}

export const fmtClock = (ms) => {
  const t = Math.max(0, Math.round(ms / 100) / 10);
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
};

/**
 * Enter, however the event happens to spell it.
 *
 * `key` is not always populated — some synthetic and remote-input paths leave
 * it empty while still carrying `code` or the legacy `keyCode`. Both places
 * that commit on Enter (a numeric field, the console) need the same answer, so
 * it lives here rather than in either of them.
 */
export function isEnter(ev) {
  return ev.key === 'Enter' || ev.code === 'Enter' || ev.code === 'NumpadEnter' || ev.keyCode === 13;
}
