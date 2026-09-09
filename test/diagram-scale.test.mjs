import { test } from "node:test";
import assert from "node:assert/strict";
import {
  plotArea,
  niceTicks,
  linearScale,
  bandScale,
  formatTick,
  polarPoint,
} from "../scripts/lib/diagrams/scale.mjs";

test("the shared plot area matches the documented cartesian margins", () => {
  // Every cartesian chart uses these, so a bar / line / scatter of the same data
  // line up when a reader flips between them.
  const p = plotArea();
  assert.deepEqual(p, { x: 80, y: 40, w: 880, h: 380, x2: 960, y2: 420 });
});

test("niceTicks rounds to intervals a reader can add up", () => {
  // The failure this prevents: a raw span/count step labels the axis 0, 3.7, 7.4.
  const t = niceTicks(0, 37, 5);
  assert.ok(t.ticks.every((v) => Number.isInteger(v / t.step)));
  assert.ok(t.min <= 0 && t.max >= 37);
  assert.ok(
    [1, 2, 2.5, 5, 10].some(
      (m) => Math.abs(t.step / 10 ** Math.floor(Math.log10(t.step)) - m) < 1e-9,
    ),
  );
});

test("niceTicks brackets the data on both sides", () => {
  for (const [lo, hi] of [
    [0, 100],
    [-40, 40],
    [3, 7],
    [0.02, 0.09],
    [1200, 98000],
  ]) {
    const t = niceTicks(lo, hi);
    assert.ok(t.min <= lo, `min ${t.min} must bracket ${lo}`);
    assert.ok(t.max >= hi, `max ${t.max} must bracket ${hi}`);
    assert.ok(t.ticks.length >= 2);
  }
});

test("niceTicks never emits float-drift labels", () => {
  // Accumulating a fractional step by repeated addition yields ticks like
  // 0.30000000000000004, which reach the axis text verbatim.
  const t = niceTicks(0, 1, 5);
  for (const v of t.ticks) {
    assert.equal(v, Number(v.toPrecision(12)), `tick ${v} carries float drift`);
  }
});

test("a flat series still gets an axis with height", () => {
  // Otherwise every bar computes to zero height and the chart renders empty.
  const t = niceTicks(5, 5);
  assert.ok(t.max > t.min);
  const zero = niceTicks(0, 0);
  assert.ok(zero.max > zero.min);
});

test("niceTicks survives non-finite input rather than producing NaN geometry", () => {
  const t = niceTicks(NaN, Infinity);
  assert.ok(Number.isFinite(t.min) && Number.isFinite(t.max) && t.max > t.min);
});

test("linearScale maps the domain ends to the range ends, inverted y included", () => {
  const y = linearScale([0, 100], [420, 40]);
  assert.equal(y(0), 420);
  assert.equal(y(100), 40);
  assert.equal(y(50), 230);
});

test("linearScale on a zero-width domain returns the range start, never NaN", () => {
  const y = linearScale([7, 7], [420, 40]);
  assert.equal(y(7), 420);
  assert.ok(Number.isFinite(y(9)));
});

test("bandScale keeps the mark wider than the gap beside it", () => {
  // A gap wider than the bar reads as missing data rather than as spacing.
  const b = bandScale(5, 80, 880);
  assert.ok(b.width > b.pitch - b.width, "bar must exceed its gap");
  assert.equal(b.center(0), 80 + b.pitch / 2);
  assert.equal(b.start(0), b.center(0) - b.width / 2);
});

test("bandScale clamps a silly ratio instead of producing a zero-width mark", () => {
  assert.ok(bandScale(4, 0, 400, 0).width > 0);
  assert.ok(bandScale(4, 0, 400, 5).width <= bandScale(4, 0, 400).pitch);
  assert.ok(bandScale(0, 0, 400).width > 0, "an empty series must not divide by zero");
});

test("formatTick shows just enough precision", () => {
  assert.equal(formatTick(1000, 250), "1000");
  assert.equal(formatTick(0.25, 0.25), "0.25");
  assert.equal(formatTick(1, 0.5), "1");
  assert.equal(formatTick(0, 0.5), "0");
});

test("polarPoint starts at twelve o'clock and runs clockwise", () => {
  const top = polarPoint(0, 0, 10, 0, 4);
  assert.ok(Math.abs(top.x) < 1e-9 && Math.abs(top.y + 10) < 1e-9, "index 0 is straight up");
  const right = polarPoint(0, 0, 10, 1, 4);
  assert.ok(right.x > 9.99, "index 1 is clockwise, to the right");
});
