// A radial lollipop chart: one quantitative series wrapped around a circle, for
// data whose CYCLIC order carries meaning (hours of a day, months of a year). A
// bar chart says the same numbers but throws away the wrap-around — "23:00" and
// "00:00" read as opposite ends of a shelf instead of adjacent hours. That is the
// one thing this type buys over Bar, so it only exists for genuinely cyclic axes.
//
// The value mark is a thin ray plus a constant-size endpoint circle, never a
// filled wedge: a wedge's AREA grows quadratically with radius while its length
// still only encodes the value linearly, so its apparent magnitude lies about
// every value except the one at the very tip. The ray's length is the only
// encoding, exactly as a bar's height is the only encoding of a bar chart.

import { assemble, esc, snap, wrap, MONO_CH, NAME_CH } from "./text.mjs";
import { formatTick, linearScale, niceTicks, polarPoint } from "./scale.mjs";

/**
 * @typedef {Object} PolarSlice
 * @property {string} label category label, placed outside the outer ring
 * @property {number} value magnitude along the radius; must be finite and >= 0
 * @property {boolean} [focal] at most one slice across the whole chart
 */

/**
 * @typedef {Object} PolarSpec
 * @property {"polar"} kind
 * @property {string} id
 * @property {string} title used only as the accessible chart name
 * @property {PolarSlice[]} slices in clockwise display order, starting at twelve o'clock
 * @property {string} [rLabel] what the radius measures, e.g. "requests"
 */

const CX = 500;
const CY = 320;
const R = 190;
const LABEL_GAP = 28;
const LINE_H = 13;
const PAD = 24;

/**
 * @param {PolarSpec} spec
 * @returns {string}
 */
