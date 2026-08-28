// Venn / set-overlap diagram: 2 or 3 equal circles with labelled regions.
// Overlap is the whole point here, so every circle is a `<circle class="mark
// ...">` - `nonRectMarks` in shape-scan.mjs deliberately keeps circle marks
// out of the node-overlap check (a radar's series polygons get the same
// exemption, for the same reason: this shape is SUPPOSED to sit on top of its
// neighbours, not stay clear of them).
//
// A region's label point is not a solved circular-segment centroid - for the
// one symmetric layout this renders (equal radii, evenly spaced centers), a
// good approximation is reached by walking outward from the diagram's own
// centre of symmetry along that region's own axis: the same direction its
// member circles' centers already sit on. `test/diagram-venn.test.mjs` checks
// the approximation empirically, confirming every region label lands well
// inside every set it names and well outside every set it doesn't.

import { polarPoint } from "./scale.mjs";
import { assemble, esc, snap, NAME_CH, MONO_CH } from "./text.mjs";

/**
 * @typedef {Object} VennSet
 * @property {string} label
 * @property {boolean} [focal]
 */

/**
 * @typedef {Object} VennRegion
 * @property {number[]} sets indices into `sets` naming which sets overlap here
 * @property {string} label
 */

/**
 * @typedef {Object} VennSpec
 * @property {"venn"} kind
 * @property {string} id
 * @property {string} title
 * @property {VennSet[]} sets exactly 2 or 3 sets
 * @property {VennRegion[]} [regions] one entry per combination worth naming
 */

const R = 150;
const LABEL_GAP = 18;
// Fraction of R a region label sits from the diagram's own centre of
// symmetry: an exclusive (one-set) region sits out near its own circle's far
// edge, a shared region sits closer in, near the lens its members hold in
// common. Both are tuned (see the test) for the widest margin against every
// circle boundary, not just a passing one.
const SINGLE_FRACTION = 0.5;
const SHARED_FRACTION = 0.75;
const PAD = 16;

/**
 * Equal-radius circle centers, plus the angle (radians, clockwise from twelve
 * o'clock) each one sits at from the diagram's own centre of symmetry - the
 * same axis its exclusive region is drawn on.
 * @param {number} n
 * @returns {{ centers: {x: number, y: number}[], angles: number[] }}
 */
function circleLayout(n) {
  if (n === 2) {
    return {
      centers: [
        { x: -R / 2, y: 0 },
        { x: R / 2, y: 0 },
      ],
      angles: [Math.PI, 0],
    };
  }
  // Centers sit on a circle of radius R/sqrt(3), 120 degrees apart, which
  // makes every pair of centers exactly R apart: circles that pass through
  // each other's centers, the classic symmetric 3-set Venn.
  const pts = [0, 1, 2].map((i) => polarPoint(0, 0, R / Math.sqrt(3), i, 3));
  return { centers: pts.map((p) => ({ x: p.x, y: p.y })), angles: pts.map((p) => p.angle) };
}

/**
 * Circular mean of two angles, so a shared region's axis takes the SHORT arc
 * between its members instead of a naive `(a+b)/2` - which is wrong whenever
 * the two angles straddle the +-180 degree seam.
 * @param {number} a @param {number} b @returns {number}
 */
function meanAngle(a, b) {
  return Math.atan2(Math.sin(a) + Math.sin(b), Math.cos(a) + Math.cos(b));
}

/**
 * @param {number[]} sets sorted, unique indices into the set list
 * @param {number} n total set count
 * @param {{x: number, y: number}[]} centers
 * @param {number[]} angles
 * @returns {{x: number, y: number}}
 */
function regionPoint(sets, n, centers, angles) {
  if (sets.length === n) return { x: 0, y: 0 };
  if (sets.length === 1) {
    const i = sets[0];
    const a = angles[i];
    return {
      x: centers[i].x + Math.cos(a) * R * SINGLE_FRACTION,
      y: centers[i].y + Math.sin(a) * R * SINGLE_FRACTION,
    };
  }
  const a = meanAngle(angles[sets[0]], angles[sets[1]]);
  return { x: Math.cos(a) * R * SHARED_FRACTION, y: Math.sin(a) * R * SHARED_FRACTION };
}

/**
 * Render a Venn diagram: 2-3 overlapping circles with labelled regions.
 * @param {VennSpec} spec
 * @returns {string}
 */
