// High-level stack overview: a phase chevron banner across the top, a
// deployment boundary containing an orchestration bar and the phase's
// components, and an identity footer below the boundary.
//
// Geometry mirrors `references/type-high-level.md` §2 wherever this input
// contract carries the data that formula needs: the chevron-banner width
// split (§2.2), the cluster boundary and orchestration bar insets (§2.4/§2.6)
// and the "node centered on its chevron" rule (§2.7). This contract has no
// `sources`, no vertical chevrons and no per-component `connections`, so the
// source zone (§2.3), the right-side vertical strip (§2.9) and the connector
// rules (§3) do not apply — there is nothing in the input to route an edge
// from. The cluster height is NOT the reference's flat 336: it is fit to the
// tallest phase column (§11 of the assignment; the reference's own 336 would
// clip a 3-row column, since 120 + 3*80 + 2*16 = 392 > 40 + 336).

import { assemble, esc, snap, wrap, MONO_CH, NAME_CH } from "./text.mjs";
import { indexTag } from "./shapes.mjs";

/**
 * @typedef {Object} HighLevelComponent
 * @property {string} label
 * @property {number} phase 0-based index into `chevrons`
 * @property {boolean} [focal] exactly one component across the spec must set this
 */

/**
 * @typedef {Object} HighLevelSpec
 * @property {"high-level"} kind
 * @property {string} [id]
 * @property {string} title
 * @property {string[]} chevrons phase names, left to right
 * @property {HighLevelComponent[]} components
 * @property {string} orchestration tool named in the cluster's orchestration bar
 * @property {string} identity tool named in the footer's identity bar
 */

const EFFECTIVE_W = 1000;
const BANNER_TOP = 4;
const BANNER_BOTTOM = 32;
const BANNER_LABEL_Y = 21;
const CLUSTER_X = 4;
const CLUSTER_Y = 40;
const CLUSTER_W = EFFECTIVE_W - CLUSTER_X - 4;
const BAR_INSET = 12;
const BAR_H = 44;
const BAR_Y = CLUSTER_Y + BAR_INSET;
const BAR_X = CLUSTER_X + BAR_INSET;
const BAR_W = CLUSTER_W - BAR_INSET * 2;
const NODE_W = 152;
const NODE_H = 80;
const ROW_GAP = 16;
const FIRST_ROW_Y = BAR_Y + BAR_H + 24; // clears the orchestration bar
const CLUSTER_MIN_H = 336;
const CLUSTER_BOTTOM_PAD = 24;
const FOOTER_GUTTER = 16;
const FOOTER_H = 40;
const BOTTOM_PAD = 24;
const MIN_CHEVRON_W = 120;

/** @param {number} x @returns {number} */
const floorTo4 = (x) => Math.floor(x / 4) * 4;

/**
 * The chevron banner's column boundaries (§2.2): each column is at least
 * `MIN_CHEVRON_W`, sized off an equal split of `EFFECTIVE_W` otherwise, with
 * the last column absorbing whatever the floor-to-4 rounding leaves over.
 * @param {number} n
 * @returns {number[]} n+1 boundaries, x_boundaries[0] === 0, x_boundaries[n] === EFFECTIVE_W
 */
function chevronBounds(n) {
  const baseUnit = floorTo4(EFFECTIVE_W / n);
  /** @type {number[]} */
  const widths = new Array(n).fill(Math.max(MIN_CHEVRON_W, baseUnit));
  const sum = widths.reduce((a, b) => a + b, 0);
  widths[n - 1] += EFFECTIVE_W - sum;
  if (widths[n - 1] < 40) {
    throw new Error(`too many chevrons (${n}) to fit a legible ${EFFECTIVE_W}px banner`);
  }
  const bounds = [0];
  for (const w of widths) bounds.push(bounds[bounds.length - 1] + w);
  return bounds;
}

/**
 * One chevron polygon (§2.2): a point on the right unless it is the last
 * column (which meets the canvas edge flat), a notch on the left unless it is
 * the first column (which starts flat).
 * @param {number} x0 @param {number} x1 @param {boolean} isFirst @param {boolean} isLast
 * @returns {string} polygon points
 */
function chevronPoints(x0, x1, isFirst, isLast) {
  const top = BANNER_TOP;
  const bottom = BANNER_BOTTOM;
  const mid = (top + bottom) / 2;
  if (isFirst && isLast) return `${x0},${top} ${x1},${top} ${x1},${bottom} ${x0},${bottom}`;
  const right = isLast
    ? `${x1},${top} ${x1},${bottom}`
    : `${x1 - 12},${top} ${x1},${mid} ${x1 - 12},${bottom}`;
  const left = isFirst ? "" : ` ${x0 + 12},${mid}`;
  return `${x0},${top} ${right} ${x0},${bottom}${left}`;
}

/**
 * Render a high-level stack overview to inline SVG.
 * @param {HighLevelSpec} spec
 * @returns {string}
 */
