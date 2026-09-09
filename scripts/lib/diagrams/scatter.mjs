import { assemble, esc, wrap, MONO_CH } from "./text.mjs";
import { plotArea, niceTicks, linearScale, VIEW } from "./scale.mjs";
import { xAxis, yAxis, axisTitles } from "./axes.mjs";
import { place } from "./geometry.mjs";

/** @typedef {import("./types.mjs").Rect} Rect */

/**
 * @typedef {Object} ScatterPoint
 * @property {number} x
 * @property {number} y
 * @property {string} [label] shown next to the point; capped to a few per chart
 * @property {boolean} [focal] at most one point per chart may set this
 */

/**
 * @typedef {Object} ScatterSpec
 * @property {"scatter"} kind
 * @property {string} id
 * @property {string} title
 * @property {string} [xLabel]
 * @property {string} [yLabel]
 * @property {ScatterPoint[]} points 5-30 points; more should be binned upstream
 * @property {boolean} [trend] draw a dashed least-squares trend line
 * @property {boolean} [quadrants] draw dashed dividers at the median x and y
 */

const R = 5;
const R_FOCAL = 6;
const MAX_LABELS = 3;

/** @param {number[]} values @returns {number} */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Ordinary least squares over the raw data domain (not pixels), so the fitted
 * line is independent of the plot's pixel scale.
 * @param {ScatterPoint[]} points
 * @returns {{ a: number, b: number }} intercept and slope: y = a + b*x
 */
function fitTrend(points) {
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  const b = den === 0 ? 0 : num / den;
  return { a: meanY - b * meanX, b };
}

/**
 * Render a scatter plot: two continuous axes, one circular mark per point.
 *
 * Marks are drawn as `<rect rx=r ry=r>` rather than `<circle>`. A square rect
 * fully rounded on every corner (rx = ry = half its side) IS a circle — same
 * silhouette, same pixels — but unlike a `<circle>` it is a `<rect>`, which is
 * the only shape `validate.mjs` inspects for overlap, label collision and
 * viewBox clipping. Using `<circle>` would make every point invisible to those
 * checks; this gets the reference's circular mark and real geometric
 * validation from the same element.
 * @param {ScatterSpec} spec
 * @returns {string}
 */
