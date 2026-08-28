// Bar / column chart: one rect per category against a single shared value
// scale. Vertical columns are the default; `horizontal: true` swaps which
// physical axis carries values, for long category names or more than eight
// categories that would otherwise force rotated or overlapping labels.
//
// The value axis always brackets zero, never just the data's own min/max: a
// bar's LENGTH is the reader's only cue to magnitude, so a truncated axis
// silently rescales every comparison on the chart — the anti-pattern the
// reference calls out by name. When the data crosses zero the baseline moves
// off the plot's edge and earns its own axis-weight line (the `hasNegative`
// branch below); `barExtent` keeps every bar honestly anchored to wherever
// that baseline actually is, including the degenerate all-zero case
// `niceTicks` already resolves to a finite span.

import { assemble, esc, wrap, snap, MONO_CH } from "./text.mjs";
import { plotArea, niceTicks, linearScale, bandScale, VIEW } from "./scale.mjs";
import { yAxis, xAxis, categoryAxis, axisTitles } from "./axes.mjs";

/** @typedef {import("./scale.mjs").Plot} Plot */
/** @typedef {import("./scale.mjs").Band} Band */

/**
 * @typedef {Object} BarDatum
 * @property {string} label category name, shown on the category axis
 * @property {number} value
 * @property {boolean} [focal] the one bar worth calling out; at most one per chart
 */

/**
 * @typedef {Object} BarSpec
 * @property {"bar"} kind
 * @property {string} id
 * @property {string} title becomes the SVG's aria-label
 * @property {string} [xLabel] category-axis title: the bottom axis by default,
 *   the left axis when `horizontal`
 * @property {string} [yLabel] value-axis title: the left axis by default, the
 *   bottom axis when `horizontal`
 * @property {boolean} [horizontal] draw rows instead of columns; use for long
 *   labels or more than 8 categories
 * @property {BarDatum[]} bars 4-8 recommended; more should be grouped or split
 */

// A bar rounding to (or genuinely at) zero length still has to READ as a
// value, not as a rendering bug — 3px is visible at this viewBox's scale
// without being mistaken for a real magnitude.
const MIN_THICKNESS = 3;
// The reference's own margin for a row-label column (the dumbbell variant):
// long labels are the documented reason to go horizontal in the first place,
// so the column has to be wide enough to actually hold them.
const ROW_MARGIN_LEFT = 200;
// `categoryAxis` estimates its own `.clab` text at 6.2px/char without naming
// the constant; matched here so row-label wrapping is consistent for the
// same class.
const CLAB_CH = 6.2;
const ROW_LINE_H = 12;
const LABEL_GAP = 8;
// Digits have no descenders, so a label placed ABOVE (or beside) a mark
// clears it by exactly `LABEL_GAP`: its baseline IS its visual bottom edge. A
// label placed BELOW one sits on its baseline with the glyphs rising above
// it, so it needs the same gap plus roughly a digit's height to clear the
// mark by the same visual amount.
const LABEL_GAP_BELOW = 14;

/**
 * The bar's own value, not rounded to the axis grid — a reader comparing
 * labelled bars needs the real number, not one rounded to whatever the tick
 * spacing happens to be.
 * @param {number} n
 * @returns {string}
 */
function formatValue(n) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * A bar's [start, length] along the value axis, in plot pixels.
 *
 * Three invariants, checked in order: the edge anchored at zero never moves
 * (a value never reads as larger than it is), a value whose true length
 * rounds below `MIN_THICKNESS` is still a visible sliver rather than nothing,
 * and the box never leaves the plot band even after that sliver is added at
 * an axis extreme — which happens whenever the data does not cross zero, so
 * zero sits ON the plot's edge rather than inside it.
 * @param {number} scaled the value's own scaled pixel position
 * @param {number} zero the scaled pixel position of zero
 * @param {number} plotStart the plot's top (vertical) or left (horizontal) edge
 * @param {number} plotEnd the plot's bottom (vertical) or right (horizontal) edge
 * @returns {{ start: number, length: number }}
 */
