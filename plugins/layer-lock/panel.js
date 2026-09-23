/*
 * Layer Lock — the panel: a lock and a "take only" per layer, per group.
 *
 * One card per screen or aux in service, one row per fitted layer, showing
 * what program and preview hold, what the switcher says the layer will do on
 * the next take, and the two controls. The layer groups, when that plugin is
 * on, get the same two controls for a whole group at once — "lock the side
 * screens" is one decision, as the groups panel argues for sources.
 *
 * ## Why a sidebar entry and not a tab
 *
 * The strip beside Properties is full — `plugins/layer-groups/client.js` says
 * a fifth tab of ours would need a better argument than it had, and this is
 * not one: a lock is set before a section of the show and left, not reached
 * for take by take. The one control that is reached for take by take, "take
 * only", is on the same rows so an operator does not have to hold two lists
 * in their head.
 *
 * ## ⚠️ What the panel has to say out loud
 *
 * A lock is kept by THIS page. The front panel, a T-bar, an OSC take and
 * anything speaking to the switcher directly are not held — the engine's head
 * has the full list — so the panel says so on every render rather than in a
 * tooltip. A lock that silently does not hold on a show is worse than no lock.
 */

import { h, button } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import { listDestinations, sourceLabel, presetBanks } from '../../src/core/screens.js';
import { fittedLayers, bankLetter, readValue } from '../../src/core/properties.js';
import { sourceSpec } from '../../src/core/groups.js';
import { layerLabel } from '../../src/core/layer-names.js';
import { normalise, lockKey, parseLockKey, inSync, verdict, LOCKS_VERSION } from '../../src/core/layer-lock.js';

/** The switcher's own words for a layer's next transition, as a reader would say them. */
const VERDICT = {
  OFF: 'stays', OPEN: 'opens', CLOSE: 'closes', CROSS: 'crosses',
  FLYING: 'flies', FLYING_DEPTH: 'flies (depth)', PREEMPTED: 'preempted', MASK: 'preempted',
  OUT_OF_CAPACITY: 'out of capacity', UNAVAILABLE_SOURCE: 'source unavailable'
};

/**
 * @param {object} o
 * @param {object} o.session
 * @param {{load: Function, save: Function}} o.storage
 * @param {() => object|null} o.engine        the lock engine, once it exists
 * @param {() => object} [o.names]            layer names, `S1/2` → name
 * @param {() => Array|null} [o.groups]       the layer groups, when that plugin is on
 * @param {() => boolean} [o.gated]           whether the page hook took the gate
 * @param {Function} [o.onRefresh]
 */
