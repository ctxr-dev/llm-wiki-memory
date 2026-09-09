import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTimeline } from "../scripts/lib/diagrams/timeline.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

const EVENTS = [
  { date: "2026-01", label: "kickoff", sub: "project charter signed" },
  { date: "2026-02", label: "design review" },
  { date: "2026-04", label: "alpha release", focal: true },
  { date: "2026-07", label: "beta release", sub: "external testers onboarded" },
  { date: "2026-09", label: "ga launch" },
  { date: "2026-12", label: "v2 planning" },
];

const SPEC = {
  kind: "timeline",
  id: "release-timeline",
  title: "Release timeline",
  events: EVENTS,
};

test("a 6-event spec renders with zero geometric findings", () => {
  const svg = renderTimeline(SPEC);
  assert.deepEqual(validateSvg(svg), []);
});

test("one dot and one card is drawn per event, alternating above and below the spine", () => {
  const svg = renderTimeline(SPEC);
  const dots = svg.match(/<circle class="dot"/g) ?? [];
  assert.equal(dots.length, EVENTS.length);
  const cardYs = [...svg.matchAll(/<rect class="nb[^"]*" x="[^"]+" y="(-?[\d.]+)"/g)].map((m) =>
    Number(m[1]),
  );
  assert.equal(cardYs.length, EVENTS.length);
  cardYs.forEach((y, i) => {
    if (i % 2 === 0) assert.ok(y < 0, `event ${i} (even index) should sit above the spine`);
    else assert.ok(y > 0, `event ${i} (odd index) should sit below the spine`);
  });
});

test("exactly one card is marked focal", () => {
  const svg = renderTimeline(SPEC);
  const focalCards = svg.match(/<rect class="nb focal"/g) ?? [];
  assert.equal(focalCards.length, 1);
});

test("events land in the same left-to-right order they were given", () => {
  const svg = renderTimeline(SPEC);
  const xs = [...svg.matchAll(/<circle class="dot" cx="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
  for (let i = 1; i < xs.length; i += 1) {
    assert.ok(xs[i] > xs[i - 1], `event ${i} should sit to the right of event ${i - 1}`);
  }
});

test("well-formed non-uniform dates space events proportionally to elapsed time, not evenly", () => {
  const svg = renderTimeline(SPEC);
  const xs = [...svg.matchAll(/<circle class="dot" cx="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
  const gaps = xs.slice(1).map((x, i) => x - xs[i]);
  // Jan->Feb is a 1-month gap; Apr->Jul is a 3-month gap. An honest scale must
  // render the longer real interval as the visually larger one.
  assert.ok(gaps[2] > gaps[0], "a 3-month gap must render wider than a 1-month gap");
  // Gaps must differ at all (a scale that collapsed to uniform spacing would
  // fail the "don't fake linear spacing" rule even if order were preserved).
  assert.ok(new Set(gaps.map((g) => Math.round(g))).size > 1);
});

test("dates that are not real calendar dates fall back to even spacing instead of throwing", () => {
  const svg = renderTimeline({
    ...SPEC,
    events: [
      { date: "Phase 1", label: "a" },
      { date: "Phase 2", label: "b" },
      { date: "Phase 3", label: "c" },
    ],
  });
  assert.deepEqual(validateSvg(svg), []);
  const xs = [...svg.matchAll(/<circle class="dot" cx="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
  const gap1 = xs[1] - xs[0];
  const gap2 = xs[2] - xs[1];
  assert.equal(gap1, gap2, "non-date labels must space evenly rather than through Date.parse");
});

test("fewer than 2 events fails loudly, naming the count", () => {
  assert.throws(
    () => renderTimeline({ ...SPEC, events: [{ date: "2026-01", label: "only" }] }),
    /at least 2 events, got 1/,
  );
});

test("more than one focal event fails loudly", () => {
  assert.throws(
    () =>
      renderTimeline({
        ...SPEC,
        events: [
          { date: "2026-01", label: "a", focal: true },
          { date: "2026-02", label: "b", focal: true },
          { date: "2026-03", label: "c" },
        ],
      }),
    /one focal event, got 2/,
  );
});

test("chronologically out-of-order dates fail loudly instead of rendering backwards", () => {
  assert.throws(
    () =>
      renderTimeline({
        ...SPEC,
        events: [
          { date: "2026-05", label: "a" },
          { date: "2026-01", label: "b" },
          { date: "2026-06", label: "c" },
        ],
      }),
    /chronological order/,
  );
});