function barExtent(scaled, zero, plotStart, plotEnd) {
  let start = Math.min(scaled, zero);
  let length = Math.max(scaled, zero) - start;
  if (length < MIN_THICKNESS) {
    start = scaled < zero ? zero - MIN_THICKNESS : zero;
    length = MIN_THICKNESS;
  }
  if (start < plotStart) start = plotStart;
  if (start + length > plotEnd) start = plotEnd - length;
  return { start, length };
}

/**
 * Row labels for the horizontal orientation: one right-aligned category name
 * per band, vertically centred on it, plus the category axis's own rule.
 * `categoryAxis` cannot be reused here — it always runs its labels along x,
 * and a horizontal chart needs them along y instead.
 * @param {{ plot: Plot, band: Band, labels: string[] }} args
 * @returns {{ svg: string, minX: number }} the markup, and the leftmost pixel
 *   it drew — an unbroken long label can wrap wider than the reserved
 *   column, and the caller needs to know if the viewBox must grow for it
 */
function rowLabels({ plot, band, labels }) {
  /** @type {string[]} */
  const parts = [
    `<line class="axis" x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y2}"/>`,
  ];
  const maxChars = Math.max(6, Math.floor((plot.x - 16) / CLAB_CH));
  const lx = plot.x - 10;
  let minX = plot.x;
  labels.forEach((label, i) => {
    const lines = wrap(label, maxChars);
    const widest = Math.max(...lines.map((l) => l.length));
    minX = Math.min(minX, lx - widest * CLAB_CH);
    const baseline = band.center(i) + 4 - ((lines.length - 1) * ROW_LINE_H) / 2;
    const tspans = lines
      .map((l, k) => `<tspan x="${lx}" dy="${k === 0 ? 0 : ROW_LINE_H}">${esc(l)}</tspan>`)
      .join("");
    parts.push(`<text class="clab" x="${lx}" y="${baseline}" text-anchor="end">${tspans}</text>`);
  });
  return { svg: parts.join(""), minX };
}

/**
 * Render a bar/column chart: one rect per category on a shared value scale.
 * @param {BarSpec} spec
 * @returns {string}
 */
