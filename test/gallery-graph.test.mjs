import { test } from "node:test";
import assert from "node:assert/strict";
import { draw, knownKinds } from "../scripts/lib/diagrams/index.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";
import { graphExamples } from "../scripts/lib/gallery/graph.mjs";
import { graphStructureExamples } from "../scripts/lib/gallery/graph-structure.mjs";
const allGraph = [...graphExamples, ...graphStructureExamples];

for (const entry of allGraph) {
  test(`gallery entry "${entry.name}" (${entry.kind}) draws with no geometric findings`, () => {
    const svg = draw(entry.spec);
    assert.ok(svg.length > 0, "draw() must return a non-empty svg string");
    assert.deepEqual(validateSvg(svg), []);
  });
}

test("every gallery entry name is unique", () => {
  const names = allGraph.map((e) => e.name);
  assert.equal(new Set(names).size, names.length, `duplicate names in: ${names.join(", ")}`);
});

test("every gallery entry kind is a registered diagram kind", () => {
  const kinds = new Set(knownKinds());
  for (const entry of allGraph) {
    assert.ok(kinds.has(entry.kind), `"${entry.kind}" (entry "${entry.name}") is not a known kind`);
  }
});

test("every gallery entry caption is a non-empty sentence under 140 characters", () => {
  for (const entry of allGraph) {
    assert.ok(
      typeof entry.caption === "string" && entry.caption.length > 0,
      `entry "${entry.name}" has an empty caption`,
    );
    assert.ok(
      entry.caption.length < 140,
      `entry "${entry.name}" caption is ${entry.caption.length} chars, must be under 140`,
    );
  }
});

test("the graph gallery covers all ten assigned kinds exactly once", () => {
  const expected = [
    "architecture",
    "er",
    "flow",
    "flowchart",
    "nested",
    "org-chart",
    "sequence",
    "state",
    "swimlane",
    "tree",
  ];
  assert.deepEqual(allGraph.map((e) => e.kind).sort(), expected);
});
