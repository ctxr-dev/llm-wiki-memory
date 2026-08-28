import { MONO_CH, esc, wrap } from "./text.mjs";
import { silhouette } from "./shapes.mjs";
import { place } from "./geometry.mjs";

/** @typedef {import("./types.mjs").Box} Box */
/** @typedef {import("./types.mjs").DiagramEdge} DiagramEdge */
/** @typedef {import("./types.mjs").DiagramZone} DiagramZone */
/** @typedef {import("./types.mjs").EdgeKind} EdgeKind */
/** @typedef {import("./types.mjs").Geom} Geom */
/** @typedef {import("./types.mjs").Rect} Rect */
/** @typedef {import("./types.mjs").Track} Track */
/** @typedef {import("./types.mjs").ZoneBounds} ZoneBounds */

/**
 * Arrowhead definitions, one per line colour. Ids are namespaced by the spec id
 * because several diagrams share one document and duplicate marker ids would
 * make every diagram after the first reuse the first one's colour.
 * @param {string} id
 * @returns {string}
 */
export function markers(id) {
  // refX tracks the marker size so the arrow tip lands ON the endpoint rather
  // than overshooting it; the original three markers all satisfy refX == size.
  /** @param {string} suffix @param {string} fill @param {number} size @returns {string} */
  const head = (suffix, fill, size) =>
    `<marker id="${id}-${suffix}" viewBox="0 0 8 8" refX="${size}" refY="4" markerWidth="${size}" markerHeight="${size}" orient="auto-start-reverse"><path d="M0,0.5 L8,4 L0,7.5 Z" fill="var(--${fill})"/></marker>`;
  return [
    "<defs>",
    head("a", "muted", 7),
    head("af", "accent", 7),
    head("as", "ink", 6),
    "</defs>",
  ].join("\n");
}

/**
 * @param {string} id @param {EdgeKind} kind
 * @returns {string}
 */
export function markerFor(id, kind) {
  if (kind === "store") return `${id}-as`;
  if (kind === "focal") return `${id}-af`;
  return `${id}-a`;
}

/**
 * @param {EdgeKind} kind
 * @returns {string}
 */
export function edgeClass(kind) {
  if (kind === "async") return "e async";
  if (kind === "store") return "e store";
  if (kind === "focal") return "e focal";
  return "e";
}

/**
 * Render an edge's label, anchored to the run entering ITS OWN target.
 *
 * For a bent run the anchor is biased toward the target half rather than the
 * geometric midpoint: at the midpoint of an elbow the label sits in open space
 * between two boxes and a reader cannot tell which of the two edges crossing
 * there it describes. `occupied` accumulates, so labels avoid nodes AND every
 * label already placed.
 * @param {DiagramEdge} edge @param {Geom} geom @param {Rect[]} occupied @param {Track} track
 * @returns {string}
 */
export function edgeLabel(edge, geom, occupied, track) {
  if (!edge.label) return "";
  const lines = wrap(edge.label, edge.wrap ?? 24);
  const w = Math.max(...lines.map((l) => l.length)) * MONO_CH + 10;
  const h = lines.length * 11 + 6;
  const vertical =
    edge.orient === "v" ||
    (edge.orient !== "h" && Math.abs(geom.ty - geom.sy) > Math.abs(geom.tx - geom.sx));
  const axis = vertical ? "x" : "y";
  const midX = (geom.sx + geom.tx) / 2;
  const midY = (geom.sy + geom.ty) / 2;
  const bias = edge.side === "left" ? -1 : 1;
  const bent = Math.abs(geom.ty - geom.sy) > 2 && Math.abs(geom.tx - geom.sx) > 2;
  const runX = bent ? (midX + geom.tx) / 2 : midX;
  const runY = bent ? (midY + geom.ty) / 2 : midY;
  let cx = edge.lx ?? (vertical ? geom.tx + bias * (w / 2 + 14) : runX);
  let cy = edge.ly ?? (vertical ? runY : geom.ty - (h / 2 + 9));
  cx += edge.dx ?? 0;
  cy += edge.dy ?? 0;
  const pinned = edge.lx !== undefined || edge.ly !== undefined;
  const rect = pinned
    ? { x: cx - w / 2, y: cy - h / 2, w, h }
    : place(cx, cy, w, h, occupied, axis);
  occupied.push(rect);
  track(rect.x, rect.y, rect.w, rect.h);
  const tx = rect.x + w / 2;
  const cls = edge.kind === "focal" ? "el focal" : "el";
  const tspans = lines
    .map((line, i) => `<tspan x="${tx}" dy="${i === 0 ? 0 : 11}">${esc(line)}</tspan>`)
    .join("");
  return (
    `<rect class="emask" x="${rect.x}" y="${rect.y}" width="${w}" height="${h}" rx="3"/>` +
    `<text class="${cls}" x="${tx}" y="${rect.y + 11}" text-anchor="middle">${tspans}</text>`
  );
}

