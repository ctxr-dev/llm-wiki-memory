import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTreemap } from "../scripts/lib/diagrams/treemap.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";
import { plotArea } from "../scripts/lib/diagrams/scale.mjs";

/** @param {string} svg @param {string} cls @returns {{x: number, y: number, w: number, h: number}[]} */
function rectsOfClass(svg, cls) {
  const out = [];
  for (const m of svg.matchAll(/<rect\b([^>]*)\/>/g)) {
    const attrs = m[1];
    const classMatch = /class="([^"]*)"/.exec(attrs);
    if (!classMatch || !classMatch[1].split(/\s+/).includes(cls)) continue;
    const num = (/** @type {string} */ name) =>
      Number(new RegExp(`${name}="(-?[\\d.]+)"`).exec(attrs)?.[1]);
    out.push({ x: num("x"), y: num("y"), w: num("width"), h: num("height") });
  }
  return out;
}

/** @param {{x:number,y:number,w:number,h:number}} a @param {{x:number,y:number,w:number,h:number}} b @returns {number} */
function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// Real category weights from this project's own wiki (knowledge/daily/...),
// deliberately wide (1061 down to 2, a 530x spread) so the smallest cells are
// genuine slivers: that is the case a treemap layout most easily gets wrong,
// and the one the acceptance bar below is built to catch.
const CELLS = [
  { label: "knowledge", value: 1061, focal: true },
  { label: "daily", value: 208 },
  { label: "investigations", value: 166 },
  { label: "plans", value: 24 },
  { label: "self_improvement", value: 9 },
  { label: "issues", value: 5 },
  { label: "state", value: 3 },
  { label: "cache", value: 2 },
];
const TOTAL_VALUE = CELLS.reduce((sum, c) => sum + c.value, 0);

const SPEC = {
  kind: "treemap",
  id: "wiki-mix",
  title: "Wiki leaves by category",
  cells: CELLS,
};

test("an 8-cell spec with a wide value spread renders with zero geometric findings", () => {
  const svg = renderTreemap(SPEC);
  assert.deepEqual(validateSvg(svg), []);
});

test("cells tile the plot area exactly: no overlap, nothing outside the bounds", () => {
  const svg = renderTreemap(SPEC);
  const plot = plotArea({ margin: { left: 40, right: 40, bottom: 40 } });
  const marks = rectsOfClass(svg, "mark");
  assert.equal(marks.length, CELLS.length, "one mark rect per cell");

  for (const m of marks) {
    assert.ok(
      m.x >= plot.x - 0.01 && m.x + m.w <= plot.x2 + 0.01,
      `x-extent inside plot: ${JSON.stringify(m)}`,
    );
    assert.ok(
      m.y >= plot.y - 0.01 && m.y + m.h <= plot.y2 + 0.01,
      `y-extent inside plot: ${JSON.stringify(m)}`,
    );
  }
  for (let i = 0; i < marks.length; i += 1) {
    for (let j = i + 1; j < marks.length; j += 1) {
      assert.equal(overlapArea(marks[i], marks[j]), 0, `cells ${i} and ${j} must not overlap`);
    }
  }
  // The gutter is the only permitted gap, so the cells must still account for
  // almost the whole plot rather than leaving stray uncovered area.
  const covered = marks.reduce((sum, m) => sum + m.w * m.h, 0);
  const budget = plot.w * plot.h;
  assert.ok(
    covered / budget > 0.99,
    `cells cover ${((covered / budget) * 100).toFixed(1)}% of the plot`,
  );
});

test("each cell's drawn area is proportional to its value, within the tolerance a real gutter costs a sliver", () => {
  const svg = renderTreemap(SPEC);
  const plot = plotArea({ margin: { left: 40, right: 40, bottom: 40 } });
  const budget = plot.w * plot.h;
  const marks = rectsOfClass(svg, "mark");

  // Rendering preserves input order (placed cells are sorted back to their
  // original index before drawing), so mark i corresponds to CELLS[i].
  marks.forEach((m, i) => {
    const trueShare = CELLS[i].value / TOTAL_VALUE;
    const drawnShare = (m.w * m.h) / budget;
    const relErr = Math.abs(drawnShare - trueShare) / trueShare;
    // A fixed-width gutter is proportionally cheapest on the biggest cell and
    // most expensive on the smallest: "cache" (2 of 1478, the worst case
    // here) actually measures under 6%. 15% leaves headroom for that
    // unavoidable sliver cost while still failing on a genuinely broken
    // layout, which misses by tens of percent or more.
    assert.ok(
      relErr < 0.15,
      `cell "${CELLS[i].label}" drawn share ${(drawnShare * 100).toFixed(2)}% vs true share ${(trueShare * 100).toFixed(2)}% (relative error ${(relErr * 100).toFixed(1)}%)`,
    );
  });
});

