import { assemble, esc, snap, wrap, NAME_CH, MONO_CH } from "./text.mjs";

/**
 * @typedef {"focal" | "store" | "external" | "ghost"} NestedKind
 * The visual treatment of a LEAF box only. Containers are drawn as `zone`
 * frames (see `renderNested`), which carries no kind modifiers.
 */

/**
 * @typedef {Object} NestedNode
 * @property {string} label
 * @property {string} [sub] second line, rendered in the mono face
 * @property {NestedKind} [kind] leaf-only accent; ignored on a container
 * @property {NestedNode[]} [children] presence of a non-empty array makes this a container
 */

/**
 * @typedef {Object} NestedSpec
 * @property {"nested"} kind
 * @property {string} id
 * @property {string} title
 * @property {NestedNode} root
 */

/**
 * @typedef {Object} NestedBox
 * A laid-out node, sized bottom-up: a leaf's size comes from its wrapped
 * text, a container's from its children plus its own label. Positions start
 * at (0,0) relative to the box's own top-left and are resolved to absolute
 * coordinates by `place()` in a second, top-down pass.
 * @property {NestedNode} node
 * @property {string[]} lines wrapped label lines
 * @property {string[]} subLines wrapped sub lines
 * @property {number} w
 * @property {number} h
 * @property {number} x
 * @property {number} y
 * @property {{box: NestedBox, dx: number, dy: number}[]} children offsets relative to this box's own origin
 */

const LEAF_KINDS = ["focal", "store", "external", "ghost"];
const MAX_DEPTH = 4;

const LEAF_MAX_CHARS = 16;
const LEAF_SUB_MAX_CHARS = 24;
const LEAF_PAD_X = 16;
const LEAF_MIN_W = 108;
const LEAF_MIN_H = 44;
const LEAF_LINE_H = 15;
const LEAF_SUB_LINE_H = 11;

const CONTAINER_LABEL_MAX_CHARS = 24;
const CONTAINER_SUB_MAX_CHARS = 34;
const CONTAINER_PAD_X = 24;
const CONTAINER_PAD_BOTTOM = 22;
const LABEL_TOP = 20;
const LABEL_LINE_H = 15;
const SUB_LINE_H = 11;
const LABEL_CONTENT_GAP = 16;
const GAP_X = 20;
const GAP_Y = 20;
const MAX_ROW_W = 720;
const OUTER_PAD = 20;

/** @param {string[]} lines @param {string[]} subLines @returns {number} */
function textWidth(lines, subLines) {
  return Math.max(
    0,
    ...lines.map((l) => l.length * NAME_CH),
    ...subLines.map((l) => l.length * MONO_CH),
  );
}

/** @param {NestedNode} node @returns {NestedBox} */
function measureLeaf(node) {
  const lines = wrap(node.label, LEAF_MAX_CHARS);
  const subLines = node.sub ? wrap(node.sub, LEAF_SUB_MAX_CHARS) : [];
  const w = Math.max(LEAF_MIN_W, Math.ceil(textWidth(lines, subLines)) + LEAF_PAD_X * 2);
  const textH =
    lines.length * LEAF_LINE_H + (subLines.length ? subLines.length * LEAF_SUB_LINE_H + 8 : 0);
  const h = Math.max(LEAF_MIN_H, textH + 22);
  return { node, lines, subLines, w, h, x: 0, y: 0, children: [] };
}

/** @param {NestedBox[]} boxes @returns {NestedBox[][]} */
function wrapIntoRows(boxes) {
  /** @type {NestedBox[][]} */
  const rows = [];
  /** @type {NestedBox[]} */
  let row = [];
  let rowW = 0;
  for (const box of boxes) {
    const addW = row.length ? GAP_X + box.w : box.w;
    if (row.length && rowW + addW > MAX_ROW_W) {
      rows.push(row);
      row = [];
      rowW = 0;
    }
    row.push(box);
    rowW += row.length === 1 ? box.w : GAP_X + box.w;
  }
  if (row.length) rows.push(row);
  return rows;
}

/** @param {NestedNode} node @param {NestedNode[]} kids @param {number} depth @returns {NestedBox} */
function measureContainer(node, kids, depth) {
  const kidBoxes = kids.map((k) => measure(k, depth + 1));
  const rows = wrapIntoRows(kidBoxes);
  const rowWidths = rows.map((row) => row.reduce((s, k, i) => s + (i ? GAP_X : 0) + k.w, 0));
  const rowHeights = rows.map((row) => Math.max(...row.map((k) => k.h)));
  const contentW = Math.max(...rowWidths);
  const contentH = rowHeights.reduce((s, h, i) => s + (i ? GAP_Y : 0) + h, 0);

  const labelLines = wrap(node.label, CONTAINER_LABEL_MAX_CHARS);
  const subLines = node.sub ? wrap(node.sub, CONTAINER_SUB_MAX_CHARS) : [];
  const labelTextW = Math.ceil(textWidth(labelLines, subLines));
  const labelBlockH =
    LABEL_TOP +
    (labelLines.length - 1) * LABEL_LINE_H +
    (subLines.length ? subLines.length * SUB_LINE_H + 10 : 6);
  const topInset = labelBlockH + LABEL_CONTENT_GAP;

  const w = Math.max(contentW, labelTextW) + CONTAINER_PAD_X * 2;
  const h = topInset + contentH + CONTAINER_PAD_BOTTOM;

  // Children are centred within the available content width rather than
  // left-packed, so a container whose label is wider than its children (or
  // vice versa) never leaves the layout looking lopsided.
  const availW = w - CONTAINER_PAD_X * 2;
  /** @type {{box: NestedBox, dx: number, dy: number}[]} */
  const children = [];
  let y = topInset;
  rows.forEach((row, ri) => {
    const rw = rowWidths[ri];
    let x = CONTAINER_PAD_X + (availW - rw) / 2;
    for (const kid of row) {
      children.push({ box: kid, dx: x, dy: y });
      x += kid.w + GAP_X;
    }
    y += rowHeights[ri] + GAP_Y;
  });

  return { node, lines: labelLines, subLines, w, h, x: 0, y: 0, children };
}

