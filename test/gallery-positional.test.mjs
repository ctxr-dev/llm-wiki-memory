import { test } from "node:test";
import assert from "node:assert/strict";
import { positionalExamples } from "../scripts/lib/gallery/positional.mjs";
import { draw, knownKinds } from "../scripts/lib/diagrams/index.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

test("every positional example kind is registered in the diagram catalogue", () => {
  const known = knownKinds();
  for (const entry of positionalExamples) {
    assert.ok(known.includes(entry.kind), `"${entry.kind}" is not a known diagram kind`);
  }
});

test("every positional example name is unique", () => {
  const names = positionalExamples.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, "duplicate name slug in the gallery");
});

test("every positional example caption is a short non-empty sentence", () => {
  for (const entry of positionalExamples) {
    assert.ok(entry.caption.length > 0, `${entry.name} has an empty caption`);
    assert.ok(entry.caption.length < 140, `${entry.name} caption is ${entry.caption.length} chars`);
  }
});

test("every positional example renders and validates with zero geometric findings", () => {
  for (const entry of positionalExamples) {
    const svg = draw(entry.spec);
    assert.match(svg, /^<svg viewBox="/, `${entry.name} did not render an svg`);
    assert.deepEqual(validateSvg(svg), [], `${entry.name} has geometric findings`);
  }
});

test("the nine positional kinds are each covered exactly once", () => {
  const kinds = positionalExamples.map((entry) => entry.kind).sort();
  assert.deepEqual(kinds, [
    "fishbone",
    "high-level",
    "kanban",
    "layers",
    "loop",
    "medallion",
    "quadrant",
    "timeline",
    "wardley",
  ]);
});
