// B9 (determinism acceptance, §6h) — validates the A6 nested/strict wire's
// enforcement END-TO-END over a REAL resolved multi-level context (brain + repo,
// with a sibling mount deliberately OUT of scope). Drives the parse seam
// (resolveWikiContext → parseWriteRequest) directly — the exact layer the MCP
// handlers call. Complements mcp.test (single-scope, over the live server): the
// property that can ONLY be shown with multiple levels is here — a `target`
// naming a real mount that is NOT in the resolved scope chain is REFUSED, so a
// write can never land outside the scopes the caller declared.
// Store-seam only (no bootstrap / git / network); realpath'd /tmp.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildFakeHome, mkdirp, rmAll } from "./federation-helpers.mjs";

/** @type {string[]} */
const tmps = [];
/** @type {(() => void) | undefined} */
let restore;
/** @type {import("../../scripts/lib/wiki-context.mjs").WikiContext} */
let ctx;
/** @type {{ parseWriteRequest: Function, WRITE_KIND: any }} */
let engine;
/** @type {import("../../scripts/lib/wiki-context.mjs").WikiLevel} */
let brainLevel;
/** @type {import("../../scripts/lib/wiki-context.mjs").WikiLevel} */
let repoLevel;
/** @type {string} */
let inScopeTarget;
/** @type {string} */
let outOfScopeTarget;

before(async () => {
  const built = await buildFakeHome({
    prefix: "b9-determinism",
    brainTemplate: "default",
    mounts: [
      { rel: "repo", template: "default" },
      { rel: "sibling", template: "default" },
    ],
  });
  restore = built.restore;
  tmps.push(built.home);
  const deepCwd = mkdirp(built.home, "repo/deep");
  const { resolveWikiContext } = await import("../../scripts/lib/wiki-context.mjs");
  const { parseWriteRequest, WRITE_KIND } = await import("../../scripts/lib/context/write.mjs");
  engine = { parseWriteRequest, WRITE_KIND };
  // Real up-walk from repo/deep → repo(mount) → home(brain). The `sibling` mount
  // is NOT an ancestor of the cwd, so it is deliberately OUT of scope.
  ctx = resolveWikiContext([deepCwd]);
  brainLevel = ctx.levels[0];
  repoLevel = ctx.levels[1];
  inScopeTarget = repoLevel.mountDir;
  outOfScopeTarget = path.join(built.mounts[1].dir, ".llm-wiki-memory");
});

after(() => {
  if (restore) restore();
  rmAll(tmps);
});

/** @param {Record<string, unknown>} [over] */
function write(over = {}) {
  return engine.parseWriteRequest(ctx, {
    kind: engine.WRITE_KIND.DOCUMENT,
    dataset: "knowledge",
    name: "det.md",
    text: "# det\n\nbody",
    ...over,
  });
}

/** @param {Record<string, unknown>} over @param {string} field */
function assertFieldRejected(over, field) {
  try {
    write(over);
    assert.fail(`expected a ContextValidationError on field "${field}"`);
  } catch (err) {
    assert.equal(err.name, "ContextValidationError", `${field}: got ${err.name}: ${err.message}`);
    assert.equal(err.envelope?.field, field, `rejected field is ${field}`);
  }
}

test("determinism: the scope chain is brain(0)+repo(1); the sibling mount is OUT of scope", () => {
  assert.deepEqual(
    ctx.levels.map((l) => l.depth),
    [0, 1],
    "only the cwd's ancestors resolve — sibling excluded",
  );
  assert.ok(
    !ctx.levels.some((l) => l.mountDir === outOfScopeTarget),
    "the sibling mount is not a resolved level",
  );
});

test("determinism: no target → the brain; an in-scope target → that level", () => {
  assert.equal(write().target.level, brainLevel, "default write lands in the brain");
  assert.equal(
    write({ target: inScopeTarget }).target.level,
    repoLevel,
    "in-scope target resolves",
  );
});

test("determinism: a target naming a real mount OUTSIDE the scope chain is REFUSED with an actionable envelope (C9)", () => {
  // The write can never escape the declared scopes: a real, initialised sibling
  // wiki that the up-walk did not reach cannot be targeted. The refusal carries
  // the {field, allowed[], reason} envelope, and allowed[] lists ACCEPTED TOKENS
  // (level roots/mountDirs + the brain sentinel), NOT module names (C9).
  try {
    write({ target: outOfScopeTarget });
    assert.fail("expected a ContextValidationError on field 'target'");
  } catch (err) {
    assert.equal(err.name, "ContextValidationError", `got ${err.name}: ${err.message}`);
    assert.equal(err.envelope?.field, "target", "the rejected field is 'target'");
    assert.match(err.message, /not one of the active context levels/i);
    const allowed = err.envelope?.allowed || [];
    assert.ok(allowed.includes("brain"), "the brain sentinel is an accepted token");
    assert.ok(
      allowed.some((a) => a === repoLevel.root || a === repoLevel.mountDir),
      "a level's root/mountDir is an accepted token",
    );
    assert.ok(
      !allowed.includes(repoLevel.projectModule),
      "module names are NOT offered as accepted tokens (C9)",
    );
  }
});

test("determinism: an undeclared dataset is rejected against the TARGET level's layout", () => {
  assertFieldRejected({ dataset: "no_such_category" }, "dataset");
});

test("determinism: off-vocabulary task_type / atom_type / priority are each rejected", () => {
  assertFieldRejected({ metadata: { task_type: "frobnicate" } }, "task_type");
  assertFieldRejected({ metadata: { atom_type: "not-an-atom-type" } }, "atom_type");
  assertFieldRejected({ metadata: { priority: "P9" } }, "priority");
});

test("determinism: the self_improvement gate is computed from BOTH dataset and path (bypass closed)", () => {
  assert.equal(write({ dataset: "knowledge" }).gated, false, "a knowledge write is not gated");
  assert.equal(
    write({ dataset: "self_improvement" }).gated,
    true,
    "a self_improvement dataset is gated",
  );
  assert.equal(
    write({ dataset: "knowledge", path: "self_improvement/sneaky" }).gated,
    true,
    "a knowledge dataset with a path that LANDS in self_improvement is still gated (bypass closed)",
  );
});
