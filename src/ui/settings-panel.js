/*
 * LivePremier Plus settings — the app's own page, inside the vendor's app.
 *
 * ## Where it lives, and why there
 *
 * In the **Preconfig flyout**, at the end of the list, beneath the device's
 * own System page. Preconfig is where Web RCS files "things about this
 * installation as a whole" — System, Outputs, Screens, Canvas — as against
 * LIVE, which is where an operator drives a show. Settings for the proxy
 * belong on the first side of that line, and the operator who wants them is
 * already in the habit of going there.
 *
 * The alternative was another entry in the PLUS section at the bottom of the
 * sidebar. That would have filed it by who wrote it rather than by what it is,
 * which is the same argument that put MIDI Mapping under Virtual RC400T.
 *
 * ## This is deliberately a placeholder
 *
 * Everything it shows is read — device identity, firmware, where each panel
 * lives, whether the session is up. Nothing is written, because nothing here
 * is configurable yet. The settings that are coming are listed by name and
 * plainly marked as not yet arrived, so the page is honest about being a frame
 * rather than dressed up with controls that do nothing. A toggle that silently
 * fails is worse than an empty row that says what it is waiting for.
 */

import { h, button, readout, sectionTitle } from './dom.js';
import { panel } from './shell.js';
import { readIdentity } from '../core/identity.js';

/*
 * What is installed, and where to find it.
 *
 * Written down here rather than derived from the shell because it is a map for
 * a person: an operator who has just met this app wants to know that a cue
 * stack exists and that it is a tab on the Screens page, and no amount of
 * introspection over `Shell.entries` says that as well as a sentence does.
 */
const FEATURES = [
  {
    name: 'VPU Map',
    where: 'Sidebar, under PLUS',
    what: 'Which mixers each screen is using, running against staged.'
  },
  {
    name: 'Console',
    where: 'Screens / Aux., beside Properties',
    what: 'A command line over the device — takes, preset recalls, layer moves.'
  },
  {
    name: 'Timeline',
    where: 'Screens / Aux., beside Properties',
    what: 'A theatre cue stack with GO, fades and a standby cue.'
  },
  {
    name: 'MIDI Mapping',
    where: 'Sidebar, under Virtual RC400T',
    what: 'A MIDI control surface driving the switcher from this page.'
  },
  {
    name: 'Field arithmetic',
    where: 'Every numeric field in Web RCS',
    what: 'Type 1080-80 in a layer width and get 1000.'
  }
];

/*
 * The settings this page is being built to hold.
 *
 * Each is a stage of the roadmap rather than a wish; they are listed now so
 * that the page has a shape, and so that anyone opening it can see what it is
 * for before it does anything.
 */
const PLANNED = [
  {
    name: 'Model compatibility',
    what: 'Which commands and graphs this switcher supports, and what is hidden because it does not.'
  },
  {
    name: 'Timecode source',
    what: 'The audio or MIDI input the timeline chases, and its offset.'
  },
  {
    name: 'Audio patching',
    what: 'Names for the audio sources and destinations the console patches between.'
  },
  {
    name: 'Cue stack storage',
    what: 'Where show files are kept, and which one this device is using.'
  }
];

