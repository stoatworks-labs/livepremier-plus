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
 * ## Most of it is still a readout, and the rest is real
 *
 * Device identity, firmware, where each panel lives, whether the session is
 * up — all read. Two groups are genuinely settings and are written through
 * `PUT /__lpp/settings`: how the console reads a typed line, and whether this
 * process is listening for OSC. Anything still on the roadmap is listed by
 * name and plainly marked as not yet arrived, because a toggle that silently
 * fails is worse than a row that says what it is waiting for.
 *
 * ## Why these settings are not kept in the page
 *
 * Two reasons, and neither is a preference. The OSC listener is a UDP socket
 * in the server process — a browser cannot open one, see one, or be the
 * authority on whether one is bound. And the console exists in two windows at
 * once, the tab and the popout, so a per-page setting would have them
 * disagreeing about which language the operator chose. See
 * `../core/settings.js`.
 */

import { h, button, readout, sectionTitle } from './dom.js';
import { panel } from './shell.js';
import { readIdentity } from '../core/identity.js';
import { detectPlatform, CAPABILITIES } from '../core/platform.js';
import { SOURCE_KINDS } from './timecode-source.js';
import { formatTimecode } from '../core/timecode.js';
import {
  AWJ_TRANSPORTS, DEFAULT_SETTINGS, LANGUAGE_CHOICES, OSC_BIND_CHOICES
} from '../core/settings.js';
import { OSC_ROOT } from '../vendor/mynah-lang.mjs';

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
    what: 'Which mixers each screen is using, running against staged.',
    /* Which capability has to hold for this to be on the sidebar at all. A
       feature with no `needs` is platform-independent. */
    needs: 'vpuMap'
  },
  {
    name: 'Console',
    where: 'Screens / Aux., beside Properties',
    what: 'A command line over the device — takes, preset recalls, layer moves.',
    needs: 'console'
  },
  {
    name: 'Timeline',
    where: 'Screens / Aux., beside Properties',
    what: 'A theatre cue stack with GO, fades and a standby cue.',
    needs: 'cueStack'
  },
  {
    name: 'MIDI Mapping',
    where: 'Sidebar, under Virtual RC400T',
    what: 'A MIDI control surface driving the switcher from this page.',
    needs: 'console'
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
    name: 'Audio patching',
    what: 'Names for the audio sources and destinations the console patches between.'
  },
  {
    name: 'Cue stack storage',
    what: 'Where show files are kept, and which one this device is using.'
  }
];

