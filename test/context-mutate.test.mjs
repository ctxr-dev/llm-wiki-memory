import test from "node:test";
import assert from "node:assert/strict";
import { parseMutateRequest, MUTATE_OP } from "../scripts/lib/context/mutate.mjs";
import { TARGET_KIND } from "../scripts/lib/context/target.mjs";

/** @typedef {import("../scripts/lib/wiki-context.mjs").WikiLevel} WikiLevel */
/** @typedef {import("../scripts/lib/wiki-context.mjs").WikiContext} WikiContext */

/** @returns {{ ctx: WikiContext, brain: WikiLevel, repo: WikiLevel }} */
function makeCtx() {
  /** @type {WikiLevel} */
  const brain = {
    root: "/home/u/.llm-wiki-memory/wiki",
    mountDir: "/home/u/.llm-wiki-memory",
    ownership: "wiki",
    projectModule: "brain",
    depth: 0,
    layout: {},
    embedCacheFor: () => "",
  };
  /** @type {WikiLevel} */
  const repo = {
    root: "/home/u/repo/.llm-wiki-memory/wiki",
    mountDir: "/home/u/repo/.llm-wiki-memory",
    ownership: "repo",
    projectModule: "repo",
    depth: 1,
    layout: {},
    embedCacheFor: () => "",
  };
  return { ctx: { levels: [brain, repo], brain, writeDefault: brain }, brain, repo };
}

test("MUTATE_OP carries the four document operations", () => {
  assert.deepEqual(
    { ...MUTATE_OP },
    { DISABLE: "disable", ENABLE: "enable", DELETE: "delete", MOVE: "move" },
  );
});

test("disable/enable/delete parse to a frozen typed request with the resolved target", () => {
  const { ctx, brain } = makeCtx();
  for (const op of [MUTATE_OP.DISABLE, MUTATE_OP.ENABLE, MUTATE_OP.DELETE]) {
    const req = parseMutateRequest(ctx, {
      op,
      dataset: "knowledge",
      documentId: "k/a.md",
      target: "brain",
    });
    assert.equal(req.op, op);
    assert.equal(req.dataset, "knowledge");
    assert.equal(req.documentId, "k/a.md");
    assert.equal(req.toPath, undefined);
    assert.equal(req.target.kind, TARGET_KIND.BRAIN);
    assert.equal(req.target.level, brain, 'explicit "brain" -> the wiki-owned level');
    assert.ok(Object.isFrozen(req), "request is frozen");
  }
});

test("a mutate with NO target is REJECTED (target is required, no brain default)", () => {
  const { ctx } = makeCtx();
  assert.throws(
    () =>
      parseMutateRequest(ctx, {
        op: MUTATE_OP.DISABLE,
        dataset: "knowledge",
        documentId: "k/a.md",
      }),
    (err) => err.envelope?.field === "target",
    "an omitted target throws the actionable envelope",
  );
});

test("an explicit target resolves the request against that level (not the brain)", () => {
  const { ctx, repo } = makeCtx();
  const req = parseMutateRequest(ctx, {
    op: MUTATE_OP.DISABLE,
    dataset: "knowledge",
    documentId: "k/a.md",
    target: repo.mountDir,
  });
  assert.equal(req.target.kind, TARGET_KIND.LEVEL);
  assert.equal(req.target.level, repo, "documentId resolves against the chosen level");
});

test("move parses toPath and keeps an optional (omitted) dataset", () => {
  const { ctx } = makeCtx();
  const req = parseMutateRequest(ctx, {
    op: MUTATE_OP.MOVE,
    documentId: "Notes/a.md",
    toPath: "Notes/Testing/a.md",
    target: "brain",
  });
  assert.equal(req.op, MUTATE_OP.MOVE);
  assert.equal(req.dataset, undefined, "move dataset is optional");
  assert.equal(req.toPath, "Notes/Testing/a.md");
});

test("an unknown op is rejected with an actionable envelope", () => {
  const { ctx } = makeCtx();
  try {
    parseMutateRequest(ctx, { op: "obliterate", documentId: "x.md" });
    assert.fail("expected a ContextValidationError");
  } catch (err) {
    assert.equal(err.name, "ContextValidationError");
    assert.equal(err.envelope.field, "op");
    assert.ok(err.envelope.allowed.includes("disable"), "envelope lists the allowed ops");
  }
});

test("move without a toPath is rejected at parse (never reaches the store)", () => {
  const { ctx } = makeCtx();
  for (const toPath of [undefined, "", "   "]) {
    try {
      parseMutateRequest(ctx, { op: MUTATE_OP.MOVE, documentId: "x.md", toPath });
      assert.fail("expected a ContextValidationError");
    } catch (err) {
      assert.equal(err.name, "ContextValidationError");
      assert.equal(err.envelope.field, "toPath");
    }
  }
});

test("a target naming no active level throws (can't mutate outside the resolved scopes)", () => {
  const { ctx } = makeCtx();
  assert.throws(
    () =>
      parseMutateRequest(ctx, {
        op: MUTATE_OP.DELETE,
        dataset: "knowledge",
        documentId: "k/a.md",
        target: "/home/u/not-a-mount",
      }),
    /not one of the active context levels/i,
  );
});
