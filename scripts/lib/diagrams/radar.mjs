// Radar / spider chart: N quantitative axes on one 0..max scale, compared as
// closed polygons. Every position comes from `polarPoint` in `scale.mjs` — the
// only radial math this file owns is choosing which radius and angle to feed it.
//
// The shared `.ser` class renders `fill:none` (it is built for line charts), so
// a radar series here is an outline polygon, not the translucent-fill area a
// generic radar usually draws. That is a deliberate consequence of reusing the
// house style rather than inventing a filled variant.

import { polarPoint, formatTick } from "./scale.mjs";
import { assemble, esc, snap, NAME_CH, MONO_CH } from "./text.mjs";

/**
 * @typedef {Object} RadarSeries
 * @property {string} label
 * @property {number[]} values one per axis, in `0..max`
 * @property {boolean} [focal]
 */

/**
 * @typedef {Object} RadarSpec
 * @property {"radar"} kind
 * @property {string} id
 * @property {string} title
 * @property {string[]} axes 3..8 axis names, first axis drawn at twelve o'clock
 * @property {RadarSeries[]} series
 * @property {number} max the scale ceiling every axis and series is normalized to
 */

const R = 160;
const LABEL_GAP = 16;
const RING_FRACTIONS = [0.2, 0.4, 0.6, 0.8, 1.0];
const DOT = 4;
const PAD = 16;

/**
 * @param {{x: number, y: number, w: number, h: number}[]} bboxes
 * @param {number} x @param {number} y @param {number} w @param {number} h
 */
function track(bboxes, x, y, w, h) {
  bboxes.push({ x, y, w, h });
}

/**
 * Render a radar chart: concentric grid, one spoke per axis, one outline
 * polygon per series, and vertex dots on whichever series is meant to carry
 * the reader's attention.
 * @param {RadarSpec} spec
 * @returns {string}
 */
