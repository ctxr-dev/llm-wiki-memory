import { MONO_CH, NAME_CH, snap, wrap } from "./text.mjs";

/** @typedef {import("./types.mjs").Box} Box */
/** @typedef {import("./types.mjs").FlowSpec} FlowSpec */
/** @typedef {import("./types.mjs").Geom} Geom */
/** @typedef {import("./types.mjs").Rect} Rect */

/**
 * Measure every node, then resolve positions once row heights are known. Two
 * passes are unavoidable (a row's top depends on every earlier row's height),
 * but the Box is only constructed in the second, so it is never half-built.
 * @param {FlowSpec} spec
 * @returns {{ boxes: Map<string, Box>, width: number, height: number }}
 */
export function layout(spec) {
  const colW = spec.colW ?? 176;
  const colGap = spec.colGap ?? 104;
  // A zone frame is drawn 20 units ABOVE its topmost member to make room for its
  // own label, plus its padding on every side. With the bare row gap, two zones
  // in adjacent rows therefore overlap: the lower frame's top edge and label land
  // on top of the upper zone's boxes. So a zoned diagram gets a wider default
  // gap. An explicit `rowGap` still wins, because an author who sets one is
  // usually fitting a specific shape.
  const rowGap = spec.rowGap ?? ((spec.zones?.length ?? 0) > 0 ? 64 : 34);
  const padX = spec.padX ?? 28;
  const padY = spec.padY ?? 28;

  /** @type {{ node: import("./types.mjs").DiagramNode, lines: string[], subLines: string[], h: number }[]} */
  const measured = [];
  /** @type {number[]} */
  const rowHeights = [];
  for (const node of spec.nodes) {
    const lines = wrap(node.label, Math.floor((colW - 18) / NAME_CH));
    const subLines = node.sub ? wrap(node.sub, Math.floor((colW - 20) / MONO_CH)) : [];
    const h = snap(16 + lines.length * 15 + (subLines.length ? subLines.length * 11 + 4 : 0));
    rowHeights[node.row] = node.center
      ? (rowHeights[node.row] ?? 0)
      : Math.max(rowHeights[node.row] ?? 0, h);
    measured.push({ node, lines, subLines, h });
  }

  /** @type {number[]} */
  const rowTops = [];
  let y = padY + (spec.headroom ?? 0);
  for (let r = 0; r < rowHeights.length; r += 1) {
    rowTops[r] = y;
    y += (rowHeights[r] ?? 0) + rowGap;
  }

  const firstTop = rowTops[0] ?? padY;
  const lastRow = rowHeights.length - 1;
  const lastBottom = (rowTops[lastRow] ?? padY) + (rowHeights[lastRow] ?? 0);

  /** @type {Map<string, Box>} */
  const boxes = new Map();
  for (const { node, lines, subLines, h } of measured) {
    const span = node.span ?? 1;
    const colX = padX + node.col * (colW + colGap);
    const colWidth = colW * span + colGap * (span - 1);
    const rowH = node.center ? h : (rowHeights[node.row] ?? h);
    const rowY = node.center
      ? (firstTop + lastBottom) / 2 - rowH / 2 + (node.dy ?? 0)
      : (rowTops[node.row] ?? padY) + (node.dy ?? 0);

    // A dot or ringed dot is a MARKER, not a card: give it a box the size of the
    // marker, centred in its cell. With a full column-width box the edge ports
    // are computed from the cell border, so the arrow visibly starts or ends in
    // empty space a long way from the dot the reader can see.
    const marker = node.shape === "dot" ? 12 : node.shape === "end" ? 18 : 0;
    const w = marker || colWidth;
    const boxH = marker || rowH;
    const x = marker ? colX + colWidth / 2 - marker / 2 : colX;
    const boxY = marker ? rowY + rowH / 2 - marker / 2 : rowY;

    boxes.set(node.id, {
      node,
      lines,
      subLines,
      x,
      y: boxY,
      w,
      h: boxH,
      cx: x + w / 2,
      cy: boxY + boxH / 2,
    });
  }

  const maxCol = Math.max(...spec.nodes.map((n) => n.col + (n.span ?? 1) - 1));
  return {
    boxes,
    width: spec.width ?? padX * 2 + (maxCol + 1) * colW + maxCol * colGap,
    height: spec.height ?? y - rowGap + padY,
  };
}