export function renderBar(spec) {
  const bars = spec.bars ?? [];
  if (bars.length === 0) throw new Error(`bar chart "${spec.id}" has no bars`);
  for (const bar of bars) {
    if (!Number.isFinite(bar.value)) {
      throw new Error(`bar chart "${spec.id}" bar "${bar.label}" has a non-finite value`);
    }
  }
  const focalCount = bars.filter((b) => b.focal).length;
  if (focalCount > 1) {
    throw new Error(`bar chart "${spec.id}" has ${focalCount} focal bars; at most one is allowed`);
  }

  const horizontal = spec.horizontal === true;
  const plot = plotArea(horizontal ? { margin: { left: ROW_MARGIN_LEFT } } : {});
  const values = bars.map((b) => b.value);
  const hasNegative = values.some((v) => v < 0);
  // Never truncate: the domain always brackets zero, whichever side the data
  // falls on, so a bar's length is always an honest share of the axis.
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const band = bandScale(bars.length, horizontal ? plot.y : plot.x, horizontal ? plot.h : plot.w);
  const valueScale = linearScale(
    [ticks.min, ticks.max],
    horizontal ? [plot.x, plot.x2] : [plot.y2, plot.y],
  );
  const zero = valueScale(0);
  const plotStart = horizontal ? plot.x : plot.y;
  const plotEnd = horizontal ? plot.x2 : plot.y2;

  /** @type {string[]} */
  const marks = [];
  /** @type {string[]} */
  const valueLabels = [];
  // Tracks the true drawn extent so a large value's label can never fall
  // outside the viewBox; expanded below only when a label actually needs it.
  let overflowMin = 0;
  let overflowMax = VIEW.w;

  bars.forEach((bar, i) => {
    const scaled = valueScale(bar.value);
    const { start, length } = barExtent(scaled, zero, plotStart, plotEnd);
    const bandStart = band.start(i);
    const markCls = bar.focal ? "mark focal" : "mark";
    marks.push(
      horizontal
        ? `<rect class="${markCls}" x="${start}" y="${bandStart}" width="${length}" height="${band.width}"/>`
        : `<rect class="${markCls}" x="${bandStart}" y="${start}" width="${band.width}" height="${length}"/>`,
    );

    // The far edge is whichever side of the anchored zero the value's own
    // (pre-clamp) position sits on; a label belongs beyond THAT edge in
    // every case, including the hairline ones `barExtent` had to adjust.
    const nearStart = scaled < zero;
    const far = nearStart ? start : start + length;
    const text = esc(formatValue(bar.value));
    const labelCls = bar.focal ? "vlab focal" : "vlab";
    if (horizontal) {
      const cy = band.center(i) + 4;
      const lx = nearStart ? far - LABEL_GAP : far + LABEL_GAP;
      const anchor = nearStart ? "end" : "start";
      valueLabels.push(
        `<text class="${labelCls}" x="${lx}" y="${cy}" text-anchor="${anchor}">${text}</text>`,
      );
      const textW = text.length * MONO_CH;
      if (nearStart) overflowMin = Math.min(overflowMin, lx - textW);
      else overflowMax = Math.max(overflowMax, lx + textW);
    } else {
      const cx = band.center(i);
      const ly = nearStart ? far - LABEL_GAP : far + LABEL_GAP_BELOW;
      valueLabels.push(
        `<text class="${labelCls}" x="${cx}" y="${ly}" text-anchor="middle">${text}</text>`,
      );
    }
  });

  /** @type {string[]} */
  const axisParts = [];
  if (horizontal) {
    const rows = rowLabels({ plot, band, labels: bars.map((b) => b.label) });
    axisParts.push(xAxis({ plot, ticks: ticks.ticks, step: ticks.step, x: valueScale }));
    axisParts.push(rows.svg);
    overflowMin = Math.min(overflowMin, rows.minX);
    if (hasNegative) {
      axisParts.push(
        `<line class="axis" x1="${zero}" y1="${plot.y}" x2="${zero}" y2="${plot.y2}"/>`,
      );
    }
    axisParts.push(axisTitles({ plot, xLabel: spec.yLabel, yLabel: spec.xLabel }));
  } else {
    axisParts.push(yAxis({ plot, ticks: ticks.ticks, step: ticks.step, y: valueScale }));
    axisParts.push(categoryAxis({ plot, band, labels: bars.map((b) => b.label) }));
    if (hasNegative) {
      axisParts.push(
        `<line class="axis" x1="${plot.x}" y1="${zero}" x2="${plot.x2}" y2="${zero}"/>`,
      );
    }
    axisParts.push(axisTitles({ plot, xLabel: spec.xLabel, yLabel: spec.yLabel }));
  }

  // Only ever grows past the standard viewBox, never shrinks it: the fixed
  // margins already fit ordinary content, and this exists solely to catch
  // the horizontal orientation's value labels overrunning it. Padding is
  // added only once real overflow is detected — applying it unconditionally
  // would widen every horizontal chart by a few pixels for no reason.
  const vx = horizontal && overflowMin < 0 ? snap(overflowMin - 4) : 0;
  const right = horizontal && overflowMax > VIEW.w ? snap(overflowMax + 4) : VIEW.w;
  const vw = right - vx;

  return assemble([
    `<svg viewBox="${vx} 0 ${vw} ${VIEW.h}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="${vx}" y="0" width="${vw}" height="${VIEW.h}" rx="10"/>`,
    axisParts.join(""),
    marks.join(""),
    valueLabels.join(""),
    "</svg>",
  ]);
}
