import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRadar } from "../scripts/lib/diagrams/radar.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

const SPEC = {
  kind: "radar",
  id: "backend-scorecard",
  title: "Backend scorecard",
  axes: ["latency", "cost", "accuracy", "coverage", "effort"],
  series: [
    { label: "current", values: [3, 4, 2, 5, 3], focal: true },
    { label: "alternative", values: [4, 2, 4, 3, 2] },
  ],
  max: 5,
};

test("a 5-axis, 2-series radar renders with zero geometric findings", () => {
  const svg = renderRadar(SPEC);
  assert.deepEqual(validateSvg(svg), []);
});

test("one outline polygon is drawn per series", () => {
  const svg = renderRadar(SPEC);
  const polygons = svg.match(/<polygon class="ser[^"]*"/g) ?? [];
  assert.equal(polygons.length, SPEC.series.length);
});

test("one spoke and one grid ring are drawn per axis / ring fraction", () => {
  const svg = renderRadar(SPEC);
  const spokes = svg.match(/<line class="grid"/g) ?? [];
  assert.equal(spokes.length, SPEC.axes.length);
  const rings = svg.match(/<polygon class="grid"/g) ?? [];
  assert.equal(rings.length, 5, "0.2/0.4/0.6/0.8/1.0 fractions");
});

test("every axis name is drawn inside the viewBox", () => {
  const svg = renderRadar(SPEC);
  const view = /viewBox="(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)"/.exec(svg);
  assert.ok(view, "svg must declare a viewBox");
  const [vx, vy, vw, vh] = view.slice(1).map(Number);
  const labelPositions = [...svg.matchAll(/<text class="clab" x="(-?[\d.]+)" y="(-?[\d.]+)"/g)];
  assert.equal(labelPositions.length, SPEC.axes.length);
  for (const [, xs, ys] of labelPositions) {
    const x = Number(xs);
    const y = Number(ys);
    assert.ok(x >= vx && x <= vx + vw, `label x=${x} falls outside viewBox width ${vw}`);
    assert.ok(y >= vy && y <= vy + vh, `label y=${y} falls outside viewBox height ${vh}`);
  }
  for (const name of SPEC.axes) {
    assert.ok(svg.includes(`>${name}<`), `axis name "${name}" missing from output`);
  }
});

test("vertex dots are drawn only for the focal series, one per axis", () => {
  const svg = renderRadar(SPEC);
  const dots = svg.match(/<rect class="mark focal"/g) ?? [];
  assert.equal(dots.length, SPEC.axes.length);
});

test("a lone non-focal series still gets vertex dots so the mark class is never empty", () => {
  const svg = renderRadar({ ...SPEC, series: [{ label: "solo", values: [1, 2, 3, 4, 5] }] });
  assert.deepEqual(validateSvg(svg), []);
  const dots = svg.match(/<rect class="mark s1"/g) ?? [];
  assert.equal(dots.length, SPEC.axes.length);
});

test("fewer than 3 axes fails loudly", () => {
  assert.throws(
    () =>
      renderRadar({
        ...SPEC,
        axes: ["latency", "cost"],
        series: [{ label: "current", values: [1, 2] }],
      }),
    /3-8 axes/,
  );
});

test("more than 8 axes fails loudly", () => {
  const axes = Array.from({ length: 9 }, (_, i) => `axis${i}`);
  assert.throws(
    () =>
      renderRadar({
        ...SPEC,
        axes,
        series: [{ label: "current", values: axes.map(() => 1) }],
      }),
    /3-8 axes/,
  );
});

test("a series value count that does not match the axis count fails loudly, naming the series", () => {
  assert.throws(
    () => renderRadar({ ...SPEC, series: [{ label: "current", values: [1, 2, 3] }] }),
    /current/,
  );
});

test("a value outside 0..max fails loudly, naming the series and axis", () => {
  assert.throws(
    () =>
      renderRadar({
        ...SPEC,
        series: [{ label: "current", values: [3, 4, 2, 5, 99] }],
      }),
    /current.*effort/,
  );
});

test("more than one focal series fails loudly", () => {
  assert.throws(
    () =>
      renderRadar({
        ...SPEC,
        series: [
          { label: "a", values: [1, 2, 3, 4, 5], focal: true },
          { label: "b", values: [1, 2, 3, 4, 5], focal: true },
        ],
      }),
    /one focal/,
  );
});

test("more than 4 non-focal series fails loudly", () => {
  const series = Array.from({ length: 5 }, (_, i) => ({
    label: `s${i}`,
    values: [1, 2, 3, 4, 5],
  }));
  assert.throws(() => renderRadar({ ...SPEC, series }), /4 non-focal/);
});

test("a non-positive or missing max fails loudly", () => {
  assert.throws(() => renderRadar({ ...SPEC, max: 0 }), /positive finite max/);
  assert.throws(() => renderRadar({ ...SPEC, max: undefined }), /positive finite max/);
});
