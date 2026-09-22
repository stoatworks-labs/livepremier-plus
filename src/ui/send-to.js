/*
 * Send to — a routing menu on the vendor's own source cards.
 *
 * Web RCS assigns a source to a layer by dragging its card onto the layer.
 * That is a good gesture for one layer on one screen you can see, and a poor
 * one for the same input on three screens, two of which are scrolled out of
 * view. This puts a `…` on every source card that opens a menu instead:
 * preview or program, then a screen and layer, or a layer group.
 *
 * ## Where the button goes, and what it is made of
 *
 * Every source card already carries a `⋮` of the vendor's own — it opens that
 * input's settings — in a tools slot at the card header's right. Ours is
 * **cloned from that button**, exactly as `ui/shell.js` clones a sidebar
 * entry and for the same reason: the button, its hover wrapper and its sizing
 * are all per-build hashed class names, and a hand-built copy would be right
 * on one firmware. The clone's glyph is swapped for `more-horizontal-12` —
 * the sprite's own horizontal ellipsis — so the two are told apart at a
 * glance: `⋮` is the vendor's, `…` is ours.
 *
 * ## ⚠️ How a card says which source it is
 *
 * It does not. There is no data attribute, no id, and the visible number is
 * the input's position rather than its name. What every card does have is a
 * picture, and the picture's address *is* the source:
 * `/api/device/snapshots/inputs/3` is `LIVE_3` on LivePremier and `INPUT_3`
 * on Midra. `core/dialect.js` owns that mapping in both directions, so this
 * file reads the `<img>` and asks — and a card whose source cannot be named
 * that way gets no button at all.
 *
 * That last part is deliberate rather than a gap. The Sources panel's third
 * tab is background *sets*, which are not layer sources in the first place,
 * and its fourth is screens used as sources, which have no snapshot to read.
 * Offering a `…` that cannot say what it would send is worse than not
 * offering one.
 *
 * ## ⚠️ React will take the button away
 *
 * The cards are React's, re-rendered on every snapshot refresh — which is
 * every couple of seconds. A MutationObserver puts the button back, and the
 * marker attribute is what stops it being added twice to a card that
 * survived. This is the sidebar's lifecycle problem in a busier place; the
 * same answer works, and trying to hold a node against reconciliation does
 * not.
 *
 * ## The lock is respected even though it cannot stop us
 *
 * The padlock on a screen card is React state, not device state, so a write
 * over the socket ignores it — see `ui/preset-lock.js`. The menu chooses to
 * honour it anyway: a target buffer that is locked gets a confirmation step
 * naming every layer it is about to change, and one that is open is sent
 * straight through. That is the operator's own guard rail, and an app that
 * quietly stepped over it would make the rail worthless everywhere.
 */

import { h, icon, button, spriteId } from './dom.js';
import { dialectFor } from '../core/dialect.js';
import { listDestinations, sourceLabel } from '../core/screens.js';
import { fittedLayers } from '../core/properties.js';
import { sourceCommands, resolveMembers } from '../core/groups.js';
import { lockedFor, ROLE_LABEL } from './preset-lock.js';

/**
 * The popover's own classes.
 *
 * ⚠️ **Not `aw-card`**, and this is the one exception to "reach for an `aw-`
 * class first" in the whole file. The vendor's card carries
 *
 *     .aw-card:hover { background-color: rgba(255, 255, 255, 0.08); … }
 *
 * — a translucent white *highlight*, which is right for a card lying on the
 * page and wrong for anything floating over it. A popover wearing it turned
 * see-through the moment the pointer landed on it, showing the layer stack
 * straight through the menu, and it beat our own opaque background on
 * specificity (`.aw-card:hover` is 0-2-0 against `.wru-sendto`'s 0-1-0) so no
 * amount of ordering would have fixed it. `aw-card` also dims the text to 70%
 * and forces its own `box-shadow` with `!important`.
 *
 * `.wru-sendto` already sets the background, border, radius and a stronger
 * shadow, so the class was contributing nothing but the bug.
 */
const MENU_CLASS = 'wru-sendto aw-border-radius aw-padding-none';

/** Put on our button so a re-render cannot end up with two of them. */
const MARK = 'data-lpp-sendto';
/** The vendor's own tools slot at a card header's right. */
const TOOLS_SEL = '[class*="header-module__c__tools___"]';
/** The Sources panel's card list. */
const CARDS_SEL = '[class*="sources-container__c__sections___"] .aw-card';

