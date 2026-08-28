import { MONO_CH, NAME_CH, assemble, esc, snap, wrap } from "./text.mjs";
import { ports } from "./geometry.mjs";
import { clearExitX, detour, elbow, elbowV, runCrosses, sideDetour } from "./routing.mjs";
import { edgeClass, edgeLabel, markerFor, markers, renderNode } from "./parts.mjs";

/** @typedef {import("./types.mjs").Box} Box */
/** @typedef {import("./types.mjs").EdgeKind} EdgeKind */
/** @typedef {import("./types.mjs").NodeKind} NodeKind */
/** @typedef {import("./types.mjs").Rect} Rect */

/**
 * @typedef {Object} SwimlaneLane
 * @property {string} id
 * @property {string} label
 */

/**
 * @typedef {Object} SwimlaneStep
 * @property {string} id used by edges to refer to this step
 * @property {string} lane lane id this step belongs to
 * @property {number} col 0-based column; steps sharing a col share an x
 * @property {string} label
 * @property {string} [sub] second line, rendered in the mono face
 * @property {NodeKind} [kind]
 */

/**
 * @typedef {Object} SwimlaneEdge
 * @property {string} from step id
 * @property {string} to step id
 * @property {string} [label]
 * @property {EdgeKind} [kind]
 */

/**
 * @typedef {Object} SwimlaneSpec
 * @property {"swimlane"} kind
 * @property {string} id unique per document; namespaces the arrowhead marker ids
 * @property {string} title becomes the SVG's aria-label
 * @property {SwimlaneLane[]} lanes ordered top to bottom
 * @property {SwimlaneStep[]} steps
 * @property {SwimlaneEdge[]} [edges]
 */

const BAND_X = 148;
const COL_W = 150;
const COL_GAP = 64;
const PAD_L = 22;
const PAD_R = 22;
const ROW_PAD = 16;
const MIN_LANE_H = 64;
const TOP = 24;
const GUTTER_TEXT_X = 14;
const SIDE_GAP = 26;
const FIT_PAD = 20;

/**
 * Render a swimlane diagram: horizontal lanes stacked top to bottom, steps
 * placed in a shared column grid across them, and edges that may cross lanes.
 *
 * Lane bands are `zone`-classed rather than `lay`-classed, even though a band
 * is exactly the "full-width band" the `lay` class exists for. `lay` joins
 * `nb` in the validator's `nodes` list, so it is checked for node-overlap
 * against every box inside it and for label-over-node against every label
 * inside it — but a step and its own edge labels live INSIDE their lane's
 * band by definition, so a `lay` band can never coexist with the content it
 * groups (confirmed empirically: a step box inside a `lay` band always
 * reports `node-overlap`). `zone` carries the same full-width visual language
 * without joining that check, which is what a backdrop grouping — as opposed
 * to a primary shape — needs. Dividers are explicit `hair` lines rather than
 * relying on the zone border, because the reference calls for a clearly
 * legible 1px hairline and zone's border is deliberately faint.
 * @param {SwimlaneSpec} spec
 * @returns {string}
 */
