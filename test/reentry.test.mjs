import { test } from "node:test";
import assert from "node:assert/strict";
import { REENTRY_VARS, isReentrant, reentryEnv } from "../scripts/lib/reentry.mjs";

test("isReentrant: false on a clean env", () => {
  assert.equal(isReentrant({}), false);
});

test("isReentrant: true when the neutral MEMORY_HOOK_REENTRY is set", () => {
  assert.equal(isReentrant({ MEMORY_HOOK_REENTRY: "memory-flush" }), true);
});

test("isReentrant: true when the legacy CLAUDE_INVOKED_BY is set", () => {
  assert.equal(isReentrant({ CLAUDE_INVOKED_BY: "memory_compile" }), true);
});

test("isReentrant: an empty-string guard is not reentrant", () => {
  assert.equal(isReentrant({ MEMORY_HOOK_REENTRY: "" }), false);
});

test("reentryEnv: sets every guard var to the tag and preserves the base env", () => {
  const out = reentryEnv("memory-distill", { PATH: "/usr/bin", FOO: "bar" });
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.FOO, "bar");
  for (const name of REENTRY_VARS) assert.equal(out[name], "memory-distill");
  // The product of reentryEnv is itself recognised as reentrant.
  assert.equal(isReentrant(out), true);
});
