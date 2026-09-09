// Entity-relationship diagram: one box per entity with a header and a field
// list, joined by orthogonal relationship lines carrying cardinality in their
// label — undirected strokes, since cardinality itself carries direction.
// Every entity box doubles as the shared `Box` shape (see `EntityBox`), so
// routing reuses the existing port/collision helpers unmodified.

import { assemble, esc, snap } from "./text.mjs";
import { ports } from "./geometry.mjs";
import { clearExitX, detour, elbow, elbowV, runCrosses, sideDetour } from "./routing.mjs";
import { edgeClass, edgeLabel } from "./parts.mjs";
import { LANE_MARGIN, FIT_PAD, layoutEntities, renderEntity } from "./er-entity.mjs";

/** @typedef {import("./er-entity.mjs").ErEntity} ErEntity */
/** @typedef {import("./er-entity.mjs").EntityBox} EntityBox */

/**
 * @typedef {Object} ErRelation
 * @property {string} from entity id
 * @property {string} to entity id
 * @property {string} [label] how the two relate, in words
 * @property {string} [cardinality] e.g. "1..1", "1..n"
 * @property {import("./types.mjs").EdgeKind} [kind]
 * @property {"v" | "h"} [axis] force the port axis instead of letting it be inferred
 */

/**
 * @typedef {Object} ErSpec
 * @property {"er"} kind
 * @property {string} id
 * @property {string} title
 * @property {ErEntity[]} entities
 * @property {ErRelation[]} [relations]
 */

/**
 * Route one relationship as an orthogonal run between two entity edges, then
 * place its cardinality/label text clear of every entity and prior label.
 * @param {ErRelation} rel @param {EntityBox} a @param {EntityBox} b
 * @param {EntityBox[]} others @param {{ left: number, right: number, top: number, bottom: number }} bases
 * @param {import("./types.mjs").Rect[]} occupied @param {import("./types.mjs").Track} track
 * @returns {{ path: string, label: string }}
 */
function routeRelation(rel, a, b, others, bases, occupied, track) {
  const overlapX = (a.cx >= b.x && a.cx <= b.x + b.w) || (b.cx >= a.x && b.cx <= a.x + a.w);
  const autoSide = overlapX || Math.abs(b.cy - a.cy) >= Math.abs(b.cx - a.cx) ? "v" : "h";
  let side = rel.axis ?? autoSide;
  const blocked = (/** @type {"v" | "h"} */ s) =>
    others.some((o) => runCrosses(ports(a, b, s), s, o));
  if (!rel.axis && blocked(autoSide)) {
    const alt = autoSide === "v" ? "h" : "v";
    if (!blocked(alt)) side = alt;
  }
  const geom = ports(a, b, side);
  const blockers = others.filter((o) => runCrosses(geom, side, o));
  let d;
  if (blockers.length > 0 && side === "h") {
    // Same row: a side lane would still run through the row the blocker
    // occupies, so cross above or below the whole diagram instead.
    const up = Math.abs(a.cy - bases.top) <= Math.abs(bases.bottom - a.cy);
    const lane = up ? bases.top - LANE_MARGIN : bases.bottom + LANE_MARGIN;
    const exitX = clearExitX(a, others, up ? a.y : a.y + a.h, lane);
    const entryX = clearExitX(b, others, up ? b.y : b.y + b.h, lane);
    d = detour(a, b, lane, up, 8, { exitX, entryX });
    geom.sx = exitX;
    geom.tx = entryX;
    geom.sy = geom.ty = lane;
    track(Math.min(exitX, entryX), lane - 2, Math.abs(entryX - exitX), 4);
  } else if (blockers.length > 0) {
    // Same column: cross beside the whole diagram, clear because it starts
    // outside every entity's extent.
    const left = Math.abs(a.cx - bases.left) <= Math.abs(bases.right - a.cx);
    const lane = left ? bases.left - LANE_MARGIN : bases.right + LANE_MARGIN;
    d = sideDetour(a, b, lane, left);
    geom.sx = geom.tx = lane;
    geom.sy = a.cy;
    geom.ty = b.cy;
    track(lane - 2, Math.min(a.cy, b.cy), 4, Math.abs(b.cy - a.cy));
  } else {
    const elbowFn = side === "v" ? elbowV : elbow;
    d = elbowFn(geom.sx, geom.sy, geom.tx, geom.ty);
  }
  const kind = rel.kind ?? "sync";
  const path = `<path class="${edgeClass(kind)}" d="${d}"/>`;
  const text = [rel.label, rel.cardinality].filter(Boolean).join(" \u00b7 ");
  if (!text) return { path, label: "" };
  /** @type {import("./types.mjs").DiagramEdge} */
  const labelEdge = { from: rel.from, to: rel.to, label: text, kind: rel.kind };
  // Anchor on the run's MID-HEIGHT, not on the target's centre. Entities in one
  // row differ in height (a five-field box is far taller than a two-field one),
  // so the target's centre can be most of a box away from where the run actually
  // travels: that put "mapped by" above BOTH boxes, describing nothing. Flatten
  // the geom the LABEL is placed against; the drawn path is untouched.
  const midY = (geom.sy + geom.ty) / 2;
  const midX = (geom.sx + geom.tx) / 2;
  const labelGeom =
    side === "v"
      ? { sx: midX, tx: midX, sy: geom.sy, ty: geom.ty }
      : { sx: geom.sx, tx: geom.tx, sy: midY, ty: midY };
  return { path, label: edgeLabel(labelEdge, labelGeom, occupied, track) };
}