export function renderSwimlane(spec) {
  if (spec.lanes.length === 0) throw new Error("a swimlane needs at least one lane");
  const laneIds = new Set(spec.lanes.map((lane) => lane.id));
  for (const step of spec.steps) {
    if (!laneIds.has(step.lane)) throw new Error(`unknown lane ${step.lane} for step ${step.id}`);
  }

  const maxCol = spec.steps.length ? Math.max(...spec.steps.map((s) => s.col)) : 0;
  /** @param {number} col @returns {number} */
  const colX = (col) => BAND_X + PAD_L + col * (COL_W + COL_GAP);
  const contentW = PAD_L + (maxCol + 1) * COL_W + maxCol * COL_GAP + PAD_R;

  // Two passes, like `geometry.layout()`: a lane's box height depends on every
  // step in it, so nothing can be positioned until all of them are measured.
  /** @type {{ step: SwimlaneStep, lines: string[], subLines: string[], h: number }[][]} */
  const byLane = spec.lanes.map((lane) =>
    spec.steps
      .filter((step) => step.lane === lane.id)
      .map((step) => {
        const lines = wrap(step.label, Math.floor((COL_W - 18) / NAME_CH));
        const subLines = step.sub ? wrap(step.sub, Math.floor((COL_W - 20) / MONO_CH)) : [];
        const h = snap(16 + lines.length * 15 + (subLines.length ? subLines.length * 11 + 4 : 0));
        return { step, lines, subLines, h };
      }),
  );
  /** @type {number[]} */
  const boxH = byLane.map((entries) => (entries.length ? Math.max(...entries.map((e) => e.h)) : 0));
  // A lane with no steps still renders as a full band — "don't force equal
  // step count per lane" only excuses uneven CONTENT, not a missing row.
  /** @type {number[]} */
  const laneH = boxH.map((h) => Math.max(MIN_LANE_H, h + ROW_PAD * 2));
  /** @type {number[]} */
  const laneTop = [];
  let cursor = TOP;
  for (let i = 0; i < spec.lanes.length; i += 1) {
    laneTop.push(cursor);
    cursor += laneH[i];
  }

  /** @type {Map<string, Box>} */
  const boxes = new Map();
  byLane.forEach((entries, i) => {
    const cy = laneTop[i] + laneH[i] / 2;
    for (const { step, lines, subLines } of entries) {
      const x = colX(step.col);
      const h = boxH[i];
      const y = cy - h / 2;
      boxes.set(step.id, {
        node: {
          id: step.id,
          label: step.label,
          sub: step.sub,
          row: i,
          col: step.col,
          kind: step.kind,
          shape: "box",
        },
        lines,
        subLines,
        x,
        y,
        w: COL_W,
        h,
        cx: x + COL_W / 2,
        cy,
      });
    }
  });

  /** @type {Rect[]} */
  const occupied = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  /** @type {import("./types.mjs").Track} */
  const track = (x, y, w, h) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const box of boxes.values()) {
    track(box.x, box.y, box.w, box.h);
    occupied.push({ x: box.x, y: box.y, w: box.w, h: box.h });
  }

  const gutterChars = Math.floor((BAND_X - GUTTER_TEXT_X - 12) / MONO_CH);
  /** @type {string[]} */
  const bands = [];
  spec.lanes.forEach((lane, i) => {
    const by = laneTop[i];
    const bh = laneH[i];
    bands.push(`<rect class="zone" x="${BAND_X}" y="${by}" width="${contentW}" height="${bh}"/>`);
    if (i > 0) {
      bands.push(
        `<line class="hair" x1="${BAND_X}" y1="${by}" x2="${BAND_X + contentW}" y2="${by}"/>`,
      );
    }
    const lines = wrap(lane.label, gutterChars);
    const startY = by + bh / 2 - ((lines.length - 1) * 11) / 2 + 3;
    const tspans = lines
      .map(
        (line, k) =>
          `<tspan x="${GUTTER_TEXT_X}" dy="${k === 0 ? 0 : 11}">${esc(line.toUpperCase())}</tspan>`,
      )
      .join("");
    bands.push(`<text class="tag" x="${GUTTER_TEXT_X}" y="${startY}">${tspans}</text>`);
    track(0, by, BAND_X, bh);
  });

  const entries = [...boxes.values()];
  const leftBase = Math.min(...entries.map((e) => e.x));
  const rightBase = Math.max(...entries.map((e) => e.x + e.w));

  /** @type {string[]} */
  const edgePaths = [];
  /** @type {string[]} */
  const edgeLabels = [];
  for (const edge of spec.edges ?? []) {
    const a = boxes.get(edge.from);
    const b = boxes.get(edge.to);
    if (!a || !b) throw new Error(`unknown step in edge ${edge.from}->${edge.to}`);
    // Lanes are the axis a reader actually tracks here — a handoff crossing
    // lane boundaries is the point of the diagram — so any lane change routes
    // vertically regardless of how far apart the columns are. A generic
    // nearest-axis heuristic would draw a distant cross-lane edge as if it
    // were a same-row one, hiding the handoff.
    const side = a.node.row === b.node.row ? "h" : "v";
    const geom = ports(a, b, side);
    const others = entries.filter((e) => e !== a && e !== b);
    const blocked = others.some((o) => runCrosses(geom, side, o));
    const kind = edge.kind ?? "sync";
    /** @type {string} */
    let d;
    if (blocked && side === "h") {
      // Same lane, blocked by a sibling: duck under both boxes rather than
      // cut through whatever sits between them in that row.
      const y = Math.max(a.y + a.h, b.y + b.h) + 18;
      const exitX = clearExitX(a, others, a.y + a.h, y);
      const entryX = clearExitX(b, others, b.y + b.h, y);
      d = detour(a, b, y, false, 8, { exitX, entryX });
      geom.sx = exitX;
      geom.tx = entryX;
      geom.sy = y;
      geom.ty = y;
      track(Math.min(exitX, entryX), y - 2, Math.abs(entryX - exitX), 4);
    } else if (blocked) {
      // Crossing lanes but blocked by an intervening step: a side lane past
      // whichever edge of the grid is nearer clears every row at once.
      const left = Math.abs(a.cx - leftBase) <= Math.abs(rightBase - a.cx);
      const base = left ? leftBase : rightBase;
      const laneX = left ? base - SIDE_GAP : base + SIDE_GAP;
      d = sideDetour(a, b, laneX, left);
      geom.sx = laneX;
      geom.tx = laneX;
      geom.sy = a.cy;
      geom.ty = b.cy;
      track(laneX - 2, Math.min(a.cy, b.cy), 4, Math.abs(b.cy - a.cy));
    } else {
      d =
        side === "v"
          ? elbowV(geom.sx, geom.sy, geom.tx, geom.ty)
          : elbow(geom.sx, geom.sy, geom.tx, geom.ty);
    }
    edgePaths.push(
      `<path class="${edgeClass(kind)}" d="${d}" marker-end="url(#${markerFor(spec.id, kind)})"/>`,
    );
    edgeLabels.push(edgeLabel(edge, geom, occupied, track));
  }

  const nodes = entries.map(renderNode).join("");

  // Fit the viewBox to what was actually drawn: a side or under detour, or a
  // displaced label, routinely falls outside the nominal grid.
  const vx = snap(minX - FIT_PAD);
  const vy = snap(minY - FIT_PAD);
  const vw = snap(maxX - minX + FIT_PAD * 2);
  const vh = snap(maxY - minY + FIT_PAD * 2);
  return assemble([
    `<svg viewBox="${vx} ${vy} ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    markers(spec.id),
    `<rect class="bg" x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="10"/>`,
    bands.join(""),
    edgePaths.join(""),
    nodes,
    edgeLabels.join(""),
    "</svg>",
  ]);
}
