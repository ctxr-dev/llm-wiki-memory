// Geometric self-check on rendered SVG: the mechanical half of "is this diagram
// legible". It reads the OUTPUT, not the spec, so it applies to every diagram
// kind including ones whose layout code it knows nothing about.
//
// Why parse our own markup rather than inspect layout state: a renderer bug that
// emits geometry differing from what it computed is exactly the class of defect
// worth catching, and every kind emits the same small vocabulary of elements. It
// also means a new diagram type gets these checks for free.
//
// This does not replace looking at the diagram. It catches the failures a reader
// notices instantly and an author misses (a label sitting on a box, a run cutting
// through an unrelated node, content clipped outside the viewBox), so the visual
// pass can be spent on judgement instead of on inspection.

/** @typedef {import("./types.mjs").Rect} Rect */
import { rectsOfClass, nonRectMarks } from "./shape-scan.mjs";

/**
 * @typedef {Object} Finding
 * @property {"label-over-node" | "label-over-label" | "node-overlap" | "edge-through-node" | "label-adrift" | "zone-overlap" | "clipped" | "empty"} kind
 * @property {string} detail
 */

/** @param {Rect} a @param {Rect} b @param {number} tol @returns {number} */
function overlapArea(a, b, tol) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) - tol;
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) - tol;
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Extract the polyline of an emitted path. Our renderers produce absolute `M`,
 * `H`, `V`, `Q` and `C` commands only.
 *
 * `Q` corners are tiny rounded elbows, so their end point is a sound stand-in.
 * `C` is NOT: a loop arc bulges far outside the straight line between its ends,
 * and it must be handled at all, because omitting the command once made
 * self-transition runs invisible here and a loop's own label was measured
 * against a different edge and reported adrift by 163 units.
 *
 * But its CONTROL POINTS are not on the curve, and treating them as if they were
 * is worse than ignoring the command: a strongly bulged arc then appears to
 * travel through territory it never enters. That produced two phantom
 * `edge-through-node` findings on a five-stage loop whose arcs were, in fact,
 * perfectly clear. So the curve is SAMPLED.
 * @param {string} d
 * @returns {{ x: number, y: number }[]}
 */
function pathPoints(d) {
  /** @type {{ x: number, y: number }[]} */
  const pts = [];
  let x = 0;
  let y = 0;
  for (const m of d.matchAll(/([MHVQC])\s*([-\d.,\s]*)/g)) {
    const cmd = m[1];
    const nums = (m[2].match(/-?[\d.]+/g) ?? []).map(Number);
    if (cmd === "M" && nums.length >= 2) {
      [x, y] = [nums[0], nums[1]];
    } else if (cmd === "H" && nums.length >= 1) {
      x = nums[nums.length - 1];
    } else if (cmd === "V" && nums.length >= 1) {
      y = nums[nums.length - 1];
    } else if (cmd === "Q" && nums.length >= 4) {
      [x, y] = [nums[2], nums[3]];
    } else if (cmd === "C" && nums.length >= 6) {
      const [c1x, c1y, c2x, c2y, ex, ey] = nums;
      const steps = 16;
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const u = 1 - t;
        pts.push({
          x: u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex,
          y: u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey,
        });
      }
      x = ex;
      y = ey;
      continue;
    } else {
      continue;
    }
    pts.push({ x, y });
  }
  return pts;
}

/**
 * Does the segment a->b pass through rect r? Sampled rather than solved: the
 * segments are axis-aligned or short corner hops, and sampling avoids a
 * clipping algorithm whose edge cases would need their own tests.
 * @param {{x:number,y:number}} a @param {{x:number,y:number}} b @param {Rect} r @param {number} inset
 * @returns {boolean}
 */