/**
 * Choose the exit and entry points for an edge.
 *
 * The width test is the fan-in/fan-out fix: when one box spans the other (a wide
 * bar with several narrow producers above it), snapping BOTH ports to the
 * narrower box's centre keeps the run a straight vertical. Using each box's own
 * centre instead makes the line exit sideways and wrap around, which reads as a
 * relationship that is not there.
 * @param {Box} a @param {Box} b @param {"v" | "h" | "left"} side
 * @returns {Geom}
 */
export function ports(a, b, side) {
  if (side === "v") {
    const down = b.cy > a.cy;
    let sx = a.cx;
    let tx = b.cx;
    if (b.w > a.w * 1.4 && a.cx > b.x + 10 && a.cx < b.x + b.w - 10) tx = a.cx;
    else if (a.w > b.w * 1.4 && b.cx > a.x + 10 && b.cx < a.x + a.w - 10) sx = b.cx;
    return { sx, sy: down ? a.y + a.h : a.y, tx, ty: down ? b.y : b.y + b.h };
  }
  const right = b.cx > a.cx;
  return {
    sx: right ? a.x + a.w : a.x,
    sy: a.cy,
    tx: right ? b.x : b.x + b.w,
    ty: b.cy,
  };
}

/** @param {Rect} a @param {Rect} b @param {number} gap @returns {number} */
function overlapArea(a, b, gap) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + gap;
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + gap;
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Find a slot for a label near its anchor.
 *
 * Candidates are the anchor, steps along the run's own axis, steps along the
 * perpendicular, and the diagonals — then SORTED BY ACTUAL DISTANCE so the
 * nearest free slot always wins. Generating them in axis-then-diagonal order and
 * taking the first free one is not the same thing: it let a large perpendicular
 * jump be chosen over a small step, which parked a label at the far corner of
 * the diagram where no reader could tell which edge it belonged to. A label
 * adrift is worse than a label with a slight collision.
 *
 * When nothing is free it returns the LEAST-overlapping candidate rather than
 * the unshifted anchor, with drift weighted heavily enough that it never buys a
 * long excursion to shave a few square units. Giving up at the anchor is what
 * produced labels sitting squarely on node text (one measured 1078 sq units).
 * @param {number} cx @param {number} cy @param {number} w @param {number} h
 * @param {Rect[]} occupied @param {"x" | "y"} axis @param {number} [maxDrift]
 * @returns {Rect}
 */
export function place(cx, cy, w, h, occupied, axis, maxDrift = 200) {
  const stepX = w / 2 + 12;
  const stepY = h / 2 + 9;
  const ladder = [0, -1, 1, -2, 2, -3, 3];
  /** @type {{ dx: number, dy: number }[]} */
  const offsets = [];
  for (const k of ladder) {
    offsets.push(axis === "x" ? { dx: k * stepX, dy: 0 } : { dx: 0, dy: k * stepY });
  }
  for (const k of ladder) {
    if (k === 0) continue;
    offsets.push(axis === "x" ? { dx: 0, dy: k * stepY } : { dx: k * stepX, dy: 0 });
  }
  for (const kx of [-1, 1]) {
    for (const ky of [-1, 1]) offsets.push({ dx: kx * stepX, dy: ky * stepY });
  }
  // Score EVERY candidate and take the global minimum. Returning the first free
  // slot in distance order looks equivalent and is not: the measured case had a
  // free slot 69 units out and a slot 46 units out overlapping a neighbour by a
  // 20x2 sliver. First-free returns the 69 and parks the label over empty space
  // where it describes nothing; the sliver is invisible. Weighing both terms in
  // one cost keeps drift and collision commensurable, so neither is traded away
  // wholesale — which is what a hard drift cap did (it produced overlaps
  // instead) and what an uncapped first-free search did (it produced drift).
  const reachable = offsets.filter(({ dx, dy }) => Math.hypot(dx, dy) <= maxDrift);

  /** @type {{ rect: Rect, cost: number } | null} */
  let best = null;
  for (const { dx, dy } of reachable) {
    const rect = { x: cx + dx - w / 2, y: cy + dy - h / 2, w, h };
    let area = 0;
    for (const o of occupied) area += overlapArea(rect, o, 2);
    const cost = area + Math.hypot(dx, dy) * 4;
    if (!best || cost < best.cost) best = { rect, cost };
  }
  return best ? best.rect : { x: cx - w / 2, y: cy - h / 2, w, h };
}