export function renderPolar(spec) {
  const slices = spec.slices;
  if (!Array.isArray(slices) || slices.length < 3) {
    throw new Error(`a polar chart needs at least 3 slices, got ${slices?.length ?? 0}`);
  }
  const focalCount = slices.filter((s) => s.focal).length;
  if (focalCount > 1) {
    throw new Error(`a polar chart allows at most one focal slice, got ${focalCount}`);
  }
  slices.forEach((s, i) => {
    if (!Number.isFinite(s.value)) {
      throw new Error(`slice "${s.label ?? i}" has a non-finite value: ${s.value}`);
    }
    if (s.value < 0) {
      throw new Error(
        `slice "${s.label ?? i}" has a negative value (${s.value}); a radius cannot be negative`,
      );
    }
  });

  const count = slices.length;
  const maxValue = Math.max(...slices.map((s) => s.value));
  const { max: scaleMax, step, ticks } = niceTicks(0, maxValue, 5);
  const radiusOf = linearScale([0, scaleMax], [0, R]);
  const ringTicks = ticks.filter((t) => t > 0);

  // Fitted to the ACTUAL drawn extent rather than a guessed canvas: a long
  // category label or a units caption can outgrow any fixed margin, and a
  // fixed margin sized for the worst case wastes space on every ordinary chart.
  const bounds = { minX: CX - R, maxX: CX + R, minY: CY - R, maxY: CY + R };
  /** @param {number} x @param {number} y @param {number} w @param {number} h */
  const track = (x, y, w, h) => {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x + w);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxY = Math.max(bounds.maxY, y + h);
  };

  /** @type {string[]} */
  const rings = [];
  /** @type {string[]} */
  const tickLabels = [];
  // Scale labels sit in the gap BEFORE the first category (half a slice-step
  // anticlockwise of twelve o'clock) so they never sit under a category's own
  // spoke or ray, whatever the slice count.
  for (const t of ringTicks) {
    const r = radiusOf(t);
    rings.push(`<circle class="grid" cx="${CX}" cy="${CY}" r="${r.toFixed(1)}"/>`);
    const p = polarPoint(CX, CY, r, -0.5, count);
    const text = formatTick(t, step);
    const w = text.length * MONO_CH + 6;
    const h = 12;
    const bx = p.x - w;
    const by = p.y - h + 3;
    tickLabels.push(
      `<rect class="emask" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${w.toFixed(1)}" height="${h}"/>` +
        `<text class="tick" x="${(p.x - 3).toFixed(1)}" y="${(p.y + 3).toFixed(1)}" text-anchor="end">${esc(text)}</text>`,
    );
    track(bx, by, w, h);
  }

  /** @type {string[]} */
  const spokes = [];
  /** @type {string[]} */
  const rays = [];
  /** @type {string[]} */
  const markers = [];
  /** @type {string[]} */
  const catLabels = [];

  slices.forEach((s, i) => {
    const outer = polarPoint(CX, CY, R, i, count);
    spokes.push(
      `<line class="grid" x1="${CX}" y1="${CY}" x2="${outer.x.toFixed(1)}" y2="${outer.y.toFixed(1)}"/>`,
    );

    // A zero value keeps its spoke (the category still occupies a slot on the
    // wheel) but draws no ray and no head: a zero-length ray is invisible
    // anyway, and a marker parked at the centre would read as a real point.
    if (s.value > 0) {
      const r = radiusOf(s.value);
      const tip = polarPoint(CX, CY, r, i, count);
      const cls = s.focal ? "mark focal" : "mark";
      rays.push(
        `<line class="${s.focal ? "ser focal" : "ser"}" x1="${CX}" y1="${CY}" x2="${tip.x.toFixed(1)}" y2="${tip.y.toFixed(1)}"/>`,
      );
      const mr = s.focal ? 5 : 4;
      // A bare <circle class="mark"> is enough: validateSvg collects circle and
      // polygon marks for its empty and clipping checks, and deliberately keeps
      // them OUT of the node-overlap check, where low-value radial heads
      // legitimately crowd the hub.
      markers.push(
        `<circle class="${cls}" cx="${tip.x.toFixed(1)}" cy="${tip.y.toFixed(1)}" r="${mr}"/>`,
      );
      track(tip.x - mr, tip.y - mr, mr * 2, mr * 2);
    }

    const anchorPt = polarPoint(CX, CY, R + LABEL_GAP, i, count);
    const dx = anchorPt.x - CX;
    const dy = anchorPt.y - CY;
    // Within 15 degrees of vertical the label centres on the spoke; past that
    // it reads better hugging the side it points to, ending or starting at the
    // ring so it grows away from the chart rather than back over it.
    const anchor = Math.abs(dx) < 0.26 * (R + LABEL_GAP) ? "middle" : dx > 0 ? "start" : "end";
    const lines = wrap(s.label, 20);
    const lineWidth = Math.max(...lines.map((l) => l.length * NAME_CH));
    const blockTop =
      anchor === "middle"
        ? dy < 0
          ? anchorPt.y - (lines.length - 1) * LINE_H - 4
          : anchorPt.y + LINE_H
        : anchorPt.y - ((lines.length - 1) * LINE_H) / 2 + 4;
    const boxX =
      anchor === "start"
        ? anchorPt.x - 2
        : anchor === "end"
          ? anchorPt.x - lineWidth - 2
          : anchorPt.x - lineWidth / 2 - 2;
    const boxY = blockTop - 10;
    const boxW = lineWidth + 4;
    const boxH = lines.length * LINE_H + 4;
    catLabels.push(
      `<text class="clab" x="${anchorPt.x.toFixed(1)}" y="${blockTop.toFixed(1)}" text-anchor="${anchor}">` +
        lines
          .map(
            (l, k) =>
              `<tspan x="${anchorPt.x.toFixed(1)}" dy="${k === 0 ? 0 : LINE_H}">${esc(l)}</tspan>`,
          )
          .join("") +
        "</text>",
    );
    track(boxX, boxY, boxW, boxH);
  });

  // The unit caption lives in a fixed corner rather than in the circular
  // layout: anywhere on the wheel it would compete with a category label at
  // some slice count, and the corner never does.
  /** @type {string[]} */
  const note = [];
  if (spec.rLabel) {
    const text = spec.rLabel.toUpperCase();
    const w = text.length * MONO_CH + 8;
    // Centred ABOVE the wheel, not pinned to a corner. A fixed corner caption
    // pushed the tracked extent out to x=16 while the wheel stayed at CX=500,
    // so the computed viewBox gained a wide empty margin on one side and the
    // whole composition rendered visibly off-centre.
    const cy = CY - R - LABEL_GAP - 26;
    note.push(`<text class="atitle" x="${CX}" y="${cy}" text-anchor="middle">${esc(text)}</text>`);
    track(CX - w / 2, cy - 12, w, 16);
  }

  const vx = snap(bounds.minX - PAD);
  const vy = snap(bounds.minY - PAD);
  const vw = snap(bounds.maxX - bounds.minX + PAD * 2);
  const vh = snap(bounds.maxY - bounds.minY + PAD * 2);

  return assemble([
    `<svg viewBox="${vx} ${vy} ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="10"/>`,
    spokes.join(""),
    rings.join(""),
    tickLabels.join(""),
    rays.join(""),
    markers.join(""),
    catLabels.join(""),
    note.join(""),
    "</svg>",
  ]);
}
