import { esc } from "./text.mjs";

/** @typedef {import("./types.mjs").Box} Box */

// Node silhouettes. SHAPE carries the node's TYPE and colour never does: a reader
// can tell a decision from a step at a glance without consulting a legend, and
// the single accent stays available for emphasis. Adding a fill to signal type is
// the anti-pattern these shapes exist to avoid.

/**
 * @param {Box} box
 * @returns {string} polygon points for a decision diamond
 */
function diamondPoints(box) {
  const { cx, cy } = box;
  const halfW = box.w / 2;
  return `${cx},${box.y} ${cx + halfW},${cy} ${cx},${box.y + box.h} ${cx - halfW},${cy}`;
}

/**
 * The silhouette element for a node, without its text.
 * @param {Box} box @param {string} cls
 * @returns {string}
 */
export function silhouette(box, cls) {
  const shape = box.node.shape ?? "box";
  if (shape === "diamond") {
    return `<polygon class="${cls}" points="${diamondPoints(box)}"/>`;
  }
  if (shape === "dot") {
    // A start marker or a merge point: the label rides beside it, so the box's
    // own width is ignored and only its centre matters.
    return `<circle class="dot" cx="${box.cx}" cy="${box.cy}" r="5"/>`;
  }
  if (shape === "end") {
    return (
      `<circle class="ring" cx="${box.cx}" cy="${box.cy}" r="8"/>` +
      `<circle class="dot" cx="${box.cx}" cy="${box.cy}" r="4.5"/>`
    );
  }
  // A terminator is a stadium: rx large enough to round fully at this height.
  const rx = shape === "terminator" ? box.h / 2 : shape === "state" ? 8 : 6;
  return `<rect class="${cls}" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${rx}"/>`;
}

/**
 * A self-transition: a loop leaving the box's right edge and returning to it.
 *
 * Deliberately to the SIDE rather than above. Above, the loop and its label land
 * in the same band as the label of whatever edge enters the box from the
 * previous row, and the two fight: capping the label's drift produced a 522
 * sq unit collision, and letting it drift parked it over the wrong box. The
 * right flank is almost always free, so the contention disappears instead of
 * being traded around.
 * @param {Box} box
 * @returns {string}
 */
export function selfLoopPath(box) {
  const x = box.x + box.w;
  const out = x + 26;
  return `M${x},${box.cy - 9} C${out},${box.cy - 16} ${out},${box.cy + 16} ${x},${box.cy + 9}`;
}

/**
 * An index eyebrow (`L3`, `07`, `APPLICATION`) in the mono face.
 * @param {number} x @param {number} y @param {string} label
 * @returns {string}
 */
export function indexTag(x, y, label) {
  return `<text class="tag" x="${x}" y="${y}">${esc(label.toUpperCase())}</text>`;
}
