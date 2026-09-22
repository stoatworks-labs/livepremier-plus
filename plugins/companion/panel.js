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
 * ## Why the embedded UI is an iframe, and why that is not a cop-out
 *
 * Everything below `Buttons` is Companion's own web app, served through this
 * app's proxy at `/__lpp/companion/ui` and therefore **on this origin**. That
 * is worth being precise about, because "we embedded their web page" usually
 * means something worse than this does:
 *
 * - It is not a remote page in a box. Companion supports being served under a
 *   sub-path, so every URL it emits — assets, API, its own WebSocket — already
 *   points back through us. No mixed content, no CORS, no second port.
 * - It is **the real thing**, not a reimplementation. The button editor is a
 *   large, fast-moving piece of somebody else's software with its own release
 *   cadence. Redrawing it here would be a permanent maintenance tax on a UI
 *   nobody on this side controls, and it would be worse at the job.
 * - What this app adds is the part Companion cannot do: knowing which
 *   switcher you are pointed at, and what belongs in the show because of it.
 *
 * So the panel is ours where it has something to say — the link, the plan,
 * the two connections — and theirs where they are better at it.
 *
 * ## Drawn in place, because of the iframe
 *
 * Every other panel is rebuilt whole on each repaint, and the app repaints on
 * every frame the switcher sends — about once a second from its timers alone.
 * Rebuilt whole, this panel took the iframe with it: Companion's editor
 * reloaded every second it was open, and anything half-done in it was lost
 * (found 2026-09-22, on 0.12.0). So this panel builds its frame once and
 * returns the same element every time; each repaint refills the parts that
 * change, and the iframe is replaced only when the operator picks another
 * view. `ui/shell.js` leaves a panel alone when it hands back the element
 * already on screen.
 *
 * ## The plan is an offer, not a sync
 *
 * `core.js` sets out the rule this panel exists to present: an existing
 * connection is **adopted**, never rewritten, and two of the same module are
 * reported rather than resolved. An operator's show is theirs. The only button
 * here that writes anything says exactly what it will create before it creates
 * it.
 */

import { MODULES } from './core.js';

/**
 * The pages of Companion's own UI worth reaching from here.
 *
 * Deliberately short. This is not a second navigation for the whole of
 * Companion — an operator who wants Triggers has Companion open. These are
 * the three an operator wants *while looking at the switcher*: the buttons
 * they are programming, the buttons they are pressing, and a surface to press
 * them on.
 */
const VIEWS = [
  { id: 'buttons', label: 'Buttons', path: '/buttons', what: 'Programme the page — the real button editor.' },
  { id: 'web', label: 'Web buttons', path: '/tablet', what: 'The touch surface, as a tablet would see it.' },
  { id: 'emulator', label: 'Emulator', path: '/emulator', what: 'A Stream Deck on screen.' },
];

/**
 * @param {object} o
 * @param {object} o.kit        the app's DOM helpers — `ctx.kit`
 * @param {(path: string) => string} o.url   this plugin's routes — `ctx.url`
 * @param {{get: Function, set: Function}} o.settings  this plugin's settings — `ctx.settings`
 * @param {() => void} [o.onRefresh]
 */
export function createCompanionPanel({ kit, url, settings, onRefresh }) {
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

  /* Which of Companion's own pages is showing, and nothing until the operator
     asks. An iframe that mounted itself on first paint would have Companion's
     whole web app booting behind a panel nobody had opened yet. */
  let view = null;

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
   * The same argument `ui/matrix-panel.js` makes about a router, and here it
   * is sharper: Companion's own Connections page is embedded a few lines
   * below, so the most likely way for this list to change is the operator
   * changing it inside our own iframe. A panel that only refreshed when it
   * was opened would contradict the page sitting underneath it.
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

  /* ---------------------------------------------------------- the frame */

  /*
   * Built once and kept. `head` and `top` are refilled on every repaint; the
   * embedded section is built when a Companion is first configured, and its
   * iframe is replaced only when the chosen view changes. Refilling a parent
   * of the iframe would detach it, and a detached iframe reloads.
   */
  let root = null;
  let head = null;
  let top = null;
  let embed = null;
  /* The embedded section's parts, while a Companion is configured. */
  let parts = null;
  /* The view whose iframe is in `parts.body` now: undefined for none yet,
     null for the "pick a view" caption. */
  let shown;

  function frame() {
    if (root) return;
    head = h('div', { style: { display: 'contents' } });
    top = h('div', { class: 'aw-flex-col aw-gap-row-medium' });
    embed = h('div', { class: 'aw-flex-col aw-gap-row-small' });
    root = panel({ toolbar: head, body: h('div', { class: 'aw-flex-col aw-gap-row-medium' }, top, embed) });
  }

  /**
   * Companion's own pages, on this origin.
   *
   * The iframe is rebuilt when the view changes rather than having its `src`
   * reassigned, so going back to a view is a fresh load rather than a history
   * entry in a frame nobody can navigate.
   */
  function syncEmbed() {
    const link = (data && data.link) || {};
    if (!link.configured) {
      if (parts) { fill(embed); parts = null; shown = undefined; }
      return;
    }
    if (!parts) {
      parts = { tabs: h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' }), body: h('div') };
      fill(embed, sectionTitle('Companion'), parts.tabs, parts.body);
      shown = undefined;
    }

    fill(parts.tabs,
      VIEWS.map((v) => button(v.label, {
        active: view === v.id,
        title: v.what,
        disabled: !link.connected,
        onClick: () => { view = view === v.id ? null : v.id; repaint(); },
      })),
      view ? button('Close', { onClick: () => { view = null; repaint(); } }) : null);

    const chosen = VIEWS.find((v) => v.id === view);
    if (chosen) {
      if (shown !== chosen.id) {
        fill(parts.body, h('iframe', {
          src: UI + chosen.path,
          /* Tall enough to be usable and not so tall that the panel's own
             controls are pushed off the top on a laptop. */
          style: {
            width: '100%', height: '32rem', border: '0',
            borderRadius: '0.25rem', background: '#1c2226',
          },
          title: `Companion — ${chosen.label}`,
        }));
        shown = chosen.id;
      }
    } else {
      fill(parts.body, h('div', { class: 'aw-font-caption aw-text-tertiary', text:
        link.connected
          ? 'Pick a view to open Companion here. It runs on this app’s own address, so it needs nothing extra opened up.'
          : 'Connect to a Companion to open its pages here.' }));
      shown = null;
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
    syncEmbed();
    return root;
  }

  return {
    render,
    reload: load,
    /* True while an address field has the caret; the app holds repaints. */
    busy: () => typing,
  };
}
