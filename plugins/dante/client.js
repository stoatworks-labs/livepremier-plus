/*
 * Dante — the plugin's page half: the PLUS ▸ Dante panel, its settings card,
 * and a cue action.  ** PREVIEW **
 *
 * A whole-network view, like Matrix Routing and the Audio Matrix, so a sidebar
 * entry under PLUS. Everything it shows about the Dante network comes from
 * the server half, which holds the devices; what it shows about the switcher's
 * own card comes from the store (`switcher.js`), which only the page has.
 *
 * The cue action goes to the server, not the vendor socket — the switcher has
 * never heard of a Dante subscription. Not awaited, as no contributed action
 * is: a route that fails comes back as a warning on the cue, naming what the
 * device said.
 */

import { createDantePanel } from './panel.js';
import { createDanteModel } from './model.js';
import { parseCueText, describeCueAction, cueRequest, normaliseSettings, CUE_KIND, POLL_SECONDS, BROWSE_SECONDS } from './core.js';

export default function activate(ctx) {
  const model = createDanteModel({ url: ctx.url, log: (m) => ctx.log.warn(m) });
  model.settings = () => normaliseSettings(ctx.settings.get());
  /* A popped-out panel shows the tab's devices over the tab's one stream. */
  ctx.share(model);

  const dante = createDantePanel({
    session: ctx.session, model, settings: model.settings, onRefresh: ctx.refresh
  });
  ctx.ui.sidebar({
    id: 'dante',
    label: 'Dante',
    icon: ['audio-18', 'audio-line-18'],
    order: 57,
    render: () => dante.render()
  });

  /* ------------------------------------------------------------ cues */

  ctx.contribute('cueAction', {
    kind: CUE_KIND,
    label: 'Dante',
    async run(a) {
      const { path, body } = cueRequest(a);
      const res = await fetch(ctx.url(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Dante — ${payload.error || payload.summary || `the app answered ${res.status}`}`);
    },
    describe: describeCueAction,
    field: {
      label: 'Dante',
      placeholder: 'snapshot Show A; 1@Amp-1 <- Mix L@Desk',
      hint: 'snapshot <name> recalls a saved snapshot. <rx channel>@<device> <- <tx channel>@<device> subscribes one channel; <- none clears it. ; between several.',
      parse: (text) => parseCueText(text),
      format: (actions) => actions.map(describeCueAction).map((s) => s.replace(/^Dante snapshot /, 'snapshot ')).join('; ')
    }
  });

  /* ------------------------------------------------------------ settings */

  const { h, card, note, picker } = ctx.kit;
  let saving = false;
  let error = null;

  async function put(patch) {
    saving = true;
    ctx.refresh();
    try { await ctx.settings.set(patch); error = null; } catch (err) { error = err.message; }
    saving = false;
    void model.load();
    ctx.refresh();
  }

  function field(label, value, onCommit, { placeholder = '', width = '12rem', key } = {}) {
    return h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: label }),
      h('input', {
        class: 'wru-input', type: 'text', value, placeholder, 'data-lpp-key': key,
        style: { maxWidth: width }, disabled: saving ? 'disabled' : null,
        /* On blur, not per keystroke: a change restarts discovery. */
        onBlur: (ev) => { if (ev.target.value !== value) onCommit(ev.target.value); },
        onKeyDown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); } }
      }));
  }

  function render() {
    model.want();
    const s = normaliseSettings(ctx.settings.get());
    const data = model.state.data;
    const interfaces = (data && data.interfaces) || [];
    const devices = (data && data.devices) || [];
    const ifaceChoices = [
      { id: '', label: 'Every interface', what: 'Asks on every IPv4 interface this machine has that is up — Wi-Fi and a Dante NIC alike.' },
      ...interfaces.map((i) => ({ id: i.address, label: `${i.name} — ${i.address}`, what: `Asks on ${i.name} only.` }))
    ];
    if (s.interface && !ifaceChoices.some((c) => c.id === s.interface)) ifaceChoices.push({ id: s.interface, label: `${s.interface} (not up)`, what: 'That interface is not up on this machine now.' });
    const switcherChoices = [
      { id: '', label: 'Match by the store', what: 'The switcher’s own Dante card is found by the name and addresses its store reports.' },
      ...devices.map((d) => ({ id: d.name, label: d.name, what: `Treat ${d.name} as this switcher’s Dante card.` }))
    ];
    if (s.switcherDevice && !switcherChoices.some((c) => c.id === s.switcherDevice)) switcherChoices.push({ id: s.switcherDevice, label: `${s.switcherDevice} (not found)`, what: 'Not on the network now.' });

    const toggle = h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', style: { cursor: 'pointer' } },
      h('input', { type: 'checkbox', checked: s.discovery ? 'checked' : null, disabled: saving ? 'disabled' : null, onChange: (ev) => put({ discovery: ev.target.checked }) }),
      h('span', { class: 'aw-font-body-1', text: 'Find Dante devices on the network (mDNS)' }));

    const notes = [];
    if (error) notes.push(note('warn', `Could not save: ${error}`));
    notes.push(note('warn',
      'Preview. This speaks Dante’s control protocol as the open-source netaudio project reverse-engineered it, '
      + 'and has only ever spoken to a simulated network on this machine — never a real Dante device. Before trusting '
      + 'it with a show, run the first-device test in docs/DANTE.md. Dante Controller can run beside it.'));
    notes.push(note('info',
      'Devices are found by asking the network from a port of this app’s own, so the system’s mDNS responder — and '
      + 'Dante Controller and Dante Virtual Soundcard, which rely on it — are never disturbed. Where multicast does '
      + 'not reach this machine, list devices by address.'));
    if (data && data.discovery && data.discovery.error) notes.push(note('warn', data.discovery.error));

    return card('Dante',
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        toggle,
        picker('Interface', ifaceChoices, s.interface, (v) => put({ interface: v }), { disabled: saving })),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        field('Devices by address', s.manualDevices.join(', '), (v) => put({ manualDevices: v }), { placeholder: '192.168.1.20, 10.0.0.5:4440', width: '22rem', key: 'dante-manual' }),
        field('Read every (s)', String(s.pollSeconds), (v) => put({ pollSeconds: Number(v) }), { width: '5rem', key: 'dante-poll', placeholder: `${POLL_SECONDS.def}` }),
        field('Ask the network every (s)', String(s.browseSeconds), (v) => put({ browseSeconds: Number(v) }), { width: '5rem', key: 'dante-browse', placeholder: `${BROWSE_SECONDS.def}` })),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        picker('This switcher’s Dante card', switcherChoices, s.switcherDevice, (v) => put({ switcherDevice: v }), { disabled: saving }),
        field('Discovery target (testing)', s.discoveryTarget, (v) => put({ discoveryTarget: v }), { placeholder: 'empty: the mDNS group', width: '12rem', key: 'dante-target' })),
      ...notes);
  }

  ctx.ui.settingsSection({ id: 'dante', order: 30, render });
}

