// A 2x2 prioritization matrix: two labelled axes crossing at the centre, four
// named quadrants, and items placed by their own (x, y) score. Built on the
// shared cartesian plot area so a quadrant lines up with a bar, line or
// scatter chart of related data placed beside it in the same document.
//
// Items are drawn as fully-rounded `<rect>` marks rather than `<circle>`, the
// same trick `scatter.mjs` uses: a `<rect>` is the only shape `validate.mjs`
// checks for overlap and label collision, so this keeps an item's real
// geometry inside those checks instead of hiding it from them.

import { assemble, esc, wrap, snap, MONO_CH } from "./text.mjs";
import { plotArea, linearScale, VIEW } from "./scale.mjs";
import { axisTitles } from "./axes.mjs";
import { place } from "./geometry.mjs";

/** @typedef {import("./types.mjs").Rect} Rect */

/**
 * @typedef {Object} QuadrantAxis
 * @property {string} label the dimension name, e.g. "effort"
 * @property {string} low one bare word for the low end, e.g. "low"
 * @property {string} high one bare word for the high end, e.g. "high"
 */

/**
 * @typedef {Object} QuadrantItem
 * @property {string} label
 * @property {number} x 0 (low) .. 1 (high) on `xAxis`
 * @property {number} y 0 (low) .. 1 (high) on `yAxis`
 * @property {boolean} [focal] at most one item per chart may set this
 */

/**
 * @typedef {Object} QuadrantSpec
 * @property {"quadrant"} kind
 * @property {string} id
 * @property {string} title
 * @property {QuadrantAxis} xAxis
 * @property {QuadrantAxis} yAxis
 * @property {[string, string, string, string]} quadrants names in reading
 *   order: top-left, top-right, bottom-left, bottom-right
 * @property {QuadrantItem[]} items 1-12 items; cluster or split beyond that
 */

/** @typedef {{ tx: number, ty: number, anchor: "start" | "end" | "middle", text: string }} TipLabel */
/** @typedef {{ cx: number, cy: number, anchor: "start" | "end", text: string }} CornerLabel */

const R = 5;
const R_FOCAL = 6;
const MAX_ITEMS = 12;
const CORNER_PAD = 16;
const TIP_LEN = 9;
const TIP_ABOVE = 12;
const TIP_BELOW = 20;
const LABEL_MAX_CHARS = 20;
const PAD = 16;

/**
 * @param {QuadrantAxis | undefined} axis
 * @param {"x" | "y"} which
 * @param {string} id
 * @returns {void}
 */
function requireAxis(axis, which, id) {
  if (!axis || !axis.label || !axis.low || !axis.high) {
    throw new Error(`quadrant "${id}" is missing its ${which} axis label, low or high word`);
  }
}

/**
 * Render a 2x2 prioritization matrix: dividers through the centre, quadrant
 * names in the corners, and items positioned by score with collision-avoided
 * labels.
 * @param {QuadrantSpec} spec
 * @returns {string}
 */
