import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPolar } from "../scripts/lib/diagrams/polar.mjs";
import { niceTicks } from "../scripts/lib/diagrams/scale.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

const HOURS = [
  "00:00",
  "02:00",
  "04:00",
  "06:00",
  "08:00",
  "10:00",
  "12:00",
  "14:00",
  "16:00",
  "18:00",
  "20:00",
  "22:00",
];

const SPEC = {
  kind: "polar",
  id: "hourly-demand",
  title: "Request demand by hour",
  slices: HOURS.map((label, i) => ({
    label,
    value: 20 + 15 * Math.sin((i / HOURS.length) * Math.PI * 2) + i,
    focal: i === 6,
  })),
  rLabel: "requests",
};

test("a 12-slice hourly spec renders with zero geometric findings", () => {
  const svg = renderPolar(SPEC);
  assert.deepEqual(validateSvg(svg), []);
});

test("one spoke and one value ray are drawn per slice with a positive value", () => {
  const svg = renderPolar(SPEC);
  const spokes = svg.match(/<line class="grid"/g) ?? [];
  assert.equal(spokes.length, SPEC.slices.length, "every slice gets a full-length spoke");
  const rays = svg.match(/<line class="ser[^"]*"/g) ?? [];
  const positive = SPEC.slices.filter((s) => s.value > 0).length;
  assert.equal(rays.length, positive, "only slices with a positive value draw a ray");
});

test("one grid ring is drawn per positive nice-tick", () => {
  const svg = renderPolar(SPEC);
  const maxValue = Math.max(...SPEC.slices.map((s) => s.value));
  const expected = niceTicks(0, maxValue, 5).ticks.filter((t) => t > 0).length;
  const rings = svg.match(/<circle class="grid"/g) ?? [];
  assert.equal(rings.length, expected);
});

test("exactly one focal ray and one focal marker are drawn", () => {
  const svg = renderPolar(SPEC);
  assert.equal((svg.match(/<line class="ser focal"/g) ?? []).length, 1);
  assert.equal((svg.match(/<circle class="mark focal"/g) ?? []).length, 1);
  // No backing rect: validateSvg collects circle marks directly, so the
  // duplicate hit-rect that used to exist for its benefit is gone.
  assert.equal((svg.match(/<rect class="mark/g) ?? []).length, 0);
});

test("every category label and the radius caption sit inside the viewBox", () => {
  const svg = renderPolar(SPEC);
  const view = /viewBox="(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)"/.exec(svg);
  assert.ok(view, "svg must declare a viewBox");
  const [vx, vy, vw, vh] = view.slice(1).map(Number);
  const labelPositions = [
    ...svg.matchAll(/<text class="(?:clab|atitle)" x="(-?[\d.]+)" y="(-?[\d.]+)"/g),
  ];
  assert.equal(
    labelPositions.length,
    SPEC.slices.length + 1,
    "one clab per slice plus the rLabel caption",
  );
  for (const [, xs, ys] of labelPositions) {
    const x = Number(xs);
    const y = Number(ys);
    assert.ok(x >= vx && x <= vx + vw, `label x=${x} falls outside viewBox width ${vw}`);
    assert.ok(y >= vy && y <= vy + vh, `label y=${y} falls outside viewBox height ${vh}`);
  }
  for (const label of HOURS) {
    assert.ok(svg.includes(`>${label}<`), `category label "${label}" missing from output`);
  }
  assert.ok(svg.includes(">REQUESTS<"), "the radius caption is rendered uppercased");
});

test("a radial tick label is masked wherever a ring passes behind it", () => {
  const svg = renderPolar(SPEC);
  const ringCount = (svg.match(/<circle class="grid"/g) ?? []).length;
  const tickMasks = svg.match(/<rect class="emask"/g) ?? [];
  const tickLabels = svg.match(/<text class="tick"/g) ?? [];
  assert.equal(tickLabels.length, ringCount, "one scale label per ring");
  assert.equal(tickMasks.length, ringCount, "each scale label gets its own emask backing");
});

test("fewer than 3 slices fails loudly, naming the count", () => {
  assert.throws(
    () => renderPolar({ ...SPEC, slices: SPEC.slices.slice(0, 2) }),
    /at least 3 slices, got 2/,
  );
});

test("a non-finite value fails loudly, naming the offending slice", () => {
  assert.throws(
    () =>
      renderPolar({
        ...SPEC,
        slices: [
          { label: "a", value: 1 },
          { label: "bad", value: NaN },
          { label: "c", value: 3 },
        ],
      }),
    /"bad".*non-finite value/,
  );
});

test("a negative value fails loudly, naming the offending slice", () => {
  assert.throws(
    () =>
      renderPolar({
        ...SPEC,
        slices: [
          { label: "a", value: 1 },
          { label: "bad", value: -5 },
          { label: "c", value: 3 },
        ],
      }),
    /"bad".*negative value/,
  );
});

test("more than one focal slice fails loudly", () => {
  assert.throws(
    () =>
      renderPolar({
        ...SPEC,
        slices: [
          { label: "a", value: 1, focal: true },
          { label: "b", value: 2, focal: true },
          { label: "c", value: 3 },
        ],
      }),
    /one focal slice, got 2/,
  );
});

test("a zero-value slice keeps its spoke but draws no ray or marker", () => {
  const svg = renderPolar({
    ...SPEC,
    slices: [
      { label: "a", value: 0 },
      { label: "b", value: 5 },
      { label: "c", value: 10 },
    ],
  });
  assert.deepEqual(validateSvg(svg), []);
  const spokes = svg.match(/<line class="grid"/g) ?? [];
  assert.equal(spokes.length, 3);
  const rays = svg.match(/<line class="ser[^"]*"/g) ?? [];
  assert.equal(rays.length, 2, "the zero-value slice draws no ray");
});