export function createSettingsPanel({ session, onRefresh = () => {} }) {
  /*
   * The proxy's own status: our version, and which switcher it is pointed at.
   * Fetched once and cached, because none of it changes while the page is
   * open — re-pointing the proxy hangs up this tab's socket, so a settings
   * page that outlived a change of device is not a case that arises.
   */
  const state = { status: null, statusError: null, asked: false };

  async function loadStatus() {
    if (state.asked) return;
    state.asked = true;
    try {
      const res = await fetch('/__lpp/status', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.status = await res.json();
    } catch (err) {
      state.statusError = err.message;
    }
    onRefresh();
  }

  /* --------------------------------------------------------------- device */

  function deviceSection() {
    const id = readIdentity(session.store);
    const frame = id.primary;

    if (!id.present) {
      return card('This switcher',
        h('div', { class: 'wru-empty', text: session.store.ready
          ? 'The device store has no identity block — this build reports it somewhere else.'
          : 'Waiting for the device store.' }));
    }

    const rows = h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
      readout('Model', frame.model || 'unknown', { tone: frame.model ? null : 'tertiary' }),
      readout('Family', frame.family || '—'),
      readout('Firmware', frame.firmware || '—'),
      readout('Chassis', frame.chassis || '—'),
      readout('Serial', frame.serial || '—'));

    /*
     * Say when it is a simulator, because it changes what the other panels
     * are allowed to claim: a simulator has no VPU at all, so an empty VPU
     * map on one is the right answer and not a fault to chase.
     */
    const notes = [];
    if (frame.simulated) {
      notes.push(note('warn', 'Simulated device — there is no VPU behind it, so the VPU Map has nothing to draw.'));
    }
    if (frame.outdated) {
      notes.push(note('warn', 'The device reports its firmware as out of date.'));
    }
    /* Only the slots with a frame actually in them. The list is always four
       long; saying "4 linked frames" on a single box would be a lie. */
    if (id.linked.length > 1) {
      notes.push(note('info', `${id.linked.length} linked frames: ` +
        id.linked.map((f) => `${f.key} ${f.model || '?'}`).join(', ') + '. Identity above is the master.'));
    }

    return card('This switcher', rows, ...notes);
  }

  /* ---------------------------------------------------------------- proxy */

  function proxySection() {
    const s = state.status;
    const rows = h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
      readout('Version', (s && s.version) || (state.statusError ? 'unavailable' : '…')),
      readout('Switcher', (s && s.device) || (state.statusError ? 'unavailable' : '…')),
      readout('Serving on', location.host),
      readout('Session', session.state));

    const notes = [];
    if (state.statusError) notes.push(note('warn', 'Could not reach the proxy: ' + state.statusError));
    if (s && s.upstreamError) notes.push(note('warn', 'Last upstream error: ' + s.upstreamError));
    /*
     * The one thing worth explaining unprompted. Web MIDI needs a secure
     * context, and a switcher's own address on a LAN is not one — so an
     * operator who typed the device's IP in themselves will find MIDI
     * missing with nothing on screen to say why.
     */
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      notes.push(note('warn', 'This page is not a secure context, so Web MIDI is unavailable. ' +
        'Open Web RCS through LivePremier Plus rather than at the switcher\'s own address.'));
    }

    return card('LivePremier Plus', rows, ...notes);
  }

  /* ------------------------------------------------------------- features */

  function featureSection() {
    return card('What this adds',
      h('div', { class: 'aw-flex-col aw-gap-row-medium' },
        FEATURES.map((f) => h('div', { class: 'aw-flex-row aw-gap-col-large aw-flex-wrap' },
          h('div', { class: 'aw-font-body-1-bold', style: { minWidth: '11rem' }, text: f.name }),
          h('div', { class: 'aw-flex-col aw-gap-row-mini', style: { flex: '1 1 20rem' } },
            h('div', { class: 'aw-font-body-1', text: f.what }),
            h('div', { class: 'aw-font-caption aw-text-tertiary', text: f.where }))))));
  }

  /* -------------------------------------------------------------- planned */

  function plannedSection() {
    return card('Settings',
      h('div', { class: 'aw-font-body-1 aw-text-secondary aw-margin-bottom-medium',
        text: 'Nothing here is configurable yet. These are the settings this page is being built to hold.' }),
      h('div', { class: 'aw-flex-col aw-gap-row-medium' },
        PLANNED.map((p) => h('div', { class: 'aw-flex-row aw-gap-col-large aw-flex-wrap', style: { opacity: '0.55' } },
          h('div', { class: 'aw-font-body-1-bold', style: { minWidth: '11rem' } },
            p.name, ' ', h('span', { class: 'wru-tag', text: 'not yet' })),
          h('div', { class: 'aw-font-body-1', style: { flex: '1 1 20rem' }, text: p.what })))));
  }

  /* --------------------------------------------------------------- render */

  const card = (title, ...body) => h('div', { class: 'wru-vpu-device aw-flex-col aw-gap-row-medium' },
    sectionTitle(title), ...body);

  const note = (tone, text) => h('div', {
    class: ['aw-font-caption', tone === 'warn' ? 'wru-warn' : 'aw-text-tertiary'], text
  });

  function toolbar() {
    return [
      h('div', { class: 'aw-font-subtitle-1', text: 'LivePremier Plus' }),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        button('Refresh', { iconId: 'refresh-14', onClick: () => { state.asked = false; loadStatus(); } }))
    ];
  }

  function render() {
    loadStatus();
    const body = h('div', { class: 'aw-flex-col aw-gap-row-large' },
      deviceSection(),
      proxySection(),
      featureSection(),
      plannedSection());
    return panel({ toolbar: toolbar(), body });
  }

  return { render };
}
