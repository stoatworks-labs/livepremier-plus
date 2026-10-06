/*
 * Background Slicer — which platform's model a store gets.
 *
 * A LivePremier cuts a background per output into stills (`core.js`); a
 * Midra 4K or Alta 4K takes one picture per screen through a Background
 * Image and lets the switcher crop it (`mng.js`). The two export the same
 * names — `readScreens`, `screenTopology`, `buildPlan`, `readSets`,
 * `readLibrary`, `liveCandidates`, `plugTemplates`, `edidChoice`,
 * `assumptionsFor`, `imageName`, `NOTES`, `PLATFORM` — so the panel asks this
 * once per render and draws whichever it is handed. The dialect decides, as
 * it decides every other spelling (`core/dialect.js`); a store that has not
 * said yet gets LivePremier's, whose readers find nothing in it.
 */

import * as nlc from './core.js';
import * as mng from './mng.js';
import { dialectFor, MNG } from '../../src/core/dialect.js';

export const MODELS = { nlc, mng };

/** The model for this store's platform. */
export function modelFor(store) {
  return dialectFor(store) === MNG ? mng : nlc;
}
