// ONE cold-embed ledger is shared by every recall rung, category and wiki level, so the first
// draw could spend the entire bound and every later one got nothing. That is not "fewer hits" for
// the later rungs — a leaf the budget refuses is stamped COLD_SKIP_SCORE and FILTERED OUT of the
// result set, so a starved rung returns zero, silently.
//
// The fix is allocative, not a bigger budget: each draw may take at most
// `max(floor, remaining - floor)`, which keeps a tail for whatever comes next. The invariant that
// makes it safe is that TOTAL spend is still bounded by maxColdPerRead — a cold search costs no
// more than before, the same texts are just distributed differently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeColdBudget, defaultColdBudget, coldShortfall } from "../scripts/lib/cold-budget.mjs";
import { withSettingsOverride } from "../scripts/lib/settings.mjs";

// Spends one text at a time until the current draw refuses, and reports how many it got.
/** @param {ReturnType<typeof makeColdBudget>} budget @returns {number} */
function drainDraw(budget) {
  let got = 0;
  while (budget.take(1)) got += 1;
  return got;
}

test("without a floor the ledger behaves exactly as before — one draw can take everything", () => {
  const budget = makeColdBudget(32);
  assert.equal(drainDraw(budget), 32, "no floor => no reservation, the legacy behaviour");
  assert.equal(budget.spent, 32);
});

test("a draw is capped so a later draw is never starved", () => {
  const budget = makeColdBudget(32, 8);
  budget.openDraw();
  assert.equal(drainDraw(budget), 24, "first draw takes max(8, 32-8) = 24, leaving a tail");
  budget.openDraw();
  assert.equal(drainDraw(budget), 8, "second draw takes the reserved 8 — previously it got ZERO");
  budget.openDraw();
  assert.equal(drainDraw(budget), 0, "the bound is still a bound");
});

// The load-bearing invariant. If this can fail, the change is not purely allocative and a cold
// search could cost more than it does today.
test("total spend never exceeds maxColdPerRead, however many draws are opened", () => {
  for (const draws of [1, 2, 3, 6, 12, 50]) {
    const budget = makeColdBudget(32, 8);
    for (let i = 0; i < draws; i += 1) {
      budget.openDraw();
      drainDraw(budget);
    }
    assert.equal(budget.spent <= 32, true, `${draws} draws spent ${budget.spent}, must be <= 32`);
  }
});

test("the ceiling holds for a range of budgets and floors", () => {
  for (const max of [0, 1, 5, 32, 100]) {
    for (const floor of [0, 1, 8, 32, 200]) {
      const budget = makeColdBudget(max, floor);
      for (let i = 0; i < 10; i += 1) {
        budget.openDraw();
        drainDraw(budget);
      }
      assert.equal(
        budget.spent <= max,
        true,
        `max=${max} floor=${floor} spent ${budget.spent}, must be <= ${max}`,
      );
    }
  }
});

test("a floor at or above the budget degenerates safely — the first draw takes it all", () => {
  const budget = makeColdBudget(32, 32);
  budget.openDraw();
  assert.equal(
    drainDraw(budget),
    32,
    "no reservation is possible, so do not starve the first draw",
  );
  budget.openDraw();
  assert.equal(drainDraw(budget), 0);
});

test("a zero budget skips everything without arithmetic trouble", () => {
  const budget = makeColdBudget(0, 8);
  budget.openDraw();
  assert.equal(drainDraw(budget), 0);
  assert.equal(budget.spent, 0);
});

// The background warm builds `makeColdBudget(Infinity)` purely as a counter and never opens a
// draw. It must stay unbounded, or the warm silently stops doing work after the first slice.
test("the counting-only Infinity ledger stays unbounded and is unaffected", () => {
  const budget = makeColdBudget(Infinity);
  for (let i = 0; i < 1000; i += 1) assert.equal(budget.take(1), true);
  assert.equal(budget.spent, 1000);
  budget.openDraw();
  assert.equal(budget.take(1), true, "opening a draw must not bound an Infinity ledger");
});

test("a multi-text take is all-or-nothing against the draw cap", () => {
  const budget = makeColdBudget(32, 8);
  budget.openDraw();
  assert.equal(budget.take(20), true, "fits inside the 24 cap");
  assert.equal(budget.take(20), false, "would exceed the cap — refused whole, not part-spent");
  assert.equal(budget.spent, 20, "a refused take spends nothing");
});

test("skipLeaf still counts leaves dropped, independently of spend", () => {
  const budget = makeColdBudget(2, 1);
  budget.openDraw();
  budget.take(1);
  budget.skipLeaf();
  budget.skipLeaf();
  assert.equal(budget.skipped, 2, "the count the advisory is built from");
  assert.equal(budget.spent, 1);
});

// The floor is DERIVED from the bound rather than configured separately, so this pins the
// documented default: maxColdPerRead 32 -> a floor of 8 -> a first draw of 24.
test("the default ledger derives its floor from embed.maxColdPerRead", async () => {
  await withSettingsOverride({ embed: { maxColdPerRead: 32 } }, async () => {
    const budget = defaultColdBudget();
    assert.ok(budget, "a non-maintenance read gets a bounded ledger");
    budget.openDraw();
    assert.equal(drainDraw(budget), 24, "32 -> floor 8 -> first draw 24");
    budget.openDraw();
    assert.equal(drainDraw(budget), 8, "and the reserved tail is available");
  });
});

test("a tiny bound does not reserve itself into uselessness", async () => {
  await withSettingsOverride({ embed: { maxColdPerRead: 1 } }, async () => {
    const budget = defaultColdBudget();
    assert.ok(budget);
    budget.openDraw();
    assert.equal(drainDraw(budget), 1, "a bound of 1 must still fund one leaf");
  });
});

test("coldShortfall reports only when leaves were actually dropped", () => {
  assert.equal(coldShortfall(null), null, "no ledger (maintenance) => nothing to report");
  const clean = makeColdBudget(32, 8);
  clean.take(4);
  assert.equal(coldShortfall(clean), null, "spending without skipping is not a shortfall");
  const starved = makeColdBudget(1, 0);
  starved.take(1);
  starved.skipLeaf();
  const report = coldShortfall(starved);
  assert.equal(report?.skippedLeaves, 1);
  assert.equal(report?.embeddedTexts, 1);
  assert.match(String(report?.remedy), /warm/, "must name the remedy, not just the symptom");
  assert.match(String(report?.remedy), /EXCLUDED|excluded/, "and say the leaves were dropped");
});