/**
 * @param {Box} entry
 * @returns {string}
 */
export function renderNode(entry) {
  const { node, lines, subLines } = entry;
  const kind = node.kind ?? "backend";
  const shape = node.shape ?? "box";
  const body = silhouette(entry, `nb ${kind}`);

  // A dot or a ringed dot has no room for text inside it, so its label sits to
  // the right at the same baseline rather than being centred and unreadable.
  if (shape === "dot" || shape === "end") {
    const label = lines.join(" ");
    return (
      body +
      (label
        ? `<text class="ns" x="${entry.cx + 14}" y="${entry.cy + 3}">${esc(label)}</text>`
        : "")
    );
  }

  const textTop = entry.y + (entry.h - (lines.length * 15 + subLines.length * 11)) / 2 + 11;
  const name = lines
    .map((line, i) => `<tspan x="${entry.cx}" dy="${i === 0 ? 0 : 15}">${esc(line)}</tspan>`)
    .join("");
  const sub = subLines
    .map((line, i) => `<tspan x="${entry.cx}" dy="${i === 0 ? 13 : 11}">${esc(line)}</tspan>`)
    .join("");
  return (
    body +
    `<text class="nn" x="${entry.cx}" y="${textTop}" text-anchor="middle">${name}</text>` +
    (sub
      ? `<text class="ns" x="${entry.cx}" y="${textTop + (lines.length - 1) * 15}" text-anchor="middle">${sub}</text>`
      : "")
  );
}

/**
 * @param {DiagramZone} zone @param {Map<string, Box>} boxes
 * @returns {ZoneBounds | null}
 */
export function zoneBounds(zone, boxes) {
  /** @type {Box[]} */
  const members = [];
  for (const id of zone.nodes) {
    const box = boxes.get(id);
    if (box) members.push(box);
  }
  if (members.length === 0) return null;
  const pad = zone.pad ?? 14;
  return {
    x: Math.min(...members.map((m) => m.x)) - pad,
    // The extra 20 above leaves room for the zone's own label, which is drawn
    // straddling the top border rather than inside the box.
    y: Math.min(...members.map((m) => m.y)) - pad - 20,
    x2: Math.max(...members.map((m) => m.x + m.w)) + pad,
    y2: Math.max(...members.map((m) => m.y + m.h)) + pad,
  };
}

/**
 * A zone's frame and its label, returned SEPARATELY.
 *
 * The frame is a backdrop and belongs under everything; the label must sit ABOVE
 * the edges. Emitting both together put the label under the runs, and a
 * long-range edge crossing a zone's top border painted straight through its
 * name, mask and all: a mask only protects what is drawn after it.
 * @param {DiagramZone} zone @param {Map<string, Box>} boxes @param {Track} track
 * @returns {{ frame: string, label: string }}
 */
export function renderZone(zone, boxes, track) {
  const b = zoneBounds(zone, boxes);
  if (!b) return { frame: "", label: "" };
  const labelW = zone.label.length * 5.6 + 12;
  const lx = b.x + 14;
  track(b.x, b.y, b.x2 - b.x, b.y2 - b.y);
  return {
    frame: `<rect class="zone" x="${b.x}" y="${b.y}" width="${b.x2 - b.x}" height="${b.y2 - b.y}" rx="8"/>`,
    label:
      `<rect class="zmask" x="${lx - 5}" y="${b.y - 5.5}" width="${labelW}" height="11" rx="2"/>` +
      `<text class="zlab" x="${lx}" y="${b.y + 3}">${esc(zone.label.toUpperCase())}</text>`,
  };
}
