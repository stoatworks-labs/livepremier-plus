/*
 * Web RCS's own edit locks, read off the page.
 *
 * The Screens / Aux. page has a padlock on each preset buffer of each screen
 * card, and a master pair over the Sources panel that sets them all. Locked
 * means the vendor's own UI will not let you drop a source on that buffer —
 * it is the guard rail an operator puts up so that a mis-aimed drag does not
 * land on the output.
 *
 * ## ⚠️ The lock is not device state
 *
 * There is nothing in `GET /api/stores/device` for it. The whole store was
 * searched on 2026-09-21 against a LivePremier Simulator 6.2.73: the only
 * `lock` keys are `system/deviceList/items/<n>/frontPanel/pp/lock` and the
 * ST2110 cards' PTP `isLocked`, neither of which is this. `localStorage` is
 * empty too, and the locks reset to PGM-locked, PRW-unlocked on reload. It is
 * React state inside the vendor bundle and it exists only in the tab.
 *
 * Which has two consequences, and they are the reason this file is written
 * the way it is:
 *
 * - **A write over the socket is not subject to it.** The lock stops the
 *   vendor's UI, not the device. Anything this app sends goes through whether
 *   the padlock is shut or not. So respecting it is a thing we choose to do,
 *   and this file is that choice made legible.
 * - **It can only be read where it is drawn.** A screen whose card is not on
 *   screen — the page shows the screens the operator has selected — has no
 *   lock state anywhere to read. So the answer falls back: the screen's own
 *   card, then the master pair, then locked. Each step is less specific and
 *   more cautious than the last, and the last one means "ask".
 *
 * ## What is matched, and why none of it is a hashed class
 *
 * Read off a running Web RCS (LivePremier Simulator 6.2.73, 2026-09-21):
 *
 *   .aw-preset-view                     one screen card — a plain utility class
 *     h2                                its destination, `S1` / `A2`
 *     [class*="screen-overview-container__c__preset___"]   one per buffer
 *       button > use[href="#locked-12" | "#unlocked-12"]   the padlock
 *
 * The padlock is found by its **sprite id** and its state read from
 * `aria-pressed`, neither of which carries a build hash. The one hashed
 * fragment used — `screen-overview-container__c__preset___` — is matched on
 * its stable middle in the same way `ui/shell.js` matches the sidebar, and it
 * is only needed to tell one buffer's block from the other's; when it is not
 * found the whole card is searched instead and the two padlocks are taken in
 * the order they are drawn, which is PGM then PRW.
 *
 * ## The Midra 4K / Alta 4K page draws its cards differently
 *
 * Read off a running Web RCS (Midra 4K Simulator 3.2.29, Pulse 4K,
 * 2026-10-06). Same sprites, same `aria-pressed`, but no `.aw-preset-view`
 * and no `h2`:
 *
 *   one column per screen
 *     button > span "S1"                the screen's chip, at the top
 *     [class*="live-content-header__c___"]          one per buffer
 *       [class*="live-content-header__c__lock___"] > button > use   the padlock
 *       button "PGM" | "PRW"            the buffer's own label button
 *
 * So there each padlock is found first, its role read off the label button
 * in its own header, and its screen off the nearest ancestor holding exactly
 * one destination chip — the column. An ancestor holding two (the Screens bar
 * at the top names S1 and S2) is the whole page: the padlock is skipped
 * rather than given to either. The master pair is the same two labelled
 * buttons as on LivePremier. One difference worth knowing: a fresh Midra page
 * draws every padlock open, PGM included.
 *
 * What the Midra lock then refuses is the vendor UI's own: a memory dragged
 * onto that buffer, a source dropped on it, its layers moved, its Load
 * control in the properties panel (all `isPresetLocked` / `isLocked` in the
 * 3.2.29 bundle). It is per component there, where LivePremier has one
 * middleware, but the operator's guard rail is the same.
 */

