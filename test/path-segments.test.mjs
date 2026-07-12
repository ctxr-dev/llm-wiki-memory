import test from "node:test";
import assert from "node:assert/strict";
import { pathSegments } from "../scripts/lib/path-segments.mjs";

test("pathSegments splits on both slash kinds and drops empty + `.` segments", () => {
  assert.deepEqual(pathSegments("self_improvement/a/b"), ["self_improvement", "a", "b"]);
  assert.deepEqual(pathSegments("./self_improvement/x"), ["self_improvement", "x"]);
  assert.deepEqual(pathSegments("././self_improvement"), ["self_improvement"]);
  assert.deepEqual(pathSegments("/self_improvement//x"), ["self_improvement", "x"]);
  assert.deepEqual(pathSegments("a\\b\\c"), ["a", "b", "c"]);
});

test("pathSegments keeps `..` (placement rejects it separately) and handles non-strings", () => {
  assert.deepEqual(pathSegments(".."), [".."]);
  assert.deepEqual(pathSegments("."), []);
  assert.deepEqual(pathSegments(""), []);
  assert.deepEqual(pathSegments("   "), ["   "]);
  assert.deepEqual(pathSegments(undefined), []);
  assert.deepEqual(pathSegments(null), []);
  assert.deepEqual(pathSegments(123), []);
});