/**
 * Render an entity-relationship diagram to inline SVG: one box per entity
 * with a header and field rows, joined by cardinality-labelled relationships.
 * @param {ErSpec} spec
 * @returns {string}
 */
export function renderEr(spec) {
  if (spec.entities.length === 0) throw new Error("an er diagram needs at least one entity");
  const boxes = layoutEntities(spec.entities);
  const boxList = [...boxes.values()];
  const bases = {
    left: Math.min(...boxList.map((b) => b.x)),
    right: Math.max(...boxList.map((b) => b.x + b.w)),
    top: Math.min(...boxList.map((b) => b.y)),
    bottom: Math.max(...boxList.map((b) => b.y + b.h)),
  };

  // `occupied` doubles as the viewBox extent: every rect pushed into it (an
  // entity box, a placed label, a lane mark) is fit directly, rather than
  // tracked a second time through a parallel min/max accumulator.
  /** @type {import("./types.mjs").Rect[]} */
  const occupied = boxList.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
  /** @type {import("./types.mjs").Track} */
  const track = (x, y, w, h) => {
    occupied.push({ x, y, w, h });
  };

  /** @type {string[]} */
  const edgePaths = [];
  /** @type {string[]} */
  const edgeLabels = [];
  for (const rel of spec.relations ?? []) {
    const a = boxes.get(rel.from);
    const b = boxes.get(rel.to);
    if (!a || !b) throw new Error(`relation references unknown entity ${a ? rel.to : rel.from}`);
    const others = boxList.filter((e) => e !== a && e !== b);
    const { path, label } = routeRelation(rel, a, b, others, bases, occupied, track);
    edgePaths.push(path);
    if (label) edgeLabels.push(label);
  }

  const nodes = boxList.map(renderEntity).join("");
  const minX = Math.min(...occupied.map((r) => r.x));
  const minY = Math.min(...occupied.map((r) => r.y));
  const maxX = Math.max(...occupied.map((r) => r.x + r.w));
  const maxY = Math.max(...occupied.map((r) => r.y + r.h));
  const vx = snap(minX - FIT_PAD);
  const vy = snap(minY - FIT_PAD);
  const vw = snap(maxX - minX + FIT_PAD * 2);
  const vh = snap(maxY - minY + FIT_PAD * 2);
  return assemble([
    `<svg viewBox="${vx} ${vy} ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="10"/>`,
    edgePaths.join(""),
    nodes,
    edgeLabels.join(""),
    "</svg>",
  ]);
}
