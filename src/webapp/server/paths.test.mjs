import { test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { samePath, samePathKey, realpathOr } from "./paths.mjs";

test("samePath is true for the same real dir via different lexical forms", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-p-")));
  expect(samePath(dir, path.join(dir, "sub", ".."))).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("samePath is false for different dirs", () => {
  expect(samePath(path.join("/a", "b"), path.join("/a", "c"))).toBe(false);
});

test("realpathOr falls back to resolve for a nonexistent path", () => {
  const resolved = realpathOr(path.join("/no", "such", "dir", "xyz"));
  expect(path.isAbsolute(resolved)).toBe(true);
});

test("samePathKey normalizes a trailing separator", () => {
  const base = path.join("/a", "b");
  expect(samePathKey(base)).toBe(samePathKey(`${base}${path.sep}`));
});
