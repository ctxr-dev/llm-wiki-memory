import { test } from "node:test";
import assert from "node:assert/strict";
import { renderWardley } from "../scripts/lib/diagrams/wardley.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

const SPEC = {
  kind: "wardley",
  id: "assistant",
  title: "AI assistant value chain",
  components: [
    { id: "need", label: "answer in the flow of work", visibility: 0.89, evolution: 0.38 },
    { id: "chat", label: "chat ui", visibility: 0.77, evolution: 0.63 },
    {
      id: "orchestrator",
      label: "agent orchestration",
      visibility: 0.66,
      evolution: 0.38,
      focal: true,
    },
    { id: "vectorstore", label: "vector store", visibility: 0.43, evolution: 0.63 },
    { id: "llm", label: "llm api", visibility: 0.31, evolution: 0.7 },
    { id: "gpu", label: "gpu compute", visibility: 0.2, evolution: 0.88 },
  ],
  links: [
    { from: "need", to: "chat" },
    { from: "chat", to: "orchestrator" },
    { from: "orchestrator", to: "vectorstore" },
    { from: "orchestrator", to: "llm" },
    { from: "llm", to: "gpu" },
  ],
};

test("6 components and 5 links render with zero geometric findings", () => {
  const svg = renderWardley(SPEC);
  assert.deepEqual(validateSvg(svg), []);
});

test("every component becomes a mark, and exactly the focal one gets a bigger radius", () => {
  const svg = renderWardley(SPEC);
  const marks = [
    ...svg.matchAll(
      /<rect class="(mark[^"]*)" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g,
    ),
  ];
  assert.equal(marks.length, SPEC.components.length, "one mark rect per component");
  const focal = marks.filter((m) => m[1].includes("focal"));
  assert.equal(focal.length, 1, "exactly one focal mark");
  const focalWidth = Number(focal[0][4]);
  const plainWidths = marks.filter((m) => !m[1].includes("focal")).map((m) => Number(m[4]));
  assert.ok(
    plainWidths.every((w) => w < focalWidth),
    "the focal mark must be visibly larger than every plain mark",
  );
});

test("every link renders as a plain line, drawn before any component mark", () => {
  const svg = renderWardley(SPEC);
  const linkCount = (svg.match(/<line class="e"/g) || []).length;
  assert.equal(linkCount, SPEC.links.length);
  const lastLinkIndex = svg.lastIndexOf('<line class="e"');
  const firstMarkIndex = svg.indexOf('<rect class="mark');
  assert.ok(lastLinkIndex < firstMarkIndex, "links are drawn before components so dots sit on top");
});

test("every component gets a masked name label", () => {
  const svg = renderWardley(SPEC);
  const masks = svg.match(/<rect class="emask"/g) || [];
  assert.equal(masks.length, SPEC.components.length);
  assert.ok(svg.includes("chat ui"), "a short label reaches the output verbatim");
  assert.ok(svg.includes("<tspan"), "the long label wraps across tspans");
});

test("the four evolution bands render as uppercase ticks, and the y axis is never numbered", () => {
  const svg = renderWardley(SPEC);
  const ticks = [...svg.matchAll(/<text class="tick"[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]);
  assert.deepEqual(ticks.sort(), ["GENESIS", "CUSTOM-BUILT", "PRODUCT", "COMMODITY"].sort());
  assert.ok(
    svg.includes(">VISIBLE TO<") && svg.includes(">THE USER<") && svg.includes(">INVISIBLE<"),
  );
  assert.doesNotMatch(svg, /writing-mode/, "the value-chain label is never rotated");
});

test("throws on an empty component list instead of rendering nothing", () => {
  assert.throws(() => renderWardley({ ...SPEC, components: [] }), /no components/);
});

test("throws when more components than the legibility cap are supplied", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    id: `c${i}`,
    label: `component ${i}`,
    visibility: 0.5,
    evolution: 0.5,
  }));
  const links = many.slice(1).map((c, i) => ({ from: many[i].id, to: c.id }));
  assert.throws(() => renderWardley({ ...SPEC, components: many, links }), /10 components/);
});

test("throws naming a duplicate component id", () => {
  const dup = { ...SPEC, components: [...SPEC.components, { ...SPEC.components[0] }] };
  assert.throws(() => renderWardley(dup), /duplicate component id "need"/);
});

test("throws naming the component with an out-of-range visibility or evolution", () => {
  const badVisibility = {
    ...SPEC,
    components: SPEC.components.map((c) => (c.id === "chat" ? { ...c, visibility: 1.4 } : c)),
  };
  assert.throws(() => renderWardley(badVisibility), /"chat" needs visibility/);

  const badEvolution = {
    ...SPEC,
    components: SPEC.components.map((c) => (c.id === "llm" ? { ...c, evolution: -0.2 } : c)),
  };
  assert.throws(() => renderWardley(badEvolution), /"llm" needs evolution/);
});

test("throws when more than one component claims the single accent", () => {
  const twoFocal = {
    ...SPEC,
    components: SPEC.components.map((c) => (c.id === "chat" ? { ...c, focal: true } : c)),
  };
  assert.throws(() => renderWardley(twoFocal), /focal/);
});

test("throws on an empty link list instead of rendering disconnected dots", () => {
  assert.throws(() => renderWardley({ ...SPEC, links: [] }), /no dependency links/);
});

test("throws naming a link that references an unknown component", () => {
  const bad = { ...SPEC, links: [...SPEC.links, { from: "need", to: "ghost" }] };
  assert.throws(() => renderWardley(bad), /unknown component "ghost"/);
});

test("throws on a link connecting a component to itself", () => {
  const bad = { ...SPEC, links: [...SPEC.links, { from: "need", to: "need" }] };
  assert.throws(() => renderWardley(bad), /connects "need" to itself/);
});

test("throws naming a component with no dependency link", () => {
  const orphan = {
    ...SPEC,
    components: [
      ...SPEC.components,
      { id: "orphan", label: "orphan", visibility: 0.5, evolution: 0.5 },
    ],
  };
  assert.throws(() => renderWardley(orphan), /"orphan" has no dependency link/);
});
