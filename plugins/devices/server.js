/*
 * Device host — the plugin's server half: the host's state for the settings
 * card, and a way to restart it. The host itself is the app's, not this
 * plugin's (`server/device-host.js`, `devices/README.md`): switching this card
 * off hides it and stops nothing.
 */

export default function activate(ctx) {
  const devices = () => ctx.use('devices');

  ctx.route('GET', '/', (req, res, h) => {
    const d = devices();
    h.json(200, d ? d.status() : { installed: false, running: false, reason: 'No device host.', modules: [] });
  });

  ctx.route('POST', '/restart', (req, res, h) => {
    const d = devices();
    if (!d?.status().installed) throw new ctx.HttpError(409, d?.status().reason || 'No device host.');
    d.restart();
    h.json(200, d.status());
  });
}