/**
 * @param {{session: object, groups: object, enabled?: () => boolean,
 *          onSent?: Function, onWrote?: Function, doc?: Document}} opts
 *   `groups` is the store from `ui/groups-panel.js` — `list()`, and
 *   `remember()` for the recently-used targets. `onWrote` is handed every
 *   command actually sent, with the target they were aimed at, so the gang
 *   can be told when a whole group has already been written.
 */
export function installSendTo({
  session, groups, enabled = () => true, onSent = () => {}, onWrote = () => {}, doc = document
} = {}) {
  let menu = null;
  let observer = null;

  const store = () => session.store;

  /* ------------------------------------------------------------- the button */

  /** Every source card we can name a source for, with that source. */
  function cards() {
    const dialect = dialectFor(store());
    if (!dialect) return [];
    const out = [];
    for (const card of doc.querySelectorAll(CARDS_SEL)) {
      const img = card.querySelector('img[src*="/api/device/snapshots/"]');
      const source = dialect.sourceFromSnapshot(img && img.getAttribute('src'));
      if (source) out.push({ card, source });
    }
    return out;
  }

  function decorate() {
    if (!enabled() || !store().ready) return;
    for (const { card, source } of cards()) {
      const tools = card.querySelector(TOOLS_SEL);
      if (!tools) continue;
      const existing = tools.querySelector('[' + MARK + ']');
      if (existing) {
        /* The card was re-rendered around our button, or React reused this
           node for a different input. Either way the source is re-stamped
           rather than trusted — a stale one would send the wrong picture. */
        existing.setAttribute(MARK, source);
        continue;
      }
      const node = cloneTool(tools, source);
      if (node) tools.prepend(node);
    }
  }

  /**
   * A copy of the vendor's own tool button, with our glyph in it.
   *
   * The whole `aw-card--displayed-hover` wrapper is cloned, not just the
   * button: that class is what makes the vendor's `⋮` appear on hover and
   * stay out of the way otherwise, and a button of ours sitting there
   * permanently would be the one thing on the card that never settles down.
   */
  function cloneTool(tools, source) {
    const template = tools.querySelector('.aw-card--displayed-hover') || tools.firstElementChild;
    const original = template && template.querySelector('button');
    if (!original) return null;

    const node = template.cloneNode(true);
    const btn = node.querySelector('button');
    if (!btn) return null;

    node.setAttribute(MARK, source);
    btn.setAttribute('type', 'button');
    btn.setAttribute('title', 'Send to…');
    btn.setAttribute('aria-label', 'Send to');

    /* Swap the glyph in place so the icon keeps the vendor's own sizing
       classes. `spriteId` falls back when a build's sprite lacks the
       horizontal ellipsis, in which case ours looks like the vendor's — the
       title still tells them apart, and a blank button would not. */
    const use = btn.querySelector('use');
    if (use) {
      const id = '#' + spriteId(['more-horizontal-12', 'more-horizontal-18', 'more-vertical-12']);
      use.setAttribute('href', id);
      use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', id);
    }

    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      /* Read off the node rather than closed over: React reuses card nodes as
         the list scrolls, and `decorate` re-stamps the attribute each pass. */
      openMenu(btn, node.getAttribute(MARK));
    });

    return node;
  }

  /* --------------------------------------------------------------- the menu */

  function openMenu(anchor, source) {
    closeMenu();
    const state = { source, mode: 'PREVIEW', stage: 'pick', plan: null, result: null };
    const el = h('div', {
      class: MENU_CLASS,
      role: 'dialog',
      'aria-label': 'Send to'
    });
    menu = { el, state, anchor, draw: () => drawMenu(el, state) };
    doc.body.append(el);
    menu.draw();
    position(el, anchor);

    doc.addEventListener('mousedown', onOutside, true);
    doc.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', closeMenu);
    /* A scroll of the sources list would leave the menu pointing at nothing.
       Capture, because the scroller is one of the vendor's and does not
       bubble scroll events. */
    doc.addEventListener('scroll', closeMenu, true);
  }

  function closeMenu() {
    if (!menu) return;
    menu.el.remove();
    menu = null;
    doc.removeEventListener('mousedown', onOutside, true);
    doc.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', closeMenu);
    doc.removeEventListener('scroll', closeMenu, true);
  }

  const onOutside = (ev) => { if (menu && !menu.el.contains(ev.target)) closeMenu(); };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); closeMenu(); } };

  /**
   * Put the menu beside its button, and inside the window.
   *
   * Fixed rather than absolute, and parented to `body`: the sources list is a
   * scroller with `overflow: hidden` on the cross axis, so a menu rendered
   * inside a card would be clipped to the card.
   */
  function position(el, anchor) {
    const r = anchor.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const margin = 8;
    let left = r.right + margin;
    if (left + box.width > window.innerWidth - margin) left = Math.max(margin, r.left - box.width - margin);
    let top = r.top;
    if (top + box.height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - box.height - margin);
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  function drawMenu(el, state) {
    el.textContent = '';
    el.append(
      h('div', { class: 'wru-sendto-head aw-flex-row-center-v-space-between aw-padding-medium' },
        h('div', { class: 'aw-font-subtitle-1', text: 'Send ' + (sourceLabel(state.source, store()) || state.source) }),
        h('button', { class: 'wru-sendto-x aw-text-tertiary', type: 'button', title: 'Close', onClick: closeMenu },
          icon(['close-12', 'close-14'], 'aw-block-medium'))));

    if (state.result) return el.append(resultView(state));
    if (state.stage === 'confirm') return el.append(confirmView(state));
    el.append(pickView(state));
  }

  /* ------------------------------------------------------------- picking */

  function pickView(state) {
    const body = h('div', { class: 'wru-sendto-body' });

    body.append(h('div', { class: 'wru-sendto-modes aw-flex-row aw-gap-col-small aw-padding-horizontal-medium aw-padding-bottom-medium' },
      modeButton(state, 'PREVIEW', 'Preview'),
      modeButton(state, 'PROGRAM', 'Program')));

    const recent = recentTargets();
    if (recent.length) {
      body.append(group('Recent', recent.map((t) => targetRow(state, t))));
    }

    const groupRows = (groups.list() || [])
      .filter((g) => g.members.length)
      .map((g) => {
        const resolved = resolveMembers(store(), g);
        const missing = resolved.filter((m) => !m.fitted).length;
        return targetRow(state, { kind: 'group', id: g.id }, {
          label: g.name,
          hint: describeMembers(resolved),
          warn: missing ? `${missing} not fitted` : null,
          badge: g.gang ? 'GANG' : null
        });
      });
    body.append(group('Groups', groupRows.length ? groupRows
      : [h('div', { class: 'wru-sendto-empty aw-text-tertiary aw-font-caption', text: 'No layer groups yet — PLUS ▸ Layer Groups.' })]));

    const screens = [];
    for (const dest of destinations()) {
      const layers = fittedLayers(store(), dest.id);
      if (!layers.length) continue;
      screens.push(h('div', { class: 'wru-sendto-screen aw-flex-row-center-v aw-gap-col-small' },
        h('div', { class: 'wru-sendto-screen-id aw-font-body-1-bold', text: dest.id }),
        h('div', { class: 'aw-flex-row aw-gap-col-mini aw-flex-wrap' },
          layers.map((l) => layerChip(state, dest.id, l.key)))));
    }
    body.append(group('Screens', screens.length ? screens
      : [h('div', { class: 'wru-sendto-empty aw-text-tertiary aw-font-caption', text: 'No screen reports a fitted layer.' })]));

    return body;
  }

  const group = (title, children) => h('div', { class: 'wru-sendto-group' },
    h('div', { class: 'wru-sendto-group-title aw-font-overline aw-text-tertiary', text: title }),
    children);

  function modeButton(state, mode, label) {
    return button(label, {
      active: state.mode === mode,
      variant: mode === 'PROGRAM' ? 'danger' : 'default',
      onClick: () => { state.mode = mode; menu.draw(); position(menu.el, menu.anchor); }
    });
  }

  /**
   * How a layer key is written in prose — a target row, a member list, the
   * confirmation step. The chips below abbreviate NATIVE further because they
   * are three characters wide, and that is the only place that does.
   */
  const layerLabel = (layer) => (layer === 'NATIVE' ? 'NATIVE' : 'L' + layer);

  function layerChip(state, id, layer) {
    return h('button', {
      class: 'wru-sendto-chip aw-font-caption',
      type: 'button',
      onClick: () => choose(state, { kind: 'layer', id, layer })
    }, layer === 'NATIVE' ? 'NAT' : layerLabel(layer));
  }

  function targetRow(state, target, meta = {}) {
    const info = meta.label ? meta : describeTarget(target);
    if (!info) return null;
    return h('button', { class: 'wru-sendto-row aw-flex-row-center-v aw-gap-col-small', type: 'button', onClick: () => choose(state, target) },
      h('div', { class: 'aw-flex-col aw-flex-item aw-min-width-0' },
        h('div', { class: 'aw-font-body-1 aw-text-ellipsis', text: info.label }),
        info.hint ? h('div', { class: 'aw-font-caption aw-text-tertiary aw-text-ellipsis', text: info.hint }) : null),
      info.warn ? h('div', { class: 'wru-tag wru-tag--warn aw-font-caption', text: info.warn }) : null,
      info.badge ? h('div', { class: 'wru-tag aw-font-caption', text: info.badge }) : null);
  }

  /* ------------------------------------------------------------- deciding */

  /**
   * A target was clicked: work out the writes, then either ask or send.
   *
   * The plan is built before the lock is consulted, because the lock question
   * is about the screens a send would *actually* touch — a group with three
   * members of which one is not fitted asks about two screens, not three.
   */
  function choose(state, target) {
    const members = membersOf(target);
    if (!members.length) return;

    const plan = sourceCommands(store(), members, state.source, state.mode);
    const touched = [...new Set(plan.cmds.map((c) => screenOfPath(c.path)).filter(Boolean))];
    const lock = lockedFor(touched, state.mode, doc);

    if (!plan.cmds.length) return finish(state, target, plan, 0);
    if (lock.locked.length) {
      state.stage = 'confirm';
      state.plan = { target, plan, lock };
      menu.draw();
      position(menu.el, menu.anchor);
      return;
    }
    send(state, target, plan);
  }

  function send(state, target, plan) {
    const sent = [];
    for (const cmd of plan.cmds) if (session.send(cmd)) sent.push(cmd);
    /* Announced before the echoes can arrive, so the gang can recognise them
       as this send landing rather than as a member drifting. */
    onWrote({ target, cmds: sent, mode: state.mode });
    groups.remember(target);
    finish(state, target, plan, sent.length);
  }

  /**
   * Say what happened, and say all of it.
   *
   * A count of what was written is half an answer: "sent to three layers"
   * when one of them was refused mid-take is the kind of quiet failure that
   * gets discovered on the output. Every refusal carries its own reason up
   * from `sourceCommands`, and they all go on the line.
   */
  function finish(state, target, plan, sent) {
    const label = sourceLabel(state.source, store()) || state.source;
    const bits = [];
    if (sent) bits.push(`${label} → ${sent} layer${sent === 1 ? '' : 's'}`);
    if (plan.unchanged.length) bits.push(`${plan.unchanged.length} already ${label}`);
    for (const r of plan.refused) bits.push(r.why);

    state.result = {
      tone: plan.refused.length || !sent ? 'warn' : 'ok',
      text: bits.join(' · ') || 'nothing to send'
    };
    onSent({ source: state.source, mode: state.mode, target, sent, plan });
    menu.draw();
    setTimeout(closeMenu, plan.refused.length ? 2600 : 1400);
  }

  function confirmView(state) {
    const { target, plan, lock } = state.plan;
    const role = ROLE_LABEL[state.mode] || state.mode;
    const why = lock.reason === 'card' ? `${role} is locked on ${lock.locked.join(', ')}`
      : lock.reason === 'master' ? `${role} is locked for the whole page`
        : `${lock.locked.join(', ')} ${lock.locked.length === 1 ? 'is' : 'are'} not on screen, so the ${role} lock cannot be read`;

    /*
     * Name every layer this is about to change, from the built commands
     * rather than from the target — a group of three whose third member is
     * not fitted must say two. The group's own name leads, because that is
     * what was clicked; a single layer is already its own name, so it is not
     * said twice.
     */
    const where = plan.cmds.map((c) => `${screenOfPath(c.path)} ${layerLabel(layerOfPath(c.path))}`).join(' · ');
    const named = target.kind === 'group' ? `${(describeTarget(target) || {}).label} — ${where}` : where;

    return h('div', { class: 'wru-sendto-body' },
      h('div', { class: 'wru-sendto-warn aw-padding-medium aw-flex-col aw-gap-row-small' },
        h('div', { class: 'aw-font-body-1-bold', text: plan.live ? `${role} — ON AIR` : `${role} is locked` }),
        h('div', { class: 'aw-font-caption', text: why }),
        h('div', { class: 'aw-font-caption aw-text-secondary',
          text: `${sourceLabel(state.source, store()) || state.source} → ${named}` })),
      h('div', { class: 'aw-flex-row aw-gap-col-small aw-padding-medium' },
        button(`Send to ${state.mode === 'PROGRAM' ? 'program' : 'preview'}`, {
          variant: 'danger',
          onClick: () => { state.stage = 'pick'; send(state, target, plan); }
        }),
        button('Cancel', { onClick: closeMenu })));
  }

  function resultView(state) {
    return h('div', { class: 'wru-sendto-body' },
      h('div', { class: ['wru-sendto-result', 'aw-padding-medium', 'aw-font-caption', 'wru-sendto-result--' + state.result.tone] },
        state.result.text));
  }

  /* ------------------------------------------------------------- helpers */

  function destinations() {
    return store().ready ? listDestinations(store()) : [];
  }

  function membersOf(target) {
    if (target.kind === 'layer') return [{ id: target.id, layer: target.layer }];
    const group = (groups.list() || []).find((g) => g.id === target.id);
    return group ? group.members : [];
  }

  function describeTarget(target) {
    if (target.kind === 'layer') return { label: `${target.id} ${layerLabel(target.layer)}` };
    const group = (groups.list() || []).find((g) => g.id === target.id);
    if (!group) return null;
    return { label: group.name, hint: describeMembers(resolveMembers(store(), group)), badge: group.gang ? 'GANG' : null };
  }

  const describeMembers = (members) =>
    members.map((m) => `${m.id} ${layerLabel(m.layer)}`).join(' · ');

  /** Recently used targets that still resolve to something. */
  function recentTargets() {
    return (groups.recent() || []).filter((t) => membersOf(t).length).slice(0, 5);
  }

  /*
   * Which screen and layer a built command is for.
   *
   * Read back out of the path rather than carried alongside it, so that what
   * is reported is what is actually about to be written. The two platforms
   * put the destination and the layer in different places, so both are found
   * by their neighbouring collection name — the only two spellings either
   * dialect uses.
   */
  const afterList = (path, names) => {
    for (let i = 0; i < path.length - 1; i++) {
      if (names.includes(path[i]) && path[i + 1] === 'items') return path[i + 2];
    }
    return null;
  };
  const screenOfPath = (path) => {
    const key = afterList(path, ['screenList', 'auxiliaryList', 'auxiliaryScreenList']);
    if (key == null) return null;
    /* `mng` keys its screens `1`..`4` in two lists; the identifier above the
       dialect is `S1` / `A1`, which is what everything else here prints. */
    if (/^[SA]\d+$/.test(key)) return key;
    return (path.includes('auxiliaryScreenList') ? 'A' : 'S') + key;
  };
  const layerOfPath = (path) => afterList(path, ['layerList', 'liveLayerList']);

  /* --------------------------------------------------------------- start */

  decorate();
  /*
   * The cards are re-rendered constantly — a snapshot refresh is a new `src`
   * every couple of seconds — so this fires often. `decorate` is a query and
   * an attribute check per card, and the alternative is a button that
   * disappears on its own schedule.
   */
  observer = new MutationObserver(() => decorate());
  observer.observe(doc.body, { childList: true, subtree: true });

  return {
    refresh: decorate,
    stop() {
      closeMenu();
      if (observer) { observer.disconnect(); observer = null; }
      for (const node of doc.querySelectorAll('[' + MARK + ']')) node.remove();
    }
  };
}

/** Exported for the tests: the selector a card list is found by. */
export const SOURCE_CARDS_SELECTOR = CARDS_SEL;
export const SENDTO_MARK = MARK;
export const SENDTO_MENU_CLASS = MENU_CLASS;
