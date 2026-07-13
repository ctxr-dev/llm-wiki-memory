import test from "node:test";
import assert from "node:assert/strict";
import { defaultProjectModule, workspaceIdentity } from "../scripts/lib/env.mjs";

test("defaultProjectModule: an explicit env override always wins", () => {
  const saved = process.env.MEMORY_DEFAULT_PROJECT_MODULE;
  process.env.MEMORY_DEFAULT_PROJECT_MODULE = "explicit/override";
  try {
    assert.equal(defaultProjectModule(), "explicit/override");
  } finally {
    if (saved === undefined) delete process.env.MEMORY_DEFAULT_PROJECT_MODULE;
    else process.env.MEMORY_DEFAULT_PROJECT_MODULE = saved;
  }
});

test("workspaceIdentity: a deterministic git-origin (org/repo) or file:// identity, never a bare basename", () => {
  const id = workspaceIdentity();
  assert.ok(id, "non-empty");
  assert.ok(id.includes("/"), `carries a path/org separator (git org/repo or file://): ${id}`);
});
