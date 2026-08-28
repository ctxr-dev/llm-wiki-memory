import { test } from "node:test";
import assert from "node:assert/strict";
import { chartsExamples } from "../scripts/lib/gallery/charts.mjs";
import { draw, knownKinds } from "../scripts/lib/diagrams/index.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

test("every chart example renders with zero geometric findings", () => {
  for (const entry of chartsExamples) {
    let svg;
    assert.doesNotThrow(() => {
      svg = draw(entry.spec);
    }, `"${entry.name}" (${entry.kind}) threw while rendering`);
    assert.deepEqual(
      validateSvg(svg),
      [],
      `"${entry.name}" (${entry.kind}) has geometric findings`,
    );
  }
});

test("every example name is unique", () => {
  const names = chartsExamples.map((e) => e.name);
  assert.equal(new Set(names).size, names.length, "duplicate name slug in chartsExamples");
});

test("every example kind is a registered diagram kind", () => {
  const known = new Set(knownKinds());
  for (const entry of chartsExamples) {
    assert.ok(known.has(entry.kind), `"${entry.name}" uses unregistered kind "${entry.kind}"`);
  }
});

test("every caption is a short, non-empty plain sentence", () => {
  for (const entry of chartsExamples) {
    assert.ok(entry.caption.length > 0, `"${entry.name}" has an empty caption`);
    assert.ok(
      entry.caption.length < 140,
      `"${entry.name}" caption is ${entry.caption.length} chars, expected under 140`,
    );
  }
});

test("the 10 assigned chart kinds are all covered", () => {
  const expected = [
    "bar",
    "line",
    "scatter",
    "gantt",
    "radar",
    "polar",
    "pyramid",
    "treemap",
    "venn",
    "sankey",
  ];
  const covered = new Set(chartsExamples.map((e) => e.kind));
  for (const kind of expected) {
    assert.ok(covered.has(kind), `no gallery example covers kind "${kind}"`);
  }
});