export function renderHighLevel(spec) {
  const chevrons = spec.chevrons ?? [];
  if (chevrons.length === 0) {
    throw new Error("a high-level overview needs at least one phase chevron");
  }
  const components = spec.components ?? [];
  if (components.length === 0) {
    throw new Error("a high-level overview needs at least one component");
  }
  components.forEach((c) => {
    if (!Number.isInteger(c.phase) || c.phase < 0 || c.phase >= chevrons.length) {
      throw new Error(
        `component "${c.label}" has phase ${c.phase}, outside 0..${chevrons.length - 1}`,
      );
    }
  });
  const focalComponents = components.filter((c) => c.focal);
  if (focalComponents.length !== 1) {
    const named = focalComponents.map((c) => c.label).join(", ");
    throw new Error(
      `a high-level overview needs exactly one focal component, got ${focalComponents.length}${named ? ` (${named})` : ""}`,
    );
  }
  if (!spec.orchestration) throw new Error("a high-level overview needs an orchestration tool");
  if (!spec.identity) throw new Error("a high-level overview needs an identity tool");

  const n = chevrons.length;
  const bounds = chevronBounds(n);
  /** @param {number} i @returns {number} */
  const chevronCx = (i) => (bounds[i] + bounds[i + 1]) / 2;

  /** @type {Map<number, HighLevelComponent[]>} */
  const byPhase = new Map();
  for (const c of components) {
    const list = byPhase.get(c.phase) ?? [];
    list.push(c);
    byPhase.set(c.phase, list);
  }
  const maxRows = Math.max(1, ...[...byPhase.values()].map((list) => list.length));

  // §11: fit the boundary to the tallest column actually drawn, never a flat
  // constant that a deep column could overflow.
  const stackBottom = FIRST_ROW_Y + maxRows * NODE_H + (maxRows - 1) * ROW_GAP;
  const clusterH = Math.max(CLUSTER_MIN_H, stackBottom + CLUSTER_BOTTOM_PAD - CLUSTER_Y);
  const clusterBottom = CLUSTER_Y + clusterH;
  const footerY = clusterBottom + FOOTER_GUTTER;
  const vh = footerY + FOOTER_H + BOTTOM_PAD;

  /** @type {string[]} */
  const banner = [];
  chevrons.forEach((label, i) => {
    const x0 = bounds[i];
    const x1 = bounds[i + 1];
    banner.push(
      `<polygon class="mark ${i % 2 === 0 ? "s1" : "s2"}" points="${chevronPoints(x0, x1, i === 0, i === n - 1)}"/>`,
    );
    const lines = wrap(label, Math.floor((x1 - x0 - 16) / MONO_CH));
    const cx = chevronCx(i);
    const baseline = BANNER_LABEL_Y - ((lines.length - 1) * 8) / 2;
    banner.push(
      `<text class="tag" x="${cx}" y="${baseline}" text-anchor="middle">` +
        lines
          .map((l, k) => `<tspan x="${cx}" dy="${k === 0 ? 0 : 8}">${esc(l.toUpperCase())}</tspan>`)
          .join("") +
        "</text>",
    );
  });

  const zone = [
    `<rect class="zone" x="${CLUSTER_X}" y="${CLUSTER_Y}" width="${CLUSTER_W}" height="${clusterH}" rx="8"/>`,
    indexTag(CLUSTER_X + 12, CLUSTER_Y + 20, "deployment boundary"),
  ].join("");

  const barCx = BAR_X + BAR_W / 2;
  const bar = [
    `<rect class="nb" x="${BAR_X}" y="${BAR_Y}" width="${BAR_W}" height="${BAR_H}" rx="4"/>`,
    `<text class="tag" x="${barCx}" y="${BAR_Y + 16}" text-anchor="middle">ORCHESTRATION</text>`,
    `<text class="nn" x="${barCx}" y="${BAR_Y + 33}" text-anchor="middle">${esc(spec.orchestration)}</text>`,
  ].join("");

  /** @type {string[]} */
  const nodes = [];
  chevrons.forEach((_, phase) => {
    const cx = chevronCx(phase);
    const x = cx - NODE_W / 2;
    (byPhase.get(phase) ?? []).forEach((comp, row) => {
      const y = FIRST_ROW_Y + row * (NODE_H + ROW_GAP);
      const cls = comp.focal ? "nb focal" : "nb";
      nodes.push(
        `<rect class="${cls}" x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="6"/>`,
      );
      const lines = wrap(comp.label, Math.floor((NODE_W - 24) / NAME_CH));
      const baseline = y + NODE_H / 2 + 4 - ((lines.length - 1) * 13) / 2;
      nodes.push(
        `<text class="nn" x="${cx}" y="${baseline}" text-anchor="middle">` +
          lines
            .map((l, k) => `<tspan x="${cx}" dy="${k === 0 ? 0 : 13}">${esc(l)}</tspan>`)
            .join("") +
          "</text>",
      );
    });
  });

  const footerCx = CLUSTER_X + CLUSTER_W / 2;
  const footer = [
    `<rect class="nb" x="${CLUSTER_X}" y="${footerY}" width="${CLUSTER_W}" height="${FOOTER_H}" rx="4"/>`,
    `<text class="tag" x="${footerCx}" y="${footerY + 15}" text-anchor="middle">IDENTITY</text>`,
    `<text class="nn" x="${footerCx}" y="${footerY + 32}" text-anchor="middle">${esc(spec.identity)}</text>`,
  ].join("");

  return assemble([
    `<svg viewBox="0 0 ${snap(EFFECTIVE_W)} ${snap(vh)}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="0" y="0" width="${snap(EFFECTIVE_W)}" height="${snap(vh)}" rx="10"/>`,
    banner.join(""),
    zone,
    bar,
    nodes.join(""),
    footer,
    "</svg>",
  ]);
}
