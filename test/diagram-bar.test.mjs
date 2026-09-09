import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBar } from "../scripts/lib/diagrams/bar.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";
import { plotArea } from "../scripts/lib/diagrams/scale.mjs";

const BARS = [
  { label: "scala-webhooks", value: 1240, focal: true },
  { label: "bumblebee", value: 860 },
  { label: "hodor", value: 640 },
  { label: "veritas", value: 420 },
  { label: "aletheia", value: 310 },
  { label: "cop", value: 90 },
];

const VERTICAL_SPEC = {
  kind: "bar",
  id: "svc-throughput",
  title: "Requests per service",
  xLabel: "Service",
  yLabel: "Requests/sec",
  bars: BARS,
};

// Long, near-duplicate-prefixed names are exactly the documented reason to
// flip orientation, so the horizontal variant earns its own realistic labels
// rather than reusing the short vertical set.
const HORIZONTAL_SPEC = {
  kind: "bar",
  id: "svc-throughput-rows",
  title: "Requests per service (by row)",
  xLabel: "Service",
  yLabel: "Requests/sec",
  horizontal: true,
  bars: [
    { label: "scala-webhooks-ingestion-worker", value: 1240, focal: true },
    { label: "bumblebee-order-normalizer", value: 860 },
    { label: "hodor-decision-engine", value: 640 },
    { label: "veritas-fraud-scoring", value: 420 },
    { label: "aletheia-analytics-pipeline", value: 310 },
    { label: "cop-policy-enforcement", value: 90 },
  ],
};

/** @param {string} svg @returns {{ cls: string, x: number, y: number, w: number, h: number }[]} */
function marksOf(svg) {
  return [
    ...svg.matchAll(
      /<rect class="(mark[^"]*)" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g,
    ),
  ].map((m) => ({ cls: m[1], x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]) }));
}

test("a vertical chart draws one mark per bar, all within the shared plot area", () => {
  const svg = renderBar(VERTICAL_SPEC);
  const marks = marksOf(svg);
  assert.equal(marks.length, BARS.length);
  const plot = plotArea();
  for (const m of marks) {
    assert.ok(
      m.x >= plot.x - 0.01 && m.x + m.w <= plot.x2 + 0.01,
      `x-extent inside plot: ${m.x}-${m.x + m.w}`,
    );
    assert.ok(
      m.y >= plot.y - 0.01 && m.y + m.h <= plot.y2 + 0.01,
      `y-extent inside plot: ${m.y}-${m.y + m.h}`,
    );
  }
});

test("a vertical chart marks exactly one bar as focal", () => {
  const marks = marksOf(renderBar(VERTICAL_SPEC));
  const focal = marks.filter((m) => m.cls.includes("focal"));
  assert.equal(focal.length, 1);
});

test("a vertical chart has no geometric findings", () => {
  assert.deepEqual(validateSvg(renderBar(VERTICAL_SPEC)), []);
});

test("a horizontal chart draws one mark per bar, all within its (wider) plot area", () => {
  const svg = renderBar(HORIZONTAL_SPEC);
  const marks = marksOf(svg);
  assert.equal(marks.length, HORIZONTAL_SPEC.bars.length);
  const plot = plotArea({ margin: { left: 200 } });
  for (const m of marks) {
    assert.ok(
      m.x >= plot.x - 0.01 && m.x + m.w <= plot.x2 + 0.01,
      `x-extent inside plot: ${m.x}-${m.x + m.w}`,
    );
    assert.ok(
      m.y >= plot.y - 0.01 && m.y + m.h <= plot.y2 + 0.01,
      `y-extent inside plot: ${m.y}-${m.y + m.h}`,
    );
  }
});

test("a horizontal chart marks exactly one bar as focal", () => {
  const marks = marksOf(renderBar(HORIZONTAL_SPEC));
  const focal = marks.filter((m) => m.cls.includes("focal"));
  assert.equal(focal.length, 1);
});

test("a horizontal chart has no geometric findings", () => {
  assert.deepEqual(validateSvg(renderBar(HORIZONTAL_SPEC)), []);
});

test("row labels render along the left in the horizontal orientation", () => {
  const svg = renderBar(HORIZONTAL_SPEC);
  assert.ok(svg.includes("cop-policy-enforcement"), "row label text reaches the output");
  assert.equal((svg.match(/class="clab"/g) || []).length, HORIZONTAL_SPEC.bars.length);
});

test("a bar of value 0 still renders a visible hairline, not nothing", () => {
  const spec = {
    kind: "bar",
    id: "zero-case",
    title: "Zero case",
    bars: [
      { label: "a", value: 100 },
      { label: "b", value: 0 },
      { label: "c", value: 40 },
    ],
  };
  const svg = renderBar(spec);
  assert.deepEqual(validateSvg(svg), []);
  const marks = marksOf(svg);
  assert.equal(marks.length, 3);
  assert.ok(marks[1].h >= 2, `zero bar should have a visible height, got ${marks[1].h}`);
});

test("negative values anchor bars to a zero baseline inside the plot, not the bottom edge", () => {
  const spec = {
    kind: "bar",
    id: "signed",
    title: "Signed values",
    bars: [
      { label: "up", value: 100 },
      { label: "down", value: -40 },
    ],
  };
  const svg = renderBar(spec);
  assert.deepEqual(validateSvg(svg), []);
  const [up, down] = marksOf(svg);
  const plot = plotArea();
  // The positive bar's bottom and the negative bar's top must meet at the
  // same pixel: that shared edge IS the zero line, and it has to sit inside
  // the plot rather than coincide with either frame edge.
  assert.ok(Math.abs(up.y + up.h - down.y) < 0.5, "positive bottom and negative top meet at zero");
  assert.ok(down.y > plot.y + 5, "zero line sits below the plot's top edge");
  assert.ok(up.y + up.h < plot.y2 - 5, "zero line sits above the plot's bottom edge");
  // The reader has to see that line to read either bar's magnitude off it.
  assert.match(svg, /<line class="axis" x1="80" y1="[\d.]+" x2="960" y2="[\d.]+"\/>/);
});

test("an oversized horizontal value label grows the viewBox rather than clipping", () => {
  const spec = {
    kind: "bar",
    id: "huge-values",
    title: "Huge values",
    horizontal: true,
    bars: [
      { label: "a", value: 123456789 },
      { label: "b", value: 2 },
    ],
  };
  const svg = renderBar(spec);
  assert.deepEqual(validateSvg(svg), []);
  const viewBox = /viewBox="(-?[\d.]+) 0 ([\d.]+) [\d.]+"/.exec(svg);
  assert.ok(viewBox, "svg has a viewBox");
  assert.ok(Number(viewBox[2]) > 1000, "viewBox widened past the standard 1000 to fit the label");
});

test("an empty bar list fails loudly instead of rendering nothing", () => {
  assert.throws(() => renderBar({ ...VERTICAL_SPEC, bars: [] }), /no bars/);
});

test("a non-finite value fails loudly, naming the bar", () => {
  const bad = { ...VERTICAL_SPEC, bars: [...BARS, { label: "broken", value: NaN }] };
  assert.throws(() => renderBar(bad), /broken/);
});

test("more than one focal bar fails loudly", () => {
  const twoFocal = {
    ...VERTICAL_SPEC,
    bars: BARS.map((b, i) => (i < 2 ? { ...b, focal: true } : b)),
  };
  assert.throws(() => renderBar(twoFocal), /focal/);
});
