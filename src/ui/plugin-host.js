/*
 * The plugin host — the page half.
 *
 * Loads the page half of every plugin the server says is on, and gives each a
 * `ctx` to put itself on the page with: an entry in the sidebar, a tab on the
 * Screens / Aux. strip, its settings, the live session. What a plugin
 * registers is handed back to `main.js`, which puts it beside the app's own
 * entries in the order their `order` asks for — so a plugin's entry lands
 * exactly where a hand-wired one would have, and cannot tell the difference.
 *
 * ## Why switching a plugin applies on the next load, here
 *
 * The server half of a switch is live (`server/plugin-host.js`). This half is
 * not, on purpose: a page whose sidebar grew and lost entries under an
 * operator's pointer mid-show would be worse than a reload, and the settings
 * page says so beside the switch. So the list is read once, at boot.
 *
 * ## Isolation
 *
 * A plugin whose page half will not import, or throws while it starts, is
 * logged and left out; nothing it registered before it threw is kept. The rest
 * of the app — and the vendor's own interface above all — must come up whether
 * or not any plugin does.
 *
 * ## The kit
 *
 * `ctx.kit` is the app's own small set of DOM helpers — the same `h`,
 * `button` and `panel` every built-in panel is drawn with — so a plugin looks
 * like the rest of the app without importing files by path. What is in the kit
 * is the stable surface; a plugin that reaches past it into `/__lpp/src/…` is
 * depending on something that can move.
 */

import { h, button, readout, sectionTitle, fill, icon, card, note, picker } from './dom.js';
import { panel } from './shell.js';

const TAG = '[LivePremier Plus]';

/** The DOM helpers a plugin draws with. Frozen: a plugin cannot swap one out from under another. */
export const KIT = Object.freeze({ h, button, readout, sectionTitle, fill, icon, panel, card, note, picker });

/**
 * Load the page halves of the plugins that are on.
 *
 * @param {object} o
 * @param {object} o.session     the store mirror, `{store, send}`
 * @param {() => object} o.platform
 * @param {(cap: string) => boolean} o.can
 * @param {() => void} o.refresh ask for a repaint of whatever of ours is on screen
 * @param {object} o.settings    the settings as `/__lpp/settings` returned them at boot
 * @param {typeof fetch} [o.fetch]
 * @param {(url: string) => Promise<object>} [o.load]  how a module is imported; tests stub it
 * @param {Console} [o.log]
 * @returns {Promise<{sidebar: object[], tabs: object[], settings: object[], busy: () => boolean, loaded: string[], failed: object[]}>}
 */