export function renderScatter(spec) {
  const points = spec.points;
  if (!points || points.length === 0) {
    throw new Error(`scatter "${spec.id}" has no points`);
  }
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new Error(
        `scatter "${spec.id}" point "${p.label ?? `(${p.x}, ${p.y})`}" has a non-finite coordinate`,
      );
    }
  }
  const focalCount = points.filter((p) => p.focal).length;
  if (focalCount > 1) {
    throw new Error(`scatter "${spec.id}" has ${focalCount} focal points; at most one is allowed`);
  }

  const plot = plotArea();
  const xTicks = niceTicks(
    Math.min(...points.map((p) => p.x)),
    Math.max(...points.map((p) => p.x)),
  );
  const yTicks = niceTicks(
    Math.min(...points.map((p) => p.y)),
    Math.max(...points.map((p) => p.y)),
  );
  const x = linearScale([xTicks.min, xTicks.max], [plot.x, plot.x2]);
  const y = linearScale([yTicks.min, yTicks.max], [plot.y2, plot.y]);

  const laid = points.map((p) => {
    const r = p.focal ? R_FOCAL : R;
    return { point: p, cx: x(p.x), cy: y(p.y), r };
  });

  /** @type {Rect[]} occupied boxes for label placement: every point, then every placed label */
  const occupied = laid.map((p) => ({ x: p.cx - p.r, y: p.cy - p.r, w: p.r * 2, h: p.r * 2 }));

  /** @type {string[]} */
  const parts = [];
  parts.push(`<rect class="bg" x="0" y="0" width="${VIEW.w}" height="${VIEW.h}" rx="10"/>`);

  if (spec.quadrants) {
    const mx = x(median(points.map((p) => p.x)));
    const my = y(median(points.map((p) => p.y)));
    parts.push(
      `<line class="hair" x1="${mx}" y1="${plot.y}" x2="${mx}" y2="${plot.y2}" stroke-dasharray="3 4"/>`,
      `<line class="hair" x1="${plot.x}" y1="${my}" x2="${plot.x2}" y2="${my}" stroke-dasharray="3 4"/>`,
    );
    const corners = [
      { tx: plot.x + 6, ty: plot.y + 14, anchor: "start", text: "LOW X \u00b7 HIGH Y" },
      { tx: plot.x2 - 6, ty: plot.y + 14, anchor: "end", text: "HIGH X \u00b7 HIGH Y" },
      { tx: plot.x + 6, ty: plot.y2 - 8, anchor: "start", text: "LOW X \u00b7 LOW Y" },
      { tx: plot.x2 - 6, ty: plot.y2 - 8, anchor: "end", text: "HIGH X \u00b7 LOW Y" },
    ];
    for (const c of corners) {
      parts.push(
        `<text class="vlab" x="${c.tx}" y="${c.ty}" text-anchor="${c.anchor}">${esc(c.text)}</text>`,
      );
    }
  }

  parts.push(
    yAxis({ plot, ticks: yTicks.ticks, step: yTicks.step, y }),
    xAxis({ plot, ticks: xTicks.ticks, step: xTicks.step, x }),
    axisTitles({ plot, xLabel: spec.xLabel, yLabel: spec.yLabel }),
  );

  if (spec.trend) {
    // Never force a fit on a genuinely scattered cloud is an authoring call,
    // not this renderer's to make; `spec.trend` is the author's assertion that
    // the relationship is real. Fitted and drawn on the raw data domain, then
    // clamped to the plot's vertical bounds so a steep slope cannot draw
    // outside the frame it is describing.
    const { a, b } = fitTrend(points);
    /** @param {number} v @returns {number} */
    const clampY = (v) => Math.min(Math.max(v, plot.y), plot.y2);
    parts.push(
      `<line class="ser" x1="${x(xTicks.min)}" y1="${clampY(y(a + b * xTicks.min))}" ` +
        `x2="${x(xTicks.max)}" y2="${clampY(y(a + b * xTicks.max))}" stroke-dasharray="4 3"/>`,
    );
  }

  for (const { point, cx, cy, r } of laid) {
    const cls = point.focal ? "mark focal" : "mark";
    parts.push(
      `<rect class="${cls}" x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" rx="${r}" ry="${r}"/>`,
    );
  }

  // Label at most a few points: every other one would mush into the cloud, and
  // the reference calls for the focal point plus 1-2 outliers, never all of
  // them. Focal first (it is the point most worth naming), then spec order.
  const labeled = laid
    .filter((p) => p.point.label)
    .sort((a, b) => (b.point.focal ? 1 : 0) - (a.point.focal ? 1 : 0))
    .slice(0, MAX_LABELS);
  for (const p of labeled) {
    const label = /** @type {string} */ (p.point.label);
    const lines = wrap(label, 18);
    const w = Math.max(...lines.map((l) => l.length)) * MONO_CH + 10;
    const h = lines.length * 11 + 6;
    // Anchored to the right of the point, then `place` slides it off any box
    // (another point or an already-placed label) it would otherwise sit on.
    const rect = place(p.cx + p.r + 8 + w / 2, p.cy, w, h, occupied, "x");
    occupied.push(rect);
    const tx = rect.x + w / 2;
    const cls = p.point.focal ? "vlab focal" : "vlab";
    const tspans = lines
      .map((l, i) => `<tspan x="${tx}" dy="${i === 0 ? 0 : 11}">${esc(l)}</tspan>`)
      .join("");
    parts.push(
      `<rect class="emask" x="${rect.x}" y="${rect.y}" width="${w}" height="${h}" rx="3"/>`,
      `<text class="${cls}" x="${tx}" y="${rect.y + 8}" text-anchor="middle">${tspans}</text>`,
    );
  }

  return assemble([
    `<svg viewBox="0 0 ${VIEW.w} ${VIEW.h}" role="img" aria-label="${esc(spec.title)}">`,
    parts.join(""),
    "</svg>",
  ]);
}