export function renderRadar(spec) {
  const axesNames = spec.axes;
  const axisCount = Array.isArray(axesNames) ? axesNames.length : 0;
  if (!Array.isArray(axesNames) || axisCount < 3 || axisCount > 8) {
    throw new Error(`a radar chart needs 3-8 axes, got ${axisCount}`);
  }
  const N = axisCount;

  const series = spec.series;
  if (!Array.isArray(series) || series.length === 0) {
    throw new Error("a radar chart needs at least one series");
  }

  const max = spec.max;
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error(`a radar chart needs a positive finite max, got ${max}`);
  }

  for (const s of series) {
    if (!Array.isArray(s.values) || s.values.length !== N) {
      throw new Error(
        `series "${s.label}" has ${s.values?.length ?? 0} values, expected ${N} (one per axis)`,
      );
    }
    s.values.forEach((v, i) => {
      if (!Number.isFinite(v) || v < 0 || v > max) {
        throw new Error(
          `series "${s.label}" axis "${axesNames[i]}" has value ${v}, expected 0..${max}`,
        );
      }
    });
  }

  const focalSeries = series.filter((s) => s.focal);
  if (focalSeries.length > 1) {
    throw new Error(
      `a radar chart allows one focal series, got ${focalSeries.length}: ${focalSeries
        .map((s) => s.label)
        .join(", ")}`,
    );
  }
  const nonFocalCount = series.length - focalSeries.length;
  if (nonFocalCount > 4) {
    throw new Error(
      `a radar chart supports at most 4 non-focal series (plus one optional focal); got ${nonFocalCount}`,
    );
  }

  /** @param {number} radius @param {number} i @returns {{x: number, y: number, angle: number}} */
  const pt = (radius, i) => polarPoint(0, 0, radius, i, N);

  /** @type {{x: number, y: number, w: number, h: number}[]} */
  const bboxes = [];
  // Only the outer ring's own vertices bound the drawn content — a polygon
  // touches its circumscribed circle at N points, not everywhere on it.
  for (let i = 0; i < N; i += 1) {
    const p = pt(R, i);
    track(bboxes, p.x, p.y, 0, 0);
  }

  /** @type {string[]} */
  const grid = [];
  for (const frac of RING_FRACTIONS) {
    const ringPts = Array.from({ length: N }, (_, i) => pt(R * frac, i))
      .map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)
      .join(" ");
    grid.push(`<polygon class="grid" points="${ringPts}"/>`);
  }
  for (let i = 0; i < N; i += 1) {
    const p = pt(R, i);
    grid.push(`<line class="grid" x1="0" y1="0" x2="${Math.round(p.x)}" y2="${Math.round(p.y)}"/>`);
  }

  // Axis labels sit outside the outer ring along their own spoke. The anchor
  // follows the spoke's side so the label grows AWAY from the polygon: middle
  // for the (near-)vertical top/bottom spokes, start on the right half, end on
  // the left half.
  /** @type {string[]} */
  const labels = [];
  axesNames.forEach((name, i) => {
    const p = pt(R + LABEL_GAP, i);
    const anchor = Math.abs(p.x) < 1 ? "middle" : p.x > 0 ? "start" : "end";
    const ty = anchor === "middle" ? (p.y < 0 ? p.y - 2 : p.y + 10) : p.y + 4;
    const tx = Math.round(p.x);
    const roundedTy = Math.round(ty);
    labels.push(
      `<text class="clab" x="${tx}" y="${roundedTy}" text-anchor="${anchor}">${esc(String(name))}</text>`,
    );
    const w = String(name).length * NAME_CH;
    const bx = anchor === "start" ? tx : anchor === "end" ? tx - w : tx - w / 2;
    track(bboxes, bx, roundedTy - 9, w, 12);
  });

  // Scale numbers live only on the top axis (index 0, always straight up):
  // every spoke shares the same 0..max scale, so repeating the numbers on
  // every spoke would add clutter without adding information.
  /** @type {string[]} */
  const ticks = [];
  const step = max / RING_FRACTIONS.length;
  for (const frac of RING_FRACTIONS) {
    const ty = -frac * R;
    const label = formatTick(frac * max, step);
    const roundedTy = Math.round(ty) + 3;
    ticks.push(`<text class="tick" x="-6" y="${roundedTy}" text-anchor="end">${esc(label)}</text>`);
    track(bboxes, -6 - label.length * MONO_CH, roundedTy - 8, label.length * MONO_CH, 10);
  }

  let nonFocalIndex = 0;
  const seriesInfo = series.map((s) => {
    if (s.focal) return { s, cls: "focal" };
    const cls = `s${(nonFocalIndex % 4) + 1}`;
    nonFocalIndex += 1;
    return { s, cls };
  });
  // Non-focal first, focal last, so the series a reader should look at is
  // drawn on top of the rest rather than potentially hidden beneath them.
  const drawOrder = [
    ...seriesInfo.filter((si) => si.cls !== "focal"),
    ...seriesInfo.filter((si) => si.cls === "focal"),
  ];

  /** @type {string[]} */
  const polygons = [];
  for (const { s, cls } of drawOrder) {
    const pts = s.values
      .map((v, i) => pt((v / max) * R, i))
      .map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)
      .join(" ");
    polygons.push(`<polygon class="ser ${cls}" points="${pts}"/>`);
  }

  // Vertex dots are the readability rule that keeps a multi-series radar from
  // becoming a bead curtain: only the series the reader is meant to focus on
  // carries them. A lone series has nothing to be confused with, so it earns
  // dots too rather than rendering with no marks at all.
  const dotted = focalSeries.length === 1 ? focalSeries[0] : series.length === 1 ? series[0] : null;
  /** @type {string[]} */
  const dots = [];
  if (dotted) {
    const dottedCls = seriesInfo.find((si) => si.s === dotted)?.cls ?? "focal";
    dotted.values.forEach((v, i) => {
      const p = pt((v / max) * R, i);
      const x = Math.round(p.x - DOT);
      const y = Math.round(p.y - DOT);
      dots.push(
        `<rect class="mark ${dottedCls}" x="${x}" y="${y}" width="${DOT * 2}" height="${DOT * 2}" rx="2"/>`,
      );
      track(bboxes, x, y, DOT * 2, DOT * 2);
    });
  }

  /** @type {string[]} */
  const legendParts = [];
  if (series.length > 1) {
    const gap = 18;
    const swatchW = 16;
    const widths = seriesInfo.map(({ s }) => swatchW + 6 + s.label.length * MONO_CH + gap);
    const total = widths.reduce((a, b) => a + b, 0) - gap;
    let cursor = -total / 2;
    const ly = R + LABEL_GAP + 44;
    seriesInfo.forEach(({ s, cls }, i) => {
      const swatchX = Math.round(cursor);
      legendParts.push(
        `<rect class="swatch ${cls}" x="${swatchX}" y="${ly - 7}" width="${swatchW}" height="8" rx="2"/>`,
        `<text class="tick" x="${swatchX + swatchW + 6}" y="${ly}">${esc(s.label)}</text>`,
      );
      track(bboxes, swatchX, ly - 10, widths[i], 14);
      cursor += widths[i];
    });
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of bboxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }

  const vx = snap(minX - PAD);
  const vy = snap(minY - PAD);
  const vw = snap(maxX + PAD - vx);
  const vh = snap(maxY + PAD - vy);

  return assemble([
    `<svg viewBox="${vx} ${vy} ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="10"/>`,
    grid.join(""),
    labels.join(""),
    ticks.join(""),
    polygons.join(""),
    dots.join(""),
    legendParts.join(""),
    "</svg>",
  ]);
}
