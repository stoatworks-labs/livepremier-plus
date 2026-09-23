/*
 * Companion: the link to one, what it has in its show, and its own UI.
 *
 * ## Why this is a panel of ours and not a tab
 *
 * Same rule as the matrix: a Companion is installation-level furniture, not a
 * property of one screen. It goes on driving the show when the operator is
 * looking at Aux 3, and it does not change when the switcher is re-pointed at
 * a backup frame. So it sits in the sidebar beside the other whole-rig views
 * rather than on the Screens / Aux. strip.
 *
 * ## Companion's buttons, drawn in this app's own look
 *
 * Until 0.13 everything below the show was Companion's own web app in an
 * iframe — its Buttons, Web buttons and Emulator pages, served through the
 * mount. It worked, and it looked like somebody else's program pasted into
 * the switcher's. Now the grid is ours (`surface.js`): the page list and
 * the buttons, as Companion renders them, in the app's chrome, pressable, and
 * poppable onto a second monitor. The one thing still left to Companion is
 * *programming* a button — a large, fast-moving editor with its own release
 * cadence, which a copy here would only do worse — and that opens Companion's
 * own editor, through the same mount, in a window of its own.
 *
 * What this app adds is still the part Companion cannot do: knowing which
 * switcher you are pointed at, what belongs in the show because of it — and
 * now, which buttons a cue or a memory recall presses.
 *
 * ## Drawn in place
 *
 * Every other panel is rebuilt whole on each repaint, and the app repaints on
 * every frame the switcher sends — about once a second from its timers alone.
 * This one builds its frame once and returns the same element every time; the
 * parts that follow the link are refilled, and the button grid and the
 * trigger editor are left alone, so a button's image is only ever swapped in
 * place and a half-typed trigger survives a frame from the switcher. It
 * started with the iframe (Companion's editor reloaded every second it was
 * open, found 2026-09-22, on 0.12.0); the grid and the fields need it as much.
 * `ui/shell.js` leaves a panel alone when it hands back the element already
 * on screen.
 *
 * ## The plan is an offer, not a sync
 *
 * `core.js` sets out the rule this panel exists to present: an existing
 * connection is **adopted**, never rewritten, and two of the same module are
 * reported rather than resolved. An operator's show is theirs. The only button
 * here that writes anything says exactly what it will create before it creates
 * it.
 */

import { MODULES, formatLocationList, locationKey, parseLocationList, triggerKey } from './core.js';
import { createButtonGrid } from './surface.js';
import { dialectOrDefault } from '../../src/core/dialect.js';

/* The Buttons window, beside this file in the plugin's folder. */
const POPOUT = new URL('./popout.html', import.meta.url).href;

/* How often an off-screen grid is noticed and paused. Its subscriptions are a
   PNG per repaint per button, and nothing is looking at them. */
const VISIBILITY_MS = 1500;

/**
 * @param {object} o
 * @param {object} o.kit        the app's DOM helpers — `ctx.kit`
 * @param {(path: string) => string} o.url   this plugin's routes — `ctx.url`
 * @param {{get: Function, set: Function}} o.settings  this plugin's settings — `ctx.settings`
 * @param {() => void} [o.onRefresh]
 * @param {object} [o.session]   the live store mirror, for the memory banks' names
 * @param {object} [o.triggers]  the memory triggers — `client.js`
 * @param {(o: object) => Promise<object|null>} [o.pick]  the button chooser
 */
