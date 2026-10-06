/*
 * Preview lock during takes — the server half, which is only its settings.
 *
 * The padlock is pressed in the page, because the padlock is the page's: Web
 * RCS keeps it in its own Redux store and nothing about it reaches the
 * switcher. The settings live here so every page on the install skips the
 * same screens, and so they travel in the setup file with the rest.
 */

import { normalise } from './core.js';

export const settings = { normalise };

export default function activate() {}
