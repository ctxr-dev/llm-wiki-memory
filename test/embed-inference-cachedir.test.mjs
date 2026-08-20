// `applyCacheDir` mutates the transformers module-global `env.cacheDir`, which persists for
// the process. The bug it fixes: assigning only when a value was PRESENT meant clearing the
// setting never took effect — and because the embedder memo keys on `cacheDir`, clearing it
// forced a full model rebuild that then resolved weights from the OLD directory. The cost of
// the rebuild with none of its effect.
//
// Driven over a fake `env` object because the real one belongs to transformers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCacheDir } from "../scripts/lib/embed-inference.mjs";

test("an explicit cacheDir overrides, and clearing it RESTORES the builtin default", () => {
  const env = { cacheDir: "/builtin/default" };
  applyCacheDir(env, "/user/models");
  assert.equal(env.cacheDir, "/user/models", "an explicit value wins");
  applyCacheDir(env, undefined);
  assert.equal(env.cacheDir, "/builtin/default", "clearing restores the captured builtin");
  applyCacheDir(env, "/user/models");
  assert.equal(env.cacheDir, "/user/models", "and it can be set again");
});

test("the builtin is captured BEFORE any assignment, so it is never a value we wrote", () => {
  // The hazard: capturing lazily on a later call would latch whatever this function had
  // already written, and "clear" would then restore the override instead of the default.
  const env = { cacheDir: "/genuine/builtin" };
  applyCacheDir(env, "/override/one");
  applyCacheDir(env, "/override/two");
  applyCacheDir(env, undefined);
  assert.equal(env.cacheDir, "/genuine/builtin", "not /override/one or /override/two");
});

test("an empty string is treated as absent, not as a directory named ''", () => {
  const env = { cacheDir: "/builtin/default" };
  applyCacheDir(env, "");
  assert.equal(env.cacheDir, "/builtin/default", "an empty setting means 'use the default'");
});
