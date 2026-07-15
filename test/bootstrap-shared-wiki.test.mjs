import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isSharedWiki } from "../scripts/bootstrap/shared-wiki.mjs";

const wikiWith = (layoutYaml) => {
  const wiki = fs.mkdtempSync(path.join(os.tmpdir(), "shared-wiki-"));
  fs.mkdirSync(path.join(wiki, ".layout"), { recursive: true });
  if (layoutYaml != null) fs.writeFileSync(path.join(wiki, ".layout", "layout.yaml"), layoutYaml);
  return wiki;
};

test("a default (all wiki-owned) layout is NOT shared", () => {
  const wiki = wikiWith("layout:\n  - path: knowledge\n    ownership: wiki\n");
  assert.equal(isSharedWiki(wiki), false);
  fs.rmSync(wiki, { recursive: true, force: true });
});

test("a layout with an ownership: repo category IS shared", () => {
  const wiki = wikiWith("layout:\n  - path: knowledge\n    ownership: repo\n");
  assert.equal(isSharedWiki(wiki), true);
  fs.rmSync(wiki, { recursive: true, force: true });
});

test("a mixed layout (any repo-owned category) IS shared", () => {
  const wiki = wikiWith(
    "layout:\n  - path: notes\n    ownership: wiki\n  - path: knowledge\n    ownership: repo\n",
  );
  assert.equal(isSharedWiki(wiki), true);
  fs.rmSync(wiki, { recursive: true, force: true });
});

test("a layout.local.yaml declaring a repo category flips detection to shared", () => {
  const wiki = wikiWith("layout:\n  - path: knowledge\n    ownership: wiki\n");
  fs.writeFileSync(
    path.join(wiki, ".layout", "layout.local.yaml"),
    "layout:\n  - path: runbooks\n    ownership: repo\n",
  );
  assert.equal(isSharedWiki(wiki), true);
  fs.rmSync(wiki, { recursive: true, force: true });
});

test("a missing layout → false (no throw)", () => {
  const wiki = fs.mkdtempSync(path.join(os.tmpdir(), "shared-wiki-none-"));
  assert.equal(isSharedWiki(wiki), false);
  assert.equal(isSharedWiki(path.join(wiki, "does-not-exist")), false);
  fs.rmSync(wiki, { recursive: true, force: true });
});

test("garbage layout YAML → false (no throw)", () => {
  const wiki = wikiWith(":\n::\n  not: [valid");
  assert.equal(isSharedWiki(wiki), false);
  fs.rmSync(wiki, { recursive: true, force: true });
});

test("CLI prints 1 for a shared wiki, 0 otherwise (the bootstrap detection source)", () => {
  const mod = path.resolve("scripts/bootstrap/shared-wiki.mjs");
  const shared = wikiWith("layout:\n  - path: knowledge\n    ownership: repo\n");
  const priv = wikiWith("layout:\n  - path: knowledge\n    ownership: wiki\n");
  const run = (d) => spawnSync(process.execPath, [mod, d], { encoding: "utf8" }).stdout;
  assert.equal(run(shared), "1");
  assert.equal(run(priv), "0");
  fs.rmSync(shared, { recursive: true, force: true });
  fs.rmSync(priv, { recursive: true, force: true });
});
