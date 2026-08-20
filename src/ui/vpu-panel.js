/*
 * The VPU allocation map.
 *
 * What this is for: a LivePremier configuration either fits in the mixing
 * resources the chassis has, or it does not, and the stock UI tells you which
 * only by refusing the configuration. This draws the budget instead - every
 * unit the chassis has, who holds it, and how much is left.
 *
 * Reading it:
 *  - one block per processor card, one tile per VPU unit
 *  - colour is the screen holding the unit, so a screen reads as one mass
 *  - dashed and faint means the slot is not fitted; outlined means fitted and
 *    free, which is the headroom figure that actually matters
 *  - CURRENT is what is running; STAGED is the pending preconfig. The device
 *    keeps both, and the difference is the cost of applying the change, so
 *    the diff is the point rather than a footnote.
 *
 * Every value here is read-only on the device. Nothing in this panel writes.
 */

import { h, fill, button, readout, sectionTitle } from './dom.js';
import { panel } from './shell.js';
import { screenColour } from './theme.js';
import { readMap, diffMaps, layerLabel } from '../core/vpu.js';

export function createVpuPanel({ session, onRefresh }) {
  const view = { which: 'current', showSpare: true, showAbsent: false };

  function render() {
    const store = session.store;
    if (!store.ready) return panel({ toolbar: title(), body: h('div', { class: 'wru-empty', text: 'Waiting for the device store…' }) });

    const current = readMap(store, 'current');
    const staged = readMap(store, 'new');

    if (!current) {
      return panel({
        toolbar: title(),
        body: h('div', { class: 'wru-empty' },
          h('div', { class: 'aw-font-subtitle-1 aw-margin-bottom-medium', text: 'No VPU mapping reported' }),
          h('div', { text: 'This firmware does not expose preconfig/resources/*/status/mapping under either name this build knows (vpuMixerList or vpuLayerList).' }))
      });
    }

    const map = view.which === 'new' && staged ? staged : current;
    const changes = staged ? diffMaps(current, staged) : [];
    const changedKeys = new Set(changes.map((c) => c.key));

    return panel({
      toolbar: title(map, changes),
      body: h('div', {},
        summary(map, changes),
        ...map.devices.map((d) => deviceBlock(d, map, changedKeys)))
    });
  }

  function title(map, changes) {
    return [
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-large' },
        h('div', { class: 'aw-font-subtitle-1', text: 'VPU Resources' }),
        map ? h('span', { class: 'wru-tag', text: map.variant === 'mixer' ? 'mixer model' : 'scaler model' }) : null,
        changes && changes.length
          ? h('span', { class: 'wru-tag wru-warn', text: changes.length + ' staged change' + (changes.length === 1 ? '' : 's') })
          : null),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        button('Current', { onClick: () => { view.which = 'current'; onRefresh(); }, active: view.which === 'current' }),
        button('Staged', { onClick: () => { view.which = 'new'; onRefresh(); }, active: view.which === 'new' }),
        button('Spare', { onClick: () => { view.showSpare = !view.showSpare; onRefresh(); }, active: view.showSpare, variant: 'ghost' }),
        button('Empty slots', { onClick: () => { view.showAbsent = !view.showAbsent; onRefresh(); }, active: view.showAbsent, variant: 'ghost' }))
    ];
  }

  function summary(map, changes) {
    const t = map.totals;
    const screens = [...map.byScreen.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }));

    const bar = h('div', { class: 'wru-bar aw-margin-top-small' });
    for (const [screenId, layers] of screens) {
      const count = [...layers.values()].reduce((n, arr) => n + arr.length, 0);
      bar.append(h('span', {
        style: { width: (count / Math.max(1, t.available) * 100) + '%', background: screenColour(screenId) },
        title: `${screenId}: ${count} of ${t.available} fitted units`
      }));
    }
    if (t.spare > 0) bar.append(h('span', { style: { width: (t.spare / Math.max(1, t.available) * 100) + '%', background: '#283239' }, title: `spare: ${t.spare}` }));

    return h('div', { class: 'aw-margin-bottom-large' },
      h('div', { class: 'aw-flex-row aw-gap-col-massive aw-margin-bottom-small' },
        readout('Fitted', `${t.available} of ${t.total}`),
        readout('Allocated', t.enabled),
        readout('Spare', t.spare, { tone: t.spare > 0 ? 'green' : 'red' }),
        readout('Screens in use', map.byScreen.size)),
      bar,
      h('div', { class: 'wru-legend aw-margin-top-medium' },
        ...screens.map(([screenId, layers]) => {
          const count = [...layers.values()].reduce((n, arr) => n + arr.length, 0);
          return h('span', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
            h('span', { class: 'wru-swatch', style: { background: screenColour(screenId) } }),
            h('span', { class: 'aw-font-body-2', text: `${screenId} · ${count}` }));
        }),
        h('span', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
          h('span', { class: 'wru-swatch', style: { background: '#283239', border: '0.1rem solid #49535B' } }),
          h('span', { class: 'aw-font-body-2', text: 'spare' }))),
      changes && changes.length ? changeList(changes) : null);
  }

  function changeList(changes) {
    return h('div', { class: 'aw-margin-top-large' },
      sectionTitle('Staged against current'),
      h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        ...changes.slice(0, 40).map((c) => {
          if (c.added) return h('div', { class: 'aw-font-body-2', text: `${c.key} appears` });
          if (c.gone) return h('div', { class: 'aw-font-body-2', text: `${c.key} disappears` });
          const bits = c.fields.map((f) => `${f}: ${fmt(c.before[f])} → ${fmt(c.after[f])}`).join(', ');
          return h('div', { class: 'aw-font-body-2' },
            h('span', { class: 'aw-font-body-1-bold', text: c.key + ' ' }),
            h('span', { class: 'aw-text-secondary', text: bits }));
        }),
        changes.length > 40 ? h('div', { class: 'aw-text-tertiary', text: `…and ${changes.length - 40} more` }) : null));
  }

  const fmt = (v) => (v === null || v === undefined ? '—' : String(v));

  function deviceBlock(device, map, changedKeys) {
    const units = device.units.filter((u) => {
      if (!u.available) return view.showAbsent;
      if (!u.enabled) return view.showSpare;
      return true;
    });

    const fitted = device.units.filter((u) => u.available).length;
    const used = device.units.filter((u) => u.available && u.enabled).length;

    return h('div', { class: 'wru-vpu-device' },
      h('div', { class: 'aw-flex-row-center-v-space-between aw-margin-bottom-small' },
        h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium' },
          h('div', { class: 'aw-font-subtitle-1', text: device.role }),
          h('span', { class: 'wru-tag', text: device.fitted ? `${used}/${fitted} in use` : 'not fitted' })),
        h('div', { class: 'aw-font-body-2 aw-text-tertiary', text: `${device.pipes.filter((p) => p.used).length} output pipes used` })),
      units.length
        ? h('div', { class: 'wru-vpu-grid' }, ...units.map((u) => unitTile(u, device, changedKeys)))
        : h('div', { class: 'aw-text-tertiary aw-font-body-2', text: 'Nothing to show with the current filters.' }));
  }

  function unitTile(u, device, changedKeys) {
    const allocated = u.available && u.enabled;
    const colour = allocated ? screenColour(u.screen) : '#616D75';
    const cls = ['wru-vpu-unit'];
    if (!u.available) cls.push('wru-vpu-unit--absent');
    else if (!u.enabled) cls.push('wru-vpu-unit--spare');
    else cls.push('wru-vpu-unit--used');
    if (changedKeys.has(device.key + '/' + u.id)) cls.push('wru-vpu-unit--changed');

    const short = u.id.replace(/^PROC_(\d+)_(MIXER|SCALER)_(\d+)$/, 'P$1·$3');
    const tip = [
      u.id,
      `available: ${u.available}`,
      `enabled: ${u.enabled}`,
      `capability: ${u.capability ?? '—'}`,
      `screen: ${u.screen ?? '—'}`,
      `layer: ${u.layer ?? '—'}`,
      u.slice != null ? `slice: ${u.slice}` : null,
      u.channel != null ? `channel: ${u.channel}` : null,
      u.pipes.length ? 'pipes: ' + u.pipes.map((p) => `${p.index}→out ${p.output}`).join(', ') : 'pipes: none',
      Object.keys(u.scalers).length
        ? 'scalers: ' + Object.entries(u.scalers).map(([k, v]) => `${k} fill ${v.fill ?? '—'} / cut ${v.cut ?? '—'}`).join('; ')
        : null
    ].filter(Boolean).join('\n');

    return h('div', { class: cls, style: { color: colour }, title: tip },
      h('div', { class: 'wru-vpu-id', text: short }),
      allocated
        ? h('div', { class: 'wru-vpu-alloc aw-font-body-2', text: u.screen })
        : h('div', { class: 'wru-vpu-alloc aw-font-body-2 aw-text-tertiary', text: u.available ? 'spare' : 'empty' }),
      allocated ? h('div', { class: 'aw-font-body-2 aw-text-secondary', text: layerLabel(u.layer) }) : null,
      h('div', { class: 'wru-vpu-meta aw-flex-row-center-v aw-gap-col-mini' },
        u.slice != null && allocated ? h('span', { text: 'slice ' + u.slice }) : null,
        u.capability && u.capability !== 'OFF' ? h('span', { text: u.capability }) : null,
        ...u.pipes.map((p) => h('span', { class: 'wru-vpu-pipe', text: 'out ' + p.output }))));
  }

  return { render, view };
}

export { fill };
