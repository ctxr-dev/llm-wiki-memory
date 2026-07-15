import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { samePath } from "../scripts/lib/path-equal.mjs";

/** @type {string[]} */
const tmps = [];
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});

test("samePath: a dir equals itself and its trailing-slash form", () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pe-")));
  tmps.push(d);
  assert.equal(samePath(d, d), true);
  assert.equal(samePath(d, d + path.sep), true);
});

test("samePath: a dir equals an alias reaching it (symlink / non-canonical form)", () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pe-real-")));
  tmps.push(d);
  const link = fs.mkdtempSync(path.join(os.tmpdir(), "pe-link-")) + "-alias";
  fs.symlinkSync(d, link, process.platform === "win32" ? "junction" : undefined);
  tmps.push(link);
  assert.equal(samePath(d, link), true, "the symlink resolves to the same real dir");
});

test("samePath: distinct dirs are not equal", () => {
  const a = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pe-a-")));
  const b = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pe-b-")));
  tmps.push(a, b);
  assert.equal(samePath(a, b), false);
});

test("samePath: nonexistent paths fall back to resolve equality", () => {
  assert.equal(samePath("/no/such/x", "/no/such/x"), true);
  assert.equal(samePath("/no/such/x", "/no/such/y"), false);
});
