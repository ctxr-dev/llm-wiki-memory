// Edge routing: the path shapes a run can take between two boxes, and the
// clearance decisions that keep a run from crossing something it does not
// connect. Split from `geometry.mjs` so neither file outgrows the size gate.

/** @typedef {import("./types.mjs").Box} Box */
/** @typedef {import("./types.mjs").Geom} Geom */
/** @typedef {import("./types.mjs").Rect} Rect */

/**
 * Horizontal-first elbow: out sideways, across at the midpoint, then in.
 * @param {number} sx @param {number} sy @param {number} tx @param {number} ty @param {number} [r]
 * @returns {string}
 */
export function elbow(sx, sy, tx, ty, r = 8) {
  if (Math.abs(sy - ty) < 1) return `M${sx},${sy} H${tx}`;
  if (Math.abs(sx - tx) < 1) return `M${sx},${sy} V${ty}`;
  const mid = (sx + tx) / 2;
  const xs = Math.sign(tx - sx);
  const ys = Math.sign(ty - sy);
  const rr = Math.min(r, Math.abs(tx - sx) / 2, Math.abs(ty - sy) / 2);
  return [
    `M${sx},${sy}`,
    `H${mid - rr * xs}`,
    `Q${mid},${sy} ${mid},${sy + rr * ys}`,
    `V${ty - rr * ys}`,
    `Q${mid},${ty} ${mid + rr * xs},${ty}`,
    `H${tx}`,
  ].join(" ");
}

/**
 * Vertical-first elbow, for a top-down run.
 * @param {number} sx @param {number} sy @param {number} tx @param {number} ty @param {number} [r]
 * @returns {string}
 */
export function elbowV(sx, sy, tx, ty, r = 8) {
  if (Math.abs(sx - tx) < 1) return `M${sx},${sy} V${ty}`;
  const mid = (sy + ty) / 2;
  const xs = Math.sign(tx - sx);
  const ys = Math.sign(ty - sy);
  const rr = Math.min(r, Math.abs(tx - sx) / 2, Math.abs(ty - sy) / 2);
  return [
    `M${sx},${sy}`,
    `V${mid - rr * ys}`,
    `Q${sx},${mid} ${sx + rr * xs},${mid}`,
    `H${tx - rr * xs}`,
    `Q${tx},${mid} ${tx},${mid + rr * ys}`,
    `V${ty}`,
  ].join(" ");
}

/**
 * Route out of the top or bottom of both boxes and across a horizontal lane, so
 * a long-range edge does not cut through the rows between its endpoints.
 *
 * `exitX` / `entryX` handle the case the lane alone does not: when another box
 * sits DIRECTLY below (or above) an endpoint, the descent to the lane runs
 * straight through it even though the lane itself is clear. Passing a clear x
 * makes the run leave the box's edge, jog sideways, and only then descend. The
 * jog is 10 units so it reads as a deliberate step rather than a kink.
 * @param {Box} a @param {Box} b @param {number} y lane position
 * @param {boolean} up @param {number} [r]
 * @param {{ exitX?: number, entryX?: number }} [clear]
 * @returns {string}
 */
export function detour(a, b, y, up, r = 8, clear = {}) {
  const sy = up ? a.y : a.y + a.h;
  const ty = up ? b.y : b.y + b.h;
  const sx = clear.exitX ?? a.cx;
  const tx = clear.entryX ?? b.cx;
  const xs = Math.sign(tx - sx) || 1;
  const vs = up ? -1 : 1;
  /** @type {string[]} */
  const parts = [`M${a.cx},${sy}`];
  if (sx !== a.cx) parts.push(`V${sy + 10 * vs}`, `H${sx}`);
  parts.push(
    `V${y - r * vs}`,
    `Q${sx},${y} ${sx + r * xs},${y}`,
    `H${tx - r * xs}`,
    `Q${tx},${y} ${tx},${y - r * vs}`,
  );
  if (tx !== b.cx) parts.push(`V${ty + 10 * vs}`, `H${b.cx}`);
  parts.push(`V${ty}`);
  return parts.join(" ");
}

/**
 * An x from which a vertical run between `y0` and `y1` clears every blocker:
 * the box's own centre when that is already clear, else a point just outside
 * whichever side is free.
 * @param {Box} box @param {Box[]} blockers @param {number} y0 @param {number} y1
 * @returns {number}
 */
export function clearExitX(box, blockers, y0, y1) {
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  /** @param {number} x @returns {boolean} */
  const free = (x) =>
    !blockers.some((o) => x > o.x - 2 && x < o.x + o.w + 2 && bottom > o.y && top < o.y + o.h);
  for (const x of [box.cx, box.x + 14, box.x + box.w - 14, box.x - 14, box.x + box.w + 14]) {
    if (free(x)) return x;
  }
  return box.cx;
}

/**
 * The same idea rotated: out of the sides and along a vertical lane.
 * @param {Box} a @param {Box} b @param {number} x lane position
 * @param {boolean} left @param {number} [r]
 * @returns {string}
 */
export function sideDetour(a, b, x, left, r = 8) {
  const sx = left ? a.x : a.x + a.w;
  const tx = left ? b.x : b.x + b.w;
  const sy = a.cy;
  const ty = b.cy;
  const ys = Math.sign(ty - sy) || 1;
  const k = left ? 1 : -1;
  return [
    `M${sx},${sy}`,
    `H${x + r * k}`,
    `Q${x},${sy} ${x},${sy + r * ys}`,
    `V${ty - r * ys}`,
    `Q${x},${ty} ${x + r * k},${ty}`,
    `H${tx}`,
  ].join(" ");
}

/**
 * Does an axis-aligned run from (sx,sy) to (tx,ty), via the elbow midpoint,
 * pass through `box`? Sampled along the three legs, which is enough because
 * every run this renderer emits is axis-aligned with rounded corners.
 * @param {import("./types.mjs").Geom} geom @param {"v" | "h" | "left"} side
 * @param {Rect} box @param {number} [inset]
 * @returns {boolean}
 */
export function runCrosses(geom, side, box, inset = 6) {
  const x1 = box.x + inset;
  const y1 = box.y + inset;
  const x2 = box.x + box.w - inset;
  const y2 = box.y + box.h - inset;
  if (x2 <= x1 || y2 <= y1) return false;
  const mid = side === "v" ? (geom.sy + geom.ty) / 2 : (geom.sx + geom.tx) / 2;
  /** @type {[number, number][]} */
  const legs =
    side === "v"
      ? [
          [geom.sx, geom.sy],
          [geom.sx, mid],
          [geom.tx, mid],
          [geom.tx, geom.ty],
        ]
      : [
          [geom.sx, geom.sy],
          [mid, geom.sy],
          [mid, geom.ty],
          [geom.tx, geom.ty],
        ];
  for (let i = 1; i < legs.length; i += 1) {
    const [ax, ay] = legs[i - 1];
    const [bx, by] = legs[i];
    const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 3));
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const px = ax + (bx - ax) * t;
      const py = ay + (by - ay) * t;
      if (px > x1 && px < x2 && py > y1 && py < y2) return true;
    }
  }
  return false;
}
