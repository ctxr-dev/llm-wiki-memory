// The shared gated-category path predicate used by BOTH the L3 server gate
// (targetsGatedCategory) and the L2 hook (isGatedSelfImprovementCall). Pinning it
// here keeps the two surfaces in lockstep — a change that broke path-bypass
// detection would fail these falsifiable cases.
import { test } from "node:test";
import assert from "node:assert/strict";

const { placementTargetsCategory } = await import("../scripts/lib/gate-target.mjs");

test("placementTargetsCategory: first path segment matches the category", () => {
  assert.equal(placementTargetsCategory("self_improvement/area/x", "self_improvement"), true);
  assert.equal(placementTargetsCategory("/self_improvement/area", "self_improvement"), true, "leading slash stripped");
  assert.equal(placementTargetsCategory("self_improvement\\area", "self_improvement"), true, "backslash separator");
  assert.equal(placementTargetsCategory("///self_improvement", "self_improvement"), true, "multiple leading slashes");
  assert.equal(placementTargetsCategory("issues/JIRA/DEV/1", "issues"), true, "works for any category");
});

test("placementTargetsCategory: non-matching / empty / non-string -> false", () => {
  assert.equal(placementTargetsCategory("knowledge/x", "self_improvement"), false);
  assert.equal(placementTargetsCategory("self_improvementX/x", "self_improvement"), false, "no partial-segment match");
  assert.equal(placementTargetsCategory("", "self_improvement"), false);
  assert.equal(placementTargetsCategory("   ", "self_improvement"), false);
  assert.equal(placementTargetsCategory(undefined, "self_improvement"), false);
  assert.equal(placementTargetsCategory(null, "self_improvement"), false);
  assert.equal(placementTargetsCategory(123, "self_improvement"), false);
});
