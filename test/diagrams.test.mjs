import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble, wrap } from "../scripts/lib/diagrams/text.mjs";
import { place } from "../scripts/lib/diagrams/geometry.mjs";
import { clearExitX, runCrosses } from "../scripts/lib/diagrams/routing.mjs";
import { registerRenderer, rendererFor, knownKinds } from "../scripts/lib/diagrams/registry.mjs";
import { draw, block, drawChecked } from "../scripts/lib/diagrams/index.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

test("assemble refuses a blank line, which would truncate the diagram in markdown", () => {
  // A blank line ENDS an HTML block in CommonMark, so the leaf renders the first
  // half of the SVG and silently drops the rest. This guard is the only thing
  // standing between a malformed fragment and a diagram that vanishes on save.
  assert.throws(() => assemble(["<svg>", "<rect/>\n\n<rect/>", "</svg>"]), /blank line/);
  assert.throws(() => assemble(["<svg>", "<rect/>\n \t \n<rect/>", "</svg>"]), /blank line/);
});

test("assemble joins with single newlines and drops empty fragments", () => {
  assert.equal(assemble(["<svg>", "", undefined, "<rect/>", "</svg>"]), "<svg>\n<rect/>\n</svg>");
});

test("wrap breaks long dotted identifiers at . - _ / boundaries", () => {
  const lines = wrap("core.fct.captured-order.1", 12);
  assert.ok(lines.length > 1, "a long topic name must wrap");
  for (const l of lines) assert.ok(l.length <= 14, `line too long: ${l}`);
  assert.equal(lines.join(""), "core.fct.captured-order.1");
});

test("wrap honours explicit newlines and never returns an empty array", () => {
  assert.deepEqual(wrap("a\nb", 40), ["a", "b"]);
  assert.deepEqual(wrap("", 40), [""]);
});

test("place returns a free slot when one exists, preferring the anchor", () => {
  const free = place(100, 100, 40, 20, [], "y");
  assert.deepEqual(free, { x: 80, y: 90, w: 40, h: 20 });
});

test("place falls back to LEAST overlap, not to the anchor, when nothing is free", () => {
  // Regression: the old ladder gave up and returned the anchor, which is how
  // labels ended up sitting squarely on node text (one measured 1078 sq units).
  const blocker = { x: 80, y: 90, w: 40, h: 20 };
  const near = [blocker];
  const chosen = place(100, 100, 40, 20, near, "y");
  const overlapW = Math.min(chosen.x + 40, blocker.x + 40) - Math.max(chosen.x, blocker.x);
  const overlapH = Math.min(chosen.y + 20, blocker.y + 20) - Math.max(chosen.y, blocker.y);
  const area = overlapW > 0 && overlapH > 0 ? overlapW * overlapH : 0;
  assert.ok(area < 40 * 20, "must not return the fully-overlapping anchor slot");
});

test("runCrosses detects a vertical run passing through an intervening box", () => {
  const box = { x: 28, y: 236, w: 168, h: 72 };
  const through = { sx: 112, sy: 346, tx: 376, ty: 100 };
  assert.equal(runCrosses(through, "v", box), true);
  const beside = { sx: 500, sy: 346, tx: 520, ty: 100 };
  assert.equal(runCrosses(beside, "v", box), false);
});

test("clearExitX steps outside the box when a sibling sits directly below", () => {
  const src = { x: 572, y: 28, w: 172, h: 60, cx: 658, cy: 58, node: {}, lines: [], subLines: [] };
  const below = { x: 572, y: 126, w: 172, h: 76 };
  const x = clearExitX(src, [below], 88, 228);
  assert.notEqual(x, src.cx, "the centre descent is blocked and must be avoided");
  assert.ok(x < below.x || x > below.x + below.w, `x=${x} still inside the blocker`);
  assert.equal(clearExitX(src, [], 88, 228), src.cx, "an unblocked descent keeps the centre");
});

test("the registry rejects an unknown kind and names what it knows", () => {
  assert.ok(knownKinds().includes("flow"));
  assert.ok(knownKinds().includes("sequence"));
  assert.throws(() => rendererFor("nope"), /unknown diagram kind "nope".*flow/s);
});

test("the registry refuses a duplicate registration", () => {
  assert.throws(() => registerRenderer("flow", () => ""), /registered twice/);
});

const SPEC = {
  id: "t",
  title: "Test flow",
  nodes: [
    { id: "a", col: 0, row: 0, label: "producer" },
    { id: "b", col: 0, row: 1, label: "store", kind: "store" },
    { id: "c", col: 0, row: 2, label: "consumer", kind: "focal" },
    { id: "d", col: 1, row: 0, label: "sink" },
  ],
  edges: [
    { from: "a", to: "b", label: "write raw order", kind: "store" },
    { from: "b", to: "c", label: "change data capture", kind: "async" },
    { from: "c", to: "d", label: "gRPC fetch: id to state" },
  ],
};

