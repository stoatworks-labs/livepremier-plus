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
  AWJ_TRANSPORTS, CONSOLE_MODELS, DEFAULT_SETTINGS, LANGUAGE_CHOICES, OSC_BIND_CHOICES
} from '../core/settings.js';
import { OSC_ROOT } from '../vendor/mynah-lang.mjs';
import { insecureContextAdvice } from '../core/secure-context.js';

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
    name: 'Edit',
    where: 'Sidebar, under PLUS',
    what: 'The Screens / Aux. layout with one row, on neither bus. Programme a look, '
      + 'then save it into a real memory.',
    needs: 'layerProperties'
  },
  {
    name: 'Companion',
    where: 'Sidebar, under PLUS',
    what: 'A Bitfocus Companion on this address — its buttons, web buttons and emulator — '
      + 'and the connections that belong in the show for this switcher.'
    /* No `needs`: Companion knows nothing of which platform the switcher is,
       and the panel is as useful beside a Midra as beside a LivePremier. */
  },
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
    name: 'Memories',
    where: 'Sidebar, under PLUS',
    what: 'Every memory bank in one list, with recall, save, rename and erase — and a window of its own.',
    needs: 'cueStack'
  },
  {
    name: 'Layer',
    where: 'Screens / Aux., beside Properties',
    what: 'Every property of a named layer, generated from the device\u2019s own parameter catalogue.',
    needs: 'layerProperties'
  },
  {
    name: 'Layer names',
    where: 'The Layer tab, and every layer list',
    what: 'Name a layer and the name shows in the vendor\u2019s own lists \u2014 the switcher has nowhere to keep one.',
    needs: 'layerGroups'
  },
  {
    name: 'Layer Groups',
    where: 'Sidebar, under PLUS, and a Groups tab',
    what: 'Several layers, across screens, driven as one \u2014 and a gang that follows a change to any of them.',
    needs: 'layerGroups'
  },
  {
    name: 'Send to',
    where: 'The \u2026 on every source card',
    what: 'Route an input to a layer or a whole group, in preview or program, without a drag.',
    needs: 'layerGroups'
  },
  {
    name: 'Matrix Routing',
    where: 'Sidebar, under PLUS',
    what: 'Patch the frame to a Videohub, Lightware or Turtle AV router and route through it.',
    needs: 'matrixRouting'
  },
  {
    name: 'Pitch Compensation',
    where: 'Preconfig flyout',
    what: 'The H and V ratios for a screen spanning LED walls of different pitches.',
    needs: 'pitchCompensation'
  },
  {
    name: 'OSC input',
    where: 'This page',
    what: 'QLab, TouchOSC or a lighting desk driving the switcher over UDP, with no browser open.'
  },
  {
    name: 'Timecode',
    where: 'This page, and the Timeline',
    what: 'Fire cues from MIDI Time Code, LTC on an audio input, or a timecode pushed to this app.',
    needs: 'cueStack'
  },
  {
    name: 'MIDI Mapping',
    where: 'Sidebar, under Virtual RC400T',
    what: 'A MIDI control surface driving the switcher from this page.',
    needs: 'console'
  },
  {
    name: 'Pixelhue panel',
    where: 'This page (preview)',
    what: 'A Pixelhue U5, U5 Pro or U5 mini driving the switcher. Never yet run against a console.'
  },
  {
    name: 'Setup file',
    where: '/__lpp/config',
    what: 'Cue stack, groups, layer names, router patch and settings as one JSON file, and back.'
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
    pixelhue: null,
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
      state.pixelhue = state.status.pixelhue || null;
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
      state.pixelhue = body.pixelhue || null;
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
      /* The product name when the code is one we have met — `PULSE` is a
         Pulse 4K — and the code itself when it is not. */
      readout('Model', here.modelName || here.model || 'unknown', { tone: here.model ? null : 'tertiary' }),
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
      notes.push(note('warn', insecureContextAdvice(window.location)));
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
        readout('Refused', String(live.failed), { tone: live.failed ? null : 'tertiary' }),
        /* Which platform the addresses are spelled for. The listener asks
           the switcher on the first packet; until then it has not decided. */
        readout('Spelled for', live.platform || 'asked on the first message',
          { tone: live.platform ? null : 'tertiary' }))
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

  /* --------------------------------------------------------------- panel */

  /**
   * A Pixelhue U-series console.  ** PREVIEW **
   *
   * Marked preview in as many words, because it has never been run against a
   * console: every byte of it was worked out from firmware and proved against
   * the vendor's own control service running headless in a VM. That is a long
   * way from a panel on a desk, and an operator deciding whether to rig one
   * deserves to be told which it is.
   *
   * It is also the second setting on this page that writes to a switcher
   * without anybody looking at a browser, so it is off until somebody turns it
   * on, exactly like the OSC listener.
   */
  function pixelhueSection() {
    const on = state.settings.pixelhueEnabled;
    const live = state.pixelhue;
    const link = live && live.link;
    const model = CONSOLE_MODELS.find((m) => m.id === state.settings.pixelhueModel);

    const toggle = h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', style: { cursor: 'pointer' } },
      h('input', {
        type: 'checkbox',
        checked: on ? 'checked' : null,
        disabled: state.saving ? 'disabled' : null,
        onChange: (ev) => put({ pixelhueEnabled: ev.target.checked })
      }),
      h('span', { class: 'aw-font-body-1', text: 'Drive a Pixelhue console' }));

    const host = h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Console address' }),
      h('input', {
        class: 'wru-input', type: 'text', value: state.settings.pixelhueHost,
        placeholder: model && model.overLan ? '192.168.2.50' : '127.0.0.1',
        style: { maxWidth: '12rem' },
        disabled: state.saving ? 'disabled' : null,
        /* On blur, not per keystroke: a link is rebuilt on every change and
           retyping an address would dial four consoles that do not exist. */
        onBlur: (ev) => commitPanelHost(ev.target.value),
        onKeyDown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); } }
      }));

    const rows = live
      ? h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
        readout('Link', link && link.connected ? `connected to ${link.host}:${link.port}` : 'not connected',
          { tone: link && link.connected ? null : 'tertiary' }),
        readout('Published', link ? String(link.published) : '0'),
        readout('Commands', link ? String(link.commands) : '0'),
        readout('Selected', live.selection.destinations.join(' ') || 'nothing on the panel',
          { tone: live.selection.destinations.length ? null : 'tertiary' }),
        readout('Editing', live.selection.buffer, { tone: live.selection.buffer === 'PROGRAM' ? 'warn' : null }))
      : null;

    const notes = [note('warn',
      'Preview. This has never been run against a console — it was built from the '
      + 'firmware and proved against the vendor’s own control service running with no '
      + 'hardware. Treat the first show with one as a rehearsal.')];

    if (model && !model.overLan) {
      notes.push(note('warn',
        `A ${model.label} serves its control port on loopback only, so this app has to be `
        + 'running on the console itself to reach one. A U5 mini answers on the network.'));
    }
    if (link && link.lastError) notes.push(note('warn', link.lastError));
    if (on) {
      notes.push(note('info',
        'The console is handed a model of this switcher — its screens, inputs and memories — '
        + 'and labels, lights and pages its own keys from it. What comes back is what the '
        + 'operator meant, so there is no key mapping to keep. docs/PIXELHUE.md has the rest.'));
      notes.push(note('info',
        'A recall from the panel always lands in preview, whatever PGM EDIT is doing, for the '
        + 'same reason every other recall in this app does. Fade to black and freeze are '
        + 'reported by the console and not yet sent anywhere.'));
      notes.push(note('info',
        'Tally is read when the panel connects and after each change it makes. A take fired '
        + 'from the Web RCS or the front panel does not relight the console’s keys until then.'));
    }

    const history = live && live.history && live.history.length
      ? h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        live.history.slice(0, 5).map((e) => h('div', {
          class: ['aw-font-caption', e.error ? 'wru-warn' : 'aw-text-tertiary'],
          text: [e.command, e.note || e.error || e.kind].filter(Boolean).join(' — ')
        })))
      : null;

    return card('Pixelhue panel',
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        toggle, host,
        picker('Console', CONSOLE_MODELS, state.settings.pixelhueModel, (v) => put({ pixelhueModel: v }))),
      rows, history, ...notes);
  }

  function commitPanelHost(raw) {
    const value = String(raw || '').trim();
    if (value === state.settings.pixelhueHost) return;
    if (value && !/^[A-Za-z0-9._-]+$/.test(value)) {
      state.saveError = `${raw} is not a host name or address`;
      return onRefresh();
    }
    void put({ pixelhueHost: value });
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

  /**
   * Where the Edit page's memory file is written for the switcher to read.
   *
   * ⚠️ The only setting on this page that names a path on the OTHER machine.
   * `presetBank/import/extract` is resolved by the device, so on a simulator
   * this app's own temporary directory is also the device's and the default
   * works; on a real switcher it is the switcher's disk, and an installation
   * has to give both of them one directory they can each see. Left empty it
   * falls back to a temporary directory here, which is right for a simulator
   * and wrong for a box — and the save says so rather than failing silently.
   */
  function memorySection() {
    return card('Saving memories from the Edit page',
      h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Shared directory' }),
        h('input', {
          class: 'wru-input', type: 'text', value: state.settings.memoryImportDir || '',
          placeholder: '/Volumes/showshare/lpp',
          style: { maxWidth: '20rem' },
          disabled: state.saving ? 'disabled' : null,
          onBlur: (ev) => {
            const value = ev.target.value.trim();
            if (value !== (state.settings.memoryImportDir || '')) void put({ memoryImportDir: value });
          },
          onKeyDown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); } }
        })),
      note(null,
        'The Edit page can write a memory straight into the bank, touching neither preview nor '
        + 'program. It does it by handing the switcher a file — and the path is resolved by the '
        + 'switcher, not by this app. Both are the same machine on a simulator, so leaving this '
        + 'empty works there.'),
      note('warn',
        'On real hardware this has to be an absolute path both machines can see, and it has not '
        + 'been proven on one. The Edit page’s “Via preview” route needs none of this and works '
        + 'on any switcher.'));
  }

  function render() {
    loadStatus();
    const body = h('div', { class: 'aw-flex-col aw-gap-row-large' },
      deviceSection(),
      compatibilitySection(),
      consoleSection(),
      oscSection(),
      memorySection(),
      pixelhueSection(),
      timecodeSection(),
      proxySection(),
      featureSection(),
      plannedSection());
    return panel({ toolbar: toolbar(), body });
  }

  return { render };
}
