/*
 * EDID builder — the plugin's server half, which is only its settings schema.
 *
 * Everything the plugin does happens in the page: it reads the bank off the
 * store mirror and writes a slot the way Web RCS does, through the proxy's
 * relay of `/api/…`. The server keeps no mirror of the switcher (AGENTS.md,
 * "Ride the app's socket"), so there is nothing for it to do here but say
 * what a setting may be.
 */

export const settings = {
  /* `autoFill`: keep the EDID bank filled with one EDID per custom format.
     Off unless somebody switches it on — it writes to the switcher. */
  normalise: (raw = {}) => ({ autoFill: raw.autoFill === true })
};

export default function activate() {}