/** Sprite ids for the two states. Shut is `locked-12`; open is `unlocked-12`. */
const SHUT = 'locked-12';
const OPEN = 'unlocked-12';

const PRESET_BLOCK = '[class*="screen-overview-container__c__preset___"]';

/** PROGRAM and PREVIEW, in the words the vendor's own buttons use. */
export const ROLE_LABEL = { PROGRAM: 'PGM', PREVIEW: 'PRW' };

/** Is this element a padlock, and is it shut? `null` when it is not one. */
function padlockState(el) {
  const use = el.querySelector && el.querySelector('use');
  const href = use && (use.getAttribute('href') || use.getAttribute('xlink:href') || '');
  if (href === '#' + SHUT) return true;
  if (href === '#' + OPEN) return false;
  return null;
}

/**
 * The master pair over the Sources panel.
 *
 * Found as "a button whose whole label is PGM or PRW and which carries a
 * padlock", which is only true of these two: the other PGM/PRW buttons on the
 * page carry a caret, an eye or nothing at all. Returns what it could read,
 * so a build that draws them differently produces an empty map rather than a
 * wrong answer.
 */
export function readMasterLocks(root = document) {
  const out = {};
  for (const btn of root.querySelectorAll('button')) {
    const label = (btn.textContent || '').trim().toUpperCase();
    if (label !== 'PGM' && label !== 'PRW') continue;
    const shut = padlockState(btn);
    if (shut == null) continue;
    out[label] = shut;
  }
  return out;
}

/**
 * Every screen card's locks: `{ S1: {PGM: true, PRW: false}, … }`.
 *
 * A card whose destination cannot be named is skipped rather than guessed at.
 * Both pages name a card `S1` / `A2` — the `h2` on LivePremier, the column's
 * chip on Midra 4K — which is this app's own spelling for a destination and
 * so needs no translation, although a Midra numbers its screens `1`..`4` in
 * the store.
 */
export function readCardLocks(root = document) {
  const out = {};
  for (const [id, pads] of cardPadlocks(root)) {
    for (const [role, pad] of Object.entries(pads)) (out[id] || (out[id] = {}))[role] = pad.shut;
  }
  return out;
}

/**
 * The padlock button itself on one screen card, for a caller that means to
 * press it: `plugins/preview-lock` shuts PRW for the length of a take. A
 * click on it is the vendor's own toggle, through the vendor's own handler,
 * so its Redux lock and its warnings follow exactly as if the operator had
 * pressed it.
 *
 * Only ever the card's. The master pair shuts every screen on the page, and
 * a take on one screen is no reason to lock the others. `null` when the
 * card is not drawn or its padlock cannot be told from the other one.
 *
 * @param {string} id     `S1`, `A2`
 * @param {'PGM'|'PRW'} role
 * @returns {{button: Element, shut: boolean} | null}
 */
export function cardPadlock(id, role, root = document) {
  for (const [cardId, pads] of cardPadlocks(root)) {
    if (cardId === id) return pads[role] || null;
  }
  return null;
}

/** Every named card's padlocks: `[[id, {PGM: {button, shut}, PRW: {…}}]]`. */
function cardPadlocks(root) {
  const out = [];
  for (const card of root.querySelectorAll('.aw-preset-view')) {
    const heading = card.querySelector('h2');
    const id = heading && (heading.textContent || '').trim().toUpperCase();
    if (!id || !/^[SA]\d+$/.test(id)) continue;

    const pads = {};
    const blocks = [...card.querySelectorAll(PRESET_BLOCK)];
    if (blocks.length) {
      for (const block of blocks) {
        const role = blockRole(block);
        const pad = findPadlock(block);
        if (role && pad) pads[role] = pad;
      }
    } else {
      /* No hashed block to split the card by. Take the padlocks in the order
         they are drawn — program above preview, which is how every Web RCS
         build has laid a screen card out — rather than abandoning the card. */
      const found = [...card.querySelectorAll('button')]
        .map((button) => ({ button, shut: padlockState(button) }))
        .filter((p) => p.shut != null);
      if (found.length === 2) { pads.PGM = found[0]; pads.PRW = found[1]; }
    }
    if (Object.keys(pads).length) out.push([id, pads]);
  }
  /* The Midra 4K page has no `.aw-preset-view`; its cards are read padlock
     first. A destination the first pass named is left as it named it. */
  const named = new Set(out.map(([id]) => id));
  const columns = new Map();
  for (const lock of root.querySelectorAll(MNG_LOCK)) {
    const pad = findPadlock(lock);
    const header = pad && ancestorWithClass(lock, MNG_HEADER);
    const role = header && blockRole(header);
    const id = role && columnDestination(header);
    if (!id || named.has(id)) continue;
    const pads = columns.get(id) || {};
    pads[role] = pad;
    columns.set(id, pads);
  }
  return [...out, ...columns];
}

