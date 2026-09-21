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
 * ⚠️ The `h2` naming it reads `S1` on LivePremier, which is this app's own
 * spelling for a destination and so needs no translation. That has not been
 * checked on a Midra 4K, where screens are numbered `1`..`4` in the store;
 * if that page names its cards some other way they simply do not match here
 * and the master pair answers instead, which is the safe direction to be
 * wrong in.
 */
export function readCardLocks(root = document) {
  const out = {};
  for (const card of root.querySelectorAll('.aw-preset-view')) {
    const heading = card.querySelector('h2');
    const id = heading && (heading.textContent || '').trim().toUpperCase();
    if (!id || !/^[SA]\d+$/.test(id)) continue;

    const blocks = [...card.querySelectorAll(PRESET_BLOCK)];
    if (blocks.length) {
      for (const block of blocks) {
        const role = blockRole(block);
        const shut = findPadlock(block);
        if (role && shut != null) (out[id] || (out[id] = {}))[role] = shut;
      }
      continue;
    }

    /* No hashed block to split the card by. Take the padlocks in the order
       they are drawn — program above preview, which is how every Web RCS
       build has laid a screen card out — rather than abandoning the card. */
    const locks = [...card.querySelectorAll('button')].map(padlockState).filter((s) => s != null);
    if (locks.length === 2) out[id] = { PGM: locks[0], PRW: locks[1] };
  }
  return out;
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
  for (const btn of block.querySelectorAll('button')) {
    const shut = padlockState(btn);
    if (shut != null) return shut;
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
