/*
 * Demo seed — makes a simulator look like a real Aquilon C.
 *
 * Injected by `npm run demo` only. Nothing in the shipping product loads this,
 * and the proxy injects no extra modules unless it is asked to.
 *
 * ## Why this has to exist
 *
 * The panels live inside the vendor's Web RCS, so a demo without Web RCS is a
 * demo of something that is not the product. The LivePremier Simulator gives
 * us the real thing — and the one feature it cannot give us is the headline
 * one: **a simulator has no VPU at all**. It carries a `vpuLayerList` that is
 * present and permanently empty, and no `vpuMixerList`, so the VPU panel
 * against a bare simulator correctly reports that there is nothing to draw.
 *
 * So the demo folds the recorded Aquilon C resource subtree into the store
 * after hydration. The result is the real vendor UI, driven by a real
 * simulator, showing a real device's mixer allocation: 32 of 64 mixers fitted,
 * interleaved output links, Optimized mode on S1, and a staged preconfig that
 * differs from the running one in 26 mixers — the case a properties-only diff
 * would call "no change".
 *
 * ## What it does NOT do
 *
 * It does not touch the simulator, and it does not fake the socket. Everything
 * outside `preconfig/resources` is the simulator's own live state, so the
 * timeline still fires real preset recalls and takes at it and you still see
 * the frames on the wire. Only the resource subtree is substituted.
 */

const TAG = '[LivePremier Plus demo]';
const CAPTURE = '/__lpp/demo/resources.json';

/** Wait for main.js to finish booting, or give up rather than hang forever. */
function waitForApp(timeoutMs = 30000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (window.__WRU && window.__WRU.session && window.__WRU.session.store.ready) {
        resolve(window.__WRU);
      } else if (Date.now() - started > timeoutMs) {
        resolve(null);
      } else {
        setTimeout(tick, 150);
      }
    };
    tick();
  });
}

async function seed() {
  const app = await waitForApp();
  if (!app) {
    console.warn(TAG, 'the panels never became ready — nothing seeded');
    return;
  }

  let capture;
  try {
    const res = await fetch(CAPTURE, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    capture = await res.json();
  } catch (err) {
    console.error(TAG, 'could not load the capture', err);
    return;
  }

  const resources = capture?.device?.preconfig?.resources;
  if (!resources) {
    console.error(TAG, 'capture is not shaped as device/preconfig/resources');
    return;
  }

  const store = app.session.store;
  const root = store.root?.device;
  if (!root) {
    console.error(TAG, 'no device store to seed into');
    return;
  }

  /* Written straight into the tree rather than through store.set().
     `startsWith(path, prefix)` only notifies subscribers whose prefix is a
     prefix of the written path, so one write at `preconfig/resources` would
     reach nobody watching deeper — the panels subscribe well below it. A
     direct splice plus an explicit repaint is honest about that. */
  root.preconfig = root.preconfig || {};
  root.preconfig.resources = resources;

  if (app.shell && typeof app.shell.refresh === 'function') app.shell.refresh();

  const fitted = Object.values(
    resources.current?.status?.mapping?.deviceList?.items?.['1']?.vpuMixerList?.items || {}
  ).filter((m) => m?.pp?.isAvailable).length;

  console.info(
    TAG,
    `seeded a real Aquilon C resource map (${fitted} mixers fitted).`,
    'Everything outside preconfig/resources is still the simulator\'s own live state.'
  );
  window.__LPP_DEMO = { seeded: true, fitted };
}

seed().catch((err) => console.error(TAG, 'seed failed', err));
