// Squarified treemap (Bruls, Huizing & van Wijk, 2000): area is the only
// encoding, so the layout goal is keeping every cell as close to square as
// the data allows. Processing cells in decreasing value and growing each row
// only while doing so does not worsen its own worst aspect ratio is what
// prevents the degenerate case — a plain proportional-stripe layout tiles the
// same values but turns two non-adjacent slivers into shapes a reader cannot
// compare by eye, which is the entire reason to reach for this type over a
// bar chart in the first place.
//
// Cells are separated by a gutter charged only to edges that border a
// SIBLING cell, never to edges already sitting on the plot's own frame. A
// flat inset on every edge would waste the same margin along the outer frame
// that no other chart type pays for, and the cost lands hardest on exactly
// the cells a reader can least afford to lose area from: the smallest ones,
// where even a fraction of a pixel is a double-digit percentage of the cell.

import { assemble, esc, snap, NAME_CH, MONO_CH } from "./text.mjs";
import { plotArea, VIEW } from "./scale.mjs";

/** @typedef {import("./types.mjs").Rect} Rect */

/**
 * @typedef {Object} TreemapCell
 * @property {string} label
 * @property {number} value must be finite and greater than zero — area
 *   encodes value directly, so a zero or negative cell cannot be drawn
 * @property {boolean} [focal] the one editorially-focal cell, not
 *   necessarily the largest; at most one cell per chart may set this
 */

/**
 * @typedef {Object} TreemapSpec
 * @property {"treemap"} kind
 * @property {string} id
 * @property {string} title becomes the SVG's aria-label
 * @property {TreemapCell[]} cells 2-12 cells; group a long tail into one
 *   explicit "Other" cell upstream rather than passing 13+ slivers
 */

/** @typedef {{ cell: TreemapCell, index: number, area: number }} SizedCell */
/** @typedef {SizedCell & Rect} PlacedCell */

const MIN_CELLS = 2;
const MAX_CELLS = 12;
// Total visible gap at an interior seam (half charged to each side of it).
// Kept small deliberately: `squarify` alone tiles with zero proportional
// error, so every unit of gutter is pure, avoidable distortion on whichever
// cell is smallest — see the module doc comment.
const GUTTER = 1;
const CELL_PAD = 8;
const NAME_LINE_H = 14;
const VALUE_LINE_H = 11;
const LABEL_GAP = 3;
// The rank ramp cycles rather than caps: unlike a line or scatter series, a
// cell's identity comes from the label drawn on it, not from its color, so
// reusing s1..s4 past the fourth-ranked cell is never ambiguous.
const RANK_PALETTE = 4;

/**
 * The worst (largest) aspect ratio among the rectangles that laying `areas`
 * out against a strip of length `edge` would produce. `edge` is the SHORTER
 * side of the rectangle currently being filled (see `squarify`): the row's
 * shared thickness is `sum/edge`, so an item's own ratio is pinned by how far
 * its area sits from that thickness squared, which is why only the row's max
 * and min area — not every item — decide the worst case.
 * @param {number[]} areas
 * @param {number} edge
 * @returns {number}
 */
function worstRatio(areas, edge) {
  const sum = areas.reduce((a, b) => a + b, 0);
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  return Math.max((edge * edge * max) / (sum * sum), (sum * sum) / (edge * edge * min));
}

/**
 * Lay one row against the shorter side of `rect` — a vertical slice spanning
 * the full height when `rect` is wider than it is tall, a horizontal slice
 * spanning the full width otherwise — then return whatever rectangle is left
 * for the next row.
 * @param {SizedCell[]} row
 * @param {Rect} rect
 * @returns {{ placed: PlacedCell[], rest: Rect }}
 */
