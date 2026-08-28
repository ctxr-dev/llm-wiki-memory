// Sankey / flow-quantity diagram: three fixed stage columns, ribbons whose
// thickness is proportional to the value flowing through them.
//
// Ribbons are `<path class="flow">` - the only fill-based, variable-width
// shape the palette offers, and it has no `band.focal` modifier - so the ONE
// focal path is distinguished by dropping the `style="opacity:.4"` every
// ordinary ribbon carries, and by being painted last, on top.
//
// A ribbon's two edges are cubic Beziers whose control points both sit at
// the column midpoint, at the y of the endpoint they belong to (`ribbonPath`).
// Each edge spans only two distinct y-values, so by the convex-hull property
// of Bezier curves it can never swing past its own two endpoints - it can
// never leave the node stack it connects, which keeps it inside the plot
// with no separate clipping check.

import { assemble, esc, snap, NAME_CH, MONO_CH } from "./text.mjs";

/**
 * @typedef {Object} SankeyNode
 * @property {string} id
 * @property {string} label
 * @property {number} layer 0, 1 or 2 - a sankey always renders exactly 3 stage columns
 */

/**
 * @typedef {Object} SankeyFlow
 * @property {string} from node id, one layer left of `to`
 * @property {string} to node id, one layer right of `from`
 * @property {number} value
 * @property {boolean} [focal]
 */

/**
 * @typedef {Object} SankeySpec
 * @property {"sankey"} kind
 * @property {string} id
 * @property {string} title
 * @property {SankeyNode[]} nodes
 * @property {SankeyFlow[]} flows
 */

/** @typedef {{ flow: SankeyFlow, from: SankeyNode, to: SankeyNode }} Edge */
/** @typedef {{ height: number, top: number }} Placed */

const COL_X = [130, 500, 870];
const NODE_W = 12;
const TARGET_HEIGHT = 320;
const NODE_GAP = 16;
const GUTTER = 40;
const LEGEND_GAP = 56;
const PAD = 24;

import { formatCount, stackBounds, ribbonPath } from "./sankey-geometry.mjs";

/**
 * Render a sankey diagram: 3 stage columns, ribbons proportional to value.
 * @param {SankeySpec} spec
 * @returns {string}
 */