function segmentEntersRect(a, b, r, inset) {
  const x1 = r.x + inset;
  const y1 = r.y + inset;
  const x2 = r.x + r.w - inset;
  const y2 = r.y + r.h - inset;
  if (x2 <= x1 || y2 <= y1) return false;
  const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 3));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    if (px > x1 && px < x2 && py > y1 && py < y2) return true;
  }
  return false;
}

/**
 * Inspect a rendered `<svg>` string for legibility defects.
 *
 * Tolerances are deliberate, not sloppy: label masks are drawn slightly larger
 * than their text and boxes touch their own borders, so a couple of units of
 * contact is normal and only a real intrusion should be reported.
 * @param {string} svg the inline svg element, as returned by `draw`
 * @param {{ labelTolerance?: number, nodeTolerance?: number, edgeInset?: number }} [opts]
 * @returns {Finding[]}
 */
export function validateSvg(svg, opts = {}) {
  const labelTolerance = opts.labelTolerance ?? 2;
  const nodeTolerance = opts.nodeTolerance ?? 1;
  // Edges legitimately touch the border of the boxes they connect, so only count
  // an intrusion well inside a box as passing THROUGH it.
  const edgeInset = opts.edgeInset ?? 6;

  /** @type {Finding[]} */
  const findings = [];
  // Every diagram kind draws its primary shape with one of these classes. A new
  // kind that invents another is INVISIBLE to every check below and will report
  // clean while being broken — that already happened once, when layer bands were
  // added and scored as an empty diagram. `mark` covers the chart marks (bars,
  // points, wedges).
  const nodes = [
    ...rectsOfClass(svg, "nb"),
    ...rectsOfClass(svg, "lay"),
    ...rectsOfClass(svg, "mark"),
  ];
  // Circles and polygons count as CONTENT (so a circle-only chart is not "empty",
  // and a mark outside the frame is still caught) but are kept out of the
  // overlap check, where a Venn's circles and a radar's polygons overlap by
  // design. See `nonRectMarks`.
  const roundMarks = nonRectMarks(svg, "mark");
  const labels = rectsOfClass(svg, "emask");

  // Zone frames are BACKDROPS, so they are excluded from the node checks above.
  // That exclusion has a cost: two frames overlapping each other is invisible to
  // every other check, and it looks broken — the lower frame's edge and label
  // land on top of the upper zone's contents. Nesting one zone fully inside
  // another is legitimate containment, so only PARTIAL overlap is reported.
  const zones = rectsOfClass(svg, "zone");
  for (let i = 0; i < zones.length; i += 1) {
    for (let j = i + 1; j < zones.length; j += 1) {
      const a = zones[i];
      const b = zones[j];
      if (overlapArea(a, b, 1) === 0) continue;
      const contains = (/** @type {Rect} */ o, /** @type {Rect} */ inner) =>
        inner.x >= o.x - 1 &&
        inner.y >= o.y - 1 &&
        inner.x + inner.w <= o.x + o.w + 1 &&
        inner.y + inner.h <= o.y + o.h + 1;
      if (contains(a, b) || contains(b, a)) continue;
      findings.push({
        kind: "zone-overlap",
        detail: `zone frames at (${a.x.toFixed(0)},${a.y.toFixed(0)}) and (${b.x.toFixed(0)},${b.y.toFixed(0)}) partially overlap`,
      });
    }
  }

  if (nodes.length === 0 && roundMarks.length === 0) {
    findings.push({ kind: "empty", detail: "no node, band or mark shapes were emitted" });
  }

  for (const label of labels) {
    for (const node of nodes) {
      const area = overlapArea(label, node, labelTolerance);
      if (area > 0) {
        findings.push({
          kind: "label-over-node",
          detail: `label at (${label.x.toFixed(0)},${label.y.toFixed(0)}) overlaps a node by ${area.toFixed(0)} sq units`,
        });
      }
    }
  }

  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const area = overlapArea(labels[i], labels[j], labelTolerance);
      if (area > 0) {
        findings.push({
          kind: "label-over-label",
          detail: `labels at (${labels[i].x.toFixed(0)},${labels[i].y.toFixed(0)}) and (${labels[j].x.toFixed(0)},${labels[j].y.toFixed(0)}) overlap by ${area.toFixed(0)} sq units`,
        });
      }
    }
  }

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const area = overlapArea(nodes[i], nodes[j], nodeTolerance);
      if (area > 0) {
        findings.push({
          kind: "node-overlap",
          detail: `nodes at (${nodes[i].x.toFixed(0)},${nodes[i].y.toFixed(0)}) and (${nodes[j].x.toFixed(0)},${nodes[j].y.toFixed(0)}) overlap by ${area.toFixed(0)} sq units`,
        });
      }
    }
  }

  for (const m of svg.matchAll(/<path\b[^>]*class="e[^"]*"[^>]*\bd="([^"]+)"/g)) {
    const pts = pathPoints(m[1]);
    if (pts.length < 2) continue;
    const first = pts[0];
    const last = pts[pts.length - 1];
    for (const node of nodes) {
      // A run starts and ends ON its endpoints' borders; skip those two boxes.
      const isEndpoint =
        segmentEntersRect(first, first, node, -edgeInset) ||
        segmentEntersRect(last, last, node, -edgeInset);
      if (isEndpoint) continue;
      for (let i = 1; i < pts.length; i += 1) {
        if (segmentEntersRect(pts[i - 1], pts[i], node, edgeInset)) {
          findings.push({
            kind: "edge-through-node",
            detail: `an edge run passes through the node at (${node.x.toFixed(0)},${node.y.toFixed(0)})`,
          });
          break;
        }
      }
    }
  }

  // A label far from every run is the failure the eye catches instantly and an
  // overlap check never will: it is perfectly placed by the only rule collision
  // avoidance knows about, and completely useless to a reader who cannot tell
  // which edge it describes. Measured against the nearest run because the output
  // carries no label-to-edge association.
  const runs = [...svg.matchAll(/<path\b[^>]*class="e[^"]*"[^>]*\bd="([^"]+)"/g)].map((m) =>
    pathPoints(m[1]),
  );
  if (runs.length > 0) {
    for (const label of labels) {
      const lx = label.x + label.w / 2;
      const ly = label.y + label.h / 2;
      let nearest = Infinity;
      for (const pts of runs) {
        for (let i = 1; i < pts.length; i += 1) {
          const a = pts[i - 1];
          const b = pts[i];
          const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 6));
          for (let s = 0; s <= steps; s += 1) {
            const t = s / steps;
            const d = Math.hypot(a.x + (b.x - a.x) * t - lx, a.y + (b.y - a.y) * t - ly);
            if (d < nearest) nearest = d;
          }
        }
      }
      // Half the label's own diagonal is "touching its run"; the allowance past
      // that is roughly one placement step.
      const allowed = Math.hypot(label.w, label.h) / 2 + 40;
      if (nearest > allowed) {
        findings.push({
          kind: "label-adrift",
          detail: `label at (${label.x.toFixed(0)},${label.y.toFixed(0)}) sits ${nearest.toFixed(0)} units from the nearest run (allowed ${allowed.toFixed(0)})`,
        });
      }
    }
  }

  const view = /viewBox="(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)"/.exec(svg);
  if (view) {
    const [vx, vy, vw, vh] = view.slice(1).map(Number);
    for (const r of [...nodes, ...roundMarks, ...labels]) {
      if (r.x < vx - 1 || r.y < vy - 1 || r.x + r.w > vx + vw + 1 || r.y + r.h > vy + vh + 1) {
        findings.push({
          kind: "clipped",
          detail: `content at (${r.x.toFixed(0)},${r.y.toFixed(0)}) ${r.w.toFixed(0)}x${r.h.toFixed(0)} falls outside the viewBox`,
        });
      }
    }
  }

  return findings;
}