function layoutRow(row, rect) {
  const { x, y, w, h } = rect;
  const rowSum = row.reduce((s, it) => s + it.area, 0);
  /** @type {PlacedCell[]} */
  const placed = [];
  if (w >= h) {
    const sliceW = rowSum / h;
    let cy = y;
    for (const it of row) {
      const itemH = it.area / sliceW;
      placed.push({ ...it, x, y: cy, w: sliceW, h: itemH });
      cy += itemH;
    }
    return { placed, rest: { x: x + sliceW, y, w: w - sliceW, h } };
  }
  const sliceH = rowSum / w;
  let cx = x;
  for (const it of row) {
    const itemW = it.area / sliceH;
    placed.push({ ...it, x: cx, y, w: itemW, h: sliceH });
    cx += itemW;
  }
  return { placed, rest: { x, y: y + sliceH, w, h: h - sliceH } };
}

/**
 * Squarify `items` into `rect`: process in decreasing area, growing the
 * current row for as long as adding the next item does not worsen the row's
 * own worst aspect ratio, then lay that row out and recurse on whatever
 * rectangle remains.
 * @param {SizedCell[]} items sorted by decreasing `area`; every area must be > 0
 * @param {Rect} rect
 * @returns {PlacedCell[]}
 */
function squarify(items, rect) {
  /** @type {PlacedCell[]} */
  const out = [];
  let remaining = items;
  let current = rect;
  while (remaining.length > 0) {
    const edge = Math.min(current.w, current.h);
    let row = [remaining[0]];
    let i = 1;
    while (i < remaining.length) {
      const candidate = [...row, remaining[i]];
      const worstOf = (/** @type {SizedCell[]} */ r) =>
        worstRatio(
          r.map((it) => it.area),
          edge,
        );
      if (worstOf(candidate) > worstOf(row)) break;
      row = candidate;
      i += 1;
    }
    const { placed, rest } = layoutRow(row, current);
    out.push(...placed);
    remaining = remaining.slice(row.length);
    current = rest;
  }
  return out;
}

/**
 * Shrink a placed cell by half the gutter on each edge that borders a
 * sibling cell, leaving edges that border the plot's own frame untouched.
 * Final dimensions are floored well above zero: only a value skew so extreme
 * that a cell's ideal size already approaches the gutter itself could drive
 * this negative, and a barely-visible sliver is still preferable to invalid
 * (negative-size) SVG geometry.
 * @param {Rect} rect
 * @param {Rect} plot
 * @returns {Rect}
 */
function insetCell(rect, plot) {
  const half = GUTTER / 2;
  const eps = 0.01;
  const left = Math.abs(rect.x - plot.x) < eps ? 0 : half;
  const top = Math.abs(rect.y - plot.y) < eps ? 0 : half;
  const right = Math.abs(rect.x + rect.w - (plot.x + plot.w)) < eps ? 0 : half;
  const bottom = Math.abs(rect.y + rect.h - (plot.y + plot.h)) < eps ? 0 : half;
  return {
    x: rect.x + left,
    y: rect.y + top,
    w: Math.max(0.25, rect.w - left - right),
    h: Math.max(0.25, rect.h - top - bottom),
  };
}

/** @param {number} value @returns {string} */
function formatValue(value) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * Decide whether a drawn cell has room for its name, and separately for a
 * value line beneath it. Both are single-line width tests, mirroring the
 * pyramid slab check: a treemap cell is sized by its VALUE, not by its
 * label, so a label that does not fit is dropped rather than wrapped or
 * shrunk — a wrapped label would just as easily overflow an undersized cell.
 * @param {number} w @param {number} h @param {string} name @param {string} valueText
 * @returns {{ name: boolean, value: boolean }}
 */
function fitLabel(w, h, name, valueText) {
  const innerW = w - CELL_PAD * 2;
  const name_ = innerW >= name.length * NAME_CH && h >= CELL_PAD * 2 + NAME_LINE_H;
  const value_ =
    name_ &&
    innerW >= valueText.length * MONO_CH &&
    h >= CELL_PAD * 2 + NAME_LINE_H + LABEL_GAP + VALUE_LINE_H;
  return { name: name_, value: value_ };
}

