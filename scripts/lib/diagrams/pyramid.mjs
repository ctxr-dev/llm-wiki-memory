// A pyramid / funnel: stacked horizontal slabs, widest at the top and
// narrowing downward. `shape: "funnel"` scales each slab's WIDTH to its value
// so the taper itself carries the data; `shape: "pyramid"` steps the widths
// down in equal increments (decorative — the value lives in the label) since
// a value pyramid usually ranks tiers rather than measuring a population that
// shrinks tier over tier.
//
// Slabs are plain rects, not sloped trapezoids: `validateSvg` only recognises
// `<rect class="mark">` as a data mark, so a polygon taper would score as an
// empty diagram while looking fine to the eye — the exact failure mode its own
// doc comment warns a new kind can fall into.

import { assemble, esc, snap, NAME_CH, MONO_CH } from "./text.mjs";

/**
 * @typedef {Object} PyramidStage
 * @property {string} label
 * @property {number} value
 * @property {boolean} [focal]
 */

/**
 * @typedef {Object} PyramidSpec
 * @property {"pyramid"} kind
 * @property {string} id
 * @property {string} title becomes the SVG's aria-label
 * @property {"funnel" | "pyramid"} shape
 * @property {PyramidStage[]} stages ordered top (widest) to bottom (narrowest), 3-7 entries
 */

const BAND_H = 60;
const TOP_PAD = 28;
const BOTTOM_PAD = 28;
const SIDE_PAD = 24;
const CENTER_X = 420;
const MAX_W = 620;
const PYRAMID_MIN_W = 160;
const FUNNEL_FLOOR_W = 40;
// Fixed columns so every leader-line label / annotation lines up down the
// page, rather than drifting with each row's own (varying) slab width.
const LEADER_COL_X = 90;
const LEADER_TEXT_GAP = 8;
const ANNOT_GAP = 24;
const INNER_PAD = 14;

/**
 * One width per stage, top to bottom. The caller has already confirmed values
 * are non-increasing, so `stages[0]` is always the largest and anchors the
 * funnel's proportional scale.
 *
 * The funnel case is an AFFINE map (`FUNNEL_FLOOR_W` at value 0, `MAX_W` at
 * the top value), not a plain `Math.max(floor, proportional)` clamp: a hard
 * clamp collapses every value below the floor's threshold to the SAME width,
 * which silently turns "monotonically narrowing" into "flat, then narrowing"
 * for any long-tailed funnel — exactly the shape real conversion data has.
 * The affine map stays strictly increasing in value everywhere, so distinct
 * values always render distinct widths, while values near zero still get a
 * visible, non-degenerate slab.
 * @param {"funnel" | "pyramid"} shape
 * @param {PyramidStage[]} stages
 * @returns {number[]}
 */
function stageWidths(shape, stages) {
  const n = stages.length;
  if (shape === "pyramid") {
    return stages.map((_, i) => MAX_W - ((MAX_W - PYRAMID_MIN_W) * i) / (n - 1));
  }
  const top = stages[0].value;
  return stages.map((s) => FUNNEL_FLOOR_W + (s.value / top) * (MAX_W - FUNNEL_FLOOR_W));
}

/** @param {number} n @returns {string} */
function formatCount(n) {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * @param {number} prev @param {number} value
 * @returns {string}
 */
function dropOffLabel(prev, value) {
  const pct = Math.round((1 - value / prev) * 100);
  return pct <= 0 ? "0%" : `-${pct}%`;
}

/**
 * @param {PyramidSpec} spec
 * @returns {string}
 */
export function renderPyramid(spec) {
  const stages = spec.stages ?? [];
  if (stages.length < 3 || stages.length > 7) {
    throw new Error(`a pyramid needs 3-7 stages, got ${stages.length}`);
  }
  if (spec.shape !== "funnel" && spec.shape !== "pyramid") {
    throw new Error(`unknown pyramid shape "${spec.shape}"`);
  }
  for (const stage of stages) {
    if (!Number.isFinite(stage.value) || stage.value <= 0) {
      throw new Error(`stage "${stage.label}" has a non-finite or non-positive value`);
    }
  }
  for (let i = 1; i < stages.length; i += 1) {
    if (stages[i].value > stages[i - 1].value) {
      throw new Error(
        `stage "${stages[i].label}" (${stages[i].value}) is larger than the stage above it, ` +
          `"${stages[i - 1].label}" (${stages[i - 1].value}); a funnel or pyramid may not widen going down`,
      );
    }
  }
  if (stages.filter((s) => s.focal).length > 1) {
    throw new Error("a pyramid may have at most one focal stage");
  }

  const widths = stageWidths(spec.shape, stages);

  // Tracks the true drawn extent (rule: viewBox fits actual content, not a
  // nominal budget), seeded with the top slab's edges since it is always the
  // widest one on either shape.
  let minX = CENTER_X - MAX_W / 2;
  let maxRight = CENTER_X + MAX_W / 2;

  /** @type {string[]} */
  const marks = [];
  /** @type {string[]} */
  const labels = [];

  stages.forEach((stage, i) => {
    const w = widths[i];
    const y = TOP_PAD + i * BAND_H;
    const x = CENTER_X - w / 2;
    const cy = y + BAND_H / 2 + 4;

    const classes = stage.focal ? "mark focal" : "mark";
    marks.push(`<rect class="${classes}" x="${x}" y="${y}" width="${w}" height="${BAND_H}"/>`);

    const fits = w - INNER_PAD * 2 >= stage.label.length * NAME_CH;
    if (fits) {
      labels.push(
        `<text class="nn" x="${CENTER_X}" y="${cy}" text-anchor="middle">${esc(stage.label)}</text>`,
      );
    } else {
      // Too narrow for its own name: a leader line carries the label out to a
      // fixed left column instead of shrinking or wrapping text that would
      // then spill past the slab's edge.
      const labelX = LEADER_COL_X - LEADER_TEXT_GAP;
      labels.push(
        `<path class="hair" d="M${x},${y + BAND_H / 2} H${LEADER_COL_X}"/>`,
        `<text class="nn" x="${labelX}" y="${cy}" text-anchor="end">${esc(stage.label)}</text>`,
      );
      minX = Math.min(minX, labelX - stage.label.length * NAME_CH);
    }

    const annotX = CENTER_X + MAX_W / 2 + ANNOT_GAP;
    const valueText = formatCount(stage.value);
    const dropText = i === 0 ? "" : ` (${dropOffLabel(stages[i - 1].value, stage.value)})`;
    const annotText = valueText + dropText;
    const vlabClasses = stage.focal ? "vlab focal" : "vlab";
    labels.push(`<text class="${vlabClasses}" x="${annotX}" y="${cy}">${esc(annotText)}</text>`);
    maxRight = Math.max(maxRight, annotX + annotText.length * MONO_CH);
  });

  const vx = snap(minX - SIDE_PAD);
  const vw = snap(maxRight + SIDE_PAD) - vx;
  const vh = snap(TOP_PAD + stages.length * BAND_H + BOTTOM_PAD);

  return assemble([
    `<svg viewBox="${vx} 0 ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="${vx}" y="0" width="${vw}" height="${vh}" rx="10"/>`,
    marks.join(""),
    labels.join(""),
    "</svg>",
  ]);
}