test("no cell's aspect ratio is worse than about 6:1", () => {
  const svg = renderTreemap(SPEC);
  const marks = rectsOfClass(svg, "mark");
  for (const m of marks) {
    const aspect = Math.max(m.w, m.h) / Math.min(m.w, m.h);
    assert.ok(aspect < 6, `aspect ratio ${aspect.toFixed(2)}:1 for cell ${JSON.stringify(m)}`);
  }
});

test("exactly one focal mark, matching the cell that set focal:true", () => {
  const svg = renderTreemap(SPEC);
  const focal = [...svg.matchAll(/<rect class="mark focal" x="([-\d.]+)" y="([-\d.]+)"/g)];
  assert.equal(focal.length, 1, "exactly one focal mark");
  const marks = rectsOfClass(svg, "mark");
  const focalIndex = CELLS.findIndex((c) => c.focal);
  assert.equal(Number(focal[0][1]), marks[focalIndex].x);
  assert.equal(Number(focal[0][2]), marks[focalIndex].y);
});

test("a cell gets a name+value label only when it is large enough to hold one", () => {
  const svg = renderTreemap(SPEC);
  const names = [...svg.matchAll(/<text class="nn"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  const values = [...svg.matchAll(/<text class="vlab[^"]*"[^>]*>([^<]*)<\/text>/g)].map(
    (m) => m[1],
  );
  // The three biggest cells are comfortably large; "plans" is a narrow but
  // tall sliver that still has enough width for its five-letter name.
  assert.deepEqual(names, ["knowledge", "daily", "investigations", "plans"]);
  assert.deepEqual(values, ["1,061", "208", "166", "24"]);
  // "self_improvement" is long enough that its own cell (bigger than several
  // labelled ones) still can't fit it on one line, so it correctly gets
  // nothing rather than an overflowing or truncated label.
  assert.ok(!svg.includes(">self_improvement<"));
  assert.ok(!svg.includes(">issues<") && !svg.includes(">state<") && !svg.includes(">cache<"));
});

test("throws naming the cell on a non-positive value", () => {
  const bad = { ...SPEC, cells: [...CELLS.slice(0, 7), { label: "cache", value: 0 }] };
  assert.throws(() => renderTreemap(bad), /cache.*non-positive/);
});

test("throws naming the cell on a non-finite value", () => {
  const bad = {
    ...SPEC,
    cells: [
      { label: "a", value: 5 },
      { label: "b", value: NaN },
    ],
  };
  assert.throws(() => renderTreemap(bad), /"b".*non-positive/);
});

test("throws when the cell count falls outside 2-12", () => {
  assert.throws(
    () => renderTreemap({ ...SPEC, cells: [{ label: "solo", value: 1 }] }),
    /2-12 cells, got 1/,
  );
  const thirteen = Array.from({ length: 13 }, (_, i) => ({ label: `c${i}`, value: i + 1 }));
  assert.throws(() => renderTreemap({ ...SPEC, cells: thirteen }), /2-12 cells, got 13/);
});

test("throws when more than one cell claims the single accent", () => {
  const twoFocal = { ...SPEC, cells: CELLS.map((c, i) => (i < 2 ? { ...c, focal: true } : c)) };
  assert.throws(() => renderTreemap(twoFocal), /2 cells focal/);
});

test("throws on a cell with no label instead of rendering a blank box", () => {
  const bad = { ...SPEC, cells: [{ value: 5 }, { label: "b", value: 2 }] };
  assert.throws(() => renderTreemap(bad), /no label/);
});
