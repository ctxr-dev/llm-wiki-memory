import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeLayouts, loadMergedLayout } from "../scripts/lib/layout-merge.mjs";
import { LayoutYamlSchema } from "../scripts/lib/layout-schema.mjs";
import { WikiLevelSchema, WikiContextSchema } from "../scripts/lib/wiki-context.mjs";

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeLayoutDir(sharedText, localText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-layout-merge-"));
  tmpDirs.push(dir);
  if (sharedText != null) fs.writeFileSync(path.join(dir, "layout.yaml"), sharedText);
  if (localText != null) fs.writeFileSync(path.join(dir, "layout.local.yaml"), localText);
  return dir;
}

test("mergeLayouts: shared wins on a colliding scalar (mode/purpose)", () => {
  const shared = { mode: "hosted", purpose: "SHARED purpose" };
  const local = { mode: "local-mode", purpose: "LOCAL purpose", extra_scalar: "keep-me" };
  const merged = mergeLayouts(shared, local);
  assert.equal(merged.mode, "hosted", "shared mode wins the collision");
  assert.equal(merged.purpose, "SHARED purpose", "shared purpose wins the collision");
  assert.equal(merged.extra_scalar, "keep-me", "a local-only scalar is preserved");
});

test("mergeLayouts: shared wins on a colliding scalar string array", () => {
  const shared = { some_list: ["a", "b"] };
  const local = { some_list: ["x"], local_only_list: ["m"] };
  const merged = mergeLayouts(shared, local);
  assert.deepEqual(merged.some_list, ["a", "b"], "shared array replaces the local array wholesale");
  assert.deepEqual(merged.local_only_list, ["m"], "a local-only array is preserved");
});

test("mergeLayouts: layout[] — shared entry replaces same-path local entry; local-only path survives", () => {
  const shared = { layout: [{ path: "knowledge", purpose: "SHARED-knowledge" }] };
  const local = {
    layout: [
      { path: "knowledge", purpose: "LOCAL-knowledge" },
      { path: "mynotes", purpose: "local only" },
    ],
  };
  const merged = mergeLayouts(shared, local);
  const entries = /** @type {Array<{ path: string, purpose: string }>} */ (merged.layout);
  const knowledge = entries.find((e) => e.path === "knowledge");
  const mynotes = entries.find((e) => e.path === "mynotes");
  assert.ok(knowledge, "knowledge entry present");
  assert.equal(
    knowledge.purpose,
    "SHARED-knowledge",
    "shared entry wins wholesale on path collision",
  );
  assert.ok(mynotes, "local-only path survives the merge");
  assert.equal(mynotes.purpose, "local only");
});

test("mergeLayouts: vocabularies — colliding key takes shared array; local-only key preserved", () => {
  const shared = { vocabularies: { subject_domains: ["a", "b"] } };
  const local = { vocabularies: { subject_domains: ["x"], my_vocab: ["m1"] } };
  const merged = mergeLayouts(shared, local);
  const vocabs = /** @type {Record<string, string[]>} */ (merged.vocabularies);
  assert.deepEqual(vocabs.subject_domains, ["a", "b"], "shared vocab array wins the collision");
  assert.deepEqual(vocabs.my_vocab, ["m1"], "a local-only vocab key is preserved");
});

test("mergeLayouts: empty/absent local returns shared unchanged", () => {
  const shared = { mode: "hosted", layout: [{ path: "knowledge" }] };
  assert.equal(mergeLayouts(shared, null), shared, "null local returns shared reference");
  assert.equal(mergeLayouts(shared, undefined), shared, "undefined local returns shared reference");
  assert.equal(mergeLayouts(shared, {}), shared, "empty-object local returns shared reference");
});

test("LayoutYamlSchema: duplicate layout[].path is rejected loudly", () => {
  const doc = { layout: [{ path: "knowledge" }, { path: "knowledge" }] };
  const result = LayoutYamlSchema.safeParse(doc);
  assert.equal(result.success, false, "duplicate path must fail validation");
  if (!result.success) {
    assert.ok(
      result.error.issues.some((i) => /duplicate/i.test(i.message)),
      `expected a duplicate-path issue, got ${JSON.stringify(result.error.issues)}`,
    );
  }
});

