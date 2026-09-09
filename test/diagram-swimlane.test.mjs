import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSwimlane } from "../scripts/lib/diagrams/swimlane.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

const SPEC = {
  kind: "swimlane",
  id: "sw",
  title: "Order ingestion handoffs",
  lanes: [
    { id: "web", label: "scala-webhooks" },
    { id: "queue", label: "kafka" },
    { id: "fraud", label: "analysis-platform" },
  ],
  steps: [
    { id: "s1", lane: "web", col: 0, label: "receive order", kind: "focal" },
    { id: "s2", lane: "web", col: 1, label: "validate signature" },
    { id: "s3", lane: "queue", col: 1, label: "publish OrderReceived", sub: "core.fct.orders" },
    { id: "s4", lane: "fraud", col: 2, label: "score risk" },
    { id: "s5", lane: "web", col: 2, label: "ack webhook" },
  ],
  edges: [
    { from: "s1", to: "s2", kind: "sync" },
    { from: "s2", to: "s3", kind: "async", label: "OrderEvent" },
    { from: "s3", to: "s4", kind: "async", label: "consume" },
    { from: "s4", to: "s5", kind: "focal", label: "risk score" },
  ],
};

test("a swimlane renders one zone band per lane, one nb box per step, one path per edge", () => {
  const svg = renderSwimlane(SPEC);
  assert.match(svg, /<svg viewBox="[^"]+" role="img" aria-label="Order ingestion handoffs">/);
  assert.match(svg, /<\/svg>$/);
  assert.equal((svg.match(/<rect class="zone"/g) ?? []).length, 3, "one band per lane");
  assert.equal((svg.match(/<rect class="nb /g) ?? []).length, 5, "one box per step");
  assert.equal((svg.match(/<path class="e/g) ?? []).length, 4, "one path per edge");
  assert.equal((svg.match(/<rect class="emask"/g) ?? []).length, 3, "labelled edges only");
  assert.equal(
    (svg.match(/<line class="hair"/g) ?? []).length,
    2,
    "a divider between each pair of lanes",
  );
  assert.ok(svg.includes("receive order"), "step labels reach the output");
  assert.ok(svg.includes("SCALA-WEBHOOKS"), "lane labels are upper-cased eyebrows");
  assert.ok(svg.includes("core.fct.orders"), "step sub-lines reach the output");
  assert.match(svg, /<rect class="nb focal"/, "a focal step keeps its accent treatment");
});

test("a swimlane crossing two lanes has no geometric findings", () => {
  // s4 (fraud, lane 2) -> s5 (web, lane 0) skips the queue lane entirely.
  const svg = renderSwimlane(SPEC);
  assert.deepEqual(validateSvg(svg), []);
});

test("an edge that would cut through an intervening lane's step is rerouted, not drawn through it", () => {
  // web -> fraud directly, skipping queue: the straight elbow's horizontal jog
  // would otherwise land exactly on queue's own step at the midpoint column.
  const svg = renderSwimlane({
    kind: "swimlane",
    id: "blocked",
    title: "Blocked handoff",
    lanes: [
      { id: "web", label: "scala-webhooks" },
      { id: "queue", label: "kafka" },
      { id: "fraud", label: "analysis-platform" },
    ],
    steps: [
      { id: "s1", lane: "web", col: 0, label: "receive order" },
      { id: "s3", lane: "queue", col: 1, label: "publish OrderReceived" },
      { id: "s4", lane: "fraud", col: 2, label: "score risk" },
    ],
    edges: [{ from: "s1", to: "s4", label: "webhook.received", kind: "focal" }],
  });
  assert.deepEqual(validateSvg(svg), []);
});

test("a same-lane edge that skips an intervening step ducks under it instead of crossing it", () => {
  const svg = renderSwimlane({
    kind: "swimlane",
    id: "sl",
    title: "Same lane skip",
    lanes: [{ id: "web", label: "scala-webhooks" }],
    steps: [
      { id: "s1", lane: "web", col: 0, label: "start" },
      { id: "s2", lane: "web", col: 1, label: "middle step in the way" },
      { id: "s3", lane: "web", col: 2, label: "end" },
    ],
    edges: [{ from: "s1", to: "s3", label: "skip ahead", kind: "async" }],
  });
  assert.deepEqual(validateSvg(svg), []);
});

test("a lane with no steps still renders as a full band", () => {
  const svg = renderSwimlane({
    kind: "swimlane",
    id: "empty",
    title: "t",
    lanes: [
      { id: "a", label: "alpha" },
      { id: "b", label: "beta" },
    ],
    steps: [{ id: "s1", lane: "a", col: 0, label: "only step" }],
    edges: [],
  });
  assert.equal(
    (svg.match(/<rect class="zone"/g) ?? []).length,
    2,
    "beta has no steps but still gets a band",
  );
  assert.deepEqual(validateSvg(svg), []);
});

test("a long lane label wraps at a dash boundary and stays upper-cased", () => {
  const svg = renderSwimlane({
    kind: "swimlane",
    id: "wrap",
    title: "t",
    lanes: [{ id: "a", label: "webhooks-order-service-consumer" }],
    steps: [{ id: "s1", lane: "a", col: 0, label: "x" }],
    edges: [],
  });
  const tagText = /<text class="tag"[^>]*>([\s\S]*?)<\/text>/.exec(svg)[1];
  assert.equal((tagText.match(/<tspan/g) ?? []).length, 2, "the label wraps to two lines");
  assert.ok(svg.includes("WEBHOOKS-ORDER-SERVICE-"));
});

test("a swimlane needs at least one lane", () => {
  assert.throws(
    () =>
      renderSwimlane({ kind: "swimlane", id: "e", title: "t", lanes: [], steps: [], edges: [] }),
    /at least one lane/,
  );
});

test("a step referencing an unknown lane fails loudly", () => {
  assert.throws(
    () =>
      renderSwimlane({
        kind: "swimlane",
        id: "e",
        title: "t",
        lanes: [{ id: "a", label: "A" }],
        steps: [{ id: "s1", lane: "ghost", col: 0, label: "x" }],
        edges: [],
      }),
    /unknown lane ghost for step s1/,
  );
});

test("an edge to an unknown step fails loudly rather than drawing a partial diagram", () => {
  assert.throws(
    () =>
      renderSwimlane({
        kind: "swimlane",
        id: "e",
        title: "t",
        lanes: [{ id: "a", label: "A" }],
        steps: [{ id: "s1", lane: "a", col: 0, label: "x" }],
        edges: [{ from: "s1", to: "ghost" }],
      }),
    /unknown step in edge s1->ghost/,
  );
});
