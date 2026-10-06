/*
 * Field arithmetic — the plugin's page half.
 *
 * `1080-80` in a layer width gives 1000. It improves the vendor's own fields
 * whether or not anybody ever opens a panel of ours, so it registers nothing
 * with the host: it is a page decoration, installed the moment the plugin
 * starts. `math-fields.js` says which fields count as numeric, and why an
 * answer is fitted to the field's own limits rather than typed in raw.
 *
 * `$S1.width/2` and `@gap*3` work too while the Variables plugin is on. Its
 * service is asked for at each commit, not here: it may start after this
 * plugin, or be switched off, and either way a field must keep working.
 */

import { installMathFields } from './math-fields.js';

export default function activate(ctx) {
  installMathFields(document, { variables: () => (ctx && ctx.use ? ctx.use('variables') : null) });
}
