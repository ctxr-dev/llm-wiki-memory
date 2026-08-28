import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLoop } from "../scripts/lib/diagrams/loop.mjs";
import { polarPoint } from "../scripts/lib/diagrams/scale.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

const STAGES = [
  { label: "capture", sub: "signals in" },
  { label: "research", sub: "evidence pulled", focal: true },
  { label: "decide", sub: "human approves" },
  { label: "act", sub: "work ships" },
];

const SPEC = { kind: "loop", id: "improve-loop", title: "Self-improving loop", stages: STAGES };

test("a 4-stage spec renders with zero geometric findings", () => {
  const svg = renderLoop(SPEC);
  assert.deepEqual(validateSvg(svg), []);
});

test("one arrow closes each gap between adjacent stages, including the last back to the first", () => {
  const svg = renderLoop(SPEC);
  const arcs = svg.match(/<path class="e" d="[^"]+" marker-end="url\(#[^)]+\)"\/>/g) ?? [];
  assert.equal(arcs.length, STAGES.length, "one ring arrow per stage, closing the loop");
});

test("one box is drawn per stage, arranged clockwise from the top", () => {
  const svg = renderLoop(SPEC);
  const boxes = [
    ...svg.matchAll(
      /<rect class="nb[^"]*" x="(-?[\d.]+)" y="(-?[\d.]+)" width="(\d+)" height="(\d+)"/g,
    ),
  ];
  assert.equal(boxes.length, STAGES.length);
  const n = STAGES.length;
  const centers = boxes.map((m) => ({
    x: Number(m[1]) + Number(m[3]) / 2,
    y: Number(m[2]) + Number(m[4]) / 2,
  }));
  centers.forEach((center, i) => {
    const expected = polarPoint(0, 0, 240, i, n);
    assert.ok(Math.abs(center.x - expected.x) < 1, `stage ${i} x should sit on its ring position`);
    assert.ok(Math.abs(center.y - expected.y) < 1, `stage ${i} y should sit on its ring position`);
  });
  // Stage 0 is polarPoint's -90 degree position: dead centre horizontally,
  // and above every other stage.
  assert.ok(Math.abs(centers[0].x) < 1, "stage 0 sits horizontally centred at the top");
  centers.slice(1).forEach((center, i) => {
    assert.ok(centers[0].y < center.y, `stage 0 should sit above stage ${i + 1}`);
  });
});

test("exactly one stage box is marked focal", () => {
  const svg = renderLoop(SPEC);
  const focalBoxes = svg.match(/<rect class="nb focal"/g) ?? [];
  assert.equal(focalBoxes.length, 1);
});

test("a 6-stage spec (the upper bound) still renders with zero geometric findings", () => {
  const stages = ["capture", "research", "decide", "act", "measure", "learn"].map((label) => ({
    label,
    sub: `${label} caption`,
  }));
  const svg = renderLoop({ ...SPEC, stages });
  assert.deepEqual(validateSvg(svg), []);
});

test("fewer than 3 stages fails loudly, naming the count", () => {
  assert.throws(
    () => renderLoop({ ...SPEC, stages: [{ label: "a" }, { label: "b" }] }),
    /3-6 stages, got 2/,
  );
});

test("more than 6 stages fails loudly, naming the count", () => {
  const stages = Array.from({ length: 7 }, (_, i) => ({ label: `s${i}` }));
  assert.throws(() => renderLoop({ ...SPEC, stages }), /3-6 stages, got 7/);
});

test("more than one focal stage fails loudly", () => {
  assert.throws(
    () =>
      renderLoop({
        ...SPEC,
        stages: [{ label: "a", focal: true }, { label: "b", focal: true }, { label: "c" }],
      }),
    /one focal stage, got 2/,
  );
});
