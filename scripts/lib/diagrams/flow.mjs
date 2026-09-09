import { assemble, esc, snap, SANS_CH } from "./text.mjs";
import { layout, place, ports } from "./geometry.mjs";
import { clearExitX, detour, elbow, elbowV, runCrosses, sideDetour } from "./routing.mjs";
import {
  edgeClass,
  edgeLabel,
  markerFor,
  markers,
  renderNode,
  renderZone,
  zoneBounds,
} from "./parts.mjs";
import { selfLoopPath } from "./shapes.mjs";

/** @typedef {import("./types.mjs").Box} Box */
/** @typedef {import("./types.mjs").FlowSpec} FlowSpec */
/** @typedef {import("./types.mjs").Rect} Rect */

/**
 * Render a node-and-edge flow diagram to inline SVG.
 * @param {FlowSpec} spec
 * @returns {string}
 */
export function render(spec) {
  const { boxes } = layout(spec);
  const id = spec.id;
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
  for (const entry of boxes.values()) {
    track(entry.x, entry.y, entry.w, entry.h);
    occupied.push({ x: entry.x, y: entry.y, w: entry.w, h: entry.h });
  }

  /** @type {import("./types.mjs").ZoneBounds[]} */
  const zoneBoxes = [];
  for (const zone of spec.zones ?? []) {
    const b = zoneBounds(zone, boxes);
    if (b) zoneBoxes.push(b);
  }
  const rendered = (spec.zones ?? []).map((z) => renderZone(z, boxes, track));
  const zoneFrames = rendered.map((z) => z.frame).join("");
  // Zone LABELS are emitted late, with the edge labels, so a run crossing a
  // zone's top border cannot paint through its name.
  const zoneLabels = rendered.map((z) => z.label).join("");

  const entries = [...boxes.values()];
  // Routing bases for `global` detours: the outermost edge of anything drawn, so
  // a global lane clears the whole diagram rather than just its two endpoints.
  const overBase = Math.min(
    Math.min(...entries.map((e) => e.y)),
    ...(zoneBoxes.length ? [Math.min(...zoneBoxes.map((z) => z.y))] : []),
  );
  const underBase = Math.max(
    Math.max(...entries.map((e) => e.y + e.h)),
    ...(zoneBoxes.length ? [Math.max(...zoneBoxes.map((z) => z.y2))] : []),
  );
  const leftBase = Math.min(
    Math.min(...entries.map((e) => e.x)),
    ...(zoneBoxes.length ? [Math.min(...zoneBoxes.map((z) => z.x))] : []),
  );
  const rightBase = Math.max(
    Math.max(...entries.map((e) => e.x + e.w)),
    ...(zoneBoxes.length ? [Math.max(...zoneBoxes.map((z) => z.x2))] : []),
  );

  /** @type {string[]} */
  const edgePaths = [];
  /** @type {string[]} */
  const edgeLabels = [];
  for (const edge of spec.edges ?? []) {
    const a = boxes.get(edge.from);
    const b = boxes.get(edge.to);
    if (!a || !b) throw new Error(`unknown edge endpoint ${edge.from}->${edge.to}`);
    if (a === b) {
      // A self-transition ("retry on timeout") loops above the box. It has no
      // run to anchor a label against, so the label is placed beside the loop's
      // peak — but still through collision placement, because the peak sits in
      // the same crowded band as the labels of the edges entering the box.
      const kindSelf = edge.kind ?? "sync";
      edgePaths.push(
        `<path class="${edgeClass(kindSelf)}" d="${selfLoopPath(a)}" marker-end="url(#${markerFor(id, kindSelf)})"/>`,
      );
      track(a.x + a.w, a.cy - 18, 30, 36);
      if (edge.label) {
        const lw = edge.label.length * 5 + 10;
        // Anchored just past the loop on the same centre line, with a tight
        // drift cap: proximity to the loop is this label's ONLY cue to
        // ownership, so it must not be pushed into a neighbour's band.
        const rect = place(a.x + a.w + 32 + lw / 2, a.cy, lw, 16, occupied, "y", 26);
        occupied.push(rect);
        track(rect.x, rect.y, rect.w, rect.h);
        edgeLabels.push(
          `<rect class="emask" x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" rx="3"/>` +
            `<text class="${kindSelf === "focal" ? "el focal" : "el"}" x="${rect.x + 5}" y="${rect.y + 11}">${esc(edge.label)}</text>`,
        );
      }
      continue;
    }
    const overlapX = (a.cx >= b.x && a.cx <= b.x + b.w) || (b.cx >= a.x && b.cx <= a.x + a.w);
    const autoSide = overlapX || Math.abs(b.cy - a.cy) >= Math.abs(b.cx - a.cx) ? "v" : "h";
    // When the preferred axis would drive the run through an unrelated box, the
    // OTHER axis usually clears it by routing through the column or row gutter,
    // which is both shorter and less surprising than a lane around the diagram.
    // Try that before anything more drastic. An explicit `edge.side` is the
    // author's call and is never second-guessed.
    let side = edge.side ?? autoSide;
    if (!edge.side && !edge.d && !edge.route) {
      const others = entries.filter((e) => e !== a && e !== b);
      const blocked = (/** @type {"v" | "h"} */ s) =>
        others.some((e) => runCrosses(ports(a, b, s), s, e));
      if (blocked(autoSide)) {
        const alt = autoSide === "v" ? "h" : "v";
        if (!blocked(alt)) side = alt;
      }
    }
    const geom = ports(a, b, side);
    const kind = edge.kind ?? "sync";
    let d = edge.d;
    if (!d && (edge.route === "under" || edge.route === "over")) {
      const up = edge.route === "over";
      const localTop = Math.min(a.y, b.y);
      const localBottom = Math.max(a.y + a.h, b.y + b.h);
      const base = edge.global ? (up ? overBase : underBase) : up ? localTop : localBottom;
      const lane = up ? base - (edge.lane ?? 26) : base + (edge.lane ?? 26);
      // The lane clears the rows between the endpoints, but the DESCENT to it
      // does not when a box sits directly below (or above) an endpoint in the
      // same column, so pick an x for each leg that is actually free.
      const others = entries.filter((e) => e !== a && e !== b);
      const exitX = clearExitX(a, others, up ? a.y : a.y + a.h, lane);
      const entryX = clearExitX(b, others, up ? b.y : b.y + b.h, lane);
      d = detour(a, b, lane, up, 8, { exitX, entryX });
      geom.sx = exitX;
      geom.tx = entryX;
      geom.sy = lane;
      geom.ty = lane;
      track(Math.min(exitX, entryX), lane - 2, Math.abs(entryX - exitX), 4);
    }
    if (!d && (edge.route === "left" || edge.route === "right")) {
      const left = edge.route === "left";
      const localLeft = Math.min(a.x, b.x);
      const localRight = Math.max(a.x + a.w, b.x + b.w);
      const base = edge.global ? (left ? leftBase : rightBase) : left ? localLeft : localRight;
      const lane = left ? base - (edge.lane ?? 26) : base + (edge.lane ?? 26);
      d = sideDetour(a, b, lane, left);
      geom.sx = lane;
      geom.tx = lane;
      geom.sy = a.cy;
      geom.ty = b.cy;
      track(lane - 2, Math.min(a.cy, b.cy), 4, Math.abs(b.cy - a.cy));
    }
    if (!d) {
      // A direct run between non-adjacent rows in the same column crosses every
      // node between them. That reads as a relationship to the box it passes
      // through, which is the single most misleading thing a diagram can do, so
      // detect it and take a side lane instead of drawing the lie. Only an
      // AUTOMATIC route is replaced: an explicit `route`/`d` in the spec is the
      // author's decision and is left alone above.
      const blockers = entries.filter((e) => e !== a && e !== b && runCrosses(geom, side, e));
      if (blockers.length > 0) {
        const left = Math.abs(a.cx - leftBase) <= Math.abs(rightBase - a.cx);
        const base = left ? leftBase : rightBase;
        const lane = left ? base - 26 : base + 26;
        d = sideDetour(a, b, lane, left);
        geom.sx = lane;
        geom.tx = lane;
        geom.sy = a.cy;
        geom.ty = b.cy;
        track(lane - 2, Math.min(a.cy, b.cy), 4, Math.abs(b.cy - a.cy));
      } else {
        d =
          side === "v"
            ? elbowV(geom.sx, geom.sy, geom.tx, geom.ty)
            : elbow(geom.sx, geom.sy, geom.tx, geom.ty);
      }
    }
    edgePaths.push(
      `<path class="${edgeClass(kind)}" d="${d}" marker-end="url(#${markerFor(id, kind)})"/>`,
    );
    edgeLabels.push(
      edgeLabel(
        { ...edge, side: edge.route === "left" ? "left" : edge.side },
        geom,
        occupied,
        track,
      ),
    );
  }

  const nodes = entries.map(renderNode).join("");
  const notes = (spec.notes ?? []).map((n) => {
    track(n.x - 4, n.y - 12, (n.text.length * SANS_CH) / 1.6, 16);
    return `<text class="note" x="${n.x}" y="${n.y}"${n.anchor ? ` text-anchor="${n.anchor}"` : ""}>${esc(n.text)}</text>`;
  });

  // Fit the viewBox to what was actually drawn, not to the nominal layout size:
  // detour lanes and displaced labels routinely fall outside it, and a nominal
  // box clips them.
  const pad = spec.fitPad ?? 18;
  const vx = snap(minX - pad);
  const vy = snap(minY - pad);
  const vw = snap(maxX - minX + pad * 2);
  const vh = snap(maxY - minY + pad * 2);
  return assemble([
    `<svg viewBox="${vx} ${vy} ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    markers(id),
    `<rect class="bg" x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="10"/>`,
    zoneFrames,
    edgePaths.join(""),
    nodes,
    edgeLabels.join(""),
    zoneLabels,
    notes.join(""),
    "</svg>",
  ]);
}