export function renderQuadrant(spec) {
  const items = spec.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`quadrant "${spec.id}" has no items`);
  }
  if (items.length > MAX_ITEMS) {
    throw new Error(
      `quadrant "${spec.id}" has ${items.length} items; cluster or split past ${MAX_ITEMS}`,
    );
  }
  if (!Array.isArray(spec.quadrants) || spec.quadrants.length !== 4) {
    throw new Error(
      `quadrant "${spec.id}" needs exactly 4 quadrant names, got ${spec.quadrants?.length ?? 0}`,
    );
  }
  requireAxis(spec.xAxis, "x", spec.id);
  requireAxis(spec.yAxis, "y", spec.id);
  for (const item of items) {
    const validX = Number.isFinite(item.x) && item.x >= 0 && item.x <= 1;
    const validY = Number.isFinite(item.y) && item.y >= 0 && item.y <= 1;
    if (!validX || !validY) {
      throw new Error(
        `quadrant "${spec.id}" item "${item.label}" needs x and y in 0..1, got (${item.x}, ${item.y})`,
      );
    }
  }
  const focalCount = items.filter((item) => item.focal).length;
  if (focalCount > 1) {
    throw new Error(`quadrant "${spec.id}" has ${focalCount} focal items; at most one is allowed`);
  }

  const plot = plotArea();
  const x = linearScale([0, 1], [plot.x, plot.x2]);
  const y = linearScale([0, 1], [plot.y2, plot.y]);
  const cx = x(0.5);
  const cy = y(0.5);

  /** @type {{ minX: number, minY: number, maxX: number, maxY: number }} */
  const bounds = { minX: plot.x, minY: plot.y, maxX: plot.x2, maxY: plot.y2 };
  /** @param {number} tx @param {number} ty @param {number} tw @param {number} th @returns {void} */
  const track = (tx, ty, tw, th) => {
    bounds.minX = Math.min(bounds.minX, tx);
    bounds.minY = Math.min(bounds.minY, ty);
    bounds.maxX = Math.max(bounds.maxX, tx + tw);
    bounds.maxY = Math.max(bounds.maxY, ty + th);
  };

  // The furniture (cross, single-ended arrow tips, dimension titles) is fixed
  // by the plot rectangle alone, never by the data, so it is trusted to sit
  // inside the standard margin the same way every other cartesian kind trusts
  // `axisTitles` — only the tip words and item labels carry variable-length
  // author text and get tracked below.
  /** @type {string[]} */
  const furniture = [
    `<line class="axis" x1="${plot.x}" y1="${cy}" x2="${plot.x2}" y2="${cy}"/>`,
    `<line class="axis" x1="${cx}" y1="${plot.y}" x2="${cx}" y2="${plot.y2}"/>`,
    `<path class="dot" d="M${plot.x2},${cy - 4} L${plot.x2 + TIP_LEN},${cy} L${plot.x2},${cy + 4} Z"/>`,
    `<path class="dot" d="M${cx - 4},${plot.y} L${cx},${plot.y - TIP_LEN} L${cx + 4},${plot.y} Z"/>`,
    axisTitles({ plot, xLabel: spec.xAxis.label, yLabel: spec.yAxis.label }),
  ];

  /** @type {TipLabel[]} */
  const tips = [
    { tx: plot.x - TIP_ABOVE, ty: cy + 3, anchor: "end", text: spec.xAxis.low },
    { tx: plot.x2 + TIP_LEN + TIP_ABOVE, ty: cy + 3, anchor: "start", text: spec.xAxis.high },
    { tx: cx, ty: plot.y - TIP_LEN - TIP_ABOVE, anchor: "middle", text: spec.yAxis.high },
    { tx: cx, ty: plot.y2 + TIP_BELOW, anchor: "middle", text: spec.yAxis.low },
  ];
  for (const tip of tips) {
    const word = tip.text.toUpperCase();
    furniture.push(
      `<text class="tick" x="${tip.tx}" y="${tip.ty}" text-anchor="${tip.anchor}">${esc(word)}</text>`,
    );
    const w = word.length * MONO_CH;
    const bx =
      tip.anchor === "end" ? tip.tx - w : tip.anchor === "middle" ? tip.tx - w / 2 : tip.tx;
    track(bx, tip.ty - 9, w, 11);
  }

  /** @type {Rect[]} occupied boxes for item-label placement */
  const occupied = [];
  /** @type {string[]} */
  const cornerTags = [];
  /** @type {CornerLabel[]} */
  const corners = [
    { cx: plot.x + CORNER_PAD, cy: plot.y + CORNER_PAD, anchor: "start", text: spec.quadrants[0] },
    { cx: plot.x2 - CORNER_PAD, cy: plot.y + CORNER_PAD, anchor: "end", text: spec.quadrants[1] },
    { cx: plot.x + CORNER_PAD, cy: plot.y2 - CORNER_PAD, anchor: "start", text: spec.quadrants[2] },
    { cx: plot.x2 - CORNER_PAD, cy: plot.y2 - CORNER_PAD, anchor: "end", text: spec.quadrants[3] },
  ];
  for (const corner of corners) {
    const word = corner.text.toUpperCase();
    cornerTags.push(
      `<text class="tag" x="${corner.cx}" y="${corner.cy}" text-anchor="${corner.anchor}">${esc(word)}</text>`,
    );
    const w = word.length * MONO_CH;
    const bx = corner.anchor === "end" ? corner.cx - w : corner.cx;
    occupied.push({ x: bx - 4, y: corner.cy - 10, w: w + 8, h: 14 });
    track(bx, corner.cy - 10, w, 14);
  }

  const laid = items.map((item) => ({
    item,
    cx: x(item.x),
    cy: y(item.y),
    r: item.focal ? R_FOCAL : R,
  }));
  for (const p of laid) occupied.push({ x: p.cx - p.r, y: p.cy - p.r, w: p.r * 2, h: p.r * 2 });

  /** @type {string[]} */
  const marks = laid.map(
    (p) =>
      `<rect class="${p.item.focal ? "mark focal" : "mark"}" x="${p.cx - p.r}" y="${p.cy - p.r}" width="${p.r * 2}" height="${p.r * 2}" rx="${p.r}" ry="${p.r}"/>`,
  );

  /** @type {string[]} */
  const labels = [];
  for (const p of laid) {
    const lines = wrap(p.item.label, LABEL_MAX_CHARS);
    const w = Math.max(...lines.map((l) => l.length)) * MONO_CH + 10;
    const h = lines.length * 11 + 6;
    // Anchored to the right of the item, same as `scatter.mjs`; `place` then
    // slides it off any box (a corner tag, another item, another label) it
    // would otherwise sit on.
    const rect = place(p.cx + p.r + 8 + w / 2, p.cy, w, h, occupied, "x");
    occupied.push(rect);
    const tx = rect.x + w / 2;
    const cls = p.item.focal ? "vlab focal" : "vlab";
    const tspans = lines
      .map((l, i) => `<tspan x="${tx}" dy="${i === 0 ? 0 : 11}">${esc(l)}</tspan>`)
      .join("");
    labels.push(
      `<rect class="emask" x="${rect.x}" y="${rect.y}" width="${w}" height="${h}" rx="3"/>`,
      `<text class="${cls}" x="${tx}" y="${rect.y + 8}" text-anchor="middle">${tspans}</text>`,
    );
    track(rect.x, rect.y, w, h);
  }

  // Fitted to whichever is larger: the standard chart grid (so this lines up
  // with its cartesian siblings) or the actual tracked extent (so a long tip
  // word or a label pushed wide by `place` is never clipped).
  const vx = snap(Math.min(0, bounds.minX - PAD));
  const vy = snap(Math.min(0, bounds.minY - PAD));
  const vw = snap(Math.max(VIEW.w, bounds.maxX + PAD) - vx);
  const vh = snap(Math.max(VIEW.h, bounds.maxY + PAD) - vy);

  return assemble([
    `<svg viewBox="${vx} ${vy} ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="10"/>`,
    furniture.join(""),
    cornerTags.join(""),
    marks.join(""),
    labels.join(""),
    "</svg>",
  ]);
}
