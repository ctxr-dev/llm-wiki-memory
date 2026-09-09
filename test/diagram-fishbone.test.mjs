import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFishbone } from "../scripts/lib/diagrams/fishbone.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

const CATEGORIES = [
  { label: "embedding", causes: ["stale cache", "dim mismatch"] },
  { label: "retrieval", causes: ["wrong index", "empty scope", "stale snapshot"] },
  { label: "storage", causes: ["disk full", "corrupt shard"], focal: true },
  { label: "config", causes: ["missing key", "bad default", "env drift"] },
];

const SPEC = {
  kind: "fishbone",
  id: "recall-failure",
  title: "Why recall returned nothing",
  effect: "recall returned nothing",
  categories: CATEGORIES,
};

test("a 4-category spec (2-3 causes each) renders with zero geometric findings", () => {
  const svg = renderFishbone(SPEC);
  assert.deepEqual(validateSvg(svg), []);
});

test("one bone is drawn per category, and one tick per cause", () => {
  const svg = renderFishbone(SPEC);
  const bones = svg.match(/<line class="bus"/g) ?? [];
  assert.equal(bones.length, CATEGORIES.length);
  const ticks = svg.match(/<line class="hair"/g) ?? [];
  const totalCauses = CATEGORIES.reduce((n, c) => n + c.causes.length, 0);
  assert.equal(ticks.length, totalCauses);
  const causeLabels = svg.match(/<text class="ns"/g) ?? [];
  assert.equal(causeLabels.length, totalCauses);
});

test("category tags alternate above and below the spine", () => {
  const svg = renderFishbone(SPEC);
  const tagYs = [...svg.matchAll(/<rect class="nb[^"]*" x="[^"]+" y="(-?[\d.]+)"/g)]
    .map((m) => Number(m[1]))
    // The effect box is also an `nb` rect, always last in the alternation
    // sequence's leftover slot; categories are emitted before it.
    .slice(0, CATEGORIES.length);
  tagYs.forEach((y, i) => {
    if (i % 2 === 0) assert.ok(y < 0, `category ${i} (even index) should sit above the spine`);
    else assert.ok(y > 0, `category ${i} (odd index) should sit below the spine`);
  });
});

test("the effect box is always focal, and exactly one category tag may also be focal", () => {
  const svg = renderFishbone(SPEC);
  const focalBoxes = svg.match(/<rect class="nb focal"/g) ?? [];
  // The unconditional effect box, plus the one category that set focal: true.
  assert.equal(focalBoxes.length, 2);
});

test("a spine runs from the tail to the effect box with a single arrowhead", () => {
  const svg = renderFishbone(SPEC);
  const spines =
    svg.match(/<path class="e" d="M-?[\d.]+,0 H[\d.]+" marker-end="url\(#[^)]+\)"\/>/g) ?? [];
  assert.equal(spines.length, 1);
});

test("the 6-category, 3-cause-each upper bound still renders with zero geometric findings", () => {
  const categories = [
    {
      label: "embedding pipeline",
      causes: ["stale cache entry", "dimension mismatch", "model version drift"],
    },
    {
      label: "retrieval",
      causes: ["wrong index selected", "empty scope filter", "stale snapshot read"],
    },
    {
      label: "storage layer",
      causes: ["disk quota exceeded", "corrupt shard file", "replica lag"],
    },
    {
      label: "configuration",
      causes: ["missing api key", "bad default value", "environment drift"],
    },
    {
      label: "networking",
      causes: ["dns resolution failure", "tls handshake timeout", "pool exhausted"],
    },
    {
      label: "scheduling",
      causes: ["cron misconfigured", "worker pool starved", "deadline exceeded"],
    },
  ];
  const svg = renderFishbone({
    ...SPEC,
    categories,
    effect: "recall pipeline degraded under load",
  });
  assert.deepEqual(validateSvg(svg), []);
});

test("fewer than 2 categories fails loudly, naming the count", () => {
  assert.throws(
    () => renderFishbone({ ...SPEC, categories: [{ label: "a", causes: ["x"] }] }),
    /2-6 categories, got 1/,
  );
});

test("more than 6 categories fails loudly, naming the count", () => {
  const categories = Array.from({ length: 7 }, (_, i) => ({ label: `c${i}`, causes: ["x"] }));
  assert.throws(() => renderFishbone({ ...SPEC, categories }), /2-6 categories, got 7/);
});

test("a category with zero or more than 3 causes fails loudly, naming the category", () => {
  assert.throws(
    () => renderFishbone({ ...SPEC, categories: [{ label: "empty", causes: [] }, CATEGORIES[0]] }),
    /category "empty" has 0 causes, expected 1-3/,
  );
  assert.throws(
    () =>
      renderFishbone({
        ...SPEC,
        categories: [{ label: "overloaded", causes: ["a", "b", "c", "d"] }, CATEGORIES[0]],
      }),
    /category "overloaded" has 4 causes, expected 1-3/,
  );
});

test("more than one focal category fails loudly", () => {
  assert.throws(
    () =>
      renderFishbone({
        ...SPEC,
        categories: [
          { label: "a", causes: ["x"], focal: true },
          { label: "b", causes: ["y"], focal: true },
        ],
      }),
    /one focal category, got 2/,
  );
});