export function createCompanionPanel({ kit, url, settings, onRefresh, session = null, triggers = null, pick = null }) {
  const { h, button, readout, sectionTitle, panel, fill } = kit;
  const API = url('/');
  const UI = url('/ui');
  const repaint = () => { if (onRefresh) onRefresh(); };

  /* The last snapshot from our own process. Null until the first fetch lands,
     which is a different thing from "nothing configured" — the panel says
     which of those it is rather than showing an empty table that looks like
     an answer. */
  let data = null;
  let error = null;
  let busy = null;
  /* What the last write did, kept until the next one. A result that vanished
     on the next repaint would be a result nobody read. */
  let results = null;

  /* Draft state for the address form, kept out of `data` so a repaint driven
     by the link coming up does not wipe what somebody is halfway through
     typing. Null means "not editing" — the fields show what is stored. */
  let draft = null;
  /* Whether one of those fields has the caret. The app holds every repaint
     while it does (see `busy()` below): a repaint rebuilds the form, and a
     rebuilt field has lost the caret and whatever was selected in it. */
  let typing = false;
  let letGo = null;

  /* The live subscription, opened once the panel has been looked at. */
  let stream = null;

  async function load() {
    try {
      const res = await fetch(`${API}/state`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status}`);
      data = await res.json();
      error = data.error || null;
    } catch (err) {
      error = `Could not reach the launcher: ${err.message}`;
    }
    repaint();
  }

  /**
   * Follow the show rather than sampling it.
   *
   * The same argument the Matrix Routing panel (`plugins/matrix-routing/panel.js`) makes about a router, and here it
   * is sharper: Companion's own editor is one button away (Edit in
   * Companion), so the most likely way for this list to change is the
   * operator changing it in the window beside this one. A panel that only
   * refreshed when it was opened would contradict it.
   *
   * EventSource reconnects by itself, so a launcher restart heals without
   * anybody reloading Web RCS.
   */
  function listen() {
    if (stream) return;
    try {
      stream = new EventSource(`${API}/stream`);
      stream.addEventListener('show', (ev) => {
        try {
          const next = JSON.parse(ev.data);
          if (!data) return;
          data = { ...data, connections: next.connections, plan: next.plan, link: next.link };
          /* A write that has just reported itself is not stale news, but the
             show it reported on has moved since — so the results stay and the
             list under them updates. */
          repaint();
        } catch { /* a malformed frame is not worth taking the panel down */ }
      });
    } catch { /* no EventSource: the panel still works, just not live */ }
  }

  async function saveAddress(next) {
    busy = 'address';
    clearTimeout(letGo);
    typing = false;
    repaint();
    try {
      await settings.set(next);
      draft = null;
      error = null;
      /* The link is rebuilt by the server on this write, and dialling takes a
         moment. Re-reading immediately would report "not connected" about a
         socket that is halfway open, so the state comes back on the next
         look rather than now. */
      await load();
    } catch (err) {
      error = err.message;
    } finally {
      busy = null;
      repaint();
    }
  }

  async function addToShow(keys) {
    busy = 'add';
    results = null;
    repaint();
    try {
      const res = await fetch(`${API}/connections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) { error = payload.error || `${res.status}`; return; }
      error = null;
      results = payload.results || [];
      /* The server read the show back after writing it, so this is what is
         actually there rather than what we asked for. */
      if (payload.connections) data = { ...data, connections: payload.connections, plan: payload.plan };
    } catch (err) {
      error = err.message;
    } finally {
      busy = null;
      repaint();
    }
  }

  /* ------------------------------------------------------------------ */

  function addressForm() {
    const stored = data && data.link ? data.link : {};
    const current = draft || {
      companionEnabled: !!(data && data.settings ? data.settings.companionEnabled : stored.configured),
      companionHost: (data && data.settings && data.settings.companionHost) || '',
      companionPort: (data && data.settings && data.settings.companionPort) || 8000,
    };
    const edit = (patch) => { draft = { ...current, ...patch }; repaint(); };
    const focus = () => { clearTimeout(letGo); typing = true; };
    /* Let go a moment after the caret leaves rather than at once. Pressing
       Connect takes the caret off the field on mouse-down; a repaint landing
       before mouse-up would swap the button out from under the pointer, and
       the click would never arrive. */
    const blur = () => { clearTimeout(letGo); letGo = setTimeout(() => { typing = false; }, 400); };

    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
          h('input', {
            type: 'checkbox',
            checked: current.companionEnabled ? 'checked' : null,
            onChange: (ev) => edit({ companionEnabled: ev.target.checked }),
          }),
          h('span', { class: 'aw-font-body-2', text: 'Connect to a Companion' })),
      ),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        h('input', {
          type: 'text',
          class: 'wru-input',
          placeholder: 'address, e.g. 192.168.0.10',
          value: current.companionHost,
          style: { flex: '1 1 auto' },
          onFocus: focus,
          onBlur: blur,
          onInput: (ev) => { draft = { ...current, companionHost: ev.target.value }; },
        }),
        h('input', {
          type: 'text',
          class: 'wru-input wru-input--narrow',
          placeholder: '8000',
          value: String(current.companionPort),
          onFocus: focus,
          onBlur: blur,
          onInput: (ev) => { draft = { ...current, companionPort: Number(ev.target.value) || 0 }; },
        }),
        button(busy === 'address' ? 'Connecting…' : 'Connect', {
          variant: 'primary',
          disabled: busy === 'address',
          onClick: () => saveAddress(draft || current),
        })),
      /* Companion's own default is 8000, which is also this app's default OSC
         port. They do not collide — one is ours to listen on, the other is
         theirs to be dialled — but an operator who has changed one and not
         the other should not have to work that out from a failure. */
      h('div', { class: 'aw-font-caption aw-text-tertiary', text:
        'Companion serves its UI on 8000 unless it has been changed in its own settings.' }));
  }

  function linkState() {
    const link = (data && data.link) || {};
    if (!link.configured) {
      return h('div', { class: 'aw-font-body-2 aw-text-tertiary', text:
        'No Companion configured. Give it an address above.' });
    }
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium' },
      readout('Link', link.connected ? 'connected' : 'not connected',
        { tone: link.connected ? 'green' : 'red' }),
      link.version ? readout('Companion', 'v' + link.version) : null,
      link.error && !link.connected
        ? h('div', { class: 'wru-warn aw-font-caption', text: link.error })
        : null);
  }

  /**
   * What is in the show, and what this app would add to it.
   *
   * The two lists are deliberately not merged. "These are your connections"
   * and "this is what I would do" are different claims, and running them
   * together is how a tool ends up looking like it already did something.
   */
  function showSection() {
    if (!data || !data.link || !data.link.configured) return null;
    if (data.error) return h('div', { class: 'wru-warn', text: data.error });
    if (!data.connections) return h('div', { class: 'aw-font-body-2 aw-text-tertiary', text: 'Reading the show…' });

    const plan = data.plan || { add: [], adopt: [], ambiguous: [] };
    const known = new Set(Object.values(MODULES).map((m) => m.moduleId));

    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      sectionTitle('The show'),
      h('table', { class: 'wru-table' },
        h('thead', {}, h('tr', {},
          h('th', { text: 'Connection' }), h('th', { text: 'Module' }), h('th', { text: 'Status' }))),
        h('tbody', {}, data.connections.map((c) => h('tr', {
          /* Ours are marked so an operator can see at a glance which two of a
             long list this app has an opinion about. */
          class: known.has(c.moduleId) ? 'wru-row--active' : null,
        },
          h('td', { text: c.label }),
          h('td', { class: 'aw-text-tertiary', text: c.moduleId }),
          h('td', {
            class: c.status && c.status.category === 'good' ? '' : 'wru-warn',
            text: c.status ? (c.status.level || c.status.category || '') : (c.enabled ? '' : 'disabled'),
          }))))),
      planSection(plan),
      resultsSection());
  }

  function planSection(plan) {
    const parts = [];

    for (const { spec, connections } of plan.ambiguous) {
      /* Reported, never resolved. A show with a main and a backup frame is a
         correct show, and picking one of them by sort order would be picking
         at random. */
      parts.push(h('div', { class: 'wru-warn aw-font-body-2', text:
        `${connections.length} connections use ${spec.moduleId}. Point this app at one by hand — it will not choose for you.` }));
    }

    for (const { spec, connection } of plan.adopt) {
      parts.push(h('div', { class: 'aw-font-body-2 aw-text-tertiary', text:
        `Using the existing “${connection.label}” for ${spec.label}. Its settings are left alone.` }));
    }

    if (plan.add.length) {
      const facts = (data && data.facts) || {};
      parts.push(h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        h('div', { class: 'aw-font-body-2', text: 'Not in the show yet:' }),
        h('ul', { class: 'wru-warnings' }, plan.add.map(({ key, spec }) => h('li', {},
          h('span', { class: 'aw-font-body-2-bold', text: spec.label }),
          h('span', { class: 'aw-text-tertiary', text: ` — ${spec.what}` }),
          h('div', { class: 'aw-font-caption aw-text-tertiary', text: pointedAt(key, facts) })))),
        /* The warning that saves the most time, because the failure it
           prevents looks like a Companion bug rather than a mistake. */
        facts.selfIsLoopback && plan.add.some((a) => a.key === 'lpp')
          ? h('div', { class: 'wru-warn aw-font-caption', text:
              'This page reached the launcher on 127.0.0.1, so that is the address the LivePremier Plus '
              + 'connection would be given. A Companion on another machine cannot dial it. Open this app '
              + 'by its network address first if Companion is not on this machine.' })
          : null,
        h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
          button(busy === 'add' ? 'Adding…' : `Add ${plan.add.length === 1 ? 'it' : 'both'} to the show`, {
            variant: 'primary',
            disabled: busy === 'add' || !(data.link && data.link.connected),
            onClick: () => addToShow(plan.add.map((a) => a.key)),
          }),
          plan.add.length > 1
            ? plan.add.map(({ key, spec }) => button(`Only ${spec.label}`, {
                disabled: busy === 'add' || !(data.link && data.link.connected),
                onClick: () => addToShow([key]),
              }))
            : null)));
    } else if (!plan.ambiguous.length) {
      parts.push(h('div', { class: 'aw-font-body-2', text: 'Both connections are in the show.' }));
    }

    return parts.length ? h('div', { class: 'aw-flex-col aw-gap-row-small' }, parts) : null;
  }

  /** One line saying where a connection would be pointed, before it is made. */
  function pointedAt(key, facts) {
    if (key === 'awj') {
      return facts.device
        ? `Will be pointed at the switcher, ${facts.device}.`
        : 'No switcher chosen yet — it would be added unpointed.';
    }
    return facts.selfHost
      ? `Will be pointed back at this app, ${facts.selfHost}:${facts.selfPort}.`
      : 'This app could not work out its own address — it would be added unpointed.';
  }

  function resultsSection() {
    if (!results || !results.length) return null;
    return h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('ul', { class: 'wru-warnings' }, results.map((r) => {
        const spec = MODULES[r.key];
        const name = spec ? spec.label : r.key;
        if (!r.ok) return h('li', { class: 'wru-warn', text: `${name}: ${r.note || 'could not be added'}` });
        if (r.note) return h('li', { class: 'wru-warn', text: `${name}: ${r.note}` });
        return h('li', { text: `${name}: added${r.configured ? ' and pointed' : ''}.` });
      })));
  }

  /* ------------------------------------------------------ memory triggers */

  /*
   * Which buttons each memory recall presses.
   *
   * Drawn into a host of its own, redrawn when the triggers change or the
   * operator does something here — never by a frame from the switcher, which
   * would take the half-typed slot number with it.
   */
  const trig = { bank: null, slot: '', buttons: '', note: null, busy: false };

  function banks() {
    const store = session ? session.store : null;
    return dialectOrDefault(store).banks;
  }

  function drawTriggers() {
    if (!triggersHost) return;
    if (!triggers) { fill(triggersHost); return; }
    const all = banks();
    if (!trig.bank || !all.some((b) => b.kind === trig.bank)) trig.bank = (all.find((b) => b.kind === 'screen') || all[0]).kind;
    const current = triggers.get();
    const entries = Object.entries(current.memories)
      .map(([key, locations]) => {
        const [bank, slot] = key.split(':');
        return { key, bank, slot: Number(slot), locations };
      })
      .sort((a, b) => a.bank.localeCompare(b.bank) || a.slot - b.slot);
    const bankLabel = (kind) => (all.find((b) => b.kind === kind) || { label: kind }).label;

    const save = async (next, note) => {
      trig.busy = true;
      trig.note = null;
      drawTriggers();
      try {
        await triggers.save(next);
        trig.note = note ? { tone: 'ok', text: note } : null;
        return true;
      } catch (err) {
        trig.note = { tone: 'warn', text: err.message };
        return false;
      } finally {
        trig.busy = false;
        drawTriggers();
      }
    };

    const remove = (key) => {
      const memories = { ...triggers.get().memories };
      delete memories[key];
      save({ version: 1, memories });
    };

    const test = async (locations) => {
      try {
        await triggers.test(locations);
        trig.note = { tone: 'ok', text: `Pressed ${formatLocationList(locations)}.` };
      } catch (err) {
        trig.note = { tone: 'warn', text: err.message };
      }
      drawTriggers();
    };

    const bankSelect = h('select', {
      class: 'wru-input',
      style: { width: 'auto', flex: '0 0 auto' },
      onChange: (ev) => { trig.bank = ev.target.value; },
    }, all.map((b) => {
      const opt = h('option', { value: b.kind, text: b.label });
      if (b.kind === trig.bank) opt.selected = true;
      return opt;
    }));
    const slotInput = h('input', {
      type: 'number', min: '1', class: 'wru-input wru-input--narrow', placeholder: 'slot',
      style: { width: '5rem', flex: '0 0 auto' },
      value: trig.slot, onInput: (ev) => { trig.slot = ev.target.value; },
    });
    const buttonsInput = h('input', {
      type: 'text', class: 'wru-input', placeholder: 'page/row/column, e.g. 1/0/3',
      value: trig.buttons, spellcheck: 'false', style: { flex: '1 1 10rem' },
      onInput: (ev) => { trig.buttons = ev.target.value; },
    });

    const add = async () => {
      const slot = Number(trig.slot);
      if (!Number.isInteger(slot) || slot < 1) { trig.note = { tone: 'warn', text: 'Give the memory’s slot number.' }; return drawTriggers(); }
      let locations;
      try { locations = parseLocationList(trig.buttons); } catch (err) { trig.note = { tone: 'warn', text: err.message }; return drawTriggers(); }
      if (!locations.length) { trig.note = { tone: 'warn', text: 'Choose at least one button.' }; return drawTriggers(); }
      const key = triggerKey(trig.bank, slot);
      const ok = await save({ version: 1, memories: { ...triggers.get().memories, [key]: locations } },
        `${bankLabel(trig.bank)} memory ${slot} now presses ${formatLocationList(locations)}.`);
      if (ok) { trig.slot = ''; trig.buttons = ''; drawTriggers(); }
    };

    fill(triggersHost,
      sectionTitle('Memory triggers'),
      h('div', { class: 'aw-font-caption aw-text-tertiary', text:
        'Press Companion buttons whenever a memory is recalled from this page — from Memories, a cue, the '
        + 'Console or the vendor’s own Memories tab. A recall from the front panel or another program is '
        + 'not seen here, and presses nothing.' }),
      entries.length
        ? h('table', { class: 'wru-table' },
          h('thead', {}, h('tr', {}, h('th', { text: 'Memory' }), h('th', { text: 'Presses' }), h('th', {}))),
          h('tbody', {}, entries.map((e) => h('tr', {},
            h('td', { text: `${bankLabel(e.bank)} ${e.slot}` }),
            h('td', { class: 'wru-cue-number', text: formatLocationList(e.locations) }),
            h('td', {}, h('div', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
              button('Test', { variant: 'ghost', title: 'Press these buttons now', disabled: trig.busy, onClick: () => test(e.locations) }),
              button('Edit', { variant: 'ghost', disabled: trig.busy, onClick: () => {
                trig.bank = e.bank; trig.slot = String(e.slot); trig.buttons = formatLocationList(e.locations); drawTriggers();
              } }),
              button('×', { variant: 'ghost', title: 'Remove this trigger', disabled: trig.busy, onClick: () => remove(e.key) })))))))
        : h('div', { class: 'aw-font-body-2 aw-text-tertiary', text: 'No memory presses anything yet.' }),
      h('div', { class: 'aw-flex-row-center-v aw-flex-wrap aw-gap-col-small aw-gap-row-small' },
        bankSelect, slotInput, buttonsInput,
        pick ? button('Choose…', {
          title: 'Choose the button from Companion’s grid',
          disabled: !(data && data.link && data.link.connected),
          onClick: async () => {
            let current = [];
            try { current = parseLocationList(trig.buttons); } catch { /* choose afresh */ }
            const chosen = await pick({ current });
            if (!chosen) return;
            trig.buttons = formatLocationList([...current.filter((l) => locationKey(l) !== locationKey(chosen)), chosen]);
            drawTriggers();
          },
        }) : null,
        button(trig.busy ? 'Saving…' : 'Set', { variant: 'primary', disabled: trig.busy, onClick: add })),
      trig.note ? h('div', { class: ['aw-font-caption', trig.note.tone === 'warn' ? 'wru-warn' : 'aw-text-tertiary'], text: trig.note.text }) : null);
  }

  /* ---------------------------------------------------------- the frame */

  /*
   * Built once and kept. `head` and `top` are refilled on every repaint; the
   * buttons section is rebuilt only when the link comes or goes, and the
   * trigger editor only when it has something new to say.
   */
  let root = null;
  let head = null;
  let top = null;
  let buttonsHost = null;
  let triggersHost = null;
  /* The live grid while a Companion is connected, and the link state it was
     built for. */
  let grid = null;
  let gridFor = null;
  let watcher = null;
  let gridNote = null;
  let triggersDrawnFor = null;

  function frame() {
    if (root) return;
    head = h('div', { style: { display: 'contents' } });
    top = h('div', { class: 'aw-flex-col aw-gap-row-medium' });
    buttonsHost = h('div', { class: 'aw-flex-col aw-gap-row-small' });
    triggersHost = h('div', { class: 'aw-flex-col aw-gap-row-small' });
    root = panel({ toolbar: head, body: h('div', { class: 'aw-flex-col aw-gap-row-large' }, top, buttonsHost, triggersHost) });
    if (triggers) triggers.onChange(() => drawTriggers());
    drawTriggers();
  }

  function popOut() {
    const w = window.open(POPOUT, 'lpp-companion-buttons', 'popup,width=900,height=560');
    if (w) w.focus();
  }

  function openEditor() {
    const w = window.open(UI + '/buttons', 'lpp-companion-editor');
    if (w) w.focus();
  }

  /**
   * The button grid: built when the link comes up, taken down when it goes,
   * and paused whenever the panel is off screen.
   */
  function syncButtons() {
    const link = (data && data.link) || {};
    const want = link.configured ? (link.connected ? 'live' : 'down') : 'none';
    if (want === gridFor) {
      if (grid) grid.resume();
      return;
    }
    gridFor = want;
    if (grid) { grid.dispose(); grid = null; }

    if (want === 'none') { fill(buttonsHost); return; }
    if (want === 'down') {
      fill(buttonsHost, sectionTitle('Buttons'),
        h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'Connect to a Companion to show its buttons here.' }));
      return;
    }

    gridNote = h('div', { class: 'aw-font-caption wru-warn' });
    grid = createButtonGrid({
      kit, ui: UI, mode: 'press',
      onError: (msg) => { gridNote.textContent = msg; },
    });
    fill(buttonsHost,
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        sectionTitle('Buttons'),
        h('div', { style: { flex: '1' } }),
        button('Pop out', { variant: 'ghost', title: 'Open the buttons in a window of their own', onClick: popOut }),
        button('Edit in Companion', { variant: 'ghost', title: 'Programme buttons in Companion’s own editor, in a new window', onClick: openEditor })),
      grid.el,
      gridNote);

    /* Pause the grid's subscriptions while it is off screen, and let the next
       render resume them. Checked on a timer rather than observed: the shell
       swaps panels by replacing a subtree, and a MutationObserver over the
       whole page to catch that would cost more than this does. */
    if (!watcher) {
      watcher = setInterval(() => {
        if (grid && grid.running && !grid.el.isConnected) grid.pause();
      }, VISIBILITY_MS);
    }
  }

  function render() {
    if (!data && !error) load();
    /* Opened once, on the first look. Not at module load: a subscription to
       a Companion nobody has asked about yet is a socket held open for a
       panel that may never be opened this show. */
    listen();
    frame();

    fill(head, sectionTitle('Companion',
      data && data.link && data.link.connected
        ? h('span', { class: 'aw-font-caption aw-text-tertiary', text: 'connected' })
        : null));
    fill(top,
      error ? h('div', { class: 'wru-warn', text: error }) : null,
      h('div', { class: 'aw-flex-col aw-gap-row-small' },
        addressForm(),
        linkState()),
      showSection());
    syncButtons();
    /* The trigger editor's chooser needs the link; redraw it when that
       changes, and only then. */
    const connected = !!(data && data.link && data.link.connected);
    if (connected !== triggersDrawnFor) { triggersDrawnFor = connected; drawTriggers(); }
    return root;
  }

  return {
    render,
    reload: load,
    /* True while an address field has the caret; the app holds repaints. */
    busy: () => typing,
  };
}
