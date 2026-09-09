import { assemble, esc, snap, wrap, NAME_CH, MONO_CH } from "./text.mjs";

/** @typedef {import("./types.mjs").TreeSpec} TreeSpec */
/** @typedef {import("./types.mjs").TreeNode} TreeNode */
/** @typedef {{ node: TreeNode, lines: string[], subLines: string[], depth: number, x: number, y: number, w: number, h: number, cx: number }} TreeBox */

const NODE_W = 156;
const NODE_H = 46;
const GAP_X = 22;
const GAP_Y = 54;
const PAD = 28;

/**
 * Lay out and render a hierarchy with ORTHOGONAL connectors.
 *
 * Positions are computed bottom-up: a leaf takes the next free slot on its row,
 * and a parent centres over its children. That ordering is what keeps the bus
 * lines short and the siblings contiguous; centring parents first and then
 * placing children forces the children apart to satisfy an already-fixed parent.
 *
 * Connectors are drawn before nodes so a node's fill always covers the stub
 * entering it, and they are never diagonal: a parent drops a short vertical, a
 * horizontal bus spans the siblings, and each child takes a short drop into its
 * own top edge.
 * @param {TreeSpec} spec
 * @returns {string}
 */
export function renderTree(spec) {
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  for (const n of spec.nodes) {
    if (n.parent !== undefined && !byId.has(n.parent)) {
      throw new Error(`unknown tree parent ${n.parent} for node ${n.id}`);
    }
  }
  const roots = spec.nodes.filter((n) => n.parent === undefined);
  if (roots.length === 0) throw new Error("a tree needs a node with no parent");

  /** @param {string} id @returns {TreeNode[]} */
  const childrenOf = (id) => spec.nodes.filter((n) => n.parent === id);

  /** @type {Map<string, TreeBox>} */
  const boxes = new Map();
  let depthSeen = 0;
  let cursor = PAD;

  /**
   * @param {TreeNode} node @param {number} depth
   * @returns {TreeBox}
   */
  const placeNode = (node, depth) => {
    depthSeen = Math.max(depthSeen, depth);
    const lines = wrap(node.label, Math.floor((NODE_W - 16) / NAME_CH));
    const subLines = node.sub ? wrap(node.sub, Math.floor((NODE_W - 18) / MONO_CH)) : [];
    const kids = childrenOf(node.id);
    /** @type {TreeBox[]} */
    const placed = kids.map((k) => placeNode(k, depth + 1));
    let x;
    if (placed.length === 0) {
      x = cursor;
      cursor += NODE_W + GAP_X;
    } else {
      const first = placed[0];
      const last = placed[placed.length - 1];
      x = (first.x + last.x + last.w) / 2 - NODE_W / 2;
    }
    const y = PAD + depth * (NODE_H + GAP_Y);
    const box = {
      node,
      lines,
      subLines,
      depth,
      x,
      y,
      w: NODE_W,
      h: NODE_H,
      cx: x + NODE_W / 2,
    };
    boxes.set(node.id, box);
    return box;
  };
  for (const root of roots) placeNode(root, 0);

  /** @type {string[]} */
  const connectors = [];
  for (const box of boxes.values()) {
    const kids = childrenOf(box.node.id)
      .map((k) => boxes.get(k.id))
      .filter((k) => k !== undefined);
    if (kids.length === 0) continue;
    const busY = box.y + box.h + GAP_Y / 2;
    connectors.push(`<path class="bus" d="M${box.cx},${box.y + box.h} V${busY}"/>`);
    if (kids.length > 1) {
      const left = Math.min(...kids.map((k) => k.cx));
      const right = Math.max(...kids.map((k) => k.cx));
      connectors.push(`<path class="bus" d="M${left},${busY} H${right}"/>`);
    }
    for (const kid of kids) {
      connectors.push(`<path class="bus" d="M${kid.cx},${busY} V${kid.y}"/>`);
    }
  }

  /** @type {string[]} */
  const nodes = [];
  for (const box of boxes.values()) {
    const kind = box.node.kind ?? "backend";
    const textTop = box.y + (box.h - (box.lines.length * 14 + box.subLines.length * 11)) / 2 + 11;
    nodes.push(
      `<rect class="nb ${kind}" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="6"/>` +
        `<text class="nn" x="${box.cx}" y="${textTop}" text-anchor="middle">` +
        box.lines
          .map((l, i) => `<tspan x="${box.cx}" dy="${i === 0 ? 0 : 14}">${esc(l)}</tspan>`)
          .join("") +
        "</text>" +
        (box.subLines.length
          ? `<text class="ns" x="${box.cx}" y="${textTop + (box.lines.length - 1) * 14 + 12}" text-anchor="middle">` +
            box.subLines
              .map((l, i) => `<tspan x="${box.cx}" dy="${i === 0 ? 0 : 11}">${esc(l)}</tspan>`)
              .join("") +
            "</text>"
          : ""),
    );
  }

  const all = [...boxes.values()];
  const minX = Math.min(...all.map((b) => b.x));
  const maxX = Math.max(...all.map((b) => b.x + b.w));
  const vw = snap(maxX - minX + PAD * 2);
  const vh = snap(PAD * 2 + (depthSeen + 1) * NODE_H + depthSeen * GAP_Y);
  return assemble([
    `<svg viewBox="${snap(minX - PAD)} 0 ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="${snap(minX - PAD)}" y="0" width="${vw}" height="${vh}" rx="10"/>`,
    connectors.join(""),
    nodes.join(""),
    "</svg>",
  ]);
}
