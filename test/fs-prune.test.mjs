import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneEmptyAncestors } from "../scripts/lib/fs-prune.mjs";

// Pure fs unit tests of the {removed, survivor} contract. The survivor is the
// dir whose index.md the CALLER must rebuild (it still lists the pruned child);
// null means nothing was pruned so no stale ref can exist.

const roots = [];
function mkTmp() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-prune-"));
  roots.push(r);
  return r;
}
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const mkdir = (p) => (fs.mkdirSync(p, { recursive: true }), p);
const leaf = (dir, name) => fs.writeFileSync(path.join(dir, name), "---\nid: y\n---\nbody");
const idx = (dir) => fs.writeFileSync(path.join(dir, "index.md"), "---\nid: x\ntype: index\n---\n");

test("nothing pruned when the dir is meaningful -> survivor null", () => {
  const root = mkTmp();
  const A = mkdir(path.join(root, "A"));
  leaf(A, "keep.md");
  const res = pruneEmptyAncestors(A, root);
  assert.deepEqual(res, { removed: [], survivor: null });
  assert.ok(fs.existsSync(A), "meaningful dir untouched");
});

test("one empty child removed -> survivor is its parent", () => {
  const root = mkTmp();
  const A = mkdir(path.join(root, "A"));
  leaf(A, "keep.md");
  const B = mkdir(path.join(A, "B")); // empty
  const res = pruneEmptyAncestors(B, root);
  assert.deepEqual(res.removed, [path.resolve(B)]);
  assert.equal(res.survivor, path.resolve(A));
  assert.ok(!fs.existsSync(B) && fs.existsSync(A));
});

test("climbs several empty levels -> survivor is the highest meaningful dir", () => {
  const root = mkTmp();
  const X = mkdir(path.join(root, "X"));
  leaf(X, "keep.md"); // meaningful; stops the climb
  const B = mkdir(path.join(X, "B"));
  const C = mkdir(path.join(B, "C")); // empty leaf of the chain
  const res = pruneEmptyAncestors(C, root);
  assert.deepEqual(res.removed, [path.resolve(C), path.resolve(B)]);
  assert.equal(res.survivor, path.resolve(X));
  assert.ok(!fs.existsSync(C) && !fs.existsSync(B) && fs.existsSync(X));
});

test("climb reaches the wiki root -> survivor is the wiki root (never removed)", () => {
  const root = mkTmp();
  const A = mkdir(path.join(root, "A"));
  const B = mkdir(path.join(A, "B")); // A contains only B; both go
  const res = pruneEmptyAncestors(B, root);
  assert.deepEqual(res.removed, [path.resolve(B), path.resolve(A)]);
  assert.equal(res.survivor, path.resolve(root));
  assert.ok(fs.existsSync(root) && !fs.existsSync(A), "root kept, A pruned");
});

test("an index-only dir is removed (unlink index.md then rmdir) and counted", () => {
  const root = mkTmp();
  const M = mkdir(path.join(root, "M"));
  leaf(M, "keep.md");
  const B = mkdir(path.join(M, "B"));
  idx(B); // only an auto-generated index.md
  const res = pruneEmptyAncestors(B, root);
  assert.deepEqual(res.removed, [path.resolve(B)]);
  assert.equal(res.survivor, path.resolve(M));
  assert.ok(!fs.existsSync(B), "index-only dir removed");
});
