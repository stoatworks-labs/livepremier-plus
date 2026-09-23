/*
 * The placeholder library: routers you can patch and route against before the
 * real one is on the network.
 *
 * A placeholder is not an emulator. It speaks no protocol and opens no
 * socket; it is a router-shaped table of the right size, held in this
 * process, so a show can be patched, routed and cued in the simulator weeks
 * before anybody is standing next to the rack. `routers/placeholder.js` is the
 * driver, and it answers exactly the questions a real driver answers — how
 * big, what is routed where — so every surface that routes (the panel, the
 * Router tabs, cues, OSC, the Console) works on one unchanged.
 *
 * Each model names the `kind` it will be once it goes live. Going live keeps
 * the router's id, so the patch — which names routers by id — carries over to
 * the real frame without a single cable being re-entered, and the routing the
 * placeholder held comes with it as a plan that can be pushed in one click.
 *
 * ⚠️ **These sizes are the vendors' published port counts, not something any
 * of these frames told us.** A real router reports its own size when it
 * connects, and the patch is re-validated against that. `custom` exists for
 * everything not listed, and for a frame fitted with fewer cards than it
 * holds — a modular Lightware is sold by the slot, not by the frame.
 */

export const LIBRARY = [
  /* Blackmagic Design — Videohub Ethernet Protocol */
  { id: 'bmd-videohub-mini-4x2-12g', kind: 'videohub', vendor: 'Blackmagic', label: 'Videohub Mini 4×2 12G', inputs: 4, outputs: 2 },
  { id: 'bmd-videohub-mini-6x2-12g', kind: 'videohub', vendor: 'Blackmagic', label: 'Videohub Mini 6×2 12G', inputs: 6, outputs: 2 },
  { id: 'bmd-videohub-mini-8x4-12g', kind: 'videohub', vendor: 'Blackmagic', label: 'Videohub Mini 8×4 12G', inputs: 8, outputs: 4 },
  { id: 'bmd-videohub-10x10-12g', kind: 'videohub', vendor: 'Blackmagic', label: 'Videohub 10×10 12G', inputs: 10, outputs: 10 },
  { id: 'bmd-videohub-12x12-12g', kind: 'videohub', vendor: 'Blackmagic', label: 'Videohub 12×12 12G', inputs: 12, outputs: 12 },
  { id: 'bmd-micro-videohub', kind: 'videohub', vendor: 'Blackmagic', label: 'Micro Videohub 16×16', inputs: 16, outputs: 16 },
  { id: 'bmd-videohub-20x20-12g', kind: 'videohub', vendor: 'Blackmagic', label: 'Videohub 20×20 12G', inputs: 20, outputs: 20 },
  { id: 'bmd-smart-videohub-cleanswitch-12x12', kind: 'videohub', vendor: 'Blackmagic', label: 'Smart Videohub CleanSwitch 12×12 6G', inputs: 12, outputs: 12 },
  { id: 'bmd-smart-videohub-12g-40x40', kind: 'videohub', vendor: 'Blackmagic', label: 'Smart Videohub 12G 40×40', inputs: 40, outputs: 40 },
  { id: 'bmd-videohub-40x40-12g', kind: 'videohub', vendor: 'Blackmagic', label: 'Videohub 40×40 12G', inputs: 40, outputs: 40 },
  { id: 'bmd-universal-videohub-72', kind: 'videohub', vendor: 'Blackmagic', label: 'Universal Videohub 72', inputs: 72, outputs: 72 },
  { id: 'bmd-videohub-80x80-12g', kind: 'videohub', vendor: 'Blackmagic', label: 'Videohub 80×80 12G', inputs: 80, outputs: 80 },
  { id: 'bmd-videohub-120x120-12g', kind: 'videohub', vendor: 'Blackmagic', label: 'Videohub 120×120 12G', inputs: 120, outputs: 120 },
  { id: 'bmd-universal-videohub-288', kind: 'videohub', vendor: 'Blackmagic', label: 'Universal Videohub 288', inputs: 288, outputs: 288 },

  /* Lightware — LW3 / LW2 */
  { id: 'lw-mx2-8x8', kind: 'lightware', vendor: 'Lightware', label: 'MX2-8x8-HDMI20', inputs: 8, outputs: 8 },
  { id: 'lw-mx2-16x16', kind: 'lightware', vendor: 'Lightware', label: 'MX2-16x16-HDMI20', inputs: 16, outputs: 16 },
  { id: 'lw-mx2-24x24', kind: 'lightware', vendor: 'Lightware', label: 'MX2-24x24-HDMI20', inputs: 24, outputs: 24 },
  { id: 'lw-mx2-32x32', kind: 'lightware', vendor: 'Lightware', label: 'MX2-32x32-HDMI20', inputs: 32, outputs: 32 },
  { id: 'lw-mx2-48x48', kind: 'lightware', vendor: 'Lightware', label: 'MX2-48x48-HDMI20', inputs: 48, outputs: 48 },
  { id: 'lw-mx-fr17', kind: 'lightware', vendor: 'Lightware', label: 'MX-FR17 (16×16 frame, fully fitted)', inputs: 16, outputs: 16 },
  { id: 'lw-mx-fr33r', kind: 'lightware', vendor: 'Lightware', label: 'MX-FR33R (32×32 frame, fully fitted)', inputs: 32, outputs: 32 },
  { id: 'lw-mx-fr65r', kind: 'lightware', vendor: 'Lightware', label: 'MX-FR65R (64×64 frame, fully fitted)', inputs: 64, outputs: 64 },
  { id: 'lw-mx-fr80r', kind: 'lightware', vendor: 'Lightware', label: 'MX-FR80R (80×80 frame, fully fitted)', inputs: 80, outputs: 80 },

  /* Turtle AV — ASCII on TCP 8000 */
  { id: 'turtle-hdp-mxb88vw', kind: 'turtle', vendor: 'Turtle AV', label: 'HDP-MXB88VW 8×8', inputs: 8, outputs: 8 },
];

/** Any size, for whatever is not listed. Its `kind` is chosen at go-live. */
export const CUSTOM = { id: 'custom', kind: null, vendor: '', label: 'Custom size…' };

export const libraryModel = (id) => LIBRARY.find((m) => m.id === id) ?? null;

/** `LIBRARY` grouped by vendor, in list order, for an `<optgroup>` per vendor. */
export function libraryByVendor() {
  const groups = new Map();
  for (const model of LIBRARY) {
    if (!groups.has(model.vendor)) groups.set(model.vendor, []);
    groups.get(model.vendor).push(model);
  }
  return [...groups];
}
