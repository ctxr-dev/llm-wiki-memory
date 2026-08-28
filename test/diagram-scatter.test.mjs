import { test } from "node:test";
import assert from "node:assert/strict";
import { renderScatter } from "../scripts/lib/diagrams/scatter.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";
import { plotArea } from "../scripts/lib/diagrams/scale.mjs";

/** @param {number} n @returns {{ x: number, y: number, label?: string, focal?: boolean }} */
function pointAt(n) {
  return { x: 10 + n * 6, y: 280 + n * 42 + (n % 3) * 30 };
}

const points = Array.from({ length: 12 }, (_, i) => pointAt(i));
points[0] = { ...points[0], label: "hodor", focal: true };
points[6] = { ...points[6], label: "widow" };

const baseSpec = {
  kind: "scatter",
  id: "svc-perf",
  title: "Latency vs throughput",
  xLabel: "Requests/s",
  yLabel: "p95 latency (ms)",
  points,
  trend: true,
  quadrants: true,
};

test("a 12-point spec with labels, trend and quadrants renders with zero geometric findings", () => {
  const svg = renderScatter(baseSpec);
  assert.deepEqual(validateSvg(svg), []);
});

test("every point becomes a mark, and the focal point gets a bigger radius", () => {
  const svg = renderScatter(baseSpec);
  const marks = [
    ...svg.matchAll(
      /<rect class="(mark[^"]*)" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g,
    ),
  ];
  assert.equal(marks.length, points.length, "one mark rect per point");
  const focal = marks.filter((m) => m[1].includes("focal"));
  assert.equal(focal.length, 1, "exactly one focal mark");
  const focalWidth = Number(focal[0][4]);
  const plainWidths = marks.filter((m) => !m[1].includes("focal")).map((m) => Number(m[4]));
  assert.ok(
    plainWidths.every((w) => w < focalWidth),
    "the focal mark must be visibly larger than every plain mark",
  );
});

test("every mark sits within the shared plot area", () => {
  const svg = renderScatter(baseSpec);
  const plot = plotArea();
  for (const m of svg.matchAll(
    /<rect class="mark[^"]*" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g,
  )) {
    const [, x, y, w, h] = m.map(Number);
    assert.ok(
      x >= plot.x - 0.01 && x + w <= plot.x2 + 0.01,
      `mark x-extent ${x}-${x + w} inside plot`,
    );
    assert.ok(
      y >= plot.y - 0.01 && y + h <= plot.y2 + 0.01,
      `mark y-extent ${y}-${y + h} inside plot`,
    );
  }
});

test("labelled points get a paper mask behind mono text, capped at three", () => {
  const svg = renderScatter(baseSpec);
  const masks = svg.match(/<rect class="emask"/g) || [];
  assert.equal(masks.length, 2, "one mask per labelled point in this spec");
  assert.ok(svg.includes(">hodor<"), "hodor's mono label text is present, lowercase");
  assert.ok(svg.includes(">widow<"), "widow's mono label text is present, lowercase");

  const overLabelled = {
    ...baseSpec,
    points: baseSpec.points.map((p, i) => (i < 5 ? { ...p, label: `p${i}` } : p)),
  };
  const svg2 = renderScatter(overLabelled);
  const masks2 = svg2.match(/<rect class="emask"/g) || [];
  assert.ok(masks2.length <= 3, "at most three labels are ever drawn");
});

test("quadrants draw dashed median dividers and trend draws a dashed regression line", () => {
  const withBoth = renderScatter(baseSpec);
  assert.equal((withBoth.match(/class="hair"/g) || []).length, 2);
  assert.equal((withBoth.match(/class="ser"/g) || []).length, 1);

  const withNeither = renderScatter({ ...baseSpec, trend: false, quadrants: false });
  assert.equal((withNeither.match(/class="hair"/g) || []).length, 0);
  assert.equal((withNeither.match(/class="ser"/g) || []).length, 0);
  assert.deepEqual(validateSvg(withNeither), []);
});

test("throws naming the point on a non-finite coordinate", () => {
  const bad = { ...baseSpec, points: [...points, { x: NaN, y: 10, label: "broken" }] };
  assert.throws(() => renderScatter(bad), /broken/);
});

test("throws on an empty series instead of rendering nothing", () => {
  assert.throws(() => renderScatter({ ...baseSpec, points: [] }), /no points/);
});

test("throws when more than one point claims the single accent", () => {
  const twoFocal = {
    ...baseSpec,
    points: points.map((p, i) => (i < 2 ? { ...p, focal: true } : p)),
  };
  assert.throws(() => renderScatter(twoFocal), /focal/);
});
