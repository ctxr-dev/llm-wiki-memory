import { test, after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MEMORY_EMBED_BACKEND = "lexical";
const { setupWorkspace, cleanup } = await import("./harness.mjs");
const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

fs.writeFileSync(
  path.join(wiki, ".layout", "layout.yaml"),
  `mode: hosted
vocabularies:
  subject_domains: [architecture, operations, general]
layout:
  - path: knowledge
    placement_facets: [area, subject]
    facet_rules:
      subject: { kind: path, vocabulary: subject_domains, fallback: general }
    max_depth: 6
    consolidate: refine
  - path: daily
    placement_strategy: daily-date
    max_depth: 5
    consolidate: none
`,
);
const store = await import("../scripts/lib/wiki-store.mjs");
store._resetLayoutCacheForTests();
const { absorbPaths, leafNameFor } = await import("../scripts/lib/absorb-batch.mjs");

const SRC = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "absorb-batch-src-")));
after(() => fs.rmSync(SRC, { recursive: true, force: true }));
function seed(rel, body) {
  const p = path.join(SRC, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}
before(() => {
  seed("docs/a.md", "# A\n\nAlpha document body, long enough to be real.\n" + "x ".repeat(80));
  seed("docs/guide/a.md", "# Guide A\n\nA same-basename doc in a nested dir.\n" + "y ".repeat(80));
  seed("docs/empty.md", "   \n  "); // whitespace-only -> absorbDocument refuses -> failed[]
  seed("docs/notes.txt", "not markdown"); // filtered out by the default mask
});

afterEach(() => {
  delete process.env.MEMORY_LLM_PROVIDER;
  delete process.env.MEMORY_LLM_MOCK_RESPONSE;
});
function withMock(json, fn) {
  process.env.MEMORY_LLM_PROVIDER = "mock";
  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify(json);
  return fn();
}
function countLeaves(root) {
  let n = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md") && e.name !== "index.md") n += 1;
    }
  };
  if (fs.existsSync(root)) walk(root);
  return n;
}

test("leafNameFor: path relative to the absorb root, slugified, extension dropped→.md", () => {
  assert.equal(leafNameFor(path.join(SRC, "docs", "a.md"), path.join(SRC, "docs")), "a.md");
  assert.equal(
    leafNameFor(path.join(SRC, "docs", "guide", "a.md"), path.join(SRC, "docs")),
    "guide-a.md",
  );
});

test("absorbPaths: a directory tree → one full leaf per markdown file; same basename in two dirs → DISTINCT leaves", async () => {
  const res = await withMock(
    { area: "platform", atom_type: "reference", subject: ["architecture"] },
    () => absorbPaths({ paths: [path.join(SRC, "docs")], category: "knowledge" }),
  );
  assert.equal(res.matched, 3, "3 markdown files matched (notes.txt excluded)");
  assert.equal(res.absorbed.length, 2, "2 absorbed");
  assert.equal(res.failed.length, 1, "the empty file failed");
  assert.match(res.failed[0].file, /empty\.md$/);
  assert.match(res.failed[0].error, /empty/);
  const names = res.absorbed.map((a) => path.posix.basename(String(a.id))).sort();
  assert.deepEqual(names, ["a.md", "guide-a.md"], "path-derived distinct names (D1)");
  assert.equal(countLeaves(path.join(wiki, "knowledge")), 2);
});

test("absorbPaths: re-absorbing the same root is idempotent (overwrite, no new leaves)", async () => {
  const res = await withMock(
    { area: "platform", atom_type: "reference", subject: ["architecture"] },
    () => absorbPaths({ paths: [path.join(SRC, "docs")], category: "knowledge" }),
  );
  assert.equal(res.absorbed.length, 2);
  assert.equal(countLeaves(path.join(wiki, "knowledge")), 2, "still exactly two leaves");
});

test("absorbPaths: dryRun classifies every file but writes nothing", async () => {
  const wsBefore = countLeaves(path.join(wiki, "knowledge"));
  const res = await withMock(
    { area: "platform", atom_type: "reference", subject: ["architecture"] },
    () => absorbPaths({ paths: [path.join(SRC, "docs")], category: "knowledge", dryRun: true }),
  );
  assert.equal(res.absorbed.length, 2, "both proposals returned");
  assert.ok(
    res.absorbed.every((a) => a.id === undefined && a.dir),
    "proposals carry a dir but no id",
  );
  assert.equal(countLeaves(path.join(wiki, "knowledge")), wsBefore, "no new leaves written");
});

test("absorbPaths: a custom --match that matches nothing → 0 matched, no error", async () => {
  const res = await absorbPaths({
    paths: [path.join(SRC, "docs")],
    match: ["**/*.rst"],
    category: "knowledge",
  });
  assert.deepEqual(res, { absorbed: [], failed: [], matched: 0 });
});

test("absorbPaths: an empty directory / a missing path → 0 matched, no error", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "absorb-empty-"));
  after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const res = await absorbPaths({ paths: [empty, path.join(SRC, "nope")], category: "knowledge" });
  assert.deepEqual(res, { absorbed: [], failed: [], matched: 0 });
});

test("absorbPaths: two source paths that slug to the SAME name get DISTINCT leaves (no silent overwrite)", async () => {
  const col = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "absorb-collide-")));
  after(() => fs.rmSync(col, { recursive: true, force: true }));
  fs.mkdirSync(path.join(col, "a"), { recursive: true });
  fs.writeFileSync(path.join(col, "a", "b.md"), "# X\n\nbody X unique " + "x ".repeat(40));
  fs.writeFileSync(path.join(col, "a-b.md"), "# Y\n\nbody Y unique " + "y ".repeat(40));
  const res = await withMock(
    { area: "platform", atom_type: "reference", subject: ["architecture"] },
    () => absorbPaths({ paths: [col], category: "knowledge" }),
  );
  assert.equal(res.absorbed.length, 2, "both absorbed");
  const ids = res.absorbed.map((a) => String(a.id)).sort();
  assert.equal(new Set(ids).size, 2, "two DISTINCT leaf ids (no collision overwrite)");
  const bodies = ids.map((id) => fs.readFileSync(path.join(wiki, id), "utf8"));
  assert.ok(
    bodies.some((b) => b.includes("body X unique")) &&
      bodies.some((b) => b.includes("body Y unique")),
    "both source bodies preserved on disk",
  );
});
