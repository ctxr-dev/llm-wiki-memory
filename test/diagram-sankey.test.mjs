import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSankey } from "../scripts/lib/diagrams/sankey.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

/** @param {string} svg @param {string} cls @returns {{x: number, y: number, w: number, h: number}[]} */
function rectsOfClass(svg, cls) {
  /** @type {{x: number, y: number, w: number, h: number}[]} */
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

/**
 * Parse a ribbon path back into its geometric parameters: the column x each
 * end sits at, and the [top,bottom] pixel offsets at that end. Relies on the
 * renderer's fixed `M C L C Z` token order (see `ribbonPath` in sankey.mjs).
 * @param {string} svg
 * @returns {{ sx: number, sy: [number, number], tx: number, ty: [number, number], focal: boolean }[]}
 */
function ribbons(svg) {
  /** @type {{ sx: number, sy: [number, number], tx: number, ty: [number, number], focal: boolean }[]} */
  const out = [];
  for (const m of svg.matchAll(/<path\b([^>]*)\/>/g)) {
    const attrs = m[1];
    if (!/class="([^"]*)"/.exec(attrs)?.[1].split(/\s+/).includes("flow")) continue;
    const d = /\bd="([^"]+)"/.exec(attrs)?.[1] ?? "";
    const pairs = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((p) => [
      Number(p[1]),
      Number(p[2]),
    ]);
    const sx = pairs[0][0];
    const sy = [Math.min(pairs[0][1], pairs[7][1]), Math.max(pairs[0][1], pairs[7][1])];
    const tx = pairs[3][0];
    const ty = [Math.min(pairs[3][1], pairs[4][1]), Math.max(pairs[3][1], pairs[4][1])];
    out.push({ sx, sy, tx, ty, focal: /class="[^"]*\bfocal\b/.test(attrs) });
  }
  return out;
}

const THREE_LAYER_SPEC = {
  kind: "sankey",
  id: "pipeline",
  title: "Memory capture pipeline",
  nodes: [
    { id: "turns", label: "turns", layer: 0 },
    { id: "replays", label: "replays", layer: 0 },
    { id: "captured", label: "captured", layer: 1 },
    { id: "skipped", label: "skipped", layer: 1 },
    { id: "consolidated", label: "consolidated", layer: 2 },
    { id: "pending", label: "pending", layer: 2 },
  ],
  flows: [
    { from: "turns", to: "captured", value: 2000, focal: false },
    { from: "turns", to: "skipped", value: 400 },
    { from: "replays", to: "captured", value: 500, focal: true },
    { from: "replays", to: "skipped", value: 100 },
    { from: "captured", to: "consolidated", value: 2500 },
    { from: "skipped", to: "pending", value: 500 },
  ],
};

test("3 layers, 6 nodes, 6 balanced flows renders with zero geometric findings", () => {
  const svg = renderSankey(THREE_LAYER_SPEC);
  assert.deepEqual(validateSvg(svg), []);
});

test("one node bar is drawn per node, and node bars never overlap within a layer", () => {
  const svg = renderSankey(THREE_LAYER_SPEC);
  const bars = rectsOfClass(svg, "nb");
  assert.equal(bars.length, THREE_LAYER_SPEC.nodes.length);
  const byX = new Map();
  for (const bar of bars) {
    for (const other of byX.get(bar.x) ?? []) {
      const overlap = Math.min(bar.y + bar.h, other.y + other.h) - Math.max(bar.y, other.y);
      assert.ok(overlap <= 0, `bars in the same column at x=${bar.x} overlap by ${overlap}`);
    }
    byX.set(bar.x, [...(byX.get(bar.x) ?? []), bar]);
  }
});

test("one ribbon is drawn per flow, and exactly one carries the focal class", () => {
  const svg = renderSankey(THREE_LAYER_SPEC);
  const bands = ribbons(svg);
  assert.equal(bands.length, THREE_LAYER_SPEC.flows.length);
  const focalCount = bands.filter((b) => b.focal).length;
  assert.equal(focalCount, 1);
});

test("every ribbon stays within the vertical span of the two node bars it connects", () => {
  const svg = renderSankey(THREE_LAYER_SPEC);
  const bars = rectsOfClass(svg, "nb");
  const overallTop = Math.min(...bars.map((b) => b.y));
  const overallBottom = Math.max(...bars.map((b) => b.y + b.h));
  for (const r of ribbons(svg)) {
    for (const y of [...r.sy, ...r.ty]) {
      assert.ok(
        y >= overallTop - 1 && y <= overallBottom + 1,
        `ribbon coordinate y=${y} falls outside every node's vertical span [${overallTop},${overallBottom}]`,
      );
    }
  }
});

