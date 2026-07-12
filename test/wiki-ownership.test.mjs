import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ownershipMap,
  sharedCategories,
  mergedLayoutForRoot,
  partitionEntriesForCommit,
} from "../scripts/lib/wiki-ownership.mjs";

/** @type {string[]} */
const tmps = [];
function tmpRoot(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `lwm-${prefix}-`)));
  tmps.push(d);
  return d;
}
after(() => {
  for (const d of tmps) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function writeLayout(root, yaml) {
  fs.mkdirSync(path.join(root, ".layout"), { recursive: true });
  fs.writeFileSync(path.join(root, ".layout", "layout.yaml"), yaml);
}

test("ownershipMap keeps only entries with a repo/wiki ownership field", () => {
  const map = ownershipMap({
    layout: [
      { path: "knowledge", ownership: "repo" },
      { path: "self_improvement", ownership: "wiki" },
      { path: "plans" }, // no ownership -> omitted (baseline)
      { path: "bogus", ownership: "nonsense" }, // invalid -> omitted
    ],
  });
  assert.equal(map.get("knowledge"), "repo");
  assert.equal(map.get("self_improvement"), "wiki");
  assert.equal(map.has("plans"), false);
  assert.equal(map.has("bogus"), false);
});

test("ownershipMap / sharedCategories tolerate an empty or malformed layout", () => {
  assert.equal(ownershipMap({}).size, 0);
  assert.deepEqual(sharedCategories({}), []);
  assert.deepEqual(sharedCategories({ layout: "not-an-array" }), []);
});

test("sharedCategories returns only ownership==repo dirs, in layout order", () => {
  const layout = {
    layout: [
      { path: "knowledge", ownership: "repo" },
      { path: "self_improvement", ownership: "wiki" },
      { path: "team_lore", ownership: "repo" },
    ],
  };
  assert.deepEqual(sharedCategories(layout), ["knowledge", "team_lore"]);
});

test("mergedLayoutForRoot reads a root's layout.yaml (absent -> {})", () => {
  const root = tmpRoot("own-merge");
  assert.deepEqual(mergedLayoutForRoot(root), {}); // no .layout yet
  writeLayout(root, "layout:\n  - path: knowledge\n    ownership: repo\n");
  assert.deepEqual(sharedCategories(mergedLayoutForRoot(root)), ["knowledge"]);
});

test("partitionEntriesForCommit drops repo-owned leaves and groups survivors by root", () => {
  const rootRepo = tmpRoot("own-part-a");
  const rootBare = tmpRoot("own-part-b");
  writeLayout(
    rootRepo,
    "layout:\n  - path: knowledge\n    ownership: repo\n  - path: notes\n    ownership: wiki\n",
  );
  // rootBare has NO layout -> nothing is repo-owned -> its entry is kept.

  const entries = [
    {
      action: "saved",
      leafRelPath: "knowledge/a.md",
      reason: "",
      extraPaths: [],
      rootDir: rootRepo,
    },
    { action: "saved", leafRelPath: "notes/b.md", reason: "", extraPaths: [], rootDir: rootRepo },
    { action: "saved", leafRelPath: "notes/c.md", reason: "", extraPaths: [], rootDir: rootBare },
  ];
  const groups = partitionEntriesForCommit(entries, rootRepo);

  assert.deepEqual([...groups.keys()].sort(), [rootRepo, rootBare].sort());
  const repoGroup = groups.get(rootRepo) || [];
  assert.deepEqual(
    repoGroup.map((e) => e.leafRelPath),
    ["notes/b.md"],
    "the repo-owned knowledge/a.md was dropped; only notes/b.md survives in rootRepo",
  );
  const bareGroup = groups.get(rootBare) || [];
  assert.deepEqual(
    bareGroup.map((e) => e.leafRelPath),
    ["notes/c.md"],
    "rootBare has no ownership, so its entry is kept",
  );
});

test("partitionEntriesForCommit falls back to fallbackRoot for entries with no rootDir", () => {
  const root = tmpRoot("own-fallback");
  writeLayout(root, "layout:\n  - path: knowledge\n    ownership: wiki\n");
  const entries = [{ action: "saved", leafRelPath: "knowledge/x.md", reason: "", extraPaths: [] }];
  const groups = partitionEntriesForCommit(entries, root);
  assert.deepEqual([...groups.keys()], [root]);
  assert.equal((groups.get(root) || []).length, 1);
});