/**
 * Render a squarified treemap: one `<rect class="mark">` per cell, tiling the
 * plot exactly, sized so area is proportional to value.
 * @param {TreemapSpec} spec
 * @returns {string}
 */
export function renderTreemap(spec) {
  const cells = spec.cells;
  if (!Array.isArray(cells) || cells.length < MIN_CELLS || cells.length > MAX_CELLS) {
    const got = Array.isArray(cells) ? cells.length : 0;
    throw new Error(
      `treemap "${spec.id}" needs ${MIN_CELLS}-${MAX_CELLS} cells, got ${got}; group a long tail into one "Other" cell`,
    );
  }
  let focalCount = 0;
  for (const cell of cells) {
    if (!cell.label) {
      throw new Error(`treemap "${spec.id}" has a cell with no label`);
    }
    if (!Number.isFinite(cell.value) || cell.value <= 0) {
      throw new Error(
        `treemap "${spec.id}" cell "${cell.label}" has a non-positive value (${cell.value}); a zero-area cell cannot be drawn`,
      );
    }
    if (cell.focal) focalCount += 1;
  }
  if (focalCount > 1) {
    throw new Error(
      `treemap "${spec.id}" marks ${focalCount} cells focal; at most one accent is allowed per chart`,
    );
  }

  // No axis, so the shared cartesian left gutter (sized for y-axis tick
  // labels) buys nothing here; a symmetric margin gives every cell back that
  // space instead of leaving it blank.
  const plot = plotArea({ margin: { left: 40, right: 40, bottom: 40 } });
  const totalValue = cells.reduce((sum, cell) => sum + cell.value, 0);
  const areaBudget = plot.w * plot.h;

  /** @type {SizedCell[]} */
  const sized = cells
    .map((cell, index) => ({ cell, index, area: (cell.value / totalValue) * areaBudget }))
    .sort((a, b) => b.area - a.area);

  /** @type {Map<number, string>} */
  const rankClass = new Map();
  let rank = 0;
  for (const s of sized) {
    if (s.cell.focal) continue;
    rankClass.set(s.index, `s${(rank % RANK_PALETTE) + 1}`);
    rank += 1;
  }

  const placed = squarify(sized, { x: plot.x, y: plot.y, w: plot.w, h: plot.h });
  placed.sort((a, b) => a.index - b.index);

  /** @type {string[]} */
  const parts = [];
  for (const p of placed) {
    const cell = p.cell;
    const box = insetCell(p, plot);
    const cls = cell.focal ? "mark focal" : `mark ${rankClass.get(p.index) ?? "s1"}`;
    parts.push(
      `<rect class="${cls}" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}"/>`,
    );

    const valueText = formatValue(cell.value);
    const fit = fitLabel(box.w, box.h, cell.label, valueText);
    if (fit.name) {
      const tx = box.x + CELL_PAD;
      const nameY = box.y + CELL_PAD + 10;
      parts.push(`<text class="nn" x="${tx}" y="${nameY}">${esc(cell.label)}</text>`);
      if (fit.value) {
        const vcls = cell.focal ? "vlab focal" : "vlab";
        parts.push(
          `<text class="${vcls}" x="${tx}" y="${nameY + NAME_LINE_H}">${esc(valueText)}</text>`,
        );
      }
    }
  }

  // Fixed to the nominal plot rather than a tracked extent: every cell is
  // placed by `squarify` strictly inside `plot`, and `insetCell` only ever
  // shrinks a cell inward, so nothing drawn here can reach past VIEW's edge.
  const vw = snap(VIEW.w);
  const vh = snap(VIEW.h);
  return assemble([
    `<svg viewBox="0 0 ${vw} ${vh}" role="img" aria-label="${esc(spec.title)}">`,
    `<rect class="bg" x="0" y="0" width="${vw}" height="${vh}" rx="10"/>`,
    parts.join(""),
    "</svg>",
  ]);
}
