import test from "node:test";
import assert from "node:assert/strict";
import { parseWriteRequest, isGatedWrite, WRITE_KIND } from "../scripts/lib/context/write.mjs";
import { ContextValidationError } from "../scripts/lib/context/errors.mjs";

/** @typedef {import("../scripts/lib/wiki-context.mjs").WikiLevel} WikiLevel */
/** @typedef {import("../scripts/lib/wiki-context.mjs").WikiContext} WikiContext */

const DEFAULT_CATS = ["knowledge", "self_improvement", "plans", "investigations", "daily"];

/** @param {string} root @param {string} mountDir @param {"repo"|"wiki"} own @param {Record<string, unknown>} layout @returns {WikiLevel} */
function level(root, mountDir, own, layout) {
  return { root, mountDir, ownership: own, depth: 0, projectModule: "m", layout, embedCacheFor: () => "" };
}

// brain declares the 5 defaults (empty layout => baked-in defaults); the repo
// level additionally declares a flat `runbooks` category.
function makeCtx() {
  const brain = level("/h/.llm-wiki-memory/wiki", "/h/.llm-wiki-memory", "wiki", {});
  const repo = level("/h/r/.llm-wiki-memory/wiki", "/h/r/.llm-wiki-memory", "repo", {
    layout: [...DEFAULT_CATS, "runbooks"].map((p) => ({ path: p })),
  });
  return { ctx: /** @type {WikiContext} */ ({ levels: [brain, repo], brain, writeDefault: brain }), brain, repo };
}

const baseArgs = (over) => ({ kind: WRITE_KIND.DOCUMENT, dataset: "knowledge", ...over });

test("isGatedWrite: the OR of both signals (C4 — both bypass directions closed)", () => {
  assert.equal(isGatedWrite("self_improvement", undefined), true);
  assert.equal(isGatedWrite("knowledge", undefined), false);
  assert.equal(isGatedWrite("knowledge", "self_improvement/billing/x.md"), true, "path bypass caught");
  assert.equal(isGatedWrite("self_improvement", "knowledge/x.md"), true, "reverse bypass: dataset still gates");
  assert.equal(isGatedWrite("plans", "plans/x.md"), false);
  assert.equal(isGatedWrite("knowledge", null), false);
});

test("parseWriteRequest: a valid non-gated write parses; gated=false; frozen", () => {
  const { ctx, brain } = makeCtx();
  const req = parseWriteRequest(ctx, baseArgs({ name: "n", text: "t" }));
  assert.equal(req.dataset, "knowledge");
  assert.equal(req.gated, false);
  assert.equal(req.kind, WRITE_KIND.DOCUMENT);
  assert.equal(req.target.level, brain);
  assert.ok(Object.isFrozen(req));
});

test("parseWriteRequest: self_improvement dataset is gated", () => {
  const { ctx } = makeCtx();
  assert.equal(parseWriteRequest(ctx, baseArgs({ dataset: "self_improvement" })).gated, true);
});

test("parseWriteRequest: knowledge dataset + self_improvement path is gated (bypass closed)", () => {
  const { ctx } = makeCtx();
  const req = parseWriteRequest(ctx, baseArgs({ dataset: "knowledge", path: "self_improvement/x.md" }));
  assert.equal(req.gated, true);
});

test("parseWriteRequest: an undeclared dataset is rejected with an actionable envelope", () => {
  const { ctx } = makeCtx();
  try {
    parseWriteRequest(ctx, baseArgs({ dataset: "team" }));
    assert.fail("expected rejection");
  } catch (e) {
    assert.ok(e instanceof ContextValidationError);
    assert.equal(e.envelope.field, "dataset");
    assert.deepEqual(e.envelope.allowed, DEFAULT_CATS);
    assert.match(e.message, /not a category declared/);
  }
});

test("parseWriteRequest: dataset is validated against the TARGET level's layout (C7)", () => {
  const { ctx, repo } = makeCtx();
  // runbooks is declared at the repo level -> accepted when target is the repo,
  assert.equal(parseWriteRequest(ctx, baseArgs({ dataset: "runbooks", target: repo.root })).dataset, "runbooks");
  // but NOT at the brain (default target) -> rejected.
  assert.throws(
    () => parseWriteRequest(ctx, baseArgs({ dataset: "runbooks" })),
    (e) => e instanceof ContextValidationError && e.envelope.field === "dataset",
  );
});

test("parseWriteRequest: off-vocabulary metadata is rejected per field", () => {
  const { ctx } = makeCtx();
  const cases = [
    ["task_type", { task_type: "frobnicate" }],
    ["atom_type", { atom_type: "made-up-type" }],
    ["priority", { priority: "P9" }],
  ];
  for (const [field, metadata] of cases) {
    assert.throws(
      () => parseWriteRequest(ctx, baseArgs({ metadata })),
      (e) => e instanceof ContextValidationError && e.envelope.field === field,
      `expected ${field} rejection`,
    );
  }
});

test("parseWriteRequest: in-vocabulary metadata passes", () => {
  const { ctx } = makeCtx();
  const req = parseWriteRequest(
    ctx,
    baseArgs({ dataset: "self_improvement", metadata: { task_type: "debugging", priority: "P1" } }),
  );
  assert.equal(req.metadata?.task_type, "debugging");
});

test("parseWriteRequest: an unknown write kind is rejected", () => {
  const { ctx } = makeCtx();
  assert.throws(
    () => parseWriteRequest(ctx, baseArgs({ kind: "bogus" })),
    (e) => e instanceof ContextValidationError && e.envelope.field === "kind",
  );
});
