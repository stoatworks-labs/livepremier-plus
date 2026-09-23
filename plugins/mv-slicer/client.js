/*
 * Multiviewer slicer — the plugin's page half.  ** PREVIEW **
 *
 * The switcher already draws every source it has, live, on a multiviewer. Put
 * that multiviewer into this browser — a capture card, or a stream — and the
 * store says to the pixel where each source sits in it. This cuts each one
 * out and puts it into the page's thumbnails in place of the once-a-second
 * PNG, at up to 25 frames a second (`swap.js`).
 *
 * Where the picture comes from is chosen **per browser** and kept in this
 * browser's local storage — a capture card is plugged into one machine, and a
 * tablet on the show Wi-Fi wants the stream instead. The geometry and the
 * stream's address are the install's settings, shared by every page.
 *
 * On a Midra 4K or Alta 4K the switcher can be its own capture: its H.264
 * streamer takes the multiviewer as a source and pushes RTMP to a MediaMTX,
 * which serves it back as WHEP. The card has the two buttons for that, and
 * never presses them itself.
 *
 * Nothing is replaced while the picture is stale: three seconds without a
 * new video frame hands every thumbnail back to the switcher.
 */

import {
  ASPECTS, ALIGNS, LIMITS, family, multiviewers, raster, tilesFromStore, planCrops, pictureRect,
  scaleRect, streamerState, streamerStart, streamerStop, isOurs, whepFromRtmp
} from './core.js';
import { MODES, listCameras, openCamera, openWhep, openTest } from './capture.js';
import { createSwapper } from './swap.js';
import { insecureContextAdvice } from '../../src/core/secure-context.js';

const LOCAL_KEY = 'lpp.mv-slicer';
/* Without a new frame for this long the capture is stale and the switcher's
   own pictures come back. */
const STALE_MS = 3000;
const RETRY_MS = 5000;
const PREVIEW_MS = 200;

function readLocal() {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}');
    return { mode: MODES.includes(v.mode) ? v.mode : 'off', deviceId: typeof v.deviceId === 'string' ? v.deviceId : '' };
  } catch { return { mode: 'off', deviceId: '' }; }
}

function writeLocal(v) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(v)); } catch { /* private window: this page only */ }
}

