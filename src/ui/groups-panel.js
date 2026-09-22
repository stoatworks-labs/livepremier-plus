/*
 * Layer Groups — the panel where a group is made, and what holds it.
 *
 * A group is a name and a list of layers, on one screen or on several, that
 * the operator treats as one thing: the side screens, the confidence
 * monitors, the two halves of a wide. `core/groups.js` is the model and the
 * rules; this is the surface, plus the small store that keeps the list and
 * hands it to the other two things that need it — the `…` menu on the source
 * cards and the gang that follows a change.
 *
 * ## Why this is a sidebar entry and not a tab
 *
 * The Screens / Aux. tab strip is per-screen, and it is full: the vendor's own
 * Properties and Memories plus our Console, Timeline and Layer already push
 * the labels down to their short forms at any ordinary window width. A group
 * is not per-screen — its whole point is that it crosses them — so it files
 * beside the VPU map and the memory banks, which are the other whole-device
 * views. `main.js` says the same thing about the memory banks.
 *
 * ## ⚠️ A group is per device
 *
 * `S1/2` means a layer slot on one box's preconfig. Re-point at a backup
 * frame configured differently and the same words name something else, or
 * nothing. So the list is keyed by device, like a cue stack, and a member the
 * device does not have is drawn struck through rather than quietly dropped —
 * a preconfig change is usually temporary and deleting the operator's group
 * over it would be the wrong kind of tidy.
 *
 * ## ⚠️ A layer belongs to at most one group
 *
 * Two ganged groups sharing a layer is the one arrangement that can
 * oscillate, so adding a layer to a group takes it out of whichever group had
 * it. The panel says so when it happens rather than letting the member appear
 * to vanish from somewhere else.
 */

import { h, button, icon, isEnter } from './dom.js';
import { panel } from './shell.js';
import { listDestinations, sourceLabel } from '../core/screens.js';
import { fittedLayers, bankLetter, readValue } from '../core/properties.js';
import {
  normalise, newId, addMember, memberKey, resolveMembers, sourceSpec, GROUPS_VERSION
} from '../core/groups.js';

/** How many recently-used targets the `…` menu is offered. */
const RECENT_MAX = 5;

/**
 * @param {{session: object, storage: {load: Function, save: Function},
 *          onRefresh: Function}} opts
 */
