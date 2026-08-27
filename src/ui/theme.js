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
/* Console — a command line, so a monospace field and a compact result log.
   Colours are the vendor's own tokens rather than new ones. */
.wru-console-line {
  background: #08141B; border: 0.1rem solid #49535B; border-radius: 0.25rem;
  padding: 0.5rem 0.75rem;
}
.wru-console-caret { font-family: ui-monospace, Menlo, monospace; font-size: 1.1rem; }
.wru-console-input {
  flex: 1; background: transparent; border: 0; outline: none; color: #fff;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.1rem;
}
.wru-console-input::placeholder { color: #616D75; }
.wru-console-feedback { min-height: 1.6rem; }
.wru-console-log { gap: 0.25rem; }
.wru-console-row {
  display: flex; gap: 0.75rem; align-items: baseline;
  padding: 0.25rem 0.5rem; border-left: 0.2rem solid transparent; border-radius: 0.15rem;
}
.wru-console-cmd { font-family: ui-monospace, Menlo, monospace; white-space: pre; }
.wru-console-detail { font-size: 0.9rem; }
/* Which language a line was read as.
   Fixed width so a column of them lines up — the reason to look at this chip
   at all is usually to scan back down the log for the one line that was read
   as something other than the rest. */
.wru-console-lang {
  flex: 0 0 auto; min-width: 3.5rem; text-align: center;
  color: #838B91; letter-spacing: 0.02em;
}
.wru-console-ok   { border-left-color: #00FF7F; background: rgba(0,255,127,0.05); }
.wru-console-warn { border-left-color: #F39910; background: rgba(243,153,16,0.05); }
.wru-console-err  { border-left-color: #F64747; background: rgba(246,71,71,0.06); }

/* A tab of ours sits in the vendor's strip and must fill it the same way. */
[data-lpp-tab-pane] { display: flex; flex-direction: column; min-height: 0; }
[data-lpp-tab-pane] > .wru-overlay-inner { flex: 1 1 auto; min-height: 0; }

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
  padding: 0.833333rem;
}
/* The link grid, drawn the way the manual draws a VPU: an 8x8 field of links,
   layer links in from the left, output links out top and bottom. */
.wru-vpu-svg { width: 26rem; height: auto; display: block; }
.wru-vpu-svg--unfitted { opacity: 0.3; }

.wru-field { fill: rgba(0,0,0,0.3); stroke: #49535B; stroke-width: 1; }
/* The native layers, laid out below the eight layer-capacity links because they
   spend output capacity and not layer capacity. */
.wru-band { stroke-dasharray: 4 3; stroke-opacity: 0.75; }
.wru-band-label {
  fill: #838B91; font-size: 7px; text-anchor: end; fill-opacity: 0.8;
  font-family: OpenSans, Helvetica, sans-serif;
}
/* Which output links belong to which screen: a screen owns a contiguous run of
   them, and all of its layers start at the same one. */
.wru-screen-bar rect { fill: currentColor; fill-opacity: 0.5; stroke: currentColor; stroke-width: 1.2; }
.wru-screen-bar text {
  fill: #08141B; font-size: 8px; font-weight: 700; text-anchor: middle;
  font-family: OpenSans, Helvetica, sans-serif; pointer-events: none;
}
.wru-lattice { stroke: rgba(255,255,255,0.08); stroke-width: 1; }
.wru-link-in { stroke: #616D75; stroke-width: 1.5; }
.wru-link-out { stroke: #616D75; stroke-width: 1.5; }
.wru-link-no {
  fill: #838B91; font-size: 7px; text-anchor: middle;
  font-family: OpenSans, Helvetica, sans-serif;
}

.wru-cell { fill: currentColor; fill-opacity: 0.55; stroke: currentColor; stroke-width: 1.2; }
/* An added layer, distinguished from the screen's native layer. NATIVE is a
   layer slot that costs mixers - it is NOT the screen's background, which
   lives in a different subtree entirely and costs nothing. */
.wru-cell--layered { fill-opacity: 0.28; stroke-dasharray: 3 2; }
.wru-cell--changed { stroke: #F39910; stroke-width: 2; }
.wru-tie { stroke: currentColor; stroke-width: 2; stroke-opacity: 0.5; }
/* Only drawn when a layer's links are reported in pieces: the block itself is
   continuous across adjacent links. */
.wru-span { fill: none; stroke: currentColor; stroke-width: 1.2; stroke-dasharray: 3 2; stroke-opacity: 0.8; }
/* The manual's wrap hook — this piece took another layer link because the layer
   reached past the centre line (5.5.4). */
.wru-hook { fill: none; stroke: #F39910; stroke-width: 1.5; }
.wru-cell-label {
  fill: #08141B; font-size: 9px; font-weight: 700; text-anchor: middle;
  font-family: OpenSans, Helvetica, sans-serif; pointer-events: none;
}
.wru-cell-sub {
  fill: #08141B; font-size: 7px; text-anchor: middle; fill-opacity: 0.75;
  font-family: OpenSans, Helvetica, sans-serif; pointer-events: none;
}
/* A one-link-tall block has no room for two lines, and four bars all reading
   the screen name would say nothing. */
.wru-cell-label--sm { font-size: 7px; text-anchor: start; }
/* Several slices ride one layer's links; the count says how many. */
.wru-cell-count { text-anchor: end; }
/* The scaling-engine boundary at four output links. Drawn on every VPU — a
   layer-capacity link cannot cross it, which is why a layer reaching both halves
   is split in two. Optimized mode lifts it for capacity-2 layers only (5.5.6),
   so there it is drawn quieter rather than hidden. */
.wru-boundary { stroke: #F64747; stroke-width: 1.5; stroke-dasharray: 4 3; stroke-opacity: 0.85; }
.wru-boundary--soft { stroke-opacity: 0.3; }

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
.wru-tag--good { background: rgba(0,255,127,0.1); color: #00FF7F; }

.wru-select {
  background: rgba(0,0,0,0.3); border: 0.1rem solid #49535B; border-radius: 0.25rem;
  color: #fff; font-family: inherit; font-size: 1rem; padding: 0.166667rem 0.333333rem;
}

/* Pitch compensation. Numbers in columns that have to line up to be compared,
   so tabular figures throughout and the ratio columns right-aligned. */
.wru-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.wru-table th {
  text-align: left; font-size: 0.833333rem; color: #838B91; font-weight: 600;
  padding: 0.25rem 0.5rem 0.25rem 0; border-bottom: 0.1rem solid rgba(255,255,255,0.08);
  white-space: nowrap;
}
.wru-table td { padding: 0.25rem 0.5rem 0.25rem 0; border-bottom: 0.1rem solid rgba(255,255,255,0.04); }
.wru-row--active { background: rgba(33,133,208,0.12); }
.wru-pitch-table th:nth-child(n+4), .wru-pitch-table td:nth-child(n+4) { text-align: right; }

.wru-warnings { margin: 0; padding: 0 0 0 1rem; font-size: 0.916667rem; line-height: 1.5; }
.wru-warnings li { margin-bottom: 0.333333rem; }

.wru-empty { color: #838B91; padding: 2rem; text-align: center; }
.wru-warn { color: #F39910; }

/* ------------------------------------------------- popped-out console -- */

/* A three-region window: previews and the reference shelf side by side, with
   the command line spanning the full width beneath them. The console is the
   thing being used; the previews are what it is being used at. */
.lpp-popout {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; background: #08141B;
}
.lpp-top { flex: 1 1 auto; display: flex; min-height: 0; }
.lpp-previews { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.lpp-side {
  flex: 0 0 26rem; display: flex; flex-direction: column; min-height: 0;
  border-left: 0.1rem solid #283239; background: #1B272F;
}
.lpp-pane-head {
  display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
  padding: 0.666667rem 1rem; background: #08141B;
  border-bottom: 0.1rem solid #283239; flex: 0 0 auto;
}
.lpp-wall-body { flex: 1 1 auto; overflow: auto; padding: 1rem; background: #1B272F; }
.lpp-console {
  flex: 0 0 auto; height: 40%; min-height: 14rem; max-height: 60%;
  border-top: 0.1rem solid #283239; position: relative;
  display: flex; flex-direction: column;
}
/* The console renders the standard panel frame; make it fill this region. */
.lpp-console > .wru-overlay-inner { flex: 1 1 auto; min-height: 0; }

.lpp-side-tabs { padding: 0.5rem 0.5rem 0; flex: 0 0 auto; }
.lpp-tab {
  appearance: none; border: 0; background: transparent; color: #838B91;
  font-family: inherit; font-size: 1rem; letter-spacing: 0.0416667rem;
  text-transform: uppercase; padding: 0.5rem 0.833333rem; cursor: pointer;
  border-bottom: 0.166667rem solid transparent;
}
.lpp-tab:hover { color: #fff; }
.lpp-tab--on { color: #54C8FF; border-bottom-color: #54C8FF; }
.lpp-side-pane { flex: 1 1 auto; overflow: auto; min-height: 0; }
.lpp-side-body { padding: 1rem; }

.lpp-words { display: flex; flex-wrap: wrap; gap: 0.333333rem; }
/* The shortest unambiguous abbreviation is the point of the row, so it is the
   bright half and the rest of the word trails off behind it. */
.lpp-word {
  background: rgba(255,255,255,0.05); border: 0.1rem solid #283239;
  border-radius: 0.166667rem; padding: 0.083333rem 0.333333rem; font-size: 0.916667rem;
}
.lpp-example {
  border-left: 0.166667rem solid #283239; padding: 0.166667rem 0 0.166667rem 0.5rem;
}

/* ------------------------------------------------------------ previews -- */

.lpp-controls { row-gap: 0.5rem; }
.lpp-chip {
  appearance: none; border: 0.1rem solid #49535B; background: rgba(255,255,255,0.04);
  color: #838B91; font-family: inherit; font-size: 0.916667rem; line-height: 1.33333rem;
  padding: 0.083333rem 0.5rem; border-radius: 0.166667rem; cursor: pointer;
}
.lpp-chip:hover { color: #fff; }
.lpp-chip--on { background: #2185D0; border-color: #2185D0; color: #fff; }
.lpp-chip--pgm.lpp-chip--on { background: #F64747; border-color: #F64747; }
.lpp-chip--prw.lpp-chip--on { background: #00FF7F; border-color: #00FF7F; color: #08141B; }

.lpp-wall { display: flex; flex-wrap: wrap; gap: 1rem; align-content: flex-start; }
.lpp-card {
  background: #08141B; border: 0.1rem solid #283239; border-radius: 0.333333rem;
  padding: 0.5rem; display: flex; flex-direction: column; gap: 0.416667rem;
}
.lpp-card-head { min-width: 0; }

/* The stage keeps the screen's own aspect ratio: a padding-top percentage on
   an empty spacer, with the layers absolutely positioned over it. Screens are
   not all 16:9 — a canvas can be any shape the operator built. */
.lpp-stage { position: relative; background: #000; overflow: hidden; border: 0.1rem solid #323F48; }
.lpp-stage--pgm { border-color: rgba(246,71,71,0.6); }
.lpp-stage--prw { border-color: rgba(0,255,127,0.45); }
.lpp-stage-pad { width: 100%; }
.lpp-stage-inner { position: absolute; inset: 0; }
.lpp-stage-tag {
  position: absolute; top: 0; left: 0; padding: 0 0.333333rem;
  font-size: 0.75rem; font-weight: 700; letter-spacing: 0.0416667rem;
  background: rgba(8,20,27,0.75); pointer-events: none;
}
.lpp-stage-tag--pgm { color: #F64747; }
.lpp-stage-tag--prw { color: #00FF7F; }

.lpp-layer { position: absolute; overflow: hidden; outline: 1px solid rgba(255,255,255,0.35); }
/* NATIVE is a layer slot that costs mixers, not the screen's background —
   drawn quieter so it does not read as a source someone put there. */
.lpp-layer--native { outline-style: dashed; outline-color: rgba(255,255,255,0.2); }
.lpp-layer-img { width: 100%; height: 100%; object-fit: fill; display: block; }
.lpp-layer-tag {
  position: absolute; left: 0; bottom: 0; padding: 0 0.25rem;
  font-size: 0.75rem; background: rgba(8,20,27,0.7); color: #fff;
  pointer-events: none; white-space: nowrap;
}

.lpp-banner {
  background: rgba(246,71,71,0.15); border-bottom: 0.1rem solid #F64747;
  color: #fff; padding: 0.666667rem 1rem; flex: 0 0 auto;
}
.lpp-orphan { padding: 3rem; max-width: 40rem; color: #838B91; }
.lpp-orphan h1 { color: #fff; margin: 0 0 0.5rem; }

/* ------------------------------------------- popped-out timeline editor -- */

/* The QLab arrangement: a list you drive from the keyboard, and everything
   about the selected cue in a panel underneath it. */
.lpp-editor { display: flex; flex-direction: column; }
.lpp-cuelist-host { flex: 1 1 auto; overflow: auto; background: #1B272F; min-height: 0; }
.lpp-cuelist { table-layout: fixed; }
.lpp-cuelist td { white-space: nowrap; }
.lpp-cue--selected { outline: 0.1rem solid #2185D0; outline-offset: -0.1rem; background: rgba(33,133,208,0.12); }
/* A cue fired by the clock rather than by GO — worth telling apart at a
   glance, since it is the difference between a cue that waits for you and one
   that does not. */
.lpp-tc { color: #54C8FF; }

.lpp-inspector {
  flex: 0 0 auto; max-height: 42%; overflow: auto;
  border-top: 0.1rem solid #283239; background: #08141B; padding: 0.833333rem 1rem;
}
.lpp-inspector-head { margin-bottom: 0.666667rem; }
.lpp-inspector-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  gap: 0.833333rem;
}
.lpp-field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.lpp-actions { margin-top: 0.833333rem; }
.lpp-action {
  background: rgba(255,255,255,0.04); border: 0.1rem solid #283239;
  border-radius: 0.166667rem; padding: 0.166667rem 0.5rem;
}
.lpp-editor-foot {
  flex: 0 0 auto; padding: 0.5rem 1rem;
  border-top: 0.1rem solid #283239; background: #1B272F;
}

/* The running clock, big enough to read across a production desk. */
.lpp-clock {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 1.5rem; letter-spacing: 0.05rem; color: #616D75;
}
.lpp-clock--live { color: #00FF7F; }
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