export default function activate(ctx) {
  const { h, button, readout, card, note, picker } = ctx.kit;
  const store = ctx.session.store;

  let settings = ctx.settings.get();
  let local = readLocal();
  let saving = false;
  let saveError = null;

  /* ------------------------------------------------------------ the feed */

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  /* In the document, one pixel, invisible: a video that is not attached may
     not decode frames a canvas can draw. */
  Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  video.setAttribute('aria-hidden', 'true');

  const feed = {
    state: 'off',          // off | opening | waiting | live | stale | error
    message: '',
    label: '',
    handle: null,
    lastFrame: 0,
    frames: 0,
    since: 0,
    retry: null,
    generation: 0
  };

  function layout() {
    const n = family(store) === 'mng' ? 1 : settings.multiviewer;
    return { raster: raster(store, n), tiles: tilesFromStore(store, n) };
  }

  function crops() {
    const { raster: mv, tiles } = layout();
    if (!video.videoWidth) return new Map();
    return planCrops(tiles, mv, { width: video.videoWidth, height: video.videoHeight }, settings);
  }

  const swapper = createSwapper({
    doc: document, win: window, settings: () => settings,
    frame: () => ({ video, crops: crops() })
  });

  /* Frames arriving: the one fact that says the feed is alive. */
  function watchFrames() {
    if (typeof video.requestVideoFrameCallback === 'function') {
      const gen = feed.generation;
      const cb = () => {
        if (gen !== feed.generation) return;
        feed.lastFrame = performance.now();
        feed.frames += 1;
        video.requestVideoFrameCallback(cb);
      };
      video.requestVideoFrameCallback(cb);
    }
  }
  /* The frame callback only fires while the page is being rendered, and a
     page in a background window is not. So a video whose clock is moving, with
     a frame to draw and a track that is not muted — a track stops getting
     frames goes muted, which is how a stalled capture or peer shows — counts
     as alive too. */
  let lastTime = -1;
  setInterval(() => {
    const track = video.srcObject && video.srcObject.getVideoTracks ? video.srcObject.getVideoTracks()[0] : null;
    if (track && !track.muted && track.readyState === 'live' && video.readyState >= 2 && video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      feed.lastFrame = performance.now();
      if (!feed.frames) feed.frames = 1;
    }
    if (feed.state === 'off' || feed.state === 'opening' || feed.state === 'error') { swapper.setLive(false); return; }
    const fresh = feed.lastFrame && performance.now() - feed.lastFrame < STALE_MS;
    feed.state = fresh ? 'live' : feed.frames ? 'stale' : 'waiting';
    swapper.setLive(Boolean(fresh) && !document.hidden);
  }, 500);

  function close() {
    feed.generation += 1;
    clearTimeout(feed.retry);
    feed.retry = null;
    swapper.setLive(false);
    if (feed.handle) { try { feed.handle.stop(); } catch { /* gone */ } }
    feed.handle = null;
    video.srcObject = null;
    feed.frames = 0;
    feed.lastFrame = 0;
  }

  async function open() {
    close();
    const gen = feed.generation;
    if (local.mode === 'off') { feed.state = 'off'; feed.message = ''; ctx.refresh(); return; }
    feed.state = 'opening';
    feed.message = '';
    ctx.refresh();
    try {
      const whep = settings.whepUrl || whepFromRtmp(settings.rtmpUrl);
      const handle = local.mode === 'camera' ? await openCamera(local.deviceId)
        : local.mode === 'whep' ? await openWhep(whep)
        : openTest(layout);
      if (gen !== feed.generation) { handle.stop(); return; }
      feed.handle = handle;
      feed.label = handle.label;
      feed.since = Date.now();
      if (!video.isConnected) document.body.append(video);
      video.srcObject = handle.stream;
      video.play().catch(() => {});
      watchFrames();
      feed.state = 'waiting';
      /* A stream that ends — a card unplugged, a WHEP peer gone — is tried
         again, as is one that never opened. */
      const again = (why) => {
        if (gen !== feed.generation) return;
        fail(why);
      };
      for (const t of handle.stream.getTracks()) t.addEventListener('ended', () => again('The capture ended.'));
      if (handle.peer) {
        handle.peer.addEventListener('connectionstatechange', () => {
          const s = handle.peer.connectionState;
          if (s === 'failed' || s === 'closed') again(`The stream's connection ${s}.`);
        });
      }
    } catch (err) {
      if (gen !== feed.generation) return;
      fail(err && err.message ? err.message : String(err));
    }
    ctx.refresh();
  }

  function fail(message) {
    const mode = local.mode;
    close();
    feed.state = 'error';
    feed.message = message;
    if (mode === 'camera' || mode === 'whep') feed.retry = setTimeout(open, RETRY_MS);
    ctx.refresh();
  }

  /* The store arrives after the page halves start; a test pattern drawn
     before it has nothing to draw, and redraws once it has. */
  if (store.ready) open(); else store.addEventListener('ready', () => open(), { once: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && feed.state === 'error' && !feed.retry) open();
  });

  /* ----------------------------------------------------------- the card */

  async function put(patch) {
    saving = true; saveError = null; ctx.refresh();
    const before = settings;
    try { settings = await ctx.settings.set(patch); }
    catch (err) { saveError = err.message; }
    saving = false;
    swapper.retime();
    /* A new stream address reopens a page that is playing the stream. */
    if (local.mode === 'whep' && (before.whepUrl !== settings.whepUrl || before.rtmpUrl !== settings.rtmpUrl)) open();
    ctx.refresh();
  }

  function setLocal(patch) {
    local = { ...local, ...patch };
    writeLocal(local);
    open();
  }

  /* The preview is built once and redrawn in place: the app repaints the
     settings page on every frame the switcher sends. */
  const preview = h('canvas', { width: '640', height: '360', style: { width: '100%', maxWidth: '640px', background: '#000', borderRadius: '4px' } });
  let previewTimer = null;
  function drawPreview() {
    if (!preview.isConnected) { clearInterval(previewTimer); previewTimer = null; return; }
    const g = preview.getContext('2d');
    const W = preview.width;
    const H = preview.height;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    const cap = video.videoWidth ? { width: video.videoWidth, height: video.videoHeight } : null;
    if (cap) g.drawImage(video, 0, 0, W, H);
    const { raster: mv, tiles } = layout();
    if (!mv) return;
    const view = { width: W, height: H };
    g.lineWidth = 1;
    g.font = '11px sans-serif';
    for (const t of tiles) {
      const tile = scaleRect(t.rect, mv, view);
      g.setLineDash([3, 3]);
      g.strokeStyle = 'rgba(255,255,255,0.45)';
      g.strokeRect(tile.x + 0.5, tile.y + 0.5, tile.w - 1, tile.h - 1);
      g.setLineDash([]);
      if (!t.path) continue;
      const pic = scaleRect(pictureRect(t.rect, settings), mv, view);
      g.strokeStyle = '#3c3';
      g.lineWidth = 2;
      g.strokeRect(pic.x + 1, pic.y + 1, pic.w - 2, pic.h - 2);
      g.lineWidth = 1;
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(pic.x + 2, pic.y + 2, g.measureText(t.source).width + 6, 14);
      g.fillStyle = '#9f9';
      g.fillText(t.source, pic.x + 5, pic.y + 13);
    }
  }

  const STATE_TEXT = {
    off: 'Off in this browser.',
    opening: 'Opening…',
    waiting: 'Opened — waiting for the first frame.',
    live: 'Live — thumbnails are being cut from it.',
    stale: `No new frame for ${STALE_MS / 1000} s — the switcher's own thumbnails are back until one arrives.`,
    error: 'Failed.'
  };

  let cameras = null;
  function loadCameras() {
    if (cameras) return;
    cameras = [];
    listCameras().then((list) => { cameras = list; ctx.refresh(); }).catch(() => {});
  }

  const text = (label, key, placeholder, hint) => h('div', { class: 'aw-flex-col aw-gap-row-mini', style: { flex: '1 1 22rem' } },
    h('div', { class: 'aw-font-overline aw-text-tertiary', text: label }),
    h('input', {
      class: 'wru-input', type: 'text', value: settings[key], placeholder, title: hint,
      style: { maxWidth: '28rem' }, disabled: saving ? 'disabled' : null,
      onChange: (ev) => put({ [key]: ev.target.value })
    }));

  const number = (label, key, [min, max], hint, step = null) => h('div', { class: 'aw-flex-col aw-gap-row-mini' },
    h('div', { class: 'aw-font-overline aw-text-tertiary', text: label }),
    h('input', {
      class: 'wru-input', type: 'number', min: String(min), max: String(max), step,
      value: String(settings[key]), title: hint, style: { maxWidth: '6rem' },
      disabled: saving ? 'disabled' : null,
      onChange: (ev) => put({ [key]: Number(ev.target.value) })
    }));

  function streamerSection() {
    const st = streamerState(store);
    if (!st) return null;
    const ours = isOurs(st, settings.rtmpUrl);
    const plan = streamerStart(st, { rtmpUrl: settings.rtmpUrl, slot: settings.streamSlot });
    const sendAll = (cmds) => {
      let sent = 0;
      for (const c of cmds) if (ctx.session.send(c)) sent += 1;
      return sent;
    };
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-subtitle-2', text: 'The switcher’s own streamer' }),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        text('RTMP address (MediaMTX)', 'rtmpUrl', 'rtmp://192.168.2.69:1935/lpp-mv',
          'Where the streamer pushes. MediaMTX takes RTMP on 1935 and serves the same path as WHEP on 8889.'),
        number('Destination slot', 'streamSlot', LIMITS.streamSlot, 'The streamer’s destination this address is written into. 1–4 come from the factory.')),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        readout('Streamer', st.status, { tone: st.running ? null : 'tertiary' }),
        readout('Carrying', st.source || '—'),
        readout('Profile', st.profile || '—'),
        readout('Bit rate', st.bitrate ? `${st.bitrate} kbit/s` : '—')),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        ours && st.running
          ? button('Stop the streamer', { onClick: () => { sendAll([streamerStop()]); ctx.refresh(); } })
          : button('Stream the multiviewer here', {
            variant: 'active',
            disabled: !plan.ok,
            title: plan.ok ? `Writes destination ${settings.streamSlot}, sets the streamer to the multiviewer and starts it.` : plan.why,
            onClick: () => {
              if (!plan.ok) return;
              if (!window.confirm(`Point the switcher's streamer at ${settings.rtmpUrl} (destination ${settings.streamSlot}), with the multiviewer as its picture, and start it? It is the unit's only streamer.`)) return;
              sendAll(plan.cmds);
              ctx.refresh();
            }
          })),
      plan.ok ? null : note('warn', plan.why),
      st.hdcpWarning ? note('warn', 'The streamer reports HDCP content: it sends black in its place.') : null,
      note('info', `Derived WHEP address: ${settings.whepUrl || whepFromRtmp(settings.rtmpUrl) || '— set the RTMP address first'}. `
        + 'The stream is 720p and a second or so behind the switcher — slower than a capture card, far quicker than the PNGs.'));
  }

  function render() {
    const fam = family(store);
    if (!fam) {
      return card('Multiviewer thumbnails',
        note('info', store.ready ? 'This switcher has no multiviewer this can read.' : 'Waiting for the switcher.'));
    }
    const { raster: mv, tiles } = layout();
    const plan = crops();
    const st = swapper.stats();

    if (!previewTimer) previewTimer = setInterval(drawPreview, PREVIEW_MS);
    if (local.mode === 'camera') loadCameras();

    const modes = [
      { id: 'off', label: 'Off', what: 'This browser shows the switcher’s own thumbnails.' },
      { id: 'camera', label: 'Capture device', what: 'A capture card on this machine carrying the multiviewer output. Needs localhost or https.' },
      { id: 'whep', label: 'Stream (WHEP)', what: 'A WebRTC stream of the multiviewer from MediaMTX — an encoder, or a Midra’s own streamer. Works from any machine.' },
      { id: 'test', label: 'Test pattern', what: 'A multiviewer drawn here from the store’s layout, for a simulator. Changes nothing on the switcher.' }
    ];

    const secureNote = local.mode === 'camera' && !window.isSecureContext ? note('warn', insecureContextAdvice(window.location)) : null;

    const table = tiles.length
      ? h('table', { class: 'aw-font-caption' },
        h('thead', {}, h('tr', { class: 'aw-text-tertiary' },
          ['Widget', 'Source', 'Where', 'Thumbnail', 'Cut at'].map((t) => h('td', { text: t, style: { padding: '2px 12px 2px 0' } })))),
        h('tbody', {}, tiles.map((t) => {
          const c = t.path && plan.get(t.path);
          const cell = (v, cls = '') => h('td', { class: cls, text: v, style: { padding: '2px 12px 2px 0' } });
          return h('tr', {},
            cell(t.widget),
            cell(t.source),
            cell(`${t.rect.w}×${t.rect.h} at ${t.rect.x},${t.rect.y}`, 'aw-text-secondary'),
            cell(t.path ? t.path.replace('/api/device/snapshots/', '') : 'none drawn', t.path ? '' : 'aw-text-tertiary'),
            cell(c ? `${c.crop.w}×${c.crop.h} → ${c.width}×${c.height}` : '—', 'aw-text-secondary'));
        })))
      : note('info', 'Nothing on this multiviewer has a source.');

    const mvs = multiviewers(store);
    return card('Multiviewer thumbnails',
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        picker('This browser’s picture', modes, local.mode, (mode) => setLocal({ mode })),
        local.mode === 'camera' && cameras && cameras.length
          ? picker('Capture device', [{ id: '', label: 'Default', what: 'Whatever the browser offers first.' },
            ...cameras.map((c) => ({ id: c.id, label: c.label, what: c.label }))], local.deviceId, (deviceId) => setLocal({ deviceId }))
          : null),
      local.mode === 'whep' ? text('WHEP address', 'whepUrl', whepFromRtmp(settings.rtmpUrl) || 'http://192.168.2.69:8889/lpp-mv/whep',
        'MediaMTX serves http://<host>:8889/<path>/whep. Left empty, it is worked out from the RTMP address below.') : null,
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        readout('Feed', feed.state === 'error' ? `Failed: ${feed.message}` : STATE_TEXT[feed.state],
          { tone: feed.state === 'live' ? null : feed.state === 'error' || feed.state === 'stale' ? 'warn' : 'tertiary' }),
        video.videoWidth ? readout('Arriving', `${video.videoWidth}×${video.videoHeight} · ${feed.label}`) : null,
        mv ? readout('Multiviewer', `${mv.width}×${mv.height}`) : null,
        readout('Replacing', `${st.sources} sources · ${st.images} images`),
        st.frames ? readout('Cut + encode', `${(st.encodeMs / st.frames).toFixed(1)} ms a round`) : null),
      preview,
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        fam === 'nlc' ? picker('Multiviewer', mvs.map((n) => ({ id: String(n), label: `Multiviewer ${n}`, what: 'The one whose output is on the capture.' })),
          String(settings.multiviewer), (v) => put({ multiviewer: Number(v) }), { disabled: saving }) : null,
        picker('Picture in a widget', ASPECTS.map((a) => ({ id: a, label: a === 'tile' ? 'The whole widget' : `${a}, fitted`,
          what: a === 'tile' ? 'Cuts the widget edge to edge, label band and all.' : `A ${a} picture fitted inside the widget; the band left over is where the label sits.` })),
        settings.aspect, (aspect) => put({ aspect }), { disabled: saving }),
        picker('Sits', ALIGNS.map((a) => ({ id: a, label: a[0].toUpperCase() + a.slice(1),
          what: 'Where a fitted picture is in a widget taller than it. Check the green boxes against the picture.' })),
        settings.align, (align) => put({ align }), { disabled: saving })),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        number('Trim (%)', 'insetPct', LIMITS.insetPct, 'Taken off every edge of the picture — for a tally border drawn over it.', '0.5'),
        number('Frames a second', 'fps', LIMITS.fps, 'How often the thumbnails are redrawn. 1–25.'),
        number('Max width (px)', 'maxWidth', LIMITS.maxWidth, 'A thumbnail is drawn at its size in the capture, up to this.')),
      table,
      fam === 'mng' ? streamerSection() : null,
      saveError ? note('warn', `Could not save: ${saveError}`) : null,
      secureNote,
      note('warn', 'Preview. Proven on a simulator with the test pattern only — never yet against a real multiviewer output or a real streamer. '
        + 'Set this browser to Off, or switch the plugin off, and every thumbnail comes from the switcher as before.'),
      note('info', 'Green boxes are what is cut; dashed ones are the widgets. Only inputs'
        + (fam === 'nlc' ? ' and stills' : '') + ' have thumbnails to replace. A source missing from the multiviewer keeps the switcher’s picture.'));
  }

  ctx.ui.settingsSection({ id: 'mv-slicer', order: 21, render });
  /* What is going on, for `window.__WRU.shared` on a day with hardware. */
  ctx.share({ stats: swapper.stats, feed: () => ({ state: feed.state, message: feed.message, label: feed.label, frames: feed.frames }), crops });
}