export function createGroupsPanel({ session, storage, onRefresh = () => {} } = {}) {
  /* The whole stored document: groups, and the `…` menu's recent targets.
     One file, because both are "where this operator routes things on this
     box" and neither means anything pointed at another one. */
  let doc = { version: GROUPS_VERSION, groups: [], recent: [] };

  const view = {
    /* {id, text} while a group's name is being typed into. */
    editing: null,
    /* Per group: which destination and layer the add-row is showing. */
    adding: new Map(),
    note: null,
    /* The last thing the gang did, so the panel can show that it is working.
       Deliberately one line and not a log: this is reassurance, not a trace. */
    activity: null
  };

  const store = () => session.store;
  const busy = () => view.editing != null;

  /* ------------------------------------------------------------ the store */

  async function load() {
    const raw = await storage.load();
    const fresh = normalise(raw);
    doc = { ...fresh, recent: normaliseRecent(raw && raw.recent) };
    onRefresh();
  }

  function save() {
    /* Normalised on the way out as well as in. The rules — unique ids, a
       member in one group only — are properties of what is stored, not of
       what this panel happens to do, and a bug here should not be able to
       write a file that would later gang in a circle. */
    doc = { ...normalise(doc), recent: normaliseRecent(doc.recent) };
    storage.save(doc);
    onRefresh();
  }

  function normaliseRecent(raw) {
    const out = [];
    const seen = new Set();
    for (const t of Array.isArray(raw) ? raw : []) {
      if (!t || typeof t !== 'object') continue;
      const key = t.kind === 'group' ? `g:${t.id}`
        : t.kind === 'layer' ? `l:${t.id}/${t.layer}` : null;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(t.kind === 'group'
        ? { kind: 'group', id: String(t.id) }
        : { kind: 'layer', id: String(t.id), layer: String(t.layer) });
      if (out.length >= RECENT_MAX) break;
    }
    return out;
  }

  /** Most recent first, and never twice. Called by the `…` menu after a send. */
  function remember(target) {
    const key = target.kind === 'group' ? `g:${target.id}` : `l:${target.id}/${target.layer}`;
    const rest = doc.recent.filter((t) => (t.kind === 'group' ? `g:${t.id}` : `l:${t.id}/${t.layer}`) !== key);
    doc.recent = [target, ...rest].slice(0, RECENT_MAX);
    save();
  }

  /* --------------------------------------------------------------- edits */

  function addGroup() {
    const n = doc.groups.length + 1;
    doc.groups = [...doc.groups, { id: newId(), name: `Group ${n}`, gang: true, members: [] }];
    save();
  }

  function removeGroup(id) {
    doc.groups = doc.groups.filter((g) => g.id !== id);
    save();
  }

  function patchGroup(id, patch) {
    doc.groups = doc.groups.map((g) => (g.id === id ? { ...g, ...patch } : g));
    save();
  }

  function join(groupId, member) {
    const { groups, movedFrom } = addMember(doc.groups, groupId, member);
    doc.groups = groups;
    if (movedFrom) {
      note('warn', `${member.id} L${member.layer} moved out of ${movedFrom.name} — a layer belongs to one group.`);
    }
    save();
  }

  function leave(groupId, member) {
    const key = memberKey(member);
    patchGroup(groupId, {
      members: (doc.groups.find((g) => g.id === groupId) || { members: [] })
        .members.filter((m) => memberKey(m) !== key)
    });
  }

  function note(tone, text) {
    view.note = { tone, text };
    onRefresh();
  }

  /* -------------------------------------------------------------- reading */

  function destinations() {
    return store().ready ? listDestinations(store()) : [];
  }

  /**
   * What a member is showing right now, in both buffers.
   *
   * The point of the column is that a glance says whether the group agrees.
   * Program and preview are resolved per screen because two screens are
   * routinely on opposite letters for the same role — `core/groups.js` has
   * the long version.
   */
  function memberSources(member) {
    const spec = sourceSpec(store());
    if (!spec) return { program: null, preview: null };
    const read = (mode) => {
      const bank = bankLetter(store(), member.id, mode);
      if (!bank.letter) return null;
      return readValue(store(), { id: member.id, bank: bank.letter, layer: member.layer }, spec) ?? null;
    };
    return { program: read('PROGRAM'), preview: read('PREVIEW') };
  }

  /* ------------------------------------------------------------ rendering */

  function render() {
    const ready = store().ready;
    return panel({
      toolbar: h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        h('div', { class: 'aw-font-subtitle-1', text: 'Layer Groups' }),
        h('div', { class: 'aw-font-caption aw-text-tertiary aw-margin-left-auto',
          text: `${doc.groups.length} group${doc.groups.length === 1 ? '' : 's'}` }),
        button('New group', { iconId: ['group-14', 'add-12'], onClick: addGroup, disabled: !ready })),
      body: h('div', { class: 'aw-flex-col aw-gap-row-big' },
        view.note ? h('div', { class: ['wru-console-row', 'wru-console-' + view.note.tone], text: view.note.text }) : null,
        view.activity ? h('div', { class: 'wru-groups-activity aw-font-caption aw-text-secondary', text: view.activity }) : null,
        !ready ? h('div', { class: 'aw-text-tertiary', text: 'Waiting for the device store…' }) : null,
        ready && !doc.groups.length ? emptyState() : null,
        ready ? doc.groups.map(groupCard) : null)
    });
  }

  const emptyState = () => h('div', { class: 'aw-flex-col aw-gap-row-small aw-padding-big aw-text-tertiary' },
    h('div', { class: 'aw-font-body-1', text: 'No layer groups yet.' }),
    h('div', { class: 'aw-font-caption',
      text: 'A group is a set of layers driven as one — layer 2 on S1 with layer 1 on S2 and S3, say. Send an input to the group from the … on any source card, and a ganged group follows a change made anywhere.' }));

  function groupCard(group) {
    const members = resolveMembers(store(), group);
    /* ⚠️ Not `aw-card`, for the reason `ui/send-to.js` sets out at length: the
       vendor's card lightens on hover, which says "click me" about a container
       that is only holding other controls — and on a floating surface the same
       rule turns it see-through. `.wru-groups-card` carries the background and
       the border itself. */
    return h('div', { class: 'wru-groups-card aw-padding-medium aw-flex-col aw-gap-row-medium' },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        nameField(group),
        h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-margin-left-auto' },
          gangToggle(group),
          button('Delete', { variant: 'ghost', iconId: ['delete-12', 'trash-12'], onClick: () => removeGroup(group.id) }))),
      members.length
        ? h('table', { class: 'wru-groups-members' },
          h('thead', {}, h('tr', {},
            h('th', { text: 'Layer' }), h('th', { text: 'Program' }), h('th', { text: 'Preview' }), h('th', {}))),
          h('tbody', {}, members.map((m) => memberRow(group, m))))
        : h('div', { class: 'aw-text-tertiary aw-font-caption', text: 'No layers in this group yet.' }),
      addRow(group));
  }

  function nameField(group) {
    const editing = view.editing && view.editing.id === group.id;
    return h('input', {
      class: 'wru-input wru-groups-name aw-font-subtitle-1',
      type: 'text',
      value: editing ? view.editing.text : group.name,
      onInput: (ev) => { view.editing = { id: group.id, text: ev.target.value }; },
      onKeyDown: (ev) => {
        if (isEnter(ev)) { ev.preventDefault(); ev.target.blur(); }
        if (ev.key === 'Escape') { view.editing = null; onRefresh(); }
      },
      onBlur: (ev) => {
        const text = String(ev.target.value).trim();
        view.editing = null;
        if (text && text !== group.name) patchGroup(group.id, { name: text });
        else onRefresh();
      }
    });
  }

  /**
   * The gang switch.
   *
   * Off, a group is only a target: it fans out when something is sent to it
   * and does nothing otherwise. On, it also follows — and since that is the
   * one thing in this app that writes without being asked for that write
   * specifically, the switch says which it is in words rather than leaving an
   * icon to carry it.
   */
  function gangToggle(group) {
    return button(group.gang ? 'Gang: follows' : 'Gang: off', {
      active: group.gang,
      iconId: group.gang ? ['linked-h-18', 'link-vertical-12'] : ['unlinked-h-18', 'link-vertical-12'],
      title: group.gang
        ? 'A source change on any member is written to the rest, in the same role — program or preview.'
        : 'The group is only a target for the … menu. Nothing follows a change made elsewhere.',
      onClick: () => patchGroup(group.id, { gang: !group.gang })
    });
  }

  function memberRow(group, member) {
    const sources = member.fitted ? memberSources(member) : { program: null, preview: null };
    const label = (v) => (v && v !== 'NONE' ? (sourceLabel(v, store()) || v) : '—');
    return h('tr', { class: member.fitted ? null : 'wru-groups-member--absent' },
      h('td', { class: 'aw-font-body-1-bold' },
        `${member.id} ${member.layer === 'NATIVE' ? 'NATIVE' : 'L' + member.layer}`,
        member.fitted ? null : h('span', { class: 'wru-tag wru-tag--warn aw-font-caption aw-margin-left-small', text: 'not fitted' })),
      h('td', { class: 'wru-groups-src', text: label(sources.program) }),
      h('td', { class: 'wru-groups-src', text: label(sources.preview) }),
      h('td', {}, button('Remove', { variant: 'ghost', onClick: () => leave(group.id, member) })));
  }

  /**
   * The add-row: a destination, one of its fitted layers, and Add.
   *
   * The layer list is the device's own fitted list rather than a range,
   * because a preset carries geometry for slots the hardware does not have —
   * the trap `core/screens.js` exists to close. Offering L2 on a screen with
   * one scaler would let an operator build a group that can never fire.
   */
  function addRow(group) {
    const dests = destinations();
    if (!dests.length) return null;
    const pick = view.adding.get(group.id) || {};
    const dest = dests.find((d) => d.id === pick.id) || dests[0];
    const layers = fittedLayers(store(), dest.id);
    const layer = layers.find((l) => l.key === pick.layer) || layers[0];

    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
      h('select', {
        class: 'wru-select',
        onChange: (ev) => { view.adding.set(group.id, { id: ev.target.value, layer: null }); onRefresh(); }
      }, ...dests.map((d) => h('option', { value: d.id, selected: d.id === dest.id ? 'selected' : null },
        d.label ? `${d.id} — ${d.label}` : d.id))),
      layers.length
        ? h('select', {
          class: 'wru-select',
          onChange: (ev) => { view.adding.set(group.id, { id: dest.id, layer: ev.target.value }); onRefresh(); }
        }, ...layers.map((l) => h('option', { value: l.key, selected: layer && l.key === layer.key ? 'selected' : null },
          l.key === 'NATIVE' ? 'Native' : `L${l.key}`)))
        : h('div', { class: 'aw-text-tertiary aw-font-caption', text: 'no fitted layers' }),
      button('Add', {
        iconId: ['add-12', 'add-18'],
        disabled: !layer,
        onClick: () => layer && join(group.id, { id: dest.id, layer: layer.key })
      }));
  }

  /* --------------------------------------------------------------- public */

  return {
    render,
    busy,
    load,
    /** The current groups, for the `…` menu and the gang. */
    list: () => doc.groups,
    recent: () => doc.recent,
    remember,
    /** The gang's last report, drawn as one reassurance line on the panel. */
    reportActivity(report) {
      if (!report) return;
      const bits = [];
      if (report.sent) bits.push(`${report.group.name}: ${report.sent} layer${report.sent === 1 ? '' : 's'} followed ${report.from ? report.from.id + ' L' + report.from.layer : ''} to ${sourceLabel(report.source, store()) || report.source} in ${String(report.mode || '').toLowerCase()}`);
      for (const r of report.refused || []) bits.push(r.why);
      view.activity = bits.join(' · ') || null;
      onRefresh();
    }
  };
}
