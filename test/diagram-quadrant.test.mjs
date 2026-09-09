import { test } from "node:test";
import assert from "node:assert/strict";
import { renderQuadrant } from "../scripts/lib/diagrams/quadrant.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";
import { plotArea } from "../scripts/lib/diagrams/scale.mjs";

const SPEC = {
  kind: "quadrant",
  id: "roadmap",
  title: "Roadmap prioritization",
  xAxis: { label: "effort", low: "low", high: "high" },
  yAxis: { label: "impact", low: "low", high: "high" },
  quadrants: ["quick wins", "big bets", "fill-ins", "money pit"],
  items: [
    { label: "dedupe probe", x: 0.2, y: 0.85, focal: true },
    { label: "cache warmer", x: 0.35, y: 0.7 },
    { label: "agent sandbox", x: 0.75, y: 0.8 },
    { label: "schema migrate", x: 0.85, y: 0.65 },
    { label: "typo fix", x: 0.15, y: 0.25 },
    { label: "changelog note", x: 0.3, y: 0.15 },
    { label: "rewrite pipeline", x: 0.8, y: 0.2 },
    { label: "port to nuxt", x: 0.65, y: 0.3 },
  ],
};

test("8 items spread across all four cells render with zero geometric findings", () => {
  const svg = renderQuadrant(SPEC);
  assert.deepEqual(validateSvg(svg), []);
});

test("every item becomes a mark, and exactly the focal item gets a bigger radius", () => {
  const svg = renderQuadrant(SPEC);
  const marks = [
    ...svg.matchAll(
      /<rect class="(mark[^"]*)" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g,
    ),
  ];
  assert.equal(marks.length, SPEC.items.length, "one mark rect per item");
  const focal = marks.filter((m) => m[1].includes("focal"));
  assert.equal(focal.length, 1, "exactly one focal mark");
  const focalWidth = Number(focal[0][4]);
  const plainWidths = marks.filter((m) => !m[1].includes("focal")).map((m) => Number(m[4]));
  assert.ok(
    plainWidths.every((w) => w < focalWidth),
    "the focal mark must be visibly larger than every plain mark",
  );
});

test("every item gets a masked label, one per item", () => {
  const svg = renderQuadrant(SPEC);
  const masks = svg.match(/<rect class="emask"/g) || [];
  assert.equal(masks.length, SPEC.items.length);
  assert.ok(
    svg.includes(">dedupe probe<") || svg.includes("dedupe"),
    "item text reaches the output",
  );
});

test("the four quadrant names render as uppercase corner tags", () => {
  const svg = renderQuadrant(SPEC);
  const tags = [...svg.matchAll(/<text class="tag"[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]);
  assert.equal(tags.length, 4);
  assert.deepEqual(tags.sort(), ["QUICK WINS", "BIG BETS", "FILL-INS", "MONEY PIT"].sort());
});

test("axis tip words render as bare uppercase ticks, and dimension titles render once each", () => {
  const svg = renderQuadrant(SPEC);
  const ticks = [...svg.matchAll(/<text class="tick"[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]);
  assert.deepEqual(ticks.sort(), ["LOW", "LOW", "HIGH", "HIGH"].sort());
  assert.equal((svg.match(/class="atitle"/g) || []).length, 2, "one title for x, one for y");
});

test("the divider cross spans the plot area and crosses at its exact centre", () => {
  const svg = renderQuadrant(SPEC);
  const plot = plotArea();
  const lines = [
    ...svg.matchAll(
      /<line class="axis" x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/g,
    ),
  ].map((m) => m.slice(1).map(Number));
  assert.equal(lines.length, 2, "one horizontal and one vertical divider");
  const horizontal = lines.find((l) => l[1] === l[3]);
  const vertical = lines.find((l) => l[0] === l[2]);
  assert.ok(horizontal && vertical, "one line is horizontal, the other vertical");
  assert.equal(
    horizontal[1],
    (plot.y + plot.y2) / 2,
    "horizontal divider sits at the vertical midpoint",
  );
  assert.equal(
    vertical[0],
    (plot.x + plot.x2) / 2,
    "vertical divider sits at the horizontal midpoint",
  );
  assert.deepEqual(
    [horizontal[0], horizontal[2]].sort((a, b) => a - b),
    [plot.x, plot.x2],
  );
  assert.deepEqual(
    [vertical[1], vertical[3]].sort((a, b) => a - b),
    [plot.y, plot.y2],
  );
});

test("throws naming the item on an out-of-range coordinate", () => {
  const bad = {
    ...SPEC,
    items: [...SPEC.items, { label: "off chart", x: 1.4, y: 0.5 }],
  };
  assert.throws(() => renderQuadrant(bad), /off chart/);
});

test("throws on an empty item list instead of rendering nothing", () => {
  assert.throws(() => renderQuadrant({ ...SPEC, items: [] }), /no items/);
});

test("throws when more items than the legibility cap are supplied", () => {
  const tooMany = {
    ...SPEC,
    items: Array.from({ length: 13 }, (_, i) => ({ label: `item ${i}`, x: 0.1, y: 0.1 })),
  };
  assert.throws(() => renderQuadrant(tooMany), /13 items/);
});

test("throws when more than one item claims the single accent", () => {
  const twoFocal = {
    ...SPEC,
    items: SPEC.items.map((it, i) => (i < 2 ? { ...it, focal: true } : it)),
  };
  assert.throws(() => renderQuadrant(twoFocal), /focal/);
});

test("throws when quadrants is not exactly 4 names", () => {
  assert.throws(() => renderQuadrant({ ...SPEC, quadrants: ["only one"] }), /4 quadrant names/);
});

test("throws naming the missing axis word", () => {
  assert.throws(
    () => renderQuadrant({ ...SPEC, xAxis: { label: "effort", low: "low", high: "" } }),
    /x axis/,
  );
});
