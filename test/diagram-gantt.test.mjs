import { test } from "node:test";
import assert from "node:assert/strict";
import { renderGantt } from "../scripts/lib/diagrams/gantt.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

const SPEC = {
  kind: "gantt",
  id: "roadmap",
  title: "Backend migration roadmap",
  scale: { start: 0, end: 12, unit: "week" },
  tasks: [
    { label: "discovery", start: 0, end: 2, lane: "core" },
    { label: "port renderer to new backend", start: 2, end: 6, lane: "core", focal: true },
    { label: "design review", start: 3, end: 3, lane: "core", milestone: true },
    { label: "migrate consumers", start: 6, end: 9, lane: "downstream" },
    { label: "dual-write cutover", start: 9, end: 9, lane: "downstream", milestone: true },
    { label: "decommission old path", start: 9, end: 11, lane: "downstream" },
    { label: "retro", start: 11, end: 12 },
  ],
};

test("a gantt renders one bar per non-milestone task, a diamond per milestone, dividers between lanes", () => {
  const svg = renderGantt(SPEC);
  assert.match(svg, /<svg viewBox="[^"]+" role="img" aria-label="Backend migration roadmap">/);
  assert.match(svg, /<\/svg>$/);
  assert.equal(
    (svg.match(/<rect class="mark[^"]*"/g) ?? []).length,
    5,
    "5 of the 7 tasks are bars",
  );
  assert.equal(
    (svg.match(/<polygon class="mark[^"]*"/g) ?? []).length,
    2,
    "the two milestone tasks are diamonds, not bars",
  );
  assert.equal(
    (svg.match(/<line class="hair"/g) ?? []).length,
    2,
    "a divider between core/downstream and downstream/ungrouped",
  );
  assert.equal((svg.match(/<text class="tag"/g) ?? []).length, 2, "one eyebrow per lane group");
  assert.ok(svg.includes("discovery"), "an unwrapped task label reaches the output");
  assert.ok(
    svg.includes("renderer") && svg.includes("backend"),
    "a wrapped task label's pieces reach the output",
  );
  assert.ok(svg.includes("CORE") && svg.includes("DOWNSTREAM"), "lane tags are upper-cased");
  assert.match(svg, /<rect class="mark focal"/, "the focal task keeps its accent treatment");
});

test("a gantt with a milestone and two lanes has no geometric findings", () => {
  const svg = renderGantt(SPEC);
  assert.deepEqual(validateSvg(svg), []);
});

test("no bar rect is ever emitted for a milestone task", () => {
  const svg = renderGantt(SPEC);
  // Design review and dual-write cutover both have start === end; a rect bar of
  // zero width would be indistinguishable from a rendering bug, so neither may
  // ever appear as a <rect class="mark">.
  const barCount = (svg.match(/<rect class="mark[^"]*"/g) ?? []).length;
  const milestoneCount = SPEC.tasks.filter((t) => t.start === t.end).length;
  const nonMilestoneCount = SPEC.tasks.length - milestoneCount;
  assert.equal(barCount, nonMilestoneCount);
});

test("every bar and diamond stays within the numeric time axis bounds", () => {
  const svg = renderGantt(SPEC);
  const plotX = 80;
  const plotX2 = 960;
  for (const m of svg.matchAll(
    /<rect class="mark[^"]*" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g,
  )) {
    const x = Number(m[1]);
    const w = Number(m[2]);
    assert.ok(x >= plotX - 0.01, `bar starts at ${x}, before the axis at ${plotX}`);
    assert.ok(x + w <= plotX2 + 0.01, `bar ends at ${x + w}, past the axis at ${plotX2}`);
  }
  for (const m of svg.matchAll(/<polygon class="mark[^"]*" points="([^"]+)"/g)) {
    const xs = m[1].split(/\s+/).map((pair) => Number(pair.split(",")[0]));
    for (const x of xs) {
      assert.ok(
        x >= plotX - 0.01 && x <= plotX2 + 0.01,
        `diamond point at x=${x} is outside the axis`,
      );
    }
  }
});

test("a gantt needs at least one task", () => {
  assert.throws(
    () =>
      renderGantt({ kind: "gantt", id: "x", title: "t", scale: { start: 0, end: 5 }, tasks: [] }),
    /at least one task/,
  );
});

test("a degenerate time scale fails loudly", () => {
  assert.throws(
    () =>
      renderGantt({
        kind: "gantt",
        id: "x",
        title: "t",
        scale: { start: 5, end: 5 },
        tasks: [{ label: "a", start: 0, end: 1 }],
      }),
    /degenerate/,
  );
});

test("a task ending before it starts fails loudly, naming the task", () => {
  assert.throws(
    () =>
      renderGantt({
        kind: "gantt",
        id: "x",
        title: "t",
        scale: { start: 0, end: 5 },
        tasks: [{ label: "backwards task", start: 3, end: 1 }],
      }),
    /backwards task/,
  );
});
