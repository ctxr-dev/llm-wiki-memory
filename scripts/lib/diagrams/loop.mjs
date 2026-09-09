// A cyclic flywheel: stages arranged in a ring, each handed off to the next by
// a curved arrow, with the last closing the circle back to the first.
//
// The ring connectors are cubic Beziers that bulge outward along the same
// circle the stages sit on, NOT true elliptical arcs (`A`): `validate.mjs`'s
// `pathPoints` only understands absolute M/H/V/Q/C commands (the same
// constraint `selfLoopPath` in `shapes.mjs` already lives under), so an `A`
// command would render fine but be invisible to every edge-based geometry
// check. A control point pushed radially outward at each endpoint's own angle
// approximates the circle closely enough at these arc lengths without solving
// true circle/box intersections.

import { assemble, esc, snap, wrap, NAME_CH, MONO_CH } from "./text.mjs";
import { polarPoint } from "./scale.mjs";
import { markers, markerFor, edgeClass } from "./parts.mjs";

/**
 * @typedef {Object} LoopStage
 * @property {string} label
 * @property {string} [sub]
 * @property {boolean} [focal]
 */

/**
 * @typedef {Object} LoopSpec
 * @property {"loop"} kind
 * @property {string} [id]
 * @property {string} title
 * @property {LoopStage[]} stages
 */

const R = 240;
const STAGE_W = 160;
const STAGE_H_MIN = 64;
const BULGE = 30;
// Past a stage's own half-width, so the ring arrow's endpoint clears the box
// at every ring position: a station straight above or below the hub-less
// center moves almost entirely SIDEWAYS for a small angular step (its width
// governs clearance there), while one at the side moves almost entirely
// vertically (its height governs clearance there). Using the half-WIDTH
// against the radius is the conservative bound that covers both.
const ARROW_BUFFER = 8;
const PAD = 44;

/**
 * Render a cyclic flywheel to inline SVG: N stages in a ring, each feeding the
 * next, closing back to the first.
 * @param {LoopSpec} spec
 * @returns {string}
 */
export function renderLoop(spec) {
  const id = spec.id ?? "loop";
  const stages = spec.stages ?? [];
  const n = stages.length;
  if (n < 3 || n > 6) {
    throw new Error(`a loop needs 3-6 stages, got ${n}`);
  }
  const focal = stages.filter((s) => s.focal);
  if (focal.length > 1) {
    throw new Error(
      `a loop allows one focal stage, got ${focal.length}: ${focal.map((s) => s.label).join(", ")}`,
    );
  }

  // Every stage shares one box height — the tallest wrapped label/sub in the
  // ring — so the ring reads as N equal stations rather than N boxes each
  // sized to their own text.
  const measured = stages.map((stage) => {
    const lines = wrap(stage.label, Math.floor((STAGE_W - 24) / NAME_CH));
    const subLines = stage.sub ? wrap(stage.sub, Math.floor((STAGE_W - 24) / MONO_CH)) : [];
    return { stage, lines, subLines };
  });
  const stageH = Math.max(
    STAGE_H_MIN,
    ...measured.map(({ lines, subLines }) =>
      snap(24 + lines.length * 15 + (subLines.length ? subLines.length * 11 + 4 : 0)),
    ),
  );

  /**
   * Where along the ring an arc may start or end so it clears its own stage box.
   *
   * Solved on the RING, not along the tangent. Measuring the box's tangential
   * exit distance and converting it to an angle is the obvious approach and it
   * is only valid while that angle stays small: the ring curves back toward the
   * box, so a large clearance lands the endpoint back INSIDE it. That is a
   * content-independent bug, and it bit at exactly n=5 (n=3, 4 and 6 were clean),
   * where the arc between the two bottom stages began and ended inside them.
   *
   * Walking outward until the ring point actually leaves the box, expanded by
   * ARROW_BUFFER, holds for every stage count and every box size. Each direction
   * is solved separately because a box is only symmetric about its own radius,
   * not about the two arcs that meet it.
   * @param {number} index stage index
   * @param {1 | -1} dir +1 to leave the box, -1 to approach it
   * @returns {number} clearance in index units
   */
  const clearFrac = (index, dir) => {
    const c = polarPoint(0, 0, R, index, n);
    const halfW = STAGE_W / 2 + ARROW_BUFFER;
    const halfH = stageH / 2 + ARROW_BUFFER;
    for (let d = 0.01; d <= 0.45; d += 0.01) {
      const p = polarPoint(0, 0, R, index + dir * d, n);
      if (Math.abs(p.x - c.x) > halfW || Math.abs(p.y - c.y) > halfH) return d;
    }
    // A ring this crowded cannot clear the box at all; half a step at least
    // keeps the arc from doubling back across its neighbour.
    return 0.45;
  };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  /** @param {number} x @param {number} y */
  const track = (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  /** @type {string[]} */
  const arcs = [];
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const from = i + clearFrac(i, 1);
    const to = j - clearFrac(j, -1);
    const p0 = polarPoint(0, 0, R, from, n);
    const p1 = polarPoint(0, 0, R, to, n);
    const c0 = polarPoint(0, 0, R + BULGE, from, n);
    const c1 = polarPoint(0, 0, R + BULGE, to, n);
    for (const p of [p0, c0, c1, p1]) track(p.x, p.y);
    const d =
      `M${Math.round(p0.x)},${Math.round(p0.y)} ` +
      `C${Math.round(c0.x)},${Math.round(c0.y)} ${Math.round(c1.x)},${Math.round(c1.y)} ` +
      `${Math.round(p1.x)},${Math.round(p1.y)}`;
    arcs.push(
      `<path class="${edgeClass("sync")}" d="${d}" marker-end="url(#${markerFor(id, "sync")})"/>`,
    );
  }

  /** @type {string[]} */
  const boxes = [];
  measured.forEach(({ stage, lines, subLines }, i) => {
    const center = polarPoint(0, 0, R, i, n);
    const x = center.x - STAGE_W / 2;
    const y = center.y - stageH / 2;
    track(x, y);
    track(x + STAGE_W, y + stageH);
    const cx = Math.round(center.x);
    const textTop = y + (stageH - (lines.length * 14 + subLines.length * 11)) / 2 + 11;
    const cls = stage.focal ? "nb focal" : "nb";
    const name = lines
      .map((l, k) => `<tspan x="${cx}" dy="${k === 0 ? 0 : 14}">${esc(l)}</tspan>`)
      .join("");
    const sub = subLines
      .map((l, k) => `<tspan x="${cx}" dy="${k === 0 ? 0 : 11}">${esc(l)}</tspan>`)
      .join("");
    boxes.push(
      `<rect class="${cls}" x="${Math.round(x)}" y="${Math.round(y)}" width="${STAGE_W}" height="${stageH}" rx="6"/>` +
        `<text class="nn" x="${cx}" y="${Math.round(textTop)}" text-anchor="middle">${name}</text>` +
        (sub
          ? `<text class="ns" x="${cx}" y="${Math.round(textTop + (lines.length - 1) * 14 + 12)}" text-anchor="middle">${sub}</text>`
          : ""),
    );
  });

  const vx = snap(minX - PAD);
  const vy = snap(minY - PAD);
  const vw = snap(maxX + PAD - vx);
  const vh = snap(maxY + PAD - vy);

  return assemble([
    `<svg viewBox="${vx} ${vy} ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    markers(id),
    `<rect class="bg" x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="10"/>`,
    arcs.join(""),
    boxes.join(""),
    "</svg>",
  ]);
}
