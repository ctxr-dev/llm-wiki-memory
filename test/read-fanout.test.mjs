import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A FIXED settings home carries the lexical embed backend (settings are
// brain-global: read from MEMORY_DATA_DIR regardless of which level's tree a
// search is scoped to). Each test then builds its OWN federation under a fresh
// temp home and passes it as `brainDataDir`, so the trees are independent while
// every search still ranks with the deterministic lexical scorer.
const SETTINGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-fanout-set-"));
process.env.MEMORY_DATA_DIR = path.join(SETTINGS_HOME, ".llm-wiki-memory");
process.env.MEMORY_DEFAULT_PROJECT_MODULE = "brainmod";
fs.mkdirSync(path.join(process.env.MEMORY_DATA_DIR, "settings"), { recursive: true });
fs.writeFileSync(
  path.join(process.env.MEMORY_DATA_DIR, "settings", "settings.yaml"),
  "embed:\n  backend: lexical\nconsolidate:\n  enabled: false\n",
);

const { searchMemoryFiltered, searchOneTree } = await import("../scripts/lib/wiki-store.mjs");
const { recallLessons, searchMemory } = await import("../scripts/lib/recall.mjs");
const { resolveWikiContext, withWikiContext } = await import("../scripts/lib/wiki-context.mjs");
const { clampSearchResponse, SEARCH_TOTAL_BUDGET } =
  await import("../scripts/lib/search-clamp.mjs");

const tmpDirs = [SETTINGS_HOME];
after(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-fanout-"));
  tmpDirs.push(home);
  return home;
}

// Build a wiki mount at `dir` declaring `cats`; returns the wiki root.
function mkMount(dir, cats) {
  const wikiRoot = path.join(dir, ".llm-wiki-memory", "wiki");
  const layoutDir = path.join(wikiRoot, ".layout");
  fs.mkdirSync(layoutDir, { recursive: true });
  fs.writeFileSync(
    path.join(layoutDir, "layout.yaml"),
    `layout:\n${cats.map((c) => `  - path: ${c}`).join("\n")}\n`,
  );
  return wikiRoot;
}

function writeLeaf(wikiRoot, category, name, { body, memory }) {
  const dir = path.join(wikiRoot, category);
  fs.mkdirSync(dir, { recursive: true });
  const fm = ["---", "memory:"];
  for (const [k, v] of Object.entries(memory)) fm.push(`  ${k}: ${v}`);
  fm.push("---", "", body, "");
  fs.writeFileSync(path.join(dir, name), fm.join("\n"));
}

function brainOpts(home) {
  return { home, brainDataDir: path.join(home, ".llm-wiki-memory") };
}

// ─── clamp: level-scaled budget, no dropped hits, priority governs spend ─────

test("clamp: total budget scales with the level count so more bodies survive", () => {
  const body = "x".repeat(599);
  const single = {
    records: Array.from({ length: 40 }, (_, i) => ({
      documentId: `s${i}`,
      priority: "P1",
      content: body,
    })),
  };
  const multi = {
    records: Array.from({ length: 40 }, (_, i) => ({
      documentId: `m${i}`,
      priority: "P1",
      content: body,
      depth: i % 2, // two distinct depths -> two contributing levels
    })),
  };
  const outSingle = clampSearchResponse(single);
  const outMulti = clampSearchResponse(multi);
  const alive = (o) => o.records.filter((r) => r.content.length > 0).length;
  assert.equal(outSingle.records.length, 40, "single-level: no hit dropped");
  assert.equal(outMulti.records.length, 40, "multi-level: no hit dropped");
  assert.ok(
    alive(outMulti) > alive(outSingle),
    `multi-level budget lets more bodies through (multi=${alive(outMulti)}, single=${alive(outSingle)})`,
  );
});

test("clamp: priority (not depth) governs body spend — deep P0 survives, shallow P2 emptied", () => {
  const body = "x".repeat(599);
  const records = [
    ...Array.from({ length: 60 }, (_, i) => ({
      documentId: `p2_${i}`,
      priority: "P2",
      content: body,
      depth: 0,
    })),
    { documentId: "p0deep", priority: "P0", content: body, depth: 2 },
  ];
  const out = clampSearchResponse({ records });
  assert.equal(out.records.length, 61, "no hit dropped from the ranked list");
  const p0 = out.records.find((r) => r.documentId === "p0deep");
  assert.ok(
    p0 && p0.content.length > 0,
    "the deepest hit keeps its body because it is P0 (priority spent first, not depth)",
  );
  const emptiedShallow = out.records.filter((r) => r.priority === "P2" && r.content === "").length;
  assert.ok(emptiedShallow > 0, "some shallow P2 bodies are emptied once the budget is spent");
});

test("clamp: single-tree response (no depth tags) keeps the un-scaled budget", () => {
  const body = "x".repeat(599);
  const records = Array.from({ length: 60 }, (_, i) => ({
    documentId: `h${i}`,
    priority: "P1",
    content: body,
  }));
  const out = clampSearchResponse({ records });
  const totalChars = out.records.reduce((s, r) => s + r.content.length, 0);
  assert.ok(
    totalChars <= SEARCH_TOTAL_BUDGET + 600,
    `within the single-level budget: ${totalChars}`,
  );
});

// ─── §3f worked example: additive depth boost, deeper wins ───────────────────

test("§3f worked example: a DEEPER level's hits outrank a shallower one's (order W2,W1,R1,H1)", async () => {
  const home = makeHome();
  const brain = mkMount(home, ["knowledge", "daily"]);
  const repos = mkMount(path.join(home, "repos"), ["knowledge", "daily"]);
  const webhooks = mkMount(path.join(home, "repos", "webhooks"), ["knowledge", "daily"]);
  const mem = { atom_type: "knowledge-fact" };
  // All four match the query to SOME degree; within the deepest level W2 matches
  // better than W1. Depth dominates cross-level, so the final order inverts the
  // pure-cosine order (which would be W2, H1, R1, W1).
  writeLeaf(brain, "knowledge", "H1.md", { body: "octopus garden brain note alpha", memory: mem });
  writeLeaf(repos, "knowledge", "R1.md", {
    body: "octopus garden repos note beta gamma",
    memory: mem,
  });
  writeLeaf(webhooks, "knowledge", "W1.md", {
    body: "octopus filler webhook note delta epsilon zeta",
    memory: mem,
  });
  writeLeaf(webhooks, "knowledge", "W2.md", { body: "octopus garden", memory: mem });

  const ctx = resolveWikiContext([path.join(home, "repos", "webhooks")], brainOpts(home));
  assert.deepEqual(
    ctx.levels.map((l) => l.depth),
    [0, 1, 2],
    "brain(d0), repos(d1), webhooks(d2)",
  );

  const out = await withWikiContext(ctx, () =>
    searchMemoryFiltered({ query: "octopus garden", datasetId: "knowledge" }),
  );
  assert.deepEqual(
    out.records.map((r) => r.documentName),
    ["W2.md", "W1.md", "R1.md", "H1.md"],
    "deeper wins: both webhooks hits, then repos, then brain",
  );
  // adjustedConfidence is strictly descending and equals cosine + depth*boost.
  for (const r of out.records) {
    assert.equal(r.cosine, r.score, "score stays the honest cosine");
    assert.equal(r.depthBoost, r.depth * 1, "default depthBoostPerLevel = 1");
    assert.equal(r.adjustedConfidence, r.cosine + r.depthBoost, "additive ranking");
  }
  const adj = out.records.map((r) => r.adjustedConfidence);
  for (let i = 1; i < adj.length; i += 1) {
    assert.ok(adj[i - 1] >= adj[i], "sorted by adjustedConfidence DESC");
  }
  assert.equal(out.records[0].depth, 2, "top hit is the deepest level");
  assert.equal(out.records[3].depth, 0, "the brain hit is last despite a mid cosine");
});

// ─── regression: single level is byte-identical to the single-tree scorer ────

test("single-level fan-out is byte-identical to searchOneTree (no depth fields)", async () => {
  const home = makeHome();
  const brain = mkMount(home, ["knowledge", "daily"]);
  const mem = { atom_type: "knowledge-fact" };
  writeLeaf(brain, "knowledge", "A.md", { body: "quokka wombat alpha note", memory: mem });
  writeLeaf(brain, "knowledge", "B.md", { body: "quokka bilby beta note", memory: mem });

  const ctx = resolveWikiContext([], brainOpts(home)); // brain-only: one level
  assert.equal(ctx.levels.length, 1, "single-level context");

  const viaFanout = await withWikiContext(ctx, () =>
    searchMemoryFiltered({ query: "quokka note", datasetId: "knowledge" }),
  );
  const viaOneTree = await withWikiContext(ctx, () =>
    searchOneTree({ query: "quokka note", datasetId: "knowledge" }),
  );
  assert.deepEqual(viaFanout, viaOneTree, "one-level door == single-tree scorer, exactly");
  for (const r of viaFanout.records) {
    assert.equal(r.depth, undefined, "no depth tag on a single-tree hit");
    assert.equal(r.adjustedConfidence, undefined, "no adjustedConfidence on a single-tree hit");
    assert.equal(r.resolvedRoot, undefined, "no resolvedRoot on a single-tree hit");
  }
});

// ─── tree-namespaced dedupe ──────────────────────────────────────────────────

test("dedupe: the SAME rel path in two DIFFERENT trees both survive", async () => {
  const home = makeHome();
  const brain = mkMount(home, ["knowledge", "daily"]);
  const repos = mkMount(path.join(home, "repos"), ["knowledge", "daily"]);
  const mem = { atom_type: "knowledge-fact" };
  writeLeaf(brain, "knowledge", "DUPE.md", { body: "narwhal shared relpath brain", memory: mem });
  writeLeaf(repos, "knowledge", "DUPE.md", { body: "narwhal shared relpath repos", memory: mem });

  const ctx = resolveWikiContext([path.join(home, "repos")], brainOpts(home));
  const out = await withWikiContext(ctx, () =>
    searchMemoryFiltered({ query: "narwhal shared relpath", datasetId: "knowledge" }),
  );
  const dupes = out.records.filter((r) => r.documentName === "DUPE.md");
  assert.equal(dupes.length, 2, "both same-rel-path leaves survive (keyed on tree root)");
  assert.equal(new Set(dupes.map((r) => r.resolvedRoot)).size, 2, "distinct tree roots");
  assert.deepEqual(
    [...new Set(dupes.map((r) => r.depth))].sort(),
    [0, 1],
    "one from the brain (d0), one from the repo (d1)",
  );
});

// ─── per-level project_module ────────────────────────────────────────────────

test("per-level project_module: a mount leaf tagged with a DIFFERENT module is still returned", async () => {
  const home = makeHome();
  const brain = mkMount(home, ["knowledge", "daily"]);
  const webhooks = mkMount(path.join(home, "webhooks"), ["knowledge", "daily"]);
  writeLeaf(brain, "knowledge", "BrainFact.md", {
    body: "platypus config note",
    memory: { atom_type: "knowledge-fact", project_module: "brainmod" },
  });
  // Tagged with the mount's OWN module, NOT the brain default.
  writeLeaf(webhooks, "knowledge", "RepoFact.md", {
    body: "platypus config note",
    memory: { atom_type: "knowledge-fact", project_module: "webhooks" },
  });

  const ctx = resolveWikiContext([path.join(home, "webhooks")], brainOpts(home));
  // searchMemory auto-injects the brain default module; without per-level
  // re-scoping the "webhooks"-tagged leaf would be filtered out by "brainmod".
  const out = await withWikiContext(ctx, () =>
    searchMemory({ query: "platypus config", filters: { atom_type: "knowledge-fact" } }),
  );
  const names = out.records.map((r) => r.documentName);
  assert.ok(names.includes("RepoFact.md"), "mount leaf under its own module is returned");
  assert.ok(names.includes("BrainFact.md"), "brain leaf under the default module is returned");
});

// ─── category absence: a knowledge-only repo doesn't break recall ────────────

test("category-absence: a knowledge-only repo contributes knowledge and never breaks recall_lessons", async () => {
  const home = makeHome();
  const brain = mkMount(home, ["knowledge", "self_improvement", "daily"]);
  // The repo declares NO self_improvement category and has no such dir.
  const proj = mkMount(path.join(home, "proj"), ["knowledge", "daily"]);
  writeLeaf(brain, "self_improvement", "L1.md", {
    body: "kangaroo lesson always validate inputs",
    memory: {
      atom_type: "self-improvement-lesson",
      project_module: "brainmod",
      task_type: "implementation",
      error_pattern: "kangaroo-trap",
    },
  });
  writeLeaf(proj, "knowledge", "K1.md", {
    body: "kangaroo root cause cache invalidation",
    memory: { atom_type: "bug-root-cause", project_module: "proj", error_pattern: "kangaroo-trap" },
  });

  const ctx = resolveWikiContext([path.join(home, "proj")], brainOpts(home));
  const out = await withWikiContext(ctx, () =>
    recallLessons({ query: "kangaroo validate cache", includeKnowledge: true }),
  );
  assert.ok(out.lessonHits >= 1, "brain lesson recalled despite the repo lacking self_improvement");
  assert.ok(
    out.records.some((r) => r.kind === "lesson" && r.documentName === "L1.md"),
    "the brain lesson is present",
  );
  assert.ok(
    out.records.some((r) => r.kind === "knowledge" && r.documentName === "K1.md"),
    "the knowledge-only repo's bug-root-cause is contributed via per-level module scoping",
  );
});
