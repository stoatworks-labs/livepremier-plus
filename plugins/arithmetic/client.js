/*
 * Field arithmetic — the plugin's page half.
 *
 * `1080-80` in a layer width gives 1000. It improves the vendor's own fields
 * whether or not anybody ever opens a panel of ours, so it registers nothing
 * with the host: it is a page decoration, installed the moment the plugin
 * starts. `math-fields.js` says which fields count as numeric, and why an
 * answer is fitted to the field's own limits rather than typed in raw.
 */

import { installMathFields } from './math-fields.js';

export default function activate() {
  installMathFields();
}