export function createSettingsPanel({ session, platform = null, timecode = null, onRefresh = () => {} }) {
  /*
   * The proxy's own status: our version, and which switcher it is pointed at.
   * Fetched once and cached, because none of it changes while the page is
   * open — re-pointing the proxy hangs up this tab's socket, so a settings
   * page that outlived a change of device is not a case that arises.
   */
  const state = {
    status: null,
    statusError: null,
    asked: false,
    /* The defaults until the process answers. Rendering controls against them
       is honest — they are what is in force when nothing has been chosen — and
       it avoids a page that flickers between empty and populated. */
    settings: { ...DEFAULT_SETTINGS },
    osc: null,
    saveError: null,
    saving: false
  };

  async function loadStatus() {
    if (state.asked) return;
    state.asked = true;
    try {
      const res = await fetch('/__lpp/status', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.status = await res.json();
      if (state.status.settings) state.settings = state.status.settings;
      state.osc = state.status.osc || null;
    } catch (err) {
      state.statusError = err.message;
    }
    onRefresh();
  }

  /**
   * Change one setting.
   *
   * One field at a time, merged server-side, so this page never has to restate
   * the rest and cannot race a console that is changing a different one.
   *
   * The result is broadcast on `window` because the console reads these too
   * and is very often in another window — a language change that reached the
   * settings page and not the command line would be the whole feature failing
   * quietly.
   */
  async function put(patch) {
    state.saving = true;
    state.saveError = null;
    onRefresh();
    try {
      const res = await fetch('/__lpp/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
      state.settings = body.settings;
      state.osc = body.osc || null;
      window.dispatchEvent(new CustomEvent('lpp:settings', { detail: state.settings }));
    } catch (err) {
      state.saveError = err.message;
    }
    state.saving = false;
    onRefresh();
  }

  /* --------------------------------------------------------------- device */

  function deviceSection() {
    /*
     * Identity comes from `core/platform.js` now, not from the LivePremier
     * device list directly — the two platforms keep it in different places
     * and only that file knows which to read. `readIdentity` is still used
     * for the linked-frame note, which is a LivePremier idea and has no
     * meaning on a single-frame Midra or Alta.
     */
    const here = platform ? platform() : detectPlatform(session.store);
    const id = readIdentity(session.store);

    if (!here.ready) {
      return card('This switcher', h('div', { class: 'wru-empty', text: 'Waiting for the device store.' }));
    }

    const rows = h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
      readout('Platform', here.name),
      readout('Model', here.model || 'unknown', { tone: here.model ? null : 'tertiary' }),
      readout('Firmware', here.firmware || '—'),
      here.chassis ? readout('Chassis', here.chassis) : null,
      readout('Serial', here.serial || '—'));

    /*
     * Say when it is a simulator, because it changes what the other panels
     * are allowed to claim: a simulator has no VPU at all, so an empty VPU
     * map on one is the right answer and not a fault to chase.
     */
    const notes = [];
    if (here.simulated) {
      notes.push(note('warn', 'Simulated device — there is no VPU behind it, so the VPU Map has nothing to draw.'));
    }
    if (id.primary && id.primary.outdated) {
      notes.push(note('warn', 'The device reports its firmware as out of date.'));
    }
    /* Only the slots with a frame actually in them. The list is always four
       long on LivePremier; saying "4 linked frames" on a single box would be a
       lie, and on Midra or Alta there is no list at all. */
    if (here.frames.length > 1) {
      notes.push(note('info', `${here.frames.length} linked frames: ` +
        here.frames.map((f) => `${f.key} ${f.model || '?'}`).join(', ') + '. Identity above is the master.'));
    }
    if (here.id === 'unknown') {
      notes.push(note('warn', 'This switcher does not report its platform anywhere this build looks. ' +
        'Features are being offered on the strength of what its store contains, listed below.'));
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

  /* -------------------------------------------------------- compatibility */

  /*
   * What this switcher supports, and how we know.
   *
   * Every row is the result of asking the store whether the path that feature
   * writes to is there — not of looking the model up in a table. So the
   * evidence is shown alongside the verdict: if a feature is off, the reason
   * is a named thing that is missing, which is checkable rather than a claim.
   */
  function compatibilitySection() {
    const here = platform ? platform() : detectPlatform(session.store);
    if (!here.ready) {
      return card('Compatibility',
        h('div', { class: 'wru-empty', text: 'Waiting for the device store.' }));
    }

    const rows = CAPABILITIES.map((cap) => {
      const state = here.capabilities[cap.id];
      const on = state.supported === true;
      return h('div', { class: 'aw-flex-row aw-gap-col-large aw-flex-wrap' },
        h('div', { style: { minWidth: '11rem' }, class: 'aw-flex-row-center-v aw-gap-col-small' },
          h('span', { class: ['wru-tag', on ? 'wru-tag--good' : ''], text: on ? 'yes' : 'no' }),
          h('span', { class: 'aw-font-body-1-bold', text: cap.label })),
        h('div', { style: { flex: '1 1 20rem' }, class: 'aw-font-body-1', text: on
          ? `Offered — this switcher reports ${cap.needs}.`
          : (cap.absent || `Not offered — this switcher does not report ${cap.needs}.`) }));
    });

    return card('Compatibility',
      h('div', { class: 'aw-font-body-1 aw-text-secondary aw-margin-bottom-medium', text:
        `${here.name} runs ${here.family || 'a platform this build does not recognise'}. ` +
        'Each feature is offered only when the part of the device store it drives is actually present.' }),
      h('div', { class: 'aw-flex-col aw-gap-row-medium' }, rows),
      note('info', 'LivePremier and Midra 4K / Alta 4K are different platforms with different object ' +
        'models, so a feature that is off here is off because the paths behind it do not exist on this ' +
        'switcher — not because it has been disabled.'));
  }

  /* ------------------------------------------------------------- timecode */

  /*
   * Where timecode comes from.
   *
   * The first setting on this page that is actually a setting. Three ways in,
   * and the picker lists what each of them can see rather than asking the
   * operator to type a device name — MIDI ports and audio inputs are both
   * enumerable, and the third needs nothing chosen at all.
   */
  function timecodeSection() {
    if (!timecode) return null;
    const { clock, state } = timecode;

    const pick = h('select', {
      class: 'wru-input', style: { maxWidth: '18rem' },
      onChange: (ev) => choose(ev.target.value)
    }, SOURCE_KINDS.map((k) => h('option', {
      value: k.id, selected: state.kind === k.id ? 'selected' : null, text: k.label
    })));

    const devices = h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' });
    paintDevices(devices);

    const reading = clock.reading;
    const rows = h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
      readout('Reading', formatTimecode(reading)),
      readout('State', clock.running ? 'running' : (reading ? 'stopped' : 'nothing yet'),
        { tone: clock.running ? null : 'tertiary' }),
      readout('Rate', reading && reading.rate ? reading.rate + (reading.dropFrame ? ' DF' : '') : '—'));

    const notes = [];
    if (state.error) notes.push(note('warn', state.error));
    /*
     * The one that is not guessable. LTC does not transmit its frame rate —
     * only the drop-frame flag — so the reader has to be told, and a reader
     * told 25 while the tape runs at 30 puts every cue in the wrong place.
     */
    if (state.kind === 'audio') {
      notes.push(note('info', 'LTC does not carry its frame rate, so the rate above is the one this ' +
        'app assumes. Cue timecodes are read at that rate too, so the two agree.'));
    }
    if (state.kind === 'backend') {
      notes.push(note('info', 'POST a timecode to /__lpp/timecode — either "01:02:03:04" or ' +
        '{hours,minutes,seconds,frames} — and every open page hears it.'));
    }

    return card('Timecode',
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium aw-flex-wrap' }, pick, devices),
      rows, ...notes);
  }

  async function paintDevices(host) {
    host.textContent = '';
    const kind = timecode.state.kind;
    if (kind !== 'midi' && kind !== 'audio') return;
    let list = [];
    try { list = kind === 'midi' ? await timecode.midiInputs() : await timecode.audioInputs(); }
    catch (err) { host.append(h('span', { class: 'wru-tag wru-warn', text: err.message })); return; }
    if (!list.length) {
      host.append(h('span', { class: 'wru-tag', text: 'no inputs found' }));
      return;
    }
    host.append(h('select', {
      class: 'wru-input', style: { maxWidth: '18rem' },
      onChange: (ev) => choose(kind, ev.target.value)
    }, list.map((d) => h('option', {
      value: d.id, selected: timecode.state.deviceId === d.id ? 'selected' : null, text: d.label
    }))));
  }

  async function choose(kind, deviceId = '') {
    try { await timecode.use(kind, deviceId); }
    catch { /* the error is on `state` and the next render shows it */ }
    onRefresh();
  }

  /* ------------------------------------------------------------- features */

  function featureSection() {
    const here = platform ? platform() : detectPlatform(session.store);
    /*
     * A feature this switcher does not get is dimmed and said to be absent,
     * not quietly listed as though it were there. The compatibility card above
     * gives the reason; this one is the map of where things are, and a map
     * that marks a room which does not exist is worse than no map.
     */
    return card('What this adds',
      h('div', { class: 'aw-flex-col aw-gap-row-medium' },
        FEATURES.map((f) => {
          const off = f.needs && here.ready && here.capabilities[f.needs] &&
            here.capabilities[f.needs].supported === false;
          return h('div', {
            class: 'aw-flex-row aw-gap-col-large aw-flex-wrap',
            style: off ? { opacity: '0.45' } : null
          },
          h('div', { class: 'aw-font-body-1-bold', style: { minWidth: '11rem' } },
            f.name, off ? ' ' : null, off ? h('span', { class: 'wru-tag', text: 'not here' }) : null),
          h('div', { class: 'aw-flex-col aw-gap-row-mini', style: { flex: '1 1 20rem' } },
            h('div', { class: 'aw-font-body-1', text: f.what }),
            h('div', { class: 'aw-font-caption aw-text-tertiary',
              text: off ? 'Not available on this switcher' : f.where })));
        })));
  }

  /* -------------------------------------------------------- console setup */

  /**
   * A labelled picker over a closed list of choices.
   *
   * Each option carries a sentence, and the sentence for whichever is selected
   * is printed under the control. That is deliberate rather than decorative:
   * every choice on this page trades something — a language for detection, an
   * AWJ client slot for a reply, a loopback bind for the network being able to
   * fire takes — and a `title` attribute is not where a trade-off gets read.
   */
  function picker(label, choices, current, onPick) {
    const chosen = choices.find((c) => c.id === current) || choices[0];
    return h('div', { class: 'aw-flex-col aw-gap-row-mini', style: { flex: '1 1 22rem' } },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: label }),
      h('select', {
        class: 'wru-input', style: { maxWidth: '24rem' },
        disabled: state.saving ? 'disabled' : null,
        onChange: (ev) => onPick(ev.target.value)
      }, choices.map((c) => h('option', {
        value: c.id, selected: c.id === current ? 'selected' : null, text: c.label
      }))),
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: chosen.what }));
  }

  function consoleSection() {
    const notes = [];
    if (state.saveError) notes.push(note('warn', `Could not save: ${state.saveError}`));

    /*
     * The two halves of "how does a typed line reach the switcher". Kept in
     * one card because choosing AWJ as the language and leaving the transport
     * on store writes is a perfectly sensible combination that reads as a
     * contradiction if the two controls are in different places.
     */
    if (state.settings.awjTransport === 'socket') {
      notes.push(note('info',
        'A real AWJ socket spends one of the device’s five client slots for the length of each '
        + 'exchange, and it can be switched off entirely in the Web RCS security settings. '
        + 'A message sent this way goes out exactly as typed.'));
    } else {
      notes.push(note('info',
        'An AWJ message is converted to the store spelling and rides the vendor’s own socket, '
        + 'landing at the same node. A get still needs a real socket, and uses one whichever '
        + 'transport is chosen here — it has nowhere else to answer from.'));
    }

    return card('Console language',
      h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
        picker('Language', LANGUAGE_CHOICES, state.settings.consoleLanguage,
          (v) => put({ consoleLanguage: v })),
        picker('AWJ via', AWJ_TRANSPORTS, state.settings.awjTransport,
          (v) => put({ awjTransport: v }))),
      ...notes);
  }

  /* ------------------------------------------------------------------ OSC */

  /**
   * The OSC listener.
   *
   * The only setting on this page that opens a port, which is why it is off by
   * default, binds loopback unless told otherwise, and says in as many words
   * what the other option means. This fires takes on a video switcher.
   */
  function oscSection() {
    const on = state.settings.oscEnabled;
    const live = state.osc;

    const toggle = h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', style: { cursor: 'pointer' } },
      h('input', {
        type: 'checkbox',
        checked: on ? 'checked' : null,
        disabled: state.saving ? 'disabled' : null,
        onChange: (ev) => put({ oscEnabled: ev.target.checked })
      }),
      h('span', { class: 'aw-font-body-1', text: 'Listen for OSC' }));

    const port = h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'UDP port' }),
      h('input', {
        class: 'wru-input', type: 'text', value: String(state.settings.oscPort),
        style: { maxWidth: '7rem' },
        disabled: state.saving ? 'disabled' : null,
        /* Committed on blur and on Enter, not per keystroke: rebinding a UDP
           socket on the way from 8000 to 9000 would bind 900 first. */
        onBlur: (ev) => commitPort(ev.target.value),
        onKeyDown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); } }
      }));

    const rows = live
      ? h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
        readout('State', live.listening ? `listening on ${live.address}:${live.port}` : 'not listening',
          { tone: live.listening ? null : 'tertiary' }),
        readout('Received', String(live.received)),
        readout('Writes sent', String(live.sent)),
        readout('Refused', String(live.failed), { tone: live.failed ? null : 'tertiary' }))
      : null;

    const notes = [];
    if (live && live.lastError) notes.push(note('warn', live.lastError));
    if (on) {
      notes.push(note('info',
        `Addresses start ${OSC_ROOT}/ — the full dictionary is in docs/OSC.md. `
        + 'Messages are written to the switcher over AWJ on TCP 10606, which works with no '
        + 'browser open; that port can be switched off in the Web RCS security settings.'));
      notes.push(note('info',
        'preview and program are refused here and answered only in the console: naming a '
        + 'buffer needs the device’s take state, which this process does not hold. Address a '
        + 'buffer directly — /a, /b or /c.'));
    }

    return card('OSC input',
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        toggle, port,
        picker('Accept from', OSC_BIND_CHOICES, state.settings.oscBind, (v) => put({ oscBind: v }))),
      rows, ...notes);
  }

  function commitPort(raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 1024 || n >= 65536) {
      /* Refused rather than clamped, and the field is repainted with what is
         actually in force — a silently corrected port is one an operator will
         spend an hour sending to. */
      state.saveError = `${raw} is not a usable port — pick something above 1024`;
      return onRefresh();
    }
    if (n === state.settings.oscPort) return;
    void put({ oscPort: n });
  }

  /* -------------------------------------------------------------- planned */

  function plannedSection() {
    return card('Still to come',
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

  /* Refreshing has to re-read the settings too, not just the device status —
     another window may have changed one. */

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
      compatibilitySection(),
      consoleSection(),
      oscSection(),
      timecodeSection(),
      proxySection(),
      featureSection(),
      plannedSection());
    return panel({ toolbar: toolbar(), body });
  }

  return { render };
}