test("each node's outgoing ribbons exactly tile its own bar height, with no gap or overlap", () => {
  const svg = renderSankey(THREE_LAYER_SPEC);
  const bars = rectsOfClass(svg, "nb");
  // "turns" is the topmost bar in layer 0 (x=130): its two outgoing ribbons
  // (to captured, to skipped) must cover its own height exactly.
  const turns = bars.find(
    (b) => b.x === 130 && b.y === Math.min(...bars.filter((c) => c.x === 130).map((c) => c.y)),
  );
  assert.ok(turns);
  const spans = ribbons(svg)
    .filter(
      (r) => r.sx === turns.x + 12 && r.sy[0] >= turns.y - 1 && r.sy[1] <= turns.y + turns.h + 1,
    )
    .map((r) => r.sy)
    .sort((a, b) => a[0] - b[0]);
  assert.equal(spans.length, 2, "turns has exactly 2 outgoing flows");
  assert.ok(Math.abs(spans[0][0] - turns.y) <= 1, "first ribbon starts at the bar's own top");
  assert.ok(
    Math.abs(spans[0][1] - spans[1][0]) <= 1,
    "ribbons are contiguous, with no gap between them",
  );
  assert.ok(
    Math.abs(spans[1][1] - (turns.y + turns.h)) <= 1,
    "last ribbon ends at the bar's own bottom",
  );
});

test("a flow crossing a non-adjacent layer fails loudly", () => {
  const spec = {
    ...THREE_LAYER_SPEC,
    flows: [...THREE_LAYER_SPEC.flows, { from: "turns", to: "consolidated", value: 10 }],
  };
  assert.throws(() => renderSankey(spec), /adjacent layers/);
});

test("a node whose inflow and outflow disagree fails loudly, naming the node", () => {
  const spec = {
    ...THREE_LAYER_SPEC,
    flows: THREE_LAYER_SPEC.flows.map((f) =>
      f.from === "captured" && f.to === "consolidated" ? { ...f, value: 999 } : f,
    ),
  };
  assert.throws(() => renderSankey(spec), /"captured" does not balance/);
});

test("a flow referencing an unknown node fails loudly", () => {
  const spec = {
    ...THREE_LAYER_SPEC,
    flows: [...THREE_LAYER_SPEC.flows, { from: "turns", to: "ghost", value: 5 }],
  };
  assert.throws(() => renderSankey(spec), /unknown node "ghost"/);
});

test("a duplicate node id fails loudly", () => {
  const spec = {
    ...THREE_LAYER_SPEC,
    nodes: [...THREE_LAYER_SPEC.nodes, { id: "turns", label: "dup", layer: 0 }],
  };
  assert.throws(() => renderSankey(spec), /duplicate sankey node id "turns"/);
});

test("a node with a layer outside 0-2 fails loudly", () => {
  const spec = {
    ...THREE_LAYER_SPEC,
    nodes: THREE_LAYER_SPEC.nodes.map((n) => (n.id === "turns" ? { ...n, layer: 3 } : n)),
  };
  assert.throws(() => renderSankey(spec), /expected 0, 1 or 2/);
});

test("a spec with no node in one of the 3 layers fails loudly", () => {
  const spec = {
    ...THREE_LAYER_SPEC,
    nodes: THREE_LAYER_SPEC.nodes.filter((n) => n.id !== "turns" && n.id !== "replays"),
    flows: THREE_LAYER_SPEC.flows.filter((f) => f.from !== "turns" && f.from !== "replays"),
  };
  assert.throws(() => renderSankey(spec), /at least one node in layer 0/);
});

test("more than 8 nodes fails loudly", () => {
  const extra = ["x1", "x2", "x3"].map((id) => ({ id, label: id, layer: 1 }));
  const spec = { ...THREE_LAYER_SPEC, nodes: [...THREE_LAYER_SPEC.nodes, ...extra] };
  assert.throws(() => renderSankey(spec), /at most 8 nodes/);
});

test("more than 12 flows fails loudly", () => {
  const extra = Array.from({ length: 7 }, (_, i) => ({
    from: "turns",
    to: "captured",
    value: 1 + i,
  }));
  const spec = { ...THREE_LAYER_SPEC, flows: [...THREE_LAYER_SPEC.flows, ...extra] };
  assert.throws(() => renderSankey(spec), /at most 12 flows/);
});

test("a node with no flows at all fails loudly", () => {
  const spec = {
    ...THREE_LAYER_SPEC,
    nodes: [...THREE_LAYER_SPEC.nodes, { id: "orphan", label: "orphan", layer: 1 }],
  };
  assert.throws(() => renderSankey(spec), /"orphan" has no flows at all/);
});
