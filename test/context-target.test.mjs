import test from "node:test";
import assert from "node:assert/strict";
import { parseTarget, TARGET_KIND } from "../scripts/lib/context/target.mjs";
import { resolveTargetLevel } from "../scripts/lib/wiki-context.mjs";

/** @typedef {import("../scripts/lib/wiki-context.mjs").WikiLevel} WikiLevel */
/** @typedef {import("../scripts/lib/wiki-context.mjs").WikiContext} WikiContext */

// sameDir falls back to path.resolve when a side can't be stat'd, so the fixture
// dirs need not exist on disk — identity of the returned level is what matters.
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

/** @param {unknown} v @returns {WikiContext} */
const asCtx = (v) => /** @type {WikiContext} */ (v);

test("TARGET_KIND carries the three discriminants", () => {
  assert.deepEqual({ ...TARGET_KIND }, { DEFAULT: "default", BRAIN: "brain", LEVEL: "level" });
});

test("empty / null / undefined / blank target resolves to default (writeDefault)", () => {
  const { ctx, brain } = makeCtx();
  for (const raw of [undefined, null, "", "   "]) {
    const r = parseTarget(ctx, raw);
    assert.equal(r.kind, TARGET_KIND.DEFAULT);
    assert.equal(r.level, brain, "same writeDefault reference");
    assert.equal(r.requested, null);
  }
});

test('the literal "brain" resolves to the wiki-owned level, kind brain', () => {
  const { ctx, brain } = makeCtx();
  const r = parseTarget(ctx, "brain");
  assert.equal(r.kind, TARGET_KIND.BRAIN);
  assert.equal(r.level, brain);
  assert.equal(r.requested, "brain");
});

test("a level's root OR mountDir resolves to that exact level, kind level", () => {
  const { ctx, repo, brain } = makeCtx();
  assert.equal(parseTarget(ctx, repo.root).level, repo);
  assert.equal(parseTarget(ctx, repo.mountDir).level, repo);
  assert.equal(parseTarget(ctx, repo.root).kind, TARGET_KIND.LEVEL);
  assert.equal(parseTarget(ctx, repo.root).requested, repo.root);
  assert.equal(parseTarget(ctx, brain.root).level, brain);
  assert.equal(parseTarget(ctx, brain.mountDir).level, brain);
});

test("a target naming no context level throws (never a silent brain fallback)", () => {
  const { ctx } = makeCtx();
  assert.throws(
    () => parseTarget(ctx, "/home/u/not-a-mount"),
    /not one of the active context levels/i,
  );
});

test("a missing or empty context throws", () => {
  assert.throws(() => parseTarget(asCtx(null), "brain"), /no resolved wiki context/);
  assert.throws(() => parseTarget(asCtx({ levels: [] }), "brain"), /no resolved wiki context/);
});

test("resolveTargetLevel delegates to parseTarget (identical level reference)", () => {
  const { ctx, repo, brain } = makeCtx();
  for (const raw of [undefined, null, "", "brain", repo.root, repo.mountDir, brain.mountDir]) {
    assert.equal(resolveTargetLevel(ctx, raw), parseTarget(ctx, raw).level);
  }
});
