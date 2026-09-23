/*
 * Multiviewer slicer — where the multiviewer picture comes from. Page side.
 *
 * Each opener resolves `{ stream, label, stop() }`, a MediaStream with one
 * video track and a way to let it go:
 *
 *   camera  a capture card this browser can see — anything that shows up
 *           as a webcam: UVC cards (Magewell, Elgato, …), and a DeckLink
 *           where Blackmagic's driver offers it as one. Needs a secure
 *           context, like the LTC timecode source.
 *   whep    a WebRTC stream from a WHEP endpoint — MediaMTX re-serving an
 *           encoder, or a Midra / Alta's own streamer pushing RTMP to it.
 *           Works from any machine that can reach it.
 *   test    a multiviewer drawn here from the switcher's own layout, for a
 *           simulator, which has no multiviewer output to capture.
 */

import { createTestCard } from './testcard.js';

export const MODES = ['off', 'camera', 'whep', 'test'];

/** The video inputs this browser can see: `[{ id, label }]`. */
export async function listCameras(nav = globalThis.navigator) {
  if (!nav || !nav.mediaDevices || !nav.mediaDevices.enumerateDevices) return [];
  const all = await nav.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Video input ${i + 1}` }));
}

export async function openCamera(deviceId, nav = globalThis.navigator) {
  if (!nav || !nav.mediaDevices || !nav.mediaDevices.getUserMedia) {
    throw new Error('This browser offers no capture devices here — a secure context (localhost or https) is needed.');
  }
  /* Ask for the multiviewer's full raster; a card that cannot offers less and
     the crops scale to whatever arrives. */
  const stream = await nav.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }
    }
  });
  const track = stream.getVideoTracks()[0];
  return {
    stream,
    label: track ? track.label : 'capture',
    stop: () => stream.getTracks().forEach((t) => t.stop())
  };
}

/* A candidate that has not turned up by now is not worth holding the offer
   for: on one LAN, host candidates arrive in milliseconds. */
const ICE_WAIT_MS = 1500;

export async function openWhep(url, { fetchImpl = globalThis.fetch, Peer = globalThis.RTCPeerConnection } = {}) {
  if (!url) throw new Error('No WHEP address set.');
  if (!Peer) throw new Error('This browser has no WebRTC.');
  const pc = new Peer();
  const stream = new MediaStream();
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addEventListener('track', (ev) => { if (ev.track.kind === 'video') stream.addTrack(ev.track); });
  let resource = null;
  const stop = () => {
    try { pc.close(); } catch { /* already closed */ }
    if (resource) fetchImpl(resource, { method: 'DELETE' }).catch(() => {});
  };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const t = setTimeout(resolve, ICE_WAIT_MS);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
      });
    });
    const res = await fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/sdp' }, body: pc.localDescription.sdp
    });
    if (!res.ok) {
      throw new Error(res.status === 404
        ? `Nothing is publishing at ${url} yet (404).`
        : `The WHEP server answered ${res.status}.`);
    }
    const loc = res.headers.get('location');
    if (loc) resource = new URL(loc, url).href;
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  } catch (err) {
    stop();
    if (err instanceof TypeError) throw new Error(`Could not reach ${url} — is MediaMTX running, and does it allow this origin?`);
    throw err;
  }
  return { stream, label: new URL(url).host, stop, peer: pc };
}

/** @param {() => {raster: {width:number,height:number}|null, tiles: any[]}} layout */
export function openTest(layout) {
  const card = createTestCard({ layout });
  return { stream: card.stream, label: 'Test pattern', stop: card.stop };
}
