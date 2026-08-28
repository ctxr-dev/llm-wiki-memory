import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLine } from "../scripts/lib/diagrams/line.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";
import { plotArea } from "../scripts/lib/diagrams/scale.mjs";

const xLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"];

const baseSpec = {
  kind: "line",
  id: "latency",
  title: "Latency by percentile",
  xLabel: "Month",
  yLabel: "Latency (ms)",
  xLabels,
  series: [
    { label: "p50", values: [8, 9, 7, 10, 11, 9, 8, 10] },
    { label: "p99", values: [12, 18, 15, 22, 25, 20, 17, 19], focal: true, area: true },
    { label: "p999", values: [20, 28, 24, 33, 38, 30, 26, 29] },
  ],
};

test("a 3-series 8-point line chart renders with zero geometric findings", () => {
  const svg = renderLine(baseSpec);
  assert.match(svg, /^<svg viewBox="/);
  assert.match(svg, /<\/svg>$/);
  assert.deepEqual(validateSvg(svg), []);
});

test("one polyline is drawn per series, palette assigned in order without skipping", () => {
  const svg = renderLine(baseSpec);
  const polylines = [...svg.matchAll(/<polyline class="(ser[^"]*)"/g)];
  assert.equal(polylines.length, 3, "one polyline per series");
  const focalLines = polylines.filter((m) => m[1].includes("focal"));
  assert.equal(focalLines.length, 1, "exactly one focal polyline");
  const paletteClasses = polylines.filter((m) => !m[1].includes("focal")).map((m) => m[1]);
  assert.deepEqual(paletteClasses.sort(), ["ser s1", "ser s2"], "non-focal series get s1 then s2");
});

test("vertex dots are drawn only on the focal series, one per point", () => {
  const svg = renderLine(baseSpec);
  const dots = svg.match(/<rect class="mark focal"/g) || [];
  assert.equal(dots.length, xLabels.length, "one dot per focal-series point");
  // Non-focal series contribute polylines only — "line only" per the type spec.
  assert.equal(svg.match(/<rect class="mark[^"]*"/g)?.length, xLabels.length);
});

test("axes, category labels and axis titles are all present", () => {
  const svg = renderLine(baseSpec);
  assert.equal((svg.match(/class="axis"/g) || []).length, 2, "y-axis line plus x baseline");
  assert.equal((svg.match(/class="clab"/g) || []).length, xLabels.length, "one label per category");
  assert.equal((svg.match(/class="atitle"/g) || []).length, 2, "both axis titles requested");
  for (const label of xLabels)
    assert.ok(svg.includes(`>${label}<`), `category label ${label} present`);
});

test("the legend lists one entry per series with its own label", () => {
  const svg = renderLine(baseSpec);
  assert.equal((svg.match(/<rect class="swatch/g) || []).length, 3);
  for (const s of baseSpec.series) {
    assert.ok(svg.includes(`>${s.label}</text>`), `legend text includes ${s.label}`);
  }
});

test("only the focal series with area:true draws a band fill, closed to the baseline", () => {
  const svg = renderLine(baseSpec);
  const bands = [...svg.matchAll(/<polygon class="band" points="([^"]+)"/g)];
  assert.equal(bands.length, 1);
  const plot = plotArea();
  const pts = bands[0][1]
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number));
  assert.equal(pts[0][1], plot.y2, "band opens on the baseline");
  assert.equal(pts[pts.length - 1][1], plot.y2, "band closes on the baseline");

  const withoutArea = renderLine({
    ...baseSpec,
    series: baseSpec.series.map((s) => (s.focal ? { ...s, area: false } : s)),
  });
  assert.equal((withoutArea.match(/<polygon class="band"/g) || []).length, 0);
  assert.deepEqual(validateSvg(withoutArea), []);
});

test("every polyline vertex and every dot sits inside the shared plot area", () => {
  const svg = renderLine(baseSpec);
  const plot = plotArea();
  const inBounds = (px, py) =>
    px >= plot.x - 0.01 && px <= plot.x2 + 0.01 && py >= plot.y - 0.01 && py <= plot.y2 + 0.01;

  let vertexCount = 0;
  for (const m of svg.matchAll(/<polyline class="ser[^"]*" points="([^"]+)"/g)) {
    for (const pair of m[1].trim().split(/\s+/)) {
      const [px, py] = pair.split(",").map(Number);
      assert.ok(inBounds(px, py), `polyline point (${px},${py}) inside plot`);
      vertexCount += 1;
    }
  }
  assert.equal(vertexCount, baseSpec.series.length * xLabels.length);

  for (const m of svg.matchAll(
    /<rect class="mark focal" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g,
  )) {
    const [, x, y, w, h] = m.map(Number);
    assert.ok(inBounds(x + w / 2, y + h / 2), "dot center inside plot");
  }
});

test("a series whose length disagrees with xLabels fails loudly, naming the series", () => {
  assert.throws(
    () =>
      renderLine({
        ...baseSpec,
        series: [...baseSpec.series, { label: "short", values: [1, 2, 3] }],
      }),
    /"short"/,
  );
});

test("a non-finite value fails loudly, naming the series", () => {
  assert.throws(
    () =>
      renderLine({ ...baseSpec, series: [{ label: "bad", values: [1, NaN, 3, 4, 5, 6, 7, 8] }] }),
    /"bad"/,
  );
});

test("more than one focal series fails loudly instead of picking a winner", () => {
  assert.throws(
    () => renderLine({ ...baseSpec, series: baseSpec.series.map((s) => ({ ...s, focal: true })) }),
    /focal/,
  );
});

test("more non-focal series than the palette can distinguish fails loudly", () => {
  const tooMany = {
    ...baseSpec,
    series: Array.from({ length: 5 }, (_, i) => ({ label: `s${i}`, values: xLabels.map(() => i) })),
  };
  assert.throws(() => renderLine(tooMany), /palette/);
});

test("an empty series list fails loudly instead of rendering nothing", () => {
  assert.throws(() => renderLine({ ...baseSpec, series: [] }), /at least one series/);
});

test("an empty xLabels list fails loudly instead of rendering nothing", () => {
  assert.throws(() => renderLine({ ...baseSpec, xLabels: [] }), /at least one x label/);
});