export async function loadPlugins({
  session, platform, can, refresh, settings,
  fetch: get = (...a) => fetch(...a),
  load = (url) => import(url),
  log = console
}) {
  const sidebar = [];
  const tabs = [];
  const sections = [];
  const busy = [];
  const loaded = [];
  const failed = [];

  let list = [];
  try {
    const res = await get('/__lpp/plugins', { cache: 'no-store' });
    if (res.ok) list = (await res.json()).plugins || [];
  } catch (err) {
    log.warn(TAG, 'could not list plugins', err);
  }

  /* Each plugin's settings as the page last saw them, kept here so `set` can
     answer with what the server actually stored. */
  const stored = { ...(settings && settings.plugins ? settings.plugins : {}) };

  for (const p of list) {
    if (!p.on || !p.client) continue;

    let mod;
    try {
      mod = await load(p.client);
    } catch (err) {
      failed.push({ id: p.id, error: `its page half would not load: ${err.message}` });
      log.warn(TAG, `plugin ${p.id}: its page half would not load`, err);
      continue;
    }
    if (!mod || typeof mod.default !== 'function') {
      failed.push({ id: p.id, error: 'its page half exports no activate function' });
      log.warn(TAG, `plugin ${p.id}: its page half exports no activate function`);
      continue;
    }

    /* Registered into scratch lists first and kept only if activation
       finishes: a plugin that throws halfway must not leave half an entry. */
    const mine = { sidebar: [], tabs: [], sections: [], busy: [] };
    const needs = (p.requires && p.requires.capabilities) || [];
    /* An entry is offered only where the switcher can do what the plugin
       said it needs — the same rule every built-in entry follows — and then
       only where the plugin's own `enabled` agrees. */
    const gate = (entry) => ({
      ...entry,
      enabled: () => needs.every((cap) => can(cap)) && (entry.enabled ? entry.enabled() !== false : true)
    });

    const ctx = Object.freeze({
      id: p.id,
      manifest: p,
      session,
      platform,
      can,
      refresh,
      kit: KIT,
      log: {
        info: (...a) => log.info(TAG, `${p.id}:`, ...a),
        warn: (...a) => log.warn(TAG, `${p.id}:`, ...a)
      },

      /** Where one of this plugin's routes is: `ctx.url('/state')` is `/__lpp/<id>/state`. */
      url: (path = '/') => `${p.base}${path === '/' ? '' : path}`,

      settings: Object.freeze({
        /** This plugin's settings, as the server normalised them. */
        get: () => ({ ...((stored[p.id] && stored[p.id].settings) || {}) }),
        /**
         * Save some of them. Resolves with the settings as stored — which may
         * not be what was sent, if the plugin's schema corrected a field.
         */
        async set(patch) {
          const res = await get('/__lpp/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plugins: { [p.id]: { settings: patch } } })
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `settings were not saved (${res.status})`);
          const next = body.settings && body.settings.plugins ? body.settings.plugins : {};
          Object.assign(stored, next);
          return { ...((stored[p.id] && stored[p.id].settings) || {}) };
        }
      }),

      ui: Object.freeze({
        /**
         * An entry in the sidebar: `{ id, label, icon, render, order?, after?,
         * submenuOf?, enabled?, busy? }` — the same shape as the app's own,
         * see `ui/shell.js`. `busy()` returning true holds repaints off while
         * somebody is typing in the panel.
         */
        sidebar(entry) {
          mine.sidebar.push(gate({ id: p.id, ...entry }));
          if (entry.busy) mine.busy.push(entry.busy);
        },
        /** A tab on the Screens / Aux. strip: `{ id, label, short, icon, render, order?, enabled?, busy? }`. */
        tab(entry) {
          mine.tabs.push(gate({ id: p.id, ...entry }));
          if (entry.busy) mine.busy.push(entry.busy);
        },
        /**
         * A card on this app's settings page: `{ id, render, order? }`, where
         * `render()` returns one element — `kit.card(title, …)` makes it look
         * like the page's own. Drawn only where the manifest's capabilities
         * are met, in `order` among the other plugins' cards.
         */
        settingsSection(entry) {
          const gated = gate({ id: p.id, ...entry });
          mine.sections.push({ ...gated, render: () => (gated.enabled() ? entry.render() : null) });
        }
      })
    });

    try {
      await mod.default(ctx);
    } catch (err) {
      failed.push({ id: p.id, error: `failed to start: ${err.message}` });
      log.warn(TAG, `plugin ${p.id}: failed to start`, err);
      continue;
    }
    sidebar.push(...mine.sidebar);
    tabs.push(...mine.tabs);
    sections.push(...mine.sections);
    busy.push(...mine.busy);
    loaded.push(p.id);
  }

  return {
    sidebar,
    tabs,
    settings: byOrder(sections),
    /* A plugin's `busy` that throws is not busy: a broken predicate must not
       freeze every repaint in the app. */
    busy: () => busy.some((fn) => { try { return Boolean(fn()); } catch { return false; } }),
    loaded,
    failed
  };
}

/**
 * Entries in the order they ask for.
 *
 * Stable: entries with the same `order` — or none, which sorts after every
 * entry that has one — keep the order they were listed in, so the app's own
 * list reads the same whether or not a plugin is anywhere in it.
 */
export function byOrder(entries) {
  return entries
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => (a.entry.order ?? 1000) - (b.entry.order ?? 1000) || a.i - b.i)
    .map(({ entry }) => entry);
}
