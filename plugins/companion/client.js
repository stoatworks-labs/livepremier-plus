/*
 * Companion — the plugin's page half.
 *
 * One sidebar entry, and the panel behind it (`panel.js`). Everything the
 * panel asks of this app goes through `ctx` — its routes by `ctx.url`, its
 * settings by `ctx.settings`, the look of the rest of the app by `ctx.kit` —
 * so nothing here depends on where the app keeps its own files.
 *
 * And two ways the show reaches Companion without anybody opening the panel:
 *
 *  - **A cue can press a button.** A `cueAction` of kind `companion:press`,
 *    with a *Companion trigger* field the Timeline's editors draw for it —
 *    see `core/contributions.js` for `field`. Fired like any contributed
 *    action: alongside the recalls, ahead of the take, not awaited.
 *  - **A memory recall can press a button.** Every write this page sends is
 *    watched for a recall (`recallOf` in `core.js`), whichever part of the
 *    page sent it — the Memories panel, a cue, the Console, the vendor's own
 *    Memories tab — and the buttons set against that memory are pressed.
 *
 * Both press through the server (`POST /press`), not this page's own socket:
 * the page that fires a cue may never have opened the panel, and the server's
 * link is up whenever a Companion is set.
 *
 * ⚠️ A recall is only seen by the page that sent it. The front panel, a
 * Companion button that recalls through the AWJ module, and another browser
 * that is not going through this app all recall without a trigger firing.
 * That is also what stops two open pages pressing the button twice.
 */

import { createCompanionPanel } from './panel.js';
import { pickButton } from './surface.js';
import {
  EMPTY_TRIGGERS, PRESS_KIND, formatLocationList, locationKey, normaliseTriggers,
  parseLocationList, pressAction, recallOf, triggerKey,
} from './core.js';
import { dialectFor } from '../../src/core/dialect.js';

export default function activate(ctx) {
  const ui = ctx.url('/ui');

  async function press(locations) {
    const res = await fetch(ctx.url('/press'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `the launcher answered ${res.status}`);
    return body;
  }

  /* ------------------------------------------------------- memory triggers */

  let triggers = normaliseTriggers(EMPTY_TRIGGERS);
  const triggerListeners = new Set();
  const told = () => { for (const fn of triggerListeners) fn(triggers); };

  async function loadTriggers() {
    try {
      const res = await fetch(ctx.url('/triggers'), { cache: 'no-store' });
      if (res.ok) triggers = normaliseTriggers((await res.json()).data);
    } catch (err) {
      ctx.log.warn('could not load the Companion memory triggers', err);
    }
    told();
  }

  async function saveTriggers(next) {
    const data = normaliseTriggers(next);
    const res = await fetch(ctx.url('/triggers'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `the launcher answered ${res.status}`);
    triggers = normaliseTriggers(body.data);
    told();
    return triggers;
  }

  loadTriggers();

  /*
   * Watch what this page sends. `dir: 'out'` frames are this tab's own writes
   * — ours through `session.send`, and the vendor app's through its socket,
   * which the hook sees too (`transports/page-socket.js`).
   */
  const recent = new Map();
  ctx.session.addEventListener('frame', (ev) => {
    const frame = ev.detail;
    if (!frame || frame.dir !== 'out') return;
    const recall = recallOf(dialectFor(ctx.session.store), frame.path, frame.value);
    if (!recall) return;
    const key = triggerKey(recall.bank, recall.slot);
    const locations = triggers.memories[key];
    if (!locations || !locations.length) return;
    /* One recall onto several screens is several writes of the same slot in
       the same breath — a screen memory sent to S1 and S2. That is one recall
       as far as the show is concerned, and one press. */
    const now = Date.now();
    if (now - (recent.get(key) || 0) < 250) return;
    recent.set(key, now);
    press(locations).catch((err) => ctx.log.warn(`memory ${key} trigger: ${err.message}`));
  });

  /* ---------------------------------------------------------- cue action */

  const pick = ({ doc, current } = {}) => pickButton({
    kit: ctx.kit,
    ui,
    doc: doc || document,
    page: current && current[0] ? current[0].pageNumber : 1,
    current: current || [],
  });

  ctx.contribute('cueAction', {
    kind: PRESS_KIND,
    label: 'Companion',
    run: (action) => press([{ pageNumber: action.pageNumber, row: action.row, column: action.column }]),
    describe: (action) => `Companion ${locationKey(action)}`,
    field: {
      label: 'Companion trigger',
      placeholder: 'page/row/column, e.g. 1/0/3',
      hint: 'Buttons this cue presses in Companion, as it fires. Separate several with commas.',
      parse: (text) => parseLocationList(text).map(pressAction),
      format: (actions) => formatLocationList(actions),
      /* Resolves with the text for the field: the one chosen, added to what
         is there already. */
      async pick({ doc, text = '' } = {}) {
        let current = [];
        try { current = parseLocationList(text); } catch { /* choose afresh */ }
        const chosen = await pick({ doc, current });
        if (!chosen) return null;
        const keys = new Set(current.map(locationKey));
        return keys.has(locationKey(chosen)) ? formatLocationList(current) : formatLocationList([...current, chosen]);
      },
    },
  });

  /* ---------------------------------------------------------- the panel */

  const panel = createCompanionPanel({
    kit: ctx.kit,
    url: ctx.url,
    settings: ctx.settings,
    onRefresh: ctx.refresh,
    session: ctx.session,
    triggers: {
      get: () => triggers,
      save: saveTriggers,
      reload: loadTriggers,
      onChange: (fn) => { triggerListeners.add(fn); return () => triggerListeners.delete(fn); },
      test: (locations) => press(locations),
    },
    pick,
  });

  /* The Buttons window: the grid on a second monitor. */
  ctx.share({ kit: ctx.kit, ui });

  ctx.ui.sidebar({
    id: 'companion',
    label: 'Companion',
    icon: ['gpio-18', 'connector-gpio-18'],
    /*
     * In PLUS, after Matrix Routing — and the call was close enough to be
     * worth writing down. MIDI Mapping is anchored to the vendor's Virtual
     * RC400T because both are control surfaces, and a Companion is a control
     * surface too; by that argument this belongs there.
     *
     * Two things beat it. An anchored entry needs its vendor item to exist,
     * and Virtual RC400T is not on every platform, so anchoring would make
     * this quietly absent on a Midra 4K — which has just as much use for a
     * Companion. And half of this panel is not a surface at all: it is what is
     * in the show and what this app would add to it, which is a whole-rig
     * configuration view of exactly the kind the rest of that section holds.
     */
    order: 60,
    render: panel.render,
    busy: panel.busy,
  });
}
