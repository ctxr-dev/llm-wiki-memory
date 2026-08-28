// Chart geometry: the plot area, tick selection, and the scales that map data to
// pixels. Pure math, no markup — `axes.mjs` renders, this decides where things go.
//
// One plot area is shared by every cartesian chart (margins left 80 / bottom 60 /
// top 40 / right 40 inside a 1000x500 viewBox) so a bar, a line and a scatter of
// the same data line up when a reader flips between them. That consistency is the
// whole reason these constants live here rather than in each renderer.

export const VIEW = { w: 1000, h: 500 };
// Note on `bottom`: the type references describe a 60px bottom margin but also
// pin the y-axis line as running to y=420 in a 500-tall viewBox, which is a
// margin of 80. The explicit coordinate wins, and it is the one that works: the
// space below the baseline has to hold the category labels, an axis title AND the
// legend strip, which 60px cannot.
export const MARGIN = { left: 80, right: 40, top: 40, bottom: 80 };

/**
 * @typedef {Object} Plot
 * @property {number} x left edge (the y-axis line)
 * @property {number} y top edge
 * @property {number} w
 * @property {number} h
 * @property {number} x2 right edge
 * @property {number} y2 bottom edge (the x-axis baseline)
 */

/**
 * @param {{ width?: number, height?: number, margin?: Partial<typeof MARGIN> }} [opts]
 * @returns {Plot}
 */
export function plotArea(opts = {}) {
  const width = opts.width ?? VIEW.w;
  const height = opts.height ?? VIEW.h;
  const m = { ...MARGIN, ...(opts.margin || {}) };
  const x = m.left;
  const y = m.top;
  return {
    x,
    y,
    w: width - m.left - m.right,
    h: height - m.top - m.bottom,
    x2: width - m.right,
    y2: height - m.bottom,
  };
}

/**
 * Round a span outward to human tick values.
 *
 * The steps are 1 / 2 / 2.5 / 5 / 10 per decade because those are the intervals a
 * reader adds up without thinking. Picking the mathematically tightest step
 * (a raw span/count) yields axes labelled 0, 3.7, 7.4 which are unreadable, and
 * that is the failure this exists to prevent.
 * @param {number} min @param {number} max @param {number} [count] target tick count
 * @returns {{ min: number, max: number, step: number, ticks: number[] }}
 */
export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1, step: 1, ticks: [0, 1] };
  }
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  // A flat series still needs an axis with height, or every bar renders as zero.
  if (hi === lo) {
    if (lo === 0) return { min: 0, max: 1, step: 1, ticks: [0, 1] };
    hi = lo + Math.abs(lo) * 0.5;
  }
  const raw = (hi - lo) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const stepMultiple =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  const step = stepMultiple * magnitude;
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  /** @type {number[]} */
  const ticks = [];
  // Index-based accumulation avoids compounding drift, but does NOT remove it:
  // 3 * 0.2 is 0.6000000000000001, and that reaches the axis label verbatim. So
  // snap each tick to 12 significant digits, comfortably beyond any real data
  // precision and well inside the double's exact range.
  const steps = Math.round((niceMax - niceMin) / step);
  for (let i = 0; i <= steps; i += 1) {
    ticks.push(Number((niceMin + i * step).toPrecision(12)));
  }
  return {
    min: Number(niceMin.toPrecision(12)),
    max: Number(niceMax.toPrecision(12)),
    step: Number(step.toPrecision(12)),
    ticks,
  };
}

/**
 * A linear map from a data domain to a pixel range.
 * @param {[number, number]} domain @param {[number, number]} range
 * @returns {(value: number) => number}
 */
export function linearScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0) return () => r0;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

/**
 * @typedef {Object} Band
 * @property {number} pitch centre-to-centre distance
 * @property {number} width the mark's own width
 * @property {(i: number) => number} center
 * @property {(i: number) => number} start left edge of the mark
 */

/**
 * Evenly divide a span into `count` slots.
 *
 * `ratio` defaults to 0.65 so the mark is always wider than the gap beside it: a
 * gap wider than the bar reads as missing data rather than as spacing.
 * @param {number} count @param {number} x @param {number} w @param {number} [ratio]
 * @returns {Band}
 */
export function bandScale(count, x, w, ratio = 0.65) {
  const n = Math.max(1, count);
  const pitch = w / n;
  const width = Math.max(2, pitch * Math.min(0.95, Math.max(0.2, ratio)));
  return {
    pitch,
    width,
    center: (i) => x + pitch * (i + 0.5),
    start: (i) => x + pitch * (i + 0.5) - width / 2,
  };
}

/**
 * Format a tick for display: enough precision to represent the STEP exactly, and
 * no more. `1000` beats `1000.00`, and a 0.25 step must print `0.25` rather than
 * rounding to `0.3`.
 *
 * Precision comes from what the step actually needs, found by asking. Deriving it
 * from `-log10(step)` is the obvious formula and it is WRONG for any step that is
 * not a power of ten: 0.25 needs two decimals but log10 says one, so the axis
 * labelled 0, 0.3, 0.5, 0.8, 1 has two ticks that are simply false.
 * @param {number} value @param {number} step
 * @returns {string}
 */
export function formatTick(value, step) {
  if (!Number.isFinite(value)) return "";
  let decimals = 0;
  if (Number.isFinite(step) && step > 0 && step < 1) {
    while (decimals < 6 && Number(step.toFixed(decimals)) !== step) decimals += 1;
  }
  const fixed = value.toFixed(decimals);
  // A whole value under a fractional step still prints without its dead zeros.
  return decimals > 0 ? fixed.replace(/\.?0+$/, "") || "0" : fixed;
}

/**
 * Polar coordinates for the radial charts (radar, polar), measured CLOCKWISE from
 * twelve o'clock so a reader's "first" category is at the top where they look.
 * @param {number} cx @param {number} cy @param {number} radius @param {number} index @param {number} count
 * @returns {{ x: number, y: number, angle: number }}
 */
export function polarPoint(cx, cy, radius, index, count) {
  const angle = (index / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2;
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, angle };
}