test("a flow spec renders one svg with a node box and a label per edge", () => {
  const svg = draw(SPEC);
  assert.match(svg, /^<svg viewBox="/);
  assert.match(svg, /<\/svg>$/);
  assert.equal((svg.match(/<rect class="nb /g) ?? []).length, 4);
  assert.equal((svg.match(/<rect class="emask"/g) ?? []).length, 3);
  assert.ok(svg.includes("change data capture"), "edge labels must reach the output");
  assert.ok(svg.includes('marker-end="url(#t-a)"'), "markers are namespaced by spec id");
});

test("a rendered flow has no geometric findings", () => {
  const { findings } = drawChecked(SPEC);
  assert.deepEqual(findings, [], `expected a clean diagram, got ${JSON.stringify(findings)}`);
});

test("an edge to an unknown node fails loudly rather than drawing a partial diagram", () => {
  assert.throws(
    () => draw({ ...SPEC, edges: [{ from: "a", to: "ghost" }] }),
    /unknown edge endpoint a->ghost/,
  );
});

test("block wraps the svg in the themed container with no blank line", () => {
  const out = block(SPEC);
  assert.match(out, /^<div class="dd">\n<svg /);
  assert.match(out, /<\/svg>\n<\/div>$/);
  assert.ok(!/\n[ \t]*\n/.test(out), "a blank line would truncate the html block");
});

test("validateSvg reports each defect class it is responsible for", () => {
  const overlap =
    '<svg viewBox="0 0 200 200"><rect class="nb backend" x="10" y="10" width="80" height="40"/>' +
    '<rect class="emask" x="20" y="20" width="40" height="20"/></svg>';
  assert.ok(validateSvg(overlap).some((f) => f.kind === "label-over-node"));

  const nodes =
    '<svg viewBox="0 0 200 200"><rect class="nb backend" x="10" y="10" width="80" height="40"/>' +
    '<rect class="nb backend" x="50" y="20" width="80" height="40"/></svg>';
  assert.ok(validateSvg(nodes).some((f) => f.kind === "node-overlap"));

  const clipped =
    '<svg viewBox="0 0 50 50"><rect class="nb backend" x="10" y="10" width="200" height="40"/></svg>';
  assert.ok(validateSvg(clipped).some((f) => f.kind === "clipped"));

  assert.ok(validateSvg(`<svg viewBox="0 0 10 10"></svg>`).some((f) => f.kind === "empty"));
});

test("validateSvg flags a run through a third node but not one touching its endpoints", () => {
  const cutting =
    '<svg viewBox="0 0 400 400">' +
    '<rect class="nb backend" x="10" y="10" width="100" height="40"/>' +
    '<rect class="nb backend" x="10" y="100" width="100" height="40"/>' +
    '<rect class="nb backend" x="10" y="200" width="100" height="40"/>' +
    '<path class="e async" d="M60,200 V50"/></svg>';
  assert.ok(
    validateSvg(cutting).some((f) => f.kind === "edge-through-node"),
    "a run from row 3 to row 1 crosses row 2 and must be reported",
  );

  const adjacent =
    '<svg viewBox="0 0 400 400">' +
    '<rect class="nb backend" x="10" y="10" width="100" height="40"/>' +
    '<rect class="nb backend" x="10" y="100" width="100" height="40"/>' +
    '<path class="e" d="M60,50 V100"/></svg>';
  assert.deepEqual(
    validateSvg(adjacent).filter((f) => f.kind === "edge-through-node"),
    [],
  );
});

test("a sequence spec renders actor heads, lifelines and one run per step", () => {
  const svg = draw({
    kind: "sequence",
    id: "s",
    title: "Test sequence",
    actors: [
      { id: "x", label: "caller" },
      { id: "y", label: "service", sub: "ns core" },
    ],
    steps: [
      { phase: "request" },
      { from: "x", to: "y", label: "HTTP POST /convert" },
      { from: "y", to: "y", label: "validate", kind: "focal" },
      { note: "retried on 425", over: ["x", "y"] },
    ],
  });
  assert.equal((svg.match(/<line class="life"/g) ?? []).length, 2);
  assert.equal((svg.match(/<rect class="nb /g) ?? []).length, 2);
  assert.ok(svg.includes("HTTP POST /convert"));
  assert.ok(svg.includes("retried on 425"));
  assert.ok(svg.includes("REQUEST"), "a phase divider is upper-cased");
});

test("a sequence step naming an unknown actor fails loudly", () => {
  assert.throws(
    () =>
      draw({
        kind: "sequence",
        id: "s",
        title: "t",
        actors: [{ id: "x", label: "caller" }],
        steps: [{ from: "x", to: "ghost", label: "call" }],
      }),
    /unknown actor in x->ghost/,
  );
});

test("the registry exposes every implemented kind", () => {
  // Generated from the registry, so this list grows as kinds are added; the
  // rule table is kept in step by test/diagram-docs.test.mjs.
  assert.deepEqual(knownKinds(), [
    "architecture",
    "bar",
    "er",
    "fishbone",
    "flow",
    "flowchart",
    "gantt",
    "high-level",
    "kanban",
    "layers",
    "line",
    "loop",
    "medallion",
    "nested",
    "org-chart",
    "polar",
    "pyramid",
    "quadrant",
    "radar",
    "sankey",
    "scatter",
    "sequence",
    "state",
    "swimlane",
    "timeline",
    "tree",
    "treemap",
    "venn",
    "wardley",
  ]);
});

test("a flowchart renders shape-carried node types, never colour-carried", () => {
  const svg = draw({
    kind: "flowchart",
    id: "f",
    title: "Triage",
    nodes: [
      { id: "s", col: 0, row: 0, label: "start", shape: "terminator" },
      { id: "d", col: 0, row: 1, label: "paying?", shape: "diamond" },
      { id: "e", col: 0, row: 2, label: "done", shape: "terminator" },
    ],
    edges: [
      { from: "s", to: "d" },
      { from: "d", to: "e", label: "yes" },
    ],
  });
  assert.equal((svg.match(/<polygon class="nb /g) ?? []).length, 1, "the decision is a diamond");
});

test("a state machine gives markers a marker-sized box so arrows reach them", () => {
  // Regression: with a full column-width box the initial arrow visibly started
  // in empty space, a long way from the dot a reader can see.
  const svg = draw({
    kind: "state",
    id: "s",
    title: "Lifecycle",
    nodes: [
      { id: "i", col: 0, row: 0, label: "", shape: "dot" },
      { id: "a", col: 1, row: 0, label: "active" },
      { id: "f", col: 2, row: 0, label: "", shape: "end" },
    ],
    edges: [
      { from: "i", to: "a" },
      { from: "a", to: "f" },
    ],
  });
  const dot = /<circle class="dot" cx="([\d.]+)" cy="([\d.]+)" r="5"\/>/.exec(svg);
  assert.ok(dot, "the initial marker is a filled dot");
  const firstRun = /<path class="e[^"]*" d="M([\d.]+),/.exec(svg);
  assert.ok(firstRun, "an edge leaves the marker");
  const gap = Math.abs(Number(firstRun[1]) - Number(dot[1]));
  assert.ok(gap < 12, `the run must start at the dot, not the cell border (gap ${gap})`);
  assert.equal((svg.match(/<circle class="ring"/g) ?? []).length, 1, "the final state is ringed");
});

test("a self-transition loops to the SIDE and keeps its label beside the loop", () => {
  // Regression: looping ABOVE put the label in the same band as the incoming
  // edge's label; capping drift gave a 522 sq unit collision, letting it drift
  // parked it over the previous box.
  const svg = draw({
    kind: "state",
    id: "s",
    title: "Retry",
    nodes: [
      { id: "a", col: 0, row: 0, label: "queued" },
      { id: "b", col: 0, row: 1, label: "running" },
    ],
    edges: [
      { from: "a", to: "b", label: "start / dequeue" },
      { from: "b", to: "b", label: "retry [timeout]", kind: "async" },
    ],
  });
  assert.ok(svg.includes("retry [timeout]"));
  assert.deepEqual(validateSvg(svg), [], "the loop label must not collide with the entry label");
});

test("a layer stack renders one full-width band per layer, all at the same x", () => {
  const svg = draw({
    kind: "layers",
    id: "l",
    title: "Stack",
    direction: { label: "abstraction", up: true },
    layers: [
      { tag: "L1", name: "top", note: "outermost" },
      { tag: "L0", name: "bottom", focal: true },
    ],
  });
  const bands = [...svg.matchAll(/<rect class="lay[^"]*" x="([\d.]+)"[^>]*width="([\d.]+)"/g)];
  assert.equal(bands.length, 2);
  assert.equal(bands[0][1], bands[1][1], "bands share an x");
  assert.equal(bands[0][2], bands[1][2], "bands share a width");
  assert.match(svg, /class="lay[^"]*focal"/, "the focal band is marked");
  // Regression: a horizontal direction label ran past x=0 and rendered clipped
  // as "RACTION".
  assert.match(svg, /transform="rotate\(-90 /, "the direction label runs with its axis");
  assert.deepEqual(validateSvg(svg), []);
});

test("a tree uses orthogonal connectors and centres a parent over its children", () => {
  const svg = draw({
    kind: "tree",
    id: "t",
    title: "Hierarchy",
    nodes: [
      { id: "r", label: "root" },
      { id: "a", parent: "r", label: "left" },
      { id: "b", parent: "r", label: "right" },
    ],
  });
  const buses = [...svg.matchAll(/<path class="bus" d="M([\d.]+),([\d.]+) ([HV])([\d.]+)"/g)];
  assert.ok(buses.length >= 4, "a drop, a sibling bus, and one drop per child");
  assert.equal((svg.match(/<rect class="nb /g) ?? []).length, 3);
  assert.deepEqual(validateSvg(svg), []);
});

test("a tree with an unknown parent fails loudly", () => {
  assert.throws(
    () =>
      draw({
        kind: "tree",
        id: "t",
        title: "t",
        nodes: [{ id: "a", parent: "ghost", label: "orphan" }],
      }),
    /unknown tree parent ghost/,
  );
});
