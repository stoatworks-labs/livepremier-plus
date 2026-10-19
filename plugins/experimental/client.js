/*
 * Experimental features — the switch, and a card saying what is behind it.
 *
 * Some things the switcher's control software will do have never been seen
 * working on a real frame: an aux's background taking a still, for one, which
 * the simulators and an Aquilon RS4 accept and report (2026-10-17) but nobody
 * has yet watched an output draw. They are built so they can be tried on a
 * simulator or a spare box, and kept out of everybody else's way until a frame
 * has shown what they do.
 *
 * So this plugin is off by default, and it is the gate: a built-in whose
 * manifest says `experimental: true` requires it (its row reads *needs
 * Experimental features* until this is on), and the Plugins card does not even
 * list one while it is off. A feature that is a corner of an existing plugin
 * rather than a plugin of its own — the UMD Generator's aux-background target —
 * asks for the `experimental` service instead, which exists only while this
 * plugin runs.
 */

/** What is behind the switch, for the card. A plugin of its own is listed by the Plugins card too. */
const BEHIND = [
  {
    name: 'Aux backgrounds',
    where: 'Preconfig ▸ Backgrounds, under the screens',
    what: 'A still or a live input on an aux’s background, in preview or program. Switch the plugin on as well.'
  },
  {
    name: 'UMD on an aux’s background',
    where: 'Screens / Aux. ▸ ⋯ ▸ UMD, “UMD on”',
    what: 'The UMD still under an aux’s layers instead of on its top layer, so every layer is a box, with 2, 4, 6 and 8-box layouts.'
  },
  {
    name: 'Take only with a time and an effect',
    where: 'PLUS ▸ Layer Lock, “Take only with”',
    what: 'A take time and an opening and closing effect for the layers a Take only moves. The others are held, so the time is theirs alone, and the screen’s own time is put back afterwards.'
  }
];

export default function activate(ctx) {
  const { h, card, note } = ctx.kit;

  ctx.provide('experimental', Object.freeze({ on: true, features: BEHIND.map((f) => f.name) }));

  ctx.ui.settingsSection({
    id: 'experimental',
    order: 95,
    render: () => card('Experimental features',
      note('warn', 'These use things the switcher accepts but no frame has been seen to do. Try them on a simulator or a spare box, never in a show, and tell me what a real output does.'),
      h('div', { class: 'aw-flex-col aw-gap-row-small' },
        BEHIND.map((f) => h('div', { class: 'aw-flex-col aw-gap-row-mini' },
          h('div', { class: 'aw-font-body-1-bold', text: f.name }),
          h('div', { class: 'aw-font-body-1', text: f.what }),
          h('div', { class: 'aw-font-caption aw-text-tertiary', text: f.where })))))
  });
}
