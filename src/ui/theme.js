/*
 * The one stylesheet this extension adds.
 *
 * Everything it can borrow, it borrows: colours, spacing and type all come
 * from the vendor's own `aw-` utilities. What is here is only what Web RCS
 * has no equivalent for - a VPU allocation grid and a cue list - written
 * against the same token values so the two never drift apart visually.
 *
 * Those values were read off the running app rather than guessed:
 *
 *   slate grey  900 #08141B  800 #1B272F  700 #283239  600 #323F48
 *               500 #3D4951  400 #49535B  300 #616D75  200 #838B91
 *   accent      blue #2185D0   green #00FF7F   red #F64747   orange #F39910
 *   borders     primary #49535B  secondary #283239  tertiary #1B272F
 *   type        OpenSans, root font-size 12px, so 1rem = 12px
 *
 * The root font size matters: the host sets html{font-size:12px} and every
 * `aw-` spacing value is in rem against it. Sizes here are in rem for the
 * same reason, so a panel keeps its proportions if that base ever changes.
 */

const CSS = `
.wru-overlay {
  position: absolute; inset: 0; z-index: 40;
  display: flex; flex-direction: column;
  background: #1B272F;
}
.wru-overlay[hidden] { display: none; }

.wru-topbar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; padding: 0.666667rem 1rem;
  background: #08141B; border-bottom: 0.1rem solid #283239;
  flex: 0 0 auto;
}
.wru-body { flex: 1 1 auto; overflow: auto; padding: 1rem; }

.wru-button {
  appearance: none; border: 0.1rem solid #49535B; background: rgba(255,255,255,0.04);
  color: #fff; font-family: inherit; font-size: 1rem; letter-spacing: 0.0416667rem;
  padding: 0.333333rem 0.833333rem; cursor: pointer; line-height: 1.33333rem;
  text-transform: uppercase; white-space: nowrap;
}
.wru-button:hover:not(:disabled) { background: rgba(255,255,255,0.08); }
.wru-button:disabled { opacity: 0.4; cursor: default; }
.wru-button--active { background: #2185D0; border-color: #2185D0; }
.wru-button--go { background: #F39910; border-color: #F39910; color: #08141B; font-weight: 700; }
.wru-button--go:hover:not(:disabled) { background: #ffad2e; }
.wru-button--danger { border-color: #F64747; color: #F64747; }
.wru-button--ghost { border-color: transparent; }

/* ---------------------------------------------------------------- VPU -- */

.wru-vpu-device {
  background: #08141B; border: 0.1rem solid #283239; border-radius: 0.333333rem;
  padding: 0.833333rem; margin-bottom: 0.833333rem;
}
.wru-vpu-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr));
  gap: 0.333333rem;
}
.wru-vpu-unit {
  border: 0.1rem solid #283239; border-radius: 0.25rem;
  padding: 0.333333rem 0.416667rem; min-height: 4.25rem;
  display: flex; flex-direction: column; gap: 0.166667rem;
  background: rgba(255,255,255,0.04);
}
/* Not fitted at all: the chassis has no card in that processor slot. */
.wru-vpu-unit--absent { opacity: 0.28; background: transparent; border-style: dashed; }
/* Fitted and free - this is the headroom a config still has to spend. */
.wru-vpu-unit--spare { border-color: #49535B; background: rgba(255,255,255,0.04); }
/* Allocated. Hue carries the screen, so one screen reads as one block. */
.wru-vpu-unit--used { border-color: currentColor; background: color-mix(in srgb, currentColor 16%, transparent); }
.wru-vpu-unit--changed { outline: 0.166667rem solid #F39910; outline-offset: -0.166667rem; }

.wru-vpu-id { font-size: 0.833333rem; letter-spacing: 0.0416667rem; color: rgba(255,255,255,0.7); }
.wru-vpu-alloc { font-weight: 700; }
.wru-vpu-meta { font-size: 0.833333rem; color: #838B91; margin-top: auto; }
.wru-vpu-pipe {
  display: inline-block; padding: 0 0.25rem; border-radius: 0.166667rem;
  background: rgba(255,255,255,0.16); font-size: 0.833333rem;
}

.wru-legend { display: flex; flex-wrap: wrap; gap: 0.666667rem; align-items: center; }
.wru-swatch { width: 0.833333rem; height: 0.833333rem; border-radius: 0.166667rem; display: inline-block; }

.wru-bar { height: 0.666667rem; border-radius: 0.333333rem; background: #283239; overflow: hidden; display: flex; }
.wru-bar > span { display: block; height: 100%; }

/* ----------------------------------------------------------- timeline -- */

.wru-cuelist { width: 100%; border-collapse: collapse; }
.wru-cuelist th {
  text-align: left; font-size: 0.833333rem; text-transform: uppercase;
  letter-spacing: 0.0416667rem; color: #838B91; font-weight: 400;
  padding: 0.333333rem 0.5rem; border-bottom: 0.1rem solid #283239;
  position: sticky; top: 0; background: #1B272F;
}
.wru-cuelist td { padding: 0.333333rem 0.5rem; border-bottom: 0.1rem solid rgba(255,255,255,0.04); vertical-align: middle; }
.wru-cue:hover { background: rgba(255,255,255,0.04); }
.wru-cue--standby { background: rgba(33,133,208,0.16); box-shadow: inset 0.25rem 0 0 #2185D0; }
.wru-cue--fired { color: rgba(255,255,255,0.7); }
.wru-cue--armed { background: rgba(243,153,16,0.1); box-shadow: inset 0.25rem 0 0 #F39910; }
.wru-cue--disabled { opacity: 0.45; }
.wru-cue-number { font-weight: 700; font-variant-numeric: tabular-nums; }
.wru-cue-actions { color: #838B91; font-size: 0.916667rem; }

.wru-input {
  background: rgba(0,0,0,0.3); border: 0.1rem solid #49535B; border-radius: 0.25rem;
  color: #fff; font-family: inherit; font-size: 1rem; padding: 0.166667rem 0.333333rem;
  width: 100%; min-width: 3rem;
}
.wru-input:focus { outline: none; border-color: #2185D0; }
.wru-input--narrow { width: 4.5rem; }

.wru-tag {
  display: inline-block; padding: 0 0.333333rem; border-radius: 0.166667rem;
  background: rgba(255,255,255,0.08); font-size: 0.833333rem; margin-right: 0.166667rem;
}

.wru-empty { color: #838B91; padding: 2rem; text-align: center; }
.wru-warn { color: #F39910; }
`;

/**
 * Screen colours.
 *
 * Distinct hues at a fixed lightness, so a VPU grid reads as blocks of screen
 * rather than as a rainbow. The first entries deliberately match the vendor's
 * own blue and green.
 */
const SCREEN_HUES = [
  '#2185D0', '#00FF7F', '#F39910', '#B36AE2', '#00C4CC',
  '#F64747', '#7FD13B', '#FF7BAC', '#4C6EF5', '#E8C547'
];

export const screenColour = (screenId) => {
  if (!screenId || screenId === '—') return '#616D75';
  let n = 0;
  for (let i = 0; i < screenId.length; i++) n = (n * 31 + screenId.charCodeAt(i)) >>> 0;
  return SCREEN_HUES[n % SCREEN_HUES.length];
};

export function installStyles(doc = document) {
  if (doc.getElementById('wru-styles')) return;
  const style = doc.createElement('style');
  style.id = 'wru-styles';
  style.textContent = CSS;
  doc.head.append(style);
}
