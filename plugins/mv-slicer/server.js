/*
 * Multiviewer slicer — the server half, which is only its settings.
 *
 * Everything this plugin does happens in the page: the capture is the
 * browser's (a capture card it can see, or a WHEP stream it plays), and the
 * thumbnails it replaces are the page's images. The settings live here so
 * every page on the install shares one geometry and one stream address, and
 * so they travel in the setup file with the rest.
 */

import { normalise } from './core.js';

export const settings = { normalise };

export default function activate() {}