export function createLockPanel({
  session, storage, engine, names = () => ({}), groups = () => null, gated = () => true, onRefresh = () => {}
} = {}) {
  let doc = { version: LOCKS_VERSION, locks: [] };
  const view = { note: null, activity: null, running: false };
  const store = () => session.store;

  /* ------------------------------------------------------------ the store */

  async function load() {
    doc = normalise(await storage.load());
    onRefresh();
  }

  function setLocks(next, why) {
    doc = normalise({ locks: next });
    storage.save(doc);
    /* Setting a lock is the operator asking for the layer to be brought into
       line now — the one time the follower acts on state it merely found. */
    const e = engine();
    if (e) {
      const done = e.syncAll(why);
      const sent = done.reduce((n, r) => n + (r.sent || 0), 0);
      const refused = done.filter((r) => r.refused).map((r) => r.refused);
      if (refused.length) say('warn', `Locked, but not lined up yet: ${refused.join(' · ')}. It will be when the take lands.`);
      else if (sent) say('ok', `Locked — preview matched to program (${sent} propert${sent === 1 ? 'y' : 'ies'}).`);
    }
    onRefresh();
  }

  const isLocked = (id, layer) => doc.locks.includes(lockKey(id, layer));

  function toggle(id, layer) {
    const key = lockKey(id, layer);
    setLocks(isLocked(id, layer) ? doc.locks.filter((k) => k !== key) : [...doc.locks, key], 'locked');
  }

  function lockGroup(group, on) {
    const keys = group.members.map((m) => lockKey(m.id, m.layer));
    setLocks(on ? [...doc.locks, ...keys] : doc.locks.filter((k) => !keys.includes(k)), 'locked');
  }

  async function takeOnly(targets) {
    const e = engine();
    if (!e || view.running) return;
    view.running = true;
    say('ok', 'Taking…');
    try {
      const r = await e.takeOnly(targets);
      say(r.ok ? 'ok' : 'warn', r.message);
    } catch (err) {
      say('err', `Partial take failed: ${err.message}`);
    } finally {
      view.running = false;
      onRefresh();
    }
  }

  function say(tone, text) { view.note = { tone, text }; onRefresh(); }

  /* -------------------------------------------------------------- reading */

  function sources(id, layer) {
    const spec = sourceSpec(store());
    if (!spec) return { program: null, preview: null };
    const read = (mode) => {
      const bank = bankLetter(store(), id, mode);
      return bank.letter ? readValue(store(), { id, bank: bank.letter, layer }, spec) ?? null : null;
    };
    return { program: read('PROGRAM'), preview: read('PREVIEW') };
  }

  /* ------------------------------------------------------------ rendering */

  function render() {
    const ready = store().ready;
    const dests = ready ? listDestinations(store()).filter((d) => fittedLayers(store(), d.id).length) : [];
    const groupList = groups() || [];
    return panel({
      toolbar: h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        h('div', { class: 'aw-font-subtitle-1', text: 'Layer Lock' }),
        h('div', { class: 'aw-font-caption aw-text-tertiary aw-margin-left-auto',
          text: `${doc.locks.length} locked` }),
        doc.locks.length
          ? button('Unlock all', { variant: 'ghost', iconId: ['unlocked-12'], onClick: () => setLocks([], 'unlocked') })
          : null),
      body: h('div', { class: 'aw-flex-col aw-gap-row-big' },
        h('div', { class: ['wru-console-row', 'wru-console-warn', 'aw-font-caption'],
          text: 'A lock holds for takes sent from this page — the TAKE and CUT buttons here, the Console, a cue, Companion '
            + 'buttons pressed through this app. The front panel, a T-bar, an OSC take and anything talking to the '
            + 'switcher directly are not held; a locked layer is kept in line between takes, so it is usually still, '
            + 'but a recall and a take from outside in the same instant will move it.' }),
        gated() ? null : h('div', { class: ['wru-console-row', 'wru-console-err'],
          text: 'This page was loaded before layer locks existed, so its takes cannot be held. Reload the page.' }),
        view.note ? h('div', { class: ['wru-console-row', 'wru-console-' + view.note.tone], text: view.note.text }) : null,
        view.activity ? h('div', { class: 'wru-groups-activity aw-font-caption aw-text-secondary', text: view.activity }) : null,
        !ready ? h('div', { class: 'aw-text-tertiary', text: 'Waiting for the device store…' }) : null,
        ready && !dests.length ? h('div', { class: 'aw-text-tertiary', text: 'No screen or aux in service has a fitted layer.' }) : null,
        groupList.length ? groupsCard(groupList) : null,
        dests.map(destCard),
        strayLocks(dests))
    });
  }

  function destCard(dest) {
    const layers = fittedLayers(store(), dest.id);
    const banks = presetBanks(store(), dest.id);
    const state = !banks.reported ? 'buffers not reported'
      : !banks.settled ? 'mid-take' : `program ${banks.program} · preview ${banks.preview}`;
    return h('div', { class: 'wru-groups-card aw-padding-medium aw-flex-col aw-gap-row-medium' },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        h('div', { class: 'aw-font-subtitle-1', text: dest.label ? `${dest.id} — ${dest.label}` : dest.id }),
        h('div', { class: 'aw-font-caption aw-text-tertiary aw-margin-left-auto', text: state })),
      h('table', { class: 'wru-groups-members' },
        h('thead', {}, h('tr', {},
          h('th', { text: 'Layer' }), h('th', { text: 'Program' }), h('th', { text: 'Preview' }),
          h('th', { text: 'Next take', title: 'What the switcher says this layer will do on the next take. A simulator always says "stays".' }),
          h('th', {}), h('th', {}))),
        h('tbody', {}, layers.map((l) => layerRow(dest, l.key)))));
  }

  function layerRow(dest, layer) {
    const src = sources(dest.id, layer);
    const label = (v) => (v && v !== 'NONE' ? (sourceLabel(v, store()) || v) : '—');
    const locked = isLocked(dest.id, layer);
    const v = verdict(store(), dest.id, layer);
    const said = v ? (v.next != null ? VERDICT[v.next] || v.next
      : v.up === v.down ? VERDICT[v.up] || v.up : `up ${v.up} · down ${v.down}`) : '—';
    const lined = locked ? inSync(store(), dest.id, [layer]) : null;
    return h('tr', {},
      h('td', { class: 'aw-font-body-1-bold' }, layerLabel(names(), dest.id, layer),
        locked ? h('span', {
          class: ['wru-tag', 'aw-margin-left-small', lined ? 'wru-tag--good' : 'wru-tag--warn'],
          text: lined ? 'locked' : 'locked · lining up'
        }) : null),
      h('td', { class: 'wru-groups-src', text: label(src.program) }),
      h('td', { class: 'wru-groups-src', text: label(src.preview) }),
      h('td', { class: 'wru-groups-src', text: said }),
      h('td', {}, button(locked ? 'Locked' : 'Lock', {
        active: locked,
        iconId: locked ? ['locked-12'] : ['unlocked-12'],
        title: locked
          ? 'Stays as it is on program through every take sent from this page. Click to unlock.'
          : 'Keep this layer as it is on program through every take: preview is held equal to program.',
        onClick: () => toggle(dest.id, layer)
      })),
      h('td', {}, button('Take only', {
        disabled: view.running || locked,
        title: locked ? 'A locked layer does not move — unlock it first.'
          : 'Take this layer alone: every other layer on the screen is held, then preview is put back.',
        onClick: () => takeOnly([{ id: dest.id, layer }])
      })));
  }

  function groupsCard(list) {
    return h('div', { class: 'wru-groups-card aw-padding-medium aw-flex-col aw-gap-row-medium' },
      h('div', { class: 'aw-font-subtitle-1', text: 'Layer groups' }),
      h('table', { class: 'wru-groups-members' },
        h('tbody', {}, list.map((g) => {
          const members = g.members || [];
          const all = members.length > 0 && members.every((m) => isLocked(m.id, m.layer));
          return h('tr', {},
            h('td', { class: 'aw-font-body-1-bold', text: g.name }),
            h('td', { class: 'wru-groups-src',
              text: members.map((m) => `${m.id} ${m.layer === 'NATIVE' ? 'NAT' : 'L' + m.layer}`).join(', ') || 'no layers' }),
            h('td', {}, button(all ? 'Locked' : 'Lock group', {
              active: all, disabled: !members.length,
              iconId: all ? ['locked-12'] : ['unlocked-12'],
              onClick: () => lockGroup(g, !all)
            })),
            h('td', {}, button('Take only', {
              disabled: view.running || !members.length,
              title: 'Take every layer in this group, on each of its screens, and hold the rest.',
              onClick: () => takeOnly(members)
            })));
        }))));
  }

  /** Locks on layers this box does not have — kept, and shown, rather than dropped. */
  function strayLocks(dests) {
    const known = new Set();
    for (const d of dests) for (const l of fittedLayers(store(), d.id)) known.add(lockKey(d.id, l.key));
    const stray = store().ready ? doc.locks.filter((k) => !known.has(k)) : [];
    if (!stray.length) return null;
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap aw-font-caption aw-text-tertiary' },
      h('span', { text: 'Locked, but not fitted on this switcher:' }),
      ...stray.map((k) => {
        const p = parseLockKey(k);
        return button(`${p.id} ${p.layer === 'NATIVE' ? 'NAT' : 'L' + p.layer} ×`, {
          variant: 'ghost', title: 'Remove this lock', onClick: () => setLocks(doc.locks.filter((x) => x !== k), 'unlocked')
        });
      }));
  }

  /* --------------------------------------------------------------- public */

  return {
    render,
    load,
    busy: () => view.running,
    list: () => doc.locks,
    /** One line of what the engine last did, so the panel shows it working. */
    reportActivity(r) {
      if (!r) return;
      const which = (r.layers || []).map((k) => (k === 'NATIVE' ? 'NAT' : 'L' + k)).join('+');
      view.activity = r.kind === 'held'
        ? `${r.id} ${r.prop === 'xCut' ? 'cut' : 'take'} held while ${which} lined up (${r.sent} write${r.sent === 1 ? '' : 's'}${r.missing ? `, ${r.missing} not echoed` : ''})`
        : r.kind === 'partial'
          ? `Partial take: ${r.what}`
          : `${r.id} ${which} kept in line with program (${r.sent} write${r.sent === 1 ? '' : 's'})`;
      onRefresh();
    }
  };
}
