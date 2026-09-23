/*
 * The EDID builder's window: the Otter editor, with this switcher as its host.
 *
 * `own` is what `client.js` shares — the bank as the Web RCS tab's store has
 * it, and a `save` that posts through that tab. This file only translates it
 * into the `EdidHost` shape Otter's `src/host.ts` declares; everything about
 * the device stays in the plugin, and everything about EDIDs in Otter.
 */

/** The `EdidHost` Otter's editor asks for, over what the plugin shares. */
export function editorHost(own, initial) {
  return {
    title: own.title(),
    /* Otter's HostSlot is a subset of a bank slot; the bytes stay behind. */
    slots: () => own.slots().map(({ id, label, name, empty, locked }) => ({ id, label, name, empty, locked })),
    subscribe: (fn) => own.subscribe(fn),
    save: (slotId, bytes) => own.save(slotId, bytes),
    ...(initial ? { initial } : {}),
    ...mosaicHost(own)
  };
}

/*
 * A mosaic's tiles straight onto input plugs, grouped into one input — when
 * the `edid-mosaic` plugin is on to do it. Otter shows its Apply panel only
 * where the host has these, so with that plugin off they are simply absent.
 * Asked for per call: the service can come and go under an open window.
 */
function mosaicHost(own) {
  if (!own.mosaic || !own.mosaic()) return {};
  const service = () => {
    const s = own.mosaic();
    if (!s) throw new Error('Mosaic inputs is switched off in the Web RCS tab');
    return s;
  };
  return {
    mosaicTargets: (cols, rows) => service().targets(cols, rows),
    applyMosaic: (targetId, tiles) => service().apply(targetId, tiles)
  };
}

export function buildEditor(doc, own) {
  const el = doc.getElementById('otter') || doc.body.appendChild(doc.createElement('div'));
  const initial = own.takeInitial();
  let unmount = null;
  let stopped = false;

  /* Imported here, not through `own.loadOtter`: the module has to run in THIS
     window's realm, or its `document` — a download link, a clipboard write —
     would be the Web RCS tab's. Same URL, so the browser's cache has it. */
  import('../../src/vendor/otter-edid-embed.js').then((otter) => {
    if (stopped) return;
    unmount = otter.mount(el, editorHost(own, initial));
    if (initial && initial.slotId) doc.title = `ED${initial.slotId} — EDID builder`;
  }).catch((err) => {
    el.textContent = `The EDID editor would not load: ${err.message}`;
  });

  return {
    stop() {
      stopped = true;
      if (unmount) unmount();
    }
  };
}