test("LayoutYamlSchema: distinct layout[].path values pass (no false positive)", () => {
  const doc = { layout: [{ path: "knowledge" }, { path: "daily" }] };
  const result = LayoutYamlSchema.safeParse(doc);
  assert.equal(result.success, true, JSON.stringify(!result.success && result.error.issues));
});

test("LayoutYamlSchema: ownership repo|wiki validates; an invalid ownership rejects", () => {
  for (const value of ["repo", "wiki"]) {
    const doc = { layout: [{ path: "knowledge", ownership: value }] };
    assert.equal(
      LayoutYamlSchema.safeParse(doc).success,
      true,
      `ownership: ${value} should validate`,
    );
  }
  const bad = { layout: [{ path: "knowledge", ownership: "server" }] };
  assert.equal(
    LayoutYamlSchema.safeParse(bad).success,
    false,
    "an unknown ownership value must reject",
  );
});

test("loadMergedLayout: malformed layout.local.yaml is ignored (uses shared), no crash", () => {
  const shared = "layout:\n  - path: knowledge\n  - path: daily\n";
  const dir = makeLayoutDir(shared, "layout: [this is: not: valid yaml\n  - oops");
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  let merged;
  try {
    merged = loadMergedLayout(dir);
  } finally {
    console.warn = orig;
  }
  const entries = /** @type {Array<{ path: string }>} */ (merged.layout);
  assert.deepEqual(
    entries.map((e) => e.path).sort(),
    ["daily", "knowledge"],
    "merged layout equals the shared layout when local is malformed",
  );
  assert.ok(
    warnings.some((w) => /local/i.test(w)),
    `expected a warning about the malformed local layout, got ${JSON.stringify(warnings)}`,
  );
});

test("loadMergedLayout: absent layout.local.yaml returns the shared layout", () => {
  const shared = "layout:\n  - path: knowledge\n  - path: daily\n";
  const dir = makeLayoutDir(shared, null);
  const merged = loadMergedLayout(dir);
  const entries = /** @type {Array<{ path: string }>} */ (merged.layout);
  assert.deepEqual(entries.map((e) => e.path).sort(), ["daily", "knowledge"]);
});

test("loadMergedLayout: a local-only category is added on top of shared", () => {
  const shared = "layout:\n  - path: knowledge\n  - path: daily\n";
  const local = "layout:\n  - path: scratch\n    placement_facets: []\n";
  const dir = makeLayoutDir(shared, local);
  const merged = loadMergedLayout(dir);
  const entries = /** @type {Array<{ path: string }>} */ (merged.layout);
  assert.deepEqual(entries.map((e) => e.path).sort(), ["daily", "knowledge", "scratch"]);
});

test("loadMergedLayout: an invalid merged layout is surfaced by throwing", () => {
  const dir = makeLayoutDir("layout: []\n", null);
  assert.throws(
    () => loadMergedLayout(dir),
    /validation/i,
    "an empty layout[] must fail validation loudly",
  );
});

test("WikiLevelSchema: accepts a valid level and rejects a bad ownership", () => {
  const level = {
    root: "/repo/.llm-wiki-memory/wiki",
    ownership: "wiki",
    depth: 0,
    projectModule: "repos",
    layout: { layout: [{ path: "knowledge" }] },
  };
  assert.equal(WikiLevelSchema.safeParse(level).success, true, "a well-formed level validates");
  assert.equal(
    WikiLevelSchema.safeParse({ ...level, ownership: "cloud" }).success,
    false,
    "an out-of-enum ownership rejects",
  );
});

test("WikiContextSchema: accepts a well-formed context, rejects a missing brain", () => {
  const level = {
    root: "/repo",
    ownership: "repo",
    depth: 1,
    projectModule: "repos",
    layout: {},
    embedBackend: "lexical",
  };
  const ctx = { levels: [level], brain: level, writeDefault: level };
  assert.equal(WikiContextSchema.safeParse(ctx).success, true, "a full context validates");
  assert.equal(
    WikiContextSchema.safeParse({ levels: [level] }).success,
    false,
    "a context without brain/writeDefault rejects",
  );
});