/** @param {NestedNode} node @param {number} depth @returns {NestedBox} */
function measure(node, depth) {
  if (depth > MAX_DEPTH) {
    throw new Error(`nested diagram exceeds max depth of ${MAX_DEPTH} at node "${node.label}"`);
  }
  if (!node.label) {
    throw new Error(`a nested node at depth ${depth} is missing a label`);
  }
  if (node.kind !== undefined && !LEAF_KINDS.includes(node.kind)) {
    throw new Error(`unknown node kind "${node.kind}" for node "${node.label}"`);
  }
  const kids = node.children ?? [];
  return kids.length === 0 ? measureLeaf(node) : measureContainer(node, kids, depth);
}

/** @param {NestedBox} box @param {number} x @param {number} y @returns {void} */
function place(box, x, y) {
  box.x = x;
  box.y = y;
  for (const child of box.children) place(child.box, x + child.dx, y + child.dy);
}

/**
 * @param {NestedBox} box
 * @param {string[]} parts
 * @param {(x: number, y: number, w: number, h: number) => void} extent
 * @returns {void}
 */
function render(box, parts, extent) {
  extent(box.x, box.y, box.w, box.h);

  if (box.children.length === 0) {
    const classes = box.node.kind ? `nb ${box.node.kind}` : "nb";
    parts.push(
      `<rect class="${classes}" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="6"/>`,
    );
    const cx = box.x + box.w / 2;
    const textTop =
      box.y +
      (box.h - (box.lines.length * LEAF_LINE_H + box.subLines.length * LEAF_SUB_LINE_H)) / 2 +
      11;
    parts.push(
      `<text class="nn" x="${cx}" y="${textTop}" text-anchor="middle">` +
        box.lines
          .map((l, i) => `<tspan x="${cx}" dy="${i === 0 ? 0 : LEAF_LINE_H}">${esc(l)}</tspan>`)
          .join("") +
        "</text>",
    );
    if (box.subLines.length) {
      const subY = textTop + (box.lines.length - 1) * LEAF_LINE_H + 12;
      parts.push(
        `<text class="ns" x="${cx}" y="${subY}" text-anchor="middle">` +
          box.subLines
            .map(
              (l, i) => `<tspan x="${cx}" dy="${i === 0 ? 0 : LEAF_SUB_LINE_H}">${esc(l)}</tspan>`,
            )
            .join("") +
          "</text>",
      );
    }
    return;
  }

  // A container is drawn as a `zone` frame, never `nb`: a nested box legitimately
  // sits INSIDE its parent's rect, and validateSvg's node-overlap check treats
  // every `nb`/`lay` pair that overlaps as a defect. `zone` is invisible to that
  // check, which is exactly what containment (as opposed to collision) needs.
  parts.push(
    `<rect class="zone" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="8"/>`,
  );
  const lx = box.x + CONTAINER_PAD_X;
  const ly = box.y + LABEL_TOP;
  parts.push(
    `<text class="nn" x="${lx}" y="${ly}">` +
      box.lines
        .map((l, i) => `<tspan x="${lx}" dy="${i === 0 ? 0 : LABEL_LINE_H}">${esc(l)}</tspan>`)
        .join("") +
      "</text>",
  );
  if (box.subLines.length) {
    const subY = ly + (box.lines.length - 1) * LABEL_LINE_H + 13;
    parts.push(
      `<text class="ns" x="${lx}" y="${subY}">` +
        box.subLines
          .map((l, i) => `<tspan x="${lx}" dy="${i === 0 ? 0 : SUB_LINE_H}">${esc(l)}</tspan>`)
          .join("") +
        "</text>",
    );
  }
  for (const child of box.children) render(child.box, parts, extent);
}

/**
 * Render a nested-containment diagram: boxes inside boxes expressing depth
 * purely through geometry, never through an arrow.
 *
 * Layout is two passes. `measure` sizes every box bottom-up, so a parent is
 * never smaller than its contents and a leaf is sized from its own wrapped
 * text. `place` then walks top-down, turning the relative offsets `measure`
 * computed into absolute coordinates. The viewBox is fitted to the actual
 * drawn extent tracked during render, not to a nominal size.
 * @param {NestedSpec} spec
 * @returns {string}
 */
export function renderNested(spec) {
  if (!spec.root) throw new Error("a nested diagram needs a root node");

  const root = measure(spec.root, 1);
  place(root, 0, 0);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  /** @param {number} x @param {number} y @param {number} w @param {number} h @returns {void} */
  const extent = (x, y, w, h) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };

  /** @type {string[]} */
  const parts = [];
  render(root, parts, extent);

  const vx = snap(minX - OUTER_PAD);
  const vy = snap(minY - OUTER_PAD);
  const vw = snap(maxX - minX + OUTER_PAD * 2);
  const vh = snap(maxY - minY + OUTER_PAD * 2);
  return assemble([
    `<svg viewBox="${vx} ${vy} ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="10"/>`,
    parts.join(""),
    "</svg>",
  ]);
}