/** Midra 4K: one buffer's header, and the box its padlock sits in. */
const MNG_HEADER = 'live-content-header__c___';
const MNG_LOCK = '[class*="live-content-header__c__lock___"]';

function ancestorWithClass(el, fragment) {
  for (let up = el; up; up = up.parentElement) {
    if (String(up.className || '').includes(fragment)) return up;
  }
  return null;
}

/**
 * The destination a Midra buffer header belongs to: the nearest ancestor that
 * holds exactly one button whose whole label is a destination (the column's
 * chip). Two or more means the walk has reached the page, and no answer is
 * safer than the wrong screen.
 */
function columnDestination(header) {
  for (let up = header.parentElement; up; up = up.parentElement) {
    const ids = new Set();
    for (const btn of up.querySelectorAll('button')) {
      const label = (btn.textContent || '').trim().toUpperCase();
      if (/^[SA]\d+$/.test(label)) ids.add(label);
    }
    if (ids.size === 1) return [...ids][0];
    if (ids.size > 1) return null;
  }
  return null;
}

/** PGM or PRW, from the words inside one buffer's block. */
function blockRole(block) {
  for (const btn of block.querySelectorAll('button')) {
    const label = (btn.textContent || '').trim().toUpperCase();
    if (label === 'PGM' || label === 'PRW') return label;
  }
  const text = (block.textContent || '').trim().toUpperCase();
  if (text.startsWith('PGM')) return 'PGM';
  if (text.startsWith('PRW')) return 'PRW';
  return null;
}

function findPadlock(block) {
  for (const button of block.querySelectorAll('button')) {
    const shut = padlockState(button);
    if (shut != null) return { button, shut };
  }
  return null;
}

/**
 * Is `mode` locked on these destinations, and where?
 *
 * The answer per destination is the first of: that screen's own card, the
 * master pair, then **locked**. The last step is the one that matters — a
 * screen the operator has not got on screen is a screen whose guard rail we
 * cannot see, and treating that as open would mean the one case we cannot
 * check is also the one case we do not ask about.
 *
 * @param {string[]} ids destinations a send is about to touch
 * @param {'PROGRAM'|'PREVIEW'} mode
 * @returns {{locked: string[], reason: 'card'|'master'|'unknown'|null}}
 */
export function lockedFor(ids, mode, root = document) {
  const role = ROLE_LABEL[mode];
  /* A literal buffer letter is the operator naming a buffer rather than a
     role, and the vendor's locks are drawn per role. Nothing to check. */
  if (!role) return { locked: [], reason: null };

  const cards = readCardLocks(root);
  const master = readMasterLocks(root);
  const locked = [];
  let reason = null;

  for (const id of ids) {
    const onCard = cards[id] && cards[id][role];
    if (onCard != null) {
      if (onCard) { locked.push(id); reason = reason || 'card'; }
      continue;
    }
    if (master[role] != null) {
      if (master[role]) { locked.push(id); reason = reason || 'master'; }
      continue;
    }
    locked.push(id);
    reason = reason || 'unknown';
  }

  return { locked, reason: locked.length ? reason : null };
}
