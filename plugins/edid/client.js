/*
 * EDID builder — the plugin's page half.
 *
 * The Otter EDID editor, brought to the switcher's EDID bank. Three places:
 *
 *   - **From Formats**, a third tab on the EDID page beside Default EDIDS and
 *     EDID Bank: one EDID per custom format in Setup ▸ Formats, built as the
 *     formats change, each marked with the slot that already holds it — and,
 *     switched on, the bank kept filled with them automatically.
 *   - **Create EDID…** on the same strip: the whole Otter editor in a window
 *     of its own, saving straight into a bank slot.
 *   - **Edit** on each filled bank slot: the same window, opened on that slot.
 *
 * The editor is Otter's, vendored whole (`src/vendor/otter-edid-embed.js`),
 * so this app and the website cannot reach different EDIDs for the same mode.
 * Its stylesheet styles `body`, which is why it only ever lives in the popout
 * and never in the Web RCS page.
 *
 * What the popout needs it gets from `ctx.share`: the bank, the formats, and a
 * `save` that posts through this tab — the window opens no connection of its
 * own, like every popout here.
 */

import {
  SAVE_URL, readSlots, readFormats, savePayload, deleteCommand, slotHolding, slotCarrying, firstFree, formatEdidName
} from './bank.js';
import { installEdidPage } from './page.js';

const WATCHED = [['device', 'system', 'edid', 'bankList'], ['device', 'customFormats', 'bankList']];
const touches = (path) => Array.isArray(path) && WATCHED.some((w) => w.every((k, i) => path[i] === k));

