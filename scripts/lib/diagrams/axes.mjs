import { esc, wrap, MONO_CH } from "./text.mjs";
import { formatTick } from "./scale.mjs";

/** @typedef {import("./scale.mjs").Plot} Plot */
/** @typedef {import("./scale.mjs").Band} Band */
/** @typedef {import("./types.mjs").Track} Track */

// Axis furniture. Gridlines are drawn FIRST and very faint on purpose: they exist
// to let a reader estimate a value, not to be looked at, so anything that competes
// with the data marks is a defect. The baseline and the y-axis line are darker
// because they are the frame the marks sit on.

// The three rows below the baseline, in reading order, with enough separation
// that a two-line wrapped category label cannot reach the axis title and the
// title cannot reach the legend. They were 48 and 40 and therefore COLLIDED: the
// legend swatches printed on top of the axis title. Keep these ordered and keep
// the total inside `MARGIN.bottom` (80).
const CATEGORY_DY = 18;
const AXIS_TITLE_DY = 46;
const LEGEND_DY = 68;

/**
 * Horizontal gridlines plus right-aligned value labels down the y-axis.
 * @param {{ plot: Plot, ticks: number[], step: number, y: (v: number) => number, track?: Track }} args
 * @returns {string}
 */
export function yAxis({ plot, ticks, step, y, track }) {
  /** @type {string[]} */
  const parts = [];
  for (const t of ticks) {
    const py = y(t);
    parts.push(`<line class="grid" x1="${plot.x}" y1="${py}" x2="${plot.x2}" y2="${py}"/>`);
    const label = formatTick(t, step);
    parts.push(
      `<text class="tick" x="${plot.x - 8}" y="${py + 3}" text-anchor="end">${esc(label)}</text>`,
    );
    if (track) track(plot.x - 8 - label.length * MONO_CH, py - 5, label.length * MONO_CH, 10);
  }
  parts.push(`<line class="axis" x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y2}"/>`);
  return parts.join("");
}

/**
 * The x-axis baseline plus one centred label per category.
 *
 * Long category labels WRAP rather than being truncated or rotated: a rotated
 * label is unreadable at this size, and a truncated one loses the identity the
 * label exists to carry.
 * @param {{ plot: Plot, band: Band, labels: string[], track?: Track }} args
 * @returns {string}
 */
export function categoryAxis({ plot, band, labels, track }) {
  /** @type {string[]} */
  const parts = [
    `<line class="axis" x1="${plot.x}" y1="${plot.y2}" x2="${plot.x2}" y2="${plot.y2}"/>`,
  ];
  const maxChars = Math.max(6, Math.floor(band.pitch / 6.2));
  labels.forEach((label, i) => {
    const cx = band.center(i);
    const lines = wrap(label, maxChars);
    parts.push(
      `<text class="clab" x="${cx}" y="${plot.y2 + CATEGORY_DY}" text-anchor="middle">` +
        lines
          .map((l, k) => `<tspan x="${cx}" dy="${k === 0 ? 0 : 12}">${esc(l)}</tspan>`)
          .join("") +
        "</text>",
    );
    if (track) track(cx - band.pitch / 2, plot.y2 + 6, band.pitch, 14 + lines.length * 12);
  });
  return parts.join("");
}

/**
 * A numeric x-axis: baseline, ticks, and labels under each tick.
 * @param {{ plot: Plot, ticks: number[], step: number, x: (v: number) => number, track?: Track }} args
 * @returns {string}
 */
export function xAxis({ plot, ticks, step, x, track }) {
  /** @type {string[]} */
  const parts = [
    `<line class="axis" x1="${plot.x}" y1="${plot.y2}" x2="${plot.x2}" y2="${plot.y2}"/>`,
  ];
  for (const t of ticks) {
    const px = x(t);
    parts.push(`<line class="grid" x1="${px}" y1="${plot.y}" x2="${px}" y2="${plot.y2}"/>`);
    const label = formatTick(t, step);
    parts.push(
      `<text class="tick" x="${px}" y="${plot.y2 + 16}" text-anchor="middle">${esc(label)}</text>`,
    );
    if (track) {
      track(px - (label.length * MONO_CH) / 2, plot.y2 + 6, label.length * MONO_CH, 12);
    }
  }
  return parts.join("");
}

/**
 * An axis title, placed outside the plot so it never competes with the marks. The
 * y title is rotated to run with its axis, which also means a long title needs no
 * horizontal budget.
 * @param {{ plot: Plot, xLabel?: string, yLabel?: string }} args
 * @returns {string}
 */
export function axisTitles({ plot, xLabel, yLabel }) {
  /** @type {string[]} */
  const parts = [];
  if (xLabel) {
    parts.push(
      `<text class="atitle" x="${plot.x + plot.w / 2}" y="${plot.y2 + AXIS_TITLE_DY}" text-anchor="middle">${esc(xLabel)}</text>`,
    );
  }
  if (yLabel) {
    const cy = plot.y + plot.h / 2;
    const cx = plot.x - 54;
    parts.push(
      `<text class="atitle" x="${cx}" y="${cy}" text-anchor="middle" transform="rotate(-90 ${cx} ${cy})">${esc(yLabel)}</text>`,
    );
  }
  return parts.join("");
}

/**
 * A horizontal legend strip under the plot, one swatch per series.
 *
 * Only emitted when there is more than one series: a legend for a single series
 * restates the title and spends a row for nothing.
 * @param {{ plot: Plot, series: { label: string, focal?: boolean, index: number }[], track?: Track }} args
 * @returns {string}
 */
export function legend({ plot, series, track }) {
  if (series.length < 2) return "";
  /** @type {string[]} */
  const parts = [];
  const gap = 18;
  const swatch = 16;
  const widths = series.map((s) => swatch + 6 + s.label.length * 6.2 + gap);
  const total = widths.reduce((a, b) => a + b, 0) - gap;
  let cursor = plot.x + plot.w / 2 - total / 2;
  const y = plot.y2 + LEGEND_DY;
  series.forEach((s, i) => {
    const cls = s.focal ? "swatch focal" : `swatch s${(s.index % 4) + 1}`;
    parts.push(
      `<rect class="${cls}" x="${cursor}" y="${y - 7}" width="${swatch}" height="8" rx="2"/>`,
      `<text class="tick" x="${cursor + swatch + 6}" y="${y}">${esc(s.label)}</text>`,
    );
    if (track) track(cursor, y - 10, widths[i], 14);
    cursor += widths[i];
  });
  return parts.join("");
}