export function renderVenn(spec) {
  const sets = spec.sets;
  const n = Array.isArray(sets) ? sets.length : 0;
  if (n !== 2 && n !== 3) {
    throw new Error(`a venn diagram needs 2 or 3 sets, got ${n} (4+ sets are unreadable)`);
  }
  const focalSets = sets.filter((s) => s.focal);
  if (focalSets.length > 1) {
    throw new Error(
      `a venn diagram allows one focal set, got ${focalSets.length}: ` +
        focalSets.map((s) => s.label).join(", "),
    );
  }

  const rawRegions = spec.regions ?? [];
  if (!Array.isArray(rawRegions)) throw new Error(`venn "${spec.id}" regions must be an array`);
  const seenCombos = new Set();
  const regions = rawRegions.map((region) => {
    const raw = region.sets;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > n) {
      throw new Error(`a venn region needs 1-${n} set indices, got ${JSON.stringify(raw)}`);
    }
    const idx = [...new Set(raw)].sort((a, b) => a - b);
    if (idx.length !== raw.length) {
      throw new Error(`a venn region lists a set index more than once: ${JSON.stringify(raw)}`);
    }
    for (const i of idx) {
      if (!Number.isInteger(i) || i < 0 || i >= n) {
        throw new Error(`a venn region references set index ${i}, but there are only ${n} sets`);
      }
    }
    const key = idx.join(",");
    if (seenCombos.has(key))
      throw new Error(`two regions both label the {${idx.join(", ")}} overlap`);
    seenCombos.add(key);
    if (typeof region.label !== "string" || region.label.trim() === "") {
      throw new Error(`the region for {${idx.join(", ")}} needs a non-empty label`);
    }
    return { sets: idx, label: region.label };
  });

  const { centers, angles } = circleLayout(n);

  /** @type {{x: number, y: number, w: number, h: number}[]} */
  const bboxes = [];
  /** @param {number} x @param {number} y @param {number} w @param {number} h */
  const track = (x, y, w, h) => bboxes.push({ x, y, w, h });

  let nonFocalIndex = 0;
  const setInfo = sets.map((s, i) => {
    const cls = s.focal ? "focal" : `s${(nonFocalIndex % 4) + 1}`;
    if (!s.focal) nonFocalIndex += 1;
    return { s, i, cls };
  });
  // Non-focal circles first, focal last, so its accent stroke is never buried
  // under a circle drawn on top of it.
  const drawOrder = [
    ...setInfo.filter((si) => si.cls !== "focal"),
    ...setInfo.filter((si) => si.cls === "focal"),
  ];

  /** @type {string[]} */
  const circles = [];
  for (const { i, cls } of drawOrder) {
    const x = Math.round(centers[i].x);
    const y = Math.round(centers[i].y);
    circles.push(`<circle class="mark ${cls}" cx="${x}" cy="${y}" r="${R}"/>`);
    track(x - R, y - R, R * 2, R * 2);
  }

  // Set names sit OUTSIDE their own circle, along the same axis its exclusive
  // region is built on, so they never cross a stroke and never compete with
  // an in-circle region count for the same patch of paper.
  /** @type {string[]} */
  const setLabels = [];
  sets.forEach((s, i) => {
    const a = angles[i];
    const x = Math.round(centers[i].x + Math.cos(a) * (R + LABEL_GAP));
    const y = Math.round(centers[i].y + Math.sin(a) * (R + LABEL_GAP));
    const dirX = Math.cos(a);
    const anchor = Math.abs(dirX) < 0.05 ? "middle" : dirX > 0 ? "start" : "end";
    const ty = anchor === "middle" ? (y < 0 ? y - 2 : y + 10) : y + 4;
    setLabels.push(
      `<text class="clab" x="${x}" y="${ty}" text-anchor="${anchor}">${esc(s.label)}</text>`,
    );
    const w = s.label.length * NAME_CH;
    const bx = anchor === "middle" ? x - w / 2 : anchor === "start" ? x : x - w;
    track(bx, ty - 9, w, 12);
  });

  /** @type {string[]} */
  const regionLabels = [];
  for (const region of regions) {
    const p = regionPoint(region.sets, n, centers, angles);
    const x = Math.round(p.x);
    const y = Math.round(p.y) + 3;
    regionLabels.push(
      `<text class="vlab" x="${x}" y="${y}" text-anchor="middle">${esc(region.label)}</text>`,
    );
    const w = region.label.length * MONO_CH;
    track(x - w / 2, y - 8, w, 10);
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
    circles.join(""),
    setLabels.join(""),
    regionLabels.join(""),
    "</svg>",
  ]);
}