export function renderSankey(spec) {
  const nodes = spec.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0)
    throw new Error("a sankey needs at least one node");
  if (nodes.length > 8) throw new Error(`a sankey allows at most 8 nodes, got ${nodes.length}`);

  /** @type {Map<string, SankeyNode>} */
  const byId = new Map();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new Error(`duplicate sankey node id "${node.id}"`);
    if (![0, 1, 2].includes(node.layer))
      throw new Error(`node "${node.id}" has layer ${node.layer}, expected 0, 1 or 2`);
    byId.set(node.id, node);
  }
  const layers = [0, 1, 2].map((L) => nodes.filter((n) => n.layer === L));
  layers.forEach((layerNodes, L) => {
    if (layerNodes.length === 0) throw new Error(`a sankey needs at least one node in layer ${L}`);
  });

  const rawFlows = spec.flows;
  if (!Array.isArray(rawFlows) || rawFlows.length === 0)
    throw new Error("a sankey needs at least one flow");
  if (rawFlows.length > 12)
    throw new Error(`a sankey allows at most 12 flows, got ${rawFlows.length}`);

  /** @type {Edge[]} */
  const edges = rawFlows.map((flow) => {
    const from = byId.get(flow.from);
    const to = byId.get(flow.to);
    if (!from) throw new Error(`flow references unknown node "${flow.from}"`);
    if (!to) throw new Error(`flow references unknown node "${flow.to}"`);
    if (to.layer !== from.layer + 1) {
      throw new Error(
        `flow "${flow.from}"->"${flow.to}" must connect adjacent layers, got layer ${from.layer} -> ${to.layer}`,
      );
    }
    if (!Number.isFinite(flow.value) || flow.value <= 0)
      throw new Error(`flow "${flow.from}"->"${flow.to}" has a non-finite or non-positive value`);
    return { flow, from, to };
  });

  // A node's throughflow is whichever side it actually has; where both exist
  // they must agree, or the sankey doesn't balance - a data error, not a
  // layout choice.
  /** @type {Map<string, number>} */
  const throughflow = new Map();
  for (const node of nodes) {
    const outSum = edges.filter((e) => e.from.id === node.id).reduce((a, e) => a + e.flow.value, 0);
    const inSum = edges.filter((e) => e.to.id === node.id).reduce((a, e) => a + e.flow.value, 0);
    if (outSum > 0 && inSum > 0 && Math.abs(outSum - inSum) > 1e-6 * Math.max(outSum, inSum)) {
      throw new Error(`node "${node.id}" does not balance: ${inSum} in vs ${outSum} out`);
    }
    const total = Math.max(outSum, inSum);
    if (total <= 0) throw new Error(`node "${node.id}" has no flows at all`);
    throughflow.set(node.id, total);
  }

  // Position within its own layer decides stacking order on every edge that
  // touches a node, keeping flows sharing a node in a consistent top-to-
  // bottom sequence across the columns they cross.
  /** @type {Map<string, number>} */
  const posInLayer = new Map();
  layers.forEach((layerNodes) => layerNodes.forEach((n, i) => posInLayer.set(n.id, i)));
  const layerTotal = layers.map((ls) => ls.reduce((a, n) => a + (throughflow.get(n.id) ?? 0), 0));
  const k = TARGET_HEIGHT / Math.max(...layerTotal);

  // Stack each layer top to bottom in the given node order. The middle layer
  // reserves a GUTTER above every node (including the first) for its label;
  // the outer layers only need a small gap, since their labels sit beside
  // the bar rather than above it.
  /** @type {Map<string, Placed>} */
  const placedById = new Map();
  const extents = layers.map((layerNodes, L) => {
    const middle = L === 1;
    let y = middle ? GUTTER : 0;
    layerNodes.forEach((node, i) => {
      if (i > 0) y += middle ? GUTTER : NODE_GAP;
      const height = Math.max(4, snap((throughflow.get(node.id) ?? 0) * k));
      placedById.set(node.id, { height, top: y });
      y += height;
    });
    return y;
  });
  const maxExtent = Math.max(...extents);
  layers.forEach((layerNodes, L) => {
    const offset = (maxExtent - extents[L]) / 2;
    for (const node of layerNodes) {
      const p = placedById.get(node.id);
      if (!p) throw new Error(`internal: no layout for node "${node.id}"`);
      p.top += offset;
    }
  });

  /** @type {Map<SankeyFlow, { y0: number, y1: number }>} */
  const outSpan = new Map();
  /** @type {Map<SankeyFlow, { y0: number, y1: number }>} */
  const inSpan = new Map();
  for (const node of nodes) {
    const p = placedById.get(node.id);
    if (!p) throw new Error(`internal: no layout for node "${node.id}"`);
    const out = edges
      .filter((e) => e.from.id === node.id)
      .sort((a, b) => (posInLayer.get(a.to.id) ?? 0) - (posInLayer.get(b.to.id) ?? 0));
    const outBounds = stackBounds(
      out.map((e) => e.flow.value),
      p.height,
    );
    out.forEach((e, i) =>
      outSpan.set(e.flow, { y0: p.top + outBounds[i], y1: p.top + outBounds[i + 1] }),
    );

    const inc = edges
      .filter((e) => e.to.id === node.id)
      .sort((a, b) => (posInLayer.get(a.from.id) ?? 0) - (posInLayer.get(b.from.id) ?? 0));
    const inBounds = stackBounds(
      inc.map((e) => e.flow.value),
      p.height,
    );
    inc.forEach((e, i) =>
      inSpan.set(e.flow, { y0: p.top + inBounds[i], y1: p.top + inBounds[i + 1] }),
    );
  }

  /** @type {{x: number, y: number, w: number, h: number}[]} */
  const bboxes = [];
  /** @param {number} x @param {number} y @param {number} w @param {number} h */
  const track = (x, y, w, h) => bboxes.push({ x, y, w, h });

  /** @type {string[]} */
  const ordinaryRibbons = [];
  /** @type {string[]} */
  const focalRibbons = [];
  for (const edge of edges) {
    const sOff = outSpan.get(edge.flow);
    const tOff = inSpan.get(edge.flow);
    if (!sOff || !tOff)
      throw new Error(`internal: no ribbon offsets for "${edge.from.id}"->"${edge.to.id}"`);
    const sx = COL_X[edge.from.layer] + NODE_W;
    const tx = COL_X[edge.to.layer];
    const d = ribbonPath(sx, sOff.y0, sOff.y1, tx, tOff.y0, tOff.y1);
    // The focal ribbon carries the accent via its CLASS, and is painted last
    // (focalRibbons is appended after ordinaryRibbons) so a crossing never
    // buries it. Inline opacity used to do the dimming; the class does it now.
    const cls = edge.flow.focal ? "flow focal" : "flow";
    (edge.flow.focal ? focalRibbons : ordinaryRibbons).push(`<path class="${cls}" d="${d}"/>`);
  }

  /** @type {string[]} */
  const nodeBars = [];
  /** @type {string[]} */
  const labels = [];
  for (const node of nodes) {
    const p = placedById.get(node.id);
    if (!p) throw new Error(`internal: no layout for node "${node.id}"`);
    const x = COL_X[node.layer];
    nodeBars.push(
      `<rect class="nb" x="${x}" y="${Math.round(p.top)}" width="${NODE_W}" height="${Math.round(p.height)}"/>`,
    );
    track(x, p.top, NODE_W, p.height);

    const qty = formatCount(throughflow.get(node.id) ?? 0);
    const w = Math.max(node.label.length * NAME_CH, qty.length * MONO_CH);
    if (node.layer === 0 || node.layer === 2) {
      const lx = node.layer === 0 ? x - 12 : x + NODE_W + 12;
      const anchor = node.layer === 0 ? "end" : "start";
      const midY = p.top + p.height / 2;
      labels.push(
        `<text class="clab" x="${lx}" y="${Math.round(midY - 4)}" text-anchor="${anchor}">${esc(node.label)}</text>`,
        `<text class="vlab" x="${lx}" y="${Math.round(midY + 12)}" text-anchor="${anchor}">${qty}</text>`,
      );
      track(node.layer === 0 ? lx - w : lx, midY - 16, w, 32);
    } else {
      const cx = x + NODE_W / 2;
      const qtyY = p.top - 8;
      const nameY = qtyY - 16;
      labels.push(
        `<text class="clab" x="${cx}" y="${Math.round(nameY)}" text-anchor="middle">${esc(node.label)}</text>`,
        `<text class="vlab" x="${cx}" y="${Math.round(qtyY)}" text-anchor="middle">${qty}</text>`,
      );
      track(cx - w / 2, nameY - 9, w, 28);
    }
  }

  // A legend for the two ribbon treatments plus the node bar, in abstract
  // `swatch` classes rather than the real `band`/`nb`, so a legend chip is
  // never mistaken for a diagram node.
  const hasFocal = edges.some((e) => e.flow.focal);
  const swatches = [
    { label: "Flow", cls: "swatch" },
    ...(hasFocal ? [{ label: "Focal flow", cls: "swatch focal" }] : []),
    { label: "Node", cls: "swatch s3" },
  ];
  const legendY = maxExtent + LEGEND_GAP;
  const gap = 18;
  const swW = 16;
  const widths = swatches.map((s) => swW + 6 + s.label.length * MONO_CH + gap);
  let cursor = (COL_X[0] + COL_X[2] + NODE_W) / 2 - (widths.reduce((a, b) => a + b, 0) - gap) / 2;
  /** @type {string[]} */
  const legendParts = [];
  swatches.forEach((s, i) => {
    const sx = Math.round(cursor);
    legendParts.push(
      `<rect class="${s.cls}" x="${sx}" y="${Math.round(legendY - 7)}" width="${swW}" height="8" rx="2"/>`,
      `<text class="tick" x="${sx + swW + 6}" y="${Math.round(legendY)}">${esc(s.label)}</text>`,
    );
    track(cursor, legendY - 10, widths[i], 14);
    cursor += widths[i];
  });

  const vx = snap(Math.min(...bboxes.map((b) => b.x)) - PAD);
  const vy = snap(Math.min(...bboxes.map((b) => b.y)) - PAD);
  const vw = snap(Math.max(...bboxes.map((b) => b.x + b.w)) + PAD - vx);
  const vh = snap(Math.max(...bboxes.map((b) => b.y + b.h)) + PAD - vy);

  return assemble([
    `<svg viewBox="${vx} ${vy} ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="10"/>`,
    ordinaryRibbons.join(""),
    focalRibbons.join(""),
    nodeBars.join(""),
    labels.join(""),
    legendParts.join(""),
    "</svg>",
  ]);
}