export default function activate(ctx) {
  const { session } = ctx;

  /* ---------------------------------------------------------- the editor */

  let otter = null;
  /** Otter's module, imported the first time something needs it — 430 kB is not worth loading on every page. */
  const loadOtter = () => (otter = otter || import('../../src/vendor/otter-edid-embed.js'));

  /* ------------------------------------------------------ bank and formats */

  const listeners = new Set();
  let queued = false;
  const changed = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      for (const fn of [...listeners]) { try { fn(); } catch (err) { ctx.log.warn(err); } }
    }, 150);
  };
  session.addEventListener('frame', (ev) => { if (touches(ev.detail && ev.detail.path)) changed(); });
  session.addEventListener('state', changed);
  session.store.addEventListener && session.store.addEventListener('ready', changed);

  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const slots = () => readSlots(session.store);

  /**
   * Write a slot the way Web RCS does, and resolve only once the switcher says
   * the slot holds these bytes. The `200 OK` means the request was taken, not
   * that the bank changed; the socket's echo is the truth here as everywhere.
   */
  async function save(slotId, bytes) {
    const body = savePayload(slotId, bytes);
    const res = await fetch(SAVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`the switcher refused ED${slotId}: ${res.status}${text ? ` ${text.slice(0, 120)}` : ''}`);
    }
    const landed = () => {
      const s = slots().find((x) => x.id === String(slotId));
      return s && s.bytes && slotHolding([s], bytes);
    };
    if (landed()) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error(`ED${slotId} did not change — the switcher took the request but has not reported the new EDID`)); }, 6000);
      const stop = subscribe(() => { if (landed()) { clearTimeout(timer); stop(); resolve(); } });
    });
  }

  const remove = (slotId) => session.send(deleteCommand(slotId));

  /**
   * One EDID per valid custom format, built by Otter from the format's exact
   * timing. `inBank` is the slot already holding exactly those bytes.
   */
  async function formatEdids() {
    const lib = await loadOtter();
    const bank = slots();
    /* Each slot decoded once per pass, not once per format. */
    const read = new Map();
    const describe = (bytes) => {
      const key = bytes.join(',');
      if (!read.has(key)) read.set(key, lib.describeEdid(bytes));
      return read.get(key);
    };
    return readFormats(session.store).map((f) => {
      try {
        const label = lib.timingLabel(f.timing);
        const built = lib.edidForTiming(f.timing, { name: formatEdidName(f, label) });
        const inBank = slotHolding(bank, built.bytes);
        /* `carried`: a slot whose EDID has this format as its preferred mode,
           though not these exact bytes — the one built for it, edited. */
        const carried = inBank || slotCarrying(bank, f.timing, describe);
        return { ...f, mode: label, vic: built.vic, edidName: built.name, bytes: built.bytes, notes: built.notes, inBank, carried, error: null };
      } catch (err) {
        return { ...f, mode: '', bytes: null, inBank: null, carried: null, error: err.message };
      }
    });
  }

  /* ------------------------------------------------------------ the popout */

  /* What the next popout opens on. One window, reused: a second Create or
     Edit navigates it rather than stacking windows. */
  let pending = null;
  function openEditor(initial = null) {
    pending = initial;
    const url = new URL('./popout.html', import.meta.url);
    const win = window.open(url, 'lpp-edid-editor', 'popup,width=1480,height=940');
    if (win) win.focus();
    return win;
  }

  /* How the editor's panels name the host: "Save to the switcher", "Apply to
     the switcher's inputs". Not the platform's model — that is an internal id
     (NLC_CMAX), not what the vendor's header calls the box. */
  const title = () => 'the switcher';

  ctx.share({
    title,
    slots,
    subscribe,
    save,
    remove,
    loadOtter,
    /** The `edid-mosaic` service — a mosaic's tiles onto input plugs — or null while nobody provides it. */
    mosaic: () => ctx.use('edid-mosaic'),
    /** What the window was opened for — handed over once. */
    takeInitial: () => { const i = pending; pending = null; return i; }
  });

  /* -------------------------------------------------------- automatic fill */

  /*
   * With "Keep the bank filled" on, every valid custom format with no slot
   * carrying its mode gets an EDID — the first empty slot, never a filled one,
   * never a protected one. "Carrying", not "holding these bytes": an EDID the
   * operator opened from here and edited still has the format as its
   * preferred mode, and adding a pristine copy beside it would quietly undo
   * the edit's point. It does not delete: a format that changes leaves
   * its old EDID where it was, because a slot an input is using is not this
   * plugin's to take away.
   *
   * Run from the page because the page has the store; the server keeps no
   * mirror (AGENTS.md, "Ride the app's socket"). Two tabs with it on can both
   * reach for the same empty slot; each re-reads the bank before every write,
   * and a slot that has meanwhile filled with the same bytes is simply found.
   */
  let filling = false;
  let lastFill = { at: 0, text: '' };
  /* A message replaces the last only when it says something different, or a
     full bank would be "new" on every run — see the `finally` below. */
  const report = (text) => { if (text !== lastFill.text) lastFill = { at: Date.now(), text }; };
  async function autoFill() {
    if (filling || !ctx.settings.get().autoFill || !session.store.ready) return;
    filling = true;
    const before = lastFill;
    const wrote = [];
    try {
      const wanted = (await formatEdids()).filter((f) => f.bytes && !f.carried);
      for (const f of wanted) {
        const bank = slots();
        if (slotHolding(bank, f.bytes)) continue;
        const free = firstFree(bank);
        if (!free) { report('The EDID bank is full.'); break; }
        await save(free.id, f.bytes);
        wrote.push(`${f.label} → ${free.label}`);
      }
      if (wrote.length) report(`Added ${wrote.join(', ')}.`);
    } catch (err) {
      report(`Could not fill the bank: ${err.message}`);
      ctx.log.warn('auto-fill', err);
    } finally {
      filling = false;
      /* Only when there is something new to show. This runs on every change
         notice, so announcing a run that did nothing would schedule the next
         one — a loop every 150 ms for as long as the switch is on. */
      if (lastFill !== before) changed();
    }
  }
  subscribe(() => { autoFill(); });

  const setAutoFill = async (on) => {
    await ctx.settings.set({ autoFill: !!on });
    changed();
    if (on) autoFill();
  };

  installEdidPage({
    session,
    enabled: () => ctx.can('edidBank'),
    subscribe,
    slots,
    formatEdids,
    save,
    openEditor,
    autoFill: () => ({ on: !!ctx.settings.get().autoFill, busy: filling, last: lastFill }),
    setAutoFill
  });
}
